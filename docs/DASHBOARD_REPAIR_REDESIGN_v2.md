# Dashboard Repair Redesign v2 — proper architecture for `מאזן חברה`

**Status**: WAITING ON STEVEN — do not implement until he chooses path A/B/C.
**Author**: Claude (post-incident 2026-05-28).
**Trigger**: PR #114 wiped 4 years of historical dashboard data. Steven restored from backup.

## TL;DR

The existing dashboard is **mostly working**. The earlier "everything is broken" framing was wrong. After Steven's restore, only a small number of cells are actually broken. The future fix should be **surgical**, not a 266-cell mass APPLY.

## What we actually know about Steven's data model

After reading `personal_sheet_fix.gs` (the existing repair scripts), the `הזמנות` tab schema, the `תנועות` schema, and Steven's pre-incident screenshots:

### Tab inventory + role per tab

| Tab | Role | Source-of-truth for |
|---|---|---|
| `תנועות` | Bot's expense writes via WhatsApp | Personal expenses + bot-classified business expenses (`עסק/שיווק`, `עסק/תפעולי`, etc.) |
| `הזמנות` | Per-order detail Steven enters manually | Business revenue, per-order materials cost, per-order shipping cost, per-order profit |
| `מאזן חברה` | The active company dashboard | Reads from BOTH `הזמנות` and `תנועות` depending on metric |
| `מאזן אישי` | Personal dashboard | Reads from `תנועות` only |
| Internal helper columns AB-AE in `מאזן חברה` | Pre-bot legacy data + flattened orders | Some legacy formulas reference these |
| `מאזן חברה 2023/2024/2025` | Archive of older year dashboards | Read-only history; do NOT touch |
| `📊 מאזן חברה`, `מאזן שנתי - לא לגעת`, `חברה 2026 לא רלוונטי` | Legacy/deprecated duplicates | Ignore |
| `_backup_*`, `_QA_*`, `dontdelete` | Backup/QA infra | Never modify automatically |

### Per-metric source map (from reading existing formulas)

| Metric | Source tab | Existing formula pattern | Status |
|---|---|---|---|
| מחזור ברוטו (revenue) | `הזמנות` (orders) | `SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, ...)` via `_buildRevenueFormulas_` | ✅ Working — DO NOT replace |
| מס׳ הזמנות (order count) | `הזמנות` or internal columns | `COUNTIFS($AB$4:$AB$100, year, $AC$4:$AC$100, hebMonth, ...)` | ⚠️ Some cells reference `$AB$4:$AB$100` internal cols that ARE populated. ~24 cells per Steven's earlier dry-run flagged as "missing 'תנועות' ref" — but they're not broken, they're just sourced differently. |
| עלות חומרי גלם (materials) | `תנועות` (bot expense writes) | `SUMIFS('תנועות'!C:C, ..., E:E, "*חומרי גלם*")` via `_buildBusinessRowFormulas_` | ✅ Working for bot-written rows. Historical pre-bot data must be elsewhere. |
| עלות שיווק (marketing) | `תנועות` | Same pattern with `*שיווק*` criterion | ✅ Working. Per Steven's backup screenshot, 2026 monthly values like ₪888/₪2,623/₪3,731 — these come from תנועות + the +2,100 manual cash entry. |
| משלוחים והתקנות (shipping) | `תנועות` | Same with `*משלוח*` / `*אריזה*` | ✅ Working |
| הוצאות תפעוליות (ops) | `תנועות` | Same with `*תפעולי*` / `יועצים` / `תוכנות` / etc. | ✅ Working |
| סה״כ הוצאות עסקיות | Same column cascade | `=IFERROR(C8,0)+IFERROR(C9,0)+IFERROR(C10,0)+IFERROR(C11,0)` | ✅ Working — pure cascade, no data source |
| רווח נטו חודשי | Same column cascade | `=IFERROR(C6,0)-IFERROR(C12,0)` | ✅ Working |
| אחוז רווחיות | Same column cascade | `=IFERROR(C13/C6,0)` | ✅ Working |

## Why PR #114 broke everything

I built `_psf_buildFormula_v2_` that pointed ALL metrics to `תנועות`. Effects:
- **Revenue formula**: I replaced `SUMIFS('הזמנות'!...)` with `SUMPRODUCT('תנועות'!...)`. But תנועות has NO historical orders (only bot writes from May 2026 onward). Result: 4 years × 12 months × revenue cell = 48 cells went from real numbers to ₪0.
- **Expense buckets**: I replaced working `*שיווק*` SUMIFS with a new SUMPRODUCT. Most months had no bot-written שיווק rows, so they went to ₪0 too. Only May 2026 marketing survived because of the `+2100` special case.
- **Order count**: I replaced COUNTIFS pointing at internal cols with COUNTIFS at תנועות. Internal cols ARE populated; תנועות isn't. Result: 0.

