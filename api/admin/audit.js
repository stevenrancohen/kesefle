// /api/admin/audit
// GET — search the audit log.
//
// Query params:
//   ?action=account_deleted   (exact action match; optional)
//   ?since=2026-05-01         (ISO date; optional, default = last 30 days)
//   ?until=2026-05-16         (ISO date; optional, default = now)
//   ?limit=200                (cap on returned events; default 200, max 1000)
//
// Returns:
//   { ok, events: [{ key, ts, action, subHash, reqId, metadata }],
//     total, truncated, reqId }
//
// Audit key shape (written by lib/secure-kv.js auditLog()):
//   audit:<action>:<ts-ms>:<subHash-first-8>
//
// We use the action prefix in the SCAN match pattern when provided — that lets
// KV do the filtering server-side, instead of fetching the world and dropping
// nine tenths of it.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvScan, kvMGet, kvConfigured, kvOutage } from './_kv.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const AUDIT_SCAN_BUDGET = 5000;
const ACTION_ALLOWED = /^[a-z0-9_]{1,64}$/;

function clampLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseISO(v, fallback) {
  if (!v || typeof v !== 'string') return fallback;
  const d = new Date(v);
  if (isNaN(d.getTime())) return fallback;
  return d;
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  const limit = clampLimit(req.query?.limit);
  const action = typeof req.query?.action === 'string' ? req.query.action.trim() : '';
  if (action && !ACTION_ALLOWED.test(action)) {
    return res.status(400).json({ ok: false, error: 'invalid_action_format', reqId });
  }

  const defaultSince = new Date(Date.now() - 30 * 86400_000);
  const since = parseISO(req.query?.since, defaultSince);
  const until = parseISO(req.query?.until, new Date());
  if (since > until) {
    return res.status(400).json({ ok: false, error: 'since_after_until', reqId });
  }

  const match = action ? `audit:${action}:*` : 'audit:*';
  const scan = await kvScan({ match, count: 500, maxKeys: AUDIT_SCAN_BUDGET });
  if (!scan.ok) {
    log.error('admin.audit.scan_failed', { reqId, error: scan.error });
    return kvOutage(res, reqId, 'SCAN over audit:* failed');
  }

  // Pre-filter by ts embedded in the key to skip MGET on out-of-range entries
  // (key shape: audit:<action>:<ts-ms>:<subHash>).
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  const inRangeKeys = scan.keys.filter((k) => {
    const parts = k.split(':');
    if (parts.length < 4) return false;
    const ts = parseInt(parts[parts.length - 2], 10);
    if (!Number.isFinite(ts)) return false;
    return ts >= sinceMs && ts <= untilMs;
  });

  // Sort newest-first by ts-in-key, then cap before MGET.
  inRangeKeys.sort((a, b) => {
    const ats = parseInt(a.split(':').at(-2), 10) || 0;
    const bts = parseInt(b.split(':').at(-2), 10) || 0;
    return bts - ats;
  });
  const slicedKeys = inRangeKeys.slice(0, limit);

  const { values } = await kvMGet(slicedKeys, { concurrency: 20 });
  const events = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!v || typeof v !== 'object') continue;
    events.push({
      key: slicedKeys[i],
      ts: v.ts || null,
      action: v.action || slicedKeys[i].split(':')[1] || null,
      subHash: v.subHash || null,
      reqId: v.reqId || null,
      metadata: v.metadata || {},
    });
  }

  log.info('admin.audit.queried', {
    reqId, adminEmail: req.user.email,
    action: action || 'any', since: since.toISOString(), until: until.toISOString(),
    matched: events.length, scanned: scan.keys.length,
  });

  return res.status(200).json({
    ok: true,
    events,
    total: inRangeKeys.length,
    returned: events.length,
    truncated: inRangeKeys.length > events.length || !!scan.truncated,
    range: { since: since.toISOString(), until: until.toISOString() },
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_audit', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
