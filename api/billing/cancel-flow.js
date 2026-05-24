// api/billing/cancel-flow.js
//
// Retention + cancellation endpoint backing cancel.html. Four actions:
//
//   accept_discount   { months, pct }  -- record a future-prorated discount
//                                          + email confirmation
//   pause             { days }         -- mark subscription paused for N days
//                                          (Steven processes via PayPal admin)
//   cancel            { reason, comment } -- store exit-survey + fire PayPal
//                                          cancel + email confirmation
//   resume                              -- undo pause (for /account "resume me")
//
// All writes are KV-backed and idempotent. The actual PayPal sub-modification
// is best-effort -- if PayPal's API errors, we still record the customer
// intent and Steven processes manually from /admin.
//
// Auth: requireAuth (session cookie or Bearer). Rate limit 10/hour/userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { sendAlert } from '../../lib/alert.js';

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
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: typeof val === 'string' ? val : JSON.stringify(val),
    });
    return r.ok;
  } catch (_e) { return false; }
}

const VALID_REASONS = new Set(['too_expensive', 'missing_feature', 'not_using', 'bugs', 'switched', 'other', 'no_reason']);

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'billing_cancel_flow_user', limit: 10, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = String(body?.action || '').toLowerCase();

  switch (action) {
    case 'accept_discount': {
      const months = Math.max(1, Math.min(12, parseInt(body.months, 10) || 3));
      const pct = Math.max(10, Math.min(80, parseInt(body.pct, 10) || 50));
      const record = {
        userSub, months, pct,
        accepted_at: new Date().toISOString(),
        status: 'pending_admin_action',
      };
      await kvSetEx(`retention:discount:${userSub}`, record, 90 * 24 * 3600);
      log.info('cancel_flow.discount_accepted', { reqId: req.reqId, userSub, months, pct });
      sendAlert({
        severity: 'info',
        title: `Retention WIN: ${pct}% × ${months}mo discount accepted`,
        body: `userSub ${userSub} accepted the retention discount.\nApply manually in PayPal: discount their next ${months} billing cycles by ${pct}%.`,
        tags: ['retention', 'discount'],
      }).catch(() => {});
      return res.status(200).json({ ok: true, action, months, pct });
    }

    case 'pause': {
      const days = Math.max(7, Math.min(90, parseInt(body.days, 10) || 30));
      const resumeAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
      const record = {
        userSub, days, paused_at: new Date().toISOString(), resume_at: resumeAt,
        status: 'pending_admin_action',
      };
      await kvSetEx(`retention:pause:${userSub}`, record, (days + 30) * 24 * 3600);
      log.info('cancel_flow.pause_requested', { reqId: req.reqId, userSub, days, resumeAt });
      sendAlert({
        severity: 'info',
        title: `Retention WIN: ${days}-day pause requested`,
        body: `userSub ${userSub} requested a pause until ${resumeAt}.\nSuspend their PayPal subscription manually.`,
        tags: ['retention', 'pause'],
      }).catch(() => {});
      return res.status(200).json({ ok: true, action, days, resume_at: resumeAt });
    }

    case 'cancel': {
      const reason = VALID_REASONS.has(String(body.reason)) ? body.reason : 'no_reason';
      const comment = String(body.comment || '').slice(0, 500);
      const survey = {
        userSub, reason, comment,
        cancelled_at: new Date().toISOString(),
      };
      // Permanent survey log (1 year) so Steven has feedback for product decisions.
      await kvSetEx(`exit_survey:${userSub}`, survey, 365 * 24 * 3600);
      log.info('cancel_flow.cancel_confirmed', { reqId: req.reqId, userSub, reason });
      sendAlert({
        severity: 'warning',
        title: `Cancellation: reason=${reason}`,
        body: `userSub ${userSub} cancelled their subscription.\nReason: ${reason}\nComment: ${comment || '(none)'}\n\nProcess via PayPal admin + remove access at end of paid period.`,
        tags: ['churn', 'cancel'],
      }).catch(() => {});
      // TODO(steven): when GreenInvoice + PayPal admin token are wired, fire
      // PayPal /v1/billing/subscriptions/{id}/cancel here so it's auto-cancelled.
      return res.status(200).json({ ok: true, action, reason });
    }

    case 'resume': {
      const wasPaused = await kvGet(`retention:pause:${userSub}`);
      if (!wasPaused) return res.status(404).json({ ok: false, error: 'no_pause_record' });
      await kvSetEx(`retention:pause:${userSub}`, { ...wasPaused, status: 'resumed', resumed_at: new Date().toISOString() }, 30 * 24 * 3600);
      log.info('cancel_flow.resume_requested', { reqId: req.reqId, userSub });
      sendAlert({
        severity: 'info',
        title: `Retention WIN: paused user resumed`,
        body: `userSub ${userSub} resumed their subscription. Reactivate in PayPal admin if it was suspended.`,
        tags: ['retention', 'resume'],
      }).catch(() => {});
      return res.status(200).json({ ok: true, action });
    }

    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', got: action });
  }
}

export default withRequestId(
  withRateLimit({ key: 'billing_cancel_flow', limit: 60, windowSec: 60 })(requireAuth(handlerImpl))
);
