#!/usr/bin/env node
// Executable delivery-state tests for WhatsApp account-link replies.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0;
let fail = 0;
const ok = (label, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL ' + label); }
};

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

function harness() {
  const state = new Map();
  const cache = new Map();
  const sent = [];
  const logs = [];
  const sendResults = [];
  const claimTtls = [];
  let kvAvailable = true;
  let finalizeAvailable = true;
  let lockAvailable = true;
  let lockCalls = 0;
  let id = 0;
  const context = {
    Logger: { log: (message) => logs.push(String(message)) },
    Utilities: { getUuid: () => 'uuid-' + (++id), sleep: () => {} },
    CacheService: { getScriptCache: () => ({
      get: (key) => cache.get(key) || null,
      put: (key, value) => cache.set(key, value),
      remove: (key) => cache.delete(key)
    }) },
    LockService: { getScriptLock: () => {
      lockCalls++;
      return { tryLock: () => lockAvailable, hasLock: () => lockAvailable, releaseLock: () => {} };
    } },
    sendWhatsAppMessage: (to, reply) => {
      sent.push({ to, reply });
      if (!sendResults.length) return { ok: true };
      const next = sendResults.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    _kvSetNx_: (key, value, ttl) => {
      claimTtls.push(ttl);
      if (!kvAvailable) return { available: false, acquired: false };
      if (state.has(key)) return { available: true, acquired: false };
      state.set(key, value);
      return { available: true, acquired: true };
    },
    kvGet: (key) => state.get(key) || null,
    _kvCompareSet_: (key, expected, value) => {
      if (!finalizeAvailable || state.get(key) !== expected) return false;
      state.set(key, value);
      return true;
    },
    _kvCompareDelete_: (key, expected) => {
      if (state.get(key) !== expected) return false;
      state.delete(key);
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFn(SRC, '_deliverLinkCodeCacheFallback_'), context);
  vm.runInContext(extractFn(SRC, '_deliverLinkCodeOutcome_'), context);
  return {
    deliver: context._deliverLinkCodeOutcome_,
    state,
    cache,
    sent,
    logs,
    sendResults,
    claimTtls,
    getLockCalls: () => lockCalls,
    setKvAvailable: (value) => { kvAvailable = value; },
    setFinalizeAvailable: (value) => { finalizeAvailable = value; },
    setLockAvailable: (value) => { lockAvailable = value; }
  };
}

const success = { reply: 'linked-success', kind: 'success', reason: 'linked', retryable: false };
const replay = { reply: 'linked-success', kind: 'success', reason: 'already_confirmed', retryable: false };
const temporary = { reply: 'temporary-error', kind: 'retryable', reason: 'temporary_unavailable', retryable: true };
const terminal = { reply: 'invalid-code', kind: 'terminal', reason: 'invalid_code', retryable: false };

let h = harness();
let result = h.deliver('wamid-1', '972501234567', success);
ok('first success sends once', result.ok && h.sent.length === 1);
ok('success lease exceeds the Apps Script execution ceiling', h.claimTtls[0] === 420);
ok('first success is marked only after provider acceptance', h.state.get('linkReply:wamid-1') === 'sent:success:linked');
result = h.deliver('wamid-1', '972501234567', replay);
ok('same wamid replay stays silent', result.skipped && h.sent.length === 1);

h = harness();
result = h.deliver('wamid-lost-api', '972501234567', temporary);
ok('temporary API failure sends guidance without a durable marker',
  result.ok && h.sent.length === 1 && !h.state.has('linkReply:wamid-lost-api'));
result = h.deliver('wamid-lost-api', '972501234567', temporary);
ok('same wamid does not repeat an identical temporary notice', result.skipped && h.sent.length === 1);
result = h.deliver('wamid-lost-api', '972501234567', replay);
ok('later API receipt sends the first success',
  result.ok && h.sent.filter((x) => x.reply === 'linked-success').length === 1);
result = h.deliver('wamid-lost-api', '972501234567', replay);
ok('third delivery cannot duplicate success',
  result.skipped && h.sent.filter((x) => x.reply === 'linked-success').length === 1);

h = harness();
h.sendResults.push({ ok: false, reason: 'provider_500' });
result = h.deliver('wamid-send-fail', '972501234567', success);
ok('provider rejection is returned as failure', !result.ok);
ok('provider rejection releases the owned lease', !h.state.has('linkReply:wamid-send-fail'));
result = h.deliver('wamid-send-fail', '972501234567', success);
ok('provider rejection permits a later retry', result.ok && h.sent.length === 2);

h = harness();
h.sendResults.push(new Error('transport down'));
result = h.deliver('wamid-send-throw', '972501234567', success);
ok('provider exception is returned as failure', !result.ok && result.reason === 'send_exception');
ok('provider exception releases the durable lease', !h.state.has('linkReply:wamid-send-throw'));

h = harness();
h.state.set('linkReply:wamid-concurrent', 'sending:other-worker');
result = h.deliver('wamid-concurrent', '972501234567', success);
ok('concurrent lease has one winner', result.skipped && h.sent.length === 0);

h = harness();
h.setKvAvailable(false);
result = h.deliver('wamid-fallback', '972501234567', terminal);
ok('KV outage degrades to locked cache and still replies', result.ok && h.sent.length === 1);
ok('fallback acquires a lock when router has none', h.getLockCalls() === 1);
result = h.deliver('wamid-fallback', '972501234567', terminal);
ok('locked cache suppresses duplicate terminal reply', result.skipped && h.sent.length === 1);

h = harness();
h.setKvAvailable(false);
h.sendResults.push(new Error('transport down'));
result = h.deliver('wamid-fallback-throw', '972501234567', terminal);
ok('cache fallback converts provider exception to failure', !result.ok && result.reason === 'send_exception');
ok('cache fallback exception clears the processing marker', h.cache.size === 0);

h = harness();
h.setKvAvailable(false);
result = h.deliver('wamid-router-lock', '972501234567', terminal, true);
ok('held router lock is reused during KV outage', result.ok && h.sent.length === 1 && h.getLockCalls() === 0);

h = harness();
h.setKvAvailable(false);
h.setLockAvailable(false);
result = h.deliver('wamid-lock-busy', '972501234567', terminal);
ok('KV outage plus busy fallback lock does not silently lose the customer reply',
  result.ok && h.sent.length === 1 && h.logs.some((line) => /lock busy/.test(line)));

h = harness();
h.setFinalizeAvailable(false);
result = h.deliver('wamid-finalize-outage', '972501234567', success);
ok('provider success survives durable finalization outage', result.ok && h.sent.length === 1);
result = h.deliver('wamid-finalize-outage', '972501234567', success);
ok('local sent marker covers finalization outage', result.skipped && h.sent.length === 1);

h = harness();
result = h.deliver('', '972501234567', success);
ok('missing wamid favors delivering the customer reply', result.ok && h.sent.length === 1);
ok('missing wamid logs degraded idempotency', h.logs.some((line) => /missing wamid/.test(line)));

function runProviderSend(provider, status) {
  let request = null;
  const context = {
    Logger: { log: () => {} },
    _waSendConfig_: () => ({
      ok: true,
      provider,
      url: 'https://provider.example/messages',
      from: '972500000000',
      headers: { Authorization: 'test' }
    }),
    _unwrapConciergeJson_: (message) => message,
    _waNormE164Digits_: (value) => String(value).replace(/\D/g, ''),
    _waEncodeForm_: (fields) => Object.keys(fields)
      .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]))
      .join('&'),
    UrlFetchApp: { fetch: (url, options) => {
      request = { url, options };
      return {
        getResponseCode: () => status,
        getContentText: () => status >= 200 && status < 300 ? '{"accepted":true}' : '{"error":"rejected"}'
      };
    } }
  };
  vm.createContext(context);
  vm.runInContext(extractFn(SRC, 'sendWhatsAppMessage'), context);
  return { result: context.sendWhatsAppMessage('972501234567', 'provider-test'), request };
}

let providerRun = runProviderSend('meta', 200);
ok('Meta HTTP 200 is treated as provider acceptance', providerRun.result.ok && providerRun.result.code === 200);
providerRun = runProviderSend('360dialog', 200);
ok('360dialog HTTP 200 is treated as provider acceptance', providerRun.result.ok && providerRun.result.code === 200);
providerRun = runProviderSend('twilio', 201);
ok('Twilio HTTP 201 is treated as provider acceptance',
  providerRun.result.ok && providerRun.result.code === 201 && /Body=provider-test/.test(providerRun.request.options.payload));
providerRun = runProviderSend('twilio', 400);
ok('Twilio non-2xx is rejected and cannot finalize a delivery lease', !providerRun.result.ok && providerRun.result.code === 400);
providerRun = runProviderSend('meta', 500);
ok('Meta non-2xx is rejected and cannot finalize a delivery lease', !providerRun.result.ok && providerRun.result.code === 500);

console.log('test_link_code_delivery: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
