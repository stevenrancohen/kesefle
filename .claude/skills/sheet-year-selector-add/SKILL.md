---
name: sheet-year-selector-add
description: Add a year-selector dropdown to a dashboard `B4` cell that switches the SUMIFS formulas between live data (current year) and a `סיכום היסטורי` snapshot (past years), without breaking existing tenants.
---

# Add a year-selector dropdown (B4) to a dashboard

`מאזן חברה` already reads `$B$4` as its active year for every SUMIFS (`lib/sheet-writer.js:443-522`, `bot/personal_sheet_fix.gs:50-55`). Today B4 is just a number — users have to type the year. This skill is the pattern for promoting B4 into a dropdown bound to a list of available years, and for switching the underlying formulas to read live תנועות/הזמנות data when the chosen year matches the current year, or read from the `סיכום היסטורי` snapshot tab for past years.

Why split live vs snapshot? תנועות/הזמנות get pruned at year-end. For a 3-year-old year, the formula would return 0 — but the snapshot tab holds the year-end-closed numbers, immutable.

## When to use

- A tenant requests "let me browse previous years in the dashboard" (Steven 2026-05-28 brief).
- After year-end close, when a year's raw rows are archived but you want the dashboard to keep showing the totals.
- When adding a NEW dashboard tab with the same per-year breakdown shape (extends to `מאזן אישי`, the extended Pa'amonim dashboard, etc.).

## When NOT to use

- The dashboard doesn't have a fixed `B4` year cell — adding one is a different change (see `sheet-spec-modify`).
- The user has fewer than 2 years of data — the dropdown is overhead with no benefit. Single-value cell stays.

## Steps

1. Decide the snapshot tab name + shape. Convention: `סיכום היסטורי` with one row per year × per metric:
   - Col A: year (number)
   - Col B..N: same column shape as `מאזן חברה` row 6..14 (annual + 12 months)
   - One section per metric (revenue, orders, rawMat, marketing, shipping, ops, totalExp, netProfit, marginPct), separated by a blank row.
2. Backup first. `_backupCompanyDashboard_(ss)` from `bot/personal_sheet_fix.gs:132` — never write before backup.
3. Apply the dropdown via Apps Script. The validation must list ONLY years for which data exists (live current year + every distinct year in `סיכום היסטורי` col A):
   ```js
   function ADD_YEAR_SELECTOR_B4() {
     var ss = SpreadsheetApp.openById('<TENANT_SPREADSHEET_ID>');
     var dash = ss.getSheetByName('מאזן חברה'); // מאזן חברה
     if (!dash) { Logger.log('FAIL: no מאזן חברה'); return; }
     var hist = ss.getSheetByName('סיכום היסטורי'); // סיכום היסטורי
     var nowYear = new Date().getFullYear();
     var years = [nowYear];
     if (hist) {
       var lastRow = hist.getLastRow();
       if (lastRow >= 2) {
         var col = hist.getRange(2, 1, lastRow - 1, 1).getValues();
         for (var i = 0; i < col.length; i++) {
           var y = parseInt(col[i][0], 10);
           if (y && years.indexOf(y) < 0) years.push(y);
         }
       }
     }
     years.sort(function (a, b) { return b - a; }); // newest first
     var rule = SpreadsheetApp.newDataValidation()
       .requireValueInList(years.map(String), true)
       .setAllowInvalid(false)
       .setHelpText('בחר שנה לתצוגה')
       .build();
     dash.getRange('B4').setDataValidation(rule);
     dash.getRange('B4').setValue(nowYear); // default to current
     Logger.log('Dropdown set with years: ' + years.join(', '));
   }
   ```
4. Wrap every dashboard formula with `IFS(B4=<currentYear>, <live formula>, B4<>"", <snapshot lookup>)`. Pattern for the revenue row (was: just the live `SUMIFS`):
   ```js
   // Old: =IFERROR(SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, ">="&DATE($B$4,1,1), 'הזמנות'!A:A, "<"&DATE($B$4,2,1)), 0)
   // New: live for currentYear, snapshot lookup otherwise.
   // INDEX/MATCH on סיכום היסטורי where col A == $B$4 + section offset for the metric.
   var historicYear = "INDEX('סיכום היסטורי'!C:C, MATCH($B$4&\"|revenue\", 'סיכום היסטורי'!A:A&\"|\"&'סיכום היסטורי'!B:B, 0))";
   var liveFormula = "IFERROR(SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, \">=\"&DATE($B$4,1,1), 'הזמנות'!A:A, \"<\"&DATE($B$4,2,1)), 0)";
   var wrapped = "=IFS($B$4=" + nowYear + ", " + liveFormula + ", TRUE, IFERROR(" + historicYear + ", 0))";
   dash.getRange(6, 3).setFormula(wrapped); // C6 = January revenue
   ```
   Note: every Hebrew tab name is `\u05XX`-encoded per `sheet-hebrew-encoding-safe-script` — Apps Script editor mangles direct Hebrew on paste.
5. Repeat the wrap for rows 6-14 cols B..N. Or better — reuse the `_buildRevenueFormulas_` / `_buildBusinessRowFormulas_` builders in `bot/personal_sheet_fix.gs:74-95` and wrap each returned string in the `IFS` shell.
6. Test. Set B4 = current year — every cell should match the pre-existing live values exactly. Set B4 = a prior year present in snapshot — should match the snapshot row. Set B4 = a year not in the dropdown — Sheets blocks the entry (because `setAllowInvalid(false)`).

## Verification

- `node tests/full_qa.js` — green.
- Set B4 to current year; compare `מאזן חברה` to baseline screenshot — should be identical.
- Set B4 to prior year; verify it pulls from `סיכום היסטורי` (turn off live תנועות for that month — should still show snapshot value).
- Edge case: empty snapshot tab — dropdown should fall back to current year only.

## Examples

- **2026-05-28 — Steven's brief**: "אני רוצה לראות גם שנים קודמות בדשבורד עם dropdown ב-B4". Implementation = this skill: add דרופ דאון to `מאזן חברה`!B4, wire IFS wrappers, snapshot `סיכום היסטורי` from end-of-year close.
- **Anti-pattern**: hardcoding the year as `2026` in the formulas — every Jan 1 the dashboard breaks. Always reference `$B$4`.

## Common pitfalls

- Forgetting to `setAllowInvalid(false)` — users type a typo, formulas all return 0, support ticket.
- `IFS(B4=currentYear, ..., TRUE, ...)` — the `TRUE` literal as a fallback condition is intentional, mirrors Excel's `IFS`. Sheets supports it.
- Snapshot lookup uses INDEX/MATCH on a concatenated key (`$B$4&"|metric"`) — slower than a per-metric XLOOKUP. Use XLOOKUP if the tenant's snapshot has >100 rows.
- Pasting Hebrew tab names into the editor as literal Hebrew — bidi marks corrupt the string on Cmd+S in some browsers. ALWAYS use `\u05XX` escapes — see `sheet-hebrew-encoding-safe-script`.
- Wiring the IFS wrapper but forgetting `setNumberFormat` — the cell loses its `₪` currency format. Re-apply via `dash.getRange(6, 2, 1, 13).setNumberFormat('"₪"#,##0')`.

## Related skills

- [[sheet-spec-modify]] — for the template-side change (provisioning new tenants with the dropdown built-in).
- [[sheet-recompute-dashboard]] — to backfill the IFS wrappers across existing tenants after this lands.
- [[sheet-hebrew-encoding-safe-script]] — for the Hebrew tab-name escapes.
- [[verify-data-sources-before-formula-repair]] — pre-flight before wrapping formulas; confirm `סיכום היסטורי` exists and has the right shape.
