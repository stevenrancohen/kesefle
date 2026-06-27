// /api/events
// Consolidated event endpoint: waitlist signups, anonymous analytics, NPS feedback.
// Why one file: Vercel Hobby has a 12-function limit; folding three thin endpoints
// into one router keeps headroom for future endpoints.
//
// Actions:
//   POST ?action=waitlist  body: { email, source } → waitlist signup (KV-persisted, rate-limited)
//   POST ?action=track     body: { event, path, meta, session } → privacy-friendly counter
//   POST ?action=nps       body: { score (0–10), comment, session, path } → NPS feedback
//
// All anonymous; no auth required; no cookies; no fingerprinting.

import { withRequestId, log } from '../lib/log.js';
import { rateLimit } from '../lib/ratelimit.js';
import { rateLimit as ipRateLimit } from './_lib/rateLimit.js';

// ---------- KV helpers (REST, no npm) ----------
function kvConfig() {
  return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
}

async function kvIncr(key) {
  const { url, token } = kvConfig();
  if (!url || !token) return { ok: false, kvOutage: true };
  try {
    const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, count: j?.result ?? 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function kvSadd(key, member) {
  const { url, token } = kvConfig();
  if (!url || !token) return { ok: false, kvOutage: true };
  try {
    const r = await fetch(`${url}/sadd/${encodeURIComponent(key)}/${encodeURIComponent(member)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function kvExpire(key, seconds) {
  const { url, token } = kvConfig();
  if (!url || !token) return;
  try {
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${seconds}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch { /* non-fatal */ }
}

async function kvSet(key, value) {
  const { url, token } = kvConfig();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

async function kvLpush(key, value) {
  const { url, token } = kvConfig();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/lpush/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([typeof value === 'string' ? value : JSON.stringify(value)]),
    });
    return r.ok;
  } catch { return false; }
}

// ---------- Helpers ----------
function todayUTC() { return new Date().toISOString().slice(0, 10); }

function clientIP(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) || 'unknown';
}

function sanitizePath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  return raw.split('?')[0].split('#')[0].slice(0, 100);
}

function sanitizeSession(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
}

// ---------- waitlist sub-handler ----------
const RATE_LIMIT_IP_PER_HOUR = 5;
const RATE_LIMIT_EMAIL_PER_HOUR = 3;

async function bucketHourly(kvUrl, kvToken, key, limit) {
  try {
    const r = await fetch(`${kvUrl}/incr/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    const j = await r.json();
    const count = j?.result ?? 0;
    if (count === 1) {
      await fetch(`${kvUrl}/expire/${encodeURIComponent(key)}/3600`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
      });
    }
    return { ok: count <= limit, count, limit };
  } catch (e) { return { ok: true, count: 0, limit, kvError: e.message }; }
}

async function handleWaitlist(req, res, body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const source = String(body?.source || 'unknown').slice(0, 64);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const { url: kvUrl, token: kvToken } = kvConfig();
  if (kvUrl && kvToken) {
    const ip = clientIP(req);
    const ipKey = `rl:wait:ip:${ip}`;
    const emailKey = `rl:wait:em:${email}`;
    const ipLim = await bucketHourly(kvUrl, kvToken, ipKey, RATE_LIMIT_IP_PER_HOUR);
    if (!ipLim.ok) return res.status(429).json({ ok: false, error: 'rate_limit_ip', retry_after: 3600 });
    const emLim = await bucketHourly(kvUrl, kvToken, emailKey, RATE_LIMIT_EMAIL_PER_HOUR);
    if (!emLim.ok) return res.status(429).json({ ok: false, error: 'rate_limit_email', retry_after: 3600 });
  }

  const entry = {
    email, source,
    ts: new Date().toISOString(),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    ref: String(req.headers['referer'] || '').slice(0, 200),
    ip: clientIP(req),
  };

  if (kvUrl && kvToken) {
    try {
      const id = `wait:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      await fetch(`${kvUrl}/sadd/waitlist_emails/${encodeURIComponent(email)}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
      });
    } catch (err) {
      log.warn('waitlist.kv_write_failed', { reqId: req.reqId, error: err.message });
    }
  } else {
    log.info('WAITLIST', entry);
  }
  return res.status(200).json({ ok: true });
}

