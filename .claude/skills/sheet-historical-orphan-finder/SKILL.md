---
name: sheet-historical-orphan-finder
description: Compare OLD vs NEW sheet row counts per tab; produce a diff table. Use BEFORE Phase 2 APPLY to set Steven's expectations on how many rows will move and where shrinkage is suspicious.
---

# OLD vs NEW row-count diff

During the Kesefle sheet migration (see `bot/MIGRATE_OLD_TO_KESEFLE.gs`), the OLD sheet's per-year tabs (2023, 2024, 2025) feed into the NEW sheet's consolidated `תנועות` + `הזמנות` + `מאזן חברה`. Before pressing APPLY on Phase 2, we need a row-count diff to know what to expect and to spot anomalies (a year tab with zero migrated rows = parser bug, not "no expenses that year").

## Required input
- OLD_SHEET_ID
- NEW_SHEET_ID

## Steps

1. Apps Script function:
   ```js
   function ROW_COUNT_DIFF() {
     var OLD_ID = 'PUT_OLD_SHEET_ID_HERE';
     var NEW_ID = 'PUT_NEW_SHEET_ID_HERE';
     var old = SpreadsheetApp.openById(OLD_ID);
     var nw = SpreadsheetApp.openById(NEW_ID);
     var oldTabs = {}, newTabs = {};
     old.getSheets().forEach(function(s) { oldTabs[s.getName()] = s.getLastRow() - 1; });
     nw.getSheets().forEach(function(s) { newTabs[s.getName()] = s.getLastRow() - 1; });
     var allNames = {};
     Object.keys(oldTabs).forEach(function(n) { allNames[n] = true; });
     Object.keys(newTabs).forEach(function(n) { allNames[n] = true; });
     var rows = [['tab','old','new','diff','note']];
     Object.keys(allNames).sort().forEach(function(n) {
       var o = oldTabs[n] || 0, nw_ = newTabs[n] || 0;
       var diff = nw_ - o;
       var note = '';
       if (!oldTabs[n]) note = 'NEW only';
       else if (!newTabs[n]) note = 'OLD only — lost?';
       else if (Math.abs(diff) > 0 && Math.max(o, nw_) > 0 && Math.abs(diff)/Math.max(o,nw_) > 0.1) note = 'large shrinkage (>10%)';
       rows.push([n, o, nw_, diff, note]);
     });
     Logger.log(rows.map(function(r){return r.join(',')}).join('\n'));
   }
   ```
2. Run it. Save the CSV to `snapshots/{date}/row-count-diff.csv`.
3. Read the `note` column:
   - `NEW only` rows: expected if the new tab is consolidated (e.g. `תנועות` in NEW vs per-year in OLD). Sanity-check.
   - `OLD only — lost?`: STOP. A tab present in OLD but not NEW means migration didn't create or didn't carry. Investigate before APPLY.
   - `large shrinkage`: investigate. The migration script might be silently dropping rows that don't match its parse rules.
4. For each suspicious tab, sample a few rows from OLD and verify they're parseable by `bot/MIGRATE_OLD_TO_KESEFLE.gs` (`_MIG_VERSION_ = 'Migration_Phase_2_v1'`).

## Verification
- Diff CSV exists in snapshots folder.
- No `OLD only — lost?` rows for tabs that should have data (year tabs, ledger tabs).
- The total of all OLD per-year tab row counts is within 10% of NEW `תנועות` row count (allowing for the per-year vs consolidated remap).

## Common pitfalls
- Comparing `getLastRow()` raw without subtracting header rows → systematic +1 drift per tab.
- Forgetting that OLD's `דשבורד` is a computed dashboard with no rows to migrate — `note: OLD only — lost?` is fine here.
- Running on the wrong sheet IDs (Steven has multiple; double-check IDs against MEMORY notes).

## Examples
- "Pre-Phase-2-APPLY checklist" → run, save CSV, eyeball, only press APPLY if clean.
- "After Phase 1 ran, sanity check the carry" → run, confirm row counts match expectation.
