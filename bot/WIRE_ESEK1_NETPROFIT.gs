// WIRE_ESEK1_NETPROFIT.gs -- Phase 2a: rename maazan-hevra -> "esek 1" and wire
// the maazan-ishi "esek" income row to that tab's net-profit (revah neto) row.
// =============================================================================
// WHAT STEVEN ASKED (2026-05-31)
//   "hachnasa 2 - esek" in maazan ishi should show the business net profit.
//   Rename the "maazan hevra" tab to "esek 1". The income must come from the
//   figure called "revah neto" (net profit).
//
// WHAT THIS DOES
//   1. Renames the company tab  "maazan hevra"  ->  "esek 1"  (only if needed).
//   2. Relabels the maazan-ishi income row "hachnasa 2 - esek"  ->  "esek 1".
//   3. Wires that income row so each month + the annual = the matching cell of
//      the company tab's net-profit row:
//        B(annual) = ='esek 1'!B<np>   C(Jan) = ='esek 1'!C<np>  ... N = ...
//      The company net-profit row is itself year-aware, so when both tabs show
//      the same year, the esek income equals that year's net profit.
//
// SAFE (Steven's iron rules)
//   - LABEL-WALKER: finds the net-profit row + the esek income row BY LABEL,
//     never by hardcoded row numbers.
//   - WEN_DRY_RUN writes NOTHING -- logs the plan + both tabs' year cells.
//   - WEN_APPLY gated by Script Property CONFIRM_WIRE_ESEK1 = "YES I UNDERSTAND".
//   - WEN_APPLY backs up (tab name + income-row label + income-row B..N
//     formulas) to DocumentProperties FIRST. WEN_ROLLBACK restores exactly.
//   - LockService. Touches ONLY the one income row's label + B..N, and the tab
//     name. Raw data (tnuot / hazmanot) is never touched. Never opens OLD sheet.
//
// USAGE
//   1. WEN_SELF_TEST_HEBREW -> Run
//   2. WEN_DRY_RUN -> Run -> send Claude the log
//   3. (after approval) Project Settings -> Script Properties ->
//      CONFIRM_WIRE_ESEK1 = YES I UNDERSTAND -> Save
//   4. WEN_APPLY -> Run     (WEN_ROLLBACK undoes it)
//
// Hebrew is \uXXXX-escaped. Comments ASCII.
// =============================================================================

var _WEN_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _WEN_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';   // maazan ishi
var _WEN_COMPANY_OLD_  = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';   // maazan hevra
var _WEN_COMPANY_NEW_  = '\u05e2\u05e1\u05e7 1';             // esek 1
var _WEN_NETPROFIT_    = '\u05e8\u05d5\u05d5\u05d7 \u05e0\u05d8\u05d5';         // revah neto
var _WEN_ESEK_         = '\u05e2\u05e1\u05e7';                 // esek (income-row marker)
var _WEN_CONFIRM_PROP_ = 'CONFIRM_WIRE_ESEK1';
var _WEN_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _WEN_BACKUP_PROP_  = 'WEN_BACKUP_ESEK1';
var _WEN_INCOME_MAXROW_ = 15;  // the dashboard income block is near the top
var _WEN_MAX_ROWS_     = 90;
var _WEN_MAX_COL_      = 14;   // N

function _wen_ss_() { return SpreadsheetApp.openById(_WEN_NEW_SHEET_ID_); }
function _wen_colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function WEN_SELF_TEST_HEBREW() {
  Logger.log('=== WEN_SELF_TEST_HEBREW ===');
  Logger.log('personal      : ' + _WEN_PERSONAL_);
  Logger.log('company old/new: ' + _WEN_COMPANY_OLD_ + ' -> ' + _WEN_COMPANY_NEW_);
  Logger.log('net-profit     : ' + _WEN_NETPROFIT_);
  Logger.log('esek marker    : ' + _WEN_ESEK_);
  Logger.log('If the Hebrew above is readable, encoding is fine.');
  return 'ok';
}

// The company sheet: prefer the new name if already renamed, else the old name.
function _wen_companySheet_(ss) {
  return ss.getSheetByName(_WEN_COMPANY_NEW_) || ss.getSheetByName(_WEN_COMPANY_OLD_);
}

