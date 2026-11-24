// lib/billing.js
// The ONE place premium gets switched on/off, no matter how the user paid
// (PayPal subscription, crypto, Bit, or bank transfer). Everything writes the
// canonical `user:<sub>` record so computeEntitlement / /api/whatsapp/link / the
// bot all see the same truth. Pricing + plan helpers live here too.

import crypto from 'node:crypto';
import { PREMIUM_PLANS } from './subscription.js';
import { userDeletionKey } from './user-record.js';

const BILLING_ACTIVATION_TTL_SEC = 400 * 24 * 3600;
const BILLING_RECONCILIATION_TTL_SEC = 400 * 24 * 3600;
const BILLING_RECONCILIATION_INDEX = 'billingReconcile:pending';
const PAYPAL_REQUEST_TIMEOUT_MS = 5000;

// ── Pricing ────────────────────────────────────────────────────────────────
// Monthly / yearly price in ILS. Yearly ≈ 10 months (2 free) to nudge annual.
const PRICES = {
  pro:    { month: 19, year: 190 },
  family: { month: 39, year: 390 },
};
const PLAN_LABELS = { pro: 'Pro', family: 'Family' };
// Rough ILS→USD for crypto charges (crypto amounts are inherently approximate).
const ILS_PER_USD = 3.7;

function normalizePlan(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'premium' || p === 'premium-monthly' || p === 'pro') return 'pro';
  if (p === 'family') return 'family';
  return PREMIUM_PLANS.includes(p) ? p : 'pro';
}

function periodMonths(period) {
  return String(period || '').toLowerCase() === 'year' ? 12 : 1;
}

function priceILS(plan, period) {
  const p = normalizePlan(plan);
  const tier = PRICES[p] || PRICES.pro;
  return period === 'year' ? tier.year : tier.month;
}

function priceUSD(plan, period) {
  return Math.max(1, Math.round((priceILS(plan, period) / ILS_PER_USD) * 100) / 100);
}

// ── KV (plain JSON; user:<sub> wraps an already-encrypted token envelope) ────
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('billing_kv_unavailable');
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('billing_kv_read_failed');
  const j = await r.json().catch(() => null);
  if (!j || !Object.prototype.hasOwnProperty.call(j, 'result')) {
    throw new Error('billing_kv_read_malformed');
  }
  if (j.result === null) return null;
  if (typeof j.result !== 'string') throw new Error('billing_kv_read_malformed');
  try { return JSON.parse(j.result); }
  catch { throw new Error('billing_kv_read_malformed'); }
}

// opts.ttlSec (optional) — Upstash SET with EX, for keys that must not grow the
// quota-monitored store forever (e.g. paypal_event:* idempotency guards).
async function kvSet(key, value, opts) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('billing_kv_unavailable');
  const ttlSec = opts && Number(opts.ttlSec) > 0 ? Math.floor(Number(opts.ttlSec)) : 0;
  const qs = ttlSec ? `?EX=${ttlSec}` : '';
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('billing_kv_write_failed');
  return true;
}

async function kvEval(script, keys, args = []) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('billing_kv_unavailable');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args]),
  });
  if (!r.ok) throw new Error('billing_kv_mutation_failed');
  const payload = await r.json().catch(() => null);
  if (!payload || typeof payload.result !== 'string') {
    throw new Error('billing_kv_mutation_malformed');
  }
  try { return JSON.parse(payload.result); }
  catch { throw new Error('billing_kv_mutation_malformed'); }
}

const QUEUE_BILLING_RECONCILIATION_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_BILLING_RECONCILIATION_QUEUE_V1
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[2]))
redis.call('SADD', KEYS[1], KEYS[2])
return cjson.encode({ status = 'queued' })`;

const RESOLVE_BILLING_RECONCILIATION_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_BILLING_RECONCILIATION_RESOLVE_V1
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[1], KEYS[2])
return cjson.encode({ status = 'resolved' })`;

function billingReconciliationKey(provider, kind, externalId) {
  const digest = crypto.createHash('sha256')
    .update(`${String(provider || '')}:${String(kind || '')}:${String(externalId || '')}`)
    .digest('hex');
  return `billingReconcile:${digest}`;
}

