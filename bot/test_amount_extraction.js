#!/usr/bin/env node
// bot/test_amount_extraction.js (auto-discovered by the gauntlet)
// Locks the amount-extraction fix (Steven 2026-06-08, QA fleet round 2). The
// parser used to grab the FIRST number, so a quantity / unit / road number /
// installment COUNT beat the real price (e.g. "5 tashlumim shel 99" recorded
// 5, "dlek 95 oktan 250" recorded 95). Now: numbers followed by a unit word or
// preceded by "kvish" are dropped, installments collapse to the price (largest
// survivor), and a shekel-anchored number wins. Single + multi-expense ("a + b")
// behaviour is unchanged. Runs through the REAL bot via classify-one.js.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ONE = path.join(__dirname, 'classify-one.js');
function amount(msg) {
  const o = execFileSync('node', [ONE, msg], { encoding: 'utf8' });
  const m = o.match(/amount=([\d.]+)/);
  return m ? parseFloat(m[1]) : NaN;
}
const CASES = [
  // installments -> the price, not the count
  ['5 תשלומים של 99', 99], ['מקרר 12 תשלומים של 300', 300], ['8 x 200', 200],
  // unit/spec numbers dropped -> the price
  ['דלק 95 אוקטן 250 שקל', 250], ['תדלוק 98 אוקטן ב300', 300],
  ['טיפול 10000 קמ במוסך 850', 850], ['דיסק קשיח 500gb ב320', 320],
  ['10 מטר כבל חשמל 90 שקל', 90], ['קניתי 4 יחידות במחיר 80 שקל', 80],
  // road number dropped
  ['כביש 6 אגרה 38.50', 38.5],
  // currency anchor beats a leftover quantity
  ['3 חולצות 240 שקל', 240],
  // quantity-noun + unit + product-code + brand-number (QA fleet round 3)
  ["סושי 8 פיסות 90", 90], ["3 פלאפלים 36", 36], ["factory 54 נעליים 899", 899],
  ["אומגה 3 קניתי ב 199", 199], ["ויטמין B12 זריקה 90", 90], ["תוסף אבץ 50 מ״ג 45", 45],
  ["פנסיון לחתול 7 ימים 420", 420], ["קרם SPF 50 בסופר פארם 89", 89],
  // unchanged: single number + genuine multi-expense (first item)
  ['85 קפה', 85], ['8500 משכורת', 8500], ['50 קפה + 30 חניה', 50],
];
let pass = 0, fail = 0;
for (const [msg, exp] of CASES) {
  const a = amount(msg);
  if (Math.abs(a - exp) < 0.01) pass++;
  else { fail++; console.log('  FAIL "' + msg + '" want=' + exp + ' got=' + a); }
}
console.log('test_amount_extraction: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