// First row (1-based) in [1..maxRow] whose col-A label CONTAINS frag, else 0.
function _wen_findRow_(sh, frag, maxRow) {
  var last = Math.min(sh.getLastRow(), maxRow || _WEN_MAX_ROWS_);
  var labels = sh.getRange(1, 1, last, 1).getDisplayValues();
  for (var i = 0; i < last; i++) {
    if (labels[i][0] && labels[i][0].indexOf(frag) >= 0) return i + 1;
  }
  return 0;
}

// Report the first cell in rows 1..6 / cols A..N whose value is a year 2023-2030.
function _wen_yearCell_(sh) {
  var rows = Math.min(sh.getLastRow(), 6);
  var vals = sh.getRange(1, 1, rows, _WEN_MAX_COL_).getDisplayValues();
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < _WEN_MAX_COL_; c++) {
      var v = (vals[r][c] || '').replace(/[^0-9]/g, '');
      if (/^(202[0-9]|2030)$/.test(v)) return _wen_colLetter_(c + 1) + (r + 1) + '=' + vals[r][c];
    }
  }
  return '(year cell not found in rows 1-6)';
}

function WEN_DRY_RUN() {
  Logger.log('=== WEN_DRY_RUN (writes nothing) ===');
  var ss = _wen_ss_();
  var comp = _wen_companySheet_(ss);
  if (!comp) { Logger.log('!! company tab not found (neither "' + _WEN_COMPANY_OLD_ + '" nor "' + _WEN_COMPANY_NEW_ + '").'); return 'no-company'; }
  var compName = comp.getName();
  var npRow = _wen_findRow_(comp, _WEN_NETPROFIT_, _WEN_MAX_ROWS_);
  Logger.log('Company tab: "' + compName + '"  (will ' + (compName === _WEN_COMPANY_NEW_ ? 'KEEP' : 'rename to "' + _WEN_COMPANY_NEW_ + '"') + ')');
  if (!npRow) { Logger.log('!! net-profit row ("' + _WEN_NETPROFIT_ + '") not found in company tab.'); return 'no-np'; }
  Logger.log('Net-profit row: R' + npRow + ' "' + comp.getRange(npRow, 1).getDisplayValue() + '"  B=' + comp.getRange(npRow, 2).getFormula());
  Logger.log('Company year cell: ' + _wen_yearCell_(comp));

  var pers = ss.getSheetByName(_WEN_PERSONAL_);
  if (!pers) { Logger.log('!! personal tab not found.'); return 'no-personal'; }
  var incRow = _wen_findRow_(pers, _WEN_ESEK_, _WEN_INCOME_MAXROW_);
  if (!incRow) { Logger.log('!! esek income row not found in personal rows 1-' + _WEN_INCOME_MAXROW_ + '.'); return 'no-income'; }
  Logger.log('Personal esek income row: R' + incRow + ' "' + pers.getRange(incRow, 1).getDisplayValue() + '"');
  Logger.log('  current B: ' + (pers.getRange(incRow, 2).getFormula() || '(value ' + pers.getRange(incRow, 2).getDisplayValue() + ')'));
  Logger.log('  current C: ' + (pers.getRange(incRow, 3).getFormula() || '(value ' + pers.getRange(incRow, 3).getDisplayValue() + ')'));
  Logger.log('Personal year cell: ' + _wen_yearCell_(pers));

  Logger.log('');
  Logger.log('PLAN on APPLY:');
  Logger.log('  1. rename tab "' + compName + '" -> "' + _WEN_COMPANY_NEW_ + '" (if needed)');
  Logger.log('  2. relabel personal R' + incRow + ' -> "' + _WEN_COMPANY_NEW_ + '"');
  Logger.log('  3. set R' + incRow + ':  B = ' + _wen_ref_('B', npRow) + '   C..N analogous (e.g. C = ' + _wen_ref_('C', npRow) + ')');
  Logger.log('');
  Logger.log('NOTE on years: the esek income will mirror "' + _WEN_COMPANY_NEW_ + '"\'s net profit for whatever year that tab shows. Keep both tabs\' year selector on the same year for a consistent view. (Ask me to auto-sync them if you want one control.)');
  Logger.log('');
  Logger.log('If the plan looks right: set Script Property ' + _WEN_CONFIRM_PROP_ + ' = ' + _WEN_CONFIRM_VAL_ + ' then run WEN_APPLY.');
  return 'ok';
}

