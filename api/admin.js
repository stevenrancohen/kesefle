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
//   GET ?action=feature-flags
//   POST ?action=feature-flag-set  body: { key, value }
//   POST ?action=user-action       body: { action, targetUserSub }
//
// All require admin auth (requireAdmin).

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

async function kvScan(pattern, count = 100) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 20; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok) break;
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
  return res.status(200).json({ ok: true, users: slice, total, page, limit });
}

async function getUser(req, res) {
  const sub = String(req.query.sub || '').trim();
  if (!sub || !/^[A-Za-z0-9_\-]+$/.test(sub) || sub.length > 100) {
    return res.status(400).json({ ok: false, error: 'invalid_sub' });
  }
  const r = await kvFetch(`/get/${encodeURIComponent('user:' + sub)}`);
  if (r.kvOutage) return kvOutage(res);
  const user = r.result ? JSON.parse(r.result) : null;
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  return res.status(200).json({ ok: true, user: sanitizeUser(user) });
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
  if (r.kvOutage) return kvOutage(res);
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
// Main dispatcher
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) return res.status(400).json({ ok: false, error: 'missing_action_param', hint: 'use ?action=users|user|jobs|metrics|audit|feature-flags|feature-flag-set|user-action|transactions' });

  if (req.method === 'GET') {
    switch (action) {
      case 'users': return listUsers(req, res);
      case 'user': return getUser(req, res);
      case 'jobs': return listJobs(req, res);
      case 'metrics': return getMetrics(req, res);
      case 'audit': return listAudit(req, res);
      case 'feature-flags': return getFeatureFlags(req, res);
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

export default withRequestId(
  withRateLimit({ key: 'admin', limit: 60, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
