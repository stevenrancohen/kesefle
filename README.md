# כסף'לה (Kesef'le)

> הכסף שלך, על אוטומט.
> Hebrew WhatsApp-bot expense tracker with Google Sheets backend.

**Live at https://kesefle.vercel.app · Status: production ~92% feature-complete · 6 launch blockers tracked in `docs/PRODUCTION_ROADMAP.md`**

## What's running

| Surface | Path | Status |
|---|---|---|
| Landing page | `/` | ✓ |
| Onboarding | `/account` | ✓ — Google sign-in → sheet provision → redirect to `/welcome` |
| First-run tour | `/welcome` | ✓ — 5 commands, click-to-copy, WhatsApp CTA |
| User dashboard | `/dashboard` | ✓ — pulls real data from `/api/sheet/summary` with Google One Tap auth fallback |
| Admin panel | `/admin` | ✓ — Wix-inspired, gated by `ADMIN_EMAILS`. 9 sections, dark mode |
| Status page | `/status` | ✓ — 6 services, 30-day uptime, auto-refresh |
| Pricing | `/pricing` | (building) — standalone page with comparison + ROI calc |
| Demo | `/demo` | (building) — interactive bot preview, no signup needed |
| Test suite | `/test` | ✓ — 31 automated regression checks |
| Privacy / Terms | `/privacy`, `/terms` | ✓ — OAuth scope disclosure, Israeli Privacy Law §13 |

## API surface (12 endpoints — at Vercel Hobby function limit)

| Endpoint | Purpose |
|---|---|
| `POST /api/waitlist` | Pre-launch email collection (rate-limited 5/IP/hr + 3/email/hr) |
| `POST /api/auth/google` + `POST /api/auth/google-exchange` | Server-side OAuth code+PKCE exchange for refresh tokens |
| `POST /api/sheet/provision` | Copy template sheet to user's Drive, store mapping in KV |
| `GET /api/sheet/summary` | Read user's transactions, return dashboard JSON (Bearer auth) |
| `POST /api/whatsapp/webhook` | Meta WA Cloud API webhook. HMAC raw-body verified. Writes to user's sheet via refresh token (AES-256-GCM encrypted at rest) |
| `POST /api/billing/checkout` | Stripe Checkout Session (Pro ₪19/mo, Family ₪39/mo, 14-day trial) |
| `POST /api/billing/webhook` | Stripe webhook (subscription state → KV) |
| `POST /api/account/delete` | Self-serve account deletion (Israeli Amendment 13 / GDPR Art. 17) |
| `GET /api/account/export` | Self-serve data export (GDPR Art. 20) |
| `GET/POST /api/admin?action=...` | Consolidated admin router (users, jobs, metrics, audit, feature-flags) |
| `GET /api/health` | Uptime + dep health probe (KV, Google OAuth, Sheets, env vars) |

## Security posture

- **HSTS** (preload-ready) + **CSP** (locked sources for scripts/styles/imgs/fonts/connect) + **Permissions-Policy** (no camera/mic/geolocation)
- **AES-256-GCM** envelope encryption of OAuth refresh tokens at rest, AAD-bound to userSub (KV record swap fails decryption)
- **RS256 ID token verification** against Google JWKS (with kid-rotation cache)
- **HMAC raw-body verification** on Meta WA webhook + Stripe webhook (no JSON re-stringification — that bug was caught + fixed)
- **Formula-injection sanitization** on every sheet write (`valueInputOption=RAW` + prefix-with-`'` for `= + - @`)
- **Rate limiting** via KV token-bucket (IPv6 /64 grouping to prevent prefix bypass)
- **Structured logging** with auto-redaction of token/secret/password fields
- **Admin auth** via `ADMIN_EMAILS` env var + verified ID token (not just header trust — that was a CRITICAL bug, now fixed)

5 documented Red Team findings (CRITICAL severity) all fixed. Full reports in `docs/security/`.

## Apps Script bot

The bot lives separately in Apps Script project `1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo`. Files in `bot/`:

