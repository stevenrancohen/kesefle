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

// -----------------------------------------------------------------------------
// IPv6 /64 grouping (rate-limit bypass defense)
// -----------------------------------------------------------------------------
//
// An IPv6 end host is routinely handed an entire /64 (2^64 addresses). If we key
// the bucket on the FULL address, an attacker rotates source addresses inside
// their own /64 for free and gets an unbounded number of fresh buckets — i.e. no
// effective rate limit at all. The fix is to key IPv6 callers on the /64 prefix
// (the first four 16-bit hextets) so the whole allocation shares one bucket.
//
// Subtlety: IPv6 text can be compressed with "::" (RFC 5952 even REQUIRES it for
// the canonical form), so "2001:db8::1" has only three colon-separated tokens but
// its /64 prefix is 2001:db8:0:0 — and the host bits ("1") must NOT leak into the
// key. A naive `split(':').slice(0,4)` includes those host bits and re-opens the
// very bypass we are closing. So we expand "::" to its implied zero groups first,
// THEN take the first four hextets. IPv4 (no colon) is returned unchanged.
function ipv6Prefix64(ip) {
  // Strip a zone id (fe80::1%eth0) and any surrounding brackets ([::1]).
  let s = String(ip).trim().replace(/^\[/, '').replace(/\]$/, '');
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(':')) return s; // IPv4 / hostname / 'unknown' — unchanged.

  // Drop an embedded IPv4 tail's dotted part's relevance to the prefix: an
  // IPv4-mapped address like ::ffff:1.2.3.4 still resolves to all-zero high
  // hextets here, which is fine — it groups all v4-mapped traffic, and real v4
  // never reaches this branch (no colon).
  const hasDouble = s.includes('::');
  let head = s, tail = '';
  if (hasDouble) {
    const parts = s.split('::');
    head = parts[0] || '';
    tail = parts.slice(1).join('::') || ''; // tolerate a malformed extra '::'
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
  // Take the /64 prefix: first four hextets, each normalized (lowercase, no
  // leading zeros) so "2001:0DB8:0000:0000" and "2001:db8:0:0" map to one key.
  const prefix = [];
  for (let i = 0; i < 4; i++) {
    const h = (groups[i] || '0').toLowerCase().replace(/^0+(?=.)/, '');
    prefix.push(h);
  }
  return prefix.join(':') + '::/64';
}

function extractIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim() || 'unknown';
  }
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.length) return real.trim();
  return 'unknown';
}

// Build the bucket identity from the caller IP: IPv6 → /64 prefix, IPv4 → as-is.
// Exported for the regression test that asserts the bypass is closed.
export function ipBucketKey(req) {
  return ipv6Prefix64(extractIp(req));
}

function shouldSkip(req) {
  const u = req?.url || '';
  return u.includes('/api/health') || u.includes('/api/_internal');
}

// -----------------------------------------------------------------------------
// Atomic, self-healing INCR + TTL (lockout-race defense)
// -----------------------------------------------------------------------------
//
// The old code did INCR, then — only when count===1 — a SEPARATE, fire-and-forget
// EXPIRE. Two independent failure modes could leave a bucket key with NO TTL:
//   (a) the EXPIRE HTTP call fails (network blip / KV hiccup), or
//   (b) the process is torn down between the INCR and the EXPIRE.
// Because the TTL was only ever (re)tried on the count===1 hit, a key that lost
// its TTL once would keep that missing TTL FOREVER: subsequent hits see count>=2
// and never re-set it. Once count crosses the limit, that IP/user is locked out
// permanently — a legit-user denial of service from a single transient blip.
//
// Fix: one pipelined round trip that ALWAYS (re)asserts the TTL with EXPIRE ... NX
// ("set a TTL only if the key currently has none"). NX makes it safe to send on
// EVERY hit: it never extends a live window (so it can't be abused to lengthen a
// throttle), but it DOES self-heal a key that somehow lost its TTL. A key can
// therefore never get stuck without an expiry, so no permanent lockout.
//
// Degrade path: EXPIRE ... NX needs Redis 7+ (Upstash is 7+). If a server rejects
// the NX flag, the pipeline still returns a valid INCR; we detect the EXPIRE error
// and fall back to a plain EXPIRE on this same hit so the TTL is still set.
async function incrWithTtl(url, token, key, windowSec) {
  const auth = { 'Authorization': `Bearer ${token}` };
  const enc = encodeURIComponent(key);
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(windowSec), 'NX'],
    ]),
  });
  const arr = await r.json().catch(() => null);
  const incrRes = Array.isArray(arr) ? arr[0] : null;
  const expRes = Array.isArray(arr) ? arr[1] : null;
  const count = Number(incrRes?.result ?? 0);
  // If the server didn't understand EXPIRE ... NX, set the TTL the plain way on
  // THIS hit (not just count===1) so a recovered/missing TTL is still healed.
  if (expRes && expRes.error) {
    await fetch(`${url}/expire/${enc}/${windowSec}`, { method: 'POST', headers: auth }).catch(() => {});
  }
  return count;
}

export async function rateLimit(req, res, opts = {}) {
  if (shouldSkip(req)) return false;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  // KV not configured — fail open so dev/preview deploys don't 429 by default.
  if (!url || !token) return false;

  // IPv6 callers are bucketed by /64 so an attacker can't rotate within their
  // own allocation to dodge the limit. IPv4 is keyed on the full address.
  const ip = ipBucketKey(req);
  const key = `rate:${ip}`;

  try {
    // One pipelined round trip: INCR + EXPIRE ... NX. Always (re)asserts a TTL
    // so a bucket can never get stuck without an expiry (no permanent lockout).
    const count = await incrWithTtl(url, token, key, windowSec);

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
