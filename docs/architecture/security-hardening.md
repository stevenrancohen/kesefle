# 6. Security Hardening

## Threat model (top 8)

1. **Stolen refresh token** → attacker reads/writes user's sheet. Mitigated: tokens encrypted at rest (pgcrypto), short-lived access tokens cached in memory only.
2. **WhatsApp webhook spoofing** → fake "user" injecting transactions. Mitigated: HMAC verify (`x-hub-signature-256`).
3. **Stripe webhook spoofing** → fake "subscription active". Mitigated: HMAC verify with timestamp tolerance.
4. **Rate-limit bypass / dollar bomb** → flood `/api/waitlist` or `/api/auth/google`. Mitigated: KV-backed token bucket, IP + email keys.
5. **SQL injection** — all queries use parameterized `sql\`\`` tagged template (no string concat).
6. **CSRF on dashboard** — session cookies set `SameSite=Lax` + double-submit token for state-changing routes.
7. **Token leak via logs** — explicit redaction of headers + body fields before `console.log`.
8. **Insider/admin abuse** — impersonate endpoint logs loudly + 5-min token expiry + IP allowlist.

## 6.1 Webhook signature verification

WhatsApp (Meta) — already implemented in `api/whatsapp/webhook.js`, generalize as `lib/verify-meta.js`:

```js
// /api/lib/verify-meta.js
import crypto from 'node:crypto';

export function verifyMeta(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = signatureHeader.slice(7);
  const computedHex = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (expectedHex.length !== computedHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(computedHex, 'hex'));
  } catch { return false; }
}
```

**Critical**: the current `api/whatsapp/webhook.js` re-stringifies `req.body` before HMAC — that's wrong if Meta canonicalized differently. Switch to raw body capture (`config.api.bodyParser = false`) as in the Stripe handler.

## 6.2 Rate limiting

The current `/api/waitlist.js` is unbounded — flagged. New helper:

```js
// /api/lib/rate-limit.js
const KV = process.env.KV_REST_API_URL;
const KT = process.env.KV_REST_API_TOKEN;

export async function rateLimit(key, { max, windowSec }) {
  if (!KV || !KT) return { ok: true, remaining: max };  // dev fallback
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const r = await fetch(`${KV}/incr/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KT}` },
  });
  const j = await r.json();
  const count = Number(j?.result || 0);
  if (count === 1) {
    // first hit in this window — set TTL
    await fetch(`${KV}/expire/${encodeURIComponent(bucket)}/${windowSec}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KT}` },
    });
  }
  const ok = count <= max;
  return { ok, remaining: Math.max(0, max - count), retryAfter: ok ? 0 : windowSec };
}
```

**Apply to all public endpoints**:

| Endpoint | Limit | Key |
|---|---|---|
| `/api/waitlist` | 5 per 5 min per IP, 1 per email per hour | `wl:ip:<ip>` + `wl:email:<email>` |
| `/api/auth/google` | 10 per min per IP | `auth:ip:<ip>` |
| `/api/whatsapp/webhook` | none (Meta signs it) | n/a |
| `/api/billing/checkout` | 20 per hour per user | `chk:<userId>` |
| `/api/transactions` (POST/PATCH/DELETE) | 60 per 5 min per user | `tx:<userId>` |
| `/api/summary/*` | 120 per min per user | `sum:<userId>` |

Updated `waitlist.js` snippet (Edit, not rewrite):

```js
import { rateLimit } from '../lib/rate-limit.js';

// inside handler, after validating email:
const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
const ipLimit = await rateLimit(`wl:ip:${ip}`, { max: 5, windowSec: 300 });
if (!ipLimit.ok) return res.status(429).json({ ok: false, error: 'too many requests' });
const emailLimit = await rateLimit(`wl:email:${email}`, { max: 1, windowSec: 3600 });
if (!emailLimit.ok) return res.status(429).json({ ok: false, error: 'already signed up' });
```

## 6.3 Token encryption helper

`/api/lib/crypto.js` — wraps Node's built-in `crypto` (no npm). Used for any short string we'd ever store outside Postgres (cookies, signed URLs, one-time codes).

