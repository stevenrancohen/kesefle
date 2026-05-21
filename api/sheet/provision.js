// Provisions a new Google Sheet for a user by copying the template.
// Env: KESEFLE_TEMPLATE_SHEET_ID (the master template), KV_REST_API_URL, KV_REST_API_TOKEN.
//
// Flow:
//   1. Browser obtains a Google access token with drive.file + spreadsheets scopes.
//   2. Browser POSTs { accessToken, userSub, userEmail } to this endpoint.
//   3. Server calls drive.files.copy to clone the template into user's Drive.
//   4. Server stores { userSub -> spreadsheetId } in Vercel KV.
//   5. Server returns the new spreadsheet URL.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { getGoogleClientId } from '../../lib/auth.js';

// Server-side verification of a Google OAuth access token.
// Returns { sub, email, scope, ... } if valid, throws if not.
// This replaces requireAuth() for this specific endpoint because the GIS oauth2 token-client
// flow used by account.html returns ONLY an access token (no ID token). Verifying the access
// token via the tokeninfo endpoint gives us a cryptographically guaranteed sub claim, which is
// what C4 required.
async function verifyAccessToken(accessToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!r.ok) throw new Error('tokeninfo_status_' + r.status);
  const info = await r.json();
  if (info.error) throw new Error('tokeninfo_error_' + info.error);
  if (!info.sub) throw new Error('tokeninfo_missing_sub');
  // Check audience matches our OAuth client
  const expectedAud = getGoogleClientId();
  if (info.aud && info.aud !== expectedAud) throw new Error('tokeninfo_aud_mismatch');
  // Check scopes include drive.file + drive.readonly + spreadsheets.
  // drive.readonly is required to read the template Sheet (which the user
  // hasn't opened via this app, so drive.file alone won't grant access).
  const scopes = String(info.scope || '').split(/\s+/);
  if (!scopes.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('missing_drive_file_scope');
  if (!scopes.includes('https://www.googleapis.com/auth/drive.readonly')) throw new Error('missing_drive_readonly_scope');
  return info;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const templateId = process.env.KESEFLE_TEMPLATE_SHEET_ID;
  if (!templateId) {
    return res.status(500).json({ ok: false, error: 'server misconfigured: KESEFLE_TEMPLATE_SHEET_ID missing' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const accessToken = String(body?.accessToken || '').trim();

  if (!accessToken || accessToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing accessToken' });
  }

  // SECURITY (C4 fix): verify access token server-side via Google's tokeninfo.
  // The userSub comes from the VERIFIED tokeninfo response, NOT from body — prevents
  // attacker supplying their own token + victim's sub to redirect the sheet.
  let tokenInfo;
  try {
    tokenInfo = await verifyAccessToken(accessToken);
  } catch (e) {
    log.warn('provision.token_invalid', { reqId: req.reqId, error: e.message });
    return res.status(401).json({ ok: false, error: 'invalid_access_token', detail: e.message });
  }
  const userSub = tokenInfo.sub;
  const userEmail = tokenInfo.email || String(body?.userEmail || '').trim();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const existingRes = await fetch(`${kvUrl}/get/${encodeURIComponent('sheet:' + userSub)}`, {
        headers: { 'Authorization': `Bearer ${kvToken}` },
      });
      const existing = await existingRes.json();
      if (existing?.result) {
        const parsed = JSON.parse(existing.result);
        return res.status(200).json({
          ok: true,
          reused: true,
          spreadsheetId: parsed.spreadsheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${parsed.spreadsheetId}`,
        });
      }
    } catch (e) {
      console.warn('KV lookup failed, will provision new', e);
    }
  }

  let copyResult;
  try {
    const copyRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateId)}/copy?supportsAllDrives=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `כספ'לה — ${userEmail || userSub}`.slice(0, 200),
        }),
      }
    );
    copyResult = await copyRes.json();
    if (!copyRes.ok) {
      return res.status(copyRes.status).json({
        ok: false,
        error: 'drive copy failed',
        detail: copyResult?.error?.message || 'unknown',
      });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'drive api unreachable: ' + e.message });
  }

  const spreadsheetId = copyResult.id;
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  const record = {
    userSub,
    userEmail,
    spreadsheetId,
    spreadsheetUrl,
    provisioned: new Date().toISOString(),
  };

  // KV setter that VERIFIES the write succeeded and retries once. The bot finds
  // a user's sheet via these mappings — a silent failure here means the user
  // gets a sheet in their Drive but the bot can never write to it.
  const kvSetChecked = async (key, val) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(val),
        });
        if (r.ok) return true;
      } catch (_e) { /* retry */ }
    }
    return false;
  };

  if (kvUrl && kvToken) {
    // CRITICAL mapping. If this fails after a retry, do NOT report success —
    // the user must be able to retry rather than be left with an orphaned sheet.
    const sheetSaved = await kvSetChecked('sheet:' + userSub, record);
    if (!sheetSaved) {
      log.error('provision.sheet_mapping_save_failed', { reqId: req.reqId, userSub, spreadsheetId });
      return res.status(502).json({
        ok: false,
        error: 'sheet_registration_failed',
        detail: 'הגיליון נוצר אך ההרשמה לא הושלמה. נסו שוב בעוד רגע.',
        spreadsheetId,
        spreadsheetUrl,
      });
    }

    // Best-effort: mirror the sheet id into the user + token records so the
    // phone:<E.164> link lookup can resolve it from any of them.
    try {
      const userRes = await fetch(`${kvUrl}/get/${encodeURIComponent('user:' + userSub)}`, { headers: { 'Authorization': `Bearer ${kvToken}` } });
      const userJson = await userRes.json();
      const userRec = userJson?.result ? JSON.parse(userJson.result) : null;
      if (userRec) {
        userRec.spreadsheetId = spreadsheetId;
        userRec.spreadsheetUrl = spreadsheetUrl;
        userRec.provisioned = record.provisioned;
        await kvSetChecked('user:' + userSub, userRec);
      }
    } catch (e) { console.warn('user_record_merge_failed', e); }

    try {
      const tokRes = await fetch(`${kvUrl}/get/${encodeURIComponent('token:' + userSub)}`, { headers: { 'Authorization': `Bearer ${kvToken}` } });
      const tokJson = await tokRes.json();
      const tokRec = tokJson?.result ? JSON.parse(tokJson.result) : null;
      if (tokRec) { tokRec.sheetId = spreadsheetId; await kvSetChecked('token:' + userSub, tokRec); }
    } catch (e) { console.warn('token_record_merge_failed', e); }
  } else {
    console.log('SHEET_PROVISIONED', JSON.stringify(record));
  }

  return res.status(200).json({
    ok: true,
    reused: false,
    spreadsheetId,
    spreadsheetUrl,
  });
}

// Apply security middleware: request ID → rate limit (5/hour for sheet provisioning).
// Auth is done inside handlerImpl via verifyAccessToken (tokeninfo) — gives us the same
// cryptographic guarantee about the user's identity as requireAuth, but works with the
// access-token-only flow the frontend currently uses.
export default withRequestId(
  withRateLimit({ key: 'sheet_provision', limit: 5, windowSec: 3600 })(handlerImpl)
);
