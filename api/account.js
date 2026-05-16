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
import { decryptRefreshToken } from '../lib/crypto.js';

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
  const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
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

  if (userRec.refreshToken) {
    await revokeGoogleToken(userRec.refreshToken);
  }

  const deleted = [];
  const keysToDelete = [
    'user:' + userSub,
    'sheet:' + userSub,
    // Referral keys (clean these up too)
    'referral:code:' + userSub,
  ];

  // If user has a referral code, also delete the reverse lookup.
  const code = await kvGet('referral:code:' + userSub);
  if (code) keysToDelete.push('referral:reverse:' + code);

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

// Both delete (3/hr) and export (2/hr) are sensitive but distinct.
// We use a single bucket here keyed by `account_op` with the conservative cap of 5/hour
// — covers both flows together since real users do these very rarely.
export default withRequestId(
  withRateLimit({ key: 'account_op', limit: 5, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
