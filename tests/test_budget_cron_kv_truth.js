#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api/cron/budget-check.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('async function ' + name + '(');
  const syncStart = source.indexOf('function ' + name + '(');
  const actual = start >= 0 && (syncStart < 0 || start < syncStart) ? start : syncStart;
  assert.ok(actual >= 0, name + ' exists');
  const body = source.indexOf('{', source.indexOf(')', actual));
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(actual, i + 1);
  }
  throw new Error('unterminated ' + name);
}

async function scanFixture(responses) {
  let index = 0;
  const context = { encodeURIComponent, kvFetch: async () => responses[Math.min(index++, responses.length - 1)] };
  vm.runInNewContext(extractFunction('kvScan') + '\nglobalThis.run = kvScan;', context);
  return context.run('usr_budget:*', 100);
}

async function getFixture(response) {
  const context = { encodeURIComponent, JSON, Object, Array, kvFetch: async () => response };
  vm.runInNewContext(extractFunction('kvGetState') + '\nglobalThis.run = kvGetState;', context);
  return context.run('key');
}

async function kvFetchFixture(response) {
  const context = { fetch: async () => response, JSON };
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    extractFunction('kvFetch'),
    'globalThis.run = kvFetch;',
  ].join('\n');
  vm.runInNewContext(code, context);
  return context.run('/get/key');
}

async function acquireFixture(response) {
  const context = { encodeURIComponent, Object, kvFetch: async () => response };
  const code = [
    'const DELIVERY_LEASE_TTL_SEC = 600;',
    extractFunction('kvAcquireDeliveryLease'),
    'globalThis.run = kvAcquireDeliveryLease;',
  ].join('\n');
  vm.runInNewContext(code, context);
  return context.run('dedupe-key', 'lease-token');
}

function validBudget(value) {
  return !!value && value.categories && !Array.isArray(value.categories) &&
    Object.entries(value.categories).every(([name, conf]) => name && Number(conf.cap) > 0 &&
      Number(conf.threshold) >= 1 && Number(conf.threshold) <= 99);
}

async function handlerFixture({
  scan, states, pushOk = true,
  lease = { ok: true, acquired: true },
  finalize = { ok: true, finalized: true, result: 'stored' },
  release = { ok: true, released: true, result: 'released' },
}) {
  const calls = { push: 0, whatsapp: 0, release: 0 };
  const state = { status: 0, body: null };
  const context = {
    verifyCronAuth: async () => ({ ok: true }),
    kvScan: async () => scan,
    kvGetState: async (key) => states[key] || { state: 'missing' },
    validBudgetRecord: validBudget,
    kvAcquireDeliveryLease: async () => lease,
    kvFinalizeDelivery: async () => finalize,
    kvReleaseDeliveryLease: async () => { calls.release += 1; return release; },
    decryptRefreshToken: () => 'refresh',
    exchangeRefreshForAccess: async () => 'access',
    readMtdByCategory: async () => ({ 'מזון ופארמה': 90 }),
    sendWhatsAppAlert: async () => { calls.whatsapp += 1; return { ok: true }; },
    sendPush: async () => { calls.push += 1; return { ok: pushOk, skipped: !pushOk }; },
    monthKey: () => '2026-11',
    subHash: () => 'hash',
    log: { info() {}, warn() {} },
    process: { env: { SELF_URL: 'https://kesefle.test' } },
    Date,
    Promise,
    Object,
    Number,
    Math,
    randomUUID: () => 'uuid',
  };
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    extractFunction('handlerImpl'),
    'globalThis.run = handlerImpl;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'budget-cron-kv-truth-runtime.js' });
  const res = {
    status(codeValue) { state.status = codeValue; return this; },
    json(body) { state.body = body; return body; },
  };
  await context.run({ headers: {}, reqId: 'test' }, res);
  return { state, calls };
}

