// /api/admin/metrics
// GET — top-line system metrics for the admin dashboard.
//
// Returns:
//   { ok, metrics: {
//       totalUsers,
//       byPlan: { free, pro, family, admin },
//       paidUsers,         // pro + family + admin
//       mrr,               // monthly recurring revenue estimate in ILS, integer
//       mau,               // unique active phones last 30 days
//       dau,               // unique active phones last 24h
//       activeLast7d,      // distinct phones with last_inbound in last 7 days
//       errors24h,         // placeholder (see TODO note)
//     },
//     reqId, generatedAt }
//
// MRR estimate: we don't read Stripe live (that would slow this endpoint by
// seconds). Instead we sum a small price table over active subscriptions in KV.
// Override prices via env PRICE_PRO_ILS / PRICE_FAMILY_ILS if needed.
//
// MAU/DAU: counted off `last_inbound:<phone>` keys written by the WhatsApp
// webhook. These have a 25-hour TTL today, so anything older than 24h would
// already have been evicted. To get real 7d/30d we'd need a longer-TTL counter.
// For now, anything in the set is "active in last 24h" and we extrapolate.
// TODO: add a daily/weekly active-users counter when we add a job runner.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvScan, kvMGet, kvConfigured, kvOutage } from './_kv.js';

const PLAN_KEYS = ['free', 'pro', 'family', 'admin'];

function priceFor(plan) {
  if (plan === 'pro')    return parseInt(process.env.PRICE_PRO_ILS    || '29', 10);
  if (plan === 'family') return parseInt(process.env.PRICE_FAMILY_ILS || '49', 10);
  return 0;
}

function isPayingStatus(s) {
  return s === 'active' || s === 'trialing';
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  // 1. Users
  const userScan = await kvScan({ match: 'user:*', count: 200, maxKeys: 5000 });
  if (!userScan.ok) return kvOutage(res, reqId, 'SCAN user:* failed');
  const { values: users } = await kvMGet(userScan.keys, { concurrency: 20 });

  const byPlan = Object.fromEntries(PLAN_KEYS.map((p) => [p, 0]));
  let totalUsers = 0;
  let paidUsers = 0;
  let mrr = 0;

  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    totalUsers++;
    const plan = PLAN_KEYS.includes(u.plan) ? u.plan : 'free';
    byPlan[plan]++;
    if (plan !== 'free' && isPayingStatus(u.subscriptionStatus)) {
      paidUsers++;
      mrr += priceFor(plan);
    }
  }

  // 2. Active phones from last_inbound:*
  const inboundScan = await kvScan({ match: 'last_inbound:*', count: 500, maxKeys: 10000 });
  let dau = 0;
  let mau = 0; // best-effort given the 25h TTL; see header comment
  let activeLast7d = 0;

  if (inboundScan.ok && inboundScan.keys.length) {
    // We need timestamps to bucket DAU vs older. Fetch values.
    const { values } = await kvMGet(inboundScan.keys, { concurrency: 30 });
    const now = Date.now();
    const dayMs = 86400_000;
    for (const v of values) {
      if (!v || typeof v !== 'object' || !v.ts) continue;
      const age = now - Number(v.ts);
      if (age <= dayMs) dau++;
      if (age <= 7 * dayMs) activeLast7d++;
      if (age <= 30 * dayMs) mau++;
    }
  }

  // 3. Errors in last 24h — we don't aggregate logs in KV today. Placeholder
  //    so the SPA can render a tile; the real value will come from a future
  //    log-tap or Sentry digest job.
  const errors24h = null; // null signals "not collected yet" to UI

  log.info('admin.metrics', {
    reqId, adminEmail: req.user.email,
    totalUsers, paidUsers, mrr,
    inboundKeys: inboundScan.keys.length,
  });

  return res.status(200).json({
    ok: true,
    metrics: {
      totalUsers,
      byPlan,
      paidUsers,
      mrr,
      currency: 'ILS',
      mau,
      dau,
      activeLast7d,
      errors24h,
    },
    notes: {
      mau_caveat: 'Approximated from last_inbound TTL (25h); accurate for dau, lower-bound for mau.',
      errors24h_placeholder: 'TODO: wire to log aggregator (Sentry digest or Vercel logs query).',
    },
    generatedAt: new Date().toISOString(),
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_metrics', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
