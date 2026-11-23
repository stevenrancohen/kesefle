// /api/import/bank-csv
//
// POST endpoint: previews or imports an Israeli bank statement CSV (Hapoalim,
// Leumi, Discount or Mizrahi-Tefahot)
// into the authenticated user's Kesefle sheet (the תנועות tab).
//
// Body:
//   {
//     bank:    'hapoalim' | 'leumi' | 'discount' | 'mizrahi',
//     csvBase64: string, -- raw CSV bytes, decoded size up to 2 MB
//     csvText?: string,  -- legacy UTF-8 compatibility path
//     dryRun:  boolean  -- true parses/classifies/dedupes without any write
//   }
//
// Auth: requireAuth (session cookie or Bearer ID token).
// Rate limit: 20 previews or 5 imports per hour per userSub (separate buckets).
//
// Flow:
//   1. Parse CSV with the bank-specific header-driven parser.
//   2. For every parsed row compute a stable dedup hash (sha256 of
//      date|amount|description after a strict normalization) and check it
//      against the user's import:hashes:{userSub} set (400-day sliding TTL).
//   3. For unseen rows: classify category via lib/categories.js
//      findGroupForSubcategory + a tiny in-module keyword map (mirrors what
//      the bot does -- we do NOT import the bot file).
//   4. Build the 9-column row with buildExpenseRow and append to תנועות
//      via the same Sheets API path the WhatsApp flow uses. To avoid N HTTP
//      calls we issue ONE values:append request with all rows; the existing
//      appendRowToUserSheet is row-by-row, so we use the lower-level Sheets
//      API directly here (matching the same auth + retry semantics).
//   5. Record the new hashes via Upstash SADD, set the set's TTL on first
//      write of a window.
//
// Returns a classified preview (up to 10 sample rows), or the final import
// count. A preview never resolves the user's Google token and never writes.
//
// Privacy: this handler logs ONLY userSub, bank, rowCount. Descriptions
// and amounts NEVER hit the log line. Required by the task spec and by
// our PII rules (lib/log.js redacts known keys but we don't even pass them).

import { withRequestId, log } from '../../lib/log.js';
import { requireAuth } from '../../lib/auth.js';
import { rateLimitId } from '../../lib/ratelimit.js';
import { BANK_PARSERS } from '../../lib/bank-parsers.js';
import {
  buildExpenseRow, exchangeRefreshForAccess,
} from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';
import { findGroupForSubcategory, isIncomeGroup } from '../../lib/categories.js';
import { recordExpenseActivity } from '../../lib/user-activity.js';
import crypto from 'node:crypto';

// Keep in sync with lib/sheet-writer.js TX_HEADERS -- col I "ניכוי מע״מ"
// added 2026-05-24. Bank-imported rows default to vatDeductible=false
// (the user can flip individual rows from the bot or sheet UI).
const TX_HEADERS = ['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'סטטוס', 'ניכוי מע״מ'];

// Vercel default body limit is 1 MB; bank exports for one month are usually
// well under that, but a full-year export can push past it. 2 MB headroom.
// Base64 adds ~33% over the decoded 2 MB file limit.
export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

const HASH_SET_TTL_SEC = 400 * 24 * 3600; // covers annual-statement reimports
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_PARSED_ROWS = 5000;
const PREVIEW_TTL_SEC = 10 * 60;
const COMMIT_PENDING_TTL_SEC = 24 * 3600;
const COMMIT_DONE_TTL_SEC = 400 * 24 * 3600;

// ---------------------------------------------------------------------------
// KV helpers (mirrored from api/recurring.js -- no shared module yet)
// ---------------------------------------------------------------------------
function kvCfg() {
  return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
}

async function kvGet(key) {
  const { url, token } = kvCfg();
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}

async function kvGetStrict(key) {
  const { url, token } = kvCfg();
  if (!url || !token) return { ok: false };
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    if (j?.result == null) return { ok: true, value: null };
    try { return { ok: true, value: JSON.parse(j.result) }; }
    catch { return { ok: false }; }
  } catch { return { ok: false }; }
}

