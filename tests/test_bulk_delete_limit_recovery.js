#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DASHBOARD = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

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

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated function ' + name);
}

function makeClassList(initial) {
  const values = new Set(initial || []);
  return {
    add(v) { values.add(v); },
    remove(v) { values.delete(v); },
    contains(v) { return values.has(v); },
  };
}

function makeStorage() {
  const values = new Map();
  return {
    getItem(k) { return values.has(k) ? values.get(k) : null; },
    setItem(k, v) { values.set(k, String(v)); },
    removeItem(k) { values.delete(k); },
    values,
  };
}

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json() { return Promise.resolve(data); },
  };
}

function makeContext(reply) {
  const storage = makeStorage();
  const boxes = [{ checked: true }, { checked: true }, { checked: false }];
  const elements = {
    'kfl-bulk-bar': { classList: makeClassList(['hidden']) },
    'kfl-bulk-count': { textContent: '' },
    'kfl-bulk-status': { textContent: '', className: '', classList: makeClassList(['hidden']) },
    'kfl-bulk-delete': { disabled: false, textContent: '🗑 מחק' },
  };
  const state = { alerts: [], refreshed: 0, reply };
  const context = {
    window: null,
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll(sel) { return sel === '.kfl-tx-check' ? boxes : []; },
    },
    sessionStorage: storage,
    kesefleGetUser() { return { sub: 'user-A' }; },
    fetch() {
      if (state.reply instanceof Error) return Promise.reject(state.reply);
      return Promise.resolve(state.reply);
    },
    confirm() { return true; },
    alert(message) { state.alerts.push(message); },
    kesefleRefresh() { state.refreshed++; },
    Set,
    Map,
    Object,
    Array,
    JSON,
    String,
    Number,
    Math,
    Promise,
  };
  context.window = context;
  vm.createContext(context);

  [
    '_kflBulkRecoveryStorageKey',
    '_kflBulkRowKeys',
    '_kflBulkReadRecovery',
    '_kflBulkSaveRecovery',
    '_kflBulkClearRecovery',
    '_kflBulkRecoveryIndices',
  ].forEach((name) => vm.runInContext(extractFunction(DASHBOARD, name), context));

  const bulkStart = DASHBOARD.indexOf('window.kflBulkBarUpdate = function');
  const bulkEnd = DASHBOARD.indexOf('</script>', bulkStart);
  assert.ok(bulkStart >= 0 && bulkEnd > bulkStart, 'bulk action script exists');
  vm.runInContext(DASHBOARD.slice(bulkStart, bulkEnd), context);

  context._kflRecentRows = [
    { date: '2026-11-14', amount: 100, description: 'קפה', is_income: false },
    { date: '2026-11-13', amount: 200, description: 'סופר', is_income: false },
    { date: '2026-11-12', amount: 30, description: 'אוטובוס', is_income: false },
  ];
  context._kflSelected = new Set([0, 1]);
  return { context, elements, boxes, storage, state };
}

(async () => {
  console.log('\nBulk-delete limit recovery');

  await test('429 keeps the selected rows, stores recovery and reports that nothing was deleted', async () => {
    const env = makeContext(response(429, { ok: false, error: 'rate_limited', retryAfter: 1800 }));
    await env.context.kflBulkDelete();
    assert.deepStrictEqual([...env.context._kflSelected], [0, 1]);
    assert.strictEqual(env.boxes.filter((box) => box.checked).length, 2);
    assert.strictEqual(env.storage.values.has('kesefle_bulk_delete_recovery:user-A'), true);
    assert.match(env.elements['kfl-bulk-status'].textContent, /לא נמחק דבר/);
    assert.match(env.elements['kfl-bulk-status'].textContent, /30 דקות/);
    assert.strictEqual(env.state.alerts.length, 0, 'limit recovery is inline, not a blocking alert');
    assert.strictEqual(env.elements['kfl-bulk-delete'].disabled, false);
  });

  await test('refresh/back recovery follows transaction identity rather than stale list index', async () => {
    const env = makeContext(response(429, { ok: false, error: 'rate_limited', retryAfter: 60 }));
    await env.context.kflBulkDelete();
    const shifted = [
      { date: '2026-11-15', amount: 50, description: 'חדש', is_income: false },
      ...env.context._kflRecentRows,
    ];
    const restored = env.context._kflBulkRecoveryIndices(shifted);
    assert.deepStrictEqual([...restored], [1, 2]);
  });

  await test('duplicate-looking rows restore only the selected occurrence', async () => {
    const env = makeContext(response(429, { ok: false, error: 'rate_limited' }));
    const duplicate = { date: '2026-11-14', amount: 100, description: 'קפה', is_income: false };
    const rows = [duplicate, { ...duplicate }];
    env.context._kflBulkSaveRecovery(new Set([1]), rows);
    assert.deepStrictEqual([...env.context._kflBulkRecoveryIndices(rows)], [1]);
  });

  await test('network failure also preserves a retryable selection', async () => {
    const env = makeContext(new Error('offline'));
    await env.context.kflBulkDelete();
    assert.strictEqual(env.context._kflSelected.size, 2);
    assert.match(env.elements['kfl-bulk-status'].textContent, /שגיאת רשת/);
    assert.strictEqual(env.storage.values.has('kesefle_bulk_delete_recovery:user-A'), true);
  });

  await test('only a server-confirmed delete clears recovery and selection', async () => {
    const env = makeContext(response(200, { ok: true, deleted: 2, notFound: [] }));
    env.context._kflBulkSaveRecovery(env.context._kflSelected, env.context._kflRecentRows);
    await env.context.kflBulkDelete();
    assert.strictEqual(env.context._kflSelected.size, 0);
    assert.strictEqual(env.boxes.filter((box) => box.checked).length, 0);
    assert.strictEqual(env.storage.values.has('kesefle_bulk_delete_recovery:user-A'), false);
    assert.strictEqual(env.state.refreshed, 1);
    assert.strictEqual(env.state.alerts.length, 1);
  });

  await test('dashboard render and accessible mobile status are wired to recovery', async () => {
    assert.match(DASHBOARD, /window\._kflSelected\s*=\s*_kflBulkRecoveryIndices\(window\._kflRecentRows\)/);
    assert.match(DASHBOARD, /checkbox\.checked\s*=\s*window\._kflSelected\.has\(i\)/);
    assert.match(DASHBOARD, /id="kfl-bulk-status"[^>]+role="status"[^>]+aria-live="polite"/);
    const deleteFn = DASHBOARD.slice(
      DASHBOARD.indexOf('window.kflBulkDelete = async function'),
      DASHBOARD.indexOf('</script>', DASHBOARD.indexOf('window.kflBulkDelete = async function')),
    );
    const finallyBlock = deleteFn.slice(deleteFn.indexOf('} finally {'));
    assert.doesNotMatch(finallyBlock, /kflBulkClear\(/, 'finally must not discard a failed selection');
  });

  console.log(`\n${passed} bulk-delete recovery checks passed.`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
