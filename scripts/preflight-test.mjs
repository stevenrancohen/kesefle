#!/usr/bin/env node
// scripts/preflight-test.mjs
//
// Pre-launch smoke test for kesefle.com. Hits the critical signup-path
// endpoints in sequence, measures latency, and reports green/red per
// check. Designed to be run RIGHT BEFORE you post the launch link.
//
// Usage:
//   node scripts/preflight-test.mjs                       # tests prod (kesefle.com)
//   node scripts/preflight-test.mjs https://staging.foo   # tests staging
//
// Exit code: 0 if all green, 1 if any red. CI-friendly.

import process from 'node:process';

const TARGET = (process.argv[2] || 'https://kesefle.com').replace(/\/$/, '');
const TIMEOUT_MS = 10000;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

let failures = 0;

function pass(name, detail) {
  console.log(`  ${GREEN}✓${RESET} ${name}  ${DIM}${detail || ''}${RESET}`);
}
function fail(name, detail) {
  console.log(`  ${RED}✗${RESET} ${BOLD}${name}${RESET}  ${RED}${detail || ''}${RESET}`);
  failures++;
}
function warn(name, detail) {
  console.log(`  ${YELLOW}!${RESET} ${name}  ${YELLOW}${detail || ''}${RESET}`);
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - t0, result };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e };
  }
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function check_homepage_loads() {
  const r = await fetchWithTimeout(TARGET + '/');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes("כספ'לה")) throw new Error('Brand string missing from homepage HTML');
  if (!html.includes('about-kesefle')) throw new Error('about-kesefle section missing (homepage restructure regressed)');
  return `${html.length} bytes`;
}

async function check_account_page_loads() {
  const r = await fetchWithTimeout(TARGET + '/account');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes('kesefleIsInAppBrowser')) throw new Error('In-app browser detection missing -- launch blocker!');
  if (!html.includes('WhatsAppBusiness')) throw new Error('WA Business detection regex missing -- regression');
  return `${html.length} bytes, in-app detection present`;
}

async function check_config_endpoint() {
  const r = await fetchWithTimeout(TARGET + '/api/config');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error('returned ok:false');
  if (!j.BOT_NUMBER) throw new Error('BOT_NUMBER missing from config');
  return `BOT_NUMBER=+${j.BOT_NUMBER}, waba_approved=${j.waba_approved}`;
}

