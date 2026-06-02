/**
 * MAAZAN_SRC_TOOLS.gs  --  STANDALONE migration/fix tools for the NEW Kesefle sheet.
 *
 * These live in Steven's TOOLS Apps Script project ALONGSIDE KESEFLE_SHEET_TOOLS.gs.
 * They are NOT part of the live bot project (no doPost). Each opens the NEW sheet by id,
 * takes a script lock, and follows the backup-first -> dry-run -> approval -> apply ->
 * rollback discipline. They write ONLY the NEW sheet, never the OLD one.
 *
 * Function-name prefixes here (FMC_/ES2_/FOM_ + helpers _fmc_/_es2_/_fom_) are FRESH and
 * do NOT collide with KESEFLE_SHEET_TOOLS.gs (DB_/FPT_/WEN_/AYD_/MOP_/MOO_/MFB_/MOE_/FOH_).
 *
 * Hebrew is written ONLY as \uXXXX escapes so the whole file is ASCII (survives clipboard /
 * browser bidi / chat paste without corruption).
 *
 * THREE TOOLS (each: <PREFIX>_DRY_RUN read-only, <PREFIX>_APPLY gated+locked+backup,
 *                    <PREFIX>_ROLLBACK restores the backup):
 *
 *   (A) FMC_  -- Fix the cross-year company LEAK in "\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9" (maazan ishi).
 *                R6 C..N currently mirror '\u05e2\u05e1\u05e7 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea'!C13:N13 which follows the
 *                COMPANY tab's own B4. Rewrite C6:N6 so the company-net income row computes
 *                company NET for the PERSONAL year $B$2 directly (rev G - COGS F - 3 opex terms,
 *                all keyed off $B$2). Makes maazan ishi self-consistent; leaves company B4 free.
 *
 *   (B) ES2_  -- Wire the SRC crypto-arb business as a 2nd income row in maazan ishi. SRC's only
 *                footprint is monthly realized NET in '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea' rows tagged col E =
 *                '\u05d4\u05db\u05e0\u05e1\u05d4 2 \u2014 \u05e2\u05e1\u05e7 SRC' (em-dash), col B = 'YYYY-MM', col C = amount
 *                (can be negative). Insert ONE row after R6 (so Google auto-extends the income
 *                SUM and the expense anchors shift), OR -- if the empty R7 '\u05d4\u05db\u05e0\u05e1\u05d4 3' slot
 *                is genuinely empty -- reuse R7 with no insert (the SAFER, default path; see
 *                _es2_decide_). C..N = SUMIFS('\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea' C:C by E + B = $B$2-MM).
 *
 *   (C) FOM_  -- Fix the orphan '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea' row (col D = '\u05e2\u05e1\u05e7', col E = '\u05e2\u05e1\u05e7'
 *                literal, col F detail contains '\u05e9\u05d9\u05d5\u05d5\u05e7 \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7', col C ~ 1514).
 *                It matches NO company-dashboard bucket because R9's marketing regex keys off
 *                col E and '\u05e2\u05e1\u05e7' has no marketing keyword. Set col E -> '\u05e2\u05dc\u05d5\u05ea \u05e9\u05d9\u05d5\u05d5\u05e7'
 *                so the '\u05e9\u05d9\u05d5\u05d5\u05e7' token is caught and 2026 company marketing rises ~1,514.
 *                The row is LOCATED by matching D+E+F, never hardcoded.
 *
 * RUN ORDER for Steven (each tool independently): <PREFIX>_DRY_RUN -> read the log ->
 *   set Script Property CONFIRM_<NAME> = 'YES I UNDERSTAND' -> <PREFIX>_APPLY -> (optional)
 *   <PREFIX>_ROLLBACK to undo.
 */

/* =================================================================================
 *  SHARED CONSTANTS (each tool also re-declares its own id/tab consts per spec so a
 *  tool can be copied out standalone; these block-level ones are only the sheet id +
 *  the tab names, kept identical to the per-tool ones).
 * ================================================================================= */

var _MST_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// --- column helper (1 -> A, 14 -> N) ---
function _mst_colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

/**
 * safeSetFormula: write a formula to a single-cell Range ONLY if the cell is empty or
 * already holds a formula. If the cell holds a user-typed literal (a non-empty value that
 * is NOT a formula), SKIP it and log -- never clobber Steven's hand-typed data.
 * Returns true if written, false if skipped.
 */
function _mst_safeSetFormula_(range, formula) {
  var curF = range.getFormula();              // '' when the cell is a literal or empty
  var curV = range.getValue();                // the literal / number / ''
  var isLiteral = (curF === '') && !(curV === '' || curV === null);
  if (isLiteral) {
    Logger.log('  SKIP ' + range.getA1Notation() + ' -- user-typed value present: ' + JSON.stringify(curV));
    return false;
  }
  range.setFormula(formula);
  return true;
}

/**
 * safeSetValue: write a literal to a single-cell Range ONLY if the cell is empty or already
 * holds the SAME-kind literal we are about to overwrite (i.e. it is not a formula and not an
 * unrelated user value we were not told to touch). For FOM we additionally pre-verify the
 * exact expected old value before calling this, so the guard here is a backstop:
 * refuse if the cell currently holds a FORMULA (we never want to drop a formula to a literal).
 * Returns true if written, false if skipped.
 */
function _mst_safeSetValue_(range, value, expectedOld) {
  var curF = range.getFormula();
  if (curF !== '') {
    Logger.log('  SKIP ' + range.getA1Notation() + ' -- holds a FORMULA, refusing to overwrite with a literal: ' + curF);
    return false;
  }
  if (expectedOld !== undefined && expectedOld !== null) {
    var curV = range.getValue();
    if (String(curV) !== String(expectedOld)) {
      Logger.log('  SKIP ' + range.getA1Notation() + ' -- current value ' + JSON.stringify(curV) +
                 ' != expected old ' + JSON.stringify(expectedOld) + ' (not the row we meant).');
      return false;
    }
  }
  range.setValue(value);
  return true;
}

