// /api/transactions/edit
// PATCH a transaction by rowIdx in the user's sheet.
// Body: { rowIdx, fields: { amount?, type?, category?, subcategory?, raw? } }
// Returns: { ok, updated, rowIdx }

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

// Sanitize cell value to prevent formula injection (matches webhook.js convention)
function sanitizeCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  const cleaned = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  const firstNonSpace = cleaned.trimStart()[0];
  if (firstNonSpace === '=' || firstNonSpace === '+' || firstNonSpace === '-' || firstNonSpace === '@' || firstNonSpace === '\t') {
    return "'" + cleaned;
  }
  return cleaned;
}

async function handlerImpl(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const rowIdx = parseInt(body?.rowIdx, 10);
  const fields = body?.fields || {};
  if (!Number.isInteger(rowIdx) || rowIdx < 2 || rowIdx > 10000) {
    return res.status(400).json({ ok: false, error: 'invalid_rowIdx' });
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ ok: false, error: 'fields_must_be_object' });
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

  // First read the existing row so we keep unspecified columns intact
  const readRange = encodeURIComponent(`'תנועות'!A${rowIdx}:I${rowIdx}`);
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${readRange}`;
  const readResp = await fetch(readUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!readResp.ok) return res.status(readResp.status).json({ ok: false, error: 'row_read_failed' });
  const readJson = await readResp.json();
  const existing = (readJson.values || [[]])[0] || [];
  if (existing.length === 0) return res.status(404).json({ ok: false, error: 'row_not_found' });

  // Apply field overrides
  const next = [...existing];
  while (next.length < 9) next.push('');
  if ('amount' in fields) next[1] = typeof fields.amount === 'number' ? fields.amount : parseFloat(fields.amount) || 0;
  if ('currency' in fields) next[2] = sanitizeCell(String(fields.currency).slice(0, 8));
  if ('type' in fields) {
    const t = String(fields.type).toLowerCase();
    if (t !== 'expense' && t !== 'income') return res.status(400).json({ ok: false, error: 'invalid_type' });
    next[3] = t;
  }
  if ('category' in fields) next[4] = sanitizeCell(String(fields.category).slice(0, 64));
  if ('subcategory' in fields) next[5] = sanitizeCell(String(fields.subcategory).slice(0, 128));
  if ('raw' in fields) next[6] = sanitizeCell(String(fields.raw).slice(0, 500));
  // timestamp (col A) + source (col H) + messageId (col I) are NOT user-editable

  // Write back the full row using RAW mode (no formula injection)
  const writeRange = encodeURIComponent(`'תנועות'!A${rowIdx}:I${rowIdx}`);
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${writeRange}?valueInputOption=RAW`;
  const writeResp = await fetch(writeUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [next] }),
  });
  if (!writeResp.ok) {
    const errText = await writeResp.text().catch(() => '');
    log.error('txn.edit_failed', { reqId: req.reqId, userSub, rowIdx, status: writeResp.status });
    return res.status(writeResp.status).json({ ok: false, error: 'sheets_write_failed', detail: errText.slice(0, 200) });
  }

  log.info('txn.edit_ok', { reqId: req.reqId, userSub, rowIdx, fieldsChanged: Object.keys(fields) });
  return res.status(200).json({ ok: true, updated: true, rowIdx, fields_changed: Object.keys(fields) });
}

export default withRequestId(
  withRateLimit({ key: 'txn_edit', limit: 30, windowSec: 60 })(
    requireAuth(handlerImpl)
  )
);
