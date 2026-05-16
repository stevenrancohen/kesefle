// /api/transactions/delete
// DELETE a transaction by rowIdx in the user's sheet.
// We use "soft delete" (clear the row contents) to preserve row index stability.
// To hard-delete, the user can manually clean the empty rows or we can add a future cleanup job.
//
// Body: { rowIdx, confirm }  — confirm must be 'YES-DELETE'
// Returns: { ok, deleted, rowIdx }

import { requireAuth } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('refresh_failed');
  return j.access_token;
}

async function handlerImpl(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const rowIdx = parseInt(body?.rowIdx, 10);
  if (!Number.isInteger(rowIdx) || rowIdx < 2 || rowIdx > 10000) {
    return res.status(400).json({ ok: false, error: 'invalid_rowIdx' });
  }
  if (body?.confirm !== 'YES-DELETE') {
    return res.status(400).json({ ok: false, error: 'missing_confirmation', hint: 'set confirm:"YES-DELETE"' });
  }

  const userSub = req.user.sub;
  const userRec = await kvGet('user:' + userSub);
  if (!userRec?.spreadsheetId) return res.status(404).json({ ok: false, error: 'no_sheet' });

  let refreshToken;
  try {
    refreshToken = userRec.refreshTokenEnvelope
      ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
      : userRec.refreshToken;
    if (!refreshToken) throw new Error('no_token');
  } catch (e) {
    return res.status(403).json({ ok: false, error: 'reauth_needed' });
  }

  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) { return res.status(403).json({ ok: false, error: 'token_refresh_failed' }); }

  // Soft delete: clear A:I of the row.
  const range = encodeURIComponent(`'תנועות'!A${rowIdx}:I${rowIdx}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}:clear`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    log.error('txn.delete_failed', { reqId: req.reqId, userSub, rowIdx, status: resp.status });
    return res.status(resp.status).json({ ok: false, error: 'sheets_clear_failed', detail: errText.slice(0, 200) });
  }

  log.info('txn.delete_ok', { reqId: req.reqId, userSub, rowIdx });
  return res.status(200).json({ ok: true, deleted: true, rowIdx, soft_delete: true });
}

export default withRequestId(
  withRateLimit({ key: 'txn_delete', limit: 20, windowSec: 60 })(
    requireAuth(handlerImpl)
  )
);
