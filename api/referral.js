// /api/referral
// Refer-a-friend program. Both referrer and redeemer may receive one lifetime
// month of Pro. Every multi-key transition is one Upstash key-locked EVAL.
//
// Storage:
//   referral:code:<sub>      -> '<CODE>'
//   referral:reverse:<code>  -> '<sub>'
//   referral:redeemed:<sub>  -> immutable, replay-safe receipt (no referrer PII)
//   referral:credit:<sub>    -> { grantedUntil, grantedAt, source }
//   referral:count:<sub>     -> integer
//   referral:redeemers:<sub> -> [{ emailInitial, at }] (never a full email)
//   audit:referral_redeem:<sub> -> immutable account-bound audit marker
//
// Legacy user:<sub>.referral_credit fields remain a read-only migration
// fallback. New writes never rewrite a whole user record.

import { requireAuth } from '../lib/auth.js';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { userDeletionKey } from '../lib/user-record.js';

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function validObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const CODE_RE = /^[A-Za-z0-9]{6}$/;

function validCode(value) {
  return typeof value === 'string' && CODE_RE.test(value) && normalizeCode(value) === value;
}

function validUserSub(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= Number.MAX_SAFE_INTEGER;
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validRedeemers(value) {
  if (!Array.isArray(value) || value.length > 200) return false;
  return value.every((entry) => validObject(entry) &&
    ((typeof entry.emailInitial === 'string' && /^[A-Za-z0-9?]$/.test(entry.emailInitial)) ||
      (typeof entry.email === 'string' && entry.email.length <= 320)) &&
    validIsoTimestamp(entry.at));
}

function validReferralCredit(value) {
  return validObject(value) &&
    validIsoTimestamp(value.grantedUntil) && validIsoTimestamp(value.grantedAt) &&
    typeof value.source === 'string' && value.source.length > 0 && value.source.length <= 320;
}

function validReferralReceipt(value) {
  if (!validObject(value) || !validCode(value.code) || !validIsoTimestamp(value.at)) return false;
  const hasReplayFields = hasOwn(value, 'grantedUntil') || hasOwn(value, 'redeemerGranted') ||
    hasOwn(value, 'referrerGranted');
  if (!hasReplayFields) return true;
  return validIsoTimestamp(value.grantedUntil) &&
    typeof value.redeemerGranted === 'boolean' && typeof value.referrerGranted === 'boolean';
}

// Only an explicit Upstash result:null means missing. Outages and malformed
// replies must never look like an unused code or an empty account.
async function kvReadValue(key, validator) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { state: 'unavailable' };
  try {
    const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { state: 'unavailable' };
    const payload = await response.json().catch(() => null);
    if (!payload || hasOwn(payload, 'error') || !hasOwn(payload, 'result')) {
      return { state: 'unavailable' };
    }
    if (payload.result === null) return { state: 'missing' };
    let value = payload.result;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* raw string is valid */ }
    }
    if (typeof validator === 'function' && !validator(value)) return { state: 'invalid_state' };
    return { state: 'found', value };
  } catch {
    return { state: 'unavailable' };
  }
}

async function runReferralEval(script, keys, args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false };
  const command = ['EVAL', script, String(keys.length), ...keys, ...args.map((value) => String(value))];
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response.ok) return { ok: false };
    const payload = await response.json().catch(() => null);
    if (!payload || hasOwn(payload, 'error') || typeof payload.result !== 'string') return { ok: false };
    let result;
    try { result = JSON.parse(payload.result); } catch { return { ok: false }; }
    if (!result || typeof result.status !== 'string') return { ok: false };
    return { ok: true, ...result };
  } catch {
    return { ok: false };
  }
}

