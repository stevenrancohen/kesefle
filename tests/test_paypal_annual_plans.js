#!/usr/bin/env node
// tests/test_paypal_annual_plans.js
//
// Guards the ANNUAL PayPal subscription plans (added 2026-06-03). Annual was
// already wired end-to-end in api/billing/paypal.js — the subscribe handler's
// planIdFor() and the webhook's planFromPlanId() both reference
// PAYPAL_PLAN_PRO_YEAR / PAYPAL_PLAN_FAMILY_YEAR — but the admin
// `action=setup-plans` bootstrap only ever CREATED the two monthly plans, so
// those env vars could never be populated. This suite asserts:
//
//   1. buildPlansToCreate() emits EXACTLY FOUR plan specs — Pro/Family x
//      monthly/annual — with the correct interval semantics: the two monthly
//      specs default to MONTH (intervalUnit unset), the two annual specs carry
//      intervalUnit:'YEAR'. Each spec maps to the exact env var
//      (PAYPAL_PLAN_PRO / _PRO_YEAR / _FAMILY / _FAMILY_YEAR) that planIdFor
//      and planFromPlanId look up.
//   2. Prices come from lib/billing.js's priceILS (the single server-side
//      source of truth) — annual = 190 (Pro) / 390 (Family), NOT hardcoded.
//   3. createPlan() stamps interval_unit:'YEAR' only when asked, and defaults
//      to 'MONTH' otherwise (so monthly behavior is 100% intact).
//   4. setupPlansImpl() actually issues FOUR createPlan calls (right intervals)
//      and returns all four env ids in its response — exercised against the
//      REAL handler with createProduct/createPlan stubbed (no PayPal network).
//   5. planIdFor / planFromPlanId ROUND-TRIP the _YEAR ids: pro/year and
//      family/year resolve to the *_YEAR env values and map back to the same
//      (plan, period) pair — and monthly is never collateral-damaged.
//
// Loads the REAL source via balanced-brace extraction (the house pattern — no
// mocking framework, no ESM import so no secrets/deps needed).
//   Run: node tests/test_paypal_annual_plans.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PP = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');
const BILLING = fs.readFileSync(path.join(ROOT, 'lib/billing.js'), 'utf8');

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function eq(actual, expected, label) {
  assert(actual === expected, label + ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}

// ── balanced-brace helper: pull `[async ]function NAME(...) { ... }` source ──
// Preserves a leading `async ` so async functions (createPlan / setupPlansImpl)
// keep their async-ness — otherwise the `await` inside would be a SyntaxError
// when eval'd as a plain function.
function fnSrc(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
function balanced(src, marker, open, close) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('marker not found: ' + marker);
  const i = src.indexOf(open, s);
  let d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === open) d++;
    else if (src[j] === close) { d--; if (!d) { j++; break; } }
  }
  return src.slice(i, j);
}

console.log('\ntests/test_paypal_annual_plans.js\n');

// ── load the REAL pricing source of truth from lib/billing.js ────────────────
// priceILS -> normalizePlan -> PRICES. PREMIUM_PLANS is imported across modules
// in billing.js; only normalizePlan's *fallback* branch touches it (never hit
// for 'pro'/'family'), so we provide the canonical list (matches
// lib/subscription.js) to keep the closure resolvable.
const PREMIUM_PLANS = ['pro', 'family', 'business'];
const PRICES = eval('(' + balanced(BILLING, 'const PRICES = {', '{', '}') + ')');
eval(fnSrc(BILLING, 'normalizePlan'));
eval(fnSrc(BILLING, 'priceILS'));

// Sanity: the prices we just loaded are the genuine source-of-truth annual
// numbers (so the assertions below are anchored to real values, not a stub).
console.log('Source-of-truth annual prices (lib/billing.js):');
eq(priceILS('pro', 'year'), 190, 'priceILS(pro, year) === 190');
eq(priceILS('family', 'year'), 390, 'priceILS(family, year) === 390');
eq(priceILS('pro', 'month'), 19, 'priceILS(pro, month) === 19');
eq(priceILS('family', 'month'), 39, 'priceILS(family, month) === 39');

// ── load buildPlansToCreate() from the REAL paypal.js (uses priceILS above) ──
eval(fnSrc(PP, 'buildPlansToCreate'));
const plans = buildPlansToCreate();

console.log('\nbuildPlansToCreate() shape:');
eq(Array.isArray(plans) ? plans.length : -1, 4, 'builds exactly 4 plans');

const byEnv = {};
for (const p of plans) byEnv[p.envKey] = p;

// All four expected env keys present, each exactly once.
for (const k of ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR']) {
  assert(!!byEnv[k], 'has a plan for env var ' + k);
}
eq(Object.keys(byEnv).length, 4, 'env keys are unique (no dup envKey)');

