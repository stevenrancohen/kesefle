// /api/recurring
//
// Personal "recurring expense templates" (הוצאות קבועות): rent, arnona, gym,
// streaming subscriptions… The bot parses the Hebrew command and stores a
// template here; a DAILY cron auto-logs any template that's due to the user's
// OWN Google Sheet (via the same tenant-write path as /api/sheet/append) and
// WhatsApps a confirmation — so the user never re-types a fixed expense.
//
// Why server-side (not Apps Script): writing to a NON-owner user's sheet
// requires their encrypted refresh token, which only the Vercel side can
// unwrap. So storage + the auto-log cron live here; the bot is just the
// command surface.
//
// KV schema:
//   recurring:<phone>                              → [ template, ... ]  (max 50)
//   recurring_logged:<phone>:<id>:<YYYY-MM-DD>     → '1'  (idempotency, TTL 45d)
//
// template = {
//   id, amount, description, category, subcategory,
//   freq: { type:'monthly', day:D }
//       | { type:'months',  n:N, day:D }      // every N months on day D
//       | { type:'weekly',  dow:W }           // W = 0..6 (0=Sunday)
//       | { type:'days',    n:N },            // every N days from startDate
//   startDate: 'YYYY-MM-DD', status: 'active'|'paused', createdAt, lastLoggedDate
// }
//
// Actions (POST, JSON, bot-secret):  add | list | remove | toggle | update | sync
// Action  (POST, JSON, cron-secret): cron
//   — `sync` and `cron` both write rows; `sync` is one phone (mid-month catch-up),
//     `cron` is the daily cross-user pass.

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { appendRowToUserSheet, buildExpenseRow } from '../lib/sheet-writer.js';
import { sendWhatsApp } from '../lib/billing.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CATCHUP_DAYS = 3;          // daily cron also catches the last 3 days
const MAX_TEMPLATES = 50;
const LOGGED_TTL_SEC = 45 * 86400;

