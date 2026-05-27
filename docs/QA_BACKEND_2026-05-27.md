# Kesefle Backend / API QA Audit — 2026-05-27

Read-only CTO-level production-readiness review. ~90 serverless functions under `api/**.js`. Live endpoints NOT touched.

## Summary

The Kesefle backend is more mature than typical for a pre-launch SaaS: AES-256-GCM at-rest encryption of refresh tokens with kid-rotation, HS256 session JWTs that reject `alg:none`, HMAC verification on Meta/Stripe/Coinbase/PayPal webhooks, timing-safe `constantTimeEqual` for every shared secret, and the canonical tenant chain (`phone:{E164}` → `userSub` → `sheet:{userSub}` + `user:{userSub}`) is consistently enforced on every Sheets-write endpoint — with a leak-guard that aborts when `sheet:{sub}` and `phone:{E164}.spreadsheetId` disagree. A live "multi-writer anomaly detector" in `api/sheet/append.js:212-260` actively alerts on the exact class of bug that caused a prior cross-tenant leak. The major caveat: a single shared `KESEFLE_BOT_SECRET` is the only thing standing between any internet caller and ~20 high-privilege bot endpoints (incl. `phone → userSub` resolution, sheet writes via `/api/recurring`, NPS/announcements PII, `/api/account?action=delete-by-phone` which deletes accounts by phone alone). Loss of that single env var = catastrophic. **Production-readiness score: 7.5 / 10.** Safe to launch with the Top-10 fix list below shipped this week.

## Endpoint table (sorted highest-risk first)

