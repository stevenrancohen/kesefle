// lib/bank-parsers.js
//
// Pure-JS parsers for Israeli bank statement CSV exports (Hapoalim, Leumi).
// Returns a normalized array of transactions plus a `skipped` array for rows
// that could not be parsed.
//
// Design notes:
//   - Both parsers are HEADER-DRIVEN: we scan for the header row (a row
//     containing at least one date column + one amount column from a known
//     Hebrew alias set), then map each subsequent row's cells by that header.
//     This makes the parser robust to small format drifts between exports
//     (Bank Hapoalim alone has shipped at least three header variants over the
//     last few years). If a column in the header is not in the alias map we
//     log a warning and ignore that column -- no row is rejected for unknown
//     extra columns.
//   - Encoding: Israeli banks export CSV in either windows-1255 (older
//     desktop exports) or UTF-8 with BOM (newer web exports). The public
//     entry points accept either a string OR a Buffer; for Buffer input we
//     sniff: BOM -> UTF-8, else try UTF-8 and if it contains the U+FFFD
//     replacement char we fall back to windows-1255.
//   - Direction marks: RTL bank statement exports often have isolated bidi
//     marks (‎ / ‏ / ‪-‮) sprinkled around numbers and
//     headers; we strip them globally before tokenizing.
//   - Date formats: DD/MM/YYYY (most common), DD.MM.YYYY (Leumi PDF export
//     to CSV), DD-MM-YYYY (rare), and YYYY-MM-DD (already ISO, accepted).
//     Two-digit years are taken as 20YY when <70, 19YY otherwise.
//   - Amount sign convention:
//       Hapoalim:  separate חיוב (debit) and זיכוי (credit) columns.
//                  Both are positive numbers; we set isIncome=true for credit.
//       Leumi:     single signed amount column (negative = debit, positive =
//                  credit) OR a "סכום" column plus a "סוג פעולה" indicator.
//                  We support both.
//   - Decimal: Israeli locale uses dot decimal, but Excel exports sometimes
//     produce comma. We accept both. Thousand separators (comma or space)
//     are stripped.
//   - Privacy: this module NEVER logs descriptions or amounts -- only row
//     counts. Callers (e.g. /api/import/bank-csv.js) MUST follow the same
//     rule.
//
// Public API:
//   parseHapoalimCsv(text|buffer) -> { rows: TxRow[], skipped: SkipRow[] }
//   parseLeumiCsv(text|buffer)    -> { rows: TxRow[], skipped: SkipRow[] }
//   BANK_PARSERS = { hapoalim: parseHapoalimCsv, leumi: parseLeumiCsv }
//
// TxRow shape:
//   {
//     date: 'YYYY-MM-DD',
//     amount: number,         // always positive
//     description: string,    // cleaned, no bidi marks
//     isIncome: boolean,
//     rawRow: string,         // the original CSV line (capped at 500 chars)
//   }
//
// SkipRow shape:
//   { rowNumber: number, reason: string }  -- rowNumber is 1-based across the
//   raw file (header row included), so callers can show "row 17" to the user.

// ---------------------------------------------------------------------------
// 0. Constants -- header column aliases (Hebrew names that appear in real
//    bank exports). Lowercased before lookup.
// ---------------------------------------------------------------------------

// Date columns. "תאריך ערך" (value date) is preferred over "תאריך" (entry
// date) when both are present -- value date is what the user thinks of as
// "when the money moved" and matches the bank's own dashboard.
const DATE_ALIASES = ['תאריך ערך', 'תאריך הערך', 'ערך', 'תאריך'];
const PREFERRED_DATE_ALIAS = ['תאריך ערך', 'תאריך הערך', 'ערך']; // fall back to 'תאריך'

// Description / narration column.
const DESC_ALIASES = ['פרטים', 'תיאור', 'תיאור הפעולה', 'הסבר', 'שם פעולה'];

// Hapoalim-style two-column scheme.
const DEBIT_ALIASES = ['חובה', 'בחובה', 'חיוב', 'סכום חיוב', 'סכום בחובה'];
const CREDIT_ALIASES = ['זכות', 'בזכות', 'זיכוי', 'סכום זיכוי', 'סכום בזכות'];

// Leumi-style single-amount scheme. We also accept "סכום בש"ח".
const AMOUNT_ALIASES = ['סכום', 'סכום העסקה', 'סכום בש"ח', 'סכום בשח', 'סכום הפעולה'];

