// /api/account
// Consolidated account router — handles self-serve account operations via ?action= query param.
// This pattern keeps the project under Vercel Hobby's 12-function limit.
//
// Replaces:
//   /api/account/delete  (POST ?action=delete)
//   /api/account/export  (GET  ?action=export)
//
// Actions:
//   POST ?action=delete  body: { confirmation: 'DELETE-MY-ACCOUNT' }
//   GET  ?action=export  (returns a JSON download with all account data)
//
// All require authenticated user (requireAuth — verified Google ID token).
// Per Israeli Privacy Protection Law Amendment 13 + GDPR Articles 17 & 20.

import { requireAuth } from '../lib/auth.js';
import { createHmac } from 'node:crypto';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { decryptRefreshToken, constantTimeEqual } from '../lib/crypto.js';
import { exchangeRefreshForAccess } from '../lib/oauth.js';
import { TX_TAB } from '../lib/sheet-tabs.js';
import { migrateLegacyReferralPii } from '../lib/referral-privacy.js';
import { auditLog } from '../lib/secure-kv.js';
import {
  userDeletionKey, manualPaymentIndexKey, DELETION_TOMBSTONE_TTL_SEC,
} from '../lib/user-record.js';
import {
  cancelPaypalSubscription, pendingBillingCheckoutKey, queueBillingReconciliation,
} from '../lib/billing.js';
// GDPR completeness (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md): goals are
// stored as one key per goal under an index, so a flat key list can't reach
// them. purgeGoals() walks the goals:{userSub} index and deletes each
// goal:{userSub}:{id} plus the index itself.
import { purgeGoals } from '../lib/goals.js';

const ACCOUNT_IO_TIMEOUT_MS = 3000;
const DELETION_RECEIPT_TTL_SEC = 7 * 86400;
const DELETION_GUARD_COOLDOWN_SEC = 10 * 60;
const MANUAL_PAYMENT_CODE_RE = /^KFL-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const MANUAL_PAYMENT_INDEX_MAX = 1000;
// Legacy Coinbase Commerce can still detect a late payment for up to seven
// days after charge creation. An EXPIRED/FAILED state is therefore not enough
// on its own to prove that deleting the account cannot orphan a payment.
const COINBASE_LATE_PAYMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Destructive account operations must not wait forever after earlier steps
// have already succeeded. Abort the underlying request and also race it so a
// test double (or non-compliant fetch implementation) that ignores AbortSignal
// still cannot strand the HTTP response.
async function _withDeadline_(operation, timeoutMs = ACCOUNT_IO_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('account_io_timeout'));
    }, Math.max(10, Number(timeoutMs) || ACCOUNT_IO_TIMEOUT_MS));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function _fetchWithDeadline_(url, init = {}, timeoutMs = ACCOUNT_IO_TIMEOUT_MS) {
  return _withDeadline_(
    (signal) => fetch(url, { ...init, signal }),
    timeoutMs,
  );
}

// Keep the deadline active through response-body parsing. A server can send
// headers and then stall forever; destructive flows must treat that as an
// outage, not as a missing record or a completed command.
async function _fetchJsonWithDeadline_(url, init = {}, timeoutMs = ACCOUNT_IO_TIMEOUT_MS) {
  return _withDeadline_(async (signal) => {
    const response = await fetch(url, { ...init, signal });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('account_io_malformed_json'); }
    return { response, payload };
  }, timeoutMs);
}

async function kvGet(key, { allowRawString = false } = {}) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('kv_unavailable');
  const { response, payload } = await _fetchJsonWithDeadline_(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('kv_read_failed');
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'result')) {
    throw new Error('kv_read_malformed');
  }
  if (payload.result === null) return null;
  if (typeof payload.result !== 'string') throw new Error('kv_read_malformed');
  let parsed;
  try { parsed = JSON.parse(payload.result); }
  catch {
    if (allowRawString && payload.result.length > 0) return payload.result;
    throw new Error('kv_read_malformed');
  }
  if (parsed === null) throw new Error('kv_read_malformed');
  return parsed;
}

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await _fetchWithDeadline_(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

async function kvDeleteReferralReverseIfOwned(code, userSub) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token || !code || !userSub) throw new Error('kv_unavailable');
  const script = `#!lua flags=allow-key-locking
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ status = 'missing' }) end
local ok, decoded = pcall(cjson.decode, raw)
local owner = ok and (type(decoded) == 'string' or type(decoded) == 'number') and tostring(decoded) or raw
if owner ~= ARGV[1] then return cjson.encode({ status = 'foreign' }) end
redis.call('DEL', KEYS[1])
return cjson.encode({ status = 'deleted' })`;
  try {
    const transport = await _fetchJsonWithDeadline_(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', script, '1', 'referral:reverse:' + code, userSub]),
    });
    const { response, payload } = transport;
    if (!response.ok) throw new Error('reverse_delete_failed');
    if (typeof payload?.result !== 'string') throw new Error('reverse_delete_malformed');
    const result = JSON.parse(payload.result);
    if (!['deleted', 'missing', 'foreign'].includes(result?.status)) throw new Error('reverse_delete_malformed');
    return result.status;
  } catch {
    throw new Error('referral_reverse_delete_unavailable');
  }
}

