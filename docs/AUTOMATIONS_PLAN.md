# 50 Background Automations — Plan + Implementation Status

> Steven's sprint spec 2026-05-26:
> "Design and implement up to 50 useful background automations where
> appropriate. Do not create unnecessary fake automations. Implement
> only where the architecture supports it, and document the rest as
> planned tasks."

Status legend:
- ✅ **shipped** — running in production
- 🟡 **wired** — code exists, cron in vercel.json, awaiting verification
- 🔵 **planned** — design doc here, not yet built
- 🔘 **out of scope v1** — won't build until specific user demand

## Already running (10)

| # | Automation | Cron path | Schedule | Status |
|---|------------|-----------|----------|--------|
| 1 | KV backup nightly snapshot | /api/cron/kv-backup | 3am UTC | ✅ |
| 2 | Daily reminders to inactive users | /api/cron/reminders | 6am UTC | ✅ |
| 3 | Recurring expense fire | /api/cron/recurring | 6:05am UTC | ✅ |
| 4 | Lifecycle emails (trial/dunning) | /api/cron/lifecycle | 7am UTC | ✅ |
| 5 | Budget exceeded → WhatsApp alert | /api/cron/budget-check | 8am UTC | ✅ |
| 6 | KV usage monitor (>80% alert) | /api/cron/kv-monitor | every hour | ✅ |
| 7 | Steven's daily Hebrew dev digest | /api/cron/steven-daily-digest | 6am UTC | ✅ |
| 8 | Self-healing dashboards | /api/cron/heal-dashboards | 3am UTC | 🟡 PR #14 open |
| 9 | Bot daily heartbeat (KV version check) | inside bot | inline | ✅ |
| 10 | Sheet quota monitor (per-tenant) | inline check | inline | ✅ |

## High-value next (15 — recommended sprint)

