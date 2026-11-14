#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const dashboard = read('dashboard.html');
const pricing = read('pricing.html');
const upgrade = read('upgrade.html');
const apiSource = read('api/custom-categories.js');
const intent = require('../js/upgrade-intent.js');

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  let passed = 0;
  const ok = (label, fn) => {
    fn();
    passed++;
    console.log('  ✅ ' + label);
  };

  console.log('── safe custom-category return context ──');
  ok('source and return path survive refresh/back', () => {
    const s = storage();
    const first = intent.capture('?source=custom_categories&return_to=%2Fdashboard%3Ffocus%3Dcustom-categories%23%2Foverview', s, 'https://kesefle.com');
    assert.deepStrictEqual(first, {
      source: 'custom_categories',
      returnTo: '/dashboard?focus=custom-categories#/overview',
    });
    assert.deepStrictEqual(intent.capture('', s, 'https://kesefle.com'), first);
  });
  ok('external and API return targets are rejected', () => {
    assert.strictEqual(intent.returnPath('https://evil.example/collect', 'https://kesefle.com'), '');
    assert.strictEqual(intent.returnPath('/api/custom-categories', 'https://kesefle.com'), '');
    assert.strictEqual(intent.returnPath('/dashboard?focus=custom-categories#/overview', 'https://kesefle.com'), '/dashboard?focus=custom-categories#/overview');
  });

  console.log('── entitlement and write behavior ──');
  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'test-token';
  const { __test } = await import('../api/custom-categories.js?' + Date.now());
  const originalFetch = global.fetch;

  async function runScenario(userRecord) {
    let writes = 0;
    global.fetch = async (url) => {
      const decoded = decodeURIComponent(String(url));
      if (decoded.includes('/get/user:sub-test')) {
        return { ok: true, json: async () => ({ result: JSON.stringify(userRecord) }) };
      }
      if (decoded.includes('/get/custom_categories:sub-test')) {
        return { ok: true, json: async () => ({ result: JSON.stringify({ items: [] }) }) };
      }
      if (decoded.includes('/set/custom_categories:sub-test')) {
        writes++;
        return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
      }
      throw new Error('rate-limit or unexpected test fetch: ' + decoded);
    };
    const res = response();
    await __test.handleAuthed({ reqId: 'test' }, res, { action: 'add', name: 'קורס אנגלית' }, 'sub-test');
    return { res, writes };
  }

  try {
    const free = await runScenario({ plan: 'free' });
    ok('Free gets attributed comparison CTA and no write', () => {
      assert.strictEqual(free.res.statusCode, 402);
      assert.strictEqual(free.res.body.source, 'custom_categories');
      assert.strictEqual(free.res.body.return_to, '/dashboard?focus=custom-categories#/overview');
      assert.match(free.res.body.upgrade_url, /^\/pricing\?source=custom_categories&return_to=%2Fdashboard%3Ffocus%3Dcustom-categories%23%2Foverview#tiers$/);
      assert.strictEqual(free.writes, 0);
    });

    const expired = await runScenario({ plan: 'free', trialEndsAt: '2020-01-01T00:00:00.000Z' });
    ok('expired trial follows the honest no-write upgrade path', () => {
      assert.strictEqual(expired.res.statusCode, 402);
      assert.strictEqual(expired.res.body.error, 'upgrade_required');
      assert.match(expired.res.body.detail, /אינה מבצעת חיוב/);
      assert.doesNotMatch(expired.res.body.detail, /ניסיון חינם|חיוב אוטומטי/);
      assert.strictEqual(expired.writes, 0);
    });

    const pro = await runScenario({ plan: 'pro', accessUntil: '2999-01-01T00:00:00.000Z' });
    ok('active Pro writes exactly once', () => {
      assert.strictEqual(pro.res.statusCode, 200);
      assert.strictEqual(pro.res.body.ok, true);
      assert.strictEqual(pro.writes, 1);
    });

    ok('active canonical trial remains premium without changing policy', () => {
      assert.strictEqual(__test.isPremium({ plan: 'free', trialEndsAt: '2999-01-01T00:00:00.000Z' }), true);
    });
  } finally {
    global.fetch = originalFetch;
  }

  console.log('── surface wiring ──');
  ok('API uses canonical entitlement and attributed upgrade payload', () => {
    assert.match(apiSource, /computeEntitlement\(userRec \|\| \{\}\)\.premium/);
    assert.match(apiSource, /source: UPGRADE_SOURCE/);
    assert.doesNotMatch(apiSource, /upgrade_url:\s*['"]\/pricing['"]/);
  });
  ok('dashboard preserves draft and replaces the alert with inline CTA', () => {
    assert.match(dashboard, /kfl_custom_category_upgrade_draft/);
    assert.match(dashboard, /j\.error === 'upgrade_required'/);
    assert.match(dashboard, /id = 'kfl-cats-draft-upgrade'/);
    assert.match(dashboard, /פתיחת עמוד המסלולים אינה מבצעת חיוב/);
  });
  ok('pricing captures attribution and payment return restores safe context', () => {
    assert.match(pricing, /KesefleUpgradeIntent\.capture/);
    assert.match(pricing, /upgrade_source:/);
    assert.match(upgrade, /KesefleUpgradeIntent\.read/);
    assert.match(upgrade, /id="upgrade-primary-return"/);
  });

  console.log(`✅ ${passed} custom-category upgrade checks passed.`);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
