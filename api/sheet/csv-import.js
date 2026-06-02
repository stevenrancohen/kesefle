// api/sheet/csv-import.js
//
// Bulk-import existing expense/income history from CSV. Built for users
// who already have data in a spreadsheet, bank export, or a previous
// finance app and want to migrate to Kesefle without re-typing the
// last 6/12/24 months by hand.
//
// Steven's sprint spec 2026-05-26:
//   "Allow user to upload Excel/CSV/Google Sheet export. Parse columns
//    intelligently. Detect date, amount, description, category.
//    Normalize categories. Add imported rows to the official Kesefle
//    sheet. Avoid duplicates. Show import summary. Ask user to confirm
//    before final import. Support Hebrew column names."
//
// POST /api/sheet/csv-import
// Headers:  x-kesefle-bot-secret: <secret>
// Body:     { phone, csv, mode: "preview"|"commit", dateFormat: "DMY"|"MDY"|"YMD"|"auto" }
//
// Returns preview: { detected, sampleRows, totalRowsParsed, validRecords, errors }
// Returns commit:  { imported, skippedDuplicates, errors, sheetUrl }
//
// Safety rails:
//   - 5000 row hard limit + 5MB payload limit
//   - Rate limit: 3 imports / 24h per phone (this is a migration, not routine)
//   - Tenant isolation: phone → user:{sub} → sheet:{userSub}; NEVER owner sheet
//   - Dedup against existing תנועות rows by (date + amount + description)
//   - Preview mode by default; write only when mode:"commit" + user confirms

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess, TX_TAB, sanitizeCell } from '../../lib/sheet-writer.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;
const MAX_ROWS = 5000;

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

// ─── RFC4180-lite CSV parser ────────────────────────────────────────
// Hand-rolled because we want zero deps + we control the edge cases.
// Handles: quoted fields, embedded commas/newlines in quotes, "" → "
// escape, CR/LF tolerance, BOM stripping.
function parseCsv(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

// ─── Column detection heuristics ────────────────────────────────────
const DATE_PATTERNS = [
  /^date$/i, /^transaction\s*date$/i, /^posted$/i, /^value\s*date$/i,
  /^תאריך$/, /^תאריך\s*עסקה$/, /^תאריך\s*חיוב$/, /^יום$/,
];
const AMOUNT_PATTERNS = [
  /^amount$/i, /^sum$/i, /^value$/i, /^debit$/i, /^credit$/i, /^total$/i, /^charge$/i,
  /^סכום$/, /^סכום\s*חיוב$/, /^חיוב$/, /^זכות$/, /^חובה$/, /^סך/, /^עלות$/, /^מחיר$/,
];
const DESC_PATTERNS = [
  /^description$/i, /^details$/i, /^narration$/i, /^memo$/i, /^merchant$/i, /^payee$/i, /^name$/i,
  /^תיאור$/, /^פרטים$/, /^בית\s*עסק$/, /^שם\s*עסק$/, /^הערות$/, /^שם$/, /^עסק$/,
];
const CATEGORY_PATTERNS = [
  /^category$/i, /^cat$/i, /^type$/i, /^class$/i, /^tag$/i,
  /^קטגוריה$/, /^סוג$/, /^תת.?קטגוריה$/, /^תווית$/, /^נושא$/,
];

function scoreHeader(headerCell, patterns) {
  const s = String(headerCell || '').trim();
  if (!s) return 0;
  for (const re of patterns) {
    if (re.test(s)) return 10;
  }
  return 0;
}

// Auto-detect which row is the header (some exports have a title row first).
function detectHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r] || [];
    let matches = 0;
    for (const cell of row) {
      if (scoreHeader(cell, DATE_PATTERNS) > 0) { matches++; continue; }
      if (scoreHeader(cell, AMOUNT_PATTERNS) > 0) { matches++; continue; }
      if (scoreHeader(cell, DESC_PATTERNS) > 0) { matches++; continue; }
      if (scoreHeader(cell, CATEGORY_PATTERNS) > 0) { matches++; continue; }
    }
    if (matches >= 2) return r;
  }
  return 0;
}

