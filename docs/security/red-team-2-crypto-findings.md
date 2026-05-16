# Red Team 2 — Cryptography & Secrets Findings

**Auditor:** Red Team Agent #2 (crypto + secrets specialist)
**Date:** 2026-05-16
**Scope:** `api/`, `bot/`, `vercel.json`, `docs/architecture/security-hardening.md`
**Standard:** Apple/NVIDIA grade — fail-closed, defense-in-depth, no plaintext secrets at rest.

---

## Severity rubric

| Severity | Meaning |
|---|---|
| **CRITICAL** | Compromise of one account = compromise of all accounts, or remote auth bypass. |
| **HIGH** | Compromise of one account, or persistent attacker foothold. |
| **MEDIUM** | Weakens defense-in-depth; needs a second bug to exploit. |
| **LOW** | Hygiene / hardening that an external auditor will flag. |

---

## Findings table

| # | Severity | File:Line | Title |
|--:|---|---|---|
| 1 | CRITICAL | `api/auth/google-exchange.js:79-89` | ID token decoded without signature verification |
| 2 | CRITICAL | `api/auth/google-exchange.js:96-117` | Refresh tokens stored PLAINTEXT in Vercel KV |
| 3 | CRITICAL | `api/whatsapp/webhook.js:80` | Verify-token compared with `===` (timing oracle) |
| 4 | CRITICAL | `api/whatsapp/webhook.js:98-104` | HMAC verification SKIPPED when `META_APP_SECRET` not set |
| 5 | HIGH | `api/sheet/summary.js:51-52`, `api/account/delete.js:53` | `X-User-Sub` header trusted without auth (full IDOR) |
| 6 | HIGH | `api/billing/checkout.js:58` | `userSub` from request body — anyone can subscribe under any user |
| 7 | HIGH | `api/whatsapp/webhook.js:331-353` (and 4 other files) | `GOOGLE_CLIENT_SECRET` lacks defense-in-depth: no env check at module load |
| 8 | HIGH | `bot/DROPDOWN_FOR_UNSURE.gs:24-31` | Apps Script `ScriptProperties` holds `WA_TOKEN` plaintext, shared across all script editors |
| 9 | MEDIUM | `vercel.json:12` | CSP allows `'unsafe-inline'` for scripts — defeats XSS sandbox |
| 10 | MEDIUM | `api/whatsapp/webhook.js:114-300` | Idempotency key uses `seen:wa:<messageId>` w/o `NX` semantics — race window |
| 11 | MEDIUM | `api/billing/webhook.js:36` | Stripe sig verification doesn't trim whitespace around `t=` / `v1=` |
| 12 | MEDIUM | (whole project) | No `kfl_session` cookie / JWT used; auth is purely header-based per request |
| 13 | MEDIUM | `lib/crypto.js` (pre-rewrite) | No versioned envelope; rotation requires reading every record |
| 14 | LOW | `api/whatsapp/webhook.js:261` | `console.error('WRITE_BLOCKED_NO_REFRESH_TOKEN', { userSub, spreadsheetId })` logs userSub |
| 15 | LOW | `api/auth/google-exchange.js:40` | Default `GOOGLE_CLIENT_ID` hard-coded as a fallback — leaks across envs |
| 16 | LOW | `api/billing/webhook.js:130` | `new Date(sub.current_period_end * 1000)` throws on missing field — DoS via crafted payload |
| 17 | LOW | `api/health.js:38-50` | Health endpoint enumerates env-var presence (recon aid) — gate behind admin auth |
| 18 | LOW | `vercel.json` | No `Cache-Control: no-store` on `/account` and `/dashboard` HTML — token can stick in CDN |

---

## Detailed findings

### #1 — CRITICAL — ID token decoded without signature verification

**File:** `api/auth/google-exchange.js:79-89`

```js
if (tokens.id_token) {
  const payload = tokens.id_token.split('.')[1];
  identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
```

The handler splits the JWT and parses the payload **without verifying the signature**.

**Why is this currently "safe" (but you must still fix it):** the `id_token` arrives over a back-channel TLS call to `oauth2.googleapis.com`, so an external attacker cannot forge one in transit. Today the only way to reach this code is to have already exchanged a real code with Google.

