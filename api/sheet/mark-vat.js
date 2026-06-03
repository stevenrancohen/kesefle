// /api/sheet/mark-vat
//
// Bridge endpoint called by the Apps Script bot when a non-owner user sends
// the "/מעמ" (VAT deductible) command. We find the LAST row of their תנועות
// tab, verify it was written in the last 24 hours, and flip col I to TRUE.
//
// Same auth/credential pattern as /api/sheet/append: shared bot secret +
// per-phone lookup of the user's encrypted refresh token in KV.
//
// POST body:
//   {
//     phone: "972526003090",
//     botSecret: "..."        // OR x-kesefle-bot-secret header
//   }
//
// Returns:
//   200 { ok:true, rowIndex: 567 }                -- flagged successfully
//   400 { ok:false, error:"invalid_phone" }
//   401 { ok:false, error:"unauthorized" }         -- bot secret mismatch
//   404 { ok:false, error:"no_recent_expense" }    -- empty sheet
//   409 { ok:false, error:"too_old" }              -- last row > 24h old
//   429 { ok:false, error:"rate_limit_exceeded" }
//   502 { ok:false, error:"sheets_update_failed" } -- upstream Sheets API
//
// Behavior notes:
//   - We treat "last row" as the bottom non-empty row of the תנועות sheet.
//   - The 24h cutoff means the user can't retroactively flag a stale row by
//     accident (e.g. typing "מעמ" days after the original expense). They can
//     still hand-edit col I in the sheet for that.
//   - On the read step we ask for A:I -- if the sheet still has only 8 cols
//     (legacy), the per-cell update at I{n} below auto-extends columnCount.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
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

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Bot-only -- fail closed if the shared secret env is missing.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('mark_vat.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  // Timing-safe comparison; lib/crypto.js export. Lazy import keeps
  // cold-start small for the common authed path.
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    log.warn('mark_vat.unauthorized', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  // Per-phone rate limit -- the user shouldn't legitimately need to flag
  // more than a few rows in a minute. 20/hr per phone is generous.
  const phoneLim = await rateLimitId(phone, { key: 'mark_vat_phone', limit: 20, windowSec: 3600 });
  if (!phoneLim.ok) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: phoneLim.retryAfter });
  }

  // Resolve the user (same pattern as append.js).
  const phoneRec = await kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }
  const sheetRec = await kvGet('sheet:' + phoneRec.userSub);
  const userRec = (await kvGet('user:' + phoneRec.userSub)) || {};
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;

  // Same leak guard as append.js -- abort if phone record and canonical
  // mapping disagree.
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('mark_vat.sheet_ownership_mismatch', {
      reqId: req.reqId, phone, userSub: phoneRec.userSub,
      phoneRecordSheet: phoneSheetId, canonicalSheet: canonicalSheetId,
    });
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
  }
  const spreadsheetId = canonicalSheetId || phoneSheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) {
    return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
  }
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  // Mint an access token.
  let refreshToken = null;
  if (userRec.refreshTokenEnvelope) {
    try { refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, phoneRec.userSub); }
    catch (e) {
      log.warn('mark_vat.refresh_decrypt_failed', { reqId: req.reqId, error: e.message });
      return res.status(403).json({ ok: false, error: 'refresh_token_decrypt_failed' });
    }
  } else {
    refreshToken = userRec.refreshToken;
  }
  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) {
    log.warn('mark_vat.token_refresh_failed', { reqId: req.reqId, error: e.message });
    return res.status(403).json({ ok: false, error: 'reauth_needed', detail: e.message });
  }

  // Read the last row of the תנועות tab. We use a windowed read (A:A) just
  // to find the last non-empty row index cheaply, then a targeted read of
  // that row to verify the 24h cutoff.
  const dateColUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${TX_TAB}'!A:A`)}`;
  let dateColResp;
  try {
    dateColResp = await fetch(dateColUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheets_api_unreachable', detail: e.message });
  }
  if (!dateColResp.ok) {
    const t = await dateColResp.text().catch(() => '');
    return res.status(502).json({ ok: false, error: 'sheets_read_failed', detail: t.slice(0, 200) });
  }
  const dateColJson = await dateColResp.json().catch(() => ({}));
  const dateValues = dateColJson.values || [];
  // Find the last non-empty data row (row index is 1-based; row 1 is the header).
  let lastDataRowIndex = -1;
  for (let i = dateValues.length - 1; i >= 1; i--) {
    if (dateValues[i] && dateValues[i][0] != null && String(dateValues[i][0]).trim() !== '') {
      lastDataRowIndex = i + 1; // 1-based sheet row
      break;
    }
  }
  if (lastDataRowIndex < 2) {
    return res.status(404).json({ ok: false, error: 'no_recent_expense' });
  }

  // 24h cutoff: parse the cell as a date.
  const lastTsRaw = dateValues[lastDataRowIndex - 1][0];
  const lastTs = new Date(lastTsRaw);
  if (isNaN(lastTs.getTime())) {
    log.warn('mark_vat.unparseable_date', { reqId: req.reqId, raw: String(lastTsRaw).slice(0, 80) });
    // Fall through and just flag anyway -- the row exists and the user
    // explicitly asked. The bot's reply text will still inform them. Better
    // to flag than to reject on a date-parse edge case.
  } else if ((Date.now() - lastTs.getTime()) > 24 * 60 * 60 * 1000) {
    return res.status(409).json({ ok: false, error: 'too_old' });
  }

  // Write TRUE to col I of that row. Use PUT (values.update) so we don't
  // append a new row. valueInputOption=RAW preserves the boolean type.
  const updateRange = encodeURIComponent(`'${TX_TAB}'!I${lastDataRowIndex}`);
  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${updateRange}?valueInputOption=RAW`;
  let updateResp;
  try {
    updateResp = await fetch(updateUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[true]] }),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheets_api_unreachable', detail: e.message });
  }
  if (!updateResp.ok) {
    const t = await updateResp.text().catch(() => '');
    log.warn('mark_vat.sheets_update_failed', { reqId: req.reqId, status: updateResp.status, body: t.slice(0, 200) });
    return res.status(502).json({ ok: false, error: 'sheets_update_failed', detail: t.slice(0, 200) });
  }

  // Best-effort: seed the header cell I1 with "ניכוי מע״מ" if it's missing
  // (legacy sheets that predate this feature). Don't fail the request if it
  // doesn't work -- the data write above already succeeded.
  try {
    const hdrUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${TX_TAB}'!I1`)}`;
    const hdrR = await fetch(hdrUrl, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (hdrR.ok) {
      const hdrJ = await hdrR.json().catch(() => ({}));
      const current = (hdrJ.values && hdrJ.values[0] && hdrJ.values[0][0]) || '';
      if (!current) {
        await fetch(hdrUrl + '?valueInputOption=RAW', {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [['ניכוי מע״מ']] }),
        }).catch(() => {});
      }
    }
  } catch (_hdrErr) { /* non-fatal */ }

  log.info('mark_vat.ok', { reqId: req.reqId, phone, userSub: phoneRec.userSub, spreadsheetId, rowIndex: lastDataRowIndex });
  return res.status(200).json({ ok: true, rowIndex: lastDataRowIndex });
}

// 30 marks/hr per IP (lenient; the per-phone 20/hr inside is the load-bearing cap).
export default withRequestId(
  withRateLimit({ key: 'mark_vat_ip', limit: 30, windowSec: 3600 })(handlerImpl)
);
