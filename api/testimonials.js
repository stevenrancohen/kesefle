// api/testimonials.js
//
// Three-mode endpoint:
//   POST /api/testimonials (bot-secret)      -- submit a new testimonial
//   GET  /api/testimonials/public            -- public approved list (cached)
//   POST /api/testimonials (admin)           -- approve/hide/delete
//
// Storage:
//   testimonial:{userSub}     -- the actual testimonial { text, name, at,
//                                 approved, hidden }
//   testimonials:all          -- sorted set (score = ts) of userSubs for
//                                 fast list operations
//
// Privacy: we store only the first name + city if provided. No phone, no
// email. The 'name' field is what the user gave the bot, capped at 30 chars.

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { requireAdmin } from '../lib/auth.js';

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

async function kvSet(key, val) {
  return kvFetch(`/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: typeof val === 'string' ? val : JSON.stringify(val),
  });
}

async function kvScan(pattern, count = 200) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 30; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
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

async function submitFromBot(req, res, body) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  const presented = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (!presented || !constantTimeEqual(String(presented), expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const userSub = String(body.userSub || '').trim();
  const text = String(body.text || '').trim().slice(0, 280);
  const name = String(body.name || '').trim().slice(0, 30);
  if (!userSub || !text || text.length < 10) {
    return res.status(400).json({ ok: false, error: 'invalid_submission' });
  }

  // Auto-reject obvious spam / single-word / mostly-emoji submissions.
  const wordCount = text.replace(/[^֐-׿a-zA-Z\s]/g, ' ').trim().split(/\s+/).length;
  if (wordCount < 3) {
    return res.status(400).json({ ok: false, error: 'too_short', detail: 'need at least 3 words' });
  }

  const record = {
    userSub,
    text,
    name: name || 'משתמש/ת',
    at: new Date().toISOString(),
    approved: false,    // admin must explicitly approve
    hidden: false,
  };
  await kvSet(`testimonial:${userSub}`, record);

  log.info('testimonial.submitted', { reqId: req.reqId, userSub, wordCount });
  return res.status(200).json({ ok: true, queued_for_review: true });
}

async function listPublic(_req, res) {
  // Read all approved + non-hidden testimonials. KV scan is cheap until we
  // have >1000 testimonials; then switch to a sorted index.
  const keys = await kvScan('testimonial:*');
  const items = (await kvMget(keys)).filter((t) => t && t.approved && !t.hidden);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // Public response strips userSub.
  const out = items.slice(0, 50).map((t) => ({
    text: t.text,
    name: t.name,
    at: t.at,
  }));
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json({ ok: true, testimonials: out, count: out.length });
}

async function listAdmin(_req, res) {
  const keys = await kvScan('testimonial:*');
  const items = (await kvMget(keys)).filter(Boolean);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return res.status(200).json({ ok: true, testimonials: items, count: items.length });
}

async function adminAction(req, res, body) {
  const userSub = String(body.userSub || '').trim();
  if (!userSub) return res.status(400).json({ ok: false, error: 'missing_userSub' });
  const action = String(body.adminAction || '').toLowerCase();
  const rec = await kvGet(`testimonial:${userSub}`);
  if (!rec) return res.status(404).json({ ok: false, error: 'not_found' });
  if (action === 'approve') rec.approved = true;
  else if (action === 'hide') rec.hidden = true;
  else if (action === 'unhide') rec.hidden = false;
  else if (action === 'edit') {
    if (typeof body.text === 'string') rec.text = body.text.slice(0, 280);
    if (typeof body.name === 'string') rec.name = body.name.slice(0, 30);
  } else if (action === 'delete') {
    await kvFetch(`/del/${encodeURIComponent('testimonial:' + userSub)}`, { method: 'POST' });
    log.info('testimonial.admin_deleted', { reqId: req.reqId, userSub, by: req.user?.email });
    return res.status(200).json({ ok: true, deleted: true });
  } else {
    return res.status(400).json({ ok: false, error: 'unknown_admin_action' });
  }
  rec.updated_at = new Date().toISOString();
  rec.updated_by = req.user?.email || 'admin';
  await kvSet(`testimonial:${userSub}`, rec);
  log.info('testimonial.admin_action', { reqId: req.reqId, userSub, action, by: req.user?.email });
  return res.status(200).json({ ok: true, testimonial: rec });
}

async function handlerImpl(req, res) {
  // GET = public list (with /public path discriminator) OR admin list.
  if (req.method === 'GET') {
    if (req.query.list_all === '1') {
      // Admin-only full list (including pending + hidden).
      const wrapped = requireAdmin(listAdmin);
      return wrapped(req, res);
    }
    return listPublic(req, res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Admin POST: action=approve|hide|unhide|edit|delete (requires admin auth).
  if (body.adminAction) {
    const wrapped = requireAdmin(function (req2, res2) { return adminAction(req2, res2, body); });
    return wrapped(req, res);
  }

  // Otherwise: bot-secret submission.
  return submitFromBot(req, res, body);
}

export default withRequestId(
  withRateLimit({ key: 'testimonials', limit: 60, windowSec: 60 })(handlerImpl)
);