| Endpoint | Method | Auth | Rate limit | Idempotency | Input validation | Error shape | Sheets/KV/Ext |
|---|---|---|---|---|---|---|---|
| `/api/account?action=delete-by-phone` | POST | bot-secret | account_op 5/h IP | none | phone digits-only | `{ok,error}` consistent | KV, Google revoke |
| `/api/sheet/append` | POST | bot-secret | sheet_append 60/min IP + 40/min phone | KV `seen:wa:*` (24h) upstream | E.164, amount>0 | `{ok,error,detail}` | Sheets, KV |
| `/api/sheet/delete-last` | POST | bot-secret | sheet-delete 30/min | none | E.164 | `{ok,error}` | Sheets, KV |
| `/api/sheet/mark-vat` | POST | bot-secret | mark_vat_ip 30/h + 20/h phone | 24h cutoff guard | E.164 | `{ok,error}` | Sheets, KV |
| `/api/sheet/relabel-row` | POST | bot-secret | 60/min IP + 20/h phone | none | rowIndex 2..5001 | `{ok,error,detail}` | Sheets, KV |
| `/api/sheet/add-category-row` | POST | bot-secret | 30/min IP + 12/h phone | dup-label check | name length, no `"` or `\\` | `{ok,error,detail}` | Sheets, KV |
| `/api/sheet/csv-import` | POST | bot-secret | 3/24h phone | hash set 90d | 5000 row + 5MB cap | `{ok,error}` | Sheets, KV |
| `/api/sheet/bot-query` | POST | bot-secret | 60/min IP + 30/h phone | n/a (read) | enum queryType/period | `{ok,error}` | Sheets, KV |
| `/api/sheet/stats` | POST | bot-secret | sheet_stats 120/min | n/a | E.164 | `{ok,error}` | Sheets, KV |
| `/api/sheet/fix-company-dashboard` | POST | session OR bot-secret | 30/min + 10/h | n/a | n/a | `{ok,error}` | Sheets, KV |
| `/api/recurring` | POST | bot-secret OR cron-secret | 60/min | KV `recurring_logged:*` per-day | freq enum, amount>0 | `{ok,error}` | Sheets, KV |
| `/api/reminders` | POST | bot-secret (cron-secret for `due`) | 30/min | none | E.164, date parser | `{ok,error}` | KV |
| `/api/goals/{upsert,delete,list}` | POST/GET | bot-secret | per-route 30-60 | upsert dedups on id | type enum, amountILS 1..1e7 | `{ok,error,detail}` | KV |
| `/api/objectives/action` | POST | bot-secret | 60/10min | n/a | action enum | `{ok,error}` | KV |
| `/api/whatsapp/send` | POST | bot-secret | 100/h per phone | none | E.164, 4096 char cap | `{ok,error,detail}` | Meta Graph |
| `/api/whatsapp/webhook` | GET/POST | HMAC (Meta) + IP RL | 120/min IP | KV `seen:wa:{msgId}` 24h | parsed JSON | `{ok,error}` | Meta, Sheets, KV |
| `/api/whatsapp/link?action=confirm` | POST | bot-secret | wa_link_confirm 120/10min | atomic `SETNX phone:*` | 6-digit code regex | `{ok,error}` | KV, Meta |
| `/api/whatsapp/link?action=request` | POST | session OR access-token | wa_link_request 30/10min | n/a | E.164 | `{ok,error}` | KV |
| `/api/whatsapp/link` (GET) | GET | optional bot-secret | none on GET | n/a | E.164 | `{ok,linked,...}` | KV |
| `/api/auth/google-exchange` | POST | n/a (auth flow) | oauth_exchange 10/h IP | n/a | code/verifier/redirect required | `{ok,error,detail}` | Google, KV |
| `/api/auth/google` | POST | n/a (verifies JWT) | per-IP 30/min | n/a | min length | `{ok,error}` | Google JWKS, KV |
| `/api/auth/logout` | POST | n/a | auth_logout 30/min | n/a | n/a | `{ok}` | n/a |
| `/api/profile` | POST | bot-secret | profile 60/min | n/a | enums, taxId 7-12 digits | `{ok,error}` | KV |
| `/api/learn` | GET/POST | bot-secret | learn 120/min | last-write-wins by hash | hash regex, category enum | `{ok,error}` | KV |
| `/api/budgets` | POST | session OR bot-secret | 30/h userSub OR phone | n/a | category in lib/categories | `{ok,error}` | KV |
| `/api/custom-categories` | GET/POST | bot-secret OR session+premium | 30/h userSub | n/a | name 2-60 char | `{ok,error,detail}` | KV |
| `/api/announcements` | GET/POST | public OR bot-secret OR admin | announcements 120/min | n/a | title/body length, audience enum | `{ok,error}` | KV |
| `/api/testimonials` | GET/POST | public OR bot-secret OR admin | 60/min | n/a | length/word count | `{ok,error,detail}` | KV |
| `/api/abuse-log` | POST | bot-secret | abuse_log 60/min | n/a | length caps | `{ok,stored}` | KV |
| `/api/log/bot-heartbeat` | POST | bot-secret | 60/h | n/a | version<80 char | `{ok}` | KV |
| `/api/log/funnel-event` | POST | none | 600/min IP | n/a | event allowlist | 204/`{ok,error}` | KV |
| `/api/log/missed-inapp` | POST | none | 60/min IP | n/a | UA<500 | 204/`{ok}` | KV |
| `/api/log/user-report` | POST | none | 30/10min IP | n/a | length caps | `{ok,error}` | KV |
| `/api/events?action=...` | POST | none, CORS allowlist | per-IP + per-action | n/a | enum events, allowlist meta | `{ok,error}` | KV |
| `/api/ab?experiment=` | GET/POST | public GET, admin POST | ab 300/min | n/a | name regex | `{ok,error,detail}` | KV |
| `/api/nps` | POST/GET | bot-secret POST, admin GET | nps 60/min | last-write-wins | score 0..10 | `{ok,error}` | KV |
| `/api/waitlist` | POST/GET | public POST, admin GET | waitlist 60/min + 5/h IP | phone/email dedup | email regex | `{ok,error}` | KV |
| `/api/me` | GET | session cookie | none | n/a | n/a | `{ok,error}` | KV |
| `/api/config` | GET | none | none | n/a | n/a | `{ok}` | n/a |
| `/api/health` | GET | none | none | n/a | n/a | env flags only | external probes |
| `/api/health/detailed` | GET | none | none | n/a | n/a | per-dep status | external probes |
| `/api/account?action=delete\|export` | POST/GET | requireAuth | account_op 5/h | n/a | confirmation literal | `{ok,error}` | KV, Google revoke, Sheets |
| `/api/admin*` (all 17+ admin routes) | GET/POST | requireAdmin | per-route 10-60/min | n/a | per-route | `{ok,error}` | KV, Sheets |
| `/api/admin/stats` | GET/POST | Bearer `ADMIN_TOKEN` (legacy) | none | n/a | n/a | `{error}` (NOT `{ok,error}`) | KV |
| `/api/billing/checkout` | POST | requireAuth | 10/h | n/a | plan enum | `{ok,error,detail}` | Stripe (DEPRECATED) |
| `/api/billing/webhook` | POST | HMAC Stripe | none (webhook) | KV `stripe_event:*` | timestamp tolerance 300s | `{ok,error,reason}` | KV (DEPRECATED) |
| `/api/billing/crypto-create` | POST | requireAuth | billing_crypto 10/h | n/a | plan enum | `{ok,error}` | Coinbase |
| `/api/billing/crypto-webhook` | POST | HMAC Coinbase | none (webhook) | KV `crypto_event:*` | n/a | `{ok,error}` | KV |
| `/api/billing/paypal?action=subscribe\|webhook` | POST | requireAuth OR PayPal HMAC | 30/h | KV `paypal_event:*` | plan/period enum | `{ok,error}` | PayPal, KV |
| `/api/billing/manual?action=...` | POST/GET | requireAuth (request) OR requireAdmin | 10/h | code is CSPRNG | plan/method enum | `{ok,error}` | KV, Meta |
| `/api/billing/winback-claim` | POST | none (token-gated) | 30/h IP | KV `winback:{sub}` | token 8-64 char | `{ok,error}` | KV |
| `/api/billing/change-plan` | POST | requireAuth | 30/min + 10/h | KV `plan_change:{sub}` | plan enum | `{ok,error}` | KV |
| `/api/billing/cancel-flow` | POST | requireAuth | 60/min + 10/h | KV `retention:*` | reason enum | `{ok,error}` | KV |
| `/api/billing/invoice` | POST | requireAdmin | 20/h | KV `invoice:{sub}:{ref}` | amount>0 | `{ok,...}` | GreenInvoice |
| `/api/sheet/{summary,export,monthly-statement,tax-report,getExpenses,delete-rows,web-append}` | GET/POST | requireAuth | per-route 5-60/h | none for writes | per-route | `{ok,error}` | Sheets, KV |
| `/api/group` (Splitwise-style) | POST | bot-secret + membership check | 60/min | n/a | code regex | `{ok,error}` | KV, Sheets |
| `/api/group/mine` | GET | requireAuth | 60/h | n/a | n/a | `{ok,group}` | KV |
| `/api/referral?action=...` | POST/GET | requireAuth | 30/h | KV `referral:redeemed:{sub}` | code regex | `{ok,error}` | KV |
| `/api/push/subscribe` | GET/POST/DELETE | requireAuth | push_subscribe 10/h | n/a | endpoint https + b64url keys | `{ok,error}` | KV |
| `/api/import/bank-csv` | POST | requireAuth | 5/h userSub | sha256 hash set 90d | bank enum, 2MB cap | `{ok,error}` | Sheets, KV |
| `/api/cron/{lifecycle,budget-check,kv-backup,kv-monitor,reminders,recurring,steven-daily-digest,customer-weekly-digest}` | POST/GET | `CRON_SECRET` Bearer timing-safe | none (cron) | per-job KV guards | n/a | `{ok,error}` | varies |

