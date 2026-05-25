// api/profession/seed-sheet.js
//
// Seed a user's "מאזן אישי" dashboard with profession-tailored category
// rows from lib/professions.js. Called by the bot AFTER Q4 of onboarding
// when the user has picked (or freely typed) their profession.
//
// Example: a קבלן בניין (general_contractor) gets these rows added to
// their dashboard so they see per-category totals immediately:
//   הכנסות:  תקבול מלקוח, מקדמה, תשלום ביניים
//   הוצאות:  בטון, גבס, פועלים, אינסטלציה, חומרי בניין
//
// The row layout + formula matches /api/sheet/add-category-row exactly —
// label in col A, SUMPRODUCT formula in col B that fuzzy-matches across
// תנועות D/E/F. We batch all rows into a single Sheets values:append call
// so seeding 8–12 rows costs 1 API call, not 12.
//
// POST /api/profession/seed-sheet
// Headers: x-kesefle-bot-secret: <secret>   (OR body.botSecret)
// Body:    { phone: "972...", profession: "general_contractor" }
//
// Returns:
//   200 { ok: true, profession, addedRows: [labels], skippedDuplicates: [labels], totalNow }
//   400 { ok: false, error: "missing_phone"|"missing_profession"|"unknown_profession" }
//   401 { ok: false, error: "unauthorized" }
//   404 { ok: false, error: "no_user"|"no_sheet" }
//   409 { ok: false, error: "reauth_required" }
//   502 { ok: false, error: "sheet_read_failed"|"sheet_write_failed"|"token_refresh_failed" }
//
// SECURITY: bot-secret authed (constant-time compare). Strict tenant
// isolation via phone:{e164} → userSub → sheet:{userSub}; we NEVER fall
// through to the owner sheet (same invariant as append.js).
//
// IDEMPOTENT: re-running for the same profession is safe — labels that
// already exist in col A are returned in skippedDuplicates and the row
// count doesn't double.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess, PERSONAL_DASHBOARD_TAB, TX_TAB, sanitizeCell } from '../../lib/sheet-writer.js';
import { findProfession } from '../../lib/professions.js';
import { getProfessionRows } from '../../lib/profession-template.js';

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

