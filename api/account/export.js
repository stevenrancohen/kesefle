// /api/account/export
// GDPR Article 20 + Israeli Privacy Law: right to data portability.
// Returns a single JSON document with ALL data the system holds about the user,
// suitable for self-service download.
//
// Auth: requireAuth (verified Google ID token, user's own data only).
// Rate-limited: 2 per hour (this is heavy + sensitive).

import { requireAuth } from '../../lib/auth.js';
import { withRequestId, log, redact } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
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

async function handlerImpl(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const userSub = req.user.sub;
  const userRec = await kvGet('user:' + userSub) || {};

  // Strip sensitive crypto material — user shouldn't see their own refresh token envelope
  // (it has no value to them; the Google account itself is the source of truth).
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

  const exportDoc = {
    export_meta: {
      exported_at: new Date().toISOString(),
      user_sub: userSub,
      format_version: '1.0',
      note: 'This is the complete export of all data Kesefle holds about your account. Per GDPR Article 20 and Israeli Privacy Law Section 13. To delete this data, use POST /api/account/delete.',
      note_he: 'זהו ייצוא מלא של כל הנתונים ש"כסף\'לה" שומר על חשבונך. לפי GDPR סעיף 20 וחוק הגנת הפרטיות סעיף 13. למחיקה: POST /api/account/delete.',
    },
    profile: userProfile,
    transactions: {
      count: transactions.length,
      data: transactions,
      read_error: sheetReadError,
      note: 'Transactions live in your own Google Sheet at spreadsheet_url. This export is a snapshot.',
    },
    not_stored_by_kesefle: [
      'Original raw WhatsApp message bodies (only the parsed amount + category are persisted)',
      'Your bank/credit card data (we never receive it)',
      'Your phone number content beyond the sender field on incoming messages',
      'Your Google contacts, calendar, drive files outside the kesefle-provisioned sheet',
      'Your IP address beyond the last request (rate-limit ephemeral)',
    ],
    your_rights: {
      delete: 'POST /api/account/delete with confirmation:"DELETE-MY-ACCOUNT"',
      export: 'GET /api/account/export (this endpoint)',
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

export default withRequestId(
  withRateLimit({ key: 'account_export', limit: 2, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
