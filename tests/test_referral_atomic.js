#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'api/referral.js'), 'utf8');
const accountSource = fs.readFileSync(path.join(ROOT, 'account.html'), 'utf8');

function extractFunctionFrom(text, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(text);
  assert.ok(match, name + ' exists');
  const start = match.index;
  let paren = text.indexOf('(', start), params = 0, after = paren;
  for (; after < text.length; after += 1) {
    if (text[after] === '(') params += 1;
    else if (text[after] === ')' && --params === 0) { after += 1; break; }
  }
  const body = text.indexOf('{', after);
  let depth = 0, quote = '', escaped = false, line = false, block = false;
  for (let index = body; index < text.length; index += 1) {
    const char = text[index], next = text[index + 1];
    if (line) { if (char === '\n') line = false; continue; }
    if (block) { if (char === '*' && next === '/') { block = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { line = true; index += 1; continue; }
    if (char === '/' && next === '*') { block = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error('unterminated ' + name);
}

function extractFunction(name) { return extractFunctionFrom(source, name); }

function http(ok, body) { return { ok, async json() { return body; } }; }
function scalar(raw) {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  } catch {}
  return String(raw);
}
function strictIso(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [
    key, typeof value === 'string' ? value : JSON.stringify(value),
  ]));
  const controls = { getReply: null, evalReply: null, loseEvalReply: false, getCalls: 0, evalCalls: 0 };

  function codeEval(command) {
    const [codeKey, candidateKey, oldKey, userKey, tombstoneKey] = command.slice(3, 8);
    const [sub, candidate, forceRaw, expected] = command.slice(8);
    if (store.has(tombstoneKey)) return { status: 'account_deleted' };
    if (!store.has(userKey)) return { status: 'account_missing' };
    let account;
    try { account = JSON.parse(store.get(userKey)); } catch { return { status: 'invalid_state' }; }
    if (!account || typeof account !== 'object' || Array.isArray(account) ||
        (account.userSub != null && String(account.userSub) !== sub)) return { status: 'invalid_state' };
    const force = forceRaw === '1';
    const current = store.has(codeKey) ? scalar(store.get(codeKey)) : null;
    if (!force && current) {
      if (current !== expected) return { status: 'conflict', code: current };
      const owner = store.has(oldKey) ? scalar(store.get(oldKey)) : null;
      if (owner && owner !== sub) return { status: 'invalid_state' };
      if (!owner) store.set(oldKey, JSON.stringify(sub));
      return { status: 'reused', code: current };
    }
    if (force && (current || '') !== expected) return { status: 'conflict', code: current || '' };
    const candidateOwner = store.has(candidateKey) ? scalar(store.get(candidateKey)) : null;
    if (candidateOwner && candidateOwner !== sub) return { status: 'collision' };
    if (current && current !== candidate) {
      const oldOwner = store.has(oldKey) ? scalar(store.get(oldKey)) : null;
      if (oldOwner && oldOwner !== sub) return { status: 'invalid_state' };
      if (oldOwner === sub) store.delete(oldKey);
    }
    store.set(codeKey, candidate);
    store.set(candidateKey, JSON.stringify(sub));
    return { status: current ? 'regenerated' : 'generated', code: candidate };
  }

  function redeemEval(command) {
    const [receiptKey, reverseKey, countKey, listKey, userKey, referrerKey,
      userCreditKey, referrerCreditKey, auditKey, userTombstoneKey,
      referrerTombstoneKey] = command.slice(3, 14);
    const [sub, code, referrerSub, initial, now, until, userSource, referrerSource, maxRaw] = command.slice(14);
    if (store.has(userTombstoneKey) || store.has(referrerTombstoneKey)) {
      return { status: 'account_deleted' };
    }
    if (store.has(receiptKey)) {
      let receipt;
      try { receipt = JSON.parse(store.get(receiptKey)); } catch { return { status: 'invalid_state' }; }
      if (!receipt || typeof receipt !== 'object' || !strictIso(receipt.at)) return { status: 'invalid_state' };
      if (receipt.code !== code || !strictIso(receipt.grantedUntil) ||
          typeof receipt.redeemerGranted !== 'boolean' || typeof receipt.referrerGranted !== 'boolean') {
        return { status: 'already_redeemed' };
      }
      return { status: 'replayed', grantedUntil: receipt.grantedUntil,
        redeemerGranted: receipt.redeemerGranted, referrerGranted: receipt.referrerGranted };
    }
    const owner = store.has(reverseKey) ? scalar(store.get(reverseKey)) : null;
    if (!owner || owner !== referrerSub) return { status: 'code_not_found' };
    if (owner === sub) return { status: 'self_referral' };
    const count = store.has(countKey) ? Number(store.get(countKey)) : 0;
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number.MAX_SAFE_INTEGER) return { status: 'invalid_state' };

    let list = [];
    try { if (store.has(listKey)) list = JSON.parse(store.get(listKey)); } catch { return { status: 'invalid_state' }; }
    if (!Array.isArray(list) || list.length > Number(maxRaw) ||
        !list.every((entry) => entry && typeof entry === 'object' &&
          (typeof entry.emailInitial === 'string' || typeof entry.email === 'string') && strictIso(entry.at))) {
      return { status: 'invalid_state' };
    }
    list = list.map((entry) => ({
      emailInitial: typeof entry.emailInitial === 'string' && /^[A-Za-z0-9?]$/.test(entry.emailInitial)
        ? entry.emailInitial : '?',
      at: entry.at,
    }));

    let user, referrer;
    try {
      if (store.has(userKey)) user = JSON.parse(store.get(userKey));
      if (store.has(referrerKey)) referrer = JSON.parse(store.get(referrerKey));
    } catch { return { status: 'invalid_state' }; }
    if (!user || typeof user !== 'object' || Array.isArray(user) ||
        !referrer || typeof referrer !== 'object' || Array.isArray(referrer)) return { status: 'invalid_state' };

    function prepareCredit(key, record, sourceValue) {
      if (store.has(key)) {
        let credit;
        try { credit = JSON.parse(store.get(key)); } catch { return null; }
        if (!credit || !strictIso(credit.grantedUntil) || !strictIso(credit.grantedAt) ||
            typeof credit.source !== 'string' || !credit.source) return null;
        return { credit, granted: false, write: false };
      }
      const legacy = record.referral_credit != null || record.referral_credit_granted_at != null ||
        record.referral_credit_source != null;
      if (legacy) {
        if (!strictIso(record.referral_credit) || !strictIso(record.referral_credit_granted_at) ||
            typeof record.referral_credit_source !== 'string' || !record.referral_credit_source) return null;
        return { credit: { grantedUntil: record.referral_credit,
          grantedAt: record.referral_credit_granted_at, source: record.referral_credit_source },
        granted: false, write: true };
      }
      return { credit: { grantedUntil: until, grantedAt: now, source: sourceValue }, granted: true, write: true };
    }
    const userCredit = prepareCredit(userCreditKey, user, userSource);
    const referrerCredit = prepareCredit(referrerCreditKey, referrer, referrerSource);
    if (!userCredit || !referrerCredit) return { status: 'invalid_state' };
    list.push({ emailInitial: /^[A-Za-z0-9?]$/.test(initial) ? initial : '?', at: now });
    list = list.slice(-Number(maxRaw));
    if (userCredit.write) store.set(userCreditKey, JSON.stringify(userCredit.credit));
    if (referrerCredit.write) store.set(referrerCreditKey, JSON.stringify(referrerCredit.credit));
    store.set(receiptKey, JSON.stringify({ code, at: now, grantedUntil: userCredit.credit.grantedUntil,
      redeemerGranted: userCredit.granted, referrerGranted: referrerCredit.granted }));
    store.set(auditKey, JSON.stringify({ at: now, action: 'referral_redeem' }));
    store.set(countKey, String(count + 1));
    store.set(listKey, JSON.stringify(list));
    return { status: 'redeemed', grantedUntil: userCredit.credit.grantedUntil,
      redeemerGranted: userCredit.granted, referrerGranted: referrerCredit.granted };
  }

  async function fetch(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/get/')) {
      controls.getCalls += 1;
      if (controls.getReply) { const reply = controls.getReply; controls.getReply = null; return reply; }
      const key = decodeURIComponent(parsed.pathname.slice(5));
      return http(true, { result: store.has(key) ? store.get(key) : null });
    }
    if (parsed.pathname.startsWith('/set/')) return http(true, { result: 'OK' });
    const command = JSON.parse(options.body || '[]');
    assert.strictEqual(command[0], 'EVAL');
    controls.evalCalls += 1;
    if (controls.evalReply) { const reply = controls.evalReply; controls.evalReply = null; return reply; }
    const result = /KESEFLE_ATOMIC_REFERRAL_CODE_V1/.test(command[1]) ? codeEval(command) : redeemEval(command);
    if (controls.loseEvalReply) { controls.loseEvalReply = false; throw new Error('lost_after_commit'); }
    return http(true, { result: JSON.stringify(result) });
  }
  return { store, controls, fetch };
}

