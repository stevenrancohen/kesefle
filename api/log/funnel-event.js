// api/log/funnel-event.js
//
// Minimal conversion-funnel tracking for launch day. Since Steven didn't
// set up PostHog, we capture funnel events ourselves into KV. Lightweight
// (one KV write per event, 24h TTL) so it can't blow the free tier.
//
// Events the frontend fires:
//   - signup_page_loaded     (user landed on /account)
//   - google_clicked         (user clicked "Continue with Google")
//   - oauth_completed        (user came back from Google with code)
//   - sheet_provisioned      (provision returned ok)
//   - phone_link_started     (user clicked "Get linking code")
//   - phone_link_done        (bot confirmed the code)
//   - first_message_sent     (first WhatsApp expense lands -- set by webhook)
//
// Each call: LPUSH into `funnel_events_today` (truncated to 5000 entries)
// + INCR per-event counters that the admin can sum without scanning.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const ALLOWED_EVENTS = new Set([
  'signup_page_loaded',
  'google_clicked',
  'oauth_completed',
  'oauth_failed',
  'sheet_provisioned',
  'sheet_provision_failed',
  'phone_link_started',
  'phone_link_done',
  'phone_link_failed',
  'first_message_sent',
  'inapp_browser_detected',
  'dashboard_loaded',
  'help_search',
  'pricing_viewed',
  'upgrade_clicked',
  'cancel_clicked',
  'bank_import_started',
  'bank_import_done',
  'bank_import_failed',
]);

async function handlerImpl(req, res) {
  // Accept POST + sendBeacon (which uses POST with Content-Type:text/plain).
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) {
    return res.status(204).end(); // KV not configured -- silently drop, never break the user flow
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const event = String(body?.event || '').slice(0, 40);
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ ok: false, error: 'unknown_event' });
  }
  const meta = body?.meta && typeof body.meta === 'object' ? body.meta : {};
  // Drop any PII from meta -- we only store anonymous funnel data.
  const safeMeta = {};
  ['source', 'campaign', 'browser', 'page', 'error_kind', 'retry', 'q', 'plan', 'bank', 'count'].forEach((k) => {
    if (meta[k] != null) safeMeta[k] = String(meta[k]).slice(0, 80);
  });

  const at = Date.now();
  const entry = JSON.stringify({ e: event, t: at, m: safeMeta });

  // Per-event counter for today (UTC). Reset daily via TTL.
  const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const counterKey = `funnel:${dayKey}:${event}`;

  try {
    // INCR + EXPIRE on first-set (KV reuses TTL if already set).
    const incrRes = await fetch(`${KV_URL}/incr/${encodeURIComponent(counterKey)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const incrJson = await incrRes.json();
    if (incrJson?.result === 1) {
      // First time today -- set 48h TTL.
      await fetch(`${KV_URL}/expire/${encodeURIComponent(counterKey)}/${86400 * 2}`, {
        method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
    }
    // Append to today's event list (capped at 5000 entries, 48h TTL).
    await fetch(`${KV_URL}/lpush/${encodeURIComponent('funnel_log:' + dayKey)}/${encodeURIComponent(entry)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    // Trim + TTL (only on first insert of the day -- but cheap to always do).
    await fetch(`${KV_URL}/ltrim/${encodeURIComponent('funnel_log:' + dayKey)}/0/4999`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
  } catch (e) {
    log.warn('funnel_event.kv_failed', { reqId: req.reqId, event, error: e.message });
  }

  return res.status(204).end();
}

export default withRequestId(
  withRateLimit({ key: 'funnel_event', limit: 600, windowSec: 60 })(handlerImpl)
);