// Remove ONE member from a KV set (Upstash REST: POST /srem/<key>/<member>).
// Used to evict a deleted user from the `users_all` index set on account
// deletion. A DEL can't do this — the set persists and only the matching
// member must go. Best-effort: a missing member is a no-op (SREM returns 0).
async function kvSetRemove(setKey, member) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await _fetchWithDeadline_(
    `${url}/srem/${encodeURIComponent(setKey)}/${encodeURIComponent(member)}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } },
  );
  return r.ok;
}

// 2026-05-29 resweep R1: single source of truth for "every KV key that holds
// per-user state". Previously the cookie-auth deleteAccount() path and the
// bot-secret deleteByPhone() path each maintained their own list, and they
// drifted: the web path missed profile/recurring/memberGroup/reminders/nps/
// testimonial; the bot path missed referral:code/referral:reverse.
//
// The full list is enumerated from `grep -rnE "/set/" --include='*.js' api/ lib/`
// (29 distinct prefixes across the codebase). Phone-keyed entries are only
// included when `phone` is provided; userSub-keyed entries are always included.
// Referral-reverse is removed separately with a compare-owner EVAL.
async function _keysForUser_(userSub, phone, subscriptionId) {
  const keys = [
    // Identity / auth core (both flows already had these)
    'user:' + userSub,
    'sheet:' + userSub,
    'token:' + userSub,          // legacy plaintext token store — GDPR purge
    'userPhone:' + userSub,
    // 2026-05-31 audit fix (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md #2):
    // Legacy GIS one-tap path in api/auth/google.js wrote to user:google:{sub}
    // instead of user:{sub}. Records persist past delete unless we also try
    // this orphan namespace. Best-effort: KV DEL of a missing key is a no-op.
    'user:google:' + userSub,
    // Referral mapping (only the web flow had these; bot flow missed them)
    'referral:code:' + userSub,
    // Web push subscription
    'push_sub:' + userSub,
    // NPS submission (free-text comment is PII)
    'nps:' + userSub,
    // Submitted testimonial (free text + name + plan, possibly displayed
    // publicly elsewhere). If a user deletes, drop the unpublished copy.
    'testimonial:' + userSub,
    // Cancellation exit-survey (free text reason). 365-day TTL anyway,
    // but the user explicitly asked for deletion — honor it.
    'exit_survey:' + userSub,
    // 2026-05-31 audit additions (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md
    // GDPR completeness): per-user prefixes that were written across the
    // codebase but never enumerated here, so deletion left orphan records
    // behind. Each is a single KV DEL; missing keys are no-ops.
    'usr_budget:' + userSub,             // per-user budget caps
    'custom_categories:' + userSub,      // Pro custom category list
    'objective:' + userSub,              // weekly objective state
    'payment_failed:' + userSub,         // dunning state (PII via timing)
    'retention:discount:' + userSub,     // cancel-flow save offer record
    'retention:pause:' + userSub,        // cancel-flow pause record
    'winback:' + userSub,                // post-cancel winback claim (PII)
    'user_seen_announcement:' + userSub, // dismissed announcement IDs
    'referral:redeemed:' + userSub,      // referral redemption idempotency
    'referral:credit:' + userSub,        // durable referral entitlement receipt
    'referral:count:' + userSub,         // aggregate referral count
    'referral:redeemers:' + userSub,     // redacted referral event list
    'audit:referral_redeem:' + userSub,  // account-bound redemption audit marker
    pendingBillingCheckoutKey(userSub),  // provider checkout cancellation manifest
    // TODO (deferred — needs SCAN, not DEL):
    //   goal:{userSub}:{goalId}   — multi-key, but lib/goals.js keeps a
    //                               goals:{userSub} index; purgeGoals() walks it
    //   stats:{userSub}:{window}  — multi-key cached stats; TTL'd but PII
    // The SET `users_all` needs SREM (different op than DEL) — it is removed
    // via kvSetRemove() in BOTH deleteAccount and deleteByPhone (see below),
    // so this DEL-only list stays SET-vs-KEY clean.
  ];
  if (phone) {
    // Phone-keyed records (only the bot flow had these; web flow missed them)
    keys.push('phone:' + phone);
    keys.push('profile:' + phone);          // billing profile, currency, premium fields
    keys.push('recurring:' + phone);        // recurring expense templates
    keys.push('recurring_pending:' + phone); // pending recurring confirmation
    keys.push('memberGroup:' + phone);      // family/group membership pointer
    keys.push('reminders:' + phone);        // reminder list (PII in free text)
    keys.push('phoneGroups:' + phone);      // 2026-05-31 audit addition: family/group list
    keys.push('optout:' + phone);           // 2026-05-31 audit addition: WhatsApp STOP record
  }
  if (subscriptionId) keys.push('paypalSub:' + subscriptionId);
  return keys;
}

// Historical lists stored full redeemer emails. Writer v2 never does. Account
// deletion is gated on a durable drain -> redact -> verify -> ready migration;
// until `ready`, no OAuth grant or customer key is destructively changed.
async function _ensureLegacyReferralPrivacy_(deleted) {
  // Read-only here: only the authenticated production cron may scan/transform
  // the global namespace, so customer requests cannot amplify KV usage.
  const result = await migrateLegacyReferralPii();
  if (result.changed > 0) deleted.push('referral:legacy-email-redactions:' + result.changed);
  if (result.quarantined > 0) deleted.push('referral:invalid-lists-removed:' + result.quarantined);
  if (!result.complete) {
    const error = new Error('privacy_cleanup_pending');
    error.code = 'privacy_cleanup_pending';
    error.retryAfter = result.retryAfter || 5;
    throw error;
  }
}

function _privacyCleanupPendingResponse_(res, error) {
  const retryAfter = Math.max(1, Number(error?.retryAfter) || 60);
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(503).json({
    ok: false,
    completed: false,
    error: 'privacy_cleanup_pending',
    retry_after: retryAfter,
  });
}

// Purge the per-user records that a flat key list in _keysForUser_ can't reach
// because they are multi-key (one KV entry per goal, indexed) or windowed
// (one entry per stats window). Called from BOTH delete paths so bot-driven
// and web-driven deletes leave identical residue. Every transport failure is
// counted so a caller cannot emit a false completion receipt.
// (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md GDPR completeness, items 5 + 7.)
async function _purgeMultiKeyUserRecords_(userSub, deleted) {
  let failed = 0;
  try {
    const r = await purgeGoals(userSub);   // walks goals:{userSub} index → goal:{userSub}:{id} + index
    if (r?.ok) {
      if (r.purged) deleted.push('goal:' + userSub + ':* (' + r.purged + ')');
      deleted.push('goals:' + userSub);
    } else {
      failed += 1;
    }
  } catch (e) {
    failed += 1;
    log.warn('account.purge_goals_failed', { err: e && e.message });
  }
  // Cached stats aggregates (amounts → PII). Two known windows; TTL'd anyway,
  // but the user asked for deletion, so honor it immediately.
  for (const window of ['7d', '30d']) {
    try {
      if (await kvDel('stats:' + userSub + ':' + window)) {
        deleted.push('stats:' + userSub + ':' + window);
      } else failed += 1;
    } catch { failed += 1; }
  }
  return { failed };
}

// The per-user manual-payment index is the only safe way to discover pending
// Bit/bank references without a global SCAN. Treat malformed or foreign index
// state as a hard failure: silently skipping a child would leave PII behind
// while the deletion endpoint claimed completion.
async function _manualPaymentsForUserStrict_(userSub) {
  const indexKey = manualPaymentIndexKey(userSub);
  const index = await kvGet(indexKey);
  if (index === null) return { indexKey, indexPresent: false, codes: [], payments: [] };
  if (!Array.isArray(index) || index.length > MANUAL_PAYMENT_INDEX_MAX) {
    throw new Error('manual_payment_index_malformed');
  }
  const codes = [];
  const seen = new Set();
  const payments = [];
  for (const rawCode of index) {
    const code = String(rawCode || '');
    if (!MANUAL_PAYMENT_CODE_RE.test(code) || seen.has(code)) {
      throw new Error('manual_payment_index_malformed');
    }
    seen.add(code);
    codes.push(code);
    const payment = await kvGet('pendingPayment:' + code);
    if (payment === null) continue; // stale index member: deletion remains safe
    if (!payment || typeof payment !== 'object' || Array.isArray(payment) ||
        payment.code !== code || !['pending', 'confirmed', 'rejected'].includes(payment.status)) {
      throw new Error('manual_payment_record_malformed');
    }
    // Pending records retain their owner so an operator can confirm them.
    // Terminal receipts are deliberately redacted and therefore have no sub.
    if (payment.status === 'pending' && payment.userSub !== userSub) {
      throw new Error('manual_payment_owner_mismatch');
    }
    if (payment.status !== 'pending' && payment.userSub && payment.userSub !== userSub) {
      throw new Error('manual_payment_owner_mismatch');
    }
    payments.push(payment);
  }
  return { indexKey, indexPresent: true, codes, payments };
}

async function _purgeManualPaymentsStrict_(userSub, deleted) {
  let indexed;
  try { indexed = await _manualPaymentsForUserStrict_(userSub); }
  catch (error) {
    log.warn('account.manual_payment_inventory_failed', { error: error?.message });
    return { failed: 1 };
  }
  for (const code of indexed.codes) {
    const key = 'pendingPayment:' + code;
    try {
      if (!(await kvDel(key))) return { failed: 1 };
      deleted.push(key);
    } catch { return { failed: 1 }; }
  }
  // Keep the index as a retry anchor until every child deletion was
  // acknowledged. A lost/failed DEL therefore cannot orphan an undiscoverable
  // pending payment.
  if (!indexed.indexPresent) return { failed: 0 };
  try {
    if (!(await kvDel(indexed.indexKey))) return { failed: 1 };
    deleted.push(indexed.indexKey);
    return { failed: 0 };
  } catch { return { failed: 1 }; }
}

async function cancelRecurringBillingForDeletion(userRec) {
  const subscriptionId = String(userRec?.subscriptionId || '').trim();
  const isPaypal = userRec?.paymentMethod === 'paypal' || /^I-[A-Za-z0-9_-]+$/.test(subscriptionId);
  // Historical records can carry a PayPal subscription id without the newer
  // recurring flag. A valid provider id is sufficient evidence to cancel;
  // otherwise deletion could erase the mapping while charges continue.
  if (!subscriptionId || !isPaypal) return true;
  return cancelPaypalSubscription(subscriptionId, 'account deleted by customer');
}

async function getCoinbaseChargeStatusForDeletion(chargeId) {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey || !chargeId) return null;
  try {
    const { response, payload } = await _fetchJsonWithDeadline_(
      `https://api.commerce.coinbase.com/charges/${encodeURIComponent(chargeId)}`,
      {
        headers: {
          'X-CC-Api-Key': apiKey,
          'X-CC-Version': '2018-03-22',
        },
      },
    );
    if (!response.ok || !payload?.data) return null;
    const timeline = Array.isArray(payload.data.timeline) ? payload.data.timeline : [];
    const latest = timeline.length ? timeline[timeline.length - 1]?.status : payload.data.status;
    if (!latest) return null;
    return {
      status: String(latest).toUpperCase(),
      createdAt: payload.data.created_at || null,
      expiresAt: payload.data.expires_at || null,
    };
  } catch { return null; }
}