// Durable, privacy-minimized operator queue. The hourly KV monitor pages while
// this set is non-empty and the admin launch monitor exposes the records, so a
// failed WhatsApp alert cannot make real money disappear operationally.
async function queueBillingReconciliation({ provider, kind, externalId, details = {} }) {
  const normalizedProvider = String(provider || '').trim().slice(0, 40);
  const normalizedKind = String(kind || '').trim().slice(0, 80);
  const normalizedExternalId = String(externalId || '').trim().slice(0, 240);
  if (!normalizedProvider || !normalizedKind || !normalizedExternalId) {
    throw new Error('billing_reconciliation_identity_required');
  }
  const itemKey = billingReconciliationKey(normalizedProvider, normalizedKind, normalizedExternalId);
  const safeDetails = {};
  for (const field of ['eventId', 'saleId', 'subscriptionId', 'chargeId', 'reason', 'invoiceJobKey']) {
    if (details[field] != null) safeDetails[field] = String(details[field]).slice(0, 240);
  }
  const record = {
    v: 1,
    provider: normalizedProvider,
    kind: normalizedKind,
    externalId: normalizedExternalId,
    details: safeDetails,
    queuedAt: new Date().toISOString(),
  };
  const result = await kvEval(QUEUE_BILLING_RECONCILIATION_LUA, [
    BILLING_RECONCILIATION_INDEX, itemKey,
  ], [JSON.stringify(record), String(BILLING_RECONCILIATION_TTL_SEC)]);
  if (result?.status !== 'queued') throw new Error('billing_reconciliation_queue_failed');
  return { ok: true, key: itemKey };
}

async function resolveBillingReconciliation({ provider, kind, externalId }) {
  const itemKey = billingReconciliationKey(provider, kind, externalId);
  const result = await kvEval(RESOLVE_BILLING_RECONCILIATION_LUA, [
    BILLING_RECONCILIATION_INDEX, itemKey,
  ]);
  return result?.status === 'resolved';
}

