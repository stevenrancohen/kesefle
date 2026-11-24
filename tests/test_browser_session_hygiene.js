#!/usr/bin/env node
'use strict';

// Browser auth regression contract:
// - reusable credentials never survive in Web Storage
// - app/admin API calls use the HttpOnly session cookie only
// - legacy profiles migrate without losing harmless offline presentation data
// - the installed PWA rolls onto the new shell + scrubber together

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(label, condition, hint) {
  if (condition) {
    pass++;
    console.log('  ✅ ' + label);
  } else {
    fail++;
    console.error('  ❌ ' + label + (hint ? ' — ' + hint : ''));
  }
}

function storage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    key(i) { return Array.from(data.keys())[i] ?? null; },
    getItem(k) { return data.has(String(k)) ? data.get(String(k)) : null; },
    setItem(k, v) { data.set(String(k), String(v)); },
    removeItem(k) { data.delete(String(k)); },
    dump() { return Object.fromEntries(data); },
  };
}

console.log('\n=== legacy browser credential migration ===');
const legacyJwt = 'eyJhbGciOiJSUzI1NiJ9.'
  + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  + '.signature';
const local = storage({
  kesefle_user: JSON.stringify({
    sub: '123', email: 'user@example.com', name: 'Dana', picture: '/avatar.png', plan: 'pro',
    idToken: legacyJwt, id_token: 'jwt-2', idTokenExpiresAt: 9999999999999,
    accessToken: 'access', refresh_token: 'refresh', credential: 'raw',
    authorization: 'Bearer raw', adminToken: 'admin', role: 'admin', internalFlags: { staff: true },
  }),
  kefle_admin_token: 'legacy-admin',
  'kesefle_fixed_expenses:972500000000': '[{"amount":10}]',
  kfl_app_theme: 'dark',
});
const session = storage({
  kesefle_user: JSON.stringify({ sub: '123', access_token: 'access' }),
  kfl_pkce_verifier_state123: 'verifier',
  kfl_oauth_state: 'state123',
  kfl_auth_next: '/dashboard',
});
const context = { window: { localStorage: local, sessionStorage: session, atob: s => Buffer.from(s, 'base64').toString('binary') } };
vm.runInNewContext(read('lib/browser-session.js'), context, { filename: 'browser-session.js' });

const migrated = JSON.parse(local.getItem('kesefle_user'));
const migratedKeys = Object.keys(migrated).map(k => k.replace(/[^a-z0-9]/gi, '').toLowerCase());
check('profile is upgraded to presentation-only schema v2',
  migrated.version === 2 && migrated.sub === '123' && migrated.email === 'user@example.com'
    && migrated.name === 'Dana' && migrated.picture === '/avatar.png' && migrated.plan === 'pro');
check('profile storage uses an exact presentation-only allowlist',
  JSON.stringify(migratedKeys.sort()) === JSON.stringify(['email','name','picture','plan','sub','version'].sort()));
check('legacy admin shared secret is removed', local.getItem('kefle_admin_token') === null);
check('fresh legacy ID token survives only in memory for one cookie upgrade',
  context.window.KesefleSession.consumeLegacyIdToken() === legacyJwt
    && context.window.KesefleSession.consumeLegacyIdToken() === null);
check('PKCE state and verifier remain available for the OAuth callback',
  session.getItem('kfl_pkce_verifier_state123') === 'verifier' && session.getItem('kfl_oauth_state') === 'state123');
check('migration is idempotent',
  JSON.stringify(context.window.KesefleSession.sanitizeStorage(local)) === JSON.stringify(migrated));

context.window.KesefleSession.clearAllIdentityStorage();
check('logout removes identity data and pending auth flow state',
  !local.getItem('kesefle_user') && !local.getItem('kesefle_sheet')
    && !local.getItem('kesefle_fixed_expenses:972500000000')
    && !session.getItem('kfl_pkce_verifier_state123') && !session.getItem('kfl_oauth_state')
    && !session.getItem('kfl_auth_next'));
check('logout preserves device preferences', local.getItem('kfl_app_theme') === 'dark');

console.log('\n=== cookie-only browser clients ===');
const account = read('account.html');
const dashboard = read('dashboard.html');
const app = read('app.html');
const admin = read('admin.html');
const adminOs = read('admin-os.html');
const launch = read('admin/launch-monitor.html');
const monitor = read('admin/monitor.html');
const browserClients = [account, dashboard, app, admin, adminOs, launch, monitor].join('\n');

check('dashboard no longer persists or reads Google ID tokens',
  !/\bidToken\b|idTokenExpiresAt|persistIdToken|isIdTokenFresh|getOrRefreshIdentity/.test(dashboard));
check('dashboard upgrades a legacy token once without storing it again',
  /consumeLegacyIdToken\(\)/.test(dashboard)
    && /\/api\/auth\/google[\s\S]{0,260}body:\s*JSON\.stringify\(\{\s*credential:\s*legacyCredential\s*\}\)/.test(dashboard));