async function cancelPendingBillingCheckoutsForDeletion(userSub) {
  const manifestKey = pendingBillingCheckoutKey(userSub);
  let checkouts;
  try { checkouts = await kvGet(manifestKey); }
  catch { return false; }
  if (checkouts === null) return true;
  if (!Array.isArray(checkouts) || checkouts.length > 100) return false;
  for (const checkout of checkouts) {
    const provider = String(checkout?.provider || '').toLowerCase();
    const externalId = String(checkout?.externalId || '').trim();
    if (!externalId || !['paypal', 'coinbase'].includes(provider)) return false;
    if (provider === 'paypal') {
      const cancelled = await cancelPaypalSubscription(
        externalId, 'account deleted while checkout was pending',
      );
      if (!cancelled) return false;
    } else {
      // Never infer expiry from a local TTL: keep deletion retryable while the
      // hosted charge is payable or its state cannot be proven. Coinbase can
      // detect late payment after EXPIRED/FAILED, so those states are safe only
      // after the documented seven-day late-payment window has elapsed.
      const charge = await getCoinbaseChargeStatusForDeletion(externalId);
      const status = charge?.status;
      if (!status || ['NEW', 'PENDING', 'UNRESOLVED'].includes(status)) return false;
      if (['EXPIRED', 'FAILED'].includes(status)) {
        const latePaymentAnchor = Date.parse(charge.expiresAt || charge.createdAt || '');
        if (!Number.isFinite(latePaymentAnchor)
          || Date.now() < latePaymentAnchor + COINBASE_LATE_PAYMENT_WINDOW_MS) return false;
      } else if (!['CANCELED', 'CANCELLED', 'COMPLETED', 'RESOLVED'].includes(status)) {
        return false;
      }
      if (['COMPLETED', 'RESOLVED'].includes(status)) {
        try {
          await queueBillingReconciliation({
            provider: 'coinbase', kind: 'paid_checkout_deleted', externalId,
            details: { chargeId: externalId, reason: 'account_deleted_after_payment' },
          });
        } catch { return false; }
      }
    }
  }
  try { return await kvDel(manifestKey); }
  catch { return false; }
}