// Upstash key-locking keeps the read, entitlement mutation, and payment marker
// in one atomic operation. The ISO helpers are intentionally inside Lua: a
// one-off payment must extend from the value that exists WHILE the key is
// locked, not from a stale value read by the serverless function beforehand.
const ACTIVATE_PREMIUM_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_BILLING_ACTIVATE_V1
local function days_from_civil(y, m, d)
  y = y - ((m <= 2) and 1 or 0)
  local era = math.floor(((y >= 0) and y or (y - 399)) / 400)
  local yoe = y - era * 400
  local mp = m + ((m > 2) and -3 or 9)
  local doy = math.floor((153 * mp + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

local function parse_iso_ms(value)
  if type(value) ~= 'string' then return nil end
  local y, mo, d, h, mi, s, frac = string.match(
    value,
    '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.(%d+)Z$'
  )
  if not y then
    y, mo, d, h, mi, s = string.match(
      value,
      '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)Z$'
    )
    frac = ''
  end
  if not y then return nil end
  local millis = tonumber(string.sub((frac or '') .. '000', 1, 3)) or 0
  return days_from_civil(tonumber(y), tonumber(mo), tonumber(d)) * 86400000
    + tonumber(h) * 3600000 + tonumber(mi) * 60000 + tonumber(s) * 1000 + millis
end

local function civil_from_days(z)
  z = z + 719468
  local era = math.floor(((z >= 0) and z or (z - 146096)) / 146097)
  local doe = z - era * 146097
  local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524)
    - math.floor(doe / 146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
  local mp = math.floor((5 * doy + 2) / 153)
  local d = doy - math.floor((153 * mp + 2) / 5) + 1
  local m = mp + ((mp < 10) and 3 or -9)
  y = y + ((m <= 2) and 1 or 0)
  return y, m, d
end

local function iso_from_ms(ms)
  local whole = math.floor(ms)
  local days = math.floor(whole / 86400000)
  local day_ms = whole - days * 86400000
  local h = math.floor(day_ms / 3600000)
  day_ms = day_ms - h * 3600000
  local mi = math.floor(day_ms / 60000)
  day_ms = day_ms - mi * 60000
  local s = math.floor(day_ms / 1000)
  local millis = day_ms - s * 1000
  local y, mo, d = civil_from_days(days)
  return string.format('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ', y, mo, d, h, mi, s, millis)
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end

local raw = redis.call('GET', KEYS[1])
local record = { userSub = ARGV[1] }
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then
    return cjson.encode({ status = 'malformed_user_record' })
  end
  record = decoded
end
if record['userSub'] and tostring(record['userSub']) ~= ARGV[1] then
  return cjson.encode({ status = 'user_identity_mismatch' })
end
if not raw then
  return cjson.encode({ status = 'account_missing' })
end

-- A payment endpoint must never create an account. Signup is the only place
-- allowed to create user:<sub>; this also closes a delete/webhook race.
if not record['userSub'] then
  return cjson.encode({ status = 'account_missing' })
end

if #KEYS > 2 and redis.call('EXISTS', KEYS[3]) == 1 then
  return cjson.encode({ status = 'replayed', record = record })
end

local now_ms = tonumber(ARGV[8])
local current_ms = parse_iso_ms(record['accessUntil']) or 0
local new_ms
if ARGV[6] == 'absolute' then
  local requested_ms = tonumber(ARGV[7])
  if not requested_ms then return cjson.encode({ status = 'invalid_access_until' }) end
  new_ms = math.max(current_ms, requested_ms)
else
  local months = math.max(1, tonumber(ARGV[7]) or 1)
  new_ms = math.max(current_ms, now_ms) + months * 30 * 86400000
end

record['userSub'] = record['userSub'] or ARGV[1]
record['plan'] = ARGV[2]
record['subscriptionStatus'] = 'active'
record['paymentMethod'] = ARGV[3]
record['recurring'] = ARGV[4] == '1'
record['billingPeriod'] = ARGV[5]
record['accessUntil'] = iso_from_ms(new_ms)
record['lastPaymentAt'] = ARGV[9]
if ARGV[10] ~= '' then record['lastPaymentRef'] = ARGV[10] end
if ARGV[4] == '1' and ARGV[10] ~= '' then record['subscriptionId'] = ARGV[10] end

redis.call('SET', KEYS[1], cjson.encode(record))
if #KEYS > 2 then
  local ttl = tonumber(ARGV[11]) or 0
  if ttl > 0 then
    redis.call('SET', KEYS[3], '1', 'EX', ttl)
  else
    redis.call('SET', KEYS[3], '1')
  end
end
return cjson.encode({ status = 'applied', record = record })`;

const DEACTIVATE_PREMIUM_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_BILLING_DEACTIVATE_V1
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ status = 'missing' }) end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' then
  return cjson.encode({ status = 'malformed_user_record' })
end
local expected = ARGV[4]
if expected ~= '' and tostring(record['subscriptionId'] or '') ~= expected then
  return cjson.encode({ status = 'stale_subscription', record = record })
end
record['subscriptionStatus'] = ARGV[2]
record['recurring'] = false
record['canceledAt'] = ARGV[3]
local access_until = tostring(record['accessUntil'] or '')
if access_until == '' or access_until <= ARGV[3] then record['plan'] = 'free' end
redis.call('SET', KEYS[1], cjson.encode(record))
return cjson.encode({ status = 'applied', record = record })`;

const ASSERT_BILLING_ACCOUNT_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_BILLING_ACCOUNT_ASSERT_V1
if redis.call('EXISTS', KEYS[2]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ status = 'account_missing' }) end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' then
  return cjson.encode({ status = 'malformed_user_record' })
end
if tostring(record['userSub'] or '') ~= ARGV[1] then
  return cjson.encode({ status = 'user_identity_mismatch' })
end
return cjson.encode({ status = 'eligible' })`;

// ── WhatsApp helpers ─────────────────────────────────────────────────────────
function metaCreds() {
  return {
    token: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
    phoneId: process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

// Fire-and-forget WhatsApp text. Never throws — billing must not fail because a
// notification couldn't be delivered.
async function sendWhatsApp(toPhone, body) {
  try {
    const { token, phoneId } = metaCreds();
    if (!token || !phoneId || !toPhone) return false;
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toPhone).replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body },
      }),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

async function getUserPhone(userSub) {
  const rec = await kvGet(`userPhone:${userSub}`);
  if (!rec) return null;
  return typeof rec === 'string' ? rec : rec.phone || null;
}

// Alert the business owner (Steven) about something needing attention.
async function notifyOwner(body) {
  const owner = String(process.env.KESEFLE_OWNER_PHONE || '972547760643').replace(/[^0-9]/g, '');
  return sendWhatsApp(owner, body);
}

// ── Activation / deactivation ────────────────────────────────────────────────
// Turn premium ON. Used by every payment path.
//   plan       — 'pro' | 'family'
//   method     — 'paypal' | 'crypto' | 'bit' | 'bank'
//   period     — 'month' | 'year' (billing cycle; derived from `months` when
//                absent). Persisted as rec.billingPeriod — admin/revenue.js
//                (annual MRR normalization) and billing/change-plan.js
//                (proration) both read it, so dropping it silently miscounts
//                annual subscribers' money.
//   months     — prepaid length (ignored when `accessUntil` is given)
//   accessUntil— explicit ISO end (recurring webhooks pass next_billing_time+grace)
//   externalId — provider charge/subscription id (for audit + idempotency)
//   recurring  — true for PayPal subscriptions (auto-renews)
//   activationKey — stable logical payment id; makes retries exact-once
//   activationTtlSec — optional marker lifetime (defaults to 400 days)
async function activatePremium(userSub, opts = {}) {
  if (!userSub) return null;
  const {
    plan = 'pro', method = 'manual', period = null, months = 1,
    accessUntil = null, externalId = null, recurring = false,
    activationKey = null, activationTtlSec = BILLING_ACTIVATION_TTL_SEC,
  } = opts;
  const now = new Date();
  const normalizedPlan = normalizePlan(plan);
  const billingPeriod = (period ? period === 'year' : Number(months) >= 12) ? 'year' : 'month';
  const normalizedActivationKey = String(activationKey || '').trim().slice(0, 240);
  const keys = [`user:${userSub}`, userDeletionKey(userSub)];
  if (normalizedActivationKey) {
    const digest = crypto.createHash('sha256')
      .update(String(userSub)).update('\0').update(normalizedActivationKey)
      .digest('hex');
    keys.push(`billingActivation:${digest}`);
  }
  let accessMode = 'months';
  let accessValue = String(Math.max(1, Number(months) || 1));
  if (accessUntil) {
    const accessMs = Date.parse(accessUntil);
    if (!Number.isFinite(accessMs)) throw new Error('billing_access_until_invalid');
    accessMode = 'absolute';
    accessValue = String(accessMs);
  }
  const result = await kvEval(ACTIVATE_PREMIUM_LUA, keys, [
    String(userSub), normalizedPlan, String(method || 'manual'), recurring ? '1' : '0',
    billingPeriod, accessMode, accessValue, String(now.getTime()), now.toISOString(),
    externalId ? String(externalId).slice(0, 240) : '',
    String(Math.max(0, Math.floor(Number(activationTtlSec) || 0))),
  ]);
  if (result?.status === 'account_deleted') throw new Error('billing_account_deleted');
  if (result?.status === 'account_missing') throw new Error('billing_account_missing');
  if (result?.status === 'malformed_user_record') throw new Error('billing_user_record_malformed');
  if (result?.status === 'user_identity_mismatch') throw new Error('billing_user_identity_mismatch');
  if (result?.status === 'invalid_access_until') throw new Error('billing_access_until_invalid');
  if (!['applied', 'replayed'].includes(result?.status) || !result.record) {
    throw new Error('billing_activation_failed');
  }
  const rec = result.record;
  if (result.status === 'replayed') {
    return { ...rec, activationReplayed: true };
  }

  // Tell the customer on WhatsApp (best-effort).
  const phone = await getUserPhone(userSub).catch(() => null);
  if (phone) {
    const label = PLAN_LABELS[rec.plan] || 'Premium';
    const until = new Date(rec.accessUntil);
    const untilStr = `${until.getDate()}/${until.getMonth() + 1}/${until.getFullYear()}`;
    const line = recurring
      ? `המנוי יתחדש אוטומטית. החיוב הבא בערך ב-${untilStr}.`
      : `בתוקף עד ${untilStr}.`;
    await sendWhatsApp(phone, `✅ הפרימיום שלך (${label}) פעיל! 🎉\n${line}\n\nתודה שבחרת בכספ'לה 💚`);
  }
  return rec;
}

