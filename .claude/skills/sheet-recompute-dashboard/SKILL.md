---
name: sheet-recompute-dashboard
description: Run RECOMPUTE_COMPANY_DASHBOARD in bot/personal_sheet_fix.gs to rebuild broken or missing dashboard formulas for a user's sheet.
---

# Recompute company dashboard

`RECOMPUTE_COMPANY_DASHBOARD()` at `bot/personal_sheet_fix.gs:548` is the canonical fix for "the dashboard shows zeros / `#REF!` / wrong totals". It walks the דשבורד tab, finds broken formulas via `_isBrokenDashFormula_`, and rewrites them from `_buildBusinessRowFormulas_` / `_buildRevenueFormulas_` / `_buildOrderCountFormulas_` / `_buildTotalsFormulas_`.

## When to run
- A user reports "my numbers are gone" or zeros where there should be values.
- After importing historical rows you suspect overwrote a formula cell.
- After a template change (see `sheet-spec-modify`) for users provisioned on the old template.

## Steps
1. Open the bot's Apps Script project (same project Steven pastes into).
2. Paste `bot/personal_sheet_fix.gs` into a new file in the project if it isn't already there.
3. Run `_backupCompanyDashboard_(ss)` FIRST — never recompute without a snapshot.
4. Run `DRY_RUN_RESTORE_2026()` (line ~142) to preview what would change. Read the log.
5. If preview looks right, run `RECOMPUTE_COMPANY_DASHBOARD()`.
6. Open the sheet, verify all rows recomputed and chart still renders.

## Verification
- `_isBrokenDashFormula_` reports zero matches after run.
- Spot-check: pick one category, sum the matching תנועות rows by hand, confirm vs the dashboard cell.
- If wrong: `RESTORE_FROM_BACKUP()` (line ~299) reverts.

## Common pitfalls
- Running on the master `SHEET_ID` without checking which tenant you're in.
- No backup → no rollback. Always run `_backupCompanyDashboard_` first.
- `_resolveDashboardYear_` (line ~375) inferred the wrong year on a multi-year sheet — eyeball the result.
