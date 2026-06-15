#!/usr/bin/env node
// bot/test_refund_income.js (auto-discovered by the gauntlet)
// Locks the refund-from-merchant income pre-check in _resolveIsIncome_ (Steven
// 2026-06-08, QA fleet r3): a store refund/credit ("zikui me-Castro", "hechzer
// al kniya", "kibalti hechzer") is money coming BACK -> income, even though the
// merchant keyword routed the category to the store's bucket. Guarded so a loan
// repayment ("hechzer halvaa") and a bare ambiguous "zikui" are NOT flipped.
// Loads the REAL functions from source via balanced-brace extraction (no mocks).
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { started = true; depth++; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  return '';
}
eval(extract('_isIncomeCategory_'));
eval(extract('_resolveIsIncome_'));

const CASES = [
  // refund / store credit FROM a place -> income (even though category = merchant)
  ['החזר מקסטרו על חולצה 200', 'קניות', 'ביגוד', true],
  ['זיכוי מטרמינל איקס 150', 'קניות', 'ביגוד', true],
  ['החזר על קנייה 80', 'שונות ואחרים', 'שונות', true],
  ['קיבלתי החזר 200', 'שונות ואחרים', 'שונות', true],
  ['זוכיתי 120', 'שונות ואחרים', 'שונות', true],
  // must NOT flip: loan repayment, bare ambiguous "zikui", normal expense
  ['החזר הלוואה 500', 'שונות ואחרים', 'שונות', false],
  ['זיכוי 300', 'שונות ואחרים', 'שונות', false],
  ['85 קפה', 'אוכל', 'אוכל בחוץ', false],
  // explicit income still income
  ['8500 משכורת', 'הכנסות', 'משכורת', true],
  // audit 2026-06-15: "כספי" between the refund word and the מ-source must still
  // flip to income (the regex previously required מ immediately after החזר/זיכוי)
  ['החזר כספי מהמסעדה 120', 'אוכל', 'אוכל בחוץ', true],
  ['זיכוי כספי מהחנות 90', 'קניות', 'ביגוד', true],
  // control: a refund GIVEN TO someone (ל-prefix) stays an EXPENSE
  ['החזר כספי לחבר 200', 'שונות ואחרים', 'שונות', false],
  // audit 2026-06-15: a WhatsApp-pasted RLM (U+200F) before the '+' income
  // convention must not defeat it (.trim() does not strip directional marks)
  ['\u200F+3000 העברה', 'שונות ואחרים', 'שונות', true],
];
let pass = 0, fail = 0;
for (const [msg, cat, sub, exp] of CASES) {
  const got = _resolveIsIncome_(null, msg, cat, sub);
  if (got === exp) pass++;
  else { fail++; console.log('  FAIL "' + msg + '" want income=' + exp + ' got=' + got); }
}
console.log('test_refund_income: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
