---
name: kesefle-sheet-audit
description: End-to-end audit of a Kesefle tenant Google Sheet — tab inventory, row counts per tab, formula health, dashboard reconciliation, year selector status, broken formula detection.
---

# kesefle-sheet-audit

When invoked: read-only inspection of a Kesefle tenant sheet by SHEET_ID.

## Inputs
- `sheetId` (required) — the 44-char Google Drive ID
- `phone` (optional) — owner phone for cross-reference against KV `user:{sub}` record

## Checklist
1. List all tabs with row count, last-write timestamp, presence of dashboard formulas
2. For `תנועות` tab:
   - Total rows
   - Per-year row counts (col B `YYYY-MM` parse)
   - Any orphan rows (col B blank, col C blank, col E blank)
3. For `מאזן אישי` + `מאזן חברה` dashboards:
   - Run `_isBrokenDashFormula_` (from `bot/personal_sheet_fix.gs`) against every formula cell
   - Report broken count + sample broken formula
   - Verify B4 has data validation (year selector)
   - Verify B4 in both tabs are linked (bd!B4 = pd!B4 or via Settings.active_year)
4. For `הזמנות`:
   - Total rows
   - Schema consistency vs `parseBusinessOrder_` expectations
5. Detect old-sheet refs in formulas (any reference to `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` or different file ID)

## Pass criteria
- 0 broken formulas
- 0 orphan rows in תנועות
- Year selector wired in both dashboards
- No cross-sheet references to OLD ID

## Outputs
Markdown report: `audit/sheet-{sheetId-short}-{YYYY-MM-DD}.md` with table per check + remediation suggestion.

## Hard NO
- No writes
- No data validation modification
- No formula rewrite during audit
