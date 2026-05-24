// api/billing/change-plan.js
//
// Plan upgrade/downgrade with prorate. User is on Pro (or Family) and wants
// to switch. We compute the prorate credit (unused days on the current
// plan), record the user's intent in KV, alert Steven to process the
// PayPal-side change manually, and reply with a friendly status.
//
// Why not auto-modify the PayPal subscription? Because PayPal's
// `/v1/billing/subscriptions/{id}/revise` requires a new plan_id PER
// (currency × frequency × price) tuple, and approving the revision is a
// FRESH redirect-to-PayPal flow. Combined with idempotency edge cases (a
// partial-revision can charge twice), we keep the customer-facing surface
// simple (record intent + alert) and Steven does the PayPal admin work
// once a day. When volume justifies it, switch to the full revise flow.
//
// POST /api/billing/change-plan { newPlan: 'pro' | 'family', period: 'month' | 'year' }
// Auth: requireAuth (session cookie or Bearer)
// Rate limit: 10/hour/userSub

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { sendAlert } from '../../lib/alert.js';
import { priceILS } from '../../lib/billing.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

async function kvSetEx(key, val, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: typeof val === 'string' ? val : JSON.stringify(val),
    });
    return r.ok;
  } catch (_e) { return false; }
}

// Compute the prorate credit for the unused portion of the current plan.
// Returns: { unusedDays, totalDays, currentPaidIls, creditIls, newCharge,
//            netDue, isUpgrade, isDowngrade }
//
// Approach (deliberately simple, matches what a small biz expects):
//   - currentPaid = priceILS(currentPlan, currentPeriod)
//   - unusedDays = days remaining until accessUntil
//   - totalDays  = period length in days (30 for month, 365 for year)
//   - creditIls  = currentPaid * (unusedDays / totalDays)  -- rounded down
//   - newCharge  = priceILS(newPlan, newPeriod)            -- next cycle
//   - netDue     = max(0, newCharge - creditIls)           -- one-time first charge
function computeProrate({ currentPlan, currentPeriod, accessUntil, newPlan, newPeriod }) {
  const now = Date.now();
  const currentPaidIls = priceILS(currentPlan, currentPeriod);
  const totalDays = currentPeriod === 'year' ? 365 : 30;
  let unusedDays = 0;
  if (accessUntil) {
    const until = Date.parse(accessUntil);
    if (until > now) {
      unusedDays = Math.max(0, Math.min(totalDays, Math.ceil((until - now) / (1000 * 60 * 60 * 24))));
    }
  }
  const creditIls = Math.floor(currentPaidIls * (unusedDays / totalDays));
  const newCharge = priceILS(newPlan, newPeriod);
  const netDue = Math.max(0, newCharge - creditIls);
  const isUpgrade = newCharge > currentPaidIls;
  const isDowngrade = newCharge < currentPaidIls;
  return { unusedDays, totalDays, currentPaidIls, creditIls, newCharge, netDue, isUpgrade, isDowngrade };
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'billing_change_plan_user', limit: 10, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const newPlan = String(body.newPlan || '').toLowerCase();
  const newPeriod = String(body.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  if (newPlan !== 'pro' && newPlan !== 'family') {
    return res.status(400).json({ ok: false, error: 'invalid_new_plan', detail: 'newPlan must be "pro" or "family"' });
  }

  // Read current state.
  const user = await kvGet(`user:${userSub}`);
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

  const currentPlan = String(user.plan || 'free').toLowerCase();
  const currentPeriod = user.billingPeriod === 'year' ? 'year' : 'month';

  if (currentPlan === 'free') {
    // Not really a "change" -- just point them at /pricing for the initial sub.
    return res.status(409).json({
      ok: false,
      error: 'no_active_subscription',
      detail: 'אתה במסלול חינמי. כדי להתחיל, לך ל-/pricing.',
      redirect: '/pricing',
    });
  }

  if (currentPlan === newPlan && currentPeriod === newPeriod) {
    return res.status(409).json({ ok: false, error: 'no_change', detail: 'אתה כבר על המסלול הזה.' });
  }

  const prorate = computeProrate({
    currentPlan, currentPeriod,
    accessUntil: user.accessUntil,
    newPlan, newPeriod,
  });

  // Record the intent (15-day TTL -- Steven processes within a few days).
  const record = {
    userSub,
    requested_at: new Date().toISOString(),
    from: { plan: currentPlan, period: currentPeriod },
    to: { plan: newPlan, period: newPeriod },
    prorate,
    status: 'pending_admin_action',
  };
  await kvSetEx(`plan_change:${userSub}`, record, 15 * 24 * 3600);

  log.info('billing.change_plan_requested', {
    reqId: req.reqId, userSub, from: currentPlan, to: newPlan,
    creditIls: prorate.creditIls, netDue: prorate.netDue,
  });
  sendAlert({
    severity: prorate.isDowngrade ? 'info' : 'warning',
    title: `Plan ${prorate.isUpgrade ? 'UPGRADE' : 'DOWNGRADE'}: ${currentPlan}/${currentPeriod} -> ${newPlan}/${newPeriod}`,
    body: `userSub ${userSub} (${user.email || 'unknown email'}) requested a plan change.\n\n` +
      `From: ${currentPlan}/${currentPeriod} at ${prorate.currentPaidIls} NIS\n` +
      `To:   ${newPlan}/${newPeriod} at ${prorate.newCharge} NIS\n` +
      `Prorate credit: ${prorate.creditIls} NIS (${prorate.unusedDays}/${prorate.totalDays} days unused)\n` +
      `Net due on next cycle: ${prorate.netDue} NIS\n\n` +
      `Process via PayPal admin: cancel current sub + create new one OR use PayPal's revise flow.`,
    tags: ['billing', 'plan-change'],
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    from: { plan: currentPlan, period: currentPeriod },
    to: { plan: newPlan, period: newPeriod },
    prorate,
    note: prorate.isUpgrade
      ? `שדרוג נרשם. תזוכה ב-${prorate.creditIls} ש"ח על הימים שלא ניצלת. החיוב הבא יהיה ${prorate.netDue} ש"ח. נציג יחזור אליך בוואטסאפ.`
      : `שינוי מסלול נרשם. הזיכוי על הימים שלא ניצלת (${prorate.creditIls} ש"ח) יקוזז מהחיוב הבא. נציג יחזור אליך בוואטסאפ.`,
  });
}

export default withRequestId(
  withRateLimit({ key: 'billing_change_plan', limit: 30, windowSec: 60 })(requireAuth(handlerImpl))
);
