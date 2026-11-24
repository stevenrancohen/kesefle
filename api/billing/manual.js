// /api/billing/manual
// Manual-confirm payments for Bit and bank transfer (no API exists for either).
// Flow:
//   1. POST ?action=request  (auth'd customer) {plan, period, method}
//        → creates a pending record + reference code, alerts the owner on
//          WhatsApp, returns payment instructions (your Bit number / bank
//          details, the amount, and the reference code).
//   2. Customer pays you directly via Bit / bank, quoting the reference code.
//   3. POST ?action=confirm  (ADMIN only) {code}
//        → activates premium for that customer (they get a WhatsApp confirmation).
//   GET  ?action=list        (ADMIN only) → open pending payments.
//   POST ?action=reject      (ADMIN only) {code} → drop a pending request.
//
// Env: BIT_PAYEE_PHONE, BANK_TRANSFER_DETAILS, ADMIN_EMAILS (for confirm/list)

import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { auditLog } from '../../lib/secure-kv.js';
import {
  notifyOwner, getUserPhone, sendWhatsApp,
  priceILS, periodMonths, normalizePlan, PLAN_LABELS,
  billingKvGet, billingKvEval,
} from '../../lib/billing.js';
import { userDeletionKey, manualPaymentIndexKey } from '../../lib/user-record.js';

const PENDING_INDEX = 'billing:pending';
const PENDING_TTL_SEC = 30 * 24 * 3600;
const TERMINAL_TTL_SEC = 400 * 24 * 3600;
const USER_INDEX_TTL_SEC = 400 * 24 * 3600;
const MANUAL_CODE_RE = /^KFL-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