**Why it must be fixed anyway:**
1. **Defense-in-depth.** If TLS pinning is misconfigured at Vercel's egress, or if a future code path lets an attacker supply `tokens` from anywhere other than Google, the entire identity layer collapses.
2. **Code reuse risk.** Other endpoints (`/api/sheet/summary`, `/api/account/delete`) trust the `sub` extracted here. If this function were ever reused for a client-supplied JWT, attackers forge any `sub` they like.
3. **Audit posture.** SOC 2 / ISO 27001 require *signature verification of all JWTs* — no "we trust the channel" exceptions.

**Exploit (the realistic one):** combined with finding #5, if any user-facing endpoint accepts a client-controlled JWT and feeds it through this parser, an attacker forges `sub=<victim's-google-sub>` with `alg: none` or with a self-signed RS256 key — gaining full access to the victim's sheet.

**Fix:**

```js
import { verifyGoogleIdToken } from '../../lib/crypto.js';

// inside handler, after fetching tokens:
let identity;
try {
  identity = await verifyGoogleIdToken(tokens.id_token, {
    audience: clientId,  // strict aud check
  });
} catch (e) {
  return res.status(401).json({ ok: false, error: 'id_token_invalid', detail: e.message });
}
```

---

### #2 — CRITICAL — Refresh tokens stored PLAINTEXT in Vercel KV

**File:** `api/auth/google-exchange.js:96-117`

```js
const record = {
  userSub: identity.sub,
  email: identity.email,
  refreshToken: tokens.refresh_token,   // <-- plaintext
  ...
};
await fetch(`${kvUrl}/set/${encodeURIComponent('user:' + identity.sub)}`, ...);
```

The inline comment at line 97 even admits the gap:
> "XOR with a server-side key is NOT secure — use a proper KMS in prod"

**Threat:** any read of Vercel KV (compromised KV API token, leaked Upstash backup, insider read, support engineer dump) yields **every refresh token for every user**. With those tokens the attacker:

- Reads every transaction in every user's sheet (`spreadsheets.values.get`).
- WRITES arbitrary fake transactions (`spreadsheets.values.append`).
- Renames the sheet (`spreadsheets.batchUpdate`).
- Drives any other scope granted (drive.file lets them read/modify any sheet the user has opened with Kesefle).

This is the single highest-impact bug in the system. One stolen token = one user. One stolen KV dump = all users.

**Exploit demonstration (conceptual):**

```sh
# Attacker has KV_REST_API_TOKEN from any leak (env file in dev, Vercel logs, dependabot PR, etc.)
curl -H "Authorization: Bearer $STOLEN_KV_TOKEN" \
     "$KV_REST_API_URL/get/user:1234567890" \
   | jq .result \
   | jq -r 'fromjson | .refreshToken' \
   | xargs -I{} curl -d "client_id=$KFL_CLIENT_ID&client_secret=$KFL_CLIENT_SECRET&refresh_token={}&grant_type=refresh_token" \
       https://oauth2.googleapis.com/token
# -> attacker now holds a valid Google access token for the victim's sheet.
```

**Fix:**

```js
import { encryptRefreshToken } from '../../lib/crypto.js';

// at storage time:
const record = {
  userSub: identity.sub,
  email: identity.email,
  // ...other fields
  // NOTE: refreshToken is REPLACED with refreshTokenEnvelope.
  refreshTokenEnvelope: encryptRefreshToken(tokens.refresh_token, identity.sub),
  encryptedAt: new Date().toISOString(),
};
```

```js
// at use time (whatsapp/webhook.js, sheet/summary.js):
import { decryptRefreshToken } from '../../lib/crypto.js';

const refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, userRec.userSub);
// AAD binding to userSub ensures envelope cannot be re-used if KV records are swapped.
```

The envelope format: `v1:<kid>:<base64url-iv>:<base64url-tag>:<base64url-ct>`. The KEK is `KESEFLE_DB_KEY` in Vercel env. The `<kid>` enables zero-downtime rotation (write keyring with `KESEFLE_DB_KEY_2026A=...`, set `KESEFLE_DB_KEY_ACTIVE_KID=2026A`, run rotation job).

