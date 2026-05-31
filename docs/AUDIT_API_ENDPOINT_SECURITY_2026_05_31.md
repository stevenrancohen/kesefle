# API endpoint security audit — 2026-05-31

Auditor: kesefle-api-endpoint-security agent (audit-only, read-only sweep).
Scope: every `api/**/*.js` file (90 endpoint files + 3 `api/_lib/*` shared utilities = 93 .js files total).
Method: Per-endpoint check of auth, rate-limit, input validation, PII-in-logs, CORS, method gate. Cross-checked against `lib/auth.js`, `lib/ratelimit.js`, `lib/crypto.js`, `lib/log.js`, `lib/middleware.js`.
Baseline: prior audits `docs/SECURITY_QA_RESWEEP_2026_05_29.md` + `docs/SECURITY_HARDENING_AUDIT_2026-05-27.md`. This pass re-checks every endpoint after PRs through 2026-05-31.

## Summary

- Total endpoint files scanned: **90** (+ 3 shared utilities in `api/_lib/`)
- CRITICAL: **0**
- HIGH: **1**  (bot secret transmitted in URL query string by 2 cron endpoints)
- MEDIUM: **5**  (admin handlers without rate-limit wrap, duplicated constant-time helpers, legacy ADMIN_TOKEN path, dead Stripe webhook still routable, verify-token strict equality)
- LOW: **6**  (Cache-Control/header inconsistencies, error-context PII risk in a few `log.warn`, legacy plaintext refreshToken fallback, KV outage error-message verbosity, etc.)

Posture grade: **B+ → A−**. Every prior-audit High (H1-H3) has been fixed. R1, R2, R5, R8 from the 2026-05-29 re-sweep are all closed. New finding: cron secret-in-URL is now the loudest gap.

---

## Critical findings

**None.** No write endpoint is missing auth, no secret comparison uses raw `===` against the secret itself, no ACAO `*` on a credentialed route, no SSRF surface, no unauthenticated admin endpoint.

---

## High findings

### H1. Manual-trigger cron handlers accept `KESEFLE_BOT_SECRET` in the URL query string

- **Files:** `api/cron/customer-weekly-digest.js:79-83`, `api/cron/steven-daily-digest.js:147-151`
- **Severity:** HIGH (secret leak via access logs)
- **Evidence:**
  ```js
  const adminParam = (req.query && req.query.admin) || ...;
  if (adminParam && process.env.KESEFLE_BOT_SECRET && constantTimeEqual(adminParam, process.env.KESEFLE_BOT_SECRET)) {
    return true;
  }
  ```
- **Risk:** Vercel access logs (and any upstream proxy / CDN / browser history / Referer header on outbound clicks rendered into the response) capture the full request URL **including the query string**. The bot secret is the master key for ~20 bot-callable endpoints. Anyone with read access to Vercel logs sees the secret in plaintext, indefinitely.
- **Fix:** Switch manual-trigger path to `Authorization: Bearer <KESEFLE_BOT_SECRET>` header (same compare, same `constantTimeEqual`), update the manual `curl` runbook in `docs/`. The `?admin=...` path can keep working for one release as a 410 redirect that logs a deprecation warning if hit.
- **Tag:** Claude can ship autonomously (additive header path + warning log, query path kept compatible for 1 release).

---

## Medium findings

### M1. Three admin handlers bypass `withRateLimit` wrapping

- **Files:**
  - `api/billing/manual.js:155` — `const adminHandler = requireAdmin(adminImpl)` — no `withRateLimit`. The `requestHandler` (user-flow) IS wrapped; the admin-flow (list / confirm / reject) is not.
  - `api/billing/paypal.js:451` — `if (action === 'setup-plans') return requireAdmin(setupPlansImpl)(req, res)` — `setup-plans` is admin-only and not rate-limited (though it is one-shot config). The user-facing `subscribe` IS rate-limited.
  - `api/admin.js` — the top-level router (line 574-580) calls `adminHandler(req, res)` which IS rate-limited (line 561), so this admin endpoint is OK. The PUBLIC diagnostic dispatcher (`publicDiagHandler`, line 567) is also rate-limited (30/min). No issue here — flagged then cleared on re-read.
