#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/paypal-return.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'upgrade.html'), 'utf8');
const PAYPAL_API = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (error) {
    console.error('  ❌ ' + name);
    throw error;
  }
}

function element(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    style: {},
    children: [],
    attributes: {},
    listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    remove() { this.removed = true; },
  };
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json() { return Promise.resolve(data); },
  };
}

function makeBrowser(search, replies) {
  const ids = [
    'confetti', 'state-pending', 'state-success', 'state-cancel', 'state-icon',
    'upgrade-title', 'upgrade-sub', 'confirm-status', 'btn-confirm-retry',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element(id)]));
  elements['state-success'].hidden = true;
  elements['state-cancel'].hidden = true;
  elements['btn-confirm-retry'].hidden = true;
  const body = element('body');
  let calls = 0;
  const queue = replies.slice();
  const document = {
    title: "שדרוג — כספ'לה",
    body,
    getElementById(id) { return elements[id] || null; },
    createElement() { return element('piece'); },
  };
  const context = {
    document,
    location: { search },
    URLSearchParams,
    JSON,
    Math,
    AbortController,
    Promise,
    fetch(url, options) {
      calls++;
      context.lastRequest = { url, options };
      const next = queue.length ? queue.shift() : response(409, { ok: false, error: 'subscription_not_active' });
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    setTimeout(fn, ms) {
      // Retry delays resolve immediately in this deterministic browser model;
      // leave the cosmetic 5.5s confetti cleanup pending for assertions.
      if (ms < 5000) queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'js/paypal-return.js' });
  return { context, document, elements, body, calls: () => calls };
}

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
}

(async () => {
  console.log('\nPayPal return UI');

  await test('default HTML cannot claim success before JavaScript or server confirmation', async () => {
    assert.match(HTML, /id="state-success" hidden/);
    assert.match(HTML, /<h1 id="upgrade-title"[^>]*>בודקים את השדרוג<\/h1>/);
    assert.doesNotMatch(HTML, /<div id="state-success">/);
  });

  await test('ACTIVE confirmation is the only path that reveals success and confetti', async () => {
    const env = makeBrowser('?paypal=success&subscription_id=I-ACTIVE', [response(200, { ok: true, plan: 'pro' })]);
    await settle();
    assert.strictEqual(env.calls(), 1);
    assert.strictEqual(env.body.attributes['data-paypal-return-state'], 'success');
    assert.strictEqual(env.elements['state-success'].hidden, false);
    assert.strictEqual(env.elements['state-pending'].hidden, true);
    assert.strictEqual(env.elements['upgrade-title'].textContent, 'השדרוג הושלם!');
    assert.strictEqual(env.elements.confetti.children.length, 60);
    assert.strictEqual(env.context.lastRequest.options.credentials, 'include');
    assert.deepStrictEqual(JSON.parse(env.context.lastRequest.options.body), { subscriptionId: 'I-ACTIVE' });
  });

  await test('APPROVAL_PENDING retries safely, then succeeds after PayPal becomes ACTIVE', async () => {
    const env = makeBrowser('?paypal=success&subscription_id=I-LATE', [
      response(409, { ok: false, error: 'subscription_not_active', status: 'APPROVAL_PENDING' }),
      response(200, { ok: true, alreadyActive: true, plan: 'family' }),
    ]);
    await settle();
    assert.strictEqual(env.calls(), 2);
    assert.strictEqual(env.body.attributes['data-paypal-return-state'], 'success');
    assert.strictEqual(env.elements['state-success'].hidden, false);
  });

  await test('persistent pending/network failure never claims success and offers a retry', async () => {
    const env = makeBrowser('?paypal=success&subscription_id=I-PENDING', [
      response(409, { ok: false, error: 'subscription_not_active' }),
      new Error('offline'),
      response(502, { ok: false, error: 'paypal_unreachable' }),
    ]);
    await settle();
    assert.strictEqual(env.calls(), 3);
    assert.strictEqual(env.body.attributes['data-paypal-return-state'], 'error');
    assert.strictEqual(env.elements['state-success'].hidden, true);
    assert.strictEqual(env.elements.confetti.children.length, 0);
    assert.strictEqual(env.elements['btn-confirm-retry'].hidden, false);
    assert.match(env.elements['confirm-status'].textContent, /לא צריך לשלם שוב/);
  });

  await test('missing subscription id and direct visits stay neutral/fail-closed without requests', async () => {
    const missing = makeBrowser('?paypal=success', []);
    const direct = makeBrowser('', []);
    await settle();
    assert.strictEqual(missing.calls(), 0);
    assert.strictEqual(missing.body.attributes['data-paypal-return-state'], 'error');
    assert.strictEqual(missing.elements['state-success'].hidden, true);
    assert.strictEqual(direct.calls(), 0);
    assert.strictEqual(direct.body.attributes['data-paypal-return-state'], 'neutral');
  });

  await test('cancel is honest, makes no confirm request, and never renders success', async () => {
    const env = makeBrowser('?paypal=cancel&subscription_id=I-NOT-USED', []);
    await settle();
    assert.strictEqual(env.calls(), 0);
    assert.strictEqual(env.body.attributes['data-paypal-return-state'], 'cancel');
    assert.strictEqual(env.elements['state-cancel'].hidden, false);
    assert.strictEqual(env.elements['state-success'].hidden, true);
    assert.strictEqual(env.elements.confetti.children.length, 0);
  });

  await test('expired login stops automatic retry and points to account recovery', async () => {
    const env = makeBrowser('?paypal=success&subscription_id=I-AUTH', [response(401, { ok: false, error: 'unauthorized' })]);
    await settle();
    assert.strictEqual(env.calls(), 1);
    assert.strictEqual(env.body.attributes['data-paypal-return-state'], 'error');
    assert.strictEqual(env.elements['btn-confirm-retry'].hidden, true);
    assert.match(env.elements['confirm-status'].textContent, /ההתחברות לחשבון פגה/);
    assert.match(HTML, /href="\/account"/);
  });

  await test('refresh/back remains server-idempotent and cannot duplicate activation', async () => {
    assert.match(PAYPAL_API, /existing\?\.subscriptionId === subId/);
    assert.match(PAYPAL_API, /alreadyActive:\s*true/);
    const first = makeBrowser('?paypal=success&subscription_id=I-REPLAY', [response(200, { ok: true })]);
    const refresh = makeBrowser('?paypal=success&subscription_id=I-REPLAY', [response(200, { ok: true, alreadyActive: true })]);
    await settle();
    assert.strictEqual(first.calls(), 1);
    assert.strictEqual(refresh.calls(), 1);
    assert.strictEqual(refresh.body.attributes['data-paypal-return-state'], 'success');
  });

  console.log(`\n${passed} PayPal-return checks passed.`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
