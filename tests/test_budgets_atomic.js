#!/usr/bin/env node
'use strict';

// Budget storage integrity regression contract:
// - only explicit KV result:null means missing
// - set/remove are one EVAL mutation, never GET + SET
// - ambiguous HTTP-200 payloads fail closed
// - concurrent mutations preserve a valid linear order and the 30-item limit

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'api/budgets.js'), 'utf8');

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, name + ' exists');
  const start = match.index;
  const body = source.indexOf('{', match.index + match[0].length);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = body; i < source.length; i += 1) {
    const char = source[i], next = source[i + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

function http(ok, body, status = ok ? 200 : 503) {
  return { ok, status, async json() { return body; } };
}

function validStoredBudget(value, maxCategories = 30) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)) return false;
  const entries = Object.entries(value.categories);
  if (entries.length > maxCategories) return false;
  return entries.every(([name, conf]) => name && conf && Number.isInteger(Number(conf.cap)) &&
    Number(conf.cap) >= 1 && Number(conf.cap) <= 100000 &&
    Number.isInteger(Number(conf.threshold)) && Number(conf.threshold) >= 1 && Number(conf.threshold) <= 99);
}

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key,
    typeof value === 'string' ? value : JSON.stringify(value)]));
  const calls = [];
  const controls = { nextGet: null, nextEval: null, nextDel: null, loseNextEvalResponse: false };

  async function fetch(url, options = {}) {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/get/')) {
      if (controls.nextGet) { const value = controls.nextGet; controls.nextGet = null; return value; }
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      return http(true, { result: store.has(key) ? store.get(key) : null });
    }
    if (parsed.pathname.startsWith('/del/')) {
      if (controls.nextDel) { const value = controls.nextDel; controls.nextDel = null; return value; }
      const key = decodeURIComponent(parsed.pathname.slice('/del/'.length));
      const deleted = store.delete(key) ? 1 : 0;
      return http(true, { result: deleted });
    }
    const command = JSON.parse(options.body || '[]');
    assert.strictEqual(command[0], 'EVAL');
    assert.match(command[1], /KESEFLE_ATOMIC_BUDGET_MUTATION_V1/);
    if (controls.nextEval) { const value = controls.nextEval; controls.nextEval = null; return value; }
    const key = command[3], action = command[4], category = command[5];
    const cap = Number(command[6]), threshold = Number(command[7]);
    const maxCategories = Number(command[8]), updatedAt = command[10];
    let current = { categories: {}, updatedAt: null };
    if (store.has(key)) {
      try { current = JSON.parse(store.get(key)); }
      catch (_e) { return http(true, { result: JSON.stringify({ status: 'invalid_state' }) }); }
      if (!validStoredBudget(current, maxCategories)) {
        return http(true, { result: JSON.stringify({ status: 'invalid_state' }) });
      }
    }
    let result;
    if (action === 'set') {
      if (!(category in current.categories) && Object.keys(current.categories).length >= maxCategories) {
        result = { status: 'too_many' };
      } else {
        current.categories[category] = { cap, threshold };
        current.updatedAt = updatedAt;
        store.set(key, JSON.stringify(current));
        result = { status: 'stored', budget: current };
      }
    } else if (action === 'remove') {
      if (!(category in current.categories)) result = { status: 'not_found', budget: current };
      else {
        delete current.categories[category];
        current.updatedAt = updatedAt;
        store.set(key, JSON.stringify(current));
        result = { status: 'removed', budget: current };
      }
    } else result = { status: 'invalid_action' };
    if (controls.loseNextEvalResponse) {
      controls.loseNextEvalResponse = false;
      throw new Error('lost_response_after_commit');
    }
    return http(true, { result: JSON.stringify(result) });
  }
  return { fetch, store, calls, controls };
}

