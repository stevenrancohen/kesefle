// /api/reminders
//
// Bill / payment reminders. The bot stores them in KV; a daily cron
// reads the ones due today and WhatsApps the user. Per-user so each
// person manages their own list, NOT shared across a group.
//
// KV schema:
//   reminders:<phone>          → [{ id, when (ISO date), description, amount?, recurring? }]
//   The list is bounded at 50 entries per phone (oldest dropped).
//
// Endpoints (POST, JSON, bot-secret required):
//   action=add     { phone, when, description, amount?, recurring? }
//   action=list    { phone }
//   action=remove  { phone, id }
//   action=due     { onDate? }   → cross-user scan of reminders firing today
//                                  (rate-limited admin path; cron uses it)

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
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

async function kvScan(pattern, max = 200) {
  if (!KV_URL || !KV_TOKEN) return [];
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 20 && keys.length < max; i++) {
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

// Parse a Hebrew/numeric date hint into a YYYY-MM-DD string.
// Accepts:
//   "מחר", "tomorrow"
//   "DD/MM", "D.M"
//   "DD/MM/YYYY"
//   "ראשון הבא", "first of month" → too fuzzy; user must use DD/MM
function parseDateHint(input) {
  if (!input) return null;
  const s = String(input).trim();
  const now = new Date();
  if (/^(מחר|tomorrow)$/i.test(s)) {
    const d = new Date(now); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (/^(היום|today)$/i.test(s)) return now.toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    let year;
    if (m[3]) { year = parseInt(m[3], 10); if (year < 100) year += 2000; }
    else {
      year = now.getFullYear();
      const probe = new Date(year, mon - 1, day);
      // If the date is more than 1 day in the past, roll to next year.
      if (probe.getTime() < now.getTime() - 86400 * 1000) year++;
    }
    const d = new Date(year, mon - 1, day);
    if (d.getMonth() !== mon - 1 || d.getDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }
  return null;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('reminders.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (got !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const action = String(body?.action || '').toLowerCase();

  switch (action) {
    case 'add': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const when = parseDateHint(body.when);
      if (!when) return res.status(400).json({ ok: false, error: 'invalid_date', hint: 'use DD/MM or "מחר"' });
      const description = String(body.description || '').slice(0, 200);
      if (!description) return res.status(400).json({ ok: false, error: 'description_required' });
      const list = (await kvGet('reminders:' + phone)) || [];
      const entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        when,
        description,
        amount: body.amount ? Number(body.amount) : null,
        recurring: body.recurring ? String(body.recurring) : null,
        createdAt: new Date().toISOString(),
      };
      list.push(entry);
      // Bound list size — 50 reminders is more than any human will track.
      if (list.length > 50) list.splice(0, list.length - 50);
      await kvSet('reminders:' + phone, list);
      return res.status(200).json({ ok: true, entry, total: list.length });
    }

    case 'list': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const list = (await kvGet('reminders:' + phone)) || [];
      // Only show upcoming (today and forward) by default.
      const today = new Date().toISOString().slice(0, 10);
      const upcoming = list.filter(r => r.when >= today).sort((a, b) => a.when.localeCompare(b.when));
      return res.status(200).json({ ok: true, reminders: upcoming, total: list.length });
    }

    case 'remove': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const id = String(body.id || '');
      const list = (await kvGet('reminders:' + phone)) || [];
      const next = list.filter(r => r.id !== id);
      await kvSet('reminders:' + phone, next);
      return res.status(200).json({ ok: true, removed: list.length - next.length, total: next.length });
    }

    case 'due': {
      // Cron-only scan. Returns all reminders firing today across all
      // users, so the bot can iterate and send WhatsApp pings.
      const onDate = body.onDate || new Date().toISOString().slice(0, 10);
      const keys = await kvScan('reminders:*');
      const due = [];
      for (const key of keys) {
        const list = await kvGet(key);
        if (!Array.isArray(list) || !list.length) continue;
        const phone = key.replace(/^reminders:/, '');
        list.filter(r => r.when === onDate).forEach(r => due.push({ phone, ...r }));
      }
      return res.status(200).json({ ok: true, onDate, count: due.length, due });
    }

    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', got: action });
  }
}

export default withRequestId(
  withRateLimit({ key: 'reminders', limit: 30, windowSec: 60 })(handlerImpl)
);