// Optional sign / type indicator (used by Leumi when the amount column is
// always positive).
const TYPE_ALIASES = ['סוג פעולה', 'סוג', 'חיוב/זיכוי', 'חובה/זכות'];

// Optional reference / asmachta -- not used in dedup hash but useful for raw.
const REF_ALIASES = ['אסמכתא', 'מספר אסמכתא', 'אסמכתה'];

// ---------------------------------------------------------------------------
// 1. Encoding + line normalization
// ---------------------------------------------------------------------------

function decodeIfBuffer(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input.byteLength !== 'number') return String(input || '');
  // BOM sniff -> UTF-8.
  const u0 = input[0], u1 = input[1], u2 = input[2];
  if (u0 === 0xEF && u1 === 0xBB && u2 === 0xBF) {
    try { return new TextDecoder('utf-8').decode(input.subarray(3)); } catch { /* fall through */ }
  }
  // Try UTF-8 first; if it produces replacement chars treat as windows-1255.
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(input);
    if (!utf8.includes('�')) return utf8;
  } catch { /* fall through */ }
  try {
    return new TextDecoder('windows-1255').decode(input);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(input);
  }
}

// Strip BOM, normalize newlines, strip bidi / zero-width marks. We keep
// digits and Hebrew letters as-is; only the formatting / direction marks go.
const BIDI_RE = /[​‌‍‎‏‪-‮⁦-⁩﻿]/g;
function normalizeText(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(BIDI_RE, '');
  return s;
}

// ---------------------------------------------------------------------------
// 2. CSV row splitter (handles quoted fields, embedded commas, "" -> ")
// ---------------------------------------------------------------------------

function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Detect the most likely separator by counting on the first non-empty line.
// Hapoalim/Leumi exports are almost always comma but a few tools produce
// semicolon (when the user's Windows locale uses comma as decimal).
function detectSeparator(text) {
  const firstLines = text.split('\n').filter(l => l.trim()).slice(0, 5);
  let commas = 0, semis = 0, tabs = 0;
  for (const l of firstLines) {
    commas += (l.match(/,/g) || []).length;
    semis  += (l.match(/;/g) || []).length;
    tabs   += (l.match(/\t/g) || []).length;
  }
  if (semis > commas && semis > tabs) return ';';
  if (tabs  > commas && tabs  > semis) return '\t';
  return ',';
}

// ---------------------------------------------------------------------------
// 3. Header detection
// ---------------------------------------------------------------------------

function lc(s) { return String(s || '').toLowerCase().trim(); }

// Returns the index of the header row in `rows` (array of cell arrays), or
// -1 if none found within the first 20 rows. A header row is one that
// contains at least one date alias AND (an amount alias OR a debit alias).
function findHeaderRow(rows) {
  const lim = Math.min(rows.length, 20);
  for (let i = 0; i < lim; i++) {
    const cells = rows[i].map(lc);
    const hasDate = cells.some(c => DATE_ALIASES.some(a => c === a || c.includes(a)));
    const hasAmt  = cells.some(c => AMOUNT_ALIASES.some(a => c === a || c.includes(a)))
                 || cells.some(c => DEBIT_ALIASES.some(a => c === a || c.includes(a)))
                 || cells.some(c => CREDIT_ALIASES.some(a => c === a || c.includes(a)));
    if (hasDate && hasAmt) return i;
  }
  return -1;
}