function detectColumns(headerRow) {
  const cols = { dateCol: -1, amountCol: -1, descCol: -1, categoryCol: -1 };
  const used = new Set();
  function pickBest(patterns, key) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < headerRow.length; i++) {
      if (used.has(i)) continue;
      const s = scoreHeader(headerRow[i], patterns);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) { cols[key] = best; used.add(best); }
  }
  pickBest(DATE_PATTERNS, 'dateCol');
  pickBest(AMOUNT_PATTERNS, 'amountCol');
  pickBest(DESC_PATTERNS, 'descCol');
  pickBest(CATEGORY_PATTERNS, 'categoryCol');
  return cols;
}

// ─── Value parsing ──────────────────────────────────────────────────

function parseDate(raw, hint) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), monthKey: y + '-' + String(mo).padStart(2, '0') };
    }
  }
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let d = +m[1], mo = +m[2], y = +m[3];
    if (hint === 'MDY') { const t = d; d = mo; mo = t; }
    if (y < 100) y += y < 50 ? 2000 : 1900;
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), monthKey: y + '-' + String(mo).padStart(2, '0') };
    }
  }
  return null;
}

function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  s = s.replace(/[₪$€£¥]/g, '').replace(/[,\s]/g, '').trim();
  let negFromParens = false;
  if (/^\(.*\)$/.test(s)) { negFromParens = true; s = s.slice(1, -1); }
  const n = Number(s);
  if (!isFinite(n)) return NaN;
  return negFromParens ? -n : n;
}

const INCOME_RE = /משכורת|שכר|בונוס|תקבול|הכנסה|salary|paycheck|income|payment\s+received|refund|החזר/i;
function detectIsIncome(amount, description) {
  if (amount > 0 && INCOME_RE.test(description || '')) return true;
  return false;
}

