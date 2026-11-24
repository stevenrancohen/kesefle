#!/usr/bin/env node
// Regression coverage for account deletion racing provider checkout creation.
// No network/secrets: executes the real handler functions with local stubs.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAYPAL = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');
const COINBASE = fs.readFileSync(path.join(ROOT, 'api/billing/crypto-create.js'), 'utf8');
const ACCOUNT = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
const KV_MONITOR = fs.readFileSync(path.join(ROOT, 'api/cron/kv-monitor.js'), 'utf8');
const LAUNCH_MONITOR = fs.readFileSync(path.join(ROOT, 'api/admin/launch-monitor.js'), 'utf8');

function fnSrc(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) {
    if (src[k] === '(') pd++;
    else if (src[k] === ')' && --pd === 0) { k++; break; }
  }
  let i = src.indexOf('{', k), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { j++; break; }
  }
  return src.slice(start, j);
}

const failures = [];
function check(value, label) {
  if (value) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}
function response() {
  return {
    statusCode: 0, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  const realFetch = global.fetch;
  const log = { info() {}, warn() {}, error() {} };

  console.log('\nPayPal post-create account recheck:');
  {
    const SITE = 'https://kesefle.test';
    let accountChecks = 0;
    let checkoutRegistrations = 0;
    const cancelled = [];
    const queued = [];
    function planIdFor() { return 'P-TEST'; }
    function paypalBase() { return 'https://paypal.test'; }
    async function getAccessToken() { return 'TOKEN'; }
    async function assertBillingAccount() {
      accountChecks++;
      return { userSub: 'user-race' };
    }
    async function registerPendingBillingCheckout() {
      checkoutRegistrations++;
      throw new Error('billing_account_deleted');
    }
    async function cancelPaypalSubscription(id) { cancelled.push(id); return false; }
    async function queueBillingReconciliation(item) { queued.push(item); return { ok: true }; }
    global.fetch = async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'I-ORPHAN',
        links: [{ rel: 'approve', href: 'https://paypal.test/secret-approval-url' }],
      }),
    });
    const subscribeImpl = eval('(' + fnSrc(PAYPAL, 'subscribeImpl') + ')'); // eslint-disable-line no-eval
    const res = response();
    await subscribeImpl({ reqId: 'race', user: { sub: 'user-race' }, body: { plan: 'pro', period: 'month' } }, res);
    check(accountChecks === 1 && checkoutRegistrations === 1,
      'provider object is atomically registered against the account tombstone after creation');
    check(res.statusCode === 410 && res.body?.error === 'account_deleted', 'deleted account receives 410');
    check(!res.body?.url, 'approval URL is never exposed after deletion');
    check(cancelled[0] === 'I-ORPHAN', 'new PayPal subscription is cancelled when possible');
    check(queued[0]?.kind === 'provider_checkout_orphaned' && queued[0]?.externalId === 'I-ORPHAN',
      'uncancelled PayPal subscription enters the durable reconciliation queue');
  }

  console.log('\nCoinbase post-create account recheck:');
  {
    let accountChecks = 0;
    let checkoutRegistrations = 0;
    const queued = [];
    async function assertBillingAccount() {
      accountChecks++;
      return { userSub: 'user-race' };
    }
    async function registerPendingBillingCheckout() {
      checkoutRegistrations++;
      throw new Error('billing_account_deleted');
    }
    async function queueBillingReconciliation(item) { queued.push(item); return { ok: true }; }
    function normalizePlan() { return 'pro'; }
    function priceUSD() { return 5.14; }
    function priceILS() { return 19; }
    const PLAN_LABELS = { pro: 'Pro' };
    global.fetch = async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'CH-ORPHAN', hosted_url: 'https://coinbase.test/secret-charge-url' } }),
    });
    const handlerImpl = eval('(' + fnSrc(COINBASE, 'handlerImpl') + ')'); // eslint-disable-line no-eval
    const savedKey = process.env.COINBASE_COMMERCE_API_KEY;
    process.env.COINBASE_COMMERCE_API_KEY = 'test-key';
    try {
      const res = response();
      await handlerImpl({ method: 'POST', reqId: 'race', user: { sub: 'user-race' }, body: { plan: 'pro' } }, res);
      check(accountChecks === 1 && checkoutRegistrations === 1,
        'charge is atomically registered against the account tombstone after creation');
      check(res.statusCode === 410 && res.body?.error === 'account_deleted', 'deleted account receives 410');
      check(!res.body?.url && !res.body?.hosted_url, 'hosted charge URL is never exposed after deletion');
      check(queued[0]?.provider === 'coinbase' && queued[0]?.kind === 'provider_checkout_orphaned' && queued[0]?.externalId === 'CH-ORPHAN',
        'orphaned Coinbase charge enters the durable reconciliation queue');
    } finally {
      if (savedKey === undefined) delete process.env.COINBASE_COMMERCE_API_KEY;
      else process.env.COINBASE_COMMERCE_API_KEY = savedKey;
    }
  }

  console.log('\nReturned URL followed by account deletion:');
  {
    const SITE = 'https://kesefle.test';
    const manifests = new Map();
    const cancelled = [];
    const queued = [];
    const COINBASE_LATE_PAYMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    let coinbaseCharge = { status: 'NEW', createdAt: new Date().toISOString(), expiresAt: null };
    function planIdFor() { return 'P-TEST'; }
    function paypalBase() { return 'https://paypal.test'; }
    async function getAccessToken() { return 'TOKEN'; }
    async function assertBillingAccount() { return { userSub: 'user-delete-after-url' }; }
    function pendingBillingCheckoutKey(userSub) { return 'manifest:' + userSub; }
    async function registerPendingBillingCheckout(userSub, item) {
      manifests.set(pendingBillingCheckoutKey(userSub), [item]);
      return { ok: true };
    }
    async function cancelPaypalSubscription(id) { cancelled.push(id); return true; }
    async function queueBillingReconciliation(item) { queued.push(item); return { ok: true }; }
    async function getCoinbaseChargeStatusForDeletion() { return coinbaseCharge; }
    async function kvGet(key) { return manifests.get(key) || null; }
    async function kvDel(key) { manifests.delete(key); return true; }
    global.fetch = async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'I-RETURNED', links: [{ rel: 'approve', href: 'https://paypal.test/returned-url' }],
      }),
    });
    const subscribeImpl = eval('(' + fnSrc(PAYPAL, 'subscribeImpl') + ')'); // eslint-disable-line no-eval
    const cancelPendingBillingCheckoutsForDeletion = eval(
      '(' + fnSrc(ACCOUNT, 'cancelPendingBillingCheckoutsForDeletion') + ')',
    ); // eslint-disable-line no-eval
    const res = response();
    await subscribeImpl({ reqId: 'returned', user: { sub: 'user-delete-after-url' }, body: {} }, res);
    check(res.statusCode === 200 && res.body?.url === 'https://paypal.test/returned-url',
      'hosted URL is returned only after its provider id is in the deletion manifest');
    const deleted = await cancelPendingBillingCheckoutsForDeletion('user-delete-after-url');
    check(deleted && cancelled[0] === 'I-RETURNED',
      'deletion after URL return cancels the provider object before purging the account');
    check(!manifests.has('manifest:user-delete-after-url'),
      'deletion removes the pending-checkout manifest only after cancellation succeeds');

    manifests.set('manifest:user-delete-after-url', [{ provider: 'coinbase', externalId: 'CH-LIVE' }]);
    const activeChargeDelete = await cancelPendingBillingCheckoutsForDeletion('user-delete-after-url');
    check(activeChargeDelete === false && manifests.has('manifest:user-delete-after-url'),
      'deletion remains retryable while Coinbase proves the hosted charge is still payable');
    coinbaseCharge = { status: 'EXPIRED', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() };
    const recentExpiredDelete = await cancelPendingBillingCheckoutsForDeletion('user-delete-after-url');
    check(recentExpiredDelete === false && manifests.has('manifest:user-delete-after-url'),
      'recently expired Coinbase charge stays protected during its late-payment window');
    coinbaseCharge = {
      status: 'EXPIRED',
      createdAt: new Date(Date.now() - (9 * 86400000)).toISOString(),
      expiresAt: new Date(Date.now() - (8 * 86400000)).toISOString(),
    };
    const oldExpiredDelete = await cancelPendingBillingCheckoutsForDeletion('user-delete-after-url');
    check(oldExpiredDelete === true && !manifests.has('manifest:user-delete-after-url'),
      'expired Coinbase charge becomes deletable only after the late-payment window');

    manifests.set('manifest:user-delete-after-url', [{ provider: 'coinbase', externalId: 'CH-PAID' }]);
    coinbaseCharge = { status: 'COMPLETED', createdAt: new Date().toISOString(), expiresAt: null };
    const paidChargeDelete = await cancelPendingBillingCheckoutsForDeletion('user-delete-after-url');
    check(paidChargeDelete === true && queued.some((item) => item.kind === 'paid_checkout_deleted'),
      'terminal paid Coinbase charge is queued for refund review before deletion continues');
  }

  console.log('\nReconciliation observability:');
  check(/billingReconcile:pending/.test(KV_MONITOR) && /Billing reconciliation required/.test(KV_MONITOR),
    'hourly cron pages when the durable billing queue is non-empty');
  check(/billingReconcile:pending/.test(LAUNCH_MONITOR) && /billingReconciliation/.test(LAUNCH_MONITOR),
    'admin launch monitor exposes pending reconciliation records');

  global.fetch = realFetch;
  if (failures.length) {
    console.error('\nFAIL: ' + failures.length + ' provider-race assertion(s) failed');
    process.exit(1);
  }
  console.log('\nOK: provider checkout deletion races fail closed');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
