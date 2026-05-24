// api/admin/referral-leaderboard.js
//
// Admin-only: scans referral:count:* + referral:redeemers:* to build a
// leaderboard of top referrers. Surfaces who's bringing the most people +
// estimated $-earned (1 referral = 1 free month for them = ~$5 value).
//
// Used by /admin/launch-monitor card "Top referrers".

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const PRO_MONTHLY_USD = Number(process.env.PRO_PLAN_MONTHLY_USD || '5'); // 19 NIS ~ $5

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function kvScan(pattern, count = 200) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 30; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    const batch = r.result?.[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys;
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const path = '/mget/' + keys.map(encodeURIComponent).join('/');
  const r = await kvFetch(path);
  return (r.result || []).map((v) => {
    try { return JSON.parse(v); }
    catch { return v; } // count keys are bare numbers stored as strings
  });
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_outage' });
  }

  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 10));

  const countKeys = await kvScan('referral:count:*');
  const counts = await kvMget(countKeys);
  const referrers = countKeys.map((key, i) => {
    const sub = key.replace('referral:count:', '');
    const count = parseInt(counts[i], 10) || 0;
    return { sub, count };
  }).filter((r) => r.count > 0).sort((a, b) => b.count - a.count).slice(0, limit);

  if (!referrers.length) {
    return res.status(200).json({
      ok: true,
      leaderboard: [],
      total_referrals: 0,
      total_value_usd: 0,
      note: 'No referrals yet -- chart is empty until first referrer brings someone in.',
    });
  }

  // Enrich with user info (name/email/created) for display.
  const userKeys = referrers.map((r) => `user:${r.sub}`);
  const users = await kvMget(userKeys);
  const enriched = referrers.map((r, i) => {
    const u = users[i] || {};
    return {
      sub: r.sub,
      count: r.count,
      name: u.name || (u.email ? u.email.split('@')[0] : 'משתמש לא ידוע'),
      email: u.email || null,
      plan: u.plan || 'free',
      // 1 referral = ~1 free month for them = $PRO_MONTHLY_USD value earned
      value_usd: r.count * PRO_MONTHLY_USD,
      // Estimated NIS value at 1 USD = 3.7 NIS (rough; surface as approximate).
      value_nis: Math.round(r.count * PRO_MONTHLY_USD * 3.7),
    };
  });

  const totalReferrals = enriched.reduce((s, r) => s + r.count, 0);
  const totalValueUsd = totalReferrals * PRO_MONTHLY_USD;

  return res.status(200).json({
    ok: true,
    leaderboard: enriched,
    total_referrals: totalReferrals,
    total_value_usd: totalValueUsd,
    pro_monthly_usd: PRO_MONTHLY_USD,
    generated_at: new Date().toISOString(),
  });
}

export default withRequestId(requireAdmin(handlerImpl));