// Keep a durable deletion receipt without recreating the personal data that
// was just erased. auditLog() hashes the subject, applies a 730-day TTL, and
// keeps the raw identifier out of both the KV key and value. Metadata is a
// deliberately closed, aggregate-only schema: never pass email, phone, IP,
// request headers, or the deleted key names here.
async function _writeDeletionAudit_(subject, channel, outcome, deletedKeyCount) {
  try {
    const ok = await auditLog('account_deletion', subject || null, {
      channel,
      outcome,
      deletedKeyCount: Math.max(0, Number(deletedKeyCount) || 0),
    });
    if (!ok) log.warn('account.deletion_audit_unavailable', { channel, outcome });
  } catch (error) {
    // Account deletion must not fail because its privacy-minimized receipt is
    // temporarily unavailable. The warning itself contains no user identity.
    log.warn('account.deletion_audit_failed', { channel, outcome, error: error?.message });
  }
}

function _deletionRetryRequiredResponse_(res) {
  const retryAfter = 5;
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(503).json({
    ok: false,
    completed: false,
    error: 'account_deletion_retry_required',
    retry_after: retryAfter,
  });
}

function _webDeletionSuccessResponse_(res, deleted, replayed = false) {
  return res.status(200).json({
    ok: true,
    deleted,
    ...(replayed ? { replayed: true } : {}),
    note: 'Your account, OAuth tokens, and our connection to your sheet have been removed. The Google Sheet itself remains in your Drive under your control — delete it manually if you wish.',
    note_he: 'החשבון שלך, אסימוני ההזדהות והקישור שלנו לגיליון הוסרו. הגיליון עצמו נשאר ב-Drive שלך בשליטתך — מחק אותו ידנית אם תרצה.',
  });
}

function _deletionReceiptKey_(kind, value) {
  const secret = process.env.KV_REST_API_TOKEN;
  if (!secret || !value || !['user', 'phone'].includes(kind)) return null;
  const digest = createHmac('sha256', secret)
    .update(`kesefle:account-deletion:v1:${kind}:${String(value)}`)
    .digest('hex');
  return `deletion:complete:${kind}:${digest}`;
}

// The deletion/link race guard is opaque for the same reason as completion
// receipts: a raw Google subject must not survive in a new KV key after the
// account is gone. api/whatsapp/link.js derives this exact key before its
// atomic confirmation transaction.
function _deletionGuardKey_(userSub) {
  const secret = process.env.KV_REST_API_TOKEN;
  if (!secret || !userSub) return null;
  const digest = createHmac('sha256', secret)
    .update(`kesefle:account-deletion:v1:guard:${String(userSub)}`)
    .digest('hex');
  return `deletion:guard:${digest}`;
}

// Publish deletion intent before any secondary purge. This transaction and
// phone-link confirmation both lock the canonical user + opaque guard keys,
// so Redis serializes the two operations: a confirmation that wins first is
// purged below, while one that runs afterwards observes the guard and stops.
async function _beginDeletion_(userSub) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const guardKey = _deletionGuardKey_(userSub);
  const tombstoneKey = userDeletionKey(userSub);
  if (!url || !token || !guardKey) return { status: 'unavailable' };
  const script = `#!lua flags=allow-key-locking
local userRaw = redis.call('GET', KEYS[1])
if not userRaw then return cjson.encode({ status = 'user_missing' }) end
local ok, decoded = pcall(cjson.decode, userRaw)
if not ok or type(decoded) ~= 'table' then
  return cjson.encode({ status = 'user_malformed' })
end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], 'deleting', 'EX', ARGV[2])
return cjson.encode({ status = 'marked' })`;
  try {
    const { response, payload } = await _fetchJsonWithDeadline_(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL', script, '3', 'user:' + userSub, guardKey, tombstoneKey,
        JSON.stringify({ v: 1, status: 'deleting' }),
        String(DELETION_TOMBSTONE_TTL_SEC),
      ]),
    });
    if (!response.ok || typeof payload?.result !== 'string') return { status: 'unavailable' };
    const result = JSON.parse(payload.result);
    return ['marked', 'user_missing', 'user_malformed'].includes(result?.status)
      ? { status: result.status }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function _hasDeletionReceipt_(kind, value) {
  const key = _deletionReceiptKey_(kind, value);
  if (!key) throw new Error('deletion_receipt_unavailable');
  const receipt = await kvGet(key);
  if (receipt === null) return false;
  if (typeof receipt !== 'object' || receipt.v !== 1 || receipt.status !== 'complete') {
    throw new Error('deletion_receipt_malformed');
  }
  return true;
}

