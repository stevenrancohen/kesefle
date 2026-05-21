# 🚀 Kesefle — Master Launch Checklist (test → live)

> Do these **in order**. Each long step links to a detailed doc. ✅ = already done.
> 🔴 = blocks real users. The website + API auto-deploy from GitHub; only the
> **bot** needs a manual paste into Apps Script.

---

## Phase 0 — Security gate (must be true before launch)

- [x] **Multi-tenant isolation fixed & verified.** Owner = `972547760643` (matches
      the built-in `OWNER_PHONE`, so isolation holds even if the Script Property
      is unset). 18/18 isolation tests pass. See `SECURITY.md`.
- [ ] 🔴 **Re-paste `bot/ExpenseBot_DEPLOY.gs`** into Apps Script (latest = the
      fix). Until you do, the leak fix isn't live. (Phase 3 below.)
- [ ] **Set `SHEET_OWNER_PHONE = 972547760643`** in Apps Script → Project Settings
      → Script Properties. (Optional — the built-in fallback already = your number
      — but explicit is safer.)
- [ ] **Clean the already-leaked rows** from your sheet using
      `bot/CLEANUP_LEAKED_ROWS.gs` (backup → list → delete). See `DEPLOYMENT_CHECKLIST.md` §5.
- [ ] **Rotate the PayPal secret** that was pasted in chat earlier (treat as compromised).

---

## Phase 1 — Domain

- [x] **kesefle.com is live on Vercel** (verified: HTTP 200, served by Vercel).
      If you ever re-point DNS, follow `docs/DOMAIN_SWITCHOVER.md`.
- [ ] In Vercel → **Project → Settings → Domains**, confirm `kesefle.com` +
      `www.kesefle.com` both show **"Valid Configuration"**.

## Phase 2 — Identity verification (the slow ones — start FIRST, they take days)

- [ ] 🔴 **Meta Business Verification + WhatsApp app publish** → unlocks the
      production number `+1 774 544 8053`. Full steps: `docs/META_BUSINESS_VERIFICATION.md`.
      *(1–3 business days. Start this before everything else.)*
- [ ] 🔴 **Google OAuth verification** (for the Sheets/Drive scopes). Full kit:
      `docs/oauth-verification/` (README + scope-justifications + demo-video-storyboard
      + denial-recovery). **Tips to avoid rejection:** privacy policy + terms must be
      live (they are: `/privacy`, `/terms`); the demo video must show the exact
      consent screen → what each scope is used for; scope justifications must match
      the video. **Until approved**, add testers under **APIs & Services → OAuth
      consent screen → Test users → + ADD USERS** (their Google emails; up to 100).

## Phase 3 — Deploy the bot (Apps Script)

1. Open the Apps Script project. Project should contain ONLY: the main bot file,
   `BOT_COMMANDS.gs` (if used), `CLEANUP_LEAKED_ROWS.gs` (optional). **Do NOT** paste
   `ExpenseBot_FIXED.gs` or any `FIX_*`/`CREATE_*` dev script.
2. Paste the full `bot/ExpenseBot_DEPLOY.gs` → **Save (Cmd+S)**.
3. Run **`installKesefleBot()`** once → read the ✅/⚠️ report (it now checks
   `SHEET_OWNER_PHONE`).
4. **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
5. Copy the **/exec** URL → in **Meta → WhatsApp → Configuration → Webhook**, set
   Callback URL = that /exec URL, Verify token = `expense_bot_verify_2026`,
   Subscribe to **messages**. Click **Verify and save**.

## Phase 4 — WhatsApp Business profile

- [ ] **Display name** `כספ'לה` — submit via Meta (review ~24h). See `docs/WHATSAPP_DISPLAY_NAME.md`.
- [ ] **Profile photo** = the logo (`/icon-512.png`).
- [ ] **Remove the test recipient numbers** (Meta → WhatsApp → API Setup → "To" list)
      once the number is live.
- [ ] After Meta approves the production number, **switch the site links**: tell me
      and I'll swap all `wa.me/15556408123` → the live number in one pass
      (`DEPLOYMENT_CHECKLIST.md` §0; 45 links across 20 pages).

## Phase 5 — Vercel environment variables (Project → Settings → Environment Variables)

🔴 **Core (required):** `KESEFLE_BOT_SECRET` (must match Apps Script), `KESEFLE_CRON_SECRET`
(match Apps Script), `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `KESEFLE_DB_KEY`, `KESEFLE_DB_KEY_ACTIVE_KID`, `SESSION_SECRET`,
`PUBLIC_SITE_URL=https://kesefle.com`, `KESEFLE_OWNER_PHONE=972547760643`.

**WhatsApp-on-Vercel (only if Meta points at Vercel, not Apps Script):** `META_APP_SECRET`,
`META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`.

**Payments (enable what you use):** PayPal `PAYPAL_CLIENT_ID/SECRET/ENV/PLAN_PRO/PLAN_FAMILY/WEBHOOK_ID`;
crypto `COINBASE_COMMERCE_API_KEY/COINBASE_WEBHOOK_SECRET`; manual `BIT_PAYEE_PHONE/BANK_TRANSFER_DETAILS`;
admin `ADMIN_EMAILS/ADMIN_TOKEN`. **Stripe is NOT used** — leave `STRIPE_*` unset.

> After changing any env var, **Vercel → Deployments → ⋯ → Redeploy** so it takes effect.

## Phase 6 — Smoke test (do this the moment you're live)

- [ ] Send `50 קפה` from **your** number → lands in **your** sheet.
- [ ] Send from a **second** number (linked) → lands in **its own** sheet, NOT yours.
- [ ] Send from an **unlinked** number → onboarding message, **no write anywhere**.
- [ ] Open kesefle.com on phone → sign in with Google → sheet provisions → link phone.

## Phase 7 — First 24 hours — what to watch

- **Vercel → Logs**: look for `append.sheet_ownership_mismatch`,
  `append.sheet_multi_writer_anomaly`, `WRITE_BLOCKED_*`, 5xx spikes.
- **KV**: `write_log:*` (every tenant write), `sheet_anomaly:*` (should stay empty).
- **Apps Script → Executions**: `doPost` errors, quota limits.
- **Meta → WhatsApp → Insights**: message delivery failures.
- **Conversion**: did anyone complete signup → first expense? (the funnel that matters.)
- Keep your phone handy — the bot DMs you (`_adminAlertOnce_`) if it ever blocks a
  foreign write to your sheet.
