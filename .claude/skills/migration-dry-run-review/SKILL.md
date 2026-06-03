---
name: migration-dry-run-review
description: Parse an Apps Script execution log (Steven pastes it) from a Kesefle migration DRY_RUN; extract per-tab counts and sample rows; flag anomalies before pressing APPLY.
---

# Review a migration DRY_RUN log

Migrations under `bot/MIGRATE_OLD_TO_KESEFLE.gs` and `bot/MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs` always print a structured DRY_RUN log: per-tab "would carry N rows", per-tab sample row, total. Steven runs DRY_RUN, pastes me the log. This skill is the parse + sanity-check ritual that turns the paste into a go/no-go.

## Steps

1. Ask Steven for the FULL Apps Script log (Cmd+Enter in Apps Script editor → Executions → click row → Logs tab). Don't accept truncated paste.
2. Extract the migration version tag:
   ```
   grep -E "_MIG_VERSION_|Migration_Phase_\d+_v\d+" <log>
   ```
   Confirm it matches the version in the current repo (`grep _MIG_VERSION_ bot/MIGRATE*.gs`).
3. Parse per-tab counts. Typical format from the migration script:
   ```
   [2023] would carry 412 rows
   [2024] would carry 1083 rows
   [2025] would carry 1741 rows
   ```
   Tabulate: tab | count | sample row.
4. Sanity checks:
   - Total ≈ row-count-diff from `sheet-historical-orphan-finder`. If they disagree by >10%, the migration is silently filtering rows.
   - Sample rows have non-empty amount + non-empty description + a parsed date.
   - Currency parsing: amounts should be plain numbers (not strings like `'₪412'`).
   - Categories: at least 80% should be non-empty (LLM fallback fills the rest).
5. Flag anomalies:
   - Any tab with 0 rows that previously had data → investigate.
   - Any sample row with `amount: NaN`, `date: Invalid Date`, or empty description → fix migration script before APPLY.
   - Source-tag column (col J) must be present and = `_MIG_VERSION_`.
6. If clean: tell Steven "DRY_RUN clean, X rows ready to migrate, sample looks right, OK to APPLY."
7. If anomalies: list each anomaly with the suggested code-side fix; do NOT tell Steven to APPLY.

## Verification
- Every per-tab line is parsed; nothing left over.
- Totals add up.
- No NaN, no Invalid Date, no empty description in sampled rows.
- Source-tag column is consistent.

## Common pitfalls
- Apps Script log truncates at 100KB — large migrations don't print every row. Trust the count, sample the head + tail.
- Misreading "would carry" as "did carry" → assume APPLY happened when it didn't. Always confirm the log mentions DRY_RUN.
- Pre-APPLY without a snapshot — block on `sheet-snapshot-backup` first regardless of DRY_RUN cleanliness.

## Examples
- "Steven pasted DRY_RUN log for Phase 2 — review it" → run this, give Steven a clear go/no-go.
- "Phase 3 dashboard dry-run shows wrong per-year totals" → flag, link to the offending line in `MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs`.
