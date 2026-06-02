# Sheet + Dashboard Strategy v1

**Decision date:** 2026-05-27 (evening)
**Decided by:** Steven (founder)
**Status:** PROPOSED — Steven to approve before any code lands
**Companion doc:** [APP_STRATEGY_WHATSAPP_PLUS_APP.md](./APP_STRATEGY_WHATSAPP_PLUS_APP.md) (morning's WhatsApp-input contract — still binding)

---

## Context

Steven asked for a major architecture push: bot messages DB, 4 sheet templates by user type, visual dashboard rebuild, twice-daily improvement automation. 4 parallel audit agents inspected the codebase. Findings + lean PR breakdown below. **This doc reconciles with this morning's plan, it does not replace it.**

---

## What exists today (audit findings)

### Sheet template — `lib/sheet-writer.js:726-755`
- 5 tabs: מאזן אישי, תנועות, הזמנות, מאזן חברה, פירוט מורחב
- `תנועות` has **9 columns** (תאריך/חודש/סכום/קטגוריה/תת-קטגוריה/פירוט/מקור/סטטוס/ניכוי מע״ם). Missing: transaction_id, profile_type, project_id, confidence_score, payment_method, review_status.
- Brittle formulas: hardcoded row positions. Personal row 10 total = `B28+B34+B39+B50+B58`. Company dashboard rows 6-14 lock single year.
- **ZERO user-type branching.** `buildTenantSheetSpec()` returns the same spec for personal/family/business/contractor.

### Bot message logging — `bot/ExpenseBot_FIXED.gs`
- NO persistent log. Only `Logger.log` (30-day retention) + Sheets row (9 fields, lossy).
- **6 of Steven's 25 required fields captured today.** 19 missing.
- Cheapest hook: line 7570 in `processExpense()` after successful appendRow. One `_logBotMessage_(input, result)` call captures ~10 fields with zero refactoring.

### KV schema — `api/`, `lib/`
- 24+ key patterns inventoried. **`bot_msg:*` does not exist. `review:*` does not exist.** `learned_rule:*` partial via `global_learn:{sha256-hex}` (hash-only, cross-user).
- Source-of-truth INVERTED: transactions live ONLY in Sheets (no KV backup); profile/goals/reminders KV-only.
- Free tier ~10k ops/day. Per-message KV writes today: only `analytics:` + rate-limit counters (cheap). Adding 1 message log write per inbound is within budget at beta scale.

### Dashboard — `public/dashboard.html`
- Already has KPI cards + charts (incremental upgrade is possible). Not a rebuild.

---

## Conflict flag — honest reconciliation

Morning's [PR #108](https://github.com/stevenrancohen/kesefle/pull/108) said:
> "Google Sheets stays primary (for now); broad dashboard rebuild — DO NOT BUILD"

This evening flips both. The honest reconciliation:

| Decision | Morning (binding) | Evening (proposed) | Reconciled |
|---|---|---|---|
| WhatsApp = input layer | ✓ | ✓ | ✓ Keep |
| Dashboard.html = correction layer | ✓ | ✓ | ✓ Keep |
| No native iOS/Android | ✓ | (silent) | ✓ Keep |
| Sheets = primary | ✓ | "Sheets = backup" | 🟡 v1: stays primary. v2 decision after Bot Messages KV proves stable. |
| No broad dashboard rebuild | ✓ | "rebuild visual dashboard" | 🟡 Honor morning's rule. Add cards/charts INCREMENTALLY to existing dashboard.html, not a rebuild. |
| Bot uncertainty + Review Inbox | ✓ | ✓ | ✓ Keep (morning's Epic 2944316144) |
| PWA | ✓ Phase C | (silent) | ✓ Keep (push to phase 2 — see below) |

---

## The 6 decisions

1. **Bot Messages KV log is the foundation.** Every received message → 1 KV record at `bot_msg:{userSub}:{ts}:{messageId}` with all 25 fields. Source of truth for bot intelligence. Cost: 1 KV write/msg, ~100ms. Feature flag: `KFL_BOT_MSG_LOG=true`.

2. **Sheet template stays Personal-first for v1.** Add ONE new variant: **Contractor** (most distinct delta, clearest profit-per-job pain). Family + Business variants deferred. `buildTenantSheetSpec(profileType)` branches on existing `profile:{phone}.trackingType`.

3. **Existing users do NOT get re-provisioned.** New signups get the new template; existing users keep their current sheet. Re-provision is opt-in via the existing button (task #173 already shipped).

4. **Dashboard upgrade is incremental, not a rebuild.** Add KPI cards + charts to existing dashboard.html (RTL polish, mobile breakpoints, empty states). PR-S5 ships behind `?v2=1` query param for A/B until QA passes.

5. **Sheets remains source-of-truth for transactions for v1.** Bot Messages KV log is the bot-intelligence layer, NOT a transaction backup. Moving transactions to KV is a v2 decision (after 30 days of stable Bot Messages logging).

6. **Twice-daily review starts as a manual button.** v1: admin clicks "Run Bot Improvement Report Now" in admin panel, sees report. v2 (after we trust report quality): Vercel cron at 09:00 + 21:00 IL.

---

## What we explicitly DO NOT build now

- 4 sheet template variants (only +1: Contractor)
- Family + Business template variants
- Full dashboard rebuild (only +cards/+charts to existing)
- KV-as-source-of-truth migration for transactions
- Telegram channel support (WhatsApp only)
- Twice-daily Vercel cron (manual button first)
- Tax-export tabs (defer until accountant feedback)
- "Bot Message Intelligence" public-facing UI (admin-only in v1)

---

## PR breakdown (7 PRs, sequenced)

| # | Title | Scope | Touches | Reviewable in |
|---|---|---|---|---|
| **PR-S1** | This strategy doc | docs only | `docs/` | 5 min |
| **PR-S2** | Bot Messages KV log | `_logBotMessage_` helper + insertion at `processExpense:7570` + `KFL_BOT_MSG_LOG` env flag | `bot/ExpenseBot_FIXED.gs` only | 20 min |
| **PR-S3** | Admin "מאגר הודעות הבוט" view | Read-only table of `bot_msg:*` records w/ filters (failed/low-conf/unknown-category), PII masked by default | `public/admin/`, `api/admin/bot-messages.js` | 30 min |
| **PR-S4** | Contractor template variant | `buildTenantSheetSpec(profileType)` branches when `profileType === 'contractor'`. Adds: דשבורד עסקי, פרויקטים, רווחיות פרויקט, לקוחות tabs | `lib/sheet-writer.js`, `lib/categories.js` | 45 min |
| **PR-S5** | Dashboard cards + charts upgrade | +6 KPI cards (income/expense/net/budget-used/top-cat/MoM), +3 charts (category donut, monthly trend, budget vs actual). Behind `?v2=1` | `public/dashboard.html`, `api/dashboard/` | 60 min |
| **PR-S6** | Review Inbox (reconcile with morning Epic) | "צריך אישור" tab → uses `bot_msg:*` filtered to `status='needs_review'`. One-tap fix writes correction + learns rule | `public/dashboard.html`, `api/dashboard/review-inbox*.js` | 45 min |
| **PR-S7** | Bot improvement report (manual button v1) | `/api/admin/bot-improvement-report` aggregates last 12h of `bot_msg:*`, runs LLM analysis, returns 14-section markdown report | `api/admin/`, `public/admin/` | 45 min |

Each PR ≤300 LOC. Each deployable independently. Each reversible via revert + (for bot PR-S2) prior DEPLOY.gs paste.

---

## How this fits with morning's Epic

Morning's Epic 2944316144 has 8 subtasks. This evening's 7 PRs reshuffle them:

| Morning subtask | Evening PR |
|---|---|
| 1. One-page strategy doc | ✓ Done (PR #108 merged) |
| 2. Bot low-confidence confirmation | Replaced by **PR-S2** (Bot Messages log) + a separate PR that adds the 0.85 threshold guard on top of the log |
| 3. needs_review status | Subsumed by **PR-S2** (status field is one of the 25) |
| 4. Review Inbox dashboard tab | = **PR-S6** |
| 5. One-tap corrections | = **PR-S6** |
| 6. Save learning rule | = **PR-S6** (already partially exists via `global_learn:*`) |
| 7. PWA install support | Deferred to phase 2 (after Bot Messages + Contractor template prove value) |
| 8. QA — full-flow smoke | Carries over, runs after **PR-S2..S6** land |

Monday Epic gets updated, not duplicated. No new Epic.

---

## QA contract (Steven's Part 14 — 11 test cases)

All 11 cases must pass on Personal AND Contractor templates after PR-S2..S6 land:

**Personal:** `50 קפה`, `245 סופר`, `תקציב אוכל 2000`, `כמה נשאר לי לאוכל`
**Business:** `עסק הכנסה 10000`, `עסק הוצאה שיווק 500`, `עובדים 2500`, `חומרים 1200`
**Contractor:** `עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200`, `כמה הרווחתי בעסקה של יוסי`

For each:
- ✅ correct classification (assertion: `bot_msg.detected_category` matches expected)
- ✅ correct sheet write (assertion: `bot_msg.sheet_write_status === 'success'` AND target row exists)
- ✅ correct dashboard update (assertion: KPI card matches new total)
- ✅ correct bot message log (assertion: all 25 fields populated)
- ✅ correct review status (assertion: confidence < 0.85 → `status='needs_review'`)

Test fixtures land in PR-S2 (Bot Messages log) and PR-S4 (Contractor template).

---

## Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| KV cost explosion from `bot_msg:*` writes | `KV_WATCHDOG` (task #59 already shipped) monitors `bot_msg:*` count, alerts at 80% Upstash quota | Flip `KFL_BOT_MSG_LOG=false` env var, bot resumes silent operation |
| 4-template variants → maintenance hell | Ship only +1 variant (Contractor) in v1. Re-evaluate after 30 days. | Revert PR-S4. Contractor users degrade to Personal template (still works). |
| Dashboard regressions for existing users | PR-S5 ships behind `?v2=1` query param. Default OFF. A/B test before flipping default. | Remove `?v2=1` codepath. Default users stay on existing dashboard. |
| Bot Messages log captures PII in plain text | Admin view masks by default (only show last-4 of amount, first-10 chars of description). Full text requires explicit "Open Support Case" click + audit log entry. | Defer PR-S3 (admin view). PR-S2's log is internal-only; no UI exposure. |

---

## When to revisit

After **30 days** of v1 live with:
- ≥3 active contractor users (justifies the Contractor variant)
- ≥1000 bot_msg records logged (enough data for the twice-daily report to be useful)
- ≥10 corrections via Review Inbox (proves the learning loop works)

If all 3 → expand to Family + Business templates, flip dashboard default to v2, promote twice-daily to Vercel cron.
If 0 → roll back PR-S4 + PR-S7, keep PR-S2/3/5/6 (still useful in isolation).

---

*Two-page rule: this doc spans 3 architecture layers (bot intel / templates / dashboard) so it runs 2 pages instead of 1 — but every line is load-bearing. The 6 decisions are the durable contract.*
