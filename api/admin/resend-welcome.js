// api/admin/resend-welcome.js
//
// Admin-only: re-send the WhatsApp welcome message to a specific phone.
// Use case: launch day, a user signed up but the welcome message didn't
// arrive (Meta delivery flake, or they cleared the conversation). Steven
// hits this endpoint from the admin UI and the user gets a fresh welcome.
//
// POST /api/admin/resend-welcome { phone: "<E.164>" }
// Returns { ok, sentTo, sheetUrl } on success.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '972' + s.slice(1);
  if (s.length < 10 || s.length > 15) return null;
  return s;
}

async function sendWhatsAppText(phone, body) {
  const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('whatsapp_env_not_configured');
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`meta_${resp.status}_${detail.slice(0, 120)}`);
  }
  return true;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const phoneRec = await kvGet(`phone:${phone}`);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'phone_not_linked' });
  }
  const sheetRec = await kvGet(`sheet:${phoneRec.userSub}`);
  const sheetUrl = sheetRec?.spreadsheetUrl
    || (sheetRec?.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${sheetRec.spreadsheetId}/edit` : '');

  const message =
    'מצוין! 🎉 המספר הזה מחובר עכשיו לחשבון שלך.\n\n' +
    'נסה לשלוח לי הוצאה — לדוגמה:\n' +
    '• 45 קפה\n' +
    '• 230 סופר רמי לוי\n' +
    '• 1200 שכר דירה\n\n' +
    'אני אכניס הכל לגיליון שלך אוטומטית. 📊' +
    (sheetUrl ? `\n\n📄 הגיליון שלך:\n${sheetUrl}` : '');

  try {
    await sendWhatsAppText(phone, message);
    log.info('admin.resend_welcome.ok', { reqId: req.reqId, adminEmail: req.user.email, phone, userSub: phoneRec.userSub });
    return res.status(200).json({
      ok: true,
      sentTo: phone,
      sheetUrl: sheetUrl || null,
      userEmail: phoneRec.email || null,
    });
  } catch (e) {
    log.error('admin.resend_welcome.failed', { reqId: req.reqId, phone, error: e.message });
    return res.status(502).json({ ok: false, error: 'send_failed', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'admin_resend_welcome', limit: 30, windowSec: 60 })(requireAdmin(handlerImpl))
);
