// api/group/mine.js
//
// Session-authed lookup: returns the current user's family/group (if any).
// Used by /family-invite.html to show the user's join-code + QR.
//
// GET /api/group/mine
// Auth: requireAuth (session cookie or Bearer).
// Rate limit: 60/hour/userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false };
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
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

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'group_mine_user', limit: 60, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  // Get the user's linked phone.
  const userRec = await kvGet(`user:${userSub}`);
  const phone = userRec?.linkedPhone || userRec?.phone;
  if (!phone) {
    return res.status(200).json({ ok: true, group: null, reason: 'no_phone_linked' });
  }
  const cleanPhone = String(phone).replace(/\D+/g, '');

  // Scan group:* for one where this phone is a member. Bounded scan; if the
  // user has multiple groups (rare), return the first match (the one they
  // created or joined most recently).
  const groupKeys = await kvScan('group:*');
  // Filter out non-group keys (e.g. group_invite:* aliases).
  const onlyGroupKeys = groupKeys.filter((k) => /^group:[A-Z0-9]{4,12}$/i.test(k));
  const groups = (await kvMget(onlyGroupKeys)).filter(Boolean);
  const myGroup = groups.find((g) => {
    return Array.isArray(g.members) && g.members.some((m) => {
      const mPhone = String(m.phone || '').replace(/\D+/g, '');
      return mPhone === cleanPhone;
    });
  });

  if (!myGroup) {
    return res.status(200).json({ ok: true, group: null, reason: 'no_group' });
  }

  log.info('group_mine.read', { reqId: req.reqId, userSub, code: myGroup.code });
  // Strip member phones from public response (privacy: only return our own
  // phone + the group meta).
  return res.status(200).json({
    ok: true,
    group: {
      code: myGroup.code,
      name: myGroup.name,
      memberCount: (myGroup.members || []).length,
      createdAt: myGroup.createdAt,
      isCreator: String(myGroup.createdBy || '').replace(/\D+/g, '') === cleanPhone,
      sheetUrl: myGroup.sheetUrl || null,
    },
  });
}

export default withRequestId(
  withRateLimit({ key: 'group_mine', limit: 60, windowSec: 60 })(requireAuth(handlerImpl))
);
