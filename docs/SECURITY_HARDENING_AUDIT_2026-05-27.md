# Kesefle Security + Privacy Hardening Audit — 2026-05-27

Scope: `api/**`, `lib/**`, `bot/ExpenseBot_FIXED.gs`, top-level HTML, `vercel.json`.
Method: 10 checks per Steven's brief. No code changes.

---

## Executive summary

Posture is stronger than typical pre-launch SaaS. Tenant isolation is a documented invariant (canonical `sheet:{userSub}` + `user:{userSub}` resolution, mismatch guard, multi-writer anomaly detector). All bot-secret comparisons use `constantTimeEqual` / `crypto.timingSafeEqual` — zero `===` paths. Webhook signatures verified with HMAC + raw-body capture for Meta WhatsApp, PayPal (verify API), Coinbase Commerce. `lib/log.js` auto-redacts `phone`, `email`, `*token*`, `userSub` keys. CSP/HSTS/X-Frame-Options/Referrer-Policy set globally. Sheets are provisioned in the user's own Drive via OAuth — never granted "anyone-with-link".

Gaps are narrow. Biggest: five bot-secret sheet endpoints lack the explicit ownership-mismatch guard (they trust the phone record alone); two admin endpoints diverge from `requireAdmin` (one uses a separate `ADMIN_TOKEN`, one uses `KESEFLE_BOT_SECRET`).

**Risk grade: B+** — no Critical findings exploitable today. High items below should land before scaling past ~1k paying users.

---

## Critical findings

None.

---

## High (fix this month)

### H1. Five bot-secret sheet endpoints lack `sheet_ownership_mismatch` guard
- **Severity:** High
- **Files:** `api/sheet/delete-last.js:70`, `api/sheet/csv-import.js:297-302`, `api/sheet/relabel-row.js:96-100`, `api/sheet/add-category-row.js:174-180`, `api/sheet/fix-company-dashboard.js`.
- **Exploitable today?** Theoretical only. The guard exists in `append.js`, `bot-query.js`, `mark-vat.js`, `stats.js`, `recurring.js` (added after the original cross-tenant leak). If a `phone:` record's cached `spreadsheetId` drifts from canonical `sheet:{userSub}`, these five would silently act on the wrong sheet (delete wrong row, write to wrong sheet, etc.).
- **Fix:** Extract `resolveTenantWriteRecord(phone)` from `api/recurring.js:175-198` into `lib/sheet-writer.js`; call from all five.

### H2. `api/admin/stats.js` uses `ADMIN_TOKEN`, not `requireAdmin`
- **Severity:** High
- **File:** `api/admin/stats.js:1-60`
- **Exploitable today?** Only if `ADMIN_TOKEN` env leaks. It's a parallel Bearer-token auth path that bypasses the `ADMIN_EMAILS` allowlist used by every other admin endpoint. Token compromise = full KV stats read; no second factor.
- **Fix:** Migrate to `requireAdmin`; remove `ADMIN_TOKEN` from Vercel env.

### H3. `api/admin/customer-digest-set.js` uses `KESEFLE_BOT_SECRET`, not `requireAdmin`
- **Severity:** High
- **File:** `api/admin/customer-digest-set.js:65-71`
- **Exploitable today?** Anyone with the bot secret can set the customer-weekly-digest message that goes to every paying user. Phishing/reputational vector — broadcast a fake "click here for refund" Hebrew message.
- **Fix:** Switch to `requireAdmin`. The endpoint is admin-only by design.

---

## Medium (fix this quarter)

### M1. `api/log/bot-heartbeat.js:18-28` reimplements `constantTimeEqual` locally
- **Exploitable today?** No — implementation is correct. But it's a maintenance hazard; future changes to canonical won't propagate.
- **Fix:** Import from `lib/crypto.js`.

### M2. `innerHTML` interpolations of error-message strings
- **Files:** `admin.html:1219, 1306, 1363, 1393, 1526` — `esc(e.message)` from caught exceptions.
- **Exploitable today?** No — `esc()` correctly escapes `< > & " '`. JS Error messages can carry user-influenced fragments, so this is defense-in-depth only. All other interpolations pass through `esc`/`escapeHtml`.
- **Fix:** Adopt a lint rule banning bare `innerHTML =` for fetch-derived strings. Cosmetic.

### M3. `api/events.js:255-285` CORS allowlist is hardcoded
- **Exploitable today?** No — strict allowlist (`kesefle.com`, `www.kesefle.com`, `kesefle.vercel.app`, two localhost ports), no credentials sent.
- **Fix:** Move to `CORS_ALLOWED_ORIGINS` env var.

### M4. `api/auth/google.js:108` comment mentions logging email/name/picture
- **Exploitable today?** Only if a raw `console.log({...profile})` bypasses the structured logger.
- **Fix:** Audit the file; ensure all OAuth-callback logging goes through `log.info()`.