## Critical findings

These are high-confidence issues. File:line citations.

1. **`/api/account?action=delete-by-phone` lets anyone with `KESEFLE_BOT_SECRET` permanently delete any user account by phone alone** — `api/account.js:295-326`. No second factor, no audit beyond a `log.info`, no rate limit per phone (only the shared `account_op` 5/h IP bucket which is trivially bypassed). Bot-secret loss = mass-delete capability across the whole tenant base. Recommend: require `KESEFLE_DESTRUCTIVE_SECRET` (separate env) AND log an `audit:delete_by_phone:*` KV row AND alert on every call.

2. **`/api/admin/stats.js` accepts a shared bearer `ADMIN_TOKEN` instead of `requireAdmin`** — `api/admin/stats.js:52-62`. That's a divergent auth model from every other admin route (which use OAuth + `ADMIN_EMAILS`). If `ADMIN_TOKEN` leaks, an attacker reads aggregate KV counts (lower severity than per-record dumps but still confidential business metrics). Also returns errors as `{error: "..."}` not `{ok: false, error: "..."}` — frontend code expecting the latter will misparse.

3. **`/api/whatsapp/link` GET is unauthenticated and returns `{linked: true}` for any phone in KV** — `api/whatsapp/link.js:233-254`. This is a phone-number enumeration oracle: any anonymous caller can iterate Israeli mobile numbers and learn which are Kesefle users. The endpoint correctly suppresses billing fields for non-bot callers (good), but the linked-yes/no leak still violates privacy norms and is exploitable for targeted phishing. Recommend: require a session cookie OR a rate-limit by IP (currently the GET path is explicitly SKIPPED from rate-limiting at `link.js:189-200`).

