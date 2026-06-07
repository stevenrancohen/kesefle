#!/usr/bin/env node
// Pins the REAL current currency contract of the bot (rewritten 2026-06-07).
//
// HISTORY: this test used to assert "there is NO FX conversion; every row is
// written as ILS with the raw number". That contract is OBSOLETE. The bot now
// auto-converts foreign currency to ILS at fixed rates via
// parseForeignCurrencyHint (Paths A/B/C) before writing the row. The old test
// still "passed" only because it scanned for FX functions by the wrong names
// (getExchangeRate/fxConvert), so it silently lied. This rewrite asserts what is
// actually true today.
//
// THE REAL CONTRACT
//   1. The sheet column is always ILS — the row's `currency` field is 'ILS'
//      (we store the CONVERTED shekel amount, never a foreign code).
//   2. An FX engine exists: parseForeignCurrencyHint + _kfl_fxRate + _kfl_fxLookup.
//   3. A static rate table defines USD/EUR/GBP/CAD/AUD/JPY/CHF.
//   4. Hebrew multi-word names ("דולר קנדי"=CAD, "דולר אוסטרלי"=AUD) are matched
//      BEFORE the generic "דולר" (=USD), so a Canadian/Australian dollar never
//      converts at the US rate. (This is the money bug fixed 2026-06-07.)
//   5. The note field still has its currency-symbol strip step.
//
// This is a CONTRACT PIN: if the FX design changes, update these assertions
// deliberately. Behavioral rate values live in tests/test_fx_cad_aud_rate.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BOT_PATH = path.join(ROOT, 'bot', 'ExpenseBot_FIXED.gs');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_currency_hardcoded_ils_contract.js\n');

const src = fs.readFileSync(BOT_PATH, 'utf8');

// 1. Rows are still written with currency:'ILS' (we store converted shekels).
const ilsLiteralMatches = src.match(/currency\s*:\s*['"]ILS['"]/g) || [];
assert(ilsLiteralMatches.length >= 3,
  "bot writes currency:'ILS' on every row (converted shekels) — found " + ilsLiteralMatches.length);

// 2. The FX engine exists (the old test wrongly assumed it did not).
assert(/function\s+parseForeignCurrencyHint\s*\(/.test(src), 'parseForeignCurrencyHint() is defined (FX engine present)');
assert(/function\s+_kfl_fxRate\s*\(/.test(src), '_kfl_fxRate() is defined');
assert(/function\s+_kfl_fxLookup\s*\(/.test(src), '_kfl_fxLookup() is defined');

// 3. A static rate table covers all 7 supported currencies.
['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF'].forEach(function (code) {
  assert(new RegExp('\\b' + code + '\\b').test(src), 'static FX table references ' + code);
});

// 4. THE FIX: in _kfl_fxLookup, the Hebrew CAD/AUD branches must come BEFORE the
//    generic USD branch, or "דולר קנדי" falls through to USD (wrong rate).
const lookupBody = src.slice(src.indexOf('function _kfl_fxLookup'), src.indexOf('function _kfl_fxLookup') + 1200);
// The Hebrew CAD/AUD return statements must precede the Hebrew GENERIC-"דולר"
// USD return (the LAST _kfl_fxRate('USD') in the function), or "דולר קנדי" falls
// through to USD. (The first _kfl_fxRate('USD') is the '$' symbol branch — not
// relevant to ordering, so we anchor on lastIndexOf for the Hebrew branch.)
const idxCadReturn = lookupBody.indexOf("_kfl_fxRate('CAD')");
const idxAudReturn = lookupBody.indexOf("_kfl_fxRate('AUD')");
const idxHebUsdReturn = lookupBody.lastIndexOf("_kfl_fxRate('USD')");
assert(idxCadReturn > -1 && idxHebUsdReturn > -1 && idxCadReturn < idxHebUsdReturn,
  '_kfl_fxLookup resolves CAD (דולר קנדי) before the generic USD branch');
assert(idxAudReturn > -1 && idxHebUsdReturn > -1 && idxAudReturn < idxHebUsdReturn,
  '_kfl_fxLookup resolves AUD (דולר אוסטרלי) before the generic USD branch');

// 4b. The multi-word CAD/AUD tokens are woven through every FX path (lookup,
//     Path B amount-adjacent, Path C non-adjacent, cleanup, note), so every
//     word order is covered. Count occurrences as a cheap structural proxy.
assert((src.match(/קנדי/g) || []).length >= 4, '"קנדי" (Canadian) appears across multiple FX paths');
assert((src.match(/אוסטרלי/g) || []).length >= 4, '"אוסטרלי" (Australian) appears across multiple FX paths');

// 5. The note still strips currency symbols (₪ / שח / שקל) before writing.
assert(/(replace\([^)]*₪|replace\([^)]*שח|replace\([^)]*שקל)/.test(src),
  'bot strips currency symbols from the note field before writing the row');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