```js
// /api/lib/crypto.js
// Symmetric encryption with AES-256-GCM. The DB key is for pgcrypto (DB-side);
// this helper is for stuff that lives in cookies / KV / signed URLs.
//
// Env: KESEFLE_APP_KEY  — 32 random bytes, base64 (≥44 chars)

import crypto from 'node:crypto';

function key() {
  const k = process.env.KESEFLE_APP_KEY;
  if (!k) throw new Error('KESEFLE_APP_KEY missing');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('KESEFLE_APP_KEY must decode to 32 bytes');
  return buf;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');  // url-safe
}

export function decrypt(token) {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 28) throw new Error('ciphertext too short');
  const iv  = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// HMAC for double-submit CSRF tokens, signed URLs, etc.
export function sign(msg) {
  return crypto.createHmac('sha256', key()).update(String(msg)).digest('base64url');
}
export function verifyHmac(msg, sigB64u) {
  const expected = sign(msg);
  if (expected.length !== sigB64u.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64u));
}

// Session JWT (HS256) — minimal, no deps
export function signJWT(payload, ttlSec = 60 * 60 * 24 * 30) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + ttlSec,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
export function verifyJWT(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = crypto.createHmac('sha256', key()).update(`${h}.${b}`).digest('base64url');
  if (expected.length !== s.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
  return payload;
}
```

**Why not libsodium?** No npm → we'd vendor it as a precompiled WASM blob (~150 KB), and Node's AES-256-GCM is FIPS-approved and constant-time. For our threat model (cookie + session protection) AES-GCM is correct.

**Key rotation plan**: support `KESEFLE_APP_KEY_PREV` so decrypt can try both during a rolling rotation, then drop after a week.

## 6.4 CSRF protection

- `kfl_session` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
- For all state-changing routes (`POST`/`PATCH`/`DELETE`) we use **double-submit token**: cookie `kfl_csrf` (NOT HttpOnly) contains a random value; the client must echo it in the `X-CSRF-Token` header. Server compares.

```js
// in lib/auth.js
export function requireUser(req, res) {
  const jwt = readCookie(req, 'kfl_session');
  const user = verifyJWT(jwt);
  if (!user) { res.status(401).json({ ok: false, error: 'auth required' }); return null; }
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD') {
    const cookieCsrf = readCookie(req, 'kfl_csrf');
    const headerCsrf = req.headers['x-csrf-token'];
    if (!cookieCsrf || cookieCsrf !== headerCsrf) {
      res.status(403).json({ ok: false, error: 'csrf token mismatch' });
      return null;
    }
  }
  return user;
}
```

## 6.5 SQL injection

**Never** string-concat. Always parameterize. Our `sql` tagged template:

```js
// /api/lib/db.js
export function sql(strings, ...values) {
  const fragments = [];
  const params = [];
  for (let i = 0; i < strings.length; i++) {
    fragments.push(strings[i]);
    if (i < values.length) {
      params.push(values[i]);
      fragments.push(`$${params.length}`);
    }
  }
  return { text: fragments.join(''), values: params };
}
```

Allows: ``db.query(sql`select * from users where id = ${id}`)`` — `id` is bound, not interpolated. The Supabase REST client we send to also re-parses parameters server-side via prepared statements.

## 6.6 Headers + CSP

Add to `vercel.json`:

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "Permissions-Policy", "value": "geolocation=(), camera=(), microphone=(self), payment=(self)" },
      { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://js.stripe.com https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://accounts.google.com https://*.supabase.co https://api.stripe.com; frame-src https://accounts.google.com https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none';" },
      { "key": "X-Frame-Options", "value": "DENY" }
    ]
  }]
}
```

## 6.7 Logging hygiene

```js
// /api/lib/log.js
const SECRETS = /(authorization|cookie|set-cookie|access[-_]token|refresh[-_]token|api[-_]key|password|credential|secret)/i;
export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRETS.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}
export function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...redact(fields) }));
}
```

## 6.8 Secret inventory

| Secret | Where | Rotation |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | Vercel env | annual |
| `KESEFLE_APP_KEY` | Vercel env | annual (rolling) |
| `KESEFLE_DB_KEY` | Vercel env | annual (with migration) |
| `KESEFLE_JWT_SECRET` | Vercel env | quarterly |
| `META_APP_SECRET` | Vercel env | when compromise suspected |
| `META_ACCESS_TOKEN` | Vercel env | per Meta system-user policy |
| `STRIPE_API_KEY` | Vercel env | annual or on incident |
| `STRIPE_WEBHOOK_SECRET` | Vercel env | per webhook endpoint |
| `KV_REST_API_TOKEN` | Vercel env | annual |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env | never expose to client; rotate annually |
| `KESEFLE_TEMPLATE_SHEET_ID` | Vercel env | n/a — not a secret |

All secrets backed up in 1Password "Kesefle Production" vault; never in git.
