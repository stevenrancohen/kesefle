#!/usr/bin/env node
// bot/qa-battery.js — the "100 testers" virtual QA environment (Steven 2026-06-07).
//
// Runs a battery of realistic customer messages (Hebrew AND English) through the
// REAL classifier via bot/bot-replay.js, checks the bot's reaction (amount,
// category, income flag, FX), and prints a scorecard + every miss. Reusable:
// add a case to BATTERY and re-run. Deterministic + network-free (bot-replay
// stubs UrlFetchApp, so FX uses the static floor).
//
//   node bot/qa-battery.js            # full scorecard
//   node bot/qa-battery.js --strict   # exit 1 if accuracy < THRESHOLD (CI gate)
//
// A case: { msg, lang, cat?, sub?, income?, fxRate? }
//   cat     expected top category (substring match; omit to only check it parsed)
//   income  true  -> expect the income flag set
//   fxRate  number-> expect FX conversion at ~that rate
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const REPLAY = path.join(__dirname, 'bot-replay.js');
const THRESHOLD = 90; // percent

// Load the deployed keyword index so the harness mirrors PRODUCTION's two-tier
// classify: primary (CATEGORY_MAP, via bot-replay) THEN the big keyword-index
// fallback. bot-replay does not load the ~3.8MB index, so we apply that second
// tier here -- exactly what the live bot does when the primary is unsure.
let KW = { index: {}, buckets: [] };
try { KW = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords', 'INDEX.json'), 'utf8')); } catch (_e) {}
function _norm(s) { return String(s || '').toLowerCase().split(/[^0-9a-z֐-׿]+/).filter(Boolean).join(' '); }
function indexFallback(desc) {
  const t = _norm(desc);
  if (!t) return null;
  const words = t.split(' ');
  const cands = [t];
  for (let n = Math.min(3, words.length); n >= 1; n--) for (let i = 0; i + n <= words.length; i++) cands.push(words.slice(i, i + n).join(' '));
  for (const c of cands) { const b = KW.index[c]; if (b !== undefined && KW.buckets[b]) return { category: KW.buckets[b][0], subcategory: KW.buckets[b][1], isIncome: KW.buckets[b][2] === 1 }; }
  return null;
}

function run(msg) {
  let out;
  try { out = execFileSync('node', [REPLAY, '--json', msg], { encoding: 'utf8' }); }
  catch (e) { return { _err: (e && e.message) || 'replay error' }; }
  let j; try { j = JSON.parse(out); } catch { return { _err: 'bad json' }; }
  const d = j.decisions || {};
  const mc = d.matchCategory || {};
  const am = d.amountMatch || {};
  const fx = d.fx || {};
  let category = mc.category || null;
  let subcategory = mc.subcategory || null;
  let income = mc.isIncome === true || am.isIncome === true || /^\s*\+/.test(String(msg));
  // Tier 2: when the primary classifier is unsure (null / שונות), consult the
  // deployed keyword index, exactly like the live bot. Strip amounts first.
  if (!category || category.indexOf('שונות') >= 0) {
    const fb = indexFallback(String(msg).replace(/[+\-]?\d[\d.,]*/g, ' '));
    if (fb) { category = fb.category; subcategory = fb.subcategory; if (fb.isIncome) income = true; }
  }
  return {
    amount: am.amount !== undefined ? am.amount : (fx.ilsAmount !== undefined ? fx.ilsAmount : undefined),
    category, subcategory, income, fxRate: fx.fxRate,
  };
}

const BATTERY = [
  // ---------- Hebrew everyday ----------
  { msg: '85 סופר רמי לוי', lang: 'he', cat: 'אוכל' },
  { msg: '45 קפה ארומה', lang: 'he', cat: 'אוכל' },
  { msg: '250 דלק פז', lang: 'he', cat: 'תחבורה' },
  { msg: '120 חניה', lang: 'he', cat: 'תחבורה' },
  { msg: '300 זארה', lang: 'he', cat: 'קניות' },
  { msg: '90 רופא שיניים', lang: 'he', cat: 'בריאות' },
  { msg: '1200 ארנונה', lang: 'he', cat: 'הוצאות קבועות' },
  { msg: '99 נטפליקס', lang: 'he', cat: 'בידור' },
  { msg: '60 וולט', lang: 'he', cat: 'אוכל' },
  { msg: '200 חשמל', lang: 'he', cat: 'הוצאות קבועות' },
  // ---------- Hebrew income ----------
  { msg: '8500 משכורת', lang: 'he', income: true },
  { msg: '+3000 מכירת תמונה', lang: 'he', income: true },
  // ---------- English everyday (the gap to close) ----------
  { msg: '100 groceries', lang: 'en', cat: 'אוכל' },
  { msg: '50 coffee starbucks', lang: 'en', cat: 'אוכל' },
  { msg: '200 gas', lang: 'en', cat: 'תחבורה' },
  { msg: '200 fuel', lang: 'en', cat: 'תחבורה' },
  { msg: '120 zara', lang: 'en', cat: 'קניות' },
  { msg: '30 netflix', lang: 'en', cat: 'הוצאות קבועות' },
  { msg: 'uber 45', lang: 'en', cat: 'תחבורה' },
  { msg: '45 wolt', lang: 'en', cat: 'אוכל' },
  { msg: '150 rent', lang: 'en', cat: 'הוצאות קבועות' },
  { msg: '80 electricity', lang: 'en', cat: 'הוצאות קבועות' },
  { msg: '60 pharmacy', lang: 'en', cat: 'בריאות' },
  { msg: '90 restaurant', lang: 'en', cat: 'אוכל' },
  { msg: '40 parking', lang: 'en', cat: 'תחבורה' },
  { msg: '500 shopping', lang: 'en', cat: 'קניות' },
  { msg: '70 internet', lang: 'en', cat: 'הוצאות קבועות' },
  { msg: '120 doctor', lang: 'en', cat: 'בריאות' },
  // ---------- English income ----------
  { msg: 'salary 12000', lang: 'en', income: true },
  { msg: 'income 5000', lang: 'en', income: true },
  // ---------- FX (Hebrew + English) ----------
  { msg: '50 דולר amazon', lang: 'he', fxRate: 2.91 },
  { msg: '100 דולר קנדי uber', lang: 'he', fxRate: 2.10 },
  { msg: '100 cad uber', lang: 'en', fxRate: 2.10 },
  { msg: '20 euro spotify', lang: 'en', fxRate: 3.39 },
];

let pass = 0, fail = 0;
const misses = [];
const byLang = { he: { p: 0, t: 0 }, en: { p: 0, t: 0 } };

for (const c of BATTERY) {
  const r = run(c.msg);
  byLang[c.lang].t++;
  let ok = !r._err && r.amount !== undefined && r.amount !== null;
  const reasons = [];
  if (r._err) reasons.push('err:' + r._err);
  if (r.amount === undefined || r.amount === null) reasons.push('no amount');
  if (ok && c.cat && !(String(r.category || '').indexOf(c.cat) >= 0)) { ok = false; reasons.push('cat=' + r.category + ' want~' + c.cat); }
  if (ok && c.income && !r.income) { ok = false; reasons.push('not flagged income'); }
  if (ok && c.fxRate && Math.abs((r.fxRate || 0) - c.fxRate) > 0.01) { ok = false; reasons.push('fx=' + r.fxRate + ' want~' + c.fxRate); }
  if (ok) { pass++; byLang[c.lang].p++; } else { fail++; misses.push({ msg: c.msg, lang: c.lang, reasons }); }
}

const total = BATTERY.length;
const acc = Math.round((pass / total) * 1000) / 10;
console.log('\n======== KESEFLE BOT QA BATTERY ========');
console.log('cases: ' + total + '  |  pass: ' + pass + '  |  fail: ' + fail + '  |  accuracy: ' + acc + '%');
console.log('  Hebrew:  ' + byLang.he.p + '/' + byLang.he.t);
console.log('  English: ' + byLang.en.p + '/' + byLang.en.t);
if (misses.length) {
  console.log('\nMISSES:');
  for (const m of misses) console.log('  [' + m.lang + '] "' + m.msg + '"  -> ' + m.reasons.join('; '));
}
console.log('');

const strict = process.argv.includes('--strict');
if (strict && acc < THRESHOLD) { console.error('QA BATTERY below threshold ' + THRESHOLD + '%'); process.exit(1); }
process.exit(0);
