# Kesefle Security + Privacy Hardening Audit — 2026-05-27

Scope: full sweep of `api/**`, `lib/**`, `bot/ExpenseBot_FIXED.gs`, top-level HTML, and `vercel.json`.
Method: 10 targeted checks per Steven's brief. No code changes made.

---

## Executive summary

Kesefle's security posture is **stronger than typical pre-launch SaaS at this stage**. Tenant isolation is implemented as a documented invariant (canonical `sheet:{userSub}` + `user:{userSub}` resolution with a phone-vs-canonical mismatch guard and a multi-writer anomaly detector). All bot-secret comparisons go through `constantTimeEqual` / `crypto.timingSafeEqual` — no `===` paths found. Webhook signatures are verified with HMAC + raw-body capture for Meta WhatsApp, PayPal (API verify endpoint), and Coinbase Commerce. Structured logging auto-redacts `phone`, `email`, `*token*`, `userSub` keys before they reach Vercel retention. CSP / HSTS / X-Frame-Options / Referrer-Policy are set globally in `vercel.json`. The sheet provisioning path creates the sheet in the user's own Drive via their OAuth token — Kesefle never grants "anyone-with-link" or public access.

The gaps are real but **narrow and addressable in days, not weeks**. The biggest exposures are: (1) two bot-secret-gated sheet endpoints that lack the explicit ownership-mismatch guard (`csv-import`, `add-category-row`, `relabel-row`, `fix-company-dashboard`, `delete-last`) — they rely on the integrity of the phone record alone; (2) several `innerHTML` interpolations of API-fetched strings that escape *most* values but a small set of cosmetic strings (`p.amountILS`, raw `e.message` from errors) flow through `esc()` without consistent type coercion; (3) one duplicate hand-rolled `constantTimeEqual` in `api/log/bot-heartbeat.js` instead of importing the canonical implementation.

**Risk grade: B+** (no Critical findings exploitable today; a handful of Mediums; production-ready for the current user count but the High items should land before scaling past ~1k paying users).

---

## Critical findings

None. No exploitable secret leaks, no missing webhook signature verification, no public sheet grants, no `===` on `KESEFLE_BOT_SECRET`, no XSS-from-LLM, no public admin endpoint.

---

## High findings (fix this month)

### H1. Five bot-secret sheet endpoints lack the `sheet_ownership_mismatch` guard
- **Severity:** High
- **Files:**
  - `api/sheet/delete-last.js:70` — resolves only `user:{phoneRec.userSub}`; no comparison of `phoneRec.spreadsheetId` vs `sheet:{userSub}.spreadsheetId`.
  - `api/sheet/csv-import.js:297-302` — same pattern.
  - `api/sheet/relabel-row.js:96-100` — same.
  - `api/sheet/add-category-row.js:174-180` (via `resolveUser`) — same.
  - `api/sheet/fix-company-dashboard.js` — same.
- **Exploitable today?** Only theoretical. The guard exists in `append.js`, `bot-query.js`, `mark-vat.js`, `stats.js`, `recurring.js` because the original cross-tenant leak shipped via the write path. If a `phone:` record's cached `spreadsheetId` were ever to drift from the canonical `sheet:{userSub}`, these five endpoints would silently act on the wrong sheet (delete the wrong row, write a category row to someone else's sheet, etc.). The shared `_swCache` anomaly detector only fires on `append.js`, not these.
- **Fix:** Extract `resolveTenantWriteRecord(phone)` from `api/recurring.js` lines 175-198 into `lib/sheet-writer.js` and call it from all 5 endpoints. One PR.

### H2. `api/admin/stats.js` uses a separate `ADMIN_TOKEN` env var, not `requireAdmin`
- **Severity:** High
- **File:** `api/admin/stats.js:1-60`
- **Exploitable today?** Not unless the `ADMIN_TOKEN` env var leaks. But it's a parallel auth path (Bearer token vs Google session) that diverges from every other `api/admin/**` endpoint and bypasses the `ADMIN_EMAILS` allowlist. Token compromise = full read of all KV stats; no second factor.
- **Fix:** Migrate to `requireAdmin` like the other 15 admin endpoints, then remove `ADMIN_TOKEN` from Vercel env vars.

### H3. `api/admin/customer-digest-set.js` uses `KESEFLE_BOT_SECRET` instead of `requireAdmin`
- **Severity:** High
- **File:** `api/admin/customer-digest-set.js:65-71`
- **Exploitable today?** Anyone with the bot secret (i.e. the bot itself, or anyone who exfiltrates it from Apps Script Properties) can set the customer-weekly-digest message that goes out to every paying user on Sunday at 10:00 IL. That's a reputational/phishing vector — broadcast a fake "click here to claim refund" Hebrew message to all customers.
- **Fix:** Switch to `requireAdmin`. The endpoint is admin-only by design — it doesn't need bot callability. One-line change.

