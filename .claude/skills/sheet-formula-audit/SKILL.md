---
name: sheet-formula-audit
description: For a given sheet ID + tab, list every cell whose formula references a tab name that doesn't exist in the workbook. Outputs CSV — used to catch broken cross-tab references after a tab rename or restructure.
---

# Formula audit (cross-tab reference check)

After renaming a tab, restructuring the template, or migrating a sheet, formulas like `=SUMIFS('הזמנות'!D:D, ...)` or `=COUNTIFS('תנועות'!A:A, ...)` silently break if the referenced tab doesn't exist. Google returns `#REF!` for the cell but the bot doesn't notice. This skill audits the whole sheet and produces a CSV of broken refs.

## Required env
- `GOOGLE_SERVICE_ACCOUNT_JSON` or the Apps Script-side equivalent (Steven runs it inside Apps Script when KV-side won't authorize the sheet).

## Steps

1. Run the audit script — the cleanest way is from inside Apps Script with the SHEET_ID hardcoded. Create a one-off function in the bot project:
   ```js
   function AUDIT_FORMULA_REFS() {
     var ss = SpreadsheetApp.openById('PUT_SHEET_ID_HERE');
     var existingTabs = ss.getSheets().map(function(s){ return s.getName(); });
     var existingSet = {};
     existingTabs.forEach(function(n){ existingSet[n] = true; });
     var report = [['tab', 'a1', 'broken_ref', 'formula']];
     ss.getSheets().forEach(function(sh) {
       var range = sh.getDataRange();
       var formulas = range.getFormulas();
       for (var r = 0; r < formulas.length; r++) {
         for (var c = 0; c < formulas[r].length; c++) {
           var f = formulas[r][c];
           if (!f) continue;
           var m = f.match(/'([^']+)'!|\b([A-Za-zא-ת_][A-Za-zא-ת0-9_ ]*)!/g) || [];
           m.forEach(function(ref) {
             var name = ref.replace(/^'|'?!$/g, '').replace(/!$/, '');
             if (!existingSet[name]) {
               report.push([sh.getName(), sh.getRange(r+1, c+1).getA1Notation(), name, f]);
             }
           });
         }
       }
     });
     Logger.log(report.map(function(r){return r.join(',')}).join('\n'));
   }
   ```
2. Run it. Copy the log into a file under `snapshots/{date}/formula-audit-{sheetid}.csv`.
3. If the report has rows: for each broken ref, decide — rename the formula's tab reference, recreate the missing tab, or delete the formula cell.
4. After fixing, re-run AUDIT_FORMULA_REFS to confirm zero broken refs.

## Verification
- Final report has ONLY the header row.
- Open the sheet — no `#REF!` cells visible on any tab.
- The bot's dashboard recompute (`sheet-recompute-dashboard`) runs without errors.

## Common pitfalls
- Tabs whose name contains an apostrophe — Google escapes them weirdly; the regex above misses them. Eyeball the long-tail.
- `INDIRECT("'" & A1 & "'!B2")` — runtime-resolved; the audit can't catch them. Search for `INDIRECT\(` separately and check by hand.
- Running on the bot-owner sheet without backup → `sheet-snapshot-backup` first.

## Examples
- "After Phase 2 migration, audit the new sheet for broken formulas" → run, expect zero.
- "Steven renamed דשבורד → מאזן חברה, what broke?" → run, see all formulas that still reference דשבורד.
