// api/admin/conversations.js
//
// Admin Conversation Console (read-only, MVP) -- a FastBots-style view of who
// has been talking to the bot recently, newest-first, grouped per user as a
// lightweight thread.
//
// ---------------------------------------------------------------------------
// IMPORTANT -- WHAT THIS DOES AND DOES NOT SHOW
// ---------------------------------------------------------------------------
// Kesefle is privacy-first by design. The product DELIBERATELY does not persist
// the bodies of WhatsApp messages or the bot's outbound replies:
//
//   - last_inbound:<phone>  ->  { ts, id }   (timestamp + message-id only; NO text)
//   - lib/secure-kv.js exclude-list + the bot's _kvSet_ never write message text
//   - api/admin/user-timeline.js explicitly states message bodies are NOT captured
//   - the bot processes + replies entirely inside Apps Script; nothing is stored
//
// Therefore this endpoint does NOT fabricate inbound/outbound text. It surfaces
// the real signals we DO have, as threads:
//
//   * inbound "ping" events    -- from last_inbound:<phone> (a message arrived
//                                 at time T; body intentionally not stored)
//   * user_report messages     -- real user-typed text Steven already collects
//                                 via the floating "report a problem" button
//   * exit_survey comments      -- real user-typed cancellation comments
//
// For each user we assemble a newest-first thread of these events. Where the
// actual message body / bot reply is not captured, the item is flagged
// (body_available: false) so the UI can be honest rather than show fake text.
//
// "Edit + resend the bot's reply" is a STRETCH goal that depends on a captured
// outbound store which does not exist yet -- the UI ships a disabled control
// with a note instead of faking it.
//
// ---------------------------------------------------------------------------
// PRIVACY / SECURITY
// ---------------------------------------------------------------------------
//   - requireAdmin (ADMIN_EMAILS) gates the endpoint.
//   - Identifiers are PII-minimized in the response: userSub is hashed (subHash),
//     phone numbers are masked to the last 4 digits, emails are masked.
//   - Tenant isolation is preserved: we only read admin-aggregate KV keys
//     (last_inbound:*, user_report:*, exit_survey:*, user:* lookups). No tenant
//     sheet contents are read; no cross-tenant message bodies are exposed
//     (there are none stored).
//
// GET /api/admin/conversations?limit=30&hours=336&cursor=0&kinds=ping,user_report,exit_survey

import { withRequestId, log, subHash } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Hard caps so a malicious/huge query cannot blow the per-admin rate budget or
// scan the entire keyspace.
const MAX_SCAN_ITER = 25;       // up to 25 * 400 = 10k keys per prefix scanned
const SCAN_COUNT = 400;
const MAX_USER_LOOKUPS = 120;   // cap user:/phone: hydrations per request

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  try {
    const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch (_e) {
    return { ok: false };
  }
}

