// KESEFLE_SHEET_TOOLS.gs  --  ALL sheet tools in ONE file (paste this, delete the rest)
// =============================================================================
// One file so nothing is scattered. Every function has a unique prefix:
//   DB_*   = read-only diagnostics (DB_RUN_ALL, DB_DUMP_ALL_COMPANY, DB_REBUILD_RECON, ...)
//   FPT_*  = fix maazan-ishi total-expenses (FPT_DRY_RUN, FPT_APPLY, FPT_ROLLBACK)
//   WEN_*  = rename maazan-hevra -> esek 1 + wire net profit (WEN_DRY_RUN, WEN_APPLY, WEN_ROLLBACK)
//   AYD_*  = add year dropdown to maazan ishi (AYD_DRY_RUN, AYD_APPLY, AYD_ROLLBACK)
//
// All DRY_RUN / diagnostic functions are READ-ONLY. Every *_APPLY is gated by a
// Script Property (CONFIRM_*) + backs up to DocumentProperties + has a *_ROLLBACK.
// Hebrew is \uXXXX-escaped. Never opens the OLD sheet.
//
// To install: create ONE new script file, paste this whole file, Cmd+S.
// =============================================================================

// ===================== 1) DIAGNOSTICS (DB_*) =====================

var _DB_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _DB_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';   // maazan ishi
var _DB_COMPANY_      = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';   // maazan hevra
var _DB_NETPROFIT_    = '\u05e8\u05d5\u05d5\u05d7 \u05e0\u05d8\u05d5';         // revah neto
var _DB_TOTAL_PREFIX_ = '\u05e1\u05d4';                                       // "se" (start of total rows)
// income-row label fragments (for the findings scan):
var _DB_F_HACHNAS_    = '\u05d4\u05db\u05e0\u05e1';                           // hachnas
var _DB_F_ESEK_       = '\u05e2\u05e1\u05e7';                                 // esek
var _DB_F_MASKORET_   = '\u05de\u05e9\u05db\u05d5\u05e8\u05ea';               // maskoret
var _DB_F_SHONOT_     = '\u05e9\u05d5\u05e0\u05d5\u05ea';                     // shonot
var _DB_MAX_ROWS_     = 90;  // cap per tab so the log stays readable

function _db_ss_() { return SpreadsheetApp.openById(_DB_NEW_SHEET_ID_); }

// -- 1. Hebrew self-test ------------------------------------------------------
function DB_SELF_TEST_HEBREW() {
  Logger.log('=== DB_SELF_TEST_HEBREW ===');
  Logger.log('Personal tab : ' + _DB_PERSONAL_);
  Logger.log('Company tab  : ' + _DB_COMPANY_);
  Logger.log('Net-profit   : ' + _DB_NETPROFIT_);
  Logger.log('Total prefix : ' + _DB_TOTAL_PREFIX_);
  Logger.log('If the Hebrew above is readable, encoding is fine.');
  return 'ok';
}

// -- 2. List every tab --------------------------------------------------------
function DB_LIST_TABS() {
  var sheets = _db_ss_().getSheets();
  Logger.log('=== DB_LIST_TABS (' + sheets.length + ' tabs) ===');
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    Logger.log((i + 1) + '. "' + sh.getName() + '"  rows=' + sh.getLastRow() + '  cols=' + sh.getLastColumn());
  }
  return 'ok';
}

// -- 3. Dump one tab: row | colA label | colB formula-or-value ---------------
function _db_dumpTab_(tabName) {
  var sh = _db_ss_().getSheetByName(tabName);
  if (!sh) { Logger.log('!! TAB NOT FOUND: "' + tabName + '"'); return; }
  var lastRow = Math.min(sh.getLastRow(), _DB_MAX_ROWS_);
  if (lastRow < 1) { Logger.log('(empty tab "' + tabName + '")'); return; }
  // Read A:C so we also capture the January (col C) formula for total rows.
  var rng = sh.getRange(1, 1, lastRow, 3);
  var formulas = rng.getFormulas();
  var display = rng.getDisplayValues();
  Logger.log('=== DUMP "' + tabName + '"  (rows 1..' + lastRow + ') ===');
  for (var r = 0; r < lastRow; r++) {
    var label = display[r][0];
    var bForm = formulas[r][1];
    var bVal = display[r][1];
    if (label === '' && bForm === '' && bVal === '') continue;  // skip blank rows
    var bShow = bForm ? bForm : ('(' + bVal + ')');
    Logger.log('R' + (r + 1) + ' | ' + label + ' | B: ' + bShow);
  }
}

