// api/admin/funnel-summary.js
//
// Admin-only: reads today's funnel event counters (set by /api/log/funnel-
// event) and returns aggregate counts. Surfaced in launch-monitor UI to
// show the actual conversion funnel without needing PostHog/GA.

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const STEPS = [
  'signup_page_loaded',
  'google_clicked',
  'oauth_completed',
  'sheet_provisioned',
  'phone_link_started',
  'phone_link_done',
  'first_message_sent',
];
const ERROR_EVENTS = [
  'oauth_failed',
  'sheet_provision_failed',
  'phone_link_failed',
  'inapp_browser_detected',
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
  await Promise.all([
    ...STEPS.map(async (s) => { stepCounts[s] = await kvGetNumber(`funnel:${day}:${s}`); }),
    ...ERROR_EVENTS.map(async (e) => { errorCounts[e] = await kvGetNumber(`funnel:${day}:${e}`); }),
  ]);

  // Compute drop-off rates step-to-step.
  const funnel = STEPS.map((step, i) => {
    const count = stepCounts[step] || 0;
    const prev = i === 0 ? count : (stepCounts[STEPS[i - 1]] || 0);
    const conversionFromPrev = (i === 0 || prev === 0) ? 1 : count / prev;
    return {
      step,
      count,
      conversion_from_prev: Number(conversionFromPrev.toFixed(3)),
      dropoff_from_prev: i === 0 ? 0 : Math.max(0, prev - count),
    };
  });

  const totalErrors = Object.values(errorCounts).reduce((a, b) => a + b, 0);
  const totalLandings = stepCounts.signup_page_loaded || 0;
  const totalCompletions = stepCounts.first_message_sent || 0;
  const e2eConversion = totalLandings > 0 ? totalCompletions / totalLandings : 0;

  return res.status(200).json({
    ok: true,
    day,
    funnel,
    errors: errorCounts,
    summary: {
      total_landings: totalLandings,
      total_completions: totalCompletions,
      total_errors: totalErrors,
      end_to_end_conversion: Number(e2eConversion.toFixed(3)),
    },
  });
}

export default withRequestId(requireAdmin(handlerImpl));
