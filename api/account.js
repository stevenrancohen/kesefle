// /api/account
// Consolidated account router — handles self-serve account operations via ?action= query param.
// This pattern keeps the project under Vercel Hobby's 12-function limit.
//
// Replaces:
//   /api/account/delete  (POST ?action=delete)
//   /api/account/export  (GET  ?action=export)
//
// Actions:
//   POST ?action=delete  body: { confirmation: 'DELETE-MY-ACCOUNT' }
//   GET  ?action=export  (returns a JSON download with all account data)
//
// All require authenticated user (requireAuth — verified Google ID token).
// Per Israeli Privacy Protection Law Amendment 13 + GDPR Articles 17 & 20.

import { requireAuth } from '../lib/auth.js';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { decryptRefreshToken, constantTimeEqual } from '../lib/crypto.js';
import { getGoogleClientId } from '../lib/auth.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

async function revokeGoogleToken(refreshToken) {
  if (!refreshToken) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (e) { console.warn('google_revoke_failed', e.message); }
}

async function exchangeRefreshForAccess(refreshToken) {
  const clientId = getGoogleClientId();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var missing');
  const params = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('refresh_failed');
  return j.access_token;
}

// =============================================================
// Action: delete (GDPR Art.17 + Israeli Privacy Law Sec.14)
// =============================================================
async function deleteAccount(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const userSub = req.user.sub;

  if (body?.confirmation !== 'DELETE-MY-ACCOUNT') {
    return res.status(400).json({ ok: false, error: 'missing or invalid confirmation' });
  }

  const userRec = await kvGet('user:' + userSub);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }

  // Revoke the Google grant on delete. Handle BOTH the encrypted envelope
  // (current users) AND the legacy plaintext token — otherwise envelope users'
  // Google access survives account deletion (GDPR). Mirrors deleteByPhone.
  {
    let _refresh = null;
    try {
      _refresh = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
    } catch (_e) { _refresh = userRec.refreshToken || null; }
    if (_refresh) await revokeGoogleToken(_refresh);
  }

  const deleted = [];
  const keysToDelete = [
    'user:' + userSub,
    'sheet:' + userSub,
    'token:' + userSub, // legacy PLAINTEXT token store — must be purged too (GDPR)
    // Referral keys (clean these up too)
    'referral:code:' + userSub,
  ];

  // If user has a referral code, also delete the reverse lookup.
  const code = await kvGet('referral:code:' + userSub);
  if (code) keysToDelete.push('referral:reverse:' + code);

  // Phone-mapping cleanup. Without this, the deleted user's phone stays
  // mapped in KV pointing at a now-missing user record, so the bot would
  // open a stale-state conversation ("✅ נרשם" reply with no sheet to
  // write to) the next time they message in. We look up the reverse
  // mapping `userPhone:<sub>` to find the E164 phone, then drop both
  // directions.
  const userPhoneRec = await kvGet('userPhone:' + userSub);
  if (userPhoneRec && userPhoneRec.phone) {
    keysToDelete.push('phone:' + userPhoneRec.phone);
    keysToDelete.push('userPhone:' + userSub);
  }

  for (const k of keysToDelete) {
    if (await kvDel(k)) deleted.push(k);
  }

  // Audit log (non-fatal)
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const auditEntry = {
        ts: new Date().toISOString(),
        action: 'account_deleted',
        userSub,
        email: userRec.email,
        deletedKeys: deleted,
        ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64),
      };
      const auditKey = `audit:delete:${Date.now()}:${userSub.slice(0, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(auditKey)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(auditEntry),
      });
    } catch (e) { /* non-fatal */ }
  }

  return res.status(200).json({
    ok: true,
    deleted,
    note: 'Your account, OAuth tokens, and our connection to your sheet have been removed. The Google Sheet itself remains in your Drive under your control — delete it manually if you wish.',
    note_he: 'החשבון שלך, אסימוני ההזדהות והקישור שלנו לגיליון הוסרו. הגיליון עצמו נשאר ב-Drive שלך בשליטתך — מחק אותו ידנית אם תרצה.',
  });
}

// =============================================================
// Action: export (GDPR Art.20 right to data portability)
// =============================================================
async function exportAccount(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const userSub = req.user.sub;
  const userRec = (await kvGet('user:' + userSub)) || {};

  // Strip sensitive crypto material — user shouldn't see their own refresh token envelope
  const userProfile = {
    sub: userSub,
    email: userRec.email,
    name: userRec.name,
    picture: userRec.picture,
    plan: userRec.plan || 'free',
    subscription_status: userRec.subscriptionStatus,
    subscribed_at: userRec.subscribedAt,
    connected_at: userRec.connectedAt,
    spreadsheet_id: userRec.spreadsheetId,
    spreadsheet_url: userRec.spreadsheetUrl,
    has_refresh_token: !!(userRec.refreshTokenEnvelope || userRec.refreshToken),
  };

  // Sheet data (transactions) — fetch via stored refresh token
  let transactions = [];
  let sheetReadError = null;
  if (userRec.spreadsheetId) {
    try {
      const refreshToken = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
      if (refreshToken) {
        const accessToken = await exchangeRefreshForAccess(refreshToken);
        const range = encodeURIComponent("'תנועות'!A2:I10001");
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (r.ok) {
          const j = await r.json();
          transactions = (j.values || [])
            .filter(row => row[0])
            .map(row => ({
              date: row[0],
              amount: parseFloat(row[1] || '0') || 0,
              currency: row[2] || 'ILS',
              type: row[3] || '',
              category: row[4] || '',
              subcategory: row[5] || '',
              description: row[6] || '',
              source: row[7] || '',
              message_id: row[8] || '',
            }));
        } else {
          sheetReadError = 'sheets_status_' + r.status;
        }
      }
    } catch (e) {
      sheetReadError = e.message;
    }
  }

  // Referral data
  const referralCode = await kvGet('referral:code:' + userSub);

  const exportDoc = {
    export_meta: {
      exported_at: new Date().toISOString(),
      user_sub: userSub,
      format_version: '1.1',
      note: 'This is the complete export of all data Kesefle holds about your account. Per GDPR Article 20 and Israeli Privacy Law Section 13. To delete this data, use POST /api/account?action=delete.',
      note_he: 'זהו ייצוא מלא של כל הנתונים ש"כסף\'לה" שומר על חשבונך. לפי GDPR סעיף 20 וחוק הגנת הפרטיות סעיף 13. למחיקה: POST /api/account?action=delete.',
    },
    profile: userProfile,
    transactions: {
      count: transactions.length,
      data: transactions,
      read_error: sheetReadError,
      note: 'Transactions live in your own Google Sheet at spreadsheet_url. This export is a snapshot.',
    },
    referral: {
      code: referralCode || null,
      note: 'Your personal referral code, if generated.',
    },
    not_stored_by_kesefle: [
      'Original raw WhatsApp message bodies (only the parsed amount + category are persisted)',
      'Your bank/credit card data (we never receive it)',
      'Your phone number content beyond the sender field on incoming messages',
      'Your Google contacts, calendar, drive files outside the kesefle-provisioned sheet',
      'Your IP address beyond the last request (rate-limit ephemeral)',
    ],
    your_rights: {
      delete: 'POST /api/account?action=delete with confirmation:"DELETE-MY-ACCOUNT"',
      export: 'GET /api/account?action=export (this endpoint)',
      sheet_ownership: 'The Google Sheet at spreadsheet_url is YOURS. Kesefle has access only to files we created (drive.file scope). You can revoke our access at myaccount.google.com/permissions',
      complaint: 'https://www.gov.il/he/departments/the_privacy_protection_authority',
    },
  };

  log.info('account.export_ok', { reqId: req.reqId, userSub, txnCount: transactions.length });

  const filename = `kesefle-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify(exportDoc, null, 2));
}

