---
name: sheet-orphan-row-cleanup
description: Find rows in the NEW sheet's תנועות tab with no amount, no category, and no description (junk left by parse failures or aborts). DRY_RUN lists them, APPLY removes — backup-first.
---

# Orphan row cleanup (תנועות)

Over time, parser failures and abandoned conversations leave debris rows in `תנועות` — rows with a date and maybe a row-id but no amount, category, or description. They distort row counts, make audits harder, and pollute the dashboard's SUMIFS ranges (zero amount = harmless but cluttered).

## Steps

1. Run `sheet-snapshot-backup` first. Mandatory.
2. DRY_RUN function (Apps Script — paste into the bot project):
   ```js
   function DRY_RUN_ORPHAN_ROWS() {
     var SHEET_ID = 'PUT_NEW_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var sh = ss.getSheetByName('תנועות');
     if (!sh) { Logger.log('FAIL: no תנועות tab'); return; }
     // Skip header row.
     var last = sh.getLastRow();
     if (last < 2) { Logger.log('empty'); return; }
     // Columns (per lib/sheet-writer.js): A=date, B=amount, C=description, D=category, E=subcategory ...
     var values = sh.getRange(2, 1, last - 1, 5).getValues();
     var orphans = [];
     for (var i = 0; i < values.length; i++) {
       var row = values[i];
       var amt = Number(row[1]) || 0;
       var desc = String(row[2] || '').trim();
       var cat = String(row[3] || '').trim();
       var sub = String(row[4] || '').trim();
       if (amt === 0 && !desc && !cat && !sub) {
         orphans.push({ row: i + 2, date: row[0] });
       }
     }
     Logger.log('Orphans: ' + orphans.length);
     Logger.log(JSON.stringify(orphans.slice(0, 50), null, 2));
   }
   ```
3. Inspect the log. Confirm count is reasonable (a few dozen is normal; thousands = different problem; investigate).
4. APPLY function — delete bottom-up so row indices stay valid:
   ```js
   function APPLY_DELETE_ORPHAN_ROWS() {
     var SHEET_ID = 'PUT_NEW_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var sh = ss.getSheetByName('תנועות');
     var last = sh.getLastRow();
     var values = sh.getRange(2, 1, last - 1, 5).getValues();
     var rowsToDelete = [];
     for (var i = 0; i < values.length; i++) {
       var row = values[i];
       var amt = Number(row[1]) || 0;
       if (amt === 0 && !String(row[2]||'').trim() && !String(row[3]||'').trim() && !String(row[4]||'').trim()) {
         rowsToDelete.push(i + 2);
       }
     }
     rowsToDelete.sort(function(a,b){return b-a}).forEach(function(r) { sh.deleteRow(r); });
     Logger.log('Deleted ' + rowsToDelete.length + ' orphan rows');
   }
   ```
5. After APPLY: re-run DRY_RUN — should show 0.
6. Audit log entry (see `audit-log-add`).

## Verification
- DRY_RUN after APPLY returns 0 orphans.
- Dashboard totals unchanged (orphans had 0 amount → no effect on sums).
- `sheet-dashboard-row-validate` still passes.

## Common pitfalls
- Deleting top-down → row indices shift, you delete the wrong rows. Always bottom-up.
- Treating "no category" alone as orphan — a row with amount + description + no-category is legit (parser ASK'd, user replied with category in a follow-up that hasn't merged yet). The conjunctive `amount==0 AND empty all-text` is the correct filter.
- Running APPLY without DRY_RUN first → user-typed value goes away forever.

## Examples
- "Sheet has 8K rows but only 3K real ones" → run DRY_RUN, expect ~5K orphan count, APPLY, audit log entry.
- "Pre-migration cleanup before Phase 2" → run, clean, snapshot.
