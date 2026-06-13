#!/usr/bin/env node
// tests/test_paypal_golive.js
//
// Guards the PayPal go-live hardening (2026-06-12). Money code — every
// behavior below was a confirmed gap in the end-to-end audit:
//
//   1.  paypalBase(): PAYPAL_ENV selects sandbox vs live, DEFAULT sandbox
//       (no real charge can happen until the owner explicitly sets live).
//   2.  planIdFor(): choosing yearly with no *_YEAR env returns nothing
//       (subscribe → paypal_plan_not_configured) — NEVER silently bills the
//       monthly plan to a user who clicked the annual price.
//   3.  accessUntilFromNextBilling(): period-aware fallback — an annual payer
//       gets ~365d (+3d grace) when next_billing_time is missing, not 30d.
//   4.  webhookImpl(): signature-verification failure → 401, nothing written.
//   5.  webhookImpl(): ACTIVATED writes the paypalSub mapping + activates with
//       the exact KV shape (plan/period/method/recurring/externalId/accessUntil)
//       that computeEntitlement / _hasActivePremium_ / revenue.js read.
//   6.  webhookImpl(): idempotent — a replayed event id answers `duplicate`
//       and does NOT activate twice; seen-keys carry a 90d TTL.
//   7.  webhookImpl(): PAYMENT.SALE.COMPLETED arriving BEFORE ACTIVATED
//       (common PayPal ordering) falls back to the sale's custom field,
//       creates the mapping, activates, and issues the VAT invoice.
//   8.  webhookImpl(): a truly unmappable sale alerts the owner and is NOT
//       marked seen (a dashboard resend can re-process it later).
//   9.  webhookImpl(): CANCELLED/EXPIRED/SUSPENDED flip premium OFF.
//   10. confirmImpl() (return leg): activates only when PayPal reports ACTIVE
//       AND custom_id matches the signed-in user; idempotent vs the webhook.
//   11. setupPlansImpl(): KV-idempotent — re-running reuses the stored plan
//       ids instead of duplicating products/plans; {"force":true} overrides.
//   12. lib/billing.js activatePremium(): persists billingPeriod (read by
//       admin/revenue.js MRR math + billing/change-plan.js proration).
//   13. lib/billing.js kvSet(): optional ttlSec appends ?EX= (Upstash SET EX).
//   14. lib/billing.js cancelPaypalSubscription(): hits the right env base,
//       treats 204/422 as success, anything else as failure.
//   15. cancel-flow.js 'cancel': really cancels the PayPal sub + deactivates
//       (no more TODO + alert-only).
//   16. admin/revenue.js isTrial(): a lastPaymentRef payer is PAID, not trial.
//   17. Raw-body webhook verification + upgrade.html honest states/confirm leg
//       (textual contracts).
//
// Loads the REAL source via balanced-brace extraction (house pattern — no
// mocking framework, no network, no secrets; env values below are obvious
// dummies, never real credentials).
//   Run: node tests/test_paypal_golive.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PP = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');
const BILLING = fs.readFileSync(path.join(ROOT, 'lib/billing.js'), 'utf8');
const SUBSCRIPTION = fs.readFileSync(path.join(ROOT, 'lib/subscription.js'), 'utf8');
const CANCELFLOW = fs.readFileSync(path.join(ROOT, 'api/billing/cancel-flow.js'), 'utf8');
const REVENUE = fs.readFileSync(path.join(ROOT, 'api/admin/revenue.js'), 'utf8');
const UPGRADE_HTML = fs.readFileSync(path.join(ROOT, 'upgrade.html'), 'utf8');

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function eq(actual, expected, label) {
  assert(actual === expected, label + ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}

// ── balanced-brace helper (same as tests/test_paypal_annual_plans.js) ────────
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

console.log('\ntests/test_paypal_golive.js\n');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// Anchor the constants the extracted functions close over to the REAL source,
// so the suite fails loudly if they drift.
assert(/const GRACE_DAYS = 3;/.test(PP), 'paypal.js GRACE_DAYS is 3 (anchored)');
const GRACE_DAYS = 3;
assert(/SEEN_EVENT_TTL_SEC = 90 \* 24 \* 3600/.test(PP), 'paypal.js seen-event TTL is 90 days (anchored)');
const SEEN_EVENT_TTL_SEC = 90 * 24 * 3600;
const DAY_MS = DAY; // lib/subscription.js closes over DAY_MS

// Real pricing chain (priceILS -> normalizePlan -> PRICES), like the sibling suite.
const PREMIUM_PLANS = ['pro', 'family', 'business'];
const PRICES = eval('(' + balanced(BILLING, 'const PRICES = {', '{', '}') + ')');
eval(fnSrc(BILLING, 'normalizePlan'));
eval(fnSrc(BILLING, 'priceILS'));

// ── 1. PAYPAL_ENV: sandbox/live base selection, default SANDBOX ─────────────
console.log('Sandbox/live URL selection (paypalBase):');
eval(fnSrc(PP, 'paypalEnvName'));
eval(fnSrc(PP, 'paypalBase'));
{
  const saved = process.env.PAYPAL_ENV;
  delete process.env.PAYPAL_ENV;
  eq(paypalBase(), 'https://api-m.sandbox.paypal.com', 'PAYPAL_ENV unset -> SANDBOX base (safe default)');
  process.env.PAYPAL_ENV = 'sandbox';
  eq(paypalBase(), 'https://api-m.sandbox.paypal.com', 'PAYPAL_ENV=sandbox -> sandbox base');
  process.env.PAYPAL_ENV = 'live';
  eq(paypalBase(), 'https://api-m.paypal.com', 'PAYPAL_ENV=live -> live base');
  process.env.PAYPAL_ENV = 'LIVE';
  eq(paypalBase(), 'https://api-m.paypal.com', 'PAYPAL_ENV=LIVE (case-insensitive) -> live base');
  process.env.PAYPAL_ENV = 'garbage';
  eq(paypalBase(), 'https://api-m.sandbox.paypal.com', 'unknown PAYPAL_ENV value -> sandbox (fail-safe)');
  if (saved === undefined) delete process.env.PAYPAL_ENV; else process.env.PAYPAL_ENV = saved;
}

// ── 2. planIdFor: NO silent yearly->monthly fallback ─────────────────────────
console.log('\nplanIdFor (no silent yearly fallback):');
eval(fnSrc(PP, 'planIdFor'));
{
  const KEYS = ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR'];
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.PAYPAL_PLAN_PRO = 'P-PRO-M';
  process.env.PAYPAL_PLAN_FAMILY = 'P-FAM-M';
  assert(!planIdFor('pro', 'year'), 'pro/year with no PAYPAL_PLAN_PRO_YEAR -> falsy (NOT the monthly id)');
  assert(!planIdFor('family', 'year'), 'family/year with no PAYPAL_PLAN_FAMILY_YEAR -> falsy (NOT the monthly id)');
  eq(planIdFor('pro', 'month'), 'P-PRO-M', 'pro/month still resolves');
  eq(planIdFor('family', 'month'), 'P-FAM-M', 'family/month still resolves');
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}

// ── 3. accessUntilFromNextBilling: period-aware fallback ─────────────────────
console.log('\naccessUntilFromNextBilling (period-aware fallback):');
eval(fnSrc(PP, 'accessUntilFromNextBilling'));
{
  const nb = iso(Date.now() + 365 * DAY);
  eq(accessUntilFromNextBilling(nb, 'year'), iso(Date.parse(nb) + GRACE_DAYS * DAY),
    'explicit next_billing_time -> that time + 3d grace');
  const mFallback = Date.parse(accessUntilFromNextBilling(null, 'month')) - Date.now();
  assert(Math.abs(mFallback - 33 * DAY) < 60000, 'month fallback ~= 30d + 3d grace');
  const yFallback = Date.parse(accessUntilFromNextBilling(null, 'year')) - Date.now();
  assert(Math.abs(yFallback - 368 * DAY) < 60000, 'YEAR fallback ~= 365d + 3d grace (annual payer never lapses after 33d)');
}

// ── Async sections: webhook / confirm / setup-plans / lib/billing ────────────
(async () => {
  // Plan-id env for planFromPlanId round-trips inside the handlers.
  const PLAN_KEYS = ['PAYPAL_PLAN_PRO', 'PAYPAL_PLAN_PRO_YEAR', 'PAYPAL_PLAN_FAMILY', 'PAYPAL_PLAN_FAMILY_YEAR'];
  const savedPlans = {};
  for (const k of PLAN_KEYS) savedPlans[k] = process.env[k];
  process.env.PAYPAL_PLAN_PRO = 'P-PRO-M';
  process.env.PAYPAL_PLAN_PRO_YEAR = 'P-PRO-Y';
  process.env.PAYPAL_PLAN_FAMILY = 'P-FAM-M';
  process.env.PAYPAL_PLAN_FAMILY_YEAR = 'P-FAM-Y';

  eval(fnSrc(PP, 'planFromPlanId'));

  // Recording stubs for everything the handlers close over.
  let kv = {};
  let kvSetOpts = {};
  let activations = [];
  let deactivations = [];
  let ownerAlerts = [];
  let invoices = [];
  let subById = {};
  let verifyResult = true;
  async function getAccessToken() { return 'TOK'; }                       // eslint-disable-line no-unused-vars
  async function verifyWebhook() { return verifyResult; }                 // eslint-disable-line no-unused-vars
  async function billingKvGet(k) { return Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null; }
  async function billingKvSet(k, v, opts) { kv[k] = v; kvSetOpts[k] = opts || null; return true; }
  async function activatePremium(userSub, opts) { activations.push({ userSub, opts }); return { userSub }; }
  async function deactivatePremium(userSub, status) { deactivations.push({ userSub, status }); return {}; }
  async function getSubscription(_t, id) { return subById[id] || null; }  // eslint-disable-line no-unused-vars
  async function maybeIssueInvoiceForPayment(args) { invoices.push(args); } // eslint-disable-line no-unused-vars
  async function notifyOwner(msg) { ownerAlerts.push(msg); return true; } // eslint-disable-line no-unused-vars
  const log = { info() {}, warn() {}, error() {} };                       // eslint-disable-line no-unused-vars

  eval(fnSrc(PP, 'webhookImpl'));
  eval(fnSrc(PP, 'confirmImpl'));

  const mkRes = () => ({
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  });
  const hook = async (event) => { const r = mkRes(); await webhookImpl({ reqId: 't', body: event, rawBody: JSON.stringify(event) }, r); return r; };

  // ── 4. Signature verification: fail-closed ────────────────────────────────
  console.log('\nWebhook signature verification (fail-closed):');
  verifyResult = false;
  {
    const r = await hook({ id: 'WH-BAD', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-EVIL', custom_id: 'attacker', plan_id: 'P-PRO-M' } });
    eq(r.statusCode, 401, 'bad signature -> 401');
    eq(r.body && r.body.error, 'signature_invalid', 'bad signature -> signature_invalid');
    eq(activations.length, 0, 'bad signature -> NO activation');
    eq(Object.keys(kv).length, 0, 'bad signature -> NO KV writes');
  }
  verifyResult = true;

  // ── 5. ACTIVATED writes the exact KV shape ────────────────────────────────
  console.log('\nBILLING.SUBSCRIPTION.ACTIVATED:');
  const nextBillingY = iso(Date.now() + 365 * DAY);
  {
    const r = await hook({
      id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-SUB1', custom_id: 'user-1', plan_id: 'P-FAM-Y', billing_info: { next_billing_time: nextBillingY } },
    });
    eq(r.statusCode, 200, 'ACTIVATED -> 200');
    const map = kv['paypalSub:I-SUB1'];
    assert(map && map.userSub === 'user-1' && map.plan === 'family' && map.period === 'year',
      'paypalSub:<subId> mapping = {userSub, plan:family, period:year}');
    eq(activations.length, 1, 'exactly one activation');
    const a = activations[0];
    eq(a.userSub, 'user-1', 'activation targets custom_id user');
    eq(a.opts.plan, 'family', 'activation plan = family');
    eq(a.opts.period, 'year', 'activation period = year (billingPeriod source)');
    eq(a.opts.method, 'paypal', 'activation method = paypal');
    eq(a.opts.recurring, true, 'activation recurring = true');
    eq(a.opts.externalId, 'I-SUB1', 'activation externalId = subscription id');
    eq(a.opts.accessUntil, iso(Date.parse(nextBillingY) + GRACE_DAYS * DAY), 'accessUntil = next_billing_time + grace');
    const seen = kv['paypal_event:WH-1'];
    assert(!!seen, 'event marked seen after successful handling');
    eq(kvSetOpts['paypal_event:WH-1'] && kvSetOpts['paypal_event:WH-1'].ttlSec, SEEN_EVENT_TTL_SEC, 'seen key carries the 90d TTL');
  }

  // ── 6. Idempotency: replayed event id -> duplicate, no double-activate ────
  console.log('\nWebhook idempotency:');
  {
    const r = await hook({
      id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: { id: 'I-SUB1', custom_id: 'user-1', plan_id: 'P-FAM-Y', billing_info: { next_billing_time: nextBillingY } },
    });
    eq(r.statusCode, 200, 'replay -> 200');
    eq(r.body && r.body.duplicate, 'WH-1', 'replay answers duplicate:<eventId>');
    eq(activations.length, 1, 'replay does NOT activate a second time');
  }

  // ── 7. SALE.COMPLETED before ACTIVATED: custom fallback works ─────────────
  console.log('\nPAYMENT.SALE.COMPLETED arriving FIRST (out-of-order):');
  {
    subById['I-SUB2'] = {
      id: 'I-SUB2', custom_id: 'user-2', status: 'ACTIVE', plan_id: 'P-PRO-M',
      billing_info: { next_billing_time: iso(Date.now() + 30 * DAY) },
    };
    const r = await hook({
      id: 'WH-2', event_type: 'PAYMENT.SALE.COMPLETED',
      resource: { id: 'SALE-1', billing_agreement_id: 'I-SUB2', custom: 'user-2', amount: { total: '19.00' } },
    });
    eq(r.statusCode, 200, 'first-payment-before-activated -> 200');
    const map = kv['paypalSub:I-SUB2'];
    assert(map && map.userSub === 'user-2' && map.plan === 'pro' && map.period === 'month',
      'mapping created from the sale (custom fallback + plan_id lookup)');
    eq(activations.length, 2, 'sale activates the user (not silently dropped)');
    eq(activations[1].userSub, 'user-2', 'activation targets the custom user');
    eq(invoices.length, 1, 'VAT invoice issued for the first payment');
    eq(invoices[0].amountILS, 19, 'invoice amount = 19 ILS (Pro monthly)');
    eq(invoices[0].externalId, 'SALE-1', 'invoice keyed by the SALE id (per-renewal)');
    assert(!!kv['paypal_event:WH-2'], 'handled sale marked seen');
  }

  // ── 8. Unmappable sale: owner alerted, NOT marked seen ────────────────────
  console.log('\nUnmappable PAYMENT.SALE.COMPLETED:');
  {
    const before = ownerAlerts.length;
    const r = await hook({
      id: 'WH-3', event_type: 'PAYMENT.SALE.COMPLETED',
      resource: { id: 'SALE-2', billing_agreement_id: 'I-GHOST', amount: { total: '39.00' } },
    });
    eq(r.statusCode, 200, 'unmappable sale -> 200 (no retry storm)');
    eq(r.body && r.body.unmapped, true, 'response flags unmapped:true');
    eq(activations.length, 2, 'no activation for an unmappable sale');
    assert(ownerAlerts.length === before + 1, 'owner alerted (nothing fails silently)');
    assert(!kv['paypal_event:WH-3'], 'NOT marked seen -> a dashboard resend can re-process it');
  }

  // unmappable ACTIVATED (no custom_id) also alerts + stays unseen
  {
    const before = ownerAlerts.length;
    const r = await hook({ id: 'WH-3b', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-NOCUSTOM', plan_id: 'P-PRO-M' } });
    eq(r.body && r.body.unmapped, true, 'ACTIVATED without custom_id flags unmapped:true');
    assert(ownerAlerts.length === before + 1, 'ACTIVATED without custom_id alerts the owner');
    assert(!kv['paypal_event:WH-3b'], 'ACTIVATED without custom_id NOT marked seen');
  }

  // ── 9. Cancel/suspend events flip premium OFF ─────────────────────────────
  console.log('\nCancel / suspend lifecycle events:');
  for (const t of ['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.SUSPENDED']) {
    const before = deactivations.length;
    const r = await hook({ id: 'WH-C-' + t, event_type: t, resource: { id: 'I-SUB1' } });
    eq(r.statusCode, 200, t + ' -> 200');
    assert(deactivations.length === before + 1 &&
      deactivations[before].userSub === 'user-1' && deactivations[before].status === 'canceled',
      t + ' -> deactivatePremium(user-1, canceled)');
  }

  // ── 10. confirmImpl: the authed return leg ─────────────────────────────────
  console.log('\naction=confirm (return-leg activation):');
  const confirm = async (userSub, subscriptionId) => {
    const r = mkRes();
    await confirmImpl({ reqId: 't', user: { sub: userSub }, body: { subscriptionId } }, r);
    return r;
  };
  {
    let r = await confirm('user-9', 'not a sub id !!');
    eq(r.statusCode, 400, 'malformed subscription id -> 400');

    r = await confirm('user-9', 'I-MISSING');
    eq(r.statusCode, 404, 'unknown subscription -> 404');

    subById['I-C1'] = { id: 'I-C1', custom_id: 'someone-else', status: 'ACTIVE', plan_id: 'P-PRO-M', billing_info: {} };
    const beforeAct = activations.length;
    r = await confirm('user-9', 'I-C1');
    eq(r.statusCode, 403, "someone else's subscription -> 403 (custom_id must match the signed-in user)");
    eq(activations.length, beforeAct, 'mismatch does NOT activate');

    subById['I-C3'] = { id: 'I-C3', custom_id: 'user-9', status: 'APPROVAL_PENDING', plan_id: 'P-PRO-M', billing_info: {} };
    r = await confirm('user-9', 'I-C3');
    eq(r.statusCode, 409, 'non-ACTIVE subscription -> 409 (fail-closed)');

    const nb = iso(Date.now() + 30 * DAY);
    subById['I-C2'] = { id: 'I-C2', custom_id: 'user-9', status: 'ACTIVE', plan_id: 'P-FAM-M', billing_info: { next_billing_time: nb } };
    r = await confirm('user-9', 'I-C2');
    eq(r.statusCode, 200, 'matching ACTIVE subscription -> 200');
    eq(r.body && r.body.plan, 'family', 'confirm resolves plan from plan_id');
    eq(activations.length, beforeAct + 1, 'confirm activates exactly once');
    const a = activations[activations.length - 1];
    assert(a.userSub === 'user-9' && a.opts.method === 'paypal' && a.opts.recurring === true &&
      a.opts.externalId === 'I-C2' && a.opts.plan === 'family' && a.opts.period === 'month' &&
      a.opts.accessUntil === iso(Date.parse(nb) + GRACE_DAYS * DAY),
      'confirm activation has the same KV shape as the webhook path');
    assert(kv['paypalSub:I-C2'] && kv['paypalSub:I-C2'].userSub === 'user-9', 'confirm writes the paypalSub mapping too');

    // Idempotent vs the webhook: user record already reflects this sub.
    kv['user:user-9'] = { subscriptionId: 'I-C2', plan: 'family', accessUntil: iso(Date.parse(nb) + GRACE_DAYS * DAY) };
    r = await confirm('user-9', 'I-C2');
    eq(r.statusCode, 200, 'repeat confirm -> 200');
    eq(r.body && r.body.alreadyActive, true, 'repeat confirm answers alreadyActive');
    eq(activations.length, beforeAct + 1, 'repeat confirm does NOT re-activate (no duplicate WhatsApp)');
  }

  // ── 11. setup-plans idempotency (KV-stored plan ids) ───────────────────────
  console.log('\nsetup-plans idempotency:');
  {
    const createCalls = [];
    let _id = 0;
    async function createProduct() { return 'PROD-1'; }   // eslint-disable-line no-unused-vars
    async function createPlan(_t, _p, name, priceIls, intervalUnit) { createCalls.push({ name, priceIls, intervalUnit }); return 'PLAN-' + (++_id); }
    eval(fnSrc(PP, 'buildPlansToCreate'));
    eval(fnSrc(PP, 'setupPlansImpl'));

    const savedEnv = process.env.PAYPAL_ENV;
    delete process.env.PAYPAL_ENV; // -> sandbox

    // Existing record -> reuse, ZERO PayPal create calls.
    kv['paypal_plans:sandbox'] = {
      productId: 'PROD-OLD',
      PAYPAL_PLAN_PRO: 'OLD-PM', PAYPAL_PLAN_PRO_YEAR: 'OLD-PY',
      PAYPAL_PLAN_FAMILY: 'OLD-FM', PAYPAL_PLAN_FAMILY_YEAR: 'OLD-FY',
    };
    let r = mkRes();
    await setupPlansImpl({ reqId: 't', body: {} }, r);
    eq(r.statusCode, 200, 'rerun with stored ids -> 200');
    eq(r.body && r.body.reused, true, 'rerun answers reused:true');
    eq(r.body && r.body.PAYPAL_PLAN_PRO, 'OLD-PM', 'rerun echoes the STORED pro id (no duplicate plan)');
    eq(r.body && r.body.PAYPAL_PLAN_FAMILY_YEAR, 'OLD-FY', 'rerun echoes the STORED family-year id');
    eq(createCalls.length, 0, 'rerun issues ZERO createPlan calls');

    // force:true -> fresh creation + KV updated.
    r = mkRes();
    await setupPlansImpl({ reqId: 't', body: { force: true } }, r);
    eq(r.statusCode, 200, 'force:true -> 200');
    eq(createCalls.length, 4, 'force:true creates the 4 plans');
    assert(kv['paypal_plans:sandbox'] && kv['paypal_plans:sandbox'].PAYPAL_PLAN_PRO === r.body.PAYPAL_PLAN_PRO,
      'fresh ids persisted back to KV for the next rerun');

    // No record at all -> creates + persists.
    delete kv['paypal_plans:sandbox'];
    r = mkRes();
    await setupPlansImpl({ reqId: 't', body: {} }, r);
    eq(r.statusCode, 200, 'first run -> 200');
    eq(createCalls.length, 8, 'first run creates 4 more plans');
    assert(!!kv['paypal_plans:sandbox'], 'first run persists the ids in KV');

    if (savedEnv === undefined) delete process.env.PAYPAL_ENV; else process.env.PAYPAL_ENV = savedEnv;
  }

  // ── 12+13. lib/billing.js: activatePremium billingPeriod + kvSet TTL ──────
  console.log('\nlib/billing.js activatePremium persists billingPeriod:');
  {
    const store = {};
    async function kvGet(k) { return store[k] || null; }   // eslint-disable-line no-unused-vars
    async function kvSet(k, v) { store[k] = v; return true; }
    async function getUserPhone() { return null; }         // eslint-disable-line no-unused-vars
    async function sendWhatsApp() { return false; }        // eslint-disable-line no-unused-vars
    const PLAN_LABELS = { pro: 'Pro', family: 'Family' };  // eslint-disable-line no-unused-vars
    eval(fnSrc(SUBSCRIPTION, 'extendAccess'));
    eval(fnSrc(BILLING, 'activatePremium'));

    await activatePremium('u-year', {
      plan: 'family', period: 'year', method: 'paypal', recurring: true,
      externalId: 'I-Y1', accessUntil: iso(Date.now() + 368 * DAY),
    });
    const recY = store['user:u-year'];
    eq(recY && recY.billingPeriod, 'year', "period:'year' -> billingPeriod 'year' (revenue.js MRR /12 + change-plan proration)");
    eq(recY && recY.plan, 'family', 'plan stored');
    eq(recY && recY.subscriptionStatus, 'active', 'subscriptionStatus active');
    eq(recY && recY.subscriptionId, 'I-Y1', 'recurring externalId -> subscriptionId');
    eq(recY && recY.lastPaymentRef, 'I-Y1', 'externalId -> lastPaymentRef (revenue isTrial reads this)');

    await activatePremium('u-month', { plan: 'pro', period: 'month', method: 'paypal', recurring: true, externalId: 'I-M1', accessUntil: iso(Date.now() + 33 * DAY) });
    eq(store['user:u-month'] && store['user:u-month'].billingPeriod, 'month', "period:'month' -> billingPeriod 'month'");

    await activatePremium('u-crypto12', { plan: 'pro', method: 'crypto', months: 12, externalId: 'CH-1' });
    eq(store['user:u-crypto12'] && store['user:u-crypto12'].billingPeriod, 'year', 'no period + months:12 -> derived billingPeriod year');

    await activatePremium('u-manual1', { plan: 'pro', method: 'bit', months: 1, externalId: 'CODE-1' });
    eq(store['user:u-manual1'] && store['user:u-manual1'].billingPeriod, 'month', 'no period + months:1 -> derived billingPeriod month');
  }

  console.log('\nlib/billing.js kvSet TTL (?EX= for paypal_event keys):');
  {
    const savedUrl = process.env.KV_REST_API_URL;
    const savedTok = process.env.KV_REST_API_TOKEN;
    process.env.KV_REST_API_URL = 'https://kv.test';
    process.env.KV_REST_API_TOKEN = 'tok';
    eval(fnSrc(BILLING, 'kvSet'));
    const urls = [];
    const realFetch = global.fetch;
    global.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({}) }; };
    try {
      await kvSet('paypal_event:E1', { a: 1 }, { ttlSec: SEEN_EVENT_TTL_SEC });
      await kvSet('user:plain', { b: 2 });
    } finally { global.fetch = realFetch; }
    assert(urls[0].includes('?EX=' + SEEN_EVENT_TTL_SEC), 'kvSet with ttlSec appends ?EX=<seconds>');
    assert(!urls[1].includes('EX='), 'kvSet without ttlSec stays a plain SET (user records never expire)');
    if (savedUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = savedUrl;
    if (savedTok === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = savedTok;
  }

  // ── 14. cancelPaypalSubscription: env base + 204/422 semantics ────────────
  console.log('\nlib/billing.js cancelPaypalSubscription:');
  {
    eval(fnSrc(BILLING, 'paypalApiBase'));
    eval(fnSrc(BILLING, 'cancelPaypalSubscription'));
    const savedEnv = process.env.PAYPAL_ENV;
    const savedId = process.env.PAYPAL_CLIENT_ID;
    const savedSecret = process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_ENV;
    // Obvious dummies — NEVER real credentials.
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';

    const realFetch = global.fetch;
    const calls = [];
    let cancelStatus = 204;
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('/v1/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'T' }) };
      return { ok: cancelStatus < 300, status: cancelStatus, json: async () => ({}) };
    };
    try {
      let okCancel = await cancelPaypalSubscription('I-DEAD', 'test');
      eq(okCancel, true, '204 -> cancelled (true)');
      assert(calls[0].url.startsWith('https://api-m.sandbox.paypal.com'), 'PAYPAL_ENV unset -> token minted on SANDBOX (matches paypal.js)');
      assert(calls[1].url === 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-DEAD/cancel',
        'cancel POSTs /v1/billing/subscriptions/<id>/cancel');

      cancelStatus = 422;
      okCancel = await cancelPaypalSubscription('I-DEAD', 'test');
      eq(okCancel, true, '422 (already cancelled) -> true (no future charges either way)');

      cancelStatus = 500;
      okCancel = await cancelPaypalSubscription('I-DEAD', 'test');
      eq(okCancel, false, '500 -> false (caller falls back to the owner alert)');

      okCancel = await cancelPaypalSubscription('', 'test');
      eq(okCancel, false, 'missing subscription id -> false (no blind API call)');
    } finally {
      global.fetch = realFetch;
      if (savedEnv === undefined) delete process.env.PAYPAL_ENV; else process.env.PAYPAL_ENV = savedEnv;
      if (savedId === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = savedId;
      if (savedSecret === undefined) delete process.env.PAYPAL_CLIENT_SECRET; else process.env.PAYPAL_CLIENT_SECRET = savedSecret;
    }
  }

  // ── 15. cancel-flow really cancels (textual contract) ─────────────────────
  console.log('\ncancel-flow.js cancel action (contract):');
  assert(/cancelPaypalSubscription\(/.test(CANCELFLOW), "cancel-flow imports+calls cancelPaypalSubscription (the TODO is gone)");
  assert(/deactivatePremium\(userSub,\s*'canceled'\)/.test(CANCELFLOW), 'cancel-flow deactivates the entitlement');
  assert(!/TODO\(steven\)[\s\S]{0,120}cancel/i.test(CANCELFLOW), 'no more TODO-instead-of-cancel');
  assert(/paypalCancelled/.test(CANCELFLOW), 'cancel result surfaces in the response + owner alert');

  // ── 16. revenue.js isTrial counts lastPaymentRef payers as PAID ───────────
  console.log('\nadmin/revenue.js isTrial:');
  {
    eval(fnSrc(REVENUE, 'isTrial'));
    const twoDaysAgo = iso(Date.now() - 2 * DAY);
    eq(isTrial({ plan: 'pro', lastPaymentRef: 'CH-99', connectedAt: twoDaysAgo }), false,
      'crypto/Bit payer with lastPaymentRef inside the 14d window -> PAID, not trial');
    eq(isTrial({ plan: 'pro', connectedAt: twoDaysAgo }), true,
      'no payment ref inside the 14d window -> still counted as trial');
    eq(isTrial({ plan: 'pro', paymentMethod: 'paypal', connectedAt: twoDaysAgo }), false,
      'paypal payer -> not trial (unchanged)');
  }

  // ── 17. Raw-body verification + upgrade.html honest states (contracts) ────
  console.log('\nStatic contracts (raw body + upgrade.html):');
  assert(/bodyParser:\s*false/.test(PP), 'paypal.js disables the body parser (raw bytes for signature verify)');
  assert(/"webhook_event":'\s*\+\s*raw/.test(PP), 'verifyWebhook splices the RAW delivered bytes into the verify payload');
  assert(/readRawBody\(/.test(PP), 'router reads the raw body once for all actions');
  assert(/action=confirm/.test(UPGRADE_HTML) && /subscription_id/.test(UPGRADE_HTML),
    'upgrade.html fires the return-leg confirm with the subscription_id');
  assert(/credentials:\s*'include'/.test(UPGRADE_HTML), 'confirm call sends the session cookie');
  assert(/paypal === 'success'/.test(UPGRADE_HTML), 'celebratory state requires the EXPLICIT paypal=success param');
  assert(/if \(isSuccess\)/.test(UPGRADE_HTML), 'confetti gated on explicit success only');
  assert(/return_url: `\$\{SITE\}\/upgrade\?paypal=success`/.test(PP), 'subscribe return_url still lands on /upgrade?paypal=success');

  // restore plan env
  for (const k of PLAN_KEYS) {
    if (savedPlans[k] === undefined) delete process.env[k]; else process.env[k] = savedPlans[k];
  }

  console.log('');
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('OK: all assertions passed');
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack || e));
  process.exit(1);
});
