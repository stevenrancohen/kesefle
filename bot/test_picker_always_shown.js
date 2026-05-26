#!/usr/bin/env node
// Test that:
//   1. The change-category picker is offered on ALL expense reply paths
//      (tenant write, owner write, receipt OCR, bare-"קטגוריה" command).
//   2. Bare "קטגוריה" command shows the picker instead of leaking to LLM.
//   3. Gemini-leak guard exists (SAFE_FALLBACK + code-fence stripper).
//
// String-match style — same as bot/test_category_picker.js — because the
// Apps Script runtime isn't easy to spin up locally. The point of these
// tests is to prevent silent regression when the SECTIONS, picker call
// sites, or Gemini parser change.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];

function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_picker_always_shown.js\n');

// --- Picker call sites ---
console.log('Picker call sites:');
const pickerCalls = (SRC.match(/_sendChangeCategoryPicker_\(/g) || []).length;
assert(pickerCalls >= 4,
  '_sendChangeCategoryPicker_ is called >= 4 times (saw ' + pickerCalls + ') — tenant + owner + receipt + bare-קטגוריה');

// --- Tenant-write call (the original, must survive) ---
// Anchor on the function definition specifically, then look for the picker
// call before the next `function ` declaration.
const tenantFnMatch = SRC.match(/function _tenantWriteExpense_\([\s\S]*?\nfunction /);
assert(!!tenantFnMatch && /_sendChangeCategoryPicker_\(fromPhone, category\)/.test(tenantFnMatch[0]),
  'tenant write path still calls _sendChangeCategoryPicker_(fromPhone, category)');

// --- Owner-write call (the new one) ---
assert(/owner-write picker err|matched\.category\)\s*;\s*\}\s*catch\s*\(_pkErr\)\s*\{[\s\S]{0,80}owner/.test(SRC),
  'owner write path calls _sendChangeCategoryPicker_ (new in this PR)');

// --- Receipt-image call (the new one) ---
assert(/receipt picker err/.test(SRC),
  'receipt-image path calls _sendChangeCategoryPicker_ (new in this PR)');

// --- Bare-קטגוריה handler ---
console.log('\nBare-קטגוריה handler:');
assert(/trimmed === ['"]קטגוריה['"]/.test(SRC),
  'handler matches bare "קטגוריה" (no args)');
assert(/lastTenantExp:[\s\S]{0,200}cache\.get\(['"]lastExp:/.test(SRC),
  'handler reads BOTH lastTenantExp (multi-tenant) and lastExp (owner) cache keys');
assert(/בחר קטגוריה חדשה/.test(SRC),
  'handler replies with "בחר קטגוריה חדשה" prompt text');

// --- Gemini anti-leak guard ---
console.log('\nGemini anti-leak guard in _botConcierge_:');
assert(/SAFE_FALLBACK\s*=\s*['"]/.test(SRC),
  'SAFE_FALLBACK constant defined');
assert(/```\(\?:json\|JSON\)\?/.test(SRC) || /\^\\s\*\`\`\`\(\?\:json\|JSON\)\?/.test(SRC),
  'code-fence stripper present (handles markdown-wrapped JSON from Gemini)');
assert(/_botConcierge_ no-json fallback|_botConcierge_ json-parse fallback/.test(SRC),
  'Logger.log debug breadcrumbs for fallback paths exist');

// --- No raw-text leak path ---
console.log('\nGuard: no path returns raw Gemini output to user:');
const badReturn = /return\s*\{\s*action:\s*['"]chat['"],\s*reply:\s*String\(raw\)\.slice/.test(SRC);
assert(!badReturn,
  'the OLD "reply: String(raw).slice(0, 600)" leak path is gone');

// --- Build/version sanity ---
console.log('\nBuild/version sanity:');
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(!!v, 'KFL_BUILD_VERSION set: ' + (v || '(missing)'));

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
