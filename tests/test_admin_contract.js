// Admin OS <-> API contract test. The 2026-06-17 audit found 6 data-honesty
// bugs that all shared one root cause: admin-os.html hand-reads JSON fields
// with no contract, so an endpoint/frontend divergence ships "green" and the
// dashboard silently lies. This gate makes a field rename fail CI instead.
//
// Run: node tests/test_admin_contract.js
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let fail = 0;

// 1) Forward contract: each endpoint MUST still return the fields admin-os reads.
const PROVIDES = {
  'api/admin/bot-version.js': ['deployed_version', 'repo_version', 'drift'],
  'api/admin/config-drift.js': ['drift', 'fix_instructions'],
  'api/admin/funnel-summary.js': ['conversion_from_prev', 'dropoff_pct'],
  'api/admin/sheets-quota.js': ['snapshot', 'read_limit', 'write_limit'],
  'api/admin/conversations.js': ['threads', 'messages'],
  'api/admin/referral-leaderboard.js': ['leaderboard', 'count'],
};
for (const [file, fields] of Object.entries(PROVIDES)) {
  const src = read(file);
  for (const fld of fields) {
    if (!new RegExp('\\b' + fld + '\\b').test(src)) {
      console.log('  ❌ ' + file + ' no longer returns "' + fld + '" — admin-os depends on it');
      fail++;
    }
  }
}

// 2) Regression guard: admin-os.html must NOT read the stale/wrong field names
//    that produced the bugs (these are never legitimate on any endpoint).
const STALE = ['apps_script_deployed', 'repo_latest', 'used_today', 'daily_limit', 'referral_count', 'text_if_available', 'drifts'];
const ui = read('admin-os.html');
for (const bad of STALE) {
  if (ui.includes(bad)) {
    console.log('  ❌ admin-os.html reads stale field "' + bad + '" — no endpoint returns it');
    fail++;
  }
}

if (fail) {
  console.log('\n❌ ADMIN CONTRACT: ' + fail + ' mismatch(es) — the dashboard would render empty/green');
  process.exit(1);
}
console.log('✅ ADMIN CONTRACT PASSED — admin-os field reads match the live API shapes');
process.exit(0);