// Pin the phone namespace before deleting any phone-scoped data. An existing
// foreign owner is never touched; a missing mapping is reserved atomically for
// this deletion so a concurrent signup cannot claim it mid-purge.
async function _preparePhoneAnchor_(userSub, phone) {
  if (!phone) return { status: 'none' };
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { status: 'unavailable' };
  const phoneKey = 'phone:' + phone;
  const reservedValue = JSON.stringify({ userSub, deletionReserved: true });
  const script = `#!lua flags=allow-key-locking
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' or decoded['userSub'] == nil then
    return cjson.encode({ status = 'malformed' })
  end
  if tostring(decoded['userSub']) ~= ARGV[1] then
    return cjson.encode({ status = 'foreign' })
  end
  return cjson.encode({ status = 'owned' })
end
redis.call('SET', KEYS[1], ARGV[2])
return cjson.encode({ status = 'reserved' })`;
  try {
    const { response, payload } = await _fetchJsonWithDeadline_(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', script, '1', phoneKey, userSub, reservedValue]),
    });
    if (!response.ok || typeof payload?.result !== 'string') return { status: 'unavailable' };
    const result = JSON.parse(payload.result);
    return ['owned', 'reserved', 'foreign', 'malformed'].includes(result?.status)
      ? { status: result.status }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

// Finalize the two records that make a partially deleted account retryable.
// With a phone, delete both anchors in one key-locked script and only if the
// phone mapping is still absent or still belongs to this user. A reassigned or
// malformed mapping is never deleted.
async function _finalizeUserAnchors_(userSub, phone) {
  const identityKey = 'user:' + userSub;
  const reversePhoneKey = 'userPhone:' + userSub;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { complete: false, deletedKeys: [] };
  const userReceiptKey = _deletionReceiptKey_('user', userSub);
  const guardKey = _deletionGuardKey_(userSub);
  const tombstoneKey = userDeletionKey(userSub);
  if (!userReceiptKey || !guardKey) return { complete: false, deletedKeys: [] };
  const receipt = JSON.stringify({ v: 1, status: 'complete', completedAt: new Date().toISOString() });
  const completedGuard = JSON.stringify({ v: 1, status: 'deleted' });

  let keys;
  let script;
  if (phone) {
    const phoneKey = 'phone:' + phone;
    const phoneReceiptKey = _deletionReceiptKey_('phone', phone);
    if (!phoneReceiptKey) return { complete: false, deletedKeys: [] };
    keys = [identityKey, phoneKey, reversePhoneKey, guardKey, userReceiptKey, phoneReceiptKey, tombstoneKey];
    script = `#!lua flags=allow-key-locking
local phoneRaw = redis.call('GET', KEYS[2])
if phoneRaw then
  local ok, decoded = pcall(cjson.decode, phoneRaw)
  if not ok or type(decoded) ~= 'table' or decoded['userSub'] == nil then
    return cjson.encode({ status = 'malformed_phone_anchor' })
  end
  if tostring(decoded['userSub']) ~= ARGV[1] then
    return cjson.encode({ status = 'foreign_phone_anchor' })
  end
end
redis.call('SET', KEYS[5], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[6], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[5])
redis.call('SET', KEYS[7], 'deleted', 'EX', ARGV[6])
local phoneDeleted = redis.call('DEL', KEYS[2])
local reverseDeleted = redis.call('DEL', KEYS[3])
local userDeleted = redis.call('DEL', KEYS[1])
return cjson.encode({ status = 'complete', userDeleted = userDeleted, phoneDeleted = phoneDeleted, reverseDeleted = reverseDeleted })`;
  } else {
    keys = [identityKey, reversePhoneKey, guardKey, userReceiptKey, tombstoneKey];
    script = `#!lua flags=allow-key-locking
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
redis.call('SET', KEYS[5], 'deleted', 'EX', ARGV[6])
local reverseDeleted = redis.call('DEL', KEYS[2])
local userDeleted = redis.call('DEL', KEYS[1])
return cjson.encode({ status = 'complete', userDeleted = userDeleted, phoneDeleted = 0, reverseDeleted = reverseDeleted })`;
  }

  try {
    const { response, payload } = await _fetchJsonWithDeadline_(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL', script, String(keys.length), ...keys,
        userSub, receipt, String(DELETION_RECEIPT_TTL_SEC),
        completedGuard, String(DELETION_GUARD_COOLDOWN_SEC),
        String(DELETION_TOMBSTONE_TTL_SEC),
      ]),
    });
    if (!response.ok || typeof payload?.result !== 'string') {
      return { complete: false, deletedKeys: [] };
    }
    const result = JSON.parse(payload.result);
    if (result?.status !== 'complete') return { complete: false, deletedKeys: [] };
    const deletedKeys = [];
    if (phone && Number(result.phoneDeleted) > 0) deletedKeys.push('phone:' + phone);
    if (Number(result.reverseDeleted) > 0) deletedKeys.push(reversePhoneKey);
    if (Number(result.userDeleted) > 0) deletedKeys.push(identityKey);
    return { complete: true, deletedKeys };
  } catch {
    return { complete: false, deletedKeys: [] };
  }
}