// Interval semantics: monthly specs leave intervalUnit unset (createPlan
// defaults to MONTH); annual specs explicitly carry 'YEAR'.
console.log('\nInterval units:');
const monthlyKeys = plans.filter((p) => p.intervalUnit !== 'YEAR').map((p) => p.envKey).sort();
const annualKeys = plans.filter((p) => p.intervalUnit === 'YEAR').map((p) => p.envKey).sort();
eq(JSON.stringify(monthlyKeys), JSON.stringify(['PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_PRO']), 'exactly the 2 monthly plans default to MONTH (intervalUnit unset)');
eq(JSON.stringify(annualKeys), JSON.stringify(['PAYPAL_PLAN_FAMILY_YEAR', 'PAYPAL_PLAN_PRO_YEAR']), 'exactly the 2 annual plans carry intervalUnit YEAR');

// Per-plan: period + price tie back to priceILS for the right (plan, period).
console.log('\nPer-plan period + price (sourced from priceILS):');
eq(byEnv.PAYPAL_PLAN_PRO.period, 'month', 'PAYPAL_PLAN_PRO is period=month');
eq(byEnv.PAYPAL_PLAN_PRO.priceIls, priceILS('pro', 'month'), 'PAYPAL_PLAN_PRO price === priceILS(pro,month)');
eq(byEnv.PAYPAL_PLAN_PRO_YEAR.period, 'year', 'PAYPAL_PLAN_PRO_YEAR is period=year');
eq(byEnv.PAYPAL_PLAN_PRO_YEAR.priceIls, priceILS('pro', 'year'), 'PAYPAL_PLAN_PRO_YEAR price === priceILS(pro,year) (190)');
eq(byEnv.PAYPAL_PLAN_FAMILY.period, 'month', 'PAYPAL_PLAN_FAMILY is period=month');
eq(byEnv.PAYPAL_PLAN_FAMILY.priceIls, priceILS('family', 'month'), 'PAYPAL_PLAN_FAMILY price === priceILS(family,month)');
eq(byEnv.PAYPAL_PLAN_FAMILY_YEAR.period, 'year', 'PAYPAL_PLAN_FAMILY_YEAR is period=year');
eq(byEnv.PAYPAL_PLAN_FAMILY_YEAR.priceIls, priceILS('family', 'year'), 'PAYPAL_PLAN_FAMILY_YEAR price === priceILS(family,year) (390)');

