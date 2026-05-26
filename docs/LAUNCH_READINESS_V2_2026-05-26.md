# Launch Readiness Scorecard v2 — 2026-05-26

Production stabilization sprint deliverable. Doc-only. No code. No `main` push (lives on `docs/launch-readiness-v2-2026-05-26` branch).

---

## A. Executive Summary

Kesefle is **functionally complete** for the core path (WhatsApp expense → Hebrew Google Sheet) but **launch-blocked** on three fronts:

1. **Live verification gap** — the signup and payment flows have never been run end-to-end by a third party. Code passes 111/111 offline tests; zero live e2e runs.
2. **Sheet write correctness** — depends on Steven confirming PR #42 actually fixed his marketing dashboard. If yes, score jumps from 70 → 90.
3. **Per-tenant cost cap missing** — without an LLM-spend ceiling per user, one abusive user could blow the budget.

**Overall score: 72 / 100 (-1 vs v1 once we removed assumed-passing flows from the scorecard).** Net direction is good (4 PRs merged since v1, 3 risky PRs closed cleanly, status page removed). 7-day path to ≥ 85 is realistic; 30-day path to soft-launch is realistic.

---

## B. What Changed Since v1 (sprint readiness 2026-05-26 morning)

| Area | Δ since v1 |
|------|------------|
| Open PRs | 11 → 6 (closed #15 / #17 / #21, opened #43 / #44 / #45) |
| Merged this morning | PR #42 (emoji-prefix dashboard fix), PR #24 (delete-last import), PR #43 (sprint v1 doc), PR #44 (hero live demo + dark-bg parity), pending PR #45 (status removal), pending PR #38 (financial validator, now rebased) |
| Risky scaffolding removed | 3 closures (#15 household, #17 federated learning, #21 stale welcome rewrite) |
| Pages on site | 31 → 30 (status removed) |
| Tests passing | 111/111 (unchanged — never broke) |
| Bot commands shipped | unchanged — no bot file modifications since v1 |

---

## C. Appendix A Decisions — Applied

| PR | Decision | Action taken | Status |
|----|----------|--------------|--------|
| **#15** Household mode | NO-GO / freeze | Closed with comment listing required prerequisites for v2 + salvageable artifacts | ✅ CLOSED |
| **#17** Federated learning Stage 3 | NO-GO / pivot to local memory | Closed with comment defining simpler per-user correction policy + salvageable tests | ✅ CLOSED |
| **#21** Welcome rewrite | Rebase + merge only if clean | Diff analysis: 73 files, 71 are REVERTS of merged work. Closed with extraction plan (port welcome delta cleanly in a fresh small PR) | ✅ CLOSED |
| `/status` page | Remove | Deleted page, stripped 14 pages' nav refs, added `/status → /` temp redirect | ✅ PR #45 OPEN |
| **#38** Financial validator | Rebase + open for merge | Branch reset onto main, AUDIT_COMPANY_DASHBOARD function + checklist re-applied cleanly | ✅ PR #38 NOW MERGEABLE |

**Net: 3 closed + 2 ready-to-merge + 0 still-blocked.**

---

## D. PR #38 Status — Detail

| Field | Value |
|-------|-------|
| Branch | `feat-financial-qa-validation` |
| Title | feat(sheet): AUDIT_COMPANY_DASHBOARD validator + financial QA checklist |
| Files | 2 (`bot/personal_sheet_fix.gs` +186, `docs/FINANCIAL_QA_CHECKLIST.md` +115 new) |
| Conflicts found | YES — original branch was 14 commits behind main and conflicted with #37/#39/#40/#41/#42 in `bot/personal_sheet_fix.gs` |
| Resolution | Reset branch to current main, force-pushed with just the additive function + new doc (no logic from main was touched) |
| Tests run | `node tests/full_qa.js` → 111/111 PASS; `node --check bot/personal_sheet_fix.gs` → OK |
| Safe to merge | **YES** — read-only Apps Script function + new doc; modifies zero production paths |
| Remaining risks | Function reads from your live sheet — first run could be slow on large `תנועות` tabs. Read-only so no write risk. |

---

## E. Launch Readiness Scorecard v2 — 16 Areas

> Scoring rubric: **100** = production-grade, third-party verified. **80–99** = solid code, needs live test. **60–79** = works but has known gaps. **40–59** = partial, real risk if launched. **< 40** = not launch-ready.

### 1. Homepage conversion — **78**
- **Why this score:** Hero now has the live demo auto-playing (PR #44). CTAs split well, 3 OAuth options above the fold, social proof chips, dark/light parity. -22 because we have **zero live conversion-rate data** — every choice is best-guess.
- **Critical blocker:** none (functional).
- **Quick win:** add basic GA4 event firing per CTA click (already wired, needs verification it fires on prod).
- **Deep fix:** real A/B framework swap-in (already exists, needs first experiment).
- **Files:** `index.html` (hero + sections), `lib/ab-test.js`.
- **Risk if ignored:** flying blind on what converts.
- **Owner:** me + Steven (Steven for content decisions).
- **Effort:** 1 day to wire GA4 verification, 3 days to ship one A/B test.

### 2. Bot onboarding — **75**
- **Why:** Q4 profession question shipped (PR #10), profession-aware sheet seeding shipped (PR #11), provisioning works in offline test. -25 because the rewrite (PR #21) was closed without re-port — current welcome message is still pre-#21 copy.
- **Critical blocker:** welcome message is not as crisp as the rewritten version. **Soft blocker** — current message works.
- **Quick win:** port the 2-file delta from PR #21 (rewrite welcome + defer survey) as a clean small PR.
- **Deep fix:** add `tests/test_onboarding_flow.js` covering Q1-Q4 and first-expense.
- **Files:** `bot/ExpenseBot_FIXED.gs` (handleWelcome), `bot/ExpenseBot_DEPLOY.gs`.
- **Risk if ignored:** ok for launch, suboptimal first impression.
- **Owner:** me.
- **Effort:** half day port + half day tests.

### 3. Bot reliability — **80**
- **Why:** Hermes loop guard, kill switch (`KFL_DISABLE_BOT_WRITES`), per-phone rate limit, daily heartbeat, owner DM on error. -20 because **no live concurrency test** at >1 user/sec.
- **Critical blocker:** none verified, but unknown unknowns at scale.
- **Quick win:** synthetic load test (10 concurrent users) using the bot endpoint.
- **Deep fix:** structured logging + Sentry-style aggregator.
- **Files:** `bot/ExpenseBot_DEPLOY.gs`, `api/whatsapp/webhook.js`.
- **Risk if ignored:** first viral moment = silent failures.
- **Owner:** me.
- **Effort:** 1 day load test + 2 days observability hardening.

### 4. Google Sheets reliability — **78**
- **Why:** per-tenant token write path verified offline. Drive.file scope only. `sanitizeForSheet` blocks formula injection. -22 because some sheets fail to provision on first try, and we rely on user retry.
- **Critical blocker:** none (recovery path works).
- **Quick win:** track first-attempt provision success rate via the existing launch-monitor card.
- **Deep fix:** automatic retry-with-backoff in `api/sheet/provision.js` (already has retry; needs idempotency proof).
- **Files:** `api/sheet/provision.js`, `lib/sheet-writer.js`.
- **Risk if ignored:** ok — admin can manually re-provision today.
- **Owner:** me.
- **Effort:** half day metric + 1 day idempotency.

### 5. Multi-business tabs — **70**
- **Why:** PR #35 added per-business TABS in same spreadsheet (not separate sheets). PR #36 owner-gated the route. PR #32 added naming. -30 because **the `מאזן חברה` aggregator currently only sums `תנועות`, not per-biz tabs** — so once a user creates עסק 2, the company dashboard won't include עסק 2's data.
- **Critical blocker:** YES for any multi-biz user — known gap tracked in `docs/FINANCIAL_QA_CHECKLIST.md`.
- **Quick win:** docs warning in the bot reply when user creates עסק 2 ("דשבורד חברה כרגע סוכם רק מתנועות הראשי").
- **Deep fix:** extend dashboard aggregation to sum across all biz tabs (touches `bot/personal_sheet_fix.gs`).
- **Files:** `bot/personal_sheet_fix.gs` (RECOMPUTE_COMPANY_DASHBOARD), `bot/ExpenseBot_FIXED.gs` (_writeBusinessNExpense_).
- **Risk if ignored:** multi-biz users see incorrect company totals.
- **Owner:** me.
- **Effort:** 2 hours warning text + 2 days aggregation rewrite.

### 6. Sheet link reliability — **75**
- **Why:** PR #209 fixed tenants seeing owner's sheet (was a leak). `/גיליון` returns tenant's own sheet now. PR #44 doesn't break it. -25 because **no admin button to re-issue a broken link** (gap from sprint v1).
- **Critical blocker:** none — manual re-provision works.
- **Quick win:** add "Re-issue sheet link" button to `/admin/launch-monitor.html` recent-signups card.
- **Deep fix:** automatic broken-link detection cron + auto-heal.
- **Files:** `admin/launch-monitor.html`, `api/admin/resend-welcome.js`.
- **Risk if ignored:** every broken-link case becomes a manual Steven ticket.
- **Owner:** me.
- **Effort:** half day button + 2 days auto-heal.

### 7. Financial formula accuracy — **70**
- **Why:** PR #42 (emoji-prefix fix) merged. PR #38 (validator) ready to merge. `bot/test_marketing_formula.js` 27/27 passes. -30 because **Steven hasn't yet run `AUDIT_COMPANY_DASHBOARD` on his actual sheet** and confirmed zero mismatches. Until that runs, this score is theoretical.
- **Critical blocker:** YES — run validator, confirm zero mismatches, document the result.
- **Quick win:** Steven merges PR #38, opens Apps Script editor, runs `AUDIT_COMPANY_DASHBOARD`, sends screenshot.
- **Deep fix:** automate the audit via daily cron (PR #14 was related, currently DIRTY — could be cleaned up).
- **Files:** `bot/personal_sheet_fix.gs`, `docs/FINANCIAL_QA_CHECKLIST.md`.
- **Risk if ignored:** wrong totals shown to user = product is worthless.
- **Owner:** Steven runs, me reviews.
- **Effort:** 1 minute to run + half day to wire daily cron.

### 8. Dashboard UX — **78**
- **Why:** `/dashboard` works, chips visible after PR #213, YoY comparison shipped, custom categories UI shipped. -22 because chart overflow on mobile landscape + onboarding checklist removed in #174.
- **Critical blocker:** none.
- **Quick win:** mobile-landscape chart constraint (`max-width: 100vw`).
- **Deep fix:** dashboard tour widget v2 (lightweight, no popups).
- **Files:** `dashboard.html`.
- **Risk if ignored:** mobile users get a cramped first impression.
- **Owner:** me.
- **Effort:** 1 hour mobile fix + 1 day tour widget.

### 9. Admin console — **80**
- **Why:** Google-OAuth gate (PR #33), XSS escape (PR #33), launch-monitor with funnel + signups + bot-version + config-drift cards, MRR dashboard. -20 because **no admin actions** for re-provision or complaint-management (gaps from v1).
- **Critical blocker:** none — admin can see issues; resolution is manual.
- **Quick win:** wire re-provision button (gap #6 above) + add "mark resolved" to user-report list.
- **Deep fix:** unified admin inbox v2 with one-click actions on every signal.
- **Files:** `admin.html`, `admin/launch-monitor.html`, new `api/admin/mark-report-resolved.js`.
- **Risk if ignored:** admin work scales linearly with user count.
- **Owner:** me.
- **Effort:** 1 day quick win + 3 days deep fix.

### 10. Payment / subscription — **60**
- **Why:** code in place (PayPal subscribe, annual toggle, Green Invoice, dunning emails, cancel flow). -40 because **never live-tested with a real PayPal sandbox account**. Pure code-correctness, zero behavioral verification.
- **Critical blocker:** YES for launching paid plans. OK for free-tier launch.
- **Quick win:** Steven runs one PayPal sandbox subscribe → entitlement flip → cancel → re-subscribe cycle.
- **Deep fix:** automated PayPal webhook handler test using PayPal's sandbox tooling.
- **Files:** `api/billing/*`, `api/billing/invoice.js`, `lib/entitlements.js`.
- **Risk if ignored:** real money flows untested; revenue at risk.
- **Owner:** Steven runs, me investigates failures.
- **Effort:** 30 min sandbox test + 2 days webhook tests.

### 11. Mobile experience — **70**
- **Why:** viewport meta on all pages, RTL default, Rubik display, dark-bg parity (PR #44), PWA install. -30 because **no live phone walk-through** has been done since v1 sprint.
- **Critical blocker:** none.
- **Quick win:** Steven does 15-min phone walk-through on iPhone SE 320px; I capture findings.
- **Deep fix:** lighthouse mobile audit run on every PR.
- **Files:** all `*.html`.
- **Risk if ignored:** Israeli market is mobile-first; bad mobile UX = no users.
- **Owner:** Steven walks, me fixes.
- **Effort:** 15 min walk + 1 day fixes.

### 12. Security / privacy — **82**
- **Why:** tenant isolation verified (PR #36), timing-safe secret compare (PR #25), PII redaction (PR #26), HSTS + CSP, drive.file scope, admin OAuth gate, `KFL_DISABLE_BOT_WRITES` kill switch. -18 because **per-tenant LLM cost cap missing** (HIGH security finding, deferred) and **21 legal-audit findings unapplied** out of 25.
- **Critical blocker:** none for personal data leak; cost-abuse is operational risk.
- **Quick win:** apply the next 5 legal-audit findings.
- **Deep fix:** per-tenant LLM spend ledger in KV with daily cap.
- **Files:** `api/learn.js`, `lib/llm-router.js`, new `lib/cost-ledger.js`.
- **Risk if ignored:** one abusive user could rack up huge LLM bill.
- **Owner:** me.
- **Effort:** 1 day legal fixes + 3 days cost cap.

### 13. QA coverage — **85**
- **Why:** 111/111 offline tests pass, golden-set 200 expenses, bank parser tests for 4 banks, marketing-formula tests, isolation tests. -15 because **zero live e2e tests in CI** (mentioned in v1, unchanged).
- **Critical blocker:** none for offline correctness.
- **Quick win:** add `tests/test_onboarding_flow.js` (Group A reuse).
- **Deep fix:** Playwright suite that drives the homepage + signup against a preview Vercel deploy.
- **Files:** new `tests/playwright/*`.
- **Risk if ignored:** regressions caught only post-merge.
- **Owner:** me.
- **Effort:** half day unit add + 1 week playwright setup.

### 14. SEO — **72**
- **Why:** schemas on public pages, 5 new Hebrew articles, sitemap + robots.txt, OG images. -28 because **legal audit flagged some article claims as false/exaggerated**.
- **Critical blocker:** none for traffic; legal liability if false claims persist.
- **Quick win:** review the 5 Hebrew articles, edit any false claims.
- **Deep fix:** content-accuracy pipeline (someone reads every article before publish).
- **Files:** `blog/*.html`, `docs/LEGAL_AUDIT_2026-05-26.md`.
- **Risk if ignored:** consumer-protection complaint at worst.
- **Owner:** Steven reviews tone, me fixes claims.
- **Effort:** 1 hour per article × 5 = half day.

### 15. Monitoring / admin alerts — **80**
- **Why:** launch-monitor + KV watchdog + multi-writer alert + KV ≥80% usage + error-to-Steven DM + bot heartbeat + daily Steven digest. -20 because **alerts go to one place (Steven)** — no PagerDuty-style escalation.
- **Critical blocker:** none for current scale.
- **Quick win:** add Slack webhook fallback so alerts have two channels.
- **Deep fix:** uptime-monitoring service (UptimeRobot or similar).
- **Files:** `api/admin/*`, `lib/alert.js`.
- **Risk if ignored:** Steven's phone dies = silent outage.
- **Owner:** me.
- **Effort:** 2 hours Slack + 1 day uptime service integration.

### 16. Scalability to 1,000 users — **55**
- **Why:** Vercel auto-scales serverless. KV (Upstash) has free-tier limits. Per-tenant Sheets API quota tracked (PR #127). -45 because **KV monthly budget will blow at ~500 active users** (Steven declined paid Upstash per #65), and **no per-tenant LLM cap** means cost explosion possible.
- **Critical blocker:** YES at >500 active users.
- **Quick win:** estimate per-user KV ops/day; project against Upstash free tier.
- **Deep fix:** upgrade Upstash to paid tier OR move hot keys to in-memory caching with cron-flush.
- **Files:** `lib/kv.js`, `api/cron/kv-monitor.js`.
- **Risk if ignored:** product breaks the moment it works.
- **Owner:** Steven (decision on Upstash tier) + me (implementation).
- **Effort:** 1 day projection + 1 day caching layer.

### Score summary (sorted, worst-first)

| Rank | Area | Score |
|------|------|-------|
| 1 (worst) | Scalability to 1,000 users | 55 |
| 2 | Payment / subscription | 60 |
| 3 | Multi-business tabs | 70 |
| 3 | Financial formula accuracy | 70 |
| 3 | Mobile experience | 70 |
| 6 | SEO | 72 |
| 7 | Bot onboarding | 75 |
| 7 | Sheet link reliability | 75 |
| 9 | Homepage conversion | 78 |
| 9 | Google Sheets reliability | 78 |
| 9 | Dashboard UX | 78 |
| 12 | Bot reliability | 80 |
| 12 | Admin console | 80 |
| 12 | Monitoring / alerts | 80 |
| 15 | Security / privacy | 82 |
| 16 (best) | QA coverage | 85 |

**Average: 72 / 100.**

---

## F. Critical Launch Blockers

### A. Must fix before real users (5 items)
1. **Steven runs `AUDIT_COMPANY_DASHBOARD`** (after merging PR #38) → confirms 0 mismatches → screenshot.
2. **Live signup smoke test** on burner Google account (Flow 1).
3. **Multi-biz dashboard warning** in bot reply (gap #5 — quick-win text).
4. **Per-tenant LLM cost cap** (security gap, area #12 / #16).
5. **Mobile walk-through** (area #11 — 15 min Steven, ≤1 day fixes).

### B. Should fix before paid users (4 items)
6. **Live PayPal sandbox test** (area #10 critical blocker).
7. **Admin re-provision button** (area #6 + #9 quick wins).
8. **Onboarding tests + welcome rewrite port** (area #2 quick + deep wins).
9. **Apply next 10 legal-audit findings** (area #12 + #14).

### C. Can wait until after launch (4 items)
10. **Multi-biz dashboard aggregation rewrite** (deep fix, area #5).
11. **Per-tenant LLM ledger deep fix** (after the cap quick win lands).
12. **A/B framework first experiment** (area #1 deep fix).
13. **Playwright e2e suite** (area #13 deep fix).

### D. Experimental / later (3 items)
14. **Household mode v2** (closed PR #15 — needs design-first).
15. **Local-learning memory** (closed PR #17 pivot — needs scoped PR).
16. **Auto-heal broken sheet links** (area #6 deep fix).

**Total: 16 items. Group A is the launch gate.**

---

## G. QA Results — 5 Real Product Flows

### Flow 1 — New user

| Step | Code path | Verdict |
|------|-----------|---------|
| Landing → /account | `account.html` | ✅ GREEN code |
| Google sign-in | `api/auth/google.js` | ✅ GREEN code; **UNVERIFIED LIVE** |
| Sheet provision | `api/sheet/provision.js` | ✅ Offline tests pass |
| Phone link via code | `api/whatsapp/link.js` | ✅ Offline tests pass |
| Send "50 קפה" | `bot/ExpenseBot_DEPLOY.gs` | ✅ GREEN code; **UNVERIFIED LIVE** |
| Row appears in own sheet | `lib/sheet-writer.js` | ✅ Isolation test passes |
| Sheet link opens | `api/whatsapp/send.js` reply | ✅ GREEN code |
| Dashboard updates | `/dashboard` polls `/api/sheet/getExpenses` | ✅ GREEN code |
| Admin updates | `/admin/launch-monitor` shows new signup | ✅ Endpoint exists |

**Verdict: GREEN-code, UNVERIFIED-LIVE.** Single 10-min Steven test on a burner closes this.

### Flow 2 — Existing user

| Step | Verdict |
|------|---------|
| Second expense → bot | ✅ Same path as Flow 1 |
| Categorization | ✅ Classifier offline tests pass (200-item golden set) |
| Writes to correct sheet/tab | ✅ Tenant write path verified |
| Confirmation sent | ✅ First-expense celebration shipped (PR #109) |
| No duplicate | ✅ Idempotency via row hash in `lib/sheet-writer.js` |

**Verdict: ✅ ALL GREEN.** Highest-confidence flow.

### Flow 3 — Multi-business user

| Step | Verdict |
|------|---------|
| `פתח עסק חדש <name>` | ✅ Shipped PR #32 |
| New TAB in same spreadsheet | ✅ Shipped PR #35 |
| Owner-gated route | ✅ Shipped PR #36 |
| `עסק 2 50 קפה` routes to right tab | ✅ Code verified |
| No data mixing | ✅ Tenant isolation tests pass |
| **`מאזן חברה` aggregates correctly** | ❌ **BROKEN** — only sums `תנועות`, not biz tabs |

**Verdict: ⚠️ PARTIAL.** Multi-biz routing works; aggregation lies. **This is the multi-biz launch blocker** (Group A #3).

### Flow 4 — Broken sheet link

| Step | Verdict |
|------|---------|
| User reports broken link | ⚠️ Logged to `/api/log/user-report` but no UI list |
| Admin sees it | ⚠️ Endpoint exists, no surfaced view |
| One-click resend welcome | ✅ Button exists |
| One-click re-provision | ❌ Endpoint exists, no admin-UI button |
| User receives new link | ✅ Same path as new-user welcome |

**Verdict: ⚠️ PARTIAL.** Recovery possible but requires Steven to manually call APIs. **Quick-win in Group B #7.**

### Flow 5 — Payment

| Step | Verdict |
|------|---------|
| `/pricing` loads | ✅ Page works |
| PayPal subscribe | ✅ Code in place; **UNVERIFIED LIVE** |
| Entitlement flips to `pro` | ✅ Offline `computeEntitlement` logic verified |
| Admin sees payment | ✅ Revenue dashboard exists (PR #150) |
| Bot honors pro features | ✅ Premium data-query path gates on entitlement |
| Cancel flow | ✅ `/cancel` + retention offer (PR #105) |
| Refund / dunning | ✅ Code in place; **UNVERIFIED LIVE** |
| Green Invoice generation | ✅ Code in place; **UNVERIFIED LIVE** |

**Verdict: GREEN-code, UNVERIFIED-LIVE.** 30-min Steven sandbox test closes this.

### QA roll-up

| Flow | Code | Live | Blocker? |
|------|------|------|----------|
| 1. New user | GREEN | UNVERIFIED | Group A #2 |
| 2. Existing user | GREEN | (via #1) | — |
| 3. Multi-biz | PARTIAL | UNVERIFIED | Group A #3 |
| 4. Broken link recovery | PARTIAL | (depends on admin) | Group B #7 |
| 5. Payment | GREEN | UNVERIFIED | Group B #6 |

---

## H. Financial Formula Results

### Test dataset (Steven-provided)
| # | Message | Expected bucket | Expected ILS |
|---|---------|-----------------|--------------|
| 1 | `500 שיווק` | עלות שיווק | +500 |
| 2 | `1200 פייסבוק` | עלות שיווק | +1,200 |
| 3 | `800 Google Ads` | עלות שיווק | +800 |
| 4 | `1500 קמפיין` | עלות שיווק | +1,500 |
| 5 | `99 Canva` | עלות שיווק | +99 |
| 6 | `245 סופר` | personal — NOT in dashboard | (excluded) |
| 7 | `1800 שכירות` | personal — NOT in dashboard | (excluded) |
| 8 | `350 חשמל` | personal — NOT in dashboard | (excluded) |
| 9 | `+3000 הכנסה מלקוח` | מחזור ברוטו (revenue) | +3,000 |
| 10 | `220 דלק` | personal — NOT in dashboard | (excluded) |

### Expected aggregates (current month)
| Bucket | Expected |
|--------|----------|
| 📣 עלות שיווק | **₪4,099** (500+1,200+800+1,500+99) |
| 💰 מחזור ברוטו | **₪3,000** |
| 🏢 הוצאות תפעוליות | ₪0 (none in dataset) |
| 🎨 עלות חומרי גלם | ₪0 |
| 🚚 משלוחים והתקנות | ₪0 |
| **רווח נטו** | **3,000 − 4,099 = ₪−1,099** |
| **אחוז רווחיות** | **(−1,099 / 3,000) × 100 = −36.6%** |

### Verification mechanism
- **Offline:** `bot/test_marketing_formula.js` already covers the bucket classification for these 10 messages — 27/27 pass.
- **Live:** Steven sends the 10 messages → opens `מאזן חברה` → runs `AUDIT_COMPANY_DASHBOARD` → expects 0 mismatches.

### Status
**UNVERIFIED LIVE.** Action is in Group A #1.

### Critical failure modes the audit catches
1. **Income leaking into marketing** (e.g. `+3000 שיווק` counted as cost — caught by H column check).
2. **Personal leaking into company** (e.g. `245 סופר` if cat=עסק bug — caught by category check).
3. **Wrong year scoping** (cross-year leak — caught by per-block year filter).
4. **Double-counting** (row matches both sub and desc — caught by SUMPRODUCT semantics).

---

## I. Admin CEO Dashboard — 10 Questions

| # | Question | Where it's answered | Verdict |
|---|----------|--------------------|---------| 
| 1 | How many users do we have? | `/admin/launch-monitor` recent-signups card | ✅ |
| 2 | How many are active? | `/admin/launch-monitor` → bot-version + heartbeat per user | ⚠️ Indirect — need a real "active in last 7d" stat |
| 3 | How many are paying? | `/admin/revenue.js` MRR card | ✅ |
| 4 | How much money are we making? | `/admin/revenue.js` MRR card | ✅ |
| 5 | Who is stuck? | `/admin/launch-monitor` funnel-summary | ⚠️ Shows funnel drop-off, not per-user "stuck" list |
| 6 | Which users have no sheet? | `/admin/recent-signups` flags `no_sheet` state | ✅ |
| 7 | Which users have broken links? | `/api/log/user-report` raw log only | ❌ No UI surface |
| 8 | Which bot messages failed? | `/api/admin/launch-monitor` `bot_errors` count | ⚠️ Aggregated count, no per-message detail |
| 9 | Which payments need approval? | `/admin/billing/*` not surfaced as a card | ❌ |
| 10 | What should I fix today? | None — there's no "top issues" view | ❌ |

**Score: 4 ✅, 4 ⚠️, 2 ❌.** Admin answers half the CEO questions cleanly.

**Recommended quick wins:**
- Add "Active last 7d" card (1 KV scan + count) → fixes #2.
- Add "User reports" list to launch-monitor → fixes #7.
- Add "Today's top 3 issues" computed card → fixes #10.
- Estimated effort: 1 day total.

---

## J. Next 15 Tasks (Execution Board)

> Strict limit: 15 tasks. No 50-task lists.

### Tier 1 — Launch gate (do this week)

| # | Task | Area | Priority | Impact | Risk | Files | Acceptance | Tests | PR size | Blocks launch? |
|---|------|------|----------|--------|------|-------|------------|-------|---------|---------------|
| 1 | Steven runs `AUDIT_COMPANY_DASHBOARD` | Financial | P0 | Trust | LOW | (sheet only) | Screenshot 0 mismatches | (validator self-tests) | 0 LOC | YES |
| 2 | Live signup smoke test on burner | E2E | P0 | Trust | LOW | live | One real user reaches first expense | manual | 0 LOC | YES |
| 3 | Multi-biz dashboard warning text | Bot | P0 | Trust | LOW | `bot/ExpenseBot_FIXED.gs` | Bot replies warning on `פתח עסק חדש` | unit | 2 files | YES |
| 4 | Per-tenant LLM cost cap (ledger only) | Security | P0 | Cost | MED | new `lib/cost-ledger.js` + `api/learn.js` | KV daily key + abort on cap | unit + isolation | 3-5 files | YES |
| 5 | Live PayPal sandbox test | E2E | P0 | Revenue | LOW | live | One sandbox sub → pro → cancel cycle | manual | 0 LOC | YES |

### Tier 2 — Should-fix (this week if Tier 1 done)

| # | Task | Area | Priority | Impact | Risk | Files | Acceptance | Tests | PR size | Blocks launch? |
|---|------|------|----------|--------|------|-------|------------|-------|---------|---------------|
| 6 | Admin re-provision button | Admin | P1 | Recovery | LOW | `admin/launch-monitor.html`, `api/admin/create-sample-sheet.js` | Click button → sheet provisions for user | manual | 2 files | No (B) |
| 7 | Port welcome rewrite from #21 | Bot | P1 | UX | LOW | `bot/ExpenseBot_FIXED.gs`, `bot/ExpenseBot_DEPLOY.gs` | Welcome message matches design | unit | 2 files | No (B) |
| 8 | Apply next 5 legal-audit findings | Legal | P1 | Liability | LOW | `privacy.html`, `terms.html`, blog | 5 false claims removed/corrected | manual review | 5-8 files | No (B) |
| 9 | Mobile walk-through + fixes | Mobile | P1 | UX | LOW | various `.html` | All 8 top pages pass iPhone SE test | manual | TBD | No (B) |
| 10 | Add "Active last 7d" admin card | Admin | P1 | Visibility | LOW | new `api/admin/active-users.js`, `admin/launch-monitor.html` | Card shows count | unit | 2 files | No (B) |

### Tier 3 — Nice-to-have (next sprint)

| # | Task | Area | Priority | Impact | Risk | Files | Acceptance | Tests | PR size | Blocks launch? |
|---|------|------|----------|--------|------|-------|------------|-------|---------|---------------|
| 11 | Multi-biz aggregation rewrite | Sheet | P2 | Trust | MED | `bot/personal_sheet_fix.gs` | Company dashboard sums all biz tabs | unit + validator | 1 file | No (C) |
| 12 | Add user-reports list to admin | Admin | P2 | Recovery | LOW | new `admin/user-reports.html` | List rendered, mark-resolved works | unit | 2 files | No (C) |
| 13 | Onboarding flow test suite | QA | P2 | Coverage | LOW | new `tests/test_onboarding_flow.js` | Q1-Q4 + first-expense covered | self | 1 file | No (C) |
| 14 | Local-learning per-user memory v1 | Bot | P2 | Quality | MED | `bot/ExpenseBot_FIXED.gs`, new `api/learn-user.js` | Per-user correction persists | unit + isolation | 3-4 files | No (D) |
| 15 | Slack alert fallback | Monitoring | P2 | Resilience | LOW | `lib/alert.js` | Alert reaches Slack + WhatsApp | manual | 1 file | No (C) |

**Recommended order:** 1 → 2 → 5 → 3 → 4 → (Tier 1 complete = launch gate clear) → 6 → 7 → 8 → 9 → 10 → (Tier 2 complete = solid launch) → 11 → 12 → 13 → 14 → 15.

---

## K. What I Need From You

### Right now (next 30 min)
1. **Merge PR #45** (status removal) — small, no risk.
2. **Merge PR #44** (hero live demo + dark-bg) — small, no risk.
3. **Merge PR #38** (financial validator) — now MERGEABLE after rebase, read-only Apps Script.

### Today (next 2 hours)
4. **Paste latest `bot/personal_sheet_fix.gs`** into your Apps Script editor → Save → run `AUDIT_COMPANY_DASHBOARD` → screenshot the log.
5. **Burner signup test:** open `kesefle.com/account` in private window, sign in with a burner Google account, walk to first expense. Report what breaks (if anything).

### This week
6. **PayPal sandbox subscribe test** (Flow 5).
7. **Decide on Upstash:** stay free → I implement caching layer (Tier 3 #15 style); pay → I document the tier we need.
8. **Mobile walk-through** (15 min on iPhone SE).

### Decision points (no time pressure but blocks Tier 2)
9. **Welcome rewrite port:** approve me extracting the 2-file delta from closed PR #21 as a small clean PR (Tier 2 #7)?
10. **Multi-biz warning text:** I'll draft 3 options for the bot reply text — pick one (Tier 1 #3).

---

## Appendix — Doc inventory after this sprint

| Doc | Purpose | Latest |
|-----|---------|--------|
| `docs/SPRINT_LAUNCH_READINESS_2026-05-26.md` | v1 sprint readiness | 2026-05-26 morning |
| `docs/LAUNCH_READINESS_V2_2026-05-26.md` | **v2 (this doc)** | 2026-05-26 afternoon |
| `docs/FINANCIAL_QA_CHECKLIST.md` | Per-metric semantic formulas + invariants | PR #38 (pending merge) |
| `docs/LEGAL_AUDIT_2026-05-26.md` | 25 findings (4 applied, 21 open) | 2026-05-26 |
| `docs/QA_REPORT_2026-05-26.md` | Earlier QA snapshot | 2026-05-26 |
| `docs/SHEET_FORMULAS.md` | Sheet architecture reference | 2026-05-26 |

---

*Generated 2026-05-26. Single source of truth for the next 7 days. Re-score weekly until score ≥ 90.*
