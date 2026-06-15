// tests/test_reconciliation.js
// Pure-logic tests for lib/reconcile.js — reproduces the worked-example scores
// (docs/TRANSACTION_RECONCILIATION_MODEL.md section 6) and the key reconcile
// scenarios from the section-7 test plan (exact dup, fuzzy round, cross-day,
// card-settlement transfer, FX, double-import idempotency, blocked-by-amount).
// No network, no KV. Run: node tests/test_reconciliation.js
'use strict';
const R = require('../lib/reconcile.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS ' : '  FAIL ') + label + ' -> ' + JSON.stringify(got) + (ok ? '' : '  (want ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}
function near(label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol || 0.001);
  console.log((ok ? '  PASS ' : '  FAIL ') + label + ' -> ' + got + (ok ? '' : '  (want ~' + want + ')'));
  ok ? pass++ : fail++;
}

// category stub: maps a normalized import description -> Kesefle category
const CAT = { 'קפה גרג בעמ': 'אוכל', 'דלק פז': 'תחבורה', 'h&m': 'ביגוד' };
const categoryOf = (d) => CAT[R.normDesc(d)] || null;

const manual = (amount, desc, dateISO, over) => Object.assign({ uid: 'm_' + amount, source: 'manual', direction: 'expense', amount, descNorm: desc, category: categoryOf(desc) || (desc === 'קפה' ? 'אוכל' : desc === 'מסעדה' ? 'אוכל' : desc === 'מתנה' ? null : desc === 'ביגוד' ? 'ביגוד' : null), dateISO }, over || {});
const imp = (amount, desc, dateISO, over) => Object.assign({ uid: 'i_' + amount, source: 'import', direction: 'expense', amount, descNorm: desc, descRaw: desc, category: categoryOf(desc), dateISO }, over || {});

console.log('\n-- section 6 worked-example scores --');
// 1 exact
near('#1 35/35 same-day same-cat -> 1.00', R.scorePair(manual(35, 'קפה', '2026-06-08'), imp(35, 'קפה גרג בעמ', '2026-06-08'), { candidateCount: 1 }).score, 1.00);
// 2 fuzzy round
near('#2 35/34.90 same-day -> 0.95', R.scorePair(manual(35, 'קפה', '2026-06-08'), imp(34.90, 'קפה גרג בעמ', '2026-06-08'), { candidateCount: 1 }).score, 0.95);
// 3 cross-day (+2)
near('#3 35/34.90 +2d -> 0.84', R.scorePair(manual(35, 'קפה', '2026-06-08'), imp(34.90, 'קפה גרג בעמ', '2026-06-10'), { candidateCount: 1 }).score, 0.84);
// 4 unknown merchant +2d
near('#4 200/198.50 unknown +2d -> 0.74', R.scorePair(manual(200, 'מסעדה', '2026-06-05'), imp(198.50, 'unknown', '2026-06-07'), { candidateCount: 1 }).score, 0.74);
// 5 contradictory category
near('#5 35/34.50 דלק same-day -> 0.75', R.scorePair(manual(35, 'קפה', '2026-06-08'), imp(34.50, 'דלק פז', '2026-06-08'), { candidateCount: 1 }).score, 0.75);
// 7 exact amount, far date, unknown
near('#7 50/50 מתנה +4d unknown -> 0.68', R.scorePair(manual(50, 'מתנה', '2026-06-01'), imp(50, 'unknown', '2026-06-05'), { candidateCount: 1 }).score, 0.68);

console.log('\n-- decision thresholds --');
eq('1.00 -> auto_link', R.decide(1.00), 'auto_link');
eq('0.95 -> auto_link', R.decide(0.95), 'auto_link');
eq('0.84 -> needs_review', R.decide(0.84), 'needs_review');
eq('0.59 -> distinct', R.decide(0.59), 'distinct');

console.log('\n-- reconcile() end-to-end --');
// Case 1/2: exact-ish dup auto-links and consumes the manual row
let manualIdx = [manual(35, 'קפה', '2026-06-08')];
let out = R.reconcile([imp(34.90, 'קפה גרג בעמ', '2026-06-08')], manualIdx, { categoryOf });
eq('auto_link decision', out.results[0].decision, 'auto_link');
eq('linked to the manual uid', out.results[0].match, 'm_35');

// Case 3: cross-day -> needs_review, manual NOT consumed
out = R.reconcile([imp(34.90, 'קפה גרג בעמ', '2026-06-11')], [manual(35, 'קפה', '2026-06-08')], { categoryOf });
eq('cross-day -> needs_review', out.results[0].decision, 'needs_review');

// Case 8: blocked by amount (>2%) -> distinct
out = R.reconcile([imp(89, 'h&m', '2026-06-01')], [manual(120, 'ביגוד', '2026-06-01')], { categoryOf });
eq('amount >2% apart -> distinct', out.results[0].decision, 'distinct');

// Case 5: card-settlement transfer (matches issuer + ~= cycle sum) -> transfer
out = R.reconcile([imp(4231.77, 'חיוב ישראכרט', '2026-06-02')], [], { cycleSumFor: () => 4230.00 });
eq('card settlement -> transfer', out.results[0].decision, 'transfer');
eq('marked direction=transfer', out.results[0].row.direction, 'transfer');
// a card-issuer row WITHOUT a matching cycle sum is NOT auto-classified transfer
out = R.reconcile([imp(120, 'חיוב ישראכרט', '2026-06-02')], [], { cycleSumFor: () => null });
eq('issuer row, no cycle sum -> not transfer', out.results[0].decision, 'distinct');

// Case 7 (FX): manual 35 ILS coffee + import $34.80 @ 3.65 -> ~127 ILS? No: FX is
// for an import already in foreign currency matched to a foreign-entered manual.
// Here: import $9.6 @ 3.65 = 35.04 ILS vs manual 35 -> within 3% FX tolerance.
out = R.reconcile(
  [imp(9.6, 'קפה גרג בעמ', '2026-06-08', { currency: 'USD' })],
  [manual(35, 'קפה', '2026-06-08')],
  { categoryOf, rateFor: () => 3.65 }
);
eq('FX-normalized import auto-links', out.results[0].decision, 'auto_link');
near('FX import amount normalized to ILS', out.results[0].row.amount, 35.04, 0.02);

// Case 8 (idempotency): same import twice -> 2nd is a duplicate (no new row)
const seen = new Set();
const rows = [imp(50, 'unknown', '2026-06-01')];
R.reconcile(rows, [], { seenFingerprints: seen });
out = R.reconcile(rows, [], { seenFingerprints: seen });
eq('re-import same row -> duplicate', out.results[0].decision, 'duplicate');

// Tie rule: two same-amount same-day coffees -> both candidates >=0.9 -> review
out = R.reconcile([imp(35, 'קפה גרג בעמ', '2026-06-08')], [
  manual(35, 'קפה', '2026-06-08', { uid: 'm_a' }),
  manual(35, 'קפה', '2026-06-08', { uid: 'm_b' }),
], { categoryOf });
eq('twin candidates -> needs_review (never auto-pick)', out.results[0].decision, 'needs_review');

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' RECONCILE CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
