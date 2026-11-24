#!/usr/bin/env node
// Behavioral regression coverage for the atomic billing write boundary.
// No live Redis, payment provider, credentials, or customer data are used: the
// fetch stub below models Upstash's command endpoint and serializes each EVAL.

import fs from 'node:fs';

process.env.KV_REST_API_URL = 'https://kv.atomic.test';
process.env.KV_REST_API_TOKEN = 'test-token';

const DAY = 86400000;
const store = new Map();
const sets = new Map();
let failNextEval = false;
let loseNextConfirmResponse = false;
let malformedNextRead = false;
let passes = 0;
let failures = 0;

function check(condition, label, detail = '') {
  if (condition) { passes++; console.log('  PASS ' + label); }
  else { failures++; console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
}

function readJson(key, fallback = null) {
  if (!store.has(key)) return fallback;
  return JSON.parse(store.get(key));
}

function writeJson(key, value) { store.set(key, JSON.stringify(value)); }

function removeFromIndex(code) {
  const index = readJson('billing:pending', []);
  if (!Array.isArray(index)) return null;
  return index.filter((value) => value !== code);
}

function applyEval(command) {
  const script = String(command[1]);
  const keyCount = Number(command[2]);
  const keys = command.slice(3, 3 + keyCount);
  const args = command.slice(3 + keyCount);

  if (script.includes('KESEFLE_MANUAL_PAYMENT_CREATE_V1')) {
    if (store.has(keys[3])) return { status: 'account_deleted' };
    const account = readJson(keys[2]);
    if (!account) return { status: 'account_missing' };
    if (account.userSub !== args[2]) return { status: 'user_identity_mismatch' };
    if (store.has(keys[0])) return { status: 'collision' };
    const index = readJson(keys[1], []);
    if (!Array.isArray(index)) return { status: 'malformed_index' };
    const userIndex = readJson(keys[4], []);
    if (!Array.isArray(userIndex)) return { status: 'malformed_user_index' };
    const payment = JSON.parse(args[0]);
    writeJson(keys[0], payment);
    writeJson(keys[1], [...index, args[1]]);
    writeJson(keys[4], [...userIndex, args[1]]);
    return { status: 'committed', payment };
  }

  if (script.includes('KESEFLE_MANUAL_PAYMENT_CONFIRM_V1')) {
    const payment = readJson(keys[0]);
    if (!payment) return { status: 'missing' };
    if (store.has(keys[3])) return { status: 'account_deleted' };
    if (payment.status === 'confirmed') {
      return {
        status: 'confirmed', replayed: true, payment,
        record: { plan: payment.plan, accessUntil: payment.accessUntil },
      };
    }
    if (payment.status === 'rejected') return { status: 'rejected', payment };
    if (payment.status !== 'pending' || payment.userSub !== args[4]) return { status: 'payment_changed' };
    const index = removeFromIndex(args[0]);
    if (!index) return { status: 'malformed_index' };
    const userIndex = readJson(keys[4], []).filter((value) => value !== args[0]);
    const record = readJson(keys[1]);
    if (!record) return { status: 'account_missing' };
    const current = Date.parse(record.accessUntil || '') || 0;
    const accessMs = Math.max(current, Number(args[1])) + Math.max(1, Number(payment.months) || 1) * 30 * DAY;
    Object.assign(record, {
      plan: payment.plan, subscriptionStatus: 'active', paymentMethod: payment.method,
      recurring: false, billingPeriod: payment.period === 'year' || payment.months >= 12 ? 'year' : 'month',
      accessUntil: new Date(accessMs).toISOString(), lastPaymentAt: args[2], lastPaymentRef: args[0],
    });
    const terminal = {
      code: args[0], status: 'confirmed', plan: payment.plan, period: payment.period,
      months: payment.months, amountILS: payment.amountILS, method: payment.method,
      confirmedAt: args[2], accessUntil: record.accessUntil, receipt: 'manual:' + args[0],
    };
    writeJson(keys[1], record);
    writeJson(keys[0], terminal);
    writeJson(keys[2], index);
    if (userIndex.length) writeJson(keys[4], userIndex); else store.delete(keys[4]);
    return { status: 'confirmed', replayed: false, payment, record };
  }

  if (script.includes('KESEFLE_MANUAL_PAYMENT_REJECT_V1')) {
    const payment = readJson(keys[0]);
    if (!payment) return { status: 'missing' };
    if (payment.status === 'confirmed') return { status: 'confirmed', payment };
    if (payment.status === 'rejected') return { status: 'rejected', replayed: true, payment };
    const index = removeFromIndex(args[0]);
    if (!index) return { status: 'malformed_index' };
    const userIndex = readJson(keys[2], []).filter((value) => value !== args[0]);
    const terminal = {
      code: args[0], status: 'rejected', plan: payment.plan, period: payment.period,
      months: payment.months, amountILS: payment.amountILS, method: payment.method,
      rejectedAt: args[1],
    };
    writeJson(keys[0], terminal);
    writeJson(keys[1], index);
    if (userIndex.length) writeJson(keys[2], userIndex); else store.delete(keys[2]);
    return { status: 'rejected', replayed: false, payment };
  }

  if (script.includes('KESEFLE_BILLING_ACTIVATE_V1')) {
    if (store.has(keys[1])) return { status: 'account_deleted' };
    const record = readJson(keys[0]);
    if (!record) return { status: 'account_missing' };
    if (keys[2] && store.has(keys[2])) return { status: 'replayed', record };
    const current = Date.parse(record.accessUntil || '') || 0;
    const next = args[5] === 'absolute'
      ? Math.max(current, Number(args[6]))
      : Math.max(current, Number(args[7])) + Math.max(1, Number(args[6])) * 30 * DAY;
    Object.assign(record, {
      userSub: record.userSub || args[0], plan: args[1], subscriptionStatus: 'active',
      paymentMethod: args[2], recurring: args[3] === '1', billingPeriod: args[4],
      accessUntil: new Date(next).toISOString(), lastPaymentAt: args[8],
    });
    if (args[9]) record.lastPaymentRef = args[9];
    if (record.recurring && args[9]) record.subscriptionId = args[9];
    writeJson(keys[0], record);
    if (keys[2]) store.set(keys[2], '1');
    return { status: 'applied', record };
  }

  if (script.includes('KESEFLE_USER_DELETION_MARK_V1')) {
    const state = store.get(keys[1]);
    if (state === 'deleted') return { status: 'deleted' };
    if (!store.has(keys[0]) && !state && args[1] !== '1') return { status: 'missing' };
    store.set(keys[1], 'deleting');
    return { status: 'deleting' };
  }

  if (script.includes('KESEFLE_USER_DELETION_FINALIZE_V1')) {
    if (store.has(keys[0])) return { status: 'user_present' };
    const state = store.get(keys[1]);
    if (!['deleting', 'deleted'].includes(state)) return { status: 'missing_marker' };
    store.set(keys[1], 'deleted');
    return { status: 'deleted' };
  }

  if (script.includes('KESEFLE_USER_RECORD_MERGE_V1')) {
    const created = !store.has(keys[0]);
    const deletionState = store.get(keys[1]);
    if (deletionState) {
      if (args[3] !== '1') return { status: 'account_deleted' };
      if (deletionState !== 'deleted' || !created) return { status: 'deletion_in_progress' };
    }
    if (created && args[2] === '1') return { status: 'missing' };
    const record = readJson(keys[0], { userSub: args[0] });
    const changes = JSON.parse(args[1]);
    if (created) Object.assign(record, changes.setOnCreate || {});
    for (const [field, value] of Object.entries(changes.setIfMissing || {})) {
      if (record[field] == null) record[field] = value;
    }
    Object.assign(record, changes.set || {});
    for (const [field, amount] of Object.entries(changes.increments || {})) {
      record[field] = (Number(record[field]) || 0) + Number(amount || 0);
    }
    for (const field of changes.deleteFields || []) delete record[field];
    record.userSub = args[0];
    writeJson(keys[0], record);
    if (deletionState && created && args[3] === '1') store.delete(keys[1]);
    return { status: 'merged', created, record };
  }

  if (script.includes('KESEFLE_BILLING_ACCOUNT_ASSERT_V1')) {
    if (store.has(keys[1])) return { status: 'account_deleted' };
    const record = readJson(keys[0]);
    if (!record) return { status: 'account_missing' };
    return record.userSub === args[0] ? { status: 'eligible' } : { status: 'user_identity_mismatch' };
  }

  if (script.includes('KESEFLE_BILLING_DEACTIVATE_V1')) {
    const record = readJson(keys[0]);
    if (!record) return { status: 'missing' };
    if (args[3] && record.subscriptionId !== args[3]) return { status: 'stale_subscription', record };
    Object.assign(record, { subscriptionStatus: args[1], recurring: false, canceledAt: args[2] });
    if (!record.accessUntil || record.accessUntil <= args[2]) record.plan = 'free';
    writeJson(keys[0], record);
    return { status: 'applied', record };
  }

  if (script.includes('KESEFLE_BILLING_RECONCILIATION_QUEUE_V1')) {
    store.set(keys[1], args[0]);
    const members = sets.get(keys[0]) || new Set();
    members.add(keys[1]);
    sets.set(keys[0], members);
    return { status: 'queued' };
  }

  if (script.includes('KESEFLE_BILLING_RECONCILIATION_RESOLVE_V1')) {
    store.delete(keys[1]);
    const members = sets.get(keys[0]) || new Set();
    members.delete(keys[1]);
    sets.set(keys[0], members);
    return { status: 'resolved' };
  }

  throw new Error('unexpected Lua script');
}

global.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('https://kv.atomic.test/get/')) {
    if (malformedNextRead) {
      malformedNextRead = false;
      return jsonResponse({ nope: true });
    }
    const key = decodeURIComponent(target.slice('https://kv.atomic.test/get/'.length));
    return jsonResponse({ result: store.has(key) ? store.get(key) : null });
  }
  if (target === 'https://kv.atomic.test' && options.method === 'POST') {
    if (failNextEval) {
      failNextEval = false;
      return jsonResponse({ error: 'forced' }, 503);
    }
    const command = JSON.parse(options.body);
    const result = applyEval(command);
    if (loseNextConfirmResponse && String(command[1]).includes('KESEFLE_MANUAL_PAYMENT_CONFIRM_V1')) {
      loseNextConfirmResponse = false;
      return jsonResponse({ result: 42 });
    }
    return jsonResponse({ result: JSON.stringify(result) });
  }
  throw new Error('unexpected fetch: ' + target);
};

