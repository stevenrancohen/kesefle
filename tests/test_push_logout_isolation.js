#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

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

async function browserDetachFixture({ fetchOk, unsubscribeOk, removed = fetchOk }) {
  const events = [];
  const local = storage({
    kesefle_user: JSON.stringify({ version: 2, sub: 'user-1' }),
    kfl_push_subscribed: '1',
  });
  const session = storage({ kfl_push_subscribed: '1' });
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-token',
    async unsubscribe() { events.push('browser:unsubscribe'); return unsubscribeOk; },
  };
  const window = {
    localStorage: local,
    sessionStorage: session,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    navigator: {
      serviceWorker: {
        async getRegistration(scope) {
          events.push('browser:registration:' + scope);
          return { pushManager: { async getSubscription() { events.push('browser:subscription'); return subscription; } } };
        },
      },
    },
    AbortController,
    setTimeout,
    clearTimeout,
    async fetch(url, options) {
      events.push('server:delete');
      return { ok: fetchOk, url, options, async json() { return { ok: fetchOk, removed }; } };
    },
  };
  const context = { window, AbortController, setTimeout, clearTimeout, Promise };
  vm.runInNewContext(read('lib/browser-session.js'), context, { filename: 'browser-session.js' });
  const result = await window.KesefleSession.detachPushBeforeLogout();
  return { result, events, local, session };
}

function responseRecorder() {
  const state = { status: 0, body: null };
  return {
    state,
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return body; },
  };
}

async function apiDeleteFixture({ requestedEndpoint, storedEndpoint, evalOk = true, replaceBeforeEval = '' }) {
  const source = read('api/push/subscribe.js');
  const calls = [];
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    'const MAX_ENDPOINT_LEN = 600;',
    'const log = { info() {} };',
    extractFunction(source, 'subscriptionKey'),
    extractFunction(source, 'kvEval'),
    extractFunction(source, 'deleteSubscriptionAtomic'),
    extractFunction(source, 'handleDelete'),
    'globalThis.handleDelete = handleDelete;',
  ].join('\n');
  const context = {
    fetch: async (url, options) => {
      const command = JSON.parse(options.body);
      calls.push({ url: String(url), command });
      if (!evalOk) return { ok: false };
      const requested = command[command.length - 1];
      const effectiveEndpoint = replaceBeforeEval || storedEndpoint;
      let result = 'missing';
      if (effectiveEndpoint) {
        result = requested && requested !== effectiveEndpoint ? 'different_device' : 'removed';
      }
      return { ok: true, async json() { return { result }; } };
    },
  };
  vm.runInNewContext(code, context, { filename: 'push-subscribe-delete.js' });
  const res = responseRecorder();
  await context.handleDelete({ body: requestedEndpoint == null ? {} : { endpoint: requestedEndpoint }, reqId: 'test' }, res, 'user-1');
  return { ...res.state, calls };
}

async function apiGetFixture({ storedEndpoint, suppliedFingerprint, kvOk = true }) {
  const source = read('api/push/subscribe.js');
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    'const createHash = globalThis.createHashImpl;',
    "function isTrustedPushEndpoint(value){ return typeof value === 'string' && value.startsWith('https://fcm.googleapis.com/'); }",
    extractFunction(source, 'subscriptionKey'),
    extractFunction(source, 'kvGet'),
    extractFunction(source, 'handleGet'),
    'globalThis.handleGet = handleGet;',
  ].join('\n');
  const context = {
    createHashImpl: crypto.createHash,
    fetch: async () => ({
      ok: kvOk,
      async json() {
        return {
          result: storedEndpoint ? JSON.stringify({ subscription: { endpoint: storedEndpoint } }) : null,
        };
      },
    }),
  };
  vm.runInNewContext(code, context, { filename: 'push-subscribe-get.js' });
  const res = responseRecorder();
  await context.handleGet({ headers: suppliedFingerprint ? { 'x-push-endpoint-fingerprint': suppliedFingerprint } : {} }, res, 'user-1');
  return res.state;
}

