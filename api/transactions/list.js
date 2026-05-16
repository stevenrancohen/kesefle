// /api/transactions/list
// Returns paginated transactions from the authenticated user's sheet.
// Auth: requireAuth (verified Google ID token). User's own data only.
//
// Query: ?page=1&limit=50&type=expense|income|all&category=<sub>&q=<text-search>
//
// Returns: { ok, transactions: [{rowIdx, date, amount, currency, type, category, subcategory, raw, messageId}], total, page, hasMore }

import { requireAuth } from '../../lib/auth.js';
import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

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

async function exchangeRefreshForAccess(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var missing');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

async function getRefreshToken(userRec, userSub) {
  if (userRec.refreshTokenEnvelope) {
    return decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
  }
  if (userRec.refreshToken) return userRec.refreshToken; // legacy
  throw new Error('no_refresh_token');
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const userSub = req.user.sub;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const typeFilter = String(req.query.type || 'all').toLowerCase();
  const categoryFilter = String(req.query.category || '').toLowerCase();
  const q = String(req.query.q || '').toLowerCase();

  const userRec = await kvGet('user:' + userSub);
  if (!userRec || !userRec.spreadsheetId) {
    return res.status(404).json({ ok: false, error: 'no_sheet_provisioned' });
  }

  let refreshToken;
  try { refreshToken = await getRefreshToken(userRec, userSub); }
  catch (e) { return res.status(403).json({ ok: false, error: 'reauth_needed' }); }

  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) { return res.status(403).json({ ok: false, error: 'token_refresh_failed' }); }

  const range = encodeURIComponent("'תנועות'!A2:I5001");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!r.ok) {
    return res.status(r.status).json({ ok: false, error: 'sheets_read_failed' });
  }
  const j = await r.json();
  const rows = j.values || [];

  // Build transactions array. rowIdx is 2-based (matches sheet rows).
  let txns = rows.map((row, i) => ({
    rowIdx: i + 2, // sheet row number (header at row 1)
    date: row[0] || '',
    amount: parseFloat(row[1] || '0') || 0,
    currency: row[2] || 'ILS',
    type: (row[3] || '').toLowerCase(),
    category: row[4] || 'אחר',
    subcategory: row[5] || '',
    raw: row[6] || '',
    source: row[7] || '',
    messageId: row[8] || '',
  })).filter(t => t.date); // ignore blank rows

  // Apply filters
  if (typeFilter !== 'all') txns = txns.filter(t => t.type === typeFilter);
  if (categoryFilter) txns = txns.filter(t => t.category.toLowerCase() === categoryFilter || t.subcategory.toLowerCase() === categoryFilter);
  if (q) txns = txns.filter(t => t.raw.toLowerCase().includes(q) || t.subcategory.toLowerCase().includes(q) || t.category.toLowerCase().includes(q));

  // Sort by date desc (newest first)
  txns.sort((a, b) => (b.date > a.date) ? 1 : (b.date < a.date) ? -1 : 0);

  const total = txns.length;
  const start = (page - 1) * limit;
  const slice = txns.slice(start, start + limit);

  return res.status(200).json({
    ok: true,
    transactions: slice,
    total,
    page,
    limit,
    hasMore: (start + limit) < total,
  });
}

export default withRequestId(
  withRateLimit({ key: 'txns_list', limit: 60, windowSec: 60 })(
    requireAuth(handlerImpl)
  )
);
