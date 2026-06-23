#!/usr/bin/env node
// scripts/wa-sim.js
//
// WhatsApp SIMULATOR + modeled sheet/dashboard for Kesefle.
//
// Drives the bot's REAL parser + classifier + sign-resolver + business router
// (via bot/bot-replay.js's exported replay(), in-process, NO live writes / no
// LLM / no Apps Script) the way a WhatsApp user would, accumulates the predicted
// rows into a modeled תנועות sheet, computes the dashboard the way the real
// dashboard does, and reports:
//   - per-message predicted classification (category / subcategory / sign / amount)
//   - MISROUTES vs an expected label (for fleet-generated labeled corpora)
//   - "DISAPPEARED money": an expense whose dashboard row is blank/unmapped
//     (the exact bug class the 2026-06-19 audit found) -> it would never be summed
//   - end-of-run dashboard: income / expense / net + per-bucket totals
//
// Usage:
//   node scripts/wa-sim.js "50 קפה"                 # chat one message
//   node scripts/wa-sim.js --corpus path.jsonl       # run a labeled corpus
//   node scripts/wa-sim.js --corpus path.jsonl --json # machine-readable report
//   node scripts/wa-sim.js --corpus path.jsonl --report out.json
//
// Corpus = JSONL, one object per line:
//   { "msg": "245 סופר", "persona": "household",
//     "expect": { "category": "אוכל", "isIncome": false, "amount": 245 } }
// Every expect.* field is optional; only provided fields are asserted.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { replay } = require('../bot/bot-replay.js');

// ── predict: one message -> structured prediction from the REAL bot logic ─────
function predict(msg) {
  const r = replay(String(msg == null ? '' : msg));
  const pt = r.predicted_target || {};
  const am = (r.decisions && r.decisions.amountMatch) || {};
  return {
    msg,
    amount: typeof am.amount === 'number' ? am.amount : null,
    items: Array.isArray(am.items) ? am.items : [],
    category: pt.category || null,
    subcategory: pt.subcategory || null,
    isIncome: pt.isIncome === true,
    dashRow: pt.dashboard_row || null,
    tab: pt.tab || null,
    business: !!(r.decisions && ((r.decisions.businessN && r.decisions.businessN.matched) || (r.decisions.bareBusiness && r.decisions.bareBusiness.matched))),
    loadError: r.load_error || null,
  };
}

// ── modeled sheet + dashboard ────────────────────────────────────────────────
function newSheet() {
  return { rows: [], income: 0, expense: 0, byRow: Object.create(null), disappeared: [] };
}
function applyRow(sheet, p) {
  // A row "disappears" from the dashboard if it is an EXPENSE whose dashboard row
  // is blank, "/" only, or an empty subcategory -> the SUMIFS never sums it.
  const sub = (p.subcategory || '').trim();
  const dash = (p.dashRow || '').trim();
  const blankDash = !dash || dash === '/' || /\/\s*$/.test(dash) || !sub;
  sheet.rows.push(p);
  if (p.amount == null) return; // unparseable amount -> not a money row
  if (p.isIncome) { sheet.income += p.amount; }
  else {
    sheet.expense += p.amount;
    if (blankDash) sheet.disappeared.push({ msg: p.msg, amount: p.amount, category: p.category, subcategory: p.subcategory, dashRow: p.dashRow });
  }
  const key = (p.isIncome ? '[+] ' : '[-] ') + (dash || sub || p.category || 'אחר');
  sheet.byRow[key] = (sheet.byRow[key] || 0) + (p.amount || 0);
}
function dashboard(sheet) {
  return { income: sheet.income, expense: sheet.expense, net: sheet.income - sheet.expense, rowCount: sheet.rows.length, buckets: sheet.byRow, disappeared: sheet.disappeared };
}

