// api/announcements.js
//
// Two modes:
//   GET  /api/announcements              -- public: latest 5 active announcements
//   GET  /api/announcements?since=ISO    -- public: only newer than this date
//   POST /api/announcements (admin)      -- create/edit/delete/push announcement
//   POST /api/announcements (bot-secret) -- bot fetches "new since user last saw"
//                                            with ?phone=E164
//
// Storage:
//   announcements:list         -- sorted set (score = ts), members = id
//   announcement:{id}          -- full record { id, title, body, ctaUrl?,
//                                  ctaLabel?, audience, pushed_to[], created_at }
//   user_seen_announcement:{userSub} -- last_seen ISO so bot can filter

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { requireAdmin } from '../lib/auth.js';
import { sendAlert } from '../lib/alert.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_BODY_CHARS = 800;
const MAX_TITLE_CHARS = 80;

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

async function listActive(limit) {
  const keys = await kvScan('announcement:*');
  // Filter out non-record keys (e.g. announcement:list itself).
  const filtered = keys.filter((k) => /^announcement:[a-z0-9_-]+$/i.test(k));
  const items = (await kvMget(filtered)).filter((a) => a && !a.archived);
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return items.slice(0, limit || 10);
}

async function publicList(req, res) {
  const since = String(req.query.since || '').trim();
  let items = await listActive(20);
  if (since) {
    items = items.filter((a) => String(a.created_at) > since);
  }
  // Strip audience field from public response.
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  return res.status(200).json({
    ok: true,
    announcements: items.slice(0, 5).map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      ctaUrl: a.ctaUrl,
      ctaLabel: a.ctaLabel,
      created_at: a.created_at,
    })),
  });
}

async function botFetchNew(req, res, presented) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (!presented || !constantTimeEqual(String(presented), expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const phone = String(req.query.phone || '').replace(/\D+/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'missing_phone' });
  const phoneRec = await kvGet(`phone:${phone}`);
  const userSub = phoneRec?.userSub;
  if (!userSub) {
    // Not linked yet -- return all latest announcements (capped 3) so the
    // bot can still notify.
    const items = await listActive(3);
    return res.status(200).json({ ok: true, announcements: items });
  }
  const seen = await kvGet(`user_seen_announcement:${userSub}`);
  const since = seen?.last_seen || '';
  const items = await listActive(10);
  const newOnes = since ? items.filter((a) => String(a.created_at) > since) : items.slice(0, 3);
  // Mark them as seen.
  if (newOnes.length) {
    await kvSet(`user_seen_announcement:${userSub}`, {
      last_seen: new Date().toISOString(),
      count: (seen?.count || 0) + newOnes.length,
    });
  }
  return res.status(200).json({ ok: true, announcements: newOnes });
}

async function adminCreate(req, res, body) {
  const title = String(body.title || '').trim().slice(0, MAX_TITLE_CHARS);
  const text = String(body.body || '').trim().slice(0, MAX_BODY_CHARS);
  if (!title || !text) return res.status(400).json({ ok: false, error: 'missing_title_or_body' });
  const id = String(body.id || ('a_' + Date.now().toString(36)));
  if (!/^[a-z0-9_-]{1,40}$/i.test(id)) return res.status(400).json({ ok: false, error: 'invalid_id' });
  const ctaUrl = body.ctaUrl ? String(body.ctaUrl).trim().slice(0, 300) : '';
  const ctaLabel = body.ctaLabel ? String(body.ctaLabel).trim().slice(0, 40) : '';
  if (ctaUrl && !/^https?:\/\//.test(ctaUrl)) {
    return res.status(400).json({ ok: false, error: 'invalid_cta_url' });
  }
  const audience = String(body.audience || 'all').toLowerCase();
  const validAudiences = ['all', 'pro', 'family', 'free'];
  if (!validAudiences.includes(audience)) {
    return res.status(400).json({ ok: false, error: 'invalid_audience', detail: validAudiences.join('|') });
  }
  const rec = {
    id, title, body: text, ctaUrl, ctaLabel, audience,
    created_at: new Date().toISOString(),
    created_by: req.user?.email || 'admin',
    pushed_to: [],
    archived: false,
  };
  await kvSet(`announcement:${id}`, rec);
  log.info('announcement.created', { reqId: req.reqId, id, by: req.user?.email });
  return res.status(200).json({ ok: true, announcement: rec });
}

async function adminArchive(req, res, body) {
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
  const rec = await kvGet(`announcement:${id}`);
  if (!rec) return res.status(404).json({ ok: false, error: 'not_found' });
  rec.archived = true;
  rec.archived_at = new Date().toISOString();
  await kvSet(`announcement:${id}`, rec);
  return res.status(200).json({ ok: true, archived: id });
}

async function adminListAll(_req, res) {
  const items = await listActive(50);
  // Also include archived for full view.
  const keys = await kvScan('announcement:*');
  const filtered = keys.filter((k) => /^announcement:[a-z0-9_-]+$/i.test(k));
  const all = (await kvMget(filtered)).filter(Boolean);
  all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return res.status(200).json({
    ok: true,
    items: all,
    active_count: items.length,
    archived_count: all.length - items.length,
  });
}

async function handlerImpl(req, res) {
  if (req.method === 'GET') {
    // Bot path: x-kesefle-bot-secret header + ?phone= present
    const botSecret = req.headers['x-kesefle-bot-secret'];
    if (botSecret) return botFetchNew(req, res, botSecret);
    // Otherwise public list.
    return publicList(req, res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Admin POST: action=create|archive|list_all
  const action = String(body.action || '').toLowerCase();
  const wrapped = requireAdmin(function (req2, res2) {
    if (action === 'create') return adminCreate(req2, res2, body);
    if (action === 'archive') return adminArchive(req2, res2, body);
    if (action === 'list_all') return adminListAll(req2, res2);
    return res2.status(400).json({ ok: false, error: 'unknown_action' });
  });
  return wrapped(req, res);
}

export default withRequestId(
  withRateLimit({ key: 'announcements', limit: 120, windowSec: 60 })(handlerImpl)
);