// ── createPlan(): interval_unit defaults to MONTH, becomes YEAR on request ───
// Capture the JSON body createPlan POSTs by stubbing global fetch. This proves
// the monthly path is byte-for-byte unchanged AND the annual path flips only
// the interval unit (interval_count stays 1).
console.log('\ncreatePlan() request body:');
eval(fnSrc(PP, 'paypalEnvName')); // paypalBase() now delegates to this (sandbox default)
eval(fnSrc(PP, 'paypalBase'));
eval(fnSrc(PP, 'createPlan'));
const _realFetch = global.fetch;
async function captureCreatePlan(unit) {
  let captured = null;
  global.fetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ id: 'PLAN-STUB' }) };
  };
  try {
    await createPlan('TOK', 'PROD-1', 'Kesefle X', 190, unit);
  } finally { global.fetch = _realFetch; }
  return captured;
}
(async () => {
  const monthlyBody = await captureCreatePlan(undefined);
  const annualBody = await captureCreatePlan('YEAR');

  eq(monthlyBody.billing_cycles[0].frequency.interval_unit, 'MONTH', 'createPlan(...) with no unit => interval_unit MONTH (monthly intact)');
  eq(monthlyBody.billing_cycles[0].frequency.interval_count, 1, 'monthly interval_count === 1');
  eq(annualBody.billing_cycles[0].frequency.interval_unit, 'YEAR', "createPlan(..., 'YEAR') => interval_unit YEAR");
  eq(annualBody.billing_cycles[0].frequency.interval_count, 1, 'annual interval_count === 1 (1 YEAR = annual)');
  eq(annualBody.billing_cycles[0].pricing_scheme.fixed_price.currency_code, 'ILS', 'annual plan currency stays ILS');

  // ── setupPlansImpl(): issues 4 creates + returns all 4 env ids ─────────────
  // Drive the REAL handler with createProduct + createPlan stubbed (so no
  // PayPal network). We assert it asks for 4 plans, each with the env-key-
  // appropriate interval, and echoes all four ids back in the response.
  console.log('\nsetupPlansImpl() end-to-end (stubbed PayPal):');

  // The handler closes over getAccessToken/createProduct/createPlan/priceILS/
  // log/buildPlansToCreate as free identifiers. Provide local stand-ins, then
  // eval the real function body so it binds to them.
  const calls = [];
  let _stubId = 0;
  async function getAccessToken() { return 'TOK'; }       // eslint-disable-line no-unused-vars
  async function createProduct() { return 'PROD-1'; }     // eslint-disable-line no-unused-vars
  // setup-plans is now KV-idempotent (paypal_plans:<env>); stub the KV pair so
  // the handler takes the fresh-creation path (no existing record).
  async function billingKvGet() { return null; }          // eslint-disable-line no-unused-vars
  async function billingKvSet() { return true; }          // eslint-disable-line no-unused-vars
  // Re-bind createPlan to a recording stub for the handler's scope.
  /* eslint-disable no-func-assign */
  const realCreatePlan = createPlan;
  createPlan = async (token, productId, name, priceIls, intervalUnit) => { // eslint-disable-line no-unused-vars
    calls.push({ name, priceIls, intervalUnit: intervalUnit || 'MONTH' });
    return 'PLAN-' + (++_stubId);
  };
  /* eslint-enable no-func-assign */
  const log = { info() {}, warn() {}, error() {} };       // eslint-disable-line no-unused-vars

  eval(fnSrc(PP, 'setupPlansImpl'));

  let status = null, payload = null;
  const res = {
    status(c) { status = c; return this; },
    json(o) { payload = o; return this; },
  };
  await setupPlansImpl({ reqId: 'test' }, res);
  createPlan = realCreatePlan; // restore // eslint-disable-line no-func-assign

  eq(status, 200, 'setup-plans responds 200 on success');
  eq(payload && payload.ok, true, 'response ok:true');
  eq(calls.length, 4, 'setup-plans issues exactly 4 createPlan calls');

  const annualCalls = calls.filter((c) => c.intervalUnit === 'YEAR');
  eq(annualCalls.length, 2, '...of which exactly 2 are YEAR (annual)');
  eq(calls.filter((c) => c.intervalUnit === 'MONTH').length, 2, '...and exactly 2 are MONTH (monthly)');

  // The two annual creates must be priced from priceILS(*, year): 190 + 390.
  const annualPrices = annualCalls.map((c) => c.priceIls).sort((a, b) => a - b);
  eq(JSON.stringify(annualPrices), JSON.stringify([190, 390]), 'annual createPlan prices are [190, 390] (Pro, Family yearly)');

  // Response returns ALL FOUR env ids (the whole point — so they can be pasted).
  for (const k of ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR']) {
    assert(payload && typeof payload[k] === 'string' && payload[k].length > 0, 'response returns ' + k + ' id');
  }
  // The "paste then redeploy" guidance must name all four vars.
  const nextMsg = (payload && payload.next) || '';
  for (const k of ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR']) {
    assert(nextMsg.indexOf(k) >= 0, 'next-step message mentions ' + k);
  }
  assert(/redeploy/i.test(nextMsg), 'next-step message tells the owner to redeploy');

  // ── planIdFor / planFromPlanId round-trip the _YEAR ids ────────────────────
  // These read process.env, so set the four plan ids and assert the annual
  // resolution + reverse mapping. Restore env afterward.
  console.log('\nplanIdFor / planFromPlanId round-trip:');
  eval(fnSrc(PP, 'planIdFor'));
  eval(fnSrc(PP, 'planFromPlanId'));

  const ENV_KEYS = ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR'];
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PAYPAL_PLAN_PRO = 'P-PRO-M';
  process.env.PAYPAL_PLAN_PRO_YEAR = 'P-PRO-Y';
  process.env.PAYPAL_PLAN_FAMILY = 'P-FAM-M';
  process.env.PAYPAL_PLAN_FAMILY_YEAR = 'P-FAM-Y';
  try {
    // Forward: (plan, period) -> the right env id.
    eq(planIdFor('pro', 'year'), 'P-PRO-Y', 'planIdFor(pro, year) -> PAYPAL_PLAN_PRO_YEAR');
    eq(planIdFor('family', 'year'), 'P-FAM-Y', 'planIdFor(family, year) -> PAYPAL_PLAN_FAMILY_YEAR');
    eq(planIdFor('pro', 'month'), 'P-PRO-M', 'planIdFor(pro, month) -> PAYPAL_PLAN_PRO (monthly intact)');
    eq(planIdFor('family', 'month'), 'P-FAM-M', 'planIdFor(family, month) -> PAYPAL_PLAN_FAMILY (monthly intact)');

    // Reverse: plan id -> (plan, period).
    eq(JSON.stringify(planFromPlanId('P-PRO-Y')), JSON.stringify({ plan: 'pro', period: 'year' }), 'planFromPlanId(PRO_YEAR id) -> {pro, year}');
    eq(JSON.stringify(planFromPlanId('P-FAM-Y')), JSON.stringify({ plan: 'family', period: 'year' }), 'planFromPlanId(FAMILY_YEAR id) -> {family, year}');
    eq(JSON.stringify(planFromPlanId('P-PRO-M')), JSON.stringify({ plan: 'pro', period: 'month' }), 'planFromPlanId(PRO id) -> {pro, month}');
    eq(JSON.stringify(planFromPlanId('P-FAM-M')), JSON.stringify({ plan: 'family', period: 'month' }), 'planFromPlanId(FAMILY id) -> {family, month}');

    // True round-trip closure for the annual ids: id -> (plan,period) -> id.
    for (const [p, per] of [['pro', 'year'], ['family', 'year'], ['pro', 'month'], ['family', 'month']]) {
      const id = planIdFor(p, per);
      const back = planFromPlanId(id);
      eq(JSON.stringify(back), JSON.stringify({ plan: p, period: per }), 'round-trip ' + p + '/' + per + ' via ' + id);
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  console.log('');
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('OK: all ' + 'assertions passed');
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack || e));
  process.exit(1);
});
