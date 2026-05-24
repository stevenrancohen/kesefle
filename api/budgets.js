// /api/budgets
//
// Per-category monthly spending caps for a single user. Read by the dashboard
// (action=list) + by the daily budget-check cron (which compares MTD spending
// to the cap and fires a WhatsApp alert when it crosses the threshold).
//
// Storage (KV):
//   budget:{userSub} -> {
//     categories: { 'מזון ופארמה': { cap: 1500, threshold: 80 }, ... },
//     updatedAt: 'ISO',
//   }
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
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) { return false; }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return r.ok;
  } catch (_e) { return false; }
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

  const key = `budget:${userSub}`;
  const current = (await kvGet(key)) || emptyBudget();
  const existing = current.categories[category];
  const nextCats = { ...current.categories, [category]: { cap, threshold } };
  if (!existing && Object.keys(nextCats).length > MAX_CATEGORIES) {
    return { code: 400, json: { ok: false, error: 'too_many_categories', max: MAX_CATEGORIES } };
  }
  const next = { categories: nextCats, updatedAt: new Date().toISOString() };
  const ok = await kvSet(key, next);
  if (!ok) return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  return { code: 200, json: { ok: true, budget: next } };
}

async function actList(userSub) {
  const key = `budget:${userSub}`;
  const b = (await kvGet(key)) || emptyBudget();
  return { code: 200, json: { ok: true, budget: b } };
}

async function actRemove(userSub, body) {
  const category = String(body.category || '').trim();
  if (!category) return { code: 400, json: { ok: false, error: 'missing_category' } };
  const key = `budget:${userSub}`;
  const current = (await kvGet(key)) || emptyBudget();
  if (!current.categories || !(category in current.categories)) {
    return { code: 200, json: { ok: true, budget: current, removed: false } };
  }
  const nextCats = { ...current.categories };
  delete nextCats[category];
  const next = { categories: nextCats, updatedAt: new Date().toISOString() };
  const ok = await kvSet(key, next);
  if (!ok) return { code: 502, json: { ok: false, error: 'kv_write_failed' } };
  return { code: 200, json: { ok: true, budget: next, removed: true } };
}

async function actClear(userSub) {
  const key = `budget:${userSub}`;
  const ok = await kvDel(key);
  if (!ok) return { code: 502, json: { ok: false, error: 'kv_delete_failed' } };
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
  // path. Per-phone rate limit (30/hour).
  const expectedBotSecret = process.env.KESEFLE_BOT_SECRET;
  const presentedSecret = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  if (expectedBotSecret && presentedSecret && presentedSecret === expectedBotSecret) {
    const phone = normalizeE164(body.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const rl = await rateLimitId(phone, { key: 'budgets_bot', limit: 30, windowSec: 3600 });
    res.setHeader('X-RateLimit-Limit', '30');
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter || 3600));
      return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || 3600 });
    }

    const phoneRec = await kvGet(`phone:${phone}`);
    if (!phoneRec || !phoneRec.userSub) return res.status(404).json({ ok: false, error: 'no_user_for_phone' });

    const r = await dispatch(phoneRec.userSub, body);
    log.info('budgets.bot', { reqId: req.reqId, phone, action: body.action, code: r.code });
    return res.status(r.code).json(r.json);
  }

  // Default to the authed (session / Bearer) path.
  return authedWrapped(req, res);
}

export default withRequestId(handlerImpl);