function runtime(kv) {
  const context = { fetch: kv.fetch, URL, JSON, Object, Number, String, Date, encodeURIComponent,
    userDeletionKey: (sub) => 'deletedUser:' + sub,
    log: { info() {} }, process: { env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'token' } } };
  const functions = [
    'normalizeCode', 'hasOwn', 'validObject', 'validCode', 'validUserSub', 'validCount',
    'validIsoTimestamp', 'validRedeemers', 'validReferralCredit', 'validReferralReceipt',
    'kvReadValue', 'runReferralEval', 'kvEvalReferralCode', 'kvEvalReferralRedeem',
    'referralSuccessPayload', 'redeemAction',
  ].map(extractFunction).join('\n');
  vm.runInNewContext(["const CODE_RE = /^[A-Za-z0-9]{6}$/;", functions,
    'globalThis.api={validCode,validRedeemers,kvReadValue,kvEvalReferralCode,kvEvalReferralRedeem,redeemAction};'].join('\n'),
  context, { filename: 'referral-runtime.js' });
  return context.api;
}

function res() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

async function runAccountReferralUi(referralResponse = {
  ok: true, note_he: 'אמת מהשרת', credit_granted_to_redeemer: false,
}) {
  const storage = new Map([
    ['kfl_referral_redeemed', '1'],
    ['kfl_referral_redeemed:local-account-a', '1'],
  ]);
  const calls = [];
  const removedSessionKeys = [];
  const element = () => ({ textContent: '', classList: { add() {}, remove() {} } });
  const elements = new Map();
  const context = {
    String,
    console: { warn() {} },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    sessionStorage: { removeItem(key) { removedSessionKeys.push(key); } },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
    kesefleReadReferralCode() { return { code: 'ABC234', name: null }; },
    async fetch(url, options = {}) {
      calls.push({ url, options });
      if (url === '/api/me') {
        return http(true, { ok: true, user: { sub: 'cookie-account-b' } });
      }
      assert.strictEqual(url, '/api/referral?action=redeem');
      return http(true, referralResponse);
    },
  };
  vm.runInNewContext([
    extractFunctionFrom(accountSource, 'kesefleRedeemReferralIfPending'),
    'globalThis.run=kesefleRedeemReferralIfPending;',
  ].join('\n'), context, { filename: 'account-referral-runtime.js' });
  await context.run();
  return { storage, calls, elements, removedSessionKeys };
}
function base() {
  return { 'referral:code:referrer': 'ABC234', 'referral:reverse:ABC234': JSON.stringify('referrer'),
    'user:referrer': { name: 'נועה כהן', plan: 'pro', refreshTokenEnvelope: 'keep' } };
}

