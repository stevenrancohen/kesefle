// /api/import/bank-csv
//
// POST endpoint: imports an Israeli bank statement CSV (Hapoalim or Leumi)
// into the authenticated user's Kesefle sheet (the תנועות tab).
//
// Body:
//   {
//     bank:    'hapoalim' | 'leumi',
//     csvText: string  -- up to ~2 MB UTF-8
//   }
//
// Auth: requireAuth (session cookie or Bearer ID token).
// Rate limit: 5 imports per hour per userSub (KV bucket).
//
// Flow:
//   1. Parse CSV with the bank-specific header-driven parser.
//   2. For every parsed row compute a stable dedup hash (sha256 of
//      date|amount|description after a strict normalization) and check it
//      against the user's import:hashes:{userSub} set (90-day TTL).
//   3. For unseen rows: classify category via lib/categories.js
//      findGroupForSubcategory + a tiny in-module keyword map (mirrors what
//      the bot does -- we do NOT import the bot file).
//   4. Build the 8-column row with buildExpenseRow and append to תנועות
//      via the same Sheets API path the WhatsApp flow uses. To avoid N HTTP
//      calls we issue ONE values:append request with all rows; the existing
//      appendRowToUserSheet is row-by-row, so we use the lower-level Sheets
//      API directly here (matching the same auth + retry semantics).
//   5. Record the new hashes via Upstash SADD, set the set's TTL on first
//      write of a window.
//
// Returns:
//   { ok, imported, duplicates, skipped, total, sample: [first 3 rows] }
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
import { decryptRefreshToken } from '../../lib/crypto.js';
import { findGroupForSubcategory } from '../../lib/categories.js';
import crypto from 'node:crypto';

