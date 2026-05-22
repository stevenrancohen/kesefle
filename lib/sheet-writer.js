// lib/sheet-writer.js
//
// Shared helpers for writing rows into a Kesefle tenant's personal Google
// Sheet using their stored Google OAuth refresh token. Extracted from
// api/whatsapp/webhook.js so multiple callers (the WhatsApp webhook for
// users whose Meta webhook is pointed at Vercel, and the Apps-Script
// bridge endpoint /api/sheet/append for users whose webhook still lands
// in Apps Script) can share the same encryption + retry behaviour.
//
// Every function here treats the tenant boundary as load-bearing:
// each row is written to the user's OWN sheet via the user's OWN OAuth
// token. The Kesefle backend never sees the cell values — it just
// negotiates the API call.

import { decryptRefreshToken } from './crypto.js';

const SHEETS_TX_TAB = 'תנועות';
const GROUP_LEDGER_TAB = 'הוצאות קבוצה';

// Copy a Drive template file into the user's Drive and return the new
// spreadsheet's ID + URL. Uses the user's own access token so the sheet
// is owned by them — never by us. Throws on any non-success.
export async function copyTemplateToUserDrive({ refreshTokenEnvelope, refreshToken, userSub, templateId, name }) {
  if (!templateId) throw new Error('template_id_missing');
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) {
    actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub);
  }
  if (!actualRefresh) throw new Error('no_refresh_token');
  const accessToken = await exchangeRefreshForAccess(actualRefresh);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateId)}/copy?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name || "כספ'לה קבוצה").slice(0, 200) }),
    }
  );
  const j = await r.json();
  if (!r.ok || !j.id) {
    throw new Error('drive_copy_failed: ' + (j?.error?.message || r.status));
  }
  return {
    spreadsheetId: j.id,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${j.id}`,
  };
}

// ── Fresh-sheet provisioning (drive.file only) ───────────────────────────────
// Creates a brand-new spreadsheet via the Sheets API instead of copying a
// template. The created file is "app-created", so the narrow drive.file scope
// covers every later read/write — no drive.readonly, no full spreadsheets
// scope, hence NO Google security assessment to publish the app. The structure
// below is the per-tenant tracker: a תנועות tab (A:I, lock-step with
// buildExpenseRow) + a live SUMIF summary.
const TENANT_TX_HEADERS = ['תאריך', 'סכום', 'מטבע', 'סוג', 'קטגוריה', 'תת-קטגוריה', 'תיאור', 'מקור', 'מזהה הודעה'];
// Expense categories the classifier actually emits as the FIRST segment. It
// sends HIERARCHICAL strings ("קניות / ביגוד"), so each summary row wildcard-
// matches the prefix ("קניות*") and SUMIFS restricts to expense rows (income is
// shown in the totals above, never double-counted here). Names match the real
// top-level emits incl. the DEFAULT bucket "שונות ואחרים".
const TENANT_SUMMARY_CATS = ['אוכל', 'תחבורה', 'הוצאות קבועות', 'הוצאות זמניות', 'קניות', 'בריאות', 'בידור', 'חינוך', 'עסק', 'ממשלה ומיסים', 'פיננסים', 'טיפוח', 'חיות מחמד', 'מתנות', 'שונות ואחרים'];

function _sw_str(s) { return { userEnteredValue: { stringValue: String(s == null ? '' : s) } }; }
function _sw_formula(f) { return { userEnteredValue: { formulaValue: f } }; }
function _sw_bold(cell) { cell.userEnteredFormat = { textFormat: { bold: true } }; return cell; }

// Build the create-spreadsheet request body. Pure (no I/O) so it's unit-tested
// offline. The Sheets API expects en_US formula syntax (comma separators) even
// when the spreadsheet locale is he_IL.
export function buildTenantSheetSpec(name) {
  const txHeader = { values: TENANT_TX_HEADERS.map(function (h) { return _sw_bold(_sw_str(h)); }) };
  var sum = [];
  sum.push({ values: [_sw_bold(_sw_str('סיכום')), _sw_str('')] });                                                  // row 1
  sum.push({ values: [_sw_str('סה"כ הכנסות'), _sw_formula('=SUMIFS(תנועות!B:B,תנועות!D:D,"income")')] });          // row 2
  sum.push({ values: [_sw_str('סה"כ הוצאות'), _sw_formula('=SUMIFS(תנועות!B:B,תנועות!D:D,"expense")')] });          // row 3
  sum.push({ values: [_sw_bold(_sw_str('מאזן')), _sw_bold(_sw_formula('=B2-B3'))] });                               // row 4
  sum.push({ values: [_sw_str(''), _sw_str('')] });                                                                  // row 5
  sum.push({ values: [_sw_bold(_sw_str('הוצאות לפי קטגוריה')), _sw_bold(_sw_str('סכום'))] });                       // row 6
  TENANT_SUMMARY_CATS.forEach(function (cat) {
    // Wildcard prefix-match ("קניות*" catches "קניות / ביגוד"); expense-only.
    sum.push({ values: [_sw_str(cat), _sw_formula('=SUMIFS(תנועות!B:B,תנועות!E:E,"' + cat + '*",תנועות!D:D,"expense")')] });
  });
  return {
    properties: { title: String(name || "כספ'לה").slice(0, 200), locale: 'he_IL', timeZone: 'Asia/Jerusalem' },
    sheets: [
      { properties: { title: 'תנועות', index: 0, gridProperties: { frozenRowCount: 1 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [txHeader] }] },
      { properties: { title: 'סיכום', index: 1 },
        data: [{ startRow: 0, startColumn: 0, rowData: sum }] },
    ],
  };
}

// Create a fresh per-tenant spreadsheet with the user's OWN access token, so the
// sheet is owned by them and the app only ever touches this one file (drive.file).
export async function createUserSheetWithToken(accessToken, name) {
  if (!accessToken) throw new Error('no_access_token');
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildTenantSheetSpec(name)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.spreadsheetId) {
    throw new Error('sheet_create_failed: ' + (j?.error?.message || r.status));
  }
  return {
    spreadsheetId: j.spreadsheetId,
    spreadsheetUrl: j.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${j.spreadsheetId}`,
  };
}

