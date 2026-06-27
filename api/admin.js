// /api/admin
// Consolidated admin router — handles all admin operations via ?action= query param.
// This pattern keeps the project under Vercel Hobby's 12-function limit.
//
// Actions:
//   GET ?action=users&q=&page=&limit=
//   GET ?action=user&sub=<sub>
//   GET ?action=jobs
//   GET ?action=metrics
//   GET ?action=audit&action_filter=&since=
//   GET ?action=transactions       (stub — see note)
//   GET ?action=analytics&days=30  (returns daily counters + unique-session counts)
//   GET ?action=feature-flags
//   POST ?action=feature-flag-set  body: { key, value }
//   POST ?action=user-action       body: { action, targetUserSub }
//
// Public-safe diagnostic actions (no admin auth required — return env-presence flags only):
//   GET  ?action=bot-status        boolean flags for Meta WhatsApp + Anthropic env vars
//   GET  ?action=errors-count      KV `errors:24h` count if available
//   POST ?action=test-webhook      body: { phone, text } — stub: echoes what a webhook call would do
//
// All other actions require admin auth (requireAdmin).

import { requireAdmin } from '../lib/auth.js';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

async function kvFetch(path, opts = {}) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, kvOutage: true };
  const r = await fetch(`${url}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

// Returns the matched keys, or `null` to SIGNAL a KV outage (so callers can
// answer 503 instead of masking the failure as an empty result set).
//
// The distinction is critical for the admin dashboard: a scan that legitimately
// finds zero keys must return [] (a healthy, empty result -> 200), while a
// transport failure must be detectable. kvFetch reports an outage as
// { ok:false, kvOutage:true } (missing env vars or a non-2xx KV response), so
// if the VERY FIRST cursor fetch is not ok we never reached KV at all -> return
// null. A failure on a later cursor (partial pagination) keeps the prior
// behavior of returning the keys gathered so far.
async function kvScan(pattern, count = 100) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 20; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok) {
      // First fetch failed -> we never reached a healthy KV: signal the outage
      // so the handler returns 503 kv_outage rather than a misleading empty 200.
      if (i === 0) return null;
      break;
    }
    cursor = r.result?.[0] || '0';
    const batch = r.result?.[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys;
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const path = '/mget/' + keys.map(encodeURIComponent).join('/');
  const r = await kvFetch(path);
  return (r.result || []).map(v => { try { return JSON.parse(v); } catch { return null; } });
}

function sanitizeUser(u) {
  if (!u) return null;
  const { refreshToken, refreshTokenEnvelope, accessToken, ...safe } = u;
  return safe;
}

function kvOutage(res) {
  return res.status(503).json({ ok: false, error: 'kv_outage', detail: 'KV_REST_API_URL/TOKEN env vars not configured' });
}

// =============================================================
// Action handlers
// =============================================================

async function listUsers(req, res) {
  const q = String(req.query.q || '').toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const keys = await kvScan('user:*');
  if (keys === null) return kvOutage(res);
  const users = (await kvMget(keys)).map(sanitizeUser).filter(Boolean);
  let filtered = users;
  if (q) filtered = users.filter(u => (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q));
  filtered.sort((a, b) => (b.connectedAt || '').localeCompare(a.connectedAt || ''));
  const total = filtered.length;
  const slice = filtered.slice((page - 1) * limit, page * limit).map(u => ({
    sub: u.userSub || u.sub,
    email: u.email,
    name: u.name,
    plan: u.plan || 'free',
    subscriptionStatus: u.subscriptionStatus,
    createdAt: u.connectedAt,
    lastActive: u.lastActive,
    hasSheet: !!u.spreadsheetId,
  }));
  res.setHeader('Cache-Control', 'private, max-age=30'); // dedupe the admin's repeated polls; this handler does a full user:* kvScan + MGET every call
  return res.status(200).json({ ok: true, users: slice, total, page, limit });
}

async function getUser(req, res) {
  const sub = String(req.query.sub || '').trim();
  if (!sub || !/^[A-Za-z0-9_\-]+$/.test(sub) || sub.length > 100) {
    return res.status(400).json({ ok: false, error: 'invalid_sub' });
  }
  const r = await kvFetch(`/get/${encodeURIComponent('user:' + sub)}`);
  // Catch BOTH outage flavours: env-unconfigured (r.kvOutage) AND a runtime KV
  // failure (r.ok === false with no flag). Otherwise a real outage falls through
  // to a misleading 404 user_not_found instead of a 503 — same masking class as
  // the kvScan bug. r.result null on a healthy KV still correctly yields 404.
  if (!r.ok) return kvOutage(res);
  const user = r.result ? JSON.parse(r.result) : null;
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  return res.status(200).json({ ok: true, user: sanitizeUser(user) });
}

// All onboarding questionnaire (profile) responses — so the owner can see WHY
// people sign up (tracking type, recurring, auto-log preference) and optimize.
async function listQuestionnaires(req, res) {
  const keys = await kvScan('profile:*');
  if (keys === null) return kvOutage(res);
  const profiles = await kvMget(keys);
  const items = [];
  const byTrackingType = {}, byAutoLogPref = {};
  let hasRecurringCount = 0;
  keys.forEach((k, i) => {
    const p = profiles[i];
    if (!p) return;
    const t = p.trackingType || 'unknown';
    byTrackingType[t] = (byTrackingType[t] || 0) + 1;
    if (p.autoLogPref) byAutoLogPref[p.autoLogPref] = (byAutoLogPref[p.autoLogPref] || 0) + 1;
    if (p.hasRecurring) hasRecurringCount++;
    items.push({
      phone: k.replace(/^profile:/, ''),
      trackingType: p.trackingType || null,
      autoLogPref: p.autoLogPref || null,
      hasRecurring: !!p.hasRecurring,
      updatedAt: p.updatedAt || null,
    });
  });
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return res.status(200).json({
    ok: true,
    total: items.length,
    summary: { byTrackingType, byAutoLogPref, hasRecurringCount },
    questionnaires: items,
  });
}

// Registration health — Steven's hard rule: a customer must NEVER finish
// registration without a sheet appearing. The bot can only serve a customer
// when the WHOLE chain is intact: user:{sub} → canonical sheet:{sub} AND a
// phone:{E164} mapping (carrying userSub + spreadsheetId that match the
// canonical sheet — this is exactly what /api/sheet/append resolves on every
// write). This endpoint scans every user and every phone link, and classifies:
//   - orphans:          registered but NO canonical sheet      (critical)
//   - pendingPhoneLink:  has sheet but WhatsApp not linked yet  (expected, nudge)
//   - brokenPhone:       a phone:* points to a missing/mismatched sheet (critical)
async function registrationHealth(req, res) {
  const userKeys = await kvScan('user:*');
  if (userKeys === null) return kvOutage(res);
  const users = await kvMget(userKeys);
  const subs = [];
  const userBySub = {};
  userKeys.forEach((k, i) => {
    const u = users[i];
    if (!u) return;
    const sub = u.userSub || u.sub || k.replace(/^user:/, '');
    subs.push(sub);
    userBySub[sub] = u;
  });
  const sheetMaps = subs.length ? await kvMget(subs.map(s => 'sheet:' + s)) : [];
  const canonBySub = {};
  subs.forEach((sub, i) => { canonBySub[sub] = sheetMaps[i]?.spreadsheetId || null; });

  // Scan every phone link → which subs have a usable WhatsApp mapping, and which
  // phone records are broken (point at a sub whose canonical sheet is missing or
  // disagrees with the phone record's spreadsheetId).
  const phoneKeys = await kvScan('phone:*');
  if (phoneKeys === null) return kvOutage(res); // KV went down mid-request — fail loud, don't report a partial picture
  const phoneRecs = phoneKeys.length ? await kvMget(phoneKeys) : [];
  const phoneLinkedSubs = new Set();
  const brokenPhone = [];
  phoneKeys.forEach((k, i) => {
    const p = phoneRecs[i];
    if (!p) return;
    const e164 = k.replace(/^phone:/, '');
    const linkedSub = p.userSub || null;
    const phoneSheet = p.spreadsheetId || null;
    const canon = linkedSub ? canonBySub[linkedSub] : null;
    if (linkedSub && phoneSheet && canon && phoneSheet === canon) {
      phoneLinkedSubs.add(linkedSub);
      return;
    }
    // Anything else is a broken link the bot would fail (or misroute) on.
    brokenPhone.push({
      phone: e164,
      linkedSub,
      phoneSheet,
      canonicalSheet: canon,
      reason: !linkedSub ? 'phone_record_missing_userSub'
        : !phoneSheet ? 'phone_record_missing_sheet'
        : !canon ? 'no_canonical_sheet_for_sub'
        : 'phone_sheet_mismatch_canonical',
    });
  });

  const orphans = [];
  const pendingPhoneLink = [];
  let healthy = 0;
  subs.forEach((sub) => {
    const u = userBySub[sub];
    const userSheetId = u.spreadsheetId || null;
    const canonSheetId = canonBySub[sub];
    const phoneLinked = phoneLinkedSubs.has(sub);
    if (canonSheetId && phoneLinked) { healthy++; return; }
    const base = { sub, email: u.email || null, phone: u.phone || u.phoneE164 || null, connectedAt: u.connectedAt || null };
    if (!canonSheetId) {
      orphans.push({
        ...base,
        hasUserSpreadsheetId: !!userSheetId,
        hasCanonicalSheetMapping: false,
        reason: userSheetId ? 'user_has_sheet_but_no_bot_mapping' : 'no_sheet_at_all',
      });
    } else {
      // Has a usable sheet, just hasn't linked WhatsApp yet — expected interim state.
      pendingPhoneLink.push({ ...base, spreadsheetId: canonSheetId });
    }
  });
  orphans.sort((a, b) => String(b.connectedAt || '').localeCompare(String(a.connectedAt || '')));
  pendingPhoneLink.sort((a, b) => String(b.connectedAt || '').localeCompare(String(a.connectedAt || '')));
  res.setHeader('Cache-Control', 'private, max-age=30'); // dedupe the admin's repeated polls; this handler does full user:* + phone:* kvScans + MGET every call
  return res.status(200).json({
    ok: true,
    totalUsers: subs.length,
    healthy,
    orphanCount: orphans.length,
    orphans,
    pendingPhoneLinkCount: pendingPhoneLink.length,
    pendingPhoneLink,
    brokenPhoneCount: brokenPhone.length,
    brokenPhone,
    note: (orphans.length === 0 && brokenPhone.length === 0)
      ? 'every registered user has a usable sheet'
      : 'these users registered but have no usable sheet — investigate / re-provision',
  });
}

async function listJobs(req, res) {
  const failed = await kvScan('job:failed:*');
  const retry = await kvScan('job:retry:*');
  if (failed === null || retry === null) return kvOutage(res);
  const items = await kvMget([...failed, ...retry]);
  const jobs = items.filter(Boolean).map(j => ({
    id: j.id, type: j.type, lastError: (j.lastError || '').slice(0, 200), attempts: j.attempts || 0, nextRetry: j.nextRetry,
  }));
  return res.status(200).json({ ok: true, jobs });
}

async function getMetrics(req, res) {
  const userKeys = await kvScan('user:*');
  if (userKeys === null) return kvOutage(res);
  const users = (await kvMget(userKeys)).filter(Boolean);
  const byPlan = { free: 0, pro: 0, family: 0 };
  for (const u of users) byPlan[u.plan || 'free'] = (byPlan[u.plan || 'free'] || 0) + 1;
  const PRO_PRICE = 19, FAMILY_PRICE = 39;
  const mrr = byPlan.pro * PRO_PRICE + byPlan.family * FAMILY_PRICE;

  // last_inbound:* gives MAU/DAU (TTL is 25h so this is "active recently")
  const inboundKeys = await kvScan('last_inbound:*');
  const inboundCount = (inboundKeys || []).length;

  res.setHeader('Cache-Control', 'private, max-age=30'); // dedupe the admin's repeated polls; this handler does a full user:* + last_inbound:* kvScan + MGET every call
  return res.status(200).json({
    ok: true,
    metrics: {
      totalUsers: users.length,
      byPlan,
      paidUsers: byPlan.pro + byPlan.family,
      mrr,
      dau: inboundCount, // lower bound — only users active in last 25h
      mau: inboundCount,
      errors24h: null,
    },
    notes: ['mau is a 25h-lower-bound based on last_inbound TTL', 'errors24h pending log aggregator wiring'],
  });
}

async function listAudit(req, res) {
  const actionFilter = String(req.query.action_filter || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const pattern = actionFilter ? `audit:${actionFilter}:*` : 'audit:*';
  const keys = await kvScan(pattern);
  if (keys === null) return kvOutage(res);
  keys.sort((a, b) => b.localeCompare(a)); // newest first by lexical sort on timestamp
  const top = keys.slice(0, limit);
  const events = (await kvMget(top)).filter(Boolean);
  return res.status(200).json({ ok: true, events, total: keys.length });
}

// =============================================================
// Analytics — returns last N days of per-event counters + unique session counts.
// Reads keys written by /api/analytics:
//   analytics:<YYYY-MM-DD>:<event>         (INCR counter)
//   analytics:session:<YYYY-MM-DD>:<event> (SADD set of sessions)
// =============================================================
const ANALYTICS_EVENTS = [
  'page_view',
  'cta_click',
  'signup_start',
  'signup_complete',
  'sheet_provisioned',
  'first_message_received',
  'subscribe_clicked',
  'export_downloaded',
  'feature_used',
];

function lastNDates(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function kvScard(key) {
  const r = await kvFetch(`/scard/${encodeURIComponent(key)}`);
  if (!r.ok) return 0;
  return r.result || 0;
}

async function getAnalytics(req, res) {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
  const dates = lastNDates(days);

  // First scan to verify KV is reachable; SCAN returns [] when nothing yet — that's fine.
  const probe = await kvScan('analytics:*', 10);
  if (probe === null) return kvOutage(res);

  // For each date × event, MGET counters in one batch, SCARD sessions individually.
  const counterKeys = [];
  for (const date of dates) {
    for (const ev of ANALYTICS_EVENTS) counterKeys.push(`analytics:${date}:${ev}`);
  }
  const counterVals = await kvMget(counterKeys);

  // For unique-session counts, fan out SCARDs (one per date×event).
  // 30 × 9 = 270 max — well within Vercel function budget.
  const sessionPromises = [];
  for (const date of dates) {
    for (const ev of ANALYTICS_EVENTS) sessionPromises.push(kvScard(`analytics:session:${date}:${ev}`));
  }
  const sessionVals = await Promise.all(sessionPromises);

  const daysOut = dates.map((date, dIdx) => {
    const events = {};
    const uniqueSessions = {};
    for (let eIdx = 0; eIdx < ANALYTICS_EVENTS.length; eIdx++) {
      const ev = ANALYTICS_EVENTS[eIdx];
      const flatIdx = dIdx * ANALYTICS_EVENTS.length + eIdx;
      const raw = counterVals[flatIdx];
      // counterVals comes through kvMget which JSON.parses — INCR returns plain number
      // stored as a string; both cases handled.
      let n = 0;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string') n = parseInt(raw, 10) || 0;
      events[ev] = n;
      uniqueSessions[ev] = sessionVals[flatIdx] || 0;
    }
    return { date, events, unique_sessions: uniqueSessions };
  });

  // Aggregate funnel totals across the window
  const funnelEvents = ['page_view', 'signup_start', 'signup_complete', 'sheet_provisioned', 'first_message_received'];
  const totals = {};
  for (const ev of ANALYTICS_EVENTS) totals[ev] = daysOut.reduce((s, d) => s + (d.events[ev] || 0), 0);
  const funnel = funnelEvents.map(ev => ({ event: ev, count: totals[ev] }));

  return res.status(200).json({
    ok: true,
    window_days: days,
    events: ANALYTICS_EVENTS,
    days: daysOut,
    totals,
    funnel,
  });
}

async function getFeatureFlags(req, res) {
  const keys = await kvScan('flag:*');
  if (keys === null) return kvOutage(res);
  const vals = await kvMget(keys);
  const flags = {};
  keys.forEach((k, i) => { flags[k.replace(/^flag:/, '')] = vals[i]?.value ?? null; });
  return res.status(200).json({ ok: true, flags });
}

async function setFeatureFlag(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const key = String(body?.key || '').trim();
  const value = body?.value;
  if (!key || !/^[a-z0-9_\-.]+$/i.test(key)) return res.status(400).json({ ok: false, error: 'invalid_key' });
  const r = await kvFetch(`/set/${encodeURIComponent('flag:' + key)}`, { method: 'POST', body: { value, updatedAt: new Date().toISOString(), by: req.user.email } });
  // Same fix as getUser: a runtime KV failure (r.ok === false, no kvOutage flag)
  // must 503, not falsely 200 "saved" when the SET never landed.
  if (!r.ok) return kvOutage(res);
  log.info('admin.flag_set', { reqId: req.reqId, key, value, by: req.user.email });
  return res.status(200).json({ ok: true, key, value });
}

async function userAction(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = String(body?.action || '').trim();
  const targetUserSub = String(body?.targetUserSub || '').trim();
  const allowedActions = ['resend_welcome', 'force_resync', 'reset_plan_to_free', 'pause_account', 'unpause_account'];
  if (!allowedActions.includes(action)) {
    return res.status(400).json({ ok: false, error: 'invalid_action', allowed: allowedActions });
  }
  if (!targetUserSub || !/^[A-Za-z0-9_\-]+$/.test(targetUserSub)) {
    return res.status(400).json({ ok: false, error: 'invalid_target' });
  }
  // Audit log
  const auditKey = `audit:admin_${action}:${Date.now()}:${targetUserSub.slice(0, 8)}`;
  await kvFetch(`/set/${encodeURIComponent(auditKey)}`, {
    method: 'POST',
    body: { ts: new Date().toISOString(), action, target: targetUserSub, actor: req.user.email, reqId: req.reqId },
  });
  log.info('admin.user_action', { reqId: req.reqId, action, targetUserSub, actor: req.user.email });
  return res.status(200).json({ ok: true, action, target: targetUserSub, queued: true, note: 'audit logged; actual execution pending downstream worker' });
}

// =============================================================
// Public-safe diagnostic actions (no admin auth — return only flags/counts)
// =============================================================

// Whitelist of actions that may run without an admin Bearer token.
// These return ONLY booleans / counts / non-sensitive metadata.
const PUBLIC_DIAG_ACTIONS = new Set(['bot-status', 'errors-count', 'test-webhook']);

function publicBotStatus(req, res) {
  // Returns ONLY genuinely-public identifiers (the Meta phone id + bot number are
  // public; the webhook URL is fixed). Secret-PRESENCE flags (meta_*_configured /
  // anthropic_*) were REMOVED from this UNAUTHENTICATED response — they leaked
  // config posture to anyone. Read them via the authenticated config-drift action.
  return res.status(200).json({
    ok: true,
    bot: {
      meta_phone_number_id: process.env.META_PHONE_NUMBER_ID || null, // public-safe identifier
      configured_bot_phone_e164: process.env.BOT_PHONE_E164 || null,
      webhook_url: `${(req.headers['x-forwarded-proto'] || 'https')}://${req.headers.host || 'kesefle.vercel.app'}/api/whatsapp/webhook`,
    },
    checked_at: new Date().toISOString(),
  });
}