function DB_DUMP_PERSONAL() {
  Logger.log('');
  _db_dumpTab_(_DB_PERSONAL_);
  return 'ok';
}

// -- 4. Dump every tab whose name starts with "maazan hevra" -----------------
function DB_DUMP_ALL_COMPANY() {
  Logger.log('');
  var sheets = _db_ss_().getSheets();
  var found = 0;
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm.indexOf(_DB_COMPANY_) === 0) { _db_dumpTab_(nm); found++; }
  }
  if (!found) Logger.log('!! No tab starting with "' + _DB_COMPANY_ + '" found.');
  Logger.log('Company tabs found: ' + found);
  return 'ok';
}

// -- 4b. FULL company dump: A label + B(annual) + C(Jan) formulas, rows 1..16.
//   This is the diagnostic for "esek income shows 0". The annual revenue row
//   (mahzor bruto) is SUM(C:N); the FROZEN-YEAR bug lives in the MONTHLY cells
//   (C..N), which DB_DUMP_ALL_COMPANY does not print. Here we print C(Jan) too:
//     - if C(Jan) of the revenue row contains a literal year ("2025-01")  -> FROZEN
//       (changing the B4 year selector does nothing) -> needs an unfreeze rewire.
//     - if C(Jan) references $B$4 / LEFT(..,4)=year                       -> year-aware
//       (the 0 is then a NO-DATA-that-year issue, not a formula bug).
function DB_DUMP_COMPANY_FULL() {
  Logger.log('');
  Logger.log('=== DB_DUMP_COMPANY_FULL (read-only) ===');
  var ss = _db_ss_();
  var sheets = ss.getSheets();
  var found = 0;
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm.indexOf(_DB_COMPANY_) !== 0) continue;
    found++;
    var sh = sheets[i];
    var lastRow = Math.min(sh.getLastRow(), 16);
    var rng = sh.getRange(1, 1, lastRow, 14);   // A..N
    var f = rng.getFormulas();
    var d = rng.getDisplayValues();
    Logger.log('## "' + nm + '"  (rows 1..' + lastRow + ')');
    for (var yr = 0; yr < Math.min(lastRow, 6); yr++) {
      for (var yc = 0; yc < 14; yc++) {
        var yv = String(d[yr][yc] || '').replace(/[^0-9]/g, '');
        if (/^(202[0-9]|2030)$/.test(yv)) Logger.log('  YEAR cell ' + _db_colLetter_(yc + 1) + (yr + 1) + ' = ' + d[yr][yc]);
      }
    }
    for (var r = 0; r < lastRow; r++) {
      var label = d[r][0];
      if (!label) continue;
      var b = f[r][1] || '(' + d[r][1] + ')';
      var cJan = f[r][2] || '(' + d[r][2] + ')';
      Logger.log('  R' + (r + 1) + ' "' + label + '"  [B shows: ' + d[r][1] + ']');
      Logger.log('      B=' + (b.length > 130 ? b.slice(0, 130) + '...' : b));
      Logger.log('      C(Jan)=' + (cJan.length > 130 ? cJan.slice(0, 130) + '...' : cJan));
    }
  }
  if (!found) Logger.log('!! No company tab found.');
  Logger.log('');
  Logger.log('HOW TO READ: find the revenue row (mahzor bruto). If its C(Jan) has a literal');
  Logger.log('year like "2025-01" -> FROZEN (needs unfreeze). If it has $B$4 / LEFT(..,4) ->');
  Logger.log('year-aware, so the 0 is a no-data-that-year issue. Copy this whole log to Claude.');
  return 'ok';
}

