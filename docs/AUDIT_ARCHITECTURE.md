# Kesefle Architecture Audit

Snapshot date: 2026-05-26. Hebrew WhatsApp expense bot writing to per-tenant Google Sheets.

---

## 1. Top-level architecture

Three independent deploy surfaces, glued together by Vercel KV (Upstash Redis) and Google OAuth refresh tokens.

| # | Surface | Runtime | Deploys via | Source of truth |
|---|---------|---------|-------------|-----------------|
| 1 | Marketing + app site (`*.html`) | Static + Vercel serverless | `git push main` -> Vercel auto-deploy | `index.html`, `account.html`, `dashboard.html`, `admin.html`, etc. |
| 2 | API (`api/**.js`) | Vercel Node 20 serverless | `git push main` -> Vercel auto-deploy | `api/` tree |
| 3 | WhatsApp bot | Google Apps Script (V8 runtime) | Manual paste from `bot/ExpenseBot_DEPLOY.gs` | `bot/ExpenseBot_FIXED.gs` (canonical source) |

### How they connect

```
WhatsApp user
   |
   v
Meta WhatsApp Cloud API (webhook)
   |
   +-- For owner (legacy single-tenant): -> Apps Script doPost in ExpenseBot_FIXED.gs
   |       -> direct Sheets API call to SHEET_ID (owner's sheet only)
   |
   +-- For all other users: Apps Script doPost (still the entry point)
           -> classifies + parses in Apps Script (rich Hebrew lexicon)
           -> POST https://kesefle.com/api/sheet/append
                   with x-kesefle-bot-secret header
           -> Vercel function unwraps user's encrypted refresh token
              from KV, exchanges for access token, writes row to
              user's OWN Google Sheet
```

Meta delivers EVERY inbound message to the same Apps Script webhook URL. The Apps Script bot decides whether to write locally (owner only) or to bridge through Vercel (everyone else). The browser-facing `api/whatsapp/webhook.js` is a parallel implementation that is wired up only on Meta apps pointing webhooks directly to Vercel; the current production path is Apps-Script-first.

### Per-tenant data flow

```
WhatsApp E.164 phone (e.g. 972526003090)
   |
   v
KV: phone:{E164}  ->  { userSub, spreadsheetId? (cache), createdAt }
   |
   v userSub (Google `sub` claim)
   |
   +-> KV: user:{sub}   -> { email, name, picture, refreshTokenEnvelope (AES-256-GCM),
   |                          plan, stripeCustomerId, trial fields, ... }
   |
   +-> KV: sheet:{sub}  -> { spreadsheetId, spreadsheetUrl, provisionedAt }
            |
            v Google Sheets API (Bearer access_token from refresh exchange)
            v
       User's OWN spreadsheet (drive.file scope only -- app-created)
           tabs: תנועות (transactions), הזמנות (orders),
                 מאזן אישי (personal dash), מאזן חברה (company dash),
                 פירוט מורחב (extended), הוצאות קבוצה (group)
```

The tenant boundary is load-bearing across `lib/sheet-writer.js`, `api/sheet/append.js`, and `api/group.js`. The canonical sheet is always `sheet:{sub}`. The `phone:{E164}` record caches `spreadsheetId` for hot-path reads but `append.js` reconciles against `sheet:{sub}` on every write and refuses to write if the two disagree (`sheet_ownership_mismatch`, 409).

---

## 2. Folder map