// Refresh-token variant for server-side callers (e.g. group creation) that hold
// an envelope rather than a live browser access token.
export async function createUserSheetWithRefresh({ refreshTokenEnvelope, refreshToken, userSub, name }) {
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub);
  if (!actualRefresh) throw new Error('no_refresh_token');
  const accessToken = await exchangeRefreshForAccess(actualRefresh);
  return createUserSheetWithToken(accessToken, name);
}

// Append a row to a NAMED tab of a spreadsheet (vs the default תנועות
// tab). Used by the group ledger to write into "הוצאות קבוצה" — and
// auto-creates the tab on first write if the user's template predated it.
export async function appendRowToTab({ refreshTokenEnvelope, refreshToken, userSub, spreadsheetId, tabName, row }) {
  if (!spreadsheetId) return { ok: false, error: 'no_spreadsheet_id' };
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) {
    try { actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub); }
    catch (e) { return { ok: false, error: 'refresh_decrypt_failed', detail: e.message }; }
  }
  if (!actualRefresh) return { ok: false, error: 'no_refresh_token' };
  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(actualRefresh); }
  catch (e) { return { ok: false, error: 'token_refresh_failed', detail: e.message }; }

  const range = encodeURIComponent(`'${tabName}'!A:Z`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const opts = (tok) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  let resp;
  try { resp = await fetch(url, opts(accessToken)); }
  catch (e) { return { ok: false, error: 'sheets_unreachable', detail: e.message }; }

  // If the tab doesn't exist yet, Sheets returns 400. Auto-provision it
  // and retry once — covers users whose template was created before the
  // group tab was added.
  if (resp.status === 400) {
    const errBody = await resp.text().catch(() => '');
    if (/Unable to parse range|not found/i.test(errBody)) {
      try {
        const addTabRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
          }
        );
        if (addTabRes.ok) resp = await fetch(url, opts(accessToken));
      } catch (e) { /* fall through to error */ }
    }
  }
  if (resp.status === 401) {
    try {
      accessToken = await exchangeRefreshForAccess(actualRefresh);
      resp = await fetch(url, opts(accessToken));
    } catch (e) { return { ok: false, error: 'token_refresh_retry_failed', detail: e.message }; }
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }
  return { ok: true };
}

export { GROUP_LEDGER_TAB };