const manual = await import('../api/billing/manual.js?atomic=' + Date.now());
const billing = await import('../lib/billing.js?atomic=' + Date.now());
const { createPendingPayment, confirmPendingPayment, rejectPendingPayment } = manual;
const {
  activatePremium, deactivatePremium, billingKvGet, assertBillingAccount,
  queueBillingReconciliation, resolveBillingReconciliation, billingReconciliationKey,
} = billing;
const { recordExpenseActivity } = await import('../lib/user-activity.js?atomic=' + Date.now());
const {
  atomicMergeUserRecord, userDeletionKey, markUserDeleted, finalizeUserDeletion,
} = await import('../lib/user-record.js?atomic=' + Date.now());

function pending(code, userSub) {
  return {
    code, userSub, plan: 'pro', period: 'month', months: 1, amountILS: 19,
    method: 'bit', status: 'pending', createdAt: new Date().toISOString(),
  };
}

console.log('\nAtomic pending creation:');
writeJson('user:user-a', { userSub: 'user-a', plan: 'free' });
writeJson('user:user-b', { userSub: 'user-b', plan: 'free' });
await Promise.all([
  createPendingPayment(pending('KFL-AAA222', 'user-a')),
  createPendingPayment(pending('KFL-BBB333', 'user-b')),
]);
check(readJson('billing:pending').length === 2, 'concurrent requests retain both index entries');
check((await createPendingPayment(pending('KFL-AAA222', 'user-a'))).status === 'collision', 'reference collision never overwrites a payment');

