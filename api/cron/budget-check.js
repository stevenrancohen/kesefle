// api/cron/budget-check.js
//
// Daily cross-user budget alert cron.
//
// For each user with a `usr_budget:{userSub}` record:
//   1. Resolve their canonical sheet + decrypt their refresh token.
//   2. Read MTD spending per category from their תנועות tab.
//   3. For each budgeted category, compute MTD / cap = pct.
//   4. If pct >= threshold AND we haven't already alerted this user this
//      month for this category, deliver independently through every available
//      channel (Web Push and, when linked, WhatsApp).
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
import { randomUUID } from 'node:crypto';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ALERT_TTL_SEC = 35 * 86400; // ~one month plus safety margin
const DELIVERY_LEASE_TTL_SEC = 10 * 60;

// ── KV helpers ──────────────────────────────────────────────────────────────
async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || typeof j !== 'object' || Object.prototype.hasOwnProperty.call(j, 'error')) {
      return { ok: false, status: r.status, error: j?.error || 'kv_protocol_error' };
    }
    return { ok: true, status: r.status, ...j };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function kvScan(pattern, count = 100) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 50; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok || !Array.isArray(r.result) || r.result.length !== 2 ||
        !Array.isArray(r.result[1]) || !r.result[1].every((key) => typeof key === 'string')) {
      return { ok: false, complete: false, keys };
    }
    cursor = String(r.result[0]);
    const batch = r.result[1];
    keys.push(...batch);
    if (cursor === '0') return { ok: true, complete: true, keys };
  }
  return { ok: false, complete: false, keys };
}

async function kvGetState(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok || !Object.prototype.hasOwnProperty.call(r, 'result')) return { state: 'unavailable' };
  if (r.result === null) return { state: 'missing' };
  try {
    const value = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid_state' };
    return { state: 'found', value };
  } catch (_e) { return { state: 'invalid_state' }; }
}

function validBudgetRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)) return false;
  return Object.entries(value.categories).every(([category, conf]) => {
    const cap = Number(conf?.cap);
    const threshold = Number(conf?.threshold);
    return !!category && Number.isInteger(cap) && cap > 0 && cap <= 100000 &&
      Number.isInteger(threshold) && threshold >= 1 && threshold <= 99;
  });
}

