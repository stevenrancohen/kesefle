/**
 * Steven's personal "מאזן אישי" sheet fixer
 * --------------------------------------------------
 * Standalone Apps Script. Paste into your personal sheet's
 * script editor (Extensions -> Apps Script), then run
 * `fixCompanyDashboardFormulas` from the runner dropdown.
 *
 * What it does
 *   Overwrites the four "business expense" formula rows in the
 *   'מאזן חברה' tab (rows 8..11, columns B..N) with the same
 *   wildcard + multi-criteria SUMIFS the Kesefle template uses.
 *   The classifier writes long subcategory strings ("עלות שיווק",
 *   "עלות חומרי גלם", "הוצאות תפעוליות", "יועצים", ...) — the
 *   formulas now match all of them via *X* wildcards + additive
 *   SUMIFS, so nothing falls through the cracks.
 *
 * What it does NOT touch
 *   Your data, your other tabs, your menu, or any other formula.
 *   Only the 4 rows of business-expense SUMIFS in 'מאזן חברה'.
 *
 * Safe to run multiple times — purely idempotent.
 */

// Must mirror lib/sheet-writer.js COMPANY_EXPENSE_ROWS in the Kesefle repo.
// Each entry's `criteria` array becomes one SUMIFS per criterion, all
// summed together. Wildcards (*X*) work in Sheets SUMIFS text criteria.
var COMPANY_EXPENSE_ROWS_FIX = [
  { rowNum: 8,  label: 'עלות חומרי גלם',  criteria: ['*חומרי גלם*'] },
  { rowNum: 9,  label: 'עלות שיווק',      criteria: ['*שיווק*'] },
  { rowNum: 10, label: 'משלוחים והתקנות', criteria: ['*משלוח*', '*אריזה*'] },
  { rowNum: 11, label: 'הוצאות תפעוליות', criteria: ['*תפעולי*', 'יועצים', 'תוכנות', 'ציוד עסקי', 'מיסים'] },
];

var TX_TAB_NAME = 'תנועות';
var COMPANY_TAB_NAME = 'מאזן חברה';

function fixCompanyDashboardFormulas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Did not find a "' + COMPANY_TAB_NAME + '" tab. Make sure the tab name matches exactly.');
    return;
  }

  // Build a 4x13 matrix: col B (annual SUM) + cols C..N (Jan..Dec).
  var matrix = [];
  for (var i = 0; i < COMPANY_EXPENSE_ROWS_FIX.length; i++) {
    var item = COMPANY_EXPENSE_ROWS_FIX[i];
    var rowCells = [];
    // Col B: annual sum across the row.
    rowCells.push('=SUM(C' + item.rowNum + ':N' + item.rowNum + ')');
    // Cols C..N: one SUMIFS per criterion, summed.
    for (var m = 1; m <= 12; m++) {
      var mm = m < 10 ? ('0' + m) : ('' + m);
      var parts = item.criteria.map(function (cr) {
        var safe = String(cr).replace(/"/g, '""');
        return "SUMIFS('" + TX_TAB_NAME + "'!C:C, '" + TX_TAB_NAME + "'!B:B, $B$4&\"-" + mm + "\", '" + TX_TAB_NAME + "'!D:D, \"עסק\", '" + TX_TAB_NAME + "'!E:E, \"" + safe + "\")";
      });
      var sumExpr = parts.length ? parts.join(' + ') : '0';
      rowCells.push('=IFERROR(' + sumExpr + ', 0)');
    }
    matrix.push(rowCells);
  }

  // Write to B8:N11 in one shot. setFormulas treats every cell as a
  // formula, so the '=' prefix in our strings is honored.
  sheet.getRange('B8:N11').setFormulas(matrix);

  SpreadsheetApp.getUi().alert(
    'Fixed ' + matrix.length + ' rows.\n\n' +
    'Recompute is automatic. If you do not see the new sums right away,\n' +
    'press Ctrl/Cmd + R to refresh, or close + reopen the tab.'
  );
}

/**
 * Optional: install a menu item so you can re-run the fix anytime.
 * Call this once from the editor; it adds "תקן מאזן חברה" to the
 * top menu bar of your sheet. After that, any future fix is one click.
 */
function installMenu() {
  SpreadsheetApp.getUi()
    .createMenu('🛠️ Kesefle Fix')
    .addItem('תקן נוסחאות מאזן חברה', 'fixCompanyDashboardFormulas')
    .addToUi();
}

/**
 * Auto-install the menu when the sheet is opened. Apps Script will call
 * onOpen() automatically. If you already have an onOpen() in your sheet,
 * just call installMenu() from there.
 */
function onOpen() {
  try { installMenu(); } catch (_e) {}
}