async function kvEvalReferralCode(userSub, candidate, force, expectedExisting) {
  const oldReverseKey = expectedExisting
    ? 'referral:reverse:' + expectedExisting
    : 'referral:reverse:__none__:' + userSub;
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_ATOMIC_REFERRAL_CODE_V1
local function scalar(raw)
  if not raw then return nil end
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and (type(decoded) == 'string' or type(decoded) == 'number') then return tostring(decoded) end
  return raw
end
if redis.call('EXISTS', KEYS[5]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end
local user_raw = redis.call('GET', KEYS[4])
if not user_raw then return cjson.encode({ status = 'account_missing' }) end
local user_ok, user = pcall(cjson.decode, user_raw)
if not user_ok or type(user) ~= 'table' then return cjson.encode({ status = 'invalid_state' }) end
if user['userSub'] ~= nil and tostring(user['userSub']) ~= ARGV[1] then
  return cjson.encode({ status = 'invalid_state' })
end
local current = scalar(redis.call('GET', KEYS[1]))
if ARGV[3] ~= '1' and current then
  if current ~= ARGV[4] then return cjson.encode({ status = 'conflict', code = current }) end
  local current_owner = scalar(redis.call('GET', KEYS[3]))
  if current_owner and current_owner ~= ARGV[1] then return cjson.encode({ status = 'invalid_state' }) end
  if not current_owner then redis.call('SET', KEYS[3], cjson.encode(ARGV[1])) end
  return cjson.encode({ status = 'reused', code = current })
end
if ARGV[3] == '1' and (current or '') ~= ARGV[4] then
  return cjson.encode({ status = 'conflict', code = current or '' })
end
local candidate_owner = scalar(redis.call('GET', KEYS[2]))
if candidate_owner and candidate_owner ~= ARGV[1] then return cjson.encode({ status = 'collision' }) end
if current and current ~= ARGV[2] then
  local old_owner = scalar(redis.call('GET', KEYS[3]))
  if old_owner and old_owner ~= ARGV[1] then return cjson.encode({ status = 'invalid_state' }) end
  if old_owner == ARGV[1] then redis.call('DEL', KEYS[3]) end
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], cjson.encode(ARGV[1]))
return cjson.encode({ status = current and 'regenerated' or 'generated', code = ARGV[2] })`;
  return runReferralEval(script, [
    'referral:code:' + userSub,
    'referral:reverse:' + candidate,
    oldReverseKey,
    'user:' + userSub,
    userDeletionKey(userSub),
  ], [userSub, candidate, force ? '1' : '0', expectedExisting || '']);
}

async function kvEvalReferralRedeem({ userSub, code, referrerSub, emailInitial, nowIso, grantedUntil }) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_ATOMIC_REFERRAL_REDEEM_V1
local function scalar(raw)
  if not raw then return nil end
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and (type(decoded) == 'string' or type(decoded) == 'number') then return tostring(decoded) end
  return raw
end
local function object_required(raw)
  if not raw then return nil end
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return nil end
  local fields = 0
  for key, _ in pairs(decoded) do
    if type(key) ~= 'string' then return nil end
    fields = fields + 1
  end
  if fields == 0 then return nil end
  return decoded
end
local function strict_iso(value)
  if type(value) ~= 'string' then return false end
  local year, month, day, hour, minute, second = string.match(
    value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$'
  )
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)
  if not year or year < 1970 or year > 9999 or not month or month < 1 or month > 12 or
      not hour or hour < 0 or hour > 23 or not minute or minute < 0 or minute > 59 or
      not second or second < 0 or second > 59 then return false end
  local month_days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if month == 2 and (year % 400 == 0 or (year % 4 == 0 and year % 100 ~= 0)) then month_days[2] = 29 end
  return day ~= nil and day >= 1 and day <= month_days[month]
end
local function credit_value(raw)
  if not raw then return nil, 'missing' end
  local credit = object_required(raw)
  if not credit or not strict_iso(credit.grantedUntil) or not strict_iso(credit.grantedAt) or
      type(credit.source) ~= 'string' or string.len(credit.source) < 1 or string.len(credit.source) > 320 then
    return nil, 'invalid'
  end
  return credit, 'found'
end
local function prepare_credit(raw, user, source)
  local credit, state = credit_value(raw)
  if state == 'invalid' then return nil, false, false, false end
  if state == 'found' then return credit, false, true, false end
  local has_legacy = user.referral_credit ~= nil or
    user.referral_credit_granted_at ~= nil or user.referral_credit_source ~= nil
  if has_legacy then
    if not strict_iso(user.referral_credit) or not strict_iso(user.referral_credit_granted_at) or
        type(user.referral_credit_source) ~= 'string' or string.len(user.referral_credit_source) < 1 or
        string.len(user.referral_credit_source) > 320 then
      return nil, false, false, false
    end
    credit = {
      grantedUntil = user.referral_credit,
      grantedAt = user.referral_credit_granted_at,
      source = user.referral_credit_source
    }
    return credit, false, true, true
  end
  credit = { grantedUntil = ARGV[6], grantedAt = ARGV[5], source = source }
  return credit, true, true, true
end

if redis.call('EXISTS', KEYS[10]) == 1 or redis.call('EXISTS', KEYS[11]) == 1 then
  return cjson.encode({ status = 'account_deleted' })
end
local receipt_raw = redis.call('GET', KEYS[1])
if receipt_raw then
  local receipt = object_required(receipt_raw)
  if not receipt or type(receipt.code) ~= 'string' or not strict_iso(receipt.at) then
    return cjson.encode({ status = 'invalid_state' })
  end
  if receipt.code ~= ARGV[2] then return cjson.encode({ status = 'already_redeemed' }) end
  if not strict_iso(receipt.grantedUntil) or type(receipt.redeemerGranted) ~= 'boolean' or
      type(receipt.referrerGranted) ~= 'boolean' then
    return cjson.encode({ status = 'already_redeemed' })
  end
  return cjson.encode({
    status = 'replayed', grantedUntil = receipt.grantedUntil,
    redeemerGranted = receipt.redeemerGranted, referrerGranted = receipt.referrerGranted
  })
end
local owner = scalar(redis.call('GET', KEYS[2]))
if not owner or owner ~= ARGV[3] then return cjson.encode({ status = 'code_not_found' }) end
if owner == ARGV[1] then return cjson.encode({ status = 'self_referral' }) end

local count_raw = redis.call('GET', KEYS[3])
local count = count_raw and tonumber(count_raw) or 0
if not count or count < 0 or count % 1 ~= 0 or count >= 9007199254740991 then
  return cjson.encode({ status = 'invalid_state' })
end

local redeemers = {}
local list_raw = redis.call('GET', KEYS[4])
if list_raw then
  local ok, decoded = pcall(cjson.decode, list_raw)
  if not ok or type(decoded) ~= 'table' then return cjson.encode({ status = 'invalid_state' }) end
  local entries = 0
  for key, value in pairs(decoded) do
    if type(key) ~= 'number' or key < 1 or key % 1 ~= 0 or type(value) ~= 'table' or
        not strict_iso(value.at) then return cjson.encode({ status = 'invalid_state' }) end
    entries = entries + 1
  end
  if entries > tonumber(ARGV[9]) then return cjson.encode({ status = 'invalid_state' }) end
  for index = 1, entries do
    local value = decoded[index]
    if not value then return cjson.encode({ status = 'invalid_state' }) end
    local initial = '?'
    if type(value.emailInitial) == 'string' and string.match(value.emailInitial, '^[A-Za-z0-9?]$') then
      initial = value.emailInitial
    elseif type(value.email) ~= 'string' or string.len(value.email) > 320 then
      return cjson.encode({ status = 'invalid_state' })
    end
    table.insert(redeemers, { emailInitial = initial, at = value.at })
  end
end

local redeemer = object_required(redis.call('GET', KEYS[5]))
local referrer = object_required(redis.call('GET', KEYS[6]))
if not redeemer or not referrer then return cjson.encode({ status = 'invalid_state' }) end
local redeemer_credit, redeemer_granted, redeemer_credit_ok, redeemer_credit_write =
  prepare_credit(redis.call('GET', KEYS[7]), redeemer, ARGV[7])
if not redeemer_credit_ok then return cjson.encode({ status = 'invalid_state' }) end
local referrer_credit, referrer_granted, referrer_credit_ok, referrer_credit_write =
  prepare_credit(redis.call('GET', KEYS[8]), referrer, ARGV[8])
if not referrer_credit_ok then return cjson.encode({ status = 'invalid_state' }) end

local new_initial = string.match(ARGV[4], '^[A-Za-z0-9?]$') and ARGV[4] or '?'
table.insert(redeemers, { emailInitial = new_initial, at = ARGV[5] })
while #redeemers > tonumber(ARGV[9]) do table.remove(redeemers, 1) end
if redeemer_credit_write then redis.call('SET', KEYS[7], cjson.encode(redeemer_credit)) end
if referrer_credit_write then redis.call('SET', KEYS[8], cjson.encode(referrer_credit)) end
redis.call('SET', KEYS[1], cjson.encode({
  code = ARGV[2], at = ARGV[5], grantedUntil = redeemer_credit.grantedUntil,
  redeemerGranted = redeemer_granted, referrerGranted = referrer_granted
}))
redis.call('SET', KEYS[9], cjson.encode({ at = ARGV[5], action = 'referral_redeem' }))
redis.call('SET', KEYS[3], tostring(count + 1))
redis.call('SET', KEYS[4], cjson.encode(redeemers))
return cjson.encode({
  status = 'redeemed', grantedUntil = redeemer_credit.grantedUntil,
  redeemerGranted = redeemer_granted, referrerGranted = referrer_granted
})`;
  return runReferralEval(script, [
    'referral:redeemed:' + userSub,
    'referral:reverse:' + code,
    'referral:count:' + referrerSub,
    'referral:redeemers:' + referrerSub,
    'user:' + userSub,
    'user:' + referrerSub,
    'referral:credit:' + userSub,
    'referral:credit:' + referrerSub,
    'audit:referral_redeem:' + userSub,
    userDeletionKey(userSub),
    userDeletionKey(referrerSub),
  ], [
    userSub, code, referrerSub, String(emailInitial || '?').slice(0, 8), nowIso, grantedUntil,
    'redeemed:' + code, 'referrer_reward', 200,
  ]);
}