async function kvSetJsonTTL(key, value, ttlSec) {
  const { url, token } = kvCfg();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}?ex=${ttlSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

async function kvDelete(key) {
  const { url, token } = kvCfg();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch { return false; }
}

// Pipelined sadd of many members. Upstash REST supports a single sadd call
// with multiple positional args; we batch in chunks of 50 to stay under URL
// length limits.
async function kvSaddMany(key, members) {
  const { url, token } = kvCfg();
  if (!url || !token) return { ok: false, kvOutage: true };
  if (!members.length) return { ok: true };
  const CHUNK = 50;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    const path = ['sadd', encodeURIComponent(key)]
      .concat(slice.map(encodeURIComponent)).join('/');
    try {
      const r = await fetch(`${url}/${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { ok: false };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: true };
}

// Test membership in bulk. Upstash REST sismember takes one member per call;
// we use the SMISMEMBER multi-arg form which returns an array of 0/1.
async function kvSmismember(key, members) {
  const { url, token } = kvCfg();
  if (!url || !token) return { ok: false, kvOutage: true };
  if (!members.length) return { ok: true, present: [] };
  const present = new Array(members.length).fill(false);
  const CHUNK = 50;
  for (let i = 0; i < members.length; i += CHUNK) {
    const slice = members.slice(i, i + CHUNK);
    const path = ['smismember', encodeURIComponent(key)]
      .concat(slice.map(encodeURIComponent)).join('/');
    try {
      const r = await fetch(`${url}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { ok: false };
      const j = await r.json();
      const result = Array.isArray(j?.result) ? j.result : [];
      if (result.length !== slice.length) return { ok: false };
      for (let k = 0; k < slice.length; k++) {
        if (result[k] === 1 || result[k] === '1' || result[k] === true) {
          present[i + k] = true;
        }
      }
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: true, present };
}

async function kvExpire(key, ttlSec) {
  const { url, token } = kvCfg();
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSec}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    return r.ok;
  } catch { return false; }
}

async function kvAcquireLock(key, owner, ttlSec) {
  const { url, token } = kvCfg();
  if (!url || !token) return { ok: false };
  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}?nx=true&ex=${ttlSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(owner),
    });
    if (!r.ok) return { ok: false };
    const j = await r.json().catch(() => ({}));
    return { ok: true, acquired: j?.result === 'OK' };
  } catch { return { ok: false }; }
}

function decodeCsvBody(body) {
  if (typeof body?.csvBase64 === 'string') {
    const encoded = body.csvBase64.trim();
    if (!encoded || encoded.length > Math.ceil(MAX_CSV_BYTES / 3) * 4 + 8 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      return { ok: false, error: 'csv_base64_invalid' };
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_CSV_BYTES) return { ok: false, error: 'csv_too_large' };
    // Reject malformed encodings that Buffer.from() would otherwise decode
    // permissively. Padding differences are normalized before comparison.
    const normalize = (s) => s.replace(/=+$/, '');
    if (normalize(bytes.toString('base64')) !== normalize(encoded)) {
      return { ok: false, error: 'csv_base64_invalid' };
    }
    return { ok: true, parserInput: bytes, bytes };
  }
  // Transitional compatibility for the existing authenticated API contract.
  // New browser clients always send csvBase64 so legacy windows-1255 bytes are
  // preserved all the way to lib/bank-parsers.js.
  if (typeof body?.csvText === 'string' && body.csvText.trim()) {
    const bytes = Buffer.from(body.csvText, 'utf8');
    if (bytes.length > MAX_CSV_BYTES) return { ok: false, error: 'csv_too_large' };
    return { ok: true, parserInput: body.csvText, bytes };
  }
  return { ok: false, error: 'csv_text_required' };
}

function previewSecret() {
  const secret = process.env.SESSION_SECRET;
  return typeof secret === 'string' && secret.length >= 16 ? secret : null;
}

