// lib/ratelimit.js
// Token-bucket rate limiting via Vercel KV (Upstash) — no npm deps.
// Fail-open on KV outage (don't block legit users), but log the failure.
//
// Usage:
//   import { rateLimit } from '../lib/ratelimit.js';
//   const lim = await rateLimit(req, { key: 'sheet_summary', limit: 30, windowSec: 60 });
//   if (!lim.ok) return res.status(429).json({ ok: false, retry: lim.retryAfter });

import { log } from './log.js';

/**
 * Identify the caller — prefer authenticated userSub, fall back to IP.
 * IPv6 normalization: group by /64 to prevent prefix enumeration bypass.
 */
function callerKey(req) {
  if (req.user?.sub) return 'u:' + req.user.sub;
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (!xff) return 'ip:unknown';
  // IPv6 /64 grouping
  if (xff.includes(':')) {
    const groups = xff.split(':');
    if (groups.length >= 4) return 'ip:' + groups.slice(0, 4).join(':') + '::/64';
  }
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
  try {
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(bucketKey)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const j = await incrRes.json();
    const count = j?.result ?? 0;
    if (count === 1) {
      // First hit — set window TTL
      await fetch(`${url}/expire/${encodeURIComponent(bucketKey)}/${windowSec}`, {
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
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(bucketKey)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    });
    const j = await incrRes.json();
    const count = j?.result ?? 0;
    if (count === 1) {
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