function runtime(kv) {
  const context = { fetch: kv.fetch, URL, JSON, Date, Object, Number, Set };
  const functions = [
    'hasOwn', 'validBudgetRecord', 'validPhoneRecord', 'kvReadJson', 'kvDel',
    'kvEvalBudgetMutation', 'emptyBudget', 'sanitizeCap', 'sanitizeThreshold',
    'actSet', 'actList', 'actRemove', 'actClear',
  ].map(extractFunction).join('\n');
  const code = [
    "const KV_URL = 'https://kv.test';",
    "const KV_TOKEN = 'token';",
    'const MAX_CATEGORIES = 30;',
    'const MAX_CAP_NIS = 100000;',
    'const DEFAULT_THRESHOLD = 80;',
    "const VALID_LABELS = new Set(['מזון ופארמה','תחבורה','דיור','בילויים ופנאי','אחר']);",
    functions,
    'globalThis.api = { kvReadJson, kvDel, kvEvalBudgetMutation, actSet, actList, actRemove, actClear, validBudgetRecord, validPhoneRecord };',
  ].join('\n');
  vm.runInNewContext(code, context, { filename: 'budgets-atomic-runtime.js' });
  return context.api;
}

function budget(categories) { return { categories, updatedAt: '2026-11-24T00:00:00.000Z' }; }

