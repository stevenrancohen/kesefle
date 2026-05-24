// api/nps.js
//
// Record NPS scores (0-10) submitted by users via the bot. Optionally
// returns the aggregate for /admin.
//
// POST (bot-secret): { userSub, score: 0-10, comment?: '...' }
//   Stores nps:{userSub} = { score, comment, at }. Last submission wins.
// GET  (admin):       returns { distribution: { 0..10: count }, nps_score,
//                                detractors, passives, promoters, total,
//                                recent: [...] }

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

async function submitFromBot(req, res, body) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  const presented = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (!presented || !constantTimeEqual(String(presented), expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const userSub = String(body.userSub || '').trim();
  const score = Number(body.score);
  const comment = String(body.comment || '').trim().slice(0, 280);
  if (!userSub || !Number.isInteger(score) || score < 0 || score > 10) {
    return res.status(400).json({ ok: false, error: 'invalid_score', detail: 'score must be 0..10' });
  }

  const record = { userSub, score, comment, at: new Date().toISOString() };
  await kvFetch(`/set/${encodeURIComponent('nps:' + userSub)}`, {
    method: 'POST', body: JSON.stringify(record),
  });
  log.info('nps.submitted', { reqId: req.reqId, userSub, score });
  return res.status(200).json({ ok: true });
}

async function adminAggregate(_req, res) {
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });
  const keys = await kvScan('nps:*');
  const items = (await kvMget(keys)).filter(Boolean);
  const distribution = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0 };
  let detractors = 0, passives = 0, promoters = 0;
  for (const it of items) {
    const s = Number(it.score);
    if (Number.isInteger(s) && s >= 0 && s <= 10) {
      distribution[s]++;
      if (s <= 6) detractors++;
      else if (s <= 8) passives++;
      else promoters++;
    }
  }
  const total = detractors + passives + promoters;
  const npsScore = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : 0;
  // Recent 10, sorted by timestamp desc, with userSub redacted to first 8.
  const recent = items
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 10)
    .map((it) => ({
      sub: (it.userSub || '').slice(0, 8) + '...',
      score: it.score,
      comment: it.comment,
      at: it.at,
    }));
  return res.status(200).json({
    ok: true,
    nps_score: npsScore,
    total,
    distribution,
    detractors,
    passives,
    promoters,
    recent,
  });
}

async function handlerImpl(req, res) {
  if (req.method === 'GET') {
    const wrapped = requireAdmin(adminAggregate);
    return wrapped(req, res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return submitFromBot(req, res, body || {});
}

export default withRequestId(
  withRateLimit({ key: 'nps', limit: 60, windowSec: 60 })(handlerImpl)
);