async function dashboardEnableFixture({ oldUnsubscribe, newEndpoint, probeOk = true, matchesDevice = false }) {
  const source = read('dashboard.html');
  const events = [];
  const fetches = [];
  const statuses = [];
  const endpointA = 'https://fcm.googleapis.com/fcm/send/device-a';
  const oldSubscription = {
    endpoint: endpointA,
    async unsubscribe() { events.push('old:unsubscribe'); return oldUnsubscribe; },
  };
  const newSubscription = {
    endpoint: newEndpoint,
    toJSON() { return { endpoint: newEndpoint, keys: { p256dh: 'x', auth: 'y' } }; },
    async unsubscribe() { events.push('new:unsubscribe'); return true; },
  };
  const button = { disabled: false, textContent: '' };
  const card = { dataset: { vapid: 'test-key' } };
  const registration = {
    pushManager: {
      async getSubscription() { events.push('push:get'); return oldSubscription; },
      async subscribe() { events.push('push:subscribe'); return newSubscription; },
    },
  };
  const code = [
    'function getCard(){ return globalThis.card; }',
    'function getBtn(){ return globalThis.button; }',
    'function setStatus(message, isError){ globalThis.statuses.push({ message, isError }); }',
    'function urlBase64ToUint8(){ return new Uint8Array([1]); }',
    "async function fingerprintPushEndpoint(){ return 'a'.repeat(64); }",
    'function hideCardForever(){}',
    extractFunction(source, 'onEnableClick'),
    'globalThis.run = onEnableClick;',
  ].join('\n');
  const context = {
    card,
    button,
    statuses,
    Uint8Array,
    Notification: { permission: 'granted' },
    navigator: {
      serviceWorker: { ready: Promise.resolve(registration) },
      userAgent: 'test-agent',
      language: 'he',
    },
    Intl,
    setTimeout() { return 1; },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      if (!options || options.method !== 'POST') {
        return { ok: probeOk, status: probeOk ? 200 : 503, async json() { return { ok: true, subscribed: matchesDevice, matchesDevice }; } };
      }
      return { ok: true, status: 200 };
    },
  };
  vm.runInNewContext(code, context, { filename: 'dashboard-push-enable.js' });
  await context.run();
  return { events, fetches, statuses, button };
}

async function dashboardShowFixture({ permission, dismissed, localEndpoint, subscribed, matchesDevice, statusOk = true }) {
  const source = read('dashboard.html');
  const calls = [];
  const classEvents = [];
  const local = storage(dismissed ? { kfl_push_dismissed: String(Date.now()) } : {});
  const card = {
    dataset: {},
    classList: {
      add(name) { classEvents.push('add:' + name); },
      remove(name) { classEvents.push('remove:' + name); },
    },
  };
  const elements = {
    'kfl-push-card': card,
    'kfl-push-title': { textContent: '' },
    'kfl-push-copy': { textContent: '' },
    'kfl-push-enable': { textContent: '' },
  };
  const localSubscription = localEndpoint ? { endpoint: localEndpoint } : null;
  const code = [
    "const CARD_DISMISSED = 'kfl_push_dismissed';",
    "const SUBSCRIBED_FLAG = 'kfl_push_subscribed';",
    'function getCard(){ return document.getElementById(\'kfl-push-card\'); }',
    'function getBtn(){ return document.getElementById(\'kfl-push-enable\'); }',
    'function hideCardForever(){ localStorage.setItem(SUBSCRIBED_FLAG, \'1\'); getCard().classList.add(\'hidden\'); }',
    "async function fingerprintPushEndpoint(endpoint){ return endpoint ? 'a'.repeat(64) : ''; }",
    extractFunction(source, 'maybeShowCard'),
    'globalThis.run = maybeShowCard;',
  ].join('\n');
  const notification = { permission };
  const context = {
    window: { PushManager: function PushManager() {}, Notification: notification },
    Notification: notification,
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({ pushManager: { async getSubscription() { return localSubscription; } } }),
      },
    },
    localStorage: local,
    document: { getElementById(id) { return elements[id] || null; } },
    Date,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/config') return { ok: true, async json() { return { vapid_public_key: 'key' }; } };
      return { ok: statusOk, async json() { return { ok: true, subscribed, matchesDevice }; } };
    },
  };
  vm.runInNewContext(code, context, { filename: 'dashboard-push-show.js' });
  await context.run();
  return { calls, classEvents, card, local };
}