// -- 5. Auto-flag findings ----------------------------------------------------
function DB_FINDINGS() {
  Logger.log('');
  Logger.log('=== DB_FINDINGS ===');
  var ss = _db_ss_();

  // 5a. Personal: every total row + its B and C formulas; plus any error cells.
  var p = ss.getSheetByName(_DB_PERSONAL_);
  if (p) {
    var pLast = Math.min(p.getLastRow(), _DB_MAX_ROWS_);
    var pr = p.getRange(1, 1, pLast, 3);
    var pf = pr.getFormulas();
    var pd = pr.getDisplayValues();
    Logger.log('-- personal: total (se...) rows --');
    for (var r = 0; r < pLast; r++) {
      var lab = pd[r][0];
      if (lab && lab.indexOf(_DB_TOTAL_PREFIX_) === 0) {
        Logger.log('  R' + (r + 1) + ' "' + lab + '"  B=' + (pf[r][1] || '(' + pd[r][1] + ')') +
                   '  C=' + (pf[r][2] || '(' + pd[r][2] + ')'));
      }
    }
    Logger.log('-- personal: error cells (#REF/#VALUE/#N/A/#ERROR/#DIV/#NAME) --');
    var errs = 0;
    for (var r2 = 0; r2 < pLast; r2++) {
      for (var c = 0; c < 3; c++) {
        var dv = pd[r2][c];
        if (dv && (dv.indexOf('#REF') >= 0 || dv.indexOf('#VALUE') >= 0 ||
                   dv.indexOf('#N/A') >= 0 || dv.indexOf('#ERROR') >= 0 ||
                   dv.indexOf('#DIV') >= 0 || dv.indexOf('#NAME') >= 0)) {
          Logger.log('  R' + (r2 + 1) + ' col' + (c + 1) + ' = ' + dv +
                     '  (formula: ' + (pf[r2][c] || 'none') + ')');
          errs++;
        }
      }
    }
    if (!errs) Logger.log('  (no #-errors found in cols A-C)');
    Logger.log('-- personal: income rows (label has hachnas/esek/maskoret/shonot) --');
    for (var r3 = 0; r3 < pLast; r3++) {
      var l3 = pd[r3][0];
      if (l3 && (l3.indexOf(_DB_F_HACHNAS_) >= 0 || l3.indexOf(_DB_F_ESEK_) >= 0 ||
                 l3.indexOf(_DB_F_MASKORET_) >= 0 || l3.indexOf(_DB_F_SHONOT_) >= 0)) {
        Logger.log('  R' + (r3 + 1) + ' "' + l3 + '"  B=' + (pf[r3][1] || '(' + pd[r3][1] + ')'));
      }
    }
  } else {
    Logger.log('!! personal tab not found.');
  }

  // 5b. Company tabs: locate the net-profit row in each.
  Logger.log('-- company tabs: net-profit (revah neto) rows --');
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var nm = sheets[i].getName();
    if (nm.indexOf(_DB_COMPANY_) !== 0) continue;
    var cs = sheets[i];
    var cLast = Math.min(cs.getLastRow(), _DB_MAX_ROWS_);
    var cr = cs.getRange(1, 1, cLast, 3);
    var cf = cr.getFormulas();
    var cd = cr.getDisplayValues();
    var hit = false;
    for (var r4 = 0; r4 < cLast; r4++) {
      if (cd[r4][0] && cd[r4][0].indexOf(_DB_NETPROFIT_) >= 0) {
        Logger.log('  "' + nm + '" R' + (r4 + 1) + ' "' + cd[r4][0] + '"  B=' +
                   (cf[r4][1] || '(' + cd[r4][1] + ')'));
        hit = true;
      }
    }
    if (!hit) Logger.log('  "' + nm + '": no row containing net-profit label found');
  }
  return 'ok';
}

