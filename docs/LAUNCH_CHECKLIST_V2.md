# Launch Checklist V2 (2026-05-25)

Supersedes `LAUNCH_CHECKLIST.md`. Same shape, updated with everything Steven and the bot have learned since the original (multi-tenant, multi-business, bot-loop guards, kill switches).

Use this list **on launch day, after every major bot change, and before opening a paid plan to the public.**

---

## Phase A — Meta / WhatsApp infra

- [ ] Meta Business Verification complete (green check in Business Manager)
- [ ] WhatsApp Business number connected and approved for production
- [ ] Permanent access token configured in Vercel env (`WHATSAPP_TOKEN`) **and** Apps Script Script Properties
- [ ] Phone-number ID stored in `WHATSAPP_PHONE_NUMBER_ID` matches the production number
- [ ] Webhook URL points at `api/whatsapp/webhook.js`, verify-token configured
- [ ] HMAC signature verification active (`META_APP_SECRET` set; `_verifyMetaWebhook_` exits early on mismatch)
- [ ] Message-id idempotency cache verified end-to-end (send same wamid twice → only one write)
- [ ] Bot-loop guards live (`bot/test_botloop.js` passing; `_shouldMuteBotLoop_` thresholds: 3 echoes in 2 min → 30-min mute + admin alert)
- [ ] Outbound reply cap live (20 replies / 60 s per phone)
- [ ] Quality rating in Meta is **green**
- [ ] Display name "Kesefle" / "כספ'לה" approved

## Phase B — Google OAuth

- [ ] Google Cloud project listed in OAuth consent screen as **In production** (not "Testing")
- [ ] Scopes limited to `userinfo.email`, `userinfo.profile`, `drive.file` (no `drive.readonly`, no `spreadsheets`)
- [ ] Verification packet submitted with `KESEFLE_TEMPLATE_SHEET_ID` justification (see `docs/oauth-verification/`)
- [ ] Authorized redirect URIs include `https://kesefle.com/api/auth/google-exchange`
- [ ] Privacy policy + terms URLs match those in the consent screen
- [ ] Test users list reviewed; if still in Testing mode, every paying user MUST be on it

## Phase C — Tenant isolation proof

- [ ] `node bot/test_isolation.js` → 18/18 green
- [ ] `SHEET_OWNER_PHONE` Script Property set to Steven's digits-only phone (currently `972547760643`)
- [ ] No literal `SHEET_ID` write path lacks an `_assertOwnerLegacyWrite_` (grep proves)
- [ ] Spot-check: KV `phone:{X}` for two random tenants returns different `sub`s and different sheet ids
- [ ] `api/sheet/append.js` derives sheet id from `user:{sub}` only (never from request body)

## Phase D — Tests + smoke

- [ ] All 8 test suites green:
  - `tests/full_qa.js` (111)
  - `tests/golden_set.js` (≥93%)
  - `tests/test_bank_parsers.js` (67)
  - `tests/recurring_detect.js` (17)
  - `bot/test_parser.js` (23)
  - `bot/test_classify.js` (68)
  - `bot/test_isolation.js` (18)
  - `bot/test_botloop.js` (24)
- [ ] WhatsApp end-to-end smoke: a fresh number can sign up, link, send `50 קפה`, see the row in their own sheet
- [ ] Billing end-to-end smoke: subscribe → entitlement flips to `pro` → cancel → flips back to `free`
- [ ] Onboarding smoke: visit `/account` in incognito → Google sign-in works → sheet provisioned → welcome message sent

## Phase E — Ops / observability

- [ ] `/admin/launch-monitor` loads (admin-gated) and shows non-zero numbers in the last 24h
- [ ] `api/admin/bot-version` reports the same version string that `KFL_BUILD_VERSION` is set to
- [ ] `api/admin/config-drift` clean (no drift between bot Script Properties and Vercel env)
- [ ] `api/cron/kv-backup` ran successfully in the last 24h (file in Drive)
- [ ] `api/cron/lifecycle.js` not throwing
- [ ] Bot heartbeat (`api/log/bot-heartbeat`) writing daily
- [ ] Funnel summary at `/admin/launch-monitor` shows realistic step-through numbers

## Phase F — Secrets + rotation

- [ ] No secret literal in tracked files (security-scan skill passes)
- [ ] `KESEFLE_BOT_SECRET` rotated within the last 90 days
- [ ] All Vercel env vars match the list in `docs/PRODUCTION_HARDENING_AUDIT.md` §3
- [ ] All Apps Script Script Properties match the list in the same section
- [ ] Personal API keys (Anthropic, Gemini) are in Apps Script Script Properties only — never in source

## Phase G — Killswitch + rollback

- [ ] `KFL_DISABLE_BOT_WRITES=true` test: flip → next inbound message gets the maintenance reply, no sheet write, no admin alert (other than once-per-user-per-hour notice). Flip back → normal traffic.
- [ ] Rollback procedure documented: re-paste the previous `ExpenseBot_DEPLOY.gs` (kept in git history) → Deploy → New Version. Apps Script keeps old versions for instant revert.
- [ ] Last known-good bot version recorded in `KFL_BUILD_VERSION` history (currently `2026-05-25-multi-business`)

## Phase H — Public claims sanity check

- [ ] `pricing.html` reflects actual pricing — no stale strikethrough numbers
- [ ] `index.html` removed all fake testimonials / "10,000 users" claims
- [ ] `trust.html` lists the data we actually access (drive.file, WhatsApp messages, no bank scraping)
- [ ] `privacy.html` matches current data flows (Sheets + KV; Resend for transactional email)
- [ ] FAQ answers reflect what the bot actually does (no promises about features not yet shipped)

## Sign-off

Cut a tag `launch-vX.Y.Z` after every box above is checked. Reference it in the announcement.