console.log('\nExact-once manual confirmation:');
writeJson('user:user-a', { userSub: 'user-a', plan: 'free', profileVersion: 7 });
const [first, replay] = await Promise.all([
  confirmPendingPayment('KFL-AAA222', 'admin@example.test'),
  confirmPendingPayment('KFL-AAA222', 'admin@example.test'),
]);
const confirmed = [first, replay].find((result) => result.replayed === false);
const duplicate = [first, replay].find((result) => result.replayed === true);
check(!!confirmed && !!duplicate, 'two concurrent confirms produce one commit and one replay');
check(readJson('user:user-a').profileVersion === 7, 'atomic confirmation preserves unrelated user fields');
const firstUntil = readJson('user:user-a').accessUntil;
check(readJson('billing:pending').includes('KFL-AAA222') === false, 'confirmation removes the pending index entry in the same commit');
check((await confirmPendingPayment('KFL-AAA222', 'admin@example.test')).record.accessUntil === firstUntil, 'retry returns the original receipt without extending access');

console.log('\nCommit followed by lost response:');
writeJson('user:user-lost', { userSub: 'user-lost', plan: 'free' });
await createPendingPayment(pending('KFL-LQST22', 'user-lost'));
loseNextConfirmResponse = true;
let lostThrew = false;
try { await confirmPendingPayment('KFL-LQST22', 'admin@example.test'); } catch { lostThrew = true; }
const committedUntil = readJson('pendingPayment:KFL-LQST22').accessUntil;
const recovered = await confirmPendingPayment('KFL-LQST22', 'admin@example.test');
check(lostThrew, 'malformed/lost commit response fails closed to the caller');
check(recovered.replayed === true && recovered.record.accessUntil === committedUntil, 'retry reconciles the committed receipt exactly once');
const terminalReceipt = readJson('pendingPayment:KFL-LQST22');
check(!terminalReceipt.userSub && !terminalReceipt.email && !terminalReceipt.phone,
  'terminal manual receipt contains no account or contact PII');