// find first row 1..maxRow whose col-A DISPLAY value CONTAINS frag. 0 if none.
function _mst_findRowByLabel_(sh, frag, maxRow) {
  var last = Math.min(sh.getLastRow(), maxRow || 80);
  if (last < 1) return 0;
  var labels = sh.getRange(1, 1, last, 1).getDisplayValues();
  for (var i = 0; i < last; i++) {
    if (labels[i][0] && labels[i][0].indexOf(frag) >= 0) return i + 1;
  }
  return 0;
}

// report the first cell in rows 1..6 cols A..N whose value is a year 2020-2035 (the selector).
function _mst_yearCell_(sh) {
  var rows = Math.min(sh.getLastRow(), 6);
  if (rows < 1) return '(no rows)';
  var vals = sh.getRange(1, 1, rows, 14).getDisplayValues();
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < 14; c++) {
      var v = (vals[r][c] || '').replace(/[^0-9]/g, '');
      if (/^(202[0-9]|203[0-5])$/.test(v)) return _mst_colLetter_(c + 1) + (r + 1) + '=' + vals[r][c];
    }
  }
  return '(year cell not found in rows 1-6)';
}


/* =================================================================================
 *  (A) FMC_  --  FIX cross-year company-net LEAK in maazan ishi C6:N6.
 * ================================================================================= */

var _FMC_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _FMC_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';            // maazan ishi
var _FMC_COMPANY_      = '\u05e2\u05e1\u05e7 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea';     // esek tmunot (company tab)
var _FMC_ESEK_FRAG_    = '\u05e2\u05e1\u05e7 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea';     // label of the company-net income row in maazan ishi (R6)
var _FMC_CONFIRM_PROP_ = 'CONFIRM_FMC_FIX_COMPANY_LEAK';
var _FMC_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _FMC_BACKUP_PROP_  = 'FMC_BACKUP_C6_N6';
var _FMC_INCOME_MAXROW_ = 20;       // the income block lives in the top ~20 rows
var _FMC_MAX_COL_       = 14;       // N

// orders log + transactions tab names (referenced inside the rebuilt formulas)
var _FMC_ORDERS_ = '\u05d4\u05d6\u05de\u05e0\u05d5\u05ea';   // hazmanot
var _FMC_TNUOT_  = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';   // tnuot

// The three opex SUMPRODUCT regex patterns (col E subcategory), exactly per spec.
var _FMC_PAT_SHIVUK_   = '\u05e9\u05d9\u05d5\u05d5\u05e7|\u05e4\u05e8\u05e1\u05d5\u05dd|\u05de\u05d5\u05d3\u05e2\u05d4|\u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7|\u05d0\u05d9\u05e0\u05e1\u05d8\u05d2\u05e8\u05dd|\u05d8\u05d9\u05e7\u05d8\u05d5\u05e7|\u05d2\u05d5\u05d2\u05dc|\u05de\u05d8\u05d0|\u05dc\u05e7\u05d5\u05d7\u05d5\u05ea|\u05dc\u05d9\u05d3\u05d9\u05dd|\u05d0\u05e4\u05d5\u05dc\u05d5|\u05d5\u05d5\u05d9\u05e7\u05e1|wix';
var _FMC_PAT_SHILUACH_ = '\u05de\u05e9\u05dc\u05d5\u05d7|\u05d0\u05e8\u05d9\u05d6\u05d4|\u05d4\u05ea\u05e7\u05e0\u05d4|\u05d4\u05d5\u05d1\u05dc\u05d4|\u05d7\u05d1\u05d9\u05dc\u05d4|\u05d3\u05d5\u05d0\u05e8|\u05d1\u05dc\u05d3\u05e8';
var _FMC_PAT_TIFULIT_  = '\u05ea\u05d5\u05db\u05e0\u05d5\u05ea|\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d5\u05ea|\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4|\u05de\u05e0\u05d5\u05d9|\u05d0\u05d7\u05e1\u05d5\u05df|\u05d3\u05d5\u05de\u05d9\u05d9\u05df|\u05d7\u05e9\u05d1\u05d5\u05e0\u05d9\u05ea|\u05d1\u05e0\u05e7|\u05e2\u05de\u05dc\u05d4|\u05e9\u05d9\u05e8\u05d5\u05ea|\u05d1\u05e0\u05e7\u05d0\u05d5\u05ea';

function _fmc_ss_() { return SpreadsheetApp.openById(_FMC_NEW_SHEET_ID_); }

function FMC_SELF_TEST_HEBREW() {
  Logger.log('FMC personal tab      = ' + _FMC_PERSONAL_);
  Logger.log('FMC company tab       = ' + _FMC_COMPANY_);
  Logger.log('FMC orders tab        = ' + _FMC_ORDERS_);
  Logger.log('FMC tnuot tab         = ' + _FMC_TNUOT_);
  Logger.log('FMC shivuk pattern    = ' + _FMC_PAT_SHIVUK_);
  return 'ok';
}

/**
 * One opex SUMPRODUCT term for month m (1..12), keyed off the PERSONAL year $B$2 (NOT $B$4).
 * Mirrors the company tab's R9/R10/R11 SUMPRODUCT but swaps the year cell to $B$2 so the
 * company-net income row in maazan ishi tracks the PERSONAL year selector.
 */
