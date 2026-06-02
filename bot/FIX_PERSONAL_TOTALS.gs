// FIX_PERSONAL_TOTALS.gs  --  Phase 1: fix the maazan-ishi total-expenses formula
// =============================================================================
// WHAT IT FIXES
//   The live "se-kol hotzaot" (total expenses) row sums only PART of the
//   expenses (DIAGNOSE_BALANCES showed monthly = SUM(C28:C34), which misses
//   food / transport / misc sections entirely). This tool rewires that row to
//   = (fixed total) + (temporary total) + (food total) + (transport total) +
//     (misc total), per column, for B and C..N.
//
// HOW IT STAYS SAFE (Steven's iron rules)
//   - LABEL-WALKER: finds the 5 section-total rows + the grand-total row BY
//     THEIR HEBREW LABELS, never by hardcoded row numbers (your rows shifted).
//   - DRY_RUN writes NOTHING -- it logs the rows it found + the exact old vs
//     new formula so you can approve before any change.
//   - APPLY is gated by Script Property CONFIRM_FIX_PERSONAL_TOTALS = "YES I UNDERSTAND".
//   - APPLY backs up the grand-total row's B..N formulas to DocumentProperties
//     FIRST, then writes. FPT_ROLLBACK restores them exactly.
//   - LockService prevents concurrent runs.
//   - Only the ONE grand-total-expenses row is touched. Nothing else.
//   - Never opens the OLD sheet.
//
// USAGE
//   1. FPT_SELF_TEST_HEBREW  -> Run  (verify Hebrew)
//   2. FPT_DRY_RUN           -> Run  -> read the log, send it to Claude
//   3. (after approval) Project Settings -> Script Properties -> add
//      CONFIRM_FIX_PERSONAL_TOTALS = YES I UNDERSTAND  -> Save
//   4. FPT_APPLY             -> Run
//   5. Open maazan ishi: se-kol-hotzaot should now include food+transport+misc.
//      If anything looks wrong: FPT_ROLLBACK -> Run.
//
// Hebrew is \uXXXX-escaped (sheet-hebrew-encoding-safe-script). Comments ASCII.
// =============================================================================

var _FPT_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _FPT_PERSONAL_      = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';   // maazan ishi
var _FPT_CONFIRM_PROP_  = 'CONFIRM_FIX_PERSONAL_TOTALS';
var _FPT_CONFIRM_VAL_   = 'YES I UNDERSTAND';
var _FPT_BACKUP_PROP_   = 'FPT_BACKUP_GRANDTOTAL';
var _FPT_MAX_ROWS_      = 90;
var _FPT_MAX_COL_       = 14;  // N

// Hebrew label fragments (escaped):
var _FPT_TOTAL_     = '\u05e1\u05d4';         // "se" -- start of every total row
var _FPT_HOTZAOT_   = '\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea';     // hotzaot (expenses)
var _FPT_KAVUA_     = '\u05e7\u05d1\u05d5\u05e2';         // kavua (fixed)
var _FPT_ZMANI_     = '\u05d6\u05de\u05e0\u05d9';         // zmani (temporary)
var _FPT_OCHEL_     = '\u05d0\u05d5\u05db\u05dc';         // ochel (food)
var _FPT_TACHBURA_  = '\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4';     // tachbura (transport)
var _FPT_ACHER_     = '\u05d0\u05d7\u05e8';           // acher (other)
var _FPT_SHONOT_    = '\u05e9\u05d5\u05e0\u05d5\u05ea';       // shonot (misc)

function _fpt_ss_() { return SpreadsheetApp.openById(_FPT_NEW_SHEET_ID_); }
function _fpt_colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function FPT_SELF_TEST_HEBREW() {
  Logger.log('=== FPT_SELF_TEST_HEBREW ===');
  Logger.log('Personal tab : ' + _FPT_PERSONAL_);
  Logger.log('total/hotzaot: ' + _FPT_TOTAL_ + ' / ' + _FPT_HOTZAOT_);
  Logger.log('sections     : ' + _FPT_KAVUA_ + ' / ' + _FPT_ZMANI_ + ' / ' + _FPT_OCHEL_ + ' / ' + _FPT_TACHBURA_ + ' / ' + _FPT_ACHER_);
  Logger.log('If the Hebrew above is readable, encoding is fine.');
  return 'ok';
}

