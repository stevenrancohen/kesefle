#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const account = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');
const meApi = fs.readFileSync(path.join(ROOT, 'api/me.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  const asyncStart = source.indexOf('async function ' + name + '(');
  const actualStart = asyncStart >= 0 && (start < 0 || asyncStart < start) ? asyncStart : start;
  assert.ok(actualStart >= 0, name + ' exists');
  const bodyStart = source.indexOf('{', source.indexOf(')', actualStart));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(actualStart, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

function storage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
  };
}

async function probe(fetchImpl) {
  const code = [
    extractFunction(account, 'kesefleProbeAccountSession'),
    'globalThis.run = kesefleProbeAccountSession;',
  ].join('\n');
  const calls = [];
  const context = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
  };
  vm.runInNewContext(code, context, { filename: 'account-session-probe.js' });
  return { result: await context.run(), calls };
}

async function hydrate(payload, seed = {}) {
  const local = storage(seed.local);
  const session = storage(seed.session);
  let profile = seed.profile || null;
  const cleared = [];
  const context = {
    localStorage: local,
    sessionStorage: session,
    kesefleGetUser: () => profile,
    kesefleSetUser: (user) => { profile = { version: 2, ...user }; local.setItem('kesefle_user', JSON.stringify(profile)); },
    window: {
      navigator: {},
      KesefleSession: {
        clearIdentityStorage(target) {
          cleared.push(target === local ? 'local' : 'session');
          ['kesefle_user', 'kesefle_sheet', 'kesefle_whatsapp_linked', 'kesefle_whatsapp_phone'].forEach((key) => target.removeItem(key));
        },
      },
    },
  };
  const code = [
    extractFunction(account, 'kesefleWithDeadline'),
    extractFunction(account, 'kesefleDetachBrowserPush'),
    extractFunction(account, 'kesefleClearAccountPresentation'),
    extractFunction(account, 'keseflePushIsolationError'),
    extractFunction(account, 'keseflePrepareAccountSwitch'),
    extractFunction(account, 'kesefleHydrateVerifiedAccount'),
    'globalThis.run = kesefleHydrateVerifiedAccount;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'account-session-hydrate.js' });
  const result = await context.run(payload);
  return { result, local, session, cleared };
}

async function accountSwitchFixture({ previousSub, nextSub, unsubscribeResult = true, hangPush = false }) {
  const localSeed = {
    kesefle_sheet: '{"spreadsheetId":"old"}',
    kfl_push_subscribed: '1',
  };
  if (previousSub != null) localSeed.kesefle_user = JSON.stringify({ version: 2, sub: previousSub });
  const local = storage(localSeed);
  const session = storage({ kfl_push_subscribed: '1' });
  const events = [];
  let profile = previousSub == null ? null : { version: 2, sub: previousSub };
  const context = {
    setTimeout: hangPush ? ((callback) => { callback(); return 1; }) : setTimeout,
    clearTimeout,
    localStorage: local,
    sessionStorage: session,
    Promise,
    kesefleGetUser: () => profile,
    window: {
      navigator: {
        serviceWorker: {
          async getRegistration(scope) {
            events.push('registration:' + scope);
            if (hangPush) return new Promise(() => {});
            return {
              pushManager: {
                async getSubscription() {
                  return {
                    async unsubscribe() { events.push('unsubscribe'); return unsubscribeResult; },
                  };
                },
              },
            };
          },
        },
      },
      KesefleSession: {
        clearIdentityStorage(target) {
          events.push(target === local ? 'clear:local' : 'clear:session');
          ['kesefle_user', 'kesefle_sheet', 'kfl_push_subscribed'].forEach((key) => target.removeItem(key));
        },
      },
      caches: {
        async keys() { return ['kesefle-api-v1', 'kesefle-static-v1']; },
        async delete(key) { events.push('cache:' + key); return true; },
      },
    },
  };
  const code = [
    extractFunction(account, 'kesefleWithDeadline'),
    extractFunction(account, 'kesefleDetachBrowserPush'),
    extractFunction(account, 'kesefleClearAccountPresentation'),
    extractFunction(account, 'keseflePushIsolationError'),
    extractFunction(account, 'keseflePrepareAccountSwitch'),
    'globalThis.run = keseflePrepareAccountSwitch;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'account-switch.js' });
  let result;
  let error = null;
  try { result = await context.run({ sub: nextSub }); }
  catch (caught) { error = caught; }
  return { result, error, events, local, session };
}

async function stalledPhoneLinkFixture() {
  const local = storage();
  let aborted = false;
  const context = {
    localStorage: local,
    kesefleGetUser: () => ({ sub: 'user-1' }),
    document: { getElementById() { return null; } },
    fetch: () => new Promise(() => {}),
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    AbortController: function AbortController() {
      this.signal = {};
      this.abort = () => { aborted = true; };
    },
  };
  const code = [
    extractFunction(account, 'kesefleWithDeadline'),
    extractFunction(account, 'kesefleSyncVerifiedPhoneLink'),
    'globalThis.run = kesefleSyncVerifiedPhoneLink;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'account-phone-link-timeout.js' });
  const result = await context.run({ spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' }, 'user-1');
  return { result, aborted, local };
}

async function latePhoneLinkFixture({ logoutBeforeResolve = false } = {}) {
  const local = storage();
  let profile = { sub: 'user-1' };
  let resolveFetch;
  let timeoutCallback;
  const context = {
    localStorage: local,
    kesefleGetUser: () => profile,
    document: { getElementById() { return null; } },
    fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    setTimeout(callback) { timeoutCallback = callback; return 1; },
    clearTimeout() {},
    AbortController: function AbortController() {
      this.signal = {};
      this.abort = () => {};
    },
  };
  const code = [
    extractFunction(account, 'kesefleWithDeadline'),
    extractFunction(account, 'kesefleSyncVerifiedPhoneLink'),
    'globalThis.run = kesefleSyncVerifiedPhoneLink;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'account-phone-link-late-response.js' });
  const pending = context.run(
    { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' },
    'user-1',
  );
  await Promise.resolve();
  if (logoutBeforeResolve) profile = null;
  else timeoutCallback();
  if (!logoutBeforeResolve) await pending;
  resolveFetch({
    ok: true,
    async json() { return { ok: true, linked: true, phone: '972500000000' }; },
  });
  const result = logoutBeforeResolve ? await pending : false;
  await new Promise((resolve) => setImmediate(resolve));
  return { result, local };
}

async function meApiFixture({ userId = 'user-1', token, user, failKey = '', malformedKey = '' }) {
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    'const getUserId = (req) => req.userId;',
    extractFunction(meApi, 'kvGet'),
    extractFunction(meApi, 'handlerImpl'),
    'globalThis.run = handlerImpl;',
  ].join('\n');
  const context = {
    fetch: async (url) => {
      const value = String(url).includes('/token%3A') ? token : user;
      return {
        ok: !failKey || !String(url).includes(failKey),
        async json() {
          if (malformedKey && String(url).includes(malformedKey)) return {};
          return { result: value == null ? null : JSON.stringify(value) };
        },
      };
    },
  };
  vm.runInNewContext(code, context, { filename: 'api-me-authority.js' });
  const state = { status: 0, body: null, headers: {} };
  const res = {
    setHeader(name, value) { state.headers[name] = value; },
    status(codeValue) { state.status = codeValue; return this; },
    json(body) { state.body = body; return body; },
  };
  await context.run({ method: 'GET', userId }, res);
  return state;
}

(async () => {
  assert.match(account, /id="account-logout"[^>]*class="[^"]*hidden/,
    'logout chrome is private until the server verifies a session');
  assert.match(account, /id="onboarding"[^>]*class="[^"]*hidden/,
    'provisioning controls are hidden on the static first paint');
  assert.match(account, /id="account-summary"[^>]*class="[^"]*hidden/,
    'account status and financial summary are hidden before session authority');
  assert.match(account, /id="account-auth-pending"[^>]*role="status"[\s\S]{0,500}פרטי החשבון ופעולות השמירה יוצגו רק לאחר אימות מאובטח/,
    'first paint explains the private session check without claiming identity');
  assert.match(account, /id="step-1"[\s\S]{0,260}>1<[\s\S]{0,260}id="step-1-title"[^>]*>התחבר עם Google/,
    'the static step does not falsely claim Google is already connected');

  const unauthenticated = await probe(async () => ({ status: 401, ok: false }));
  assert.strictEqual(unauthenticated.result.state, 'signed_out');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(unauthenticated.calls[0])), {
    url: '/api/me',
    options: { credentials: 'include', cache: 'no-store' },
  }, 'session truth is fetched without cache using the HttpOnly cookie');

  const forbidden = await probe(async () => ({ status: 403, ok: false }));
  assert.strictEqual(forbidden.result.state, 'signed_out');

  const unavailable = await probe(async () => ({ status: 503, ok: false }));
  assert.strictEqual(unavailable.result.state, 'unavailable');

  const offline = await probe(async () => { throw new Error('offline'); });
  assert.strictEqual(offline.result.state, 'unavailable');

  const malformed = await probe(async () => ({ status: 200, ok: true, async json() { return {}; } }));
  assert.strictEqual(malformed.result.state, 'unavailable');

  const kvOutage = await meApiFixture({ token: { sheetId: 'sheet-1' }, failKey: '/token%3A' });
  assert.strictEqual(kvOutage.status, 503);
  assert.strictEqual(kvOutage.body.error, 'profile_unavailable',
    'KV failure is not misreported as a real account without a sheet');
  assert.strictEqual(kvOutage.headers['Cache-Control'], 'no-store, max-age=0');

  const realNoSheet = await meApiFixture({ token: null });
  assert.strictEqual(realNoSheet.status, 200);
  assert.strictEqual(realNoSheet.body.user.sub, 'user-1');
  assert.strictEqual(realNoSheet.body.sheet, null,
    'a valid session with no account record remains a supported onboarding state');

  const apiSheet = await meApiFixture({
    token: { email: 'user@example.com', sheetId: 'sheet-1' },
    user: { name: 'User' },
  });
  assert.strictEqual(apiSheet.status, 200);
  assert.strictEqual(apiSheet.body.sheet.spreadsheetId, 'sheet-1');

  const userOnly = await meApiFixture({
    token: null,
    user: { email: 'legacy@example.com', spreadsheetId: 'legacy-sheet' },
  });
  assert.strictEqual(userOnly.status, 200);
  assert.strictEqual(userOnly.body.sheet.spreadsheetId, 'legacy-sheet',
    'a canonical user-only legacy record keeps its existing sheet');

  const userFallbackOutage = await meApiFixture({
    token: { email: 'user@example.com', sheetId: 'sheet-1' },
    user: { name: 'User' },
    failKey: '/user%3A',
  });
  assert.strictEqual(userFallbackOutage.status, 503,
    'partial profile reads fail closed instead of returning ambiguous identity');

  const malformedKv = await meApiFixture({ token: null, user: null, malformedKey: '/token%3A' });
  assert.strictEqual(malformedKv.status, 503,
    'HTTP 200 without an explicit result field is not treated as a missing record');

  const freshOnboarding = await probe(async () => ({
    status: 200,
    ok: true,
    async json() { return { ok: true, user: { sub: 'fresh-user' }, sheet: null }; },
  }));
  assert.strictEqual(freshOnboarding.result.state, 'authenticated');
  assert.strictEqual(freshOnboarding.result.payload.user.sub, 'fresh-user',
    'a valid clean-device session is accepted even before sheet creation');

  const sheet = { spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' };
  const withSheet = await probe(async () => ({
    status: 200,
    ok: true,
    async json() { return { ok: true, user: { sub: 'returning-user' }, sheet }; },
  }));
  assert.strictEqual(withSheet.result.payload.sheet.spreadsheetId, 'sheet-1');

  const stale = await hydrate({ ok: true, user: { sub: 'new-user', name: 'New' }, sheet: null }, {
    profile: { version: 2, sub: 'old-user' },
    local: {
      kesefle_user: JSON.stringify({ version: 2, sub: 'old-user' }),
      kesefle_sheet: JSON.stringify(sheet),
      kesefle_whatsapp_linked: '1',
      kesefle_whatsapp_phone: '972500000000',
    },
  });
  assert.deepStrictEqual(stale.cleared, ['local', 'session'],
    'an account switch clears account-bound presentation from both stores');
  assert.strictEqual(stale.result.sub, 'new-user');
  assert.strictEqual(stale.local.getItem('kesefle_sheet'), null,
    'authoritative absence of a sheet removes the previous account sheet');
  assert.strictEqual(stale.local.getItem('kesefle_whatsapp_linked'), null,
    'phone-link state is rebuilt from the authenticated endpoint');

  const hydratedSheet = await hydrate({ ok: true, user: { sub: 'same-user' }, sheet }, {
    profile: { version: 2, sub: 'same-user' },
  });
  assert.strictEqual(JSON.parse(hydratedSheet.local.getItem('kesefle_sheet')).spreadsheetId, 'sheet-1');

  const switched = await accountSwitchFixture({ previousSub: 'old-user', nextSub: 'new-user' });
  assert.strictEqual(switched.result, true);
  assert.deepStrictEqual(switched.events, [
    'registration:/',
    'unsubscribe',
    'clear:local',
    'clear:session',
    'cache:kesefle-api-v1',
  ], 'OAuth account switch invalidates old Push before clearing account-bound browser data');
  assert.strictEqual(switched.local.getItem('kfl_push_subscribed'), null);

  const sameUser = await accountSwitchFixture({ previousSub: 'same-user', nextSub: 'same-user' });
  assert.strictEqual(sameUser.result, false);
  assert.deepStrictEqual(sameUser.events, [],
    'same-user reauthentication preserves Push and presentation state');

  const detachFailure = await accountSwitchFixture({
    previousSub: 'old-user',
    nextSub: 'new-user',
    unsubscribeResult: false,
  });
  assert.strictEqual(detachFailure.error && detachFailure.error.code, 'push_detach_failed');
  assert.match(String(detachFailure.error && detachFailure.error.message), /החשבון הקודם/);
  assert.ok(detachFailure.events.includes('clear:local'));
  assert.strictEqual(detachFailure.local.getItem('kesefle_user'), null,
    'failed Push invalidation still removes the old account PII after the cookie switched');
  assert.strictEqual(detachFailure.local.getItem('kfl_push_isolation_pending'), '1',
    'failed invalidation leaves only a non-identifying retry marker');

  const unknownOwner = await accountSwitchFixture({ previousSub: null, nextSub: 'new-user' });
  assert.strictEqual(unknownOwner.result, true);
  assert.ok(unknownOwner.events.includes('unsubscribe'),
    'an existing Push subscription is revoked when Web Storage has no owner profile');

  const stalledPush = await accountSwitchFixture({
    previousSub: 'old-user',
    nextSub: 'new-user',
    hangPush: true,
  });
  assert.strictEqual(stalledPush.error && stalledPush.error.code, 'push_detach_failed');
  assert.strictEqual(stalledPush.local.getItem('kesefle_user'), null);
  assert.strictEqual(stalledPush.local.getItem('kfl_push_isolation_pending'), '1',
    'a stalled browser Push API reaches the safe retry path instead of blocking forever');

  const stalledPhoneLink = await stalledPhoneLinkFixture();
  assert.strictEqual(stalledPhoneLink.result, false);
  assert.strictEqual(stalledPhoneLink.aborted, true,
    'a stalled optional phone-link probe is bounded and cancelled');

  const lateAfterTimeout = await latePhoneLinkFixture();
  assert.strictEqual(lateAfterTimeout.local.getItem('kesefle_whatsapp_linked'), null);
  assert.strictEqual(lateAfterTimeout.local.getItem('kesefle_whatsapp_phone'), null,
    'a response that resolves after its deadline cannot restore old phone PII');

  const resolvedAfterLogout = await latePhoneLinkFixture({ logoutBeforeResolve: true });
  assert.strictEqual(resolvedAfterLogout.result, false);
  assert.strictEqual(resolvedAfterLogout.local.getItem('kesefle_whatsapp_phone'), null,
    'an in-flight response is rejected when its account has logged out');

  assert.match(account, /session\.state === 'signed_out'[\s\S]{0,240}kesefleDetachBrowserPush\(\)[\s\S]{0,160}kesefleClearAccountPresentation\(\)[\s\S]{0,420}kesefleShowSigninPrompt\(\)/,
    '401/403 detaches unknown Push and clears stale presentation before rendering signed-out UI');
  assert.match(account, /session\.state !== 'authenticated'[\s\S]{0,180}kesefleShowSessionUnavailable\(\)[\s\S]{0,80}return/,
    'network, 5xx and malformed state never fall back to local identity');
  assert.ok(account.indexOf('kesefleRevealAuthenticatedAccount(u)') > account.indexOf("session.state !== 'authenticated'"),
    'protected account chrome is revealed only after session authority succeeds');
  assert.ok(account.indexOf('kesefleRevealAuthenticatedAccount(u)') < account.indexOf('kesefleSyncVerifiedPhoneLink(meJson.sheet, u.sub)'),
    'authenticated account chrome becomes usable before the optional phone-link probe');
  assert.doesNotMatch(account, /function checkExistingLink\(/,
    'the unbounded pre-auth phone probe and cached-phone fallback are removed');
  assert.doesNotMatch(account, /if \(waLinked[\s\S]{0,300}window\.location\.href = '\/app'/,
    'a late optional phone response cannot navigate away after interaction begins');
  assert.doesNotMatch(account, /catch \(_meErr\) \{ \/\* network blip -> fall through to normal flow \*\//,
    'the old network-failure fallthrough to localStorage auth is gone');
  assert.ok(account.indexOf('await keseflePrepareAccountSwitch(nextProfile)') < account.indexOf('kesefleSetUser(nextProfile)'),
    'OAuth return detaches the old account before persisting the new profile');
  assert.match(account, /session\.state === 'signed_out'[\s\S]{0,240}kesefleDetachBrowserPush\(\)[\s\S]{0,160}kesefleClearAccountPresentation\(\)/,
    '401/403 revokes unknown browser Push before offering a new sign-in');

  console.log('Account session authority: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