// ─── Main handler ───────────────────────────────────────────────────

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

  const csvText = String(body.csv || '');
  if (!csvText.trim()) return res.status(400).json({ ok: false, error: 'missing_csv' });
  if (csvText.length > 5 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: 'csv_too_large_5mb_limit' });
  }

  const mode = body.dryRun || body.mode === 'preview' || !body.mode ? 'preview' : 'commit';
  const dateHint = ['DMY', 'MDY', 'YMD', 'auto'].includes(body.dateFormat) ? body.dateFormat : 'auto';

  const rows = parseCsv(csvText);
  if (rows.length === 0) return res.status(400).json({ ok: false, error: 'empty_csv' });
  if (rows.length > MAX_ROWS + 50) {
    return res.status(413).json({ ok: false, error: 'csv_too_many_rows', limit: MAX_ROWS });
  }

  const headerIdx = detectHeader(rows);
  const headers = rows[headerIdx] || [];
  const cols = detectColumns(headers);

  if (cols.dateCol < 0 || cols.amountCol < 0) {
    return res.status(400).json({
      ok: false,
      error: 'could_not_detect_columns',
      detected: cols,
      headers,
      hint: 'CSV must have a date column (תאריך / date) and an amount column (סכום / amount). Other columns optional.',
    });
  }

  const records = [];
  const errors = [];
  for (let i = headerIdx + 1; i < rows.length && records.length < MAX_ROWS; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    if (row.every(c => !String(c || '').trim())) continue;

    const dateRaw = row[cols.dateCol];
    const amountRaw = row[cols.amountCol];
    const date = parseDate(dateRaw, dateHint);
    const amount = parseAmount(amountRaw);
    const description = String((cols.descCol >= 0 ? row[cols.descCol] : '') || '').trim();
    const category = String((cols.categoryCol >= 0 ? row[cols.categoryCol] : '') || '').trim();

    if (!date) { errors.push({ row: i + 1, why: 'bad_date', raw: dateRaw }); continue; }
    if (!isFinite(amount) || amount === 0) { errors.push({ row: i + 1, why: 'bad_amount', raw: amountRaw }); continue; }

    const isIncome = detectIsIncome(amount, description);
    records.push({
      date: date.iso,
      monthKey: date.monthKey,
      amount: Math.abs(amount),
      description: description || (category || 'imported'),
      category: category || (isIncome ? 'הכנסות' : 'שונות ואחרים'),
      isIncome,
    });
  }

  if (mode === 'preview') {
    return res.status(200).json({
      ok: true,
      mode: 'preview',
      detected: { ...cols, headerRow: headerIdx, headers },
      totalRowsParsed: rows.length - headerIdx - 1,
      validRecords: records.length,
      errors: errors.slice(0, 30),
      sampleRows: records.slice(0, 10),
      note: 'Re-call with mode:"commit" to actually import. Use this preview to verify column detection looks right.',
    });
  }

  // Commit mode.
  const lim = await rateLimitId(phone, { key: 'csv_import_phone', limit: 3, windowSec: 86400 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited_3_imports_per_24h', retryAfter: lim.retryAfter });

  const phoneRec = await kvGet('phone:' + phone);
  const userSub = phoneRec?.userSub;
  if (!userSub) return res.status(404).json({ ok: false, error: 'no_user' });
  const userRec = await kvGet('user:' + userSub);
  const sheetRec = await kvGet('sheet:' + userSub);

  // PR-S2 (2026-05-27 security audit H1): tenant-isolation guard.
  // Same shape as api/sheet/append.js:124-132. Aborts BEFORE writing if the
  // phone-record's cached sheet id disagrees with canonical sheet:{userSub}.
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('csv_import.sheet_ownership_mismatch', {
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

  // Dedup against existing rows (date + amount + description tuple).
  const existingTuples = new Set();
  try {
    const range = encodeURIComponent(`'${TX_TAB}'!A2:F5000`);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const j = await r.json();
      const sheetRows = j.values || [];
      for (const row of sheetRows) {
        const tuple = String(row[0] || '') + '|' + String(row[2] || '') + '|' + String(row[5] || '').trim().toLowerCase();
        existingTuples.add(tuple);
      }
    }
  } catch (_e) {
    // Non-fatal — if we can't read, dedup is permissive (all imports go through).
  }

  const toWrite = [];
  const skipped = [];
  for (const rec of records) {
    const tuple = rec.date + '|' + rec.amount + '|' + String(rec.description || '').trim().toLowerCase();
    if (existingTuples.has(tuple)) { skipped.push(rec); continue; }
    toWrite.push([
      sanitizeCell(rec.date),
      sanitizeCell(rec.monthKey),
      rec.amount,
      sanitizeCell(rec.category),
      sanitizeCell(rec.isIncome ? 'הכנסות' : ''),
      sanitizeCell(rec.description),
    ]);
  }

  if (toWrite.length === 0) {
    return res.status(200).json({
      ok: true,
      mode: 'commit',
      imported: 0,
      skippedDuplicates: skipped.length,
      note: 'All rows already exist in your sheet — nothing to import.',
    });
  }

  try {
    const range = encodeURIComponent(`'${TX_TAB}'!A:F`);
    // RAW (not USER_ENTERED) — consistent with every other Kesefle writer
    // (lib/sheet-writer.js, bank-csv.js, relabel-row.js, mark-vat.js). RAW
    // stores each cell verbatim instead of re-parsing it as if a user typed
    // it, which (a) keeps sanitizeCell's formula-injection guard sound (it was
    // designed for RAW per its own doc-comment) and (b) stops Sheets from
    // mangling imported free-text into formulas/dates -- e.g. a description
    // "3/4" becoming a date, or "01" losing its leading zero. Amounts are
    // written as JS numbers either way, so totals are unaffected.
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: toWrite }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'sheet_append_failed', status: r.status, detail: detail.slice(0, 200) });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_append_threw', detail: e.message });
  }

  log.info('csv_import.commit_ok', {
    reqId: req.reqId, userSub, phone, imported: toWrite.length, skipped: skipped.length, errors: errors.length,
  });

  return res.status(200).json({
    ok: true,
    mode: 'commit',
    imported: toWrite.length,
    skippedDuplicates: skipped.length,
    errors: errors.slice(0, 30),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
  });
}

export default withRequestId(
  withRateLimit({ key: 'csv_import', limit: 10, windowSec: 60 })(handlerImpl)
);