---

### #3 — CRITICAL — Webhook verify-token compared with `===` (timing oracle)

**File:** `api/whatsapp/webhook.js:80`

```js
if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
  return res.status(200).send(challenge);
}
```

`===` for strings in V8 short-circuits on the first non-matching byte. An attacker who can measure RTT (worst-case: from the same Vercel region) can deduce the verify token byte-by-byte. With ~30 chars and ~50 µs resolution on a co-located attacker, the full token recovers in ≈30 × 256 × small-N = under a million requests.

**Exploit:** once the verify token is recovered, the attacker can complete Meta's webhook subscription handshake from a malicious endpoint, re-pointing the webhook to themselves and reading every inbound WhatsApp message of every user.

**Fix:**

```js
import { constantTimeEqual } from '../../lib/crypto.js';

if (mode === 'subscribe' && constantTimeEqual(token, process.env.META_VERIFY_TOKEN)) {
  return res.status(200).send(challenge);
}
```

Same fix for `api/account/delete.js:57` — the `'DELETE-MY-ACCOUNT'` compare doesn't matter cryptographically (the string is public), but a reviewer will still flag it.

---

### #4 — CRITICAL — HMAC verification SKIPPED when `META_APP_SECRET` not set

**File:** `api/whatsapp/webhook.js:98-104`

```js
const appSecret = process.env.META_APP_SECRET;
if (appSecret) {
  const sig = req.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(rawBody, sig, appSecret)) {
    return res.status(401).json({ ok: false, error: 'invalid signature' });
  }
}
// If META_APP_SECRET is unset: signature check is bypassed, EVERY POST processed.
```

**Threat:** a misconfigured production deploy (env var typo, rotation in progress) silently disables webhook authentication. Any HTTP client on the internet can POST a fake "user" message: bot writes attacker-controlled rows into the matched user's sheet, sends WhatsApp replies (potentially exhausting Meta send quota / hitting them in the 24h messaging window), and the optout/seen counters accumulate fake state.

**Fix:** fail closed.

```js
const appSecret = process.env.META_APP_SECRET;
if (!appSecret) {
  log.error('whatsapp.webhook.misconfigured', { reason: 'META_APP_SECRET missing' });
  return res.status(503).json({ ok: false, error: 'webhook_not_configured' });
}
const sig = req.headers['x-hub-signature-256'];
if (!verifyMetaSignature(rawBody, sig, appSecret)) {
  return res.status(401).json({ ok: false, error: 'invalid signature' });
}
```

Apply the same pattern to `api/billing/webhook.js` (already does it — good).

---

### #5 — HIGH — `X-User-Sub` header trusted as identity

**File:** `api/sheet/summary.js:51-52`, `api/account/delete.js:53`

```js
const userSub = req.headers['x-user-sub'] || req.query.userSub;
if (!userSub) return res.status(401).json({ ok: false, error: 'missing user identity' });

const userRec = await kvGet('user:' + userSub);
```

Any caller sets that header to any value. This is a full IDOR (Insecure Direct Object Reference): given any `sub` (which is non-secret, leaks via Google profile pages), attacker reads or deletes that user's account.

**Exploit (account deletion):**

```sh
curl -X POST https://kesefle.app/api/account/delete \
  -H 'Content-Type: application/json' \
  -H 'X-User-Sub: 1011223344556677889900' \
  -d '{"confirmation":"DELETE-MY-ACCOUNT"}'
# -> deletes user 1011...'s account record, revokes their Google token.
```

**Fix:** use the new `requireAuth` middleware from `lib/auth.js` which verifies a Bearer ID token via `verifyGoogleIdToken`. Already wired — every endpoint that currently reads `X-User-Sub` should be migrated to `requireAuth(handler)` and pull from `req.user.sub`.

---

### #6 — HIGH — `userSub` from request body in checkout

**File:** `api/billing/checkout.js:58`

```js
const userSub = String(body?.userSub || req.headers['x-user-sub'] || '').trim();
```

