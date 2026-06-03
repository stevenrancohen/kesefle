#!/usr/bin/env node
// Regression test for the email unsubscribe flow (Onboarding QA).
//
// Guards the fix for: every Kesefle email (welcome at signup + lifecycle drip +
// digests + payment-failed) linked to /unsubscribe?sub=... but NO page, API, or
// suppression-setter existed — the link 404'd and emailUnsubscribed (which the
// lifecycle cron already honors) could never be flipped. The old link was also
// unsigned, so it was forgeable for any sub.
//
// Two layers:
//   A. FUNCTIONAL — the signed-token helper (lib/email-unsub.js) actually
//      round-trips: correct sub+token verifies, wrong sub / tampered / empty
//      token reject, and the no-keyring path fails soft (empty token, usable
//      URL, verify=false). Run in a child ESM process (lib is ESM, this is CJS).
//   B. STRUCTURAL — the API endpoint sets the flag + is token-gated + rate
//      limited, the page exists, and every live email sender builds the URL via
//      buildUnsubscribeUrl (no leftover unsigned `/unsubscribe?sub=` literals).
//
// Run: node tests/test_email_unsubscribe.js   (also in tests/full_qa.js)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

console.log('\ntests/test_email_unsubscribe.js\n');

// ── A. Functional token round-trip ────────────────────────────────────────
console.log('Signed-token helper round-trip:');
const fnScript = `
import { unsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl } from ${JSON.stringify(path.join(ROOT, 'lib', 'email-unsub.js'))};
const sub = 'google-acct-xyz';
const tok = unsubscribeToken(sub);
const flip = tok.slice(0, -1) + (tok.slice(-1) === 'A' ? 'B' : 'A');
const out = {
  tokenNonEmpty: tok.length > 0,
  verifyCorrect: verifyUnsubscribeToken(sub, tok) === true,
  rejectWrongSub: verifyUnsubscribeToken('other', tok) === false,
  rejectTampered: verifyUnsubscribeToken(sub, flip) === false,
  rejectEmpty: verifyUnsubscribeToken(sub, '') === false,
  urlSigned: /\\/unsubscribe\\?sub=google-acct-xyz&t=/.test(buildUnsubscribeUrl(sub)),
};
process.stdout.write(JSON.stringify(out));
`;
let withKey = {};
try {
  const key = require('crypto').randomBytes(32).toString('base64url');
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', fnScript], {
    env: { ...process.env, KESEFLE_DB_KEY: key },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  withKey = JSON.parse(raw);
} catch (e) {
  console.error('  (child process failed: ' + e.message + ')');
}
assert(withKey.tokenNonEmpty, 'token is non-empty when keyring present');
assert(withKey.verifyCorrect, 'correct sub+token verifies true');
assert(withKey.rejectWrongSub, 'token bound to sub — wrong sub rejected');
assert(withKey.rejectTampered, 'tampered token rejected');
assert(withKey.rejectEmpty, 'empty token rejected');
assert(withKey.urlSigned, 'buildUnsubscribeUrl appends &t= when signed');

console.log('\nFail-soft when keyring is absent (must never throw in email path):');
let noKey = {};
try {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', `
import { unsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl } from ${JSON.stringify(path.join(ROOT, 'lib', 'email-unsub.js'))};
const sub = 'google-acct-xyz';
process.stdout.write(JSON.stringify({
  tokenEmpty: unsubscribeToken(sub) === '',
  urlSubOnly: buildUnsubscribeUrl(sub) === 'https://kesefle.com/unsubscribe?sub=google-acct-xyz',
  verifyFalse: verifyUnsubscribeToken(sub, 'anything') === false,
}));
`], {
    // Scrub every KEK so the keyring is genuinely empty.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^KESEFLE_DB_KEY/.test(k))),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  noKey = JSON.parse(raw);
} catch (e) {
  console.error('  (child process failed: ' + e.message + ')');
}
assert(noKey.tokenEmpty, 'no keyring -> token is empty (no throw)');
assert(noKey.urlSubOnly, 'no keyring -> URL still built (sub only)');
assert(noKey.verifyFalse, 'no keyring -> verify returns false (fails closed)');

// ── B. Structural: API endpoint ───────────────────────────────────────────
console.log('\nAPI endpoint api/account/unsubscribe.js:');
assert(exists('api/account/unsubscribe.js'), 'endpoint file exists');
const API = read('api/account/unsubscribe.js');
assert(/verifyUnsubscribeToken/.test(API), 'verifies the signed token');
assert(/emailUnsubscribed\s*=\s*true/.test(API), 'sets emailUnsubscribed = true (the flag the cron honors)');
assert(/withRateLimit\(/.test(API), 'is rate limited (enumeration defense)');
assert(/invalid_or_expired_link/.test(API), 'POST fails closed on bad/absent token');
assert(/auditLog\(/.test(API), 'writes an audit-log entry');
// Read-merge-write: must GET the existing record before SET so plan/tokens survive.
assert(/kvGet\(['"`]user:['"`]\s*\+\s*sub\)/.test(API) || /kvGet\('user:' \+ sub\)/.test(API),
  'reads the existing user record before writing (merge, not clobber)');

// ── B. Structural: page ───────────────────────────────────────────────────
console.log('\nPage unsubscribe.html:');
assert(exists('unsubscribe.html'), 'page exists at /unsubscribe');
const PAGE = read('unsubscribe.html');
assert(/\/api\/account\/unsubscribe/.test(PAGE), 'page calls the unsubscribe API');
assert(/noindex/.test(PAGE), 'page is noindex (not a marketing page)');

// ── B. Structural: senders all use the signed builder ─────────────────────
console.log('\nEmail senders use buildUnsubscribeUrl (no unsigned literals):');
const senders = [
  'api/auth/google-exchange.js',
  'api/cron/lifecycle.js',
  'api/billing/paypal.js',
];
for (const rel of senders) {
  const src = read(rel);
  assert(/buildUnsubscribeUrl/.test(src), rel + ' imports/uses buildUnsubscribeUrl');
  // No leftover hand-built unsigned link.
  assert(!/['"`]https:\/\/kesefle\.com\/unsubscribe\?sub=/.test(src),
    rel + ' has NO leftover unsigned /unsubscribe?sub= literal');
}

// The welcome email is the FIRST onboarding touch — assert specifically.
assert(/template:\s*['"]welcome['"]/.test(read('api/auth/google-exchange.js')),
  'welcome email is still sent on first signup');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
