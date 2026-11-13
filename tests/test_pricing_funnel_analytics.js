#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');
const funnelSource = fs.readFileSync(path.join(ROOT, 'js/pricing-funnel.js'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(ROOT, 'lib/analytics.js'), 'utf8');
const pricingHtml = fs.readFileSync(path.join(ROOT, 'pricing.html'), 'utf8');
const accountHtml = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');
const eventsApi = fs.readFileSync(path.join(ROOT, 'api/events.js'), 'utf8');
const adminApi = fs.readFileSync(path.join(ROOT, 'api/admin.js'), 'utf8');
const exchangeApi = fs.readFileSync(path.join(ROOT, 'api/auth/google-exchange.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (error) {
    console.error('  ❌ ' + name);
    throw error;
  }
}

function makeStorage(seed) {
  const values = seed || new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function makeContext(options = {}) {
  const listeners = {};
  const storage = options.storage || makeStorage();
  const tracked = options.tracked || [];
  const location = new URL(options.url || 'https://kesefle.com/pricing');
  const document = {
    readyState: options.readyState || 'complete',
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
  };
  const context = {
    URLSearchParams,
    URL,
    Blob,
    Uint8Array,
    Math,
    Date,
    JSON,
    crypto: webcrypto,
    sessionStorage: storage,
    document,
    navigator: options.navigator || {},
    location: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  context.globalThis = context;
  if (options.fetch) context.fetch = options.fetch;
  if (!options.realAnalytics) {
    context.kfl = {
      track(event, meta) { tracked.push({ event, meta }); return true; },
      sessionId: 'test-session',
    };
  }
  vm.createContext(context);
  if (options.realAnalytics) vm.runInContext(analyticsSource, context, { filename: 'lib/analytics.js' });
  vm.runInContext(funnelSource, context, { filename: 'js/pricing-funnel.js' });
  return { context, listeners, storage, tracked };
}

console.log('\nPricing → signup analytics');

test('desktop and mobile trial CTAs carry the same explicit anonymous intent', () => {
  assert.match(pricingHtml, /class="[^"]*md:inline-block[^"]*"[^>]*>התחל חינם<\/a>|data-kfl-pricing-intent="trial"[^>]*class="[^"]*md:inline-block/);
  assert.match(pricingHtml, /data-kfl-pricing-intent="trial" data-kfl-plan="free" class="mt-3 block/);
  const trialLinks = pricingHtml.match(/href="\/account\?plan=free&amp;from=pricing-trial"[^>]*data-kfl-pricing-intent="trial"[^>]*data-kfl-plan="free"/g) || [];
  assert.ok(trialLinks.length >= 4, 'all desktop/mobile free-trial entry points must be tagged');
});

test('trial and PayPal selections emit distinct allowlisted events with categorical metadata only', () => {
  const trial = makeContext();
  assert.strictEqual(trial.context.kflPricingFunnel.select('trial', 'free', 'month'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(trial.tracked.at(-1))), {
    event: 'pricing_trial_selected',
    meta: { plan: 'free', source: 'pricing_trial', feature: 'month' },
  });

  const paypal = makeContext();
  assert.strictEqual(paypal.context.kflPricingFunnel.select('paypal', 'family', 'year'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(paypal.tracked.at(-1))), {
    event: 'pricing_paypal_selected',
    meta: { plan: 'family', source: 'pricing_paypal', feature: 'year' },
  });
  assert.ok(!/email|phone|advertis|gclid|fbclid/i.test(JSON.stringify(paypal.tracked)));
});

test('arrival is recorded once across refresh/back in the same tab', () => {
  const storage = makeStorage();
  const tracked = [];
  const pricing = makeContext({ storage, tracked });
  pricing.context.kflPricingFunnel.select('trial', 'free', 'month');

  makeContext({ storage, tracked, url: 'https://kesefle.com/account?plan=free&from=pricing-trial' });
  makeContext({ storage, tracked, url: 'https://kesefle.com/account?plan=free&from=pricing-trial' });
  assert.strictEqual(tracked.filter(e => e.event === 'pricing_trial_arrived').length, 1);
});

test('trial start is attributed only to trial intent, never to the PayPal path', () => {
  const trial = makeContext();
  trial.context.kflPricingFunnel.select('trial', 'free', 'month');
  trial.storage.setItem('kfl_pricing_trial_started_pending', '1');
  assert.strictEqual(trial.context.kflPricingFunnel.markTrialStarted(), true);
  assert.strictEqual(trial.tracked.filter(e => e.event === 'pricing_trial_started').length, 1);

  const paypal = makeContext();
  paypal.context.kflPricingFunnel.select('paypal', 'pro', 'month');
  paypal.storage.setItem('kfl_pricing_trial_started_pending', '1');
  assert.strictEqual(paypal.context.kflPricingFunnel.markTrialStarted(), false);
  assert.strictEqual(paypal.tracked.filter(e => e.event === 'pricing_trial_started').length, 0);
  assert.strictEqual(paypal.storage.getItem('kfl_pricing_trial_started_pending'), null);
});

test('DNT/GPC refusal creates no funnel state, session identifier, or request', () => {
  for (const navigator of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
    let requests = 0;
    const env = makeContext({
      navigator,
      realAnalytics: true,
      fetch() { requests++; return Promise.resolve({ ok: true }); },
    });
    assert.strictEqual(env.context.kfl._disabled, 'dnt');
    assert.strictEqual(env.context.kflPricingFunnel.select('trial', 'free', 'month'), false);
    assert.strictEqual(env.storage.getItem('kfl_session'), null);
    assert.strictEqual(env.storage.getItem('kfl_pricing_funnel_v1'), null);
    assert.strictEqual(requests, 0);
  }
});

test('transport failure is swallowed and never prevents CTA navigation', () => {
  const requests = [];
  const env = makeContext({
    realAnalytics: true,
    navigator: { sendBeacon() { return false; } },
    fetch(url, options) { requests.push({ url, options }); return Promise.reject(new Error('offline')); },
  });
  let prevented = 0;
  const el = {
    getAttribute(name) {
      return ({ 'data-kfl-pricing-intent': 'paypal', 'data-kfl-plan': 'pro' })[name] || null;
    },
  };
  const click = env.listeners.click[0];
  assert.doesNotThrow(() => click({ target: { closest() { return el; } }, preventDefault() { prevented++; } }));
  assert.strictEqual(prevented, 0);
  assert.ok(requests.some(r => JSON.parse(r.options.body).event === 'pricing_paypal_selected'));
  const payload = JSON.parse(requests.find(r => JSON.parse(r.options.body).event === 'pricing_paypal_selected').options.body);
  assert.deepStrictEqual(Object.keys(payload).sort(), ['event', 'meta', 'path', 'session']);
  assert.ok(!/email|phone|advertis|gclid|fbclid/i.test(JSON.stringify(payload)));
});

test('client, server and admin share the five-event allowlist', () => {
  const events = [
    'pricing_trial_selected', 'pricing_trial_arrived', 'pricing_trial_started',
    'pricing_paypal_selected', 'pricing_paypal_arrived',
  ];
  for (const event of events) {
    assert.ok(analyticsSource.includes(`'${event}'`), `client missing ${event}`);
    assert.ok(eventsApi.includes(`'${event}'`), `server missing ${event}`);
    assert.ok(adminApi.includes(`'${event}'`), `admin missing ${event}`);
  }
});

test('admin pricing funnel uses unique sessions, not refresh-inflated raw totals', () => {
  assert.match(adminApi, /uniqueTotals\[ev\]\s*=\s*daysOut\.reduce\(\(s, d\) => s \+ \(d\.unique_sessions\[ev\]/);
  assert.match(adminApi, /pricing_funnel:\s*pricingFunnel/);
  assert.doesNotMatch(adminApi, /pricingFunnel[\s\S]{0,500}count:\s*totals\.pricing_/);
});

test('actual new-user response is a boolean and account queues it without PII', () => {
  assert.match(exchangeApi, /trialStarted:\s*!!isNewUser/);
  assert.match(accountHtml, /if \(j\.trialStarted\)[\s\S]{0,240}kfl_pricing_trial_started_pending/);
  assert.match(accountHtml, /\/lib\/analytics\.js[\s\S]{0,120}\/js\/pricing-funnel\.js/);
});

console.log(`\n${passed} pricing-funnel checks passed.`);