// =============================================================
// Main dispatcher with per-action rate limits
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'missing_action_param',
      hint: 'use ?action=delete (POST) or ?action=export (GET)',
    });
  }

  switch (action) {
    case 'delete': return deleteAccount(req, res);
    case 'export': return exportAccount(req, res);
    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', action, allowed: ['delete', 'export'] });
  }
}

// Bot-callable deletion by phone (no Google token — the bot only knows
// the phone). Gated by the bot secret. Resolves phone → userSub via KV,
// then runs the same revoke + purge as the authed delete. This is how
// the WhatsApp "מחק חשבון כן" flow deletes an account without the user
// being in a browser session.
async function deleteByPhone(req, res) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = String(body?.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const phoneRec = await kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    // Nothing linked — still drop any phone-keyed state and report ok.
    await kvDel('phone:' + phone);
    return res.status(200).json({ ok: true, deleted: ['phone:' + phone], note: 'no_linked_user' });
  }
  const userSub = phoneRec.userSub;
  const userRec = await kvGet('user:' + userSub);
  if (userRec) {
    const refresh = userRec.refreshTokenEnvelope
      ? (() => { try { return decryptRefreshToken(userRec.refreshTokenEnvelope, userSub); } catch { return null; } })()
      : userRec.refreshToken;
    if (refresh) await revokeGoogleToken(refresh);
  }
  const deleted = [];
  for (const k of ['user:' + userSub, 'sheet:' + userSub, 'token:' + userSub, 'phone:' + phone, 'userPhone:' + userSub, 'profile:' + phone, 'recurring:' + phone, 'memberGroup:' + phone, 'reminders:' + phone]) {
    if (await kvDel(k)) deleted.push(k);
  }
  log.info('account.delete_by_phone', { reqId: req.reqId, phone: phone.replace(/\d(?=\d{4})/g, '*') });
  return res.status(200).json({ ok: true, deleted });
}

// Both delete (3/hr) and export (2/hr) are sensitive but distinct.
// We use a single bucket here keyed by `account_op` with the conservative cap of 5/hour
// — covers both flows together since real users do these very rarely.
//
// The bot-secret delete-by-phone path is checked FIRST, bypassing
// requireAuth (the bot has no Google token), then the authed browser
// flows run as before.
export default withRequestId(
  withRateLimit({ key: 'account_op', limit: 5, windowSec: 3600 })(
    async function accountRouter(req, res) {
      const action = String(req.query?.action || '').toLowerCase();
      if (action === 'delete-by-phone') {
        if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return deleteByPhone(req, res);
      }
      return requireAuth(handlerImpl)(req, res);
    }
  )
);
