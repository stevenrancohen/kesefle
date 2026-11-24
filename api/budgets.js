// /api/budgets
//
// Per-category monthly spending caps for a single user. Read by the dashboard
// (action=list) + by the daily budget-check cron (which compares MTD spending
// to the cap and fires a WhatsApp alert when it crosses the threshold).
//
// Storage (KV):
//   usr_budget:{userSub} -> {
//     categories: { 'מזון ופארמה': { cap: 1500, threshold: 80 }, ... },
//     updatedAt: 'ISO',
//   }
// Namespace deliberately distinct from the bot's OWNER-only `budget:{phone}:{cat}`
// keys so the daily cron's KV scan doesn't accidentally pick up unrelated rows
// (different value shape entirely).
//
// Routing:
//   POST + { action: 'set'|'list'|'remove'|'clear' } via session/Bearer auth.
//   ALSO supported (bot path): POST + bot-secret + { phone, action } for the
//   inline "/תקציב" command — we look up phone -> userSub and use the SAME
//   per-userSub KV bucket so the dashboard and the bot share state.
//
// Constraints:
//   - max 30 distinct categories per user
//   - each cap = positive int (rounded), 1..100000 NIS
//   - threshold = 1..99 percent (default 80)
//   - category MUST validate against lib/categories.js EXPENSE_GROUPS .label
//
// Rate limit: 30/hour/userSub (authed path) or 30/hour/phone (bot path).

import { withRequestId, log } from '../lib/log.js';
import { requireAuth } from '../lib/auth.js';
import { rateLimitId } from '../lib/ratelimit.js';
import { EXPENSE_GROUPS } from '../lib/categories.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_CATEGORIES = 30;
const MAX_CAP_NIS = 100000;
const DEFAULT_THRESHOLD = 80;

const VALID_LABELS = new Set(EXPENSE_GROUPS.map(g => g.label));

// ── KV helpers ──────────────────────────────────────────────────────────────
function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function validBudgetRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)) return false;
  const entries = Object.entries(value.categories);
  if (entries.length > MAX_CATEGORIES) return false;
  for (const [category, conf] of entries) {
    if (!category || !conf || typeof conf !== 'object' || Array.isArray(conf)) return false;
    const cap = Number(conf.cap);
    const threshold = Number(conf.threshold);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP_NIS) return false;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 99) return false;
  }
  return value.updatedAt == null || typeof value.updatedAt === 'string';
}

function validPhoneRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.userSub === 'string' && value.userSub.length > 0;
}

// Tri-state read: only an explicit Upstash `result:null` is missing. Transport,
// protocol and schema failures remain distinct so no mutation can mistake an
// outage for an empty budget and overwrite the user's existing categories.
async function kvReadJson(key, validator) {
  if (!KV_URL || !KV_TOKEN) return { state: 'unavailable' };
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { state: 'unavailable' };
    const j = await r.json().catch(() => null);
    if (!j || hasOwn(j, 'error') || !hasOwn(j, 'result')) return { state: 'unavailable' };
    if (j.result === null) return { state: 'missing' };
    let value;
    try { value = typeof j.result === 'string' ? JSON.parse(j.result) : j.result; }
    catch (_e) { return { state: 'invalid_state' }; }
    if (typeof validator === 'function' && !validator(value)) return { state: 'invalid_state' };
    return { state: 'found', value };
  } catch (_e) { return { state: 'unavailable' }; }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return { ok: false };
  try {
    const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json().catch(() => null);
    const scalarResult = j && j.result;
    const numericResult = typeof scalarResult === 'number' ||
      (typeof scalarResult === 'string' && /^\d+$/.test(scalarResult));
    if (!j || hasOwn(j, 'error') || !hasOwn(j, 'result') || !numericResult ||
        !Number.isInteger(Number(scalarResult))) {
      return { ok: false };
    }
    return { ok: true, deleted: Number(scalarResult) };
  } catch (_e) { return { ok: false }; }
}

