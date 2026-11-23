#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api/push/subscribe.js'), 'utf8');

function extractFunction(source, name) {
  const plain = source.indexOf('function ' + name + '(');
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 && (plain < 0 || asyncStart < plain) ? asyncStart : plain;
  assert.ok(start >= 0, name + ' exists');
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

async function initFixture({ permission = 'default', current = true, subscription = null, subscribed = false, matchesDevice = false, supported = true }) {
  const states = [];
  const calls = [];
  let prompts = 0;
  const registration = { pushManager: { async getSubscription() { calls.push('getSubscription'); return subscription; } } };
  const notification = { permission, async requestPermission() { prompts++; return 'granted'; } };
  const context = {
    __appPushRun: 0,
    __appPushState: null,
    appPushCurrent: () => current,
    isIOS: () => false,
    isStandalone: () => true,
    appPushUi: (state) => states.push(state),
    appPushFetchJson: async (url) => {
      calls.push(url);
      return url === '/api/config'
        ? { vapid_public_key: 'key' }
        : { ok: true, subscribed, matchesDevice };
    },
    appPushWithDeadline: async (promise, _ms, fallback) => { try { return await promise; } catch (_e) { return fallback; } },
    appPushFingerprint: async (endpoint) => endpoint ? 'a'.repeat(64) : '',
    navigator: supported ? { serviceWorker: { ready: Promise.resolve(registration) } } : {},
    window: supported ? { PushManager: function PushManager() {}, Notification: notification } : {},
    Notification: notification,
    localStorage: { setItem() {} },
    Promise,
  };
  const code = [extractFunction(app, 'appPushInit'), 'globalThis.run = appPushInit;'].join('\n');
  vm.runInNewContext(code, context, { filename: 'app-push-init.js' });
  await context.run('user-1');
  return { states, calls, prompts, state: context.__appPushState };
}

async function enableFixture({ verifiedSub = 'user-1', ownership = { ok: true, subscribed: false, matchesDevice: false }, unsubscribeOk = true, newEndpoint = 'https://fcm.googleapis.com/fcm/send/new', postOk = true }) {
  const events = [];
  const ui = [];
  const oldEndpoint = 'https://fcm.googleapis.com/fcm/send/old';
  const oldSub = {
    endpoint: oldEndpoint,
    async unsubscribe() { events.push('old:unsubscribe'); return unsubscribeOk; },
  };
  const newSub = {
    endpoint: newEndpoint,
    toJSON() { return { endpoint: newEndpoint, keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } }; },
    async unsubscribe() { events.push('new:unsubscribe'); return true; },
  };
  const registration = { pushManager: {
    async getSubscription() { events.push('push:get'); return oldSub; },
    async subscribe() { events.push('push:subscribe'); return newSub; },
  } };
  const posts = [];
  const window = {};
  const context = {
    window,
    __appPushState: { expectedSub: 'user-1', run: 7, vapid: 'key', registration },
    appPushCurrent: () => true,
    appPushUi: (state, _sub, _run, message) => ui.push({ state, message }),
    appPushFetchJson: async (url) => url === '/api/me'
      ? { ok: true, user: { sub: verifiedSub } }
      : ownership,
    appPushWithDeadline: async (promise, _ms, fallback) => { try { return await promise; } catch (_e) { return fallback; } },
    appPushFingerprint: async () => 'a'.repeat(64),
    appPushVapidKey: () => new Uint8Array([1]),
    Notification: { permission: 'granted' },
    navigator: { userAgent: 'test', language: 'he' },
    Intl,
    Uint8Array,
    localStorage: { setItem() {} },
    $: () => ({ disabled: false, textContent: '' }),
    fetch: async (url, options = {}) => {
      if (options.method === 'POST' && url === '/api/push/subscribe') {
        posts.push(JSON.parse(options.body));
        return { ok: postOk, status: postOk ? 200 : 502 };
      }
      return { ok: true };
    },
  };
  const code = [extractFunction(app, 'appPushEnable'), 'globalThis.run = appPushEnable;'].join('\n');
  vm.runInNewContext(code, context, { filename: 'app-push-enable.js' });
  await context.run('user-1', 7);
  return { events, posts, ui };
}

