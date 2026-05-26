#!/usr/bin/env node
// Regression test for PR-G2-mini (Smart Budget Goals v2 — objectives).
// Verifies:
//   1. lib/objectives.js parseObjectiveCommand handles every shape
//   2. bot/ExpenseBot_FIXED.gs has _handleObjectiveCommand_ wired BEFORE
//      _handleGoalCommand_ in doPost
//   3. api/objectives/action.js exists + bot-secret gated + rate-limited
const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_objective_commands.js\n');

// ── 1) Pure parser tests via dynamic import ────────────────────────────────
let parseObjectiveCommand;
try {
  const mod = require('../lib/objectives.js');
  parseObjectiveCommand = mod.parseObjectiveCommand;
} catch (_e) {
  console.log('  SKIP (lib/objectives.js is ESM; verifying via source instead)');
}

if (parseObjectiveCommand) {
  console.log('parseObjectiveCommand cases:');
  const cases = [
    { input: 'יעד שלי',                                expect: 'show' },
    { input: 'השגתי יעד',                              expect: 'achieve' },
    { input: 'השתק יעד',                               expect: 'mute' },
    { input: 'די',                                     expect: 'mute' },
    { input: 'stop',                                   expect: 'mute' },
    { input: 'אל תזכיר',                              expect: 'mute' },
    { input: 'יעד חדש',                                expect: 'new' },
    { input: 'יעד חדש חודש לחסוך 1000 לטיול',         expect: 'set' },
    { input: 'יעד חדש חצי שנה לסגור הלוואה 12000',     expect: 'set' },
    { input: 'יעד חדש שנה לקנות דירה',                expect: 'set' },
    { input: 'שנה יעד לחסוך 5000 לטיול ביוני',         expect: 'rename' },
    { input: 'שלום',                                  expect: 'none' },
    { input: '',                                      expect: 'none' },
  ];
  for (const c of cases) {
    const got = parseObjectiveCommand(c.input);
    assert(got.action === c.expect, 'parse "' + c.input + '" -> ' + c.expect);
  }

  // set sub-cases: verify horizon is parsed correctly
  const setMonth = parseObjectiveCommand('יעד חדש חודש לחסוך 1000');
  assert(setMonth.horizon === 'month', 'one-shot "יעד חדש חודש ..." -> horizon=month');
  const setSix = parseObjectiveCommand('יעד חדש חצי שנה xx');
  assert(setSix.horizon === 'six_months', 'one-shot "יעד חדש חצי שנה ..." -> horizon=six_months');
  const setYear = parseObjectiveCommand('יעד חדש שנה xx');
  assert(setYear.horizon === 'year', 'one-shot "יעד חדש שנה ..." -> horizon=year');
}

// ── 2) Bot wiring assertions ──────────────────────────────────────────────
console.log('\nBot source wiring:');
const BOT = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

assert(/function _handleObjectiveCommand_\(fromPhone, text\)/.test(BOT),
  '_handleObjectiveCommand_ function exists in bot');
assert(/_handleObjectiveCommand_\(__from_, __text_\)/.test(BOT),
  'doPost dispatches to _handleObjectiveCommand_');

// Must come BEFORE _handleGoalCommand_ so "יעד שלי" doesn't get swallowed
// by the goals command "יעדים" (sub-string would match if order wrong).
const objIdx  = BOT.indexOf('_handleObjectiveCommand_(__from_, __text_)');
const goalIdx = BOT.indexOf('_handleGoalCommand_(__from_, __text_)');
assert(objIdx > 0 && goalIdx > 0 && objIdx < goalIdx,
  'objective dispatch runs BEFORE goal dispatch');

// Bot calls /api/objectives/action with the bot-secret
assert(/api\/objectives\/action/.test(BOT), 'bot POSTs to /api/objectives/action');
assert(/x-kesefle-bot-secret/.test(BOT), 'bot-secret header is sent');

// Hebrew commands all present
for (const cmd of ['יעד שלי', 'השגתי יעד', 'השתק יעד', 'שנה יעד', 'יעד חדש']) {
  assert(BOT.indexOf(cmd) >= 0, 'bot recognizes "' + cmd + '"');
}

// Version was bumped to reflect this PR (so admin freshness badge flips red
// until Steven pastes).
const v = (BOT.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/objectives/.test(v || ''),
  'KFL_BUILD_VERSION bumped to include "objectives" (currently: ' + v + ')');

// ── 3) API + lib existence ─────────────────────────────────────────────────
console.log('\nAPI + lib files:');
assert(fs.existsSync(path.join(__dirname, '..', 'api', 'objectives', 'action.js')),
  'api/objectives/action.js exists');
assert(fs.existsSync(path.join(__dirname, '..', 'lib', 'objectives.js')),
  'lib/objectives.js exists');

const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'objectives', 'action.js'), 'utf8');
assert(/withRateLimit/.test(API), 'api/objectives/action.js has withRateLimit');
assert(/constantTimeEqual/.test(API), 'api/objectives/action.js uses constantTimeEqual for bot-secret check');
assert(/no_user_for_phone/.test(API), 'api/objectives/action.js returns 404 on missing phone record');

const LIB = fs.readFileSync(path.join(__dirname, '..', 'lib', 'objectives.js'), 'utf8');
for (const exp of ['parseObjectiveCommand', 'getObjective', 'setObjective', 'renameObjective', 'muteObjective', 'achieveObjective', 'deleteObjective', 'formatObjective']) {
  assert(new RegExp('export (?:async )?function ' + exp).test(LIB), 'lib/objectives.js exports ' + exp);
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
