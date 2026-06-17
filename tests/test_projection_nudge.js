// Contract gate for the projection re-engagement nudge (api/cron/projection-nudge.js
// + the template-send support in api/whatsapp/send.js).
//
// The cron sends PROACTIVE WhatsApp messages to (by design) users who have gone
// quiet. Two properties are safety-critical and must never silently regress:
//   1. It is INERT until an approved Meta template name is configured
//      (KESEFLE_PROJECTION_TEMPLATE). Remove that guard and a deploy could
//      message every user with a broken/absent template.
//   2. It projects EXPENSES only (income excluded) — a wrong number in a
//      financial nudge is a trust breach.
// Because the API files are ESM under a CommonJS package (Vercel bundles them),
// we can't import them here, so this gate re-implements the pure formula to lock
// the math contract and asserts the source invariants by text.
//
// Run: node tests/test_projection_nudge.js
'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('  ok  ' + name); }
  else { console.log('  FAIL ' + name); failures++; }
}

// ── 1. pure formula contract (mirrors projectMonthEnd / fmtNis in the cron) ──
function projectMonthEnd(mtd, dayOfMonth, daysInMonth) {
  if (!(mtd > 0) || !(dayOfMonth > 0) || !(daysInMonth > 0)) return 0;
  return Math.round((mtd / dayOfMonth) * daysInMonth);
}
function fmtNis(n) {
  return '₪' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

console.log('projection math:');
check('half-month pace doubles to month-end', projectMonthEnd(3000, 15, 30) === 6000);
check('day-10 of 31 extrapolates', projectMonthEnd(1000, 10, 31) === 3100);
check('zero MTD -> 0', projectMonthEnd(0, 10, 30) === 0);
check('guard: day 0 -> 0 (no divide-by-zero)', projectMonthEnd(500, 0, 30) === 0);
check('guard: 0 days in month -> 0', projectMonthEnd(500, 10, 0) === 0);

console.log('currency formatting:');
check('thousands separator', fmtNis(3200) === '₪3,200');
check('millions', fmtNis(1000000) === '₪1,000,000');
check('small value', fmtNis(50) === '₪50');
check('zero', fmtNis(0) === '₪0');
check('rounds', fmtNis(99.6) === '₪100');

// ── 2. cron source invariants ────────────────────────────────────────────────
const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron', 'projection-nudge.js'), 'utf8');
console.log('cron safety invariants:');
check('INERT when template env unset (the spam guard)',
  /KESEFLE_PROJECTION_TEMPLATE/.test(cronSrc) && /inert:\s*true/.test(cronSrc));
check('requires cron auth (CRON_SECRET)', /verifyCronAuth/.test(cronSrc) && /CRON_SECRET/.test(cronSrc));
check('sends a TEMPLATE (not freeform) to reach lapsed users',
  /sendTemplate/.test(cronSrc) && /template:\s*\{\s*name:/.test(cronSrc));
check('excludes income from the projection (col-H / income category)',
  /isIncome/.test(cronSrc) && /'false'/.test(cronSrc));
check('dedups one nudge per user per month', /projection_nudged:/.test(cronSrc));
check('does not extrapolate too early in the month', /MIN_DAY/.test(cronSrc));
check('skips negligible spend', /MIN_MTD/.test(cronSrc));

// ── 3. send.js template support (backward-compatible) ────────────────────────
const sendSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'whatsapp', 'send.js'), 'utf8');
console.log('send.js template support:');
check('has a template branch', /type:\s*'template'/.test(sendSrc));
check('still supports freeform text', /type:\s*'text'/.test(sendSrc));
check('maps params to body component parameters', /type:\s*'body'/.test(sendSrc) && /parameters/.test(sendSrc));
check('rejects when neither text nor template given', /missing_text_or_template/.test(sendSrc));

if (failures) { console.log('\n❌ projection-nudge contract: ' + failures + ' FAILED'); process.exit(1); }
console.log('\n✅ projection-nudge contract: ALL CHECKS PASSED');
