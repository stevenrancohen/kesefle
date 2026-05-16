// SORT_AND_FEATURES.gs - 3 user-requested enhancements
// 1. SORT_TNUOT_NEWEST_FIRST() - one-time sort of תנועות by date desc
// 2. INSTALL_NEWEST_FIRST_TRIGGER() - auto-sort on every new row
// 3. ADD_CHECKMARK_COLUMN() - one-time mark all existing rows with checkmark
//    (bot patch to auto-mark new rows is a separate small change in ExpenseBot)

var KESEFLE_SHEET_ID_SF = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var TNUOT_TAB = 'תנועות';
var DATE_COL = 1;       // col A = date (תאריך)
var STATUS_COL = 8;     // col H = status (new column for checkmark)

// ============================================================
// 1. ONE-TIME SORT: newest dates at top
// ============================================================
function SORT_TNUOT_NEWEST_FIRST() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_SF);
  var sh = ss.getSheetByName(TNUOT_TAB);
  if (!sh) throw new Error('tab not found: ' + TNUOT_TAB);

  // Backup first
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_tnuot_' + ts;
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var bak = ss.insertSheet(bakName);
  bak.getRange(1, 1, lastRow, lastCol).setValues(sh.getRange(1, 1, lastRow, lastCol).getValues());

  // Sort rows 2..lastRow by col A (date) descending
  if (lastRow > 2) {
    sh.getRange(2, 1, lastRow - 1, lastCol).sort({ column: DATE_COL, ascending: false });
  }
  // Freeze header row
  sh.setFrozenRows(1);

  Logger.log('Sorted ' + (lastRow - 1) + ' rows. Backup: ' + bakName);
  try { SpreadsheetApp.getUi().alert('Sorted ' + (lastRow - 1) + ' rows newest-first.\nBackup: ' + bakName); } catch (e) {}
}

// ============================================================
// 2. AUTO-SORT trigger: re-sort every time a new row is added
// ============================================================
function INSTALL_NEWEST_FIRST_TRIGGER() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_SF);
  // Remove existing triggers with the same function name
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === '_AUTO_SORT_TNUOT_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Install new onChange trigger
  ScriptApp.newTrigger('_AUTO_SORT_TNUOT_').forSpreadsheet(ss).onChange().create();
  Logger.log('Installed auto-sort trigger for ' + TNUOT_TAB);
  try { SpreadsheetApp.getUi().alert('Auto-sort installed. Every new row will trigger a re-sort by date desc.'); } catch (e) {}
}

function _AUTO_SORT_TNUOT_(e) {
  // Only act on INSERT_ROW events to avoid sort-thrashing on every edit
  if (e && e.changeType && e.changeType !== 'INSERT_ROW' && e.changeType !== 'OTHER') return;
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_SF);
  var sh = ss.getSheetByName(TNUOT_TAB);
  if (!sh) return;
  var lastRow = sh.getLastRow();
  if (lastRow < 3) return;
  sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).sort({ column: DATE_COL, ascending: false });
}

function UNINSTALL_NEWEST_FIRST_TRIGGER() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === '_AUTO_SORT_TNUOT_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' triggers');
  try { SpreadsheetApp.getUi().alert('Removed ' + removed + ' auto-sort triggers.'); } catch (e) {}
}

// ============================================================
// 3. ADD CHECKMARK to existing rows (and reserve col H going forward)
// ============================================================
function ADD_CHECKMARK_COLUMN() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_SF);
  var sh = ss.getSheetByName(TNUOT_TAB);
  if (!sh) throw new Error('tab not found');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  // Set header in col H if empty
  var hdr = sh.getRange(1, STATUS_COL).getValue();
  if (!hdr) sh.getRange(1, STATUS_COL).setValue('סטטוס');

  // Fill all existing rows with checkmark (only empty cells)
  var data = sh.getRange(2, STATUS_COL, lastRow - 1, 1).getValues();
  var updates = [];
  for (var i = 0; i < data.length; i++) {
    updates.push([data[i][0] || '✅']);
  }
  sh.getRange(2, STATUS_COL, updates.length, 1).setValues(updates);

  Logger.log('Marked ' + updates.length + ' rows with ✅');
  try { SpreadsheetApp.getUi().alert('Added ✅ to ' + updates.length + ' rows in col H'); } catch (e) {}
}

// ============================================================
// Quick verification
// ============================================================
function VERIFY_SORT_AND_FEATURES() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_SF);
  var sh = ss.getSheetByName(TNUOT_TAB);
  var lastRow = sh.getLastRow();
  var firstDate = sh.getRange(2, 1).getValue();
  var lastDate = sh.getRange(lastRow, 1).getValue();
  var firstStatus = sh.getRange(2, STATUS_COL).getValue();
  var triggers = ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction() === '_AUTO_SORT_TNUOT_';});
  var report = [
    'rows total: ' + lastRow,
    'row 2 date (should be newest): ' + firstDate,
    'last row date (should be oldest): ' + lastDate,
    'row 2 col H (checkmark): ' + firstStatus,
    'auto-sort triggers installed: ' + triggers.length,
    'frozen rows: ' + sh.getFrozenRows()
  ];
  Logger.log(report.join('\n'));
  try { SpreadsheetApp.getUi().alert(report.join('\n')); } catch (e) {}
}