- **`KESEFLE_KEYWORDS_v2.gs`** — 700 Hebrew+English keywords, 30 categories, `_SRC_classify_v2_(text)` returns confidence-scored category
- **`DROPDOWN_FOR_UNSURE.gs`** — when classifier confidence < 70 OR `needs_question=true`, sends WhatsApp interactive list message + state cache in PropertiesService
- **`BOT_COMMANDS.gs`** — conversational commands: `היום?`, `השבוע?`, `החודש?`, `מחק אחרון`, `כמה הוצאתי על וולט?`, `עזרה`, `סטטיסטיקות` and English aliases
- **`WEEKLY_DIGEST.gs`** — Sunday 08:00 Asia/Jerusalem digest with spike detection (>2× weekly average)
- **`FIX_DASHBOARD_2023_2024_2025.gs`** — repaired the 2023-2025 net profit / משלוחים rows (now shipped)
- **`FIX_PROFITABILITY_AND_CHART.gs`** + **`EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs`** — 4-year financial summary with sparklines, YoY delta, auto-insights (best/worst year + root cause + recommendation)
- **`EMBEDDING_FALLBACK.gs`** / **`RECEIPT_PARSING.gs`** / **`PERSONALIZED_LEARNING.gs`** — ML modules (Vertex AI Gemini for low-confidence + receipt OCR + per-user correction cache). Designed by sub-agent, paste-ready.

## Local preview

```bash
python3 -m http.server 3000
# open http://localhost:3000
```

## Deploy

The repo auto-deploys to Vercel on push to `main`. Required env vars:

- `GOOGLE_CLIENT_ID` (live)
- `GOOGLE_CLIENT_SECRET` (live)
- `KESEFLE_TEMPLATE_SHEET_ID` (set to a publicly-viewable empty sheet)
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Upstash) — required for token storage, rate limiting, idempotency
- `META_VERIFY_TOKEN` + `META_APP_SECRET` + `META_PHONE_NUMBER_ID` + `META_ACCESS_TOKEN` — for WhatsApp Cloud API
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_PRO` + `STRIPE_PRICE_FAMILY` — for billing
- `KESEFLE_DB_KEY` (raw 32-byte base64) + `KESEFLE_DB_KEY_ACTIVE_KID` — encryption key for refresh tokens
- `ADMIN_EMAILS` (comma-separated) — who can access `/admin`

`/api/health` reports which env vars are configured (without printing values).

## Pricing

- **Free forever** — up to 30 expenses/month, basic classifier, single sheet, current-month view
- **Pro ₪19/mo** — unlimited expenses, history, custom categories, Sunday digest, ROAS panel, CSV/PDF export
- **Family ₪39/mo** — all Pro + up to 4 linked phones writing to one shared sheet, per-person color tags

14-day Pro trial, no card required up-front.

## Compliance

- **Google OAuth verification (CASA Tier 2)** — required for `drive.file` restricted scope. Documents in `docs/compliance/google-oauth-verification.md`. 4-6 week lead time.
- **Israeli Privacy Protection Law (Amendment 13, Aug 2025)** — privacy.html includes the §13 disclosure, scope justification, data retention. Self-serve deletion + export wired. Cross-border note: production should move Vercel + Upstash to EU regions (currently `iad1` — see roadmap blocker #2).
- **WhatsApp Business policy** — STOP/`עצור`/`הסר` handler implemented + 24h-window tracking in webhook. Need dedicated business number (currently using personal `+972547760643`).

## Project structure

```
/
├── index.html, account.html, dashboard.html, welcome.html
├── admin.html, admin-styles.css
├── status.html, privacy.html, terms.html, test.html
├── og-image.png, robots.txt, sitemap.xml, vercel.json
├── api/
│   ├── waitlist.js, health.js, admin.js
│   ├── auth/google.js, auth/google-exchange.js
│   ├── sheet/provision.js, sheet/summary.js
│   ├── whatsapp/webhook.js
│   ├── billing/checkout.js, billing/webhook.js
│   └── account/delete.js, account/export.js
├── lib/
│   ├── crypto.js — AES-256-GCM keyring + RS256 JWT verify
│   ├── auth.js — requireAuth / requireAdmin / verifyGoogleIdToken
│   ├── log.js — structured logging with PII redaction
│   ├── ratelimit.js — KV token-bucket
│   ├── middleware.js — compose() + withSecurityHeaders + withValidation
│   └── secure-kv.js — encrypted-at-rest KV wrapper
├── bot/ — Apps Script files (see "Apps Script bot" above)
└── docs/
    ├── PRODUCTION_ROADMAP.md
    ├── architecture/ — db-schema, api-routes, billing-stripe, jobs-cron, observability, security-hardening
    └── compliance/ — google-oauth-verification, privacy-law-compliance, whatsapp-policy-compliance, incident-response-runbook, disclaimers-and-boundaries
    └── security/ — red-team-1/2/3 findings, data-classification, data-flow-audit, sri-hashes
```

## Brand

- **Name:** כסף'לה (Kesef'le) — "little money" with affectionate Yiddish-Hebrew suffix
- **Persona:** Hebrew-speaking Israeli individuals, freelancers, small businesses; ages 25-55
- **Differentiation:** no bank/credit-card connection. Cash-friendly. Data lives in the user's own Google Drive (we touch only files we created via `drive.file` scope).
