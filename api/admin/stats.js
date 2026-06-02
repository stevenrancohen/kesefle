// Admin-only stats endpoint. Returns aggregate counts across the Vercel KV
// store so the /admin/monitor.html dashboard can render at-a-glance health.
//
// Auth (two modes, both accepted for backward compatibility):
//   1. PREFERRED: requireAdmin — Google ID token (Bearer) or cookie session,
//      with email matched against ADMIN_EMAILS. Used by modern admin pages
//      and the unified admin auth pipeline (e.g. /admin/launch-monitor).
//   2. LEGACY (deprecated): ADMIN_TOKEN Bearer — used by /admin/monitor.html
//      which still gates via a localStorage password. Kept working so
//      existing admin sessions don't break, but new admin pages should use
//      the Google-OAuth-backed requireAdmin path.
//
// Rate limit: 30/min per admin/IP — defense-in-depth in case the legacy
// ADMIN_TOKEN leaks (rate limit caps brute force).
//
// Steven 2026-05-30 (deep-review PR #152 WS4 follow-up): migrated from raw
// Bearer-only auth to requireAdmin + withRateLimit. Legacy ADMIN_TOKEN
// path retained so /admin/monitor.html keeps working without forcing a
// re-login. Plan: deprecate ADMIN_TOKEN after monitor.html migrates to
// the Google-OAuth admin flow.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import { withRateLimit } from '../../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function kvScan(pattern, maxIterations = 50) {
  let cursor = '0';
  let count = 0;
  const samples = [];
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(
      `${KV_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/200`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`KV scan ${res.status}`);
    const j = await res.json();
    const result = j.result || [];
    cursor = String(result[0] || '0');
    const keys = result[1] || [];
    count += keys.length;
    if (samples.length < 5) samples.push(...keys.slice(0, 5 - samples.length));
    if (cursor === '0') break;
  }
  return { count, samples };
}

async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result;
}

// Constant-time string compare to avoid a timing oracle on the admin token.
function ctEq(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Core handler — runs only after one of the auth modes has accepted.
async function handlerCore(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'kv_not_configured' });
    return;
  }

  try {
    const [phones, families, premium, globalLearn, tokens, lastPing] = await Promise.all([
      kvScan('phone:of:*'),
      kvScan('family:*'),
      kvScan('sub:*'),
      kvScan('global_learn:*'),
      kvScan('token:*'),
      kvGetRaw('stat:bot_last_ping'),
    ]);

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      users: {
        linkedPhones: phones.count,
        signups: tokens.count,
        premium: premium.count,
      },
      families: {
        total: families.count - phones.count, // family:of:* is duplicated under phone:of:* sometimes; rough estimate
      },
      learning: {
        globalEntries: globalLearn.count,
      },
      health: {
        botLastPing: lastPing ? (typeof lastPing === 'string' ? lastPing : JSON.stringify(lastPing)) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'stats_failed', detail: e.message });
  }
}

// Compose the two auth paths:
//   - legacyRateLimited: withRateLimit → handlerCore
//       Used by the legacy ADMIN_TOKEN path (when the Bearer token matches
//       process.env.ADMIN_TOKEN). Same rate-limit bucket as the modern path.
//   - adminWrapped: requireAdmin → withRateLimit → handlerCore
//       The modern Google-OAuth admin path. requireAdmin runs first to
//       populate req.user, then rate-limit (keyed by userSub).
const legacyRateLimited = withRateLimit({ key: 'admin_stats', limit: 30, windowSec: 60 })(handlerCore);
const adminWrapped = requireAdmin(legacyRateLimited);

// Dispatcher: try legacy ADMIN_TOKEN Bearer first (so existing
// /admin/monitor.html keeps working without re-login). If the Bearer
// looks like a Google ID token (JWT — 3 dot-segments, > 100 chars),
// skip the legacy path entirely and let requireAdmin verify it.
// Missing/invalid both fall through to the modern requireAdmin pipeline
// which returns 401/403 as appropriate.
async function dispatch(req, res) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const looksLikeJwt = bearer && bearer.split('.').length === 3 && bearer.length > 100;
  if (bearer && !looksLikeJwt) {
    // Legacy ADMIN_TOKEN path attempted.
    if (!ADMIN_TOKEN) {
      // Same 503 semantics as pre-migration — fail closed so a fresh
      // Vercel deploy with no ADMIN_TOKEN env var doesn't accept any short
      // Bearer value as admin.
      res.status(503).json({ error: 'admin_token_not_configured' });
      return;
    }
    if (ctEq(bearer, ADMIN_TOKEN)) {
      log.info('admin_stats.legacy_auth_ok', { reqId: req.reqId });
      return legacyRateLimited(req, res);
    }
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // No legacy token — fall through to the modern admin auth pipeline.
  return adminWrapped(req, res);
}

export default withRequestId(dispatch);
