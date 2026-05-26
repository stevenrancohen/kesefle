#!/usr/bin/env node
// Test that the pending-state-hijack guard in _handlePendingCategoryText_
// is wired correctly. The bug it prevents:
//   1. user sends "1 קפה" → bot can't classify → saves pendingExpense {amount:1}
//   2. user later sends "בנזין 200" → bot should treat as a NEW expense (₪200)
//      NOT as a category answer for the pending (₪1).
//
// The guard works by scanning the new text for any number >= 5 and, if found,
// dropping the pending state + returning {handled:false} so normal expense
// routing takes over. Without the guard, "בנזין 200" lands as ₪1 because the
// pending amount is used.
//
// String-match style (same as other bot/test_*.js) — Apps Script isn't easy
// to run locally, so we verify the source has the guard wired correctly.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_pending_state_hijack.js\n');

assert(/STATE-HIJACK GUARD/.test(SRC),
  'STATE-HIJACK GUARD marker is present in source');

assert(/cache\.remove\('pendingExpense:' \+ clean\)[\s\S]{0,300}cache\.remove\('pendingCreate:' \+ clean\)/.test(SRC),
  'guard removes BOTH pendingExpense and pendingCreate keys');

assert(/sawAmt[\s\S]{0,500}n\s*>=\s*5/.test(SRC),
  "guard's amount-floor is 5 (avoids treating small picker-index integers as amounts)");

assert(/Logger\.log\('pending-hijack-guard:/.test(SRC),
  'guard emits a Logger.log breadcrumb when it triggers (for prod debugging)');

assert(/_handlePendingCategoryText_[\s\S]{0,1500}STATE-HIJACK GUARD/.test(SRC),
  'guard lives INSIDE _handlePendingCategoryText_ (not a separate function)');

// The version bump tells Steven his paste is fresh.
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/pending-state-hijack/.test(v || ''),
  'KFL_BUILD_VERSION bumped to include "pending-state-hijack" (currently: ' + v + ')');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
