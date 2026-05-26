// /api/abuse-log
//
// Append-only abuse/suspicious-activity log. The bot POSTs here when it
// detects spam patterns, blacklist hits, or other suspicious behaviour,
// so they're reviewable centrally instead of buried in Apps Script's
// Logger. Bot-secret gated. Entries auto-expire after 30 days.
//
// KV schema:
//   abuse_log:<ts>:<rand>  → { phone, reason, sample, at }  (30-day TTL)

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { constantTimeEqual } from '../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  if (!KV_URL || !KV_TOKEN) return res.status(200).json({ ok: true, stored: false });

  // Reject oversized payloads — sample is capped, reason is an enum-ish
  // short string. Don't store arbitrary blobs.
  const reason = String(body?.reason || 'unknown').slice(0, 40);
  const phone = String(body?.phone || '').replace(/[^0-9]/g, '').slice(0, 15);
  const sample = String(body?.sample || '').slice(0, 200);

  const key = `abuse_log:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}?EX=2592000`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, reason, sample, at: new Date().toISOString() }),
    });
    log.warn('abuse.logged', { reqId: req.reqId, reason });
    return res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    return res.status(200).json({ ok: true, stored: false, error: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'abuse_log', limit: 60, windowSec: 60 })(handlerImpl)
);