Combined with finding #5, an attacker creates a Stripe checkout session bound to `userSub: <victim>`. When the victim eventually subscribes legitimately, the orphan customer record may collide. More directly: the attacker pays for a Pro plan, but `subscription_data[metadata][userSub]` points to the victim — Stripe's webhook then marks the victim's account as Pro (which is mostly harmless but lets the victim get a free upgrade) OR the attacker as `pro` under the victim's sub (full account takeover at the plan level).

**Fix:** same as #5. Trust only `req.user.sub` from `requireAuth`.

---

### #7 — HIGH — `GOOGLE_CLIENT_SECRET` only checked at use

**Files:** `api/auth/google-exchange.js:42`, `api/whatsapp/webhook.js:334`, `api/sheet/summary.js:27`

```js
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientSecret) {
  return res.status(500).json({ ok: false, error: 'server misconfigured: ...' });
}
```

This check happens on every request, leaking misconfiguration to clients. A reconnaissance attacker can map which environment is misconfigured by which endpoint returns 500.

**Fix:** centralize. In a `lib/env.js` module, validate every required secret at module load (`throw new Error()` at import) so cold-start fails closed. Vercel will surface the error in the build/deploy log, not in production traffic. Sample:

```js
// lib/env.js
const REQUIRED = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'KESEFLE_DB_KEY',
];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    if (process.env.NODE_ENV === 'production') throw new Error(`missing required env: ${k}`);
    else console.warn(`[env] missing ${k} (dev only — would crash in prod)`);
  }
}
```

---

### #8 — HIGH — Apps Script `ScriptProperties` for `WA_TOKEN`

**File:** `bot/DROPDOWN_FOR_UNSURE.gs:24-31`

```js
var sp = PropertiesService.getScriptProperties();
return {
  token: sp.getProperty('WA_TOKEN') || '',
  phoneId: sp.getProperty('WA_PHONE_ID') || '',
};
```

Apps Script `ScriptProperties` is:
- **Shared across all script editors** for the project. Any collaborator with edit access reads `WA_TOKEN` in cleartext via `console.log` from the editor.
- **Exported in project backups.** If you ever click File → Make a copy, the new project inherits the property values (potentially leaking to a personal Drive).
- **Visible in Apps Script execution logs** if any code line accidentally `Logger.log`s the config object.

**Risk level:** MEDIUM if you control all collaborators tightly, HIGH the moment the project is shared for code review.

**Fix recommendations** (in order of impact):
1. **Don't store WA_TOKEN in Apps Script at all.** The Vercel `api/whatsapp/webhook.js` is the future. Migrate the bot off Apps Script (already on the roadmap per `NEXT_STACK_PLAN.md`).
2. While migrating, restrict editor access to one Google account.
3. Move `WA_TOKEN` to `UserProperties` (per-user, not project-wide) using the bot service account.
4. Document the risk in the bot README — anyone who gets edit on the script can exfiltrate. Treat the project ACL as a Tier-1 secret store.

---

### #9 — MEDIUM — CSP `'unsafe-inline'` for scripts

**File:** `vercel.json:12`

```
script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://accounts.google.com ...
```

`'unsafe-inline'` allows any inline `<script>` and `on*=` handler. Combined with a stored-XSS (e.g. an unsanitized expense category showing up in `dashboard.html`), an attacker exfiltrates the session cookie or CSRF token.

**Fix:**
1. Move every inline script in `index.html`, `dashboard.html`, `account.html`, `test.html` into external files under `/assets/js/*.js`.
2. Add a per-page nonce generated server-side (Vercel Edge middleware can inject a random nonce per response): `script-src 'self' 'nonce-<random>' ...`.
3. Drop `'unsafe-inline'` once verified.

Stripe, Tailwind, and Google Identity all support nonce-based CSP.

---

### #10 — MEDIUM — Idempotency race in WhatsApp webhook

**File:** `api/whatsapp/webhook.js:184-200`

```js
const seenKey = `seen:wa:${messageId}`;
if (await kvGet(seenKey)) {
  return res.status(200).json({ ok: true, ignored: 'duplicate' });
}
// ... later ...
await fetch(`${kvUrl}/set/${encodeURIComponent(seenKey)}?EX=86400`, ...);
```

