// lib/ratelimit.js
// Token-bucket rate limiting via Vercel KV (Upstash) — no npm deps.
// Fail-open on KV outage (don't block legit users), but log the failure.
//
// Usage:
//   import { rateLimit } from '../lib/ratelimit.js';
//   const lim = await rateLimit(req, { key: 'sheet_summary', limit: 30, windowSec: 60 });
//   if (!lim.ok) return res.status(429).json({ ok: false, retry: lim.retryAfter });

import { log } from './log.js';

// -----------------------------------------------------------------------------
// Single-round-trip token-bucket increment (cost reduction)
// -----------------------------------------------------------------------------
//
// The original implementation did INCR, and then — only on the first hit of a
// window (count===1) — a SECOND HTTP call to set the TTL via EXPIRE. That second
// round trip happens on the first request of EVERY rate-limit window, on EVERY
// rate-limited endpoint (the signup exchange and both expense-write paths all
// run through here). At Kesefle's request volume that is a large number of
// avoidable KV HTTP calls.
//
// Upstash exposes a /pipeline endpoint that runs several commands in ONE HTTP
// round trip (the commands still execute in order; the pipeline itself is not
// atomic, which is irrelevant here — INCR is atomic on its own and EXPIRE ... NX
// only asserts a TTL when none exists). We pipeline:
//     INCR <bucket>
//     EXPIRE <bucket> <windowSec> NX
// so the TTL is established on the first increment and left untouched on every
// subsequent hit (NX = "only if no TTL"), exactly reproducing the old
// "EXPIRE only when count===1" semantics — but in a single HTTP call.
//
// SAFETY / DEGRADE: `EXPIRE ... NX` needs Redis 7.0+ (Upstash runs 7+). On the
// off chance the server rejects the NX flag, the pipeline still returns a valid
// INCR result; we detect the EXPIRE error and fall back to the legacy plain
// EXPIRE — but only on the first hit (count===1), so behaviour is identical to
// today and never worse. The bucket TTL is therefore always set, so a fresh key
// can never get "stuck" without an expiry and throttle a user forever.
//
// Returns { count, ttlFallbackNeeded } where ttlFallbackNeeded is true only in
// the degraded (old-Redis) case AND only on the window's first hit.
async function incrWithTtl(url, token, bucketKey, windowSec) {
  const auth = { 'Authorization': `Bearer ${token}` };
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', bucketKey],
      ['EXPIRE', bucketKey, String(windowSec), 'NX'],
    ]),
  });
  // Upstash /pipeline → [{ result }, { result|error }] in command order.
  const arr = await r.json();
  const incrRes = Array.isArray(arr) ? arr[0] : null;
  const expRes = Array.isArray(arr) ? arr[1] : null;
  const count = Number(incrRes?.result ?? 0);
  // If the server didn't understand `EXPIRE ... NX`, set the TTL the legacy way
  // — but only when this is the first increment (count===1), matching the old
  // code path exactly. On any later hit a missing/failed EXPIRE is a no-op.
  const ttlFallbackNeeded = !!expRes?.error && count === 1;
  return { count, ttlFallbackNeeded };
}

/**
 * IPv6 /64 prefix for rate-limit grouping. An IPv6 host owns an entire /64
 * (2^64 addresses); keying on the FULL address lets an attacker rotate within
 * their allocation to dodge the limit, so we group on the first four hextets.
 *
 * Compressed forms ("::") must be expanded first: "2001:db8::1" has only three
 * colon-tokens but its /64 is 2001:db8:0:0 — a naive split(':').slice(0,4)
 * leaks the host bits ("1") into the key and re-opens the bypass. So expand
 * "::" to its implied zero groups, THEN take four hextets. IPv4 → unchanged.
 */
function ipv6Prefix64(ip) {
  let s = String(ip).trim().replace(/^\[/, '').replace(/\]$/, '');
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct); // strip zone id (fe80::1%eth0)
  if (!s.includes(':')) return s;      // IPv4 / hostname — unchanged
  const hasDouble = s.includes('::');
  let head = s, tail = '';
  if (hasDouble) {
    const parts = s.split('::');
    head = parts[0] || '';
    tail = parts.slice(1).join('::') || '';
  }
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  let groups;
  if (hasDouble) {
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
    groups = headGroups.concat(Array(missing).fill('0'), tailGroups);
  } else {
    groups = headGroups;
  }
  const prefix = [];
  for (let i = 0; i < 4; i++) {
    prefix.push((groups[i] || '0').toLowerCase().replace(/^0+(?=.)/, ''));
  }
  return prefix.join(':') + '::/64';
}