// Delete every secondary record first and the canonical user record last. If
// any step fails, both the identity and phone mapping remain as retry anchors.
// Earlier successful deletes are idempotent, so retrying safely finishes the
// purge from either web or WhatsApp.
async function _purgeUserRecords_(userSub, phone, subscriptionId, deleted) {
  const identityKey = 'user:' + userSub;
  const phoneKey = phone ? 'phone:' + phone : null;
  const reversePhoneKey = 'userPhone:' + userSub;
  const keys = (await _keysForUser_(userSub, phone, subscriptionId))
    .filter((key) => key !== identityKey && key !== phoneKey && key !== reversePhoneKey);
  let failed = 0;

  // Delete manual-payment children before their discoverability index. If any
  // child DEL fails or its response is lost, retain the index and account
  // anchors so the exact inventory is retryable.
  const manual = await _purgeManualPaymentsStrict_(userSub, deleted);
  failed += manual.failed;

  for (const key of keys) {
    try {
      if (await kvDel(key)) deleted.push(key);
      else failed += 1;
    } catch { failed += 1; }
  }

  const multi = await _purgeMultiKeyUserRecords_(userSub, deleted);
  failed += multi.failed;

  try {
    if (await kvSetRemove('users_all', 'google:' + userSub)) {
      deleted.push('users_all[google:' + userSub + ']');
    } else failed += 1;
  } catch { failed += 1; }

  // Never erase a retry/race anchor until every secondary operation has been
  // acknowledged. The finalizer removes user + phone + reverse mapping in one
  // transaction and converts the guard into a short opaque cooldown marker.
  if (failed === 0) {
    const finalized = await _finalizeUserAnchors_(userSub, phone);
    if (finalized.complete) deleted.push(...finalized.deletedKeys);
    else failed += 1;
  }

  return { complete: failed === 0, failed };
}

