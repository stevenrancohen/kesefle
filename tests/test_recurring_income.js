// Unit test: _detectRecurringIncomeCandidate_ (PR #18).
//
// Mirrors tests/recurring_detect.js but for the INCOME side. Validates:
//   - fires when same income appears in 3+ distinct months with stable amount
//   - does NOT fire on expenses (only income)
//   - does NOT fire when amount varies > maxRatio (1.5)
//   - does NOT fire when < 3 distinct months
//   - returns the average amount + count + cleaned description
//
// Run: node tests/test_recurring_income.js

import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../bot/ExpenseBot_FIXED.gs', import.meta.url), 'utf8');

function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, j);
}
// Pull both _normForRecurring_ + _detectRecurringIncomeCandidate_.
const normSrc = sliceBetween(SRC, 'function _normForRecurring_', '\nfunction _detectRecurringCandidate_');
const incomeSrc = sliceBetween(SRC, 'function _detectRecurringIncomeCandidate_', '\nfunction _recurringIncomeSuggestionLine_');
const sandbox = {};
new Function('sandbox', normSrc + '\n' + incomeSrc + '\nsandbox.detect = _detectRecurringIncomeCandidate_;')(sandbox);
const detect = sandbox.detect;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('=== POSITIVE: 3+ months stable income ===\n');

{
  // Salary that's identical 3 months — should fire.
  const history = [
    { description: 'משכורת', amount: 8500, monthKey: '2026-03', isIncome: true },
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 8500, monthKey: '2026-05', isIncome: true };
  const result = detect(history, current);
  check('detects identical salary across 3 months', result !== null);
  check('count === 3', result && result.count === 3, 'got ' + (result ? result.count : 'null'));
  check('amount === 8500', result && result.amount === 8500);
  check('desc preserved', result && result.desc === 'משכורת');
}

{
  // Salary that varies within 1.5x — should fire.
  const history = [
    { description: 'משכורת', amount: 8000, monthKey: '2026-03', isIncome: true },
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 9000, monthKey: '2026-05', isIncome: true };
  const result = detect(history, current);
  check('detects salary with mild variance (within 1.5x)', result !== null);
  check('avg amount is ~8500', result && Math.abs(result.amount - 8500) <= 100);
}

console.log('\n=== NEGATIVE: should NOT fire ===\n');

{
  // Only 2 months — below minMonths=3
  const history = [
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 8500, monthKey: '2026-05', isIncome: true };
  check('does NOT fire with only 2 months', detect(history, current) === null);
}

{
  // Same descs but mixed income/expense — only count income matches
  const history = [
    { description: 'משכורת', amount: 8500, monthKey: '2026-03', isIncome: false }, // expense (wrong)
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 8500, monthKey: '2026-05', isIncome: true };
  check('does NOT count expenses toward income recurrence', detect(history, current) === null);
}

{
  // Current is an expense — function only triggers for income current.
  const history = [
    { description: 'משכורת', amount: 8500, monthKey: '2026-03', isIncome: true },
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 8500, monthKey: '2026-05', isIncome: false };
  check('does NOT fire when current is an expense', detect(history, current) === null);
}

{
  // Amount varies > 1.5x — bonus month, not a stable salary
  const history = [
    { description: 'משכורת', amount: 8000, monthKey: '2026-03', isIncome: true },
    { description: 'משכורת', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'משכורת', amount: 16000, monthKey: '2026-05', isIncome: true }; // 2x bonus
  check('does NOT fire when amount varies > 1.5x', detect(history, current) === null);
}

{
  // Different descriptions — not recurring
  const history = [
    { description: 'משכורת', amount: 8500, monthKey: '2026-03', isIncome: true },
    { description: 'בונוס', amount: 8500, monthKey: '2026-04', isIncome: true },
  ];
  const current = { description: 'תקבול לקוח', amount: 8500, monthKey: '2026-05', isIncome: true };
  check('does NOT fire for distinct descriptions', detect(history, current) === null);
}

console.log('\n=== EDGE CASES ===\n');

check('null current returns null', detect([], null) === null);
check('undefined current returns null', detect([], undefined) === null);
check('current with no description returns null',
  detect([], { description: '', amount: 5000, isIncome: true, monthKey: '2026-05' }) === null);
check('current with zero amount returns null',
  detect([], { description: 'משכורת', amount: 0, isIncome: true, monthKey: '2026-05' }) === null);
check('current with negative amount handled',
  detect([], { description: 'משכורת', amount: -100, isIncome: true, monthKey: '2026-05' }) === null);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