/**
 * Identify the caller — prefer authenticated userSub, fall back to IP.
 * IPv6 normalization: group by /64 to prevent prefix enumeration bypass.
 */
function callerKey(req) {
  if (req.user?.sub) return 'u:' + req.user.sub;
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (!xff) return 'ip:unknown';
  if (xff.includes(':')) return 'ip:' + ipv6Prefix64(xff);
  return 'ip:' + xff;
}

/**
 * KV INCR-based bucket with TTL. Returns:
 *   { ok: boolean, count, limit, retryAfter (seconds) }
 *
 * If KV is not configured, returns { ok: true, fallback: true } — fail open.
 */
export async function rateLimit(req, { key, limit, windowSec }) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return { ok: true, fallback: 'kv_unconfigured', limit };
  }
  const caller = callerKey(req);
  const bucketKey = `rl:${key}:${caller}`;
  const encBucket = encodeURIComponent(bucketKey);
  try {
    // One HTTP round trip: INCR + (conditional) EXPIRE. See incrWithTtl().
    const { count, ttlFallbackNeeded } = await incrWithTtl(url, token, bucketKey, windowSec);
    if (ttlFallbackNeeded) {
      // Degraded path only (server without EXPIRE ... NX): set TTL the old way
      // on the first hit so the window can expire. Identical to legacy cost.
      await fetch(`${url}/expire/${encBucket}/${windowSec}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    }
    if (count > limit) {
      log.warn('ratelimit.exceeded', { reqId: req.reqId, key, caller, count, limit });
      return { ok: false, count, limit, retryAfter: windowSec };
    }
    return { ok: true, count, limit, remaining: Math.max(0, limit - count) };
  } catch (e) {
    log.error('ratelimit.kv_error', { reqId: req.reqId, error: e.message });
    return { ok: true, fallback: 'kv_error', limit, error: e.message };
  }
}

/**
 * Rate-limit on an EXPLICIT identity (e.g. a phone number) instead of the
 * request's IP/userSub. Use for defense-in-depth on write endpoints where the
 * caller IP is the bot's (and rotates), so per-IP limiting is weak. Same
 * KV INCR bucket + fail-open semantics as rateLimit().
 */
export async function rateLimitId(id, { key, limit, windowSec }) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: true, fallback: 'kv_unconfigured', limit };
  const safeId = String(id || 'unknown').replace(/[^0-9A-Za-z_.:+-]/g, '');
  const bucketKey = `rl:${key}:${safeId}`;
  try {
    // One HTTP round trip: INCR + (conditional) EXPIRE. See incrWithTtl().
    const { count, ttlFallbackNeeded } = await incrWithTtl(url, token, bucketKey, windowSec);
    if (ttlFallbackNeeded) {
      await fetch(`${url}/expire/${encodeURIComponent(bucketKey)}/${windowSec}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
      });
    }
    if (count > limit) return { ok: false, count, limit, retryAfter: windowSec };
    return { ok: true, count, limit, remaining: Math.max(0, limit - count) };
  } catch (e) {
    return { ok: true, fallback: 'kv_error', limit, error: e.message };
  }
}

/**
 * Middleware wrapper: rate-limits then proceeds. Sends 429 with X-RateLimit-* headers.
 */
export function withRateLimit({ key, limit, windowSec }) {
  return function wrap(handler) {
    return async function rateLimited(req, res) {
      const result = await rateLimit(req, { key, limit, windowSec });
      res.setHeader('X-RateLimit-Limit', String(limit));
      if (result.remaining != null) res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      if (!result.ok) {
        res.setHeader('Retry-After', String(result.retryAfter || windowSec));
        return res.status(429).json({
          ok: false,
          error: 'rate_limit_exceeded',
          retry_after: result.retryAfter || windowSec,
        });
      }
      return handler(req, res);
    };
  };
}
