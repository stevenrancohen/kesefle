/**
 * Standalone dashboard fixer — works in EITHER:
 *   (A) a script bound to a Google Sheet (Extensions -> Apps Script
 *       opened from inside the sheet) — auto-detects the active sheet.
 *   (B) a STANDALONE script project (like Steven's "importjason"
 *       project that hosts the bot) — set SHEET_ID_TO_FIX below.
 *
 * What each function does
 *   fixCompanyDashboardFormulas()  → rewrites rows 8..11 of
 *       'מאזן חברה' with the wildcard + multi-criteria SUMIFS that
 *       catches every business-subcategory string the bot writes.
 *   fixPersonalDashboardFormulas() → wildcard-wraps every data row
 *       of 'מאזן אישי' so any classifier write CONTAINING the row
 *       label rolls in (e.g. "מוצרי טיפוח ויופי" → "טיפוח" row).
 *
 * Safe to run repeatedly. Idempotent. Touches only formula cells of
 * the dashboard tabs; no data is modified.
 *
 * NO menu, NO getUi() — runs cleanly from a standalone script editor.
 * Watch the Execution Log (יומן ביצוע) for results.
 */

// ─── CONFIGURE ME ─────────────────────────────────────────────────────────
// Paste the spreadsheet ID of YOUR sheet here. To find it: open the sheet
// in your browser; the URL looks like
//   https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
// Steven's personal "מאזן אישי" sheet ID (extracted from his earlier link).
var SHEET_ID_TO_FIX = '1nRR9w6kU7hPx_62gsPy7-a4_ABurtGuvfhW4XkOinXU';

// Tab names — change only if your sheet uses different names.
var TX_TAB_NAME      = 'תנועות';
var COMPANY_TAB_NAME = 'מאזן חברה';
var PERSONAL_TAB_NAME = 'מאזן אישי';

// ─── No need to edit below this line ──────────────────────────────────────

// Resolve the target spreadsheet. Prefer the active spreadsheet if the
// script is sheet-bound; otherwise open by SHEET_ID_TO_FIX.
function _openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act) return act;
  } catch (_) { /* getActiveSpreadsheet throws in standalone context */ }
  if (!SHEET_ID_TO_FIX || SHEET_ID_TO_FIX.indexOf('<') >= 0) {
    throw new Error('SHEET_ID_TO_FIX is not set. Paste your sheet ID at the top of this file.');
  }
  return SpreadsheetApp.openById(SHEET_ID_TO_FIX);
}

// ────────────────────────────────────────────────────────────────────────
// COMPANY dashboard — fix rows 8..11 with multi-criteria + wildcard SUMIFS
// ────────────────────────────────────────────────────────────────────────
var COMPANY_EXPENSE_ROWS_FIX = [
  { rowNum: 8,  label: 'עלות חומרי גלם',  criteria: ['*חומרי גלם*'] },
  { rowNum: 9,  label: 'עלות שיווק',      criteria: ['*שיווק*'] },
  { rowNum: 10, label: 'משלוחים והתקנות', criteria: ['*משלוח*', '*אריזה*'] },
  { rowNum: 11, label: 'הוצאות תפעוליות', criteria: ['*תפעולי*', 'יועצים', 'תוכנות', 'ציוד עסקי', 'מיסים'] },
];

function fixCompanyDashboardFormulas() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!sheet) {
    Logger.log('FAIL: no "' + COMPANY_TAB_NAME + '" tab in ' + ss.getName());
    return;
  }

  var matrix = [];
  for (var i = 0; i < COMPANY_EXPENSE_ROWS_FIX.length; i++) {
    var item = COMPANY_EXPENSE_ROWS_FIX[i];
    var rowCells = [];
    // Col B: annual sum across the row.
    rowCells.push('=SUM(C' + item.rowNum + ':N' + item.rowNum + ')');
    // Cols C..N (Jan..Dec): one SUMIFS per criterion, summed.
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

  sheet.getRange('B8:N11').setFormulas(matrix);
  Logger.log('OK: company dashboard — wrote ' + matrix.length + ' rows of formulas in ' + ss.getName() + ' / ' + COMPANY_TAB_NAME);
}

// ────────────────────────────────────────────────────────────────────────
// PERSONAL dashboard — wildcard-wrap every data row's monthly SUMIFS so any
// subcategory CONTAINING the row label rolls in.
// ────────────────────────────────────────────────────────────────────────
function fixPersonalDashboardFormulas() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(PERSONAL_TAB_NAME);
  if (!sheet) {
    Logger.log('FAIL: no "' + PERSONAL_TAB_NAME + '" tab in ' + ss.getName());
    return;
  }
  var lastRow = Math.min(sheet.getLastRow(), 60);
  var labels = sheet.getRange('A1:A' + lastRow).getValues();
  var updates = 0;
  for (var r = 0; r < labels.length; r++) {
    var rowNum = r + 1;
    var label = String(labels[r][0] || '').trim();
    if (!label) continue;
    if (/^סה/.test(label)) continue;                          // totals row
    if (/[\u{1F300}-\u{1FAFF}]/u.test(label)) continue;       // section header w/ emoji
    if (rowNum < 5) continue;                                  // title + year cell area
    var newRow = [];
    for (var m = 1; m <= 12; m++) {
      var mm = m < 10 ? ('0' + m) : ('' + m);
      newRow.push("=IFERROR(SUMIFS('" + TX_TAB_NAME + "'!C:C, '" + TX_TAB_NAME + "'!B:B, $B$2&\"-" + mm + "\", '" + TX_TAB_NAME + "'!E:E, \"*\"&$A" + rowNum + "&\"*\"), 0)");
    }
    try { sheet.getRange('C' + rowNum + ':N' + rowNum).setFormulas([newRow]); updates++; } catch (_e) {}
  }
  Logger.log('OK: personal dashboard — wildcard-wrap on ' + updates + ' rows in ' + ss.getName() + ' / ' + PERSONAL_TAB_NAME);
}

// Convenience: run both fixes at once. Pick this in the runner dropdown
// if you want one click that does it all.
function fixBothDashboards() {
  try { fixCompanyDashboardFormulas(); } catch (e) { Logger.log('company fix err: ' + e.message); }
  try { fixPersonalDashboardFormulas(); } catch (e) { Logger.log('personal fix err: ' + e.message); }
  Logger.log('---');
  Logger.log('Both fixes done. Open the sheet, refresh (Cmd+R), check מאזן אישי + מאזן חברה.');
}