// Walk col A; classify the total rows by label. Returns row numbers (1-based)
// or null for each, plus a list of all grand-total matches (to catch dups).
function _fpt_find_(sh) {
  var lastRow = Math.min(sh.getLastRow(), _FPT_MAX_ROWS_);
  var labels = sh.getRange(1, 1, lastRow, 1).getDisplayValues();
  var res = { fixed: null, temp: null, food: null, transport: null, misc: null, grand: [], lastRow: lastRow };
  for (var i = 0; i < lastRow; i++) {
    var lab = labels[i][0];
    if (!lab || lab.indexOf(_FPT_TOTAL_) !== 0) continue;  // only rows starting with "se"
    var row = i + 1;
    if (lab.indexOf(_FPT_KAVUA_) >= 0)        { if (res.fixed == null) res.fixed = row; }
    else if (lab.indexOf(_FPT_ZMANI_) >= 0)   { if (res.temp == null) res.temp = row; }
    else if (lab.indexOf(_FPT_OCHEL_) >= 0)   { if (res.food == null) res.food = row; }
    else if (lab.indexOf(_FPT_TACHBURA_) >= 0){ if (res.transport == null) res.transport = row; }
    else if (lab.indexOf(_FPT_ACHER_) >= 0 || lab.indexOf(_FPT_SHONOT_) >= 0) { if (res.misc == null) res.misc = row; }
    else if (lab.indexOf(_FPT_HOTZAOT_) >= 0) { res.grand.push(row); }  // "se-kol hotzaot" w/ no section qualifier
  }
  return res;
}

// Build the corrected formula for the grand-total row at one column letter.
function _fpt_formulaFor_(colLetter, f) {
  return '=' + colLetter + f.fixed + '+' + colLetter + f.temp + '+' + colLetter + f.food +
         '+' + colLetter + f.transport + '+' + colLetter + f.misc;
}

function _fpt_planOK_(f) {
  var miss = [];
  if (f.fixed == null) miss.push('fixed(kavua)');
  if (f.temp == null) miss.push('temp(zmani)');
  if (f.food == null) miss.push('food(ochel)');
  if (f.transport == null) miss.push('transport(tachbura)');
  if (f.misc == null) miss.push('misc(acher/shonot)');
  if (!f.grand.length) miss.push('grand-total(se-kol hotzaot)');
  return miss;
}

function FPT_DRY_RUN() {
  Logger.log('=== FPT_DRY_RUN (writes nothing) ===');
  var sh = _fpt_ss_().getSheetByName(_FPT_PERSONAL_);
  if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }
  var f = _fpt_find_(sh);
  Logger.log('Section totals found:');
  Logger.log('  fixed (kavua)     R' + f.fixed);
  Logger.log('  temp (zmani)      R' + f.temp);
  Logger.log('  food (ochel)      R' + f.food);
  Logger.log('  transport         R' + f.transport);
  Logger.log('  misc (acher)      R' + f.misc);
  Logger.log('  grand-total row(s): R' + f.grand.join(', R'));
  var miss = _fpt_planOK_(f);
  if (miss.length) { Logger.log('!! CANNOT PROCEED -- missing: ' + miss.join(', ')); return 'incomplete'; }
  if (f.grand.length > 1) {
    Logger.log('!! NOTE: more than one grand-total row found. APPLY will fix only the FIRST (R' +
               f.grand[0] + '); the others (R' + f.grand.slice(1).join(', R') + ') look like leftover dup rows -- leaving them untouched.');
  }
  var g = f.grand[0];
  var curB = sh.getRange(g, 2).getFormula();
  var curC = sh.getRange(g, 3).getFormula();
  Logger.log('Grand-total row R' + g + ':');
  Logger.log('  current B: ' + (curB || '(value)'));
  Logger.log('  current C: ' + (curC || '(value)'));
  Logger.log('  NEW     B: ' + _fpt_formulaFor_('B', f));
  Logger.log('  NEW     C: ' + _fpt_formulaFor_('C', f) + '   (and D..N analogous)');
  Logger.log('');
  Logger.log('-- bonus for Phase 2: income rows + company net-profit --');
  _fpt_dumpIncome_(sh);
  _fpt_dumpCompanyNet_();
  Logger.log('');
  Logger.log('If the NEW formulas look right, set Script Property ' + _FPT_CONFIRM_PROP_ +
             ' = ' + _FPT_CONFIRM_VAL_ + ' then run FPT_APPLY.');
  return 'ok';
}

