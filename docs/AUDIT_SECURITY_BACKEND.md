# Kesefle Backend Security & Tenant-Isolation Audit

Date: 2026-05-26
Scope: `api/**`, `lib/**`, `bot/ExpenseBot_FIXED.gs`, `vercel.json`, root `.env.example`.
Reviewer: read-only audit — no code changes.

The audit verifies the multi-tenant isolation model (phone -> user:{sub} -> sheet:{sub})
documented in `docs/TENANT_ISOLATION_MODEL.md`, the auth chain, secrets management,
webhook signing, and operational guardrails.

There is NO `api/profession/*.js` directory in the repo; profession logic lives in
`lib/professions.js` and `lib/profession-template.js` and is consumed from the bot
plus `/api/profile`. The audit treats those two `lib/` files instead.

---

## 1. Secrets scan

Command run from repo root (with shell-safe quoting; the exact form in the brief
fails under zsh's globbing):

```
grep -rnEi 'AIza[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{20,}|xox[baprs]-|-----BEGIN (RSA|EC|OPENSSH|PRIVATE)|client_secret"?\s*[:=]|KESEFLE_BOT_SECRET\s*=\s*["'"'"'][^"'"'"']' \
  --include='*.js' --include='*.html' --include='*.gs' --include='*.json' . | grep -v node_modules
```

Output (8 hits, all benign):

| File:Line | Hit | Type |
|---|---|---|
| lib/sheet-writer.js:1104 | `client_secret: clientSecret,` | env-var passthrough |
| api/health.js:41 | `google_client_secret: !!process.env.GOOGLE_CLIENT_SECRET,` | boolean presence flag |
| api/account.js:58 | `client_id: clientId, client_secret: clientSecret,` | env-var passthrough |
| api/auth/google-exchange.js:99 | `client_secret: clientSecret,` | env-var passthrough |
| api/sheet/summary.js:30 | `client_secret: clientSecret,` | env-var passthrough |
| api/sheet/getExpenses.js:33 | `client_secret: clientSecret,` | env-var passthrough |
| api/whatsapp/webhook.js:460 | `client_secret: clientSecret,` | env-var passthrough |
| api/cron/kv-backup.js:114 | `client_secret: clientSecret,` | env-var passthrough |

Every match is a request body that passes a value READ from
`process.env.GOOGLE_CLIENT_SECRET`. No hardcoded API keys, no committed
`.env`, no embedded PEM blocks. Result: **clean**.

Secondary scan for additional patterns (`sk_live_`, `whsec_`, `ya29.`,
`EAACEdEose`, `access_token: "..."`, `Authorization: Basic ...`,
`Password = "..."`) finds two doc-only hits:

| File:Line | Note |
|---|---|
| docs.html:843, docs.html:873 | `"accessToken": "ya29.a0Ae…"` — truncated placeholder inside a syntax-highlighted example |
| api/billing/webhook.js:11 + api/billing/checkout.js:13 | Comments documenting `whsec_…` / `sk_live_…` env var formats |

Both are documentation, not secrets. `.env.example` contains only empty
`KEY=` lines.

---

## 2. Tenant isolation audit

### Invariant
`phone:{e164}` (the bot lookup) -> `userSub` -> canonical sheet via
`sheet:{userSub}`, with the encrypted refresh token in `user:{userSub}`.
Bot-secret endpoints MUST never fall through to `SHEET_OWNER_PHONE` /
hardcoded `SHEET_ID` (that was the original cross-tenant leak).

### Per-endpoint check

| Endpoint | Reads `phone:{e164}` | Requires `userSub` | Owner fall-through | bot-secret check |
|---|---|---|---|---|
| `api/sheet/append.js` | yes (L103) | yes (L107) | no — explicit `sheet_ownership_mismatch` guard L126 | `constantTimeEqual` (L86) |
| `api/sheet/mark-vat.js` | yes (L95) | yes (L96) | no — same mismatch guard L106 | `constantTimeEqual` (L79) |
| `api/sheet/stats.js` | yes (L79) | yes (L80) | no — mismatch guard L88 | `constantTimeEqual` (L74) |
| `api/sheet/bot-query.js` | yes (L165) | yes (L166) | no — mismatch guard L173 | `constantTimeEqual` (L137) |
| `api/sheet/relabel-row.js` | yes (L96) | yes (L98) | no — direct sheet:{sub} resolve | `constantTimeEqual` (L67) |
| `api/sheet/add-category-row.js` | yes (L204) | yes (L205) | no — direct sheet:{sub} resolve | `constantTimeEqual` (L172) |
| `api/sheet/fix-company-dashboard.js` | yes (L109) | yes (L110) | no | `constantTimeEqual` (L104) |
| **`api/sheet/delete-last.js`** | yes (L66) | yes (L67) | no | **`got !== expected` (L60) — NOT constant-time, HIGH severity timing leak** |
| `api/sheet/web-append.js` | n/a — `requireAuth` (req.user.sub) | yes (L41) | no | session/Bearer auth (no bot-secret path) |
| `api/sheet/delete-rows.js` | n/a — `requireAuth` | yes (L62) | no | session/Bearer auth |
| `api/sheet/export.js` | n/a — `requireAuth` | yes (L43) | no | session/Bearer auth |
| `api/sheet/monthly-statement.js` | n/a — `requireAuth` | yes (L41) | no | session/Bearer auth |
| `api/sheet/tax-report.js` | n/a — `requireAuth` | yes (L77) | no | session/Bearer auth |
| `api/sheet/summary.js` | n/a — `requireAuth` | yes (L57) | no | session/Bearer auth |
| `api/sheet/getExpenses.js` | n/a — `requireUser` (cookie only) | yes | no | no bot path |
| `api/sheet/provision.js` | n/a — verified access token / cookie | yes (L65, L82) | no — only creates a NEW sheet | n/a |
| `api/recurring.js` | yes (L178) | yes (L178) | no — mismatch guard L184 | bot-secret (verified upstream) |
| `api/budgets.js` (bot path) | yes | yes | no — same resolver | constantTimeEqual |
| `api/abuse-log.js` | n/a | n/a | no | **`got !== expected` (L25) — HIGH severity timing leak** |
| `api/profile.js` | yes | n/a (KV scoped by phone) | no | **`got !== expected` (L67) — HIGH severity timing leak** |
| `api/account.js` (deleteByPhone) | yes (L307) | yes | no — masked-phone audit log | **`got !== expected` (L301) — HIGH severity timing leak** |
| `api/learn.js` | n/a — keyed by hash, not sub | n/a | no | **`got !== expected` (L58, L71) — HIGH severity timing leak (both GET and POST paths)** |
| `api/cron/steven-daily-digest.js` | n/a | n/a | n/a | **`adminParam === process.env.KESEFLE_BOT_SECRET` (L136) AND `cronAuth === 'Bearer '+CRON_SECRET` (L129) — HIGH severity timing leak on BOTH bot secret AND CRON secret** |
| `api/custom-categories.js` (bot read) | yes | yes | no | `constantTimeEqual` (L151) |

#### Tenant isolation findings

- **No fall-through to `SHEET_OWNER_PHONE`** in any audited endpoint. The
  resolver pattern (`canonicalSheetId || phoneSheetId || userRec.spreadsheetId`)
  always sources from a per-user record; the mismatch guard logs
  `sheet_ownership_mismatch` and 409s before any write. **Excellent.**
- **`api/sheet/append.js` includes a sheet_multi_writer_anomaly detector**
  (L196-260) that records every distinct `userSub` that writes a given
  `spreadsheetId` and alerts on >1 — defense-in-depth against the original
  leak class. Good.
- **Bot enforces owner-gating** on owner-only commands in
  `bot/ExpenseBot_FIXED.gs` via `_isOwnerPhone_` (L5072) and the
  `_assertOwnerLegacyWrite_` guard (L5084) before any write to the hardcoded
  `SHEET_ID`. Interactive replies route through `_resolveTenant_` (L5093) and
  the same bot-secret-bridged `/api/sheet/*` endpoints — no owner sheet
  fall-through.
- **Constant-time comparison is inconsistently applied.** The new endpoints
  (append, mark-vat, bot-query, relabel-row, add-category-row,
  custom-categories, fix-company-dashboard) all use `constantTimeEqual`. The
  older bot-secret endpoints (`abuse-log.js`, `profile.js`, `learn.js`,
  `account.js` deleteByPhone, `sheet/delete-last.js`, and the manual-trigger
  branch of `cron/steven-daily-digest.js`) still use plain `!==` / `===`.
  This leaks the secret one byte at a time over enough trials — see
  finding **H1**.

#### Functional bug discovered during isolation review

- **`api/sheet/delete-last.js` is BROKEN for encrypted-envelope users.** Line
  26 imports `decryptRefreshToken` from `'../../lib/secure-kv.js'`, but
  `lib/secure-kv.js` does NOT re-export it — it only imports it internally
  from `crypto.js`. The named import resolves to `undefined`; calling it on
  L78 throws `TypeError: decryptRefreshToken is not a function` and the
  endpoint 500s on any user provisioned after the encryption rollout. The
  only path that works is the legacy plaintext fallback on L80, which is
  empty for new users. This is not a security finding but flagging here
  because the broken endpoint silently degrades the bot's "מחק אחרון"
  command. **Severity: HIGH (operational, not security).**

---

## 3. Auth audit

### `requireAuth` / `requireAdmin` — Google ID token verification

`lib/auth.js`:

- `requireAuth` (L123) accepts either `Authorization: Bearer <jwt>` or the
  HS256 `kefle_session` cookie set by `setSessionCookie` (`api/_lib/session.js`).
- Bearer path fully verifies the JWT against Google's JWKS (`getGoogleJWKS`
  L49 with 1h cache), enforces RS256, checks `kid`, verifies signature with
  `crypto.createVerify('RSA-SHA256')`, then validates `exp`, `nbf`, `iss`,
  and `aud === GOOGLE_CLIENT_ID`. **Cryptographically sound.**
