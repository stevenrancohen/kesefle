// api/cron/budget-check.js
//
// Daily cross-user budget alert cron.
//
// For each user with a `usr_budget:{userSub}` record:
//   1. Resolve their canonical sheet + decrypt their refresh token.
//   2. Read MTD spending per category from their תנועות tab.
//   3. For each budgeted category, compute MTD / cap = pct.
//   4. If pct >= threshold AND we haven't already alerted this user this
//      month for this category, send a WhatsApp message via /api/whatsapp/send.
//      Dedup key: `budget_alerted:{userSub}:{YYYY-MM}:{category}` with 35d TTL
//      (35 = one month + safety margin so any clock skew across month rollover
//      doesn't double-fire).
//
// Schedule: vercel.json `0 8 * * *` (08:00 UTC = 11:00 Asia/Jerusalem).
// Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>.

import { withRequestId, log, subHash } from '../../lib/log.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { sendPush } from '../../lib/push.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ALERT_TTL_SEC = 35 * 86400; // ~one month plus safety margin

// ── KV helpers ──────────────────────────────────────────────────────────────
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
    const batch = r.result?.[1] || [];
    keys.push(...batch);
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
  if (!r.ok) return false;
  return r.result != null;
}

// ── Sheet reading (same row/col detection as api/sheet/stats.js) ───────────
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
  let m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
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

// Read MTD totals per category for one user. Returns Object<category, totalNIS>.
// Returns null on a hard read failure so the caller can skip + log without
// double-counting.
async function readMtdByCategory(spreadsheetId, accessToken) {
  const year = new Date().getFullYear();
  let result = await fetchSheetRange(spreadsheetId, `'${year}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, `'${TX_TAB}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, 'A1:N', accessToken);
  if (!result.ok) return null;

  const allRows = result.values || [];
  if (!allRows.length) return {};

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
  };
  const firstIsHeader = !parseDateCell(allRows[0][idx.date]);
  const dataRows = firstIsHeader ? allRows.slice(1) : allRows;

  const now = new Date();
  const thisKey = monthKey(now);
  const byCat = Object.create(null);
  for (const raw of dataRows) {
    if (!raw || !raw.length) continue;
    const date = parseDateCell(raw[idx.date]);
    if (!date) continue;
    const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
    if (amount <= 0) continue;
    if (monthKey(date) !== thisKey) continue;
    const cat = (raw[idx.category] || '').toString().trim();
    if (!cat) continue;
    byCat[cat] = (byCat[cat] || 0) + amount;
  }
  return byCat;
}