// Build a column-index lookup. If a column in the header doesn't match any
// alias we ignore it (the per-bank parser only reads columns it knows).
// `warnings` is an out-array for unknown header names (used by tests).
function buildHeaderMap(header, warnings) {
  const map = {
    dateIdx: -1,
    descIdx: -1,
    debitIdx: -1,
    creditIdx: -1,
    amountIdx: -1,
    typeIdx: -1,
    refIdx: -1,
  };
  // Prefer "תאריך ערך" over "תאריך" when both exist.
  let bestDateRank = -1;
  for (let i = 0; i < header.length; i++) {
    const h = lc(header[i]);
    if (!h) continue;
    let matched = false;
    // Date (with preference ranking).
    for (const a of DATE_ALIASES) {
      if (h === a || h.includes(a)) {
        const rank = PREFERRED_DATE_ALIAS.indexOf(a) >= 0 ? 2 : 1;
        if (rank > bestDateRank) { map.dateIdx = i; bestDateRank = rank; }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (DESC_ALIASES.some(a => h === a || h.includes(a))) { map.descIdx = i; matched = true; }
    else if (DEBIT_ALIASES.some(a => h === a || h.includes(a))) { map.debitIdx = i; matched = true; }
    else if (CREDIT_ALIASES.some(a => h === a || h.includes(a))) { map.creditIdx = i; matched = true; }
    else if (AMOUNT_ALIASES.some(a => h === a || h.includes(a))) { map.amountIdx = i; matched = true; }
    else if (TYPE_ALIASES.some(a => h === a || h.includes(a))) { map.typeIdx = i; matched = true; }
    else if (REF_ALIASES.some(a => h === a || h.includes(a))) { map.refIdx = i; matched = true; }
    if (!matched && warnings) warnings.push('unknown_header_column: ' + h);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 4. Date + amount parsing
// ---------------------------------------------------------------------------

// Returns 'YYYY-MM-DD' or null. Accepts DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY,
// YYYY-MM-DD, DD/MM/YY.
function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  // ISO -- YYYY-MM-DD or YYYY/MM/DD.
  const iso = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (validYMD(y, m, d)) return fmt(y, m, d);
  }
  // DD[./-]MM[./-]YYYY or DD[./-]MM[./-]YY.
  const dmy = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dmy) {
    const d = +dmy[1], m = +dmy[2];
    let y = +dmy[3];
    if (y < 100) y = y < 70 ? 2000 + y : 1900 + y;
    if (validYMD(y, m, d)) return fmt(y, m, d);
  }
  return null;
}

function validYMD(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (y < 1970 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Day-in-month bound check (cheap; avoids 2026-02-31).
  const dim = new Date(y, m, 0).getDate();
  return d <= dim;
}

function fmt(y, m, d) {
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Accepts "1,234.56", "1.234,56" (rare), "1234,56", "1234.56", " 12.5 ".
// Returns Number (positive or negative) or NaN.
function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  // Strip currency symbols and parentheses (some exports wrap negatives).
  let negParens = false;
  if (/^\(.*\)$/.test(s)) { negParens = true; s = s.slice(1, -1); }
  s = s.replace(/[₪₪$€£]/g, '');
  s = s.replace(/\s+/g, '');
  // Decide which separator is the decimal: if both '.' and ',' appear, the
  // RIGHTMOST one is the decimal. Strip the other as a thousands separator.
  const lastDot = s.lastIndexOf('.');
  const lastCom = s.lastIndexOf(',');
  if (lastDot >= 0 && lastCom >= 0) {
    if (lastDot > lastCom) s = s.replace(/,/g, '');
    else { s = s.replace(/\./g, '').replace(',', '.'); }
  } else if (lastCom >= 0 && lastDot < 0) {
    // Single comma -- treat as decimal if it's near the end (e.g. "1234,56"),
    // else as thousands ("1,234").
    const tail = s.length - 1 - lastCom;
    if (tail <= 2) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }
  // Now s should be a plain number (possibly with leading minus).
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return negParens ? -n : n;
}

function isIncomeFromType(s) {
  if (!s) return null;
  const t = lc(s);
  if (/זיכוי|זכות|הפקדה|העברה נכנסת|נכנס/.test(t)) return true;
  if (/חיוב|חובה|משיכה|תשלום|יוצא/.test(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// 5. Core parser used by both bank entry points (differ only by which column
//    scheme they prefer if BOTH amount + debit/credit columns exist).
// ---------------------------------------------------------------------------

function parseCsvWithScheme(input, scheme /* 'hapoalim' | 'leumi' */) {
  const text = normalizeText(decodeIfBuffer(input));
  if (!text.trim()) return { rows: [], skipped: [], warnings: ['empty_input'] };

  const sep = detectSeparator(text);
  const lines = text.split('\n');
  const allCells = lines.map(l => splitCsvLine(l, sep));

  const headerIdx = findHeaderRow(allCells);
  if (headerIdx < 0) {
    return { rows: [], skipped: [{ rowNumber: 1, reason: 'header_not_found' }], warnings: [] };
  }
  const warnings = [];
  const header = allCells[headerIdx];
  const map = buildHeaderMap(header, warnings);

  if (map.dateIdx < 0) {
    return { rows: [], skipped: [{ rowNumber: headerIdx + 1, reason: 'no_date_column' }], warnings };
  }

  const out = [];
  const skipped = [];

  for (let i = headerIdx + 1; i < allCells.length; i++) {
    const cells = allCells[i];
    const rowNo = i + 1; // 1-based with header counted
    // Skip empty / fully-whitespace rows.
    if (!cells || cells.every(c => !c || !c.trim())) continue;

    const rawDate = cells[map.dateIdx];
    const date = parseDate(rawDate);
    if (!date) {
      // Trailing summary rows like "סה"כ" or "יתרה" land here -- they have a
      // running balance but no real date. We silently skip them only if the
      // row LOOKS like a summary; otherwise it's a real parse failure.
      const isSummary = cells.some(c => /^(יתרה|סה[״\\"]כ|סך הכל|סיכום)/.test(String(c).trim()));
      if (!isSummary) skipped.push({ rowNumber: rowNo, reason: 'invalid_date: ' + (rawDate || '<empty>').slice(0, 32) });
      continue;
    }

    // Description -- best-effort. If missing column, fall back to joining all
    // non-amount, non-date cells so we still capture SOMETHING for matching.
    let description = '';
    if (map.descIdx >= 0) description = String(cells[map.descIdx] || '').trim();
    if (!description) {
      const skipIdx = new Set([map.dateIdx, map.debitIdx, map.creditIdx, map.amountIdx, map.typeIdx, map.refIdx].filter(x => x >= 0));
      description = cells.filter((_, idx) => !skipIdx.has(idx))
        .map(c => String(c || '').trim()).filter(Boolean).join(' ').slice(0, 200);
    }
    description = description.replace(/\s+/g, ' ').trim();

    // Amount + direction. Order of resolution:
    //   1. Debit/credit two-column (Hapoalim's canonical scheme).
    //   2. Single amount column with explicit sign.
    //   3. Single amount column + type indicator.
    let amount = NaN;
    let isIncome = false;

    const debitRaw = map.debitIdx  >= 0 ? cells[map.debitIdx]  : '';
    const creditRaw = map.creditIdx >= 0 ? cells[map.creditIdx] : '';
    const debitVal = parseAmount(debitRaw);
    const creditVal = parseAmount(creditRaw);

    if (Number.isFinite(creditVal) && creditVal > 0 && !(Number.isFinite(debitVal) && debitVal > 0)) {
      amount = Math.abs(creditVal);
      isIncome = true;
    } else if (Number.isFinite(debitVal) && debitVal > 0) {
      amount = Math.abs(debitVal);
      isIncome = false;
    } else if (map.amountIdx >= 0) {
      const a = parseAmount(cells[map.amountIdx]);
      if (Number.isFinite(a) && a !== 0) {
        amount = Math.abs(a);
        if (a < 0) isIncome = false;
        else if (a > 0) {
          // Need to disambiguate sign-via-magnitude vs always-positive.
          // For Leumi the amount column is signed -> a>0 means income.
          // For Hapoalim if we ever land here (single-column variant),
          // assume expense unless a type column says otherwise.
          isIncome = scheme === 'leumi';
        }
        const typed = map.typeIdx >= 0 ? isIncomeFromType(cells[map.typeIdx]) : null;
        if (typed != null) isIncome = typed;
      }
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      skipped.push({ rowNumber: rowNo, reason: 'invalid_amount' });
      continue;
    }
    if (!description) {
      skipped.push({ rowNumber: rowNo, reason: 'missing_description' });
      continue;
    }

    const rawLine = (lines[i] || '').slice(0, 500);
    out.push({ date, amount, description, isIncome, rawRow: rawLine });
  }

  return { rows: out, skipped, warnings };
}

// ---------------------------------------------------------------------------
// 6. Public entry points
// ---------------------------------------------------------------------------

export function parseHapoalimCsv(input) {
  return parseCsvWithScheme(input, 'hapoalim');
}

export function parseLeumiCsv(input) {
  return parseCsvWithScheme(input, 'leumi');
}

// Test-only helpers (named exports are tree-shaken away in prod).
export const __test = {
  parseDate, parseAmount, splitCsvLine, normalizeText, decodeIfBuffer,
  detectSeparator, findHeaderRow, buildHeaderMap,
};

export const BANK_PARSERS = {
  hapoalim: parseHapoalimCsv,
  leumi: parseLeumiCsv,
};