store.set(userDeletionKey('user-lost'), 'deleted');
store.delete('user:user-lost');
const deletedManualReplay = await confirmPendingPayment('KFL-LQST22', 'admin@example.test');
check(deletedManualReplay.replayed === true && !store.has('user:user-lost'),
  'manual payment retry cannot recreate a deleted account');
writeJson('user:pending-delete', { userSub: 'pending-delete', plan: 'free' });
await createPendingPayment(pending('KFL-DEL222', 'pending-delete'));
store.set(userDeletionKey('pending-delete'), 'deleting');
store.delete('user:pending-delete');
const deletedPending = await confirmPendingPayment('KFL-DEL222', 'admin@example.test');
check(deletedPending.status === 'account_deleted' && !store.has('user:pending-delete'),
  'pending manual payment is blocked once account deletion starts');

console.log('\nConfirm versus reject terminal state:');
writeJson('user:user-race', { userSub: 'user-race', plan: 'free' });
await createPendingPayment(pending('KFL-RACE22', 'user-race'));
const terminal = await Promise.all([
  confirmPendingPayment('KFL-RACE22', 'admin-a@example.test'),
  rejectPendingPayment('KFL-RACE22', 'admin-b@example.test'),
]);
const terminalState = readJson('pendingPayment:KFL-RACE22').status;
check(['confirmed', 'rejected'].includes(terminalState), 'race ends in one valid terminal state');
check(terminal.every((result) => result.status === terminalState), 'losing transition observes the winning terminal state');

console.log('\nKV failures are fail-closed:');
writeJson('user:user-fail', { userSub: 'user-fail', plan: 'free' });
const beforeKeys = store.size;
failNextEval = true;
let createFailed = false;
try { await createPendingPayment(pending('KFL-FAKL22', 'user-fail')); } catch { createFailed = true; }
check(createFailed && !store.has('pendingPayment:KFL-FAKL22') && store.size === beforeKeys, 'failed EVAL creates no payable reference or partial index write');
malformedNextRead = true;
let readFailed = false;
try { await billingKvGet('pendingPayment:any'); } catch { readFailed = true; }
check(readFailed, 'malformed KV reads throw instead of masquerading as missing data');

console.log('\nDurable billing reconciliation queue:');
const queueResult = await queueBillingReconciliation({
  provider: 'paypal', kind: 'paid_account_gone', externalId: 'SALE-QUEUE-1',
  details: { saleId: 'SALE-QUEUE-1', reason: 'paid_account_gone', email: 'must-not-persist@example.test' },
});
const queueKey = billingReconciliationKey('paypal', 'paid_account_gone', 'SALE-QUEUE-1');
const queueRecord = readJson(queueKey);
check(queueResult.key === queueKey && sets.get('billingReconcile:pending')?.has(queueKey),
  'queue item and discoverability index are committed together');
check(!queueKey.includes('SALE-QUEUE-1') && !JSON.stringify(queueRecord).includes('must-not-persist@example.test'),
  'queue key is hashed and non-allowlisted contact PII is discarded');
check(await resolveBillingReconciliation({ provider: 'paypal', kind: 'paid_account_gone', externalId: 'SALE-QUEUE-1' }),
  'operator resolution succeeds');
check(!store.has(queueKey) && !sets.get('billingReconcile:pending')?.has(queueKey),
  'resolution removes both record and index member atomically');