async function revokeGoogleToken(refreshToken) {
  if (!refreshToken) return true;
  try {
    const response = await _fetchWithDeadline_('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    // Google documents 200 for a successful revocation and 400 when the token
    // is invalid (including already expired/revoked). Both mean the stored
    // credential cannot retain an active grant; transient/5xx failures retry.
    return response.ok || response.status === 400;
  } catch (e) {
    log.warn('account.google_revoke_failed', { error: e?.message });
    return false;
  }
}

// exchangeRefreshForAccess now lives in lib/oauth.js (audit H1): it captures a
// rotated refresh_token if Google returns one during the export's read.

// =============================================================
// Action: delete (GDPR Art.17 + Israeli Privacy Law Sec.14)
// =============================================================
async function deleteAccount(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const userSub = req.user.sub;

  if (body?.confirmation !== 'DELETE-MY-ACCOUNT') {
    return res.status(400).json({ ok: false, error: 'missing or invalid confirmation' });
  }

  const deleted = [];
  try {
    await _ensureLegacyReferralPrivacy_(deleted);
  } catch (error) {
    log.warn('account.referral_privacy_pending', {
      reqId: req.reqId,
      code: error?.code || 'migration_failed',
    });
    return _privacyCleanupPendingResponse_(res, error);
  }

  let userRec;
  try { userRec = await kvGet('user:' + userSub); }
  catch {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if (userRec === null) {
    let replayed = false;
    try { replayed = await _hasDeletionReceipt_('user', userSub); }
    catch {
      await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
      return _deletionRetryRequiredResponse_(res);
    }
    if (replayed) {
      await _writeDeletionAudit_(userSub, 'web', 'deleted', deleted.length);
      return _webDeletionSuccessResponse_(res, deleted, true);
    }
    return res.status(404).json({ ok: false, error: 'user not found' });
  }
  if (typeof userRec !== 'object') {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  const deletionGuard = await _beginDeletion_(userSub);
  if (deletionGuard.status !== 'marked') {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  // Re-read after publishing the tombstone. Provider activation and deletion
  // lock the same canonical user+tombstone pair: if activation won first, this
  // snapshot contains its subscription id; if deletion won, activation stops.
  try { userRec = await kvGet('user:' + userSub); }
  catch {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if (!userRec || typeof userRec !== 'object') {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  // Resolve every new throwing KV precondition before revoking the external
  // Google grant. A transient reverse-map failure must leave the account and
  // its Drive access untouched so the user can retry safely.
  let userPhoneRec;
  let referralCode;
  try {
    userPhoneRec = await kvGet('userPhone:' + userSub);
    referralCode = await kvGet('referral:code:' + userSub, { allowRawString: true });
  } catch {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if ((userPhoneRec !== null && (typeof userPhoneRec !== 'object' || typeof userPhoneRec.phone !== 'string')) ||
      (referralCode !== null && typeof referralCode !== 'string')) {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  let phone = (userPhoneRec && userPhoneRec.phone) ? userPhoneRec.phone : null;
  if (phone) {
    const prepared = await _preparePhoneAnchor_(userSub, phone);
    if (prepared.status === 'foreign') {
      // A stale userPhone pointer must never delete the current owner's
      // phone-scoped profile. Continue with user-scoped deletion only.
      phone = null;
    } else if (!['owned', 'reserved'].includes(prepared.status)) {
      await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
      return _deletionRetryRequiredResponse_(res);
    }
  }
  if (referralCode) {
    try {
      const reverseStatus = await kvDeleteReferralReverseIfOwned(referralCode, userSub);
      if (reverseStatus === 'deleted') deleted.push('referral:reverse:' + referralCode);
    } catch {
      await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
      return _deletionRetryRequiredResponse_(res);
    }
  }

  if (!(await cancelPendingBillingCheckoutsForDeletion(userSub))) {
    log.error('account.delete_pending_checkout_cancel_failed', { reqId: req.reqId });
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  if (!(await cancelRecurringBillingForDeletion(userRec))) {
    log.error('account.delete_subscription_cancel_failed', { reqId: req.reqId });
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  // Revoke the Google grant on delete. Handle BOTH the encrypted envelope
  // (current users) AND the legacy plaintext token — otherwise envelope users'
  // Google access survives account deletion (GDPR). Mirrors deleteByPhone.
  let refreshToken = null;
  let refreshTokenReadable = true;
  try {
    refreshToken = userRec.refreshTokenEnvelope
      ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
      : userRec.refreshToken;
  } catch {
    refreshToken = userRec.refreshToken || null;
    refreshTokenReadable = Boolean(refreshToken);
  }
  if (!refreshTokenReadable || !(await revokeGoogleToken(refreshToken))) {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  const purge = await _purgeUserRecords_(userSub, phone, userRec.subscriptionId, deleted);
  if (!purge.complete) {
    await _writeDeletionAudit_(userSub, 'web', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  await _writeDeletionAudit_(userSub, 'web', 'deleted', deleted.length);

  return _webDeletionSuccessResponse_(res, deleted);
}

// =============================================================
// Action: export (GDPR Art.20 right to data portability)
// =============================================================
async function exportAccount(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const userSub = req.user.sub;
  const userRec = (await kvGet('user:' + userSub)) || {};

  // Strip sensitive crypto material — user shouldn't see their own refresh token envelope
  const userProfile = {
    sub: userSub,
    email: userRec.email,
    name: userRec.name,
    picture: userRec.picture,
    plan: userRec.plan || 'free',
    subscription_status: userRec.subscriptionStatus,
    subscribed_at: userRec.subscribedAt,
    connected_at: userRec.connectedAt,
    spreadsheet_id: userRec.spreadsheetId,
    spreadsheet_url: userRec.spreadsheetUrl,
    has_refresh_token: !!(userRec.refreshTokenEnvelope || userRec.refreshToken),
  };

  // Sheet data (transactions) — fetch via stored refresh token
  let transactions = [];
  let sheetReadError = null;
  if (userRec.spreadsheetId) {
    try {
      const refreshToken = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
      if (refreshToken) {
        const { accessToken } = await exchangeRefreshForAccess({ refreshToken, userSub });
        const range = encodeURIComponent(`'${TX_TAB}'!A2:I10001`);
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (r.ok) {
          const j = await r.json();
          transactions = (j.values || [])
            .filter(row => row[0])
            .map(row => ({
              date: row[0],
              amount: parseFloat(row[1] || '0') || 0,
              currency: row[2] || 'ILS',
              type: row[3] || '',
              category: row[4] || '',
              subcategory: row[5] || '',
              description: row[6] || '',
              source: row[7] || '',
              message_id: row[8] || '',
            }));
        } else {
          sheetReadError = 'sheets_status_' + r.status;
        }
      }
    } catch (e) {
      // Don't surface the raw exception text to the client: decrypt / token
      // failures throw messages that name internal env vars + key IDs
      // (e.g. "crypto: KESEFLE_DB_KEY_ACTIVE_KID=... not present in keyring",
      // "crypto.decrypt: authentication failed"). Return a stable, generic
      // classification in the export doc; log the real detail server-side for
      // operators. The export still succeeds — transactions just come back
      // empty with a machine-readable reason.
      sheetReadError = /crypto|decrypt|envelope|keyring|KEK/i.test(String(e && e.message))
        ? 'token_decrypt_failed'
        : 'sheet_read_failed';
      log.warn('account.export_sheet_read_failed', { reqId: req.reqId, userSub, reason: sheetReadError, err: e && e.message });
    }
  }

  // Referral data stored outside the canonical user record must be included in
  // a portability export. Other redeemers' email data is never exported.
  const [referralCode, referralCredit, referralRedemption, referralCount, referralAudit] = await Promise.all([
    kvGet('referral:code:' + userSub, { allowRawString: true }),
    kvGet('referral:credit:' + userSub),
    kvGet('referral:redeemed:' + userSub),
    kvGet('referral:count:' + userSub),
    kvGet('audit:referral_redeem:' + userSub),
  ]);
  const manualPayments = (await _manualPaymentsForUserStrict_(userSub)).payments.map((payment) => ({
    code: payment.code,
    status: payment.status,
    plan: payment.plan,
    period: payment.period,
    months: payment.months,
    amountILS: payment.amountILS,
    method: payment.method,
    createdAt: payment.createdAt,
    resolvedAt: payment.confirmedAt || payment.rejectedAt || null,
  }));

  const exportDoc = {
    export_meta: {
      exported_at: new Date().toISOString(),
      user_sub: userSub,
      format_version: '1.2',
      note: 'This is the complete export of all data Kesefle holds about your account. Per GDPR Article 20 and Israeli Privacy Law Section 13. To delete this data, use POST /api/account?action=delete.',
      note_he: 'זהו ייצוא מלא של כל הנתונים ש"כסף\'לה" שומר על חשבונך. לפי GDPR סעיף 20 וחוק הגנת הפרטיות סעיף 13. למחיקה: POST /api/account?action=delete.',
    },
    profile: userProfile,
    transactions: {
      count: transactions.length,
      data: transactions,
      read_error: sheetReadError,
      note: 'Transactions live in your own Google Sheet at spreadsheet_url. This export is a snapshot.',
    },
    referral: {
      code: referralCode || null,
      credit: referralCredit || null,
      redemption: referralRedemption || null,
      successful_referrals: Number(referralCount) || 0,
      redemption_audit: referralAudit || null,
      note: 'Your personal referral code, earned credit, redemption receipt, and referral count.',
    },
    manual_payments: manualPayments,
    not_stored_by_kesefle: [
      'Original raw WhatsApp message bodies (only the parsed amount + category are persisted)',
      'Your bank/credit card data (we never receive it)',
      'Your phone number content beyond the sender field on incoming messages',
      'Your Google contacts, calendar, drive files outside the kesefle-provisioned sheet',
      'Your IP address beyond the last request (rate-limit ephemeral)',
    ],
    your_rights: {
      delete: 'POST /api/account?action=delete with confirmation:"DELETE-MY-ACCOUNT"',
      export: 'GET /api/account?action=export (this endpoint)',
      sheet_ownership: 'The Google Sheet at spreadsheet_url is YOURS. Kesefle has access only to files we created (drive.file scope). You can revoke our access at myaccount.google.com/permissions',
      complaint: 'https://www.gov.il/he/departments/the_privacy_protection_authority',
    },
  };

  log.info('account.export_ok', { reqId: req.reqId, userSub, txnCount: transactions.length });

  const filename = `kesefle-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify(exportDoc, null, 2));
}

// =============================================================
// Main dispatcher with per-action rate limits
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'missing_action_param',
      hint: 'use ?action=delete (POST) or ?action=export (GET)',
    });
  }

  switch (action) {
    case 'delete': return deleteAccount(req, res);
    case 'export': return exportAccount(req, res);
    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', action, allowed: ['delete', 'export'] });
  }
}

// Bot-callable deletion by phone (no Google token — the bot only knows
// the phone). Gated by the bot secret. Resolves phone → userSub via KV,
// then runs the same revoke + purge as the authed delete. This is how
// the WhatsApp "מחק חשבון כן" flow deletes an account without the user
// being in a browser session.
async function deleteByPhone(req, res) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = String(body?.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const deleted = [];
  try {
    await _ensureLegacyReferralPrivacy_(deleted);
  } catch (error) {
    log.warn('account.referral_privacy_pending', {
      reqId: req.reqId,
      code: error?.code || 'migration_failed',
    });
    return _privacyCleanupPendingResponse_(res, error);
  }

  let phoneRec;
  try { phoneRec = await kvGet('phone:' + phone); }
  catch {
    await _writeDeletionAudit_(null, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if (phoneRec === null) {
    let replayed = false;
    try { replayed = await _hasDeletionReceipt_('phone', phone); }
    catch {
      await _writeDeletionAudit_(null, 'whatsapp', 'retry_required', deleted.length);
      return _deletionRetryRequiredResponse_(res);
    }
    if (replayed) {
      await _writeDeletionAudit_(null, 'whatsapp', 'deleted', deleted.length);
      return res.status(200).json({ ok: true, deleted, replayed: true });
    }
    // Explicit KV `result:null` is the only no-link state. Do not issue a DEL:
    // a concurrent link could appear between GET and DEL and be lost.
    await _writeDeletionAudit_(null, 'whatsapp', 'no_linked_user', deleted.length);
    return res.status(200).json({ ok: true, deleted, note: 'no_linked_user' });
  }
  if (typeof phoneRec !== 'object' || typeof phoneRec.userSub !== 'string' || !phoneRec.userSub) {
    await _writeDeletionAudit_(null, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  const userSub = phoneRec.userSub;
  const deletionGuard = await _beginDeletion_(userSub);
  if (deletionGuard.status !== 'marked') {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  const prepared = await _preparePhoneAnchor_(userSub, phone);
  if (!['owned', 'reserved'].includes(prepared.status)) {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  let userRec;
  let referralCode;
  try {
    userRec = await kvGet('user:' + userSub);
    referralCode = await kvGet('referral:code:' + userSub, { allowRawString: true });
  } catch {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if ((userRec !== null && typeof userRec !== 'object') ||
      (referralCode !== null && typeof referralCode !== 'string')) {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  // Complete the throwing reverse-map precondition before external OAuth
  // revocation, so a KV outage cannot strand a still-present account.
  if (referralCode) {
    try {
      const reverseStatus = await kvDeleteReferralReverseIfOwned(referralCode, userSub);
      if (reverseStatus === 'deleted') deleted.push('referral:reverse:' + referralCode);
    } catch {
      await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
      return _deletionRetryRequiredResponse_(res);
    }
  }
  if (!(await cancelPendingBillingCheckoutsForDeletion(userSub))) {
    log.error('account.delete_by_phone_pending_checkout_cancel_failed', { reqId: req.reqId });
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  if (userRec && !(await cancelRecurringBillingForDeletion(userRec))) {
    log.error('account.delete_by_phone_subscription_cancel_failed', { reqId: req.reqId });
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  let refreshToken = null;
  let refreshTokenReadable = true;
  if (userRec) {
    try {
      refreshToken = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
    } catch {
      refreshToken = userRec.refreshToken || null;
      refreshTokenReadable = Boolean(refreshToken);
    }
  }
  if (!refreshTokenReadable || !(await revokeGoogleToken(refreshToken))) {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }

  const purge = await _purgeUserRecords_(userSub, phone, userRec?.subscriptionId, deleted);
  if (!purge.complete) {
    await _writeDeletionAudit_(userSub, 'whatsapp', 'retry_required', deleted.length);
    return _deletionRetryRequiredResponse_(res);
  }
  await _writeDeletionAudit_(userSub, 'whatsapp', 'deleted', deleted.length);
  log.info('account.delete_by_phone', { reqId: req.reqId, phone: phone.replace(/\d(?=\d{4})/g, '*') });
  return res.status(200).json({ ok: true, deleted });
}

// Both delete (3/hr) and export (2/hr) are sensitive but distinct.
// We use a single bucket here keyed by `account_op` with the conservative cap of 5/hour
// — covers both flows together since real users do these very rarely.
//
// The bot-secret delete-by-phone path is checked FIRST, bypassing
// requireAuth (the bot has no Google token), then the authed browser
// flows run as before.
export default withRequestId(
  withRateLimit({ key: 'account_op', limit: 5, windowSec: 3600 })(
    async function accountRouter(req, res) {
      const action = String(req.query?.action || '').toLowerCase();
      if (action === 'delete-by-phone') {
        if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return deleteByPhone(req, res);
      }
      return requireAuth(handlerImpl)(req, res);
    }
  )
);