- Cookie path (`getUserId` in `api/_lib/session.js`) verifies the HS256 JWT
  with `crypto.timingSafeEqual` after a length check. Header is forced
  `{alg:'HS256', typ:'JWT'}`, so `alg=none` and RS256/HS256 confusion are
  blocked. **Sound.**
- Helper `getGoogleClientId()` (L38) throws if `GOOGLE_CLIENT_ID` is
  missing — no hardcoded fallback (the old `|| '<prod-id>'` antipattern is
  gone).

`lib/crypto.js` also exports a second `verifyGoogleIdToken` (L468) used by
`api/auth/google-exchange.js`. Both implementations are equivalent and
correct; future cleanup could collapse them into one.

### `ADMIN_EMAILS` format

`lib/auth.js` L215-216:

```js
const raw = process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS;
const admins = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const userEmail = (req.user.email || '').toLowerCase();
if (!userEmail || !admins.includes(userEmail)) {
```

- Comma-separated, lowercased, trimmed. Case-insensitive comparison.
- Fallback `DEFAULT_ADMIN_EMAILS = 'stevenrancohen@gmail.com,info@kesefle.com'`
  in code (L28). Safe — fails closed on an empty admin list.
- 403 (`admin_required`) on miss; logs `admin.denied` with caller's email
  for audit trail.