(async () => {
  const detached = await browserDetachFixture({ fetchOk: true, unsubscribeOk: true });
  assert.strictEqual(detached.result.serverRemoved, true);
  assert.strictEqual(detached.result.browserUnsubscribed, true);
  assert.strictEqual(detached.local.getItem('kfl_push_subscribed'), null,
    'logout removes the account-bound local push flag');
  assert.strictEqual(detached.session.getItem('kfl_push_subscribed'), null,
    'logout removes the account-bound session push flag');
  assert.ok(detached.events.includes('server:delete') && detached.events.includes('browser:unsubscribe'),
    'logout requests server deletion and browser unsubscribe');

  const offline = await browserDetachFixture({ fetchOk: false, unsubscribeOk: true });
  assert.strictEqual(offline.result.serverRemoved, false);
  assert.strictEqual(offline.result.browserUnsubscribed, true,
    'browser unsubscribe still succeeds when server cleanup is unavailable');

  const preservedNewerDevice = await browserDetachFixture({ fetchOk: true, removed: false, unsubscribeOk: true });
  assert.strictEqual(preservedNewerDevice.result.serverRemoved, false,
    'HTTP 200 with removed:false is not reported as a successful server deletion');

  const endpointA = 'https://fcm.googleapis.com/fcm/send/device-a';
  const endpointB = 'https://fcm.googleapis.com/fcm/send/device-b';
  const endpointAFingerprint = crypto.createHash('sha256').update(endpointA).digest('hex');
  const matchingFingerprint = await apiGetFixture({ storedEndpoint: endpointA, suppliedFingerprint: endpointAFingerprint });
  assert.strictEqual(matchingFingerprint.status, 200);
  assert.strictEqual(matchingFingerprint.body.matchesDevice, true,
    'the API recognizes only the exact current browser fingerprint');

  const mismatchedFingerprint = await apiGetFixture({ storedEndpoint: endpointA, suppliedFingerprint: 'b'.repeat(64) });
  assert.strictEqual(mismatchedFingerprint.body.matchesDevice, false);

  const failedRead = await apiGetFixture({ storedEndpoint: endpointA, suppliedFingerprint: endpointAFingerprint, kvOk: false });
  assert.strictEqual(failedRead.status, 502);
  assert.strictEqual(failedRead.body.error, 'kv_read_failed',
    'unknown KV state is not misreported as an absent subscription');

  const differentDevice = await apiDeleteFixture({ requestedEndpoint: endpointA, storedEndpoint: endpointB });
  assert.strictEqual(differentDevice.status, 200);
  assert.strictEqual(differentDevice.body.reason, 'different_device');
  assert.strictEqual(differentDevice.calls.length, 1);
  assert.strictEqual(differentDevice.calls[0].command[0], 'EVAL',
    'endpoint comparison and deletion execute as one Redis operation');

  const removed = await apiDeleteFixture({ requestedEndpoint: endpointA, storedEndpoint: endpointA });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(removed.body.removed, true,
    'the matching device endpoint is deleted');

  const racedReplacement = await apiDeleteFixture({
    requestedEndpoint: endpointA,
    storedEndpoint: endpointA,
    replaceBeforeEval: endpointB,
  });
  assert.strictEqual(racedReplacement.status, 200);
  assert.strictEqual(racedReplacement.body.reason, 'different_device',
    'an account switch racing logout preserves the newer device record');

  const failedDelete = await apiDeleteFixture({ requestedEndpoint: endpointA, storedEndpoint: endpointA, evalOk: false });
  assert.strictEqual(failedDelete.status, 502);
  assert.strictEqual(failedDelete.body.error, 'kv_delete_failed',
    'KV deletion failure is reported truthfully');

  const refusedRotation = await dashboardEnableFixture({ oldUnsubscribe: false, newEndpoint: endpointB });
  assert.ok(refusedRotation.events.includes('old:unsubscribe'));
  assert.ok(!refusedRotation.events.includes('push:subscribe'));
  assert.strictEqual(refusedRotation.fetches.filter((call) => call.options && call.options.method === 'POST').length, 0,
    'a browser that cannot detach the old endpoint never assigns it to the new account');

  const reusedEndpoint = await dashboardEnableFixture({ oldUnsubscribe: true, newEndpoint: endpointA });
  assert.ok(reusedEndpoint.events.includes('new:unsubscribe'));
  assert.strictEqual(reusedEndpoint.fetches.filter((call) => call.options && call.options.method === 'POST').length, 0,
    'a provider that reuses the old endpoint is rejected before server storage');

  const rotated = await dashboardEnableFixture({ oldUnsubscribe: true, newEndpoint: endpointB });
  assert.strictEqual(rotated.fetches.filter((call) => call.url === '/api/push/subscribe' && call.options.method === 'POST').length, 1,
    'a genuinely rotated endpoint is stored for the current account');

  const clickProbeFailure = await dashboardEnableFixture({
    oldUnsubscribe: true,
    newEndpoint: endpointB,
    probeOk: false,
  });
  assert.ok(!clickProbeFailure.events.includes('old:unsubscribe'));
  assert.ok(!clickProbeFailure.events.includes('push:subscribe'));
  assert.strictEqual(clickProbeFailure.fetches.filter((call) => call.options && call.options.method === 'POST').length, 0,
    'unknown ownership at click time fails closed without destructive rotation');

  const becameOwnedBeforeClick = await dashboardEnableFixture({
    oldUnsubscribe: true,
    newEndpoint: endpointB,
    matchesDevice: true,
  });
  assert.ok(!becameOwnedBeforeClick.events.includes('old:unsubscribe'));
  assert.strictEqual(becameOwnedBeforeClick.fetches.filter((call) => call.options && call.options.method === 'POST').length, 0,
    'an endpoint that became current-account-owned between render and click is reused safely');

  const repairedDespiteSnooze = await dashboardShowFixture({
    permission: 'granted',
    dismissed: true,
    localEndpoint: endpointA,
    subscribed: true,
    matchesDevice: false,
  });
  assert.ok(repairedDespiteSnooze.classEvents.includes('remove:hidden'),
    'a previous account snooze cannot hide a granted-permission isolation repair');
  const statusCall = repairedDespiteSnooze.calls.find((call) => call.url === '/api/push/subscribe');
  assert.strictEqual(statusCall.options.headers['X-Push-Endpoint-Fingerprint'].length, 64,
    'the dashboard compares a one-way endpoint fingerprint, not the secret endpoint');

  const matchingDevice = await dashboardShowFixture({
    permission: 'granted',
    dismissed: false,
    localEndpoint: endpointA,
    subscribed: true,
    matchesDevice: true,
  });
  assert.ok(matchingDevice.classEvents.includes('add:hidden'),
    'a verified current-account endpoint stays quietly enabled');

  const permissionCooldown = await dashboardShowFixture({
    permission: 'default',
    dismissed: true,
    localEndpoint: '',
    subscribed: false,
    matchesDevice: false,
  });
  assert.strictEqual(permissionCooldown.calls.length, 0,
    'dismissal still cools down the optional first permission prompt');

  const renderProbeFailure = await dashboardShowFixture({
    permission: 'granted',
    dismissed: false,
    localEndpoint: endpointA,
    subscribed: false,
    matchesDevice: false,
    statusOk: false,
  });
  assert.ok(!renderProbeFailure.classEvents.includes('remove:hidden'),
    'unknown ownership at render time never offers destructive repair');

  for (const file of ['app.html', 'dashboard.html', 'account.html', 'admin.html']) {
    const html = read(file);
    const detach = html.indexOf('detachPushBeforeLogout');
    const logout = html.indexOf('/api/auth/logout', detach);
    assert.ok(detach >= 0 && logout > detach,
      file + ' detaches Push before clearing the authenticated cookie');
  }

  const dashboard = read('dashboard.html');
  assert.match(dashboard, /Notification\.permission === ['"]denied['"]/,
    'denied permission remains fail-closed');
  assert.doesNotMatch(dashboard, /Notification\.permission !== ['"]default['"]/,
    'granted permission is no longer mistaken for current-account ownership');
  assert.match(dashboard, /getSubscription\(\)[\s\S]*fingerprintPushEndpoint\(sub\.endpoint\)[\s\S]*matchesDevice/,
    'dashboard reconciles click-time browser ownership with the server');
  assert.match(dashboard, /matchesDevice[\s\S]*unsubscribe\(\)[\s\S]*subscribe\(/,
    'a verified stale endpoint is rotated before the new account subscribes');
  assert.match(dashboard, /unsubscribed !== true[\s\S]*return;/,
    'failed browser detachment stops account reassignment');
  assert.match(dashboard, /previousEndpoint && sub\.endpoint === previousEndpoint[\s\S]*return;/,
    'provider endpoint reuse stops account reassignment');

  const api = read('api/push/subscribe.js');
  assert.match(api, /KESEFLE_DELETE_PUSH_SUB_V1[\s\S]*redis\.call\('GET'[\s\S]*different_device[\s\S]*redis\.call\('DEL'/,
    'conditional deletion is atomic inside one Redis script');
  assert.match(api, /createHash\('sha256'\)\.update\(storedEndpoint\)\.digest\('hex'\)/,
    'the API compares endpoint fingerprints without returning endpoint secrets');
  assert.match(api, /const limit = isRead \? 120 : 10/,
    'read probes allow normal dashboard reloads without weakening mutation limits');
  assert.match(api, /key: isRead \? ['"]push_subscribe_read['"] : ['"]push_subscribe['"]/,
    'read probes have a separate non-mutating rate-limit budget');
  assert.match(read('sw.js'), /v25-2026-11-24-push-logout/,
    'service-worker version rolls the updated logout helper to installed PWAs');

  console.log('Push logout isolation: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
