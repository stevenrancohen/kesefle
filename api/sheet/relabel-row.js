// api/sheet/relabel-row.js
//
// Overwrite the category (col D) and subcategory (col E) of a SPECIFIC
// row in a user's "תנועות" tab. Used by the bot's "change category"
// interactive picker that appears under every expense confirmation.
//
// POST /api/sheet/relabel-row
// Headers: x-kesefle-bot-secret: <secret>
// Body: { phone, rowIndex, newCategory, newSubcategory?, botSecret? }
//
// Returns:
//   200 { ok: true, rowIndex }
//   400 { ok: false, error: 'missing_phone' | 'invalid_row_index' | 'missing_new_category' }
//   401 { ok: false, error: 'unauthorized' }
//   404 { ok: false, error: 'no_user' | 'no_sheet' }
//   409 { ok: false, error: 'reauth_required' }
//   502 { ok: false, error: 'sheet_write_failed', detail }
//
// SECURITY: bot-secret authed via constantTimeEqual. Phone normalized to
// E.164. Resolves canonical user via phone:{e164} -> userSub -> sheet:{sub}
// -- never reads from owner SHEET_ID. Per-phone rate limit 20/hr so a
// chatty picker can't burn the user's Sheets quota.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess, sanitizeCell, normalizeSubcategoryForDashboard } from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;

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

  if (!BOT_SECRET) {
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }
  const presented =
    String(req.headers['x-kesefle-bot-secret'] || '') ||
    String((req.body && req.body.botSecret) || '');
  if (!presented || !constantTimeEqual(presented, BOT_SECRET)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'missing_phone' });

  const rowIndex = Number(body.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > 5001) {
    return res.status(400).json({ ok: false, error: 'invalid_row_index' });
  }

  const newCategory = String(body.newCategory || '').trim().slice(0, 60);
  if (!newCategory) {
    return res.status(400).json({ ok: false, error: 'missing_new_category' });
  }
  const newSubcategory = String(body.newSubcategory || '').trim().slice(0, 60);

  // Per-phone rate limit.
  const lim = await rateLimitId(phone, { key: 'relabel_row_phone', limit: 20, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  // Tenant resolution (same pattern as append.js + add-category-row.js).
  const phoneRec = await kvGet(`phone:${phone}`);
  const userSub = phoneRec?.userSub;
  if (!userSub) return res.status(404).json({ ok: false, error: 'no_user' });
  const userRec = await kvGet(`user:${userSub}`);
  const sheetRec = await kvGet(`sheet:${userSub}`);

  // PR-S2 (2026-05-27 security audit H1): tenant-isolation guard.
  // Same shape as api/sheet/append.js:124-132. Aborts BEFORE relabel if the
  // phone-record's cached sheet id disagrees with canonical sheet:{userSub}.
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('relabel_row.sheet_ownership_mismatch', {
      reqId: req.reqId, phone, userSub,
      phoneRecordSheet: phoneSheetId, canonicalSheet: canonicalSheetId,
    });
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
  }

  const spreadsheetId = canonicalSheetId || userRec?.spreadsheetId || null;
  if (!spreadsheetId) return res.status(404).json({ ok: false, error: 'no_sheet' });
  if (!userRec?.refreshTokenEnvelope && !userRec?.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  // Write col D + col E only. RAW so we don't accidentally evaluate as
  // a formula. sanitizeCell strips bidi + leading formula-trigger chars.
  const range = encodeURIComponent(`'${TX_TAB}'!D${rowIndex}:E${rowIndex}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`;
  const cellD = sanitizeCell(newCategory);
  // Canonicalize col E to a real dashboard ROW LABEL (or the שונות catch-all) so
  // a relabel can NEVER make the amount invisible to the personal-dashboard
  // SUMIFS -- mirrors the protected append path (buildExpenseRow). Falls back to
  // the raw value only if the helper is somehow unavailable.
  let dashSub;
  try {
    dashSub = typeof normalizeSubcategoryForDashboard === 'function'
      ? normalizeSubcategoryForDashboard(newSubcategory || newCategory, newCategory)
      : (newSubcategory || newCategory);
  } catch (_normErr) {
    dashSub = newSubcategory || newCategory;
  }
  const cellE = sanitizeCell(dashSub || newCategory);
  let r;
  try {
    r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[cellD, cellE]] }),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', detail: e.message });
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    // Alert Steven on persistent errors (same pattern as other writers).
    try {
      const { alertOwnerOfClientError } = await import('../../lib/error-alert.js');
      alertOwnerOfClientError({
        reqId: req.reqId, phone, userSub,
        route: '/api/sheet/relabel-row',
        code: 'sheet_write_failed',
        detail: `row=${rowIndex} status=${r.status} ${String(detail).slice(0, 120)}`,
      });
    } catch (_e2) {}
    return res.status(502).json({
      ok: false, error: 'sheet_write_failed', status: r.status,
      detail: String(detail).slice(0, 200),
    });
  }

  log.info('relabel_row.ok', {
    reqId: req.reqId, userSub, phone, rowIndex,
    newCategory, newSubcategory,
  });

  return res.status(200).json({ ok: true, rowIndex });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_relabel_row', limit: 60, windowSec: 60 })(handlerImpl)
);