(async function main() {
  console.log('\n=== atomic budget storage ===\n');

  assert.match(source, /KESEFLE_ATOMIC_BUDGET_MUTATION_V1/);
  assert.match(source, /redis\.call\('GET', KEYS\[1\]\)[\s\S]*redis\.call\('SET', KEYS\[1\]/,
    'read and write happen inside one key-locked Lua script');
  const setSource = extractFunction('actSet');
  const removeSource = extractFunction('actRemove');
  assert.doesNotMatch(setSource + removeSource, /kvReadJson|kvGet|kvSet/,
    'mutations never perform a client-side read-modify-write');

  const missingKv = fakeKv();
  const missing = await runtime(missingKv).actList('user-1');
  assert.strictEqual(missing.code, 200);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(missing.json.budget)), { categories: {}, updatedAt: null });

  const readFailureCases = [
    http(false, { error: 'down' }, 503),
    http(true, { error: 'upstream_error' }),
    http(true, {}),
    http(true, { result: '{broken-json' }),
    http(true, { result: JSON.stringify({ categories: [] }) }),
  ];
  for (const failure of readFailureCases) {
    const kv = fakeKv({ 'usr_budget:user-1': budget({ 'מזון ופארמה': { cap: 1000, threshold: 80 } }) });
    kv.controls.nextGet = failure;
    const result = await runtime(kv).actList('user-1');
    assert.ok(result.code >= 500, 'ambiguous read fails closed');
    assert.strictEqual(kv.calls.filter((call) => call.options.method === 'POST').length, 0,
      'ambiguous reads never trigger a write');
  }

  const parallelKv = fakeKv({ 'usr_budget:user-1': budget({ 'דיור': { cap: 5000, threshold: 85 } }) });
  const parallelApi = runtime(parallelKv);
  const [food, transport] = await Promise.all([
    parallelApi.actSet('user-1', { category: 'מזון ופארמה', cap: 1200 }),
    parallelApi.actSet('user-1', { category: 'תחבורה', cap: 900, threshold: 75 }),
  ]);
  assert.strictEqual(food.code, 200);
  assert.strictEqual(transport.code, 200);
  const parallelStored = JSON.parse(parallelKv.store.get('usr_budget:user-1'));
  assert.deepStrictEqual(Object.keys(parallelStored.categories).sort(), ['דיור', 'מזון ופארמה', 'תחבורה'].sort(),
    'parallel category sets retain both updates');
  assert.ok(parallelKv.calls.filter((call) => call.url === 'https://kv.test').every((call) =>
    JSON.parse(call.options.body)[0] === 'EVAL'));

  const setRemoveKv = fakeKv({ 'usr_budget:user-1': budget({
    'דיור': { cap: 5000, threshold: 80 }, 'מזון ופארמה': { cap: 1000, threshold: 80 },
  }) });
  const setRemoveApi = runtime(setRemoveKv);
  await Promise.all([
    setRemoveApi.actSet('user-1', { category: 'תחבורה', cap: 500 }),
    setRemoveApi.actRemove('user-1', { category: 'דיור' }),
  ]);
  const setRemoveStored = JSON.parse(setRemoveKv.store.get('usr_budget:user-1'));
  assert.ok(setRemoveStored.categories['תחבורה']);
  assert.ok(!setRemoveStored.categories['דיור']);
  assert.ok(setRemoveStored.categories['מזון ופארמה']);

  const setClearKv = fakeKv({ 'usr_budget:user-1': budget({ 'דיור': { cap: 5000, threshold: 80 } }) });
  const setClearApi = runtime(setClearKv);
  await Promise.all([
    setClearApi.actSet('user-1', { category: 'תחבורה', cap: 500 }),
    setClearApi.actClear('user-1'),
  ]);
  assert.strictEqual(setClearKv.store.has('usr_budget:user-1'), false,
    'clear ordered after set does not allow an old snapshot to resurrect data');

  const categories29 = {};
  for (let i = 0; i < 29; i += 1) categories29['קטגוריה ' + i] = { cap: 100 + i, threshold: 80 };
  const limitKv = fakeKv({ 'usr_budget:user-1': budget(categories29) });
  const limitApi = runtime(limitKv);
  const limitResults = await Promise.all([
    limitApi.actSet('user-1', { category: 'מזון ופארמה', cap: 500 }),
    limitApi.actSet('user-1', { category: 'תחבורה', cap: 500 }),
  ]);
  assert.deepStrictEqual(limitResults.map((result) => result.code).sort(), [200, 400]);
  assert.strictEqual(Object.keys(JSON.parse(limitKv.store.get('usr_budget:user-1')).categories).length, 30);

  const lostKv = fakeKv({ 'usr_budget:user-1': budget({ 'דיור': { cap: 5000, threshold: 80 } }) });
  const lostApi = runtime(lostKv);
  lostKv.controls.loseNextEvalResponse = true;
  assert.strictEqual((await lostApi.actSet('user-1', { category: 'תחבורה', cap: 700 })).code, 502);
  assert.strictEqual((await lostApi.actSet('user-1', { category: 'תחבורה', cap: 700 })).code, 200);
  const lostStored = JSON.parse(lostKv.store.get('usr_budget:user-1'));
  assert.deepStrictEqual(Object.keys(lostStored.categories).sort(), ['דיור', 'תחבורה'].sort(),
    'absolute retry after a lost response neither duplicates nor erases data');

  const tenantsKv = fakeKv();
  const tenantsApi = runtime(tenantsKv);
  await Promise.all([
    tenantsApi.actSet('user-A', { category: 'מזון ופארמה', cap: 111 }),
    tenantsApi.actSet('user-B', { category: 'תחבורה', cap: 222 }),
  ]);
  assert.deepStrictEqual(Object.keys(JSON.parse(tenantsKv.store.get('usr_budget:user-A')).categories), ['מזון ופארמה']);
  assert.deepStrictEqual(Object.keys(JSON.parse(tenantsKv.store.get('usr_budget:user-B')).categories), ['תחבורה']);

  const evalErrorKv = fakeKv();
  evalErrorKv.controls.nextEval = http(true, { error: 'write_failed' });
  assert.strictEqual((await runtime(evalErrorKv).actSet('user-1', { category: 'תחבורה', cap: 500 })).code, 502,
    'HTTP-200 EVAL errors never claim success');
  const delErrorKv = fakeKv({ 'usr_budget:user-1': budget({ 'דיור': { cap: 5000, threshold: 80 } }) });
  delErrorKv.controls.nextDel = http(true, { error: 'delete_failed' });
  assert.strictEqual((await runtime(delErrorKv).actClear('user-1')).code, 502,
    'HTTP-200 DEL errors never claim success');
  const delNullKv = fakeKv({ 'usr_budget:user-1': budget({ 'דיור': { cap: 5000, threshold: 80 } }) });
  delNullKv.controls.nextDel = http(true, { result: null });
  assert.strictEqual((await runtime(delNullKv).actClear('user-1')).code, 502,
    'ambiguous DEL result:null never claims success');

  console.log('Atomic budget storage: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
