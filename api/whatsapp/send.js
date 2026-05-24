// /api/whatsapp/send
//
// Server-to-server wrapper around the Meta WhatsApp Cloud send-message endpoint.
// Used by cron jobs (budget alerts, recurring reminders) and other internal
// callers that need to deliver a free-form text message to a linked user.
//
// Gating:
//   - POST only
//   - x-kesefle-bot-secret header (or { botSecret } in body) MUST match
//     process.env.KESEFLE_BOT_SECRET — same posture as other bot/server-to-
//     server endpoints (recurring, learn, stats). Without this we'd give any
//     unauthenticated caller a free WA send through our number.
//   - Per-recipient rate limit (rateLimitId on the E.164 phone): 100/hour.
//     Stops an out-of-control cron or buggy caller from spamming any single
//     user — Meta will throttle us aggressively if we do that anyway.
//
// Body: { phone: 'E164', text: 'string', botSecret?: 'string' }
// Returns: { ok, status, id?, error? }
//
// Env:
//   KESEFLE_BOT_SECRET            — shared secret with the bot
//   META_ACCESS_TOKEN             — Meta system-user access token (or WHATSAPP_TOKEN legacy)
//   META_PHONE_NUMBER_ID          — sending phone-number-id (or WHATSAPP_PHONE_NUMBER_ID legacy)

import { withRequestId, log } from '../../lib/log.js';
import { rateLimitId } from '../../lib/ratelimit.js';

const MAX_TEXT_LEN = 4096; // Meta hard limit on text body.

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('wa.send.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const presented = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  if (presented !== expected) {
    log.warn('wa.send.unauthorized', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  let text = String(body.text == null ? '' : body.text);
  text = text.trim();
  if (!text) return res.status(400).json({ ok: false, error: 'missing_text' });
  if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN);

  // Per-recipient rate limit (defense-in-depth). 100/hour is well above any
  // legitimate sequence (cron sends one daily alert per category, max ~16
  // categories) and below the threshold where a bug would page the user
  // hundreds of times before we notice.
  const rl = await rateLimitId(phone, { key: 'wa_send', limit: 100, windowSec: 3600 });
  res.setHeader('X-RateLimit-Limit', '100');
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 3600));
    log.warn('wa.send.rate_limited', { reqId: req.reqId, phone });
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || 3600 });
  }

  // Meta env vars — accept both the modern META_* and legacy WHATSAPP_*
  // names so an env-var rename doesn't break the cron. Fail closed so we
  // never quietly drop sends when the env is misconfigured.
  const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    log.error('wa.send.meta_env_missing', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'whatsapp_not_configured' });
  }

  // Pinned to v21.0 (same as link.js's welcome path) so a Meta API bump
  // doesn't change behaviour out from under us.
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text },
      }),
    });
  } catch (e) {
    log.error('wa.send.fetch_failed', { reqId: req.reqId, phone, error: e.message });
    return res.status(502).json({ ok: false, error: 'meta_unreachable', detail: e.message });
  }

  const respText = await resp.text().catch(() => '');
  let parsed = null;
  try { parsed = respText ? JSON.parse(respText) : null; } catch { /* non-JSON */ }
  const msgId = parsed?.messages?.[0]?.id || null;

  if (!resp.ok) {
    log.warn('wa.send.meta_error', { reqId: req.reqId, phone, status: resp.status, detail: respText.slice(0, 200) });
    return res.status(502).json({ ok: false, status: resp.status, error: 'meta_send_failed', detail: respText.slice(0, 200) });
  }

  log.info('wa.send.ok', { reqId: req.reqId, phone, msgId });
  return res.status(200).json({ ok: true, status: resp.status, id: msgId });
}

export default withRequestId(handlerImpl);