function generateCode() {
  let code = '';
  for (let index = 0; index < CODE_LEN; index++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function buildReferralUrl(_req, code) {
  return `https://kesefle.com/referral?ref=${encodeURIComponent(code)}`;
}

async function generateAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = String(req.user.sub);
  const force = String(req.query.force || '') === '1';
  const existingRead = await kvReadValue('referral:code:' + userSub, validCode);
  if (existingRead.state === 'unavailable') return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  if (existingRead.state === 'invalid_state') {
    return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
  }
  const expectedExisting = existingRead.state === 'found' ? existingRead.value : '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const mutation = await kvEvalReferralCode(userSub, generateCode(), force, expectedExisting);
    if (!mutation.ok) return res.status(502).json({ ok: false, error: 'kv_write_failed' });
    if (mutation.status === 'collision') continue;
    if (mutation.status === 'conflict') {
      return res.status(409).json({ ok: false, error: 'generation_conflict_retry' });
    }
    if (mutation.status === 'invalid_state') {
      return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
    }
    if (mutation.status === 'account_deleted') {
      return res.status(410).json({ ok: false, error: 'account_deleted' });
    }
    if (mutation.status === 'account_missing') {
      return res.status(409).json({ ok: false, error: 'account_missing' });
    }
    if (!['generated', 'regenerated', 'reused'].includes(mutation.status) || !validCode(mutation.code)) {
      return res.status(502).json({ ok: false, error: 'kv_write_failed' });
    }
    log.info('referral.generate', {
      reqId: req.reqId,
      regenerated: mutation.status === 'regenerated',
      reused: mutation.status === 'reused',
    });
    return res.status(200).json({
      ok: true,
      code: mutation.code,
      url: buildReferralUrl(req, mutation.code),
      reused: mutation.status === 'reused',
      regenerated: mutation.status === 'regenerated',
    });
  }
  return res.status(500).json({ ok: false, error: 'code_generation_failed_collision' });
}