const CREATE_PENDING_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_MANUAL_PAYMENT_CREATE_V1
if redis.call('EXISTS', KEYS[4]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end
local user_raw = redis.call('GET', KEYS[3])
if not user_raw then return cjson.encode({ status = 'account_missing' }) end
local user_ok, user = pcall(cjson.decode, user_raw)
if not user_ok or type(user) ~= 'table' then
  return cjson.encode({ status = 'malformed_user_record' })
end
if tostring(user['userSub'] or '') ~= ARGV[3] then
  return cjson.encode({ status = 'user_identity_mismatch' })
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return cjson.encode({ status = 'collision' })
end
local index = {}
local index_raw = redis.call('GET', KEYS[2])
if index_raw then
  local index_ok, decoded = pcall(cjson.decode, index_raw)
  if not index_ok or type(decoded) ~= 'table' then
    return cjson.encode({ status = 'malformed_index' })
  end
  index = decoded
end
local user_index = {}
local user_index_raw = redis.call('GET', KEYS[5])
if user_index_raw then
  local user_index_ok, decoded = pcall(cjson.decode, user_index_raw)
  if not user_index_ok or type(decoded) ~= 'table' then
    return cjson.encode({ status = 'malformed_user_index' })
  end
  user_index = decoded
end
local payment_ok, payment = pcall(cjson.decode, ARGV[1])
if not payment_ok or type(payment) ~= 'table' or tostring(payment['code'] or '') ~= ARGV[2]
  or tostring(payment['userSub'] or '') ~= ARGV[3] then
  return cjson.encode({ status = 'invalid_payment' })
end
for _, existing in ipairs(index) do
  if tostring(existing) == ARGV[2] then
    return cjson.encode({ status = 'collision' })
  end
end
table.insert(index, ARGV[2])
table.insert(user_index, ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(payment), 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[2], cjson.encode(index))
redis.call('SET', KEYS[5], cjson.encode(user_index), 'EX', tonumber(ARGV[5]))
return cjson.encode({ status = 'committed', payment = payment })`;

const CONFIRM_PENDING_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_MANUAL_PAYMENT_CONFIRM_V1
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
    value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.(%d+)Z$'
  )
  if not y then
    y, mo, d, h, mi, s = string.match(
      value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)Z$'
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
local function index_without(raw, code)
  if not raw then return {} end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return nil end
  local out = {}
  for _, value in ipairs(decoded) do
    if tostring(value) ~= code then table.insert(out, value) end
  end
  return out
end

local pending_raw = redis.call('GET', KEYS[1])
if not pending_raw then return cjson.encode({ status = 'missing' }) end
if redis.call('EXISTS', KEYS[4]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end
local pending_ok, pending = pcall(cjson.decode, pending_raw)
if not pending_ok or type(pending) ~= 'table' then
  return cjson.encode({ status = 'malformed_payment' })
end
if tostring(pending['code'] or '') ~= ARGV[1] then
  return cjson.encode({ status = 'payment_changed' })
end
local state = tostring(pending['status'] or '')
if state == 'confirmed' then
  return cjson.encode({
    status = 'confirmed', replayed = true, payment = pending,
    record = { plan = pending['plan'], accessUntil = pending['accessUntil'] }
  })
end
if state == 'rejected' then
  return cjson.encode({ status = 'rejected', payment = pending })
end
if state ~= 'pending' then return cjson.encode({ status = 'invalid_state' }) end

local index = index_without(redis.call('GET', KEYS[3]), ARGV[1])
if not index then return cjson.encode({ status = 'malformed_index' }) end
local user_index = index_without(redis.call('GET', KEYS[5]), ARGV[1])
if not user_index then return cjson.encode({ status = 'malformed_user_index' }) end
local user_sub = tostring(pending['userSub'] or '')
if user_sub == '' or user_sub ~= ARGV[5] then
  return cjson.encode({ status = 'payment_changed' })
end
local user_raw = redis.call('GET', KEYS[2])
if not user_raw then return cjson.encode({ status = 'account_missing' }) end
local user_ok, record = pcall(cjson.decode, user_raw)
if not user_ok or type(record) ~= 'table' then
  return cjson.encode({ status = 'malformed_user_record' })
end
if tostring(record['userSub'] or '') ~= user_sub then
  return cjson.encode({ status = 'user_identity_mismatch' })
end

local now_ms = tonumber(ARGV[2])
local months = math.max(1, tonumber(pending['months']) or 1)
local plan = tostring(pending['plan'] or '')
local method = tostring(pending['method'] or '')
local period = tostring(pending['period'] or '')
if (plan ~= 'pro' and plan ~= 'family') or (method ~= 'bit' and method ~= 'bank')
  or (period ~= 'month' and period ~= 'year') or (months ~= 1 and months ~= 12) then
  return cjson.encode({ status = 'malformed_payment' })
end
local current_ms = parse_iso_ms(record['accessUntil']) or 0
local access_ms = math.max(current_ms, now_ms) + months * 30 * 86400000
local access_until = iso_from_ms(access_ms)
record['userSub'] = record['userSub'] or user_sub
record['plan'] = plan
record['subscriptionStatus'] = 'active'
record['paymentMethod'] = method
record['recurring'] = false
record['billingPeriod'] = (period == 'year' or months >= 12) and 'year' or 'month'
record['accessUntil'] = access_until
record['lastPaymentAt'] = ARGV[3]
record['lastPaymentRef'] = ARGV[1]
local terminal = {
  code = ARGV[1], status = 'confirmed', plan = plan, period = period,
  months = months, amountILS = pending['amountILS'], method = method,
  confirmedAt = ARGV[3], accessUntil = access_until,
  receipt = 'manual:' .. ARGV[1]
}

redis.call('SET', KEYS[2], cjson.encode(record))
redis.call('SET', KEYS[1], cjson.encode(terminal), 'EX', tonumber(ARGV[6]))
redis.call('SET', KEYS[3], cjson.encode(index))
if #user_index == 0 then
  redis.call('DEL', KEYS[5])
else
  redis.call('SET', KEYS[5], cjson.encode(user_index), 'EX', tonumber(ARGV[7]))
end
return cjson.encode({ status = 'confirmed', replayed = false, payment = pending, record = record })`;

const REJECT_PENDING_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_MANUAL_PAYMENT_REJECT_V1
local function index_without(raw, code)
  if not raw then return {} end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return nil end
  local out = {}
  for _, value in ipairs(decoded) do
    if tostring(value) ~= code then table.insert(out, value) end
  end
  return out
end
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ status = 'missing' }) end
local ok, payment = pcall(cjson.decode, raw)
if not ok or type(payment) ~= 'table' then
  return cjson.encode({ status = 'malformed_payment' })
end
if tostring(payment['code'] or '') ~= ARGV[1] then
  return cjson.encode({ status = 'payment_changed' })
