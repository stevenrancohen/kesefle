#!/usr/bin/env node
// tests/test_admin_console_data_sources.js
//
// CEO admin console (admin.html) data-source invariants (2026-06-03 deepen).
//
// The admin console was rebuilt to show ONLY real data from existing
// requireAdmin endpoints -- the fabricated tiles (invented MRR trend, fake
// AI-cost, hardcoded "12 of 47 signups") were removed. This suite PINS the
// wiring so a future edit cannot silently:
//   - drop a section back to fabricated/hardcoded numbers, or
//   - point a panel at an endpoint that does not exist, or
//   - leak a full email/phone into the console (privacy: must be masked).
//
// It reads the REAL admin.html via fs (house pattern -- no import, no mock,
// no network, no secrets). Pure string assertions, safe on the QA gate.
//
//   Run: node tests/test_admin_console_data_sources.js
//
// Invariants:
//   1.  The four deepened sections fetch their documented real endpoints:
//         - conversion funnel    -> /api/admin/funnel-summary
//         - users-needing-action -> /api/admin?action=registration-health
//         - recent signups       -> /api/admin/recent-signups
//         - KPI / bot-health     -> /api/admin/revenue + launch-monitor
//   2.  One-click recovery actions POST to the endpoints that already exist
//       (reprovision-user-sheet, resend-welcome) -- not a fabricated stub.
//   3.  Identity is masked client-side (maskEmail/maskPhone helpers present).
//   4.  The honest "not instrumented yet" notes survive (revenue trend +
//       AI-tier mix) so removed-fabrication does not creep back as fake data.
//   5.  The old analytics-fed renderFunnel is gone (so two scripts don't both
//       write #kfl-funnel) -- the funnel is sourced from funnel-summary only.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failures.push(label); console.log('  FAIL  ' + label); }
}

console.log('\n-- admin console: real endpoint wiring --');
assert(/\/api\/admin\/funnel-summary/.test(html),
  'conversion funnel fetches /api/admin/funnel-summary (7-step waterfall)');
assert(/action=registration-health/.test(html),
  'attention list fetches ?action=registration-health');
assert(/\/api\/admin\/recent-signups/.test(html),
  'recent-signups feed fetches /api/admin/recent-signups');
assert(/\/api\/admin\/revenue/.test(html),
  'KPI strip fetches /api/admin/revenue');
assert(/\/api\/admin\/launch-monitor/.test(html),
  'bot-health fetches /api/admin/launch-monitor');

console.log('\n-- admin console: one-click recovery actions exist --');
assert(/\/api\/admin\/reprovision-user-sheet/.test(html),
  'orphan rows POST to reprovision-user-sheet (existing endpoint)');
assert(/\/api\/admin\/resend-welcome/.test(html),
  'pending-link rows POST to resend-welcome (existing endpoint)');
assert(/method:\s*['"]POST['"]/.test(html),
  'recovery actions use POST');

console.log('\n-- admin console: privacy (masked identity) --');
assert(/function maskEmail\(/.test(html), 'maskEmail() helper present');
assert(/function maskPhone\(/.test(html), 'maskPhone() helper present');
assert(/maskEmail\(/.test(html) && /maskPhone\(/.test(html),
  'new sections render masked email + phone, not raw');

console.log('\n-- admin console: honest "not instrumented" notes survive --');
assert(/MRR חודש-מול-חודש/.test(html),
  'revenue-trend honest-skip note present (no fabricated sparkline)');
assert(/cache \/ keyword \/ fallback/.test(html),
  'AI-tier-mix honest note present (no fabricated tier/cost tiles)');

console.log('\n-- admin console: single funnel writer (no clobber) --');
assert(!/function renderFunnel\(/.test(html),
  'legacy analytics-fed renderFunnel removed (funnel-summary is the only writer)');
assert(/window\.kflLoadFunnel/.test(html),
  'dedicated funnel-summary loader (kflLoadFunnel) present');

console.log('');
if (failures.length) {
  console.error('FAILED ' + failures.length + ' admin-console invariant(s):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED (admin console: real endpoints + recovery actions + masked + honest notes)\n');
process.exit(0);
