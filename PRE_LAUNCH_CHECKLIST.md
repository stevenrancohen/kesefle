# Kesefle — Pre-Launch Checklist
> Last updated: 2026-05-17 (during autonomous sprint)
> Target: live, sellable product to Israeli freelancers/small businesses by end of day.

## 🟢 Done (deployed + verified)

- [x] **Block A: KV + encryption keys** — `/api/health` returns `ok:true`, `kv:ok`.
- [x] **PWA** — manifest.webmanifest, sw.js v2, icon-192/512/maskable, offline.html, all installed.
- [x] **28 HTML pages** all return 200:
  - Marketing: /, /en, /pricing, /demo, /compare, /testimonials, /cases, /about, /press
  - Content: /blog (+ 3 articles), /tools (+ 4 calculators), /help (34 articles), /docs
  - Product: /account, /welcome, /dashboard, /admin, /referral
  - Trust: /trust, /privacy, /terms
  - Ops: /status, /changelog, /roadmap, /test, /offline, /404, /thanks
- [x] **12 API endpoints** at Vercel Hobby cap. Auth-gated routes return 401 cleanly.
- [x] **48 automated tests** in /test cover pages, PWA, discoverability, API.
- [x] **SEO foundation**: hreflang, canonical, schema.org, robots.txt, sitemap.xml (21 URLs), opensearch.xml, /humans.txt, /.well-known/security.txt.
- [x] **URL redirects**: /signup → /account, /careers → /about, /faq → /help, etc.
- [x] **Apps Script**: WEEKLY_DIGEST.gs + BOT_COMMANDS.gs + CLEANUP_DUPLICATES_AND_TABS.gs pasted. SUBSCRIBERS configured. Duplicate financial summary removed.

## 🔴 Critical blockers — needs YOUR action (in order)

### 1. Bot wire-up fix (3 min) — **Block B2** ⬅️ DO THIS NEXT
The bot's `handleBotCommand_` call is in the wrong place in `ExpenseBot.gs`. Commands `היום?`, `מחק אחרון`, `עזרה` don't work yet.

Steps in chat or [YOUR_TASKS.md](YOUR_TASKS.md) TASK 2.

### 2. Meta WhatsApp Business credentials (60 min) — **Block C**
Without this, the bot can't send messages — including the weekly digest (which is why `RUN_WEEKLY_DIGEST_NOW` shows `missing_wa_credentials`).

**Two Apps Script properties needed**:
- `WA_TOKEN` = Meta Cloud API access token (NOT the old `WHATSAPP_TOKEN`)
- `WA_PHONE_ID` = Meta Phone Number ID (e.g., `123456789012345`)

Plus 4 Vercel env vars (`META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`).

Full setup: https://business.facebook.com → Create App → WhatsApp Cloud API → get a phone number (₪50-100 one-time) → Webhook URL = `https://kesefle.vercel.app/api/whatsapp/webhook`.

### 3. Stripe billing (20 min) — **Block D**
Without this, /pricing → "התחל ניסיון Pro" → 404 (no Stripe Checkout).

4 Vercel env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FAMILY`.

Stripe Dashboard: https://stripe.com → Products → 2 products (₪19/mo Pro, ₪39/mo Family) → Webhook endpoint `/api/billing/webhook` with events `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`, `invoice.paid`.

### 4. EU region for Israeli compliance (30 sec) — **Block E**
Vercel → kesefle → Settings → General → Function Region → change `Washington D.C. (iad1)` → **`Frankfurt (fra1)`** → Save → Redeploy.

Required by Israeli Privacy Law Amendment 13 (cross-border data flow).

## 🟡 Important but not blockers

### 5. Google OAuth Verification (CASA Tier 2)
4-6 week external review for `drive.file` restricted scope. Submit at https://console.cloud.google.com → APIs & Services → OAuth consent screen → "Submit for verification". Draft answers in `docs/compliance/google-oauth-verification.md`.

Without verification, Google shows "App not verified" warning. **Doesn't block development**, but reduces conversion rate.

### 6. Dedicated WhatsApp Business number
Currently the test setup uses Steven's personal number `+17745448053`. Production should use a dedicated number from Meta (purchased + verified through Meta Business Manager).

## 🟢 Polish + growth (no blockers)

### 7. Email infrastructure
Templates ready in `templates/email/` (welcome, weekly-digest, payment-receipt, payment-failed, account-deleted, monthly-insights). Plug into Resend/SendGrid/Postmark when ready.

We're at the 12-function Vercel Hobby cap. To add `/api/send` endpoint:
- Either upgrade to Vercel Pro (50-fn limit + EU region)
- OR send emails directly from Apps Script via `MailApp.sendEmail` (cap: 100/day on free)
- OR fold email send into the existing `/api/billing/webhook` endpoint

### 8. Analytics dashboard data
KV is configured now, so `/api/admin?action=analytics` will start populating with real `page_view`, `cta_click`, `signup_start`, etc. counters. Visit `/admin` (gated by `ADMIN_EMAILS` env var) to see.

### 9. Bot keywords expansion
Coming in `bot/KESEFLE_KEYWORDS_EXTRA_v3.gs` from the autonomous sprint — 800-1200 additional Israeli vendor names, slang, categories. Paste into Apps Script when delivered.

### 10. Public transparency page
Coming as `/open` from the autonomous sprint — radical-transparency page showing live metrics, decisions journal, honest weaknesses. Strong trust signal.

## 🟢 Verification commands

```bash
# Site health
curl -s https://kesefle.vercel.app/api/health | jq

# All public routes
curl -s https://kesefle.vercel.app/sitemap.xml | grep -oE 'https://[^<"]+' | sort -u | xargs -I{} sh -c 'echo "$(curl -s -o /dev/null -w "%{http_code}" {})  {}"'

# API endpoints
curl -X POST https://kesefle.vercel.app/api/events?action=waitlist -H 'Content-Type: application/json' -d '{"email":"test@example.com","source":"verify"}'

# Live test suite
open https://kesefle.vercel.app/test
```

## 🟢 What "live and sellable" means today

After **Block B2 + C + D + E** (~85 min total user-side work), you can:
- Send `/pricing` URL → user clicks "Pro" → Stripe Checkout → user pays → automatic `/api/billing/webhook` → user marked Pro → user starts using bot via dedicated business WhatsApp number.

Everything else (Block F OAuth, email, more polish) is incremental.

## 📞 If something breaks

- API returns 503: check `/api/health` → env_configured fields
- Bot doesn't reply: check Apps Script Execution Log → search for `missing_wa_credentials` or HTTP errors
- /pricing checkout 404: `STRIPE_PRICE_PRO` env var missing
- Manifest icons broken: check `/icon-192.png` returns 200
- Service worker stuck on old version: bump `VERSION` constant in `sw.js`

## 🎯 Definition of done

When all of these are green, the product is ready to charge real customers:

| Check | Status | Owner |
|---|---|---|
| `/api/health` `ok:true` | ✅ | Done |
| All 28 pages return 200 | ✅ | Done |
| Bot replies to `היום?` in <3s | ⏳ | Block B2 + C |
| Stripe Checkout opens | ❌ | Block D |
| Vercel region = `fra1` | ❌ | Block E |
| Test suite at /test passes 48/48 | ⏳ | After all blocks |