| Folder | One-liner |
|--------|-----------|
| `api/` | Vercel serverless endpoints (Node 20). 85 files; the runtime entry points for every browser/bot HTTP call. |
| `api/_lib/` | Internal helpers shared across api/* (session cookie, KV rate-limit, global learn). NOT a public route prefix. |
| `api/admin/` | Admin-only endpoints (requireAdmin) for `admin.html` (recent signups, revenue, launch monitor, etc.). |
| `api/auth/` | Google OAuth code-exchange + logout. |
| `api/billing/` | Stripe / PayPal / Coinbase / manual bank transfer flows + webhooks. |
| `api/cron/` | Vercel-cron job handlers (kv-backup, reminders, recurring, lifecycle, budget-check, kv-monitor, steven-daily-digest). |
| `api/group/` | Splitwise-style group ledger query helpers (member-of-group). Main group logic in `api/group.js`. |
| `api/health/` | `/api/health/detailed` for deeper dependency probing (basic at `/api/health`). |
| `api/import/` | Bank CSV import endpoint. |
| `api/log/` | Telemetry sinks (bot heartbeat, funnel events, missed-inapp, user reports). |
| `api/push/` | Web Push subscribe endpoint (VAPID). |
| `api/sheet/` | Per-tenant sheet operations (append, summary, getExpenses, provision, export, mark-vat, tax-report, ...). |
| `api/whatsapp/` | Vercel-side WhatsApp webhook (alt path), outbound send, phone-link flow. |
| `bot/` | Apps Script bot source + auxiliary `.gs` patches + Node test suites that exercise the Apps Script logic in pure JS. |
| `lib/` | Shared server code used by `api/**` — auth, crypto, sheet-writer, rate-limit, billing, email, professions, categories, etc. |
| `tests/` | Top-level Node test suites (full_qa, golden_set, recurring_detect, bank-parsers, profession, bot Q4 profession). |
| `scripts/` | One-shot dev / ops utilities (rebrand sweeps, icon gen, deploy verify, preflight test, VAPID key gen, bot-number swap). |
| `docs/` | Architecture notes, runbooks, compliance checklists, launch plans. Includes subfolders `architecture/`, `compliance/`, `security/`, `oauth-verification/`, `design/`. |
| `blog/` | 20 Hebrew SEO blog posts as static HTML. |
| `.claude/` | Claude Code config: 55 project-specific skills (`skills/`), 18 specialist sub-agents (`agents/`), git/format hooks. |
| `assets/` | Static CSS asset(s). Most styling is inlined per HTML page. |
| `templates/` | Email templates (`templates/email/`) used by `lib/email.js` and the lifecycle cron. |
| `admin/` | Static admin-only diagnostic HTML pages (`monitor.html`, `diagnostics.html`, `launch-monitor.html`). |
| `emails/` | Pre-launch marketing email HTML (welcome sequence, distinct from runtime lifecycle templates in `templates/email/`). |
| `js/` | Two browser JS files (`ab-client.js`, `analytics-loader.js`) loaded by the static HTML. |

---

## 3. Top 20 most-important files

| # | Path | Purpose | Called by |
|---|------|---------|-----------|
| 1 | `bot/ExpenseBot_FIXED.gs` (14269 lines) | Canonical Apps Script bot source: doPost webhook, Hebrew classifier (`matchCategorySmart`), receipt OCR, voice transcripts, recurring commands, multi-business routing, kill-switch, daily heartbeat. | Meta WhatsApp Cloud (via Apps Script web app URL) |
| 2 | `bot/ExpenseBot_DEPLOY.gs` | The PASTE-READY copy of `_FIXED.gs` for the Apps Script editor. Reassembled from `_FIXED.gs` before each manual deploy. | Manual paste by Steven into script.google.com |
| 3 | `api/whatsapp/webhook.js` | Vercel-side webhook (alt path). HMAC verification, opt-out/STOP, idempotency, demo mode, calls into `lib/sheet-writer.js`. | Meta WhatsApp Cloud (when Meta app webhook is pointed at Vercel instead of Apps Script) |
| 4 | `api/sheet/append.js` (288 lines) | Bridge endpoint: bot POSTs parsed expense -> we unwrap encrypted refresh token, write to user's sheet, run multi-writer anomaly detector. | Apps Script bot via `x-kesefle-bot-secret` header |
| 5 | `lib/sheet-writer.js` (1210 lines) | Tenant write layer: builds tab spec (TX, orders, personal dash, company dash, extended, group), OAuth refresh exchange, `appendRowToUserSheet`, `createUserSheetWithRefresh`, `buildExpenseRow`, `sanitizeCell`. | `api/sheet/*`, `api/group.js`, `api/whatsapp/webhook.js` |
| 6 | `lib/categories.js` (163 lines) | Single source of truth for the Pa'amonim-derived Hebrew expense+income taxonomy (`EXPENSE_GROUPS`, `INCOME_GROUPS`). | `lib/sheet-writer.js` (dashboard rows), bot classifier reference, admin reports |
| 7 | `lib/auth.js` (224 lines) | Google ID token verification (RS256+JWKS cache), session-cookie auth, `requireAuth`/`requireAdmin`/`optionalAuth` middleware, `getGoogleClientId()` env guard. | Every `api/**.js` that needs identity |
| 8 | `lib/crypto.js` | AES-256-GCM envelope encryption for refresh tokens, HMAC-SHA256 cookie signing, KEK rotation by kid, `constantTimeEqual`. | `lib/auth.js`, `api/sheet/append.js`, `api/auth/google-exchange.js`, every bot-secret check |
| 9 | `lib/ratelimit.js` | KV-INCR token-bucket rate limit. Fails open on KV outage. `withRateLimit`, `rateLimit`, `rateLimitId`. | Most `api/**.js` handlers |
| 10 | `lib/log.js` | Structured JSON logger with PII redaction (regex allow-list); `withRequestId` injects a `reqId` per request. | Every `api/**.js` handler |
| 11 | `lib/middleware.js` | Re-exports + `compose()` helper to chain `withRequestId / withSecurityHeaders / withRateLimit / requireAuth`. | Newer endpoints |
| 12 | `lib/billing.js` + `lib/subscription.js` | Plan / trial / entitlement logic; provider-agnostic (Stripe, PayPal, Coinbase Commerce, manual). | `api/billing/*` |
| 13 | `lib/invoice.js` | Green Invoice integration (חשבונית מס/קבלה doc type 400) for Israeli legal-compliant tax receipts. | `api/billing/invoice.js` |
| 14 | `lib/email.js` + `templates/email/*` | Resend-backed email + 9 lifecycle templates (welcome, day_1, day_3, day_7, day_14, day_30, inactivity_7_days, monthly-insights, weekly-digest, winback). | `api/cron/lifecycle.js`, `api/billing/*`, `api/whatsapp/link.js` |
| 15 | `api/auth/google-exchange.js` | PKCE code-for-token exchange; encrypts the refresh_token and writes `user:{sub}`, `sheet:{sub}` (if exists), `token:{sub}`, sets HS256 session cookie. | `account.html` after OAuth redirect |
| 16 | `api/sheet/provision.js` | Creates a fresh per-tenant Google Sheet (drive.file scope) and writes `sheet:{sub}` mapping. `forceNew=true` archives the old sheet and provisions a new one. | `account.html` post-signup, `dashboard.html` reprovision button |
| 17 | `api/whatsapp/link.js` | 3-step phone-link flow: generate 6-digit code in KV, bot confirms with code, server permanently maps `phone:{E164}` -> userSub, sends welcome WhatsApp. | `account.html`, bot's "קוד 482917" handler |
| 18 | `api/group.js` (685 lines) | Splitwise-style virtual ledger (`group:<code>` + `memberGroup:<phone>`); 13 actions including addExpense/balances/undo/setActive. Best-effort writes a copy of each group expense to the creator's sheet. | Apps Script bot via bot-secret header |
| 19 | `api/learn.js` | Cross-user anonymous category KB: bot POSTs a SHA-256 of normalized description + correction; everyone else's next match on the same hash short-circuits the LLM. Privacy-safe (raw text never leaves the bot). | Apps Script bot after any user correction |
| 20 | `vercel.json` | Routing config: 43 redirects (legacy URLs collapsed), CSP + HSTS + frame-ancestors headers, 7 cron schedules. | Vercel build |

Honorable mentions: `api/account.js` (delete + export, 346 lines, GDPR Art. 17/20), `api/admin.js` (consolidated admin router, 580 lines), `api/recurring.js` (recurring-expense templates + auto-log cron, 449 lines), `bot/personal_sheet_fix.gs` (broken-formula detector / `RECOMPUTE_COMPANY_DASHBOARD`).

---

## 4. Data flow diagrams

### 4a. User signup flow

```
Browser at /account
   |
   |  1. Click "התחבר עם Google"
   v
account.html: GIS PKCE auth
   - generates code_verifier + code_challenge
   - redirect -> accounts.google.com (scope: openid email profile drive.file,
                 access_type=offline, prompt=consent)
   |
   v (Google redirects back with ?code=...)
account.html POST /api/auth/google-exchange { code, codeVerifier, redirectUri }
   |
   v
api/auth/google-exchange.js
   - exchanges code with Google -> { id_token, access_token, refresh_token }
   - verifyGoogleIdToken(id_token, GOOGLE_CLIENT_ID)
   - encryptRefreshToken(refresh_token)  via AES-256-GCM (lib/crypto.js)
   - kvGetUser(sub) -> MERGE plan/trial/stripe fields (never clobber)
   - kvSet user:{sub}    -> { email, name, picture, refreshTokenEnvelope, plan, ... }
   - kvSet token:{sub}   -> { encrypted_envelope, updatedAt }
   - setSessionCookie(sub) (HS256, HttpOnly, Secure, 30d)
   - returns { idToken, accessToken } to browser (refresh token NEVER leaves server)
   |
   v
account.html POST /api/sheet/provision { accessToken }
   |
   v
api/sheet/provision.js
   - verifyAccessToken(accessToken) via tokeninfo (must include drive.file scope)
   - createUserSheetWithToken() -> CREATES (not copies) a fresh spreadsheet
       tabs: תנועות, הזמנות, מאזן אישי, מאזן חברה, פירוט מורחב
   - kvSet sheet:{sub} -> { spreadsheetId, spreadsheetUrl, provisionedAt }
   - returns spreadsheetUrl
   |
   v
account.html: phone-link UI
   - user enters E.164 phone
   - POST /api/whatsapp/link { accessToken, phone } -> returns 6-digit code
   - user opens WhatsApp, sends "קוד 482917" to bot number
   - bot recognizes pattern, calls back POST /api/whatsapp/link?action=confirm
   - server kvSet phone:{E164} -> { userSub, spreadsheetId, createdAt }
   - server sends WhatsApp welcome with sheet URL
```

### 4b. Expense write flow

```
WhatsApp user types: "245 סופר רמי לוי"
   |
   v
Meta WhatsApp Cloud
   |
   v
Apps Script doPost (bot/ExpenseBot_FIXED.gs) -- THE entry point for prod
   - HMAC-style verification + dedup (idempotency by message id in KV-like Apps Script properties)
   - bot-loop defense (_BOT_ECHO_REGEXES_), opt-out gate, reply-cap, blacklist
   - parser extracts amount + description
   - matchCategorySmart(description) -> ranks against CATEGORY_MAP (~2000 keywords),
     consults global_learn via GET /api/learn?h=SHA256(normalized) for instant cross-user matches,
     falls back to _geminiGenerate_ (Gemini 2.0 Flash) for ambiguous Hebrew
   |
   +-- If sender == OWNER_PHONE -> direct Sheets append to SHEET_ID (single-tenant fast path)
   |
   +-- Otherwise -> POST https://kesefle.com/api/sheet/append
                    headers: x-kesefle-bot-secret: ${KESEFLE_BOT_SECRET}
                    body: { phone, amount, category, subcategory, rawText, vatDeductible? }
            |
            v
       api/sheet/append.js
           - constantTimeEqual bot secret check
           - rateLimitId(phone, 40/min)
           - kvGet phone:{E164} -> { userSub }
           - kvGet sheet:{userSub} -> { spreadsheetId } (CANONICAL)
           - kvGet user:{userSub}  -> { refreshTokenEnvelope }
           - reject if canonicalSheet != phoneCached (sheet_ownership_mismatch)
           - self-heal stale phone-record cache
           - buildExpenseRow({ amount, category, subcategory, rawText, vatDeductible })
           - appendRowToUserSheet:
                decryptRefreshToken(envelope)
                exchangeRefreshForAccess(refresh_token) -> access_token
                Sheets API: append row to 'תנועות' tab (cols A-I)
           - multi-writer anomaly detector (KV `sheetwriters:{spreadsheetId}` + in-memory LRU cache,
             alerts if >1 distinct userSub writes to same sheet)
           - returns rowIndex
   |
   v
Apps Script sends Hebrew confirmation to user via WhatsApp Cloud API
```

The bot is the rich Hebrew parser; Vercel is the secure tenant-write layer. The bot never sees encrypted refresh tokens, never holds Google credentials, never decrypts anything.

### 4c. Admin lookup flow

```
Steven opens https://kesefle.com/admin (admin.html)
   |
   v
Browser: GET /api/me  (session cookie auth)
   - confirms logged-in user, hydrates email/name
   - admin.html JS checks email matches ADMIN_EMAILS env (or DEFAULT_ADMIN_EMAILS in lib/auth.js)
   |
   v
admin.html JS fan-out (with session cookie):
   GET /api/admin?action=metrics       -> recent funnel + counts
   GET /api/admin?action=users&q=...   -> KV SCAN over user:* keys, filter, paginate
   GET /api/admin/recent-signups       -> recent user:* records, 30d
   GET /api/admin/revenue              -> aggregate from billing webhooks log
   GET /api/admin/launch-monitor       -> recent funnel events + bot heartbeats
   GET /api/admin/sheets-quota         -> sheet API call counter (lib/sheet-quota.js)
   GET /api/admin/bot-version          -> last bot heartbeat (KFL_BUILD_VERSION)
   GET /api/admin/config-drift         -> compare hardcoded vs env (bot number, etc.)
   GET /api/admin/help-queries         -> recent unclassified bot questions
   GET /api/admin/user-timeline?sub=   -> aggregated per-user event log
   |
   v
Each endpoint:
   - requireAdmin (lib/auth.js) -> requireAuth + email-in-allowlist
   - withRateLimit
   - KV SCAN/GET via Upstash REST
   - returns JSON
```

### 4d. Cron flow

```
Vercel Cron Scheduler (vercel.json)
   |
   |  Hits paths with Authorization: Bearer ${CRON_SECRET}
   |
   +-- 0 3 * * *   -> /api/cron/kv-backup           (full KV snapshot to ADMIN_BACKUP_USER_SUB sheet)
   +-- 0 6 * * *   -> /api/cron/reminders           (overdue tasks, end-of-day nudges)
   +-- 5 6 * * *   -> /api/cron/recurring           (proxies to /api/recurring action=cron)
   +-- 0 7 * * *   -> /api/cron/lifecycle           (day_1/day_3/day_7/day_14/day_30/inactivity emails)
   +-- 0 8 * * *   -> /api/cron/budget-check        (per-user budget thresholds, WhatsApp alert)
   +-- 0 * * * *   -> /api/cron/kv-monitor          (hourly KV ops counter vs KV_DAILY_LIMIT)
   +-- 0 6 * * *   -> /api/cron/steven-daily-digest (daily admin email to Steven)
   |
   v Each handler:
       - verifyCronAuth (constant-time check on CRON_SECRET)
       - KV SCAN over relevant key prefix (user:*, recurring:*, ...)
       - For each match: write idempotency key (e.g. email_sent:{sub}:{tpl}, TTL 45d)
       - Side effect: send email (Resend), WhatsApp message (Meta), Sheets append
       - log structured event
```

---

## 5. Failure points (ranked by severity)

| # | Failure | Severity | Why it silently breaks | Today's posture |
|---|---------|----------|------------------------|-----------------|
| 1 | Apps Script bot deploy stale (`KFL_BUILD_VERSION` in editor != `_FIXED.gs`) | CRITICAL | Pasted version drifts from repo source — fixes shipped to git never reach users. Heartbeat reports the OLD version with no alarm. | Mitigated: `bot/personal_sheet_fix.gs` + `api/admin/bot-version.js` expose live version; `bot-deploy-paste` + `bot-version-bump` skills enforce the workflow. Still manual. |
| 2 | KV unavailable -> webhook returns 503 | CRITICAL | Meta retries failed webhook deliveries up to 7 days and can DISABLE the webhook subscription after sustained failures. `api/whatsapp/webhook.js` wraps every KV call in try/catch returning null, but `api/sheet/append.js` returns 502 on KV miss for the bot bridge. | Partial: webhook fails open; append.js fails closed. Need a queue/retry layer for append failures. |
| 3 | Google Sheets formula drift | HIGH | The dashboards use hard-coded row ranges in SUMIFS. Adding/removing a row in `PERSONAL_*_ROWS` constants in `lib/sheet-writer.js` silently breaks every NEW user's section totals (existing sheets are unaffected). Today's bug: 2023/2024/2025 dashboard net-profit computed as revenue minus everything instead of revenue minus raw materials. | Detector exists: `bot/personal_sheet_fix.gs` `_isBrokenDashFormula_` + `RECOMPUTE_COMPANY_DASHBOARD`; `sheet-spec-modify` + `sheet-broken-formula` skills warn about the trap. No automated guard in CI. |
| 4 | OAuth refresh-token expiry without renewal | HIGH | If a user revokes the Kesefle Google app, the refresh token becomes invalid; `exchangeRefreshForAccess` throws 400 on every bot write to that user. The bot has no path to re-prompt the user from WhatsApp. | Mitigated: `api/sheet/append.js` returns `reauth_required` (409) and `lib/error-alert.js` alerts the owner. No user-facing recovery flow yet. |
| 5 | WhatsApp Cloud webhook signature mismatch | HIGH | If `META_APP_SECRET` ever drifts from the value configured in the Meta app, all webhooks fail HMAC. Current code fails CLOSED with 503 on missing secret and 401 on bad signature — Meta will eventually disable the webhook. | Mitigated: explicit fail-closed; structured `wa.webhook.app_secret_missing` log; `/api/health/detailed` reports presence. |
| 6 | LLM cost overrun (no per-user cap) | MEDIUM | The bot calls Anthropic claude-haiku-4-5 (receipt OCR + ambiguity) and Google Gemini (conversational coach + voice). No per-user budget cap; a single user spamming photos could blow the Anthropic monthly budget. | Partial: bot has reply-cap and bot-loop defense, but no token/cost accounting per phone. Should add cost-by-userSub to KV and trip a soft cap. |
| 7 | Race condition on sheet provisioning | MEDIUM | Two parallel `/api/sheet/provision` calls for the same userSub (e.g. browser double-click) can create TWO sheets. KV is fire-and-last-wins so the second call's `sheet:{sub}` overwrites; the orphan sheet stays in Drive and is invisible to the user. | Partial: `forceNew=true` is opt-in. No lock around the read-modify-write of `sheet:{sub}`. Real-world incidence appears low (Steven hasn't reported it). |
| 8 | Family/group split bugs (LEGACY, deprecated) | LOW | Old `/family`, `/group`, `/split`, `/splitwise` URLs are 301-redirected to `/` in `vercel.json`. `api/group.js` still implements the Splitwise-style ledger but the entry-point UI is gone. The replacement is the "household" pattern (multi-business owner routing via `sheet-multi-business` skill). | Mitigated: no UI surface, but `api/group.js` (685 lines) is still on disk and reachable via bot commands — eligible for removal. |

Additional silent failure modes worth noting:
- **`OWNER_PHONE` constant in `bot/ExpenseBot_FIXED.gs` is a fallback** for the `SHEET_OWNER_PHONE` Script Property. If someone clones the bot for a new Apps Script project without setting that property and forgets to change `OWNER_PHONE`, every sender gets routed to the original owner's sheet (the original cross-tenant leak class).
- **Idempotency keys live in different stores**: `seen:wa:{messageId}` in KV (24h TTL) for the Vercel webhook, but Apps Script uses `PropertiesService` (no TTL) on the bot side. A KV/Apps-Script split-brain is theoretically possible during a deploy transition.
- **`global_learn` has no consensus rule**: the latest correction for a SHA-256 hash wins. A bad actor who learns the hashing scheme could poison the global KB.

---

## 6. Tech stack inventory

| Layer | Tech | Notes |
|-------|------|-------|
| Static site + serverless | **Vercel** | Node.js 20 runtime (`api/**.js`). No edge functions. Hobby tier 12-function limit is why several endpoints (`api/admin.js`, `api/account.js`) consolidate actions behind `?action=`. Auto-deploys on `git push main`. |
| Key-value store | **Upstash KV (Redis REST)** | Free tier 10k commands/day. `api/sheet/append.js` has an in-memory LRU + cache to cut the `sheetwriters:*` write from ~1.5 ops/write to ~0.1 ops/write so 1000 active users fit in the free tier. `api/cron/kv-monitor.js` hourly counter vs `KV_DAILY_LIMIT`. |
| Identity | **Google OAuth 2.0 (PKCE)** | `openid email profile https://www.googleapis.com/auth/drive.file`. `access_type=offline&prompt=consent` to force a refresh_token on every login. ID token verified via JWKS RS256 in `lib/auth.js`. |
| Per-tenant storage | **Google Sheets API v4** + **Drive API (drive.file scope)** | App-created sheets only, no `drive.readonly`. Lets us publish without a Google CASA security assessment. `lib/sheet-quota.js` tracks per-minute call count. |
| LLM — receipt OCR + ambiguity | **Anthropic Claude `claude-haiku-4-5-20251001`** | Direct API call from Apps Script (`api.anthropic.com/v1/messages`). Used for: receipt photo OCR, ambiguous expense classification, post-OCR Hebrew summarisation. |
| LLM — conversational + voice | **Google Gemini (2.0/1.5/2.5 Flash)** | Apps Script `_geminiGenerate_` fans out across model names for resilience. Used for: coaching replies to user questions, voice-transcript fallback (uses Apps Script media APIs for the audio decoding). |
| WhatsApp messaging | **Meta WhatsApp Cloud API** | Currently `v19.0` in `api/whatsapp/webhook.js` and `v21.0` in `api/whatsapp/link.js`. The live bot uses Meta TEST number `+15556408123` (Phone Number ID `1086749664527399`, WABA `986476207210292`); production WABA migration is in `docs/WABA_SETUP_STEP_BY_STEP.md`. |
| Transactional email | **Resend** | `lib/email.js`. Templates in `templates/email/*.html`. Pre-launch sequences in `emails/*.html` (separate, marketing-only). |
| Card billing | **Stripe** (subscription, webhook) | `api/billing/webhook.js`, `api/billing/checkout.js`. Plans encoded in env (`STRIPE_*`). |
| Wallet billing | **PayPal Subscriptions** | `api/billing/paypal.js`. Plan ids: `PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_PRO_YEAR`, `PAYPAL_PLAN_FAMILY`, `PAYPAL_PLAN_FAMILY_YEAR`. `PAYPAL_ENV` toggles sandbox/prod. |
| Crypto billing | **Coinbase Commerce** | `api/billing/crypto-create.js`, `api/billing/crypto-webhook.js`. HMAC webhook verify against `COINBASE_WEBHOOK_SECRET`. |
| Manual billing (Israeli) | **Bit / bank transfer** | `api/billing/manual.js`. Pay-then-confirm flow. `BIT_PAYEE_PHONE`, `BANK_TRANSFER_DETAILS` env vars surface the recipient info. |
| Tax-compliant invoicing | **Green Invoice (greeninvoice.co.il)** | `lib/invoice.js`. Issues doc type 400 (חשבונית מס / קבלה). JWT cached ~25 min. Sandbox via `GREEN_INVOICE_ENV=test`. |
| Web Push | **VAPID** (raw `node:crypto`) | `lib/push.js`, `api/push/subscribe.js`. Keys generated by `scripts/gen-vapid-keys.mjs`. |
| Analytics | **GA4 + Meta Pixel + TikTok Pixel** | All loaded by `js/analytics-loader.js` gated on consent. CSP `connect-src` allow-listed in `vercel.json`. |
| Service Worker / PWA | Hand-rolled `sw.js` (no Workbox) | `manifest.webmanifest`. Cache-busting handled by `service-worker-bust` skill. |
| Observability | Structured logs (`lib/log.js`) + `lib/alert.js` (Slack webhook + admin email) | No Sentry yet; Slack webhook URL in `SLACK_ALERT_WEBHOOK_URL`. `lib/error-alert.js` 1-hour dedupe on alert title. |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Single workflow file; runs the Node test suite under `tests/` + `bot/test_*.js`. |
| Crypto primitives | `node:crypto` only (no npm) | AES-256-GCM envelope, HMAC-SHA256 (constant-time), RSA-SHA256 (Google JWKS). Ono College network blocks npm — the project is vendored. |

Env vars referenced across `api/` + `lib/` (count: 65): `ADMIN_BACKUP_USER_SUB`, `ADMIN_EMAILS`, `ADMIN_PUSH_USER_SUBS`, `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `BANK_TRANSFER_DETAILS`, `BIT_PAYEE_PHONE`, `COINBASE_COMMERCE_API_KEY`, `COINBASE_WEBHOOK_SECRET`, `CRON_SECRET`, `EMAIL_FROM`, `GA*`, `GITHUB_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GREEN_INVOICE_ENV/KEY/SECRET`, `GROUP_SHEET_TEMPLATE_ID`, `KESEFLE_BOT_NAME/NUMBER/SECRET`, `KESEFLE_CRON_SECRET`, `KESEFLE_CRYPTO_SELFTEST`, `KESEFLE_DB_KEY/_ACTIVE_KID`, `KESEFLE_OWNER_PHONE`, `KESEFLE_TEMPLATE_SHEET_ID`, `KV_DAILY_LIMIT`, `KV_REST_API_TOKEN/URL`, `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_PHONE_NUMBER_ID`, `META_PIXEL_ID`, `META_VERIFY_TOKEN`, `NODE_ENV`, `PAYPAL_CLIENT_ID/SECRET/ENV/PLAN_*`, `PAYPAL_WEBHOOK_ID`, `PRO_PLAN_MONTHLY_USD`, `PUBLIC_SITE_URL`, `RESEND_API_KEY`, `SELF_URL`, `SESSION_SECRET`, `SLACK_ALERT_WEBHOOK_URL`, `STRIPE_*`, `TIKTOK_PIXEL_ID`, `VAPID_*`, `VERCEL_GIT_COMMIT_DATE/SHA`, `VERCEL_REGION`, `WABA_APPROVED`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`.

---

## 7. Quick stats

| Metric | Value | How counted |
|--------|-------|-------------|
| LOC, JavaScript (api + lib + tests + scripts + js) | **25,524** | `find . -name '*.js'` excluding `kesefle_export*` and `.git` |
| LOC, Apps Script `.gs` (bot) | **35,728** | `find . -name '*.gs'` |
| LOC, HTML (top-level + blog/) | **33,403** | `find . -maxdepth 2 -name '*.html'` |
| LOC, Markdown docs | **13,694** | `find . -name '*.md'` excluding `.claude/skills/` |
| API endpoints (Vercel serverless `.js` files under `api/`) | **85** | `find api -name '*.js' \| wc -l` |
| Top-level (non-subfolder) API endpoints | **20** | direct children of `api/` |
| Cron jobs scheduled in `vercel.json` | **7** | `crons` block |
| Vercel redirects | **43** | `redirects` block in `vercel.json` |
| HTML pages (top-level public site) | **40** | `find . -maxdepth 1 -name '*.html'` |
| Blog posts (Hebrew SEO) | **20** | `find blog -name '*.html'` |
| Email templates (runtime lifecycle) | **9** | `templates/email/*.html` (excludes `_partials`) |
| Email templates (pre-launch marketing) | **5** | `emails/*.html` |
| Test suites — top-level `tests/` | **6** | `tests/*.js` |
| Test suites — bot Node-side | **5** | `bot/test_*.js` |
| Auxiliary bot `.gs` patch files | **36+** | `bot/*.gs` excluding `.bak.*` |
| Project Claude skills | **55** | `.claude/skills/` (excludes Anthropic-shipped) |
| Project Claude specialist sub-agents | **18** | `.claude/agents/*.md` |
| Project Claude git/format hooks | **3** | `.claude/hooks/*.sh` |
| Distinct env vars referenced | **65** | grep of `process.env.*` in `api/` + `lib/` |
| Total tracked LOC (JS + GS + HTML + MD) | **~108k** | sum of the four above |

KV key prefixes in active use (by code reading): `phone:{E164}`, `user:{sub}`, `sheet:{sub}`, `token:{sub}`, `optout:{phone}`, `last_inbound:{phone}`, `seen:wa:{messageId}`, `sheetwriters:{spreadsheetId}`, `sheet_anomaly:{ts}`, `global_learn:{sha256}`, `group:{code}`, `memberGroup:{phone}`, `recurring:{phone}`, `recurring_logged:{phone}:{id}:{date}`, `email_sent:{sub}:{template}`, `profile:{phone}`, `errors:24h`, `_health_probe`.

---

## End of audit
