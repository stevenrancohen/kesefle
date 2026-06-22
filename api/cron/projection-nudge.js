// api/cron/projection-nudge.js
//
// Monthly re-engagement nudge (the council's "one thing to do first": test
// whether a proactive WhatsApp nudge brings quiet users back).
//
// For each linked user it computes their END-OF-MONTH SPENDING PROJECTION from
// their own sheet (current pace: MTD expense / day-of-month x days-in-month) and
// sends a WhatsApp message: "at your current pace you'll finish the month around
// ₪X — want to see where the money's going?" with a button to /app.
//
// WHY A TEMPLATE (not freeform): a re-engagement nudge by definition targets
// users who have gone quiet. Meta only delivers a freeform text inside the 24h
// customer-service window, so freeform silently fails for exactly these users.
// This cron therefore sends an APPROVED TEMPLATE via /api/whatsapp/send.
//
// SAFE TO DEPLOY BEFORE THE TEMPLATE EXISTS: if env KESEFLE_PROJECTION_TEMPLATE
// is unset the cron is INERT (scans nothing, sends nothing, returns inert:true).
// Set it to the approved template name once Meta approves it (see
// docs/RETENTION_NUDGE_RUNBOOK.md).
//
// Dedup: `projection_nudged:{userSub}:{YYYY-MM}` (35d TTL) — one nudge per user
// per month. Only nudges users with real MTD spend and enough of the month
// elapsed for the run-rate to mean something (>= MIN_DAY).
//
// Schedule: vercel.json `0 7 24 * *` (24th, 07:00 UTC = 10:00 Asia/Jerusalem).
// Manually triggerable for the test: curl -H "Authorization: Bearer $CRON_SECRET".
// Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>.

import { withRequestId, log, subHash } from '../../lib/log.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const NUDGE_TTL_SEC = 35 * 86400; // ~one month + safety margin against rollover skew
const MIN_DAY = 8;                // don't extrapolate a month from < 8 days of data
const MIN_MTD = 50;               // skip users with negligible spend (nothing to say)

// ── pure helpers (exported for tests) ───────────────────────────────────────
export function projectMonthEnd(mtd, dayOfMonth, daysInMonth) {
  if (!(mtd > 0) || !(dayOfMonth > 0) || !(daysInMonth > 0)) return 0;
  return Math.round((mtd / dayOfMonth) * daysInMonth);
}
export function fmtNis(n) {
  return '₪' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ── KV helpers (same shape as budget-check.js) ──────────────────────────────
async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function kvScan(pattern, count = 100) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 50; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}
async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}
async function kvSetEx(key, val, ttlSec) {
  return kvFetch(`/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: 'POST', body: val });
}
async function kvExists(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  return r.ok && r.result != null;
}

// ── sheet read: MTD EXPENSE total (excludes income via col-H, like summary.js) ─
async function fetchSheetRange(spreadsheetId, range, accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json();
  return { ok: true, values: j.values || [] };
}
function parseDateCell(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(dt) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}
function monthKey(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
}
async function readMtdExpense(spreadsheetId, accessToken) {
  const year = new Date().getFullYear();
  // Read 'תנועות' FIRST to match summary.js (which the app's Insights projection
  // uses), so the nudge number equals what the user sees. The owner sheet's
  // year-named tabs are month x metric DASHBOARDS, not transactions -- reading
  // them first produced a meaningless MTD. Year tab is only a fallback for the
  // per-user template, where the transactions tab is named after the year.
  let result = await fetchSheetRange(spreadsheetId, `'${TX_TAB}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, `'${year}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, 'A1:N', accessToken);
  if (!result.ok) return null;

  const allRows = result.values || [];
  if (!allRows.length) return 0;

  const header = allRows[0].map((h) => String(h || '').trim().toLowerCase());
  const colIndex = (aliases, fb) => {
    for (let i = 0; i < header.length; i++) {
      if (aliases.some((a) => header[i].includes(a))) return i;
    }
    return fb;
  };
  const idx = {
    date: colIndex(['תאריך', 'date', 'timestamp', 'זמן'], 0),
    amount: colIndex(['סכום', 'amount', 'sum', 'price'], 1),
    category: colIndex(['קטגוריה', 'category', 'קטגורי'], 4),
    status: colIndex(['סטטוס', 'status'], 7),
  };
  const firstIsHeader = !parseDateCell(allRows[0][idx.date]);
  const dataRows = firstIsHeader ? allRows.slice(1) : allRows;

  const thisKey = monthKey(new Date());
  let mtd = 0;
  for (const raw of dataRows) {
    if (!raw || !raw.length) continue;
    const date = parseDateCell(raw[idx.date]);
    if (!date || monthKey(date) !== thisKey) continue;
    const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
    if (amount <= 0) continue;
    // Income detection identical to summary.js: col-H explicit false, or an
    // income category. Everything else (incl. blank col-H) is an expense.
    const flag = String(raw[idx.status] == null ? '' : raw[idx.status]).trim().toLowerCase();
    const cat = (raw[idx.category] || '').toString().trim();
    const isIncome = flag === 'false' || cat === 'הכנסות' || cat === 'הכנסה';
    if (isIncome) continue;
    mtd += amount;
  }
  return mtd;
}

