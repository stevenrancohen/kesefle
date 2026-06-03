// /api/admin/customer-digest-set
//
// Steven sets / gets the "מה חדש השבוע" message that the customer-weekly-digest
// cron sends out on Sundays at 10:00 IL.
//
// Auth: requireAdmin (Google ID-token or cookie session + email allow-list).
// Steven 2026-05-30 (deep-review PR #152 WS4): switched from KESEFLE_BOT_SECRET
// to requireAdmin since this is a human-admin action, not a bot-callable.
// The cron (/api/cron/customer-weekly-digest) reads the message DIRECTLY from
// KV under `customer_digest:current`, so it does not need to call this
// endpoint — meaning the only legitimate callers are admins via the admin UI.
//
// POST:
//   { action:"set", body:"<Hebrew message>" }
//     → { ok:true, length, preview }
//   { action:"get" }
//     → { ok:true, current:{ body, updatedAt, updatedBy } | null }
//   { action:"clear" }
//     → { ok:true, cleared:true }
//
// המסר עצמו אינו עובר עיבוד נוסף — מה שכותבים פה זה מה שמגיע לוואטסאפ.
// מקסימום 3900 תווים (גבול WhatsApp פחות שוליים).

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';

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

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
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
    // updatedBy: use the verified admin email when available so the audit
    // trail attributes the change to the real human, not a freeform body
    // field that could be spoofed. Fall back to body.updatedBy for
    // backward compatibility.
    const updatedBy = (req.user?.email || body?.updatedBy || 'admin').slice(0, 40);
    const record = {
      body: msg,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await kvSet(KV_KEY, record);
    log.info('customer_digest.message_set', { reqId: req.reqId, length: msg.length, updatedBy });
    return res.status(200).json({ ok: true, length: msg.length, preview: msg.slice(0, 80) });
  }

  if (action === 'clear') {
    await kvDel(KV_KEY);
    log.info('customer_digest.message_cleared', { reqId: req.reqId, updatedBy: req.user?.email || null });
    return res.status(200).json({ ok: true, cleared: true });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['get', 'set', 'clear'] });
}

export default withRequestId(
  withRateLimit({ key: 'admin-customer-digest', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
