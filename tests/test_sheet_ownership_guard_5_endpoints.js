#!/usr/bin/env node
// Regression test for PR-S2 (Security audit 2026-05-27 H1).
// Verifies the `sheet_ownership_mismatch` guard exists in EVERY sheet
// endpoint that writes/mutates a tenant's sheet, not just append.js.
//
// The guard pattern (canonical from api/sheet/append.js:124-132):
//   if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
//     log.error('<endpoint>.sheet_ownership_mismatch', {...});
//     return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
//   }
//
// Without this guard, a stale/poisoned phone-record sheet pointer could
// route a write to the wrong tenant's sheet. The 2026-05-27 security
// audit (H1) flagged the 5 endpoints below as missing the guard.

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_sheet_ownership_guard_5_endpoints.js\n');

// Endpoints that MUST have the guard (per 2026-05-27 security audit + the
// canonical ones that already had it).
const ENDPOINTS = [
  // Pre-existing (canonical):
  'api/sheet/append.js',
  'api/sheet/bot-query.js',
  'api/sheet/mark-vat.js',
  'api/sheet/stats.js',
  // PR-S2 additions (from security audit H1):
  'api/sheet/delete-last.js',
  'api/sheet/csv-import.js',
  'api/sheet/relabel-row.js',
  'api/sheet/add-category-row.js',
  'api/sheet/fix-company-dashboard.js',
];

console.log('Guard coverage:');
for (const ep of ENDPOINTS) {
  const full = path.join(__dirname, '..', ep);
  const src = fs.readFileSync(full, 'utf8');

  // Check 1: the canonical guard literal must appear at least once.
  const hasErrorReturn = /return\s+res\.status\(\s*409\s*\)\.json\(\s*\{\s*ok:\s*false,\s*error:\s*['"]sheet_ownership_mismatch['"]/.test(src);
  assert(hasErrorReturn,
    ep + ' returns 409 with error="sheet_ownership_mismatch"');

  // Check 2: the comparison itself must be present (canonicalSheetId !== phoneSheetId
  // or equivalent). Loose match so any future variant naming still works.
  const hasCompare = /canonicalSheetId\s*&&\s*phoneSheetId\s*&&\s*canonicalSheetId\s*!==\s*phoneSheetId/.test(src);
  assert(hasCompare,
    ep + ' has the canonicalSheetId !== phoneSheetId comparison');

  // Check 3: structured log line with the endpoint-namespaced key.
  const hasLog = /log\.error\(\s*['"][a-z_]+\.sheet_ownership_mismatch['"]/.test(src);
  assert(hasLog,
    ep + ' emits log.error("<namespace>.sheet_ownership_mismatch", ...)');
}

// Sanity: the audit's claim that the guard error key is exactly
// "sheet_ownership_mismatch" — make sure nobody renamed it to a near-miss
// like "sheet_owner_mismatch" or "ownership_violation" in the meantime.
console.log('\nError-key consistency:');
let totalReturns = 0;
let canonicalReturns = 0;
for (const ep of ENDPOINTS) {
  const src = fs.readFileSync(path.join(__dirname, '..', ep), 'utf8');
  const returns = src.match(/error:\s*['"]sheet_[a-z_]+mismatch['"]/g) || [];
  totalReturns += returns.length;
  canonicalReturns += returns.filter(r => /['"]sheet_ownership_mismatch['"]/.test(r)).length;
}
assert(totalReturns === canonicalReturns,
  'all sheet_*mismatch error keys are the canonical "sheet_ownership_mismatch" (no near-miss renames)');
assert(canonicalReturns >= ENDPOINTS.length,
  'every endpoint has at least one canonical guard return (got ' + canonicalReturns + ', expected >= ' + ENDPOINTS.length + ')');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
