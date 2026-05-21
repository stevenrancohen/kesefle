# Red Team Agent #1 — API Attack Surface Findings

**Date:** 2026-05-16
**Scope:** Kesefle Vercel API functions (`/api/*`)
**Methodology:** Adversarial code review focused on authn/authz/injection/IDOR
**Total findings:** 24 (5 CRITICAL, 8 HIGH, 7 MEDIUM, 4 LOW)

---

## Executive Summary

The API has **multiple critical authentication-bypass vulnerabilities** that allow a remote unauthenticated attacker who knows any victim's Google `sub` (a non-secret 21-digit number that leaks via OAuth flows, JWT exposure, sharing of email addresses linked to Google profiles, or basic enumeration) to:

1. **Read any victim's full financial transaction history** (`/api/sheet/summary`)
2. **Delete any victim's Kesefle account and revoke their Google grant** (`/api/account/delete`)
3. **Forge identity tokens to provision sheets / link billing as someone else** (`/api/auth/google-exchange` does not verify JWT signature)
4. **Steal refresh tokens via SSRF-equivalent on `/api/sheet/provision`** (server uses attacker-supplied `accessToken` against Google APIs while writing record under attacker-controlled `userSub`)

The threat model in this codebase reduces to **"anyone who knows or guesses a `sub` owns the account"**. Google `sub` values are not secret and never were intended to be — they appear in shareable URLs, JWTs the client surfaces, account ID exports, Google Workspace directories, etc.

---

## CRITICAL Findings

### C1 — Authentication bypass via unverified `X-User-Sub` header on `/api/sheet/summary`

**Severity:** CRITICAL
**Location:** `api/sheet/summary.js:51-57`
**Exploit:** Attacker sends `GET /api/sheet/summary` with `X-User-Sub: <victim_google_sub>`. Server trusts the header and returns the victim's full month expenses, income, recent transactions (with descriptions / raw Hebrew text), and top categories. No token, no signature, no session check. A 1-line curl command reads any user's financial history.

```bash
curl -H "X-User-Sub: 102938475610293847561" https://kesefle.vercel.app/api/sheet/summary
```

**Fix (in code):**
```javascript
// Replace lines 49-57 with proper bearer token verification.
import { verifyGoogleIdToken } from '../auth/_google-verify.js'; // refactored from google.js

const authHeader = req.headers['authorization'] || '';
if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'missing bearer' });
const idToken = authHeader.slice(7);
let payload;
try { payload = await verifyGoogleIdToken(idToken, process.env.GOOGLE_CLIENT_ID); }
catch (e) { return res.status(401).json({ ok: false, error: 'invalid token' }); }
const userSub = payload.sub;
```

---

### C2 — Account takeover / mass deletion via unverified `X-User-Sub` on `/api/account/delete`

**Severity:** CRITICAL
**Location:** `api/account/delete.js:53-57`
**Exploit:** Attacker who knows a victim's `sub` POSTs `{confirmation:"DELETE-MY-ACCOUNT"}` with `X-User-Sub: <victim_sub>`. Server deletes the user record, calls Google to **revoke the refresh token** (cannot be undone — victim must re-grant consent), and wipes the KV row. The "confirmation string" is a constant in the public client code and offers zero protection. This is destructive, irreversible, and unauthenticated.

```bash
curl -X POST https://kesefle.vercel.app/api/account/delete \
  -H "X-User-Sub: 102938475610293847561" -H "Content-Type: application/json" \
  -d '{"confirmation":"DELETE-MY-ACCOUNT"}'
```

**Fix (in code):**
```javascript
// Require a verified ID token whose sub matches the account being deleted.
const authHeader = req.headers['authorization'] || '';
if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'unauth' });
let payload;
try { payload = await verifyGoogleIdToken(authHeader.slice(7), process.env.GOOGLE_CLIENT_ID); }
catch { return res.status(401).json({ ok: false, error: 'invalid token' }); }
const userSub = payload.sub;
// Optional but strongly recommended: also require a freshly-issued token (iat within 5 min)
if (Date.now() - payload.iat * 1000 > 300_000) return res.status(401).json({ ok: false, error: 'reauthenticate' });
```

---