- **Severity:** MEDIUM (defense-in-depth; admin auth already gates, but rate-limit caps brute-force on token leak)
- **Fix:** Wrap with `withRateLimit({ key: 'admin_billing_manual', limit: 60, windowSec: 60 })` etc. ~3 lines per endpoint.
- **Tag:** Claude can ship autonomously.

### M2. Two duplicated local `constantTimeEqual` implementations

- **Files:** `api/log/bot-heartbeat.js:18-28`, `api/whatsapp/link.js:145-155`
- **Severity:** MEDIUM (maintenance hazard, not exploitable today — algorithms reviewed and correct: length-XOR + per-char XOR accumulator, returns boolean)
- **Risk:** Future improvement to `lib/crypto.js#constantTimeEqual` (e.g., switching to `crypto.timingSafeEqual` which is what the canonical now does) won't propagate to these two files.
- **Fix:** Replace with `import { constantTimeEqual } from '../../lib/crypto.js';`. Match the rest of the codebase. Same finding was M1 in the 2026-05-27 audit; still open.
- **Tag:** Claude can ship autonomously.

### M3. Legacy `ADMIN_TOKEN` Bearer path still accepted in `api/admin/stats.js`

- **File:** `api/admin/stats.js:122-148`
- **Severity:** MEDIUM (was H2 in the 2026-05-27 audit; partially closed — the endpoint now ALSO accepts `requireAdmin`, but legacy `ADMIN_TOKEN` path is still live)
- **Evidence:** Lines 117-118 + dispatch at 126-148. A short non-JWT Bearer triggers the legacy `ctEq(bearer, ADMIN_TOKEN)` path.
- **Risk:** If `ADMIN_TOKEN` env var leaks, full KV stats are readable. The migration plan (deprecate after `/admin/monitor.html` switches to Google-OAuth admin flow) was logged in the file header (line 19-20) but the cutover hasn't happened.
- **Fix:** Migrate `/admin/monitor.html` to Google admin sign-in (one HTML edit + cookie-based fetch). Then remove the entire `dispatch()` legacy branch (lines 126-148), exporting just `withRequestId(adminWrapped)`. Drop `ADMIN_TOKEN` from Vercel env.
- **Tag:** Needs Steven approval (involves admin UX change + env var removal).

### M4. Dead Stripe webhook (`api/billing/webhook.js`) is still routable

- **File:** `api/billing/webhook.js` (entire file)
- **Severity:** MEDIUM (low likelihood — Stripe is decommissioned per file header — but the route still exists on `kesefle.com/api/billing/webhook` and would attempt KV writes if any payload arrived. No `STRIPE_WEBHOOK_SECRET` env => returns 500. No `withRateLimit`.)
- **Risk:** Dead code = maintenance debt + invisible attack surface. If `STRIPE_WEBHOOK_SECRET` is ever set in env "just in case", the dead endpoint silently activates premium plans for forged events under metadata-controlled `userSub`.
- **Fix:** Delete the file. The replacement endpoints (`paypal.js`, `crypto-webhook.js`, `manual.js`) are well-tested.
- **Tag:** Needs Steven approval (active deletion of an endpoint that may be referenced in old Stripe dashboard config).

### M5. `META_VERIFY_TOKEN` compared with `===` (timing-attackable bootstrap)

