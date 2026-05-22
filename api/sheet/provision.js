// Provisions a new Google Sheet for a user by CREATING a fresh spreadsheet
// (not copying a template). Env: KV_REST_API_URL, KV_REST_API_TOKEN.
//
// Flow:
//   1. Browser obtains a Google access token with the drive.file scope only.
//   2. Browser POSTs { accessToken } to this endpoint.
//   3. Server creates a fresh spreadsheet (תנועות + summary) in the user's Drive.
//      Because the app created it, the narrow drive.file scope covers all later
//      reads/writes — no drive.readonly, no full spreadsheets scope, so the app
//      is publishable without a Google CASA security assessment.
//   4. Server stores { userSub -> spreadsheetId } in Vercel KV.
//   5. Server returns the new spreadsheet URL.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { getGoogleClientId } from '../../lib/auth.js';
import { createUserSheetWithToken, exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { getUserId } from '../_lib/session.js';

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
  // We CREATE a fresh sheet (app-created) instead of copying a template, so
  // only the narrow drive.file scope is required — no drive.readonly, no full
  // spreadsheets scope. That keeps the app verifiable without a CASA assessment.
  const scopes = String(info.scope || '').split(/\s+/);
  if (!scopes.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('missing_drive_file_scope');
  return info;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const bodyAccessToken = String(body?.accessToken || '').trim();

  // Two auth modes:
  //   A) Initial provision (right after OAuth) -- browser passes `accessToken`
  //      from the just-completed PKCE exchange. We verify via tokeninfo +
  //      use the same token to create the sheet.
  //   B) Retry path -- browser has no fresh access token but has a session
  //      cookie. We use the session to find the user, then mint a new access
  //      token from the stored encrypted refresh token, then create the sheet.
  let userSub, userEmail, accessToken;

  if (bodyAccessToken && bodyAccessToken.length >= 20) {
    // Mode A: verify the provided access token via tokeninfo.
    let tokenInfo;
    try {
      tokenInfo = await verifyAccessToken(bodyAccessToken);
    } catch (e) {
      log.warn('provision.token_invalid', { reqId: req.reqId, error: e.message });
      return res.status(401).json({ ok: false, error: 'invalid_access_token', detail: e.message });
    }
    userSub = tokenInfo.sub;
    userEmail = tokenInfo.email || String(body?.userEmail || '').trim();
    accessToken = bodyAccessToken;
  } else {
    // Mode B: session-cookie retry. Look up the user via the cookie, then
    // mint a fresh access token from their stored refresh token.
    userSub = getUserId(req);
    if (!userSub) {
      return res.status(401).json({ ok: false, error: 'not_signed_in' });
    }
    const kvUrl0 = process.env.KV_REST_API_URL;
    const kvToken0 = process.env.KV_REST_API_TOKEN;
    if (!kvUrl0 || !kvToken0) {
      return res.status(503).json({ ok: false, error: 'kv_unavailable' });
    }
    try {
      const tokRes = await fetch(`${kvUrl0}/get/${encodeURIComponent('token:' + userSub)}`, {
        headers: { 'Authorization': `Bearer ${kvToken0}` },
      });
      const tokJson = await tokRes.json();
      const tokRec = tokJson?.result ? JSON.parse(tokJson.result) : null;
      if (!tokRec || (!tokRec.refreshTokenEnvelope && !tokRec.refreshToken)) {
        return res.status(401).json({ ok: false, error: 'no_refresh_token_relink_needed' });
      }
      const refresh = tokRec.refreshToken || decryptRefreshToken(tokRec.refreshTokenEnvelope, userSub);
      accessToken = await exchangeRefreshForAccess(refresh);
    } catch (e) {
      log.error('provision.session_token_mint_failed', { reqId: req.reqId, userSub, error: e.message });
      return res.status(502).json({ ok: false, error: 'session_token_mint_failed', detail: e.message });
    }
    // Best-effort: pull email from the user record if we have one.
    try {
      const usrRes = await fetch(`${kvUrl0}/get/${encodeURIComponent('user:' + userSub)}`, {
        headers: { 'Authorization': `Bearer ${kvToken0}` },
      });
      const usrJson = await usrRes.json();
      const usrRec = usrJson?.result ? JSON.parse(usrJson.result) : null;
      userEmail = usrRec?.email || '';
    } catch (_e) { userEmail = ''; }
  }

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

  // Create a FRESH spreadsheet (app-created → drive.file covers it) instead of
  // copying a template (which needed drive.readonly). Same end result for the
  // user: a sheet in their OWN Drive with a תנועות tab + live summary.
  let spreadsheetId, spreadsheetUrl;
  try {
    const created = await createUserSheetWithToken(accessToken, `כספ'לה — ${userEmail || userSub}`);
    spreadsheetId = created.spreadsheetId;
    spreadsheetUrl = created.spreadsheetUrl;
  } catch (e) {
    log.error('provision.sheet_create_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'sheet_create_failed', detail: e.message });
  }

  const record = {
    userSub,
    userEmail,
    spreadsheetId,
    spreadsheetUrl,
    provisioned: new Date().toISOString(),
  };

  // KV setter that VERIFIES the write succeeded by reading it back. The bot
  // finds a user's sheet via these mappings -- a silent failure here means
  // the user gets a sheet in their Drive but the bot can never write to it.
  // Upstash returns 200 even on transient inconsistencies, so an HTTP 200 is
  // necessary but not sufficient; we re-read after every write and compare
  // the stored spreadsheetId. Retries once on any mismatch.
  const kvSetChecked = async (key, val) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(val),
        });
        if (!r.ok) continue;
        // Verify the write by reading it back. If the value matches what we
        // intended to store, we're done. If it's missing or different,
        // something between us and Upstash dropped it -- retry.
        const verifyRes = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
          headers: { 'Authorization': `Bearer ${kvToken}` },
        });
        if (!verifyRes.ok) continue;
        const verifyJson = await verifyRes.json().catch(() => ({}));
        const stored = verifyJson?.result ? JSON.parse(verifyJson.result) : null;
        if (stored && stored.spreadsheetId === val.spreadsheetId) return true;
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