console.log('\nCanonical user partial merge:');
writeJson('user:login-user', {
  userSub: 'login-user', plan: 'pro', accessUntil: new Date(Date.now() + 30 * DAY).toISOString(),
  refreshToken: 'legacy-plaintext', connectedAt: '2020-01-01T00:00:00.000Z',
});
const loginMerge = await atomicMergeUserRecord('login-user', {
  set: { email: 'login@example.test', lastLoginAt: '2026-11-24T10:00:00.000Z' },
  setIfMissing: { connectedAt: 'should-not-replace' },
  setOnCreate: { plan: 'free', trialEndsAt: 'should-not-appear' },
  deleteFields: ['refreshToken'],
});
check(loginMerge.created === false && loginMerge.record.plan === 'pro', 'returning login preserves paid entitlement');
check(loginMerge.record.connectedAt === '2020-01-01T00:00:00.000Z' && !('refreshToken' in loginMerge.record),
  'partial merge preserves first connection and strips legacy plaintext token');
const newLogin = await atomicMergeUserRecord('new-login-user', {
  set: { email: 'new@example.test' },
  setOnCreate: { plan: 'free', trialEndsAt: '2099-01-01T00:00:00.000Z' },
});
check(newLogin.created === true && newLogin.record.trialEndsAt === '2099-01-01T00:00:00.000Z',
  'creation-only defaults apply exactly once');
writeJson('user:deleting-login', { userSub: 'deleting-login', plan: 'free' });
await markUserDeleted('deleting-login');
const blockedLogin = await atomicMergeUserRecord('deleting-login', { set: { email: 'retry@example.test' } }, { allowDeletedRecreate: true });
check(blockedLogin.reason === 'deletion_in_progress', 'OAuth cannot clear a tombstone while deletion still owns the account');
store.delete('user:deleting-login');
await finalizeUserDeletion('deleting-login');
const recreatedLogin = await atomicMergeUserRecord('deleting-login', {
  set: { email: 'back@example.test' }, setOnCreate: { plan: 'free' },
}, { allowDeletedRecreate: true });
check(recreatedLogin.created === true && !store.has(userDeletionKey('deleting-login')),
  'explicit signup atomically recreates a finalized deleted account and clears its tombstone');

console.log('\nShared provider entitlement boundary:');
writeJson('user:provider-user', { userSub: 'provider-user', plan: 'free', keepMe: 'yes' });
await Promise.all([
  activatePremium('provider-user', { plan: 'pro', method: 'crypto', months: 1, externalId: 'charge-1', activationKey: 'crypto:charge-1' }),
  activatePremium('provider-user', { plan: 'pro', method: 'crypto', months: 1, externalId: 'charge-2', activationKey: 'crypto:charge-2' }),
]);
const providerRecord = readJson('user:provider-user');
check(providerRecord.keepMe === 'yes', 'provider activation preserves unrelated account state');
check(Date.parse(providerRecord.accessUntil) - Date.now() > 59 * DAY, 'two distinct concurrent payments both extend access');
const staleSnapshot = { userSub: 'provider-user', plan: 'free', email: 'provider@example.test' };
await recordExpenseActivity({ userSub: 'provider-user', currentRecord: staleSnapshot });
check(readJson('user:provider-user').plan === 'pro' && readJson('user:provider-user').expensesCount === 1,
  'activity merge cannot overwrite a payment even when its caller holds a stale free snapshot');
const beforeReplay = providerRecord.accessUntil;
const providerReplay = await activatePremium('provider-user', { plan: 'pro', method: 'crypto', months: 1, externalId: 'charge-1', activationKey: 'crypto:charge-1' });
check(providerReplay.activationReplayed === true && readJson('user:provider-user').accessUntil === beforeReplay, 'provider retry is exact-once');
const activationMarkers = [...store.entries()].filter(([key]) => key.startsWith('billingActivation:'));
check(activationMarkers.length >= 2 && activationMarkers.every(([, value]) => value === '1')
  && ![...store.keys()].some((key) => key.includes('crypto:charge-1')),
  'payment markers are hash-only flags without account or provider PII');
store.set(userDeletionKey('provider-user'), '1');
store.delete('user:provider-user');
let deletedProviderBlocked = false;
try {
  await activatePremium('provider-user', { plan: 'pro', method: 'crypto', months: 1, externalId: 'charge-2', activationKey: 'crypto:charge-2' });
} catch (error) { deletedProviderBlocked = error.message === 'billing_account_deleted'; }
check(deletedProviderBlocked && !store.has('user:provider-user'),
  'provider webhook retry cannot recreate a deleted account');
