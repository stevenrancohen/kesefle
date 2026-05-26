// api/admin/reprovision-user-sheet.js
//
// Admin-only: re-create a Google Sheet for a SPECIFIC user (not the admin),
// using THAT user's stored refresh token. The sheet is owned by them, lives
// in their Drive, and uses the standard Kesefle template.
//
// Use case: user signed up + OAuth succeeded (refresh token in KV) but the
// initial sheet provision failed (KV write race, Google API hiccup, etc.).
// Admin doesn't need to ask them to sign in again — we have their token,
// we just need to retry the Sheets create call.
//
// POST /api/admin/reprovision-user-sheet
//   { sub: "<userSub>" }       — preferred, direct
//   { phone: "<E.164>" }       — resolves via phone:{phone} → userSub
//   { email: "<email>" }       — slowest, full scan of user:* keys
//   { force?: true }           — overwrite existing sheet:{sub} record
//                                (default: refuse if user already has one)
//   { name?: "..." }           — custom sheet name (default: "כספ'לה - {firstName}")
//   { skipWelcome?: true }     — don't send WhatsApp welcome after creating
//                                (default: send if phone is linked)
//
// Returns { ok, userSub, spreadsheetId, spreadsheetUrl, welcomeSent, note }.
//
// Auth: requireAdmin (Google session cookie, ADMIN_EMAILS allowlist).
// Rate limit: 10/min per admin (typical use is one-at-a-time support).
// Audit: log.info('admin.reprovision_user_sheet.ok') with adminEmail + userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';
import { createUserSheetWithRefresh } from '../../lib/sheet-writer.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ── KV helpers (read + write + scan) ──────────────────────────────────────
async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${KV_TOKEN}`, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}
async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  return kvFetch(`/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify(value),
    headers: { 'Content-Type': 'application/json' },
  });
}
async function kvScan(pattern, maxIter = 30) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < maxIter; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

// ── identity resolution ──────────────────────────────────────────────────
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0') && s.length === 10) s = '972' + s.slice(1);
  if (s.length < 10 || s.length > 15) return null;
  return s;
}

async function resolveSubFromBody(body) {
  if (body.sub && /^[A-Za-z0-9_-]{4,100}$/.test(String(body.sub))) {
    return { userSub: String(body.sub), via: 'sub' };
  }
  if (body.phone) {
    const phone = normalizeE164(body.phone);
    if (phone) {
      const phoneRec = await kvGet(`phone:${phone}`);
      if (phoneRec?.userSub) return { userSub: phoneRec.userSub, via: 'phone' };
    }
  }
  if (body.email) {
    const email = String(body.email).toLowerCase().trim();
    if (!email.includes('@')) return null;
    const keys = await kvScan('user:*');
    for (const k of keys) {
      const u = await kvGet(k);
      if (u?.email && String(u.email).toLowerCase() === email) {
        return { userSub: u.userSub || k.replace('user:', ''), via: 'email' };
      }
    }
  }
  return null;
}

// ── WhatsApp welcome send (best-effort, doesn't fail the request) ─────────
async function sendWhatsAppWelcome(phone, sheetUrl, firstName) {
  const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { sent: false, reason: 'whatsapp_env_not_configured' };
  const greeting = firstName ? `שלום ${firstName}!` : 'שלום!';
  const body =
    greeting + '\n\n' +
    'הגיליון שלך מוכן ופועל:\n' + sheetUrl + '\n\n' +
    'שלח/י עכשיו את ההוצאה הראשונה — לדוגמה "45 קפה" — והיא תיכנס לגיליון אוטומטית.\n\n' +
    'צריך עזרה? כתוב/י "עזרה".';
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body },
      }),
    });
    if (r.ok) return { sent: true };
    const detail = await r.text().catch(() => '');
    return { sent: false, reason: `meta_${r.status}`, detail: detail.slice(0, 120) };
  } catch (e) {
    return { sent: false, reason: 'whatsapp_threw', detail: (e && e.message) || '' };
  }
}

