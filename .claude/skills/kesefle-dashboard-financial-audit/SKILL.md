---
name: kesefle-dashboard-financial-audit
description: Cross-check dashboard totals against תנועות row-level data — revenue, expense, net profit, per-category sums per month — to detect formula drift, broken SUMIFS, or stale-cached values.
---

# kesefle-dashboard-financial-audit

When invoked: for a sheet, recompute each dashboard cell value from תנועות raw rows and diff against the displayed value.

## Inputs
- `sheetId` — required
- `year` — optional (default: current calendar year)

## Per-tab checks

### מאזן אישי
For each income row + expense row, for each month col (C..N):
1. Read displayed value
2. Recompute from תנועות: `SUMIFS(C:C, B:B, "YYYY-MM", E:E, label)` (or REGEXMATCH where dashboard uses SUMPRODUCT)
3. Diff must be < ₪1 (rounding tolerance)
4. Special row 6 "עסק 2 הכנסה" — must equal `'מאזן חברה'!C13:N13` for the same month

### מאזן חברה
1. Revenue row — sum of `הזמנות!G:G` (salePrice) for matched month
2. Per-sub expense rows (חומרי גלם, שיווק, משלוחים, תפעוליות) — SUMIFS against תנועות col E sub names
3. Net profit row 13 — revenue − material − other expense

## Pass criteria
- Diff < ₪1 for every cell
- Net profit row 13 reconciles to formula
- Annual sum (col B) = sum of C:N

## Outputs
- `dashboard-financial-audit-{sheetId-short}-{YYYY}.md`
- Table: Row | Col | Displayed | Recomputed | Diff | PASS/FAIL
- Summary stats: total cells checked, total fail count, biggest diff

## Hard NO
- No writes to the sheet during audit
- No bot fix invocation
- Reports diff only — Steven decides whether to fix
