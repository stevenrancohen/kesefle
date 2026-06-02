#!/usr/bin/env node
// Regression test: api/billing/manual.js must write proper audit:* rows.
//
// Why this exists:
//   Manual (Bit / bank-transfer) payments are confirmed by an admin and that
//   confirmation ACTIVATES PREMIUM -- it is a money-moving event. Every other
//   billing path leaves a forensic row in the append-only `audit:*` keyspace
//   that the admin dashboard (api/admin.js listAudit, pattern `audit:*`) reads.
//   manual.js previously only emitted log.info(...), so manual upgrades were
//   invisible in the audit trail. This test pins the audit-log wiring so a
//   future refactor cannot silently drop it again.
//
// Style: pure string-match against source. No eval, no live KV, no secrets.
//
// Run: node tests/test_billing_manual_audit_log.js
// Hooked into tests/full_qa.js gauntlet.

const fs = require('fs');
const path = require('path');

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_billing_manual_audit_log.js\n');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'api', 'billing', 'manual.js'),
  'utf8'
);

// Strip comments so we only assert on ACTIVE code (a `//` mention of auditLog
// in a doc line must not satisfy the test).
const CODE = SRC.split('\n')
  .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
  .join('\n');

console.log('Imports the shared audit helper:');
assert(/import\s*\{[^}]*\bauditLog\b[^}]*\}\s*from\s*['"][^'"]*lib\/secure-kv\.js['"]/.test(CODE),
  'auditLog is imported from lib/secure-kv.js (canonical helper, not a hand-rolled fetch)');

console.log('\nWrites an audit row on the money-moving confirm path:');
assert(/auditLog\(\s*['"]manual_payment_confirmed['"]/.test(CODE),
  "confirm path calls auditLog('manual_payment_confirmed', ...)");
// Must hash the affected CUSTOMER's sub (pending.userSub), not the admin's,
// so the audit row joins to the user whose plan changed.
assert(/auditLog\(\s*['"]manual_payment_confirmed['"]\s*,\s*pending\.userSub/.test(CODE),
  'confirm audit uses pending.userSub (the customer) as the subject');

console.log('\nWrites an audit row on the request + reject paths too:');
assert(/auditLog\(\s*['"]manual_payment_requested['"]/.test(CODE),
  "request path calls auditLog('manual_payment_requested', ...)");
assert(/auditLog\(\s*['"]manual_payment_rejected['"]/.test(CODE),
  "reject path calls auditLog('manual_payment_rejected', ...)");

console.log('\nActions land in the audit:* keyspace the dashboard reads:');
// auditLog() builds the key as `audit:${action}:...`, so each action name above
// becomes an `audit:manual_payment_*` key. Assert the action strings are the
// snake_case form admin.js can filter on (audit:<action_filter>:*).
for (const action of ['manual_payment_requested', 'manual_payment_confirmed', 'manual_payment_rejected']) {
  assert(new RegExp("['\"]" + action + "['\"]").test(CODE),
    'action name "' + action + '" is present (=> audit:' + action + ':* key)');
}

console.log('\nAudit is non-fatal (a KV blip must not 500 a real payment confirm):');
// Every auditLog(...) call in active code must be awaited AND .catch()-guarded.
const auditCalls = CODE.match(/auditLog\([\s\S]*?\}\s*,\s*\{[^}]*\}\s*\)\.catch\(/g) || [];
assert(auditCalls.length >= 3,
  'all three auditLog calls are .catch()-guarded (found ' + auditCalls.length + ')');

console.log('\nDoes NOT store a raw phone number in the audit metadata:');
// We pass phoneTail(...) (last-4) rather than the full phone into audit metadata.
assert(/phoneTail\s*\(/.test(CODE),
  'phoneTail() is used so the audit row keeps only the last 4 digits');
assert(/auditLog\(\s*['"]manual_payment_requested['"][\s\S]*?phoneTail:\s*phoneTail\(/.test(CODE),
  'request audit metadata uses phoneTail (not the raw phone)');

console.log('\nKeeps the existing log.info breadcrumbs (defense in depth):');
assert(/log\.info\(\s*['"]manual\.payment_confirmed['"]/.test(CODE),
  'log.info("manual.payment_confirmed") is retained alongside the audit row');
assert(/log\.info\(\s*['"]manual\.payment_requested['"]/.test(CODE),
  'log.info("manual.payment_requested") is retained alongside the audit row');

if (failures.length) {
  console.error('\n' + failures.length + ' assertion(s) failed.');
  process.exit(1);
}
console.log('\nAll manual-billing audit-log assertions passed.');
