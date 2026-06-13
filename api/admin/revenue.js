// api/admin/revenue.js
//
// Revenue / MRR aggregate for the admin dashboard. Scans all user:* records
// in KV and computes:
//   - Total users (free + trial + paid + cancelled)
//   - Active paying users (plan in {pro, family}, accessUntil in the future)
//   - Trial users (plan === 'pro/family' but in trial window, accessUntil = trialEnd)
//   - MRR (sum of normalized monthly equivalents)
//   - By-plan breakdown
//   - Churn signals (exit_survey count in last 30d / cancel rate)
//   - Plan distribution (% in each tier)
//
// GET /api/admin/revenue
// Auth: requireAdmin. Rate limit 30/hr.

import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';
import { priceILS } from '../../lib/billing.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false };
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}

async function kvScan(pattern) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 50; i++) {
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

function monthlyRevenueFor(user) {
  const plan = String(user?.plan || 'free').toLowerCase();
  if (plan !== 'pro' && plan !== 'family') return 0;
  if (!user.accessUntil) return 0;
  const until = Date.parse(user.accessUntil);
  if (!isFinite(until) || until <= Date.now()) return 0;
  const period = String(user.billingPeriod || user.period || 'month').toLowerCase();
  const price = priceILS(plan, period === 'year' ? 'year' : 'month');
  return period === 'year' ? Math.round(price / 12) : price;
}

function isTrial(user) {
  if (!user) return false;
  // Trial heuristic: subscriptionStatus === 'trial' OR (plan=pro/family AND no payment ref AND in 14d window).
  if (String(user.subscriptionStatus || '').toLowerCase() === 'trial') return true;
  const plan = String(user.plan || '').toLowerCase();
  if (plan !== 'pro' && plan !== 'family') return false;
  // activatePremium stores the provider charge id as lastPaymentRef (never as
  // externalId) — checking it keeps crypto/Bit/bank payers who paid inside the
  // 14-day window counted as PAID, not trial.
  if (user.externalId || user.lastPaymentRef || user.paymentMethod === 'paypal') return false; // real paying
  const created = Date.parse(user.connectedAt || user.createdAt || '');
  if (!isFinite(created)) return false;
  const trialDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
  return trialDays >= 0 && trialDays <= 14;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const [userKeys, exitKeys] = await Promise.all([
    kvScan('user:*'),
    kvScan('exit_survey:*'),
  ]);
  const users = (await kvMget(userKeys)).filter(Boolean);
  const exits = (await kvMget(exitKeys)).filter(Boolean);

  let total = 0, free = 0, trial = 0, paid = 0, cancelled = 0;
  let mrrIls = 0;
  const byPlan = { pro_month: 0, pro_year: 0, family_month: 0, family_year: 0, free: 0, trial: 0, cancelled: 0 };
  const paidByPlan = { pro: { count: 0, mrr: 0 }, family: { count: 0, mrr: 0 } };

  for (const u of users) {
    total++;
    const plan = String(u?.plan || 'free').toLowerCase();
    const status = String(u?.subscriptionStatus || '').toLowerCase();
    if (status === 'canceled' || status === 'cancelled') {
      cancelled++;
      byPlan.cancelled++;
      continue;
    }
    if (isTrial(u)) {
      trial++;
      byPlan.trial++;
      continue;
    }
    if (plan === 'pro' || plan === 'family') {
      const monthly = monthlyRevenueFor(u);
      if (monthly > 0) {
        paid++;
        mrrIls += monthly;
        paidByPlan[plan].count++;
        paidByPlan[plan].mrr += monthly;
        const period = String(u.billingPeriod || u.period || 'month').toLowerCase();
        const key = plan + '_' + (period === 'year' ? 'year' : 'month');
        byPlan[key]++;
      } else {
        // Plan set but no active access -- treat as free.
        free++;
        byPlan.free++;
      }
    } else {
      free++;
      byPlan.free++;
    }
  }

  // Churn metrics: cancellations in last 30d / paid+trial users (the at-risk
  // cohort).
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const recentExits = exits.filter((e) => {
    const t = Date.parse(e.cancelled_at || '');
    return isFinite(t) && t >= cutoff;
  });
  const churnRate = (paid + trial) > 0 ? recentExits.length / (paid + trial + recentExits.length) : 0;

  // LTV estimate: avg-revenue * 1 / (monthly-churn). Conservative: monthly
  // churn = recent30d-cancels / current-paid. Cap at 60 months even if churn
  // is near zero (no-business-runs-forever rule of thumb).
  const monthlyChurn = paid > 0 ? recentExits.length / paid : 0.05;
  const avgMonthlyRevenue = paid > 0 ? mrrIls / paid : 0;
  const ltv = avgMonthlyRevenue > 0 ? Math.min(60, 1 / Math.max(0.01, monthlyChurn)) * avgMonthlyRevenue : 0;

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    counts: { total, free, trial, paid, cancelled },
    mrr: {
      ils: mrrIls,
      usd_approx: Math.round(mrrIls / 3.7),
      by_plan: paidByPlan,
      avg_revenue_per_user_ils: Math.round(avgMonthlyRevenue),
    },
    arr: {
      ils: mrrIls * 12,
      usd_approx: Math.round((mrrIls * 12) / 3.7),
    },
    by_plan: byPlan,
    churn: {
      cancellations_last_30d: recentExits.length,
      monthly_churn_rate_pct: Math.round(monthlyChurn * 100 * 10) / 10,
      at_risk_cohort: paid + trial,
    },
    ltv: {
      avg_ils: Math.round(ltv),
      avg_usd: Math.round(ltv / 3.7),
      note: 'rough estimate = ARPU / monthly_churn, capped at 60 months',
    },
    conversion: {
      trial_to_paid_pct: (paid + cancelled) > 0
        ? Math.round((paid / (paid + cancelled)) * 100)
        : 0,
      signup_to_paid_pct: total > 0 ? Math.round((paid / total) * 100) : 0,
    },
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_revenue', limit: 30, windowSec: 3600 })(requireAdmin(handlerImpl))
);