Net: 266 cells got "repaired" into ₪0. Steven's backup screenshot proves the dashboard was working before my apply.

## Proposed redesign — three paths

Steven picks one when he's ready:

### 🟢 Path A — "hold" (zero new code)

Dashboard is now restored from backup. It works for historical data. New bot writes to `תנועות` will appear in dashboard via the existing `_buildBusinessRowFormulas_` SUMIFS — assuming those formulas weren't overwritten by my apply too.

**Verification needed before doing nothing**: send a bot test message (`עסק 1 75 שיווק`) → wait 5 sec → refresh sheet → did `2026 May / עלות שיווק` increase by ₪75? If yes, Path A is sufficient. Move on to other priorities.

**Risk**: low. We do nothing.

### 🟡 Path B — surgical fix (~50 LOC, 1 PR, no APPLY)

If only the 24 "missing 'תנועות' sheet ref" cells from my earlier dry-run truly need repair, write a NEW dry-run scanner that:
1. Lists ONLY those 24 cells with their current formula + evaluated value
2. For each: shows what the new formula WOULD evaluate to (NOT just the text)
3. Steven approves each cell individually OR all 24 at once

If the new-formula evaluation for a cell would give a different non-zero value than the current, FLAG and refuse to auto-apply.

**Risk**: medium. Even 24-cell apply could hit edge cases. The "evaluate before apply" requirement is the only real safety improvement over what we did.

### 🔴 Path C — full redesign (2-3 PRs, 1-2 weeks)

If Steven wants to permanently retire the dual-source confusion:
- PR 1: Read both `הזמנות` and `תנועות`, build a unified `Normalized_Transactions` helper tab that mirrors everything in one shape.
- PR 2: Rewrite ALL dashboard formulas to read from `Normalized_Transactions`. Easier to reason about.
- PR 3: Backfill `Normalized_Transactions` with historical data from `הזמנות` + internal columns.

**Risk**: high. Big refactor. Requires Steven to send the full xlsx so I can verify cell-by-cell.

## My recommendation

**Path A**. After Steven verifies the bot→dashboard live pipeline works with a single test message, leave the existing formulas alone. They embody years of Steven's domain knowledge. The "broken" feeling was likely caused by my previous apply, not by an underlying problem.

If a SPECIFIC cell turns out to still be broken later (e.g. a new bot category that doesn't match existing SUMIFS criteria), fix THAT cell individually with `sheet-add-category-row` or `sheet-broken-formula` — both already exist as skills.

## What this redesign explicitly will NOT do

- ❌ No bulk APPLY of 200+ formulas at once
- ❌ No replacing `_buildRevenueFormulas_` / `_buildBusinessRowFormulas_` — they work
- ❌ No touching `הזמנות`, `תנועות`, or any archive tab
- ❌ No automated tab cleanup (deferred Monday task [2944947687](https://kesefle.monday.com/boards/5097200701/pulses/2944947687))
- ❌ No column H backfill (deferred Monday task [2945063597](https://kesefle.monday.com/boards/5097200701/pulses/2945063597))
- ❌ No new dashboard layout / styling

## Verification protocol for any future apply

Per the new `verify-data-sources-before-formula-repair` skill:
1. Read every existing formula in the affected section → build per-metric source map
2. Verify each source actually contains the data
3. Dry-run must show **evaluated values** (not just formula text)
4. Per-year, per-metric incremental apply — screenshot + verify between each
5. If new-formula evaluates to a different non-zero value than the old cell, FLAG and refuse

## Open questions for Steven

1. After backup restore, does sending `עסק 1 75 שיווק` make `2026 May / עלות שיווק` increase? (Tests Path A sufficiency)
2. If yes → are you happy with Path A?
3. If no → which 1-3 specific cells (with A1 reference) are still wrong?
4. Do the 24 "missing 'תנועות' ref" COUNTIFS cells actually MATTER to you, or are they showing the right value via internal columns?

## Related artifacts

- Skill: [`verify-data-sources-before-formula-repair`](../.claude/skills/verify-data-sources-before-formula-repair/SKILL.md) — process discipline
- Memory: `~/.claude/memory/feedback_two_source_tabs_revenue_vs_expenses.md` — data architecture
- Memory: `~/.claude/memory/feedback_audit_agents_verify_before_fix.md` — never trust audit output unverified
- Monday incident: [2945153160](https://kesefle.monday.com/boards/5097200701/pulses/2945153160)
- Closed PR with full bug analysis: [#114](https://github.com/stevenrancohen/kesefle/pull/114)
