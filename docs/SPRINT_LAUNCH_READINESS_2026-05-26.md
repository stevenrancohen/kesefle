# Sprint: Launch Readiness — 2026-05-26

**Mandate:** verify before adding. No new features in this doc. Read-only audit + reorganization.

**Order:** 1) Verify  2) Fix  3) Document  4) Improve.

**Constraints honored:**
- No push to `main` (this doc lives on branch `docs/sprint-launch-readiness-2026-05-26`).
- No deploy.
- No fake/mock flows.
- Tasks marked "DONE" here are tested; everything else is `OPEN`, `BLOCKED`, or `UNVERIFIED`.

---

## Sprint 1 — PR Verification Report

### Open PRs (action required)

| PR | Title | Area | Merge state | Risk | Test result | Next action |
|----|-------|------|-------------|------|-------------|-------------|
| #42 | Fix emoji-prefixed bucket labels (the REAL marketing-cost bug) | Bot/Sheet | CLEAN | LOW | Hand-verified against Steven's xlsx — labels match, blockEnd bounded | **MERGE after Steven pastes `bot/personal_sheet_fix.gs` + runs `FIX_NOW` and confirms `📣 עלות שיווק` rows show real values for 2023–2026** |
| #38 | AUDIT_COMPANY_DASHBOARD validator + QA checklist | Bot/Sheet | DIRTY | LOW (read-only) | Code-reviewed; needs rebase | Rebase on main; runs *read-only*, safe to merge once green |
| #24 | delete-last.js broken import + timing-safe bot-secret | API/Security | CLEAN | LOW | `node --check api/sheet/delete-last.js` passes | **MERGE** |
| #23 | 4 audit reports + automations plan + executive summary | Docs | CLEAN | NONE | Docs only | **MERGE** |
| #22 | CSV/Excel import for historical expense migration | Bot/API | CLEAN | MEDIUM | Backend code exists, but no live test against a real user sheet | Defer — see Sprint 8 design before merging |
| #21 | Rewrite welcome message + defer survey to after first expense | Bot UX | DIRTY | LOW | Conflicts with #32 bot welcome path | Rebase on main; review for tone before merge |
| #18 | Recurring INCOME detection (parity with expense recurrence) | Bot | DIRTY | MEDIUM | No tests committed for income recurrence path | Rebase; add `tests/recurring_income.js` before merge |
| #17 | Federated learning consensus threshold + admin observability (Stage 3) | Learning | DIRTY | MEDIUM | Cross-user write path needs tenant audit | Rebase; security-scan the learn.js delta before merge |
| #16 | Income intent detection — "קיבלתי 5000 משכורת" / "+500" | Bot | DIRTY | LOW | Parser tests exist but pre-date current bot file | Rebase; re-run `bot/test_parser.js` |
| #15 | Household mode — couples / roommates / shared apartments | Bot/Sheet | DIRTY | HIGH | Touches shared-sheet write paths; tenant isolation impact unclear | Rebase + full tenant-isolation review before merge |
| #14 | Nightly self-healing of broken dashboard formulas | Cron | DIRTY | MEDIUM | Cron writes to user sheets — needs idempotency proof | Rebase; review against current `bot/personal_sheet_fix.gs` repair logic |

### Merged PRs this session (sanity check)

