// /api/transactions/export
// GET — returns user's transactions as CSV (UTF-8 BOM for Excel Hebrew support).
// Optional query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&type=expense|income|all

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

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // RFC 4180: quote if contains comma, quote, or newline. Double inner quotes.
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const userSub = req.user.sub;
  const fromDate = req.query.from ? new Date(req.query.from) : null;
  const toDate = req.query.to ? new Date(req.query.to) : null;
  const typeFilter = String(req.query.type || 'all').toLowerCase();

  const userRec = await kvGet('user:' + userSub);
  if (!userRec?.spreadsheetId) {
    return res.status(404).json({ ok: false, error: 'no_sheet' });
  }

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

  const range = encodeURIComponent("'תנועות'!A2:I10001");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!r.ok) return res.status(r.status).json({ ok: false, error: 'sheets_read_failed' });
  const j = await r.json();
  const rows = j.values || [];

  // Filter
  let filtered = rows
    .filter(row => row[0]) // must have a date
    .map(row => ({
      date: row[0],
      amount: parseFloat(row[1] || '0') || 0,
      currency: row[2] || 'ILS',
      type: (row[3] || '').toLowerCase(),
      category: row[4] || '',
      subcategory: row[5] || '',
      raw: row[6] || '',
      source: row[7] || '',
      messageId: row[8] || '',
    }));

  if (fromDate && !isNaN(fromDate)) {
    filtered = filtered.filter(t => new Date(t.date) >= fromDate);
  }
  if (toDate && !isNaN(toDate)) {
    filtered = filtered.filter(t => new Date(t.date) <= toDate);
  }
  if (typeFilter !== 'all') {
    filtered = filtered.filter(t => t.type === typeFilter);
  }

  // Build CSV
  const headers = ['Date', 'Amount', 'Currency', 'Type', 'Category', 'Subcategory', 'Description', 'Source', 'MessageId'];
  const csvLines = [headers.map(csvCell).join(',')];
  for (const t of filtered) {
    csvLines.push([t.date, t.amount, t.currency, t.type, t.category, t.subcategory, t.raw, t.source, t.messageId].map(csvCell).join(','));
  }
  const csv = csvLines.join('\r\n');
  // UTF-8 BOM so Excel renders Hebrew correctly
  const body = '﻿' + csv;

  const filename = `kesefle-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  log.info('txn.export_ok', { reqId: req.reqId, userSub, count: filtered.length });
  return res.status(200).send(body);
}

export default withRequestId(
  withRateLimit({ key: 'txn_export', limit: 10, windowSec: 60 })(
    requireAuth(handlerImpl)
  )
);
