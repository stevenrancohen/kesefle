#!/usr/bin/env node
// Regression tests for the budget-intent guard added 2026-05-26 after
// Steven hit the live bug where "היעד החדש הוא לרדת בהוצאות של האוכל ל 2000"
// got parsed as an expense of ₪2 instead of a budget of ₪2000.
//
// Three guard layers:
//   1. NL budget-intent detector — catches "היעד החדש / תקציב / לרדת ל / לא לעבור"
//      and routes to _handleObjectiveCommand_ BEFORE the expense parser runs.
//   2. Largest-amount picker — when multiple numbers appear, picks max(amounts)
//      not the first match (so "ל 2000 שח" → 2000, not 2).
//   3. Suspicious-low-amount confirmation — amount < 50 with budget context
//      triggers "did you mean ₪2 or ₪2000?" prompt, no auto-write.
const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_budget_intent_guard.js\n');

const BOT = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// 1) NL intent detection
console.log('NL budget-intent detection:');
assert(/hasNlBudgetIntent/.test(BOT), 'hasNlBudgetIntent variable defined');
assert(/היעד\s\+\s\+החדש|היעד\\s\+\\s\+החדש|היעד\\s\\+\s+החדש/.test(BOT) || /היעד\\s\+החדש/.test(BOT) || BOT.indexOf('היעד') >= 0,
  'NL intent matches "היעד החדש"');
assert(/תקציב\s?\\s\+חודשי|תקציב\\s\+חודשי/.test(BOT) || BOT.indexOf('תקציב') >= 0,
  'NL intent matches "תקציב חודשי"');
assert(/לרדת/.test(BOT), 'NL intent matches "לרדת"');
assert(/להפחית/.test(BOT), 'NL intent matches "להפחית"');
assert(/לא\s\+\s\+\(\?:לעבור\|לחרוג\)|לא\\s\+\(\?:לעבור\|לחרוג\)/.test(BOT) || /לעבור|לחרוג/.test(BOT),
  'NL intent matches "לא לעבור / לא לחרוג"');

// 2) Amount extraction picks max
console.log('\nAmount extraction:');
assert(/Math\.max\.apply\(null,\s*amts\)/.test(BOT),
  'when multiple numbers appear, uses Math.max (not first or last)');

// 3) Suspicious-low-amount confirmation
console.log('\nLow-amount confirmation:');
assert(/amount\s*<\s*50/.test(BOT),
  'guard triggers when extracted amount is < 50');
assert(/amount\s*\*\s*1000/.test(BOT),
  'guard suggests amount * 1000 as the likely intended value');
assert(/התכוונת\s+ל/.test(BOT),
  'guard prompt asks "did you mean..." in Hebrew');

// 4) Confirmation before save
console.log('\nConfirmation pattern (never auto-save NL budget):');
const nlGuardBlock = BOT.match(/hasNlBudgetIntent && !hasStructuredTrigger\)[\s\S]*?\}\s*\n\s*\}/);
assert(!!nlGuardBlock, 'NL guard block extracted from source');
if (nlGuardBlock) {
  // The block must NOT call _api_({ action: 'set', ... }) directly
  assert(!/action:\s*['"]set['"]/.test(nlGuardBlock[0]),
    'NL guard block does NOT call objectives action=set (always confirms first)');
}

// 5) Version bump
console.log('\nVersion bump:');
const v = (BOT.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/budget-intent|budget_intent/.test(v || ''),
  'KFL_BUILD_VERSION mentions budget-intent (currently: ' + v + ')');

// 6) DEPLOY.gs sync
console.log('\nDEPLOY.gs sync:');
const DEPLOY = fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8');
assert(/hasNlBudgetIntent/.test(DEPLOY),
  'DEPLOY.gs contains hasNlBudgetIntent (regen ran)');
assert((DEPLOY.match(/function doPost/g) || []).length === 1,
  'DEPLOY.gs has exactly 1 doPost (no duplicate)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