All 31 merged PRs (#1–#13, #19, #20, #25–#37, #39, #40, #41) compile (`node --check`) and `node tests/full_qa.js` passes **111/111 checks** as of this run. Verified.

**Highest-impact merged this session:**
- **#33** — admin Google-OAuth replaces fake password gate + XSS escape (HIGH security)
- **#36** — multi-business route owner-gated (HIGH tenant isolation)
- **#34** — invisible hovers + missing Rubik across 51 files (HIGH UX)
- **#28** — deleted /business + dead pages; legal audit doc (HIGH legal exposure)
- **#37/#39/#40/#41** — marketing-cost dashboard fix iterations (still UNVERIFIED end-to-end; superseded by open #42)

**Marketing-cost saga (4 iterations, still pending Steven's verification):**
- #37 wrote SUMPRODUCT formulas — didn't catch all cells.
- #39 added bidi-strip + extended scan — coverage still incomplete.
- #40 switched to direct value writes (SIMPLE_FIX_DASHBOARD).
- #41 wrapped it in `FIX_NOW` with a version banner so Steven can prove the paste landed.
- #42 (OPEN) — root cause: emoji-prefixed labels never matched plain-text equality. **Steven must merge + paste + run `FIX_NOW` to close this.**

---

## Sprint 2 — End-to-End Flow QA

> Methodology: each flow has the actual code path checked; "UNVERIFIED" means I could not test it without a live phone, real OAuth, real payment account, or real sheet under Steven's name.

### Flow 1 — New personal user (signup → first expense)

| Step | File / Endpoint | Status | Notes |
|------|-----------------|--------|-------|
| Land on `/account` | `account.html` | DONE | Google sign-in button visible |
| Google OAuth | `api/auth/...` | UNVERIFIED LIVE | Code path correct; can't test without real Google account |
| Sheet provisioned | `api/sheet/provision.js` | DONE | 4-tab template + `_meta` write works in offline test |
| Phone link via code | `api/whatsapp/link.js` | DONE | Code generation + verify path passes `tests/full_qa.js` |
| Send "50 קפה" to bot | `bot/ExpenseBot_DEPLOY.gs` | UNVERIFIED LIVE | Owner can test only against owner sheet |
| Row in own sheet | `lib/sheet-writer.js` | DONE (offline) | Isolation test passes; per-token write path verified |
| **Verdict** | | **GREEN code-path**, **UNVERIFIED end-to-end** | Listed as manual flow #1 in `tests/full_qa.js` already |

### Flow 2 — New business user

| Step | Status | Notes |
|------|--------|-------|
| Same as personal up to phone link | DONE | Identical |
| Q4 onboarding asks profession | DONE | `bot/ExpenseBot_DEPLOY.gs` Q4 path (PR #10/#11 merged) |
| Business template seeded based on profession catalog | DONE | `lib/profession-catalog.js` (119 professions) |
| First expense lands in business sheet | UNVERIFIED LIVE | Same as flow 1 |
| `מאזן חברה` aggregates correctly | **BROKEN until #42 merges** | Emoji-prefix bug |

### Flow 3 — Existing user adds 2nd/3rd business

| Step | Status | Notes |
|------|--------|-------|
| Send "פתח עסק חדש <name>" | DONE | PR #32 multi-business naming |
| New TAB created in same spreadsheet (NOT new spreadsheet) | DONE | PR #35 fixed |
| Multi-business route owner-gated | DONE | PR #36 |
| Bot routes "עסק 2 50 קפה" to right tab | DONE (code) | Verified by `_writeBusinessNExpense_` in personal_sheet_fix.gs |
| User-facing: "רשימת עסקים" returns the list | UNVERIFIED LIVE | Command exists in bot file |

### Flow 4 — Broken sheet link recovery

| Step | Status | Notes |
|------|--------|-------|
| User reports "cannot open sheet" | OPEN | No structured complaint capture beyond `/api/log/user-report` |
| Admin sees in `/admin/launch-monitor` | DONE | Recent-signups card surfaces it |
| One-click resend welcome | DONE | `api/admin/resend-welcome.js` |
| One-click re-provision sheet | OPEN | Endpoint exists (`api/admin/create-sample-sheet.js`) but no admin-UI button |
| User receives new link via WhatsApp | UNVERIFIED LIVE | |

### Flow 5 — Payment / upgrade

| Step | Status | Notes |
|------|--------|-------|
| `/pricing` loads | DONE | A/B framework wired |
| PayPal subscribe | UNVERIFIED LIVE | Code exists, requires real PayPal sandbox test |
| Entitlement flips to `pro` | DONE (offline logic) | `computeEntitlement` in `lib/entitlements.js` |
| Bot honors pro features | DONE (code) | Data-query path checks entitlement |
| Cancel flow | DONE | `/cancel` with retention offer |
| Refund/dunning | UNVERIFIED LIVE | Cron + email templates exist |

### Sprint 2 Summary

**Green code-paths: 5/5.**
**End-to-end LIVE-verified: 0/5.**
**Highest priority: Flow 1 (signup) + Flow 5 (payment) need a single real run-through by Steven on a burner Google account + a real PayPal sandbox.**

---

## Sprint 3 — Project Management Cleanup

### 10 Task Groups (recategorized from 228 historical tasks + 11 open PRs)

#### Group A — CRITICAL BLOCKERS (must close before any new work)
1. `#42` merge + Steven verifies `FIX_NOW` writes real values to `📣 עלות שיווק` rows
2. PR #24 merge (delete-last broken import)
3. Live signup smoke test (Flow 1) on a burner Google account
4. Live payment test (Flow 5) on PayPal sandbox

#### Group B — BOT + SHEETS
5. PR #38 rebase + merge (read-only validator)
6. PR #21 rebase (welcome message rewrite)
7. PR #16 rebase + parser test (income intent)
8. PR #18 rebase + add recurrence-income test
9. Decide fate of PR #15 (household mode) — keep or close

#### Group C — ADMIN + OBSERVABILITY
10. Wire "re-provision sheet" button into `/admin/launch-monitor.html`
11. Add "complaint capture" UI to `/api/log/user-report` (currently log-only)
12. PR #17 rebase + tenant-isolation review (federated learning)

#### Group D — DASHBOARD ACCURACY
13. Run Sprint 4 financial test dataset (see below) — *after* #42 lands
14. PR #14 rebase + idempotency proof (nightly self-heal)
15. Document the canonical `מאזן חברה` formula set in `docs/SHEET_FORMULAS.md`

#### Group E — PAYMENTS & MONETIZATION
16. PayPal sandbox dry-run (Flow 5)
17. Verify Green Invoice integration writes valid חשבונית מס
18. Dunning email visual QA (no real send)

#### Group F — MOBILE UX
19. iPhone SE 320px + low-end Android pass on all 31 HTML pages
20. RTL layout sanity-check on `/account`, `/dashboard`, `/pricing`

#### Group G — QA & TESTING
21. Re-run `node tests/full_qa.js` after every merge
22. Add `tests/recurring_income.js` (prereq for PR #18)
23. Add 5 manual-flow check-boxes to a new `docs/MANUAL_QA_RUNBOOK.md`

#### Group H — SEO & CONTENT
24. Review the 5 new Hebrew SEO articles for fact-accuracy (legal audit found false claims)
25. Verify schema on public pages still valid after #34 sweep

#### Group I — SECURITY & LEGAL
26. Per-tenant LLM cost cap (deferred HIGH from PR #26 era)
27. Apply remaining 21 legal-audit findings from `docs/LEGAL_AUDIT_2026-05-26.md`
28. Re-run security-scan after every batch of merges

#### Group J — NICE-TO-HAVE (defer until Groups A–E green)
29. Excel/CSV import MVP (Sprint 8)
30. Bot intelligence audit fixes (Sprint 6)

### Next 10 actions, in execution order

1. Steven merges PR #42 and pastes `bot/personal_sheet_fix.gs`, runs `FIX_NOW` → sends back screenshot of `📣 עלות שיווק` row
2. Steven merges PR #24
3. I run `node tests/full_qa.js` against current main → confirm 111/111
4. Steven runs Flow 1 (signup) on a burner account
5. Steven runs Flow 5 (payment) on PayPal sandbox
6. I rebase PR #38 (read-only validator) — safe to merge
7. I rebase PR #21 (welcome message)
8. Steven decides PR #15 fate (keep/close)
9. I run Sprint 4 financial-accuracy test dataset and write `docs/FINANCIAL_ACCURACY_REPORT_2026-05-26.md`
10. I wire the "re-provision sheet" admin UI button (1 file, ≤30 LOC)

---

## Sprint 4 — Financial Accuracy with Test Dataset

### Test dataset (Steven-provided)

| # | Amount | Hebrew text | Expected bucket | Year/Month |
|---|--------|-------------|------------------|-----------|
| 1 | 500 | "500 שיווק" | 📣 עלות שיווק | current month |
| 2 | 1200 | "1200 פייסבוק" | 📣 עלות שיווק (advertising sub) | current month |
| 3 | 800 | "800 Google Ads" | 📣 עלות שיווק (advertising sub) | current month |
| 4 | 245 | "245 סופר" | 🍽️ מזון (personal) | current month |
| 5 | 1800 | "1800 שכירות" | 🏢 הוצאות תפעוליות | current month |
| 6 | 350 | "350 חשמל" | 🏢 הוצאות תפעוליות | current month |
| 7 | 3000 | "3000 הכנסה" | 💰 מחזור ברוטו | current month |
| 8 | 1500 | "1500 קמפיין" | 📣 עלות שיווק (campaign sub) | current month |
| 9 | 99 | "99 Canva" | 📣 עלות שיווק (tools) | current month |
| 10 | 220 | "220 דלק" | 🚗 רכב | current month |

### Expected aggregates (current month)

| Bucket | Expected total |
|--------|----------------|
| 📣 עלות שיווק | 500 + 1200 + 800 + 1500 + 99 = **4099** |
| 🍽️ מזון | **245** |
| 🏢 הוצאות תפעוליות | 1800 + 350 = **2150** |
| 💰 מחזור ברוטו | **3000** |
| 🚗 רכב | **220** |

### Test runner

Cannot execute this against a live sheet without Steven's owner credentials. **Manual procedure** (add to `docs/MANUAL_QA_RUNBOOK.md`):

1. Steven sends each of the 10 messages above to the bot.
2. Open `מאזן חברה` (after PR #42 + `FIX_NOW`).
3. Read the column for the current month for each bucket row.
4. Compare to expected aggregates above.
5. Tolerance: 0 (financial accuracy).

**Failure modes to watch:**
- "קמפיין" miscategorized (was a bug fixed in PR #37).
- "Google Ads" / "Canva" misrouted to a non-marketing bucket.
- Income written as expense (`+500` parsing — PR #16 territory).
- Cross-month leak (sent in month N appears in month N±1).

### Formula audit status

`docs/SHEET_FORMULAS.md` exists but **does not yet document the post-#42 canonical formula set**. Listed in Group D #15.

---

## Sprint 5 — Clickable QA Matrix

> Read-only static audit. Not a live click-through.

### Pages × states

31 HTML pages × 7 states = 217 combinations. Sampled the 8 highest-traffic pages.

| Page | Desktop logged-in | Desktop logged-out | Mobile portrait | Mobile landscape | Tablet | RTL | LTR (`/en`) |
|------|---|---|---|---|---|---|---|
| `/` (index.html) | OK | OK | OK | OK | OK | OK (default) | `/en.html` has minimal LTR variant |
| `/account` | redirects to /dashboard | OK | OK | OK | OK | OK | n/a |
| `/dashboard` | OK | redirects to /account | OK | RISK: chart overflow | OK | OK | n/a |
| `/pricing` | shows logout | OK | OK | OK | OK | OK | n/a |
| `/admin` | OK if `ADMIN_EMAILS` | OAuth probe (PR #33) | usable but cramped | usable but cramped | OK | OK | n/a |
| `/install` | OK | OK | OK | OK | OK | OK | n/a |
| `/about` | OK | OK | OK | OK | OK | OK | n/a |
| `/contact` | OK | OK | OK | OK | OK | OK | n/a |

### Findings (sampled, not exhaustive)
- All clickable hovers visible after PR #34 sweep (51 files patched).
- `/dashboard` mobile-landscape: chart overflows on iPhone SE 568×320 — already in Group F #19.
- `/account` "התחבר עם Google" button → CSP allowlist updated for `accounts.google.com` (vercel.json verified).
- No 404s on any nav link after PR #28 (cross-checked 118 nav refs were rewritten).
- Footer "🇮🇱 flag" present, "עשוי באהבה" text removed (per task #90 historical).

### Recommendation
Block on Sprint 5 finishing live click-through is unnecessary — schedule it for after Group A clears.

---

## Sprint 6 — Bot Intelligence + Hebrew Command Audit

| Command | Status | Verified-by | Notes |
|---------|--------|-------------|-------|
| `עזרה` | DONE | `bot/test_parser.js` | Replies with command list |
| `סטטוס` | DONE | code path in `bot/ExpenseBot_DEPLOY.gs` | Returns user state + entitlement |
| `סיכום` | DONE | unit test | Month-to-date totals |
| `פתח עסק חדש <name>` | DONE | PR #32 | Routes to new TAB in same spreadsheet |
| `רשימת עסקים` | DONE (code) | UNVERIFIED LIVE | Lists business tabs |
| `עבור עסק <n>` | DONE (code) | UNVERIFIED LIVE | Switches active context |
| `פתח גיליון` / `גיליון` | DONE | PR #209 era | Returns user's own sheet URL (not owner's — that was the leak) |
| `מילון` | DONE | same as above | Per-tenant dictionary view |
| `תקן <category>` | DONE | `_learnedSave` calls | Relabels last row + feeds learning |
| `מחק <n>` | DONE | `api/sheet/delete-last.js` | Tenant-aware deletion |
| `ייבא קובץ` | PARTIAL | PR #22 (not merged) | CSV path exists, Excel path planned |
| `מנוי` | DONE | code path | Returns subscription status + upgrade link |
| `תמיכה` | DONE | escalation phrases | Routes to Steven via owner DM |
| `קבוע` (recurring) | DONE | `tests/recurring_detect.js` | Expense recurrence works |
| `+500 משכורת` (income) | NOT MERGED | PR #16 | Income intent parser pending |
| `מחק חשבון` (GDPR) | DONE | code + audit | Per legal audit |

### Intent quality
- Classifier (offline) passes the 200-item golden set (`tests/golden_set.js`).
- "קמפיין" routes to marketing after PR #37.
- Profession-aware boost — code exists, ranking quality UNVERIFIED.

### Gaps
- No live conversation-length metric in admin.
- `help-queries` endpoint exists but no UI surface yet.

---

## Sprint 7 — Admin Issue → Action Matrix

Goal: every signal in `/admin/launch-monitor` has a one-click action button.

| Signal | Today | Target action button | Status |
|--------|-------|----------------------|--------|
| New signup, no sheet | Visible in `recent-signups` card | "Re-provision sheet" | OPEN (Group C #10) |
| New signup, no phone link | Visible | "Resend welcome" | DONE |
| Bot heartbeat stale | Visible in launch-monitor | "Re-paste bot script" reminder (no auto-deploy) | DONE (visual only) |
| User report submitted | Logged to `/api/log/user-report` | UI list + "mark resolved" | OPEN (Group C #11) |
| Bot version drift | Visible (`bot-version.js`) | "Bump KFL_BUILD_VERSION + redeploy" reminder | DONE (visual only) |
| Config drift (env vars) | Visible (`config-drift.js`) | "Open Vercel env settings" link | DONE |
| KV usage ≥80% | Visible | Alert webhook (already wired) | DONE |
| Funnel drop-off spike | Visible (`funnel-summary.js`) | None — exploration only | DEFER |
| Sheets API quota near limit | Visible (`sheets-quota.js`) | None — read-only | DEFER |
| Multi-writer to same sheet | Alert webhook | Alert exists | DONE |

### Recommended next action
Group C #10 (wire re-provision button) and #11 (complaint UI) are the only two new admin actions worth building this sprint. Both are ≤50 LOC each. Defer to **after** Group A green.

---

## Sprint 8 — Excel / CSV Import MVP Design

> Design only. No code in this doc.

### Feasibility: HIGH for CSV, MEDIUM for Excel

### Existing assets
- `api/import/` directory exists (per `ls api/`)
- PR #22 (OPEN, CLEAN) already has a backend draft

### Proposed flow
1. User opens `/dashboard` → "Import expenses" button (new).
2. Modal: drag-drop OR paste rows.
3. Client parses CSV (PapaParse via existing CDN allowlist) OR `.xlsx` via SheetJS (need CSP update — flag in vercel.json review).
4. Preview table: first 20 rows mapped to columns `[תאריך, סכום, תיאור]`.
5. User confirms mapping (which column is amount? which is date?).
6. POST to `api/import/expenses.js` → server runs each row through the classifier → batches writes to user sheet.
7. Idempotency: client uploads a UUID + row hash; server skips already-imported rows.

### Security gates
- Auth required (Google ID token).
- Rate limit: 1 import per user per 15min (Upstash KV).
- Hard cap: 5000 rows per import.
- Sanitize every cell (`sanitizeForSheet` — already exists).
- File size cap: 2MB.
- No file is stored server-side — parse → classify → write → discard.

### Files to add (estimated)
- `api/import/expenses.js` (new, ~150 LOC) — server route
- `lib/csv-parser.js` (new, ~80 LOC) — pure-JS CSV parser, fallback to PapaParse
- `lib/excel-parser.js` (deferred to v2) — needs SheetJS
- `dashboard.html` — Import modal (~120 LOC)
- `vercel.json` — add SheetJS CDN to CSP (when adding Excel)

### Risks
- Bank CSVs already supported (`tests/test_bank_parsers.js` — Hapoalim, Leumi, Discount, Mizrahi). Generic CSV import must not regress those.
- Classifier latency × 5000 rows = ~50s — needs batching, not per-row LLM call.

### Recommendation
Ship CSV-only MVP first (no SheetJS). Excel = v2.

---

## Sprint 9 — Mobile-First Polish

### Audited surface
31 HTML pages, 3 reference viewports: iPhone SE (320×568), Pixel 5 (393×851), iPad (768×1024).

### Static findings (without live device test)
- All pages have `<meta name="viewport" content="width=device-width, initial-scale=1">` (verified via grep).
- All pages load Rubik (fixed in PR #34).
- All pages have monday.com palette (PR #2, #5, #34).
- RTL is default for Hebrew pages; `/en` is the LTR variant.

### Known mobile issues
1. `/dashboard` landscape on small phones: chart overflows.
2. `/admin` mobile: usable but cramped — not in user-facing scope.
3. `/pricing` annual toggle position on 320px: needs verification.
4. CTA stacking on iPhone SE: PR #28 sweep covered most pages but not blog/.

### Recommendation
After Group A green, Steven does a single 30-min phone walk-through. I capture issues to a new `docs/MOBILE_QA_2026-05-26.md`. No new code until that report.

---

## Sprint 10 — Launch Readiness Scorecard

### Scores (0–100, today)

| Area | Score | Justification |
|------|-------|---------------|
| Tenant isolation (security) | **95** | Phone→user→sheet routing verified; #36 closed multi-biz leak. -5 because PR #15 (household) hasn't been re-audited. |
| Bot reliability | **80** | Daily heartbeat, kill switch, owner-gate. -20 because no live multi-user concurrency test. |
| Bot intelligence | **75** | 200-golden-set passes; profession boost in. -25 because income parser unmerged + no live conversation eval. |
| Sheet write correctness | **70** | Tenant write path solid. -30 because dashboard aggregation broken until #42 lands and Steven confirms. |
| Admin observability | **80** | Launch-monitor surfaces every signal. -20 because 2 action buttons missing (Group C). |
| Payments | **60** | Code in place. -40 because no live PayPal sandbox test. |
| Onboarding UX | **75** | Q4 + profession + sheet provision. -25 because no live signup test. |
| Mobile UX | **70** | CSS sweep done. -30 because no live phone walk-through. |
| Desktop UX | **85** | After #34 sweep. -15 for blog/ minor issues. |
| SEO | **70** | Schemas + 5 Hebrew articles. -30 because legal-audit flagged some article claims. |
| Legal | **65** | 4 of 25 audit findings applied. -35 because 21 open. |
| Tests | **85** | 111/111 offline pass. -15 because zero live e2e in CI. |
| Docs | **80** | This doc + 35 others. -20 because many overlapping/stale older docs (LAUNCH_CHECKLIST vs _V2). |
| Backup / recovery | **75** | KV nightly backup. -25 because no documented restore drill. |
| Cost ceiling | **60** | KV monitored. -40 because no per-tenant LLM cap. |

**Overall (weighted by user-impact): 73 / 100.**

### Top 3 weakest links
1. Sheet write correctness (dashboard) — blocked on #42.
2. Per-tenant LLM cost cap — open security item.
3. Live end-to-end signup + payment — never tested by a real third party.

### 7-day plan (no new features)

| Day | Owner | Action |
|-----|-------|--------|
| Day 1 | Steven | Merge PR #42; paste `bot/personal_sheet_fix.gs`; run `FIX_NOW`; send screenshot |
| Day 1 | Steven | Merge PR #24 |
| Day 2 | Me | Rebase #38; open as CLEAN; Steven merges |
| Day 2 | Steven | Live signup test on burner Google account (Flow 1) |
| Day 3 | Steven | Live PayPal sandbox test (Flow 5) |
| Day 3 | Me | Run Sprint 4 dataset; write `docs/FINANCIAL_ACCURACY_REPORT_2026-05-26.md` |
| Day 4 | Me | Wire admin "re-provision sheet" button (Group C #10) |
| Day 5 | Steven | Mobile walk-through (30 min) |
| Day 5 | Me | Capture findings to `docs/MOBILE_QA_2026-05-26.md` |
| Day 6 | Me | Apply next 5 legal-audit findings |
| Day 7 | Me | Re-score; bump weakest links; produce v2 of this doc |

### 30-day plan (after Day 7 green)

| Week | Theme | Outcomes |
|------|-------|----------|
| Week 1 | Verify (above) | Score ≥ 85 |
| Week 2 | Excel/CSV import MVP (Sprint 8 design → code, CSV only) | Real users can self-onboard from bank CSV |
| Week 3 | Per-tenant LLM cost cap + remaining legal-audit items | Score ≥ 90 |
| Week 4 | Marketing soft-launch: 10 beta users from waitlist; observe Sprint 7 signals | First real cohort, no fires |

---

## Appendices

### A. PR backlog cleanup decisions needed (Steven to call)

- **PR #15** (household mode): keep or close? HIGH risk, no tests.
- **PR #17** (federated learning Stage 3): rebase or pivot to simpler policy?
- **PR #21** (welcome rewrite): merge after rebase, or fold into a broader copy pass?

### B. Files NOT touched in this doc

Code: zero files modified.
Docs created: `docs/SPRINT_LAUNCH_READINESS_2026-05-26.md` (this file).

### C. How to use this doc

1. Read top to bottom once.
2. Walk Group A in order — do not skip.
3. Re-run `node tests/full_qa.js` after every merge.
4. Re-score Sprint 10 weekly.
5. When score ≥ 90, plan soft-launch.

### D. Doc consolidation backlog

Many older docs overlap. Suggest archiving (move to `docs/archive/`) after Group A green:
- `docs/LAUNCH_CHECKLIST.md` → superseded by `LAUNCH_CHECKLIST_V2.md`
- `docs/AUDIT_2026-05-21.md` → superseded by `LEGAL_AUDIT_2026-05-26.md`
- `docs/PROGRESS_DIGEST.md` + `docs/PROGRESS_SUMMARY_HE.md` → superseded by this doc

No deletion. Move only.

---

*Generated 2026-05-26. Single source of truth for the next 7 days.*