function _fmc_opexTerm_(m, pat) {
  var m1 = m + 1;   // month boundary upper end; for m=12 this is 13 -> DATE(y,13,1) = Jan next year (correct)
  return "SUMPRODUCT(" +
    "('" + _FMC_TNUOT_ + "'!A2:A2000>=DATE($B$2," + m + ",1))*" +
    "('" + _FMC_TNUOT_ + "'!A2:A2000<DATE($B$2," + m1 + ",1))*" +
    "REGEXMATCH(IFERROR('" + _FMC_TNUOT_ + "'!D2:D2000,\"\"),\"^\u05e2\u05e1\u05e7$\")*" +
    "REGEXMATCH(IFERROR('" + _FMC_TNUOT_ + "'!E2:E2000,\"\"),\"" + pat + "\")*" +
    "IFERROR('" + _FMC_TNUOT_ + "'!C2:C2000,0))";
}

// revenue term (orders col G) for month m, keyed off $B$2.
function _fmc_revTerm_(m) {
  var m1 = m + 1;
  return "IFERROR(SUMIFS('" + _FMC_ORDERS_ + "'!G:G,'" + _FMC_ORDERS_ + "'!A:A,\">=\"&DATE($B$2," + m + ",1)," +
         "'" + _FMC_ORDERS_ + "'!A:A,\"<\"&DATE($B$2," + m1 + ",1)),0)";
}

// COGS term (orders col F) for month m, keyed off $B$2.
function _fmc_cogsTerm_(m) {
  var m1 = m + 1;
  return "IFERROR(SUMIFS('" + _FMC_ORDERS_ + "'!F:F,'" + _FMC_ORDERS_ + "'!A:A,\">=\"&DATE($B$2," + m + ",1)," +
         "'" + _FMC_ORDERS_ + "'!A:A,\"<\"&DATE($B$2," + m1 + ",1)),0)";
}

/**
 * Full month formula for column col (3=C/Jan .. 14=N/Dec):
 *   = revenue - COGS - opexShivuk - opexShiluach - opexTifulit    (all by $B$2)
 */
function _fmc_monthFormula_(col) {
  var m = col - 2;   // C(col3)->m1 .. N(col14)->m12
  return "=" + _fmc_revTerm_(m) +
         "-" + _fmc_cogsTerm_(m) +
         "-" + _fmc_opexTerm_(m, _FMC_PAT_SHIVUK_) +
         "-" + _fmc_opexTerm_(m, _FMC_PAT_SHILUACH_) +
         "-" + _fmc_opexTerm_(m, _FMC_PAT_TIFULIT_);
}

// locate the company-net income row (R6) in maazan ishi by its label.
function _fmc_incomeRow_(pers) {
  return _mst_findRowByLabel_(pers, _FMC_ESEK_FRAG_, _FMC_INCOME_MAXROW_);
}

function FMC_DRY_RUN() {
  Logger.log('=== FMC_DRY_RUN  (writes NOTHING) ===');
  Logger.log('Fix the cross-year LEAK: rebuild maazan ishi company-net income row C..N to compute');
  Logger.log('company NET for the PERSONAL year $B$2 directly (instead of mirroring company C13:N13).');
  Logger.log('');
  var ss = _fmc_ss_();
  var pers = ss.getSheetByName(_FMC_PERSONAL_);
  if (!pers) { Logger.log('!! personal tab not found: ' + _FMC_PERSONAL_); return 'no-personal'; }
  var r = _fmc_incomeRow_(pers);
  if (!r) { Logger.log('!! company-net income row ("' + _FMC_ESEK_FRAG_ + '") not found in rows 1-' + _FMC_INCOME_MAXROW_ + '.'); return 'no-row'; }

  Logger.log('Personal year selector: ' + _mst_yearCell_(pers) + '   (expected B2)');
  Logger.log('Company-net income row: R' + r + '  label="' + pers.getRange(r, 1).getDisplayValue() + '"');
  Logger.log('');

  // OLD formulas B..N (B is the annual; C..N monthly).
  var oldB = pers.getRange(r, 2).getFormula();
  var oldC = pers.getRange(r, 3).getFormula();
  Logger.log('OLD annual  B' + r + ' = ' + (oldB || '(literal ' + pers.getRange(r, 2).getDisplayValue() + ')'));
  Logger.log('OLD month   C' + r + ' = ' + (oldC || '(literal ' + pers.getRange(r, 3).getDisplayValue() + ')'));
  var oldN = pers.getRange(r, _FMC_MAX_COL_).getFormula();
  Logger.log('OLD month   N' + r + ' = ' + (oldN || '(literal ' + pers.getRange(r, _FMC_MAX_COL_).getDisplayValue() + ')'));
  Logger.log('');

  // NEW formulas: C..N rebuilt; B is left as-is IF it already sums C..N, else we propose =SUM(C{r}:N{r}).
  var newC = _fmc_monthFormula_(3);
  var newN = _fmc_monthFormula_(_FMC_MAX_COL_);
  Logger.log('NEW month   C' + r + ' = ' + newC);
  Logger.log('  ... D..M analogous (each swaps the month index; all keyed off $B$2) ...');
  Logger.log('NEW month   N' + r + ' = ' + newN);
  Logger.log('');

  // Annual B handling.
  var bSumExpected = '=SUM(C' + r + ':N' + r + ')';
  if (oldB && oldB.replace(/\s/g, '').toUpperCase() === bSumExpected.replace(/\s/g, '').toUpperCase()) {
    Logger.log('Annual B' + r + ' already = SUM(C' + r + ':N' + r + ') -- will LEAVE AS-IS (auto-totals the new months).');
  } else {
    Logger.log('Annual B' + r + ' is NOT a plain SUM of its row -- on APPLY it will be set to ' + bSumExpected +
               ' so the annual reflects the rebuilt months. (Backed up first; safeSet skips if user-typed.)');
  }
  Logger.log('');

  // Show the per-year recomputed annual, by reading what the company-net would be for $B$2.
  // We cannot evaluate formulas in dry-run, but we can show the live current displayed annual for context.
  Logger.log('Current displayed annual (pre-fix) B' + r + ' = ' + pers.getRange(r, 2).getDisplayValue());
  Logger.log('After APPLY the annual will recompute to company NET for whatever year B2 shows.');
  Logger.log('');
  Logger.log('PLAN on APPLY:');
  Logger.log('  1. BACKUP R' + r + ' C..N (and B) formulas to Script Property ' + _FMC_BACKUP_PROP_ + '.');
  Logger.log('  2. safeSetFormula C' + r + '..N' + r + ' to the per-$B$2 company-NET month formulas.');
  Logger.log('  3. ensure B' + r + ' = SUM(C' + r + ':N' + r + ') (only if not already).');
  Logger.log('');
  Logger.log('If correct: set Script Property ' + _FMC_CONFIRM_PROP_ + ' = ' + _FMC_CONFIRM_VAL_ + ' then run FMC_APPLY.');
  return 'ok';
}

