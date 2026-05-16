# Data-Flow Audit — Kesefle API endpoints

**Owner:** Security
**Last updated:** 2026-05-16
**Scope:** every endpoint under `/api/*` as of this commit. For each: what comes in, what goes out, what is stored, what is logged, and a "leak risk" verdict.

Read this alongside `data-classification.md` (the inventory) and `security-hardening.md` (the mitigations). This document is the bridge: it answers "for endpoint X, is field Y handled per its class?"

Severity legend used below:
- **OK** — handled correctly.
- **MINOR** — improvement worth doing but no current exposure.
- **MAJOR** — actual leak risk; fix before launch.
- **CRITICAL** — exploitable now; fix today.

---

## `/api/health` (GET)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | none | — | |
| Out | build SHA, region, dep checks, **env_configured flags** | INTERNAL | Names of present env vars only — values never printed. |
| Storage | none | — | |
| Logged | nothing | — | |

**Verdict: OK.** Env flag map is intentional for ops health. Worth restricting in production to authenticated callers (MINOR) so we don't advertise which integrations are wired.

---

## `/api/waitlist` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `email`, `source`, IP (header), UA, Referer | CONFIDENTIAL | |
| Out | `{ ok: true }` | — | |
| Storage | `wait:<ts>:<rand>` (email + ts + UA + IP), `waitlist_emails` set | CONFIDENTIAL | |
| Logged | `KV write failed` on error path — error message only, no email | — | |

**Verdict: OK.** Rate-limited per IP + per email. **MINOR**: the entry stores IP + UA in clear for marketing attribution — that's fine but should be enumerated in the privacy policy with a 730-day retention cap.

---

## `/api/auth/google` (POST) — ID-token verification (sign-in)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `credential` (Google ID token, JWT) | RESTRICTED while in flight | |
| Verification | JWKS-fetched RSA pubkey; aud/iss/exp checked | — | Correct. |
| Out | `user` = { sub, email, emailVerified, name, picture, locale, provider, firstSeen } | CONFIDENTIAL | |
| Storage | KV `user:google:<sub>` ← user object; SADD to `users_all` | CONFIDENTIAL | |
| Logged | "KV write failed" with error message; on no-KV fallback **`USER_SIGNUP <full user JSON>`** | CONFIDENTIAL → log leak | |

