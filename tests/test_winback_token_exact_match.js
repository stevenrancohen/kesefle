#!/usr/bin/env node
// Regression test for PR-S (winback-claim token forgery — Backend QA Bug #7).
// String-match against api/billing/winback-claim.js source. No eval / no live KV.
//
// What this guards:
//   1. The `sub.startsWith(token)` arm in the token-match loop MUST stay
//      removed. With it present, an 8-char token would forge-match anyone
//      whose userSub starts with those chars.
//   2. Token length MUST be enforced to EXACTLY 24 chars (matches the
//      slice(0, 24) prefix). The earlier `length < 8 || length > 64`
//      window paired with `startsWith` opened the forgery hole.
//
// Run: node tests/test_winback_token_exact_match.js
// Hooked into tests/full_qa.js gauntlet.

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_winback_token_exact_match.js\n');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'api', 'billing', 'winback-claim.js'),
  'utf8'
);

console.log('Token length guard:');
// The exact equality check. Tightened from `< 8 || > 64`.
assert(/token\.length\s*!==?\s*24/.test(SRC),
  'token length is checked === 24 (not a loose window)');
assert(!/token\.length\s*<\s*8\b/.test(SRC),
  'OLD "token.length < 8" window check is GONE');
assert(!/token\.length\s*>\s*64\b/.test(SRC),
  'OLD "token.length > 64" window check is GONE');

console.log('\nForgery arm removed from match loop:');
// The `sub.startsWith(token)` arm was the forgery vector. Must be gone.
// Match only ACTIVE code (inside an `if (...)`), not comments/doc lines.
// Comments start with `//` or `*`; active code starts with `if` or `||`.
const SRC_CODE = SRC.split('\n')
  .filter(line => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
  .join('\n');
assert(!/sub\.startsWith\(\s*token\s*\)/.test(SRC_CODE),
  'sub.startsWith(token) forgery arm is GONE from active code');
// The exact-prefix match is the only valid path.
assert(/sub\.slice\(\s*0\s*,\s*24\s*\)\s*===\s*token/.test(SRC_CODE),
  'exact sub.slice(0,24) === token match is present in active code');

console.log('\nDefensive: full-match block still scans exit_survey:*:');
assert(/kvScan\(['"]exit_survey:\*['"]\)/.test(SRC),
  'still scans the exit_survey:* keyspace (no behavior regression)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
