// api/admin/help-queries.js
//
// Admin-only: reads the top-N help-center search queries for a given day.
// Backed by ZINCRBY in /api/log/funnel-event when an event=help_search
// arrives with meta.q. Day-level KV TTL of 48h.
//
// Why this is a SEPARATE aggregate (not part of the funnel waterfall):
// help_search is an engagement signal, not a step on the path to first
// expense. Putting it in the funnel would mix up two different conversion
// stories. The top-queries view tells Steven what HELP content to build.
//
// GET /api/admin/help-queries?day=YYYY-MM-DD&limit=20
// Default day = today (UTC), limit = 20, max 100.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const requestedDay = String(req.query.day || '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay)
    ? requestedDay
    : new Date().toISOString().slice(0, 10);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  // ZREVRANGE returns members in score-descending order. Upstash REST
  // exposes /zrange/<key>/<start>/<stop>?withscores=true&rev=true.
  // We get up to `limit` items.
  const key = `help_queries:${day}`;
  const r = await kvFetch(`/zrange/${encodeURIComponent(key)}/0/${limit - 1}?withscores=true&rev=true`);
  if (!r.ok) {
    log.warn('admin.help_queries.kv_fetch_failed', { reqId: req.reqId, day, error: r.error || r.status });
    return res.status(200).json({ ok: true, day, queries: [], total_unique: 0, total_searches: 0, note: 'KV fetch failed; treating as empty.' });
  }

  // Upstash zrange WITHSCORES returns an array alternating member, score, member, score...
  const raw = Array.isArray(r.result) ? r.result : [];
  const queries = [];
  let totalSearches = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const q = String(raw[i] || '');
    const score = Number(raw[i + 1] || 0);
    if (!q || !score) continue;
    queries.push({ q, count: score });
    totalSearches += score;
  }

  log.info('admin.help_queries.read', { reqId: req.reqId, adminEmail: req.user?.email, day, returned: queries.length });

  return res.status(200).json({
    ok: true,
    day,
    queries,
    total_unique: queries.length,
    total_searches: totalSearches,
    note: queries.length === 0
      ? 'No help searches yet today. Will populate once /help users start typing in the search box.'
      : `Top ${queries.length} searches. Use ?day=YYYY-MM-DD for historical (48h TTL).`,
  });
}

export default withRequestId(requireAdmin(handlerImpl));