let missingProviderBlocked = false;
try {
  await activatePremium('never-signed-up', { plan: 'pro', method: 'crypto', months: 1, activationKey: 'crypto:orphan' });
} catch (error) { missingProviderBlocked = error.message === 'billing_account_missing'; }
check(missingProviderBlocked && !store.has('user:never-signed-up'), 'billing never creates an account outside signup');
let deletedCheckoutBlocked = false;
try { await assertBillingAccount('provider-user'); }
catch (error) { deletedCheckoutBlocked = error.message === 'billing_account_deleted'; }
check(deletedCheckoutBlocked, 'checkout creation guard rejects a deleted account before provider contact');

writeJson('user:cancel-user', {
  userSub: 'cancel-user', plan: 'pro', recurring: true, subscriptionId: 'new-sub',
  accessUntil: new Date(Date.now() + 30 * DAY).toISOString(),
});
const staleCancel = await deactivatePremium('cancel-user', 'canceled', { expectedSubscriptionId: 'old-sub' });
check(staleCancel.deactivationSkipped === 'stale_subscription' && readJson('user:cancel-user').recurring === true, 'late cancellation cannot disable a replacement subscription');
await deactivatePremium('cancel-user', 'canceled', { expectedSubscriptionId: 'new-sub' });
check(readJson('user:cancel-user').subscriptionStatus === 'canceled' && readJson('user:cancel-user').recurring === false, 'matching cancellation applies atomically');

console.log('\nSource wiring:');
const manualSource = fs.readFileSync(new URL('../api/billing/manual.js', import.meta.url), 'utf8');
const paypalSource = fs.readFileSync(new URL('../api/billing/paypal.js', import.meta.url), 'utf8');
const cryptoSource = fs.readFileSync(new URL('../api/billing/crypto-webhook.js', import.meta.url), 'utf8');
const cryptoCreateSource = fs.readFileSync(new URL('../api/billing/crypto-create.js', import.meta.url), 'utf8');
const stripeWebhookSource = fs.readFileSync(new URL('../api/billing/webhook.js', import.meta.url), 'utf8');
const activitySource = fs.readFileSync(new URL('../lib/user-activity.js', import.meta.url), 'utf8');
const exchangeSource = fs.readFileSync(new URL('../api/auth/google-exchange.js', import.meta.url), 'utf8');
const unsubscribeSource = fs.readFileSync(new URL('../api/account/unsubscribe.js', import.meta.url), 'utf8');
const reprovisionSource = fs.readFileSync(new URL('../api/admin/reprovision-user-sheet.js', import.meta.url), 'utf8');
const accountSource = fs.readFileSync(new URL('../api/account.js', import.meta.url), 'utf8');
check(/KESEFLE_MANUAL_PAYMENT_(CREATE|CONFIRM|REJECT)_V1/.test(manualSource), 'manual create/confirm/reject use versioned atomic scripts');
check(/activationKey:\s*`paypal:/.test(paypalSource) && /expectedSubscriptionId:\s*subId/.test(paypalSource), 'PayPal activation and cancellation carry stable identity guards');
check(/activationKey:\s*`crypto:/.test(cryptoSource), 'Coinbase activation carries a stable payment key');
check(/assertBillingAccount/.test(paypalSource) && /assertBillingAccount/.test(cryptoCreateSource),
  'PayPal and Coinbase checkout creation reject deleted or missing accounts');
check(/requireExisting:\s*true/.test(stripeWebhookSource), 'legacy Stripe webhook cannot recreate a missing account');
check(/atomicMergeUserRecord/.test(activitySource) && !/\/set\/\$\{encodeURIComponent\('user:'/.test(activitySource),
  'expense activity uses a key-locked partial merge');
check(/atomicMergeUserRecord/.test(exchangeSource) && !/\/set\/\$\{encodeURIComponent\('user:'/.test(exchangeSource),
  'OAuth login uses a key-locked partial merge');
check(/atomicMergeUserRecord/.test(unsubscribeSource), 'email unsubscribe cannot replace billing fields from a stale snapshot');
check(/atomicMergeUserRecord/.test(reprovisionSource), 'admin sheet repair cannot replace billing fields from a stale snapshot');
check(/_beginDeletion_/.test(accountSource) && /userDeletionKey/.test(accountSource) && /userDeletionKey/.test(manualSource),
  'both account deletion and manual confirmation enforce the deletion tombstone');
check(/manualPaymentIndexKey/.test(accountSource) && /manual_payments:\s*manualPayments/.test(accountSource),
  'pending manual payments are discoverable for account export and deletion');
check(/cancelRecurringBillingForDeletion/.test(accountSource) && /paypalSub:/.test(accountSource),
  'account deletion cancels recurring PayPal billing and removes its reverse mapping');

console.log(`\n${failures ? '❌' : '✅'} ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
