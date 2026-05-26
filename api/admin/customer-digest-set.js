// /api/admin/customer-digest-set
//
// Steven sets / gets the "מה חדש השבוע" message that the customer-weekly-digest
// cron sends out on Sundays at 10:00 IL.
//
// אימות: KESEFLE_BOT_SECRET (header `x-kesefle-bot-secret` או body.botSecret).
//
// POST:
//   { action:"set", body:"<Hebrew message>", botSecret:"..." }
//     → { ok:true, length, preview }
//   { action:"get", botSecret:"..." }
//     → { ok:true, current:{ body, updatedAt, updatedBy } | null }
//   { action:"clear", botSecret:"..." }
//     → { ok:true, cleared:true }
//
// המסר עצמו אינו עובר עיבוד נוסף — מה שכותבים פה זה מה שמגיע לוואטסאפ.
// מקסימום 3900 תווים (גבול WhatsApp פחות שוליים).

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { constantTimeEqual } from '../../lib/crypto.js';

const KV_KEY = 'customer_digest:current';
const MAX_LEN = 3900;
const MIN_LEN = 20;

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.ok;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const action = String(body?.action || 'get').toLowerCase();

  if (action === 'get') {
    const current = await kvGet(KV_KEY);
    return res.status(200).json({ ok: true, current });
  }

  if (action === 'set') {
    const msg = String(body?.body || '').trim();
    if (msg.length < MIN_LEN) {
      return res.status(400).json({ ok: false, error: 'message_too_short', minLength: MIN_LEN });
    }
    if (msg.length > MAX_LEN) {
      return res.status(400).json({ ok: false, error: 'message_too_long', maxLength: MAX_LEN });
    }
    const record = {
      body: msg,
      updatedAt: new Date().toISOString(),
      updatedBy: String(body?.updatedBy || 'admin').slice(0, 40),
    };
    await kvSet(KV_KEY, record);
    log.info('customer_digest.message_set', { reqId: req.reqId, length: msg.length });
    return res.status(200).json({ ok: true, length: msg.length, preview: msg.slice(0, 80) });
  }

  if (action === 'clear') {
    await kvDel(KV_KEY);
    log.info('customer_digest.message_cleared', { reqId: req.reqId });
    return res.status(200).json({ ok: true, cleared: true });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['get', 'set', 'clear'] });
}

export default withRequestId(
  withRateLimit({ key: 'admin-customer-digest', limit: 30, windowSec: 60 })(handlerImpl)
);
