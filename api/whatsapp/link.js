// /api/whatsapp/link
//
// Flow for linking a user's WhatsApp number to their Kesefle account:
//
// 1. User on /account submits their E.164 phone → POST { phone } here with an authed accessToken
// 2. We verify the accessToken via tokeninfo, get the userSub
// 3. Generate a 6-digit code (e.g. 482917) + store {code → userSub} in KV with 10-min TTL
// 4. Return the code to the browser
// 5. Browser shows "Open WhatsApp and send: קוד 482917"
// 6. Bot webhook receives the message, sees "קוד 482917", calls /api/whatsapp/link?action=confirm
// 7. Server resolves code → userSub, then stores phone:<E164> → userSub permanently in KV
// 8. Bot writes to the user's sheet from then on
//
// Endpoints:
//   POST /api/whatsapp/link  { accessToken, phone }       → { ok, code, expiresIn }
//   POST /api/whatsapp/link?action=confirm { code, phone } → { ok, userSub, sheetId } (called by webhook)
//   GET  /api/whatsapp/link?phone=E164                    → { ok, linked: true/false, userSub? } (status check)
//
// Env: KV_REST_API_URL, KV_REST_API_TOKEN, GOOGLE_CLIENT_ID

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

async function verifyAccessToken(accessToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!r.ok) throw new Error('tokeninfo_status_' + r.status);
  const info = await r.json();
  if (info.error) throw new Error('tokeninfo_error_' + info.error);
  if (!info.sub) throw new Error('tokeninfo_missing_sub');
  return info;
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value, ttlSec) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const path = ttlSec ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${url}/set/${encodeURIComponent(key)}`;
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

// E.164 normalization — strip everything except digits, add country code if missing.
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  // If it starts with 0 (e.g., 0541234567), assume Israel and prepend 972.
  if (s.startsWith('0')) s = '972' + s.slice(1);
  // Length sanity: 7-15 digits per E.164
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// Cryptographically-safe 6-digit code (100000-999999).
function gen6DigitCode() {
  const buf = new Uint32Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    buf[0] = Math.floor(Math.random() * 0xFFFFFFFF);
  }
  return String(100000 + (buf[0] % 900000));
}

async function handlerImpl(req, res) {
  // GET — status check: is this phone already linked?
  if (req.method === 'GET') {
    const phone = normalizeE164(req.query.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
    const rec = await kvGet(`phone:${phone}`);
    if (!rec) return res.status(200).json({ ok: true, linked: false });
    return res.status(200).json({ ok: true, linked: true, userSub: rec.userSub, sheetId: rec.spreadsheetId });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const action = (req.query.action || 'request').toLowerCase();

  // === CONFIRM action — called by the bot webhook when it sees "קוד 482917" ===
  if (action === 'confirm') {
    const code = String(body?.code || '').trim();
    const phone = normalizeE164(body?.phone);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code_format' });
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    // Only the bot should call this — protect with a shared secret.
    const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
    const expected = process.env.KESEFLE_BOT_SECRET;
    if (expected && botSecret !== expected) {
      log.warn('link.confirm.unauthorized', { reqId: req.reqId });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const pending = await kvGet(`linkCode:${code}`);
    if (!pending) return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });

    const userSub = pending.userSub;
    // Look up the user's sheet to attach to the phone mapping.
    const sheetRec = await kvGet(`sheet:${userSub}`);
    const userRec = await kvGet(`user:${userSub}`) || {};

    // Permanent mapping: phone → user record (with sheet info for fast bot lookup)
    const permRec = {
      userSub,
      email: userRec.email || '',
      plan: userRec.plan || 'free',
      spreadsheetId: sheetRec?.spreadsheetId || userRec.spreadsheetId || null,
      spreadsheetUrl: sheetRec?.spreadsheetUrl || userRec.spreadsheetUrl || null,
      linkedAt: new Date().toISOString(),
    };
    await kvSet(`phone:${phone}`, permRec);

    // Reverse mapping: user → phone (so /account can detect "linked" state)
    await kvSet(`userPhone:${userSub}`, { phone, linkedAt: permRec.linkedAt });

    // Cleanup the pending code
    await kvDel(`linkCode:${code}`);

    return res.status(200).json({
      ok: true,
      userSub,
      email: permRec.email,
      sheetId: permRec.spreadsheetId,
      sheetUrl: permRec.spreadsheetUrl,
    });
  }

  // === REQUEST action (default) — user requests a linking code ===
  const accessToken = String(body?.accessToken || '').trim();
  const phone = normalizeE164(body?.phone);

  if (!accessToken || accessToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing_access_token' });
  }
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'invalid_phone' });
  }

  let tokenInfo;
  try { tokenInfo = await verifyAccessToken(accessToken); }
  catch (e) {
    log.warn('link.request.token_invalid', { reqId: req.reqId, error: e.message });
    return res.status(401).json({ ok: false, error: 'invalid_access_token' });
  }
  const userSub = tokenInfo.sub;

  // Already linked? Tell the user so they don't generate a new code unnecessarily.
  const existing = await kvGet(`userPhone:${userSub}`);
  if (existing && existing.phone === phone) {
    return res.status(200).json({ ok: true, alreadyLinked: true, phone });
  }

  // Generate a new code + store with 10-min TTL.
  const code = gen6DigitCode();
  const codeRec = {
    userSub,
    phone, // suggested phone — bot doesn't strictly need this since it sees the sender's phone
    createdAt: new Date().toISOString(),
  };
  const ok = await kvSet(`linkCode:${code}`, codeRec, 600); // 10 min TTL
  if (!ok) return res.status(500).json({ ok: false, error: 'kv_unavailable' });

  log.info('link.code_issued', { reqId: req.reqId, userSub, code });
  return res.status(200).json({
    ok: true,
    code,
    expiresIn: 600, // seconds
    instructions: `שלח לבוט הודעה: "קוד ${code}"`,
  });
}

export default withRequestId(
  withRateLimit({ key: 'wa_link', limit: 10, windowSec: 600 })(handlerImpl)
);
