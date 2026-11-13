#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ACCOUNT = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');
const RECURRING = fs.readFileSync(path.join(ROOT, 'api/recurring.js'), 'utf8');

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

function extractFn(source, name) {
  let start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let paren = source.indexOf('(', start), pDepth = 0, i = paren;
  for (; i < source.length; i++) {
    if (source[i] === '(') pDepth++;
    else if (source[i] === ')' && --pDepth === 0) { i++; break; }
  }
  const body = source.indexOf('{', i);
  let depth = 0, j = body;
  for (; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) { j++; break; }
  }
  return source.slice(start, j);
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json() { return Promise.resolve(data); },
  };
}

function makeAddContext(reply) {
  const elements = {
    'fx-category': { value: '0' },
    'fx-amount': { value: '777' },
    'fx-day': { value: '7' },
    'fx-custom': { value: '' },
    'fx-add-btn': { disabled: false, textContent: 'הוסף הוצאה קבועה' },
  };
  let local = Array.from({ length: 5 }, (_, i) => ({ id: 'existing-' + i }));
  const state = { message: '', kind: '', draft: null, resets: 0, draftClears: 0, renders: [] };
  const context = {
    KFL_FIXED_CATS: [{ label: 'שכר דירה', category: 'דיור', subcategory: 'שכר דירה' }],
    KFL_RECURRING_UPGRADE_URL: '/pricing?from=recurring-limit',
    document: { getElementById(id) { return elements[id] || null; } },
    Date,
    Math,
    Number,
    String,
    JSON,
    isFinite,
    parseInt,
    fetch() { return Promise.resolve(reply); },
    _kflFixedClearMsg() {},
    _kflFixedPhone() { return '972500000000'; },
    _kflFixedLocalGet() { return local.slice(); },
    _kflFixedLocalSet(next) { local = next.slice(); },
    _kflFixedRender(next) { state.renders.push(next.slice()); },
    _kflFixedMsg(message, kind) { state.message = message; state.kind = kind; },
    _kflFixedDraftSave(draft) { state.draft = { ...draft }; },
    _kflFixedDraftClear() { state.draftClears++; },
    _kflFixedResetForm() { state.resets++; elements['fx-amount'].value = ''; },
    kesefleFixedList() { return Promise.resolve(); },
    _kflFunnel() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(extractFn(ACCOUNT, 'kesefleFixedAdd'), context);
  return { context, elements, state, local: () => local };
}

(async () => {
  console.log('\nTrial expiry and paywall recovery');

  await test('day 13/14/15 boundaries are exact instants and timezone-independent', async () => {
    const { computeEntitlement, newUserTrialFields, TRIAL_DAYS } = await import('../lib/subscription.js');
    const DAY = 86400000;
    const start = Date.parse('2026-03-20T21:30:00.000Z');
    const fields = newUserTrialFields(start);
    const end = Date.parse(fields.trialEndsAt);
    assert.strictEqual(end - start, TRIAL_DAYS * DAY);
    assert.strictEqual(computeEntitlement(fields, start + 13 * DAY).premium, true);
    assert.strictEqual(computeEntitlement(fields, end - 1).premium, true);
    assert.strictEqual(computeEntitlement(fields, end - 1).trial.daysLeft, 1);
    assert.strictEqual(computeEntitlement(fields, end).status, 'trial_expired');
    assert.strictEqual(computeEntitlement(fields, end).premium, false);
    assert.strictEqual(computeEntitlement(fields, end + DAY).premium, false);
    const tzRecord = { ...fields, trialEndsAt: '2026-04-04T00:30:00+03:00' };
    assert.strictEqual(Date.parse(tzRecord.trialEndsAt), end);
    assert.strictEqual(computeEntitlement(tzRecord, end - 1).premium, true);
    assert.strictEqual(computeEntitlement(tzRecord, end).premium, false);
  });

  await test('expired trial downgrades free while paid Pro/Family stay premium without mutating data', async () => {
    const { computeEntitlement } = await import('../lib/subscription.js');
    const NOW = Date.parse('2026-04-05T12:00:00.000Z');
    const expired = new Date(NOW - 1).toISOString();
    const future = new Date(NOW + 86400000).toISOString();
    const free = { plan: 'free', trialEndsAt: expired, spreadsheetId: 'sheet-existing' };
    const snapshot = JSON.stringify(free);
    assert.deepStrictEqual(computeEntitlement(free, NOW).effectivePlan, 'free');
    assert.strictEqual(computeEntitlement({ plan: 'pro', trialEndsAt: expired, accessUntil: future }, NOW).effectivePlan, 'pro');
    assert.strictEqual(computeEntitlement({ plan: 'family', trialEndsAt: expired, accessUntil: future }, NOW).effectivePlan, 'family');
    assert.strictEqual(JSON.stringify(free), snapshot, 'entitlement calculation must not alter existing sheet/data fields');
  });

  await test('402 paywall does not create a fake sixth recurring rule or clear the form', async () => {
    const env = makeAddContext(response(402, { ok: false, error: 'free_limit_reached', limit: 5 }));
    await env.context.kesefleFixedAdd();
    assert.strictEqual(env.local().length, 5);
    assert.strictEqual(env.elements['fx-amount'].value, '777');
    assert.strictEqual(env.elements['fx-day'].value, '7');
    assert.strictEqual(env.state.resets, 0);
    assert.deepStrictEqual(env.state.draft, { categoryIndex: 0, amount: 777, day: 7, custom: '' });
    assert.match(env.state.message, /href="\/pricing\?from=recurring-limit"/);
    assert.match(env.state.message, /אינו מבצע חיוב אוטומטי/);
    assert.match(env.state.message, /ההוצאות שכבר שמרת נשארות פעילות/);
  });

  await test('successful retry clears the draft and persists the new rule normally', async () => {
    const env = makeAddContext(response(200, { ok: true, template: { id: 'server-sixth' } }));
    await env.context.kesefleFixedAdd();
    assert.strictEqual(env.local().length, 6);
    assert.strictEqual(env.local()[5].id, 'server-sixth');
    assert.strictEqual(env.state.draftClears, 1);
    assert.strictEqual(env.state.resets, 1);
  });

  await test('server returns one canonical pricing recovery URL for browser and bot paths', async () => {
    assert.match(RECURRING, /const RECURRING_UPGRADE_URL = 'https:\/\/kesefle\.com\/pricing\?from=recurring-limit'/);
    assert.strictEqual((RECURRING.match(/upgrade_url:\s*RECURRING_UPGRADE_URL/g) || []).length, 2);
    assert.doesNotMatch(RECURRING, /kesefle\.com\/upgrade/);
    assert.match(RECURRING, /ללא חיוב אוטומטי/);
  });

  await test('paywall branch precedes local mirroring and draft restore is wired on reveal', async () => {
    const add = extractFn(ACCOUNT, 'kesefleFixedAdd');
    assert.ok(add.indexOf('if (paywall)') < add.indexOf('list.push(tpl)'));
    const paywallBlock = add.slice(add.indexOf('if (paywall)'), add.indexOf('// Mirror locally'));
    assert.doesNotMatch(paywallBlock, /_kflFixedLocalSet/);
    assert.match(ACCOUNT, /function _kflFixedDraftRestore\(/);
    assert.match(extractFn(ACCOUNT, 'kesefleFixedReveal'), /_kflFixedDraftRestore\(\)/);
  });

  console.log(`\n${passed} trial/paywall checks passed.`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
