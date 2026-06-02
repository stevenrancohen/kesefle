# Kesefle System Overview

> Orient a new contributor in ~10 minutes. Hebrew product (כספ'לה), live at
> **https://kesefle.com**. This is the map; the deep-dives live under `docs/`
> (see [Where to read next](#11-where-to-read-next)).

Snapshot: 2026-06-02. Bot build `2026-06-02-taxonomy-normalize`.

---

## 1. What Kesefle is (one paragraph)

A Hebrew WhatsApp bot that turns a free-text message like `50 קפה` or a receipt
photo into a categorized row in **the user's own Google Sheet** (created via the
`drive.file` OAuth scope, so we only ever touch files we made). A static
marketing + account website on Vercel handles signup, OAuth, billing, and a
read-only dashboard. There is **no bank connection** and the product is
cash-friendly by design. Each user's money lives in their own Drive; we store
only pointers + an encrypted refresh token in Vercel KV (Upstash Redis).

---

## 2. Three deploy surfaces

Three independently-deployed pieces, glued by **Vercel KV** and **Google OAuth
refresh tokens**:

| # | Surface | Runtime | Source of truth | Deploys via |
|---|---------|---------|-----------------|-------------|
| 1 | Website (`*.html`, `js/`, `css/`, PWA) | Static on Vercel | the `.html` files at repo root | `git push main` → Vercel auto-deploy |
| 2 | API (`api/**.js`) | Vercel Node 20 serverless | the `api/` tree | `git push main` → Vercel auto-deploy |
| 3 | WhatsApp bot | Google Apps Script (V8) | `bot/ExpenseBot_FIXED.gs` | **manual paste** of `bot/ExpenseBot_DEPLOY.gs` |

The website and API ship automatically the moment a PR merges to `main`. The bot
does **not** — it is a manual Apps Script paste + "Deploy → New version" (see
[Deploy](#9-deploy-steps)). That asymmetry is the single most common source of
"why is prod behaving like old code?" confusion.

A separate **standalone Apps Script tools project** (`bot/KESEFLE_SHEET_TOOLS.gs`,
`bot/MAAZAN_SRC_TOOLS.gs`, the `MIGRATE_*`/`FIX_*` files) is `openById`-based and
must **not** be pasted into the bot project — doing so duplicates functions and
breaks the bot's compile. It is run ad-hoc against Steven's sheet for one-shot
migrations, always DRY_RUN → APPLY behind a `CONFIRM_*` gate.

---

## 3. End-to-end data flow

```
WhatsApp user
   │  sends "50 קפה" / receipt photo / voice note
   ▼
Meta WhatsApp Cloud API  ──webhook──►  Apps Script doPost   (bot/ExpenseBot_FIXED.gs)
                                          │  parse amount + classify category (3 tiers, see §5)
                                          │
              ┌───────────────────────────┴───────────────────────────┐
              │ Path A: sender IS the owner (Steven)                   │ Path B: any other phone
              ▼                                                        ▼
   direct Sheets API write to SHEET_ID                    POST https://kesefle.com/api/sheet/append
   (owner's master sheet only)                            header: x-kesefle-bot-secret
                                                          │
                                                          ▼
                                          Vercel function api/sheet/append.js
                                            • KV phone:{E164} → user:{sub} → sheet:{sub}
                                            • decrypt user's refresh token (AES-256-GCM)
                                            • mint short-lived Google access token
                                            • append row to THAT user's own Sheet
```

Meta delivers **every** inbound message to the same Apps Script webhook URL. The
bot decides per-message whether to write locally (owner) or bridge through Vercel
(everyone else). `api/whatsapp/webhook.js` is a parallel Vercel-native webhook
implementation kept canonical-correct, but the **production path is
Apps-Script-first**.

The browser dashboard (`/dashboard`) is read-only: it calls
`GET /api/sheet/summary` (Bearer/session auth) which reads the signed-in user's
own sheet. Corrections/edits made on the website go through
`api/sheet/web-append.js`, `relabel-row.js`, `delete-rows.js`, etc.

The **#1 invariant**: *no phone can ever cause a write to a sheet that does not
belong to that phone's owner.* Full model in
[`docs/TENANT_ISOLATION_MODEL.md`](docs/TENANT_ISOLATION_MODEL.md).
`api/sheet/append.js` even raises a multi-writer alarm if one spreadsheet
receives writes from more than one `userSub` in an hour.

---

## 4. The tenant Google Sheet template

Every new user gets a sheet provisioned by `lib/sheet-writer.js`
(`buildTenantSheetSpec`). Tabs (Hebrew names are load-bearing — formulas and the
bot reference them by exact string):

| Tab | Const | Role |
|-----|-------|------|
| `מאזן אישי` | `PERSONAL_DASHBOARD_TAB` | Personal dashboard the user opens first (income/expense by category, SUMIFS over `תנועות`) |
| `תנועות` | `TX_TAB` | **Raw transaction log** — every bot expense write lands here |
| `הזמנות` | `ORDERS_TAB` | **Orders / business revenue log** (separate source tab — revenue lives here, NOT in `תנועות`) |
| `מאזן חברה` | `COMPANY_DASHBOARD_TAB` | Company dashboard: revenue from `הזמנות`, COGS + opex from `תנועות` (`col D = "עסק"`) |
| `פירוט מורחב` | `EXTENDED_DASHBOARD_TAB` | Full per-subcategory breakdown + pie chart |
| `הוצאות קבוצה` | `GROUP_LEDGER_TAB` | Shared/group-split ledger (group feature) |

**Transaction columns (`תנועות`, A→I):**
`['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'סטטוס', 'ניכוי מע״מ']`
i.e. `[ISO date, "YYYY-MM", amount, category, subcategory, raw text, source, status, VAT-deduct]`.

**Two source tabs, not one** — the most important and most-broken fact about the
template: **`הזמנות` is revenue + per-order detail; `תנועות` is the bot's expense
writes.** A formula repair that points company revenue at `תנועות` will zero out
historical revenue (this caused a real incident — see PROGRESS_DIGEST, the PR #114
post-mortem).

**Year selector** — every dashboard tab has a year cell (`$B$4`, personal uses
`$B$2`). All SUMIFS criteria reference that cell; **no formula hardcodes a year**.
Switching the cell sweeps the whole dashboard between years. Guarded by
`bot/VALIDATE_NO_HARDCODED_YEAR.js` +
[`docs/SHEET_YEAR_SELECTOR_PLAN.md`](docs/SHEET_YEAR_SELECTOR_PLAN.md).

Dashboard total rows find their constituent rows by **walking column-A labels**,
not hardcoded row numbers (template drift / inserted rows would otherwise break
sums). Renaming a category in column A auto-rebinds because formulas use
`$A{row}` references.

---

## 5. The bot's brain (3-tier classification)

When the bot sees `245 wolt דאלי`, it tries three sources in order; the first
confident answer wins (full write-up in
[`BOT_AI_ARCHITECTURE.md`](BOT_AI_ARCHITECTURE.md)):

1. **Learned cache** (`מילון לימוד` tab + cross-user `global_learn:{hash}` in KV) —
   free, ~50ms. Substring match, longest wins. Every confirmed correction is
   saved here so the same vendor never costs an API call again. Cross-user
   learning shares only one-way **SHA-256 hashes**, never raw text.
2. **Keyword map** (`CATEGORY_MAP` constant, thousands of Israeli vendor keywords
   across ~30+ category/subcategory groups) — free, ~5ms.
3. **LLM fallback** (Claude Haiku via `ANTHROPIC_API_KEY`) — only when tiers 1–2
   return "I don't know". ~$0.0001/call, ~800ms. **Optional**: if the key is
   missing or the API is down, the bot degrades gracefully to a default category;
   it never blocks on AI.

A **never-silently-corrupt / never-silently-write** contract sits over all of
this: ambiguous expenses surface an interactive category picker rather than
guessing, and the bot will not write a row it can't justify. Golden-set accuracy
is regression-gated (`tests/golden_set.js`, ~95% floor).

Bot routing is instrumented with **KFL-TRACE** breadcrumbs — every routing branch
logs one line so a "why did my message go to the wrong category?" report can be
replayed (see the `kesefle-bot-replay` / `kesefle-bot-decision-trace` skills).

---

## 6. The API surface (`api/`)

~90 Vercel serverless functions (the Hobby 12-function ceiling was lifted; many
are consolidated routers using `?action=`). Grouped by area:

| Group | Examples | Auth |
|-------|----------|------|
| **Auth** | `auth/google.js`, `auth/google-exchange.js`, `auth/logout.js` | public + PKCE + Google ID-token verify |
| **Sheet (tenant writes/reads)** | `sheet/append.js` (bot write), `sheet/summary.js`, `sheet/web-append.js`, `sheet/provision.js`, `sheet/relabel-row.js`, `sheet/delete-rows.js`, `sheet/export.js`, `sheet/tax-report.js`, `sheet/csv-import.js` | bot-secret (append) / session (web) |
| **WhatsApp** | `whatsapp/webhook.js` (Meta-native, HMAC), `whatsapp/link.js` (phone↔account), `whatsapp/send.js` | Meta signature / bot-secret |
| **Billing** | `billing/checkout.js`, `billing/webhook.js` (Stripe), `billing/paypal.js`, `billing/crypto-*.js`, `billing/winback-claim.js` | webhook signatures |
| **Account / GDPR** | `account.js` (delete + export), `me.js`, `profile.js` | session |
| **Growth / product** | `events.js` (waitlist/track/nps), `referral.js`, `recurring.js`, `goals/*`, `objectives/*`, `budgets.js`, `custom-categories.js`, `group*` | mixed |
| **Admin** | `admin.js` + `admin/*` (`stats`, `launch-monitor`, `funnel-summary`, `recent-signups`, `bot-version`, `config-drift`, `user-reports`, `revenue`, `sheets-quota`, …) | `requireAdmin` (ID token + `ADMIN_EMAILS`) + rate limit |
| **Logging (ingest)** | `log/bot-heartbeat.js`, `log/funnel-event.js`, `log/user-report.js`, `log/missed-inapp.js` | bot-secret / public-ish |
| **Health / cron** | `health.js`, `health/detailed.js`, `cron/*` (see §8) | public probe / `CRON_SECRET` |

Shared helpers live in **`lib/`** (the only place that should talk to KV or do
crypto):

- `lib/secure-kv.js` — **the only module that talks to KV directly.** Field
  allow-list (anti mass-assignment), AES-256-GCM envelope encryption of tokens
  (AAD-bound to `userSub`), `markSeenOnce()` idempotency, masked logging.
- `lib/crypto.js` — AES-256-GCM keyring + RS256 Google ID-token verify (JWKS).
- `lib/auth.js` — `requireAuth` / `optionalAuth` / `requireAdmin` /
  `verifyGoogleIdToken`.
- `lib/oauth.js` — `exchangeRefreshForAccess` (refresh-token → short-lived access
  token).
- `lib/sheet-writer.js` — tenant sheet template + `appendRowToUserSheet`.
- `lib/ratelimit.js` — KV token-bucket (`withRateLimit`, IPv6 /64 grouping).
- `lib/log.js` — structured logging with auto-redaction of token/secret/password.
- `lib/middleware.js` — `compose()` + security-header / validation wrappers.
- Domain libs: `billing.js`, `subscription.js`, `categories.js`, `goals.js`,
  `objectives.js`, `professions.js`, `bank-parsers.js`, `push.js`, `email.js`,
  `invoice.js`, `analytics.js`, `alert.js`, `ab.js`.

---

## 7. KV (Upstash Redis) key map

`secure-kv.js` is the source of truth for the canonical records; the rest are
feature-owned keys observed across `api/` + `bot/`. All keys are flat strings;
sensitive fields inside `user:*` are encrypted.

**Canonical identity / write path** (documented in `lib/secure-kv.js` header):

| Key | Holds |
|-----|-------|
| `user:<sub>` | JSON user record — identity, plan, **encrypted** refresh/access tokens |
| `sheet:<sub>` | user's sheet pointer (id + url), not encrypted (their own file) |
| `phone:<E.164>` | `{ userSub }` pointer — the webhook's phone→user lookup (may cache `spreadsheetId`) |
| `optout:<phone>` | STOP/`עצור` opt-out record |
| `last_inbound:<phone>` | last-inbound timestamp (24h WhatsApp window tracking) |
| `seen:<scope>:<id>` | `"1"` + TTL — idempotency (WhatsApp message id, Stripe event id) |
| `audit:<action>:<ts>:<sub8>` | append-only audit entries (long TTL) |
| `rl:<key>:<window>` / `rate:*` | rate-limit counters |

**Feature-owned keys** (prefix → owner):

- Billing/events: `stripe_event:*`, `paypal_event:*`, `crypto_event:*`,
  `charge:*`, `payment_failed:*`, `plan_change:*`, `billing:*`, `invoice:*`
- Growth: `waitlist:*`, `referral:*`, `winback:*`, `nps:*`, `testimonial:*`,
  `funnel:*`, `retention:*`, `email_sent:*`, `announcement:*`,
  `user_seen_announcement:*`, `hero_cta:*`, `ab:*`
- Product state: `recurring_*` (logged/pending/reminded), `usr_budget:*`,
  `budget_alerted:*`, `custom_categories:*`, `profile:*`, `push_sub:*`,
  `goals` / `objectives` (per-user), `biz:o*` (orders), `exit_survey:*`
- Learning: `global_learn:<hash>` (cross-user category learning, hash-only)
- Ops/admin: `bot_version_latest` (bot heartbeat), `kv_usage:*`, `job:*`,
  `write_log:*`, `sheetwriters:*` (multi-writer detector), `abuse_log:*`,
  `help_queries:*`, `customer_digest:*`, `rotate_lock:*`
- Migration: per-user onboarding flags (`welcomed` / `surveyed` / `fxcel` /
  `leadNotified`) were moved from Apps Script Script-Properties **into KV**
  (PR #186/#187, run `MIGRATE_BOT_STATE_TO_KV` once); gender/need/settings keys
  are a pending follow-up.

If KV creds are absent the wrappers fail closed / degrade — they never write
plaintext tokens.

---

## 8. Cron jobs (`vercel.json` `crons` → `api/cron/*`)

All times UTC (Israel is UTC+2/+3). Each handler authorizes with
`Authorization: Bearer ${CRON_SECRET}`.

| Schedule (UTC) | Path | Does |
|----------------|------|------|
| `0 3 * * *` | `cron/kv-backup` | nightly KV snapshot/backup |
| `0 * * * *` | `cron/kv-monitor` | hourly KV-usage watchdog (warns near the free-tier ceiling) |
| `0 4 * * *` | `cron/morning-nudge` | 3-day re-engagement + monthly full-guide WhatsApp nudge |
| `0 6 * * *` | `cron/reminders` | daily reminders |
| `5 6 * * *` | `cron/recurring` | post due recurring/fixed expenses (idempotent) |
| `0 7 * * *` | `cron/lifecycle` | lifecycle emails / state transitions |
| `0 8 * * *` | `cron/budget-check` | proactive budget alerts |
| `0 6 * * *` + `0 14 * * *` | `cron/steven-daily-digest` | Steven's AM + PM ops digest |
| `0 7 * * 0` | `cron/customer-weekly-digest` | Sunday customer weekly summary |

The bot also runs **Apps-Script-side triggers** (not Vercel crons): an **hourly
heartbeat** POSTing `KFL_BUILD_VERSION` to `api/log/bot-heartbeat` (so admin
detects version drift), a Sunday weekly digest, and the recurring/group jobs.

---

## 9. Deploy steps

### Website + API (automatic)
1. Open a PR from a branch off `main`; let CI / the test gauntlet pass.
2. Merge to `main` → **Vercel auto-deploys** both the static site and `api/`.
3. `GET /api/health` reports which env vars are configured (values never printed).

### Bot (manual — easy to forget)
1. Make changes in **`bot/ExpenseBot_FIXED.gs`** (canonical source) and bump
   `KFL_BUILD_VERSION`.
2. Reassemble **`bot/ExpenseBot_DEPLOY.gs`** (single-paste file) — it must
   reassemble byte-identical from FIXED and contain exactly one `doPost`. (Use
   the `bot-deploy-paste` skill.)
3. In the Apps Script editor: paste the whole `ExpenseBot_DEPLOY.gs` over the
   existing file → **Save** → run `installKesefleBot()` once → **Deploy → New
   deployment → Web app** (Execute as "Me", access "Anyone").
4. Confirm live: WhatsApp the bot `בדיקה`; it replies with the deployed
   `גרסה: <KFL_BUILD_VERSION>`.
5. **Kill switch:** set Apps Script Property `KFL_DISABLE_BOT_WRITES=true` to halt
   all bot writes instantly without redeploying.

### Required environment / properties

**Vercel env (set in dashboard):**
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KV_REST_API_URL`,
`KV_REST_API_TOKEN`, `SESSION_SECRET`, `KESEFLE_DB_KEY` (+ `…_ACTIVE_KID`),
`KESEFLE_BOT_SECRET`, `META_VERIFY_TOKEN` + `META_APP_SECRET`
(+ phone-number-id / access-token), `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
(+ price ids), `ADMIN_EMAILS`, `CRON_SECRET`, `KESEFLE_TEMPLATE_SHEET_ID`.

**Apps Script Script Properties (bot):**
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `SHEET_ID` (owner master),
`KESEFLE_BOT_SECRET` (must match Vercel), optional `ANTHROPIC_API_KEY` (LLM
fallback) + `OPENAI_API_KEY` (voice), `VERCEL_KV_REST_URL` + `VERCEL_KV_REST_TOKEN`
(KV-backed onboarding state), webhook verify token `expense_bot_verify_2026`.

No secrets are ever committed. `.env.example` is illustrative only and may lag the
list above — trust this section + the README.

---

## 10. Security posture (at a glance)

- **AES-256-GCM** envelope encryption of OAuth refresh tokens at rest, AAD-bound
  to `userSub` (a stolen KV record can't be decrypted under another user).
- **RS256** Google ID-token verification against JWKS (kid-rotation cache).
- **HMAC raw-body** verification on the Meta webhook + Stripe webhook (no JSON
  re-stringify — that bug was caught and fixed).
- **Formula-injection sanitization** on every sheet write (`valueInputOption=RAW`
  + prefix `'` for `= + - @`).
- **Rate limiting** via KV token-bucket (IPv6 /64 grouping).
- **Structured logging** with auto-redaction; **constant-time** secret compares.
- **Admin auth** = verified ID token + `ADMIN_EMAILS` (not header trust).
- **Multi-writer alarm** on `api/sheet/append.js` (cross-tenant leak detector).
- `drive.file` scope only; Israeli Privacy Law (Amendment 13) + GDPR self-serve
  delete/export wired.

Deep dives: [`SECURITY.md`](SECURITY.md), [`docs/security.md`](docs/security.md),
`docs/security/` (red-team reports), and the dated
`docs/AUDIT_*_2026_05_31.md` sweep.

---

## 11. Where to read next

| You want to… | Read |
|--------------|------|
| See what shipped recently | [`docs/PROGRESS_DIGEST.md`](docs/PROGRESS_DIGEST.md), [`CHANGELOG.md`](CHANGELOG.md), [`docs/NIGHT_REPORT_2026-06-01.md`](docs/NIGHT_REPORT_2026-06-01.md) |
| Understand the architecture in depth | [`docs/AUDIT_ARCHITECTURE.md`](docs/AUDIT_ARCHITECTURE.md) |
| Verify tenant isolation | [`docs/TENANT_ISOLATION_MODEL.md`](docs/TENANT_ISOLATION_MODEL.md) |
| Understand bot classification | [`BOT_AI_ARCHITECTURE.md`](BOT_AI_ARCHITECTURE.md), `docs/CLASSIFICATION.md` |
| Work on the dashboard formulas / year selector | `docs/SHEET_FORMULAS.md`, `docs/SHEET_YEAR_SELECTOR_PLAN.md`, `docs/SHEET_AND_DASHBOARD_STRATEGY.md` |
| Deploy / run the bot safely | [`DEPLOY.md`](DEPLOY.md), `docs/DEPLOY_BOT_SIMPLE.md`, `DEPLOYMENT_CHECKLIST.md` |
| Add a page / endpoint / cron / bot command | the `.claude/skills/` (`add-html-page`, `api-add-endpoint`, `api-add-cron`, `bot-add-command`, …) |
| Run the tests | `node tests/full_qa.js` + `node bot/test_*.js` + `tests/*.js` (gauntlet via the `test-run-all` skill) |

---

## 12. Glossary (Hebrew terms you'll see constantly)

- **כספ'לה (Kesef'le)** — the product name ("little money"). Always with the geresh in display copy.
- **תנועות** — transactions (the raw expense log tab; bot writes here).
- **הזמנות** — orders (business revenue tab; revenue lives here).
- **מאזן אישי / מאזן חברה** — personal / company dashboard tabs.
- **פירוט מורחב** — extended breakdown tab.
- **עסק** — business (col-D value marking business expenses in `תנועות`).
- **קבוע** — fixed / recurring expense.
- **קטגוריה / תת-קטגוריה** — category / subcategory.
- **מילון לימוד** — the learned-keyword cache tab.
- **ניכוי מע״מ** — VAT deduction (transaction column I).
