// api/waitlist.js
//
// Lead-capture endpoint for users who can't complete signup right now
// (in-app browser block, no Chrome, network issues, WABA-not-approved).
// Steven contacts them manually once the blocker is resolved.
//
// POST { phone?, email?, source?, ua?, message? }
//   - at least one of phone / email is required
//   - source = where the form was shown ('inapp_block' | 'wait_for_waba' | ...)
//   - ua/message: optional context for support
// Returns: { ok, queueId, position }
//
// GET (admin):
//   - list all waitlist entries with pagination
//   - mark contacted/converted/declined
//
// Storage:
//   waitlist:{id}  -- full record { id, phone, email, source, ua, message,
//                                    at, status, contacted_at?, note? }
//   waitlist:phone:{normalizedPhone} -- pointer for dedup (1 entry per phone)
//   waitlist:email:{lowerEmail}      -- pointer for dedup (1 entry per email)

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit, rateLimitId } from '../lib/ratelimit.js';
import { requireAdmin } from '../lib/auth.js';
import { sendAlert } from '../lib/alert.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}

async function kvSet(key, val, ttl) {
  const path = ttl ? `/set/${encodeURIComponent(key)}?EX=${ttl}` : `/set/${encodeURIComponent(key)}`;
  return kvFetch(path, {
    method: 'POST',
    body: typeof val === 'string' ? val : JSON.stringify(val),
  });
}

async function kvScan(pattern) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 30; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const r = await kvFetch('/mget/' + keys.map(encodeURIComponent).join('/'));
  return (r.result || []).map((v) => { try { return JSON.parse(v); } catch { return null; } });
}

function normalizePhone(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '972' + s.slice(1);
  if (s.length < 9 || s.length > 15) return null;
  return s;
}

function validEmail(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim().toLowerCase();
  if (s.length < 5 || s.length > 80) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

async function publicSubmit(req, res, body) {
  // Rate limit per IP since this is anonymous.
  const lim = await rateLimitId(req.socket?.remoteAddress || 'anon', { key: 'waitlist_submit_ip', limit: 5, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

  const phone = normalizePhone(body.phone);
  const email = validEmail(body.email);
  if (!phone && !email) {
    return res.status(400).json({ ok: false, error: 'need_phone_or_email' });
  }

  // Dedup: if either phone or email already in waitlist, reuse the entry.
  if (phone) {
    const existingId = await kvGet(`waitlist:phone:${phone}`);
    if (existingId) {
      return res.status(200).json({ ok: true, queueId: existingId, already_on_list: true });
    }
  }
  if (email) {
    const existingId = await kvGet(`waitlist:email:${email}`);
    if (existingId) {
      return res.status(200).json({ ok: true, queueId: existingId, already_on_list: true });
    }
  }

  const id = 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    phone: phone || null,
    email: email || null,
    source: String(body.source || 'unknown').slice(0, 40),
    ua: String(body.ua || req.headers['user-agent'] || '').slice(0, 200),
    message: String(body.message || '').slice(0, 280),
    at: new Date().toISOString(),
    status: 'pending',
    contacted_at: null,
    note: null,
  };
  await kvSet(`waitlist:${id}`, rec);
  if (phone) await kvSet(`waitlist:phone:${phone}`, id);
  if (email) await kvSet(`waitlist:email:${email}`, id);

  log.info('waitlist.submitted', { reqId: req.reqId, id, source: rec.source, has_phone: !!phone, has_email: !!email });

  // Notify admin so Steven knows someone wants on.
  sendAlert({
    severity: 'info',
    title: 'New waitlist signup',
    body: `Source: ${rec.source}\nPhone: ${phone || '(none)'}\nEmail: ${email || '(none)'}\nMessage: ${rec.message || '(none)'}\nUA: ${rec.ua.slice(0, 80)}\n\nReview in /admin/launch-monitor`,
    tags: ['waitlist'],
  }).catch(() => {});

  // Try to give the user a queue position (count of pending entries).
  let position = 0;
  try {
    const allKeys = await kvScan('waitlist:w_*');
    position = allKeys.length;
  } catch (_e) {}

  return res.status(200).json({ ok: true, queueId: id, position });
}

async function adminList(_req, res) {
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });
  const keys = await kvScan('waitlist:w_*');
  const items = (await kvMget(keys)).filter(Boolean);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const pending = items.filter((i) => i.status === 'pending').length;
  const contacted = items.filter((i) => i.status === 'contacted').length;
  const converted = items.filter((i) => i.status === 'converted').length;
  return res.status(200).json({
    ok: true,
    items: items.slice(0, 100),
    total: items.length,
    pending, contacted, converted,
  });
}

async function adminUpdate(req, res, body) {
  const id = String(body.id || '').trim();
  if (!id || !/^w_[a-z0-9_]+$/.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const status = String(body.status || '').toLowerCase();
  const validStatuses = ['pending', 'contacted', 'converted', 'declined'];
  if (!validStatuses.includes(status)) return res.status(400).json({ ok: false, error: 'invalid_status' });
  const rec = await kvGet(`waitlist:${id}`);
  if (!rec) return res.status(404).json({ ok: false, error: 'not_found' });
  rec.status = status;
  if (status === 'contacted' || status === 'converted') {
    rec.contacted_at = new Date().toISOString();
  }
  if (typeof body.note === 'string') rec.note = body.note.slice(0, 280);
  await kvSet(`waitlist:${id}`, rec);
  log.info('waitlist.admin_update', { reqId: req.reqId, id, status, by: req.user?.email });
  return res.status(200).json({ ok: true, record: rec });
}

async function handlerImpl(req, res) {
  if (req.method === 'GET') {
    // Admin-only list.
    const wrapped = requireAdmin(adminList);
    return wrapped(req, res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Admin POST: action=update
  if (body.adminAction === 'update') {
    const wrapped = requireAdmin(function (req2, res2) { return adminUpdate(req2, res2, body); });
    return wrapped(req, res);
  }
  // Otherwise: public submit.
  return publicSubmit(req, res, body);
}

export default withRequestId(
  withRateLimit({ key: 'waitlist', limit: 60, windowSec: 60 })(handlerImpl)
);
