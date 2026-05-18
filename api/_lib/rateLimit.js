// /api/_lib/rateLimit.js
// Lightweight per-IP rate limiter for inline use at the top of route handlers.
// Differs from lib/ratelimit.js (which is a wrapper-style middleware): this one is
// a guard that sends the 429 itself and returns a boolean — "should the caller stop?".
//
// Usage:
//   import { rateLimit } from '../_lib/rateLimit.js';
//   export default async function handler(req, res) {
//     if (await rateLimit(req, res)) return;
//     // ...rest of handler
//   }
//
// Fail-open on KV outage (don't block legit users), but log the failure.
// The KV REST API is used directly to avoid pulling in @vercel/kv as a runtime dep —
// keeps cold-start small and removes a npm install requirement for the helper itself.

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_SEC = 60;

function extractIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim() || 'unknown';
  }
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.length) return real.trim();
  return 'unknown';
}

function shouldSkip(req) {
  const u = req?.url || '';
  return u.includes('/api/health') || u.includes('/api/_internal');
}

export async function rateLimit(req, res, opts = {}) {
  if (shouldSkip(req)) return false;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  // KV not configured — fail open so dev/preview deploys don't 429 by default.
  if (!url || !token) return false;

  const ip = extractIp(req);
  const key = `rate:${ip}`;

  try {
    const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const j = await r.json().catch(() => ({}));
    const count = Number(j?.result ?? 0);

    if (count === 1) {
      // First hit in window — set TTL. Don't await aggressively; if expire fails
      // the worst case is a slightly longer effective window.
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${windowSec}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }

    if (count > limit) {
      res.setHeader('Retry-After', String(windowSec));
      res.status(429).json({ error: 'too_many_requests' });
      return true;
    }
    return false;
  } catch (e) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'rateLimit.kv_error',
      error: e.message,
      ip,
    }));
    return false;
  }
}