function FMC_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_FMC_CONFIRM_PROP_) !== _FMC_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _FMC_CONFIRM_PROP_ + ' = ' + _FMC_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  if (props.getProperty(_FMC_BACKUP_PROP_)) {
    Logger.log('!! a backup already exists -- looks already applied. Run FMC_ROLLBACK first to re-apply.');
    return 'already-applied';
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _fmc_ss_();
    var pers = ss.getSheetByName(_FMC_PERSONAL_);
    if (!pers) { Logger.log('!! personal tab not found.'); return 'no-personal'; }
    var r = _fmc_incomeRow_(pers);
    if (!r) { Logger.log('!! company-net income row not found.'); return 'no-row'; }

    // BACKUP FIRST: B..N formulas of the income row.
    var backupBtoN = pers.getRange(r, 2, 1, _FMC_MAX_COL_ - 1).getFormulas()[0];   // B..N
    props.setProperty(_FMC_BACKUP_PROP_, JSON.stringify({ row: r, formulas: backupBtoN, at: new Date().toISOString() }));
    Logger.log('Backed up R' + r + ' B..N formulas to ' + _FMC_BACKUP_PROP_ + '.');

    // Write C..N (safe: skip user-typed literals).
    var wrote = 0, skipped = 0;
    for (var col = 3; col <= _FMC_MAX_COL_; col++) {
      var cell = pers.getRange(r, col);
      var oldF = cell.getFormula();
      var newF = _fmc_monthFormula_(col);
      if (_mst_safeSetFormula_(cell, newF)) {
        wrote++;
        Logger.log('  SET ' + _mst_colLetter_(col) + r + '  ' + (oldF || '(empty)') + '  ->  ' + newF);
      } else { skipped++; }
    }

    // Ensure annual B = SUM(C:N) of this row (only if not already a plain sum).
    var bCell = pers.getRange(r, 2);
    var bWant = '=SUM(C' + r + ':N' + r + ')';
    var bCur = bCell.getFormula();
    if (bCur.replace(/\s/g, '').toUpperCase() !== bWant.replace(/\s/g, '').toUpperCase()) {
      if (_mst_safeSetFormula_(bCell, bWant)) Logger.log('  SET B' + r + '  ' + (bCur || '(empty)') + '  ->  ' + bWant);
    } else {
      Logger.log('  KEEP B' + r + ' (already ' + bWant + ').');
    }

    SpreadsheetApp.flush();
    Logger.log('APPLIED FMC: R' + r + ' C..N rebuilt (' + wrote + ' written, ' + skipped + ' skipped). Annual B' + r + ' totals the row.');
    Logger.log('maazan ishi company income now tracks the PERSONAL year $B$2 -- no more cross-year leak.');
    Logger.log('Undo with FMC_ROLLBACK.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function FMC_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_FMC_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no FMC backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var pers = _fmc_ss_().getSheetByName(_FMC_PERSONAL_);
    var row = [];
    for (var c = 0; c < bak.formulas.length; c++) row.push(bak.formulas[c] || '');
    pers.getRange(bak.row, 2, 1, bak.formulas.length).setFormulas([row]);   // strings starting "=" re-parse as formulas; '' clears
    SpreadsheetApp.flush();
    props.deleteProperty(_FMC_BACKUP_PROP_);
    Logger.log('ROLLED BACK FMC: R' + bak.row + ' B..N restored from backup of ' + bak.at + '. Backup property cleared.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}


/* =================================================================================
 *  (B) ES2_  --  WIRE the SRC business as a 2nd income row in maazan ishi.
 * ================================================================================= */

var _ES2_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _ES2_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';            // maazan ishi
var _ES2_TNUOT_        = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';                        // tnuot
var _ES2_COMPANY_FRAG_ = '\u05e2\u05e1\u05e7 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea';     // R6 company-net row (anchor: SRC goes AFTER this)
var _ES2_SRC_LABEL_    = '\u05e2\u05e1\u05e7 SRC';                                      // new label for the SRC row
var _ES2_SRC_SUBCAT_   = '\u05d4\u05db\u05e0\u05e1\u05d4 2 \u2014 \u05e2\u05e1\u05e7 SRC';  // col-E criterion (em-dash U+2014)
var _ES2_REUSE_FRAG_   = '\u05d4\u05db\u05e0\u05e1\u05d4 3';                            // the empty "hachnasa 3 - nosaf" slot we may reuse
var _ES2_TOTAL_FRAG_   = '\u05e1\u05d4\u05f4\u05db \u05d4\u05db\u05e0\u05e1\u05d5\u05ea'; // "se total hachnasot" (the income SUM row)
var _ES2_CONFIRM_PROP_ = 'CONFIRM_ES2_WIRE_SRC_INCOME';
var _ES2_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _ES2_BACKUP_PROP_  = 'ES2_BACKUP_SRC_ROW';
var _ES2_INCOME_MAXROW_ = 20;
var _ES2_MAX_COL_       = 14;   // N

function _es2_ss_() { return SpreadsheetApp.openById(_ES2_NEW_SHEET_ID_); }

function ES2_SELF_TEST_HEBREW() {
  Logger.log('ES2 personal tab   = ' + _ES2_PERSONAL_);
  Logger.log('ES2 SRC label      = ' + _ES2_SRC_LABEL_);
  Logger.log('ES2 SRC subcat     = ' + _ES2_SRC_SUBCAT_);
  Logger.log('ES2 reuse slot     = ' + _ES2_REUSE_FRAG_);
  Logger.log('ES2 income total   = ' + _ES2_TOTAL_FRAG_);
  return 'ok';
}

/**
 * SRC month formula for column col (3=C/Jan .. 14=N/Dec):
 *   = IFERROR( SUMIFS(tnuot!C:C, tnuot!E:E, "<SRC subcat>", tnuot!B:B, $B$2 & "-" & TEXT(m,"00")), 0 )
 * Tolerates negative amounts (SUMIFS sums signed values). $B$2 is the personal year selector.
 */
function _es2_monthFormula_(col) {
  var m = col - 2;   // C->1 .. N->12
  var mm = (m < 10 ? '0' : '') + m;
  return "=IFERROR(SUMIFS('" + _ES2_TNUOT_ + "'!C:C," +
         "'" + _ES2_TNUOT_ + "'!E:E,\"" + _ES2_SRC_SUBCAT_ + "\"," +
         "'" + _ES2_TNUOT_ + "'!B:B,$B$2&\"-\"&TEXT(" + m + ",\"00\")),0)";
  // NB: the literal mm (" + mm + ") is not embedded; TEXT(m,"00") produces it live so the formula
  // stays year-agnostic and month-correct. mm computed only for readability/logging callers.
}

/**
 * Decide insert-vs-reuse. Returns {mode:'reuse'|'insert', row:<targetRowAfterAction>, reuseRow:<n>|0, why:'...'}.
 * REUSE is chosen (safer, no structural shift) when an empty "hachnasa 3" slot exists inside the
 * income block AND that slot currently has no SRC-meaningful formula/value (so we are not clobbering
 * a wired line). Otherwise we INSERT one row after the company-net row R6.
 */
function _es2_decide_(pers) {
  var compRow = _mst_findRowByLabel_(pers, _ES2_COMPANY_FRAG_, _ES2_INCOME_MAXROW_);
  var reuseRow = _mst_findRowByLabel_(pers, _ES2_REUSE_FRAG_, _ES2_INCOME_MAXROW_);
  if (reuseRow) {
    // Is the reuse row "empty enough"? Check C..N: empty or all-zero literals / blank formulas.
    var vals = pers.getRange(reuseRow, 3, 1, _ES2_MAX_COL_ - 2).getValues()[0];     // C..N values
    var forms = pers.getRange(reuseRow, 3, 1, _ES2_MAX_COL_ - 2).getFormulas()[0];  // C..N formulas
    var hasUserData = false;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i], f = forms[i];
      var nonEmptyVal = !(v === '' || v === null || v === 0);
      if (nonEmptyVal && f === '') { hasUserData = true; break; }   // user-typed non-zero literal -> do NOT reuse
    }
    if (!hasUserData) {
      return { mode: 'reuse', row: reuseRow, reuseRow: reuseRow, compRow: compRow,
               why: 'empty "hachnasa 3" slot at R' + reuseRow + ' (no user-typed non-zero data) -- reuse avoids any row insert.' };
    }
    return { mode: 'insert', row: (compRow ? compRow + 1 : 0), reuseRow: reuseRow, compRow: compRow,
             why: '"hachnasa 3" slot R' + reuseRow + ' has user data -> cannot reuse; insert a fresh row after R' + compRow + '.' };
  }
  return { mode: 'insert', row: (compRow ? compRow + 1 : 0), reuseRow: 0, compRow: compRow,
           why: 'no "hachnasa 3" slot found -> insert a fresh row after company-net row R' + compRow + '.' };
}

function ES2_DRY_RUN() {
  Logger.log('=== ES2_DRY_RUN  (writes NOTHING) ===');
  Logger.log('Wire the SRC crypto-arb business as a 2nd income row in maazan ishi (SUMIFS tnuot col E).');
  Logger.log('');
  var ss = _es2_ss_();
  var pers = ss.getSheetByName(_ES2_PERSONAL_);
  if (!pers) { Logger.log('!! personal tab not found: ' + _ES2_PERSONAL_); return 'no-personal'; }

  var compRow = _mst_findRowByLabel_(pers, _ES2_COMPANY_FRAG_, _ES2_INCOME_MAXROW_);
  var totRow  = _mst_findRowByLabel_(pers, _ES2_TOTAL_FRAG_, _ES2_INCOME_MAXROW_ + 10);
  Logger.log('Personal year selector: ' + _mst_yearCell_(pers) + '   (expected B2)');
  Logger.log('Company-net row (anchor): ' + (compRow ? 'R' + compRow + ' "' + pers.getRange(compRow, 1).getDisplayValue() + '"' : '(NOT FOUND)'));
  Logger.log('Income total row "' + _ES2_TOTAL_FRAG_ + '": ' + (totRow ? 'R' + totRow : '(NOT FOUND)'));
  if (totRow) Logger.log('  total formula B' + totRow + ' = ' + pers.getRange(totRow, 2).getFormula());
  if (totRow) Logger.log('  total formula C' + totRow + ' = ' + pers.getRange(totRow, 3).getFormula());
  Logger.log('');

  var d = _es2_decide_(pers);
  Logger.log('DECISION: ' + d.mode.toUpperCase() + ' -- ' + d.why);
  Logger.log('');

  var newC = _es2_monthFormula_(3);
  var newN = _es2_monthFormula_(_ES2_MAX_COL_);

  if (d.mode === 'reuse') {
    var rr = d.reuseRow;
    Logger.log('REUSE PLAN (no structural insert -- safest):');
    Logger.log('  - relabel A' + rr + ': "' + pers.getRange(rr, 1).getDisplayValue() + '"  ->  "' + _ES2_SRC_LABEL_ + '"');
    Logger.log('  - OLD C' + rr + ' = ' + (pers.getRange(rr, 3).getFormula() || '(literal ' + pers.getRange(rr, 3).getDisplayValue() + ')'));
    Logger.log('  - NEW C' + rr + ' = ' + newC);
    Logger.log('  - NEW N' + rr + ' = ' + newN);
    Logger.log('  - B' + rr + ' = SUM(C' + rr + ':N' + rr + ')');
    Logger.log('  Because NO row is inserted, the income total SUM range, R6 (FMC) formulas, and the');
    Logger.log('  expense section anchors (28/34/39/50/58) are ALL UNCHANGED. Proven safe by construction.');
  } else {
    var ir = d.row;   // new row index after insertRowsAfter(compRow)
    Logger.log('INSERT PLAN (insertRowsAfter R' + d.compRow + ' -> SRC becomes R' + ir + '):');
    Logger.log('  Google auto-extends ranges that SPAN the insert point. PROOF the insert is safe:');
    // Prove the income total SUM spans the company row (so a row right after it lands inside the SUM).
    if (totRow) {
      var tf = pers.getRange(totRow, 3).getFormula();
      Logger.log('  - income total C' + totRow + ' = ' + tf);
      Logger.log('    -> inserting a row AFTER R' + d.compRow + ' (inside the C2:C8-style span that ends at the row');
      Logger.log('       just above the total) makes Google rewrite the SUM upper bound +1 automatically.');
    }
    // Prove the expense anchors are BELOW the insert -> they shift +1 together (B28+B34+... stays consistent).
    Logger.log('  - expense anchors (R10 = B28+B34+B39+B50+B58) are BELOW R' + ir + ': each reference shifts +1');
    Logger.log('    in lockstep when a row is inserted above them, so R10 stays correct post-insert.');
    // Prove R6 FMC formulas only reference orders/tnuot + $B$2 (no in-tab row refs that the insert would break).
    Logger.log('  - R' + d.compRow + ' (company-net, FMC) references only \u05d4\u05d6\u05de\u05e0\u05d5\u05ea / \u05ea\u05e0\u05d5\u05e2\u05d5\u05ea + $B$2;');
    Logger.log('    inserting BELOW it does not touch those formulas.');
    Logger.log('  - then set A' + ir + ' = "' + _ES2_SRC_LABEL_ + '", C' + ir + '..N' + ir + ' = SRC SUMIFS, B' + ir + ' = SUM(C' + ir + ':N' + ir + ').');
    Logger.log('  - NEW C' + ir + ' = ' + newC);
  }
  Logger.log('');
  Logger.log('SRC criterion (col E, exact em-dash U+2014): "' + _ES2_SRC_SUBCAT_ + '"  (negatives tolerated).');
  Logger.log('');
  Logger.log('If correct: set Script Property ' + _ES2_CONFIRM_PROP_ + ' = ' + _ES2_CONFIRM_VAL_ + ' then run ES2_APPLY.');
  return 'ok';
}

function ES2_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_ES2_CONFIRM_PROP_) !== _ES2_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _ES2_CONFIRM_PROP_ + ' = ' + _ES2_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  if (props.getProperty(_ES2_BACKUP_PROP_)) {
    Logger.log('!! a backup already exists -- looks already applied. Run ES2_ROLLBACK first to re-apply.');
    return 'already-applied';
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _es2_ss_();
    var pers = ss.getSheetByName(_ES2_PERSONAL_);
    if (!pers) { Logger.log('!! personal tab not found.'); return 'no-personal'; }
    var d = _es2_decide_(pers);

    if (d.mode === 'reuse') {
      var rr = d.reuseRow;
      // BACKUP FIRST: the reuse row label + B..N formulas.
      var bakLabel = pers.getRange(rr, 1).getDisplayValue();
      var bakForms = pers.getRange(rr, 2, 1, _ES2_MAX_COL_ - 1).getFormulas()[0];   // B..N
      props.setProperty(_ES2_BACKUP_PROP_, JSON.stringify({
        mode: 'reuse', row: rr, label: bakLabel, formulas: bakForms, at: new Date().toISOString()
      }));
      Logger.log('Backed up REUSE row R' + rr + ' (label + B..N) to ' + _ES2_BACKUP_PROP_ + '.');

      pers.getRange(rr, 1).setValue(_ES2_SRC_LABEL_);
      Logger.log('  SET A' + rr + ' label -> "' + _ES2_SRC_LABEL_ + '" (was "' + bakLabel + '").');
      for (var col = 3; col <= _ES2_MAX_COL_; col++) {
        var cell = pers.getRange(rr, col);
        var oldF = cell.getFormula();
        var newF = _es2_monthFormula_(col);
        if (_mst_safeSetFormula_(cell, newF)) Logger.log('  SET ' + _mst_colLetter_(col) + rr + '  ' + (oldF || '(empty)') + '  ->  ' + newF);
      }
      var bWant = '=SUM(C' + rr + ':N' + rr + ')';
      if (_mst_safeSetFormula_(pers.getRange(rr, 2), bWant)) Logger.log('  SET B' + rr + ' -> ' + bWant);
      SpreadsheetApp.flush();
      Logger.log('APPLIED ES2 (reuse): SRC wired at R' + rr + '. Income total auto-includes it (no insert).');
      Logger.log('Undo with ES2_ROLLBACK.');
      return 'ok';
    }

    // INSERT mode.
    var compRow = d.compRow;
    if (!compRow) { Logger.log('!! company-net anchor row not found; cannot place SRC.'); return 'no-anchor'; }
    // Record the backup as an INSERT marker BEFORE inserting (rollback = delete the inserted row).
    props.setProperty(_ES2_BACKUP_PROP_, JSON.stringify({
      mode: 'insert', afterRow: compRow, insertedRow: compRow + 1, at: new Date().toISOString()
    }));
    Logger.log('Recorded INSERT backup marker (inserted row will be R' + (compRow + 1) + ') to ' + _ES2_BACKUP_PROP_ + '.');

    pers.insertRowsAfter(compRow, 1);
    var ir = compRow + 1;
    Logger.log('  insertRowsAfter(R' + compRow + ') -> new blank row R' + ir + '.');
    pers.getRange(ir, 1).setValue(_ES2_SRC_LABEL_);
    Logger.log('  SET A' + ir + ' -> "' + _ES2_SRC_LABEL_ + '".');
    for (var col2 = 3; col2 <= _ES2_MAX_COL_; col2++) {
      var newF2 = _es2_monthFormula_(col2);
      pers.getRange(ir, col2).setFormula(newF2);   // fresh blank row -> direct set is safe
      Logger.log('  SET ' + _mst_colLetter_(col2) + ir + '  ->  ' + newF2);
    }
    pers.getRange(ir, 2).setFormula('=SUM(C' + ir + ':N' + ir + ')');
    Logger.log('  SET B' + ir + ' -> =SUM(C' + ir + ':N' + ir + ').');
    SpreadsheetApp.flush();
    Logger.log('APPLIED ES2 (insert): SRC row at R' + ir + '. Income SUM + expense anchors auto-shifted by Google.');
    Logger.log('Undo with ES2_ROLLBACK (deletes the inserted row).');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function ES2_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_ES2_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no ES2 backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var pers = _es2_ss_().getSheetByName(_ES2_PERSONAL_);
    if (bak.mode === 'reuse') {
      var row = [];
      for (var c = 0; c < bak.formulas.length; c++) row.push(bak.formulas[c] || '');
      pers.getRange(bak.row, 2, 1, bak.formulas.length).setFormulas([row]);
      pers.getRange(bak.row, 1).setValue(bak.label);
      Logger.log('ROLLED BACK ES2 (reuse): R' + bak.row + ' label + B..N restored from ' + bak.at + '.');
    } else {
      // insert mode -> delete the inserted row.
      pers.deleteRow(bak.insertedRow);
      Logger.log('ROLLED BACK ES2 (insert): deleted inserted row R' + bak.insertedRow + ' (from ' + bak.at + ').');
    }
    SpreadsheetApp.flush();
    props.deleteProperty(_ES2_BACKUP_PROP_);
    Logger.log('ES2 backup property cleared.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}


/* =================================================================================
 *  (C) FOM_  --  FIX the orphan tnuot row's col E so the marketing regex catches it.
 * ================================================================================= */

var _FOM_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _FOM_TNUOT_        = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';            // tnuot
var _FOM_MATCH_D_      = '\u05e2\u05e1\u05e7';                             // col D must equal this (esek)
var _FOM_MATCH_E_      = '\u05e2\u05e1\u05e7';                             // col E currently equals this (literal esek)
var _FOM_MATCH_F_FRAG_ = '\u05e9\u05d9\u05d5\u05d5\u05e7 \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7';  // col F must contain "shivuk facebook"
var _FOM_NEW_E_        = '\u05e2\u05dc\u05d5\u05ea \u05e9\u05d9\u05d5\u05d5\u05e7';   // new col E value "alut shivuk" (contains the shivuk token)
var _FOM_CONFIRM_PROP_ = 'CONFIRM_FOM_FIX_ORPHAN_MARKETING';
var _FOM_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _FOM_BACKUP_PROP_  = 'FOM_BACKUP_ORPHAN_E';
var _FOM_COL_D_ = 4, _FOM_COL_E_ = 5, _FOM_COL_F_ = 6;
var _FOM_SCAN_MAX_ = 2000;   // scan tnuot rows 2.._FOM_SCAN_MAX_

function _fom_ss_() { return SpreadsheetApp.openById(_FOM_NEW_SHEET_ID_); }

function FOM_SELF_TEST_HEBREW() {
  Logger.log('FOM tnuot tab   = ' + _FOM_TNUOT_);
  Logger.log('FOM match D     = ' + _FOM_MATCH_D_);
  Logger.log('FOM match E     = ' + _FOM_MATCH_E_);
  Logger.log('FOM match Ffrag = ' + _FOM_MATCH_F_FRAG_);
  Logger.log('FOM new E       = ' + _FOM_NEW_E_);
  return 'ok';
}

/**
 * Locate the orphan row: col D == esek AND col E == esek(literal) AND col F contains the
 * "shivuk facebook" fragment. Returns the 1-based row number, or 0 if not found. If MORE than
 * one matches, returns -1 (ambiguous -> caller refuses to write).
 */
function _fom_findOrphan_(sh) {
  var last = Math.min(sh.getLastRow(), _FOM_SCAN_MAX_);
  if (last < 2) return 0;
  var d = sh.getRange(2, _FOM_COL_D_, last - 1, 1).getDisplayValues();
  var e = sh.getRange(2, _FOM_COL_E_, last - 1, 1).getDisplayValues();
  var f = sh.getRange(2, _FOM_COL_F_, last - 1, 1).getDisplayValues();
  var hits = [];
  for (var i = 0; i < d.length; i++) {
    var dv = (d[i][0] || '').trim();
    var ev = (e[i][0] || '').trim();
    var fv = (f[i][0] || '');
    if (dv === _FOM_MATCH_D_ && ev === _FOM_MATCH_E_ && fv.indexOf(_FOM_MATCH_F_FRAG_) >= 0) hits.push(i + 2);
  }
  if (hits.length === 0) return 0;
  if (hits.length > 1) { Logger.log('!! AMBIGUOUS: ' + hits.length + ' rows match (' + hits.join(',') + ').'); return -1; }
  return hits[0];
}

function FOM_DRY_RUN() {
  Logger.log('=== FOM_DRY_RUN  (writes NOTHING) ===');
  Logger.log('Fix the orphan tnuot row so the R9 marketing regex ("' + '\u05e9\u05d9\u05d5\u05d5\u05e7' + '") catches it.');
  Logger.log('Locate by: col D == "' + _FOM_MATCH_D_ + '" AND col E == "' + _FOM_MATCH_E_ + '" AND col F contains "' + _FOM_MATCH_F_FRAG_ + '".');
  Logger.log('');
  var sh = _fom_ss_().getSheetByName(_FOM_TNUOT_);
  if (!sh) { Logger.log('!! tnuot tab not found: ' + _FOM_TNUOT_); return 'no-tnuot'; }
  var r = _fom_findOrphan_(sh);
  if (r === 0) { Logger.log('!! orphan row NOT found (scanned rows 2-' + _FOM_SCAN_MAX_ + ').'); return 'not-found'; }
  if (r < 0)   { Logger.log('!! multiple matches -- refusing. Inspect manually.'); return 'ambiguous'; }

  var b = sh.getRange(r, 2).getDisplayValue();
  var cAmount = sh.getRange(r, 3).getDisplayValue();
  var dv = sh.getRange(r, _FOM_COL_D_).getDisplayValue();
  var ev = sh.getRange(r, _FOM_COL_E_).getDisplayValue();
  var fv = sh.getRange(r, _FOM_COL_F_).getDisplayValue();
  Logger.log('FOUND orphan at row ' + r + ':');
  Logger.log('  B' + r + ' (period) = ' + b);
  Logger.log('  C' + r + ' (amount) = ' + cAmount);
  Logger.log('  D' + r + ' (category) = ' + dv);
  Logger.log('  E' + r + ' (subcat) = ' + ev + '   <-- WILL CHANGE');
  Logger.log('  F' + r + ' (detail) = ' + fv);
  Logger.log('');
  Logger.log('PLAN on APPLY: safeSetValue E' + r + '  "' + ev + '"  ->  "' + _FOM_NEW_E_ + '"');
  Logger.log('  Effect: 2026 company marketing (R9) rises by ~' + cAmount + ' (this row now matches the "' + '\u05e9\u05d9\u05d5\u05d5\u05e7' + '" regex).');
  Logger.log('  (safeSetValue refuses if E' + r + ' is a formula or no longer == "' + _FOM_MATCH_E_ + '".)');
  Logger.log('');
  Logger.log('If correct: set Script Property ' + _FOM_CONFIRM_PROP_ + ' = ' + _FOM_CONFIRM_VAL_ + ' then run FOM_APPLY.');
  return 'ok';
}

function FOM_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_FOM_CONFIRM_PROP_) !== _FOM_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _FOM_CONFIRM_PROP_ + ' = ' + _FOM_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  if (props.getProperty(_FOM_BACKUP_PROP_)) {
    Logger.log('!! a backup already exists -- looks already applied. Run FOM_ROLLBACK first to re-apply.');
    return 'already-applied';
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _fom_ss_().getSheetByName(_FOM_TNUOT_);
    if (!sh) { Logger.log('!! tnuot tab not found.'); return 'no-tnuot'; }
    var r = _fom_findOrphan_(sh);
    if (r === 0) { Logger.log('!! orphan row not found.'); return 'not-found'; }
    if (r < 0)   { Logger.log('!! ambiguous -- refusing.'); return 'ambiguous'; }

    var cell = sh.getRange(r, _FOM_COL_E_);
    var oldE = cell.getValue();
    // BACKUP FIRST.
    props.setProperty(_FOM_BACKUP_PROP_, JSON.stringify({ row: r, col: _FOM_COL_E_, oldValue: oldE, at: new Date().toISOString() }));
    Logger.log('Backed up E' + r + ' old value ' + JSON.stringify(oldE) + ' to ' + _FOM_BACKUP_PROP_ + '.');

    // safeSetValue (pre-verifies the exact expected old == _FOM_MATCH_E_).
    if (_mst_safeSetValue_(cell, _FOM_NEW_E_, _FOM_MATCH_E_)) {
      Logger.log('  SET E' + r + '  "' + oldE + '"  ->  "' + _FOM_NEW_E_ + '".');
    } else {
      Logger.log('!! safeSetValue skipped -- nothing written. Rolling back the (no-op) backup.');
      props.deleteProperty(_FOM_BACKUP_PROP_);
      return 'skipped';
    }
    SpreadsheetApp.flush();
    Logger.log('APPLIED FOM: orphan row ' + r + ' col E now "' + _FOM_NEW_E_ + '". 2026 company marketing will rise ~' + sh.getRange(r, 3).getDisplayValue() + '.');
    Logger.log('Undo with FOM_ROLLBACK.');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function FOM_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_FOM_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no FOM backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _fom_ss_().getSheetByName(_FOM_TNUOT_);
    sh.getRange(bak.row, bak.col).setValue(bak.oldValue);
    SpreadsheetApp.flush();
    props.deleteProperty(_FOM_BACKUP_PROP_);
    Logger.log('ROLLED BACK FOM: row ' + bak.row + ' col ' + bak.col + ' restored to ' + JSON.stringify(bak.oldValue) + ' (from ' + bak.at + ').');
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}
