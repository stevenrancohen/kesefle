#!/usr/bin/env node
// bot/test_income_dashboard_row.js  (auto-discovered by the gauntlet)
//
// REGRESSION GATE for the "disappearing income" fix (2026-06-27): a transaction
// the sign-resolver marks as income MUST be normalized to a PERSONAL INCOME row
// label in col E. Otherwise col H = income paired with an expense col-E label
// makes the dashboard SUMIFS skip it in BOTH the income and expense totals, and
// the money vanishes. This bites NL-detected income (גבייה / לקוחה שילמה / ...)
// that classifies to a default subcategory.
//
// Asserts BOTH write paths agree: the bot's _normalizeSubForDashboard_ (extracted
// from ExpenseBot_FIXED.gs) and lib/sheet-writer.js normalizeSubcategoryForDashboard.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function grab(name) {
  const decl = 'var ' + name + ' =';
  const i = SRC.indexOf(decl);
  if (i < 0) throw new Error('missing ' + name);
  let open = -1;
  for (let j = i + decl.length; j < SRC.length; j++) { if (SRC[j] === '[' || SRC[j] === '{') { open = j; break; } }
  const oc = SRC[open], cc = oc === '[' ? ']' : '}'; let d = 0;
  for (let j = open; j < SRC.length; j++) { if (SRC[j] === oc) d++; else if (SRC[j] === cc) { d--; if (d === 0) return SRC.slice(open, j + 1); } }
  throw new Error('unbalanced ' + name);
}
/* eslint-disable no-eval, no-unused-vars */
const _KFL_PERSONAL_DASH_ROWS = eval(grab('_KFL_PERSONAL_DASH_ROWS'));
const _KFL_PERSONAL_INCOME_ROWS = _KFL_PERSONAL_DASH_ROWS.slice(0, 4);
const _KFL_SUB_TO_DASHBOARD_ROW = eval('(' + grab('_KFL_SUB_TO_DASHBOARD_ROW') + ')');
const _BIZ_DASH_SUBS = eval('(' + grab('_BIZ_DASH_SUBS') + ')');
const fi = SRC.indexOf('function _normalizeSubForDashboard_(');
let d = 0, start = SRC.indexOf('{', fi), end = -1;
for (let j = start; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (d === 0) { end = j; break; } } }
const _normalizeSubForDashboard_ = eval('(' + SRC.slice(fi, end + 1) + ')');
/* eslint-enable no-eval */

const INCOME_ROWS = ['הכנסה 1 — משכורת', 'הכנסה 2 — עסק', 'הכנסה 3 — נוסף', 'שונות (הכנסות)'];

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); } }

// the bot income-rows constant must equal the canonical income set, in order
ok('bot income-rows constant matches canonical', JSON.stringify(_KFL_PERSONAL_INCOME_ROWS) === JSON.stringify(INCOME_ROWS),
  JSON.stringify(_KFL_PERSONAL_INCOME_ROWS));

// CASES: [subcategory, category, isIncome, expectedRow]
const CASES = [
  // personal income with a default / non-income subcategory -> income misc row (was 'שונות' = disappeared)
  ['שונות', 'שונות ואחרים', true, 'שונות (הכנסות)'],
  ['קצבאות וזכאויות', 'הכנסות', true, 'שונות (הכנסות)'],
  ['החזר מס', 'הכנסות', true, 'שונות (הכנסות)'],
  ['', 'הכנסות', true, ''], // empty sub stays empty (caller handles)
  // well-formed income subs still resolve to their own income row
  ['הכנסה 3 — נוסף', 'הכנסות', true, 'הכנסה 3 — נוסף'],
  ['שונות (הכנסות)', 'הכנסות', true, 'שונות (הכנסות)'],
  // EXPENSE behavior must be UNCHANGED by the guard
  ['שונות', 'שונות ואחרים', false, 'שונות'],
  ['דלק', 'תחבורה', false, 'דלק'],
  ['אוכל בחוץ', 'אוכל', false, 'אוכל בחוץ'],
  // business income is dashboarded on מאזן חברה separately -> NOT the personal income row
  ['מחזור', 'עסק', true, 'מחזור'],
];

for (const [sub, cat, inc, exp] of CASES) {
  const got = _normalizeSubForDashboard_(sub, cat, inc);
  ok(`bot N(${JSON.stringify(sub)}, ${cat}, ${inc}) === ${JSON.stringify(exp)}`, got === exp, 'got ' + JSON.stringify(got));
  // every income result (personal) must be an income row or empty
  if (inc && cat !== 'עסק' && sub) {
    ok(`bot income lands on an income row for ${JSON.stringify(sub)}`, INCOME_ROWS.indexOf(got) >= 0, 'got ' + JSON.stringify(got));
  }
}

// lib parity (async dynamic import of the ESM module)
(async () => {
  const lib = await import('../lib/sheet-writer.js');
  const N = lib.normalizeSubcategoryForDashboard;
  for (const [sub, cat, inc, exp] of CASES) {
    const got = N(sub, cat, inc);
    ok(`lib N(${JSON.stringify(sub)}, ${cat}, ${inc}) === ${JSON.stringify(exp)}`, got === exp, 'got ' + JSON.stringify(got));
  }
  console.log(`test_income_dashboard_row: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