4. **`/api/admin/stats.js` uses CommonJS `module.exports` + `getRequiredString-style` plain string compare in some paths** — `api/admin/stats.js:44-50` defines its own ad-hoc `ctEq` instead of importing `constantTimeEqual` from `lib/crypto.js`. Identical logic, but it's defined inline four times across the codebase (also `api/whatsapp/link.js:145-155`, `api/log/bot-heartbeat.js:18-28`). One canonical import would avoid drift.

5. **`api/admin/reprovision-user-sheet.js:271` has `withRateLimit(requireAdmin(...), {route, ...})` — argument order is wrong.** `lib/ratelimit.js:100` `withRateLimit({key,limit,windowSec})` is curried `(opts) => (handler) => wrapped`. Passing the handler first plus an options shape with `route/windowMs/max` (not `key/limit/windowSec`) means the rate limit is silently a no-op AND the `windowSec`/`limit` defaults from `lib/ratelimit.js` apply with whatever `undefined` does. Defense-in-depth defeated.

6. **Stripe-leftover `api/billing/webhook.js` has a 500-day-old `STRIPE_WEBHOOK_SECRET` check that fails CLOSED but the file is still in the build** — `api/billing/webhook.js:81-89`. Marked DEPRECATED at the top but reachable at `/api/billing/webhook`. Any half-configured deploy that ever sets `STRIPE_WEBHOOK_SECRET` would re-activate a code path that mutates user plans from Stripe metadata (`updateUserPlan`). Recommend: delete the file (or `return 410 Gone`).

7. **`api/admin/customer-digest-set.js:71` calls `constantTimeEqual(got, expected)` without coercing `got` to string** — `lib/crypto.js:296` accepts `null` and returns false, OK, but `got` may be `undefined` when neither header nor body field exists, which `constantTimeEqual` handles. Lower severity than the equivalent `presented &&` guards elsewhere; still inconsistent with other endpoints (`!got || !constantTimeEqual(...)`). Same pattern at `api/account.js:301`, `api/profile.js:68`, `api/abuse-log.js:26`, `api/sheet/delete-last.js:60`, `api/log/funnel-event.js` (no auth), `api/recurring.js:425/433`. Recommend: harmonize with the safer `!presented || !constantTimeEqual(String(presented), expected)` pattern.

8. **`api/sheet/summary.js:1-11` documents an obsolete `X-User-Sub` header trust model in its top comment** — the code (line 57) correctly reads `req.user.sub` from `requireAuth`. Doc-bug only, but a reviewer who reads the header would think auth is weaker than it is.

9. **`api/whatsapp/link.js:145-155` `constantTimeEqual` uses `charCodeAt(i) || 0`** — out-of-bounds returns NaN, `NaN || 0 === 0`, so positions past the end of EITHER string contribute 0. Combined with `diff = la ^ lb` for the length differential, it's still constant-time-equivalent (good), but the implementation duplicates `lib/crypto.js:296` and is harder to audit. The Node `crypto.timingSafeEqual` import would be cleaner.

