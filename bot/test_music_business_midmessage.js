#!/usr/bin/env node
// bot/test_music_business_midmessage.js — MOCK ONLY (no sheet, no network).
//
// Regression: "עסק מוסיקה" / "עסק מוזיקה" in the MIDDLE of a message must route
// to the music business (עסק מוזיקה), NOT the photo business (עסק), and a $
// amount must be converted to ILS.
//   '90 אפליקציה סונו - עסק מוסיקה' | 'עסק מוסיקה 90 סונו' | 'סונו עסק מוסיקה $90'
//
// Root cause (found by the parallel Claude session, 2026-11-02):
// _classifyBareBusinessExpense_ (the "bare business expense" path in doPost)
// catches ANY message containing the standalone word עסק + an amount and writes
// it to עסק (photos) before the music/ecom routing and before FX.
//
// The FIX exists ONLY in Claude's unpushed copy (live Apps Script ZZ file,
// version 129 NOT deployed). It is vendored read-only under
// tests/fixtures/claude_c33/ and tested here in two layers:
//   [FIXTURE]   repo _classifyBareBusinessExpense_ + Claude's wrapper/markers
//               -> MUST pass (CI fails if it regresses).
//   [REPO-ONLY] repo code without the wrapper -> currently WRONG. Reported as
//               XFAIL (expected failure, reason printed) so CI stays green but
//               honest; flips to XPASS (and asks to promote the test) once the
//               fix is merged into bot/ExpenseBot_*.gs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BOT = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const FIX = (f) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/claude_c33', f), 'utf8');

function extractFn(src, name) {
  const fi = src.indexOf('function ' + name + '(');
  if (fi < 0) throw new Error('missing ' + name);
  let d = 0; const start = src.indexOf('{', fi);
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) return src.slice(fi, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const MOCK_USD = 3.5; // fixed mock rate — never the live rate
function makeCtx(withClaudeFix) {
  const ctx = {
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    UrlFetchApp: { fetch() { throw new Error('network blocked in test'); } },
    SpreadsheetApp: { openById() { throw new Error('sheet access blocked in test'); } },
    matchCategory: () => null, // no dictionary in the mock: worst case for routing
    _kfl_fxLookup: (sym) => (/^(\$|usd|דולר|דולרים)$/i.test(String(sym).trim()) ? MOCK_USD : null),
  };
  vm.createContext(ctx);
  const fns = ['_kflIsWordChar_', '_kflKwHit_', '_classifyBareBusinessExpense_', 'parseForeignCurrencyHint',
    '_kfl_fxNote_', '_kfl_currencyDisplay_', '_kfl_nonAdjacentCurrency_'];
  vm.runInContext(fns.map((n) => extractFn(BOT, n)).join('\n\n'), ctx);
  if (withClaudeFix) {
    vm.runInContext(FIX('music_block_c28.js'), ctx);
    vm.runInContext(FIX('ecom_block_c30v2.js'), ctx);
    vm.runInContext(FIX('zz_c33_bbe_fix.gs'), ctx); // installs the _classifyBareBusinessExpense_ wrapper
  }
  return ctx;
}

// Downstream of the bare-business gate (mirrors processExpense order, mock):
// gate -> FX hint -> music route.
function route(ctx, msg) {
  const bbe = ctx._classifyBareBusinessExpense_(msg);
  if (bbe) return { path: 'bare-business', category: bbe.category, subcategory: bbe.subcategory, amountIls: bbe.amount, fx: bbe.fx || null };
  const fx = ctx.parseForeignCurrencyHint(msg);
  const m = { category: '', subcategory: '' };
  const hasMusic = typeof ctx._kflMusicRoute_ === 'function';
  if (hasMusic) ctx._kflMusicRoute_(msg, m, false);
  const amt = fx ? fx.ilsAmount : Number((String(msg).match(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/) || [])[1] || NaN);
  return { path: hasMusic ? 'normal-flow' : 'normal-flow(no music route in repo)', category: m.category, subcategory: m.subcategory, amountIls: amt, fx: fx ? { orig: fx.foreignAmount, rate: fx.fxRate } : null };
}

const CASES = [
  // [message, expected ILS amount, expects USD conversion]
  ['90 אפליקציה סונו - עסק מוסיקה', 90, false], // no currency marker in the text -> stays 90 ILS
  ['עסק מוסיקה 90 סונו', 90, false],
  ['סונו עסק מוסיקה $90', 90 * MOCK_USD, true],
  ['90 אפליקציה סונו - עסק מוזיקה', 90, false], // zayin spelling, the exact October message
];

let pass = 0, fail = 0, xfail = 0, xpass = 0;
const ok = (l, c, extra) => { if (c) { pass++; console.log('  ok    ' + l); } else { fail++; console.log('  FAIL  ' + l + (extra ? '  [' + extra + ']' : '')); } };

console.log('== [FIXTURE] repo bare-business gate + Claude c33 wrapper (unpushed, v129 not deployed) ==');
const fixed = makeCtx(true);
ok('Claude wrapper is installed over the repo function', !!fixed._classifyBareBusinessExpense_.__kflC33);
for (const [msg, ils, usd] of CASES) {
  const r = route(fixed, msg);
  ok(`"${msg}" -> עסק מוזיקה / הפקה וכלים (not עסק תמונות)`, r.category === 'עסק מוזיקה' && r.subcategory === 'הפקה וכלים' && r.path === 'normal-flow', JSON.stringify(r));
  ok(`"${msg}" -> ${ils} ILS${usd ? ' (USD converted at mock rate)' : ''}`, Math.abs(r.amountIls - ils) < 0.01 && (!!r.fx === usd), JSON.stringify(r));
}
// Photo-business messages must keep the bare-business path (no over-correction).
for (const msg of ['עסק 288 שיווק', 'עסק תמונות 200 משלוח']) {
  const b = fixed._classifyBareBusinessExpense_(msg);
  ok(`photo business unchanged: "${msg}" -> עסק`, b && b.category === 'עסק' && !b.fx, JSON.stringify(b));
}
const v = fixed._classifyBareBusinessExpense_('24 דולר - עסק vercel');
ok('photo business with $ is converted by the wrapper (24 * mock rate)', v && v.fx && Math.abs(v.amount - 24 * MOCK_USD) < 0.01, JSON.stringify(v));

console.log('\n== [REPO-ONLY] current bot/ExpenseBot_FIXED.gs without the Claude fix (expected failure) ==');
const repo = makeCtx(false);
for (const [msg, ils, usd] of CASES) {
  const r = route(repo, msg);
  const good = r.category === 'עסק מוזיקה' && Math.abs(r.amountIls - ils) < 0.01 && (!!r.fx === usd);
  if (good) { xpass++; console.log(`  XPASS "${msg}" — repo now routes correctly; promote this case to a hard assertion`); }
  else {
    xfail++;
    const why = r.path === 'bare-business' ? 'hijacked by _classifyBareBusinessExpense_ -> ' + r.category + ' / ' + r.subcategory
      : 'repo has no _kflMusicRoute_ (music routing lives only in the live ZZ file)';
    console.log(`  XFAIL "${msg}" — ${why}`);
  }
}

console.log(`\ntest_music_business_midmessage: ${pass} passed, ${fail} failed, ${xfail} xfail (known: fix not in repo), ${xpass} xpass`);
process.exit(fail ? 1 : 0);