**Verdict: MAJOR.**
The no-KV fallback path `console.log('USER_SIGNUP', JSON.stringify(user))` writes email + name in clear to function logs. That violates the classification (CONFIDENTIAL must not be in plain console output where it'll persist 30–90 d in Vercel logs). Fix: replace with `log.info('user.signup', { subHash, provider })` from `lib/log.js`.

**MINOR:** This endpoint uses a different KV key namespace (`user:google:<sub>`) than `/api/auth/google-exchange` (`user:<sub>`). The webhook reads `user:<sub>`. So sign-in here doesn't help the webhook — only the OAuth exchange creates the webhook-discoverable record. Worth either consolidating or removing this endpoint entirely now that exchange is live.

---

## `/api/auth/apple` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `id_token` (Apple JWT), optional `user.name` | RESTRICTED while in flight | |
| Out | user object | CONFIDENTIAL | |
| Storage | `user:apple:<sub>` | CONFIDENTIAL | |
| Logged | same `USER_SIGNUP` JSON dump on no-KV fallback | — | |

**Verdict: MAJOR (same leak as google.js).** Same fix.

---

## `/api/auth/facebook` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `accessToken`, `userID` | RESTRICTED while in flight | |
| Verification | `/debug_token` against `app_id|app_secret` | — | Correct. |
| Out | user object | CONFIDENTIAL | |
| Storage | `user:facebook:<sub>` | CONFIDENTIAL | |
| Logged | same `USER_SIGNUP` JSON dump | — | |

**Verdict: MAJOR.** Same fix.

**MINOR:** `debug_token` request constructs an `appsecret_proof` substitute `app_id|app_secret` — that's the documented Facebook server-token format, OK, but the URL ends up in fetch debug logs if anyone enables verbose logging. The current code doesn't enable that — leaving as a future hardening note.

---

## `/api/auth/google-exchange` (POST) — PKCE code → tokens (the important one)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `code`, `codeVerifier`, `redirectUri` | RESTRICTED (the code is a bearer cred until exchanged) | |
| Token exchange | POST to `oauth2.googleapis.com/token` | — | TLS, parameterized form body — OK. |
| Tokens received | `id_token`, `access_token`, `refresh_token`, `scope` | RESTRICTED | |
| Storage | **`user:<sub>` ← { …, refreshToken, scopes, … } in plaintext JSON** | RESTRICTED stored as CONFIDENTIAL | |
| Logged | `user_record_kv_save_failed` w/ error only | OK | |
| Out | `{ user, accessToken, expiresIn, hasRefreshToken }` | — | Refresh token NOT returned. OK. |

**Verdict: CRITICAL.**
The refresh token is stored in plain JSON in Vercel KV. The code comment even acknowledges it: *"For now: store in KV with the assumption KV is access-controlled. TODO: AES-GCM with KEK from env."*

A KV dump (compromise of `KV_REST_API_TOKEN`, a Vercel access key, or a Supabase backup later on) would expose every user's Google refresh token — which gives sheet read/write and email access for as long as Google honors the grant.

**Fix:** replace direct fetch with `secure-kv.saveUser(sub, { refreshToken, ... })`. The `secure-kv.js` wrapper encrypts the refresh token field with `KESEFLE_DB_KEY` envelope before writing.

**MAJOR:** Decodes ID token without verifying its signature. Trust is borderline-OK because the code came from Google moments earlier, but defence-in-depth says verify anyway. Add a JWKS check (re-using `verifyGoogleIdToken` from `/api/auth/google.js`).

---

## `/api/sheet/provision` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `accessToken` (Google short-lived), `userSub`, `userEmail` | RESTRICTED while in flight | |
| Drive API | Copies template to user's Drive — well-scoped (drive.file) | — | OK. |
| Storage | `sheet:<sub>` ← { spreadsheetId, … }; merges spreadsheetId into `user:<sub>` | CONFIDENTIAL | |
| Logged | `SHEET_PROVISIONED <full record>` on no-KV path | CONFIDENTIAL | |

**Verdict: MAJOR (logging) + MINOR (auth model).**
The no-KV fallback `console.log('SHEET_PROVISIONED', JSON.stringify(record))` dumps the user email + sheet ID. Replace with `log.info('sheet.provisioned', { subHash, hasSpreadsheet: true })`.

**MAJOR:** No authentication on this endpoint. Anyone with a valid Google access token (which they could have obtained themselves for their own Google account) can POST any `userSub` and overwrite that user's `sheet:<sub>` record — pointing them at an attacker-owned spreadsheet. Then the webhook would write the attacker's "user's" expenses to the attacker's sheet, and the victim's summary endpoint would read from it. Fix: verify the access token belongs to the same Google identity as `userSub` (call `tokeninfo` with the access token, compare `sub`).

**Cross-tenant risk:** YES, present today. This is the biggest live bug in the audit.

---

## `/api/sheet/summary` (GET)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `X-User-Sub` header / `userSub` query | CONFIDENTIAL (auth context) | **Trusted from client without verification** |
| Storage read | `user:<sub>` (gives `refreshToken`, `spreadsheetId`) | RESTRICTED + CONFIDENTIAL | |
| Token refresh | exchanges refresh → access (server-only) | RESTRICTED | OK — token never returned to caller |
| Sheets read | `'תנועות'!A2:I5001` | CONFIDENTIAL | OK over TLS |
| Out | aggregated month totals + 10 recent transactions (with raw text) | CONFIDENTIAL | Owner only |
| Logged | nothing on success; error-text snippets (no tokens) on failure | OK | |

**Verdict: CRITICAL.**
`X-User-Sub` is set by the client. Anyone can claim to be any `sub` and read that user's spreadsheet contents. Header-based identity is **not authentication**.

Fix: require a verified session JWT (the `kfl_session` cookie from `lib/crypto.js signJWT`/`verifyJWT`). The header is fine as a UX hint but the server must take `sub` from the verified JWT alone. The code comment acknowledges: *"Production hardening TODO: verify ID token signature server-side instead of trusting client."* — this is that.

**MINOR:** Reads up to 5000 rows on every dashboard hit. As users grow this is a Sheets API quota risk + a latency cost. Cache the result for ~30s in KV per user.

---

## `/api/whatsapp/webhook` (GET + POST)

### GET (verification handshake)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `hub.mode`, `hub.verify_token`, `hub.challenge` | INTERNAL | |
| Out | challenge string on match, 403 otherwise | — | |

**Verdict: OK.** Constant-string compare; not a constant-time compare, but the verify_token is server-generated low-value. **MINOR:** switch to `crypto.timingSafeEqual` for completeness.

### POST (inbound message)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | raw body bytes; `x-hub-signature-256` | RESTRICTED while in flight | |
| Verification | HMAC SHA-256 over raw bytes vs `META_APP_SECRET` | — | OK now — `bodyParser: false` correctly captures raw bytes. |
| Storage (reads) | `phone:<E.164>` → user record with refresh token; `optout:<phone>`; `seen:wa:<msg_id>` | RESTRICTED (refresh token comes in plaintext today) | |
| Storage (writes) | `optout:<phone>` (on STOP), `last_inbound:<phone>`, `seen:wa:<msg_id>` (24 h TTL) | INTERNAL | |
| Token refresh | refresh → access | RESTRICTED | OK |
| Sheets write | one row appended to user's sheet | CONFIDENTIAL (user's data, user's sheet) | |
| Out | 200 with `{ ok: true }` plus internal flags | — | OK |
| Logged | `WRITE_BLOCKED_NO_REFRESH_TOKEN` — includes `userSub` and `spreadsheetId` | CONFIDENTIAL → minor leak | |
| Logged | `access_token_refresh_failed`, `sheet_write_failed` w/ error text | — | OK (no token bytes in error) |

**Verdict: MAJOR.**
1. `console.error('WRITE_BLOCKED_NO_REFRESH_TOKEN', { userSub, spreadsheetId })` puts both identifiers in clear in Vercel logs. Replace with `log.error('sheet.write_blocked.no_refresh_token', { subHash, hasSpreadsheet: true })`.
2. The refresh token reaches this endpoint from KV in plaintext today; after `lib/secure-kv.js` is wired it'll be decrypted only in memory.
3. **MINOR:** opt-out + last_inbound writes are best-effort with empty `catch (e) {}` blocks. Add `log.warn('optout.write_failed', ...)` so we notice when KV is misbehaving.
4. **MINOR:** No rate limit. WhatsApp signed the message so a flood would be a Meta-spoofing scenario (covered by HMAC); but a leaked `META_APP_SECRET` would allow unbounded webhook calls. Add per-phone rate limit (60 messages / 5 min).

### Cross-tenant risk

The webhook resolves a user via `phone:<E.164>` — a key only writeable by trusted server endpoints. **No cross-tenant risk here today** as long as `/api/sheet/provision`'s missing auth (above) is fixed: that's the only path by which an attacker could associate their sheet with another user.

---

## `/api/billing/checkout` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `plan`, `userSub`, `userEmail` | CONFIDENTIAL | `userSub` trusted from body/header without verification |
| Storage read | `user:<sub>` to find existing `stripeCustomerId` | CONFIDENTIAL | |
| Stripe create | customer (with email + userSub metadata), checkout session | CONFIDENTIAL → Stripe | OK |
| Storage write | `user:<sub>.stripeCustomerId` | CONFIDENTIAL | |
| Out | Stripe checkout URL | — | OK |
| Logged | nothing on success | OK | |

**Verdict: MAJOR.**
Trusts `userSub` from request body/header. An attacker can mint a checkout for another user's `sub`, which would then assign **the attacker's Stripe customer ID** to the victim's user record. When the attacker pays, the victim becomes Pro (transferable value), and when the victim's card declines (because it's the attacker's card), the victim loses their plan. This is a low-stakes griefing scenario but real. Fix: take `sub` from verified JWT.

**MINOR:** No rate limit (`security-hardening.md` calls for 20/h per user). Easy add.

---

## `/api/billing/webhook` (POST) — Stripe events

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | raw body; `stripe-signature` (t + v1) | RESTRICTED while in flight | |
| Verification | HMAC over `t.body` with timestamp tolerance 300 s | — | Correct. |
| Idempotency | `stripe_event:<id>` (no TTL specified — should be ~30 d) | INTERNAL | |
| Storage write | `user:<sub>` plan/status/period fields | CONFIDENTIAL | |
| Out | `{ ok: true, processed: <type> }` | — | OK |
| Logged | `stripe_event_unhandled` (type + id), `PAYMENT_FAILED` (invoice id + customer id) | OK — Stripe IDs, not PII | |

**Verdict: MINOR.**
1. `stripe_event:<id>` written via `kvSet` without TTL — it accumulates forever. Set a 30-day TTL (Stripe's retry window is ≤ 3 days; 30 d is generous).
2. Webhook trusts `event.data.object.metadata.userSub` — that's user-controlled at checkout creation time. With Issue checkout above fixed, this remains safe; without that fix, this is the propagation channel.

---

## `/api/account/delete` (POST)

| Phase | Data | Class | Notes |
|---|---|---|---|
| In | `confirmation: 'DELETE-MY-ACCOUNT'`, `X-User-Sub` | CONFIDENTIAL | `userSub` trusted from header |
| Storage read | `user:<sub>` (gets refresh token) | RESTRICTED | |
| Google revoke | `oauth2.googleapis.com/revoke?token=<refresh>` | — | Token in URL query string — best practice would be POST body but Google's docs accept either. OK. |
| Storage delete | `user:<sub>`, `sheet:<sub>` | — | **`phone:<E.164>` NOT deleted** — left in KV pointing to a now-deleted user. |
| Audit | `audit:delete:<ts>:<sub8>` entry with IP | CONFIDENTIAL | |
| Out | summary + ack | — | OK |

**Verdict: MAJOR.**
1. Trusts `X-User-Sub` from header. Anyone can delete anyone's account with just their `sub` (which leaks naturally — it appears in pages the user shares, etc.). Fix: require verified JWT. The `confirmation` string helps with CSRF but not with impersonation.
2. `phone:<E.164>` pointer is not cleaned up. After deletion, an inbound WhatsApp from that number resolves to a missing user, and the webhook (correctly) replies "no account linked" — but the stale pointer means re-onboarding the same phone to a different account collides. Fix: in `secure-kv.deleteUser`, look up the existing user's `phoneE164` and delete its pointer too. (The new lib does this.)

---

## Common patterns across the audit

### "Trust the client's `X-User-Sub`" — the recurring vulnerability

`/api/sheet/summary`, `/api/billing/checkout`, `/api/account/delete` all accept the user's identity from a client-controlled header. **All three become safe** by gating on a verified `kfl_session` JWT and reading `sub` from inside. The `lib/crypto.js` `verifyJWT` helper already exists; the missing piece is `lib/auth.js` `requireUser` middleware. That single helper closes three CRITICAL/MAJOR issues at once.

### "Refresh token in clear in KV" — the unprotected crown jewel

Today `/api/auth/google-exchange` writes plaintext `refreshToken` to `user:<sub>`. `lib/secure-kv.saveUser` encrypts it transparently. Replacing the four `fetch(...KV_REST_API_URL...)` blocks in `google-exchange.js`, `sheet/provision.js`, `whatsapp/webhook.js`, and `account/delete.js` with `getUser`/`saveUser`/`deleteUser` closes this.

### "Plain JSON dumps on no-KV fallback"

`USER_SIGNUP`, `SHEET_PROVISIONED`, `WAITLIST` all `console.log(JSON.stringify(...))` raw records on the dev fallback path. These run in production any time KV env vars aren't set. Replace with `log.info('event', { ...redacted })`.

### "Empty catch blocks swallow KV errors"

The webhook contains six `catch (e) { /* non-fatal */ }` blocks. Replace with `log.warn('kv.write_failed', { event, error: e.message })` so we can spot KV degradation without escalating to user-visible errors.

## Priority order to fix

1. **(CRITICAL) `/api/sheet/summary` — verify JWT, don't trust `X-User-Sub`** — every user's data is currently readable by anyone who knows their `sub`.
2. **(CRITICAL) `/api/auth/google-exchange` — encrypt refresh token at rest** — switch to `secure-kv.saveUser`.
3. **(MAJOR) `/api/sheet/provision` — verify access token belongs to `userSub`** — closes cross-tenant association attack.
4. **(MAJOR) `/api/billing/checkout`, `/api/account/delete` — verify JWT** — same single fix as #1.
5. **(MAJOR) All `console.log(JSON.stringify(...))` fallback paths** — swap to `lib/log.js` redaction.
6. **(MINOR) Stripe event TTL, rate limits, opt-out logging, JWT verification on Google ID token in exchange flow.**