// ---------- analytics sub-handler ----------
const ALLOWED_EVENTS = new Set([
  'page_view', 'cta_click', 'signup_start', 'signup_complete',
  'sheet_provisioned', 'first_message_received', 'subscribe_clicked',
  'export_downloaded', 'feature_used', 'help_search', 'install_pwa',
  'referral_share', 'referral_redeem',
]);
const ALLOWED_META_KEYS = new Set([
  'plan', 'category', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'lang', 'feature',
]);
const RETENTION_SECONDS = 90 * 24 * 3600;

function sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_META_KEYS.has(k) || v == null) continue;
    const s = String(v).slice(0, 64);
    if (s) out[k] = s;
  }
  return out;
}

async function handleTrack(req, res, body) {
  const event = String(body.event || '').trim();
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ ok: false, error: 'invalid_event', event });
  }
  const session = sanitizeSession(body.session);
  if (!session) return res.status(400).json({ ok: false, error: 'invalid_session' });

  const lim = await rateLimit(req, { key: 'analytics', limit: 200, windowSec: 60 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter || 60 });

  const date = todayUTC();
  const counterKey = `analytics:${date}:${event}`;
  const sessionKey = `analytics:session:${date}:${event}`;
  const [incrRes, saddRes] = await Promise.all([
    kvIncr(counterKey),
    kvSadd(sessionKey, session),
  ]);
  if (incrRes.ok && incrRes.count === 1) {
    kvExpire(counterKey, RETENTION_SECONDS);
    kvExpire(sessionKey, RETENTION_SECONDS);
  }
  if (incrRes.kvOutage || saddRes.kvOutage) {
    log.warn('analytics.kv_outage', { reqId: req.reqId });
  } else if (!incrRes.ok || !saddRes.ok) {
    log.warn('analytics.write_failed', { reqId: req.reqId, event });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(204).end();
}

// ---------- NPS sub-handler ----------
async function handleNps(req, res, body) {
  const score = Number(body?.score);
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    return res.status(400).json({ ok: false, error: 'invalid_score' });
  }
  const comment = String(body?.comment || '').slice(0, 500);
  const session = sanitizeSession(body?.session);
  const path = sanitizePath(body?.path);

  // Rate-limit by IP — one NPS submission per IP per 24h to prevent spam.
  const lim = await rateLimit(req, { key: 'nps', limit: 3, windowSec: 86400 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limit' });

  const date = todayUTC();
  const intScore = Math.round(score);
  const bucket =
    intScore >= 9 ? 'promoter' :
    intScore >= 7 ? 'passive' : 'detractor';

  // Counter per bucket + day + path
  const counterKey = `nps:${date}:${bucket}`;
  const incrRes = await kvIncr(counterKey);
  if (incrRes.ok && incrRes.count === 1) kvExpire(counterKey, RETENTION_SECONDS);

  // Persist the full feedback record for human review (capped list of last 500)
  if (comment) {
    const record = {
      score: intScore, bucket, comment, path, session, ts: new Date().toISOString(),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    };
    await kvLpush('nps:feedback', record);
    // Truncate list to last 500 entries (ltrim 0 499)
    const { url, token } = kvConfig();
    if (url && token) {
      try {
        await fetch(`${url}/ltrim/nps%3Afeedback/0/499`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
        });
      } catch { /* non-fatal */ }
    }
  }
  return res.status(200).json({ ok: true, bucket });
}

// Strict CORS — only our own origins may call this from a browser.
// Reflects the request origin only if it's on the allowlist; otherwise
// sends no ACAO header (the browser then blocks the cross-origin read).
const _ALLOWED_ORIGINS_ = [
  'https://kesefle.com',
  'https://www.kesefle.com',
  'https://kesefle.vercel.app',
  'http://localhost:5274',
  'http://localhost:3000',
];
function applyCors(req, res) {
  const origin = req.headers?.origin || '';
  if (_ALLOWED_ORIGINS_.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ---------- Router ----------
async function handlerImpl(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (await ipRateLimit(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  // Reject oversized payloads before parsing — a waitlist/track/nps
  // event is a few hundred bytes; anything over 8KB is abuse.
  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (contentLength > 8192) {
    return res.status(413).json({ ok: false, error: 'payload_too_large' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > 8192) return res.status(413).json({ ok: false, error: 'payload_too_large' });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  const action = String(req.query?.action || body.action || 'waitlist').toLowerCase();
  switch (action) {
    case 'waitlist': return handleWaitlist(req, res, body);
    case 'track':    return handleTrack(req, res, body);
    case 'nps':      return handleNps(req, res, body);
    default:         return res.status(400).json({ ok: false, error: 'unknown_action', action });
  }
}

export default withRequestId(handlerImpl);