// Verify that a signed-in account still exists and is not being deleted before
// creating any external checkout or payable manual instruction.
async function assertBillingAccount(userSub) {
  const normalizedSub = String(userSub || '').trim();
  if (!normalizedSub) throw new Error('billing_account_missing');
  const result = await kvEval(ASSERT_BILLING_ACCOUNT_LUA, [
    `user:${normalizedSub}`, userDeletionKey(normalizedSub),
  ], [normalizedSub]);
  if (result?.status === 'eligible') return true;
  if (result?.status === 'account_deleted') throw new Error('billing_account_deleted');
  if (result?.status === 'account_missing') throw new Error('billing_account_missing');
  if (result?.status === 'malformed_user_record') throw new Error('billing_user_record_malformed');
  if (result?.status === 'user_identity_mismatch') throw new Error('billing_user_identity_mismatch');
  throw new Error('billing_account_check_failed');
}

// Turn premium OFF (cancellation / expiry / refund). We keep accessUntil so the
// customer rides out a period they already paid for; computeEntitlement lapses
// them automatically once it passes.
async function deactivatePremium(userSub, status = 'canceled', opts = {}) {
  if (!userSub) return null;
  const nowIso = new Date().toISOString();
  const result = await kvEval(DEACTIVATE_PREMIUM_LUA, [`user:${userSub}`], [
    String(userSub), String(status || 'canceled'), nowIso,
    opts.expectedSubscriptionId ? String(opts.expectedSubscriptionId).slice(0, 240) : '',
  ]);
  if (result?.status === 'missing') return null;
  if (result?.status === 'malformed_user_record') throw new Error('billing_user_record_malformed');
  if (result?.status === 'stale_subscription') {
    return { ...result.record, deactivationSkipped: 'stale_subscription' };
  }
  if (result?.status !== 'applied' || !result.record) throw new Error('billing_deactivation_failed');
  return result.record;
}

