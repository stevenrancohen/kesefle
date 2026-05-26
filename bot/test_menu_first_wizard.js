#!/usr/bin/env node
// Test for the stateful menu-first wizard (PR-2 of the menu-first policy).
// Verifies the 'objective-new' wizard exists, routes through CacheService,
// has the 3-step state machine, and clears state on cancel/error.
const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_menu_first_wizard.js\n');
const BOT = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

console.log('Pending-flow infrastructure:');
assert(/_pendingFlowKey_\(fromPhone\)/.test(BOT), '_pendingFlowKey_ helper exists');
assert(/function _setPendingFlow_/.test(BOT),    '_setPendingFlow_ helper exists');
assert(/function _getPendingFlow_/.test(BOT),    '_getPendingFlow_ helper exists');
assert(/function _clearPendingFlow_/.test(BOT),  '_clearPendingFlow_ helper exists');
assert(/function _handlePendingFlowStep_/.test(BOT), '_handlePendingFlowStep_ dispatcher exists');
assert(/cache\.put\(_pendingFlowKey_\(fromPhone\), JSON\.stringify\(rec\), 600\)/.test(BOT),
  'pending-flow cache TTL is 600s (10 min) per policy');

console.log('\nDispatcher placement:');
const dispatchIdx = BOT.indexOf('_handlePendingFlowStep_(__from_, __text_)');
const objCmdIdx   = BOT.indexOf('_handleObjectiveCommand_(__from_, __text_)');
assert(dispatchIdx > 0, 'doPost dispatches _handlePendingFlowStep_');
assert(dispatchIdx > 0 && objCmdIdx > 0 && dispatchIdx < objCmdIdx,
  'pending-flow dispatcher runs BEFORE _handleObjectiveCommand_');

console.log('\nobjective-new wizard:');
assert(/function _objectiveNewStep_/.test(BOT), '_objectiveNewStep_ state machine exists');
assert(/step === ['"]choose-horizon['"]/.test(BOT), 'step 1: choose-horizon');
assert(/step === ['"]describe['"]/.test(BOT), 'step 2: describe (free-text description)');
assert(/step === ['"]confirm['"]/.test(BOT), 'step 3: confirm');
// "יעד חדש" bare command starts the wizard via _setPendingFlow_
assert(/יעד\\s\+חדש\$.+_setPendingFlow_\(fromPhone, 'objective-new'|\/\^יעד\\s\+חדש\$\/[\s\S]{0,300}_setPendingFlow_/.test(BOT) ||
       /\/\^יעד\\s\+חדש\$\/[\s\S]{0,400}'objective-new'/.test(BOT),
  'bare "יעד חדש" command starts the wizard via _setPendingFlow_');

console.log('\nUniversal cancel:');
assert(/\\^\(בטל\|cancel\|חזור\|stop\|דלג\)\\\$|בטל\|cancel\|חזור/.test(BOT),
  'universal escape: "בטל"/"cancel"/"חזור"/"stop"/"דלג"');

console.log('\nConfirmation before save:');
assert(/\/\^1\$\|\^אישור\$\|\^כן\$/.test(BOT) || /'אישור'/.test(BOT),
  'step 3 accepts 1/אישור/כן/ok/אוקיי for confirm');
assert(/action:\s*['"]set['"]/.test(BOT), 'confirm step calls /api/objectives/action with action=set');

console.log('\nVersion + DEPLOY.gs sync:');
const v = (BOT.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/menu-first|wizard/.test(v || ''),
  'KFL_BUILD_VERSION mentions menu-first/wizard (currently: ' + v + ')');
const DEPLOY = fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8');
assert(/_handlePendingFlowStep_/.test(DEPLOY), 'DEPLOY.gs contains _handlePendingFlowStep_');
assert((DEPLOY.match(/function doPost/g) || []).length === 1, 'DEPLOY.gs has exactly 1 doPost');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