async function kvSetEx(key, val, ttlSec) {
  return kvFetch(`/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: 'POST', body: val });
}

async function kvEval(script, keys, args) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, value: null };
  try {
    const command = ['EVAL', script, String(keys.length), ...keys, ...args.map(String)];
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json().catch(() => null);
    if (!j || Object.prototype.hasOwnProperty.call(j, 'error') || typeof j.result !== 'string') {
      return { ok: false, value: null };
    }
    return { ok: true, value: j.result };
  } catch (_e) { return { ok: false, value: null }; }
}

async function kvAcquireDeliveryLease(key, token) {
  const r = await kvFetch(`/set/${encodeURIComponent(key)}?NX=true&EX=${DELIVERY_LEASE_TTL_SEC}`, {
    method: 'POST',
    body: token,
  });
  if (!r.ok || Object.prototype.hasOwnProperty.call(r, 'error') ||
      !Object.prototype.hasOwnProperty.call(r, 'result')) {
    return { ok: false, acquired: false };
  }
  // SET NX has exactly two healthy outcomes: "OK" (we own the lease) or
  // null (another run already owns it). Any other HTTP-200 payload is a KV
  // protocol failure and must degrade the cron instead of silently skipping.
  if (r.result !== 'OK' && r.result !== null) return { ok: false, acquired: false };
  return { ok: true, acquired: r.result === 'OK' };
}

async function kvFinalizeDelivery(key, token, deliveredValue) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_FINALIZE_BUDGET_ALERT_V1
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 'not_owner' end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 'stored'`;
  const result = await kvEval(script, [key], [token, deliveredValue, ALERT_TTL_SEC]);
  if (!result.ok) return { ok: false, finalized: false, result: null };
  return { ok: true, finalized: result.value === 'stored', result: result.value };
}

async function kvReleaseDeliveryLease(key, token) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_RELEASE_BUDGET_ALERT_V1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'not_owner' end
redis.call('DEL', KEYS[1])
return 'released'`;
  const result = await kvEval(script, [key], [token]);
  if (!result.ok) return { ok: false, released: false, result: null };
  return { ok: true, released: result.value === 'released', result: result.value };
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

  const scan = await kvScan('usr_budget:*');
  if (!scan.ok || !scan.complete) {
    log.warn('budget_check.kv_scan_failed', { reqId: req.reqId, partialKeys: scan.keys.length });
    return res.status(503).json({ ok: false, error: 'kv_scan_failed', scanned: 0, alerted: 0, skipped: 0, errors: 1 });
  }
  const budgetKeys = scan.keys;
  let scanned = 0, alerted = 0, skipped = 0, errors = 0, kvErrors = 0;
  const perUser = [];

  for (const key of budgetKeys) {
    scanned++;
    const userSub = key.replace(/^usr_budget:/, '');
    if (!userSub) { skipped++; continue; }

    const budgetRead = await kvGetState(key);
    if (budgetRead.state === 'unavailable' || budgetRead.state === 'invalid_state') {
      errors++; kvErrors++;
      log.warn('budget_check.budget_kv_failed', { reqId: req.reqId, sub: subHash(userSub), state: budgetRead.state });
      continue;
    }
    if (budgetRead.state === 'missing') {
      skipped++;
      continue;
    }
    const budget = budgetRead.value;
    if (!validBudgetRecord(budget)) {
      errors++; kvErrors++;
      log.warn('budget_check.budget_invalid', { reqId: req.reqId, sub: subHash(userSub) });
      continue;
    }
    if (!Object.keys(budget.categories).length) { skipped++; continue; }

    // Phone is optional: Web Push is a first-class channel for web-first users.
    // Sheet/token authority is resolved by userSub and never depends on phone.
    const phoneRead = await kvGetState(`userPhone:${userSub}`);
    let phone = null;
    if (phoneRead.state === 'found' && typeof phoneRead.value.phone === 'string' && phoneRead.value.phone) {
      phone = phoneRead.value.phone;
    } else if (phoneRead.state === 'found' || phoneRead.state === 'unavailable' || phoneRead.state === 'invalid_state') {
      errors++; kvErrors++;
      log.warn('budget_check.phone_kv_failed', { reqId: req.reqId, sub: subHash(userSub), state: phoneRead.state });
    }

    const [sheetRead, userRead] = await Promise.all([
      kvGetState(`sheet:${userSub}`),
      kvGetState(`user:${userSub}`),
    ]);
    let sheetSpreadsheetId = null;
    if (sheetRead.state === 'unavailable' || sheetRead.state === 'invalid_state') {
      errors++; kvErrors++;
      log.warn('budget_check.sheet_kv_failed', { reqId: req.reqId, sub: subHash(userSub), state: sheetRead.state });
    } else if (sheetRead.state === 'found') {
      if (typeof sheetRead.value.spreadsheetId === 'string' && sheetRead.value.spreadsheetId.trim()) {
        sheetSpreadsheetId = sheetRead.value.spreadsheetId.trim();
      } else {
        errors++; kvErrors++;
        log.warn('budget_check.sheet_invalid', { reqId: req.reqId, sub: subHash(userSub) });
      }
    }
    if (userRead.state === 'unavailable' || userRead.state === 'invalid_state') {
      errors++; kvErrors++;
      log.warn('budget_check.user_kv_failed', { reqId: req.reqId, sub: subHash(userSub), state: userRead.state });
      continue;
    }
    const userRec = userRead.state === 'found' ? userRead.value : {};
    const userSpreadsheetId = typeof userRec.spreadsheetId === 'string' && userRec.spreadsheetId.trim()
      ? userRec.spreadsheetId.trim()
      : null;
    // A malformed canonical sheet record is degraded, but it must not shadow a
    // valid legacy user-record fallback and silently suppress the alert.
    const spreadsheetId = sheetSpreadsheetId || userSpreadsheetId;
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
      const leaseToken = `lease:${randomUUID()}`;
      const lease = await kvAcquireDeliveryLease(dedupKey, leaseToken);
      if (!lease.ok) {
        errors++; kvErrors++;
        log.warn('budget_check.lease_failed', { reqId: req.reqId, sub: subHash(userSub), category });
        continue;
      }
      if (!lease.acquired) continue;

      const capStr = Math.round(cap).toLocaleString('he-IL');
      const spentStr = spent.toLocaleString('he-IL');
      const pctStr = Math.round(pct);
      const text = `התראה: עברת ${threshold}% מתקציב ${category} (₪${spentStr} מתוך ₪${capStr}, ${pctStr}%)`;

      const whatsAppResult = phone
        ? await sendWhatsAppAlert(selfBaseUrl, phone, text)
        : { ok: false, skipped: true, reason: 'no_linked_phone' };
      let pushResult = { ok: false, skipped: true, reason: 'push_failed' };
      try {
        pushResult = await sendPush(userSub, {
          title: 'התראת תקציב',
          body: text,
          tag: `budget-${category}`,
          url: '/app#/insights',
        });
      } catch (_pushErr) { /* push must never abort the cron */ }

      // One alert per category/month once at least one channel confirms
      // delivery. A WhatsApp outage must not make successful Push repeat daily.
      if (whatsAppResult.ok || pushResult?.ok) {
        const finalized = await kvFinalizeDelivery(
          dedupKey,
          leaseToken,
          JSON.stringify({ at: new Date().toISOString(), spent, cap, pct: pctStr }),
        );
        if (finalized.ok && finalized.finalized) {
          alerted++;
          perUser.push({ userSub, category, spent, cap, pct: pctStr });
        } else {
          errors++; kvErrors++;
          log.warn('budget_check.dedup_finalize_failed', {
            reqId: req.reqId, sub: subHash(userSub), category,
            state: finalized.ok ? finalized.result : 'kv_unavailable',
          });
        }
      } else {
        const released = await kvReleaseDeliveryLease(dedupKey, leaseToken);
        errors++;
        if (!released.ok || !released.released) {
          errors++; kvErrors++;
          log.warn('budget_check.dedup_release_failed', {
            reqId: req.reqId, sub: subHash(userSub), category,
            state: released.ok ? released.result : 'kv_unavailable',
          });
        }
        log.warn('budget_check.send_failed', {
          reqId: req.reqId,
          sub: subHash(userSub),
          category,
          whatsapp: { ok: !!whatsAppResult.ok, skipped: !!whatsAppResult.skipped, reason: whatsAppResult.reason || '' },
          push: { ok: !!pushResult?.ok, skipped: !!pushResult?.skipped, reason: pushResult?.reason || '' },
        });
      }
    }
  }

  const degraded = kvErrors > 0;
  log.info('cron.budget_check.summary', { reqId: req.reqId, scanned, alerted, skipped, errors, kvErrors, degraded });
  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    ...(degraded ? { error: 'kv_partial_failure', degraded: true } : {}),
    scanned, alerted, skipped, errors, kvErrors, perUser,
  });
}

export default withRequestId(handlerImpl);
