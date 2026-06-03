// /api/sheet/tax-report
//
// Year-end VAT deductible summary for עוסק מורשה customers. Reads the user's
// תנועות tab via the stored refresh token, filters to rows in the requested
// year where col I (ניכוי מע״מ) = TRUE, and returns aggregates by category
// and month plus a small sample of rows.
//
// This is the JSON backbone for a future "ניכוי מע״מ — דוח שנתי" PDF view.
// PDF generation needs a real library + an HTML template -- deferred to v2.
//
// Auth: requireAuth (Bearer Google ID token OR kfl_session cookie).
// Rate limit: 5/hour/userSub (reading a year of rows is heavy; lower is
//   safer for the Sheets API quota too).
//
// GET /api/sheet/tax-report?year=2026
//   200 {
//     ok: true,
//     year: 2026,
//     totalDeductible: 12450.5,
//     byCategory: { "עסק": 8000, "תוכנות": 4450.5 },
//     byMonth:    { "2026-01": 1200, "2026-02": 800, ... },
//     rowCount: 17,
//     sample: [ { date, amount, category, subcategory, description }, ... ],   // first 5
//   }
//   401 { ok:false, error:"missing_auth" }              -- not signed in
//   404 { ok:false, error:"no_sheet_provisioned" }      -- user has no sheet yet
//   429 { ok:false, error:"rate_limit_exceeded" }
//   502 { ok:false, error:"sheets_read_failed" }        -- transient upstream
//
// Notes:
//   - Sheets API returns col I cells as boolean TRUE/FALSE (because we wrote
//     them as booleans via valueInputOption=RAW). When read, the values arrive
//     as either the JS string "TRUE"/"FALSE" or as a JSON true/false depending
//     on the row's actual underlying type. We tolerate both.
//   - Legacy sheets predating col I will have undefined cells in that slot --
//     those rows are correctly skipped (treated as deductible=false).
//   - We cap at 5000 rows scanned to bound Sheets quota usage per request.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j?.result ? JSON.parse(j.result) : null;
}