const TX_TAB = 'תנועות';
// Keep in sync with lib/sheet-writer.js TX_HEADERS -- col I "ניכוי מע״מ"
// added 2026-05-24. Bank-imported rows default to vatDeductible=false
// (the user can flip individual rows from the bot or sheet UI).
const TX_HEADERS = ['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'סטטוס', 'ניכוי מע״מ'];

// Vercel default body limit is 1 MB; bank exports for one month are usually
// well under that, but a full-year export can push past it. 2 MB headroom.
export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const HASH_SET_TTL_SEC = 90 * 24 * 3600; // 90 days

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

// ---------------------------------------------------------------------------
// Dedup hash. Normalization rules MUST stay deterministic across runs --
// any drift here causes the entire history to look "new" and re-import.
//   - Date is already ISO YYYY-MM-DD from the parser.
//   - Amount is rounded to cents (integer agorot) so 12.50 == 12.5.
//   - Description is lowercased, whitespace collapsed, bidi marks already
//     stripped by the parser, and capped at 80 chars (the bank sometimes
//     pads with running balance / posting time that drifts between exports).
// ---------------------------------------------------------------------------
function rowHash(r) {
  const desc = String(r.description || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  const cents = Math.round(Number(r.amount) * 100);
  const key = `${r.date}|${cents}|${desc}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Category classification. We re-use the bot's strategy (long-keyword-first
// substring match) but only over a small in-module table tuned for what
// shows up in BANK STATEMENT descriptions. For anything we don't recognise
// we fall back to 'אישי' top-level + 'מזון ופארמה - כללי'-style "כללי"
// subcategory chosen via findGroupForSubcategory.
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
      const cat = findGroupForSubcategory(e.sub) || (isIncome ? 'הכנסות שונות' : 'מזון ופארמה');
      return { category: cat, subcategory: e.sub };
    }
  }
  if (isIncome) return { category: 'הכנסות שונות', subcategory: 'הכנסות שונות - כללי' };
  return { category: 'מזון ופארמה', subcategory: 'מזון ופארמה - כללי' };
}

// ---------------------------------------------------------------------------
// Single batched values:append. Building the 8-col rows ourselves so we
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
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'missing_auth' });

  // Fail soft if KV is unreachable. We need KV for dedup and for the user
  // record (sheet id + encrypted token), so without it there's nothing safe
  // to do.
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    log.error('import.kv_not_configured', { reqId: req.reqId, userSub });
    return res.status(503).json({ ok: false, error: 'storage_unavailable' });
  }

  // Per-user rate limit. 5 imports / hour is well above any legitimate use
  // (a user typically uploads one statement per month) and protects against
  // a runaway script.
  const rl = await rateLimitId(userSub, { key: 'import_bank_csv', limit: 5, windowSec: 3600 });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 3600));
    return res.status(429).json({
      ok: false, error: 'rate_limit_exceeded',
      detail: 'יותר מדי ייבוא דפי בנק בשעה האחרונה. נסה/י שוב בעוד שעה.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const bank = String(body?.bank || '').toLowerCase();
  const csvText = body?.csvText;

  const parser = BANK_PARSERS[bank];
  if (!parser) return res.status(400).json({ ok: false, error: 'unknown_bank', supported: Object.keys(BANK_PARSERS) });
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return res.status(400).json({ ok: false, error: 'csv_text_required' });
  }
  if (csvText.length > 2 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: 'csv_too_large', max_bytes: 2 * 1024 * 1024 });
  }

  // 1. Parse.
  let parsed;
  try { parsed = parser(csvText); }
  catch (e) {
    log.error('import.parse_threw', { reqId: req.reqId, userSub, bank, error: e.message });
    return res.status(400).json({ ok: false, error: 'parse_failed', detail: e.message.slice(0, 200) });
  }
  const allRows = parsed.rows || [];
  const skippedFromParse = parsed.skipped || [];

  if (allRows.length === 0) {
    log.info('import.empty', { reqId: req.reqId, userSub, bank, rowCount: 0, skippedCount: skippedFromParse.length });
    return res.status(200).json({
      ok: true, imported: 0, duplicates: 0, skipped: skippedFromParse.length,
      total: skippedFromParse.length, sample: [], skippedReasons: skippedFromParse.slice(0, 10),
    });
  }

  // 2. Dedup. Compute hashes, ask KV which already exist.
  const hashes = allRows.map(rowHash);
  const setKey = 'import:hashes:' + userSub;
  const sm = await kvSmismember(setKey, hashes);
  if (!sm.ok) {
    log.warn('import.dedup_lookup_failed', { reqId: req.reqId, userSub, bank });
    // Best-effort fallback: treat all rows as new. The duplicate insert is
    // recoverable manually; failing the whole import is worse UX.
  }
  const present = sm.ok ? sm.present : new Array(hashes.length).fill(false);

  const newRows = [];
  const newHashes = [];
  let duplicates = 0;
  for (let i = 0; i < allRows.length; i++) {
    if (present[i]) { duplicates++; continue; }
    newRows.push(allRows[i]);
    newHashes.push(hashes[i]);
  }

  if (newRows.length === 0) {
    log.info('import.all_duplicates', {
      reqId: req.reqId, userSub, bank,
      rowCount: allRows.length, duplicatesCount: duplicates,
    });
    return res.status(200).json({
      ok: true, imported: 0, duplicates, skipped: skippedFromParse.length,
      total: allRows.length + skippedFromParse.length, sample: [],
    });
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
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) {
    log.error('import.token_refresh_failed', { reqId: req.reqId, userSub, bank, error: e.message });
    return res.status(502).json({ ok: false, error: 'token_refresh_failed' });
  }

  // 5. Build 8-col rows. We classify each row before constructing it so the
  // mirror dashboards line up.
  const sheetRows = newRows.map((r) => {
    const { category, subcategory } = classifyFromDescription(r.description, r.isIncome);
    return buildExpenseRow({
      amount: r.amount,
      isIncome: r.isIncome,
      category, subcategory,
      rawText: `[בנק:${bank}] ${r.description}`,
      date: r.date + 'T00:00:00Z', // midnight UTC for the parsed day
    });
  });

  // 6. ONE batched Sheets append.
  const writeRes = await appendRowsBatched({
    spreadsheetId: rec.spreadsheetId, accessToken, rows: sheetRows,
  });
  if (!writeRes.ok) {
    log.error('import.sheets_write_failed', { reqId: req.reqId, userSub, bank, error: writeRes.error });
    return res.status(502).json({ ok: false, error: writeRes.error, detail: writeRes.detail });
  }

  // 7. Record hashes (and set TTL on first insert of the window). We use a
  // fresh EXPIRE every time -- the set's TTL slides forward with each
  // import, which matches the user's expectation ("Kesefle remembers what
  // I imported in the last 90 days").
  const saddRes = await kvSaddMany(setKey, newHashes);
  if (saddRes.ok) {
    await kvExpire(setKey, HASH_SET_TTL_SEC);
  } else {
    log.warn('import.hash_save_failed', { reqId: req.reqId, userSub, bank, count: newHashes.length });
  }

  // PRIVACY: log only counts. No description / amount / raw row content.
  log.info('import.ok', {
    reqId: req.reqId, userSub, bank,
    rowCount: allRows.length, importedCount: newRows.length,
    duplicatesCount: duplicates, skippedCount: skippedFromParse.length,
  });

  // Build a small sample for the UI confirmation modal (3 rows max). Sample
  // is returned in the response to the AUTHENTICATED user only -- it's their
  // own data they just uploaded -- so it's safe to include.
  const sample = newRows.slice(0, 3).map(r => ({
    date: r.date,
    amount: r.amount,
    description: r.description.slice(0, 80),
    isIncome: r.isIncome,
  }));

  return res.status(200).json({
    ok: true,
    imported: newRows.length,
    duplicates,
    skipped: skippedFromParse.length,
    total: allRows.length + skippedFromParse.length,
    sample,
    skippedReasons: skippedFromParse.slice(0, 10),
  });
}

export default withRequestId(requireAuth(handlerImpl));
