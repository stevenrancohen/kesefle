---
name: sheet-dashboard-row-validate
description: For the מאזן חברה tab, verify every year-block has the 8 expected rows in the right order (revenue, orders, raw-materials, marketing, shipping, operational, total, net). Output discrepancies.
---

# Dashboard row-order validator

`מאזן חברה` (the company dashboard tab) is built by `_buildCompanyDashboardTab` in `lib/sheet-writer.js:415`. The canonical row order for each year block is:
1. R6 — `💰 מחזור ברוטו` (revenue, sum from הזמנות)
2. R7 — `📦 מס׳ הזמנות` (order count)
3. R8 — `🎨 עלות חומרי גלם`
4. R9 — `📣 עלות שיווק`
5. R10 — `🚚 משלוחים והתקנות`
6. R11 — `🏢 הוצאות תפעוליות`
7. R12 — `🧮 סה״כ הוצאות עסקיות` (= SUM(B8:B11))
8. R13 — `📈 רווח נטו חודשי` (= B6 − B12)

If these rows are missing, reordered, or contain user-typed values where formulas should be (rows 12+ marketing and 14 operations are a known user-edit hotspot per MEMORY.md), the dashboard lies. This skill validates the structure.

## Steps

1. Read the canonical row labels from source:
   ```
   grep -nE "(מחזור ברוטו|מס׳ הזמנות|חומרי גלם|עלות שיווק|משלוחים|הוצאות תפעוליות|סה״כ הוצאות|רווח נטו)" lib/sheet-writer.js
   ```
2. Validator function (Apps Script — run against the sheet of interest):
   ```js
   function VALIDATE_DASHBOARD_ROWS() {
     var EXPECTED = [
       '💰 מחזור ברוטו', '📦 מס׳ הזמנות', '🎨 עלות חומרי גלם',
       '📣 עלות שיווק', '🚚 משלוחים והתקנות', '🏢 הוצאות תפעוליות',
       '🧮 סה״כ הוצאות עסקיות', '📈 רווח נטו חודשי'
     ];
     var ss = SpreadsheetApp.openById('PUT_SHEET_ID_HERE');
     var sh = ss.getSheetByName('מאזן חברה');
     if (!sh) { Logger.log('FAIL: tab missing'); return; }
     // Walk col A from row 6 down; group into year-blocks separated by blank rows.
     var col = sh.getRange('A6:A' + sh.getLastRow()).getValues().map(function(r){return r[0]});
     var blocks = [], cur = [];
     col.forEach(function(v, i) {
       if (!v) { if (cur.length) blocks.push(cur); cur = []; return; }
       cur.push({ row: 6 + i, label: String(v).trim() });
     });
     if (cur.length) blocks.push(cur);
     var bad = [];
     blocks.forEach(function(blk, idx) {
       if (blk.length !== EXPECTED.length) {
         bad.push('block ' + idx + ' has ' + blk.length + ' rows (expected ' + EXPECTED.length + ')');
       }
       blk.forEach(function(cell, i) {
         var ex = EXPECTED[i] || '(none)';
         if (cell.label.indexOf(ex.replace(/^[^ ]+ /, '')) === -1) {
           bad.push('row ' + cell.row + ' expected "' + ex + '" got "' + cell.label + '"');
         }
       });
     });
     Logger.log(bad.length ? bad.join('\n') : 'OK ' + blocks.length + ' year-blocks valid');
   }
   ```
3. Run it. If `bad` is empty, the tab is structurally sound.
4. If discrepancies: do NOT auto-fix — Steven's user-typed rows at marketing/operations must be preserved (MEMORY: never_overwrite). Propose a manual edit list first.

## Verification
- Validator prints `OK N year-blocks valid` where N is the number of years in the sheet.
- Eyeball the sheet: each year's block has the 8 rows in order.
- Bot's dashboard formulas (`sheet-recompute-dashboard`) run without errors after.

## Common pitfalls
- Year-blocks separated by 2 blank rows instead of 1 → grouping off; tweak the split.
- Sheet uses an OLD layout where revenue is at a different row (pre-2026-05-16 net-profit-bug fix) → MEMORY note `expenses_year_tabs_real_structure.md` is the source of truth.
- Auto-fixing without backup → broken user data; always `sheet-snapshot-backup` first.

## Examples
- "After migration phase 1 to the new sheet, validate the dashboard structure" → run, expect OK.
- "Steven reports the 2024 net-profit row missing" → run, see the gap, propose a one-row insert.
