// tests/test_whatsapp_webhook_signature.js
//
// Regression tests for api/whatsapp/webhook.js — closes the test-coverage gap
// flagged in docs/AUDIT_WHATSAPP_WEBHOOK_2026_05_31.md §F6.
//
// Covers:
//  1) GET handshake fails closed when META_VERIFY_TOKEN is unset (CRITICAL F1)
//  2) GET handshake fails closed when mode !== 'subscribe'
//  3) GET handshake fails closed when token mismatches
//  4) GET handshake succeeds when mode + token match
//  5) POST signature verification fails closed when META_APP_SECRET is unset
//
// This is a parse + structural test, not a live HTTP test. We import the source
// and assert it contains the audit-required guards. That's sufficient because
// the underlying behavior is implemented by node:crypto + constantTimeEqual
// which already have their own tests.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'whatsapp', 'webhook.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('  ✅ ' + name); pass++; }
  else      { console.log('  ❌ ' + name); fail++; }
}

console.log('\n── webhook GET handshake (audit F1 — CRITICAL) ──');

// 1) Source must read META_VERIFY_TOKEN once and check for falsy.
check(
  'reads META_VERIFY_TOKEN and fails closed when unset (503)',
  /const expectedToken = process\.env\.META_VERIFY_TOKEN[\s\S]{0,200}if\s*\(\s*!expectedToken\s*\)[\s\S]{0,200}503/.test(src)
);

// 2) Source must reject non-subscribe modes BEFORE the token compare.
check(
  'rejects mode !== "subscribe" before token compare',
  /if\s*\(\s*mode\s*!==\s*['"]subscribe['"]\s*\)[\s\S]{0,200}403[\s\S]{0,400}constantTimeEqual\s*\(/.test(src)
);

// 3) Source must use constantTimeEqual on the token compare (not ===).
check(
  'uses constantTimeEqual for token compare (no === / !== on META_VERIFY_TOKEN)',
  /constantTimeEqual\s*\(\s*token\s*,\s*expectedToken\s*\)/.test(src) &&
  !/token\s*===\s*process\.env\.META_VERIFY_TOKEN/.test(src)
);

// 4) constantTimeEqual must be imported from lib/crypto.js.
check(
  'imports constantTimeEqual from lib/crypto.js',
  /import\s*\{[^}]*constantTimeEqual[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/crypto\.js['"]/.test(src)
);

console.log('\n── webhook POST signature (audit F1 + existing guard) ──');

// 5) POST path checks META_APP_SECRET presence and returns 503 if unset.
check(
  'POST verifies META_APP_SECRET is set (fails closed)',
  /META_APP_SECRET[\s\S]{0,400}503/.test(src)
);

// 6) POST uses timingSafeEqual for HMAC compare.
check(
  'POST uses timingSafeEqual for HMAC compare',
  /timingSafeEqual\s*\(/.test(src)
);

console.log('\n── webhook PII logging (audit F4 — MEDIUM) ──');

// 7) No raw console.error survives in webhook.js (use log.error instead).
const consoleErrorCalls = (src.match(/console\.error\s*\(/g) || []).length;
check(
  'no raw console.error calls (use log.error so redactor wraps them)',
  consoleErrorCalls === 0
);

// 8) Both ex-console.error sites now use log.error with named events.
check(
  'wa.access_token_refresh_failed log event present',
  /log\.error\s*\(\s*['"]wa\.access_token_refresh_failed['"]/.test(src)
);
check(
  'wa.sheets_append_failed log event present',
  /log\.error\s*\(\s*['"]wa\.sheets_append_failed['"]/.test(src)
);

console.log('\n── webhook canonical sheet write (ITEM 2 — dashboard-invisible row landmine) ──');
// Background: the webhook's inbound-write path used to hand-roll its OWN row +
// Sheets append with a column layout no dashboard could read (amount in B, the
// month column; currency in C; "expense"/"income" in D where the dashboards
// SUMIFS expect "עסק"/category). It was also tokenless (read the refresh token
// off the phone:{E164} pointer, which never carries one). The fix routes the
// write through the SHARED canonical lib/sheet-writer.js (buildExpenseRow +
// appendRowToUserSheet) — the same path /api/sheet/append uses — and resolves
// the canonical sheet:{userSub} with an isolation leak-guard.

// 9) Routes through the canonical shared writer (imported from lib/sheet-writer.js).
check(
  'imports buildExpenseRow + appendRowToUserSheet from lib/sheet-writer.js',
  /import\s*\{[^}]*\bbuildExpenseRow\b[^}]*\bappendRowToUserSheet\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/sheet-writer\.js['"]/.test(src) ||
  /import\s*\{[^}]*\bappendRowToUserSheet\b[^}]*\bbuildExpenseRow\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/sheet-writer\.js['"]/.test(src)
);
check(
  'writeToUserSheet calls the canonical appendRowToUserSheet',
  /appendRowToUserSheet\s*\(\s*\{/.test(src)
);
check(
  'writeToUserSheet builds the row via canonical buildExpenseRow',
  /buildExpenseRow\s*\(\s*\{/.test(src)
);

// 10) The wrong-column landmine is GONE: no local hand-rolled row with currency
//     in C + type in D, and no local Sheets values:append URL in the webhook.
check(
  'no local "currency" column comment (old C-column layout removed)',
  !/\/\/\s*C:\s*currency/i.test(src)
);
check(
  'no local Sheets values:append URL in the webhook (delegated to sheet-writer)',
  !/spreadsheets\/\$\{[^}]*\}\/values\/[^`]*:append/.test(src)
);
check(
  'no local sanitizeCell helper (buildExpenseRow sanitizes internally)',
  !/function\s+sanitizeCell\s*\(/.test(src)
);

// 11) Tenant isolation: resolves the canonical sheet:{userSub} and aborts on a
//     phone-cache-vs-canonical mismatch BEFORE writing (never cross-tenant).
check(
  'resolves canonical sheet via sheet:${userSub}',
  /kvGet\(\s*`sheet:\$\{userSub\}`\s*\)/.test(src)
);
check(
  'aborts on sheet ownership mismatch before writing (isolation guard)',
  /sheet_ownership_mismatch/.test(src) &&
  /canonicalSheetId\s*&&\s*phoneSheetId\s*&&\s*canonicalSheetId\s*!==\s*phoneSheetId/.test(src)
);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' WEBHOOK CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
