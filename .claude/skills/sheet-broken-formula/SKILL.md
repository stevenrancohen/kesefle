---
name: sheet-broken-formula
description: Detect and clean broken SUMIFS / dashboard formulas in a tenant sheet using _isBrokenDashFormula_ and CLEAN_BROKEN_FORMULAS in bot/personal_sheet_fix.gs.
---

# Clean broken dashboard formulas

`_isBrokenDashFormula_` (`bot/personal_sheet_fix.gs:441`) detects formulas that have been corrupted — typically a SUMIFS with an empty criteria, a stray range break, or a reference to a deleted row. `CLEAN_BROKEN_FORMULAS()` (line ~463) does a safer surgical fix vs `RECOMPUTE_COMPANY_DASHBOARD` which rebuilds everything.

## When to use
- A dashboard cell shows `#N/A`, `#REF!`, or returns 0 when there is data.
- After a manual user-edit (Steven deleted a category row) that broke downstream formulas.
- A handful of cells are wrong (not the whole dashboard).

## Steps
1. Identify the suspect cells. Note their `A1` addresses.
2. Open the bot Apps Script project. Run `CLEAN_BROKEN_FORMULAS()`.
3. It logs each cell it touches and what it rewrote. Read the log.
4. If a cell is genuinely empty (no formula was ever there), this function leaves it alone — that's the safety guarantee. For broader rebuild, use `sheet-recompute-dashboard` skill.

## Verification
- After run: `_isBrokenDashFormula_` returns false for every cell on the דשבורד tab.
- Open the sheet, eyeball — no error cells.
- Pick one category, sum תנועות rows manually, compare to the cell.

## Common pitfalls
- `_isBrokenDashFormula_` and the bot's twin at `bot/ExpenseBot_FIXED.gs:10067` must stay in sync — change one, change the other.
- Running before a backup → no undo. Prefer `_backupCompanyDashboard_` first.
- Confusing "broken formula" with "right formula, wrong data" — if the formula text is valid but the result is wrong, the data is the problem, not the formula.