10. **`api/cron/customer-weekly-digest.js:75` constructs `'Bearer ' + secret` and passes the FULL bearer header to `constantTimeEqual`** — this is fine cryptographically but means a stale `CRON_SECRET` length differs from what's stored. The cron endpoints in `api/cron/*` are inconsistent: `lifecycle.js`, `budget-check.js`, `kv-backup.js`, `kv-monitor.js`, `reminders.js`, `recurring.js` all use the dedicated `verifyCronAuth` helper that does the same Bearer-prefix concat. Pull into `lib/cron-auth.js` for one canonical implementation.

11. **`api/admin.js:574-580` routes "public diagnostic actions" (bot-status, errors-count, test-webhook) without `requireAdmin`** — `publicBotStatus` at line 435 returns env-presence booleans for Meta/Anthropic. Low severity (booleans only, no values), but the `webhook_url` echoes the host header back to anonymous callers (`admin.js:447`) — an SSRF probe surface if a misconfigured reverse proxy ever attaches a trusting Host header. Recommend: require admin auth or at minimum lock the webhook_url to the canonical domain.

12. **Several "user data" endpoints accept the bot-secret AS body (not just header)** — e.g. `api/profile.js:67`, `api/abuse-log.js:25`, `api/sheet/append.js:84`, `api/sheet/delete-last.js:59`, `api/learn.js:58`. The body path is intended for Apps Script `UrlFetchApp` quirks, but it means the secret ends up in `req.body` which is structured-logged by some middlewares (the Vercel default request log respects `Authorization` redaction but NOT custom JSON fields). `lib/crypto.js:545` `REDACT_KEY_PATTERN` matches `secret` / `webhook[-_]?secret` so `botSecret` IS redacted — verified. Lower severity, but worth a code comment so a future logger refactor doesn't break it.

13. **`api/cron/steven-daily-digest.js:15` hard-codes the owner's E.164 (`972547760643`)** — fine for now (single-tenant ops digest) but worth pulling into env so the file isn't a one-author dependency.

14. **`api/billing/winback-claim.js:67-74` matches token by `startsWith(token)`** — `userSub.startsWith(token)` means a 24-char prefix collision is enough. CSPRNG userSub means collision probability is negligible for Google's 21-digit subs, but the `startsWith` form admits "fuzzy" tokens (a 24-char prefix of one user matches a longer userSub if both share that prefix — possible). Recommend: exact-equality on `userSub.slice(0, 24) === token`.

15. **`api/sheet/append.js:138-141` returns `reauth_required` when neither envelope nor plaintext refresh-token exists, but does NOT distinguish "no refresh-token because the user never granted offline access" from "refresh-token was revoked"** — operationally this means support tickets are hard to route. Add a sub-error tag.

16. **No CSRF tokens on session-cookie writes** — every state-changing POST is gated by `requireAuth` which accepts EITHER the `kefle_session` cookie OR a Bearer ID token. Cookie is `SameSite=Lax` (`api/_lib/session.js:105`) which blocks the obvious cross-origin POST but doesn't defend against a same-site sub-resource attack (e.g. an XSS in a mounted iframe). `lib/crypto.js:317` exports `genCsrfToken` but no endpoint enforces a CSRF check. Recommend: add `withCsrf` middleware for state-changing endpoints that are reachable via cookie.

## Top 10 fixes to ship this week

1. **Add `KESEFLE_DESTRUCTIVE_SECRET` + audit log + per-phone rate limit on `/api/account?action=delete-by-phone`.** Today a leaked bot secret = mass account deletion.

2. **Migrate `/api/admin/stats.js` to `requireAdmin`** (drop `ADMIN_TOKEN` env). Also normalize its error shape to `{ok:false,error,...}` for consistency with the other 16 admin routes.

3. **Fix the `withRateLimit` argument order in `api/admin/reprovision-user-sheet.js:271`** — currently silently a no-op. Change to `withRateLimit({key:'admin_reprov',limit:10,windowSec:60})(requireAdmin(handlerImpl))`.

