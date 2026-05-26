#!/usr/bin/env node
// Regression test for PR-G2-cron (objective reminders).
// String-match assertions on:
//   1. api/cron/objective-reminders.js exists + has the right shape
//   2. vercel.json crons block includes the new schedule (Sun/Tue/Thu 17:00 UTC)
//   3. Reminder logic is structured correctly (dow guard, cooldown, dry-run)
const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_objective_reminders_cron.js\n');

// ── 1) Cron handler exists + correct shape ────────────────────────────────
console.log('Cron handler:');
const CRON_PATH = path.join(__dirname, '..', 'api', 'cron', 'objective-reminders.js');
assert(fs.existsSync(CRON_PATH), 'api/cron/objective-reminders.js exists');
const CRON = fs.readFileSync(CRON_PATH, 'utf8');

assert(/CRON_SECRET/.test(CRON), 'cron checks CRON_SECRET for Vercel auth');
assert(/REMINDER_DAYS_IL\s*=\s*new Set\(\[0,\s*2,\s*4\]\)/.test(CRON),
  'reminder days are Sun/Tue/Thu (0/2/4)');
assert(/MIN_HOURS_BETWEEN_REMINDERS\s*=\s*36/.test(CRON),
  'anti-spam cooldown is 36 hours');
assert(/kvScan\(['"]objective:\*['"]/.test(CRON),
  'cron enumerates via kvScan("objective:*")');
assert(/dryRun|dry/.test(CRON),
  'cron supports dryRun mode for ad-hoc testing');
assert(/graph\.facebook\.com\/v21\.0/.test(CRON),
  'cron uses Meta Graph v21.0 (pinned, same as other crons)');
assert(/lastReminderAt|reminderCount/.test(CRON),
  'cron updates lastReminderAt + reminderCount on successful send');

// Progress-aware reminder content
assert(/elapsed\s*<\s*30|pct\s*<\s*30/.test(CRON), 'cron has early-stage (<30% elapsed) template');
assert(/elapsed\s*<\s*70|pct\s*<\s*70/.test(CRON), 'cron has mid-stage (<70%) template');
assert(/אחרונים|אחרון|stretch/.test(CRON) || /\d{2}%/.test(CRON), 'cron has late-stage template');

// Skip conditions
for (const skip of ['muted', 'achieved', 'horizonEndsAt']) {
  assert(new RegExp('o\\.' + skip).test(CRON), 'cron skips objectives where ' + skip);
}

// ── 2) vercel.json includes the new cron schedule ─────────────────────────
console.log('\nvercel.json crons:');
const VJ = fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8');
assert(/\/api\/cron\/objective-reminders/.test(VJ),
  'vercel.json crons block references /api/cron/objective-reminders');
// Sun/Tue/Thu = day-of-week 0,2,4 in cron syntax
assert(/0\s+17\s+\*\s+\*\s+0,2,4/.test(VJ),
  'vercel.json schedule is "0 17 * * 0,2,4" (17:00 UTC = ~20:00 IL Sun/Tue/Thu)');

// ── 3) lib/objectives.js still exports everything the cron expects ───────
console.log('\nlib/objectives.js compatibility:');
const LIB = fs.readFileSync(path.join(__dirname, '..', 'lib', 'objectives.js'), 'utf8');
// Cron reads objective records that setObjective writes — check the field
// shape matches.
assert(/horizonChosenAt/.test(LIB), 'lib creates horizonChosenAt');
assert(/horizonEndsAt/.test(LIB), 'lib creates horizonEndsAt');
assert(/lastReminderAt:\s*null/.test(LIB) || /lastReminderAt:\s*0/.test(LIB),
  'lib initializes lastReminderAt');
assert(/reminderCount/.test(LIB), 'lib initializes reminderCount');
assert(/muted:/.test(LIB) && /achieved:/.test(LIB),
  'lib initializes muted + achieved flags');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