function mintPreviewToken({ userSub, bank, fileDigest, expiresAt }) {
  const secret = previewSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify({ v: 1, b: bank, d: fileDigest, e: expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
    .update(payload + '.' + userSub).digest('base64url');
  return payload + '.' + signature;
}

function verifyPreviewToken(token, { userSub, bank, fileDigest, nowSec }) {
  const secret = previewSecret();
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (!secret || parts.length !== 2) return { ok: false, error: 'preview_token_invalid' };
  const expected = crypto.createHmac('sha256', secret)
    .update(parts[0] + '.' + userSub).digest('base64url');
  if (!constantTimeEqual(parts[1], expected)) return { ok: false, error: 'preview_token_invalid' };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { return { ok: false, error: 'preview_token_invalid' }; }
  if (payload?.v !== 1 || payload.b !== bank || payload.d !== fileDigest) {
    return { ok: false, error: 'preview_token_mismatch' };
  }
  if (!Number.isInteger(payload.e) || payload.e < nowSec) {
    return { ok: false, error: 'preview_token_expired' };
  }
  return { ok: true, expiresAt: payload.e };
}

async function kvReleaseLock(key, owner) {
  const { url, token } = kvCfg();
  if (!url || !token) return false;
  // Compare-and-delete prevents an expired lock owner from deleting a newer
  // request's lock. A short TTL is still the crash-safety fallback.
  const script = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
  try {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['EVAL', script, '1', key, owner]]),
    });
    return r.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Dedup hash. Normalization rules MUST stay deterministic across runs --
