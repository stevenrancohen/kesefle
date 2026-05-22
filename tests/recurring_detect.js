// Unit tests for the PURE proactive-recurring detector.  run: node tests/recurring_detect.js
// Loads _normForRecurring_ + _detectRecurringCandidate_ from the real bot source
// (no mock) and exercises the gates that decide whether to OFFER making a
// repeating expense recurring. The integration wrapper (_recurringSuggestionLine_)
// is not tested here — it does PropertiesService I/O — but it's a thin shell
// over this logic.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../bot/ExpenseBot_FIXED.gs', 'utf8');
function fn(name) {
  const start = src.indexOf('function ' + name + '('); let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
(0, eval)(fn('_normForRecurring_'));
(0, eval)(fn('_detectRecurringCandidate_'));

let pass = 0, fail = 0; const fails = [];
function ok(label, cond) { if (cond) { pass++; console.log('  ✅ ' + label); } else { fail++; fails.push(label); console.log('  ❌ ' + label); } }

// Helper to build a row
const R = (description, amount, monthKey, isIncome) => ({ description, amount, monthKey, isIncome: !!isIncome });

console.log('\n── _normForRecurring_ ──');
ok('strips amount/currency', _normForRecurring_('נטפליקס 45') === _normForRecurring_('נטפליקס 50'));
ok('collapses whitespace + lowercases', _normForRecurring_('  Netflix   ') === 'netflix');
ok('empty → empty', _normForRecurring_('') === '' && _normForRecurring_(null) === '');

console.log('\n── _detectRecurringCandidate_: should SUGGEST ──');
// Netflix logged Jan, Feb, current March — stable amount → suggest (count 3)
let r = _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-01'), R('נטפליקס', 45, '2026-02')],
  R('נטפליקס', 45, '2026-03'));
ok('3 distinct months, stable → suggests', !!r && r.count === 3);
ok('  reports avg amount', r && r.amount === 45);

// 4 months, mild amount variation within ratio (45..50 → 1.11)
r = _detectRecurringCandidate_(
  [R('ספוטיפיי', 45, '2026-01'), R('ספוטיפיי', 50, '2026-02'), R('ספוטיפיי', 48, '2026-03')],
  R('ספוטיפיי', 47, '2026-04'));
ok('4 months, small variation → suggests', !!r && r.count === 4);

// Amount embedded in description varies but normalizes equal
r = _detectRecurringCandidate_(
  [R('נטפליקס 45', 45, '2026-01'), R('נטפליקס 45', 45, '2026-02')],
  R('נטפליקס 45', 45, '2026-03'));
ok('digits-in-desc still grouped → suggests', !!r && r.count === 3);

console.log('\n── _detectRecurringCandidate_: should NOT suggest ──');
ok('only 2 months → no', _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-01')], R('נטפליקס', 45, '2026-02')) === null);

ok('3 times SAME month → no (need distinct months)', _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-03'), R('נטפליקס', 45, '2026-03')], R('נטפליקס', 45, '2026-03')) === null);

ok('income (משכורת) → no', _detectRecurringCandidate_(
  [R('משכורת', 12000, '2026-01', true), R('משכורת', 12000, '2026-02', true)],
  R('משכורת', 12000, '2026-03', true)) === null);

ok('noisy amounts (groceries) → no (ratio > 1.5)', _detectRecurringCandidate_(
  [R('סופר', 120, '2026-01'), R('סופר', 340, '2026-02')],
  R('סופר', 600, '2026-03')) === null);

ok('different descriptions → no', _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-01'), R('ספוטיפיי', 20, '2026-02')],
  R('דיסני', 30, '2026-03')) === null);

ok('zero amount → no', _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-01'), R('נטפליקס', 45, '2026-02')],
  R('נטפליקס', 0, '2026-03')) === null);

ok('empty description → no', _detectRecurringCandidate_(
  [R('', 45, '2026-01'), R('', 45, '2026-02')], R('', 45, '2026-03')) === null);

ok('null current → no', _detectRecurringCandidate_([], null) === null);

// A genuine subscription whose price jumped a lot (45 → 90) should NOT trigger
ok('price doubled → no (instability)', _detectRecurringCandidate_(
  [R('חדר כושר', 45, '2026-01'), R('חדר כושר', 45, '2026-02')],
  R('חדר כושר', 90, '2026-03')) === null);

// Custom opts: minMonths=2 lets a 2-month repeat through
r = _detectRecurringCandidate_(
  [R('ביטוח', 200, '2026-01')], R('ביטוח', 200, '2026-02'), { minMonths: 2 });
ok('opts.minMonths=2 → suggests on 2nd month', !!r && r.count === 2);

console.log('\n' + (fail === 0
  ? '✅ ALL ' + pass + ' RECURRING-DETECT CHECKS PASSED'
  : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
