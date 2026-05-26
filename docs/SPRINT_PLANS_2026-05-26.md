# Sprint planning batch — 2026-05-26

Consolidated planning docs. **Zero code in this batch.** Each section is a plan that must be approved before implementation.

| # | Plan | Status |
|---|------|--------|
| 5 | RECOVER_DASHBOARD_V2 runbook | shipped as separate doc → `docs/RECOVER_DASHBOARD_V2_RUNBOOK.md` |
| 8 | Bot onboarding QA — audit plan | this doc, §1 |
| 9 | Bot command polish — plan | this doc, §2 |
| 10 | CEO admin console PR-A1 — plan | this doc, §3 |
| 11 | Twice-daily learning loop — design doc | this doc, §4 |

---

## §1 — Bot Onboarding QA Audit (Task 8)

**Approach:** read-only first. I send a sub-agent through the user journey and produce the bug list below. No code is written until Steven approves the fix priority.

### The 11-step journey to audit

| # | Step | Expected | What to look for (bugs) | Severity scale |
|---|------|----------|--------------------------|----------------|
| 1 | User lands on `kesefle.com/` | Hero loads, demo plays, CTA visible above fold | Slow LCP, CTA below fold on mobile, copy unclear | HIGH if CTA invisible |
| 2 | User clicks "התחל חינם" / "הרשמה" | Smooth scroll to signup section OR navigate to `/account` | Broken anchor, scroll jumps, double-click required | HIGH if dead button |
| 3 | User understands what to do | One-liner explanation visible, Google sign-in obvious | Wall of text, multiple competing CTAs | MED |
| 4 | User signs in with Google | OAuth flow completes, redirected back to `/account` with sheet | OAuth screen fails, redirect breaks, ?code= leftover in URL | HIGH if no recovery |
| 5 | Sheet provision attempts | `sheet:{sub}` written, link visible on page | Provision fails silently (this is tamirmiz03's case) | HIGH — fix is PR #51 |
| 6 | User connects WhatsApp bot | "Open WhatsApp" button, phone-link code visible | In-app browser blocks the WhatsApp deeplink, code expires | HIGH if blocked |
| 7 | Bot sends welcome | Welcome message arrives within 30s | Welcome never arrives, gets stuck in Meta queue | MED (recoverable via admin) |
| 8 | User sends "50 קפה" | Bot replies `✅ נרשם: 50₪ · קטגוריה: ...` within 5s | Bot silent, wrong category, duplicate sheet creation | HIGH |
| 9 | Sheet link works on mobile | Tap link → opens Google Sheets app or web | iOS WhatsApp opens in in-app browser → blank page | HIGH (known iOS quirk) |
| 10 | Row appears in sheet | תנועות tab has the row with amount=50 | Row appears in wrong tab, wrong column, missing | HIGH |
| 11 | Admin sees the new user | `/admin/launch-monitor` shows recent signup | Latency >5 min, missing entry | MED |

### Required audit deliverables (read-only)

The agent run will produce a table:

```
Step | Expected | Actual | Pass/Fail | Bug | Severity | Suggested fix | File(s) likely involved
```

### Pre-known issues already covered

- **#5 silent provision fail** — PR #51 ships the admin reprovision endpoint
- **#9 iOS in-app browser** — covered by PR #155 era "in-app browser fix"
- **#10 wrong tab** — covered by PR #35/#36 multi-business routing

### What the audit will catch NEW (out-of-bug-database items)

- Copy that confuses new users
- Mobile layout breaks on iPhone SE
- "פתח גיליון" silent failure modes other than #5
- Bot reply latency variance
- Confusing category picker behavior

### Estimated effort

| Phase | Effort | Output |
|-------|--------|--------|
| Sub-agent runs the audit | 5 min agent time | Bug list table |
| Steven reviews + prioritizes | 10 min Steven | Approved fix list |
| Implementation PR(s) | 1 PR per HIGH severity bug | Small focused PRs |

### Approval needed before implementation

After the agent produces the bug list, **Steven decides which to fix and in what order**. No code without that approval.

---

## §2 — Bot Command Polish — Plan (Task 9)

**Goal:** Users don't memorize `עסק N` syntax. Add explicit commands, persist active-business state in KV.

### Command matrix

| Command (user text) | Bot response | Backend action | Files to touch | Tests required | Risk |
|---------------------|--------------|----------------|----------------|----------------|------|
| `עזרה` | Static list of all commands in Hebrew | None — pure reply | `bot/ExpenseBot_FIXED.gs` | unit test on dispatcher | LOW |
| `סטטוס` | Returns plan + active business + last activity | `kvGet(user:{sub})` + format | `bot/ExpenseBot_FIXED.gs`, `lib/entitlements.js` | unit | LOW |
| `רשימת עסקים` | Returns numbered list of all business tabs | Read spreadsheet sheets metadata | `bot/ExpenseBot_FIXED.gs`, calls `lib/sheet-writer.js` | unit + integration | MED — needs OAuth call |
| `פתח עסק חדש <name>` | Confirms tab created | Already exists — PR #35 ships it | (no change) | already tested | DONE |
| `שנה שם עסק <old> <new>` | Confirms rename | Read sheets metadata → rename via Google Sheets API | `bot/ExpenseBot_FIXED.gs`, new `lib/sheet-rename.js` | new test | MED |
| `עבור עסק <name>` | "מעבר לעסק <name>. ההוצאה הבאה תרשם שם" | `kvSet(active_business:{sub} = name)` | `bot/ExpenseBot_FIXED.gs`, KV write | unit | LOW |
| `פתח גיליון` | Returns sheet URL | `kvGet(sheet:{sub})` → format | already exists | already tested | DONE |
| `תקן פעולה אחרונה <new>` | Confirms update | `appendRowToTab` write to row N | already exists | already tested | DONE |
| `מחק פעולה אחרונה` | Confirms deletion | `api/sheet/delete-last.js` | already exists | already tested | DONE — PR #24 |
| `סיכום חודשי` | Returns text summary of MTD per category | Read תנועות, aggregate | `bot/ExpenseBot_FIXED.gs`, calls existing summary helper | unit | LOW |
| `מנוי` | Returns plan + renewal date | `kvGet(user:{sub})` + entitlement | already exists | already tested | DONE |
| `תמיכה` | "אני שולח לסטיבן" + admin DM | Calls `api/admin/owner-dm.js` | already exists | already tested | DONE |

### New work scope

5 commands need new code:
- `עזרה` (static list)
- `סטטוס` (read + format)
- `רשימת עסקים` (Sheets API read)
- `שנה שם עסק` (Sheets API rename)
- `עבור עסק <name>` (KV write — the *key* missing piece)

### KV / DB requirements for active-business state

**New KV key:** `active_business:{userSub}`
- value: `{ businessName: string, setAt: ISO timestamp }`
- TTL: none (persists until next `עבור עסק`)
- Read: `bot/ExpenseBot_FIXED.gs` `_writeBusinessNExpense_` checks this when user sends expense without explicit `עסק N` prefix
- Write: only `עבור עסק <name>` command
- Size: ~80 bytes per user → 80KB at 1,000 users (negligible)

### Tests required (new)

| Test file | What it verifies |
|-----------|------------------|
| `bot/test_bot_commands.js` | Each command's parser + dispatch |
| `bot/test_active_business.js` | Active-business state persists across messages |
| `bot/test_rename_business.js` | Tab rename idempotency + collision detection |
| `tests/golden_set.js` (update) | Add 5 command-style messages to anchor classification |

### Recommended PR breakdown (3 small PRs)

| PR | Scope | Risk | Tests |
|----|-------|------|-------|
| Cmd-A1 | `עזרה`, `סטטוס`, `סיכום חודשי` (3 static/read-only commands) | LOW | unit |
| Cmd-A2 | `רשימת עסקים` + `שנה שם עסק` (Sheets API reads/writes) | MED | unit + integration |
| Cmd-A3 | `עבור עסק` + active_business KV state + `_writeBusinessNExpense_` integration | MED | unit + isolation |

**Implementation only after Steven approves.** Total effort: ~4–6 hours across 3 PRs.

---

## §3 — CEO Admin Console PR-A1 — Plan (Task 10)

**Scope:** ONLY the top KPI overview cards. Wix-style light design. No tables, no graphs, no per-user actions yet (those are PR-A2 and PR-A3).

### Current admin structure (today)

`/admin` → tab navigation:
- `/admin/launch-monitor.html` — funnel + bot heartbeat + config drift + sheets quota + recent signups
- `/admin/revenue.js` — MRR card
- `/admin/inbox.js` — user reports + escalations
- Various JSON endpoints used by the dashboards

### Data available today (from KV)

| Question | KV source | Endpoint that surfaces it |
|----------|-----------|----------------------------|
| How many users? | scan `user:*` | `/api/admin/stats.js` |
| Active last 7d? | scan `user:*` filter on lastActive | new endpoint needed |
| Paying users? | scan `user:*` filter on entitlement | `/api/admin/revenue.js` |
| MRR / total revenue | scan `user:*` aggregate plan amounts | `/api/admin/revenue.js` |
| Stuck users (signed up, no sheet) | scan `user:*` AND scan `sheet:*` diff | new endpoint needed |
| Broken sheets | scan `bot_errors:*` filter type | new endpoint needed |
| Failed bot messages | scan `bot_errors:*` | `/api/admin/launch-monitor.js` partial |
| Payments needing approval | scan `payment_failed:*` | new endpoint needed |
| "What should I fix today?" | computed (stuck + failed + broken combined) | new endpoint needed |

### Data missing (need to add)

- **Active-last-7d count** — requires `lastActive` field on user record (already there per PR #66) but no aggregation endpoint
- **Stuck-users count** — requires diffing `user:*` ∖ `sheet:*`
- **Today's top-3 issues** — requires composite query

### Proposed KPI cards (PR-A1 scope only)

Six cards across the top, mobile-stacks-to-1. Wix-style light design (white card on light gray bg, subtle shadow, Rubik 900 numbers).

| # | Card | Hebrew label | Big number | Sub-text | Color |
|---|------|--------------|------------|----------|-------|
| 1 | Users total | "סה״כ משתמשים" | live count | "+N this week" | brand-600 |
| 2 | Active 7d | "פעילים השבוע" | live count | "%-of-total" | accent-500 |
| 3 | Paying | "משלמים" | live count | "out of total" | green-600 |
| 4 | MRR | "הכנסה חודשית" | "₪X,XXX" | "+/-% vs last month" | brand-700 |
| 5 | Stuck | "תקועים" | live count | "סטטוס: aria-live" | red-500 if >0 |
| 6 | Today's todo | "לתיקון היום" | live count | "X issues" | amber-500 if >0 |

### Files to touch (PR-A1)

| File | Change | Lines |
|------|--------|-------|
| `admin.html` | Replace top section with 6-card grid | ~120 |
| `api/admin/kpi-overview.js` (NEW) | One endpoint returns all 6 numbers in a single call | ~120 |
| `lib/admin-kpi.js` (NEW) | Aggregation helpers (count_users, count_active, etc.) | ~80 |
| `tests/test_admin_kpi.js` (NEW) | Unit tests on aggregation | ~60 |

**Net: ~400 lines, 4 files. Reviewable in 30 min.**

### Risks

| Risk | Mitigation |
|------|-----------|
| Slow KV scan with N users | Cache the result for 60s per admin |
| Wrong stuck-user count | Cross-check against `provision_failed:*` log |
| Mobile layout breaks | Use existing Tailwind responsive grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-6`) |
| Showing private data | Never include emails, sums, or names — only counts |

### Tests required (PR-A1)

- `tests/test_admin_kpi.js`:
  - With 0 users: all cards show 0
  - With 5 users: total=5, active depends on `lastActive`
  - With 1 paying user: paying=1, MRR matches plan amount
  - With 1 stuck user (`user:` exists, `sheet:` missing): stuck=1
- `tests/full_qa.js` integration: endpoint requires admin auth (returns 401 without cookie)

### What PR-A2 and PR-A3 will cover (NOT this PR)

- A2: onboarding funnel chart + user table + per-user detail page
- A3: bot health graph + sheets health + issue center + analytics

### Approval needed

PR-A1 is ready to be implemented after Steven approves the card list above. No code until then.

---

## §4 — Twice-Daily Learning Loop — Design Doc (Task 11)

**Status:** Design only. Zero code. Open for Steven's feedback before MVP scope is locked.

### The strategic intent

Kesefle should be a system that learns from every user interaction. Twice a day, the system reflects: what worked, what failed, what to improve. The reflection produces a short report Steven reads on his phone.

### Signals to capture (data sources)

| Signal | Captured where | KV key pattern | Cost |
|--------|----------------|----------------|------|
| Bot understood / did not understand | `bot/ExpenseBot_FIXED.gs` after each inbound | `signal:bot_understood:{date}:{messageId}` | 1 KV write per msg |
| Sheet updated / did not update | `lib/sheet-writer.js` after `appendRowToUserSheet` | `signal:sheet_write:{date}:{messageId}` | 1 KV write per msg |
| Category existed / missing | classifier output | `signal:category_existed:{date}:{messageId}` | piggyback on bot signal |
| User got stuck | inferred from `lastActive` > 24h after signup with no first expense | `signal:stuck:{userSub}` | computed daily |
| Link opened / failed | client-side beacon from `dashboard.html` and sheet-redirect | `signal:link_opened:{date}:{userSub}` | 1 KV write per click |
| Admin saw issue / missed | admin viewing the issue in launch-monitor → `signal:admin_seen:{issueId}` | 1 write per admin action |
| Monday task created / not created | webhook from Monday on item create | `signal:monday_created:{date}:{itemId}` | 1 write per Monday event |

### Privacy rules (non-negotiable)

- **Never** log the raw user message text. Only intent labels: `bot_understood: true/false`, `category_assigned: "מזון"`, `had_amount: true/false`.
- Never log the user's phone, email, or name in `signal:*` keys. Only `userSub` (the opaque Google sub).
- Aggregate reports never include per-user financial sums. Only counts (e.g. "47 messages today, 41 categorized").
- Steven can drill into a specific user via the existing `user-timeline` endpoint (admin-only).

### Twice-daily review schedule

| Time (IL) | Window | Purpose |
|-----------|--------|---------|
| **06:00** | Last 24h | Morning briefing — what happened overnight |
| **18:00** | Last 12h | Evening briefing — what happened today |

Both run as Vercel crons. Both write a summary to `digest:{morning,evening}:{date}` and DM Steven on WhatsApp.

### Morning report format (06:00)

```
☀️ סיכום בוקר 26 במאי

המספרים מאתמול:
👥 8 הצטרפו (4 מהם פעילים)
💬 142 הודעות לבוט (133 הובנו, 9 לא)
📊 119 רשומות נכתבו בגיליונות
⚠️ 3 משתמשים תקועים (אין הוצאה ראשונה אחרי 24 שעות)
🐛 2 שגיאות בוט (1 נפתרה אוטומטית, 1 מחכה)

3 דברים שכדאי לתקן היום:
1. משתמש srcSnipoxia12 לא קיבל קישור גיליון - reprovision
2. הודעת '500 קמפיין דיגיטל' לא סווגה - הוסף keyword
3. שגיאת KV ב-/api/sheet/append בשעה 03:47 - בדוק

קישור למסך אדמין: kesefle.com/admin
```

### Evening report format (18:00)

```
🌙 סיכום ערב 26 במאי

מאז הבוקר:
💬 67 הודעות נוספות (62 הובנו)
📊 58 רשומות חדשות
👥 2 הצטרפו (שניהם פעילים — שלום!)
💰 1 שדרוג ל-Pro (₪19 MRR חדש)

3 התקדמויות:
✅ סטיבן תיקן את משתמש srcSnipoxia12
✅ הוספנו keyword 'דיגיטל' (עכשיו 18,743 keywords)
✅ שגיאת KV נפתרה

עוד 11 שעות עד הבוקר. ערב טוב.
```

### Agents involved

| Agent | Role | When |
|-------|------|------|
| `data-aggregator` | Read `signal:*` keys, count + classify | Both 06:00 and 18:00 |
| `report-writer` | Format the data into Hebrew narrative | After aggregator |
| `monday-sync` | If Monday has new items in last 12/24h, append to report | After report-writer |
| `whatsapp-sender` | Send the final report to Steven's phone | After monday-sync |

All four run within the same Vercel cron invocation, sequentially.

### Monday sync rules

- If a bug appears in `signal:bot_errors` AND has no matching Monday item with `pulse_updated > error_timestamp`, **auto-create** a Monday item in the "To-Do" group with severity tagged
- If a Monday item is marked `בוצע` (done) by Steven, the corresponding `signal:*` keys get a `resolved_at` timestamp so we don't double-report
- Auto-created items must include the error excerpt (not the user's message)

### Admin integration

- A new `/admin/learning-loop.html` page shows the latest morning + evening report inline
- A "Send digest now" button triggers a manual run (rate-limited to 1/hr to prevent spam)
- A "Mute" toggle (per signal type) so Steven can quiet noisy categories during a fix

### Category improvement workflow

When a `signal:bot_understood = false` rate exceeds 5% over 24h:
1. Aggregator extracts the (anonymized) phrase that failed
2. Cluster similar phrases (LLM call, ~100 tokens)
3. Suggest the new keyword to add to the classifier
4. Steven approves with one WhatsApp tap → keyword added → `bot/test_golden_set.js` updated

### Safe rollout plan

| Phase | Scope | When |
|-------|-------|------|
| 0 | Design doc approved by Steven | now |
| 1 | Just capture signals — no reports yet | week 1 |
| 2 | Generate reports but write to KV only, no DM | week 2 |
| 3 | DM Steven only | week 3 |
| 4 | Add `/admin/learning-loop.html` UI | week 4 |
| 5 | Monday auto-sync | week 5 |
| 6 | Category-improvement workflow | week 6 |

Each phase is a separate small PR. Each is reversible by setting `KFL_DISABLE_LEARNING_LOOP=true` in Vercel env.

### MVP implementation (phase 1 only)

- New file `lib/signal.js` — `recordSignal(name, value, metadata)` writes one KV key with TTL=7d
- Hook into 4 high-value spots: bot inbound, sheet write, link click, admin view
- That's it. No reports, no DMs, no UI. Just capture.

### Risks

| Risk | Mitigation |
|------|-----------|
| KV explosion (signals × users × days) | TTL=7d on every signal key, rotate aggregates daily |
| Privacy leak (user text in logs) | Strict log format: only intent labels, never raw text |
| Steven gets spammed | Default off, must opt-in per signal type, rate-limited |
| Cost (Anthropic for clustering) | Only run clustering on bottom-quartile understanding rate days |
| Wrong inferences from signals | Manual override button next to every auto-conclusion in the report |

### What's NOT in this design

- Public dashboard (this is admin-only)
- Per-user reports (Steven could DM each user a summary, but that's a separate product decision)
- Notifications via SMS/email (WhatsApp DM only)
- Multi-admin (single-admin assumed)

### Approval needed

This design needs Steven's review before any of phase 1 code is written.

---

## §5 — Status summary across all 7 plan sections

| Plan | Owner | Approval state | Next action |
|------|-------|----------------|-------------|
| RECOVER_DASHBOARD_V2 runbook | Steven (to run) | doc shipped, no approval needed | Steven runs DIAGNOSE → DRY_RUN |
| Bot onboarding audit (Task 8) | me (read-only first) | needs Steven's go-ahead for the sub-agent run | "Go run the audit" |
| Bot command polish (Task 9) | me (3 small PRs) | needs Steven to approve command list | "Approve commands + KV schema" |
| Admin PR-A1 (Task 10) | me (1 PR, ~400 LOC) | needs Steven to approve card list | "Approve cards + endpoints" |
| Learning loop (Task 11) | me (6-phase rollout) | needs Steven to approve phase 1 MVP scope | "Approve phase 1" |

---

*Generated 2026-05-26. No code in this doc. Single source of truth for next 5 sprints.*