function _fpt_dumpIncome_(sh) {
  var last = Math.min(sh.getLastRow(), _FPT_MAX_ROWS_);
  var labs = sh.getRange(1, 1, last, 1).getDisplayValues();
  var forms = sh.getRange(1, 2, last, 1).getFormulas();
  var frags = ['\u05d4\u05db\u05e0\u05e1', '\u05e2\u05e1\u05e7', '\u05de\u05e9\u05db\u05d5\u05e8\u05ea'];
  for (var i = 0; i < last; i++) {
    var l = labs[i][0]; if (!l) continue;
    for (var k = 0; k < frags.length; k++) {
      if (l.indexOf(frags[k]) >= 0) { Logger.log('  R' + (i + 1) + ' "' + l + '" B=' + (forms[i][0] || '(value)')); break; }
    }
  }
}

function _fpt_dumpCompanyNet_() {
  var sheets = _fpt_ss_().getSheets();
  var COMPANY = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';   // maazan hevra
  var NET = '\u05e8\u05d5\u05d5\u05d7 \u05e0\u05d8\u05d5';            // revah neto
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm.indexOf(COMPANY) !== 0) continue;
    var sh = sheets[i];
    var last = Math.min(sh.getLastRow(), _FPT_MAX_ROWS_);
    var labs = sh.getRange(1, 1, last, 1).getDisplayValues();
    var forms = sh.getRange(1, 2, last, 1).getFormulas();
    for (var r = 0; r < last; r++) {
      if (labs[r][0] && labs[r][0].indexOf(NET) >= 0) {
        Logger.log('  "' + nm + '" R' + (r + 1) + ' "' + labs[r][0] + '" B=' + (forms[r][0] || '(value)'));
      }
    }
  }
}

function FPT_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_FPT_CONFIRM_PROP_) !== _FPT_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _FPT_CONFIRM_PROP_ + ' = ' + _FPT_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _fpt_ss_().getSheetByName(_FPT_PERSONAL_);
    if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }
    var f = _fpt_find_(sh);
    var miss = _fpt_planOK_(f);
    if (miss.length) { Logger.log('!! CANNOT APPLY -- missing: ' + miss.join(', ')); return 'incomplete'; }
    var g = f.grand[0];

    // Backup the grand-total row B..N formulas FIRST.
    var backupRange = sh.getRange(g, 2, 1, _FPT_MAX_COL_ - 1);  // B..N
    var backupFormulas = backupRange.getFormulas()[0];
    props.setProperty(_FPT_BACKUP_PROP_, JSON.stringify({ row: g, formulas: backupFormulas, at: new Date().toISOString() }));
    Logger.log('Backed up R' + g + ' B..N formulas to DocumentProperties (' + _FPT_BACKUP_PROP_ + ').');

    // Write the corrected formulas: B = sum of section annual totals; C..N = per-month.
    var newRow = [];
    for (var col = 2; col <= _FPT_MAX_COL_; col++) newRow.push(_fpt_formulaFor_(_fpt_colLetter_(col), f));
    sh.getRange(g, 2, 1, _FPT_MAX_COL_ - 1).setFormulas([newRow]);
    SpreadsheetApp.flush();
    Logger.log('APPLIED: R' + g + ' B..N now = (fixed+temp+food+transport+misc) per column.');
    Logger.log('  B = ' + newRow[0]);
    Logger.log('Run FPT_ROLLBACK to undo. Or clear the Script Property to re-gate.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function FPT_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_FPT_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _fpt_ss_().getSheetByName(_FPT_PERSONAL_);
    var row = [];
    for (var c = 0; c < bak.formulas.length; c++) row.push(bak.formulas[c] || '');
    sh.getRange(bak.row, 2, 1, bak.formulas.length).setFormulas([row]);
    SpreadsheetApp.flush();
    Logger.log('ROLLED BACK R' + bak.row + ' to the backup from ' + bak.at + '.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}
