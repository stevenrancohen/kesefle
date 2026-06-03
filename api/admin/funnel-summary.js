// api/admin/funnel-summary.js
//
// Admin-only: reads today's funnel event counters (set by /api/log/funnel-
// event) and returns aggregate counts. Surfaced in launch-monitor UI to
// show the actual conversion funnel without needing PostHog/GA.

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import { withRateLimit } from '../../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Each step is { event, label } -- label is Hebrew-friendly for the admin UI.
const STEPS = [
  { event: 'signup_page_loaded', label: 'נחתו על /account' },
  { event: 'google_clicked',     label: 'לחצו "התחבר עם Google"' },
  { event: 'oauth_completed',    label: 'חזרו מ-Google עם code' },
  { event: 'sheet_provisioned',  label: 'גיליון נוצר ב-Drive' },
  { event: 'phone_link_started', label: 'ביקשו קוד חיבור לטלפון' },
  { event: 'phone_link_done',    label: 'חיברו את הטלפון' },
  { event: 'first_message_sent', label: 'שלחו הוצאה ראשונה לבוט' },
];
const ERROR_EVENTS = [
  'oauth_failed',
  'sheet_provision_failed',
  'phone_link_failed',
  'inapp_browser_detected',
];
// Secondary funnel events -- shown as separate counters, not in main funnel.
const SECONDARY_EVENTS = [
  'help_search',
  'pricing_viewed',
  'upgrade_clicked',
  'cancel_clicked',
  'bank_import_started',
  'bank_import_done',
  'bank_import_failed',
];

async function kvGetNumber(key) {
  if (!KV_URL || !KV_TOKEN) return 0;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return 0;
    const j = await r.json();
    return Number(j?.result || 0);
  } catch (_e) { return 0; }
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Default: today (UTC). Allow ?day=YYYY-MM-DD for retroactive analysis.
  const requestedDay = String(req.query.day || '').trim();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay)
    ? requestedDay
    : new Date().toISOString().slice(0, 10);

  const stepCounts = {};
  const errorCounts = {};
  const secondaryCounts = {};
  await Promise.all([
    ...STEPS.map(async (s) => { stepCounts[s.event] = await kvGetNumber(`funnel:${day}:${s.event}`); }),
    ...ERROR_EVENTS.map(async (e) => { errorCounts[e] = await kvGetNumber(`funnel:${day}:${e}`); }),
    ...SECONDARY_EVENTS.map(async (e) => { secondaryCounts[e] = await kvGetNumber(`funnel:${day}:${e}`); }),
  ]);

  // Compute drop-off rates step-to-step.
  const funnel = STEPS.map((step, i) => {
    const count = stepCounts[step.event] || 0;
    const prev = i === 0 ? count : (stepCounts[STEPS[i - 1].event] || 0);
    const conversionFromPrev = (i === 0 || prev === 0) ? 1 : count / prev;
    const dropoff = i === 0 ? 0 : Math.max(0, prev - count);
    return {
      step: step.event,
      label: step.label,
      count,
      conversion_from_prev: Number(conversionFromPrev.toFixed(3)),
      dropoff_from_prev: dropoff,
      // Drop-off percentage of the *previous* step's traffic that fell off here.
      dropoff_pct: prev > 0 ? Number((dropoff / prev).toFixed(3)) : 0,
    };
  });

  // Identify the biggest leak: the step (excluding first) with the highest
  // absolute drop-off count. Helps Steven jump straight to the worst step.
  let biggestLeakIdx = -1;
  let biggestLeakCount = 0;
  for (let i = 1; i < funnel.length; i++) {
    if (funnel[i].dropoff_from_prev > biggestLeakCount) {
      biggestLeakCount = funnel[i].dropoff_from_prev;
      biggestLeakIdx = i;
    }
  }
  const biggestLeak = biggestLeakIdx >= 0 ? {
    step: funnel[biggestLeakIdx].step,
    label: funnel[biggestLeakIdx].label,
    dropoff: biggestLeakCount,
    dropoff_pct: funnel[biggestLeakIdx].dropoff_pct,
  } : null;

  const totalErrors = Object.values(errorCounts).reduce((a, b) => a + b, 0);
  const totalLandings = stepCounts.signup_page_loaded || 0;
  const totalCompletions = stepCounts.first_message_sent || 0;
  const e2eConversion = totalLandings > 0 ? totalCompletions / totalLandings : 0;

  return res.status(200).json({
    ok: true,
    day,
    funnel,
    biggest_leak: biggestLeak,
    errors: errorCounts,
    secondary: secondaryCounts,
    summary: {
      total_landings: totalLandings,
      total_completions: totalCompletions,
      total_errors: totalErrors,
      end_to_end_conversion: Number(e2eConversion.toFixed(3)),
    },
  });
}

// Steven 2026-05-30 (deep-review PR #152 WS4 follow-up): defense-in-depth
// rate limit. Funnel summary is an admin view; 30/min is plenty for the
// /admin/launch-monitor poll loop (every 30-60s) and caps any rogue caller.
export default withRequestId(
  withRateLimit({ key: 'admin_funnel_summary', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