// any drift here causes the entire history to look "new" and re-import.
//   - Date is already ISO YYYY-MM-DD from the parser.
//   - Amount is rounded to cents (integer agorot) so 12.50 == 12.5.
//   - Description is lowercased, whitespace collapsed, bidi marks already
//     stripped by the parser, and capped at 80 chars (the bank sometimes
//     pads with running balance / posting time that drifts between exports).
// ---------------------------------------------------------------------------
function rowHashV1(r) {
  const desc = String(r.description || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  const cents = Math.round(Number(r.amount) * 100);
  const key = `${r.date}|${cents}|${desc}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function rowHashV2(r, bank) {
  const desc = String(r.description || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  const reference = String(r.reference || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
  const cents = Math.round(Number(r.amount) * 100);
  const direction = r.isIncome ? 'income' : 'expense';
  const key = `v2|${bank}|${direction}|${r.date}|${cents}|${desc}|${reference}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function exactRowHash(r) {
  const raw = String(r.rawRow || '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ---------------------------------------------------------------------------
// Category classification. We re-use the bot's strategy (long-keyword-first
// substring match) but only over a small in-module table tuned for what
// shows up in BANK STATEMENT descriptions. For anything we don't recognise
// unknown rows stay visible in an existing direction-safe catch-all and are
// marked for review in the preview instead of being silently called groceries.
// ---------------------------------------------------------------------------
// Each entry: { kw: lowercase Hebrew/English keyword, sub: subcategory label
// (must exist in lib/categories.js) }. Top-level category is resolved at
// classify time via findGroupForSubcategory(sub).
const BANK_KEYWORDS = [
  // Food / groceries
  { kw: 'שופרסל', sub: 'מזון' },
  { kw: 'רמי לוי', sub: 'מזון' },
  { kw: 'יוחננוף', sub: 'מזון' },
  { kw: 'ויקטורי', sub: 'מזון' },
  { kw: 'מגה',     sub: 'מזון' },
  { kw: 'אושר עד', sub: 'מזון' },
  { kw: 'טיב טעם', sub: 'מזון' },
  { kw: 'סופר',    sub: 'מזון' },
  // Restaurants / eating out
  { kw: 'מקדונלד', sub: 'מסעדה ואוכל בחוץ' },
  { kw: 'בורגר',   sub: 'מסעדה ואוכל בחוץ' },
  { kw: 'דומינו',  sub: 'מסעדה ואוכל בחוץ' },
  { kw: 'מסעדה',   sub: 'מסעדה ואוכל בחוץ' },
  { kw: 'פיצה',    sub: 'מסעדה ואוכל בחוץ' },
  { kw: 'wolt',    sub: 'מסעדה ואוכל בחוץ' },
  { kw: '10bis',   sub: 'מסעדה ואוכל בחוץ' },
  // Transport
  { kw: 'פז',         sub: 'דלק' },
  { kw: 'דלק',        sub: 'דלק' },
  { kw: 'סונול',      sub: 'דלק' },
  { kw: 'דור אלון',   sub: 'דלק' },
  { kw: 'חניון',      sub: 'חניה' },
  { kw: 'חניה',       sub: 'חניה' },
  { kw: 'אגרה',       sub: 'כבישי אגרה' },
  { kw: 'כביש 6',     sub: 'כבישי אגרה' },
  { kw: 'רכבת ישראל', sub: 'תחבורה ציבורית' },
  { kw: 'רב קו',      sub: 'תחבורה ציבורית' },
  { kw: 'אגד',        sub: 'תחבורה ציבורית' },
  // Utilities / housing
  { kw: 'חברת חשמל', sub: 'חשמל' },
  { kw: 'חשמל',      sub: 'חשמל' },
  { kw: 'מי אביבים', sub: 'מים וביוב' },
  { kw: 'תאגיד מים', sub: 'מים וביוב' },
  { kw: 'מים',       sub: 'מים וביוב' },
  { kw: 'ועד בית',   sub: 'מיסי ישוב / ועד בית' },
  { kw: 'ארנונה',    sub: 'ארנונה' },
  { kw: 'משכנתה',    sub: 'משכנתה' },
  { kw: 'שכר דירה',  sub: 'שכר דירה' },
  // Communication
  { kw: 'פרטנר',   sub: 'טלפון נייד ונייח' },
  { kw: 'סלקום',   sub: 'טלפון נייד ונייח' },
  { kw: 'פלאפון',  sub: 'טלפון נייד ונייח' },
  { kw: 'הוט',     sub: 'טלויזיה ואינטרנט (ספק ותשתית)' },
  { kw: 'יס',      sub: 'טלויזיה ואינטרנט (ספק ותשתית)' },
  { kw: 'בזק',     sub: 'טלויזיה ואינטרנט (ספק ותשתית)' },
  { kw: 'netflix', sub: 'שירותי תוכן' },
  { kw: 'spotify', sub: 'שירותי תוכן' },
  // Income
  { kw: 'משכורת',          sub: 'שכר עבודה 1' },
  { kw: 'שכר',             sub: 'שכר עבודה 1' },
  { kw: 'ביטוח לאומי',     sub: 'קצבת ילדים' },
  { kw: 'החזר ביטוח לאומי', sub: 'קצבת ילדים' },
  { kw: 'קצבת',            sub: 'קצבת ילדים' },
];

// Build a sorted (longest-first) keyword list once per cold start.
const BANK_KEYWORDS_SORTED = BANK_KEYWORDS
  .map(e => ({ kw: e.kw.toLowerCase(), sub: e.sub }))
  .sort((a, b) => b.kw.length - a.kw.length);

function classifyFromDescription(description, isIncome) {
  const t = String(description || '').toLowerCase();
  for (const e of BANK_KEYWORDS_SORTED) {
    if (t.includes(e.kw)) {
      const cat = findGroupForSubcategory(e.sub);
      // Bank debit/credit direction is authoritative. A keyword such as
      // "שכר" in an outgoing payroll payment must never turn into income.
      if (cat && isIncomeGroup(cat) === Boolean(isIncome)) {
        return { category: cat, subcategory: e.sub, classificationSource: 'keyword' };
      }
    }
  }
  if (isIncome) return { category: 'הכנסות שונות', subcategory: 'הכנסות שונות - כללי', classificationSource: 'fallback' };
  // The legacy fallback silently booked every unknown debit as groceries.
  // "פיננסים - כללי" is an existing, visible dashboard catch-all and is shown
  // as "לבדיקה" in preview so the user is not given false confidence.
  return { category: 'פיננסים', subcategory: 'פיננסים - כללי', classificationSource: 'fallback' };
}

const SAFE_SKIP_REASONS = new Set([
  'header_not_found', 'no_date_column', 'invalid_date',
  'invalid_amount', 'missing_description',
]);

// Parser diagnostics can contain a raw cell value (for example an invalid
// date). The browser only needs a row number and a stable reason code.
function sanitizeSkippedReasons(items) {
  return (Array.isArray(items) ? items : []).slice(0, 10).map((item) => {
    const rawReason = String(item?.reason || 'invalid_row').split(':', 1)[0].trim();
    const reason = SAFE_SKIP_REASONS.has(rawReason) ? rawReason : 'invalid_row';
    const rowNumber = Number.isInteger(item?.rowNumber) && item.rowNumber > 0
      ? item.rowNumber : null;
    return rowNumber ? { rowNumber, reason } : { reason };
  });
}

function previewSample(rows, limit = 10) {
  return rows.slice(0, limit).map((r) => {
    const classification = classifyFromDescription(r.description, r.isIncome);
    return {
      date: r.date,
      amount: r.amount,
      description: String(r.description || '').slice(0, 80),
      isIncome: Boolean(r.isIncome),
      category: classification.category,
      subcategory: classification.subcategory,
      classificationSource: classification.classificationSource,
    };
  });
}

function transactionTotals(rows) {
  return rows.reduce((totals, row) => {
    const amount = Number(row.amount) || 0;
    if (row.isIncome) totals.income += amount;
    else totals.expense += amount;
    return totals;
  }, { income: 0, expense: 0 });
}

function compactCommitResult(result) {
  // Long-lived idempotency state stores only operational counts. Descriptions,
  // samples, dates and financial totals remain transient in the response.
  return {
    ok: true,
    dryRun: false,
    ready: Number(result.ready) || 0,
    imported: Number(result.imported) || 0,
    duplicates: Number(result.duplicates) || 0,
    skipped: Number(result.skipped) || 0,
    total: Number(result.total) || 0,
    dedupWarning: Boolean(result.dedupWarning),
  };
}

// ---------------------------------------------------------------------------
// Single batched values:append. Building the 9-col rows ourselves so we
// only make ONE Sheets API call regardless of how many transactions came
// through (vs N calls if we looped appendRowToUserSheet). Same auth path,
// same self-heal-on-missing-tab fallback.
// ---------------------------------------------------------------------------
async function appendRowsBatched({ spreadsheetId, accessToken, rows }) {
  if (!rows.length) return { ok: true, updatedRange: null };

  const range = encodeURIComponent(`'${TX_TAB}'!A:I`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const body = JSON.stringify({ values: rows });
  const opts = (tok) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body,
  });

  let resp;
  try { resp = await fetch(url, opts(accessToken)); }
  catch (e) { return { ok: false, error: 'sheets_api_unreachable', detail: e.message }; }

  // Self-heal: missing תנועות tab -> create it + headers, retry.
  if (resp.status === 400) {
    const errBody = await resp.text().catch(() => '');
    if (/Unable to parse range|not found|not exist/i.test(errBody)) {
      try {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TX_TAB } } }] }),
        });
        const hdrRange = encodeURIComponent(`'${TX_TAB}'!A1`);
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${hdrRange}?valueInputOption=RAW`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [TX_HEADERS] }),
        });
        resp = await fetch(url, opts(accessToken));
      } catch (_e) { /* fall through */ }
    }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }
  const j = await resp.json().catch(() => ({}));
  return { ok: true, updatedRange: j?.updates?.updatedRange || null };
}

// ---------------------------------------------------------------------------
// Resolve the tenant write record from userSub (same pattern as recurring.js
// resolveTenantWriteRecord but indexed by userSub, since this endpoint is
// user-authenticated -- no phone lookup needed).
// ---------------------------------------------------------------------------
async function resolveByUserSub(userSub) {
  const sheetRec = await kvGet('sheet:' + userSub);
  const userRec  = (await kvGet('user:' + userSub)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) return { ok: false, error: 'no_sheet_provisioned' };
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return { ok: false, error: 'reauth_required' };
  }
  return {
    ok: true,
    spreadsheetId,
    refreshTokenEnvelope: userRec.refreshTokenEnvelope || null,
    refreshToken: userRec.refreshToken || null,
    userRecord: userRec,
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
async function handlerImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'missing_auth' });

  // Fail closed if KV is unreachable. We need KV for safe dedup and for the user
  // record (sheet id + encrypted token), so without it there's nothing safe
  // to do.
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    log.error('import.kv_not_configured', { reqId: req.reqId, userSub });
    return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const dryRun = body?.dryRun === true;

  const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return res.status(415).json({ ok: false, error: 'content_type_required' });
  }

  // Preview is intentionally more generous than commit. Keeping separate KV
  // buckets means an exploratory preview cannot consume the user's write quota.
  const rl = dryRun
    ? await rateLimitId(userSub, { key: 'preview_bank_csv', limit: 20, windowSec: 3600 })
    : await rateLimitId(userSub, { key: 'import_bank_csv', limit: 5, windowSec: 3600 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 3600));
    return res.status(429).json({
      ok: false, error: 'rate_limit_exceeded',
      retry_after: rl.retryAfter || 3600,
    });
  }

  const bank = String(body?.bank || '').toLowerCase();

  const parser = BANK_PARSERS[bank];
  if (!parser) return res.status(400).json({ ok: false, error: 'unknown_bank', supported: Object.keys(BANK_PARSERS) });
  const csv = decodeCsvBody(body);
  if (!csv.ok) {
    const status = csv.error === 'csv_too_large' ? 413 : 400;
    return res.status(status).json({ ok: false, error: csv.error, max_bytes: MAX_CSV_BYTES });
  }
  const fileDigest = crypto.createHash('sha256').update(csv.bytes).digest('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  const previewExpiresAt = nowSec + PREVIEW_TTL_SEC;
  const previewToken = dryRun
    ? mintPreviewToken({ userSub, bank, fileDigest, expiresAt: previewExpiresAt })
    : null;
  if (dryRun && !previewToken) {
    return res.status(503).json({ ok: false, error: 'preview_unavailable' });
  }
  if (!dryRun) {
    const grant = verifyPreviewToken(body?.previewToken, { userSub, bank, fileDigest, nowSec });
    if (!grant.ok) return res.status(409).json({ ok: false, error: grant.error });
  }

  // Only one commit per account may pass the dedup-check/write/hash-save
  // sequence at a time. Without this short lock, two simultaneous taps could
  // both see the same rows as unseen and append them twice. Preview is read-only
  // and deliberately never takes the lock.
  const lockKey = 'import:lock:' + userSub;
  const batchKey = 'import:commit:v1:' + userSub + ':' + fileDigest;
  const lockOwner = dryRun ? null : crypto.randomUUID();
  if (lockOwner) {
    const lock = await kvAcquireLock(lockKey, lockOwner, 90);
    if (!lock.ok) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
    if (!lock.acquired) return res.status(409).json({ ok: false, error: 'import_in_progress' });
  }

  try {
  if (!dryRun) {
    const batch = await kvGetStrict(batchKey);
    if (!batch.ok) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
    if (batch.value?.status === 'done' && batch.value.result) {
      return res.status(200).json({ ...batch.value.result, idempotent: true });
    }
    if (batch.value?.status === 'pending') {
      return res.status(409).json({ ok: false, error: 'import_status_unknown' });
    }
  }

  // 1. Parse.
  let parsed;
  try { parsed = parser(csv.parserInput); }
  catch (e) {
    log.error('import.parse_threw', { reqId: req.reqId, userSub, bank, errorType: e?.name || 'Error' });
    return res.status(400).json({ ok: false, error: 'parse_failed' });
  }
  const allRows = parsed.rows || [];
  const skippedFromParse = parsed.skipped || [];
  const skippedReasons = sanitizeSkippedReasons(skippedFromParse);
  if (allRows.length > MAX_PARSED_ROWS) {
    return res.status(413).json({ ok: false, error: 'too_many_rows', max_rows: MAX_PARSED_ROWS });
  }

  if (allRows.length === 0) {
    log.info('import.empty', { reqId: req.reqId, userSub, bank, rowCount: 0, skippedCount: skippedFromParse.length });
    const emptyResult = {
      ok: true, dryRun, ready: 0, imported: 0, duplicates: 0,
      skipped: skippedFromParse.length, total: skippedFromParse.length,
      totals: { income: 0, expense: 0 }, sample: [], skippedReasons,
      ...(dryRun ? { previewToken, expiresAt: new Date(previewExpiresAt * 1000).toISOString() } : {}),
    };
    if (!dryRun) await kvSetJsonTTL(batchKey, { status: 'done', result: compactCommitResult(emptyResult) }, COMMIT_DONE_TTL_SEC);
    return res.status(200).json(emptyResult);
  }

  // 2. Dedup. Remove byte-identical repeated rows inside the file, then query
  // both the legacy v1 identity and the richer v2 identity. v2 adds bank,
  // direction and the bank's own reference so two legitimate same-day charges
  // are not collapsed merely because amount/description match.
  const candidates = [];
  const exactSeen = new Set();
  let duplicates = 0;
  for (const row of allRows) {
    const exact = exactRowHash(row);
    if (exactSeen.has(exact)) { duplicates++; continue; }
    exactSeen.add(exact);
    candidates.push(row);
  }
  const legacyHashes = candidates.map(rowHashV1);
  const v2Hashes = candidates.map((row) => rowHashV2(row, bank));
  const setKey = 'import:hashes:' + userSub;
  const sm = await kvSmismember(setKey, legacyHashes.concat(v2Hashes));
  if (!sm.ok) {
    log.warn('import.dedup_lookup_failed', { reqId: req.reqId, userSub, bank });
    return res.status(503).json({ ok: false, error: 'dedup_unavailable' });
  }
  const present = sm.present;

  const newRows = [];
  const newHashes = [];
  for (let i = 0; i < candidates.length; i++) {
    if (present[i] || present[candidates.length + i]) { duplicates++; continue; }
    newRows.push(candidates[i]);
    newHashes.push(v2Hashes[i]);
  }

  const totals = transactionTotals(newRows);
  const sample = previewSample(newRows, dryRun ? 10 : 3);

  if (dryRun) {
    log.info('import.preview_ok', {
      reqId: req.reqId, userSub, bank,
      rowCount: allRows.length, readyCount: newRows.length,
      duplicatesCount: duplicates, skippedCount: skippedFromParse.length,
    });
    return res.status(200).json({
      ok: true, dryRun: true, ready: newRows.length, imported: 0,
      duplicates, skipped: skippedFromParse.length,
      total: allRows.length + skippedFromParse.length,
      totals, sample, skippedReasons, previewToken,
      expiresAt: new Date(previewExpiresAt * 1000).toISOString(),
    });
  }

  if (newRows.length === 0) {
    log.info('import.all_duplicates', {
      reqId: req.reqId, userSub, bank,
      rowCount: allRows.length, duplicatesCount: duplicates,
    });
    const duplicateResult = {
      ok: true, dryRun: false, ready: 0, imported: 0, duplicates,
      skipped: skippedFromParse.length,
      total: allRows.length + skippedFromParse.length,
      totals, sample: [], skippedReasons,
    };
    await kvSetJsonTTL(batchKey, { status: 'done', result: compactCommitResult(duplicateResult) }, COMMIT_DONE_TTL_SEC);
    return res.status(200).json(duplicateResult);
  }

  // 3. Resolve sheet + token.
  const rec = await resolveByUserSub(userSub);
  if (!rec.ok) {
    log.warn('import.tenant_unavailable', { reqId: req.reqId, userSub, bank, error: rec.error });
    return res.status(409).json({ ok: false, error: rec.error });
  }

  // 4. Mint access token from refresh.
  let refreshToken;
  if (rec.refreshTokenEnvelope) {
    try { refreshToken = decryptRefreshToken(rec.refreshTokenEnvelope, userSub); }
    catch (e) {
      log.error('import.token_decrypt_failed', { reqId: req.reqId, userSub, bank, error: e.message });
      return res.status(409).json({ ok: false, error: 'refresh_token_decrypt_failed' });
    }
  } else { refreshToken = rec.refreshToken; }

  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken, userSub); }
  catch (e) {
    log.error('import.token_refresh_failed', { reqId: req.reqId, userSub, bank, error: e.message });
    return res.status(502).json({ ok: false, error: 'token_refresh_failed' });
  }

  // 5. Build 9-col rows. We classify each row before constructing it so the
  // mirror dashboards line up.
  const sheetRows = newRows.map((r) => {
    const { category, subcategory } = classifyFromDescription(r.description, r.isIncome);
    const row = buildExpenseRow({
      amount: r.amount,
      isIncome: r.isIncome,
      category, subcategory,
      rawText: `[בנק:${bank}] ${r.description}`,
      date: r.date + 'T00:00:00Z', // midnight UTC for the parsed day
    });
    // buildExpenseRow defaults to the WhatsApp source for its many existing
    // callers. Bank rows must remain distinguishable for audits and filters.
    row[6] = 'ייבוא בנק';
    return row;
  });

  // 6. Mark the exact file pending immediately before the irreversible Sheets
  // append. A retry after an ambiguous network failure will stop instead of
  // silently appending twice.
  const pendingSaved = await kvSetJsonTTL(batchKey, {
    status: 'pending', startedAt: new Date().toISOString(),
  }, COMMIT_PENDING_TTL_SEC);
  if (!pendingSaved) return res.status(503).json({ ok: false, error: 'storage_unavailable' });

  // ONE batched Sheets append.
  const writeRes = await appendRowsBatched({
    spreadsheetId: rec.spreadsheetId, accessToken, rows: sheetRows,
  });
  if (!writeRes.ok) {
    log.error('import.sheets_write_failed', { reqId: req.reqId, userSub, bank, error: writeRes.error });
    if (writeRes.error === 'sheets_api_unreachable') {
      return res.status(409).json({ ok: false, error: 'import_status_unknown' });
    }
    await kvDelete(batchKey);
    return res.status(502).json({ ok: false, error: 'sheets_write_failed' });
  }

  // 7. Record hashes (and set TTL on first insert of the window). We use a
  // fresh EXPIRE every time -- the set's TTL slides forward with each
  // import. 400 days covers the common annual-statement reimport case.
  const saddRes = await kvSaddMany(setKey, newHashes);
  let dedupWarning = !saddRes.ok;
  if (!dedupWarning) {
    const expirySaved = await kvExpire(setKey, HASH_SET_TTL_SEC);
    if (!expirySaved) {
      dedupWarning = true;
      log.warn('import.hash_expiry_failed', { reqId: req.reqId, userSub, bank, count: newHashes.length });
    }
  } else {
    log.warn('import.hash_save_failed', { reqId: req.reqId, userSub, bank, count: newHashes.length });
  }

  // PRIVACY: log only counts. No description / amount / raw row content.
  log.info('import.ok', {
    reqId: req.reqId, userSub, bank,
    rowCount: allRows.length, importedCount: newRows.length,
    duplicatesCount: duplicates, skippedCount: skippedFromParse.length,
  });

  const result = {
    ok: true, dryRun: false, ready: newRows.length,
    imported: newRows.length,
    duplicates,
    skipped: skippedFromParse.length,
    total: allRows.length + skippedFromParse.length,
    totals, sample, skippedReasons,
    dedupWarning,
  };
  const commitStateSaved = await kvSetJsonTTL(batchKey, {
    status: 'done', completedAt: new Date().toISOString(), result: compactCommitResult(result),
  }, COMMIT_DONE_TTL_SEC);
  if (!commitStateSaved) result.commitStateWarning = true;
  const activity = await recordExpenseActivity({
    userSub, currentRecord: rec.userRecord, increment: newRows.length,
  });
  if (!activity.ok) {
    log.warn('import.activity_update_failed', { reqId: req.reqId, userSub, bank, reason: activity.reason });
  }
  return res.status(200).json(result);
  } finally {
    if (lockOwner) {
      const released = await kvReleaseLock(lockKey, lockOwner);
      if (!released) log.warn('import.lock_release_failed', { reqId: req.reqId, userSub, bank });
    }
  }
}

export default withRequestId(requireAuth(handlerImpl));
