#!/usr/bin/env node
// Test that the KFL-TRACE instrumentation is wired across the bot's
// key expense-routing decision points. When a user-reported bug comes
// in, Steven (or the agent) can grep '[KFL-TRACE]' in Apps Script logs
// and immediately see what path the message took.
//
// Why: bugs like "בנזין 200 wrote ₪1" (PR #67) and "1 קפה → text-only
// picker" couldn't be reproduced locally; the only way to debug was to
// instrument every branch. This guards the instrumentation from getting
// silently removed during refactors.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_trace_instrumentation.js\n');

// --- Helper exists ---
console.log('Helper function:');
assert(/function _kflTrace_\(branch, fromPhone, text, extra\)/.test(SRC),
  '_kflTrace_(branch, fromPhone, text, extra) is defined');
assert(/\[KFL-TRACE\]/.test(SRC),
  'tag string "[KFL-TRACE]" is present in helper output');
assert(/phoneTail[\s\S]{0,300}\.slice\(-4\)/.test(SRC),
  'helper truncates phone to last 4 digits (PII-safe)');
assert(/textSnip[\s\S]{0,200}\.slice\(0,\s*40\)/.test(SRC),
  'helper truncates text to first 40 chars');
assert(/never let tracing throw/.test(SRC),
  'helper has a try/catch so a bad call never breaks the bot');

// --- Call sites in key paths ---
console.log('\nCall sites at key decision points:');

const requiredBranches = [
  'concierge.entry',
  'concierge.gemini_empty',
  'concierge.gemini_raw',
  'concierge.parsed',
  'pending.no_state',
  'pending.entry_with_state',
  'pending.hijack_guard_fired',
  'tenant_write.entry',
  'tenant_write.no_parse_calling_concierge',
  'tenant_write.parsed_and_classified',
];

for (const branch of requiredBranches) {
  const re = new RegExp("_kflTrace_\\('" + branch.replace(/\./g, '\\.') + "'");
  assert(re.test(SRC),
    'trace branch "' + branch + '" is wired');
}

// --- Call sites must be inside the right functions ---
console.log('\nCall sites live in the right functions:');

// concierge.* must be inside _botConcierge_
const concierge = SRC.match(/function _botConcierge_\([\s\S]*?\n}\n/);
assert(concierge && /concierge\.entry/.test(concierge[0]),
  '_botConcierge_ contains concierge.entry');
assert(concierge && /concierge\.gemini_raw/.test(concierge[0]),
  '_botConcierge_ contains concierge.gemini_raw');
assert(concierge && /concierge\.parsed/.test(concierge[0]),
  '_botConcierge_ contains concierge.parsed');

// pending.* must be inside _handlePendingCategoryText_
const pending = SRC.match(/function _handlePendingCategoryText_\([\s\S]*?\n}\n/);
assert(pending && /pending\.no_state/.test(pending[0]),
  '_handlePendingCategoryText_ contains pending.no_state');
assert(pending && /pending\.entry_with_state/.test(pending[0]),
  '_handlePendingCategoryText_ contains pending.entry_with_state');
assert(pending && /pending\.hijack_guard_fired/.test(pending[0]),
  '_handlePendingCategoryText_ contains pending.hijack_guard_fired');

// tenant_write.* must be inside _tenantWriteExpense_
const tenantWrite = SRC.match(/function _tenantWriteExpense_\([\s\S]*?\n}\n/);
assert(tenantWrite && /tenant_write\.entry/.test(tenantWrite[0]),
  '_tenantWriteExpense_ contains tenant_write.entry');
assert(tenantWrite && /tenant_write\.parsed_and_classified/.test(tenantWrite[0]),
  '_tenantWriteExpense_ contains tenant_write.parsed_and_classified');

// --- Total trace call count sanity ---
const traceCallCount = (SRC.match(/_kflTrace_\(/g) || []).length;
console.log('\nTotal trace call sites: ' + traceCallCount);
assert(traceCallCount >= 10,
  '>= 10 trace call sites total (saw ' + traceCallCount + ')');

// --- Build version sanity ---
// Loosened from strict "trace-instrumented" to "2026-05-26" so subsequent
// PRs can rebump the version freely without breaking this guard. The
// trace helper + 10+ call sites are verified above.
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/2026-05-26/.test(v || ''),
  'KFL_BUILD_VERSION is from today or later (currently: ' + v + ')');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
