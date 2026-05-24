// api/sheet/add-category-row.js
//
// Append a custom CATEGORY ROW to the user's "מאזן אישי" dashboard sheet.
// Used by:
//   1. The bot "צור קטגוריה X" command (writes a sub-category that the
//      user can use immediately — e.g. "צור קטגוריה ילד דניאל").
//   2. The onboarding questionnaire's kids step (writes one row per kid
//      name the user typed).
//
// The new row formula uses SUMPRODUCT with SEARCH so it matches ANY of:
//   - col D (category)       contains the name
//   - col E (subcategory)    contains the name
//   - col F (description)    contains the name
// This is intentionally fuzzy so the user gets credit no matter how the
// bot classified the original expense or what description it logged.
//
// POST /api/sheet/add-category-row
// Headers: x-kesefle-bot-secret: <secret>
// Body: { phone: "972...", name: "דניאל", emoji?: "👶", botSecret?: "..." }
//
// Returns:
//   200 { ok: true, rowIndex: N, label: "...", sheetUrl: "..." }
//   400 { ok: false, error: "missing_phone"|"missing_name"|"invalid_name" }
//   401 { ok: false, error: "unauthorized" }
//   404 { ok: false, error: "no_user"|"no_sheet" }
//   409 { ok: false, error: "duplicate", existingRow: N }
//   502 { ok: false, error: "sheet_write_failed", detail }
//
// SECURITY: bot-secret authed. Resolves canonical user via
// phone:{e164} → userSub → user:{sub} (NEVER reads from the SHEET_OWNER
// owner sheet). If the user is unlinked, returns 404 with a hint to
// finish OAuth on /account.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { constantTimeEqual } from '../../lib/crypto.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess, PERSONAL_DASHBOARD_TAB, TX_TAB, sanitizeCell } from '../../lib/sheet-writer.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;
const NAME_MAX = 40;

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