// ── corpus runner ────────────────────────────────────────────────────────────
function runCorpus(corpusPath) {
  const lines = fs.readFileSync(corpusPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const sheet = newSheet();
  const misroutes = [];
  let total = 0, asserted = 0, passed = 0;
  for (const line of lines) {
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || !obj.msg) continue;
    total++;
    const p = predict(obj.msg);
    applyRow(sheet, p);
    const exp = obj.expect || null;
    if (exp) {
      const fails = [];
      if (exp.category != null && exp.category !== p.category) fails.push({ field: 'category', expected: exp.category, got: p.category });
      if (exp.isIncome != null && !!exp.isIncome !== !!p.isIncome) fails.push({ field: 'isIncome', expected: exp.isIncome, got: p.isIncome });
      if (exp.amount != null && Number(exp.amount) !== Number(p.amount)) fails.push({ field: 'amount', expected: exp.amount, got: p.amount });
      if (exp.subcategory != null && exp.subcategory !== p.subcategory) fails.push({ field: 'subcategory', expected: exp.subcategory, got: p.subcategory });
      if (exp.dashRow != null && exp.dashRow !== p.dashRow) fails.push({ field: 'dashRow', expected: exp.dashRow, got: p.dashRow });
      asserted++;
      if (fails.length === 0) passed++;
      else misroutes.push({ msg: obj.msg, persona: obj.persona || '', fails });
    }
  }
  return { total, asserted, passed, accuracy: asserted ? +(passed / asserted * 100).toFixed(1) : null, misroutes, dashboard: dashboard(sheet) };
}

function fmtReport(rep) {
  const L = [];
  L.push('=== WA-SIM REPORT ===');
  L.push(`messages: ${rep.total}  asserted: ${rep.asserted}  passed: ${rep.passed}  accuracy: ${rep.accuracy == null ? 'n/a' : rep.accuracy + '%'}`);
  L.push(`dashboard: income ₪${Math.round(rep.dashboard.income)} | expense ₪${Math.round(rep.dashboard.expense)} | net ₪${Math.round(rep.dashboard.net)} | rows ${rep.dashboard.rowCount}`);
  if (rep.dashboard.disappeared.length) {
    L.push(`\n⚠️  DISAPPEARED money (expense rows the dashboard would NOT sum): ${rep.dashboard.disappeared.length}`);
    rep.dashboard.disappeared.slice(0, 15).forEach(d => L.push(`   - "${d.msg}" ₪${d.amount} cat=${d.category} sub="${d.subcategory}" dash="${d.dashRow}"`));
  }
  if (rep.misroutes.length) {
    L.push(`\n❌ MISROUTES: ${rep.misroutes.length}`);
    rep.misroutes.slice(0, 40).forEach(m => L.push(`   - [${m.persona}] "${m.msg}" :: ` + m.fails.map(f => `${f.field} want=${f.expected} got=${f.got}`).join(', ')));
    if (rep.misroutes.length > 40) L.push(`   …and ${rep.misroutes.length - 40} more`);
  } else if (rep.asserted) {
    L.push('\n✅ no misroutes — every asserted message classified as expected.');
  }
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const corpusIdx = args.indexOf('--corpus');
  const reportIdx = args.indexOf('--report');
  if (corpusIdx >= 0) {
    const corpusPath = args[corpusIdx + 1];
    const rep = runCorpus(corpusPath);
    if (reportIdx >= 0) fs.writeFileSync(args[reportIdx + 1], JSON.stringify(rep, null, 2));
    if (jsonMode) console.log(JSON.stringify(rep));
    else console.log(fmtReport(rep));
    process.exit(rep.misroutes.length ? 1 : 0);
  } else {
    const msg = args.filter(a => !a.startsWith('--')).join(' ');
    if (!msg) { console.log('Usage: node scripts/wa-sim.js "<message>"  |  --corpus <file.jsonl> [--json] [--report out.json]'); process.exit(2); }
    const p = predict(msg);
    if (jsonMode) console.log(JSON.stringify(p));
    else {
      console.log(`🟢 you: ${msg}`);
      console.log(`🤖 bot would record: ₪${p.amount} · ${p.category} / ${p.subcategory} · ${p.isIncome ? 'income(+)' : 'expense(-)'} · dashboard row: ${p.dashRow}`);
      if (p.items.length > 1) console.log(`   (${p.items.length} items: ${p.items.map(i => '₪' + i.amount + ' ' + i.description).join(' | ')})`);
    }
  }
}

module.exports = { predict, newSheet, applyRow, dashboard, runCorpus, fmtReport };