### M5. Dead `api/billing/webhook.js` (Stripe) still shipped
- **File:** `api/billing/webhook.js:1-4`
- **Exploitable today?** It's a live Vercel route. If `STRIPE_WEBHOOK_SECRET` is ever set by mistake, the endpoint becomes callable and would update `user.plan` based on Stripe events Kesefle no longer expects.
- **Fix:** Delete the file.

### M6. Phone-record self-heal in `append.js:145-147` is fire-and-forget
- **Exploitable today?** No, but a stale-read race could re-trigger a mismatch.
- **Fix:** Use SETNX or version stamp; low-priority refinement.

---

## Low (defer)

- **L1.** `api/billing/crypto-webhook.js:74` uses `console.error` instead of `log.error`. Inconsistent; no PII leak.
- **L2.** `vercel.json` CSP allows `'unsafe-inline'` on `script-src`. Required by Tailwind CDN + inline scripts; revisit with a bundler.
- **L3.** `api/billing/winback-claim.js` is unauthenticated by design (token = first 24 chars of `userSub` from email, rate-limited 30/hr/IP). Document the threat model.

---

## Clean categories

- **Secrets in tracked files:** No `AIza...` / `sk-...` / `xox...` / `-----BEGIN` / hardcoded `KESEFLE_BOT_SECRET`. Every `client_secret` match is a read of `process.env.GOOGLE_CLIENT_SECRET` for OAuth (correct). Test files (`tests/test_csv_import.js:5,10`) use fake strings.
- **Bot-secret timing:** 35+ comparisons; all via `constantTimeEqual` (`lib/crypto.js:296`) or `crypto.timingSafeEqual`. Zero `==`/`===`.
- **Sheet/Drive permissions:** `lib/sheet-writer.js` never calls `permissions.create` with `anyone`/`anyoneWithLink`. Sheet lives in the user's Drive.
- **Webhook signatures:** Meta WhatsApp (HMAC-SHA256 + raw body), PayPal (`/v1/notifications/verify-webhook-signature` with all 5 transmission headers), Coinbase Commerce (HMAC-SHA256). All use `crypto.timingSafeEqual`.
- **Prompt injection:** Bot makes zero LLM calls. All `UrlFetchApp.fetch` targets are Kesefle's own `/api/**`. Categorization is keyword-based.
- **Logging PII:** `lib/log.js:11-34` redacts `phone`/`email`/`userSub`/`*token*`/`*secret*`/`code` at depth ≤ 5. Spot checks across `api/sheet/append.js`, `api/sheet/mark-vat.js`, `api/whatsapp/send.js`, `api/admin/*.js` confirm structured `log.info({ phone, userSub, ... })` everywhere. `api/account.js:324` masks phone explicitly even before redaction.
- **Cron auth:** All 8 cron handlers (`budget-check`, `customer-weekly-digest`, `kv-backup`, `kv-monitor`, `lifecycle`, `recurring`, `reminders`, `steven-daily-digest`) gate via `constantTimeEqual` on `CRON_SECRET`.

---

## Recommended PR series (6 PRs)

1. **Tenant isolation hardening** — extract `resolveTenantWriteRecord` into `lib/sheet-writer.js`; call from all 5 endpoints in H1. Add `bot/test_isolation.js` regression per endpoint. *(Closes H1.)*
2. **Admin auth consolidation** — switch `api/admin/customer-digest-set.js` + `api/admin/stats.js` to `requireAdmin`; remove `ADMIN_TOKEN` env. *(Closes H2, H3.)*
3. **Bot-secret crypto consistency** — replace local `constantTimeEqual` in `api/log/bot-heartbeat.js` with canonical import. *(Closes M1.)*
4. **Dead-code purge** — delete `api/billing/webhook.js`; confirm no route reference. *(Closes M5.)*
5. **CORS env var** — move `_ALLOWED_ORIGINS_` in `api/events.js` to `CORS_ALLOWED_ORIGINS`. *(Closes M3.)*
6. **OAuth callback log audit** — replace any `console.log` of profile fields in `api/auth/google.js` with `log.info`. *(Closes M4.)*

---

## 30-day security roadmap

- Land all 6 PRs above.
- Run `bot/test_isolation.js` in CI on every PR touching `api/sheet/**` or `lib/sheet-writer.js`.
- Add `scripts/audit_phone_sheet_drift.js` — scans every `phone:*` KV and reports any where `phone.spreadsheetId !== sheet:{userSub}.spreadsheetId`. Run weekly.
- Enable Vercel Log Drains to a write-only destination (Logflare/BetterStack) so admin audit trails survive a Vercel-project compromise.
- Publish `.well-known/security.txt` (the `vercel.json` route is already reserved) + set up `security@kesefle.com`.
- Add a Vercel firewall rule restricting `/api/admin/**` by IP allowlist or geofence.
- Walk `docs/SOC2_LITE_CHECKLIST.md` before crossing 100 paying customers.

---

**End of audit. No code changes made.**
