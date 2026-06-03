// tests/test_round3_api_kv_hardening.js
//
// Round 3 medium/low audit fixes — source-review contract test.
// Locks the code-level hardening shipped from:
//   docs/AUDIT_API_ENDPOINT_SECURITY_2026_05_31.md   (H1, M1, M2, L4)
//   docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md      (GDPR multi-key purge)
//
// Static review only (no Vercel KV, no network). Each assertion guards against
// a specific regression so the fix can't silently revert.

import fs from 'node:fs';

let failed = 0;
function ok(name, cond, hint) {
  if (cond) console.log('  PASS', name);
  else { console.log('  FAIL', name, hint ? ('— ' + hint) : ''); failed++; }
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const WEEKLY = read('../api/cron/customer-weekly-digest.js');
const DAILY  = read('../api/cron/steven-daily-digest.js');
const MANUAL = read('../api/billing/manual.js');
const HEARTB = read('../api/log/bot-heartbeat.js');
const LINK   = read('../api/whatsapp/link.js');
const STATS  = read('../api/admin/stats.js');
const ACCOUNT = read('../api/account.js');

// ── H1: cron bot-secret must travel in a header, never the URL query ─────────
console.log('=== H1: cron secret out of URL query string ===');
for (const [label, src] of [['customer-weekly-digest', WEEKLY], ['steven-daily-digest', DAILY]]) {
  ok(`${label} accepts x-kesefle-bot-secret header`,
    /x-kesefle-bot-secret/.test(src),
    'manual trigger must use a header, not ?admin=');
  ok(`${label} compares the header secret constant-time`,
    /headerSecret\s*&&\s*constantTimeEqual\(/.test(src));
  ok(`${label} warns when the deprecated ?admin= query path is used`,
    /deprecated_secret_in_url/.test(src) && /log\.warn\(/.test(src),
    'legacy query path must emit a deprecation warning so it can be retired');
}

// ── M1: billing/manual admin handler must be rate-limited ────────────────────
console.log('\n=== M1: billing/manual admin handler rate-limited ===');
ok('adminHandler wrapped with withRateLimit',
  /const adminHandler\s*=\s*withRateLimit\(\s*\{[^}]*billing_manual_admin[^}]*\}\s*\)\(\s*\n?\s*requireAdmin\(adminImpl\)/.test(MANUAL),
  'admin list/confirm/reject must have a rate-limit cap for defense-in-depth');
ok('user-flow handler still rate-limited (unchanged)',
  /const requestHandler\s*=\s*withRateLimit\(/.test(MANUAL));

// ── M2: single canonical constantTimeEqual, no local copies ──────────────────
console.log('\n=== M2: no duplicated constant-time compare ===');
for (const [label, src] of [['bot-heartbeat', HEARTB], ['whatsapp/link', LINK], ['admin/stats', STATS]]) {
  ok(`${label} imports constantTimeEqual from lib/crypto.js`,
    /import\s*\{\s*constantTimeEqual\s*\}\s*from\s*['"][^'"]*lib\/crypto\.js['"]/.test(src));
  ok(`${label} has no local function constantTimeEqual`,
    !/function\s+constantTimeEqual\s*\(/.test(src),
    'local copy must be removed in favor of the shared helper');
}
ok('admin/stats has no local ctEq helper',
  !/function\s+ctEq\s*\(/.test(STATS));
ok('admin/stats legacy compare uses canonical constantTimeEqual',
  /constantTimeEqual\(bearer,\s*ADMIN_TOKEN\)/.test(STATS) && !/ctEq\(/.test(STATS));
ok('whatsapp/link has no redundant dynamic crypto import',
  !/await import\(['"][^'"]*lib\/crypto\.js['"]\)/.test(LINK),
  'top-level static import replaces the per-call dynamic import');

// ── L4: customer digest must not hold a raw Google sub in the errors array ───
console.log('\n=== L4: PII (Google sub) hashed before entering errors array ===');
ok('errors array stores a sha256 fingerprint, not the raw userKey',
  /createHash\('sha256'\)\.update\(String\(userKey\)\)/.test(WEEKLY) &&
  /errors\.push\(\{\s*user:\s*userFp/.test(WEEKLY),
  'raw "google:<sub>" must never be pushed into the errors array');
ok('no raw errors.push({ user: userKey }) remains',
  !/errors\.push\(\{\s*user:\s*userKey/.test(WEEKLY));

// ── KV: GDPR multi-key purge (goals + cached stats) on account deletion ──────
console.log('\n=== KV: multi-key per-user records purged on delete ===');
ok('account.js imports purgeGoals from lib/goals.js',
  /import\s*\{\s*purgeGoals\s*\}\s*from\s*['"][^'"]*lib\/goals\.js['"]/.test(ACCOUNT));
ok('account.js defines the shared multi-key purge helper',
  /async function _purgeMultiKeyUserRecords_\(/.test(ACCOUNT));
ok('multi-key purge calls purgeGoals (walks goals index)',
  /_purgeMultiKeyUserRecords_[\s\S]*?purgeGoals\(userSub\)/.test(ACCOUNT));
ok('multi-key purge deletes cached stats windows',
  /_purgeMultiKeyUserRecords_[\s\S]*?stats:'\s*\+\s*userSub\s*\+\s*':'\s*\+\s*window/.test(ACCOUNT));
ok('deleteAccount (web path) calls the multi-key purge',
  /async function deleteAccount[\s\S]*?_purgeMultiKeyUserRecords_\(userSub/.test(ACCOUNT),
  'cookie-auth delete must purge goals + stats');
ok('deleteByPhone (bot path) calls the multi-key purge',
  /async function deleteByPhone[\s\S]*?_purgeMultiKeyUserRecords_\(userSub/.test(ACCOUNT),
  'bot-secret delete must purge goals + stats too');

if (failed > 0) {
  console.error('\nFAIL: ' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nOK: all Round 3 hardening assertions passed');
