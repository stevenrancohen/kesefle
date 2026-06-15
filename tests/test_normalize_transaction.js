// tests/test_normalize_transaction.js
// Pure tests for lib/normalize-transaction.js — date coercion, amount parsing,
// direction, currency, masking, idempotency fingerprint, batch filtering.
// Run: node tests/test_normalize_transaction.js
'use strict';
const N = require('../lib/normalize-transaction.js');
const R = require('../lib/reconcile.js');

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  PASS ' : '  FAIL ') + label + ' -> ' + JSON.stringify(got) + (ok ? '' : '  (want ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}

console.log('\n-- toISODate --');
eq('DD/MM/YYYY', N.toISODate('08/06/2026'), '2026-06-08');
eq('DD.MM.YY', N.toISODate('8.6.26'), '2026-06-08');
eq('ISO passthrough', N.toISODate('2026-06-08'), '2026-06-08');
eq('invalid -> empty', N.toISODate('not a date'), '');

console.log('\n-- normalizeImportRow --');
let r = N.normalizeImportRow({ date: '08/06/2026', amount: '₪34.90', description: 'קפה גרג בע"מ', source: 'import', provider: 'isracard', externalId: 'tx123' });
eq('dateISO', r.dateISO, '2026-06-08');
eq('month', r.month, '2026-06');
eq('year', r.year, '2026');
eq('amount magnitude', r.amount, 34.90);
eq('default direction expense', r.direction, 'expense');
eq('currency default ILS', r.currency, 'ILS');
eq('descNorm normalized', r.descNorm, R.normDesc('קפה גרג בע"מ'));
eq('externalId carried', r.externalId, 'tx123');
eq('fingerprint present', typeof r.fingerprint === 'string' && r.fingerprint.length > 0, true);

// EU thousands + decimal comma
eq('"1.234,50" -> 1234.5', N.normalizeImportRow({ date: '2026-06-08', amount: '1.234,50' }).amount, 1234.5);

// explicit income
eq('isIncome=true -> income', N.normalizeImportRow({ date: '2026-06-08', amount: 8000, isIncome: true }).direction, 'income');
// negative amount magnitude
eq('negative amount -> positive magnitude', N.normalizeImportRow({ date: '2026-06-08', amount: -55 }).amount, 55);
// currency NIS -> ILS
eq('NIS -> ILS', N.normalizeImportRow({ date: '2026-06-08', amount: 10, currency: 'NIS' }).currency, 'ILS');
// USD preserved
eq('USD preserved', N.normalizeImportRow({ date: '2026-06-08', amount: 10, currency: 'usd' }).currency, 'USD');
// card masking
eq('cardLast4 masked to 4', N.normalizeImportRow({ date: '2026-06-08', amount: 10, cardLast4: '4580123412341234' }).cardLast4, '1234');

console.log('\n-- unusable rows -> null --');
eq('no amount -> null', N.normalizeImportRow({ date: '2026-06-08', description: 'x' }), null);
eq('no date -> null', N.normalizeImportRow({ amount: 50 }), null);
eq('zero amount -> null', N.normalizeImportRow({ date: '2026-06-08', amount: 0 }), null);

console.log('\n-- batch filters nulls + feeds reconcile --');
const batch = N.normalizeBatch([
  { date: '08/06/2026', amount: 34.9, description: 'קפה גרג', source: 'import' },
  { date: 'garbage', amount: 10 },               // dropped (bad date)
  { date: '2026-06-09', amount: 0 },             // dropped (zero)
  { date: '2026-06-09', amount: 120, description: 'h&m', source: 'import' },
], { provider: 'isracard' });
eq('batch keeps 2 usable rows', batch.length, 2);
// the normalized rows are reconcile-ready (fingerprint dedups a re-import)
const seen = new Set();
R.reconcile(batch, [], { seenFingerprints: seen });
const out = R.reconcile(batch, [], { seenFingerprints: seen });
eq('re-running same batch -> all duplicates', out.results.every((x) => x.decision === 'duplicate'), true);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' NORMALIZE CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