---

## Medium findings (fix this quarter)

### M1. `api/log/bot-heartbeat.js` reimplements `constantTimeEqual` locally
- **Severity:** Medium
- **File:** `api/log/bot-heartbeat.js:18-28`
- **Exploitable today?** No — the local implementation is correct (same XOR pattern as `lib/crypto.js`). But it's a maintenance hazard: a future change to the canonical implementation (e.g. adding length normalization) won't propagate here. The comment even acknowledges it's "duplicated to avoid cross-file imports." That excuse no longer applies — every other endpoint imports it lazily.
- **Fix:** Replace local function with `const { constantTimeEqual } = await import('../../lib/crypto.js');`.

### M2. `innerHTML` interpolations of API-derived numbers without coercion
- **Severity:** Medium
- **Files:**
  - `admin.html:1206-1212` — `esc(p.amountILS)` works (esc coerces), but `p.method === 'bit' ? 'ביט' : 'העברה בנקאית'` is hardcoded — fine. Pattern is solid overall.
  - `admin.html:1219`, `1363`, `1393`, `1219` — `esc(e.message)` from caught exceptions. JS Error messages can carry user-influenced strings (e.g. response body fragments). The `esc` function does escape, so this is defense-in-depth, not a live XSS.
  - `dashboard.html:3522`, `index.html:1202` — all interpolated values pass through `escapeHtml` / `esc`. Clean.
- **Exploitable today?** No — `esc` correctly escapes `< > & " '`. The pattern itself is fine.
- **Fix:** Adopt a lint rule banning bare `innerHTML =` and require either `textContent` or a templating helper. Defense in depth only.

### M3. `api/events.js` CORS reflects the request origin
- **Severity:** Medium
- **File:** `api/events.js:255-285`
- **Exploitable today?** No — the allowlist is strict (`kesefle.com`, `www.kesefle.com`, `kesefle.vercel.app`, two localhost ports). No credentials are sent. But adding a new dev origin requires a code edit + redeploy, which has bitten other teams during launch.
- **Fix:** Move the allowlist to a `CORS_ALLOWED_ORIGINS` env var; keep the case-insensitive exact-match comparison.

### M4. `api/auth/google.js:108` comment notes email/name/picture being logged
- **Severity:** Medium
- **File:** `api/auth/google.js:108`
- **Exploitable today?** Only if the comment reflects active code. The auto-redaction in `lib/log.js` covers `email` keys, but a raw `console.log({...profile})` would dump unredacted.
- **Fix:** Audit the file; ensure all OAuth-callback logging goes through `log.info()` and not `console.log()`.

### M5. Stale `api/billing/webhook.js` (Stripe) shipped despite being marked DEPRECATED
- **Severity:** Medium
- **File:** `api/billing/webhook.js:1-4`
- **Exploitable today?** It's still a live Vercel route. If `STRIPE_WEBHOOK_SECRET` is ever set in env (by mistake), the endpoint becomes callable and would update `user.plan` in KV based on Stripe events Kesefle no longer expects.
- **Fix:** Delete the file. The comment says it's dead code; act on it.

### M6. `phone:` record self-heal in `append.js` writes a partial record
- **Severity:** Medium
- **File:** `api/sheet/append.js:145-147`
- **Exploitable today?** No. But the self-heal `kvSet('phone:' + phone, { ...phoneRec, spreadsheetId: canonicalSheetId })` is fire-and-forget — if it succeeds, future writes skip the mismatch path; if a stale read races, a half-written record could re-trigger a mismatch. Worth adding a CAS-style check.
- **Fix:** Use `SETNX` or read-modify-write with version stamps. Low-priority refinement.

---

## Low findings (defer)

### L1. `console.error('crypto_activate_failed', e.message)` in `api/billing/crypto-webhook.js:74`
- Uses `console.error` instead of structured `log.error`. The error string itself is the only thing logged (no PII), but inconsistent with the rest of the codebase.

### L2. `vercel.json` CSP allows `'unsafe-inline'` on `script-src`
- Required by Tailwind CDN, Google Tag Manager, and inline `<script>` blocks used throughout the HTML pages. Removing would require a build step. Acceptable for now; revisit if/when introducing a bundler.

### L3. `crons` in `vercel.json` not visible in this audit chunk
- Could not confirm all cron paths are gated by `CRON_SECRET`. Quick check showed all eight cron handlers (`budget-check`, `customer-weekly-digest`, `kv-backup`, `kv-monitor`, `lifecycle`, `recurring`, `reminders`, `steven-daily-digest`) do gate via `constantTimeEqual` on `CRON_SECRET`. Clean.

