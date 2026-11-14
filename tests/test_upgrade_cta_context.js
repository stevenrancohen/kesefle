#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const account = read('account.html');
const pricing = read('pricing.html');
const upgrade = read('upgrade.html');
const recurringSource = read('api/recurring.js');
const botDeploy = read('bot/ExpenseBot_DEPLOY.gs');
const botFixed = read('bot/ExpenseBot_FIXED.gs');
const context = require('../js/upgrade-context.js');

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function mockResponse(result) {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return result ? result(this) : this; },
  };
}

(async () => {
  let passed = 0;
  const ok = (label, fn) => {
    fn();
    passed++;
    console.log('  ✅ ' + label);
  };

  console.log('── safe upgrade context ──');
  ok('recurring source + return path survive refresh/back', () => {
    const storage = memoryStorage();
    const first = context.capture('?source=recurring_limit&return_to=%2Faccount%23fixed-expenses', storage, 'https://kesefle.com');
    assert.deepStrictEqual(first, { source: 'recurring_limit', returnTo: '/account#fixed-expenses' });
    const refreshed = context.capture('', storage, 'https://kesefle.com');
    assert.deepStrictEqual(refreshed, first);
  });
  ok('external and non-product return paths are rejected', () => {
    assert.strictEqual(context.safeReturnPath('https://evil.example/steal', 'https://kesefle.com'), '');
    assert.strictEqual(context.safeReturnPath('/api/billing/paypal', 'https://kesefle.com'), '');
    assert.strictEqual(context.safeReturnPath('/dashboard#/recurring', 'https://kesefle.com'), '/dashboard#/recurring');
  });
  ok('account continuation carries source attribution and encoded return', () => {
    assert.strictEqual(
      context.accountHref('pro', 'month', { source: 'recurring_limit', returnTo: '/account#fixed-expenses' }),
      '/account?plan=pro&period=month&source=recurring_limit&return_to=%2Faccount%23fixed-expenses'
    );
  });

  console.log('── recurring entitlement behavior ──');
  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const { __test } = await import('../api/recurring.js?' + Date.now());
  const originalFetch = global.fetch;
  const templates = Array.from({ length: 5 }, (_, i) => ({ id: 't' + i, amount: 10 + i, description: 'קבוע ' + i }));

  async function runScenario(userRecord) {
    let writes = 0;
    global.fetch = async (url) => {
      const decoded = decodeURIComponent(String(url));
      if (decoded.includes('/get/recurring:972501234567')) {
        return { ok: true, json: async () => ({ result: JSON.stringify(templates) }) };
      }
      if (decoded.includes('/get/user:sub-test')) {
        return { ok: true, json: async () => ({ result: JSON.stringify(userRecord) }) };
      }
      if (decoded.includes('/set/recurring:972501234567')) {
        writes++;
        return { ok: true, json: async () => ({ result: 'OK' }) };
      }
      throw new Error('unexpected fetch ' + decoded);
    };
    const res = mockResponse();
    await __test.sessionDispatch('add', 'sub-test', '972501234567', {
      amount: 340,
      dayOfMonth: 12,
      category: 'תקשורת',
      note: 'אינטרנט',
    }, res);
    return { res, writes };
  }

  try {
    const free = await runScenario({ plan: 'free' });
    ok('Free user gets attributed pricing CTA and no write', () => {
      assert.strictEqual(free.res.statusCode, 402);
      assert.strictEqual(free.res.body.error, 'free_limit_reached');
      assert.match(free.res.body.upgrade_url, /^\/pricing\?source=recurring_limit&return_to=%2Faccount%23fixed-expenses#tiers$/);
      assert.strictEqual(free.writes, 0);
    });

    const expired = await runScenario({ plan: 'free', trialEndsAt: '2020-01-01T00:00:00.000Z' });
    ok('expired trial follows the same honest limit path', () => {
      assert.strictEqual(expired.res.statusCode, 402);
      assert.strictEqual(expired.res.body.source, 'recurring_limit');
      assert.strictEqual(expired.writes, 0);
    });

    const pro = await runScenario({ plan: 'pro', accessUntil: '2999-01-01T00:00:00.000Z' });
    ok('active Pro bypasses the free limit and saves once', () => {
      assert.strictEqual(pro.res.statusCode, 200);
      assert.strictEqual(pro.res.body.ok, true);
      assert.strictEqual(pro.writes, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }

  console.log('── surface wiring ──');
  ok('API no longer sends limit users to the PayPal return page', () => {
    assert.doesNotMatch(recurringSource, /kesefle\.com\/upgrade/);
    assert.match(recurringSource, /recurring_limit_bot/);
  });
  ok('both bot builds surface the actionable API message', () => {
    for (const bot of [botDeploy, botFixed]) {
      assert.match(bot, /r\.error === 'free_limit_reached' && r\.message/);
    }
  });
  ok('account preserves the recurring draft and renders a safe CTA', () => {
    assert.match(account, /KFL_FIXED_UPGRADE_DRAFT_KEY/);
    assert.match(account, /errCode === 'free_limit_reached'/);
    assert.match(account, /id="fx-upgrade-link"/);
    assert.match(account, /_kflFixedRestoreDraft\(\)/);
  });
  ok('pricing captures source and upgrade return page restores it', () => {
    assert.match(pricing, /KesefleUpgradeContext\.capture/);
    assert.match(pricing, /upgrade_source:/);
    assert.match(upgrade, /KesefleUpgradeContext\.read/);
    assert.match(upgrade, /id="upgrade-primary-return"/);
  });

  console.log(`✅ ${passed} upgrade-context checks passed.`);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