end
local state = tostring(payment['status'] or '')
if state == 'confirmed' then return cjson.encode({ status = 'confirmed', payment = payment }) end
if state == 'rejected' then return cjson.encode({ status = 'rejected', replayed = true, payment = payment }) end
if state ~= 'pending' then return cjson.encode({ status = 'invalid_state' }) end
local index = index_without(redis.call('GET', KEYS[2]), ARGV[1])
if not index then return cjson.encode({ status = 'malformed_index' }) end
local user_index = index_without(redis.call('GET', KEYS[3]), ARGV[1])
if not user_index then return cjson.encode({ status = 'malformed_user_index' }) end
local terminal = {
  code = ARGV[1], status = 'rejected', plan = payment['plan'],
  period = payment['period'], months = payment['months'],
  amountILS = payment['amountILS'], method = payment['method'], rejectedAt = ARGV[2]
}
redis.call('SET', KEYS[1], cjson.encode(terminal), 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[2], cjson.encode(index))
if #user_index == 0 then
  redis.call('DEL', KEYS[3])
else
  redis.call('SET', KEYS[3], cjson.encode(user_index), 'EX', tonumber(ARGV[5]))
end
return cjson.encode({ status = 'rejected', replayed = false, payment = payment })`;

async function createPendingPayment(pending) {
  if (!pending || !String(pending.userSub || '').trim() || !MANUAL_CODE_RE.test(String(pending.code || ''))) {
    throw new Error('manual_payment_code_invalid');
  }
  return billingKvEval(CREATE_PENDING_LUA, [
    `pendingPayment:${pending.code}`, PENDING_INDEX, `user:${pending.userSub}`,
    userDeletionKey(pending.userSub), manualPaymentIndexKey(pending.userSub),
  ], [
    JSON.stringify(pending), pending.code, String(pending.userSub),
    String(PENDING_TTL_SEC), String(USER_INDEX_TTL_SEC),
  ]);
}

async function confirmPendingPayment(code, confirmedBy, now = new Date()) {
  if (!MANUAL_CODE_RE.test(String(code || ''))) throw new Error('manual_payment_code_invalid');
  const pending = await billingKvGet(`pendingPayment:${code}`);
  if (!pending) return { status: 'missing' };
  if (pending.status === 'confirmed') {
    return {
      status: 'confirmed', replayed: true, payment: pending,
      record: { plan: pending.plan, accessUntil: pending.accessUntil },
    };
  }
  if (pending.status === 'rejected') return { status: 'rejected', replayed: true, payment: pending };
  if (!pending.userSub) return { status: 'malformed_payment' };
  return billingKvEval(CONFIRM_PENDING_LUA, [
    `pendingPayment:${code}`, `user:${pending.userSub}`, PENDING_INDEX,
    userDeletionKey(pending.userSub), manualPaymentIndexKey(pending.userSub),
  ], [
    code, String(now.getTime()), now.toISOString(),
    String(confirmedBy || '').slice(0, 200), String(pending.userSub),
    String(TERMINAL_TTL_SEC), String(USER_INDEX_TTL_SEC),
  ]);
}

async function rejectPendingPayment(code, rejectedBy, now = new Date()) {
  if (!MANUAL_CODE_RE.test(String(code || ''))) throw new Error('manual_payment_code_invalid');
  const pending = await billingKvGet(`pendingPayment:${code}`);
  if (!pending) return { status: 'missing' };
  if (pending.status === 'confirmed') return { status: 'confirmed', replayed: true, payment: pending };
  if (pending.status === 'rejected') return { status: 'rejected', replayed: true, payment: pending };
  if (!pending.userSub) return { status: 'malformed_payment' };
  return billingKvEval(REJECT_PENDING_LUA, [
    `pendingPayment:${code}`, PENDING_INDEX, manualPaymentIndexKey(pending.userSub),
  ], [
    code, now.toISOString(), String(rejectedBy || '').slice(0, 200),
    String(TERMINAL_TTL_SEC), String(USER_INDEX_TTL_SEC),
  ]);
}

// Keep only the last 4 phone digits in audit metadata so the append-only
// trail does not store full numbers. (auditLog already one-way-hashes the
// userSub; this avoids parking a second raw identifier next to it.)
function phoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? '...' + digits.slice(-4) : null;
}

// Reference code like KFL-7K3Q9F (CSPRNG, no ambiguous chars).
function makeRef() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return `KFL-${s}`;
}

// ── action=request (customer) ────────────────────────────────────────────────
async function requestImpl(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const plan = normalizePlan(body?.plan);
  const period = String(body?.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const method = String(body?.method || '').toLowerCase();
  if (!['pro', 'family'].includes(plan)) return res.status(400).json({ ok: false, error: 'invalid_plan' });
  if (!['bit', 'bank'].includes(method)) return res.status(400).json({ ok: false, error: 'invalid_method', allowed: ['bit', 'bank'] });

  const bitPhone = process.env.BIT_PAYEE_PHONE;
  const bankDetails = process.env.BANK_TRANSFER_DETAILS;
  if (method === 'bit' && !bitPhone) return res.status(503).json({ ok: false, error: 'bit_not_configured' });
  if (method === 'bank' && !bankDetails) return res.status(503).json({ ok: false, error: 'bank_not_configured' });

  const userSub = req.user.sub;
  const email = req.user.email || '';
  const amountILS = priceILS(plan, period);
  const months = periodMonths(period);
  const phone = await getUserPhone(userSub).catch(() => null);
  let code = null;
  let pending = null;
  let created = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      code = makeRef();
      pending = {
        // Only the account key is needed while pending. Contact data remains
        // in its canonical account records and is never duplicated here.
        code, userSub,
        plan, period, months, amountILS, method,
        status: 'pending', createdAt: new Date().toISOString(),
      };
      created = await createPendingPayment(pending);
      if (created?.status === 'committed') break;
      if (created?.status !== 'collision') break;
    }
  } catch (error) {
    log.error('manual.payment_request_storage_failed', { reqId: req.reqId, userSub, error: error.message });
    created = null;
  }
  if (created?.status === 'account_deleted') {
    return res.status(410).json({ ok: false, error: 'account_deleted' });
  }
  if (created?.status === 'account_missing') {
    return res.status(409).json({ ok: false, error: 'account_missing' });
  }
  if (created?.status !== 'committed') {
    return res.status(503).json({ ok: false, error: 'manual_payment_storage_unavailable' });
  }

  // Alert the owner so they know to watch for the incoming Bit/bank payment.
  const label = PLAN_LABELS[plan] || plan;
  await notifyOwner(
    `💰 בקשת תשלום חדשה (${method === 'bit' ? 'ביט' : 'העברה בנקאית'})\n` +
    `תכנית: ${label} ${period === 'year' ? 'שנתי' : 'חודשי'} — ${amountILS}₪\n` +
    `לקוח: ${phone || 'לא ידוע'}${email ? ' (' + email + ')' : ''}\n` +
    `קוד: ${code}\n` +
    `לאישור: ${(process.env.PUBLIC_SITE_URL || 'https://kesefle.com')}/admin`
  ).catch(() => {});

  const instructions = method === 'bit'
    ? `שלח/י ${amountILS}₪ בביט למספר ${bitPhone}\nוכתוב/כתבי בהערה את הקוד: ${code}`
    : `העבר/י ${amountILS}₪ לחשבון:\n${bankDetails}\nוציין/י בהעברה את הקוד: ${code}`;

  log.info('manual.payment_requested', { reqId: req.reqId, userSub, plan, period, method, code });
  // Audit trail: a customer opened a manual (Bit/bank) payment request. Same
  // append-only audit:* keyspace the admin dashboard reads, so manual billing
  // is traceable like the other billing endpoints. Non-fatal on KV outage.
  await auditLog('manual_payment_requested', userSub, {
    code, plan, period, months, amountILS, method, phoneTail: phoneTail(phone),
  }, { reqId: req.reqId }).catch(() => {});
  return res.status(200).json({
    ok: true,
    code,
    amountILS,
    method,
    instructions,
    note: 'הפרימיום יופעל לאחר אישור התשלום (בדרך כלל תוך כמה שעות).',
  });
}

// ── admin actions ─────────────────────────────────────────────────────────────
async function adminImpl(req, res) {
  const action = String(req.query.action || '').toLowerCase();

  if (action === 'list') {
    const codes = (await billingKvGet(PENDING_INDEX)) || [];
    const items = [];
    for (const code of codes) {
      const p = await billingKvGet(`pendingPayment:${code}`);
      if (p && p.status === 'pending') items.push(p);
    }
    return res.status(200).json({ ok: true, count: items.length, pending: items });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const code = String(body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });
  if (!MANUAL_CODE_RE.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });

  if (action === 'reject') {
    let transition;
    try { transition = await rejectPendingPayment(code, req.user.email); }
    catch (error) {
      log.error('manual.payment_reject_storage_failed', { reqId: req.reqId, code, error: error.message });
      return res.status(503).json({ ok: false, error: 'manual_payment_storage_unavailable' });
    }
    if (transition?.status === 'missing') return res.status(404).json({ ok: false, error: 'code_not_found' });
    if (transition?.status === 'confirmed') return res.status(409).json({ ok: false, error: 'payment_already_confirmed' });
    if (transition?.status !== 'rejected' || !transition.payment) {
      return res.status(503).json({ ok: false, error: 'manual_payment_storage_unavailable' });
    }
    const pending = transition.payment;
    log.info('manual.payment_rejected', { reqId: req.reqId, code, userSub: pending.userSub, by: req.user.email });
    // Audit: admin dropped a pending manual payment. Hash the affected
    // customer's sub (not the admin's) so the trail joins to the user; record
    // the acting admin's email as the actor.
    if (!transition.replayed) {
      await auditLog('manual_payment_rejected', pending.userSub, {
        code, plan: pending.plan, period: pending.period, method: pending.method,
        amountILS: pending.amountILS, by: req.user.email,
      }, { reqId: req.reqId }).catch(() => {});
    }
    return res.status(200).json({ ok: true, code, status: transition.replayed ? 'already_rejected' : 'rejected' });
  }

  if (action === 'confirm') {
    let transition;
    try { transition = await confirmPendingPayment(code, req.user.email); }
    catch (error) {
      log.error('manual.payment_confirm_storage_failed', { reqId: req.reqId, code, error: error.message });
      return res.status(503).json({ ok: false, error: 'manual_payment_storage_unavailable' });
    }
    if (transition?.status === 'missing') return res.status(404).json({ ok: false, error: 'code_not_found' });
    if (transition?.status === 'account_deleted') return res.status(410).json({ ok: false, error: 'account_deleted' });
    if (transition?.status === 'account_missing') return res.status(409).json({ ok: false, error: 'account_missing' });
    if (transition?.status === 'rejected') return res.status(409).json({ ok: false, error: 'payment_already_rejected' });
    if (transition?.status !== 'confirmed' || !transition.payment || !transition.record) {
      return res.status(503).json({ ok: false, error: 'manual_payment_storage_unavailable' });
    }
    const pending = transition.payment;
    const rec = transition.record;
    log.info('manual.payment_confirmed', { reqId: req.reqId, code, userSub: pending.userSub, by: req.user.email });
    // Audit: admin confirmed a manual payment -> premium activated. This is the
    // money-moving event, so it MUST leave a forensic row in audit:* (the
    // dashboard's audit view + Amendment-13 trail) like every other billing
    // path. Hash the customer's sub; record the acting admin as `by`.
    if (!transition.replayed) {
      await auditLog('manual_payment_confirmed', pending.userSub, {
        code, plan: pending.plan, period: pending.period, months: pending.months,
        amountILS: pending.amountILS, method: pending.method,
        by: req.user.email, accessUntil: rec.accessUntil || null,
      }, { reqId: req.reqId }).catch(() => {});
      const phone = pending.phone || await getUserPhone(pending.userSub).catch(() => null);
      if (phone) {
        const label = PLAN_LABELS[rec.plan] || 'Premium';
        const until = new Date(rec.accessUntil);
        const untilStr = `${until.getDate()}/${until.getMonth() + 1}/${until.getFullYear()}`;
        await sendWhatsApp(phone, `✅ הפרימיום שלך (${label}) פעיל! 🎉\nבתוקף עד ${untilStr}.\n\nתודה שבחרת בכספ'לה 💚`).catch(() => {});
      }
    }
    return res.status(200).json({
      ok: true, code, status: transition.replayed ? 'already_confirmed' : 'confirmed',
      plan: rec.plan, accessUntil: rec.accessUntil,
    });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action' });
}

// ── Router ──────────────────────────────────────────────────────────────────
const requestHandler = withRateLimit({ key: 'billing_manual', limit: 10, windowSec: 3600 })(
  requireAuth(requestImpl)
);
// Defense-in-depth (audit M1, docs/AUDIT_API_ENDPOINT_SECURITY_2026_05_31.md):
// requireAdmin already gates list/confirm/reject, but a rate limit caps brute
// force if the admin token/cookie ever leaks. Matches the user-flow wrap above.
const adminHandler = withRateLimit({ key: 'billing_manual_admin', limit: 60, windowSec: 60 })(
  requireAdmin(adminImpl)
);

export default withRequestId(async function manualRouter(req, res) {
  const action = String(req.query.action || '').toLowerCase();
  if (action === 'request') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return requestHandler(req, res);
  }
  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return adminHandler(req, res);
  }
  if (action === 'confirm' || action === 'reject') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return adminHandler(req, res);
  }
  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['request', 'confirm', 'reject', 'list'] });
});

export { createPendingPayment, confirmPendingPayment, rejectPendingPayment };