// ── PayPal subscription cancel (used by api/billing/cancel-flow.js) ──────────
// A customer who cancels in-product must actually STOP being charged — leaving
// the PayPal subscription running until the owner manually processes an alert
// is both a money bug and Israeli consumer-protection exposure. Best-effort:
// returns true only when PayPal confirms the cancel (204), or when a follow-up
// status read proves a 422 subscription is already CANCELLED/EXPIRED.
function paypalApiBase() {
  // DEFAULT SANDBOX — must match api/billing/paypal.js's paypalBase(). Money
  // only moves after the owner sets PAYPAL_ENV=live (PAYPAL_GO_LIVE_RUNBOOK).
  return String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function paypalFetchWithDeadline(url, init = {}, { parseJson = false, timeoutMs = PAYPAL_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('paypal_request_timeout'));
    }, Math.max(10, Number(timeoutMs) || PAYPAL_REQUEST_TIMEOUT_MS));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!parseJson) return { response, payload: null };
        const payload = await response.json().catch(() => null);
        return { response, payload };
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelPaypalSubscription(subscriptionId, reason = 'customer requested cancellation') {
  try {
    const id = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret || !subscriptionId) return false;
    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const tokenResult = await paypalFetchWithDeadline(`${paypalApiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }, { parseJson: true });
    const t = tokenResult.response;
    const tj = tokenResult.payload || {};
    if (!t.ok || !tj.access_token) return false;
    const subscriptionUrl = `${paypalApiBase()}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`;
    const cancelResult = await paypalFetchWithDeadline(`${subscriptionUrl}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: String(reason).slice(0, 127) }),
    });
    const r = cancelResult.response;
    if (r.status === 204) return true;
    if (r.status !== 422) return false;
    // 422 is a generic PayPal business-validation error, not proof of an
    // already-dead subscription. Read the authoritative state and accept only
    // terminal statuses that cannot charge again.
    const statusResult = await paypalFetchWithDeadline(subscriptionUrl, {
      headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
    }, { parseJson: true });
    if (!statusResult.response.ok) return false;
    const status = String(statusResult.payload?.status || '').toUpperCase();
    return status === 'CANCELLED' || status === 'EXPIRED';
  } catch (_e) {
    return false;
  }
}

export {
  PRICES,
  PLAN_LABELS,
  normalizePlan,
  periodMonths,
  priceILS,
  priceUSD,
  activatePremium,
  assertBillingAccount,
  deactivatePremium,
  cancelPaypalSubscription,
  paypalFetchWithDeadline,
  queueBillingReconciliation,
  resolveBillingReconciliation,
  billingReconciliationKey,
  sendWhatsApp,
  notifyOwner,
  getUserPhone,
  kvGet as billingKvGet,
  kvSet as billingKvSet,
  kvEval as billingKvEval,
  BILLING_ACTIVATION_TTL_SEC,
  BILLING_RECONCILIATION_TTL_SEC,
  BILLING_RECONCILIATION_INDEX,
  QUEUE_BILLING_RECONCILIATION_LUA,
  RESOLVE_BILLING_RECONCILIATION_LUA,
};