async function publicErrorsCount(req, res) {
  // Best-effort: read `errors:24h` KV key. Returns 0 if KV unreachable.
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return res.status(200).json({ ok: true, errors_24h: null, source: 'kv_unconfigured' });
  }
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent('errors:24h')}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    const raw = j?.result;
    const count = raw == null ? 0 : (typeof raw === 'number' ? raw : parseInt(raw, 10) || 0);
    return res.status(200).json({ ok: true, errors_24h: count, source: 'kv' });
  } catch (e) {
    return res.status(200).json({ ok: true, errors_24h: null, source: 'kv_error', error: e.message });
  }
}

async function publicTestWebhook(req, res) {
  // Stub: simulates what /api/whatsapp/webhook would receive WITHOUT actually
  // dispatching or calling Meta. Returns the payload echo for debugging.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const phone = String(body?.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  const text = String(body?.text || '').slice(0, 500);
  if (!phone || !text) {
    return res.status(400).json({ ok: false, error: 'missing_fields', required: ['phone', 'text'] });
  }
  // Build the payload shape Meta would POST to our webhook
  const simulated_payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'SIMULATED_WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: process.env.BOT_PHONE_E164 || 'unknown',
            phone_number_id: process.env.META_PHONE_NUMBER_ID || 'unknown',
          },
          contacts: [{ profile: { name: 'Diagnostic Tester' }, wa_id: phone.replace(/^\+/, '') }],
          messages: [{
            from: phone.replace(/^\+/, ''),
            id: 'wamid.SIMULATED_' + Date.now(),
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
      }],
    }],
  };
  return res.status(200).json({
    ok: true,
    note: 'Stub: this payload was built but NOT dispatched. Use it as a test-only reference.',
    simulated_payload,
    next_step: 'curl -X POST $WEBHOOK_URL -H "Content-Type: application/json" -d \'<simulated_payload>\'',
  });
}

