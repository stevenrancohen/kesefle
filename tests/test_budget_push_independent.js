#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api/cron/budget-check.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

async function scenario({ phone = null, whatsAppOk = false, pushOk = false, runs = 1, concurrent = false, finalizeOk = true }) {
  const dedup = new Map();
  const calls = { whatsapp: 0, push: 0, dedup: 0, leases: 0 };
  const responses = [];
  const records = {
    'usr_budget:user-1': { categories: { 'אוכל': { cap: 100, threshold: 80 } } },
    'userPhone:user-1': phone ? { phone } : null,
    'sheet:user-1': { spreadsheetId: 'sheet-1' },
    'user:user-1': { refreshToken: 'refresh-1' },
  };
  const context = {
    verifyCronAuth: async () => ({ ok: true }),
    kvScan: async () => ({ ok: true, complete: true, keys: ['usr_budget:user-1'] }),
    kvGetState: async (key) => records[key]
      ? { state: 'found', value: records[key] }
      : { state: 'missing' },
    validBudgetRecord: () => true,
    kvAcquireDeliveryLease: async (key, token) => {
      calls.leases++;
      if (dedup.has(key)) return { ok: true, acquired: false };
      dedup.set(key, token);
      return { ok: true, acquired: true };
    },
    kvFinalizeDelivery: async (key, token, value) => {
      if (!finalizeOk || dedup.get(key) !== token) {
        return { ok: false, finalized: false, result: null };
      }
      calls.dedup++;
      dedup.set(key, value);
      return { ok: true, finalized: true, result: 'stored' };
    },
    kvReleaseDeliveryLease: async (key, token) => {
      if (dedup.get(key) !== token) return { ok: true, released: false, result: 'not_owner' };
      dedup.delete(key);
      return { ok: true, released: true, result: 'released' };
    },
    decryptRefreshToken: () => 'refresh-1',
    exchangeRefreshForAccess: async () => 'access-1',
    readMtdByCategory: async () => ({ 'אוכל': 90 }),
    sendWhatsAppAlert: async () => { calls.whatsapp++; return { ok: whatsAppOk }; },
    sendPush: async () => ({ ok: (calls.push++, pushOk), skipped: !pushOk, reason: pushOk ? '' : 'not_available' }),
    monthKey: (date) => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'),
    subHash: () => 'hash',
    log: { info() {}, warn() {} },
    process: { env: { SELF_URL: 'https://kesefle.test' } },
    Date,
    randomUUID: (() => { let id = 0; return () => 'test-' + (++id); })(),
  };
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    'const ALERT_TTL_SEC = 3024000;',
    extractFunction('handlerImpl'),
    'globalThis.run = handlerImpl;',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'budget-push-independent.js' });
  const execute = async (i) => {
    const state = { status: 0, body: null };
    const res = {
      status(codeValue) { state.status = codeValue; return this; },
      json(body) { state.body = body; return body; },
    };
    await context.run({ headers: {}, reqId: 'test-' + i }, res);
    responses.push(state);
  };
  if (concurrent) {
    await Promise.all(Array.from({ length: runs }, (_, i) => execute(i)));
  } else {
    for (let i = 0; i < runs; i++) await execute(i);
  }
  return { calls, dedup, responses };
}

(async () => {
  const pushOnly = await scenario({ phone: null, pushOk: true });
  assert.strictEqual(pushOnly.calls.whatsapp, 0, 'a web-first user needs no phone to be evaluated');
  assert.strictEqual(pushOnly.calls.push, 1, 'a web-first user receives the budget Push');
  assert.strictEqual(pushOnly.calls.dedup, 1, 'successful Push writes the monthly category dedupe');
  assert.strictEqual(pushOnly.responses[0].body.alerted, 1);

  const whatsAppDown = await scenario({ phone: '972500000000', whatsAppOk: false, pushOk: true, runs: 2 });
  assert.strictEqual(whatsAppDown.calls.whatsapp, 1);
  assert.strictEqual(whatsAppDown.calls.push, 1,
    'successful Push is not repeated next day when WhatsApp failed');
  assert.strictEqual(whatsAppDown.calls.dedup, 1);

  const noChannel = await scenario({ phone: null, pushOk: false });
  assert.strictEqual(noChannel.calls.dedup, 0, 'failed delivery never burns the dedupe key');
  assert.strictEqual(noChannel.responses[0].body.errors, 1);

  const concurrentRuns = await scenario({ phone: null, pushOk: true, runs: 2, concurrent: true });
  assert.strictEqual(concurrentRuns.calls.push, 1,
    'an atomic category lease permits only one external delivery across concurrent cron runs');
  assert.strictEqual(concurrentRuns.calls.dedup, 1);

  const failedFinalize = await scenario({ phone: null, pushOk: true, finalizeOk: false });
  assert.strictEqual(failedFinalize.responses[0].body.alerted, 0,
    'a failed durable dedupe write is never reported as a finalized alert');
  assert.strictEqual(failedFinalize.responses[0].body.errors, 1);
  assert.strictEqual(failedFinalize.responses[0].status, 503,
    'an uncertain durable dedupe write never reports a healthy cron');

  console.log('Budget Push channel independence: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