(async function main() {
  console.log('\n=== atomic referral storage ===\n');
  assert.match(source, /#!lua flags=allow-key-locking/);
  assert.match(source, /KESEFLE_ATOMIC_REFERRAL_CODE_V1/);
  assert.match(source, /KESEFLE_ATOMIC_REFERRAL_REDEEM_V1/);
  assert.doesNotMatch(extractFunction('redeemAction'), /existingList|kvIncr|kvSet\(/);
  assert.doesNotMatch(source, /table\.insert\(redeemers, \{ email =/);
  assert.match(source, /https:\/\/kesefle\.com\/referral/);
  assert.doesNotMatch(accountSource, /var redeemedKey = ['"]kfl_referral_redeemed['"]/);
  assert.match(accountSource, /kfl_referral_redeemed:' \+ verifiedSub/);
  assert.doesNotMatch(extractFunctionFrom(accountSource, 'kesefleRedeemReferralIfPending'), /Authorization/);
  assert.match(accountSource, /var truth = j\.note_he \|\| \(j\.credit_granted_to_redeemer/);
  const accountUi = await runAccountReferralUi();
  assert.strictEqual(accountUi.calls.length, 2, 'cookie session B redeems despite stale local account A');
  assert.strictEqual(accountUi.calls[0].url, '/api/me');
  assert.strictEqual(accountUi.calls[0].options.credentials, 'include');
  assert.strictEqual(accountUi.calls[1].options.credentials, 'include');
  assert.ok(!Object.hasOwn(accountUi.calls[1].options.headers, 'Authorization'));
  assert.deepStrictEqual(JSON.parse(accountUi.calls[1].options.body),
    { code: 'ABC234', expectedUserSub: 'cookie-account-b' });
  assert.strictEqual(accountUi.storage.get('kfl_referral_redeemed:cookie-account-b'), '1');
  assert.match(accountUi.elements.get('ref-success-text').textContent, /אמת מהשרת/);

  const switchedUi = await runAccountReferralUi({ ok: false, error: 'account_changed_retry' });
  assert.ok(!switchedUi.storage.has('kfl_referral_redeemed:cookie-account-b'));
  assert.deepStrictEqual(switchedUi.removedSessionKeys, []);
  assert.match(switchedUi.elements.get('ref-error-text').textContent, /החשבון השתנה/);

  const subscription = await import(pathToFileURL(path.join(ROOT, 'lib/subscription.js')).href);
  const user = { plan: 'free', unrelated: 'keep' };
  const credit = { grantedUntil: '2026-12-24T00:00:00.000Z',
    grantedAt: '2026-11-24T00:00:00.000Z', source: 'redeemed:ABC234' };
  const entitled = subscription.withReferralCredit(user, credit);
  assert.strictEqual(subscription.computeEntitlement(entitled, Date.parse('2026-11-25T00:00:00.000Z')).status, 'referral');
  assert.ok(!Object.hasOwn(user, 'referral_credit'));
  for (const file of ['api/whatsapp/link.js', 'api/recurring.js']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(text, /referral:credit:/);
    assert.match(text, /withReferralCredit/);
  }

  const readKv = fakeKv({ code: 'ABC234' });
  const readApi = runtime(readKv);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await readApi.kvReadValue('missing', readApi.validCode))), { state: 'missing' });
  readKv.controls.getReply = http(false, {});
  assert.strictEqual((await readApi.kvReadValue('code', readApi.validCode)).state, 'unavailable');
  readKv.controls.getReply = http(true, { result: 'BAD' });
  assert.strictEqual((await readApi.kvReadValue('code', readApi.validCode)).state, 'invalid_state');

  const codeKv = fakeKv({ 'user:a': { userSub: 'a' } });
  const codeApi = runtime(codeKv);
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'AAA234', false, '')).status, 'generated');
  codeKv.store.delete('referral:reverse:AAA234');
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'BBB234', false, 'AAA234')).status, 'reused');
  assert.strictEqual(scalar(codeKv.store.get('referral:reverse:AAA234')), 'a');
  codeKv.store.set('referral:reverse:AAA234', JSON.stringify('foreign'));
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'BBB234', false, 'AAA234')).status, 'invalid_state');
  codeKv.store.set('referral:reverse:AAA234', JSON.stringify('a'));
  codeKv.store.set('referral:reverse:CCC234', JSON.stringify('b'));
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'CCC234', true, 'AAA234')).status, 'collision');
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'DDD234', true, 'AAA234')).status, 'regenerated');
  codeKv.store.set('deletedUser:a', 'deleting');
  assert.strictEqual((await codeApi.kvEvalReferralCode('a', 'EEE234', false, 'DDD234')).status, 'account_deleted');
  assert.strictEqual(scalar(codeKv.store.get('referral:code:a')), 'DDD234');
  codeKv.store.delete('deletedUser:a');

  const args = { userSub: 'redeemer', code: 'ABC234', referrerSub: 'referrer', emailInitial: 'r',
    nowIso: '2026-11-24T00:00:00.000Z', grantedUntil: '2026-12-24T00:00:00.000Z' };
  const sameKv = fakeKv({ ...base(), 'user:redeemer': { email: 'r@example.com', token: 'keep' } });
  const sameApi = runtime(sameKv);
  const pair = await Promise.all([sameApi.kvEvalReferralRedeem(args), sameApi.kvEvalReferralRedeem(args)]);
  assert.deepStrictEqual(pair.map((item) => item.status).sort(), ['redeemed', 'replayed']);
  assert.strictEqual(sameKv.store.get('referral:count:referrer'), '1');
  const receipt = JSON.parse(sameKv.store.get('referral:redeemed:redeemer'));
  assert.ok(!Object.hasOwn(receipt, 'referrerSub') && !Object.hasOwn(receipt, 'referrerName'));
  assert.deepStrictEqual(JSON.parse(sameKv.store.get('audit:referral_redeem:redeemer')),
    { at: args.nowIso, action: 'referral_redeem' });
  assert.deepStrictEqual(JSON.parse(sameKv.store.get('referral:redeemers:referrer')),
    [{ emailInitial: 'r', at: args.nowIso }]);
  assert.strictEqual(JSON.parse(sameKv.store.get('user:redeemer')).token, 'keep');
  assert.ok(!Object.hasOwn(JSON.parse(sameKv.store.get('user:redeemer')), 'referral_credit'));

  const parallelKv = fakeKv({ ...base(), 'user:u1': { email: '1@x' }, 'user:u2': { email: '2@x' } });
  const parallelApi = runtime(parallelKv);
  await Promise.all([parallelApi.kvEvalReferralRedeem({ ...args, userSub: 'u1', emailInitial: '1' }),
    parallelApi.kvEvalReferralRedeem({ ...args, userSub: 'u2', emailInitial: '2' })]);
  assert.strictEqual(parallelKv.store.get('referral:count:referrer'), '2');
  assert.strictEqual(JSON.parse(parallelKv.store.get('referral:credit:referrer')).source, 'referrer_reward');

  const missingKv = fakeKv(base());
  assert.strictEqual((await runtime(missingKv).kvEvalReferralRedeem({ ...args, userSub: 'gone' })).status, 'invalid_state');
  assert.ok(!missingKv.store.has('referral:credit:gone'));

  for (const deletedSub of ['redeemer', 'referrer']) {
    const deletedKv = fakeKv({ ...base(), 'user:redeemer': { email: 'r@example.com' },
      ['deletedUser:' + deletedSub]: 'deleting' });
    const before = [...deletedKv.store.entries()];
    assert.strictEqual((await runtime(deletedKv).kvEvalReferralRedeem(args)).status, 'account_deleted');
    assert.deepStrictEqual([...deletedKv.store.entries()], before, deletedSub + ' tombstone commits nothing');
  }

  for (const [name, extra] of [
    ['bad list', { 'referral:redeemers:referrer': [{ email: 7, at: args.nowIso }] }],
    ['unsafe count', { 'referral:count:referrer': String(Number.MAX_SAFE_INTEGER) }],
    ['bad date', { 'referral:credit:referrer': { grantedUntil: '2026-99-99T00:00:00.000Z',
      grantedAt: args.nowIso, source: 'bad' } }],
  ]) {
    const badKv = fakeKv({ ...base(), 'user:bad': { email: 'bad@x' }, ...extra });
    assert.strictEqual((await runtime(badKv).kvEvalReferralRedeem({ ...args, userSub: 'bad' })).status, 'invalid_state', name);
    assert.ok(!badKv.store.has('referral:redeemed:bad'), name + ' commits nothing');
  }

  const normalizeKv = fakeKv({ ...base(),
    'referral:redeemers:referrer': [{ email: 'old@example.com', at: args.nowIso },
      { emailInitial: 'AB', at: args.nowIso }], 'user:normal': { email: 'n@x' } });
  assert.strictEqual((await runtime(normalizeKv).kvEvalReferralRedeem({ ...args, userSub: 'normal' })).status, 'redeemed');
  assert.deepStrictEqual(JSON.parse(normalizeKv.store.get('referral:redeemers:referrer')).slice(0, 2),
    [{ emailInitial: '?', at: args.nowIso }, { emailInitial: '?', at: args.nowIso }]);

  const actionKv = fakeKv({ ...base(), 'user:action': { email: 'action@example.com' } });
  const actionApi = runtime(actionKv);
  const request = { method: 'POST', query: {}, body: { code: 'ABC234', expectedUserSub: 'action' },
    user: { sub: 'action', email: 'action@example.com' }, reqId: 'r' };
  const switchedKv = fakeKv({ ...base(), 'user:cookie-c': { email: 'c@example.com' } });
  const switchedBefore = [...switchedKv.store.entries()];
  const switchedRes = res();
  await runtime(switchedKv).redeemAction({ ...request,
    body: { code: 'ABC234', expectedUserSub: 'cookie-b' },
    user: { sub: 'cookie-c', email: 'c@example.com' } }, switchedRes);
  assert.strictEqual(switchedRes.statusCode, 409);
  assert.strictEqual(switchedRes.body.error, 'account_changed_retry');
  assert.strictEqual(switchedKv.controls.getCalls, 0);
  assert.strictEqual(switchedKv.controls.evalCalls, 0);
  assert.deepStrictEqual([...switchedKv.store.entries()], switchedBefore);
  actionKv.controls.loseEvalReply = true;
  const lost = res();
  await actionApi.redeemAction(request, lost);
  assert.strictEqual(lost.statusCode, 502);
  actionKv.store.delete('referral:reverse:ABC234');
  const retry = res();
  await actionApi.redeemAction(request, retry);
  assert.strictEqual(retry.statusCode, 200);
  assert.strictEqual(retry.body.replayed, true);
  assert.strictEqual(actionKv.store.get('referral:count:referrer'), '1');
  const actionReceipt = JSON.parse(actionKv.store.get('referral:redeemed:action'));
  assert.deepStrictEqual(JSON.parse(actionKv.store.get('audit:referral_redeem:action')),
    { at: actionReceipt.at, action: 'referral_redeem' });

  const priorKv = fakeKv({ ...base(), 'referral:credit:referrer': credit,
    'user:second': { email: 'second@example.com' } });
  const priorRes = res();
  await runtime(priorKv).redeemAction({ ...request,
    body: { code: 'ABC234', expectedUserSub: 'second' },
    user: { sub: 'second', email: 'second@example.com' } }, priorRes);
  assert.strictEqual(priorRes.body.credit_granted_to_redeemer, true);
  assert.strictEqual(priorRes.body.credit_granted_to_referrer, false);
  assert.match(priorRes.body.note_he, /כבר מימש/);

  const durableKv = fakeKv({ ...base(), 'user:durable': { email: 'd@x', keep: true } });
  assert.strictEqual((await runtime(durableKv).kvEvalReferralRedeem({ ...args, userSub: 'durable' })).status, 'redeemed');
  durableKv.store.set('user:durable', JSON.stringify({ email: 'd@x', stale: true }));
  assert.strictEqual(JSON.parse(durableKv.store.get('referral:credit:durable')).grantedUntil, args.grantedUntil);

  console.log('Atomic referral storage: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