// ── main handler ─────────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const adminEmail = req.user?.email || 'admin';

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const resolved = await resolveSubFromBody(body);
  if (!resolved) {
    return res.status(404).json({
      ok: false,
      error: 'user_not_found',
      detail: 'Provide one of { sub, phone, email } that resolves to an existing user.',
    });
  }
  const { userSub, via } = resolved;

  // Pull the user record. We need their refresh token.
  const userRec = await kvGet(`user:${userSub}`);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'user_record_missing', userSub });
  }
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({
      ok: false,
      error: 'no_refresh_token',
      userSub,
      detail: 'User has no stored OAuth refresh token. They need to sign in at /account again.',
    });
  }

  // Refuse to overwrite an existing sheet unless force=true.
  const existingSheet = await kvGet(`sheet:${userSub}`);
  if (existingSheet?.spreadsheetId && !body.force) {
    return res.status(409).json({
      ok: false,
      error: 'sheet_already_exists',
      userSub,
      spreadsheetId: existingSheet.spreadsheetId,
      spreadsheetUrl: existingSheet.spreadsheetUrl,
      detail: 'User already has a sheet. Pass { force: true } to create a new one (the old one will be orphaned in their Drive but not deleted).',
    });
  }

  // Decide the sheet name. If user record has a name, use first token.
  let sheetName = body.name && typeof body.name === 'string'
    ? body.name.slice(0, 200)
    : null;
  if (!sheetName) {
    const fullName = (userRec.name || userRec.given_name || '').trim();
    const firstName = fullName.split(/\s+/)[0] || '';
    sheetName = firstName ? `כספ'לה - ${firstName}` : `כספ'לה - הגיליון שלי`;
  }

  // Create the sheet using THE USER's refresh token (owned by them).
  let created;
  try {
    created = await createUserSheetWithRefresh({
      refreshTokenEnvelope: userRec.refreshTokenEnvelope,
      refreshToken: userRec.refreshToken,
      userSub,
      name: sheetName,
    });
  } catch (e) {
    log.error('admin.reprovision_user_sheet.create_failed', {
      reqId: req.reqId, adminEmail, userSub, via, err: String((e && e.message) || e),
    });
    return res.status(502).json({
      ok: false,
      error: 'sheet_create_failed',
      userSub,
      detail: String((e && e.message) || e).slice(0, 200),
    });
  }

  // Persist the new sheet record.
  const now = new Date().toISOString();
  const sheetRec = {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
    provisioned: now,
    provisionedBy: 'admin_reprovision',
    provisionedByAdmin: adminEmail,
    name: sheetName,
  };
  await kvSet(`sheet:${userSub}`, sheetRec);

  // Update the user record's spreadsheet pointer so existing code (web
  // dashboard, "פתח גיליון" command) finds it without a separate KV read.
  const updatedUserRec = {
    ...userRec,
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
    lastUpdated: now,
  };
  await kvSet(`user:${userSub}`, updatedUserRec);

  // Best-effort welcome via WhatsApp, only if user has a linked phone.
  let welcome = { sent: false, reason: 'no_linked_phone' };
  if (!body.skipWelcome) {
    const linkedPhone = userRec.linkedPhone || userRec.phone;
    if (linkedPhone) {
      welcome = await sendWhatsAppWelcome(linkedPhone, created.spreadsheetUrl, (userRec.name || '').split(/\s+/)[0]);
    }
  }

  log.info('admin.reprovision_user_sheet.ok', {
    reqId: req.reqId,
    adminEmail,
    userSub,
    via,
    spreadsheetId: created.spreadsheetId,
    welcomeSent: welcome.sent,
    forced: !!body.force,
  });

  return res.status(200).json({
    ok: true,
    userSub,
    via,
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: created.spreadsheetUrl,
    name: sheetName,
    welcome,
    note: existingSheet ? 'Replaced existing sheet record. Old sheet still exists in user Drive but is orphaned.' : 'New sheet created for user.',
  });
}

export default withRequestId(withRateLimit(requireAdmin(handlerImpl), { route: 'admin.reprovision-user-sheet', windowMs: 60_000, max: 10 }));
