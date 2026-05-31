# OAuth + Drive scope audit — 2026-05-31

Scope: `lib/auth.js`, `lib/crypto.js`, `lib/secure-kv.js`, `lib/log.js`,
`lib/sheet-writer.js`, `api/auth/google.js`, `api/auth/google-exchange.js`,
`api/account.js`, `api/whatsapp/webhook.js`, `api/sheet/provision.js`,
`api/sheet/getExpenses.js`, `api/sheet/summary.js`, `api/cron/kv-backup.js`,
`api/_lib/session.js`, `account.html`.

## Summary
- Scopes requested: `openid email profile https://www.googleapis.com/auth/drive.file` (no `drive`, no `drive.readonly`, no `spreadsheets`)
- Refresh token storage: WARN — encrypted envelope on all NEW writes; legacy plaintext field still read for pre-migration users and silently preserved through `...existing` spread on re-login
- AAD binding: PASS — AAD = `kfl-refresh:<userSub>` enforced by `encryptRefreshToken`/`decryptRefreshToken`; cross-tenant envelope swap fails authentication
- Rotation handled: FAIL — Google's rotated refresh_token returned by the `refresh_token` grant is never captured anywhere (5 call sites)
- Revoke on delete: PASS — both web (`deleteAccount`) and bot (`deleteByPhone`) paths revoke via `https://oauth2.googleapis.com/revoke`, decrypting envelope and falling back to legacy plaintext
- ID token verification: PASS — RS256-only, JWKS-backed, audience+issuer+exp+iat all checked; HS256 session cookie correctly constant-time verified
- Bugs found: 8 (1 high, 3 medium, 4 low)

## Findings

### H1 (HIGH) — Refresh-token rotation never persisted; will silently break after 6 months
Google rotates the `refresh_token` for grants older than ~6 months by returning a new `refresh_token` field on the next `grant_type=refresh_token` exchange. After rotation the OLD token is revoked within hours. Every refresh-for-access call in the codebase reads only `j.access_token` and discards `j.refresh_token`:

- `api/whatsapp/webhook.js:457-479` `exchangeRefreshForAccess`
- `api/account.js:98-112` `exchangeRefreshForAccess` (used by `exportAccount`)
- `api/sheet/getExpenses.js:28-51` `refreshAccessToken`
- `api/sheet/summary.js` `refreshAccessToken` (same pattern)
- `api/cron/kv-backup.js:109-123` admin token mint
- `lib/sheet-writer.js:1190-1206` (assumed by symmetry — confirmed by grep)

After rotation, the bot will fail to write with `refresh_failed` for affected users and they will be forced to re-link, which is invisible to them until they message and see no reply.

A `grep -n "j\.refresh_token" api/ lib/` returns zero hits outside the initial OAuth code-exchange in `google-exchange.js:149-156`.

Recommendation: extract a single `exchangeRefreshForAccess(refreshToken, userSub)` helper that, on a non-empty `j.refresh_token` in the response, re-encrypts via `encryptRefreshToken(j.refresh_token, userSub)` and writes BOTH `user:<sub>.refreshTokenEnvelope` AND `token:<sub>.refreshTokenEnvelope` under a `LockService`-style guard (a `SETNX` lock key in KV to avoid double-write races). Add a test under `tests/` that asserts the helper persists a returned rotation token.

### M1 (MEDIUM) — Legacy plaintext `refreshToken` field is preserved on re-login
`api/auth/google-exchange.js:168-179` builds the user record as `{ ...(existing || {}), ..., refreshTokenEnvelope, ... }`. If `existing` carries a pre-migration `refreshToken: "1//0..."` plaintext field, the spread copies it into the new write — the envelope coexists with plaintext indefinitely. The comment at line 174 ("plaintext is NEVER stored anymore") is contradicted by the spread on line 169.

Recommendation: add `delete record.refreshToken;` after the spread, and ship a one-shot backfill under `scripts/` (idempotent, dry-run first) that scans every `user:*` record, encrypts any non-null `refreshToken` into a fresh envelope, and unsets the plaintext field. The `lib/log.js` redactor already masks the field name in logs (line 18) so post-backfill there is no surface left.

### M2 (MEDIUM) — Plaintext `accessToken` is stored in `token:<sub>` KV record
`api/auth/google-exchange.js:217-225` writes `accessToken: tokens.access_token` (plaintext) into the `token:<sub>` KV entry, and `api/sheet/getExpenses.js:126-127` rewrites the same plaintext on every refresh. Although access tokens are short-lived (~1h), `lib/secure-kv.js:88` already declares `accessToken: { encrypt: true, purpose: 'kfl-access' }` — meaning the secure-kv path would encrypt it, but the direct-fetch path bypasses secure-kv entirely.

The exposure is bounded: an attacker who exfiltrates KV gets at most ~1h of Sheets API window per user. Still worth fixing because (a) the redactor only masks log lines, not at-rest data, and (b) Vercel KV is one stolen `KV_REST_API_TOKEN` from being readable.

Recommendation: migrate the two write sites to `secure-kv.saveUser` (or split into a thin `setTokenRecord` helper inside `lib/secure-kv.js` that wraps `accessToken` via the existing schema). Until then, document the exposure window in `SECURITY.md`.