// ── WhatsApp template send via the internal wrapper ─────────────────────────
async function sendTemplate(selfBaseUrl, phone, templateName, params) {
  const botSecret = process.env.KESEFLE_BOT_SECRET;
  if (!botSecret) return { ok: false, error: 'bot_secret_not_configured' };
  try {
    const r = await fetch(`${selfBaseUrl}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kesefle-bot-secret': botSecret },
      body: JSON.stringify({ phone, template: { name: templateName, language: 'he', params } }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, detail: j };
  } catch (e) {
    return { ok: false, error: 'send_failed', detail: e.message };
  }
}

async function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  const auth = req.headers['authorization'] || '';
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!auth || !constantTimeEqual(String(auth), `Bearer ${cronSecret}`)) {
    return { ok: false, code: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

async function handlerImpl(req, res) {
  const authCheck = await verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  // INERT until an approved template name is configured. This makes the cron
  // safe to ship + schedule before Meta approval — it simply no-ops.
  const templateName = process.env.KESEFLE_PROJECTION_TEMPLATE;
  if (!templateName) {
    return res.status(200).json({ ok: true, inert: true, reason: 'KESEFLE_PROJECTION_TEMPLATE unset', sent: 0 });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const selfBaseUrl = process.env.SELF_URL || 'https://kesefle.com';
  const now = new Date();
  const ym = monthKey(now);
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  // Too early in the month for a run-rate to be meaningful → no-op (but report).
  if (dayOfMonth < MIN_DAY) {
    return res.status(200).json({ ok: true, skippedReason: 'too_early_in_month', dayOfMonth, sent: 0 });
  }

  const userKeys = await kvScan('user:*');
  let scanned = 0, sent = 0, skipped = 0, errors = 0;

  for (const key of userKeys) {
    scanned++;
    const userSub = key.replace(/^user:/, '');
    if (!userSub) { skipped++; continue; }

    const dedupKey = `projection_nudged:${userSub}:${ym}`;
    if (await kvExists(dedupKey)) { skipped++; continue; }

    const userPhoneRec = await kvGet(`userPhone:${userSub}`);
    const phone = userPhoneRec?.phone || null;
    if (!phone) { skipped++; continue; } // can't WhatsApp without a linked phone

    const sheetRec = await kvGet(`sheet:${userSub}`);
    const userRec = (await kvGet(key)) || {};
    const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
    if (!spreadsheetId) { skipped++; continue; }

    let refreshToken = null;
    try {
      if (userRec.refreshTokenEnvelope) refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
      else if (userRec.refreshToken) refreshToken = userRec.refreshToken;
    } catch (e) {
      log.warn('projection_nudge.decrypt_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message });
    }
    if (!refreshToken) { skipped++; continue; }

    let accessToken;
    try { accessToken = await exchangeRefreshForAccess(refreshToken, userSub); }
    catch (e) { errors++; log.warn('projection_nudge.token_exchange_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message }); continue; }

    let mtd;
    try { mtd = await readMtdExpense(spreadsheetId, accessToken); }
    catch (e) { errors++; log.warn('projection_nudge.sheet_read_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message }); continue; }
    if (mtd == null) { errors++; continue; }
    if (mtd < MIN_MTD) { skipped++; continue; } // nothing meaningful to project

    const projected = projectMonthEnd(mtd, dayOfMonth, daysInMonth);
    if (projected <= 0) { skipped++; continue; }

    const send = await sendTemplate(selfBaseUrl, phone, templateName, [fmtNis(projected)]);
    if (send.ok) {
      sent++;
      await kvSetEx(dedupKey, { at: now.toISOString(), projected }, NUDGE_TTL_SEC);
    } else {
      errors++;
      log.warn('projection_nudge.send_failed', { reqId: req.reqId, sub: subHash(userSub), detail: send.detail || send.error });
    }
  }

  log.info('projection_nudge.done', { reqId: req.reqId, ym, scanned, sent, skipped, errors });
  return res.status(200).json({ ok: true, ym, scanned, sent, skipped, errors });
}

export default withRequestId(handlerImpl);
