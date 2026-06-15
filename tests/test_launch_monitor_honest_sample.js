#!/usr/bin/env node
// tests/test_launch_monitor_honest_sample.js
//
// /api/admin/launch-monitor honest-sampling invariant (2026-06-16).
//
// The windowed signup counts (active_last_hour / active_last_day /
// new_last_hour / new_last_day) are computed from a BOUNDED SAMPLE of user:*
// records (sampleSize, capped at 200) to protect the free-tier KV quota on a
// launch-day spike -- but they used to be returned inside the `signups` block
// with no indication that they were a sample, so the admin UI displayed them
// as if they were totals. They are NOT extrapolated.
//
// This suite PINS the honesty fields so a future edit cannot silently drop
// them and let the UI present a 200-user sample as the full population:
//   - signups.sampled    : the sample size actually scanned
//   - signups.totalUsers : the full user:* population size
//   - signups.complete   : true only when the sample covered every user
// and asserts `complete` is derived from sampleSize === totalUsers (so it is
// honestly true when the population is small, false when it was truncated).
//
// House pattern: reads the REAL handler source via fs (no import, no mock, no
// network, no secrets). Pure string assertions -- safe on the offline gauntlet.
//
//   Run: node tests/test_launch_monitor_honest_sample.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(
  path.join(ROOT, 'api', 'admin', 'launch-monitor.js'),
  'utf8'
);

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failures.push(label); console.log('  FAIL  ' + label); }
}

console.log('\n-- launch-monitor: signups block exposes honest sampling fields --');
assert(/sampled:\s*sampleSize\b/.test(src),
  'signups.sampled is set to the actual sampleSize (not a fabricated total)');
assert(/totalUsers:\s*totalUsers\b/.test(src),
  'signups.totalUsers reports the full user:* population size');
assert(/complete:\s*sampleSize\s*===\s*totalUsers\b/.test(src),
  'signups.complete is derived from sampleSize === totalUsers (honest)');

console.log('\n-- launch-monitor: sampling stays bounded + non-extrapolated --');
assert(/const\s+sampleSize\s*=\s*Math\.min\(\s*200\s*,\s*userKeys\.length\s*\)/.test(src),
  'sampleSize is capped at 200 of userKeys.length (KV-quota guard intact)');
// Guard against a future "fix" that multiplies the sampled counts up to a fake
// total. The finding explicitly forbids fabricated extrapolation, so the
// windowed counters must never be scaled by totalUsers / sampleSize.
assert(!/(totalUsers\s*\/\s*sampleSize|sampleSize\s*&&[^]*?\*\s*totalUsers)/.test(src),
  'windowed counts are NOT extrapolated (no totalUsers/sampleSize scaling)');

console.log('');
if (failures.length) {
  console.error('FAILED ' + failures.length + ' launch-monitor honest-sample invariant(s):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED (launch-monitor: honest sampled/totalUsers/complete, no extrapolation)\n');
process.exit(0);