### C3 — JWT signature **not verified** in `/api/auth/google-exchange` — identity forgery

**Severity:** CRITICAL
**Location:** `api/auth/google-exchange.js:77-89`
**Exploit:** Even after the legitimate code-for-token exchange with Google succeeds, the handler decodes the returned `id_token` payload **without verifying the RS256 signature**. While Google's response is over HTTPS and normally trustworthy, the same `identity` object is written to KV under `user:<sub>` and returned to the browser — **if the upstream Google response is ever attacker-influenced** (e.g., compromised middlebox, future proxying through Vercel, internal SSRF tee, mock server in tests pushed to prod), an attacker controls the `sub` in the stored record. More importantly, an attacker who POSTs `{ code, codeVerifier, redirectUri }` of an already-leaked OAuth code or who can MITM the *Google* leg can register an arbitrary `sub` into KV. The verifier at `/api/auth/google.js` is correct — this file is the regression.

**Fix (in code):**
```javascript
// Replace lines 77-89:
import { verifyGoogleIdToken } from './_google-verify.js'; // extract verifier from google.js
let identity;
try {
  identity = await verifyGoogleIdToken(tokens.id_token, clientId);
} catch (e) {
  return res.status(400).json({ ok: false, error: 'invalid_id_token', detail: e.message });
}
if (!identity.sub) return res.status(400).json({ ok: false, error: 'id_token_missing_sub' });
```

---

### C4 — IDOR + refresh-token poisoning on `/api/sheet/provision`

**Severity:** CRITICAL
**Location:** `api/sheet/provision.js:23-29, 87-101`
**Exploit:** Body fields `accessToken`, `userSub`, `userEmail` are all attacker-controlled. Server has no way to confirm the `accessToken` belongs to the `userSub`. Two attacks:

1. **Sheet hijack:** Attacker supplies their own Google `accessToken` and the **victim's `userSub`**. Server creates a sheet in *attacker's* Drive, then writes `sheet:<victimSub> -> attackerSpreadsheetId` to KV. From now on every WhatsApp expense the victim sends is written to the attacker's sheet, and the victim sees stale/empty data in their own dashboard.
2. **Record overwrite:** The handler at line 110-119 **merges into `user:<userSub>` without ownership check**, allowing mass-assignment of arbitrary fields on any user's record (see also H4).

**Fix (in code):**
```javascript
// Verify the access token actually belongs to userSub before trusting either:
const tokenInfo = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
const ti = await tokenInfo.json();
if (!tokenInfo.ok || ti.sub !== userSub || ti.aud !== process.env.GOOGLE_CLIENT_ID) {
  return res.status(401).json({ ok: false, error: 'access_token_does_not_match_user' });
}
// Better: require a bearer ID token (as in C1) and use it as the sole source of userSub.
```

---

### C5 — `customer.subscription.updated` from Stripe trusts attacker-controlled `metadata.userSub`

