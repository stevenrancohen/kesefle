#!/usr/bin/env node
// bot/test_destructive_delete_confirm.js
// PR-DEL regression — Monday QA Critical 2944130802.
//
// Verifies the two destructive delete commands ("מחק" / "מחק הזמנה")
// now require a confirmation ("אישור") within 60s before actually
// deleting. Same string-match style as test_pending_state_hijack.js —
// Apps Script isn't trivial to run locally so we assert structural guards.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_destructive_delete_confirm.js\n');

// Build version
console.log('Build version:');
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');

// PR-DEL marker present
console.log('\nPR-DEL marker:');
assert(/PR-DEL\s+—\s+destructive-delete/.test(SRC),
  'PR-DEL interceptor block marker present at top of processExpense');
assert(/2944130802/.test(SRC),
  'Monday item ID referenced in the code comment (audit trail)');

// Two delete commands now STAGE (no immediate delete)
console.log('\nDelete commands stage instead of immediately deleting:');
// Both branches now set delPend with the right kind + Hebrew prompt + 60s notice.
assert(/trimmed === ['"]מחק הזמנה['"][^}]{0,80}\|\|/.test(SRC),
  '"מחק הזמנה" branch still has the trimmed-match guard');
// kind: 'order' must appear in the file (set by the order stager)
assert(/kind:\s*['"]order['"]/.test(SRC),
  '"מחק הזמנה" stages kind="order" (delPend payload)');
assert(/למחוק את ההזמנה האחרונה/.test(SRC),
  '"מחק הזמנה" replies in Hebrew asking for confirmation');
// kind: 'tx' for transactions
assert(/kind:\s*['"]tx['"]/.test(SRC),
  '"מחק אחרון" stages kind="tx" (delPend payload)');
assert(/למחוק את התנועה האחרונה/.test(SRC),
  '"מחק אחרון" replies in Hebrew asking for confirmation');
assert(/שלח "אישור" תוך 60 שניות/.test(SRC),
  'Both stagers mention the 60s confirmation window in Hebrew');
// And the staging blocks both write delPend via PropertiesService
const dpKeyWrites = (SRC.match(/delPend:'\s*\+\s*String\(fromPhone[^)]*\)\.replace\(/g) || []).length;
assert(dpKeyWrites >= 2,
  'delPend key is constructed from sanitized fromPhone in both stagers (' + dpKeyWrites + ' occurrences)');

// PR-DEL interceptor wiring
console.log('\nPR-DEL interceptor (processes confirmation BEFORE command parser):');
const interceptor = SRC.match(/PR-DEL — destructive-delete confirmation interceptor[\s\S]{0,3500}/);
assert(interceptor !== null,
  'PR-DEL interceptor block found');
assert(interceptor && /delPend:'\s*\+\s*__dpFromClean/.test(interceptor[0]),
  'interceptor reads delPend:{phone-clean} PropertiesService key');
assert(interceptor && /PropertiesService\.getScriptProperties\(\)/.test(interceptor[0]),
  'interceptor uses PropertiesService.getScriptProperties (same as clarPend pattern)');
assert(interceptor && /60000/.test(interceptor[0]),
  'interceptor has 60s (60000ms) hard TTL');
assert(interceptor && /\^\(\?:אישור\|אישוּר\|כן\|yes\|confirm\)\$/.test(interceptor[0]),
  'interceptor accepts אישור / אישוּר / כן / yes / confirm as confirmation');
assert(interceptor && /__dpKind === ['"]order['"]/.test(interceptor[0]),
  'order kind → calls deleteLastOrder()');
assert(interceptor && /__dpKind === ['"]tx['"]/.test(interceptor[0]),
  'tx kind → calls deleteLastTransaction()');
assert(interceptor && /deleteProperty\(__dpKeyCheck\)/.test(interceptor[0]),
  'interceptor always clears state after handling (no stale delPend)');
assert(interceptor && /__dpAge > 60000/.test(interceptor[0]),
  'interceptor expires stale state >60s automatically');

// Ordering: interceptor runs BEFORE the trimmed === 'בדיקה' diag check
console.log('\nDispatcher ordering:');
const interceptorPos = SRC.indexOf('PR-DEL — destructive-delete confirmation interceptor');
const trimmedPos = SRC.indexOf("trimmed === 'בדיקה'");
assert(interceptorPos > 0 && trimmedPos > 0 && interceptorPos < trimmedPos,
  'PR-DEL interceptor sits BEFORE the command parser (so "אישור" wins over commands)');

// Original delete functions still exist (they're now only called via the interceptor)
console.log('\nUnderlying delete functions preserved:');
assert(/function deleteLastOrder\(\)/.test(SRC),
  'deleteLastOrder() still defined (called via interceptor)');
assert(/function deleteLastTransaction\(\)/.test(SRC),
  'deleteLastTransaction() still defined (called via interceptor)');

// No IMMEDIATE delete in the trimmed-command branches (the bug we fixed)
console.log('\nNo-confirm bug is fixed:');
// The OLD code was: trimmed === 'מחק הזמנה' ... return { reply: deleteLastOrder() }
// The NEW code stages instead. Assert no `return { reply: deleteLastOrder() }` follows the trimmed === guard.
const orderNoImmediate = SRC.match(/trimmed === ['"]מחק הזמנה['"][\s\S]{0,300}?return \{ reply:[\s\S]{0,100}?deleteLastOrder\(\)/);
assert(orderNoImmediate === null,
  '"מחק הזמנה" no longer immediately returns deleteLastOrder() (was the bug)');
const txNoImmediate = SRC.match(/trimmed === ['"]מחק אחרון['"][\s\S]{0,300}?return \{ reply:[\s\S]{0,100}?deleteLastTransaction\(\)/);
assert(txNoImmediate === null,
  '"מחק אחרון" no longer immediately returns deleteLastTransaction() (was the bug)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