Two concurrent invocations of the same `messageId` (Meta retries on timeout) both pass the `kvGet` check before either writes — both end up appending the row, both reply.

**Fix:** use SETNX (atomic set-if-not-exists). Upstash Redis supports `SET k v NX EX 86400` via `/set/<k>/<v>?nx=true&ex=86400`. Reject if the response is `null` (already existed).

---

### #11 — MEDIUM — Stripe signature parsing doesn't trim

**File:** `api/billing/webhook.js:27-32`

```js
const parts = Object.fromEntries(
  sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
);
const t = parseInt(parts.t, 10);
const v1 = parts.v1;
```

Looks defensive but: Stripe's header is comma-separated with NO whitespace by spec, and `parts.v1` is treated as a hex string for `Buffer.from(v1, 'hex')`. The constant-time compare via `crypto.timingSafeEqual` will throw if the buffers differ in length, which is caught — but only as `'compare_failed'`, indistinguishable from a real mismatch (good).

**Edge case to harden:** Stripe sometimes sends **multiple `v1=` entries** (when rotating webhook signing secrets). Today only the last one wins via `Object.fromEntries`. Fix:

```js
function parseStripeSig(h) {
  const t = h.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1];
  const v1s = [...h.matchAll(/(?:^|,)v1=([a-f0-9]+)(?:,|$)/g)].map(m => m[1]);
  return { t: t ? parseInt(t, 10) : null, v1s };
}

// then verify against ALL v1 candidates:
for (const v1 of v1s) {
  if (timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'))) return { ok: true };
}
```

This is exactly how Stripe's own `stripe.webhooks.constructEvent` handles rotation.

---

### #12 — MEDIUM — No session cookie / JWT

