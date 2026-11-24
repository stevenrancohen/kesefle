#!/usr/bin/env node
'use strict';

// Dashboard privacy regression contract:
//   * private chrome stays hidden until /api/me verifies the HttpOnly session
//   * stale local account A can never be painted when the cookie belongs to B
//   * signed-out and unavailable states do not start any financial data API
//   * account switches clear presentation metadata and detach old browser Push

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function extractFunction(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error('missing function: ' + name);
  const start = match.index;
  let body = source.indexOf('{', match.index + match[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = body; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function: ' + name);
}

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return Object.fromEntries(values); },
  };
}

function classList(initial = []) {
  const classes = new Set(initial);
  return {
    add(...names) { names.forEach((name) => classes.add(name)); },
    remove(...names) { names.forEach((name) => classes.delete(name)); },
    toggle(name, force) {
      if (force === true) classes.add(name);
      else if (force === false) classes.delete(name);
      else if (classes.has(name)) classes.delete(name);
      else classes.add(name);
      return classes.has(name);
    },
    contains(name) { return classes.has(name); },
  };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; },
  };
}

async function runInit({
  localSeed,
  fetchResult,
  fetchError = null,
  fetchHandler = null,
  legacyCredential = null,
  pushSubscription = false,
  pushUnsubscribeResult = true,
  beforePushUnsubscribe = null,
  shortInitTimeouts = false,
}) {
  const local = storage(localSeed);
  const sessionStore = storage({ kesefle_user: '{"sub":"session-stale"}' });
  const calls = [];
  const pushEvents = [];
  const elements = Object.create(null);
  const element = (id) => {
    if (!elements[id]) elements[id] = {
      id,
      textContent: id === 'user-name' ? 'טוען...' : '',
      href: '#',
      src: '',
      classList: classList(id === 'kfl-session-gate-actions' || id === 'kfl-session-signin' || id === 'kfl-session-retry' ? ['hidden'] : []),
    };
    return elements[id];
  };
  const bodyClasses = classList(['kfl-session-pending']);
  element('user-name');
  const clearIdentityStorage = (target) => {
    ['kesefle_user', 'kesefle_sheet', 'kesefle_whatsapp_linked', 'kesefle_whatsapp_phone',
      'kesefle_signup_progress', 'kfl_push_subscribed'].forEach((key) => target.removeItem(key));
  };
  let legacy = legacyCredential;
  let browserSubscription = pushSubscription ? {
    endpoint: 'https://fcm.googleapis.com/fcm/send/old-account',
    async unsubscribe() {
      pushEvents.push('unsubscribe:start');
      if (beforePushUnsubscribe) await beforePushUnsubscribe();
      pushEvents.push('unsubscribe:end:' + pushUnsubscribeResult);
      if (pushUnsubscribeResult) browserSubscription = null;
      return pushUnsubscribeResult;
    },
  } : null;
  const navigator = pushSubscription ? {
    serviceWorker: {
      async getRegistration(scope) {
        pushEvents.push('registration:' + scope);
        return { pushManager: { async getSubscription() {
          pushEvents.push('subscription:' + (browserSubscription ? 'present' : 'empty'));
          return browserSubscription;
        } } };
      },
    },
  } : {};
  const context = {
    Promise,
    JSON,
    RegExp,
    setTimeout,
    clearTimeout,
    localStorage: local,
    sessionStorage: sessionStore,
    LAST_DASHBOARD: { stale: true },
    LAST_TX: { stale: true },
    document: {
      body: { classList: bodyClasses },
      getElementById: element,
      addEventListener() {},
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchHandler) return fetchHandler(url, options, calls);
      if (fetchError) throw fetchError;
      return fetchResult;
    },
    kesefleGetUser() {
      try { return JSON.parse(local.getItem('kesefle_user') || 'null'); }
      catch (_e) { return null; }
    },
    kesefleRefresh() { calls.push({ url: '/api/sheet/summary', simulated: true }); },
    kesefleCloseTxModal() {},
    window: {
      navigator,
      location: { href: '/dashboard' },
      KesefleSession: {
        consumeLegacyIdToken() { const value = legacy; legacy = null; return value; },
        sanitizeProfileObject(user) {
          return { version: 2, sub: user.sub, email: user.email, name: user.name, picture: user.picture, plan: user.plan };
        },
        clearIdentityStorage,
      },
    },
  };
  const functionNames = [
    'kesefleSetSessionGate',
    'kesefleRevealDashboardShell',
    'kesefleClearDashboardPresentation',
    'kesefleDashboardDeadline',
    'kesefleDetachDashboardPush',
    'keseflePrepareDashboardSession',
    'kesefleHydrateDashboardSession',
    'kesefleProbeDashboardSession',
    'keseflePaintDashboardIdentity',
    'kesefleInitDashboardSession',
  ];
  const functions = functionNames.map((name) => {
    let source = extractFunction(dashboard, name);
    if (shortInitTimeouts && name === 'kesefleInitDashboardSession') {
      source = source.replace(/\}\), 5000, null\);/g, '}), 10, null);');
    }
    return source;
  }).join('\n');
  vm.runInNewContext(functions + '\nglobalThis.run = kesefleInitDashboardSession;', context, {
    filename: 'dashboard-session-truth-runtime.js',
  });
  const result = await context.run();
  return { result, calls, pushEvents, local, sessionStore, elements, bodyClasses, location: context.window.location };
}

