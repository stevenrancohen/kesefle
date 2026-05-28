# verify-data-sources-before-formula-repair

When asked to "repair" or "rebuild" dashboard formulas in a Google Sheet, ALWAYS map per-metric data sources by reading the EXISTING formulas FIRST. Never assume there's a single source-of-truth tab. Spreadsheets that grew organically often have 2-4 source tabs feeding one dashboard.

## When to use

- User reports "dashboard shows wrong values" / "data missing" / "formulas broken"
- A task asks to rebuild/repair/restore dashboard formulas
- Existing repair scripts (like `RECOMPUTE_X_DASHBOARD` or `FIX_X`) need to be extended
- Any work where you would write a SUMIFS / SUMPRODUCT pointing to a sheet name

## When NOT to use

- A genuinely new dashboard built from scratch (no pre-existing formulas to preserve)
- Pure cosmetic fixes (formatting, colors) that don't touch formulas
- Single-source workflows where the source has been verified (e.g. fresh KV-backed dashboard)

## The 3-step pre-flight

### 1. Read EVERY existing formula in the affected section

Don't sample. Don't assume. Open the file, list every formula. Each formula reveals a data source:
```
=SUMIFS('Orders'!D:D, ...)     → revenue source is Orders
=COUNTIFS('Tx'!A:A, ...)       → counts source is Tx
=SUMPRODUCT('Helper'!E:E*...)  → helper-column source
```

Make a per-metric source table:
```
Metric          | Source tab | Source columns | Filter logic
revenue         | הזמנות     | D (amount), A (date) | date in [month_start, month_end]
order_count     | הזמנות     | A (date)             | same
marketing_cost  | תנועות     | C (amount), E (sub) | sub matches *שיווק*
```

### 2. Verify each source actually contains the data

Before writing a new formula, EVALUATE the existing one or sample the source tab:
- Does `הזמנות` have a row in May 2026? If yes, revenue should be non-zero. If new formula gives 0, source is wrong.
- Does `תנועות` have any רows with category=עסק + sub matching שיווק? If yes, marketing should be non-zero.

If old formula evaluates to ₪12,966 and new formula would give ₪0 for the same cell — **STOP**. The source assumption is wrong.

### 3. Per-metric "expected vs actual" check in dry-run

Dry-run must NOT just show "would change C7 from X to formula-text". It must show:
- Current evaluated value: ₪12,966
- New-formula evaluated value: ₪0 (or some specific number)
- Delta + flag if significant

If delta > 5% on a non-zero historical cell, the user must approve EACH such change individually. Don't bulk-apply where deltas are large — that's data loss.

## Critical rules

1. **Never assume a single source-of-truth tab** until you've read every existing formula in the affected section.
2. **Reuse existing builder functions** (`_buildRevenueFormulas_`, `_buildBusinessRowFormulas_`, etc.) instead of writing new ones. They encode the user's domain knowledge.
3. **A correctly-formatted formula that points to the wrong source is destructive.** Looks "professional" but produces 0 where 12,966 should be.
4. **Bulk APPLY is the failure mode.** Per-year, per-metric incremental apply with verification between each — much safer.
5. **Dry-run shows formula text — that's NOT enough.** Evaluate the formulas on the actual data (or sample cells) before claiming "safe".

## Anti-patterns

1. **Reading the user's spec ("everything from תנועות") as truth.** The user describes their desired data model; they may not realize the existing sheet has different architecture. Read the code first.
2. **Trusting an audit agent's "X cells would change" count.** That's a count, not a correctness proof. A bad fix that "changes 266 cells correctly-formatted" is still a bad fix.
3. **Writing a new builder function while ignoring the existing ones.** If `_buildRevenueFormulas_` exists, it exists because someone already encoded the right source. Trust it; extend it; never replace it without proving the replacement works for every historical cell.
4. **Bulk-applying everything in one shot.** "I'll do 266 cells across 4 years × 9 metrics in one APPLY" is the lazy way. The right way: apply 12 cells (1 metric × 1 year), screenshot, verify, then continue.

## Examples

**2026-05-28 — Kesefle dashboard wipe**: I wrote `APPLY_DASHBOARD_REPAIR` that pointed all 9 metrics to `תנועות`. Steven's `הזמנות` tab actually held revenue + order detail. My APPLY zeroed 4 years of historical revenue data. Steven restored from backup. PR #114 closed without merge. Lesson saved.

**The right approach (next attempt)**:
1. Audit `הזמנות` + `תנועות` separately — confirm what's in each
2. Reuse `_buildRevenueFormulas_` (already correct — uses `הזמנות`)
3. Reuse `_buildBusinessRowFormulas_` (already correct for expense buckets — uses `תנועות`)
4. Only fix the 24 truly-broken COUNTIFS cells (`missing 'תנועות' sheet ref`) — leave the 242 working/preserved cells alone
5. Per-year apply: 2026 first → screenshot → verify → 2025 next, etc.

## Related skills

- [[honest-counter-opinion]] — should have pushed back on my own "single source" assumption before APPLY
- [[audit-task-vs-behavior]] — this incident matched exactly: claimed safe, broke things
- [[sheet-broken-formula]] — detection helper that's part of the right tool but not sufficient alone