async function mineAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = String(req.user.sub);
  const [codeRead, countRead, redeemersRead, creditRead, userRead] = await Promise.all([
    kvReadValue('referral:code:' + userSub, validCode),
    kvReadValue('referral:count:' + userSub, validCount),
    kvReadValue('referral:redeemers:' + userSub, validRedeemers),
    kvReadValue('referral:credit:' + userSub, validReferralCredit),
    kvReadValue('user:' + userSub, validObject),
  ]);
  const reads = [codeRead, countRead, redeemersRead, creditRead, userRead];
  if (reads.some((read) => read.state === 'unavailable')) {
    return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  }
  if (reads.some((read) => read.state === 'invalid_state')) {
    return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
  }
  const code = codeRead.state === 'found' ? codeRead.value : null;
  const count = countRead.state === 'found' ? Number(countRead.value) : 0;
  const redeemers = redeemersRead.state === 'found' ? redeemersRead.value : [];
  const userRecord = userRead.state === 'found' ? userRead.value : {};
  const credit = creditRead.state === 'found'
    ? creditRead.value.grantedUntil
    : (userRecord.referral_credit || null);
  return res.status(200).json({
    ok: true,
    code,
    url: code ? buildReferralUrl(req, code) : null,
    count,
    redeemers: redeemers.slice(0, 50).map((entry) => ({
      email_initial: (entry.emailInitial || entry.email || '?').slice(0, 1) + '***',
      at: entry.at,
    })),
    referral_credit_until: credit,
    ...(code ? {} : { note: 'No code yet - POST ?action=generate to create one.' }),
  });
}