async function probeWithShortDeadline(fetchImpl) {
  const context = { Promise, setTimeout, clearTimeout, fetch: fetchImpl };
  const deadline = extractFunction(dashboard, 'kesefleDashboardDeadline');
  const probe = extractFunction(dashboard, 'kesefleProbeDashboardSession')
    .replace('5000, null', '10, null')
    .replace('2000, null', '10, null');
  vm.runInNewContext(deadline + '\n' + probe + '\nglobalThis.run = kesefleProbeDashboardSession;', context);
  return context.run();
}

function privateFetchGate(source, endpoint) {
  const fetchAt = source.indexOf(endpoint);
  assert.ok(fetchAt >= 0, endpoint + ' consumer exists');
  const before = source.slice(Math.max(0, fetchAt - 3000), fetchAt);
  assert.match(before, /await window\.__kflDashboardSessionReady|Promise\.resolve\(window\.__kflDashboardSessionReady\)/,
    endpoint + ' waits for dashboard session authority');
}

(async function main() {
  console.log('\n=== dashboard session authority ===\n');

  assert.match(dashboard, /<body class="kfl-session-pending[^\"]*">/,
    'dashboard starts in a private pending state');
  assert.match(dashboard, /\.kfl-session-pending \.kfl-private-shell \{ display: none !important; \}/,
    'pending state hides the complete private shell before first paint');
  assert.match(dashboard, /<header class="kfl-private-shell/);
  assert.match(dashboard, /<aside id="kfl-sidebar"[\s\S]{0,100}class="kfl-private-shell/);
  assert.match(dashboard, /id="kfl-sidebar-toggle"[\s\S]{0,130}class="kfl-private-shell/);
  assert.match(dashboard, /<main class="kfl-private-shell/);
  assert.match(dashboard, /id="kfl-session-gate"[^>]*role="status"[^>]*aria-live="polite"/,
    'pending, signed-out and retry feedback is accessible');
  assert.match(dashboard, /window\.__kflDashboardSessionReady = kesefleInitDashboardSession\(\)/,
    'one shared authority promise gates private consumers');
  assert.doesNotMatch(dashboard, /if \(!u \|\| !s \|\| !s\.spreadsheetUrl\)/,
    'local presentation metadata no longer decides whether /api/me runs');

  const probe = extractFunction(dashboard, 'kesefleProbeDashboardSession');
  assert.match(probe, /kesefleDashboardDeadline\(fetch\('\/api\/me',[\s\S]*?credentials: 'include',[\s\S]*?cache: 'no-store',[\s\S]*?\), 5000, null\)/,
    '/api/me is cookie-authenticated and never cacheable');
  assert.match(probe, /kesefleDashboardDeadline\(response\.json\(\), 2000, null\)/,
    '/api/me JSON parsing is bounded too');
  assert.match(probe, /response\.status === 401 \|\| response\.status === 403/,
    'both authentication rejection statuses fail closed');

  privateFetchGate(dashboard.slice(dashboard.indexOf('async function load()')), "fetch('/api/sheet/getExpenses'");
  privateFetchGate(dashboard.slice(dashboard.indexOf('async function maybeShowCard()')), "fetch('/api/config'");
  privateFetchGate(dashboard.slice(dashboard.indexOf('function loadVerifiedCategories()')), "fetchList().then(render)");
  privateFetchGate(dashboard.slice(dashboard.indexOf('/* Dashboard WhatsApp capability controller.')), "fetch('/api/config'");

  const payloadB = {
    ok: true,
    user: { sub: 'B', email: 'b@example.com', name: 'משתמש ב', picture: 'https://img.test/b.png', plan: 'pro', admin: true },
    sheet: { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/B/edit', spreadsheetId: 'B' },
  };
  const switched = await runInit({
    localSeed: {
      kesefle_user: JSON.stringify({ version: 2, sub: 'A', email: 'a@example.com', name: 'משתמש א' }),
      kesefle_sheet: JSON.stringify({ spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/A/edit' }),
      kesefle_whatsapp_phone: '972500000001',
      kesefle_whatsapp_linked: '1',
      kfl_push_subscribed: '1',
    },
    fetchResult: response(200, payloadB),
  });
  assert.strictEqual(switched.result.user.sub, 'B');
  assert.deepStrictEqual(switched.calls.map((call) => call.url), ['/api/me', '/api/me', '/api/sheet/summary'],
    'account-switch isolation is followed by revalidation before financial data');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(switched.calls[0].options)), {
    credentials: 'include', cache: 'no-store',
  });
  assert.strictEqual(switched.elements['user-name'].textContent, 'משתמש ב');
  assert.notStrictEqual(switched.elements['user-name'].textContent, 'משתמש א');
  assert.strictEqual(switched.elements['settings-email'].textContent, 'b@example.com');
  assert.strictEqual(switched.elements['settings-sheet'].href, payloadB.sheet.spreadsheetUrl);
  assert.strictEqual(switched.local.getItem('kesefle_whatsapp_phone'), null);
  assert.strictEqual(switched.local.getItem('kesefle_whatsapp_linked'), null);
  assert.strictEqual(switched.local.getItem('kfl_push_subscribed'), null);
  assert.strictEqual(JSON.parse(switched.local.getItem('kesefle_user')).admin, undefined,
    'only sanitized presentation fields are retained');
  assert.strictEqual(switched.bodyClasses.contains('kfl-session-pending'), false,
    'private shell is revealed only after B is painted');

  const legacyCannotReplaceCookie = await runInit({
    localSeed: { kesefle_user: JSON.stringify({ sub: 'A', name: 'משתמש א' }) },
    fetchResult: response(200, payloadB),
    legacyCredential: 'legacy-token-for-A',
  });
  assert.deepStrictEqual(legacyCannotReplaceCookie.calls.map((call) => call.url),
    ['/api/me', '/api/me', '/api/sheet/summary']);
  assert.ok(!legacyCannotReplaceCookie.calls.some((call) => call.url === '/api/auth/google'),
    'legacy account A can never replace an already-valid cookie for B');
  assert.strictEqual(legacyCannotReplaceCookie.elements['user-name'].textContent, 'משתמש ב');

  let legacyMeCalls = 0;
  const legacyUpgrade = await runInit({
    localSeed: { kesefle_user: JSON.stringify({ sub: 'A', name: 'משתמש א' }) },
    legacyCredential: 'legacy-token-for-A',
    fetchHandler: async (url) => {
      if (url === '/api/auth/google') return response(200, { ok: true });
      legacyMeCalls += 1;
      return legacyMeCalls === 1
        ? response(401, { ok: false, error: 'unauthorized' })
        : response(200, {
          ok: true,
          user: { sub: 'A', name: 'משתמש א', email: 'a@example.com' },
          sheet: { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/A/edit' },
        });
    },
  });
  assert.deepStrictEqual(legacyUpgrade.calls.map((call) => call.url),
    ['/api/me', '/api/auth/google', '/api/me', '/api/sheet/summary']);
  assert.strictEqual(legacyUpgrade.calls[1].options.method, 'POST');
  assert.strictEqual(legacyUpgrade.result.user.sub, 'A');

  const signedOut = await runInit({
    localSeed: {
      kesefle_user: JSON.stringify({ sub: 'A', email: 'a@example.com', name: 'משתמש א' }),
      kesefle_sheet: JSON.stringify({ spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/A/edit' }),
    },
    fetchResult: response(401, { ok: false, error: 'unauthorized' }),
  });
  assert.deepStrictEqual(signedOut.calls.map((call) => call.url), ['/api/me']);
  assert.strictEqual(signedOut.result, null);
  assert.strictEqual(signedOut.local.getItem('kesefle_user'), null);
  assert.strictEqual(signedOut.local.getItem('kesefle_sheet'), null);
  assert.strictEqual(signedOut.elements['user-name'].textContent, 'טוען...');
  assert.strictEqual(signedOut.elements['kfl-session-signin'].classList.contains('hidden'), false);
  assert.strictEqual(signedOut.bodyClasses.contains('kfl-session-pending'), true);

  const signedOutPush = await runInit({
    localSeed: {},
    fetchResult: response(401, { ok: false, error: 'unauthorized' }),
    pushSubscription: true,
  });
  assert.deepStrictEqual(signedOutPush.calls.map((call) => call.url), ['/api/me']);
  assert.ok(signedOutPush.pushEvents.includes('unsubscribe:end:true'),
    '401 detaches an account-bound browser subscription even without local identity');

  const signedOutPushRefused = await runInit({
    localSeed: {},
    fetchResult: response(401, { ok: false, error: 'unauthorized' }),
    pushSubscription: true,
    pushUnsubscribeResult: false,
  });
  assert.strictEqual(signedOutPushRefused.result, null);
  assert.strictEqual(signedOutPushRefused.local.getItem('kfl_push_isolation_pending'), '1');
  assert.strictEqual(signedOutPushRefused.elements['kfl-session-retry'].classList.contains('hidden'), false,
    '401 plus live old Push stays in recovery instead of offering a new sign-in');
  assert.strictEqual(signedOutPushRefused.elements['kfl-session-signin'].classList.contains('hidden'), true);

  const cleanStorageOldPush = await runInit({
    localSeed: {},
    fetchResult: response(200, payloadB),
    pushSubscription: true,
  });
  assert.ok(cleanStorageOldPush.pushEvents.includes('unsubscribe:end:true'));
  assert.deepStrictEqual(cleanStorageOldPush.calls.map((call) => call.url),
    ['/api/me', '/api/me', '/api/sheet/summary']);
  assert.strictEqual(cleanStorageOldPush.result.user.sub, 'B');

  const refusedPushDetach = await runInit({
    localSeed: {},
    fetchResult: response(200, payloadB),
    pushSubscription: true,
    pushUnsubscribeResult: false,
  });
  assert.deepStrictEqual(refusedPushDetach.calls.map((call) => call.url), ['/api/me']);
  assert.strictEqual(refusedPushDetach.result, null);
  assert.strictEqual(refusedPushDetach.local.getItem('kfl_push_isolation_pending'), '1');
  assert.strictEqual(refusedPushDetach.elements['user-name'].textContent, 'טוען...');
  assert.strictEqual(refusedPushDetach.bodyClasses.contains('kfl-session-pending'), true);

  let raceMeCalls = 0;
  const cookieRace = await runInit({
    localSeed: { kesefle_user: JSON.stringify({ sub: 'A', name: 'משתמש א' }) },
    pushSubscription: true,
    fetchHandler: async (url) => {
      if (url !== '/api/me') throw new Error('unexpected fetch ' + url);
      raceMeCalls += 1;
      const user = raceMeCalls === 1
        ? payloadB.user
        : { sub: 'C', email: 'c@example.com', name: 'משתמש ג' };
      return response(200, {
        ok: true,
        user,
        sheet: { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + user.sub + '/edit' },
      });
    },
  });
  assert.strictEqual(cookieRace.result.user.sub, 'C');
  assert.strictEqual(cookieRace.elements['user-name'].textContent, 'משתמש ג');
  assert.notStrictEqual(cookieRace.elements['user-name'].textContent, 'משתמש ב');
  assert.deepStrictEqual(cookieRace.calls.map((call) => call.url),
    ['/api/me', '/api/me', '/api/me', '/api/sheet/summary'],
    'cookie changes during Push cleanup are stabilized before private paint');

  const unavailable = await runInit({
    localSeed: {
      kesefle_user: JSON.stringify({ sub: 'A', email: 'a@example.com', name: 'משתמש א' }),
      kesefle_sheet: JSON.stringify({ spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/A/edit' }),
    },
    fetchResult: response(503, { ok: false, error: 'temporarily_unavailable' }),
  });
  assert.deepStrictEqual(unavailable.calls.map((call) => call.url), ['/api/me']);
  assert.strictEqual(unavailable.result, null);
  assert.strictEqual(unavailable.elements['user-name'].textContent, 'טוען...');
  assert.strictEqual(unavailable.elements['kfl-session-retry'].classList.contains('hidden'), false);
  assert.strictEqual(unavailable.bodyClasses.contains('kfl-session-pending'), true);
  assert.strictEqual(JSON.parse(unavailable.local.getItem('kesefle_user')).sub, 'A',
    'temporary outages do not destroy presentation metadata, but never display it');

  const offline = await runInit({
    localSeed: { kesefle_user: JSON.stringify({ sub: 'A', name: 'משתמש א' }) },
    fetchResult: null,
    fetchError: new Error('offline'),
  });
  assert.deepStrictEqual(offline.calls.map((call) => call.url), ['/api/me']);
  assert.strictEqual(offline.elements['user-name'].textContent, 'טוען...');
  assert.strictEqual(offline.bodyClasses.contains('kfl-session-pending'), true);

  const onboarding = await runInit({
    localSeed: {},
    fetchResult: response(200, { ok: true, user: payloadB.user, sheet: null }),
  });
  assert.strictEqual(onboarding.location.href, '/account');
  assert.deepStrictEqual(onboarding.calls.map((call) => call.url), ['/api/me', '/api/me']);
  assert.strictEqual(onboarding.bodyClasses.contains('kfl-session-pending'), true);

  let resolveLateUpgrade;
  const lateUpgradePromise = new Promise((resolve) => { resolveLateUpgrade = resolve; });
  const lateLegacyUpgrade = await runInit({
    localSeed: { kesefle_user: JSON.stringify({ sub: 'A', name: 'משתמש א' }) },
    legacyCredential: 'legacy-token-for-A',
    shortInitTimeouts: true,
    fetchHandler: async (url) => {
      if (url === '/api/me') return response(401, { ok: false, error: 'unauthorized' });
      if (url === '/api/auth/google') return lateUpgradePromise;
      throw new Error('unexpected fetch ' + url);
    },
  });
  assert.deepStrictEqual(lateLegacyUpgrade.calls.map((call) => call.url), ['/api/me', '/api/auth/google']);
  assert.strictEqual(lateLegacyUpgrade.result, null);
  assert.strictEqual(lateLegacyUpgrade.elements['kfl-session-retry'].classList.contains('hidden'), false);
  assert.strictEqual(lateLegacyUpgrade.elements['kfl-session-signin'].classList.contains('hidden'), true,
    'an indeterminate legacy mutation never opens a second sign-in race');
  resolveLateUpgrade(response(200, { ok: true }));
  await Promise.resolve();
  assert.strictEqual(lateLegacyUpgrade.bodyClasses.contains('kfl-session-pending'), true,
    'a late upgrade response cannot reveal stale private UI');

  const hangingFetch = await probeWithShortDeadline(() => new Promise(() => {}));
  assert.strictEqual(hangingFetch.state, 'unavailable', 'a stalled /api/me request reaches retry state');
  const hangingJsonExplicit = await probeWithShortDeadline(() => ({
    status: 200,
    ok: true,
    json() { return new Promise(() => {}); },
  }));
  assert.strictEqual(hangingJsonExplicit.state, 'unavailable', 'stalled /api/me JSON reaches retry state');

  console.log('Dashboard session authority: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
