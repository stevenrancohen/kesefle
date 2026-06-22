#!/usr/bin/env node
// Locks the income sign-flip fixes (2026-06-11) via classify-one replay (which
// mirrors _resolveIsIncome_): money direction must be right -- a client payment
// booked as an expense (or payroll booked as income) corrupts the dashboard.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
function run(msg) {
  const out = execFileSync('node', [path.join(__dirname, 'classify-one.js'), msg], { encoding: 'utf8' });
  return { income: /income=true/.test(out), line: out.split('\n')[0] };
}
const CASES = [
  ['הכנסה משכירות 3000', true,  'הכנסות'],
  ['החזירו לי 50',        true,  null],
  ['משכורת לעובד 6000',   false, 'עסק'],
  ['לקוח שילם לי 4500',   true,  'עסק'],
  ['מלגה 1200',           true,  'הכנסות'],
  ['שילם לי 200',         true,  null],
  ['שילמתי משכורת 6000',  false, 'עסק'],
  ['משכורת של העובד 6000', false, 'עסק'],      // audit 2026-06-19: possessive payroll = expense
  ['משכורת של עובד 6000',  false, 'עסק'],      // (no ה) also expense
  ['משכורת 9000',         true,  'הכנסות'],   // control: own salary stays income
  ['שכר דירה 3200',       false, null],        // control: rent stays expense
  ['החזר הלוואה 500',     false, null],        // control: loan repayment stays expense
];
let pass = 0, fail = 0;
for (const [msg, wantIncome, wantCat] of CASES) {
  const r = run(msg);
  const okIncome = r.income === wantIncome;
  const okCat = !wantCat || r.line.includes(wantCat);
  if (okIncome && okCat) pass++;
  else { fail++; console.log('  FAIL "' + msg + '" -> ' + r.line + ' (want income=' + wantIncome + (wantCat ? ' cat~' + wantCat : '') + ')'); }
}
// Echo-defense: the 5 new reply families must be caught by _BOT_ECHO_REGEXES_
const SRC = require('node:fs').readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const arr = SRC.slice(SRC.indexOf('var _BOT_ECHO_REGEXES_ = ['));
const regexes = eval(arr.slice(arr.indexOf('['), arr.indexOf('];') + 1));
const ECHOES = [
  'ההוצאה לא נרשמה. שלח אותה שוב',
  '✅ *הקישור הושלם!*',
  '✅ *אתה כבר מחובר!*',
  '🛑 *הפעלה: 25%* (3/12)',
  '✅ נוצר דשבורד עסקי מסודר ל: כספלה',
];
for (const e of ECHOES) {
  if (regexes.some((rx) => rx.test(e))) pass++;
  else { fail++; console.log('  FAIL echo not caught: ' + e.slice(0, 40)); }
}
console.log('test_income_signfix: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