// Formula-injection sanitiser. If a Hebrew text payload starts with
// =, +, -, @ or a tab character Sheets will interpret it as a formula
// under valueInputOption=USER_ENTERED. We use RAW + this guard so even
// if someone flips the input option later, the sanitisation still holds.
export function sanitizeCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  if (s.length === 0) return '';
  // Strip zero-width + bidi override chars that can hide injected formulas
  const cleaned = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  const firstNonSpace = cleaned.trimStart()[0];
  if (firstNonSpace === '=' || firstNonSpace === '+' || firstNonSpace === '-' || firstNonSpace === '@' || firstNonSpace === '\t') {
    return "'" + cleaned;
  }
  return cleaned;
}

// Build the 9-column row we write into a tenant's תנועות tab. Keep this
// in lock-step with what the dashboard formulas in the template sheet
// expect — A:I columns.
export function buildExpenseRow({ amount, currency, isIncome, category, subcategory, rawText, messageId, date }) {
  return [
    // `date` lets callers backfill a historical row (e.g. recurring catch-up
    // for a mid-month signup); defaults to now for normal live writes.
    date ? new Date(date).toISOString() : new Date().toISOString(),
    typeof amount === 'number' ? amount : 0,
    sanitizeCell(currency || 'ILS'),
    sanitizeCell(isIncome ? 'income' : 'expense'),
    sanitizeCell(category || 'אחר'),
    sanitizeCell(subcategory || ''),
    sanitizeCell(rawText),
    'whatsapp',
    sanitizeCell(messageId || ''),
  ];
}

// Exchanges a stored refresh token for a fresh 1-hour access token.
// Throws on any non-success — callers should catch and degrade.
export async function exchangeRefreshForAccess(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error('google_client_id_missing');
  if (!clientSecret) throw new Error('google_client_secret_missing');
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
  if (!r.ok || !j.access_token) {
    throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  }
  return j.access_token;
}

// Append `row` (an array of 9 cells) to the תנועות tab of the user's
// spreadsheet. Handles a 401 retry once with a freshly minted access
// token. Returns { ok, rowIndex } or { ok:false, error }.
export async function appendRowToUserSheet({ userRecord, row }) {
  if (!userRecord?.spreadsheetId) {
    return { ok: false, error: 'no_spreadsheet_id_in_user_record' };
  }

  let refreshToken = null;
  if (userRecord.refreshTokenEnvelope) {
    try {
      refreshToken = decryptRefreshToken(userRecord.refreshTokenEnvelope, userRecord.userSub);
    } catch (e) {
      return { ok: false, error: 'refresh_token_decrypt_failed', detail: e.message };
    }
  } else if (userRecord.refreshToken) {
    refreshToken = userRecord.refreshToken; // legacy unencrypted
  } else {
    return { ok: false, error: 'no_refresh_token_relink_needed' };
  }

  let accessToken;
  try {
    accessToken = await exchangeRefreshForAccess(refreshToken);
  } catch (e) {
    return { ok: false, error: 'token_refresh_failed', detail: e.message };
  }

  const range = encodeURIComponent(`'${SHEETS_TX_TAB}'!A:I`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const fetchOpts = (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  let resp;
  try { resp = await fetch(url, fetchOpts(accessToken)); }
  catch (e) { return { ok: false, error: 'sheets_api_unreachable', detail: e.message }; }

  // Self-heal: if the תנועות tab is missing (400), create it + the header row
  // and retry once. Covers freshly-created sheets and any edge where the tab
  // was renamed/removed — a write should never be lost over a missing tab.
  if (resp.status === 400) {
    const errBody = await resp.text().catch(() => '');
    if (/Unable to parse range|not found|not exist/i.test(errBody)) {
      try {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SHEETS_TX_TAB } } }] }),
        });
        // Seed the header row so the summary SUMIFs line up.
        const hdrRange = encodeURIComponent(`'${SHEETS_TX_TAB}'!A1`);
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${hdrRange}?valueInputOption=RAW`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [TENANT_TX_HEADERS] }),
        });
        resp = await fetch(url, fetchOpts(accessToken));
      } catch (e) { /* fall through to error reporting */ }
    }
  }

  if (resp.status === 401) {
    try {
      accessToken = await exchangeRefreshForAccess(refreshToken);
      resp = await fetch(url, fetchOpts(accessToken));
    } catch (e) {
      return { ok: false, error: 'token_refresh_retry_failed', detail: e.message };
    }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }

  const j = await resp.json().catch(() => ({}));
  return { ok: true, rowIndex: j?.updates?.updatedRange || null };
}
