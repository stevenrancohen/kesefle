// api/log/missed-inapp.js
//
// Telemetry beacon for in-app-browser detection misses. When account.html's
// kesefleHandleOAuthReturn detects it's running inside an in-app browser
// AFTER an OAuth attempt (meaning the regex missed the browser at signin
// time and the user got a blank Google page), we POST the UA here so we
// can extend the detection regex.
//
// Stores last 200 misses in Upstash list `inapp_misses` with 30-day TTL.
// Reviewed via /admin or `kvLRange inapp_misses`.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const ua = String(body?.ua || '').slice(0, 500);
  const reason = String(body?.reason || 'unknown').slice(0, 50);
  if (!ua) return res.status(204).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    // Best-effort logging only; never break the user flow on a missed log.
    log.warn('missed_inapp.kv_unavailable', { reqId: req.reqId, ua: ua.slice(0, 100), reason });
    return res.status(204).end();
  }

  const entry = JSON.stringify({ ua, reason, at: Date.now() });
  try {
    // LPUSH + LTRIM to keep the latest 200 entries only (bounded memory).
    await fetch(`${kvUrl}/lpush/inapp_misses/${encodeURIComponent(entry)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    await fetch(`${kvUrl}/ltrim/inapp_misses/0/199`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    // 30-day TTL so old data doesn't pile up forever.
    await fetch(`${kvUrl}/expire/inapp_misses/2592000`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${kvToken}` },
    });
  } catch (e) {
    log.warn('missed_inapp.kv_write_failed', { reqId: req.reqId, error: e.message });
  }

  log.info('missed_inapp.recorded', { reqId: req.reqId, ua: ua.slice(0, 100), reason });
  return res.status(204).end();
}

export default withRequestId(
  withRateLimit({ key: 'log_missed_inapp', limit: 60, windowSec: 60 })(handlerImpl)
);