function _db_colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

// -- 6. Rebuild reconnaissance: is the personal tab year-aware + formula-driven?
//   Answers two questions before any rebuild:
//   (a) Are the month cells FORMULAS (safe to rewire) or hand-typed numbers
//       (must be preserved)?
//   (b) Is the year cell a dropdown, and do the rows already reference it
//       ($B$2/$B$4) -- i.e. are they ALREADY year-aware?
function DB_REBUILD_RECON() {
  Logger.log('');
  Logger.log('=== DB_REBUILD_RECON (read-only) ===');
  var sh = _db_ss_().getSheetByName(_DB_PERSONAL_);
  if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }
  var last = Math.min(sh.getLastRow(), _DB_MAX_ROWS_);
  var rng = sh.getRange(1, 1, last, 14);   // A..N
  var forms = rng.getFormulas();
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();

  Logger.log('-- year cell(s) in rows 1-6 + dropdown? --');
  for (var r = 0; r < Math.min(last, 6); r++) {
    for (var c = 0; c < 14; c++) {
      var yv = String(disp[r][c] || '').replace(/[^0-9]/g, '');
      if (/^(202[0-9]|2030)$/.test(yv)) {
        var dvr = sh.getRange(r + 1, c + 1).getDataValidation();
        Logger.log('  ' + _db_colLetter_(c + 1) + (r + 1) + ' = ' + disp[r][c] + '   dropdown=' + (dvr ? 'YES' : 'NO'));
      }
    }
  }

  Logger.log('-- rows with HAND-TYPED non-zero numbers in months C..N (would be lost in a rewire) --');
  var manual = 0;
  for (var r2 = 0; r2 < last; r2++) {
    var cols = [];
    for (var c2 = 2; c2 < 14; c2++) {
      if (!forms[r2][c2] && typeof vals[r2][c2] === 'number' && vals[r2][c2] !== 0) cols.push(_db_colLetter_(c2 + 1));
    }
    if (cols.length) { Logger.log('  R' + (r2 + 1) + ' "' + disp[r2][0] + '": ' + cols.join(',')); manual++; }
  }
  if (!manual) Logger.log('  NONE -- every month cell is a formula. Safe to rewire from \u05ea\u05e0\u05d5\u05e2\u05d5\u05ea.');
  else Logger.log('  ^ these ' + manual + ' rows have hand-typed numbers -- a rewire must preserve them.');

  Logger.log('-- sample January (col C) formulas, to see if rows are already year-aware --');
  var shown = 0;
  for (var r3 = 0; r3 < last && shown < 10; r3++) {
    var cf = forms[r3][2];
    if (cf) { Logger.log('  R' + (r3 + 1) + ' "' + disp[r3][0] + '" C=' + (cf.length > 140 ? cf.slice(0, 140) + '...' : cf)); shown++; }
  }
  Logger.log('  (looking for $B$2 / $B$4 / LEFT(..,4) = year-aware, vs static =C61 / raw)');
  return 'ok';
}

// -- 7. One-click: run everything ---------------------------------------------
function DB_RUN_ALL() {
  DB_SELF_TEST_HEBREW();
  DB_LIST_TABS();
  DB_DUMP_PERSONAL();
  DB_DUMP_ALL_COMPANY();
  DB_FINDINGS();
  DB_REBUILD_RECON();
  Logger.log('');
  Logger.log('=== DONE. Copy this whole log and send it to Claude. ===');
  return 'ok';
}

// ===================== 2) FIX TOTAL EXPENSES (FPT_*) =====================

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
  var lock = LockService.getScriptLock();
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
  var lock = LockService.getScriptLock();
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

// ===================== 3) WIRE ESEK 1 NET PROFIT (WEN_*) =====================

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
  var lock = LockService.getScriptLock();
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
  var lock = LockService.getScriptLock();
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

// ===================== 4) YEAR DROPDOWN (AYD_*) =====================

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
  var lock = LockService.getScriptLock();
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
  var lock = LockService.getScriptLock();
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