function referralSuccessPayload(result, replayed) {
  return {
    ok: true,
    replayed,
    granted_until: result.grantedUntil,
    referrer_first_name: null,
    credit_granted_to_redeemer: result.redeemerGranted === true,
    credit_granted_to_referrer: result.referrerGranted === true,
    note_he: result.redeemerGranted === true
      ? (result.referrerGranted === true
        ? 'קיבלת חודש Pro חינם. גם החבר שהביא אותך קיבל.'
        : 'קיבלת חודש Pro חינם. החבר שהביא אותך כבר מימש בעבר את קרדיט ההפניה שלו.')
      : (result.referrerGranted === true
        ? 'קוד ההפניה נקלט. קרדיט ההפניה הקודם שלך נשמר, והחבר שהביא אותך קיבל חודש Pro.'
        : 'קוד ההפניה נקלט. לשניכם כבר הוענק בעבר קרדיט ההפניה החד-פעמי.'),
  };
}

async function redeemAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = String(req.user.sub);
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const expectedUserSub = String(body?.expectedUserSub || '');
  // Bind the browser's /api/me identity check to this mutation. A shared
  // browser can switch cookie sessions between those two requests; reject
  // before any KV read/write instead of redeeming for the newly-active account.
  if (!validUserSub(expectedUserSub) || expectedUserSub !== userSub) {
    return res.status(409).json({ ok: false, error: 'account_changed_retry' });
  }
  const code = normalizeCode(body?.code);
  if (!code || !CODE_RE.test(code)) {
    return res.status(400).json({ ok: false, error: 'invalid_code_format', hint: '6-char alphanumeric' });
  }

  const [receiptRead, reverseRead] = await Promise.all([
    kvReadValue('referral:redeemed:' + userSub, validReferralReceipt),
    kvReadValue('referral:reverse:' + code, validUserSub),
  ]);
  if (receiptRead.state === 'unavailable') return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  if (receiptRead.state === 'invalid_state') {
    return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
  }
  if (receiptRead.state === 'found') {
    if (receiptRead.value.code !== code || !hasOwn(receiptRead.value, 'grantedUntil')) {
      return res.status(409).json({ ok: false, error: 'already_redeemed' });
    }
    return res.status(200).json(referralSuccessPayload(receiptRead.value, true));
  }
  if (reverseRead.state === 'unavailable') return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  if (reverseRead.state === 'invalid_state') {
    return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
  }
  if (reverseRead.state === 'missing') return res.status(404).json({ ok: false, error: 'code_not_found' });
  const referrerSub = reverseRead.value;
  if (referrerSub === userSub) {
    return res.status(400).json({ ok: false, error: 'cannot_redeem_own_code' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const grantedUntil = new Date(now.getTime() + 30 * 86400000).toISOString();
  const first = [...String(req.user.email || '').trim()][0] || '?';
  const mutation = await kvEvalReferralRedeem({
    userSub,
    code,
    referrerSub,
    emailInitial: /^[A-Za-z0-9]$/.test(first) ? first : '?',
    nowIso,
    grantedUntil,
  });
  if (!mutation.ok) return res.status(502).json({ ok: false, error: 'kv_write_failed' });
  if (mutation.status === 'already_redeemed') {
    return res.status(409).json({ ok: false, error: 'already_redeemed' });
  }
  if (mutation.status === 'code_not_found') return res.status(404).json({ ok: false, error: 'code_not_found' });
  if (mutation.status === 'self_referral') {
    return res.status(400).json({ ok: false, error: 'cannot_redeem_own_code' });
  }
  if (mutation.status === 'invalid_state') {
    return res.status(500).json({ ok: false, error: 'referral_state_invalid' });
  }
  if (mutation.status === 'account_deleted') {
    return res.status(410).json({ ok: false, error: 'account_deleted' });
  }
  if (!['redeemed', 'replayed'].includes(mutation.status) ||
      !validIsoTimestamp(mutation.grantedUntil) ||
      typeof mutation.redeemerGranted !== 'boolean' || typeof mutation.referrerGranted !== 'boolean') {
    return res.status(502).json({ ok: false, error: 'kv_write_failed' });
  }

  log.info('referral.redeem', { reqId: req.reqId, replayed: mutation.status === 'replayed' });
  return res.status(200).json(referralSuccessPayload(mutation, mutation.status === 'replayed'));
}

async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'missing_action_param',
      hint: 'use ?action=generate (POST) | mine (GET) | redeem (POST)',
    });
  }
  switch (action) {
    case 'generate': return generateAction(req, res);
    case 'mine': return mineAction(req, res);
    case 'redeem': return redeemAction(req, res);
    default:
      return res.status(400).json({
        ok: false,
        error: 'unknown_action',
        action,
        allowed: ['generate', 'mine', 'redeem'],
      });
  }
}

export default withRequestId(
  withRateLimit({ key: 'referral', limit: 30, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