| # | Automation | Why now | Effort | Trigger |
|---|------------|---------|--------|---------|
| 11 | Weekly spending summary → WhatsApp | Users forget bot exists otherwise | 2h | Sunday 9am IL cron |
| 12 | Subscription detection ("3× same vendor at same amount = קבוע?") | Already exists for expenses, NOT for income — PR #18 ships income side as dead code, needs wire-up | 1h | Inline after each expense |
| 13 | Anomaly detector ("400 ₪ on coffee this month, 3× normal") | Anti-overspend; differentiates Kesefle from passive trackers | 4h | Daily cron, alerts via bot |
| 14 | Failed Sheets-write retry queue | Today a failed write logs + is lost. Should retry 3× with backoff | 3h | inline + dedicated retry cron |
| 15 | Webhook health check (Meta + PayPal + Coinbase) | Detect silent webhook breakage before users complain | 2h | Every 15min cron, alerts Steven |
| 16 | Bot response latency monitor | If p95 > 5s, alert Steven (cold start? KV slow?) | 2h | Every 5min cron |
| 17 | Duplicate transaction detection | Same amount+desc within 60s → ask user "אותה הוצאה?" | 2h | Inline |
| 18 | Missing-category daily review (admin) | List of expenses that landed in "שונות" — Steven adds to keyword maps | 2h | Daily cron, dashboard tile |
| 19 | Trial ending in 3 days reminder | Reduce trial→churn | 1h | Daily cron, filter by trial_end |
| 20 | Payment failed reminder (day 0/3/7) | Already exists as lifecycle dunning — verify wired | 0.5h check | Cron exists |
| 21 | New-user onboarding follow-up (day 1 + day 3) | "Haven't seen any expenses yet — need help?" | 2h | Daily cron, segment by signup_at + has_expenses |
| 22 | Inactive user reactivation (day 30 no activity) | Win-back with personalized digest | 3h | Daily cron, email + WhatsApp |
| 23 | Monthly category insights ("top 3 spends + delta vs last month") | Sticky engagement metric | 4h | 1st of month cron |
| 24 | Suspicious amount warning (>10× user's average) | Catch typos ("100000 קפה" was meant to be 100) | 2h | Inline confirm-before-write |
| 25 | Admin daily system summary | Active users, msgs processed, errors, KV usage, LLM cost — one email | 3h | Daily cron, sends to Steven |

## Medium-value (15)

| # | Automation | Effort | Why |
|---|------------|--------|-----|
| 26 | LLM cost monitor (per-tenant) | 3h | Prevent runaway spend if a user hammers the bot |
| 27 | Rate limit hit alerts (per-route) | 1h | Detect abuse / bug in client code |
| 28 | Export to PDF cron (monthly statement → email) | 3h | Tax-ready report users actually want |
| 29 | Sheet formula validation (every dashboard, weekly) | 2h | Generalization of PR #14 to ALL formulas not just עלות שיווק |
| 30 | Sheet quota monitor (per-tenant) | 1h | Alert when user approaches Sheets API daily quota |
| 31 | User feedback request (day 14, day 60) | 1h | NPS exists, expand to free-text "what's missing?" |
| 32 | Support escalation flag (auto-DM Steven) | 1h | Already exists for נציג/תקלה — check wired |
| 33 | Error digest (daily, top 10 errors grouped) | 2h | Replaces inbox flood with one daily email |
| 34 | Currency-rate daily refresh (USD/EUR → ILS) | 2h | For users tracking foreign currency |
| 35 | Recurring expense reminder ("did you pay נטפליקס this month?") | 2h | Catch missed bills |
| 36 | Year-end summary (1 Jan) | 4h | Annual review users will share on social |
| 37 | Tax-deductible flag review (quarterly) | 2h | For עוסק מורשה users |
| 38 | Sheet provisioning watchdog (orphans cleanup) | 2h | Already exists per PR #55, verify still running |
| 39 | Profession-tailored category suggestions (Q4 → seeding works, but if new profession added later) | 2h | Extension of PR #11 |
| 40 | Bank statement email parser (forward → bot extracts) | 8h | Big win, big build — separate sprint |

## Lower priority / future (10)

| # | Automation | Why deferred |
|----|------------|--------------|
| 41 | Webhook signature rotation reminder | Security hygiene but not urgent |
| 42 | Refresh-token expiry warning (90 days) | Google tokens last forever w/ usage; rare in practice |
| 43 | Receipt OCR queue (batch process at night) | Today inline. Move to queue only if scale demands |
| 44 | Multi-currency P&L (year view) | After UI is built |
| 45 | Anomaly detection ML (vs rule-based above) | Premature; rules cover 80% |
| 46 | Sheet template version migration | Only when we change template |
| 47 | Push notifications digest (for mobile app users) | After mobile app ships |
| 48 | A/B test winner auto-deploy | Framework exists; needs UI |
| 49 | Referral leaderboard re-rank (daily) | Already exists, low signal |
| 50 | Webhook replay UI (admin) | Only when debugging an incident |

## Implementation rules (apply to every new automation)

1. **Cron path**: add to `vercel.json` `crons` block + `api/cron/<name>.js`
2. **Auth**: Vercel cron header (`x-vercel-cron`) OR `?secret=<KESEFLE_CRON_SECRET>` for manual triggers
3. **Kill switch**: each cron has an env var `KESEFLE_DISABLE_<NAME>=1` to disable without redeploy
4. **Per-run limits**: max users / max time / paginated via KV cursor (pattern from PR #14)
5. **Logging**: `log.info` with reqId + stats (users processed, fixed, errors)
6. **Failure mode**: per-user errors don't block the whole cron run
7. **Idempotency**: re-running the same cron in the same window is safe (no double-sends)
8. **Tests**: every cron has a test file with at least kill-switch + auth + happy path

## Constraint: Vercel Hobby cron limits

Vercel Hobby allows **2 daily crons + 1 hourly cron** (= 3 paid). Current state: **7 crons running** — already past the limit, which means we're on the paid Pro plan ($20/mo).

The good news: each cron added beyond #10 doesn't cost more, just keeps us on Pro. The bad news: every cron is one more thing that can silently break. Use kill switches generously.

## What I'd ship this week (5 picks from the list)

If I had 5 days, I'd ship #11, #13, #14 (already PR), #17, #25. That's:
- Weekly digest cron (re-engagement)
- Anomaly detector (differentiation)
- Self-healing dashboards (prevent the bug class Steven hit)
- Duplicate detection (data quality)
- Admin daily system summary (Steven's visibility)

All 5 are 1-4 hours each. Total: ~14 hours of focused work.
