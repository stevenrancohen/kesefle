# Kesefle — Path to 1000 Paid Users

**Date:** 2026-05-24
**Status:** 0 paying customers, P0 launch-blockers fixed, WABA pending verification.
**Effort estimate to 1000-user readiness:** 46 person-days.

---

## P0 BLOCKERS — must fix before opening paid signups

| # | Item | Owner | Effort | Status |
|---|---|---|---|---|
| 1 | WABA verification + production phone (replace test number) | Steven (Meta dashboard) | 5d wait | Manual — Steven |
| 2 | Upstash KV ceiling (10k commands/day vs ~30k needed @ 1k users) | Code optimization | 1d | Claude can ship |
| 3 | No email sender wired — 7 lifecycle templates dormant | Code + Resend env | 1d | Claude can ship |
| 4 | No Vercel crons configured — reminders/dunning/inactivity never fire | Code | 0.5d | Claude can ship |
| 5 | No tax invoice (חשבונית מס) — illegal to charge Israeli customers without | Code + Green Invoice signup | 2d | Claude builds, Steven signs up |

---

## DIMENSION-BY-DIMENSION GAP ANALYSIS

### 1. Infrastructure scale — 🔴 BLOCKER
**Today:** Vercel Hobby + Upstash KV free (10k commands/day). Each signup burns ~12-15 KV ops, each active-user-day burns ~6 KV ops. At 1000 users × 5 msgs/day = ~30k KV commands/day, 3× over free tier. Bot LLM = Claude Haiku 4.5, 140-300 max_tokens per call.

**Gaps:**
- Strip defensive KV writes in `api/sheet/append.js:182-235` OR upgrade Upstash to $10/mo paid tier (100k/day)
- Meta test number cap: 250 msgs/day, 5 recipients — WABA verification is required
- No Sheets API quota tracking (each user gets own 100 req/100s bucket, but no batching for analytics reads)

**Effort:** 3 days

### 2. Payment / billing — ⚠️ PARTIAL
**Today:** PayPal subscriptions + Coinbase crypto + manual Bit confirmation. 14-day trial auto-starts. `past_due` grace works. Stripe code exists but unused.

**Gaps:**
- **No tax invoice (חשבונית מס) generation** — Israeli עוסק מורשה law requires VAT invoice per charge
- No upgrade/downgrade flow (Pro → Family) — PayPal "approve new subscription" double-charges
- No dunning sequence — PayPal `SUSPENDED`/`EXPIRED` immediately deactivates with zero retry email touchpoints

**Effort:** 5 days

### 3. Customer support — ❌ MISSING
**Today:** `info@kesefle.com` + WhatsApp owner number only. No tickets, no auto-responder, no help-center search despite 149KB FAQ page.

**Gaps:**
- Help-center search box (lunr.js client-side OR `/api/help/search` Anthropic-backed)
- Bot `/עזרה` → human escalation routing (currently classified as expense)
- Internal ops view of recent user messages (with privacy log policy)

**Effort:** 4 days

### 4. Churn & retention — ⚠️ PARTIAL
**Today:** 7 lifecycle email templates exist in `templates/email/`. Trial expiration message NOT sent.

**Gaps:**
- **No email SEND infrastructure** — only `MailApp.sendEmail` from Apps Script. Resend/Postmark/SendGrid not wired
- **No Vercel crons in `vercel.json`** — `api/reminders.js` cron never invoked
- No cancellation flow — PayPal cancel hits webhook silently, no retention offer, no exit survey

**Effort:** 6 days

### 5. Acquisition — ⚠️ PARTIAL
**Today:** Referral program works end-to-end (both sides get 1 month). UTM capture in `lib/analytics.js`. Landing pages exist per segment.

**Gaps:**
- Referral analytics shallow — no $-per-referrer, no leaderboard
- No conversion-attribution event on signup (UTM captured but not persisted on user record)
- No paid-ad pixel installed (no GA4, no Meta Pixel) despite CSP allowing it

**Effort:** 4 days

### 6. Onboarding — ⚠️ PARTIAL
**Today:** Profile questionnaire works (trackingType: personal/family/group/business). `welcome.html` post-signup. New-lead admin alerts.

**Gaps:**
- No per-step drop-off telemetry in `api/admin/funnel-summary.js`
- No "first expense celebration" — bot's first-message reply identical to message #500
- Empty-state dashboard does not show "send your first expense" walkthrough when sheet has 0 rows

**Effort:** 3 days

### 7. Product features — ⚠️ PARTIAL (vs RiseUp/MyFinanda/FamilyBiz)
**Today:** Hebrew keyword classifier (~18k keywords), Claude Haiku fallback, receipt OCR via Claude vision, voice transcription via Whisper, recurring detection.