(async function main() {
  console.log('\n=== budget cron KV truth ===\n');

  const scanFail = await scanFixture([{ ok: false }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(scanFail)), { ok: false, complete: false, keys: [] });
  const scanProtocol = await scanFixture([{ ok: true, result: ['0', 'not-an-array'] }]);
  assert.strictEqual(scanProtocol.ok, false);
  const http200Error = await kvFetchFixture({ ok: true, status: 200, json: async () => ({ error: 'upstream' }) });
  assert.strictEqual(http200Error.ok, false, 'HTTP-200 KV error payloads fail closed');
  const truncated = await scanFixture([{ ok: true, result: ['1', []] }]);
  assert.strictEqual(truncated.ok, false, 'a non-zero cursor after the page limit is incomplete');
  assert.strictEqual(truncated.complete, false);
  const complete = await scanFixture([
    { ok: true, result: ['2', ['usr_budget:a']] },
    { ok: true, result: ['0', ['usr_budget:b']] },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(complete)), {
    ok: true, complete: true, keys: ['usr_budget:a', 'usr_budget:b'],
  });

  assert.strictEqual((await getFixture({ ok: false })).state, 'unavailable');
  assert.strictEqual((await getFixture({ ok: true })).state, 'unavailable');
  assert.strictEqual((await getFixture({ ok: true, result: null })).state, 'missing');
  assert.strictEqual((await getFixture({ ok: true, result: '{bad' })).state, 'invalid_state');
  assert.strictEqual((await getFixture({ ok: true, result: JSON.stringify({ phone: '972500000000' }) })).state, 'found');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await acquireFixture({ ok: true, result: 'OK' }))),
    { ok: true, acquired: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await acquireFixture({ ok: true, result: null }))),
    { ok: true, acquired: false });
  for (const malformedLease of [{ ok: true, result: 'bogus' }, { ok: true, result: 0 }]) {
    assert.strictEqual((await acquireFixture(malformedLease)).ok, false,
      'malformed HTTP-200 lease result fails closed');
  }

  const initialScanFailure = await handlerFixture({ scan: { ok: false, complete: false, keys: [] }, states: {} });
  assert.strictEqual(initialScanFailure.state.status, 503);
  assert.strictEqual(initialScanFailure.state.body.ok, false);
  assert.strictEqual(initialScanFailure.state.body.error, 'kv_scan_failed');

  const budgetOutage = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { 'usr_budget:user-1': { state: 'unavailable' } },
  });
  assert.strictEqual(budgetOutage.state.status, 503);
  assert.strictEqual(budgetOutage.state.body.kvErrors, 1);
  assert.strictEqual(budgetOutage.state.body.skipped, 0, 'budget outage is not reported as an empty record');
  assert.strictEqual(budgetOutage.calls.push, 0);

  const malformedBudget = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { 'usr_budget:user-1': { state: 'found', value: { categories: [] } } },
  });
  assert.strictEqual(malformedBudget.state.status, 503);
  assert.strictEqual(malformedBudget.calls.push, 0, 'malformed budgets never send an alert');

  const baseStates = {
    'usr_budget:user-1': { state: 'found', value: { categories: { 'מזון ופארמה': { cap: 100, threshold: 80 } } } },
    'sheet:user-1': { state: 'found', value: { spreadsheetId: 'sheet-1' } },
    'user:user-1': { state: 'found', value: { refreshToken: 'refresh-1' } },
  };
  const phoneOutage = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'userPhone:user-1': { state: 'unavailable' } },
  });
  assert.strictEqual(phoneOutage.calls.whatsapp, 0);
  assert.strictEqual(phoneOutage.calls.push, 1, 'phone KV outage does not block independent Push');
  assert.strictEqual(phoneOutage.state.body.alerted, 1);
  assert.strictEqual(phoneOutage.state.status, 503);
  assert.strictEqual(phoneOutage.state.body.degraded, true);

  const userOutage = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'user:user-1': { state: 'unavailable' } },
  });
  assert.strictEqual(userOutage.state.status, 503);
  assert.strictEqual(userOutage.calls.push, 0);
  assert.strictEqual(userOutage.state.body.skipped, 0, 'user KV outage is not a no-sheet skip');

  const malformedSheetWithFallback = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: {
      ...baseStates,
      'sheet:user-1': { state: 'found', value: { spreadsheetId: 17 } },
      'user:user-1': { state: 'found', value: { spreadsheetId: 'legacy-sheet', refreshToken: 'refresh-1' } },
    },
  });
  assert.strictEqual(malformedSheetWithFallback.calls.push, 1,
    'a malformed canonical sheet record cannot shadow a valid user-record fallback');
  assert.strictEqual(malformedSheetWithFallback.state.status, 503,
    'the usable fallback completes safe work but preserves degraded KV truth');

  const leaseFailure = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'userPhone:user-1': { state: 'missing' } },
    lease: { ok: false, acquired: false },
  });
  assert.strictEqual(leaseFailure.state.status, 503);
  assert.strictEqual(leaseFailure.state.body.kvErrors, 1,
    'delivery-lease KV failure is a degraded cron, never 200 success');
  assert.strictEqual(leaseFailure.calls.push, 0);

  const finalizeFailure = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'userPhone:user-1': { state: 'missing' } },
    finalize: { ok: false, finalized: false, result: null },
  });
  assert.strictEqual(finalizeFailure.calls.push, 1);
  assert.strictEqual(finalizeFailure.state.status, 503);
  assert.strictEqual(finalizeFailure.state.body.alerted, 0);
  assert.strictEqual(finalizeFailure.state.body.kvErrors, 1,
    'uncertain dedupe after delivery is reported as degraded');

  const releaseFailure = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'userPhone:user-1': { state: 'missing' } },
    pushOk: false,
    release: { ok: false, released: false, result: null },
  });
  assert.strictEqual(releaseFailure.calls.release, 1);
  assert.strictEqual(releaseFailure.state.status, 503);
  assert.strictEqual(releaseFailure.state.body.kvErrors, 1,
    'failed lease cleanup cannot masquerade as a healthy retryable send failure');

  const missingPhone = await handlerFixture({
    scan: { ok: true, complete: true, keys: ['usr_budget:user-1'] },
    states: { ...baseStates, 'userPhone:user-1': { state: 'missing' } },
  });
  assert.strictEqual(missingPhone.state.status, 200);
  assert.strictEqual(missingPhone.state.body.ok, true);
  assert.strictEqual(missingPhone.calls.push, 1);

  console.log('Budget cron KV truth: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