### M3 (MEDIUM) — `google-exchange.js` does not verify `email_verified` claim
`api/auth/google-exchange.js:131` calls `verifyGoogleIdToken` (RS256 + audience), but does not enforce `payload.email_verified === true` before creating the user record. By contrast, `api/auth/google.js:81` correctly checks `emailVerified: payload.email_verified === true`. An attacker who controls a Google Workspace tenant can issue tokens with arbitrary unverified email addresses; this would let them impersonate a real user's email at signup (the `sub` is still tied to the attacker, so they cannot read another user's sheet, but they can pollute the user record's `email` field and any email-based admin lookups including `ADMIN_EMAILS` check in `lib/auth.js:208-224`).

Recommendation: after the `verifyGoogleIdToken` call in `google-exchange.js`, add `if (identity.email_verified !== true) return res.status(403).json({ ok: false, error: 'email_not_verified' });` This is also what's needed before any email-keyed lookup (admin allowlist) is trusted downstream.

### L1 (LOW) — No OIDC `nonce` parameter in the auth-code request
`account.html:1264-1274` builds the OAuth URL with `state` (good, CSRF) and PKCE (good), but no `nonce`. Google ID tokens echo back `nonce` in the payload when set; including and verifying it eliminates token-substitution attacks where an attacker injects a valid ID token from a different session.

Risk is low because PKCE + state already block code-injection; the residual is theoretical (an attacker who phishes a token from a separate flow). Recommendation: generate a random `nonce`, stash alongside `kfl_pkce_verifier_<state>` in sessionStorage, include in the auth URL, and verify `identity.nonce === stored` server-side in `google-exchange.js`.

### L2 (LOW) — OAuth state validation is client-side only
`account.html:1304` checks `savedState === state` in browser sessionStorage. If sessionStorage is cleared mid-flow (private mode quirks, in-app webview quirks) or if the redirect lands on a different origin, the validation is the only barrier. Server-side state validation is impossible without a server round-trip at flow start. Document acceptable since PKCE already binds the code to this browser, and the state's role is just CSRF.

No change required, but record this rationale in `SECURITY.md`.

### L3 (LOW) — Cookie-name docstring mismatch
`lib/auth.js:6` and `:120` reference cookie `kfl_session`, but the actual cookie name in `api/_lib/session.js:3` is `kefle_session`. Cosmetic only — no runtime impact (only one reader, one writer). Fix the comments to match.

### L4 (LOW) — Session cookie uses `SESSION_SECRET` env var, separate from KEK
`api/_lib/session.js:30-36` requires `SESSION_SECRET` (≥ 16 chars), while `lib/crypto.js` `signSessionJWT` would use the active KEK. Two different secrets are exercised for two different JWT flows. Not a bug — they're separately rotatable — but it means key rotation has two surfaces. The signed cookie is HS256, HttpOnly+Secure+SameSite=Lax, MaxAge 30 days, with proper `safeEqualB64Url` constant-time compare.

Recommendation: consolidate on `lib/crypto.js`'s `signSessionJWT`/`verifySessionJWT` so the active-KEK rotation in `crypto.js` automatically covers session cookies. This also gets the `alg:none` rejection and 60s clock-skew tolerance that `crypto.js:verifySessionJWT` already implements.

## Scope creep check
Single grep across all HTML + JS confirms only `openid email profile https://www.googleapis.com/auth/drive.file` is ever requested. `privacy.html:160` mentions `https://www.googleapis.com/auth/spreadsheets` in user-facing copy, which is misleading (Sheets writes against an app-created file work under `drive.file`). Recommendation: update `privacy.html` to drop the `spreadsheets` line and explain that `drive.file` covers reads + writes for kesefle-created spreadsheets.

The legacy `copyTemplateToUserDrive` helper in `lib/sheet-writer.js:1033-1057` is annotated "KEPT for backwards compatibility" — if no caller exercises it (the new path is `createUserSheetWithToken`), it can be removed in a future PR so the `drive.file` scope assertion in `provision.js:40` is the only auth path.

## Recommendations (numbered, safe PRs)

1. **PR-1 (HIGH, ship first)**: Add rotated-`refresh_token` capture to a new `lib/oauth.js` exported `exchangeRefreshForAccess({ refreshToken, userSub, reqId })`. Migrate the 5 call sites. Persist the new envelope under a SETNX lock to avoid races between webhook + cron + getExpenses. Add `tests/oauth_rotation_capture.test.js`.
2. **PR-2 (MEDIUM)**: In `google-exchange.js`, add `delete record.refreshToken;` after the existing spread. Ship `scripts/backfill_2026_05_31_strip_plaintext_refresh.js` (dry-run first; idempotent).
3. **PR-3 (MEDIUM)**: Move `token:<sub>` write/read through `lib/secure-kv.js` so `accessToken` is encrypted at rest via the existing `purpose: 'kfl-access'` AAD-bound envelope. Update `google-exchange.js`, `getExpenses.js`, `provision.js`.
4. **PR-4 (MEDIUM)**: Add `if (identity.email_verified !== true) return 403 email_not_verified;` to `google-exchange.js` between lines 137 and 144. Add a test that constructs a payload with `email_verified: false` and asserts the 403.
5. **PR-5 (LOW, combinable)**: (a) add OIDC `nonce`; (b) fix `kfl_session` → `kefle_session` docstring; (c) replace `api/_lib/session.js` JWT path with `lib/crypto.js` `signSessionJWT`/`verifySessionJWT`; (d) update `privacy.html` scope copy; (e) audit + remove unused `copyTemplateToUserDrive` if no callers.

All five PRs are independent except PR-1 should land first because rotation breakage is on a fixed Google-side timer and creates user-invisible bot outages.
