// api/sheet/delete-rows.js
//
// Bulk-delete rows from the user's transactions tab. Matches rows by
// (date, amount, description) since the dashboard's `recent` payload doesn't
// expose row indices to the client (and exposing them would leak sheet
// internals + race with other writes anyway).
//
// POST { matches: [{ date, amount, description, isIncome }, ...] }
// Auth: requireAuth (session cookie or Bearer ID token).
// Rate limit: 30 deletes/hour per userSub.
// Cap: max 50 rows per call (prevents accidental mass-delete).
//
// Behavior: for each match, scans the sheet's "תנועות" tab (read all rows
// in a single GET), finds the FIRST row that matches all 3 fields, queues
// a deleteDimension request for that row. Sheets API batchUpdate runs the
// queued deletions in REVERSE row order so indices don't shift mid-batch.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { exchangeRefreshForAccess, TX_TAB } from '../../lib/sheet-writer.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_PER_CALL = 50;

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

function approxEqual(a, b) {
  // Amounts may be stored as numbers OR formatted strings ("245" / "245.00").
  // Use a 0.01 tolerance.
  return Math.abs(Number(a) - Number(b)) < 0.01;
}

function normalizeStr(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseDateCell(raw) {
  if (!raw) return '';
  // Google Sheets serializes dates as ISO strings or "YYYY-MM-DD". Trim time.
  return String(raw).slice(0, 10);
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'sheet_delete_user', limit: 30, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const matches = Array.isArray(body?.matches) ? body.matches : [];
  if (!matches.length) return res.status(400).json({ ok: false, error: 'no_matches' });
  if (matches.length > MAX_PER_CALL) {
    return res.status(413).json({ ok: false, error: 'too_many_matches', detail: `max ${MAX_PER_CALL} per call` });
  }

  const sheetRec = await kvGet(`sheet:${userSub}`);
  const userRec = (await kvGet(`user:${userSub}`)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  // Mint a fresh Google access token.
  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  // Pull all rows from the transactions tab in a single GET.
  const range = encodeURIComponent(`'${TX_TAB}'!A2:I5001`);
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  let rows;
  try {
    const r = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, error: 'sheet_read_failed', detail: j?.error?.message || r.status });
    rows = j.values || [];
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_read_threw', detail: e.message });
  }

  // We also need the sheetId (numeric tab ID) for deleteDimension. Get it
  // from spreadsheet metadata.
  let txSheetId = null;
  try {
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`;
    const mr = await fetch(metaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const mj = await mr.json().catch(() => ({}));
    const txSheet = (mj.sheets || []).find(s => s.properties?.title === TX_TAB);
    txSheetId = txSheet?.properties?.sheetId;
    if (txSheetId == null) {
      return res.status(502).json({ ok: false, error: 'tx_tab_not_found' });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_meta_failed', detail: e.message });
  }

  // For each match, find the FIRST matching row in the sheet and queue
  // its row index for deletion. Track which matches we found so we can
  // report partial success.
  const toDelete = []; // array of 1-based row indices (row 2 = data row 0)
  const found = [];
  const notFound = [];
  for (const m of matches) {
    const target = {
      date: parseDateCell(m.date),
      amount: Number(m.amount),
      desc: normalizeStr(m.description),
    };
    let matchedIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      // Skip rows already marked for deletion in this batch (don't dedup a single match twice).
      if (toDelete.includes(i + 2)) continue;
      const row = rows[i];
      // Columns: A=date, B=month, C=amount, D=cat, E=subcat, F=desc, G=src, H=status, I=vat
      const rowDate = parseDateCell(row[0]);
      const rowAmount = Number(row[2]);
      const rowDesc = normalizeStr(row[5]);
      if (rowDate === target.date && approxEqual(rowAmount, target.amount) && rowDesc === target.desc) {
        matchedIdx = i + 2; // sheet rows are 1-indexed, row 1 is header
        break;
      }
    }
    if (matchedIdx > 0) {
      toDelete.push(matchedIdx);
      found.push({ date: target.date, amount: target.amount });
    } else {
      notFound.push({ date: target.date, amount: target.amount });
    }
  }

  if (!toDelete.length) {
    return res.status(404).json({ ok: false, error: 'no_matches_found', notFound });
  }

  // Sort descending so deletions don't shift indices.
  toDelete.sort((a, b) => b - a);

  // Build batchUpdate requests -- one deleteDimension per row. We can't
  // combine into a single range because matches may be non-contiguous.
  const requests = toDelete.map((rowIdx1) => ({
    deleteDimension: {
      range: {
        sheetId: txSheetId,
        dimension: 'ROWS',
        startIndex: rowIdx1 - 1, // 0-indexed in batchUpdate range
        endIndex: rowIdx1,
      },
    },
  }));

  try {
    const bUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const br = await fetch(bUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (!br.ok) {
      const errBody = await br.text().catch(() => '');
      log.error('delete_rows.batchupdate_failed', { reqId: req.reqId, userSub, status: br.status, body: errBody.slice(0, 200) });
      return res.status(502).json({ ok: false, error: 'delete_failed', detail: errBody.slice(0, 200) });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'delete_threw', detail: e.message });
  }

  log.info('delete_rows.ok', { reqId: req.reqId, userSub, spreadsheetId, deleted: toDelete.length, notFound: notFound.length });
  return res.status(200).json({
    ok: true,
    deleted: toDelete.length,
    notFound,
    found,
  });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_delete', limit: 120, windowSec: 60 })(requireAuth(handlerImpl))
);