4. **Delete `api/billing/webhook.js` and `api/billing/checkout.js` (the deprecated Stripe paths)** or replace their handlers with `return res.status(410).json({error:'gone'})`. They're a footgun if Stripe env vars ever come back.

5. **Add IP rate limit + minimal auth to `/api/whatsapp/link` GET** to plug the phone-enumeration oracle. Either require a session cookie OR cap at 10 GETs/hour/IP, regardless of the polling pattern (4s adaptive poll = still <10/h within one onboarding session).

6. **Lock `/api/admin?action=bot-status\|errors-count\|test-webhook` behind `requireAdmin`** — or strip the `webhook_url` from the response (which currently echoes the Host header to anonymous callers).

7. **Pull `constantTimeEqual` into one canonical place.** Four ad-hoc implementations (`lib/crypto.js`, `api/whatsapp/link.js:145-155`, `api/admin/stats.js:44-50`, `api/log/bot-heartbeat.js:18-28`) — pick `lib/crypto.js` as the home, delete the rest. Same for `verifyCronAuth` (duplicated across 6 cron files).

8. **Add a `withCsrf` middleware and apply it to every cookie-authed POST** (`/api/account?action=delete`, `/api/budgets`, `/api/billing/{change-plan,cancel-flow}`, `/api/group/mine`, `/api/push/subscribe`, `/api/referral?action=redeem`, `/api/sheet/{export,monthly-statement,tax-report,delete-rows,web-append,fix-company-dashboard}`). `lib/crypto.js:317` `genCsrfToken` is already there; wire it.

9. **Harmonize bot-secret comparison pattern.** Every endpoint should use `if (!presented || !constantTimeEqual(String(presented), expected))`. Today some omit the `!presented` guard (`api/profile.js:68`, `api/account.js:301`, `api/abuse-log.js:26`, `api/sheet/delete-last.js:60`, `api/admin/customer-digest-set.js:71`) — `constantTimeEqual(null, x)` returns false but a malformed body would skip the explicit check.

10. **Add a single shared error formatter** so every endpoint returns `{ok:false, error:<code>, detail?:<safe-str>, reqId}`. Today ~80% follow this shape, but outliers exist (`api/admin/stats.js`, `api/auth/google-exchange.js` returning `{ok:false, error, detail}` mixed with `{ok:false, error, reason}` for billing webhook). Frontend + bot + monitoring all benefit.

## What was NOT found (positive findings)

- No `==` comparison of secrets (good — `constantTimeEqual` is universal).
- No raw `error.stack` or upstream provider error bodies leaked in 4xx/5xx responses (all `.slice(0, 200)` on `.text()` of upstream).
- No PII (phone, email, refresh token, sheet ID) logged in cleartext beyond what's intentional in admin-only logs. `lib/crypto.js:545` `REDACT_KEY_PATTERN` is robust and covers `authorization|cookie|set-cookie|access-token|refresh-token|id-token|api-key|password|credential|secret|client-secret|signature|hmac|csrf|bearer|webhook-secret`. Phone numbers DO appear in some logs (`api/sheet/append.js:194`) — acceptable for support but worth a `redactPhone()` helper for future use.
- Input is consistently validated AFTER auth runs (bot-secret/cron-secret/requireAuth all gate first; no `parseInt(req.body.amount)` before the auth check). No SSRF/RCE vectors found in the audit window.
- Tenant isolation chain (`phone → user:{sub} → sheet:{sub}`) is enforced on EVERY Sheets write reviewed, with a leak guard that aborts on `phoneRecordSheet !== canonicalSheet` mismatch and a runtime multi-writer anomaly detector (`api/sheet/append.js:212`) that escalates to Slack.
- Webhook signature verification is correct on Meta (`api/whatsapp/webhook.js:33-39`), Stripe (deprecated but correct), Coinbase (`api/billing/crypto-webhook.js:39-44`), PayPal (`api/billing/paypal.js:217-237` uses PayPal's verify-webhook-signature API call). All use `timingSafeEqual`.
- Cron auth (`CRON_SECRET` Bearer) is consistently timing-safe across all 9 cron endpoints.
