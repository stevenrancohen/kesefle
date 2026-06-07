// api/feedback.js
//
// Capture free-text customer feedback ("ביקורת") sent from the WhatsApp bot.
// The bot forwards every feedback message to the owner on WhatsApp directly;
// this endpoint is the DURABLE copy so the team (and Claude) can review it and
// improve the product. Steven 2026-06-07:
//   "ואתה כקלוד תקבל את זה ותשפר את המערכת ותשלח לי גם הודעות כאלה שלקוחות כותבים"
//
// POST (bot-secret): { phone?, message, source?, userSub? }
//   Stores user_report:bot:<ts>-<rand> = { at, message, phone, source, kind }.
//   The key matches the 'user_report:*' pattern that api/admin/inbox.js already
//   scans, so feedback shows up in the unified admin inbox with no inbox change.
//
// No GET here — the admin inbox / user-reports endpoints already read it.

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { ok: r.ok, status: r.status };
}

function normalizePhone(input) {
  const s = String(input || '').replace(/\D+/g, '');
  if (!s) return null;
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const presented = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (!presented || !constantTimeEqual(String(presented), expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const message = String(body.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ ok: false, error: 'empty_message' });
  const phone = normalizePhone(body.phone);
  const source = String(body.source || 'whatsapp').slice(0, 24);

  if (!KV_URL || !KV_TOKEN) {
    // The bot already alerted the owner over WhatsApp, so a KV outage here is
    // non-fatal — report it but don't make the bot retry-loop.
    log.warn('feedback.kv_outage', { reqId: req.reqId });
    return res.status(200).json({ ok: true, persisted: false });
  }

  const at = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `user_report:bot:${Date.now()}-${rand}`;
  const record = {
    at,
    message,
    // Phone is the only identifier the bot has; userSub is resolved later in
    // the admin view if needed. Keep it short — this is a support signal.
    phone: phone || null,
    userSub: String(body.userSub || '') || null,
    source,
    kind: 'whatsapp_feedback',
    subject: 'ביקורת (WhatsApp)',
  };
  const r = await kvSet(key, record);
  if (!r.ok) {
    log.error('feedback.persist_failed', { reqId: req.reqId, status: r.status });
    return res.status(200).json({ ok: true, persisted: false });
  }
  log.info('feedback.captured', { reqId: req.reqId, source, hasPhone: !!phone });
  return res.status(200).json({ ok: true, persisted: true });
}

export default withRequestId(
  withRateLimit({ key: 'feedback', limit: 30, windowSec: 60 })(handlerImpl)
);
