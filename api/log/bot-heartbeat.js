// api/log/bot-heartbeat.js
//
// Receives hourly heartbeat from the Apps Script bot's cronBotHeartbeat
// trigger. Writes { version, at, source } to KV `bot_version_latest` so
// the admin /api/admin/bot-version endpoint reports a fresh value even
// when no WhatsApp messages have arrived.
//
// Without this, the bot only reports its version when receiving a message
// (via /api/whatsapp/link?phone= header). On a launch day with low message
// volume early on, the admin would see "Bot has not reported its version
// yet" for hours despite the bot being up.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

// Constant-time string comparison for the bot secret. Same implementation
// as api/whatsapp/link.js -- duplicated to avoid cross-file imports here.
function constantTimeEqual(a, b) {
  const la = a.length, lb = b.length;
  let diff = la ^ lb;
  const max = Math.max(la, lb);
  for (let i = 0; i < max; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Bot-secret gated. Anonymous heartbeats are useless (we'd accept spoofed
  // versions) and a small abuse risk.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.warn('bot_heartbeat.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }
  const presented = String(req.headers['x-kesefle-bot-secret'] || '');
  if (!constantTimeEqual(presented, String(expected))) {
    return res.status(401).json({ ok: false, error: 'invalid_bot_secret' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const version = String(body?.version || '').slice(0, 80);
  const source = String(body?.source || 'cron').slice(0, 20);
  if (!version) return res.status(400).json({ ok: false, error: 'missing_version' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    log.info('bot_heartbeat.received_no_kv', { reqId: req.reqId, version, source });
    return res.status(200).json({ ok: true, stored: false });
  }

  try {
    const record = { version, source, at: Date.now() };
    // 7-day TTL -- if the bot hasn't heartbeat in a week, the admin should
    // notice the record disappearing.
    await fetch(`${kvUrl}/set/${encodeURIComponent('bot_version_latest')}?EX=${86400 * 7}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    log.info('bot_heartbeat.recorded', { reqId: req.reqId, version, source });
    return res.status(200).json({ ok: true, stored: true, version, at: record.at });
  } catch (e) {
    log.warn('bot_heartbeat.kv_write_failed', { reqId: req.reqId, error: e.message });
    return res.status(200).json({ ok: true, stored: false, warn: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'bot_heartbeat', limit: 60, windowSec: 3600 })(handlerImpl)
);