**Gaps (vs RiseUp's killer feature):**
- **No bank statement import** (Hapoalim/Leumi/Discount/Mizrahi CSV/PDF parsers)
- **No tax-deductible flag** — bot categorizes but doesn't mark "ניכוי מע"מ" on expenses
- **No budgets/alerts** — no overspend warning ("התראה: עברת תקציב מזון")

**Effort:** 12 days

### 8. Reliability & observability — ⚠️ PARTIAL
**Today:** `api/health.js` + `/api/health/detailed`. Launch-monitor polls KV usage %. Structured logging. Bot heartbeats hourly.

**Gaps:**
- **No external uptime monitoring** wired (UptimeRobot/BetterUptime)
- **No alerting on degradation** — multi-writer anomaly writes to KV log but no Slack/email/SMS
- **No KV backup** — single Upstash region failure = total data loss

**Effort:** 4 days

### 9. Security & compliance — ✅ DONE (mostly)
**Today:** GDPR export + delete endpoints work. AES-256-GCM refresh tokens. CSP/HSTS/COOP. Bot HMAC verification. Constant-time secret comparison.

**Gaps:**
- No SOC 2-lite checklist documented
- No third-party penetration test
- Privacy policy mentions Facebook/Apple sign-in but only Google ships

**Effort:** 2 days

### 10. Legal/ops — ⚠️ PARTIAL
**Today:** Terms have 14-day refund clause, referral rules, 16+ age gate. Privacy policy updated 2026-05-15.

**Gaps:**
- VAT (מע"מ) referenced in terms but never invoiced
- No DMCA/abuse contact in `.well-known/security.txt`
- No `/api/billing/refund.js` endpoint despite 14-day refund promise

**Effort:** 3 days

---

## WEEK-BY-WEEK PLAN

### Week 1 (this week) — UNBLOCK PAID LAUNCH
- [ ] **#1.** Steven completes WABA verification (5-day Meta wait)
- [ ] **#2.** Strip 3 KV defensive writes in `api/sheet/append.js` (saves 50% commands per write)
- [ ] **#3.** Wire `lib/email.js` with Resend (env-fail-soft if `RESEND_API_KEY` missing)
- [ ] **#4.** Add Vercel `crons` block (lifecycle emails, reminders, dunning)
- [ ] **#5.** Build `api/billing/invoice.js` (Green Invoice integration scaffold)
- [ ] **#6.** Alert webhook: multi-writer anomaly + KV usage ≥80% → Slack/email
- [ ] **#7.** Cancellation flow: retention offer page + exit survey
- [ ] **#8.** Bank CSV importer: Hapoalim + Leumi parsers
- [ ] **#9.** Help-center search (lunr.js client-side)
- [ ] **#10.** GA4 + Meta Pixel install (CSP already allows)

### Week 2 — RETENTION & ATTRIBUTION
- [ ] **#11.** Tax-deductible flag on expenses (column J + year-end export)
- [ ] **#12.** Budgets with overspend alerts via WhatsApp
- [ ] **#13.** Per-step funnel drop-off telemetry
- [ ] **#14.** "First expense" celebration in bot
- [ ] **#15.** Empty-state dashboard walkthrough
- [ ] **#16.** Bot escalation phrases ("נציג"/"אנושי"/"תקלה" → owner alert)
- [ ] **#17.** Referral leaderboard with $-earned
- [ ] **#18.** Conversion-attribution: persist UTMs onto user record
- [ ] **#19.** Privacy policy: remove Facebook/Apple sign-in claims
- [ ] **#20.** External uptime monitor (UptimeRobot) on `/api/health/detailed`

### Week 3-4 — SCALE PREP
- [ ] **#21.** Bank CSV: add Discount + Mizrahi + Bank of Israel ITSL format
- [ ] **#22.** KV backup: nightly snapshot to S3/Drive
- [ ] **#23.** Sheets API quota monitoring (per-tenant tracking)
- [ ] **#24.** Internal ops view: recent user message log (privacy-compliant)
- [ ] **#25.** Dunning sequence: Day 0/3/7 templates wired
- [ ] **#26.** Upgrade/downgrade flow with prorate
- [ ] **#27.** Win-back campaign for cancelled users
- [ ] **#28.** Tutorial videos / interactive walkthroughs
- [ ] **#29.** SOC 2-lite checklist documented
- [ ] **#30.** Third-party penetration test commissioned

### Month 2-3 — GROWTH ENGINE
- [ ] **#31.** Multi-bank import: all 5 Israeli banks
- [ ] **#32.** Tax category review with Israeli CPA
- [ ] **#33.** Year-end tax report PDF export
- [ ] **#34.** Family/group expense splitting UI polish
- [ ] **#35.** Mobile app PWA install promotion
- [ ] **#36.** Israeli influencer outreach kit
- [ ] **#37.** Content marketing: 20 Hebrew SEO articles
- [ ] **#38.** Paid ads launch (Facebook + Google in Hebrew)
- [ ] **#39.** A/B test framework
- [ ] **#40.** Win-back via email + WhatsApp

---

## WHAT CLAUDE WILL SHIP TODAY (autonomous mode)

Sequence — each item gets its own commit:

1. **#2** Strip 3 KV defensive writes (save 50% commands per expense write)
2. **#4** Add Vercel `crons` block (lifecycle emails, reminders, daily summary)
3. **#3** `lib/email.js` Resend integration (env-fail-soft)
4. **#6** Alert webhook for multi-writer anomaly + KV ≥80% usage
5. **#5** `api/billing/invoice.js` Green Invoice scaffold
6. **#9** Help-center search (lunr.js + index build script)
7. **#8** `api/import/bank-csv.js` Hapoalim + Leumi parsers
8. **#10** GA4 + Meta Pixel placeholders (Steven adds tracking IDs)
9. **#7** Cancellation flow scaffold

## WHAT STEVEN NEEDS TO DO MANUALLY

1. **WABA verification** at business.facebook.com (5-day wait)
2. **Sign up for Resend.com** — paste API key into Vercel env as `RESEND_API_KEY`
3. **Sign up for Green Invoice** (greeninvoice.co.il) — paste API key as `GREEN_INVOICE_KEY`
4. **Sign up for UptimeRobot** — point at `/api/health/detailed`
5. **Get GA4 measurement ID + Meta Pixel ID** — paste into Vercel env
6. **(Optional)** Upgrade Upstash to paid ($10/mo) once usage hits 80% of free tier
7. **(Optional)** Hire Israeli CPA for tax category review

---

*Plan owner: Claude (autonomous mode). Steven approves changes via commit log.*
*Next review: when first 10 paying customers signed up.*
