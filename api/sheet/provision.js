// Provisions a new Google Sheet for a user by copying the template.
// Env: KESEFLE_TEMPLATE_SHEET_ID (the master template), KV_REST_API_URL, KV_REST_API_TOKEN.
//
// Flow:
//   1. Browser obtains a Google access token with drive.file + spreadsheets scopes.
//   2. Browser POSTs { accessToken, userSub, userEmail } to this endpoint.
//   3. Server calls drive.files.copy to clone the template into user's Drive.
//   4. Server stores { userSub -> spreadsheetId } in Vercel KV.
//   5. Server returns the new spreadsheet URL.

import { requireAuth } from '../../lib/auth.js';
import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

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
  // CRITICAL FIX (C4): bind userSub to verified ID-token identity. Previous code accepted
  // userSub from body, allowing an attacker to supply their own accessToken + the victim's
  // sub and route the victim's incoming WhatsApp expenses to the attacker's Drive.
  const userSub = req.user.sub;
  const userEmail = req.user.email || String(body?.userEmail || '').trim();

  if (!accessToken || accessToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing accessToken' });
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
          name: `כסף'לה — ${userEmail || userSub}`.slice(0, 200),
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

  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/${encodeURIComponent('sheet:' + userSub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });

      // Also merge into the user record (which has the refresh token from /api/auth/google-exchange)
      // so that the webhook's phone:<E.164> lookup gets the full picture.
      try {
        const userRes = await fetch(`${kvUrl}/get/${encodeURIComponent('user:' + userSub)}`, {
          headers: { 'Authorization': `Bearer ${kvToken}` },
        });
        const userJson = await userRes.json();
        const userRec = userJson?.result ? JSON.parse(userJson.result) : null;
        if (userRec) {
          userRec.spreadsheetId = spreadsheetId;
          userRec.spreadsheetUrl = spreadsheetUrl;
          userRec.provisioned = record.provisioned;
          await fetch(`${kvUrl}/set/${encodeURIComponent('user:' + userSub)}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(userRec),
          });
        }
      } catch (e) {
        console.warn('user_record_merge_failed', e);
      }
    } catch (e) {
      console.error('KV save failed', e);
    }
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

// Apply security middleware: request ID → rate limit (5/hour for sheet provisioning) → auth
export default withRequestId(
  withRateLimit({ key: 'sheet_provision', limit: 5, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