async function kvEvalBudgetMutation(key, action, category, cap, threshold, updatedAt) {
  if (!KV_URL || !KV_TOKEN) return { ok: false };
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_ATOMIC_BUDGET_MUTATION_V1
local raw = redis.call('GET', KEYS[1])
local current = { categories = {}, updatedAt = cjson.null }
local count = 0
if raw then
  local decoded_ok, decoded = pcall(cjson.decode, raw)
  if not decoded_ok or type(decoded) ~= 'table' or type(decoded.categories) ~= 'table' then
    return cjson.encode({ status = 'invalid_state' })
  end
  for name, conf in pairs(decoded.categories) do
    local conf_cap = type(conf) == 'table' and tonumber(conf.cap) or nil
    local conf_threshold = type(conf) == 'table' and tonumber(conf.threshold) or nil
    if type(name) ~= 'string' or name == '' or not conf_cap or conf_cap < 1 or
       conf_cap > tonumber(ARGV[6]) or conf_cap % 1 ~= 0 or not conf_threshold or
       conf_threshold < 1 or conf_threshold > 99 or conf_threshold % 1 ~= 0 then
      return cjson.encode({ status = 'invalid_state' })
    end
    count = count + 1
  end
  if count > tonumber(ARGV[5]) then return cjson.encode({ status = 'invalid_state' }) end
  current = decoded
end

if ARGV[1] == 'set' then
  if current.categories[ARGV[2]] == nil and count >= tonumber(ARGV[5]) then
    return cjson.encode({ status = 'too_many' })
  end
  current.categories[ARGV[2]] = { cap = tonumber(ARGV[3]), threshold = tonumber(ARGV[4]) }
  current.updatedAt = ARGV[7]
  redis.call('SET', KEYS[1], cjson.encode(current))
  return cjson.encode({ status = 'stored', budget = current })
end

if ARGV[1] == 'remove' then
  if current.categories[ARGV[2]] == nil then
    return cjson.encode({ status = 'not_found', budget = current })
  end
  current.categories[ARGV[2]] = nil
  current.updatedAt = ARGV[7]
  redis.call('SET', KEYS[1], cjson.encode(current))
  return cjson.encode({ status = 'removed', budget = current })
end

return cjson.encode({ status = 'invalid_action' })`;
  const command = ['EVAL', script, '1', key, action, category, cap, threshold,
    MAX_CATEGORIES, MAX_CAP_NIS, updatedAt];
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!r.ok) return { ok: false };
    const j = await r.json().catch(() => null);
    if (!j || hasOwn(j, 'error') || typeof j.result !== 'string') return { ok: false };
    let result;
    try { result = JSON.parse(j.result); } catch (_e) { return { ok: false }; }
    if (!result || typeof result.status !== 'string') return { ok: false };
    if (result.budget && !validBudgetRecord(result.budget)) return { ok: false };
    return { ok: true, ...result };
  } catch (_e) { return { ok: false }; }
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

function emptyBudget() {
  return { categories: {}, updatedAt: null };
}

function sanitizeCap(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > MAX_CAP_NIS) return null;
  return n;
}

function sanitizeThreshold(raw) {
  if (raw == null || raw === '') return DEFAULT_THRESHOLD;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return n;
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function actSet(userSub, body) {
  const category = String(body.category || '').trim();
  if (!category) return { code: 400, json: { ok: false, error: 'missing_category' } };
  if (!VALID_LABELS.has(category)) {
    return { code: 400, json: { ok: false, error: 'invalid_category', allowed: [...VALID_LABELS] } };
  }
  const cap = sanitizeCap(body.monthlyCap != null ? body.monthlyCap : body.cap);
  if (cap == null) {
    return { code: 400, json: { ok: false, error: 'invalid_cap', maxCap: MAX_CAP_NIS } };
  }
  const threshold = sanitizeThreshold(body.alertThresholdPct != null ? body.alertThresholdPct : body.threshold);
  if (threshold == null) {
    return { code: 400, json: { ok: false, error: 'invalid_threshold' } };
  }

  const key = `usr_budget:${userSub}`;
  const mutation = await kvEvalBudgetMutation(
    key, 'set', category, cap, threshold, new Date().toISOString(),
  );
  if (!mutation.ok) return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  if (mutation.status === 'too_many') {
    return { code: 400, json: { ok: false, error: 'too_many_categories', max: MAX_CATEGORIES } };
  }
  if (mutation.status === 'invalid_state') {
    return { code: 500, json: { ok: false, error: 'budget_state_invalid' } };
  }
  if (mutation.status !== 'stored' || !mutation.budget) {
    return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  }
  return { code: 200, json: { ok: true, budget: mutation.budget } };
}

async function actList(userSub) {
  const key = `usr_budget:${userSub}`;
  const read = await kvReadJson(key, validBudgetRecord);
  if (read.state === 'unavailable') return { code: 503, json: { ok: false, error: 'kv_unavailable' } };
  if (read.state === 'invalid_state') return { code: 500, json: { ok: false, error: 'budget_state_invalid' } };
  return { code: 200, json: { ok: true, budget: read.state === 'found' ? read.value : emptyBudget() } };
}

async function actRemove(userSub, body) {
  const category = String(body.category || '').trim();
  if (!category) return { code: 400, json: { ok: false, error: 'missing_category' } };
  const key = `usr_budget:${userSub}`;
  const mutation = await kvEvalBudgetMutation(
    key, 'remove', category, 0, 0, new Date().toISOString(),
  );
  if (!mutation.ok) return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  if (mutation.status === 'invalid_state') {
    return { code: 500, json: { ok: false, error: 'budget_state_invalid' } };
  }
  if ((mutation.status !== 'removed' && mutation.status !== 'not_found') || !mutation.budget) {
    return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  }
  return { code: 200, json: {
    ok: true,
    budget: mutation.budget,
    removed: mutation.status === 'removed',
  } };
}

async function actClear(userSub) {
  const key = `usr_budget:${userSub}`;
  const result = await kvDel(key);
  if (!result.ok) return { code: 502, json: { ok: false, error: 'kv_delete_failed' } };
  return { code: 200, json: { ok: true, budget: emptyBudget(), cleared: true } };
}

async function dispatch(userSub, body) {
  const action = String(body?.action || '').toLowerCase();
  switch (action) {
    case 'set':    return actSet(userSub, body);
    case 'list':   return actList(userSub);
    case 'remove': return actRemove(userSub, body);
    case 'clear':  return actClear(userSub);
    default:       return { code: 400, json: { ok: false, error: 'unknown_action', got: action } };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
// Two entry shapes:
//   1. Authed user (cookie or Bearer) — req.user.sub is the userSub.
//   2. Bot caller — bot-secret header + body.phone resolves phone -> userSub
//      via KV (same pattern as recurring/stats). Lets the inline "/תקציב"
//      WhatsApp command share storage with the dashboard.
async function authedHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user' });

  const rl = await rateLimitId(userSub, { key: 'budgets', limit: 30, windowSec: 3600 });
  res.setHeader('X-RateLimit-Limit', '30');
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 3600));
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || 3600 });
  }

  const r = await dispatch(userSub, body);
  return res.status(r.code).json(r.json);
}

const authedWrapped = requireAuth(authedHandler);

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Bot path: bot-secret header + phone (no user session). Resolve phone ->
  // userSub via KV and then run the same per-userSub dispatch as the authed
  // path. Per-phone rate limit (30/hour). Bot-secret comparison is timing-
  // safe via constantTimeEqual -- prevents byte-by-byte secret inference
  // via response-time differentials.
  const expectedBotSecret = process.env.KESEFLE_BOT_SECRET;
  const presentedSecret = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (expectedBotSecret && presentedSecret && constantTimeEqual(String(presentedSecret), expectedBotSecret)) {
    const phone = normalizeE164(body.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const rl = await rateLimitId(phone, { key: 'budgets_bot', limit: 30, windowSec: 3600 });
    res.setHeader('X-RateLimit-Limit', '30');
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter || 3600));
      return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || 3600 });
    }

    const phoneRead = await kvReadJson(`phone:${phone}`, validPhoneRecord);
    if (phoneRead.state === 'missing') return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
    if (phoneRead.state === 'unavailable') return res.status(503).json({ ok: false, error: 'kv_unavailable' });
    if (phoneRead.state === 'invalid_state') return res.status(500).json({ ok: false, error: 'phone_mapping_invalid' });

    const r = await dispatch(phoneRead.value.userSub, body);
    log.info('budgets.bot', { reqId: req.reqId, phone, action: body.action, code: r.code });
    return res.status(r.code).json(r.json);
  }

  // Default to the authed (session / Bearer) path.
  return authedWrapped(req, res);
}

export default withRequestId(handlerImpl);