**Severity:** CRITICAL
**Location:** `api/billing/webhook.js:122-134`
**Exploit:** Stripe customers can be created externally with arbitrary metadata. If an attacker has any Stripe API access (compromised key, restricted key with limited scope, or in a multi-tenant Stripe Connect scenario), they can create a subscription whose `metadata.userSub = <victim_sub>` and trigger a webhook. The handler overwrites the victim's `plan` and `subscriptionStatus` — instant free upgrade for attacker, or downgrade-DoS against the victim. More immediately, `checkout.js:110` sets `subscription_data[metadata][userSub] = userSub` from request body — combined with C1's missing auth, an unauthenticated attacker creates a checkout session with metadata claiming another user's `sub` and after paying, *the victim's account* gets the plan upgrade (or attacker's failed payment downgrades the victim).

**Fix (in code):**
```javascript
// Cross-check the userSub in metadata against the Stripe customer record we created.
// In checkout.js: never let metadata.userSub come from body — pull from a verified ID token.
// In webhook.js for subscription.updated:
const sub = event.data.object;
const customerRec = await kvGet('stripe_customer:' + sub.customer);
if (!customerRec) { console.warn('unknown customer', sub.customer); break; }
if (customerRec.userSub !== sub.metadata?.userSub) {
  console.warn('metadata userSub mismatch', sub.id); break; // refuse to update
}
```

---

## HIGH Findings

### H1 — Race condition in sheet provisioning (TOCTOU duplicate provision)

**Severity:** HIGH
**Location:** `api/sheet/provision.js:38-55, 57-79`
**Exploit:** Two concurrent POSTs with the same `userSub` both pass the `if (existing?.result)` check (line 43) before either writes the record. Both call `drive.files.copy` (line 59) and both write `sheet:<userSub>` — the second clobbers the first. Result: user owns two sheets, one is orphaned, future writes may go to the wrong one. With WhatsApp linking flow + auto-retry, attacker can intentionally trigger this to confuse the dashboard.

**Fix (in code):**
```javascript
// Use Upstash SETNX-equivalent (set with NX) as a provisioning lock.
const lockRes = await fetch(`${kvUrl}/set/${encodeURIComponent('lock:provision:' + userSub)}/1?NX=true&EX=60`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
});
const lockJson = await lockRes.json();
if (lockJson?.result !== 'OK') {
  return res.status(409).json({ ok: false, error: 'provision_in_progress_or_done' });
}
// ... do the work, then DEL the lock on both success and failure paths.
```

---

### H2 — KV `seen:wa:<msgId>` idempotency uses unsanitized message ID

**Severity:** HIGH
**Location:** `api/whatsapp/webhook.js:185-200`
**Exploit:** The `messageId` from the parsed JSON is concatenated into a KV key and a URL path segment. Although a real Meta `messages.id` is `wamid.<base64>` and signature-verified upstream, the URL `${kvUrl}/set/${encodeURIComponent('seen:wa:' + messageId)}?EX=86400` mixes a path-style key with a query-string TTL — **Upstash REST API requires `EX` as a path segment**, not a query string. The TTL is silently ignored, so the idempotency keys accumulate forever. Storage exhaustion DoS at scale; also a long-lived blacklist that can be poisoned by valid Meta IDs.

Additionally, if Meta signature verification is disabled (no `META_APP_SECRET` env var set — see `api/whatsapp/webhook.js:99` `if (appSecret)`), an attacker can craft arbitrary `messageId` values to collide with future legitimate messages (`seen:wa:wamid.LEGIT` set first → real Meta delivery is dropped as duplicate).

**Fix (in code):**
```javascript
// Make signature mandatory in production:
if (!appSecret) {
  return res.status(500).json({ ok: false, error: 'webhook_misconfigured' });
}
// Use Upstash's path-style EX:
await fetch(`${kvUrl}/setex/${encodeURIComponent(seenKey)}/86400`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ts: Date.now() }),
});
```

---

### H3 — HMAC signature verification optional (silent bypass when env var missing)

**Severity:** HIGH
**Location:** `api/whatsapp/webhook.js:98-104`
**Exploit:** `if (appSecret)` — if `META_APP_SECRET` is empty/unset (misconfiguration, env var rotation gap, accidental deletion), **the webhook accepts unsigned requests**. Anyone on the internet who knows the webhook URL can post arbitrary "WhatsApp messages" as any phone number, triggering writes to that phone's linked sheet, opting users out via fake STOP commands, or flooding the KV with `seen:wa:*` entries.

**Fix (in code):**
```javascript
const appSecret = process.env.META_APP_SECRET;
if (!appSecret) {
  console.error('META_APP_SECRET missing — refusing webhook');
  return res.status(500).json({ ok: false, error: 'webhook_misconfigured' });
}
const sig = req.headers['x-hub-signature-256'];
if (!verifyMetaSignature(rawBody, sig, appSecret)) {
  return res.status(401).json({ ok: false, error: 'invalid signature' });
}
```

---

### H4 — Mass assignment on `user:<sub>` record via `/api/sheet/provision`

**Severity:** HIGH
**Location:** `api/sheet/provision.js:105-123`
**Exploit:** The provision handler does `userRec.spreadsheetId = ...; userRec.spreadsheetUrl = ...; userRec.provisioned = ...` after re-reading the record. Combined with C4 (unverified `userSub` in body), an attacker overwrites these fields on any user. Worse: the parsed `userRec` object from KV is mutated without any allowlist — if any future code path puts user-controlled data into the same record before line 110, those fields ride along. Pattern is dangerous and should use field allowlist.

**Fix (in code):**
```javascript
// Only update the specific fields we own:
const patchedRec = {
  ...userRec,
  spreadsheetId,
  spreadsheetUrl,
  provisioned: record.provisioned,
};
// Then PUT the whole record. Or use a Lua/MULTI script for atomic field update.
```

---

### H5 — Stripe checkout `success_url` / `cancel_url` not validated — can be overridden via env-var injection or default-fallback abuse

**Severity:** HIGH
**Location:** `api/billing/checkout.js:107-108`
**Exploit:** The env-var fallback `process.env.STRIPE_SUCCESS_URL || 'https://kesefle.vercel.app/...'` means if env is misconfigured in a preview/staging deploy, the default points to **production**, leaking customer journey to wrong domain. More critically, `params.set('success_url', ...)` writes to Stripe — but if the env var is ever set from a CI-built value that ingests user input (common Vercel pattern with `VERCEL_ENV` + branch names), this becomes an open-redirect via Stripe. Independently, **none of the URLs are pinned to the kesefle.app host**, so a future code change passing through body fields would silently allow phishing redirects.

**Fix (in code):**
```javascript
const ALLOWED_ORIGINS = ['https://kesefle.vercel.app', 'https://kesefle.app'];
function safeUrl(input, fallbackPath) {
  try {
    const u = new URL(input);
    if (ALLOWED_ORIGINS.includes(u.origin)) return u.toString();
  } catch {}
  return ALLOWED_ORIGINS[0] + fallbackPath;
}
params.set('success_url', safeUrl(process.env.STRIPE_SUCCESS_URL, '/dashboard?upgraded=true'));
params.set('cancel_url', safeUrl(process.env.STRIPE_CANCEL_URL, '/account#plan'));
```

---

### H6 — Information disclosure in error responses (token-exchange details, KV errors, Google error messages)

**Severity:** HIGH
**Location:** Multiple. Examples:
- `api/auth/google-exchange.js:66-70` returns `tokens.error_description` (Google's verbose error)
- `api/auth/google-exchange.js:72` returns `e.message` from fetch failure (could include internal hostnames)
- `api/sheet/summary.js:63` returns `e.message` containing `refresh_failed: <Google's reason>`
- `api/sheet/summary.js:77` returns first 200 chars of Sheets error body
- `api/whatsapp/webhook.js:322` returns `errText.slice(0, 200)` to caller (Meta won't surface it, but logs do)
- `api/health.js:73` leaks dependency status (KV reachable Y/N, response codes) — useful to attackers fingerprinting infra

**Exploit:** Error oracles let attackers distinguish "user exists but no sheet" vs "user does not exist" vs "Google rejected the token". Combined with C1 they can enumerate which Google `sub` values are registered. `/api/health.js` also enumerates configured env vars (true/false) — telling attackers exactly which optional protections (Meta signature, Stripe webhook) are *not* configured.

**Fix (in code):**
```javascript
// Pattern: log details, return generic codes.
console.error('token_exchange_failed', { detail: tokens.error_description, sub: identity.sub });
return res.status(r.status).json({ ok: false, error: 'token_exchange_failed' }); // no detail to client.
// Protect /api/health with a token or scope the response: only return ok:true/false, never deps.
```

---

### H7 — Rate-limit bypass via spoofed `X-Forwarded-For` (waitlist.js)

**Severity:** HIGH
**Location:** `api/waitlist.js:55, 74`
**Exploit:** Vercel does set `x-forwarded-for` from the real client IP, but `req.headers['x-forwarded-for']` is the **first** entry of the split — attackers can prepend a header: `X-Forwarded-For: 1.2.3.4` and the code reads `1.2.3.4` as the rate-limit key (Vercel concatenates: `<attacker>, <real-ip>`, and `.split(',')[0]` takes the attacker-provided value). IPv6 attackers also bypass per-IP limits trivially by rotating /64 addresses or even just /128 within their allocation. Email rate limit (3/hr) is real but circumventable by appending `+suffix` to the email.

**Fix (in code):**
```javascript
// Use Vercel's request.ip (it's the trusted edge-derived value) or the LAST entry of XFF after Vercel's appendage.
const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
const ip = xff[xff.length - 1] || 'unknown'; // last hop is what Vercel added
// For IPv6, bucket by /64:
const ipBucket = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
// Normalize email to strip + alias before keying:
const emailKey = email.replace(/\+[^@]*@/, '@').toLowerCase();
```

---

### H8 — Apple ID token missing `iat`-skew check + missing nonce

**Severity:** HIGH
**Location:** `api/auth/apple.js:24-46`
**Exploit:** Unlike Google's verifier, the Apple verifier (1) does not validate `iat` is reasonable (token issued in past), (2) does not check `nonce` (Apple Sign-In supports nonce binding to prevent token replay across origins), (3) **does not cache JWKS** so every login hits Apple — DoS amplification by triggering many login attempts. Replay window is bounded only by `exp` (≈10 min from Apple), but a stolen-and-replayed token within that window is accepted unconditionally.

**Fix (in code):**
```javascript
if (Number(payload.iat) * 1000 > Date.now() + 60_000) throw new Error('token in future');
if (Number(payload.iat) * 1000 < Date.now() - 600_000) throw new Error('token too old');
// Require nonce echo if client provided one:
const expectedNonce = req.body?.nonce;
if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('nonce mismatch');
// Cache JWKS like google.js does (lines 12-23).
```

---

## MEDIUM Findings

### M1 — Prototype pollution risk via `JSON.parse` of req.body across endpoints

**Severity:** MEDIUM
**Location:** All endpoints with `if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }`
**Exploit:** Node's `JSON.parse` honors `__proto__` and `constructor.prototype` keys. The code then does `Object.assign(userRec, planFields)` (`billing/webhook.js:73`) and `Object.assign` with attacker-controlled keys can pollute `Object.prototype`. Endpoints particularly exposed: `billing/webhook.js`, `account/delete.js`, `sheet/provision.js` (mass-assigns user-controlled fields). Impact depends on what code later reads from `Object.prototype` — Vercel's runtime is reasonably safe, but third-party SDKs added later (Stripe SDK, Sheets client) could trigger gadgets.

**Fix:**
```javascript
function safeParse(s) {
  return JSON.parse(s, (k, v) => k === '__proto__' || k === 'constructor' ? undefined : v);
}
// And explicit field allowlist before any Object.assign.
```

---

### M2 — `Object.assign(userRec, planFields)` in webhook is mass-assignment

**Severity:** MEDIUM
**Location:** `api/billing/webhook.js:71-73, 112-118, 125-132`
**Exploit:** `planFields` is built from `event.data.object` (Stripe-controlled). If Stripe ever adds a new field that collides with sensitive keys in `userRec` (e.g., `refreshToken`, `email`), the webhook writes them in. Currently no obvious vector, but pattern is brittle.

**Fix:** Use explicit field allowlist when calling `updateUserPlan`.

---

### M3 — KV-fail-open in rate limit is exploitable for sustained abuse

**Severity:** MEDIUM
**Location:** `api/waitlist.js:24-26`
**Exploit:** "Fail open on KV outage" means an attacker who can DoS the KV (or just exhaust Upstash quota) bypasses all rate limits. Combined with bot-driven waitlist signups, attacker burns the Upstash budget then floods the endpoint cheaply.

**Fix:** Fail closed for rate limits (return 503), or fall back to in-memory bucket (limited but better than open).

---

### M4 — CORS wildcard on waitlist (`Access-Control-Allow-Origin: *`)

**Severity:** MEDIUM
**Location:** `api/waitlist.js:31-34`
**Exploit:** Wildcard CORS lets any malicious site embed a waitlist signup form pointed at production — phishing attacks where the victim's email gets added without their knowledge, or any site can scrape rate-limit responses to enumerate waitlist members (combined with H6).

**Fix:** Echo the origin only if it's in an allowlist; otherwise omit the header.

---

### M5 — Google sub used as KV key without length/charset validation

**Severity:** MEDIUM
**Location:** Everywhere `'user:' + userSub` is built
**Exploit:** `encodeURIComponent` saves the URL path, but the KV key itself contains untrusted bytes. If an attacker submits `userSub = "a/../../user:victim"` they don't escape the URL (encodeURIComponent neutralizes that), but they DO get a key like `user:a/../../user:victim` in Upstash — most Upstash commands treat that as a literal key, but if any code later splits keys on `:` or `/` for analytics/cleanup, it misbehaves. Also `userSub` of length 10,000 wastes KV storage. Validate format.

**Fix:**
```javascript
if (!/^[0-9]{1,30}$/.test(userSub)) return res.status(400).json({ ok: false, error: 'invalid sub format' });
// Google subs are always numeric, ≤21 chars in practice.
```

---

### M6 — `/api/sheet/summary` Sheets range injection theoretical via spreadsheetId

**Severity:** MEDIUM
**Location:** `api/sheet/summary.js:67-68`
**Exploit:** `userRec.spreadsheetId` is interpolated into the Sheets API URL without encoding. If an attacker (via C4 or other vector) writes a malicious `spreadsheetId` into KV like `LEGIT_ID/values:batchUpdate%3F...`, the constructed URL flips the request from `GET values` to `POST batchUpdate`. Currently bounded because `spreadsheetId` comes from `drive.files.copy` (trusted), but post-C4 exploit chain makes this real.

**Fix:**
```javascript
if (!/^[A-Za-z0-9_-]{20,60}$/.test(userRec.spreadsheetId)) {
  return res.status(500).json({ ok: false, error: 'invalid spreadsheet id' });
}
const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(userRec.spreadsheetId)}/values/${range}`;
```

---

### M7 — STOP/START handler is unauthenticated and operates by phone alone

**Severity:** MEDIUM
**Location:** `api/whatsapp/webhook.js:123-156`
**Exploit:** If H3 is exploited (no Meta signature), an attacker forges a STOP message for any phone number and opts that user out — denial-of-service of the bot. Even with signatures, anyone with access to that phone (e.g., shared family device) can opt out the account-holder. No explicit confirmation step.

**Fix:** STOP works (it must, per regulation), but log it and send an SMS-equivalent confirmation to the original linked email so user can reverse easily.

---

## LOW Findings

### L1 — `process.env.GOOGLE_CLIENT_ID` has hardcoded fallback exposing client ID

**Severity:** LOW
**Location:** `api/auth/google-exchange.js:40`, `api/sheet/summary.js:25`, `api/whatsapp/webhook.js:332`
**Exploit:** Hardcoded fallback `'191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com'` is technically not secret (it appears on the frontend) but masks misconfigurations. If `GOOGLE_CLIENT_ID` env is wrong in a deploy, the fallback silently uses the wrong client → audience mismatch may pass, may fail, and debugging is hard. The OAuth client ID is fingerprintable, so attackers learn which client is in use.

**Fix:** Remove fallbacks; fail fast if env is missing.

---

### L2 — `/api/health` is unauthenticated and reveals env-var configuration

**Severity:** LOW
**Location:** `api/health.js:38-51`
**Exploit:** Anyone can probe which optional features are configured. Attackers learn whether `META_APP_SECRET` is set (informs H3 attacks), whether `STRIPE_WEBHOOK_SECRET` is set, etc.

**Fix:** Require a shared secret header for the `env_configured` block, or split into a public liveness ping (`{ok: true}`) and a private detailed health.

---

### L3 — No CSRF protection on POST endpoints (relies on CORS only)

**Severity:** LOW
**Location:** All POST handlers (waitlist, auth, sheet, billing)
**Exploit:** Without CSRF tokens, a malicious site can POST as a logged-in browser if any of these endpoints ever start using cookie-based auth. Currently most use header-based identity (which is CSRF-resistant when CORS is configured), but `/api/waitlist` has wildcard CORS (M4), so any site can POST signups in a visitor's browser context. Low because no current state is bound to cookies.

**Fix:** When introducing session cookies, add SameSite=Strict + double-submit CSRF tokens.

---

### L4 — `userEmail` interpolated into Drive file name without sanitization

**Severity:** LOW
**Location:** `api/sheet/provision.js:68`
**Exploit:** `name: \`כספ'לה — ${userEmail || userSub}\`` lets an attacker (combined with C4) put control characters, RTL override marks (`‮`), or zero-width joiners in their Drive file name. Cosmetic / phishing aid more than security, but RTL override could let a malicious file name display as something benign.

**Fix:**
```javascript
const safeName = (userEmail || userSub).replace(/[ -‎‏‪-‮]/g, '').slice(0, 100);
name: `כספ'לה — ${safeName}`,
```

---

## Findings Summary Table

| ID | Severity | File | Line(s) | Title |
|----|----------|------|---------|-------|
| C1 | CRITICAL | api/sheet/summary.js | 51-57 | Auth bypass via unverified X-User-Sub |
| C2 | CRITICAL | api/account/delete.js | 53-57 | Account takeover via unverified X-User-Sub |
| C3 | CRITICAL | api/auth/google-exchange.js | 77-89 | JWT signature not verified — identity forgery |
| C4 | CRITICAL | api/sheet/provision.js | 23-29 | IDOR + refresh-token poisoning |
| C5 | CRITICAL | api/billing/webhook.js | 122-134 | Stripe metadata trusted — plan grant abuse |
| H1 | HIGH | api/sheet/provision.js | 38-79 | TOCTOU duplicate provision |
| H2 | HIGH | api/whatsapp/webhook.js | 185-200 | KV idempotency TTL silently fails (wrong syntax) |
| H3 | HIGH | api/whatsapp/webhook.js | 98-104 | Meta HMAC verification optional |
| H4 | HIGH | api/sheet/provision.js | 105-123 | Mass-assignment on user record |
| H5 | HIGH | api/billing/checkout.js | 107-108 | Unvalidated success/cancel URLs |
| H6 | HIGH | multiple | various | Information disclosure in errors |
| H7 | HIGH | api/waitlist.js | 55, 74 | XFF spoofing rate-limit bypass |
| H8 | HIGH | api/auth/apple.js | 24-46 | Apple verifier missing iat-skew/nonce/JWKS cache |
| M1 | MEDIUM | all | various | JSON.parse prototype pollution surface |
| M2 | MEDIUM | api/billing/webhook.js | 71-73, 112-132 | Mass-assignment in plan update |
| M3 | MEDIUM | api/waitlist.js | 24-26 | KV-fail-open rate-limit bypass |
| M4 | MEDIUM | api/waitlist.js | 31-34 | CORS wildcard |
| M5 | MEDIUM | all | various | Sub not validated as charset/length |
| M6 | MEDIUM | api/sheet/summary.js | 67-68 | Sheet ID URL interpolation injection (chained) |
| M7 | MEDIUM | api/whatsapp/webhook.js | 123-156 | STOP/START unauthenticated DoS |
| L1 | LOW | multiple | various | Hardcoded GOOGLE_CLIENT_ID fallback |
| L2 | LOW | api/health.js | 38-51 | Env-var enumeration |
| L3 | LOW | all POSTs | various | No CSRF defense-in-depth |
| L4 | LOW | api/sheet/provision.js | 68 | userEmail not sanitized for Drive file name |

---

## Recommended Remediation Order

**Day 1 (stop the bleeding):**
1. Patch C1 + C2 — replace `X-User-Sub` trust with verified ID-token bearer auth across `summary`, `delete`, `provision`, `checkout`.
2. Patch C3 — verify ID token signature in `google-exchange` (refactor `verifyGoogleIdToken` into a shared module).
3. Patch H3 — make `META_APP_SECRET` mandatory.

**Week 1 (close the chain):**
4. C4 + H1 + H4 — refactor provisioning around the ID-token-verified `userSub` and add a provisioning lock.
5. C5 — Stripe customer↔userSub cross-check in webhook + remove `userSub` from checkout body.
6. H7 — fix XFF parsing, normalize email keys.

**Sprint 1 (defense in depth):**
7. H6 — strip details from all client-facing errors, log them server-side.
8. M1/M2 — adopt safe JSON parsing + allowlist field updates.
9. M5 — validate `sub` format at every entry point.
10. L1/L2 — remove hardcoded fallbacks, gate `/api/health` detail.

---

*End of report. Generated by Red Team Agent #1.*