async function check_link_status_anonymous() {
  // GET should return { ok:true, linked:false } for a phone that doesn't exist,
  // with NO billing info (auth-gated since 2026-05-23).
  const fakePhone = '972500000000';
  const r = await fetchWithTimeout(TARGET + `/api/whatsapp/link?phone=${fakePhone}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error('returned ok:false');
  if (j.linked !== false) throw new Error(`expected linked:false, got ${JSON.stringify(j)}`);
  if (j.plan || j.sheetId || j.userSub) throw new Error('anonymous caller leaked billing fields -- security regression');
  return 'linked=false, no billing leak';
}

async function check_google_exchange_rejects_invalid() {
  // POST with bogus code should return 4xx, NOT 500 (5xx = our bug).
  const r = await fetchWithTimeout(TARGET + '/api/auth/google-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'preflight_invalid', codeVerifier: 'x'.repeat(43), redirectUri: TARGET + '/account' }),
  });
  if (r.status >= 500) throw new Error(`5xx server error: HTTP ${r.status} (Google should reject the code with 4xx)`);
  if (r.status === 200) {
    const j = await r.json();
    if (j.ok) throw new Error('endpoint accepted a bogus code -- CRITICAL security regression');
  }
  return `HTTP ${r.status} as expected`;
}

async function check_sheet_provision_rejects_no_auth() {
  // POST without any auth should return 401.
  const r = await fetchWithTimeout(TARGET + '/api/sheet/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (r.status === 200) {
    const j = await r.json();
    if (j.ok) throw new Error('endpoint accepted a no-auth request -- CRITICAL');
  }
  if (r.status !== 401 && r.status !== 400 && r.status !== 403) {
    throw new Error(`expected 4xx, got HTTP ${r.status}`);
  }
  return `HTTP ${r.status} as expected`;
}

async function check_missed_inapp_beacon() {
  const r = await fetchWithTimeout(TARGET + '/api/log/missed-inapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ua: 'preflight-test/1.0 (this is a preflight test)', reason: 'preflight' }),
  });
  if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
  return `HTTP ${r.status} (telemetry endpoint accepts beacons)`;
}

async function check_admin_endpoints_require_admin() {
  for (const path of ['/api/admin/launch-monitor', '/api/admin/bot-version', '/api/admin/config-drift']) {
    const r = await fetchWithTimeout(TARGET + path);
    if (r.status !== 401 && r.status !== 403) {
      throw new Error(`${path} returned HTTP ${r.status} without auth (should be 401/403)`);
    }
  }
  return 'all 3 admin endpoints reject unauthenticated requests';
}

async function check_sitemap_lastmod_recent() {
  const r = await fetchWithTimeout(TARGET + '/sitemap.xml');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  // Look for any <lastmod> in 2026-05.
  const matches = xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || [];
  if (matches.length === 0) throw new Error('no <lastmod> tags found in sitemap');
  // Find the most recent.
  const dates = matches.map((m) => m.replace(/<\/?lastmod>/g, '')).sort();
  const latest = dates[dates.length - 1];
  const ageDays = Math.floor((Date.now() - new Date(latest).getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays > 30) throw new Error(`latest lastmod is ${ageDays} days old`);
  return `latest=${latest} (${ageDays} days old)`;
}

async function check_robots_txt() {
  const r = await fetchWithTimeout(TARGET + '/robots.txt');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.includes('Disallow: /\n') && !text.includes('Disallow: /admin')) {
    throw new Error('robots.txt blocks entire site!');
  }
  return `${text.length} bytes, no site-wide block`;
}

const CHECKS = [
  ['homepage loads', check_homepage_loads],
  ['/account loads + in-app detection present', check_account_page_loads],
  ['/api/config returns BOT_NUMBER', check_config_endpoint],
  ['/api/whatsapp/link GET hides billing from anonymous', check_link_status_anonymous],
  ['/api/auth/google-exchange rejects bogus code (not 5xx)', check_google_exchange_rejects_invalid],
  ['/api/sheet/provision requires auth', check_sheet_provision_rejects_no_auth],
  ['/api/log/missed-inapp accepts beacons', check_missed_inapp_beacon],
  ['/api/admin/* require admin auth', check_admin_endpoints_require_admin],
  ['/sitemap.xml has recent lastmod', check_sitemap_lastmod_recent],
  ['/robots.txt does not block the site', check_robots_txt],
];

async function main() {
  console.log(`${BOLD}\n  PRE-FLIGHT SMOKE TEST${RESET}  ${DIM}target: ${TARGET}${RESET}\n`);
  for (const [name, fn] of CHECKS) {
    const r = await timed(fn);
    if (r.ok) {
      pass(`${name}  ${DIM}(${r.ms}ms)${RESET}`, r.result);
    } else {
      fail(name, `${r.error.message || r.error}  (${r.ms}ms)`);
    }
    // Slow check warning
    if (r.ok && r.ms > 2000) warn(`  ↑ slow: ${r.ms}ms (>2s) -- may indicate launch-day strain`);
  }

  console.log('');
  if (failures === 0) {
    console.log(`  ${GREEN}${BOLD}✓ ALL ${CHECKS.length} CHECKS PASSED${RESET}\n`);
    console.log(`  ${DIM}Ready to launch. Post the URL.${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`  ${RED}${BOLD}✗ ${failures} OF ${CHECKS.length} CHECKS FAILED${RESET}\n`);
    console.log(`  ${RED}DO NOT LAUNCH until fixed.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('preflight crashed:', e);
  process.exit(2);
});
