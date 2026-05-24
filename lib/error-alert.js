// lib/error-alert.js
//
// Steven's request 2026-05-24: "כל שגיאה שיש ללקוח תשלח לי הודעה לבוט עם
// הסיבה של השגיאה ואיזה מס טלפון זה קרה על מנת שאוכל לטפל בזה" — every
// client-facing error should ping the owner's WhatsApp with the phone +
// reason so he can intervene.
//
// Design constraints:
//   - Fire-and-forget. We never block the user response on the alert.
//   - Deduped per (phone × error_code) for 30 min so a single bug doesn't
//     spam Steven 200 messages in a row.
//   - Owner is configurable via KESEFLE_OWNER_PHONE (defaults to Steven's
//     number on file).
//   - Soft-fail: if the WhatsApp send breaks, just log — never throw.
//
// Use:
//   import { alertOwnerOfClientError } from '../lib/error-alert.js';
//   await alertOwnerOfClientError({
//     reqId: req.reqId,
//     phone: maybePhone,                  // E.164, optional
//     userSub: maybeUserSub,              // optional
//     route: '/api/sheet/provision',
//     code: 'sheet_create_failed',
//     detail: err.message,                // first 200 chars
//   });

import { log } from './log.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OWNER_PHONE = String(process.env.KESEFLE_OWNER_PHONE || '972547760643').replace(/\D+/g, '');

// Optional: dedupe key TTL. 30 min is long enough to cover a burst from
// one buggy deploy but short enough to alert on the same issue tomorrow.
const DEDUPE_TTL_SEC = 1800;

async function kvSetNX(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const url = `${KV_URL}/setnx/${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: String(value),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    if (!j || j.result !== 1) return false;
    // Apply TTL with a follow-up call (Upstash setnx doesn't accept EX).
    if (ttlSec) {
      await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/${ttlSec}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      }).catch(() => {});
    }
    return true;
  } catch (_e) {
    return false;
  }
}

// Send a WhatsApp text via Meta Graph. Reuses the same envvar pattern as
// lib/billing.js. Returns true on 2xx, false otherwise. Never throws.
async function sendWhatsAppToOwner(body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: OWNER_PHONE,
        type: 'text',
        text: { body: String(body).slice(0, 1024) },
      }),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

// Public entry. Always returns quickly. Never throws.
//   { reqId, phone, userSub, route, code, detail, severity? }
export async function alertOwnerOfClientError(info) {
  try {
    const reqId = info?.reqId || '?';
    const phone = info?.phone ? String(info.phone).replace(/\D+/g, '') : '';
    const userSub = info?.userSub ? String(info.userSub).slice(0, 40) : '';
    const route = String(info?.route || '?').slice(0, 80);
    const code = String(info?.code || 'unknown_error').slice(0, 60);
    const detail = String(info?.detail || '').replace(/\s+/g, ' ').slice(0, 200);
    const severity = info?.severity || 'error';

    // Always log it so we have a record even when WhatsApp/KV fails.
    log.warn('client_error_alert', { reqId, phone, userSub, route, code, severity });

    // Dedupe per (phone × code) for 30 min. If a key with the same phone+code
    // was set recently, suppress the WhatsApp message — Steven still has the
    // log line for forensics.
    const dedupeKey = `errAlert:${code}:${phone || userSub || 'anon'}`;
    const isFresh = await kvSetNX(dedupeKey, '1', DEDUPE_TTL_SEC);
    if (!isFresh) return; // already alerted in the last 30 min

    const phoneLine = phone ? `📱 ${phone}` : '📱 (לא מזוהה)';
    const userLine = userSub ? `\n👤 ${userSub.slice(0, 12)}…` : '';
    const body =
      `🚨 שגיאה אצל לקוח\n` +
      `━━━━━━━━━━━━\n` +
      `${phoneLine}${userLine}\n` +
      `🛣️ ${route}\n` +
      `❌ ${code}\n` +
      (detail ? `📝 ${detail}\n` : '') +
      `🔖 req=${reqId}`;

    await sendWhatsAppToOwner(body);
  } catch (e) {
    // Last-ditch — never let the alerter itself break the caller.
    try { log.warn('error_alert_threw', { detail: e?.message }); } catch (_e2) {}
  }
}