// ── WhatsApp send via the internal /api/whatsapp/send wrapper ───────────────
async function sendWhatsAppAlert(selfBaseUrl, phone, text) {
  const botSecret = process.env.KESEFLE_BOT_SECRET;
  if (!botSecret) return { ok: false, error: 'bot_secret_not_configured' };
  try {
    const r = await fetch(`${selfBaseUrl}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kesefle-bot-secret': botSecret },
      body: JSON.stringify({ phone, text }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, detail: j };
  } catch (e) {
    return { ok: false, error: 'send_failed', detail: e.message };
  }
}

// ── Cron auth ───────────────────────────────────────────────────────────────
async function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  }
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${cronSecret}`;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!auth || !constantTimeEqual(String(auth), expected)) {
    return { ok: false, code: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

// ── Main handler ────────────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  const authCheck = await verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_outage' });
  }

  const selfBaseUrl = process.env.SELF_URL || 'https://kesefle.com';
  const ymNow = monthKey(new Date());

  const budgetKeys = await kvScan('usr_budget:*');
  let scanned = 0, alerted = 0, skipped = 0, errors = 0;
  const perUser = [];

  for (const key of budgetKeys) {
    scanned++;
    const userSub = key.replace(/^usr_budget:/, '');
    if (!userSub) { skipped++; continue; }

    const budget = await kvGet(key);
    if (!budget || !budget.categories || !Object.keys(budget.categories).length) {
      skipped++;
      continue;
    }

    // Resolve the user's phone (so we can WhatsApp them) and sheet/token.
    const userPhoneRec = await kvGet(`userPhone:${userSub}`);
    const phone = userPhoneRec?.phone || null;
    if (!phone) { skipped++; continue; } // can't alert without a linked phone

    const sheetRec = await kvGet(`sheet:${userSub}`);
    const userRec = (await kvGet(`user:${userSub}`)) || {};
    const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
    if (!spreadsheetId) { skipped++; continue; }

    // Decrypt refresh token (encrypted envelope, fall back to legacy plaintext).
    let refreshToken = null;
    try {
      if (userRec.refreshTokenEnvelope) {
        refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
      } else if (userRec.refreshToken) {
        refreshToken = userRec.refreshToken;
      }
    } catch (e) {
      log.warn('budget_check.decrypt_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message });
    }
    if (!refreshToken) { skipped++; continue; }

    let accessToken;
    try { accessToken = await exchangeRefreshForAccess(refreshToken); }
    catch (e) {
      errors++;
      log.warn('budget_check.token_exchange_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message });
      continue;
    }

    let mtdByCat;
    try { mtdByCat = await readMtdByCategory(spreadsheetId, accessToken); }
    catch (e) {
      errors++;
      log.warn('budget_check.sheet_read_failed', { reqId: req.reqId, sub: subHash(userSub), error: e.message });
      continue;
    }
    if (mtdByCat == null) {
      errors++;
      log.warn('budget_check.sheet_read_returned_null', { reqId: req.reqId, sub: subHash(userSub) });
      continue;
    }

    // For each budgeted category, evaluate threshold + dedup + send.
    for (const [category, conf] of Object.entries(budget.categories)) {
      const cap = Number(conf?.cap) || 0;
      const threshold = Number(conf?.threshold) || 80;
      if (cap <= 0) continue;
      const spent = Math.round(Number(mtdByCat[category] || 0));
      const pct = (spent / cap) * 100;
      if (pct < threshold) continue;

      const dedupKey = `budget_alerted:${userSub}:${ymNow}:${category}`;
      if (await kvExists(dedupKey)) continue;

      const capStr = Math.round(cap).toLocaleString('he-IL');
      const spentStr = spent.toLocaleString('he-IL');
      const pctStr = Math.round(pct);
      const text = `התראה: עברת ${threshold}% מתקציב ${category} (₪${spentStr} מתוך ₪${capStr}, ${pctStr}%)`;

      const sendResult = await sendWhatsAppAlert(selfBaseUrl, phone, text);
      // Best-effort push (env-fail-soft when VAPID isn't configured or the
      // user never opted in). Push is a SECOND channel, not a replacement
      // for WhatsApp -- both can succeed independently. Pushed BEFORE the
      // dedup-key write so a push-only failure doesn't re-trigger tomorrow.
      try {
        await sendPush(userSub, {
          title: 'התראת תקציב',
          body: text,
          tag: `budget-${category}`,
          url: '/dashboard',
        });
      } catch (_pushErr) { /* push must never abort the cron */ }

      if (sendResult.ok) {
        await kvSetEx(dedupKey, JSON.stringify({ at: new Date().toISOString(), spent, cap, pct: pctStr }), ALERT_TTL_SEC);
        alerted++;
        perUser.push({ userSub, category, spent, cap, pct: pctStr });
      } else {
        errors++;
        log.warn('budget_check.send_failed', { reqId: req.reqId, sub: subHash(userSub), category, detail: sendResult });
      }
    }
  }

  log.info('cron.budget_check.summary', { reqId: req.reqId, scanned, alerted, skipped, errors });
  return res.status(200).json({ ok: true, scanned, alerted, skipped, errors, perUser });
}

export default withRequestId(handlerImpl);