### Session cookies

`api/_lib/session.js` L105:

```js
const cookie = `${COOKIE_NAME}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
```

- `HttpOnly` — yes
- `Secure` — yes (the cookie is unusable on http://localhost; acceptable
  trade-off given the codebase otherwise enforces https in production)
- `SameSite=Lax` — yes (sufficient for an OAuth-redirect flow; not Strict
  because the session is set during a top-level Google redirect)
- `Max-Age=30 days` (`MAX_AGE_SECONDS = 60*60*24*30`)
- `Path=/` — applies sitewide
- `SESSION_SECRET` enforced ≥16 chars (L32) and read on every call (no
  rotation hot-reload, but a redeploy picks up env changes).

### Logout

`api/auth/logout.js`:
- POST-only (rejects accidental GET preloads).
- Calls `clearSessionCookie(res)` which writes `Max-Age=0` — same
  HttpOnly/Secure attributes so the browser deletes it.
- Does NOT revoke the underlying Google refresh token (that happens only on
  `/api/account?action=delete`). For a vanilla logout this is correct —
  user can still sign back in.
- Rate-limited 30/min per IP — fine.
- NO server-side session blacklist. The cookie JWT remains valid until
  `exp` (30 days) if an attacker has already exfiltrated it. Acceptable for
  the threat model but worth documenting.

### Admin endpoint rate limits

`api/admin.js` consolidated router is wrapped in
`withRateLimit({ key: 'admin', limit: 60, windowSec: 60 })` (L562).

Individual admin endpoints under `api/admin/*.js` are NOT wrapped in
`withRateLimit`:

- `api/admin/bot-version.js`
- `api/admin/config-drift.js`
- `api/admin/launch-monitor.js`
- `api/admin/recent-signups.js`
- `api/admin/funnel-summary.js`
- `api/admin/user-reports.js`
- `api/admin/stats.js` (uses `ADMIN_TOKEN` env header instead of `requireAdmin`)

All except `stats.js` require admin Google auth, so abuse is bounded to
already-authenticated admins. Still, a runaway admin dashboard polling a
`launch-monitor` endpoint every 1s could exhaust Upstash KV scan quota.
**Severity: MEDIUM** — recommendation: add a 30/min `withRateLimit` wrapper
to each.

`api/admin/stats.js` uses constant-time `ctEq` (L44-50) — manually
implemented but correct.

---

## 4. Input validation

### Phone normalization

All bot-secret endpoints accepting `phone` define a local `normalizeE164`:

- Strips non-digits, prepends `972` if input begins with `0`, enforces
  length 7-15. Same function copy-pasted into:
  `api/sheet/append.js`, `mark-vat.js`, `stats.js`, `bot-query.js`,
  `relabel-row.js`, `add-category-row.js`, `fix-company-dashboard.js`,
  `delete-last.js`, `account.js`, `recurring.js`, `profile.js`.

Code duplication is a maintenance smell but the behaviour is consistent.
**Severity: LOW** — recommend extracting to `lib/phone.js`.

`api/abuse-log.js` (L32) and `api/learn.js` only do
`String(body?.phone || '').replace(/[^0-9]/g, '').slice(0, 15)` — no `0->972`
fix-up. Acceptable because they don't use the phone as a KV key, only as a
log field.

### Category validation

`api/learn.js` L25 defines `VALID_CATS` as a `Set` of the 15 top-level
Hebrew category names and rejects others with `invalid_category`. Good.

`api/sheet/bot-query.js` L155 has `VALID_QUERIES` and L159 `VALID_PERIODS`
enums. Good.

`api/sheet/add-category-row.js` allows free-text category names (L185
`sanitizeName`) bounded to 40 chars, requires at least one Hebrew or Latin
word char, and explicitly rejects `"` and `\` (L191) — defense-in-depth
against the formula-injection vector through `REGEXMATCH`. Good.

`api/sheet/relabel-row.js` clips `newCategory`/`newSubcategory` to 60 chars
(L85, L89) and passes both through `sanitizeCell`. Good.

`api/profile.js` validates `trackingType`, `autoLogPref`, `paymentDefault`,
`profession` against enums, `taxId` against a digit-count window (L102),
and clips `companyName` to 120 chars (L112). Good.

### Free-text -> sheet (formula injection)

`lib/sheet-writer.js` L1039 `sanitizeCell`:

```js
const cleaned = s.replace(/[<bidi/zero-width chars>]/g, '');
const firstNonSpace = cleaned.trimStart()[0];
if (firstNonSpace === '=' || firstNonSpace === '+' || firstNonSpace === '-' || firstNonSpace === '@' || firstNonSpace === '\t') {
  return "'" + cleaned;
}
```

Strips bidi/zero-width overrides, prefixes `'` on any formula trigger.
**Comprehensive.** Applied in `buildExpenseRow` for category/subcategory/
rawText and in `relabel-row.js` / `add-category-row.js` directly. The bot's
embedded sanitizer in `api/whatsapp/webhook.js` L377-390 duplicates this
logic. Code-duplication only — behaviour is correct in both.

Sheets writes use `valueInputOption=RAW` everywhere (verified in append.js
L410, web-append.js, mark-vat.js, etc.) which would block formula
evaluation even if `sanitizeCell` were bypassed — belt and suspenders.

The one place that uses `valueInputOption=USER_ENTERED` is
`api/sheet/add-category-row.js` L139 because the cell IS a formula by
design. The formula embeds a user-supplied name only after
`String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '""')`
escaping (L123-124) plus the upstream `"` and `\` rejection. Safe.

### File uploads

- `api/import/bank-csv.js` is the only file-upload endpoint. Body cap is
  2 MB (L57 `bodyParser.sizeLimit`). It's `requireAuth` gated, rate-limited
  5/hour/userSub. CSV is parsed via `lib/bank-parsers.js` — no `eval`, no
  external command shell-outs.
- `api/whatsapp/webhook.js` and `api/billing/webhook.js`/`crypto-webhook.js`
  disable bodyParser to read raw bytes for HMAC. They rely on Vercel's
  default request size limit (4.5 MB).
- No multipart endpoints, no avatar upload, no general image upload.

---

## 5. Rate-limit coverage

Endpoints WITHOUT `withRateLimit`:

| File | Has rate limit? | Auth wrapper | Notes |
|---|---|---|---|
| api/sheet/getExpenses.js | **NO** | `requireUser` (cookie only) | **HIGH** — Sheets API quota burner. Recommend 60/min per userSub. |
| api/admin/bot-version.js | NO | `requireAdmin` | Admin-only — MED. Recommend 30/min. |
| api/admin/config-drift.js | NO | `requireAdmin` | Admin-only — MED. |
| api/admin/launch-monitor.js | NO | `requireAdmin` | Admin-only, polled — MED. |
| api/admin/recent-signups.js | NO | `requireAdmin` | Admin-only — LOW. |
| api/admin/funnel-summary.js | NO | `requireAdmin` | Admin-only — LOW. |
| api/admin/user-reports.js | NO | `requireAdmin` | Admin-only — LOW. |
| api/admin/stats.js | NO | constant-time `ADMIN_TOKEN` | Admin-only — LOW, sets s-maxage cache. |
| api/billing/webhook.js | NO | Stripe HMAC | Acceptable — payment processor. (DEPRECATED file but still mounted.) |
| api/billing/crypto-webhook.js | NO | Coinbase HMAC | Acceptable — payment processor. |
| api/cron/budget-check.js | NO | constant-time `CRON_SECRET` | Acceptable — Vercel cron. |
| api/cron/kv-backup.js | NO | constant-time `CRON_SECRET` | Acceptable. |
| api/cron/kv-monitor.js | NO | constant-time `CRON_SECRET` | Acceptable. |
| api/cron/lifecycle.js | NO | constant-time `CRON_SECRET` | Acceptable. |
| api/cron/recurring.js | NO | constant-time `CRON_SECRET` | Acceptable. |
| api/cron/reminders.js | NO | constant-time `CRON_SECRET` | Acceptable. |
| api/cron/steven-daily-digest.js | NO | **non-constant-time** `CRON_SECRET` AND `KESEFLE_BOT_SECRET` | **HIGH** — see finding H1. |
| api/config.js | NO | none | LOW — returns static config (verified file is small read). |
| api/health.js | NO | none | LOW — public health probe. |
| api/health/detailed.js | NO | none | MED — verify it doesn't fan out to expensive deps without throttling. |
| api/me.js | NO | none | LOW — same-origin GET. |

Endpoints WITH `withRateLimit` and their limits — spot check for sanity:

| Endpoint | Limit (req/window) | Caller key | Verdict |
|---|---|---|---|
| sheet/append | 60/60s IP + 40/60s per phone | phone | reasonable (above human pace, blocks loops) |
| sheet/web-append | 120/60s IP + 60/3600s per userSub | userSub | reasonable |
| sheet/bot-query | 60/60s IP + 30/3600s per phone | phone | reasonable |
| sheet/mark-vat | 30/3600s IP + 20/3600s per phone | phone | tight but matches a flag-rarely-used command |
| sheet/stats | 120/60s IP | none | OK — read-only |
| sheet/relabel-row | 60/60s IP + 20/3600s per phone | phone | reasonable |
| sheet/add-category-row | 30/60s IP + 12/3600s per phone | phone | reasonable |
| sheet/fix-company-dashboard | 30/60s IP + 10/3600s per id | phone or sub | reasonable (idempotent repair) |
| sheet/delete-last | 30/60s IP | none | could be tighter with per-phone |
| sheet/delete-rows | 120/60s IP + 30/3600s per userSub | userSub | reasonable |
| sheet/export | 30/60s IP + 10/3600s per userSub | userSub | reasonable (heavy GET) |
| sheet/monthly-statement | 60/60s IP + 30/3600s per userSub | userSub | reasonable |
| sheet/tax-report | 10/3600s IP + 5/3600s per userSub | userSub | reasonable (expensive aggregate) |
| sheet/summary | 30/60s IP | none | OK |
| sheet/provision | 100/3600s IP + 50/3600s per userSub | userSub | reasonable; NAT-safe |
| auth/google-exchange | 10/3600s IP | none | **matches brief target of ~10/min — actually 10/HOUR, even stricter; reasonable** |
| auth/logout | 30/60s IP | none | reasonable |
| admin (router) | 60/60s | none | reasonable |
| billing/paypal subscribe | 30/3600s per IP | none | reasonable |
| profile | 60/60s | none | reasonable |
| abuse-log | 60/60s | none | reasonable |
| custom-categories | 60/60s | none | reasonable |
| budgets | not measured in this audit | -- | -- |
| webhook (WA inbound) | 120/60s per IP | IP | reasonable |
| user-report | 30/600s | IP | reasonable |

---

## 6. Logging hygiene

`lib/log.js` ships with an auto-redactor (`redact`) that masks any key
matching `/phone/i`, `/email/i`, `/usersub/i`, `/token/i`, `/secret/i`,
`/password/i`, `/authorization/i`, etc., before emitting JSON.

That means even calls like
`log.info('append.ok', { reqId, phone, userSub, spreadsheetId })`
emit `phone: '9725...[REDACTED:12]'`, `userSub: '1037...[REDACTED:21]'`.

This is correct and is the load-bearing PII control. Spot checks of `log.*`
sites confirm they all go through `lib/log.js`:

- `api/sheet/append.js` L194 — fields are phone/userSub/spreadsheetId — all
  redacted by `lib/log.js`.
- `api/account.js` L324 — additionally pre-masks phone with `phone.replace(/\d(?=\d{4})/g, '*')`.
  Belt-and-suspenders, fine.

**Violations of the structured-logger pattern** — raw `console.log`/
`console.warn`/`console.error` (which bypass redaction):

| File:Line | Concern |
|---|---|
| api/auth/google.js:106 | `console.log('USER_SIGNUP', JSON.stringify(user))` — emits **full user record incl. email, name, picture** unredacted. **HIGH severity for PII leak.** |
| api/sheet/provision.js:290 | `console.log('SHEET_PROVISIONED', JSON.stringify(record))` — emits userSub, userEmail, spreadsheetId. Only runs when KV is unconfigured (dev path), but should still be `log.info` with redaction. **MED.** |
| api/whatsapp/webhook.js:355, 361, 369, 442 | `console.error` lines on the (legacy/dead) Vercel webhook path. They emit `userSub` and `spreadsheetId` raw. **LOW** (this webhook path is superseded by the Apps Script bot — verify it's actually unused in production before reclassifying as MED). |
| api/billing/webhook.js:156, 161 | `console.log('PAYMENT_FAILED', invoice.id, ...)` etc. on the **deprecated Stripe** webhook. Low concern — Stripe IDs aren't PII but reroute through `log.warn`. **LOW.** |
| api/billing/crypto-webhook.js:78 | `console.error('crypto_activate_failed', e.message)` — error message only, no PII. **LOW.** |
| api/sheet/provision.js:160, 281, 288 | `console.warn` of merge failures — no PII. **LOW.** |
| api/account.js:50 | `console.warn('google_revoke_failed', e.message)` — no PII. **LOW.** |

No `log.*` call I found logs raw refresh tokens, access tokens, or sheet
content. **No** site logs raw bidi-uncorrupted Hebrew expense text either.

Recommendation: convert all `console.log` to `log.info` in api/ so the
redactor runs uniformly.

---

## 7. Webhook security

### Bot (Apps Script)

`bot/ExpenseBot_FIXED.gs` `_verifyMetaWebhook_` (L613):

- HMAC-SHA256 of raw body against `META_APP_SECRET` from script properties,
  matched against `X-Hub-Signature-256` header.
- Header probed in `e.headers`, `e.parameter`, `e.postData.headers`
  because Apps Script's doPost has historically NOT exposed headers
  reliably for web-app deploys.
- "Soft" mode by default: if the header isn't surfaced, falls back to a
  **WABA-id check** (`WHATSAPP_BUSINESS_ACCOUNT_ID` must match
  `entry[0].id`) — not cryptographic but it gates random anonymous probes.
- `STRICT_WEBHOOK_VERIFY=1` script property forces hard-fail when HMAC
  can't run.
- Constant-time-ish hex compare (L666-672).

**Verdict:** Best-effort given the Apps Script platform. Soft-mode is a
compromise; if Steven hasn't set `STRICT_WEBHOOK_VERIFY=1`, an attacker who
knows the public WABA id and the bot's `/exec` URL could potentially inject
crafted payloads. The KV optout/idempotency lookups would burn quota but
no sheet write happens without a real phone -> sub mapping. **Severity:
MED.** Recommend setting `STRICT_WEBHOOK_VERIFY=1` once header surfacing
is confirmed in production.

### `/api/whatsapp/webhook.js` (Vercel)

L122-134: `META_APP_SECRET` required, missing -> 503. HMAC verified with
`crypto.timingSafeEqual`. Pre-HMAC IP rate limit 120/min/IP. **Correct.**
(This path is effectively dead — see Section 6 note — but its security
posture is still good.)

### `/api/billing/webhook.js` (Stripe — deprecated)

Stripe `t=<ts>,v1=<sig>` verification with 300s tolerance window and
`timingSafeEqual`. Correct. File is marked deprecated.

### `/api/billing/crypto-webhook.js` (Coinbase Commerce)

`x-cc-webhook-signature` HMAC-SHA256 with `timingSafeEqual`. Correct.
Idempotency via `crypto_event:<id>` KV key.

### `/api/billing/paypal.js?action=webhook`

`verifyWebhook` calls PayPal's
`/v1/notifications/verify-webhook-signature` REST endpoint and checks
`verification_status === 'SUCCESS'`. Correct. The trust root is PayPal's
API, not our HMAC — appropriate for PayPal's auth model. Idempotency via
`paypal_event:<id>`.

---

## 8. CORS + headers

### `vercel.json` global headers (`/.*`)

- `X-Content-Type-Options: nosniff` — yes
- `X-Frame-Options: DENY` — yes
- `Referrer-Policy: strict-origin-when-cross-origin` — yes
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — yes
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` — yes
- `Content-Security-Policy` — present and reasonably scoped:
  - `script-src 'self' 'unsafe-inline' https://apis.google.com https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://accounts.google.com https://connect.facebook.net https://appleid.cdn-apple.com https://www.googletagmanager.com https://analytics.tiktok.com`
  - `connect-src 'self' https://sheets.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://www.googleapis.com https://www.google-analytics.com https://stats.g.doubleclick.net https://connect.facebook.net https://www.facebook.com https://analytics.tiktok.com`
  - `frame-ancestors 'none'` — yes (overrides X-Frame-Options)
  - `base-uri 'self'` — yes
  - `form-action 'self'` — yes
  - **Concern:** `'unsafe-inline'` in `script-src` allows inline `<script>`
    payloads to execute. Given the codebase ships ~50 inline scripts per
    page, removing this would require a major refactor. **Severity: MED**
    — acceptable for now but a known weakness if any HTML page accepts
    user-controlled HTML output.

- `Content-Security-Policy` does NOT include `upgrade-insecure-requests`
  — minor; HSTS preload covers it.

### `/api/*` headers
- `Cache-Control: no-store, max-age=0` — yes
- No CSP — handled per-page by global.
- `lib/middleware.js` `withSecurityHeaders` would add `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin` — but it is NOT actually
  wired into any endpoint (`grep withSecurityHeaders api/` returns no
  matches in handler files). `vercel.json` covers the basics but **no API
  endpoint sets COOP/CORP**. **Severity: LOW** — acceptable since the API
  returns JSON, but cleanup would close a gap.

### Per-endpoint CORS

Only `api/events.js` explicitly sets CORS. Allowlist:
`kesefle.com`, `www.kesefle.com`, `kesefle.vercel.app`, `localhost:5274`,
`localhost:3000`. Origin reflected only if in allowlist. No
`Access-Control-Allow-Credentials` header — cookies are NOT sent
cross-origin. **Correct.**

All other endpoints fall back to Vercel defaults (no `ACAO` header) so the
browser blocks cross-origin reads of the response. Session cookies are
`SameSite=Lax`, so they don't ride on cross-origin POSTs either.
**Verdict: CORS posture is conservative and correct.**

---

## 9. LLM cost protection

The Vercel side does NOT call any LLM directly. All LLM calls live in
`bot/ExpenseBot_FIXED.gs` (Apps Script):

- Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) — 4 distinct call
  sites: L8218 (classifier), L8671 (receipt OCR), L9116 (general fallback),
  L13892 (other).
- Gemini (`gemini-2.0-flash` / `1.5-flash` / `2.5-flash`) — L4242.

### Findings

- **No per-user daily token cap.** A grep for
  `aiDailyCap|llm_cost|aiCallCount|AI_DAILY|tokens.?per.?day` returns
  nothing in the bot.
- **No per-tenant total spend cap.** Same.
- **Fallback to deterministic IS present** — every LLM call site is
  wrapped in try/catch and falls back to keyword classifier (e.g. L8200
  before the Claude call, the bot already attempted keyword classification
  and only escalated on `category === 'unsure'`).
- **Per-request cost is NOT logged.** No `log.info('llm.cost', { tokensIn, tokensOut, cost })`
  pattern exists.
- KV does have `last_inbound:` keys (24h TTL) that could be used to throttle
  per phone, but no LLM-specific throttle.
- `api/sheet/append.js` rate-limits writes at 40/min per phone, which
  indirectly caps LLM calls since each write follows a classify call. But
  there's nothing stopping a single phone from sending 39 unparseable
  messages/min and burning 39 Claude calls/min.

**Severity: HIGH** — at $0.25/Mtok input + $1.25/Mtok output for Haiku,
this is a runaway-cost vector. A single buggy or malicious sender chatting
at 40 msgs/min × 24h × 700 tokens/call could rack up ~$10/day for one
phone. At 1000 active users (the target), the headroom evaporates fast.

Recommendations:
1. Add `KFL_AI_DAILY_TOKENS_BY_PHONE` script property + per-phone token
   counter in `CacheService` (24h TTL).
2. Add a global per-day cap (e.g. 1M Anthropic input tokens) checked from
   the script and from `/api/admin/launch-monitor`.
3. Log every LLM call: `log.info('llm.call', { model, tokensIn, tokensOut, ms, userSubHash })`.
4. Emit a Slack alert on >100k tokens/hour or >10x per-user baseline.

---

## 10. Top 10 critical issues

| # | Severity | Issue | Recommended fix |
|---|---|---|---|
| 1 | **HIGH** (H1) | Bot-secret comparison uses non-constant-time `!==` / `===` in 6 endpoints (`api/sheet/delete-last.js:60`, `api/profile.js:67`, `api/abuse-log.js:25`, `api/account.js:301`, `api/learn.js:58 + 71`) AND `api/cron/steven-daily-digest.js:129/136` (CRON_SECRET + bot-secret). Leaks the shared secret via timing oracle over enough requests; once leaked an attacker can write to ANY user's sheet. | Replace each with `await import('../../lib/crypto.js').then(m => m.constantTimeEqual(String(got), expected))` mirroring the pattern already used in `append.js`, `mark-vat.js`, `bot-query.js`. |
| 2 | **HIGH** (H2) | No LLM cost protection — no per-user/per-tenant token cap, no per-request cost logging, no kill-switch. A single chatty (or hostile) WhatsApp sender can drive arbitrary Anthropic spend. | Add per-phone 24h token cap in `CacheService` and a global daily cap as a script property; abort with a polite Hebrew message ("הגעת למגבלת היום, נסה שוב מחר") when exceeded; log per-call token counts to `/api/log/llm-cost`. |
| 3 | **HIGH** (H3) | `api/auth/google.js:106` emits `console.log('USER_SIGNUP', JSON.stringify(user))` — full user record (email, name, picture, sub) lands unredacted in Vercel logs. PII / GDPR exposure even though Vercel logs are not public. | Replace with `log.info('user.signup', { userSubHash: hash(user.sub) })` — `lib/log.js` will redact `userSub`/`email`/`name` automatically anyway, but use the structured logger. |
| 4 | **HIGH** (H4 — operational, surfaced during audit) | `api/sheet/delete-last.js:26` imports `decryptRefreshToken` from `lib/secure-kv.js`, which does not re-export it. The endpoint throws `TypeError: decryptRefreshToken is not a function` for any user with an encrypted refresh-token envelope (i.e. every user provisioned after the encryption rollout). The bot's "מחק אחרון" / "בטל" command silently 500s. | Change L26 to `import { decryptRefreshToken } from '../../lib/crypto.js';` and run `bot/test_isolation.js` to confirm the path works end-to-end. |
| 5 | **MED** (M1) | `api/sheet/getExpenses.js` has no rate limit and reads up to 5000 sheet rows on each call from any cookie-authed user. A single user (or a stolen cookie) can drain that user's Sheets API quota. | Add `withRateLimit({ key: 'getExpenses', limit: 30, windowSec: 60 })` and a per-userSub `rateLimitId` of 60/hour. |
| 6 | **MED** (M2) | All `api/admin/*.js` endpoints except `admin.js` lack `withRateLimit`. An admin browser left polling `/admin/launch-monitor` every 1s can blow KV scan budget on Upstash free tier. | Wrap each with `withRateLimit({ key: 'admin_<name>', limit: 30, windowSec: 60 })`. |
| 7 | **MED** (M3) | `lib/middleware.js` defines `withSecurityHeaders` (COOP, CORP, Permissions-Policy, etc.) but no endpoint actually composes it — verified by `grep withSecurityHeaders api/`. JSON APIs lack Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy headers. | Compose `withSecurityHeaders` into `withRequestId` (or into `compose(...)`) and apply uniformly. Alternative: extend `vercel.json` headers for `/api/(.*)` to add the missing four. |
| 8 | **MED** (M4) | Bot Meta-webhook verification falls back to a WABA-id check when the `X-Hub-Signature-256` header isn't surfaced by Apps Script (default soft-mode). An attacker who knows the public WABA id can POST crafted payloads to the bot's `/exec` URL and trigger downstream KV/Sheets reads. | Set `STRICT_WEBHOOK_VERIFY=1` script property after confirming header access in production. Document the requirement in `docs/WABA_SETUP_STEP_BY_STEP.md`. |
| 9 | **MED** (M5) | CSP allows `'unsafe-inline'` for `script-src` because every HTML page ships inline `<script>` blocks. If any HTML page ever renders user-controlled text without escaping, XSS becomes trivial. | Refactor inline scripts into `js/*.js` files (skill `inline-script-validate` already exists) and drop `'unsafe-inline'` from CSP. Done page-by-page over time. |
| 10 | **LOW** (L1) | `console.log`/`console.warn`/`console.error` calls in `api/billing/{webhook,crypto-webhook}.js`, `api/sheet/provision.js`, `api/whatsapp/webhook.js`, `api/account.js` bypass `lib/log.js` redaction. Most carry no PII but a few (e.g. provision.js:290 `console.log('SHEET_PROVISIONED', JSON.stringify(record))` with userEmail) do. | Search-and-replace `console.log/warn/error` in `api/` with `log.info/warn/error` so the redactor runs uniformly. |

---

## Appendix A: endpoints with identical phone-normalization copy-paste

Eleven endpoints define their own `normalizeE164` function. Recommend
extracting into `lib/phone.js` to keep behaviour aligned. This is a code
cleanliness issue, not a security one.

## Appendix B: positive findings

- `lib/crypto.js` is a model implementation: AES-256-GCM AAD-bound refresh
  token envelopes, KEK rotation via `KESEFLE_DB_KEY_<KID>` env vars with
  60s hot-reload, optional cold-start self-test, alg-confusion-safe HS256
  session JWT, full RS256 + JWKS Google ID-token verification.
- `lib/log.js` `redact()` regex covers `phone|email|usersub|token|secret|
  password|credit|card|cvv|ssn|authorization|...` automatically.
- `api/sheet/append.js` has a sheet-multi-writer anomaly detector that
  alerts Steven on the original cross-tenant-leak class of bug.
- Every webhook endpoint disables `bodyParser` and reads raw bytes for
  HMAC — no JSON-restringify-then-HMAC pitfall.
- `KESEFLE_CRYPTO_SELFTEST=1` runs a roundtrip at import so misconfigured
  deploys surface immediately.
- The Stripe webhook is deprecated cleanly with a header comment, not
  silently broken.
- Bot has a documented `_assertOwnerLegacyWrite_` defense-in-depth gate
  (`ExpenseBot_FIXED.gs:5084`) that aborts any non-owner write to
  `SHEET_ID` even if upstream routing regresses.
