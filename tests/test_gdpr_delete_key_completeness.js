// tests/test_gdpr_delete_key_completeness.js
//
// 2026-05-29 resweep R1: contract test that api/account.js has a single
// unified _keysForUser_ helper and that both deleteAccount and
// deleteByPhone call it (instead of maintaining drifted inline key lists).
//
// Before this fix, deleteAccount (web/cookie auth path) missed 6 per-user
// KV prefixes that deleteByPhone (bot path) had, and vice-versa. After
// the fix both paths produce identical deletion footprints, and the helper
// is the single source of truth.
//
// Source review only (no Vercel KV; no real network).

import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../api/account.js', import.meta.url), 'utf8');

let failed = 0;
function ok(name, cond, hint) {
  if (cond) console.log('  PASS', name);
  else { console.log('  FAIL', name, hint ? ('— ' + hint) : ''); failed++; }
}

console.log('=== unified _keysForUser_ helper ===');

ok('helper exists', /async function _keysForUser_\(/.test(SRC));

// Every key the helper must include for a complete GDPR delete.
const REQUIRED_USERSUB_KEYS = [
  'user:',
  'sheet:',
  'token:',
  'userPhone:',
  'referral:code:',
  'push_sub:',
  'nps:',
  'testimonial:',
  'exit_survey:',
];
REQUIRED_USERSUB_KEYS.forEach((prefix) => {
  ok(`helper covers '${prefix}{userSub}'`,
    new RegExp(`['"]${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\+\\s*userSub`).test(SRC));
});

const REQUIRED_PHONE_KEYS = [
  'phone:',
  'profile:',
  'recurring:',
  'recurring_pending:',
  'memberGroup:',
  'reminders:',
];
REQUIRED_PHONE_KEYS.forEach((prefix) => {
  ok(`helper covers '${prefix}{phone}'`,
    new RegExp(`['"]${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\+\\s*phone`).test(SRC));
});

ok("helper covers 'referral:reverse:{code}'",
  /['"]referral:reverse:['"]\s*\+\s*referralCode/.test(SRC));

console.log('\n=== both delete paths call the unified helper ===');

ok('deleteAccount calls _keysForUser_',
  /async function deleteAccount[\s\S]*?_keysForUser_\(/.test(SRC),
  'web auth path must use unified helper');

ok('deleteByPhone calls _keysForUser_',
  /async function deleteByPhone[\s\S]*?_keysForUser_\(/.test(SRC),
  'bot-secret path must use unified helper');

console.log('\n=== no drifted inline key lists remain ===');

// The old drifted patterns:
//   deleteByPhone used to have an inline list with 9 keys.
//   deleteAccount used to have an inline list with up to 7 keys.
// After the fix, neither function should still have an inline string-array
// of the user/sheet/token/phone family — they go through _keysForUser_.
// Sentinel: the 9-key inline list pattern from deleteByPhone is uniquely
// identifiable (it had 'user:' + userSub, 'sheet:' + userSub, 'token:' +
// userSub, ... all in one square-bracket array literal).
ok('no stranded 9-key inline array in deleteByPhone',
  !/for \(const k of \['user:' \+ userSub, 'sheet:' \+ userSub, 'token:'/.test(SRC));

ok('no stranded keysToDelete inline literal in deleteAccount',
  !/const keysToDelete\s*=\s*\[\s*\n\s*'user:' \+ userSub,/.test(SRC));

console.log('\n=== revocation still happens before deletion ===');

ok('deleteAccount still revokes Google grant before deleting',
  /async function deleteAccount[\s\S]*?revokeGoogleToken[\s\S]*?_keysForUser_/.test(SRC),
  'must revoke OAuth BEFORE wiping the user record (else we lose the refresh token)');

ok('deleteByPhone still revokes Google grant before deleting',
  /async function deleteByPhone[\s\S]*?revokeGoogleToken[\s\S]*?_keysForUser_/.test(SRC),
  'same: revoke before delete');

if (failed > 0) {
  console.error('\n❌ ' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nOK: all assertions passed');