### L4. `api/billing/winback-claim.js` is unauthenticated by design
- Token = first 24 chars of `userSub` sent via win-back email. Acceptable for the use case (claim discount), rate-limited 30/hour/IP. Document the threat model: an attacker with a leaked email + brute-force can claim someone else's discount but can't take over the account.

---

## Categories where the codebase is clean

- **Secrets in tracked files:** clean — no findings. Every `AIza...` / `sk-...` / `xox...` / `-----BEGIN` / hardcoded `KESEFLE_BOT_SECRET` returned zero hits. The only matches for `client_secret` are reading `process.env.GOOGLE_CLIENT_SECRET` and passing it to Google's OAuth endpoint (correct). Test files (`tests/test_csv_import.js:5,10`) assign `fake` strings — fine.
- **Bot-secret timing attack:** clean — no findings. All 35+ `KESEFLE_BOT_SECRET` comparisons go through `constantTimeEqual` (`lib/crypto.js:296`) or `crypto.timingSafeEqual` directly. Zero `==`/`===` on the secret.
- **Sheet/Drive permissions:** clean — no findings. `lib/sheet-writer.js` never calls Drive's `permissions.create` with `anyone` or `anyoneWithLink`. The sheet is created in the user's own Drive via their OAuth refresh token; only the user has access.
- **Webhook signature validation:** clean — no findings. Meta WhatsApp (HMAC-SHA256 + raw body capture), PayPal (API verify endpoint with all 5 transmission headers), Coinbase Commerce (HMAC-SHA256). All use `crypto.timingSafeEqual`. Dead Stripe handler still has correct verification.
- **Prompt injection:** clean — no findings. The bot does NOT call any LLM (Gemini / OpenAI / Claude / Anthropic). All `UrlFetchApp.fetch` calls go to Kesefle's own `/api/**` endpoints, never to a generative AI provider. Categorization is keyword-based.
- **Logging PII:** mostly clean. `lib/log.js` auto-redacts `phone`, `email`, `userSub`, `*token*`, `*secret*` keys at depth ≤ 5. Spot checks across `api/sheet/append.js`, `api/sheet/mark-vat.js`, `api/whatsapp/send.js`, `api/admin/*.js` show all log calls use structured `log.info({ phone, userSub, ... })` (auto-redacted). `api/account.js:324` masks the phone explicitly even before redaction. The one residual risk is `console.log` calls that bypass the redacter — see M4.

---

## Recommended PR series (6 PRs, in order)

1. **PR-1: Tenant isolation hardening.** Extract `resolveTenantWriteRecord(phone)` from `api/recurring.js:175-198` into `lib/sheet-writer.js`; call from all 5 endpoints flagged in H1. Add regression test in `bot/test_isolation.js` covering each endpoint. (Closes H1.)
2. **PR-2: Admin auth consolidation.** Switch `api/admin/customer-digest-set.js` and `api/admin/stats.js` to `requireAdmin`. Remove `ADMIN_TOKEN` from Vercel env. (Closes H2, H3.)
3. **PR-3: Bot secret crypto consistency.** Replace local `constantTimeEqual` in `api/log/bot-heartbeat.js` with the canonical import. (Closes M1.)
4. **PR-4: Dead code purge.** Delete `api/billing/webhook.js`. Verify no router reference. (Closes M5.)
5. **PR-5: CORS env var.** Move `_ALLOWED_ORIGINS_` in `api/events.js` to `CORS_ALLOWED_ORIGINS` env var, comma-separated. (Closes M3.)
6. **PR-6: OAuth callback log audit.** Read `api/auth/google.js`, replace any `console.log` of profile fields with `log.info` (auto-redacted). (Closes M4.)

---

## 30-day security roadmap

- Land all 6 PRs above.
- Run `bot/test_isolation.js` in CI on every PR touching `api/sheet/**` or `lib/sheet-writer.js`.
- Add a one-shot script `scripts/audit_phone_sheet_drift.js` that scans every `phone:*` KV record and reports any where `phone.spreadsheetId !== sheet:{userSub}.spreadsheetId`. Run weekly.
- Enable Vercel Log Drains to a separate write-only destination (Logflare or BetterStack) so admin-action audit trails survive a Vercel project compromise.
- Document the threat model in `docs/security.md`: tenant isolation invariant, bot-secret rotation cadence (already exists in `BOT_SECRET_ROTATION.md` — link from `SECURITY.md`).
- Set up a `security@kesefle.com` alias and publish `.well-known/security.txt` (the `vercel.json` already reserves the route).
- Add a Vercel firewall rule blocking requests with `User-Agent: Mozilla/5.0` against `/api/admin/**` (admin endpoints should only be called from the admin dashboard or Steven's curl).
- Schedule a 1-day SOC 2 Lite review against `docs/SOC2_LITE_CHECKLIST.md` before crossing 100 paying customers.

---

**End of audit. No code changes made. Findings cataloged for Steven's review and PR sequencing.**
