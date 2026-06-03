#!/usr/bin/env node
// Regression test for the 2026-05-27 Bot QA audit's "3 active lies" finding.
// Guards against re-introducing promises with no implementation:
//
//   1. line 9473 was "תזכורות יידלקו ב-PR הבא" (no reminder cron)
//   2. line 9574 was "התראות יעדים יופעלו ב-PR הבא"
//   3. line 9643 was "התראות יישלחו אוטומטית ב-50%, 80% ו-100% (נדלק ב-PR-2)"
//
// Per the bot-reply-style + audit-finding-to-pr skills: a bot reply that
// makes a promise the system can't keep is a CRITICAL UX bug. Honest copy
// is the surgical fix until the cron actually lands.

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_bot_no_active_lies.js\n');

const BOT = fs.readFileSync(
  path.join(__dirname, 'ExpenseBot_FIXED.gs'),
  'utf8'
);

// Strip comments so doc lines ("was 'תזכורות יידלקו ב-PR הבא' which lied")
// don't false-positive.
const CODE = BOT.split('\n')
  .filter(line => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('No active lies in user-facing replies:');
const BANNED_PHRASES = [
  'תזכורות יידלקו ב-PR',
  'התראות יעדים יופעלו ב-PR',
  'נדלק ב-PR-2',
  'יישלחו אוטומטית ב-50%, 80% ו-100%',
];
for (const phrase of BANNED_PHRASES) {
  assert(CODE.indexOf(phrase) < 0,
    'phrase "' + phrase + '" does NOT appear in active bot code');
}

// Generic "PR הבא" / "PR-2" / "PR-3" promise patterns -- catches future
// drift where someone adds a new "will fire in PR-N" copy.
const PR_PROMISE_RE = /['"][^'"]*?(PR ?הבא|PR-\d+)/g;
const matches = [];
let m;
while ((m = PR_PROMISE_RE.exec(CODE)) !== null) matches.push(m[0]);
assert(matches.length === 0,
  'no "PR הבא" / "PR-N" promises in user-facing strings (found ' + matches.length + ')');
if (matches.length) {
  matches.slice(0, 5).forEach(s => console.log('    -> ' + s.slice(0, 80)));
}

// Sanity: the OBJECTIVE / GOAL flows STILL return replies (we didn't
// accidentally break them by deleting the lie line).
console.log('\nReplies still present (not accidentally deleted):');
assert(/✅ יעד חדש נקבע/.test(CODE),
  'objective-set success reply still present');
assert(/🔕 רשמתי שלא לשלוח לך תזכורות/.test(CODE),
  'mute reply has honest copy ("רשמתי שלא לשלוח")');
assert(/✅ יעד נקבע: /.test(CODE),
  'goal-set success reply still present');

// Version bumped so admin freshness badge flips red until Steven pastes.
// Loosened from PR-specific name match to any YYYY-MM-DD prefix so
// subsequent PRs can rebump the version freely. Same fix-class as
// test_pending_state_hijack.js / test_trace_instrumentation.js. The
// substantive "no active lies" assertions above are what actually guard
// the fix.
console.log('\nVersion:');
const v = (BOT.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
