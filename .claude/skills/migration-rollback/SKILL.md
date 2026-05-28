---
name: migration-rollback
description: For a given migration tag (e.g. Migration_Phase_2_v1), generate the row-filter + delete plan in NEW sheet. DRY_RUN only — Steven runs the actual delete after review.
---

# Migration rollback (selective delete by tag)

Every migration script (`bot/MIGRATE_OLD_TO_KESEFLE.gs`, `bot/MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs`) tags every row it writes in the source column (col J on `תנועות`) with `_MIG_VERSION_` (e.g. `Migration_Phase_2_v1`). This makes rollback surgical: filter col J = tag, delete matching rows. This skill generates the plan; Steven approves; Steven runs the delete (NEVER auto-delete).

## Steps

1. Confirm the tag to roll back:
   ```
   grep -nE "_MIG_VERSION_" bot/MIGRATE_*.gs
   ```
2. Confirm a snapshot exists for the day the migration ran:
   ```
   ls snapshots/$(date +%F)/ 2>/dev/null || ls snapshots/ | tail -10
   ```
   If no snapshot → STOP. Run `sheet-snapshot-backup` of the CURRENT state first (rolling back without a "current" snapshot leaves no undo).
3. DRY_RUN scan function:
   ```js
   function DRY_RUN_ROLLBACK(tag) {
     var SHEET_ID = 'PUT_NEW_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var sh = ss.getSheetByName('תנועות');
     var last = sh.getLastRow();
     if (last < 2) { Logger.log('empty'); return; }
     // col J = source-tag (index 9, 0-based) → in 1-based getRange, col 10
     var values = sh.getRange(2, 1, last - 1, 10).getValues();
     var hits = [];
     for (var i = 0; i < values.length; i++) {
       if (String(values[i][9] || '') === tag) {
         hits.push({ row: i + 2, date: values[i][0], amount: values[i][1], desc: values[i][2] });
       }
     }
     Logger.log('tag=' + tag + ' matches=' + hits.length);
     Logger.log('first 5: ' + JSON.stringify(hits.slice(0, 5), null, 2));
     Logger.log('last 5: ' + JSON.stringify(hits.slice(-5), null, 2));
   }
   // Call: DRY_RUN_ROLLBACK('Migration_Phase_2_v1');
   ```
4. Steven runs DRY_RUN, pastes the log. Confirm the count matches the migration's "wrote N rows" number from the original DRY_RUN review.
5. Write the APPLY function (separate file, separate function) but DO NOT RUN. Steven runs it after he approves:
   ```js
   function APPLY_ROLLBACK(tag) {
     var SHEET_ID = 'PUT_NEW_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var sh = ss.getSheetByName('תנועות');
     var last = sh.getLastRow();
     var values = sh.getRange(2, 1, last - 1, 10).getValues();
     var rows = [];
     for (var i = 0; i < values.length; i++) {
       if (String(values[i][9] || '') === tag) rows.push(i + 2);
     }
     // Bottom-up so indices stay valid.
     rows.sort(function(a,b){return b-a}).forEach(function(r) { sh.deleteRow(r); });
     Logger.log('Rolled back ' + rows.length + ' rows for tag ' + tag);
   }
   ```
6. Add an audit entry (`audit-log-add`) BEFORE Steven runs APPLY (so the log captures intent even if the delete fails mid-way).
7. After APPLY: re-run DRY_RUN → expect 0 matches. Run `sheet-recompute-dashboard` to refresh dashboard SUMIFS.

## Verification
- DRY_RUN count matches the original migration's row count.
- Snapshot of CURRENT (pre-rollback) state exists in `snapshots/`.
- Audit log entry captures: tag, row count, who, when.
- After APPLY: DRY_RUN → 0; dashboard recomputed; spot-check a couple of years for missing-but-shouldn't-be-missing rows.

## Common pitfalls
- Rolling back without taking a snapshot of the CURRENT state → if the rollback was wrong, there's no undo of the undo.
- Tag string typo — `Migration_Phase_2_v1` vs `migration_phase_2_v1` — case-sensitive comparison in the snippet.
- Forgetting that the migration might have ALSO written to הזמנות (orders tab). Repeat the scan for the orders tab if so.

## Examples
- "Phase 2 had wrong category column — roll it back and redo" → DRY_RUN, hand to Steven, he runs APPLY, fix the script, re-run migration.
- "User says May 2024 looks weird after Phase 2" → DRY_RUN for `Migration_Phase_2_v1`, narrow to that month, decide if rollback is wider than that month.
