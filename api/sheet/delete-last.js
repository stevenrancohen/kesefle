// /api/sheet/delete-last
//
// Bridge endpoint called by the Apps Script bot when a non-owner user
// asks the bot to delete their last expense ("מחק", "תמחק", "בטל",
// "מחק אחרון"). We resolve the user via phone -> user:{sub}, fetch
// their refresh token, mint a Sheets API access token, find the last
// data row of the תנועות tab, return its values, and delete it.
//
// Returns the deleted row so the bot can echo "🗑️ נמחק: ₪320 שיווק"
// back to the user.
//
// POST body (JSON):
//   {
//     phone: "972526003090",   // E.164, required
//     messageId: "wamid.XXX",  // optional, for log de-dup
//     botSecret: "..."          // OR x-kesefle-bot-secret header
//   }
//
// Returns:
//   { ok: true, deleted: { amount, category, subcategory, description, rowNumber } }
//   { ok: false, error: "no_user_for_phone" | "empty_sheet" | ... }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { exchangeRefreshForAccess, sanitizeCell } from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // Bot-secret gate (same pattern as /api/sheet/append).
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  // Per-phone rate limit (#24): parity with append/stats — this is a destructive
  // write (deletes the last row), so cap each phone, not just the shared IP.
  const phoneLim = await rateLimitId(phone, { key: 'delete_last_phone', limit: 30, windowSec: 60 });
  if (!phoneLim.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

  // Resolve phone -> user:{sub} -> userRecord (mirrors api/sheet/append.js).
  const phoneRec = await kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }
  const userRecord = await kvGet('user:' + phoneRec.userSub);
  if (!userRecord || !userRecord.spreadsheetId) {
    return res.status(404).json({ ok: false, error: 'no_sheet_for_user' });
  }

  // PR-S2 (2026-05-27 security audit H1): tenant-isolation guard.
  // Same shape as api/sheet/append.js:124-132. Aborts BEFORE deleting if the
  // phone-record's cached sheet id disagrees with the canonical sheet:{userSub}.
  // Without this guard, a stale/poisoned phone-record sheet pointer could
  // route a DELETE call to the wrong tenant's sheet.
  const sheetRec = await kvGet('sheet:' + phoneRec.userSub);
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('delete_last.sheet_ownership_mismatch', {
      reqId: req.reqId, phone, userSub: phoneRec.userSub,
      phoneRecordSheet: phoneSheetId, canonicalSheet: canonicalSheetId,
    });
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
  }

  // Decrypt + mint access token.
  let refreshToken = null;
  if (userRecord.refreshTokenEnvelope) {
    try { refreshToken = decryptRefreshToken(userRecord.refreshTokenEnvelope, userRecord.userSub); }
    catch (e) { return res.status(500).json({ ok: false, error: 'refresh_token_decrypt_failed', detail: e.message }); }
  } else if (userRecord.refreshToken) {
    refreshToken = userRecord.refreshToken;
  } else {
    return res.status(409).json({ ok: false, error: 'no_refresh_token_relink_needed' });
  }
  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) { return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message }); }

  const spreadsheetId = userRecord.spreadsheetId;
  const authH = { Authorization: `Bearer ${accessToken}` };

  // Step 1: read the תנועות tab to find the last data row + its values.
  const range = encodeURIComponent(`'${TX_TAB}'!A:I`);
  let readResp;
  try { readResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, { headers: authH }); }
  catch (e) { return res.status(502).json({ ok: false, error: 'sheets_api_unreachable', detail: e.message }); }
  if (!readResp.ok) {
    const errBody = await readResp.text().catch(() => '');
    return res.status(502).json({ ok: false, error: 'read_failed', status: readResp.status, detail: errBody.slice(0, 200) });
  }
  const readJson = await readResp.json();
  const values = readJson.values || [];
  // Row 1 is the header; we need at least 2 rows total to have any data.
  if (values.length < 2) {
    return res.status(404).json({ ok: false, error: 'empty_sheet' });
  }
  const lastIdx = values.length - 1;
  const lastRow = values[lastIdx];
  const rowNumber = lastIdx + 1; // 1-indexed in Sheets UI

  // Step 2: find the numeric sheetId of the תנועות tab (deleteDimension needs it).
  let metaResp;
  try { metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, { headers: authH }); }
  catch (e) { return res.status(502).json({ ok: false, error: 'meta_unreachable', detail: e.message }); }
  if (!metaResp.ok) {
    return res.status(502).json({ ok: false, error: 'meta_read_failed', status: metaResp.status });
  }
  const meta = await metaResp.json();
  const txProps = (meta.sheets || []).map((s) => s.properties).find((p) => p && p.title === TX_TAB);
  if (!txProps) {
    return res.status(404).json({ ok: false, error: 'no_tx_tab' });
  }

  // Step 3: deleteDimension for the last row (0-indexed in API, so lastIdx).
  const batchBody = {
    requests: [{
      deleteDimension: {
        range: {
          sheetId: txProps.sheetId,
          dimension: 'ROWS',
          startIndex: lastIdx,
          endIndex: lastIdx + 1,
        },
      },
    }],
  };
  let delResp;
  try {
    delResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { ...authH, 'Content-Type': 'application/json' },
      body: JSON.stringify(batchBody),
    });
  } catch (e) { return res.status(502).json({ ok: false, error: 'delete_unreachable', detail: e.message }); }
  if (!delResp.ok) {
    const errBody = await delResp.text().catch(() => '');
    return res.status(502).json({ ok: false, error: 'delete_failed', status: delResp.status, detail: errBody.slice(0, 200) });
  }

  // Echo what we deleted (columns: A date, B month, C amount, D category,
  // E subcategory, F description). Be defensive about missing cells.
  const deleted = {
    rowNumber,
    date: lastRow[0] || '',
    month: lastRow[1] || '',
    amount: Number(lastRow[2]) || 0,
    category: sanitizeCell(lastRow[3] || ''),
    subcategory: sanitizeCell(lastRow[4] || ''),
    description: sanitizeCell(lastRow[5] || ''),
  };
  log.info('sheet.delete_last', { reqId: req.reqId, userSub: phoneRec.userSub, rowNumber, amount: deleted.amount });

  return res.status(200).json({ ok: true, deleted });
}

export default withRequestId(
  withRateLimit({ key: 'sheet-delete', limit: 30, windowSec: 60 })(handlerImpl)
);