async function kvScan(pattern) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < MAX_SCAN_ITER; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${SCAN_COUNT}`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const r = await kvFetch('/mget/' + keys.map(encodeURIComponent).join('/'));
  return (r.result || []).map((v, i) => {
    let parsed = null;
    try { parsed = v ? JSON.parse(v) : null; } catch { parsed = null; }
    return { key: keys[i], value: parsed };
  });
}

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}

// ---- PII helpers ----------------------------------------------------------

// Show only the last 4 digits of a phone: "972541234567" -> "•••••4567".
function maskPhone(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D+/g, '');
  if (!digits) return null;
  const last4 = digits.slice(-4);
  return '•••••' + last4;
}

// Mask an email to "a•••@gmail.com".
function maskEmail(email) {
  const s = String(email == null ? '' : email).trim();
  const at = s.indexOf('@');
  if (at <= 0) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.slice(0, 1);
  return head + '•••@' + domain;
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Normalize various timestamp shapes (ISO string, epoch ms number, epoch ms
// string) to epoch ms for sorting. Returns 0 when unparseable.
function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (/^\d{10,}$/.test(String(v))) return parseInt(String(v), 10);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

// A stable, non-reversible per-thread key. We thread by phone when available
// (most signals are phone-keyed) else by userSub. The returned id is a hash so
// nothing PII leaves the server.
function threadIdFor({ phone, userSub }) {
  if (userSub) return 'u_' + subHash(userSub);
  if (phone) return 'p_' + subHash('phone:' + String(phone).replace(/\D+/g, ''));
  return 'unknown';
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 30));
  // Default window: 14 days. Capped at 90 days.
  const hours = Math.min(24 * 90, Math.max(1, parseInt(req.query.hours, 10) || 24 * 14));
  const sinceMs = Date.now() - hours * 3600 * 1000;

  const requestedKinds = String(req.query.kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ALL_KINDS = ['ping', 'user_report', 'exit_survey'];
  const activeKinds = (requestedKinds.length ? requestedKinds : ALL_KINDS).filter((k) => ALL_KINDS.includes(k));

  // ---- 1. Collect raw events from the (PII-safe) signals we actually store --
  const rawEvents = [];

  // (a) Inbound pings -- last_inbound:<phone> = { ts, id }. Body NOT stored.
  if (activeKinds.includes('ping')) {
    const keys = await kvScan('last_inbound:*');
    const rows = await kvMget(keys);
    for (const { key, value } of rows) {
      if (!value) continue;
      const phone = key.replace(/^last_inbound:/, '');
      const at = toMs(value.ts);
      if (!at || at < sinceMs) continue;
      rawEvents.push({
        phone,
        userSub: null,
        kind: 'ping',
        at,
        direction: 'in',
        text: null,
        body_available: false,
        message_id: value.id ? clip(value.id, 48) : null,
      });
    }
  }

  // (b) user_report:* -- real user-typed text from the in-app report button.
  if (activeKinds.includes('user_report')) {
    const keys = await kvScan('user_report:*');
    const rows = await kvMget(keys);
    for (const { value } of rows) {
      if (!value || !value.at) continue;
      const at = toMs(value.at);
      if (!at || at < sinceMs) continue;
      rawEvents.push({
        phone: null,
        userSub: value.userSub || null,
        kind: 'user_report',
        at,
        direction: 'in',
        text: clip(value.message || value.subject || '', 280),
        body_available: !!(value.message || value.subject),
        meta: { url: clip(value.url || '', 80) },
      });
    }
  }

  // (c) exit_survey:* -- real user-typed cancellation comment.
  if (activeKinds.includes('exit_survey')) {
    const keys = await kvScan('exit_survey:*');
    const rows = await kvMget(keys);
    for (const { value } of rows) {
      if (!value || !value.cancelled_at) continue;
      const at = toMs(value.cancelled_at);
      if (!at || at < sinceMs) continue;
      const body = value.comment || '';
      rawEvents.push({
        phone: null,
        userSub: value.userSub || null,
        kind: 'exit_survey',
        at,
        direction: 'in',
        text: clip((value.reason ? '[' + value.reason + '] ' : '') + body, 280),
        body_available: !!body,
      });
    }
  }

  if (!rawEvents.length) {
    return res.status(200).json({
      ok: true,
      at: new Date().toISOString(),
      window_hours: hours,
      kinds: activeKinds,
      total_threads: 0,
      returned: 0,
      threads: [],
      capabilities: { resend: false, edit: false },
      privacy_note: 'Message bodies of WhatsApp expenses + bot replies are not stored by design. This view shows inbound activity timing plus user-submitted report/cancellation text only. Identifiers are hashed/masked.',
    });
  }

  // ---- 2. Group events into per-user threads -------------------------------
  // Key by phone first (most events are phone-keyed) then userSub. To merge a
  // phone-keyed ping with a sub-keyed report for the SAME person we resolve
  // phone<->sub via the phone:<phone> KV record (bounded number of lookups).
  const phoneToSub = new Map();
  const subToPhone = new Map();

  // Resolve sub for phone-keyed events (bounded).
  const distinctPhones = [...new Set(rawEvents.filter((e) => e.phone).map((e) => e.phone))].slice(0, MAX_USER_LOOKUPS);
  await Promise.all(distinctPhones.map(async (phone) => {
    const rec = await kvGet(`phone:${phone}`);
    if (rec?.userSub) {
      phoneToSub.set(phone, rec.userSub);
      if (!subToPhone.has(rec.userSub)) subToPhone.set(rec.userSub, phone);
    }
  }));

  // Resolve phone for sub-keyed events (bounded) so masked phone can be shown.
  const distinctSubs = [...new Set(rawEvents.filter((e) => e.userSub).map((e) => e.userSub))].slice(0, MAX_USER_LOOKUPS);
  await Promise.all(distinctSubs.map(async (sub) => {
    if (subToPhone.has(sub)) return;
    const rec = await kvGet(`userPhone:${sub}`);
    if (rec?.phone) subToPhone.set(sub, rec.phone);
  }));

  // Canonicalize each event onto a single thread (prefer userSub identity).
  const threads = new Map();
  for (const ev of rawEvents) {
    let sub = ev.userSub;
    let phone = ev.phone;
    if (!sub && phone && phoneToSub.has(phone)) sub = phoneToSub.get(phone);
    if (!phone && sub && subToPhone.has(sub)) phone = subToPhone.get(sub);

    const tid = threadIdFor({ phone, userSub: sub });
    if (!threads.has(tid)) {
      threads.set(tid, {
        thread_id: tid,
        user_hash: sub ? subHash(sub) : null,
        phone_masked: maskPhone(phone),
        email_masked: null,            // hydrated below (bounded)
        _sub: sub || null,             // internal only; stripped before responding
        last_at: 0,
        message_count: 0,
        messages: [],
      });
    }
    const t = threads.get(tid);
    if (sub && !t._sub) t._sub = sub;
    if (!t.phone_masked && phone) t.phone_masked = maskPhone(phone);
    t.messages.push({
      kind: ev.kind,
      direction: ev.direction,
      at: new Date(ev.at).toISOString(),
      at_ms: ev.at,
      text: ev.text,
      body_available: ev.body_available,
      message_id: ev.message_id || null,
      meta: ev.meta || null,
    });
    if (ev.at > t.last_at) t.last_at = ev.at;
    t.message_count++;
  }

  // ---- 3. Sort threads newest-first, paginate, hydrate masked email --------
  const allThreads = [...threads.values()].sort((a, b) => b.last_at - a.last_at);
  const totalThreads = allThreads.length;

  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const pageThreads = allThreads.slice(cursor, cursor + limit);

  // Hydrate masked email only for the page being returned (bounded lookups).
  await Promise.all(pageThreads.map(async (t) => {
    if (!t._sub) return;
    const u = await kvGet(`user:${t._sub}`);
    if (u?.email) t.email_masked = maskEmail(u.email);
  }));

  // Sort each thread's messages newest-first and strip internal fields.
  const outThreads = pageThreads.map((t) => {
    t.messages.sort((a, b) => b.at_ms - a.at_ms);
    return {
      thread_id: t.thread_id,
      user_hash: t.user_hash,
      phone_masked: t.phone_masked,
      email_masked: t.email_masked,
      last_at: new Date(t.last_at).toISOString(),
      message_count: t.message_count,
      messages: t.messages.map((m) => {
        const { at_ms, ...rest } = m;
        return rest;
      }),
    };
  });

  const nextCursor = cursor + limit < totalThreads ? cursor + limit : null;

  log.info('admin.conversations.read', {
    reqId: req.reqId,
    adminEmail: req.user?.email,
    threads: totalThreads,
    returned: outThreads.length,
    kinds: activeKinds.join(','),
  });

  return res.status(200).json({
    ok: true,
    at: new Date().toISOString(),
    window_hours: hours,
    kinds: activeKinds,
    total_threads: totalThreads,
    returned: outThreads.length,
    next_cursor: nextCursor,
    threads: outThreads,
    // Stretch capability flags -- resend/edit require a captured outbound store
    // that does not exist yet. UI must render the control disabled + a note.
    capabilities: { resend: false, edit: false },
    privacy_note: 'Message bodies of WhatsApp expenses + bot replies are not stored by design. This view shows inbound activity timing plus user-submitted report/cancellation text only. Identifiers are hashed/masked.',
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_conversations', limit: 30, windowSec: 60 })(requireAdmin(handlerImpl))
);