// True iff the raw cell value from Sheets represents a TRUE boolean. Tolerates
// both the JSON boolean (when the cell was written with valueInputOption=RAW)
// and the string forms "TRUE" / "true" (when a human typed the cell or a
// different writer used USER_ENTERED).
function isTrueCell(v) {
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === '1' || s === 'כן';
  }
  return false;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // requireAuth populates req.user; cryptographic identity guarantee.
  const userSub = req.user.sub;

  // Per-userSub rate limit -- this endpoint reads up to 5000 rows of the
  // Sheets API per call, so we keep it intentionally low.
  const lim = await rateLimitId(userSub, { key: 'sheet_tax_report', limit: 5, windowSec: 3600 });
  if (!lim.ok) {
    res.setHeader('Retry-After', String(lim.retryAfter || 3600));
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: lim.retryAfter });
  }

  // Year defaults to current; clamp to 2020..2100 to refuse nonsense input.
  const reqYearRaw = (req.query && req.query.year != null) ? String(req.query.year) : '';
  const now = new Date();
  let year = now.getFullYear();
  if (reqYearRaw) {
    const y = parseInt(reqYearRaw, 10);
    if (Number.isFinite(y) && y >= 2020 && y <= 2100) year = y;
  }

  // Resolve the user's sheet (sheet:{sub} canonical, user:{sub} fallback) +
  // refresh token. Same pattern as summary.js / provision.js.
  const sheetRec = await kvGet('sheet:' + userSub);
  const userRec = (await kvGet('user:' + userSub)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) {
    return res.status(404).json({ ok: false, error: 'no_sheet_provisioned' });
  }

  let refreshToken = null;
  if (userRec.refreshTokenEnvelope) {
    try {
      refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    } catch (e) {
      log.warn('tax_report.refresh_decrypt_failed', { reqId: req.reqId, userSub, error: e.message });
      return res.status(403).json({ ok: false, error: 'refresh_token_decrypt_failed' });
    }
  } else if (userRec.refreshToken) {
    refreshToken = userRec.refreshToken;  // legacy plaintext
  } else {
    return res.status(403).json({ ok: false, error: 'reauth_needed' });
  }

  let accessToken;
  try {
    accessToken = await exchangeRefreshForAccess(refreshToken);
  } catch (e) {
    log.warn('tax_report.token_refresh_failed', { reqId: req.reqId, userSub, error: e.message });
    return res.status(403).json({ ok: false, error: 'reauth_needed', detail: e.message });
  }

  // Read A2:I5001 from the תנועות tab. Cap at 5000 rows -- well above any
  // realistic year of expenses for a single עוסק and keeps Sheets quota in
  // check on the off chance someone has a 10k-row sheet.
  const range = encodeURIComponent(`'${TX_TAB}'!A2:I5001`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  let resp;
  try {
    resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  } catch (e) {
    log.warn('tax_report.sheets_unreachable', { reqId: req.reqId, userSub, error: e.message });
    return res.status(502).json({ ok: false, error: 'sheets_api_unreachable', detail: e.message });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    log.warn('tax_report.sheets_read_failed', { reqId: req.reqId, userSub, status: resp.status, body: t.slice(0, 200) });
    return res.status(resp.status === 404 ? 404 : 502).json({ ok: false, error: 'sheets_read_failed', detail: t.slice(0, 200) });
  }
  const j = await resp.json().catch(() => ({}));
  const allRows = j.values || [];

  // Aggregate.
  // Row layout (matches lib/sheet-writer.js buildExpenseRow):
  //   [0]=date ISO, [1]=YYYY-MM, [2]=amount, [3]=category, [4]=subcategory,
  //   [5]=description, [6]=source, [7]=isExpense bool, [8]=vatDeductible bool
  let totalDeductible = 0;
  let rowCount = 0;
  const byCategory = {};
  const byMonth = {};
  const sample = [];
  const yearStr = String(year);

  for (const row of allRows) {
    if (!row || !Array.isArray(row)) continue;
    // Fast filter: col I must be truthy.
    if (!isTrueCell(row[8])) continue;
    // Year filter: prefer col B (YYYY-MM), fall back to parsing col A.
    let monthKey = String(row[1] || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      const d = new Date(row[0]);
      if (isNaN(d.getTime())) continue;
      monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    if (monthKey.slice(0, 4) !== yearStr) continue;

    const amount = parseFloat(row[2]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const category = (row[3] != null ? String(row[3]) : '') || 'אחר';
    const subcategory = (row[4] != null ? String(row[4]) : '');

    totalDeductible += amount;
    rowCount += 1;
    byCategory[category] = (byCategory[category] || 0) + amount;
    byMonth[monthKey] = (byMonth[monthKey] || 0) + amount;

    if (sample.length < 5) {
      const dateStr = String(row[0] || '').slice(0, 10);
      sample.push({
        date: dateStr,
        amount,
        category,
        subcategory,
        description: (row[5] != null ? String(row[5]) : ''),
      });
    }
  }

  // Round totals to 2 decimals (NIS cents) so the JSON output is clean.
  function round2(n) { return Math.round(n * 100) / 100; }
  totalDeductible = round2(totalDeductible);
  for (const k of Object.keys(byCategory)) byCategory[k] = round2(byCategory[k]);
  for (const k of Object.keys(byMonth)) byMonth[k] = round2(byMonth[k]);

  log.info('tax_report.ok', { reqId: req.reqId, userSub, year, rowCount, totalDeductible });

  return res.status(200).json({
    ok: true,
    year,
    totalDeductible,
    byCategory,
    byMonth,
    rowCount,
    sample,
    refreshed_at: new Date().toISOString(),
  });
}

// requestId -> per-IP rate limit (10/hr, conservative; the per-user 5/hr
// check inside handlerImpl is the load-bearing one) -> requireAuth -> handler.
export default withRequestId(
  withRateLimit({ key: 'sheet_tax_report_ip', limit: 10, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
