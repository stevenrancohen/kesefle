#!/usr/bin/env node
'use strict';

// Budget UI truth contract:
// - only a valid { ok:true, budget:{ categories:{} } } payload is empty
// - transport/auth/protocol failures surface an explicit retry state
// - a late request cannot overwrite a newer render

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

function extractFunction(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, name + ' exists');
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
    else if (char === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error('unterminated ' + name);
}

function element(hidden = false) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    textContent: '', innerHTML: '', onclick: null,
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
    },
  };
}

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, async json() { return payload; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function dashboardRuntime(fetchImpl) {
  const elements = {
    'budget-list': element(true),
    'budget-empty': element(true),
    'budget-loading': element(false),
    'budget-error': element(true),
    'budget-retry': element(false),
    'budget-active-count': element(false),
  };
  const events = { unavailable: 0, empty: 0, reauth: 0 };
  const context = {
    fetch: fetchImpl,
    window: { __kflLastRows: [] },
    Promise, JSON, Object, Array, Number, Math,
    safeEl: (id) => elements[id] || null,
    computeMtdByCategory: () => ({}),
    _renderBudgetInsight: (cats) => { if (Object.keys(cats).length === 0) events.empty += 1; },
    _renderBudgetInsightUnavailable: () => { events.unavailable += 1; },
    _applyForecastPace() {}, computeForecast: () => ({ hasData: false }),
    compute3MonthTrends: () => ({}), _forecastTakeaway: () => '',
    escapeHtml: (value) => String(value), moneyShekel: (value) => String(value),
    showReauthBanner: () => { events.reauth += 1; },
  };
  vm.runInNewContext([
    'var _budgetRenderRequestId = 0;',
    'var _forecastBudgetTotal = 0;',
    "function _budgetBarColor(){ return '#000'; }",
    extractFunction(dashboard, 'renderBudgets'),
    'globalThis.run = renderBudgets;',
  ].join('\n'), context, { filename: 'budget-ui-runtime.js' });
  return { run: context.run, elements, events };
}

(async function main() {
  console.log('\n=== budget UI truth ===\n');

  assert.match(dashboard, /id="budget-error"[\s\S]*id="budget-retry"/,
    'dashboard contains a dedicated accessible retry state');
  assert.match(app, /התקציבים לא זמינים כרגע[\s\S]*onclick="route\(true\)"/,
    'app insights expose an honest retry card');
  assert.match(app, /if\(e&&e\.isAuth\) throw e;[\s\S]*__unavailable:true/,
    'budget fetch never swallows an expired session');
  const budgetResolution = app.indexOf('var budgetStatus=budgetApiState(bg);');
  const emptyExpensesBranch = app.indexOf('if(!spent && !tc.length)');
  assert.ok(budgetResolution >= 0 && emptyExpensesBranch > budgetResolution,
    'app resolves the budget before the no-expenses onboarding branch');
  assert.match(app.slice(emptyExpensesBranch, emptyExpensesBranch + 260), /onboardingCard\(\)\+budgetCard/,
    'no-expenses onboarding retains ready and unavailable budget truth');

  const budgetStateContext = { Object, Array };
  vm.runInNewContext(extractFunction(app, 'budgetApiState') + '\nglobalThis.run = budgetApiState;', budgetStateContext);
  const budgetState = budgetStateContext.run;
  assert.strictEqual(budgetState({ ok: true, budget: { categories: {} } }), 'empty');
  assert.strictEqual(budgetState({ ok: true, budget: { categories: { food: { cap: 10 } } } }), 'ready');
  for (const ambiguous of [null, {}, { ok: false }, { ok: true }, { ok: true, budget: {} },
    { ok: true, budget: { categories: [] } }, { __unavailable: true }]) {
    assert.strictEqual(budgetState(ambiguous), 'unavailable', 'ambiguous app payload is unavailable');
  }

  const empty = dashboardRuntime(async () => response(200, { ok: true, budget: { categories: {} } }));
  await empty.run([]);
  assert.strictEqual(empty.elements['budget-empty'].classList.contains('hidden'), false);
  assert.strictEqual(empty.elements['budget-error'].classList.contains('hidden'), true);
  assert.strictEqual(empty.elements['budget-active-count'].textContent, '0');
  assert.strictEqual(empty.events.empty, 1);
  assert.strictEqual(empty.events.unavailable, 0);

  for (const failure of [
    async () => { throw new Error('offline'); },
    async () => response(503, { ok: false }),
    async () => response(200, { ok: true }),
  ]) {
    const runtime = dashboardRuntime(failure);
    await runtime.run([]);
    assert.strictEqual(runtime.elements['budget-error'].classList.contains('hidden'), false);
    assert.strictEqual(runtime.elements['budget-empty'].classList.contains('hidden'), true,
      'failure never renders the empty CTA');
    assert.strictEqual(runtime.elements['budget-active-count'].textContent, '—');
    assert.strictEqual(runtime.events.unavailable, 1);
  }

  const expired = dashboardRuntime(async () => response(401, { ok: false }));
  await expired.run([]);
  assert.strictEqual(expired.events.reauth, 1);
  assert.strictEqual(expired.elements['budget-error'].classList.contains('hidden'), false);

  const first = deferred(), second = deferred();
  let call = 0;
  const race = dashboardRuntime(() => (++call === 1 ? first.promise : second.promise));
  const oldRender = race.run([]);
  const newRender = race.run([]);
  second.resolve(response(200, { ok: true, budget: { categories: { food: { cap: 100, threshold: 80 } } } }));
  await newRender;
  first.resolve(response(200, { ok: true, budget: { categories: {} } }));
  await oldRender;
  assert.strictEqual(race.elements['budget-list'].classList.contains('hidden'), false);
  assert.strictEqual(race.elements['budget-empty'].classList.contains('hidden'), true,
    'late empty response cannot overwrite the newer populated view');
  assert.strictEqual(race.elements['budget-active-count'].textContent, '1');

  const stale401 = deferred(), fresh200 = deferred();
  let authRaceCall = 0;
  const authRace = dashboardRuntime(() => (++authRaceCall === 1 ? stale401.promise : fresh200.promise));
  const staleAuthRender = authRace.run([]);
  const freshRender = authRace.run([]);
  fresh200.resolve(response(200, { ok: true, budget: { categories: { food: { cap: 100, threshold: 80 } } } }));
  await freshRender;
  stale401.resolve(response(401, { ok: false }));
  await staleAuthRender;
  assert.strictEqual(authRace.events.reauth, 0,
    'a stale 401 cannot raise a reauthentication banner over a newer success');
  assert.strictEqual(authRace.elements['budget-list'].classList.contains('hidden'), false);

  console.log('Budget UI truth: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
