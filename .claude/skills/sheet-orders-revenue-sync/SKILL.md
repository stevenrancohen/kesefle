---
name: sheet-orders-revenue-sync
description: Verify the sum of הזמנות salePrice for the current month matches מחזור ברוטו on מאזן חברה for the same month. Discrepancy → row-by-row diff so you can find the missing or stray order.
---

# Orders vs revenue sync check

The dashboard's `💰 מחזור ברוטו` (`מאזן חברה!C6:N6` per month) is computed as `SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, date-range)` (see `lib/sheet-writer.js:443`). If the bot writes the order row but the dashboard formula has a stale date column reference, or the user moved a row by hand, the totals lie. This skill detects the drift and lists the offending rows.

## Steps

1. Decide the month to check (default: current). Capture YYYY-MM.
2. Apps Script function:
   ```js
   function ORDERS_REVENUE_SYNC(year, month) {
     var SHEET_ID = 'PUT_SHEET_ID_HERE';
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var orders = ss.getSheetByName('הזמנות');
     var dash = ss.getSheetByName('מאזן חברה');
     if (!orders || !dash) { Logger.log('FAIL: missing tab'); return; }
     // Sum הזמנות col D (salePrice) for rows whose col A date is in [year, month].
     var ordersData = orders.getRange(2, 1, orders.getLastRow() - 1, 4).getValues();
     var monthStart = new Date(year, month - 1, 1);
     var monthEnd = new Date(year, month, 1);
     var sumOrders = 0;
     var rows = [];
     ordersData.forEach(function(r, i) {
       var d = r[0];
       if (!(d instanceof Date)) return;
       if (d >= monthStart && d < monthEnd) {
         var price = Number(r[3]) || 0;
         sumOrders += price;
         rows.push({ row: i + 2, date: d, price: price });
       }
     });
     // Read the dashboard's matching cell. Column for month M is column (M+2) on row 6 (per lib/sheet-writer.js layout).
     var dashCell = dash.getRange(6, month + 2).getValue();
     var sumDash = Number(dashCell) || 0;
     var diff = sumOrders - sumDash;
     Logger.log('orders=' + sumOrders + ' dash=' + sumDash + ' diff=' + diff);
     if (Math.abs(diff) > 0.01) {
       Logger.log('Discrepancy! Rows in הזמנות for ' + year + '-' + month + ':');
       Logger.log(JSON.stringify(rows, null, 2));
     }
   }
   ```
3. Run for the target month. Inspect.
4. If diff ≠ 0:
   - Confirm the dashboard cell is a formula, not a static value (a user might have typed over it):
     ```js
     dash.getRange(6, month + 2).getFormula()
     ```
   - If formula is empty → user overwrote it. Restore via `sheet-recompute-dashboard` or `sheet-broken-formula` skill, depending on scope.
   - If formula is intact but result wrong → likely the date column is the wrong type (string vs Date). Spot-check a row's `getValue() instanceof Date`.

## Verification
- After fix: `diff` is within ±0.01 for every month in the year.
- Dashboard cell is a formula, not a literal.
- `sheet-formula-audit` shows no broken refs touching הזמנות.

## Common pitfalls
- Comparing the wrong month — JavaScript `Date` months are 0-indexed; the helper above expects `month` 1-indexed.
- הזמנות col D is sometimes total-with-tax, sometimes pre-tax — confirm what the dashboard formula sums in `lib/sheet-writer.js:443`.
- Floating-point comparison without an epsilon → `0.001` rounding looks like drift but isn't.

## Examples
- "May totals on dashboard look low — verify" → run for 2026/5, see if rows are present but unsummed.
- "Pre-monthly-report sanity check" → run for last month, expect zero drift.