async function dispatchPublicDiag(req, res) {
  const action = String(req.query.action || '').trim();
  if (req.method === 'GET') {
    if (action === 'bot-status') return publicBotStatus(req, res);
    if (action === 'errors-count') return publicErrorsCount(req, res);
  }
  if (req.method === 'POST' && action === 'test-webhook') return publicTestWebhook(req, res);
  return res.status(405).json({ ok: false, error: 'method_not_allowed_for_diag', action });
}

// =============================================================
// Main dispatcher
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) return res.status(400).json({ ok: false, error: 'missing_action_param', hint: 'use ?action=users|user|jobs|metrics|analytics|audit|feature-flags|questionnaires|registration-health|feature-flag-set|user-action|transactions|bot-status|errors-count|test-webhook' });

  if (req.method === 'GET') {
    switch (action) {
      case 'users': return listUsers(req, res);
      case 'user': return getUser(req, res);
      case 'jobs': return listJobs(req, res);
      case 'metrics': return getMetrics(req, res);
      case 'analytics': return getAnalytics(req, res);
      case 'audit': return listAudit(req, res);
      case 'feature-flags': return getFeatureFlags(req, res);
      case 'questionnaires': return listQuestionnaires(req, res);
      case 'registration-health': return registrationHealth(req, res);
      case 'transactions':
        return res.status(200).json({ ok: true, transactions: [], note: 'requires per-user sheet proxy — not implemented for privacy' });
      default: return res.status(400).json({ ok: false, error: 'unknown_action', action });
    }
  }
  if (req.method === 'POST') {
    switch (action) {
      case 'feature-flag-set': return setFeatureFlag(req, res);
      case 'user-action': return userAction(req, res);
      default: return res.status(400).json({ ok: false, error: 'unknown_post_action', action });
    }
  }
  return res.status(405).json({ ok: false, error: 'method_not_allowed', allowed: ['GET', 'POST'] });
}

// Wrap once: the rate-limited admin handler (requires OAuth Bearer).
const adminHandler = withRequestId(
  withRateLimit({ key: 'admin', limit: 60, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);

// Public diagnostic dispatcher (no auth, still rate-limited).
const publicDiagHandler = withRequestId(
  withRateLimit({ key: 'admin_diag', limit: 30, windowSec: 60 })(
    dispatchPublicDiag
  )
);

// Top-level export — routes public-safe diagnostic actions before requireAdmin.
export default async function topLevel(req, res) {
  const action = String((req.query && req.query.action) || '').trim();
  if (PUBLIC_DIAG_ACTIONS.has(action)) {
    return publicDiagHandler(req, res);
  }
  return adminHandler(req, res);
}