// Mirror buildCategoryRowValues from api/sheet/add-category-row.js so the
// rows we seed look identical to user-created ones. The fuzzy regex
// matches across category/subcategory/description columns of תנועות so
// the user sees credit for that category no matter how the bot
// classified the original expense.
function buildRowValues(label) {
  const name = label;
  const reEscaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escaped = reEscaped.replace(/"/g, '""');
  const pattern = `(?i)(^|[^֐-׿A-Za-z0-9])${escaped}([^֐-׿A-Za-z0-9]|$)`;
  const formula = `=IFERROR(SUMPRODUCT(('${TX_TAB}'!C2:C5000)*` +
    `((IFERROR(REGEXMATCH('${TX_TAB}'!D2:D5000,"${pattern}"),FALSE))+` +
    `(IFERROR(REGEXMATCH('${TX_TAB}'!E2:E5000,"${pattern}"),FALSE))+` +
    `(IFERROR(REGEXMATCH('${TX_TAB}'!F2:F5000,"${pattern}"),FALSE))>0)),0)`;
  return [sanitizeCell(label), formula];
}

async function readDashboardLabels(spreadsheetId, accessToken) {
  const range = encodeURIComponent(`'${PERSONAL_DASHBOARD_TAB}'!A1:A300`);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return { ok: false, status: r.status, detail: await r.text().catch(() => '') };
  const j = await r.json();
  const values = j.values || [];
  // Trim + strip leading emoji+space so "🏗 בטון" compares equal to "בטון".
  const stripEmoji = (s) => String(s || '').replace(/^[\p{Extended_Pictographic}\p{Emoji_Component}]+\s+/u, '').trim();
  return { ok: true, raw: values.map((row) => String((row[0] || '')).trim()), stripped: values.map((row) => stripEmoji(row[0])) };
}

// Batch-append multiple rows in a single Sheets API call. USER_ENTERED so
// the formula in col B is recognised as a formula, not a literal string.
async function appendDashboardRows(spreadsheetId, accessToken, rows) {
  if (!rows.length) return { ok: true, addedCount: 0 };
  const range = encodeURIComponent(`'${PERSONAL_DASHBOARD_TAB}'!A:B`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return { ok: false, status: r.status, detail };
  }
  const j = await r.json();
  return { ok: true, addedCount: rows.length, updatedRange: j.updates?.updatedRange || '' };
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

  const professionId = String(body.profession || '').trim().toLowerCase();
  if (!professionId) return res.status(400).json({ ok: false, error: 'missing_profession' });
  if (!/^[a-z0-9_]{1,64}$/.test(professionId)) {
    return res.status(400).json({ ok: false, error: 'invalid_profession_format' });
  }

  const profession = findProfession(professionId);
  if (!profession) {
    return res.status(400).json({ ok: false, error: 'unknown_profession', detail: 'no such id in lib/professions.js' });
  }

  // Per-phone rate limit — this endpoint should be hit at most once per
  // signup (or rarely when the user changes profession). Generous enough
  // for legit retries, tight enough that a bug can't fill the sheet.
  const lim = await rateLimitId(phone, { key: 'profession_seed_phone', limit: 5, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  // Phone → userSub → sheet. Identical invariant to append.js: never fall
  // through to the owner sheet (cross-tenant write would be a leak).
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

  // Read existing labels so we can skip duplicates. Idempotency matters:
  // a user who picks the SAME profession twice (e.g. tapped אחר → typed
  // קבלן which fuzzy-matches general_contractor) should not get 2× rows.
  const labelsR = await readDashboardLabels(spreadsheetId, accessToken);
  if (!labelsR.ok) {
    return res.status(502).json({ ok: false, error: 'sheet_read_failed', detail: String(labelsR.detail).slice(0, 200) });
  }
  const existingStripped = new Set(labelsR.stripped.filter(Boolean));

  // Build the to-add list. Income rows get a 💰 prefix, expense rows get
  // a 💸 prefix so the user can visually tell them apart in the dashboard.
  // (The fuzzy regex strips the emoji before matching so totals still work.)
  const rows = getProfessionRows(professionId);
  const addedLabels = [];   // human-facing labels we successfully queued
  const writeRows = [];     // [labelCell, formulaCell] tuples for Sheets
  const skipped = [];

  function queueRow(sub, emoji) {
    const bareName = String(sub).trim();
    if (!bareName) return;
    const label = emoji + ' ' + bareName;
    if (existingStripped.has(bareName)) {
      skipped.push(label);
      return;
    }
    const [labelCell, formulaCell] = buildRowValues(label);
    writeRows.push([labelCell, formulaCell]);
    addedLabels.push(label);
  }

  rows.income.forEach(function (sub) { queueRow(sub, '💰'); });
  rows.expense.forEach(function (sub) { queueRow(sub, '💸'); });

  if (writeRows.length === 0) {
    return res.status(200).json({
      ok: true,
      profession: professionId,
      addedRows: [],
      skippedDuplicates: skipped,
      totalNow: labelsR.raw.length,
      note: 'all rows already present (idempotent re-run)',
    });
  }

  const writeR = await appendDashboardRows(spreadsheetId, accessToken, writeRows);
  if (!writeR.ok) {
    try {
      const { alertOwnerOfClientError } = await import('../../lib/error-alert.js');
      alertOwnerOfClientError({
        reqId: req.reqId, phone, userSub,
        route: '/api/profession/seed-sheet',
        code: 'sheet_write_failed',
        detail: `profession=${professionId} rows=${writeRows.length} status=${writeR.status} ${String(writeR.detail).slice(0, 120)}`,
      });
    } catch (_alertErr) {}
    return res.status(502).json({
      ok: false,
      error: 'sheet_write_failed',
      status: writeR.status,
      detail: String(writeR.detail).slice(0, 200),
    });
  }

  // addedLabels was already populated above by queueRow().
  log.info('profession_seed.ok', {
    reqId: req.reqId, userSub, phone, profession: professionId,
    addedCount: addedLabels.length, skippedCount: skipped.length,
  });

  return res.status(200).json({
    ok: true,
    profession: professionId,
    addedRows: addedLabels,
    skippedDuplicates: skipped,
    totalNow: labelsR.raw.length + addedLabels.length,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  });
}

export default withRequestId(
  withRateLimit({ key: 'profession_seed', limit: 30, windowSec: 60 })(handlerImpl)
);
