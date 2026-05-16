// /api/admin/users
// GET — paginated list of users for the admin SPA.
//
// Query params:
//   ?page=1            (1-indexed; default 1)
//   ?limit=50          (max 200; default 50)
//   ?q=email-fragment  (case-insensitive substring match on email or name)
//
// Returns:
//   { ok, users: [{ sub, email, name, plan, subscriptionStatus,
//                   createdAt, lastActive, hasSheet }],
//     total, page, limit, scanCursor }
//
// Implementation notes:
//   - We SCAN over `user:*` keys (Upstash cursor-based pagination, see _kv.js).
//   - We hard-cap the scan at 1000 keys per request — if the user base ever
//     outgrows that, the admin SPA should switch to passing scanCursor for the
//     next page rather than offset paging. For now, KESEFLE is < 1k users.
//   - refreshToken / accessToken / encrypted envelopes are stripped before
//     leaving the function (sanitizeUser).
//   - Auth: requireAdmin verifies Google ID token AND checks ADMIN_EMAILS.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvScan, kvMGet, sanitizeUser, kvConfigured, kvOutage } from './_kv.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const SCAN_BUDGET = 1000;

function parsePositiveInt(v, fallback, max = Infinity) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function matchesQuery(rec, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = `${rec.email || ''} ${rec.name || ''}`.toLowerCase();
  return hay.includes(needle);
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  const page = parsePositiveInt(req.query?.page, 1);
  const limit = parsePositiveInt(req.query?.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const q = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  const scan = await kvScan({ match: 'user:*', count: 200, maxKeys: SCAN_BUDGET });
  if (!scan.ok) {
    log.error('admin.users.scan_failed', { reqId, error: scan.error });
    return kvOutage(res, reqId, 'SCAN over user:* failed');
  }

  const { values: records } = await kvMGet(scan.keys);

  const filtered = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec !== 'object') continue;
    if (!matchesQuery(rec, q)) continue;
    const safe = sanitizeUser(rec);
    filtered.push({
      sub: safe.userSub || scan.keys[i]?.slice('user:'.length) || null,
      email: safe.email || null,
      name: safe.name || null,
      plan: safe.plan || 'free',
      subscriptionStatus: safe.subscriptionStatus || null,
      createdAt: safe.firstSeen || safe.connectedAt || null,
      lastActive: safe.lastSeen || null,
      hasSheet: !!safe.spreadsheetId,
    });
  }

  // Stable sort: most-recently-active first (null lastActive sinks).
  filtered.sort((a, b) => {
    const av = a.lastActive || '';
    const bv = b.lastActive || '';
    return bv.localeCompare(av);
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  const slice = filtered.slice(start, start + limit);

  log.info('admin.users.listed', {
    reqId,
    adminEmail: req.user.email,
    scanned: scan.keys.length,
    matched: total,
    page,
    limit,
    truncated: !!scan.truncated,
  });

  return res.status(200).json({
    ok: true,
    users: slice,
    total,
    page,
    limit,
    scanTruncated: !!scan.truncated,
    scanCursor: scan.nextCursor || '0',
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_users', limit: 60, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
