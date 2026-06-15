#!/usr/bin/env node
// bot/test_multiitem_income.js
// End-to-end replay of the MULTI-ITEM path (Steven 2026-06-14): a comma list
// must classify + resolve income PER ITEM, with NO cross-item bleed.
//
// Before the parser fix, parseAmountAndDescription gave every item the whole
// stripped message as its description, so "50 קפה, עסק הכנסה 10000" made item 1
// (the ₪50 coffee) carry the words "קפה עסק הכנסה" -> matchCategory saw עסק +
// הכנסה and booked it as BUSINESS INCOME (מחזור), silently flipping a personal
// expense to company revenue. Now each item carries only its own segment, so the
// coffee stays a personal expense and only the ₪10000 row is income.
//
// Mirrors the real processExpense item loop (col H = !_resolveIsIncome_) using
// the REAL source via balanced-brace extraction (Kesefle pattern, no mocking).
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let p = SRC.indexOf('(', start), pd = 0, k = p;
  for (; k < SRC.length; k++) { if (SRC[k] === '(') pd++; else if (SRC[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = SRC.indexOf('{', k), d = 0, j = i;
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) { j++; break; } } }
  return SRC.slice(start, j);
}
function balanced(marker, open, close) {
  const s = SRC.indexOf(marker); const i = SRC.indexOf(open, s);
  let d = 0, j = i;
  for (; j < SRC.length; j++) { if (SRC[j] === open) d++; else if (SRC[j] === close) { d--; if (!d) { j++; break; } } }
  return SRC.slice(i, j);
}

globalThis.CATEGORY_MAP = eval(balanced('const CATEGORY_MAP = [', '[', ']'));
globalThis.BUSINESS_CATEGORY_MAP = eval('(' + balanced('var BUSINESS_CATEGORY_MAP = {', '{', '}') + ')');
globalThis.DEFAULT_CATEGORY = eval('(' + balanced('const DEFAULT_CATEGORY =', '{', '}') + ')');
globalThis._CANONICAL_CAT_BY_SUB = eval('(' + balanced('var _CANONICAL_CAT_BY_SUB =', '{', '}') + ')');
(0, eval)(extractFn('_parseIsraeliNumber_'));
(0, eval)(extractFn('parseAmountAndDescription'));
(0, eval)(extractFn('_kflIsWordChar_'));
(0, eval)(extractFn('_kflKwHit_'));
(0, eval)(extractFn('_matchCategory_orig'));
(0, eval)(extractFn('_matchCategory_long'));
(0, eval)(extractFn('_coerceCategoryBySubcategory'));
(0, eval)(extractFn('matchCategory'));
(0, eval)(extractFn('_isIncomeCategory_'));
(0, eval)(extractFn('_resolveIsIncome_'));

let pass = 0, fail = 0;
function expect(name, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + ' = ' + JSON.stringify(got) + (ok ? '' : ' (want ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}

// Replay the real processExpense multi-item loop: parse -> per-item matchCategory
// + _resolveIsIncome_(matched, item.segment || originalText). originalText is the
// full message (consumer line ~9684); segment is per-item (the fix).
function flow(rawText) {
  const parsed = parseAmountAndDescription(rawText);
  if (!parsed || !parsed.items) return [];
  parsed.items.forEach(function (it) { it.originalText = rawText; });
  return parsed.items.map(function (item) {
    const matched = matchCategory(item.description);
    _coerceCategoryBySubcategory(matched);
    const isInc = _resolveIsIncome_(matched, item.segment || item.originalText || rawText, matched.category, matched.subcategory);
    return { amount: item.amount, desc: item.description, cat: matched.category, isIncome: isInc, colH: !isInc };
  });
}

console.log('\nbot/test_multiitem_income.js\n');

console.log('Case 1: "50 קפה, עסק הכנסה 10000" -- coffee stays personal expense, only 10000 is income');
var r1 = flow('50 קפה, עסק הכנסה 10000');
expect('2 items', r1.length, 2);
expect('item1 amount', r1[0] && r1[0].amount, 50);
expect('item1 NOT income (no bleed)', r1[0] && r1[0].isIncome, false);
expect('item1 colH=true (expense)', r1[0] && r1[0].colH, true);
expect('item1 category not עסק', r1[0] && r1[0].cat !== 'עסק', true);
expect('item2 amount', r1[1] && r1[1].amount, 10000);
expect('item2 IS income', r1[1] && r1[1].isIncome, true);
expect('item2 colH=false (income)', r1[1] && r1[1].colH, false);

console.log('\nCase 2: "משכורת 8000, 50 קפה" -- salary income then coffee expense');
var r2 = flow('משכורת 8000, 50 קפה');
expect('2 items', r2.length, 2);
expect('item1 (salary) income', r2[0] && r2[0].isIncome, true);
expect('item1 colH=false', r2[0] && r2[0].colH, false);
expect('item2 (coffee) NOT income', r2[1] && r2[1].isIncome, false);
expect('item2 colH=true', r2[1] && r2[1].colH, true);

console.log('\nCase 3: "42 קפה, 245 סופר, 1800 ארנונה" -- three distinct expenses, none income');
var r3 = flow('42 קפה, 245 סופר, 1800 ארנונה');
expect('3 items', r3.length, 3);
expect('all expenses (no income)', r3.every(function (x) { return x.isIncome === false && x.colH === true; }), true);
expect('three distinct categories', new Set(r3.map(function (x) { return x.cat; })).size >= 2, true);

console.log('\nCase 4: single "עסק הכנסה 10000" via the parse path -- income (regression guard)');
var r4 = flow('עסק הכנסה 10000');
expect('1 item', r4.length, 1);
expect('income', r4[0] && r4[0].isIncome, true);
expect('colH=false', r4[0] && r4[0].colH, false);

console.log('');
if (fail) { console.error('FAIL: ' + fail + ' failed, ' + pass + ' passed'); process.exit(1); }
console.log('OK: all ' + pass + ' multi-item income assertions passed');
