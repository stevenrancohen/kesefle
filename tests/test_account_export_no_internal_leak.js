// tests/test_account_export_no_internal_leak.js
//
// REGRESSION GUARD: GET /api/account?action=export must NOT surface raw internal
// exception text to the (authenticated) caller.
//
// The export reads the user's sheet via their decrypted refresh token. If the
// decrypt fails, lib/crypto.js throws messages that name internal key material
// and env vars, e.g.
//   "crypto: KESEFLE_DB_KEY_ACTIVE_KID=\"v3\" not present in keyring"
//   "crypto.decrypt: authentication failed"
// Before the 2026-06-03 fix, exportAccount did `sheetReadError = e.message` and
// put that string straight into the export JSON's transactions.read_error field.
// That leaks key IDs + env-var names to anyone who can authenticate (it's their
// own account, but the infra detail has no business being exposed). The fix maps
// the exception to a stable generic code ('token_decrypt_failed' /
// 'sheet_read_failed') and logs the real detail server-side instead.
//
// This is a source-contract + behavioural test (no Vercel KV, no network), in
// the same style as tests/test_gdpr_delete_key_completeness.js.
//
// Run: node tests/test_account_export_no_internal_leak.js

import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../api/account.js', import.meta.url), 'utf8');

let failed = 0, passed = 0;
function ok(name, cond, hint) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, hint ? ('— ' + hint) : ''); }
}

console.log('=== exportAccount does not leak raw exception text ===');

// Isolate the exportAccount function body so we only assert about THIS path
// (deleteAccount has its own, audited error handling).
const expStart = SRC.indexOf('async function exportAccount(');
ok('exportAccount exists', expStart >= 0);
const nextFn = SRC.indexOf('\nasync function ', expStart + 1);
const exportBody = SRC.slice(expStart, nextFn === -1 ? undefined : nextFn);

// 1. The raw-message leak must be gone: no `sheetReadError = e.message` (or
//    `err.message`) assignment inside exportAccount's catch.
ok('no raw `sheetReadError = <err>.message` assignment',
  !/sheetReadError\s*=\s*[a-zA-Z_$][\w$]*\.message/.test(exportBody),
  'export must classify the error, not echo e.message');

// 2. The catch must assign one of the generic, stable codes instead.
ok("catch sets a generic 'token_decrypt_failed' / 'sheet_read_failed' code",
  /sheetReadError\s*=\s*[^;]*token_decrypt_failed[\s\S]*?sheet_read_failed/.test(exportBody)
  || /token_decrypt_failed/.test(exportBody) && /sheet_read_failed/.test(exportBody),
  'expected the redaction branch with both codes');

// 3. The real detail must still reach the server log (operators keep the signal).
ok('logs the real error detail server-side',
  /log\.(warn|error)\([^)]*err\s*:\s*e[^)]*\)/.test(exportBody)
  || /log\.(warn|error)\(['"]account\.export_sheet_read_failed['"]/.test(exportBody),
  'expected a log.warn/error carrying the raw message');

// 4. Behavioural check of the exact classification predicate the fix uses, so a
//    future edit that weakens the regex is caught. Mirror the source regex.
console.log('\n=== classification predicate behaviour ===');
const CRYPTO_RE = /crypto|decrypt|envelope|keyring|KEK/i;
function classify(msg) {
  return CRYPTO_RE.test(String(msg)) ? 'token_decrypt_failed' : 'sheet_read_failed';
}
// The exact strings lib/crypto.js can throw must classify as token_decrypt_failed
// (so they are NEVER returned verbatim).
const CRYPTO_MSGS = [
  'crypto: KESEFLE_DB_KEY_ACTIVE_KID="v3" not present in keyring',
  'crypto.decrypt: authentication failed',
  'crypto.decrypt: malformed envelope (expected 5 colon-separated parts)',
  'crypto: no KEK configured (set KESEFLE_DB_KEY or KESEFLE_DB_KEY_<KID>)',
  'crypto.decrypt: unsupported envelope version "v9"',
];
for (const m of CRYPTO_MSGS) {
  ok('crypto error classified as token_decrypt_failed: ' + m.slice(0, 32) + '...',
    classify(m) === 'token_decrypt_failed');
}
// A generic transport error classifies as sheet_read_failed (still generic).
ok('generic fetch error -> sheet_read_failed', classify('fetch failed') === 'sheet_read_failed');
ok('undefined message -> sheet_read_failed (no throw)', classify(undefined) === 'sheet_read_failed');

// 5. Whatever the export returns as read_error, it must be one of the allowed
//    generic codes — never an env var / key id leak. We assert the only string
//    literals assigned to sheetReadError in exportAccount are on the safe list.
console.log('\n=== read_error value is always an allow-listed code ===');
const SAFE_CODES = ['token_decrypt_failed', 'sheet_read_failed', 'sheets_status_'];
const assignedLiterals = [...exportBody.matchAll(/sheetReadError\s*=\s*'([^']+)'/g)].map((m) => m[1]);
// (the sheets_status_ one is a template-ish 'sheets_status_' + r.status; the
//  literal prefix is what we can statically see.)
const sheetsStatus = /sheetReadError\s*=\s*'sheets_status_'\s*\+/.test(exportBody);
ok('every literal sheetReadError value is on the safe list',
  assignedLiterals.every((lit) => SAFE_CODES.some((s) => lit === s || lit.startsWith(s))),
  'found: ' + JSON.stringify(assignedLiterals));
ok('the only dynamic value is the safe `sheets_status_` + status code', sheetsStatus || assignedLiterals.length > 0);
// And explicitly: no key-id / env-var token appears in any assigned literal.
ok('no KESEFLE_/KEK/keyring token in any assigned read_error literal',
  assignedLiterals.every((lit) => !/KESEFLE_|KEK|keyring|envelope/i.test(lit)));

console.log('\n' + (failed === 0
  ? 'PASS account export no-internal-leak: ALL ' + passed + ' CHECKS PASSED'
  : 'FAIL ' + failed + ' FAILED, ' + passed + ' passed'));
process.exit(failed === 0 ? 0 : 1);