// Cross-tab reference to the (renamed) company net-profit row at one column.
function _wen_ref_(colLetter, npRow) {
  return "='" + _WEN_COMPANY_NEW_ + "'!" + colLetter + npRow;
}

function WEN_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_WEN_CONFIRM_PROP_) !== _WEN_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _WEN_CONFIRM_PROP_ + ' = ' + _WEN_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  if (props.getProperty(_WEN_BACKUP_PROP_)) {
    Logger.log('!! a backup already exists -- looks already applied. Run WEN_ROLLBACK first to re-apply.');
    return 'already-applied';
  }
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _wen_ss_();
    var comp = _wen_companySheet_(ss);
    if (!comp) { Logger.log('!! company tab not found.'); return 'no-company'; }
    var npRow = _wen_findRow_(comp, _WEN_NETPROFIT_, _WEN_MAX_ROWS_);
    if (!npRow) { Logger.log('!! net-profit row not found.'); return 'no-np'; }
    var pers = ss.getSheetByName(_WEN_PERSONAL_);
    var incRow = _wen_findRow_(pers, _WEN_ESEK_, _WEN_INCOME_MAXROW_);
    if (!incRow) { Logger.log('!! esek income row not found.'); return 'no-income'; }

    // BACKUP FIRST.
    var oldName = comp.getName();
    var oldLabel = pers.getRange(incRow, 1).getDisplayValue();
    var oldFormulas = pers.getRange(incRow, 2, 1, _WEN_MAX_COL_ - 1).getFormulas()[0];  // B..N
    props.setProperty(_WEN_BACKUP_PROP_, JSON.stringify({
      companyName: oldName, incRow: incRow, label: oldLabel, formulas: oldFormulas, at: new Date().toISOString()
    }));
    Logger.log('Backed up to DocumentProperties (' + _WEN_BACKUP_PROP_ + ').');

    // 1. rename tab.
    if (oldName !== _WEN_COMPANY_NEW_) { comp.setName(_WEN_COMPANY_NEW_); Logger.log('Renamed "' + oldName + '" -> "' + _WEN_COMPANY_NEW_ + '".'); }

    // 2. relabel income row.
    pers.getRange(incRow, 1).setValue(_WEN_COMPANY_NEW_);
    Logger.log('Relabeled personal R' + incRow + ' -> "' + _WEN_COMPANY_NEW_ + '".');

    // 3. wire B..N to the net-profit row.
    var row = [];
    for (var col = 2; col <= _WEN_MAX_COL_; col++) row.push(_wen_ref_(_wen_colLetter_(col), npRow));
    pers.getRange(incRow, 2, 1, _WEN_MAX_COL_ - 1).setFormulas([row]);
    SpreadsheetApp.flush();
    Logger.log('Wired R' + incRow + ' B..N to "' + _WEN_COMPANY_NEW_ + '"!R' + npRow + ' (net profit).');
    Logger.log('  B = ' + row[0]);
    Logger.log('DONE. Check maazan ishi: the esek income row now shows the business net profit.');
    Logger.log('Undo with WEN_ROLLBACK.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function WEN_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_WEN_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _wen_ss_();
    // restore tab name
    var comp = ss.getSheetByName(_WEN_COMPANY_NEW_) || ss.getSheetByName(bak.companyName);
    if (comp && comp.getName() !== bak.companyName) { comp.setName(bak.companyName); }
    // restore income row label + formulas
    var pers = ss.getSheetByName(_WEN_PERSONAL_);
    pers.getRange(bak.incRow, 1).setValue(bak.label);
    var row = [];
    for (var c = 0; c < bak.formulas.length; c++) row.push(bak.formulas[c] || '');
    pers.getRange(bak.incRow, 2, 1, bak.formulas.length).setFormulas([row]);
    SpreadsheetApp.flush();
    props.deleteProperty(_WEN_BACKUP_PROP_);
    Logger.log('ROLLED BACK: tab name + R' + bak.incRow + ' label/formulas restored from ' + bak.at + '.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}