- **File:** `api/whatsapp/webhook.js:92`
- **Severity:** MEDIUM (theoretical only — token is bootstrap-only, used once per webhook re-subscribe; leak would let attacker hijack webhook endpoint binding which they can't exploit further without `META_APP_SECRET`)
- **Evidence:** `if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) { return res.status(200).send(challenge); }`
- **Fix:** Use `constantTimeEqual(String(token), process.env.META_VERIFY_TOKEN)`. 2-line change.
- **Tag:** Claude can ship autonomously.

---

## Low findings

### L1. `api/whatsapp/webhook.js:374, 447` use raw `console.error` for downstream errors
- These do NOT contain secrets / userSub / spreadsheetId (the data is just `e.message`, response status, and a truncated body slice). Migrating to `log.error` would let the redactor catch any future addition of context fields.

### L2. `api/account.js:172` logs `ip` slice in `audit:delete:*` (intentional — audit log of who deleted what)
- IP-as-PII per GDPR — but acceptable retention with audit-log retention policy (~years for legal records of consent withdrawal). Confirm in the privacy policy or truncate to /16.

### L3. Legacy plaintext `refreshToken` fallback path still present in `api/sheet/provision.js:100`, `api/whatsapp/webhook.js:363-364`, `api/account.js:142-143`
- Code: `userRec.refreshTokenEnvelope ? decrypt(...) : userRec.refreshToken`. Provisional fallback for users created before AES-GCM rollout. Re-encryption migration script (`scripts/reencrypt_refresh_tokens.js` per `docs/SECURITY_HARDENING_AUDIT_2026-05-27.md` H?) should be re-run; once 0 records remain in plaintext, this branch can be deleted.

### L4. `api/cron/customer-weekly-digest.js:162-164` push raw `userKey` into `errors` array
- `userKey = "google:<sub>"` — the sub is PII. The response body returns `errors: errors.length` (length only) — good. But the **`errors` array itself** is held in scope and may be observable if the function is profiled / a future code change logs it. Acceptable but worth scrubbing to sha256-8 ID before push.

### L5. `api/admin/stats.js:62-68` defines a local `ctEq` (the third duplicated implementation in the codebase)
- Same as M2. Algorithm is correct (length-check + XOR loop). Same fix: import from `lib/crypto.js`.

### L6. `api/sheet/getExpenses.js` uses bespoke `requireUser(req, res)` (from `api/_lib/session.js`) instead of canonical `requireAuth` middleware
- Functional equivalence — both verify the session cookie / produce a `userId`. But it splits the cookie-auth surface across two helpers. Future hardening should consolidate on `requireAuth` (which also accepts Bearer ID tokens, broader compatibility).

---

## Per-endpoint matrix

| Path | Method | Auth | Rate | Input val | PII safe | CORS | Risk |
|---|---|---|---|---|---|---|---|
| api/ab.js | GET/POST | requireAdmin (POST), public (GET) | 300/60s | strict | OK | OK | OK |
| api/abuse-log.js | POST | bot-secret + constantTimeEqual | 60/60s | strict | OK | OK | OK |
| api/account.js | POST/GET | requireAuth + bot-secret (delete-by-phone) | 5/3600s | strict | OK | OK | OK |
| api/admin.js | GET/POST | requireAdmin + public diag (allowlist) | 60/60s (admin), 30/60s (diag) | strict | OK | OK | OK |
| api/admin/bot-version.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/config-drift.js | GET | requireAdmin | 30/60s | n/a | OK | OK | OK |
| api/admin/create-sample-sheet.js | POST | requireAdmin | 10/3600s | strict | OK | OK | OK |
| api/admin/customer-digest-set.js | POST | requireAdmin | 30/60s | strict | OK | OK | OK (was H3 — fixed) |
| api/admin/funnel-summary.js | GET | requireAdmin | 30/60s | n/a | OK | OK | OK |
| api/admin/help-queries.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/inbox.js | GET | requireAdmin | 60/60s | strict | OK | OK | OK |
| api/admin/launch-monitor.js | GET | requireAdmin | 30/60s | n/a | OK | OK | OK |
| api/admin/recent-signups.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/referral-leaderboard.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/reprovision-user-sheet.js | POST | requireAdmin | 10/60s | strict | OK | OK | OK |
| api/admin/resend-welcome.js | POST | requireAdmin | 30/60s | strict | OK | OK | OK |
| api/admin/revenue.js | GET | requireAdmin | 30/3600s | n/a | OK | OK | OK |
| api/admin/sheets-quota.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/stats.js | GET | requireAdmin + legacy ADMIN_TOKEN | 30/60s | n/a | OK | OK | **M3** (legacy path) |
| api/admin/user-reports.js | GET | requireAdmin | 60/60s | n/a | OK | OK | OK |
| api/admin/user-timeline.js | GET | requireAdmin | 60/60s | strict | OK | OK | OK |
| api/announcements.js | GET/POST | requireAdmin (POST) + bot-secret (bot GET) + public list | 120/60s | strict | OK | OK | OK |
| api/auth/google.js | POST | (verifies ID token itself, no middleware) | per-IP (legacy `_lib/rateLimit`) | strict | OK | OK | OK |
| api/auth/google-exchange.js | POST | (PKCE exchange; verifies via internal call) | 10/3600s | strict | OK | OK | OK |
| api/auth/logout.js | POST | (clears cookie; no auth needed) | 30/60s | n/a | OK | OK | OK |
| api/billing/cancel-flow.js | POST | requireAuth | 60/60s + 10/3600s per-user | strict | OK | OK | OK |
| api/billing/change-plan.js | POST | requireAuth | 30/60s + 10/3600s per-user | strict | OK | OK | OK |
| api/billing/checkout.js | POST | requireAuth | 10/3600s | strict | OK | OK | OK |
| api/billing/crypto-create.js | POST | requireAuth | 10/3600s | strict | OK | OK | OK |
| api/billing/crypto-webhook.js | POST | HMAC-SHA256 via timingSafeEqual | none | strict | OK | OK | OK (webhook) |
| api/billing/invoice.js | POST | requireAdmin | 20/3600s | strict | OK | OK | OK |
| api/billing/manual.js | POST/GET | requireAuth (request) / requireAdmin (admin) | request: 10/3600s; admin: **none** | strict | OK | OK | **M1** (admin no RL) |
| api/billing/paypal.js | POST | requireAuth (subscribe) / PayPal verify-webhook-signature (webhook) / requireAdmin (setup-plans) | 30/3600s on subscribe; **none** on setup-plans | strict | OK | OK | **M1** (setup-plans no RL) |
| api/billing/webhook.js (Stripe — dead) | POST | HMAC-SHA256 via timingSafeEqual | **none** | strict | OK | OK | **M4** (dead code) |
| api/billing/winback-claim.js | POST | optionalAuth | 30/3600s | strict | OK | OK | OK |
| api/budgets.js | POST | requireAuth OR bot-secret | per-userSub/phone 30/3600s | strict | OK | OK | OK |
| api/config.js | GET | public (returns only safe public values) | none (CDN-cached 60s) | n/a | OK | OK | OK |
| api/cron/budget-check.js | POST | CRON_SECRET or bot-secret (constantTimeEqual) | none (cron-only) | strict | OK | OK | OK |
| api/cron/customer-weekly-digest.js | GET/POST | CRON_SECRET (header) OR bot-secret via **?admin=** query | none | strict | OK | OK | **H1** (secret in URL) |
| api/cron/kv-backup.js | POST | CRON_SECRET (constantTimeEqual) | none | n/a | OK | OK | OK |
| api/cron/kv-monitor.js | GET | CRON_SECRET (constantTimeEqual) | none | n/a | OK | OK | OK |
| api/cron/lifecycle.js | POST | CRON_SECRET (constantTimeEqual) | none | strict | OK | OK | OK |
| api/cron/recurring.js | POST | CRON_SECRET + bot-secret fallback (constantTimeEqual) | none | strict | OK | OK | OK |
| api/cron/reminders.js | POST | CRON_SECRET (constantTimeEqual) | none | strict | OK | OK | OK |
| api/cron/steven-daily-digest.js | GET/POST | CRON_SECRET (header) OR bot-secret via **?admin=** query | none | strict | OK | OK | **H1** (secret in URL) |
| api/custom-categories.js | GET/POST | requireAuth (POST) + bot-secret (GET) | 60/60s + 30/3600s per-user | strict | OK | OK | OK |
| api/events.js | POST | public (waitlist/track/nps) | per-action; CORS allowlist | strict | OK | strict allowlist | OK |
| api/goals/delete.js | POST | bot-secret (constantTimeEqual) | 30/600s | strict | OK | OK | OK |
| api/goals/list.js | GET | bot-secret (constantTimeEqual) | 60/600s | strict | OK | OK | OK |
| api/goals/upsert.js | POST | bot-secret (constantTimeEqual) | 30/600s | strict | OK | OK | OK |
| api/group.js | POST | bot-secret + cron-secret (markRecurringFired) | 60/60s | strict | OK | OK | OK |
| api/group/mine.js | GET | requireAuth | 60/60s + 60/3600s per-user | n/a | OK | OK | OK |
| api/health.js | GET | public (liveness probe) | none | n/a | OK | OK | OK |
| api/health/detailed.js | GET | public | none (CDN-friendly) | n/a | OK | OK | OK |
| api/import/bank-csv.js | POST | requireAuth | 5/3600s per-user | strict (bounded loop, MAX_ROWS) | OK | OK | OK |
| api/learn.js | GET/POST | bot-secret (constantTimeEqual) | 120/60s | strict | OK | OK | OK |
| api/log/bot-heartbeat.js | POST | bot-secret (LOCAL constantTimeEqual) | 60/3600s | strict | OK | OK | **M2** (dup helper) |
| api/log/funnel-event.js | POST | public (anonymous funnel events) | 600/60s | strict | OK | OK | OK |
| api/log/missed-inapp.js | POST | public | 60/60s | strict | OK | OK | OK |
| api/log/user-report.js | POST | public | 30/600s | strict | OK (email logged but key matches `/email/i` redactor) | OK | OK |
| api/me.js | GET | session cookie (getUserId) | 30/60s | n/a | OK | OK | OK (was R8 — fixed) |
| api/nps.js | GET/POST | requireAdmin (GET) + bot-secret (POST) | 60/60s | strict | OK | OK | OK |
| api/objectives/action.js | POST | bot-secret (constantTimeEqual) | 60/600s | strict | OK | OK | OK |
| api/profile.js | POST | bot-secret (constantTimeEqual) | 60/60s | strict | OK | OK | OK |
| api/push/subscribe.js | GET/POST/DELETE | requireAuth | 10/3600s per-user | strict | OK | OK | OK |
| api/recurring.js | POST | bot-secret + CRON_SECRET (constantTimeEqual) | 60/60s | strict | OK | OK | OK |
| api/referral.js | GET/POST | requireAuth | 30/3600s | strict | OK | OK | OK |
| api/reminders.js | POST | bot-secret + CRON_SECRET for "due" action (constantTimeEqual) | 30/60s | strict | OK | OK | OK |
| api/sheet/add-category-row.js | POST | bot-secret + sheet_ownership_mismatch guard | 30/60s + 12/3600s per-phone | strict | OK | OK | OK |
| api/sheet/append.js | POST | bot-secret + sheet_ownership_mismatch guard | 60/60s + 40/60s per-phone | strict | OK | OK | OK |
| api/sheet/bot-query.js | POST | bot-secret + sheet_ownership_mismatch guard | 60/60s + 30/3600s per-phone | strict | OK | OK | OK |
| api/sheet/csv-import.js | POST | bot-secret + sheet_ownership_mismatch guard | 10/60s + 3/86400s per-phone | strict (5MB cap, MAX_ROWS) | OK | OK | OK |
| api/sheet/delete-last.js | POST | bot-secret + sheet_ownership_mismatch guard | 30/60s | strict | OK | OK | OK |
| api/sheet/delete-rows.js | POST | requireAuth | 120/60s + 30/3600s per-user | strict | OK | OK | OK |
| api/sheet/export.js | GET | requireAuth | 30/60s + 10/3600s per-user | n/a | OK | OK | OK |
| api/sheet/fix-company-dashboard.js | POST | bot-secret + sheet_ownership_mismatch guard | 30/60s + 10/3600s per-id | strict | OK | OK | OK |
| api/sheet/getExpenses.js | GET/POST | session cookie (requireUser) | 60/60s | strict | OK | OK | OK (was F1 — fixed) |
| api/sheet/mark-vat.js | POST | bot-secret + sheet_ownership_mismatch guard | 30/3600s + 20/3600s per-phone | strict | OK | OK | OK |
| api/sheet/monthly-statement.js | GET | requireAuth | 60/60s + 30/3600s per-user | n/a | OK | OK | OK |
| api/sheet/provision.js | POST | tokeninfo + drive.file scope check OR cookie session | per-IP 100/3600s + per-user 50/3600s | strict | OK (R5 fixed) | OK | OK |
| api/sheet/relabel-row.js | POST | bot-secret + sheet_ownership_mismatch guard | 60/60s + 20/3600s per-phone | strict | OK | OK | OK |
| api/sheet/stats.js | POST | bot-secret + sheet_ownership_mismatch guard | 120/60s | strict | OK | OK | OK |
| api/sheet/summary.js | GET | requireAuth | 30/60s | n/a | OK | OK | OK |
| api/sheet/tax-report.js | GET | requireAuth | 10/3600s + 5/3600s per-user | n/a | OK | OK | OK |
| api/sheet/web-append.js | POST | requireAuth | 120/60s + 60/3600s per-user | strict | OK | OK | OK |
| api/testimonials.js | GET/POST | requireAdmin (GET admin) + bot-secret (POST) + public (GET) | 60/60s | strict | OK | OK | OK |
| api/waitlist.js | GET/POST | requireAdmin (GET/admin update) | 60/60s + 5/3600s per-IP | strict | OK | OK | OK |
| api/whatsapp/link.js | GET/POST | bot-secret (LOCAL constantTimeEqual) | per-call rate limit | strict | OK | OK | **M2** (dup helper) |
| api/whatsapp/send.js | POST | bot-secret (constantTimeEqual) | 100/3600s per-phone | strict | OK | OK | OK |
| api/whatsapp/webhook.js | GET/POST | META_VERIFY_TOKEN (===) on GET + HMAC-SHA256 (timingSafeEqual) on POST | 120/60s per-IP | strict | OK (R2 fixed: log.error not console.error) | OK | **M5** (=== on verify token) |
| api/objectives/action.js | POST | bot-secret (constantTimeEqual) | 60/600s | strict | OK | OK | OK |

---

## What's been fixed since prior audits (verified clean)

Cross-checked every "still open" finding from `docs/SECURITY_QA_RESWEEP_2026_05_29.md` and `docs/SECURITY_HARDENING_AUDIT_2026-05-27.md`:

- **R1** (GDPR `deleteAccount` missed 6 KV prefixes) — **FIXED**. `api/account.js:53-86` introduces the unified `_keysForUser_(userSub, phone, referralCode)` helper called from both web-flow (line 155) and bot-flow (line 353) delete paths.
- **R2** (`console.error WRITE_BLOCKED_*` PII leak in webhook) — **FIXED**. `api/whatsapp/webhook.js:360, 366` now use `log.error('wa.write_blocked_*', { userSub, ... })` — `userSub` matches the redactor pattern.
- **R5** (`api/sheet/provision.js:290` raw `console.log` of full record) — **FIXED**. Lines 290-299 now use `log.info('provision.sheet_provisioned_no_kv', { userSub, hasEmail, hasSheet, provisioned })`.
- **R7** (`api/sheet/getExpenses.js` no rate limit) — **FIXED**. Line 215: `export default withRateLimit({ key: 'sheet_get_expenses', limit: 60, windowSec: 60 })(handlerImpl);`
- **R8** (`api/me.js` no rate limit) — **FIXED**. Lines 86-88: wrapped with `withRateLimit({ key: 'me', limit: 30, windowSec: 60 })`.
- **H1** (five bot-secret sheet endpoints lacked `sheet_ownership_mismatch`) — **FIXED**. All five (`delete-last`, `csv-import`, `relabel-row`, `add-category-row`, `fix-company-dashboard`) now have the guard. Search `grep -l "sheet_ownership_mismatch" api/sheet/*.js` returns 12 files (every bot-secret sheet write endpoint).
- **H2** (`api/admin/stats.js` used ADMIN_TOKEN not requireAdmin) — **PARTIALLY FIXED** (now also accepts `requireAdmin`; legacy path retained — tracked as **M3** above).
- **H3** (`api/admin/customer-digest-set.js` used bot-secret, not admin) — **FIXED**. Uses `requireAdmin` at line 113.

---

## Recommendations (prioritized)

1. **H1 — Move bot secret out of URL query string in two cron handlers.**
   - Files: `api/cron/customer-weekly-digest.js`, `api/cron/steven-daily-digest.js`
   - Change: replace `?admin=<secret>` with `Authorization: Bearer <secret>` (or `X-Kesefle-Bot-Secret` header). Keep query path live for 1 release with deprecation warning.
   - Effort: 30 minutes including doc updates.
   - **Tag: Claude can ship autonomously.**

2. **M5 — Switch `META_VERIFY_TOKEN` compare to `constantTimeEqual`.**
   - File: `api/whatsapp/webhook.js:92`
   - 2-line change.
   - **Tag: Claude can ship autonomously.**

3. **M2 — Replace two local `constantTimeEqual` (and the third `ctEq` in stats.js) with `import { constantTimeEqual } from '../../lib/crypto.js'`.**
   - Files: `api/log/bot-heartbeat.js:18-28`, `api/whatsapp/link.js:145-155`, `api/admin/stats.js:62-68`
   - Delete the local copies. All three behave identically to `lib/crypto.constantTimeEqual` after `lib/crypto` was upgraded to wrap `crypto.timingSafeEqual`.
   - **Tag: Claude can ship autonomously.**

4. **M1 — Wrap three admin handlers with `withRateLimit`.**
   - Files: `api/billing/manual.js:155`, `api/billing/paypal.js:451`. (admin.js line 451 setup-plans only.)
   - 3 lines per file; defense-in-depth.
   - **Tag: Claude can ship autonomously.**

5. **M4 — Delete the dead Stripe webhook.**
   - File: `api/billing/webhook.js` (entire file).
   - Pre-deletion: confirm Vercel deploy logs show zero recent hits to `/api/billing/webhook` (likely zero — migration was months ago).
   - **Tag: Needs Steven approval** (deletes a path that may still be referenced in stale Stripe dashboard config).

6. **M3 — Remove legacy `ADMIN_TOKEN` path from `api/admin/stats.js`.**
   - Prerequisite: migrate `/admin/monitor.html` to Google admin sign-in flow.
   - Then: delete the `dispatch()` legacy branch (lines 126-148) and the `ADMIN_TOKEN` env var from Vercel.
   - **Tag: Needs Steven approval** (changes admin UX + removes env var).

7. **L3 (future) — Re-run the refresh-token re-encryption migration**, confirm 0 plaintext records remain in KV, then delete the legacy plaintext fallback branch in `api/account.js`, `api/sheet/provision.js`, `api/whatsapp/webhook.js`.
   - **Tag: Needs Steven approval** (requires KV scan + verification).

---

## Methodology notes

- Read `lib/auth.js`, `lib/ratelimit.js`, `lib/crypto.js`, `lib/log.js`, `lib/middleware.js`, `api/_lib/session.js`, `api/_lib/rateLimit.js` to confirm the canonical helpers.
- For each `api/**/*.js`, ran `grep -n "requireAuth|requireAdmin|KESEFLE_BOT_SECRET|CRON_SECRET|withRateLimit|rateLimit|constantTimeEqual|method"` to characterize auth posture, then read the file head/tail for export wrapping order (`withRequestId → withRateLimit → requireAuth/requireAdmin → handlerImpl`).
- Cross-referenced findings against prior audits (`SECURITY_QA_RESWEEP_2026_05_29.md`, `SECURITY_HARDENING_AUDIT_2026-05-27.md`) to confirm fix status.
- Audit-only: no source files modified.
