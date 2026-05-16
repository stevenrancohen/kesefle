// /api/admin/user/[sub]
// GET — detailed view of a single user for the admin SPA.
//
// Path: /api/admin/user/<google-sub>
//
// Returns:
//   { ok, user: { ... sanitized record ... },
//     sheet: { spreadsheetId, spreadsheetUrl, provisioned } | null,
//     audit: [ ...last 10 audit events for this sub ... ],
//     reqId }
//
// Notes:
//   - Vercel dynamic route file naming: api/admin/user/[sub].js → req.query.sub
//   - Audit search uses a SCAN over `audit:*` filtered by sub hash. The audit
//     entries written by lib/secure-kv.js auditLog() embed a subHash, not the
//     raw sub, so we compute the same SHA-256 prefix to match.
//   - refreshToken / accessToken stripped via sanitizeUser before serialization.

import crypto from 'node:crypto';
import { requireAdmin } from '../../../lib/auth.js';
import { withRequestId, log } from '../../../lib/log.js';
import { withRateLimit } from '../../../lib/ratelimit.js';
import {
  kvScan, kvMGet, kvGet, sanitizeUser, kvConfigured, kvOutage,
} from '../_kv.js';

function logIdHash(sub) {
  return crypto.createHash('sha256').update('log:' + String(sub)).digest('hex').slice(0, 16);
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  // Vercel passes dynamic segments via req.query
  const sub = String(req.query?.sub || '').trim();
  if (!sub || sub.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(sub)) {
    return res.status(400).json({ ok: false, error: 'invalid_sub', reqId });
  }

  const [userRaw, sheet] = await Promise.all([
    kvGet('user:' + sub),
    kvGet('sheet:' + sub),
  ]);

  if (!userRaw) {
    return res.status(404).json({ ok: false, error: 'user_not_found', reqId });
  }

  const safe = sanitizeUser(userRaw);

  // Look up audit events. The audit key shape is:
  //   audit:<action>:<ts-ms>:<subHash-first-8>
  // We scan audit:* and filter by subHash prefix in JS — simpler than juggling
  // a per-user index, and audit cardinality is bounded by the 730-day TTL.
  const subHashPrefix = logIdHash(sub).slice(0, 8);
  const scan = await kvScan({ match: 'audit:*', count: 200, maxKeys: 2000 });
  let audit = [];
  if (scan.ok) {
    // Fast path: filter by key suffix before MGET
    const candidateKeys = scan.keys.filter((k) => k.endsWith(':' + subHashPrefix));
    const { values } = await kvMGet(candidateKeys);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v && typeof v === 'object') {
        audit.push({ key: candidateKeys[i], ...v });
      }
    }
    // Sort newest first; cap at 10
    audit.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    audit = audit.slice(0, 10);
  }

  log.info('admin.user.viewed', {
    reqId,
    adminEmail: req.user.email,
    targetSubHash: logIdHash(sub),
    auditFound: audit.length,
    hasSheet: !!sheet,
  });

  return res.status(200).json({
    ok: true,
    user: {
      sub: safe.userSub || sub,
      email: safe.email || null,
      name: safe.name || null,
      picture: safe.picture || null,
      provider: safe.provider || null,
      emailVerified: !!safe.emailVerified,
      phoneE164: safe.phoneE164 || null,
      phoneVerified: !!safe.phoneVerified,
      plan: safe.plan || 'free',
      subscriptionStatus: safe.subscriptionStatus || null,
      stripeCustomerId: safe.stripeCustomerId || null,
      stripeSubscriptionId: safe.stripeSubscriptionId || null,
      currentPeriodEnd: safe.currentPeriodEnd || null,
      subscribedAt: safe.subscribedAt || null,
      canceledAt: safe.canceledAt || null,
      firstSeen: safe.firstSeen || null,
      lastSeen: safe.lastSeen || null,
      connectedAt: safe.connectedAt || null,
      status: safe.status || 'active',
      hasRefreshToken: typeof safe.refreshToken === 'string' && safe.refreshToken.length > 0,
      spreadsheetId: safe.spreadsheetId || null,
    },
    sheet: sheet || null,
    audit,
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_user_detail', limit: 120, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