// ── KV helpers ────────────────────────────────────────────────────────────────
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}
async function kvSetTTL(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}
async function kvExists(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return false;
  const j = await r.json();
  return j?.result != null;
}
async function kvScan(pattern, max = 500) {
  if (!KV_URL || !KV_TOKEN) return [];
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 40 && keys.length < max; i++) {
    const r = await fetch(`${KV_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/100`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) break;
    const j = await r.json();
    const [next, batch] = j.result || ['0', []];
    cursor = String(next || '0');
    (batch || []).forEach(k => keys.push(k));
    if (cursor === '0') break;
  }
  return keys;
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// ── Date helpers (all date math in plain YYYY-MM-DD strings) ────────────────────
function todayIsrael() {
  // 'en-CA' yields YYYY-MM-DD; timeZone keeps us on Israel's calendar day.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}
function parseYmd(s) { const [y, m, d] = String(s).split('-').map(Number); return { y, m, d }; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m is 1-based
function ymdToUTC(s) { const { y, m, d } = parseYmd(s); return Date.UTC(y, m - 1, d); }
function addDaysStr(s, n) {
  const t = ymdToUTC(s) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function diffDays(a, b) { return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000); }

// Does `dateStr` (YYYY-MM-DD) match this template's frequency? (Ignores status.)
function matchesFreq(tpl, dateStr) {
  const start = tpl.startDate || '2000-01-01';
  if (dateStr < start) return false;
  const f = tpl.freq || {};
  const { y, m, d } = parseYmd(dateStr);
  if (f.type === 'monthly' || f.type === 'months') {
    // Clamp the requested day to the month length (day 31 fires on the 30th/28th).
    const day = Math.min(Number(f.day) || 1, daysInMonth(y, m));
    if (d !== day) return false;
    if (f.type === 'months') {
      const s = parseYmd(start);
      const monthsApart = (y * 12 + (m - 1)) - (s.y * 12 + (s.m - 1));
      if (monthsApart < 0 || monthsApart % (Number(f.n) || 1) !== 0) return false;
    }
    return true;
  }
  if (f.type === 'weekly') {
    return new Date(ymdToUTC(dateStr)).getUTCDay() === (Number(f.dow) || 0);
  }
  if (f.type === 'days') {
    const n = Math.max(1, Number(f.n) || 1);
    return diffDays(start, dateStr) % n === 0;
  }
  return false;
}

// Next due date on/after `fromStr` (for list display). Scans up to ~400 days.
function nextDue(tpl, fromStr) {
  for (let i = 0; i < 400; i++) {
    const ds = addDaysStr(fromStr, i);
    if (matchesFreq(tpl, ds)) return ds;
  }
  return null;
}

// Pure helpers exported for unit tests (no I/O).
export { matchesFreq, nextDue, addDaysStr, daysInMonth, diffDays };

// ── Write one template occurrence to the user's sheet + return a log line ───────
async function logOccurrence(phone, userRecord, tpl, dateStr) {
  const idemKey = `recurring_logged:${phone}:${tpl.id}:${dateStr}`;
  if (await kvExists(idemKey)) return { skipped: true };
  const row = buildExpenseRow({
    amount: Number(tpl.amount),
    currency: 'ILS',
    isIncome: false,
    category: tpl.category || 'הוצאות קבועות',
    subcategory: tpl.subcategory || 'קבוע',
    rawText: `🔁 [קבוע] ${tpl.amount} ${tpl.description}`,
    messageId: `recurring:${tpl.id}:${dateStr}`,
    date: dateStr, // sheet-writer may honour an explicit date; harmless if ignored
  });
  const result = await appendRowToUserSheet({ userRecord, row });
  if (!result.ok) return { error: result.error || 'write_failed' };
  await kvSetTTL(idemKey, '1', LOGGED_TTL_SEC);
  return { ok: true, dateStr, amount: Number(tpl.amount), description: tpl.description };
}

// ── User actions (bot-secret) ───────────────────────────────────────────────────
async function addTemplate(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
  const description = String(body.description || '').slice(0, 120).trim();
  if (!description) return res.status(400).json({ ok: false, error: 'description_required' });
  const freq = body.freq && typeof body.freq === 'object' ? body.freq : null;
  if (!freq || !['monthly', 'months', 'weekly', 'days'].includes(freq.type)) {
    return res.status(400).json({ ok: false, error: 'invalid_freq' });
  }
  const today = todayIsrael();
  const list = (await kvGet('recurring:' + phone)) || [];
  if (list.length >= MAX_TEMPLATES) return res.status(409).json({ ok: false, error: 'too_many_templates', max: MAX_TEMPLATES });
  const tpl = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    amount, description,
    category: body.category || 'הוצאות קבועות',
    subcategory: body.subcategory || 'קבוע',
    freq,
    startDate: (body.startDate && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) ? body.startDate : today,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  list.push(tpl);
  await kvSet('recurring:' + phone, list);
  return res.status(200).json({ ok: true, template: tpl, total: list.length, nextDue: nextDue(tpl, today) });
}

async function listTemplates(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const today = todayIsrael();
  const list = (await kvGet('recurring:' + phone)) || [];
  const out = list.map(t => ({ ...t, nextDue: t.status === 'active' ? nextDue(t, today) : null }));
  return res.status(200).json({ ok: true, templates: out, total: out.length });
}

// Find a template by id or by a description substring (case-insensitive).
function findTpl(list, ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return -1;
  let i = list.findIndex(t => String(t.id).toLowerCase() === r);
  if (i >= 0) return i;
  return list.findIndex(t => String(t.description || '').toLowerCase().includes(r));
}

async function removeTemplate(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const list = (await kvGet('recurring:' + phone)) || [];
  const i = findTpl(list, body.ref);
  if (i < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  const [removed] = list.splice(i, 1);
  await kvSet('recurring:' + phone, list);
  return res.status(200).json({ ok: true, removed: removed.description, total: list.length });
}

async function toggleTemplate(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const list = (await kvGet('recurring:' + phone)) || [];
  const i = findTpl(list, body.ref);
  if (i < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  const want = String(body.status || '').toLowerCase();
  list[i].status = (want === 'active' || want === 'paused') ? want : (list[i].status === 'active' ? 'paused' : 'active');
  await kvSet('recurring:' + phone, list);
  return res.status(200).json({ ok: true, description: list[i].description, status: list[i].status });
}

async function updateTemplate(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const list = (await kvGet('recurring:' + phone)) || [];
  const i = findTpl(list, body.ref);
  if (i < 0) return res.status(404).json({ ok: false, error: 'not_found' });
  if (body.amount != null && isFinite(Number(body.amount)) && Number(body.amount) > 0) list[i].amount = Number(body.amount);
  if (body.category) list[i].category = String(body.category).slice(0, 60);
  if (body.subcategory) list[i].subcategory = String(body.subcategory).slice(0, 60);
  if (body.freq && typeof body.freq === 'object' && ['monthly', 'months', 'weekly', 'days'].includes(body.freq.type)) list[i].freq = body.freq;
  if (body.description) list[i].description = String(body.description).slice(0, 120);
  await kvSet('recurring:' + phone, list);
  return res.status(200).json({ ok: true, template: list[i] });
}

// Mid-month catch-up for ONE phone: log every unlogged occurrence from the
// template's startDate (capped to the last ~90 days) up to today.
async function syncPhone(body, res) {
  const phone = normalizeE164(body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
  const userRecord = await kvGet('phone:' + phone);
  if (!userRecord) return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  const today = todayIsrael();
  const list = (await kvGet('recurring:' + phone)) || [];
  const logged = [];
  for (const tpl of list) {
    if (tpl.status !== 'active') continue;
    let from = tpl.startDate || today;
    if (diffDays(from, today) > 90) from = addDaysStr(today, -90); // safety cap
    for (let ds = from; ds <= today; ds = addDaysStr(ds, 1)) {
      if (!matchesFreq(tpl, ds)) continue;
      const r = await logOccurrence(phone, userRecord, tpl, ds);
      if (r.ok) logged.push(r);
    }
  }
  const total = logged.reduce((s, l) => s + l.amount, 0);
  return res.status(200).json({ ok: true, logged, count: logged.length, totalAmount: total });
}

// ── Daily cron (cron-secret): cross-user auto-log for [today-3, today] ──────────
async function cronRun(body, res, reqId) {
  const today = todayIsrael();
  const from = addDaysStr(today, -CATCHUP_DAYS);
  const keys = await kvScan('recurring:*');
  let users = 0, logged = 0, errors = 0;
  for (const key of keys) {
    const phone = key.replace(/^recurring:/, '');
    const list = await kvGet(key);
    if (!Array.isArray(list) || !list.length) continue;
    const active = list.filter(t => t.status === 'active');
    if (!active.length) continue;
    const userRecord = await kvGet('phone:' + phone);
    if (!userRecord) continue;
    users++;
    for (const tpl of active) {
      for (let ds = from; ds <= today; ds = addDaysStr(ds, 1)) {
        if (!matchesFreq(tpl, ds)) continue;
        const r = await logOccurrence(phone, userRecord, tpl, ds);
        if (r.ok) {
          logged++;
          const when = ds === today ? '' : ` (${ds.slice(8)}/${ds.slice(5, 7)})`;
          await sendWhatsApp(phone, `📅 הוצאה קבועה: ₪${Number(tpl.amount).toLocaleString('he-IL')} ${tpl.description} נרשמה אוטומטית${when}.`).catch(() => {});
        } else if (r.error) { errors++; }
      }
    }
  }
  log.info('recurring.cron', { reqId, users, logged, errors });
  return res.status(200).json({ ok: true, date: today, users, logged, errors });
}

// ── Router ──────────────────────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = String(body?.action || '').toLowerCase();

  // The cron is a cross-user, sheet-writing path → gate on the dedicated
  // KESEFLE_CRON_SECRET (same posture as reminders' "due"), so a bot-secret
  // leak alone can't trigger mass writes.
  if (action === 'cron') {
    const cronSecret = process.env.KESEFLE_CRON_SECRET;
    if (!cronSecret) return res.status(503).json({ ok: false, error: 'cron_secret_not_configured' });
    const got = req.headers['x-kesefle-cron-secret'] || body?.cronSecret;
    if (got !== cronSecret) return res.status(401).json({ ok: false, error: 'cron_unauthorized' });
    return cronRun(body, res, req.reqId);
  }

  // All other actions are bot-only.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (got !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });

  switch (action) {
    case 'add':    return addTemplate(body, res);
    case 'list':   return listTemplates(body, res);
    case 'remove': return removeTemplate(body, res);
    case 'toggle': return toggleTemplate(body, res);
    case 'update': return updateTemplate(body, res);
    case 'sync':   return syncPhone(body, res);
    default:       return res.status(400).json({ ok: false, error: 'unknown_action', got: action });
  }
}

export default withRequestId(
  withRateLimit({ key: 'recurring', limit: 60, windowSec: 60 })(handlerImpl)
);