async function logoutDuringEnableFixture() {
  const events = [];
  const posts = [];
  let resolveSubscribe;
  let markSubscribeStarted;
  const subscribeStarted = new Promise((resolve) => { markSubscribeStarted = resolve; });
  const newSub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/new',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'x'.repeat(88), auth: 'y'.repeat(22) } }; },
    async unsubscribe() { events.push('new:unsubscribe'); return true; },
  };
  const registration = { pushManager: {
    async getSubscription() { events.push('push:get'); return null; },
    subscribe() {
      events.push('push:subscribe');
      markSubscribeStarted();
      return new Promise((resolve) => { resolveSubscribe = resolve; });
    },
  } };
  const window = { __kflPushLogout: false, __kflPushEnableTask: null };
  const context = {
    window,
    __appPushRun: 7,
    __appPushState: { expectedSub: 'user-1', run: 7, vapid: 'key', registration },
    appPushCurrent: (_sub, run) => !window.__kflPushLogout && run === context.__appPushRun,
    appPushUi() {},
    appPushFetchJson: async (url) => url === '/api/me'
      ? { ok: true, user: { sub: 'user-1' } }
      : { ok: true, subscribed: false, matchesDevice: false },
    appPushWithDeadline: async (promise, _ms, fallback) => { try { return await promise; } catch (_e) { return fallback; } },
    appPushFingerprint: async () => 'a'.repeat(64),
    appPushVapidKey: () => new Uint8Array([1]),
    Notification: { permission: 'granted' },
    navigator: { userAgent: 'test', language: 'he' },
    Intl,
    Uint8Array,
    localStorage: { setItem() {} },
    $: () => ({ disabled: false, textContent: '' }),
    fetch: async (url, options = {}) => {
      if (url === '/api/push/subscribe' && options.method === 'POST') posts.push(options);
      return { ok: true };
    },
  };
  const code = [
    extractFunction(app, 'appPushEnable'),
    extractFunction(app, 'appPushActivate'),
    'globalThis.start = appPushActivate;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'app-push-logout-race.js' });
  context.start('user-1', 7);
  await subscribeStarted;
  window.__kflPushLogout = true;
  context.__appPushRun++;
  resolveSubscribe(newSub);
  await window.__kflPushEnableTask;
  return { events, posts };
}

