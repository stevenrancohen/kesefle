// api/sheet/export.js
//
// Export the user's full transactions in CSV or JSON. Useful for power
// users + GDPR right-to-data-portability (Article 20).
//
// GET /api/sheet/export?format=csv (default) | json
// Auth: requireAuth (session cookie or Bearer).
// Rate limit: 10 exports/hour/userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { exchangeRefreshForAccess, TX_TAB, TX_HEADERS } from '../../lib/sheet-writer.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

function csvEscape(s) {
  s = String(s == null ? '' : s);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'sheet_export_user', limit: 10, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  const format = String(req.query.format || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') {
    return res.status(400).json({ ok: false, error: 'invalid_format', detail: 'use csv|json' });
  }

  const sheetRec = await kvGet(`sheet:${userSub}`);
  const userRec = (await kvGet(`user:${userSub}`)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  // Read all data rows.
  const range = encodeURIComponent(`'${TX_TAB}'!A2:I20001`);
  let rows;
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'sheet_read_failed', detail: errBody.slice(0, 200) });
    }
    const j = await r.json();
    rows = j.values || [];
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_read_threw', detail: e.message });
  }

  log.info('sheet_export.ok', { reqId: req.reqId, userSub, format, rowCount: rows.length });

  const today = new Date().toISOString().slice(0, 10);
  const filename = `kesefle-export-${today}.${format}`;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // UTF-8 BOM so Excel opens Hebrew correctly.
    const header = TX_HEADERS.map(csvEscape).join(',');
    const body = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
    return res.status(200).send('﻿' + header + '\n' + body);
  }

  // JSON: friendly key-value shape with English keys so downstream tools
  // (Excel pivot, Python scripts) don't need to handle RTL.
  const items = rows.map((r) => ({
    date: r[0] || '',
    month: r[1] || '',
    amount: Number(r[2]) || 0,
    category: r[3] || '',
    subcategory: r[4] || '',
    description: r[5] || '',
    source: r[6] || '',
    isExpense: r[7] === true || r[7] === 'TRUE' || r[7] === 'true' || r[7] === '1',
    vatDeductible: r[8] === true || r[8] === 'TRUE' || r[8] === 'true' || r[8] === '1',
  }));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).json({
    exported_at: new Date().toISOString(),
    total_rows: items.length,
    headers_hebrew: TX_HEADERS,
    items,
  });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_export', limit: 30, windowSec: 60 })(requireAuth(handlerImpl))
);
