#!/usr/bin/env node
// Regression test for the repo-integrated C33 special-business routes.
// MOCK ONLY: no sheet, network, Properties mutation, importer, or deployment.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BOT = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(src, name) {
  const fi = src.indexOf('function ' + name + '(');
  if (fi < 0) throw new Error('missing ' + name);
  let depth = 0;
  const start = src.indexOf('{', fi);
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(fi, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

function extractSpecialBlock() {
  const start = BOT.indexOf('// SPECIAL BUSINESS ROUTING (C33, repo-integrated)');
  const end = BOT.indexOf('function matchCategory(text)', start);
  if (start < 0 || end < 0) throw new Error('missing repo-integrated C33 routing block');
  return BOT.slice(start, end);
}

const MOCK_USD = 3.5;
const ctx = {
  Logger: { log() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  UrlFetchApp: { fetch() { throw new Error('network blocked in test'); } },
  SpreadsheetApp: { openById() { throw new Error('sheet access blocked in test'); } },
  _kfl_fxLookup: (sym) => /^(\$|usd|דולר|דולרים)$/i.test(String(sym).trim()) ? MOCK_USD : null,
  _normalizeBizSub_: (sub) => sub,
};
vm.createContext(ctx);
vm.runInContext(extractSpecialBlock(), ctx);
vm.runInContext(`
  function matchCategory(text) {
    return _kflSpecialBusinessRoute_(text) || { category: 'עסק', subcategory: 'הוצאות תפעוליות', isIncome: false };
  }
`, ctx);

const supportFns = [
  '_kflIsWordChar_', '_kflKwHit_', '_classifyBareBusinessExpense_',
  'parseForeignCurrencyHint', '_kfl_fxNote_', '_kfl_currencyDisplay_',
  '_kfl_nonAdjacentCurrency_', '_isIncomeCategory_', '_normalizeSubForDashboard_'
];
vm.runInContext(supportFns.map((n) => extractFn(BOT, n)).join('\n\n'), ctx);

function route(msg) {
  const bbe = ctx._classifyBareBusinessExpense_(msg);
  if (bbe) return {
    path: 'bare-business', category: bbe.category, subcategory: bbe.subcategory,
    amountIls: bbe.amount, fx: bbe.fx || null
  };
  const fx = ctx.parseForeignCurrencyHint(msg);
  const matched = ctx._kflSpecialBusinessRoute_(msg);
  const fallbackAmount = Number((String(msg).match(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/) || [])[1] || NaN);
  return {
    path: 'normal-flow',
    category: matched && matched.category,
    subcategory: matched && matched.subcategory,
    isIncome: !!(matched && matched.isIncome),
    amountIls: fx ? fx.ilsAmount : fallbackAmount,
    fx: fx || null,
  };
}

let pass = 0;
let fail = 0;
function ok(label, condition, extra) {
  if (condition) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')); }
}

console.log('== repo-integrated music routing ==');
const musicCases = [
  ['90 אפליקציה סונו - עסק מוסיקה', 90, false],
  ['עסק מוסיקה 90 סונו', 90, false],
  ['סונו עסק מוסיקה $90', 90 * MOCK_USD, true],
  ['90 אפליקציה סונו - עסק מוזיקה', 90, false],
];
for (const [msg, expectedAmount, hasFx] of musicCases) {
  const result = route(msg);
  ok(`"${msg}" -> עסק מוזיקה / הפקה וכלים`,
    result.path === 'normal-flow' && result.category === 'עסק מוזיקה' && result.subcategory === 'הפקה וכלים', JSON.stringify(result));
  ok(`"${msg}" -> ${expectedAmount} ILS${hasFx ? ' after USD conversion' : ''}`,
    Math.abs(result.amountIls - expectedAmount) < 0.01 && (!!result.fx === hasFx), JSON.stringify(result));
}

console.log('\n== repo-integrated e-commerce routing ==');
for (const [msg, sub, income] of [
  ['עסק ecom פרסום פייסבוק 300', 'פרסום ושיווק', false],
  ['shopify 29$', 'דומיין ואתר', false],
  ['ecom הכנסה 450 מכירות', 'הכנסות ecom', true],
]) {
  const result = route(msg);
  ok(`"${msg}" -> הוצאות ecom / ${sub}`,
    result.path === 'normal-flow' && result.category === 'הוצאות ecom' && result.subcategory === sub && result.isIncome === income,
    JSON.stringify(result));
}

console.log('\n== photo business stays intact and gains FX correctness ==');
for (const msg of ['עסק 288 שיווק', 'עסק תמונות 200 משלוח']) {
  const result = route(msg);
  ok(`"${msg}" remains on the bare photo-business path`,
    result.path === 'bare-business' && result.category === 'עסק', JSON.stringify(result));
}
const usdPhoto = route('24 דולר - עסק vercel');
ok('photo business USD amount is converted before the early write',
  usdPhoto.path === 'bare-business' && Math.abs(usdPhoto.amountIls - 24 * MOCK_USD) < 0.01 && !!usdPhoto.fx,
  JSON.stringify(usdPhoto));

console.log('\n== dashboard and income contracts ==');
ok('music dashboard row remains exact',
  ctx._normalizeSubForDashboard_('הפקה וכלים', 'עסק מוזיקה', false) === 'הפקה וכלים');
ok('ecom dashboard row remains exact',
  ctx._normalizeSubForDashboard_('דומיין ואתר', 'הוצאות ecom', false) === 'דומיין ואתר');
ok('music income is definitional income', ctx._isIncomeCategory_('עסק מוזיקה', 'הכנסות מוזיקה') === true);
ok('ecom income is definitional income', ctx._isIncomeCategory_('הוצאות ecom', 'הכנסות ecom') === true);

console.log(`\ntest_music_business_midmessage: ${pass} passed, ${fail} failed, 0 xfail`);
process.exit(fail ? 1 : 0);
