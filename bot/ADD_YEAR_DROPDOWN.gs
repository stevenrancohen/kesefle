// ADD_YEAR_DROPDOWN.gs -- add a clickable year dropdown (2023-2030) to the
// maazan-ishi year cell, like maazan hevra already has.
// =============================================================================
// WHY
//   DB_REBUILD_RECON proved maazan ishi is already year-aware: every row reads
//   the year from cell B2 (=SUMIFS(..., $B$2&"-01", ...)). So switching years
//   ALREADY works -- the data for every year lives in the tnuot tab. The only
//   thing missing is a dropdown so Steven can click the "2026" cell and pick a
//   year instead of typing it. This adds exactly that.
//
// SAFE
//   - Adds a data-validation dropdown to ONE cell (the year cell). It does NOT
//     change the year value, any formula, or any data.
//   - AYD_DRY_RUN writes nothing -- it just reports which cell it found + its
//     current value + whether it already has a dropdown.
//   - AYD_APPLY gated by Script Property CONFIRM_ADD_YEAR_DROPDOWN = "YES I UNDERSTAND".
//   - AYD_ROLLBACK removes the dropdown.
//   - Never opens the OLD sheet.
//
// USAGE
//   1. AYD_SELF_TEST_HEBREW -> Run
//   2. AYD_DRY_RUN -> Run -> confirms the year cell
//   3. Project Settings -> Script Properties -> CONFIRM_ADD_YEAR_DROPDOWN = YES I UNDERSTAND
//   4. AYD_APPLY -> Run  -> click the year cell in maazan ishi: a dropdown appears.
//
// Hebrew \uXXXX-escaped. Comments ASCII.
// =============================================================================

var _AYD_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _AYD_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';   // maazan ishi
var _AYD_YEARS_        = ['2023', '2024', '2025', '2026', '2027', '2028', '2029', '2030'];
var _AYD_CONFIRM_PROP_ = 'CONFIRM_ADD_YEAR_DROPDOWN';
var _AYD_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _AYD_BACKUP_PROP_  = 'AYD_BACKUP_YEARCELL';

function _ayd_ss_() { return SpreadsheetApp.openById(_AYD_NEW_SHEET_ID_); }
function _ayd_colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function AYD_SELF_TEST_HEBREW() {
  Logger.log('=== AYD_SELF_TEST_HEBREW ===');
  Logger.log('Personal tab: ' + _AYD_PERSONAL_);
  Logger.log('Years: ' + _AYD_YEARS_.join(', '));
  Logger.log('If the Hebrew above is readable, encoding is fine.');
  return 'ok';
}

// Find the year cell: first cell in rows 1-6 / cols A-N whose value is 2023-2030.
// Returns {row, col} (1-based) or null.
function _ayd_findYearCell_(sh) {
  var rows = Math.min(sh.getLastRow(), 6);
  var disp = sh.getRange(1, 1, rows, 14).getDisplayValues();
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < 14; c++) {
      var v = String(disp[r][c] || '').replace(/[^0-9]/g, '');
      if (/^(202[0-9]|2030)$/.test(v)) return { row: r + 1, col: c + 1, val: disp[r][c] };
    }
  }
  return null;
}

function AYD_DRY_RUN() {
  Logger.log('=== AYD_DRY_RUN (writes nothing) ===');
  var sh = _ayd_ss_().getSheetByName(_AYD_PERSONAL_);
  if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }
  var yc = _ayd_findYearCell_(sh);
  if (!yc) { Logger.log('!! no year cell (2023-2030) found in rows 1-6.'); return 'no-year'; }
  var a1 = _ayd_colLetter_(yc.col) + yc.row;
  var cell = sh.getRange(yc.row, yc.col);
  var dv = cell.getDataValidation();
  Logger.log('Year cell: ' + a1 + ' = ' + yc.val + '   current dropdown: ' + (dv ? 'YES (will be replaced)' : 'NO (will be added)'));
  Logger.log('Plan on APPLY: add a dropdown on ' + a1 + ' with values ' + _AYD_YEARS_.join('/') + '.');
  Logger.log('This does NOT change the value (' + yc.val + ') or any formula -- it only lets you click to pick a year.');
  Logger.log('To apply: set Script Property ' + _AYD_CONFIRM_PROP_ + ' = ' + _AYD_CONFIRM_VAL_ + ' then run AYD_APPLY.');
  return 'ok';
}

function AYD_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_AYD_CONFIRM_PROP_) !== _AYD_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _AYD_CONFIRM_PROP_ + ' = ' + _AYD_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _ayd_ss_().getSheetByName(_AYD_PERSONAL_);
    if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }
    var yc = _ayd_findYearCell_(sh);
    if (!yc) { Logger.log('!! no year cell found.'); return 'no-year'; }
    var cell = sh.getRange(yc.row, yc.col);
    var a1 = _ayd_colLetter_(yc.col) + yc.row;
    // Record whether a dropdown existed before (for rollback).
    props.setProperty(_AYD_BACKUP_PROP_, JSON.stringify({ row: yc.row, col: yc.col, hadValidation: !!cell.getDataValidation(), at: new Date().toISOString() }));
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(_AYD_YEARS_, true)   // true = show dropdown arrow
      .setAllowInvalid(false)
      .build();
    cell.setDataValidation(rule);
    SpreadsheetApp.flush();
    Logger.log('APPLIED: dropdown added on ' + a1 + ' (' + _AYD_YEARS_.join('/') + '). Value unchanged = ' + yc.val + '.');
    Logger.log('Click that cell in maazan ishi -- you can now pick any year, and every row updates.');
    Logger.log('Undo with AYD_ROLLBACK.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function AYD_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_AYD_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _ayd_ss_().getSheetByName(_AYD_PERSONAL_);
    var cell = sh.getRange(bak.row, bak.col);
    if (!bak.hadValidation) { cell.clearDataValidations(); Logger.log('Removed the dropdown (none existed before).'); }
    else { Logger.log('A dropdown existed before APPLY; left the current one in place (cannot reconstruct the exact old rule).'); }
    SpreadsheetApp.flush();
    props.deleteProperty(_AYD_BACKUP_PROP_);
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}
