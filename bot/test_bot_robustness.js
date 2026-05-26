#!/usr/bin/env node
// Regression tests for the bot robustness sweep (PR after #68).
//
// 1. Gemini action whitelist — concierge must collapse hallucinated
//    actions ("picker", "ask", "log_expense", etc.) into "chat".
//    Otherwise Gemini-invented UX leaks to users (suspected cause of
//    "1 קפה → text-only 1/2/3/4 picker" report).
// 2. Phone-number guard in parser — "050-1234567 דמי שיחה" must NOT
//    parse as multiple amounts (50, 1234567, …). Israeli mobile +
//    landline + 1700 service-number formats covered.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_bot_robustness.js\n');

// --- 1. Gemini action whitelist ---
console.log('Gemini action whitelist (_botConcierge_):');
assert(/ALLOWED_ACTIONS\s*=\s*\[\s*'summary',\s*'help',\s*'examples',\s*'orders',\s*'chat'\s*\]/.test(SRC),
  'ALLOWED_ACTIONS whitelist defined with exactly the 5 known actions');
assert(/ALLOWED_ACTIONS\.indexOf\(action\)\s*===\s*-1/.test(SRC),
  'guard checks indexOf === -1 (unknown action)');
assert(/concierge\.action_rejected/.test(SRC),
  'trace breadcrumb fires when an action is rejected (so we see Gemini hallucinations in logs)');
assert(/action = 'chat';/.test(SRC) || /action\s*=\s*'chat'/.test(SRC),
  'rejected action collapses to chat (safe default)');

// --- 2. Phone-number guard in parser ---
console.log('\nPhone-number guard (parseAmountAndDescription):');
assert(/PHONE-NUMBER GUARD/.test(SRC),
  'PHONE-NUMBER GUARD marker is present');
assert(/972[-\\s]?/.test(SRC),
  'guard regex covers +972 country-code prefix');
assert(/1\\s-\]?700/.test(SRC) || /\\\\b1\[\\s-\]\?700/.test(SRC) || /1\[\\s-\]\?700/.test(SRC),
  'guard regex covers 1700 service numbers');
assert(/numberRe\.exec\(phoneStripped\)/.test(SRC),
  'parser scans phoneStripped (not raw text) for amounts');

// --- 3. Version bump ---
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
console.log('\nVersion: ' + v);
assert(/robustness/.test(v || ''),
  'KFL_BUILD_VERSION includes "robustness" (currently: ' + v + ')');

// --- 4. Old whitelist code shouldn't be in concierge (defensive — should
//        be inside the try block, not above the JSON.parse) ---
console.log('\nWhitelist placement (must be AFTER JSON.parse):');
const conciergeFn = SRC.match(/function _botConcierge_\([\s\S]*?\n}\n/);
assert(!!conciergeFn, '_botConcierge_ extracted from source');
if (conciergeFn) {
  const code = conciergeFn[0];
  const idxParse = code.indexOf('JSON.parse(m[0])');
  const idxWhitelist = code.indexOf('ALLOWED_ACTIONS');
  assert(idxParse !== -1 && idxWhitelist > idxParse,
    'ALLOWED_ACTIONS check is AFTER JSON.parse (not before — must run only on successfully-parsed responses)');
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
