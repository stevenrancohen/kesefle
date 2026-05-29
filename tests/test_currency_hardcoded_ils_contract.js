#!/usr/bin/env node
// Pins the CURRENT contract that the bot writes every expense as currency 'ILS'
// regardless of input symbol (₪, $, €, £, dollars, euro, etc.).
//
// Why this exists:
//   - bot/ExpenseBot_FIXED.gs hardcodes `currency: 'ILS'` at multiple write
//     sites (around lines 6281, 6371, 6551 at time of writing).
//   - There is currently NO FX conversion. Users who send "100$ Amazon" get
//     a row written as 100 ILS with note 'Amazon'.
//   - When/if FX is added (Gap 6 in QA_RUN_REPORT_AUTONOMOUS_BLOCK.md), this
//     test SHOULD start failing — at which point the author updates it
//     intentionally to reflect the new multi-currency contract.
//
// This test is a CONTRACT PIN, not an aspiration. If it fails it means
// someone added multi-currency handling without updating the spec.
//
// Pattern: load real source via fs, scan for the contract markers.

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

// 1. The literal string `currency: 'ILS'` appears multiple times — confirms
//    the bot writes ILS on every expense row.
const ilsLiteralRe = /currency\s*:\s*['"]ILS['"]/g;
const ilsLiteralMatches = src.match(ilsLiteralRe) || [];
assert(ilsLiteralMatches.length >= 3,
  "bot hardcodes currency:'ILS' at >= 3 write sites (found " +
  ilsLiteralMatches.length + ')');

// 2. No OTHER hardcoded currency literal appears as a write value (would
//    indicate partial / accidental FX support).
// Allow currency strings inside comments, but not as a key:value write.
const otherCurrencyWriteRe = /currency\s*:\s*['"](?:USD|EUR|GBP|JPY|CHF|CAD|AUD)['"]/g;
const otherCurrencyMatches = src.match(otherCurrencyWriteRe) || [];
assert(otherCurrencyMatches.length === 0,
  'no non-ILS currency literal appears as a write value (found ' +
  otherCurrencyMatches.length + ')');

// 3. There is no `getExchangeRate` / `fxConvert` / `convertCurrency` call
//    in the bot source — that would indicate live FX is wired up.
const fxCallRe = /(getExchangeRate|fxConvert|convertCurrency|exchangeRate\()/;
assert(!fxCallRe.test(src),
  'no FX conversion call in bot source (currently single-currency-only)');

// 4. The numeric parser strips currency-symbol noise consistently. We don't
//    test it parses the AMOUNT correctly here — that's bot/test_parser.js —
//    but we DO confirm the parser file does mention $ / dollar / euro / etc.
//    so that when FX is added, the test author knows where the parsing lives.
const parserMentionsCurrencySymbols =
  /\$|דולר|euro|יורו|פאונד|GBP|£|€/.test(src);
assert(parserMentionsCurrencySymbols,
  'parser code references currency symbols ($/€/£/דולר/יורו) somewhere — when FX lands, update those sites');

// 5. The note field on a write is NOT silently corrupted by currency symbols.
//    We verify there's a strip step (₪ / שח / שקל) that drops them from the
//    note before write. This already passes in bot/test_parser.js but we
//    re-anchor it here as a currency-contract concern.
const noteStripRe = /(replace\([^)]*₪|replace\([^)]*שח|replace\([^)]*שקל)/;
assert(noteStripRe.test(src),
  'bot strips currency symbols from the note field before writing the row');

console.log('');
console.log('When multi-currency FX support is added (per Gap 6), this test');
console.log('is EXPECTED to fail and force a deliberate contract update.');
console.log('');

if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