async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const path = ttlSec ? `/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `/set/${encodeURIComponent(key)}`;
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: typeof value === 'string' ? value : JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) { return false; }
}

// Sanitise a user-supplied category name. Strips control chars + leading
// formula chars (sanitizeCell already does this defensively, but we also
// enforce a length cap and reject empty/punctuation-only inputs).
function sanitizeName(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // Strip bidi/zero-width hidden chars.
  s = s.replace(/[‎‏‪-‮⁦-⁩﻿]/g, '');
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX);
  // Must contain at least one Hebrew or Latin word char.
  if (!/[֐-׿A-Za-z]/.test(s)) return '';
  return s;
}

// Read existing personal-dashboard rows so we (a) detect duplicates and
// (b) know what row index to write to. We read only col A which is fast.
async function readDashboardLabels(spreadsheetId, accessToken) {
  const range = encodeURIComponent(`'${PERSONAL_DASHBOARD_TAB}'!A1:A200`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return { ok: false, status: r.status, detail: await r.text().catch(() => '') };
  const j = await r.json();
  const values = j.values || [];
  return { ok: true, values: values.map((row) => String((row[0] || '')).trim()) };
}

// Build the row payload (label in A, SUMPRODUCT formula in B that matches
// the name across category/subcategory/description columns of תנועות).
// USER_ENTERED so the formula is evaluated by Sheets.
function buildCategoryRowValues(label, name) {
  const escaped = String(name).replace(/"/g, '""');
  const formula = `=IFERROR(SUMPRODUCT(('${TX_TAB}'!C2:C5000)*` +
    `((ISNUMBER(SEARCH("${escaped}",'${TX_TAB}'!D2:D5000)))+` +
    `(ISNUMBER(SEARCH("${escaped}",'${TX_TAB}'!E2:E5000)))+` +
    `(ISNUMBER(SEARCH("${escaped}",'${TX_TAB}'!F2:F5000)))>0)),0)`;
  return [sanitizeCell(label), formula];
}

// Append a single row to the personal-dashboard tab using USER_ENTERED so
// the formula in column B is recognised as a formula.
async function appendDashboardRow(spreadsheetId, accessToken, labelCell, formulaCell) {
  const range = encodeURIComponent(`'${PERSONAL_DASHBOARD_TAB}'!A:B`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[labelCell, formulaCell]] }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return { ok: false, status: r.status, detail };
  }
  const j = await r.json();
  // Parse the updated range to find the row index (e.g.
  // "'מאזן אישי'!A61:B61" → 61).
  const ur = j.updates?.updatedRange || '';
  const m = ur.match(/!?[A-Z]+(\d+)/);
  const rowIndex = m ? Number(m[1]) : null;
  return { ok: true, rowIndex };
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Bot-secret auth (header OR body, since Apps Script UrlFetchApp can be
  // finicky about custom headers).
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

  const phone = String(body.phone || '').replace(/\D+/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'missing_phone' });

  const name = sanitizeName(body.name);
  if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

  const emoji = body.emoji ? sanitizeName(body.emoji).slice(0, 4) : '';
  const label = (emoji ? emoji + ' ' : '') + name;

  // Per-phone rate limit so a chatty bot caller can't fill the sheet.
  const lim = await rateLimitId(phone, { key: 'add_category_row_phone', limit: 12, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  // Phone → userSub → user record + sheet. NEVER fall through to the
  // owner sheet (tenant isolation invariant — same pattern as append.js).
  const phoneRec = await kvGet(`phone:${phone}`);
  const userSub = phoneRec?.userSub;
  if (!userSub) {
    return res.status(404).json({
      ok: false,
      error: 'no_user',
      detail: 'phone not linked — connect on /account first',
    });
  }
  const userRec = await kvGet(`user:${userSub}`);
  const sheetRec = await kvGet(`sheet:${userSub}`);
  const spreadsheetId = sheetRec?.spreadsheetId || userRec?.spreadsheetId || null;
  if (!spreadsheetId) {
    return res.status(404).json({
      ok: false,
      error: 'no_sheet',
      detail: 'user has no provisioned sheet yet',
    });
  }
  if (!userRec?.refreshTokenEnvelope && !userRec?.refreshToken) {
    return res.status(409).json({
      ok: false,
      error: 'reauth_required',
      detail: 'sign in again at /account',
    });
  }

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  // Duplicate check — read existing dashboard labels.
  const labelsR = await readDashboardLabels(spreadsheetId, accessToken);
  if (!labelsR.ok) {
    return res.status(502).json({ ok: false, error: 'sheet_read_failed', detail: String(labelsR.detail).slice(0, 200) });
  }
  const labels = labelsR.values;
  for (let i = 0; i < labels.length; i++) {
    // Compare against the bare name AND the prefixed label.
    if (labels[i] && (labels[i] === name || labels[i] === label || labels[i].includes(name))) {
      return res.status(200).json({
        ok: true,
        rowIndex: i + 1,
        label: labels[i],
        duplicate: true,
        sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      });
    }
  }

  // Build + append the new row.
  const [labelCell, formulaCell] = buildCategoryRowValues(label, name);
  const writeR = await appendDashboardRow(spreadsheetId, accessToken, labelCell, formulaCell);
  if (!writeR.ok) {
    return res.status(502).json({
      ok: false,
      error: 'sheet_write_failed',
      status: writeR.status,
      detail: String(writeR.detail).slice(0, 200),
    });
  }

  // Mirror into custom_categories KV so the bot's classifier learns the
  // new category and uses it on the next message containing the name.
  try {
    const existing = (await kvGet(`custom_categories:${userSub}`)) || { items: [], updatedAt: null };
    const items = Array.isArray(existing.items) ? existing.items : [];
    if (!items.find((c) => c.name === name)) {
      items.push({ name, addedAt: new Date().toISOString(), source: 'bot_create_category' });
      await kvSet(`custom_categories:${userSub}`, { items, updatedAt: new Date().toISOString() });
    }
  } catch (_mirrorErr) {
    // Non-fatal — the dashboard row is already in place.
  }

  log.info('add_category_row.ok', {
    reqId: req.reqId, userSub, phone, name, rowIndex: writeR.rowIndex,
  });

  return res.status(200).json({
    ok: true,
    rowIndex: writeR.rowIndex,
    label,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_add_category_row', limit: 30, windowSec: 60 })(handlerImpl)
);