(async () => {
  assert.match(app, /id="app-push-card"[\s\S]{0,900}aria-live="polite"/,
    'the account route has a persistent accessible Push settings card');
  assert.ok(app.indexOf('appPushStart(u.sub)') > app.indexOf('view.innerHTML=head'),
    'Push mounts only after the authenticated account DOM exists');
  assert.match(extractFunction(app, 'appPushEnable'), /Notification\.requestPermission\(\)/,
    'permission is requested only inside the explicit enable action');
  assert.doesNotMatch(extractFunction(app, 'appPushInit'), /requestPermission/,
    'render/reconcile never prompts for permission');
  assert.match(app, /כרגע ההתראות פעילות במכשיר אחד בכל פעם/,
    'the one-device storage contract is disclosed');
  assert.match(app, /ready:\[[^\n]*כרגע אפשר לחבר מכשיר אחד לכל חשבון/,
    'the one-device limitation is disclosed before the enable action');
  assert.match(app, /expectedUserSub:expectedSub/,
    'mutations are bound to the account that mounted the settings card');
  assert.match(extractFunction(app, 'appPushEnable'), /\/api\/me[\s\S]*verified\.user\.sub!==expectedSub[\s\S]*unsubscribe\(\)/,
    'the session is revalidated before destructive endpoint rotation');

  const ready = await initFixture({ permission: 'default' });
  assert.strictEqual(ready.prompts, 0);
  assert.strictEqual(ready.states.at(-1), 'ready');

  const denied = await initFixture({ permission: 'denied' });
  assert.strictEqual(denied.states.at(-1), 'denied');
  assert.deepStrictEqual(denied.calls, [], 'denied permission makes no subscription or network calls');

  const unsupported = await initFixture({ supported: false });
  assert.strictEqual(unsupported.states.at(-1), 'unsupported');
  assert.deepStrictEqual(unsupported.calls, []);

  const enabled = await initFixture({
    permission: 'granted',
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/current' },
    subscribed: true,
    matchesDevice: true,
  });
  assert.strictEqual(enabled.states.at(-1), 'enabled');

  const stale = await initFixture({
    permission: 'granted',
    subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old' },
    subscribed: true,
    matchesDevice: false,
  });
  assert.strictEqual(stale.states.at(-1), 'repair');

  const staleMount = await initFixture({ current: false });
  assert.deepStrictEqual(staleMount.calls, [], 'a stale/unmounted account makes no Push calls');

  const switchedCookie = await enableFixture({ verifiedSub: 'user-2' });
  assert.ok(!switchedCookie.events.includes('old:unsubscribe'));
  assert.strictEqual(switchedCookie.posts.length, 0,
    'a cookie switched by another tab cannot rotate or store a subscription');

  const unknownOwnership = await enableFixture({ ownership: null });
  assert.ok(!unknownOwnership.events.includes('old:unsubscribe'));
  assert.strictEqual(unknownOwnership.posts.length, 0,
    'unknown click-time ownership fails closed');

  const refusedDetach = await enableFixture({ unsubscribeOk: false });
  assert.ok(!refusedDetach.events.includes('push:subscribe'));

  const reused = await enableFixture({ newEndpoint: 'https://fcm.googleapis.com/fcm/send/old' });
  assert.ok(reused.events.includes('new:unsubscribe'));
  assert.strictEqual(reused.posts.length, 0,
    'provider endpoint reuse is rejected before server storage');

  const failedPost = await enableFixture({ postOk: false });
  assert.ok(failedPost.events.includes('new:unsubscribe'),
    'an explicitly rejected POST cleans up the newly-created browser subscription');

  const success = await enableFixture({});
  assert.strictEqual(success.posts.length, 1);
  assert.strictEqual(success.posts[0].expectedUserSub, 'user-1');
  assert.strictEqual(success.posts[0].deviceInfo.addedFrom, 'app-account');

  const logoutRace = await logoutDuringEnableFixture();
  assert.ok(logoutRace.events.includes('new:unsubscribe'),
    'logout cancellation removes a subscription that resolves after cleanup initially saw none');
  assert.strictEqual(logoutRace.posts.length, 0,
    'a cancelled enable cannot store a subscription for the account that is logging out');

  const logout = extractFunction(app, 'kflLogout');
  assert.ok(logout.indexOf('window.__kflPushLogout=true') < logout.indexOf('cancelPushBeforeLogout(logoutSub)'),
    'logout invalidates Push synchronously before its first enable wait');
  assert.ok(logout.indexOf('cancelPushBeforeLogout(logoutSub)') < logout.indexOf("fetch('/api/auth/logout'"),
    'bounded cancellation and endpoint cleanup finish before clearing the cookie');

  assert.match(api, /expectedUserSub[\s\S]*account_changed/,
    'the API rejects stale-account mutations');
  assert.match(api, /hasOwnProperty\.call\(j, 'result'\)/,
    'malformed KV HTTP-200 responses fail closed');
  assert.match(extractFunction(app, 'appPushDisable'), /\/api\/me[\s\S]*matchesDevice!==true[\s\S]*method:'DELETE'[\s\S]*expectedUserSub:expectedSub[\s\S]*unsubscribe\(\)/,
    'opt-out revalidates session and ownership before conditional server and browser removal');

  console.log('App Push opt-in: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