The system today uses bearer `X-User-Sub` (broken) or `Authorization: Bearer <google-id-token>` (only after #5 fix). There's no concept of a **short-lived session** with sliding refresh.

**Recommendation:**
1. After a successful Google sign-in (via `/api/auth/google` or `/api/auth/google-exchange`), issue a `kfl_session` cookie:
   ```
   Set-Cookie: kfl_session=<HS256-JWT>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
   Set-Cookie: kfl_csrf=<random>; Secure; SameSite=Lax; Path=/; Max-Age=86400
   ```
2. The JWT payload: `{ sub, email, iat, exp }`. Signed with `KESEFLE_DB_KEY` (HS256 via `signSessionJWT`).
3. Sliding refresh: any request older than 12h but younger than 24h triggers a re-sign with a fresh exp. Beyond 24h: 401, redirect to /account.
4. For state-changing routes, double-submit CSRF: server checks `req.headers['x-csrf-token'] === cookie['kfl_csrf']` in **constant time**.

This eliminates the need for the browser to keep the Google ID token in memory, which would otherwise be exfiltrable via stored XSS (and #9 makes that easier today).

---

### #13 — MEDIUM — No versioned envelope (FIXED)

The original `lib/crypto.js` mixed a binary envelope format with two key namespaces (`KEY_ID_APP` vs `KEY_ID_DB`) and required reading every record to rotate.

**Fixed** in the rewrite at `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/crypto.js`:
- Envelope is `v1:<kid>:<iv>:<tag>:<ct>` (text, base64url, URL-safe).
- Keyring loaded from env (`KESEFLE_DB_KEY` + `KESEFLE_DB_KEY_<KID>` rotation entries).
- Active kid selected by `KESEFLE_DB_KEY_ACTIVE_KID`.
- Re-read every 60s — Vercel runtime rotation supported without redeploy.
- `inspectEnvelope()` + `reEncrypt()` helpers enable an offline rotation cron.

---

### #14 — LOW — userSub in error logs

**File:** `api/whatsapp/webhook.js:261`

```js
console.error('WRITE_BLOCKED_NO_REFRESH_TOKEN', { userSub: userRecord.userSub, spreadsheetId: userRecord.spreadsheetId });
```

`userSub` is the Google subject — a stable identifier that, combined with `email` from logs elsewhere, fingerprints users uniquely. Should use the redacting logger.

**Fix:**

```js
import { log } from '../../lib/log.js';
log.error('write.blocked_no_refresh_token', { userSub: userRecord.userSub, spreadsheetId: userRecord.spreadsheetId });
// log.js already redacts via SECRET_KEY_PATTERNS — userSub passes through which is OK for our threat model;
// but spreadsheetId is sensitive (it's the URL anyone can hit) — add 'spreadsheet' to the redact pattern.
```

---

### #15 — LOW — Hard-coded fallback `GOOGLE_CLIENT_ID`

**File:** `api/auth/google-exchange.js:40`

```js
const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
```

A fallback means a dev environment can silently exchange tokens against the PROD client ID — and Google then returns tokens that production trusts. Fail closed instead.

---

### #16 — LOW — DoS via missing `current_period_end`

**File:** `api/billing/webhook.js:130`

`new Date(undefined * 1000)` returns `Invalid Date`; `.toISOString()` throws. A Stripe API change or a forged-but-signed event (won't happen if HMAC is good, but defense-in-depth) crashes the handler.

**Fix:** validate every field before use.

---

### #17 — LOW — Health endpoint enumerates env vars

**File:** `api/health.js:38-50`

Returns `{ env_configured: { google_client_id: true, stripe_secret_key: false, ... } }`. Helpful for ops, but also tells an attacker which secrets aren't set (and thus which signature checks may be skipped per #4).

**Fix:** gate `env_configured` behind `requireAdmin` (already exists in `lib/auth.js`). The public response should be a flat `{ ok: true|false }`.

---

### #18 — LOW — No `no-store` on HTML

**File:** `vercel.json`

`/api/(.*)` has `Cache-Control: no-store` (good), but `/account` and `/dashboard` HTML do not. A logged-in user's response could be cached by an intermediary if they ever expose user data inline. Set `Cache-Control: private, no-store` on those routes.

---

## Encryption key delivery to Vercel

**Recommendation:**
1. Generate three independent 32-byte keys (one per env):
   ```sh
   # locally, never check in
   node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
   ```
2. Store each in 1Password under "Kesefle Production / Staging / Dev — DB KEK".
3. Inject into Vercel via `vercel env add KESEFLE_DB_KEY production` (encrypted at rest, only visible during deploy).
4. **Never** share dev-key with staging-key. A dev compromise must NOT decrypt prod data.
5. For rotation: `vercel env add KESEFLE_DB_KEY_2026A production` (new key), `vercel env add KESEFLE_DB_KEY_ACTIVE_KID 2026A production`, redeploy, run rotation job, then `vercel env rm KESEFLE_DB_KEY production` after the overlap window.
6. **Apps Script:** until the bot migrates off Apps Script, store the WA_TOKEN at `UserProperties` level (per-script-user), not `ScriptProperties` (project-wide).

---

## What was delivered

| Artifact | Path |
|---|---|
| Encryption helper module | `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/crypto.js` |
| This findings report | `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/docs/security/red-team-2-crypto-findings.md` |

`lib/crypto.js` exports the API your spec requires:

- `encrypt(plaintext, { aad? })` → `v1:<kid>:<iv>:<tag>:<ct>` (colon-separated, base64url).
- `decrypt(envelope, { aad? })` → plaintext; collapses all auth failures to a single error.
- `reEncrypt(envelope)` for rotation jobs.
- `hmacSign(data)` → base64url HMAC-SHA256.
- `hmacVerify(data, sig)` → constant-time, length-safe.
- `constantTimeEqual(a, b)` → use for ANY secret compare.
- `genCsrfToken()` → 32 random bytes, base64url.
- `randomToken(bytes)` → generic CSPRNG token.
- `signSessionJWT(payload, ttlSec)` / `verifySessionJWT(token)` → HS256, hard-coded header, alg=none rejected.
- `verifyGoogleIdToken(idTokenJwt, { audience, clockSkewSec })` → RS256, JWKS cache, kid-miss refresh, strict claims.
- `encryptRefreshToken(rt, userSub)` / `decryptRefreshToken(env, userSub)` → AAD-bound to userSub.
- `redact(obj)` → recursive secret-key redaction for safe logging.

Self-test (`KESEFLE_CRYPTO_SELFTEST=1`) runs on import to catch misconfig at cold start.