check('dashboard referrals and summary send the session cookie',
  /\/api\/referral\?action=mine[\s\S]{0,180}credentials:\s*['"]include['"]/.test(dashboard)
    && /\/api\/referral\?action=generate[\s\S]{0,220}credentials:\s*['"]include['"]/.test(dashboard)
    && /\/api\/sheet\/summary[\s\S]{0,180}credentials:\s*['"]include['"]/.test(dashboard));
check('dashboard reauthentication uses the full-page PKCE route',
  /\/account\?force_signin=1&next=/.test(dashboard)
    && !/\/account\?next=/.test(dashboard)
    && !/accounts\.google\.com\/gsi\/client/.test(dashboard));
check('mobile dashboard clips the off-canvas sidebar without horizontal page scroll',
  /html,\s*body\s*\{\s*overflow-x:\s*hidden;\s*\}/.test(dashboard));
check('mobile dashboard menu announces its open and closed state',
  /setAttribute\(['"]aria-label['"],\s*['"]סגור תפריט['"]\)/.test(dashboard)
    && /setAttribute\(['"]aria-label['"],\s*['"]פתח תפריט['"]\)/.test(dashboard)
    && /setAttribute\(['"]inert['"]/.test(dashboard)
    && /event\.key\s*===\s*['"]Escape['"]/.test(dashboard)
    && /if \(first\) first\.focus\(\)/.test(dashboard));
check('account referral redemption is session-authenticated',
  /\/api\/referral\?action=redeem[\s\S]{0,180}credentials:\s*['"]include['"]/.test(account));
check('phone linking is session-only and sends no Google token',
  /\/api\/whatsapp\/link[\s\S]{0,220}body:\s*JSON\.stringify\(\{\s*phone:\s*phone\s*\}\)/.test(account)
    && !/_kflGetFreshAccessToken/.test(account));
check('safe auth return targets are exact allowlisted paths',
  /function _kflSafeAuthNext/.test(account)
    && /['"]\/admin\/monitor['"]:\s*true/.test(account)
    && /['"]\/admin-os['"]:\s*true/.test(account)
    && /['"]\/dashboard['"]:\s*true/.test(account)
    && /sessionStorage\.removeItem\(['"]kfl_auth_next['"]\)/.test(account)
    && /kesefleRetryProvision[\s\S]{0,700}_kflConsumeAuthNext\(\)/.test(account));
check('PKCE verifier is one-shot and expires after ten minutes',
  /KFL_PKCE_MAX_AGE_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/.test(account)
    && /kfl_pkce_started_/.test(account)
    && /pkceAge\s*>\s*KFL_PKCE_MAX_AGE_MS/.test(account)
    && /_kflClearPkce\(state\);[\s\S]{0,120}kesefleShowConnecting\(\)/.test(account));
check('app and admin surfaces never construct a browser Bearer header',
  !/Authorization\s*['"]?\s*[:=]\s*['"]Bearer|\['Authorization'\]\s*=\s*['"]Bearer/.test([app, admin, adminOs, launch, monitor].join('\n')));
check('admin monitor contains no reusable shared secret or secret storage',
  !/kesefle2026|kefle_admin_token|ADMIN_TOKEN/.test(monitor)
    && /\/account\?force_signin=1&amp;next=%2Fadmin%2Fmonitor/.test(monitor));
check('expired app and admin sessions force PKCE and preserve safe destinations',
  /\/account\?force_signin=1&amp;next=%2Fapp/.test(app)
    && /\/account\?force_signin=1&next=%2Fadmin-os/.test(adminOs)
    && !/\/account\?next=/.test([app, adminOs].join('\n')));
check('logout waits for a keepalive cookie clear and purges both browser stores',
  [account, dashboard, app, admin].every(src => /\/api\/auth\/logout[\s\S]{0,140}keepalive:\s*true/.test(src))
    && [account, dashboard, app, admin].every(src => /clearAllIdentityStorage\(\)/.test(src)));
check('admin authorization truth comes from server responses, not local profile presence',
  !/function\s+isLoggedIn[\s\S]{0,180}localStorage/.test(admin)
    && !/function\s+isLoggedIn[\s\S]{0,180}localStorage/.test(launch));

console.log('\n=== repository storage + PWA rollout invariants ===');
const htmlFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (ent.isFile() && ent.name.endsWith('.html')) htmlFiles.push(full);
  }
}
walk(ROOT);
const profileReaders = htmlFiles.filter(f => fs.readFileSync(f, 'utf8').includes('kesefle_user'));
check('every HTML surface that reads the profile loads the early scrubber',
  profileReaders.length > 0 && profileReaders.every(f => {
    const src = fs.readFileSync(f, 'utf8');
    return src.includes('/lib/browser-session.js')
      && src.indexOf('/lib/browser-session.js') < src.indexOf('kesefle_user');
  }), profileReaders.filter(f => !fs.readFileSync(f, 'utf8').includes('/lib/browser-session.js')).map(f => path.relative(ROOT, f)).join(', '));
check('credential scrubber runs before every third-party executable script',
  profileReaders.every(f => {
    const src = fs.readFileSync(f, 'utf8');
    const scrubber = src.indexOf('/lib/browser-session.js');
    const remoteScript = src.search(/<script[^>]+src=["']https:\/\//i);
    return scrubber >= 0 && (remoteScript < 0 || scrubber < remoteScript);
  }));

check('shipped browser clients contain no Google ID-token field access',
  !/\.idToken\b|idTokenExpiresAt/.test(browserClients));
check('every browser profile write passes through the presentation sanitizer',
  !htmlFiles.some(f => {
    const src = fs.readFileSync(f, 'utf8');
    return /localStorage\.setItem\(['"]kesefle_user['"],\s*JSON\.stringify\((?:user|u|meJson\.user)\)\)/.test(src);
  }));

const sw = read('sw.js');
check('service worker version includes the account-Push and logout-isolation rollout',
  /v27-2026-11-24-static-app-css-[a-f0-9]{12}/.test(sw));
check('offline shell precaches the browser-session scrubber',
  /['"]\/lib\/browser-session\.js['"]/.test(sw));
check('API requests remain network-only',
  /if\s*\(url\.origin === self\.location\.origin && isApi\(url\)\)\s*\{\s*event\.respondWith\(fetch\(request\)/.test(sw));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
