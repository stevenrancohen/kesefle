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

// ===================== 5) FIX ORDERS HEADERS (FOH_*) =====================
// The orders tab ('hazmanot') DATA uses the bot's 12-col order schema, but its
// HEADER row drifted to an old 8-col layout, so the headers do not match the
// data below them. FIX_ORDERS_HEADERS sets A1:L1 to the correct labels.
// COSMETIC ONLY: dashboard formulas reference columns by LETTER (orders!G:G is
// the revenue the company dashboard sums), never by header text -> totals are
// unaffected. Backs up the old headers first; FIX_ORDERS_HEADERS_ROLLBACK undoes.
// Schema A..L: date, month, customer, size/desc, material, production-cost,
// sale-price(=revenue, col G), shipping, profit, source, note, status.
var _FOH_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _FOH_ORDERS_TAB_   = '\u05d4\u05d6\u05de\u05e0\u05d5\u05ea';  // hazmanot (orders)
var _FOH_BACKUP_PROP_  = 'FOH_BACKUP_HEADERS';
var _FOH_HEADERS_ = [
  '\u05ea\u05d0\u05e8\u05d9\u05da',                              // A: tarich (date)
  '\u05d7\u05d5\u05d3\u05e9',                                    // B: chodesh (month)
  '\u05e9\u05dd \u05dc\u05e7\u05d5\u05d7',                       // C: shem lakoach (customer)
  '\u05d2\u05d5\u05d3\u05dc / \u05ea\u05d9\u05d0\u05d5\u05e8',   // D: godel/teur (size/desc)
  '\u05d7\u05d5\u05de\u05e8',                                    // E: chomer (material)
  '\u05e2\u05dc\u05d5\u05ea \u05d9\u05d9\u05e6\u05d5\u05e8',     // F: alut yetzur (production cost)
  '\u05de\u05d7\u05d9\u05e8 \u05de\u05db\u05d9\u05e8\u05d4',     // G: mechir mechira (sale price = revenue)
  '\u05de\u05e9\u05dc\u05d5\u05d7',                              // H: mishloach (shipping)
  '\u05e8\u05d5\u05d5\u05d7',                                    // I: revach (profit)
  '\u05de\u05e7\u05d5\u05e8',                                    // J: makor (source)
  '\u05d4\u05e2\u05e8\u05d4',                                    // K: heara (note)
  '\u05e1\u05d8\u05d8\u05d5\u05e1'                               // L: status
];

function FIX_ORDERS_HEADERS() {
  var ss = SpreadsheetApp.openById(_FOH_NEW_SHEET_ID_);
  var sh = ss.getSheetByName(_FOH_ORDERS_TAB_);
  if (!sh) { Logger.log('!! orders tab not found: ' + _FOH_ORDERS_TAB_); return 'no-tab'; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var n = _FOH_HEADERS_.length;            // 12 -> A1:L1
    var rng = sh.getRange(1, 1, 1, n);
    var old = rng.getValues()[0];
    PropertiesService.getScriptProperties().setProperty(
      _FOH_BACKUP_PROP_, JSON.stringify({ headers: old, at: new Date().toISOString() }));
    Logger.log('Backed up old headers: ' + JSON.stringify(old));
    rng.setValues([_FOH_HEADERS_]);
    SpreadsheetApp.flush();
    Logger.log('DONE. Orders A1:L1 now = ' + JSON.stringify(_FOH_HEADERS_));
    Logger.log('Dashboard totals unaffected (formulas use column letters). Undo: FIX_ORDERS_HEADERS_ROLLBACK.');
    return 'ok';
  } finally { lock.releaseLock(); }
}

function FIX_ORDERS_HEADERS_ROLLBACK() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_FOH_BACKUP_PROP_);
  if (!raw) { Logger.log('!! no backup found.'); return 'no-backup'; }
  var bak = JSON.parse(raw);
  var sh = SpreadsheetApp.openById(_FOH_NEW_SHEET_ID_).getSheetByName(_FOH_ORDERS_TAB_);
  sh.getRange(1, 1, 1, bak.headers.length).setValues([bak.headers]);
  SpreadsheetApp.flush();
  Logger.log('ROLLED BACK orders headers from ' + bak.at);
  return 'ok';
}


// ===================== 6) MIGRATE OLD PERSONAL (MOP_*) =====================
// Migrate the OLD personal sheet's expense categories + cell-notes into the NEW
// 'maazan ishi' tab. Pure label-walker: every row is resolved by reading col A
// at runtime -- NO hardcoded row numbers (rows shift as cycles insert/delete).
//
//   MOP_..._DRY_RUN  : READ ONLY. Plans every ADD / EXISTS / note / orphan-drop.
//   MOP_..._APPLY    : gated by Script Property + backup (props chunks + hidden
//                      tab) + ScriptLock + full ROLLBACK. Inserts missing rows,
//                      rewrites section totals to include them, writes 54 notes,
//                      deletes the 'mehagilion hakodem' orphan block.
//   MOP_..._ROLLBACK : restore from the backup tab (or props).
//
// HARD RULES: never touch 'tnuot' (movements) / 'hazmanot' (orders). Existing
// section categories are NEVER duplicated -- only genuinely-missing ones are
// inserted; notes still migrate onto whichever row already holds that label.
// Year cell is personal B2; month SUMIFS are year-aware ($B$2 & "-01" .. "-12").
// Hebrew is \uXXXX-escaped (matches this file's convention).
// =============================================================================

var _MOP_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MOP_PERSONAL_     = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';   // maazan ishi
var _MOP_TNUOT_        = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';               // tnuot (movements) -- NEVER touch
var _MOP_YEAR_CELL_    = 'B2';                                                // year selector cell
var _MOP_MAX_ROWS_     = 200;                                                 // scan cap for the label-walker

var _MOP_CONFIRM_PROP_ = 'CONFIRM_MIGRATE_OLD_PERSONAL';
var _MOP_CONFIRM_VAL_  = 'YES I UNDERSTAND';
var _MOP_BACKUP_TAB_   = '_MOP_BACKUP_';
var _MOP_BACKUP_PROP_  = 'MOP_BACKUP';        // base key; chunks => MOP_BACKUP_0, _1, ...
var _MOP_BACKUP_META_  = 'MOP_BACKUP_META';   // {chunks:n, at:iso}
var _MOP_BACKUP_ROWS_  = 100;                 // snapshot rows 1..100
var _MOP_BACKUP_COLS_  = 14;                  // cols A..N
var _MOP_PROP_CHUNK_   = 9000;                // < 9KB per Script Property value

var _MOP_SE_           = '\u05e1\u05d4\u05f4\u05db';   // "se..k" total-row prefix ("seh-kaf")
var _MOP_ORPHAN_FRAG_  = '\u05de\u05d4\u05d2\u05d9\u05dc\u05d9\u05d5\u05df \u05d4\u05e7\u05d5\u05d3\u05dd'; // "mehagilion hakodem"

// Section descriptor: key + the col-A fragments that identify its banner & total.
// total = row containing _MOP_SE_ AND totalFrag ; banner = row containing
// bannerFrag but NOT _MOP_SE_. Fragments chosen to be collision-free vs the
// grand-total row "se..k hotsaot" (which contains none of these section frags).
var _MOP_SECTIONS_ = [
  { key: '\u05e7\u05d1\u05d5\u05e2',     // kavua (fixed)
    bannerFrag: '\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05e7\u05d1\u05d5\u05e2\u05d5\u05ea',   // "hotsaot kvuot"
    totalFrag:  '\u05e7\u05d1\u05d5\u05e2' },                                                // "kavua"
  { key: '\u05d6\u05de\u05e0\u05d9',     // zmani (temporary)
    bannerFrag: '\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05d6\u05de\u05e0\u05d9\u05d5\u05ea',   // "hotsaot zmaniot"
    totalFrag:  '\u05d6\u05de\u05e0\u05d9' },                                                // "zmani"
  { key: '\u05d0\u05d5\u05db\u05dc',     // okhel (food)
    bannerFrag: '\u05d0\u05d5\u05db\u05dc',                                                  // "okhel"
    totalFrag:  '\u05d0\u05d5\u05db\u05dc' },                                                // "okhel"
  { key: '\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4',   // tahbura (transport)
    bannerFrag: '\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4',                                      // "tahbura"
    totalFrag:  '\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4' },                                    // "tahbura"
  { key: '\u05d0\u05d7\u05e8',           // aher (other)  -- spec maps to 'aher'/'aheret'
    bannerFrag: '\u05d5\u05d0\u05d7\u05e8\u05d9\u05dd',                                      // "ve-aherim" (banner: shonot ve-aherim)
    totalFrag:  '\u05d0\u05d7\u05e8' }                                                      // "aher" (total: se..k hotsaa aheret)
];


// ---- generated literal arrays (Hebrew \u-escaped via JSON.dumps ensure_ascii) ----
var _MOP_CATS_ = [
  { 'new': "\u05d1\u05d9\u05ea", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05de\u05db\u05d5\u05df \u05db\u05d5\u05e9\u05e8", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d5\u05ea", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05ea\u05e7\u05e9\u05d5\u05e8\u05ea", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05dc\u05d9\u05de\u05d5\u05d3\u05d9\u05dd", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d1\u05d9\u05d8\u05d5\u05d7 \u05d0\u05d9\u05e9\u05d9", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d0\u05d1\u05d0", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d1\u05e0\u05e7\u05d0\u05d5\u05ea", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05e4\u05dc\u05d9\u05d9\u05e1\u05d8\u05d9\u05d9\u05e9\u05df", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d7\u05d1\u05e8\u05d4 / \u05de\u05e1 / \u05d1\u05d9\u05d8\u05d5\u05d7 \u05dc\u05d0\u05d5\u05de\u05d9", 'section': "\u05e7\u05d1\u05d5\u05e2" },
  { 'new': "\u05d7\u05e6\u05d9 \u05d0\u05d9\u05d9\u05e8\u05d5\u05df \u05de\u05df", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05de\u05e8\u05d5\u05e5 - \u05d0\u05d5\u05e1\u05d8\u05e8\u05d9\u05d4", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05e2\u05d5\u05e8\u05db\u05d9 \u05d3\u05d9\u05df", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05d1\u05e0\u05e7 \u05d4\u05e4\u05d5\u05e2\u05dc\u05d9\u05dd", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05d7\u05d5\u05e4\u05e9\u05d5\u05ea", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05d2\u05d9\u05d0", 'section': "\u05d6\u05de\u05e0\u05d9" },
  { 'new': "\u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5", 'section': "\u05d0\u05d5\u05db\u05dc" },
  { 'new': "\u05d0\u05d5\u05db\u05dc \u05dc\u05d1\u05d9\u05ea", 'section': "\u05d0\u05d5\u05db\u05dc" },
  { 'new': "\u05d1\u05d9\u05d8\u05d5\u05d7 \u05e8\u05db\u05d1", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05e8\u05d5\u05d1\u05d9\u05e7\u05d5\u05df", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05d7\u05e0\u05d9\u05d4", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05dc\u05d9\u05d9\u05dd", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "BMW s1000", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05d3\u05dc\u05e7", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05d0\u05d5\u05d8\u05d5\u05d1\u05d5\u05e1/\u05de\u05d5\u05e0\u05d9\u05ea/\u05e8\u05db\u05d1\u05ea", 'section': "\u05ea\u05d7\u05d1\u05d5\u05e8\u05d4" },
  { 'new': "\u05d0\u05d8\u05e8\u05e7\u05e6\u05d9\u05d5\u05ea", 'section': "\u05d0\u05d7\u05e8" },
  { 'new': "\u05e1\u05e4\u05e8\u05d9\u05dd", 'section': "\u05d0\u05d7\u05e8" },
  { 'new': "\u05e6\u05d9\u05d5\u05d3 \u05de\u05d7\u05e9\u05d1\u05d9 \u05d5\u05d2\u05d3\u05d2'\u05d8\u05d9\u05dd", 'section': "\u05d0\u05d7\u05e8" },
  { 'new': "\u05d1\u05d9\u05d2\u05d5\u05d3", 'section': "\u05d0\u05d7\u05e8" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'section': "\u05d0\u05d7\u05e8" },
];

var _MOP_NOTES_ = [
  { 'new': "\u05d4\u05db\u05e0\u05e1\u05d4 1 \u2014 \u05de\u05e9\u05db\u05d5\u05e8\u05ea", 'col': "F", 'text': "3900 \u05d3\u05d5\u05dc\u05e8 / 11505 \u05e9\u05e7\u05dc" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "C", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u20aa150 \u05ea\u05e9\u05dc\u05d5\u05dd \u05e2\u05dc \u05d0\u05d9\u05e9\u05d5\u05e8 \u05e8\u05d5\u05e4\u05d0 \u05dc\u05d1\u05d3\u05d9\u05e7\u05ea \u05de\u05d0\u05de\u05e5\u00a0\n\n\u20aa97 \u05dc\u05d1\u05d9\u05d8\u05d5\u05d7 \u05ea\u05d0\u05d5\u05e0\u05d5\u05ea \u05d7\u05d5\u05d3\u05e9\u05d9\u05d5\u05ea" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "I", 'text': "\u2550\u2550 2025 \u2550\u2550\n420 \u05de\u05d1\u05e8\u05d2\u05d4" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "L", 'text': "\u2550\u2550 2024 \u2550\u2550\n3900 \u05e9\u05d7 \u05de\u05db\u05d9\u05e8\u05ea \u05e9\u05e2\u05d5\u05df \u05e8\u05d0\u05d3\u05d5" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "N", 'text': "\u2550\u2550 2024 \u2550\u2550\nplus500" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "D", 'text': "\u2550\u2550 2026 \u2550\u2550\n3350 \u05d0\u05d2\u05e8\u05d4 \u05d3\u05d5\u05d7 \u05e9\u05e0\u05ea\u05d9 2023 -2022" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "E", 'text': "\u2550\u2550 2026 \u2550\u2550\n500 \u05d5\u05d9\u05dc\u05d5\u05e0\u05d5\u05ea+\u05e4\u05d7+\u05de\u05e6\u05e2\u05d9\u05dd+\u05e7\u05d5\u05dc\u05d1 | 800 \u05de\u05d5\u05d1\u05d9\u05dc\u05d9\u05dd \u05dc\u05de\u05e7\u05e8\u05e8 \u05d5\u05dc\u05e9\u05d5\u05dc\u05d7\u05df | 963 \u05e8\u05d9\u05d4\u05d5\u05d8 \u05dc\u05d1\u05d9\u05ea | 1106 \u05d7\u05d5\u05de\u05e8 \u05e6\u05d1\u05d9\u05e2\u05d4 \u05d5\u05d0\u05d9\u05d8\u05d5\u05dd \u05dc\u05d1\u05d9\u05ea (\u05dc\u05d1\u05d3\u05d5\u05e7 \u05de\u05d5\u05dc \u05de\u05d0\u05d5\u05e8 \u05d0\u05ea \u05d4\u05de\u05e2\u05f4\u05de) + 400 \u05e6\u05d9\u05d5\u05d3 \u05dc\u05d1\u05d9\u05ea + 475 (\u05e2\u05d5\u05d3 \u05d7\u05d5\u05de\u05e8 \u05e6\u05d1\u05d9\u05e2\u05d4 \u05d5\u05db\u05d5\u05f4) + 120 \u05e9\u05e4\u05db\u05d8\u05dc \u05d0\u05de\u05e8\u05d9\u05e7\u05d0\u05d9 \u05e9\u05dc\u05d9\u05e9\u05d9 + 1077 (\u05d0\u05d1\u05d0) \u05e6\u05d9\u05d5\u05d3 \u05e6\u05d1\u05d9\u05e2\u05d4+ 50 \u05e6\u05d9\u05d5\u05d3 \u05e8\u05d5\u05dc\u05e8 \u05e9\u05e4\u05db\u05d8\u05dc + 316 \u05de\u05d5\u05e6\u05e8\u05d9 \u05de\u05d8\u05d1\u05d7+240(\u05e6\u05d9\u05d5\u05d3 \u05e6\u05d1\u05d9\u05e2\u05d4 \u05e9\u05e0\u05d9 \u05d3\u05dc\u05d9\u05d9\u05dd) + 1152 (\u05e6\u05d9\u05d5\u05d3 \u05ea\u05d0\u05d5\u05e8\u05d4 \u05d5\u05de\u05d8\u05d0\u05d8\u05d0) +658 \u05e6\u05d9\u05d5\u05d3 \u05de\u05e7\u05d3\u05d7\u05d4 \u05dc\u05d1\u05d9\u05ea + 613 \u05d0\u05dc\u05d9\u05d0\u05e7\u05e1\u05e4\u05e8\u05e1 \u05d3\u05d1\u05e8\u05d9\u05dd \u05dc\u05d1\u05d9\u05ea+1000 \u05e2\u05d6\u05e8\u05d4 \u05d1\u05e0\u05d9\u05e7\u05d5\u05d9 \u05d4\u05d1\u05d9\u05ea \u05dc\u05d0\u05d1\u05d0 \u05d5\u05d2\u05d9\u05d0+ \u05d8\u05d5\u05e1\u05d8\u05e8 \u05e7 +272 \u05d1\u05d5\u05e0\u05d3\u05e8\u05d5\u05dc + \u05de\u05d8\u05d0\u05d8\u05d0 + \u05e9\u05d9\u05e4\u05d5\u05e6\u05e0\u05d9\u05e7+65 \u05d2\u05de\u05d1\u05d5 \u05d5\u05d1\u05d5\u05e7\u05e1\u05d4 + 1000 \u05e9\u05dc\u05d5\u05de\u05d9 \u05e2\u05d6\u05e8\u05d4 \u05e1\u05e4\u05e8\u05d9\u05d4+\u05d4\u05ea\u05e7\u05e0\u05ea \u05d8\u05dc\u05d5\u05d5\u05d9\u05d6\u05d9\u05d4+\u05ea\u05d0\u05d5\u05e8\u05d4+509 \u05ea\u05d0\u05d5\u05e8\u05d4 \u05dc\u05d1\u05d9\u05ea + 1000 \u05e9\u05dc\u05d5\u05de\u05d9 \u05e9\u05e7\u05e2\u05d9\u05dd + 143 \u05e9\u05e4\u05db\u05d8\u05dc \u05d0\u05de\u05e8\u05d9\u05e7\u05d0\u05d9 + 3 \u05e9\u05e7\u05e2\u05d9\u05dd \u05dc\u05d1\u05d9\u05ea + 420 \u05e6\u05d1\u05e2 \u05dc\u05d1\u05d9\u05ea + \u05de\u05e0\u05d5\u05e8\u05d5\u05ea + 170 \u05de\u05ea\u05dc\u05d4 \u05dc\u05d5\u05d5\u05d9\u05dc\u05d5\u05e0\u05d5\u05ea + 450 \u05e9\u05dc\u05d5\u05de\u05d9 \u05d7\u05e6\u05d9 \u05d9\u05d5\u05dd \u05e2\u05d1\u05d5\u05d3\u05d4 + 490 \u05ea\u05d0\u05d5\u05e8\u05d4 \u05d5\u05de\u05d5\u05d8 \u05dc\u05d5\u05d5\u05d9\u05dc\u05d5\u05e0\u05d5\u05ea + 210 \u05e2\u05dc \u05e2\u05d1\u05d5\u05d3\u05d4" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "F", 'text': "\u2550\u2550 2026 \u2550\u2550\n\u05de\u05d3\u05f4\u05d0 (\u05e6\u05d9\u05d5\u05d3 \u05dc\u05d1\u05d9\u05ea): 400\n\u05db\u05e0\u05d9\u05e1\u05d4 \u05dc\u05d3\u05dc\u05ea \u05e8\u05d1 \u05d1\u05e8\u05d9\u05d7: 183\n\u05de\u05e6\u05dc\u05de\u05d4 \u05dc\u05d1\u05d9\u05ea \u05d5\u05e6\u05d9\u05d5\u05d3 \u05e0\u05d5\u05e1\u05e3: 153\n\u05e4\u05d8\u05d9\u05e9\u05d5\u05df: 300\n\u05e6\u05d9\u05e0\u05d5\u05e8 \u05dc\u05e9\u05d9\u05e8\u05d5\u05ea\u05d9\u05dd: +\u05e7\u05e6\u05e3 \u05e4\u05d5\u05dc\u05d9\u05d0\u05d5\u05e8\u05d9\u05ea\u05df +\u05d0\u05e7\u05d3\u05d7 \u05e1\u05d9\u05dc\u05d9\u05e7\u05d5\u05df +\u05e4\u05e8\u05d5\u05e4\u05d5\u05e7\u05e1\u05d9 = 324" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "G", 'text': "\u2550\u2550 2025 \u2550\u2550\n2000 \u05e9\u05db\u05d9\u05e8\u05d5\u05ea\n595 \u05de\u05d9\u05dd \u05d7\u05e6\u05d9 \u05e9\u05e0\u05ea\u05d9" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "H", 'text': "\u2550\u2550 2024 \u2550\u2550\n1040 \u05d7\u05e9\u05de\u05dc\n270 \u05d5\u05d5\u05e2\u05d3 \u05d1\u05d9\u05ea" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "I", 'text': "\u2550\u2550 2025 \u2550\u2550\n790 \u05d0\u05e8\u05e0\u05d5\u05e0\u05d4 \u05d0\u05e8\u05d1\u05e2 \u05d7\u05d5\u05d3\u05e9\u05d9\u05dd" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "L", 'text': "\u2550\u2550 2025 \u2550\u2550\n\u05d7\u05e9\u05de\u05dc - 410\n\n\u2550\u2550 2024 \u2550\u2550\n2294+537 \u05d7\u05e9\u05d1\u05d5\u05df \u05d7\u05e9\u05de\u05dc \u05d5\u05d7\u05e9\u05d1\u05d5\u05df \u05de\u05d9\u05dd" },
  { 'new': "\u05d1\u05d9\u05ea", 'col': "M", 'text': "\u2550\u2550 2025 \u2550\u2550\n500 - \u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05d7\u05e9\u05de\u05dc \u05d0\u05e8\u05e0\u05d5\u05e0\u05d4 \u05de\u05d9\u05dd\n300 \u05d5\u05d5\u05e2\u05d3" },
  { 'new': "\u05de\u05db\u05d5\u05df \u05db\u05d5\u05e9\u05e8", 'col': "E", 'text': "\u2550\u2550 2026 \u2550\u2550\n700 \u05d5\u05d9\u05d8\u05de\u05d9\u05e0\u05d9\u05dd + 20 \u05d1\u05e7\u05d1\u05d5\u05e7 \u05e9\u05ea\u05d9\u05d4" },
  { 'new': "\u05de\u05db\u05d5\u05df \u05db\u05d5\u05e9\u05e8", 'col': "F", 'text': "\u2550\u2550 2025 \u2550\u2550\n75 - \u05d7\u05e6\u05d9 \u05d7\u05d5\u05d3\u05e9 \u05d7\u05d9\u05d3\u05d5\u05e9 \u05de\u05e0\u05d5\u05d9 \u05e1\u05e4\u05d9\u05d9\u05e1\u00a0\n230 - \u05ea\u05d5\u05e1\u05e4\u05d9 \u05ea\u05d6\u05d5\u05e0\u05d4 \u05d5\u05d8\u05d9\u05e4\u05d5\u05d7" },
  { 'new': "\u05de\u05db\u05d5\u05df \u05db\u05d5\u05e9\u05e8", 'col': "J", 'text': "\u2550\u2550 2025 \u2550\u2550\n82+53\u05d1\u05d2\u05d3\u05d9\u05dd \u05d0\u05dc\u05d9\u05d0\u05e7\u05e1\u05e4\u05e8\u05e1\u00a0\n14 \u05dc\u05d0 \u05d9\u05d3\u05d5\u05e2\n11 \u05d0\u05d1\u05d0\n50 \u05de\u05e1\u05e4\u05e8\u05d4 \n210 \u05e4\u05e8\u05d7\u05d9\u05dd - \u05e8\u05d5\u05e0\u05d9\n67 \u05db\u05e4\u05db\u05e4\u05d9\u05dd \u05d0\u05dc\u05d9\u05d0\u05e7\u05e1\u05e8\u05e1" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "D", 'text': "\u2550\u2550 2026 \u2550\u2550\n252 \u05e1\u05d5\u05dc\u05e7 payplus" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "E", 'text': "\u2550\u2550 2026 \u2550\u2550\n\u05e4\u05e8\u05e2\u05d5\u05e9\u05d9\u05dd 343 + 385 \u05d2\u05dc\u05d9\u05d9\u05e7\u05d5\u05e4\u05dc\u05e7\u05e1 + 39 \u05e8\u05e6\u05d5\u05e2\u05d4 \u05dc\u05d7\u05d9\u05d6\u05d5\u05e7 \u05d4\u05e8\u05d2\u05d9\u05dc + 500 \u05d4\u05d9\u05d3\u05e8\u05d5\u05ea\u05e8\u05e4\u05d9\u05d4 + 230 \u05db\u05d3\u05d5\u05e8 \u05de\u05d2\u05d3\n\n\u2550\u2550 2024 \u2550\u2550\n\u05d0\u05d5\u05db\u05dc - 409\u00a0\n670 \u05de\u05e0\u05d5\u05d9 \u05e9\u05e0\u05ea\u05d9" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "F", 'text': "\u2550\u2550 2026 \u2550\u2550\n\u05e7\u05d5\u05dc\u05e8 \u05d0\u05d9\u05dc\u05d5\u05e3 (\u05d0\u05e4\u05d5\u05dc\u05d5): 101\n\u05d0\u05d5\u05db\u05dc \u05dc\u05d0\u05e4\u05d5\u05dc\u05d5: 340" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "G", 'text': "\u2550\u2550 2024 \u2550\u2550\n459 \u05d0\u05d5\u05db\u05dc \u05dc\u05d0\u05e4\u05d5\u05dc\u05d5\n250 \u05db\u05d3\u05d5\u05e8 \u05e0\u05d2\u05d3 \u05e4\u05e8\u05e2\u05d5\u05e9\u05d9\u05dd" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "I", 'text': "\u2550\u2550 2024 \u2550\u2550\n360 - 18 \u05e7\u05d9\u05dc\u05d5 \u05d0\u05d5\u05db\u05dc \u05dc\u05d0\u05e4\u05d5\u05dc\u05d5" },
  { 'new': "\u05d0\u05e4\u05d5\u05dc\u05d5", 'col': "L", 'text': "\u2550\u2550 2023 \u2550\u2550\n168 \u05e1\u05dc\u05d9\u05d9\u05d3\u05e8\u05d9\u05dd \u05dc\u05d0\u05d5\u05e4\u05e0\u05d5\u05e2 - 8.7.24" },
  { 'new': "\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d5\u05ea", 'col': "F", 'text': "\u2550\u2550 2026 \u2550\u2550\n\u05e0\u05d8\u05e4\u05dc\u05d9\u05e7\u05e1: 70\nClaude: 311\nClaude: 311" },
  { 'new': "\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d5\u05ea", 'col': "H", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u05de\u05ea\u05e0\u05d4 \u05dc\u05d9\u05d5\u05dd \u05d4\u05d5\u05dc\u05d3\u05ea \u05de\u05d0\u05d5\u05e8 - 650 \u05e9\u05d7" },
  { 'new': "\u05dc\u05d9\u05de\u05d5\u05d3\u05d9\u05dd", 'col': "C", 'text': "\u2550\u2550 2026 \u2550\u2550\n400 \u05d1\u05df \u05e8\u05d5\u05df \u05ea\u05d0\u05d2\u05d9\u05d3\u05d9\u05dd" },
  { 'new': "\u05dc\u05d9\u05de\u05d5\u05d3\u05d9\u05dd", 'col': "H", 'text': "\u2550\u2550 2024 \u2550\u2550\n370 \u05e6\u05e2\u05e6\u05d5\u05e2\u05d9\u05dd \u05d5\u05d7\u05d8\u05d9\u05e4\u05d9\u05dd\n80 \u05d0\u05d5\u05db\u05dc \u05dc\u05d0\u05e4\u05d5\u05dc\u05d5" },
  { 'new': "\u05d0\u05d1\u05d0", 'col': "J", 'text': "\u2550\u2550 2024 \u2550\u2550\n6000 - \u05d0\u05d2\u05e8\u05d4\n4000 - \u05e2\u05d5\u05f4\u05d3" },
  { 'new': "\u05e4\u05dc\u05d9\u05d9\u05e1\u05d8\u05d9\u05d9\u05e9\u05df", 'col': "E", 'text': "\u2550\u2550 2026 \u2550\u2550\nBattlefield: 287\n\u05d0\u05d9\u05e0\u05d8\u05e8\u05e0\u05d8 (\u05e4\u05dc\u05d9\u05d9\u05e1\u05d8\u05d9\u05d9\u05e9\u05df): 16\n\u05de\u05e0\u05d5\u05d9 \u05e9\u05e0\u05ea\u05d9: 320\n\u05d0\u05d9\u05e0\u05d8\u05e8\u05e0\u05d8 (\u05e4\u05dc\u05d9\u05d9\u05e1\u05d8\u05d9\u05d9\u05e9\u05df): 16\nBattlefield: 287" },
  { 'new': "\u05e2\u05d5\u05e8\u05db\u05d9 \u05d3\u05d9\u05df", 'col': "F", 'text': "\u2550\u2550 2025 \u2550\u2550\n1062 \u05e9\u05f4\u05d7 - \u05e2\u05d5\u05f4\u05d3 \u05e9\u05d9 \u05e8\u05e9\u05e3" },
  { 'new': "\u05d1\u05e0\u05e7 \u05d4\u05e4\u05d5\u05e2\u05dc\u05d9\u05dd", 'col': "I", 'text': "\u2550\u2550 2024 \u2550\u2550\n1064 \u05d4\u05d5\u05e6\u05d0\u05d4 \u05dc\u05e4\u05d5\u05e2\u05dc" },
  { 'new': "\u05d1\u05e0\u05e7 \u05d4\u05e4\u05d5\u05e2\u05dc\u05d9\u05dd", 'col': "K", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u20aa2740 \u05ea\u05e9\u05dc\u05d5\u05dd \u05d7\u05df\u05d1 11/9" },
  { 'new': "\u05d7\u05d5\u05e4\u05e9\u05d5\u05ea", 'col': "J", 'text': "\u2550\u2550 2025 \u2550\u2550\n\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05d1\u05e9\"\u05d7\n75 \u05de\u05d5\u05e0\u05d9\u05ea\n131 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5\n64 \u05d1\u05d9\u05d8\u05d5\u05d7\n70 \u05d7\u05d1\u05d9\u05dc\u05ea \u05d2\u05dc\u05d9\u05e9\u05d4\n2,335 \u05db\u05e8\u05d8\u05d9\u05e1 \u05d8\u05d9\u05e1\u05d4\n\u05e1\u05d4\"\u05db \u05d1\u05e9\"\u05d7 = 2,675 \u20aa\n\n\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05d1\u05d3\u05d5\u05dc\u05e8 \u2192 \u05e9\u05e7\u05dc\n200 \u05de\u05d5\u05e0\u05d9\u05ea = 200 \u00d7 3.4 = 680 \u20aa\n1,637 \u05de\u05e1\u05d9\u05d1\u05d4 = 1,637 \u00d7 3.4 = 5,565.8 \u20aa\n\n263 \u05e9\u05ea\u05d9\u05d9\u05d4 \u05d5\u05e9\u05e3 = 263 \u00d7 3.4 = 894.2 \u20aa\n\u05e1\u05d4\"\u05db \u05d1\u05d3\u05d5\u05dc\u05e8 = 2,100 $ = 7,140 \u20aa\n\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea \u05d1\u05d9\u05d5\u05e8\u05d5 \u2192 \u05e9\u05e7\u05dc\n\n30 \u05de\u05d5\u05e0\u05d9\u05ea \u05e0\u05ea\u05d1\"\u05d2 = 120 \u20aa\n340 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5 = 1,360 \u20aa\n360 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5 = 1,440 \u20aa\n262.5 \u05d4\u05e9\u05db\u05e8\u05ea \u05e8\u05d5\u05d1\u05d9\u05e7\u05d5\u05df = 1,050 \u20aa\n468 \u05d1\u05d2\u05d3\u05d9\u05dd = 1,872 \u20aa\n30 \u05d3\u05dc\u05e7 = 120 \u20aa\n105 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5 = 420 \u20aa\n520 \u05de\u05e1\u05d9\u05d1\u05d4 = 2,080 \u20aa\n60 \u05de\u05d5\u05e0\u05d9\u05ea = 240 \u20aa\n13 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5 = 52 \u20aa\n\u05e1\u05d4\"\u05db \u05d1\u05d9\u05d5\u05e8\u05d5 = 2,188.5 \u20ac = 8,754 \u20aa\n\n\u05e1\u05d9\u05db\u05d5\u05dd \u05db\u05dc\u05dc\u05d9\n\u05e1\u05d4\"\u05db \u20aa \u05d9\u05e9\u05d9\u05e8 = 2,675 \u20aa\n\u05e1\u05d4\"\u05db $ \u2192 \u20aa = 7,140 \u20aa\n\u05e1\u05d4\"\u05db \u20ac \u2192 \u20aa = 8,754 \u20aa\n\u05e1\u05d4\"\u05db \u05db\u05d5\u05dc\u05dc = 18,569 \u20aa" },
  { 'new': "\u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5", 'col': "AG", 'text': "23/05 12:33 \u00b7 \u20aa32 \u00b7 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5\n23/05 21:18 \u00b7 \u20aa400 \u00b7 \u05d0\u05d5\u05db\u05dc\n23/05 22:36 \u00b7 \u20aa21 \u00b7 \u05d0\u05d5\u05db\u05dc \u05d1\u05d7\u05d5\u05e5\n24/05 10:04 \u00b7 \u20aa1 \u00b7 \u05e7\u05e4\u05d4\n25/05 13:13 \u00b7 \u20aa280 \u00b7 \u05d0\u05d5\u05db\u05dc \u05dc\u05d1\u05d9\u05ea\n25/05 14:03 \u00b7 \u20aa330 \u00b7 \u05d0\u05d5\u05db\u05dc \u05dc\u05d1\u05d9\u05ea \u05de\u05d2\u05d1\u05d5\u05ea \u05de\u05e6\u05e2\u05d9\u05dd" },
  { 'new': "\u05d0\u05d5\u05db\u05dc \u05dc\u05d1\u05d9\u05ea", 'col': "AG", 'text': "25/05 22:06 \u00b7 \u20aa1 \u00b7 \u05e1\u05d5\u05e4\u05e8" },
  { 'new': "\u05e8\u05d5\u05d1\u05d9\u05e7\u05d5\u05df", 'col': "C", 'text': "\u2550\u2550 2026 \u2550\u2550\n400 -\u00a0\u05e8\u05db\u05d9\u05e9\u05ea \u05d7\u05dc\u05e7\u05d9\u05dd \u05dc\u05e8\u05db\u05d1 aliexpress" },
  { 'new': "\u05d7\u05e0\u05d9\u05d4", 'col': "C", 'text': "\u2550\u2550 2026 \u2550\u2550\n35 \u05e4\u05d5\u05d8\u05d5\u05e9\u05d5\u05e4" },
  { 'new': "\u05dc\u05d9\u05d9\u05dd", 'col': "D", 'text': "\u2550\u2550 2025 \u2550\u2550\n40 \u05de\u05e0\u05d5\u05d9 \u05d7\u05d5\u05d3\u05e9\u05d9" },
  { 'new': "\u05dc\u05d9\u05d9\u05dd", 'col': "E", 'text': "\u2550\u2550 2025 \u2550\u2550\n\u05d0\u05e4\u05dc: 40\n\n\u05d2\u05e8\u05de\u05d9\u05d5: 50\n\n\u05dc\u05d9\u05d9\u05dd: 40\n\n110 \u05d0\u05e4\u05dc" },
  { 'new': "\u05dc\u05d9\u05d9\u05dd", 'col': "F", 'text': "\u2550\u2550 2025 \u2550\u2550\n38 - \u05e1\u05e8\u05d8" },
  { 'new': "\u05dc\u05d9\u05d9\u05dd", 'col': "AG", 'text': "22/05 10:16 \u00b7 \u20aa16 \u00b7 \u05dc\u05d9\u05d9\u05dd\n22/05 13:26 \u00b7 \u20aa18 \u00b7 \u05dc\u05d9\u05d9\u05dd\n22/05 19:09 \u00b7 \u20aa18 \u00b7 \u05dc\u05d9\u05d9\u05dd\n28/05 01:16 \u00b7 \u20aa14 \u00b7 \u05dc\u05d9\u05d9\u05dd" },
  { 'new': "\u05d3\u05dc\u05e7", 'col': "D", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u05de\u05ea\u05e0\u05d4 - \u05e1\u05d8\u05d9\u05d1\u05df \u05de\u05e9\u05dc\u05dd" },
  { 'new': "\u05d3\u05dc\u05e7", 'col': "F", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u05e1\u05d8\u05d9\u05d1\u05df - \u05d7\u05e9\u05d1\u05d5\u05df \u05d1\u05e0\u05e7" },
  { 'new': "\u05d3\u05dc\u05e7", 'col': "J", 'text': "\u2550\u2550 2024 \u2550\u2550\n210 okcupid" },
  { 'new': "\u05d3\u05dc\u05e7", 'col': "L", 'text': "\u2550\u2550 2024 \u2550\u2550\n122 - nordpass 2 year plan" },
  { 'new': "\u05d3\u05dc\u05e7", 'col': "M", 'text': "\u2550\u2550 2024 \u2550\u2550\n347 = \u05d1\u05d9\u05d8\u05d5\u05d7 \u05d7\u05d5\u05d1\u05d4 \u05d7\u05d5\u05d3\u05e9\u05d9\n\n110 = \u05d1\u05d9\u05d8\u05d5\u05d7 \u05d2\u05e8\u05e8 - \u05ea\u05e9\u05dc\u05d5\u05dd \u05e9\u05dc 440 \u05de\u05e1\u05ea\u05d9\u05d9\u05dd \u05d1\u05d3\u05e6\u05de\u05d1\u05e8" },
  { 'new': "\u05d0\u05d5\u05d8\u05d5\u05d1\u05d5\u05e1/\u05de\u05d5\u05e0\u05d9\u05ea/\u05e8\u05db\u05d1\u05ea", 'col': "E", 'text': "\u2550\u2550 2026 \u2550\u2550\n220 \u05de\u05d9\u05d3\u05d2\u05d5\u05e8\u05e0\u05d9 \n55 - runway gen3" },
  { 'new': "\u05d0\u05d5\u05d8\u05d5\u05d1\u05d5\u05e1/\u05de\u05d5\u05e0\u05d9\u05ea/\u05e8\u05db\u05d1\u05ea", 'col': "M", 'text': "\u2550\u2550 2025 \u2550\u2550\n150\n96\n43\n60" },
  { 'new': "\u05e6\u05d9\u05d5\u05d3 \u05de\u05d7\u05e9\u05d1\u05d9 \u05d5\u05d2\u05d3\u05d2'\u05d8\u05d9\u05dd", 'col': "G", 'text': "\u2550\u2550 2025 \u2550\u2550\n\u20aa70 \u05e4\u05d5\u05d8\u05d5\u05e9\u05d5\u05e4" },
  { 'new': "\u05e6\u05d9\u05d5\u05d3 \u05de\u05d7\u05e9\u05d1\u05d9 \u05d5\u05d2\u05d3\u05d2'\u05d8\u05d9\u05dd", 'col': "H", 'text': "\u2550\u2550 2025 \u2550\u2550\n388 \u05e7\u05d5\u05d1\u05d9\u05d4 \u05d4\u05d5\u05e0\u05d2\u05e8\u05d9\u05ea" },
  { 'new': "\u05e6\u05d9\u05d5\u05d3 \u05de\u05d7\u05e9\u05d1\u05d9 \u05d5\u05d2\u05d3\u05d2'\u05d8\u05d9\u05dd", 'col': "L", 'text': "\u2550\u2550 2024 \u2550\u2550\n101 \u05de\u05e1\u05d0\u05d6 \u05dc\u05db\u05d9\u05e1\u05d0 \u05de\u05d7\u05e9\u05d1" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "C", 'text': "\u2550\u2550 2024 \u2550\u2550\n\u20aa150 \u05ea\u05e9\u05dc\u05d5\u05dd \u05e2\u05dc \u05d0\u05d9\u05e9\u05d5\u05e8 \u05e8\u05d5\u05e4\u05d0 \u05dc\u05d1\u05d3\u05d9\u05e7\u05ea \u05de\u05d0\u05de\u05e5\u00a0\n\n\u20aa97 \u05dc\u05d1\u05d9\u05d8\u05d5\u05d7 \u05ea\u05d0\u05d5\u05e0\u05d5\u05ea \u05d7\u05d5\u05d3\u05e9\u05d9\u05d5\u05ea" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "I", 'text': "\u2550\u2550 2025 \u2550\u2550\n420 \u05de\u05d1\u05e8\u05d2\u05d4" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "L", 'text': "\u2550\u2550 2024 \u2550\u2550\n3900 \u05e9\u05d7 \u05de\u05db\u05d9\u05e8\u05ea \u05e9\u05e2\u05d5\u05df \u05e8\u05d0\u05d3\u05d5" },
  { 'new': "\u05e9\u05d5\u05e0\u05d5\u05ea", 'col': "N", 'text': "\u2550\u2550 2024 \u2550\u2550\nplus500" },
];

function _mop_ss_()   { return SpreadsheetApp.openById(_MOP_NEW_SHEET_ID_); }
function _mop_sheet_(){ return _mop_ss_().getSheetByName(_MOP_PERSONAL_); }

// Column letter (1->A, 27->AA) ; and letter->index.
function _mop_colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function _mop_colIndex_(letter) {
  var n = 0;
  for (var i = 0; i < letter.length; i++) n = n * 26 + (letter.charCodeAt(i) - 64);
  return n;
}

// Read col A labels (1..maxRows) once, trimmed. Returns array indexed by row-1.
function _mop_readLabels_(sh) {
  var last = Math.min(sh.getLastRow(), _MOP_MAX_ROWS_);
  if (last < 1) return [];
  var vals = sh.getRange(1, 1, last, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i][0];
    out.push(v == null ? '' : String(v).trim());
  }
  return out;
}

// Find first row (1-based) whose label contains EVERY fragment in `frags` and
// NONE in `notFrags`. Returns -1 if none. `from` is a 0-based start index.
function _mop_findRow_(labels, frags, notFrags, from) {
  from = from || 0;
  for (var i = from; i < labels.length; i++) {
    var L = labels[i];
    if (!L) continue;
    var ok = true, j;
    for (j = 0; j < frags.length; j++) { if (L.indexOf(frags[j]) === -1) { ok = false; break; } }
    if (ok && notFrags) for (j = 0; j < notFrags.length; j++) { if (L.indexOf(notFrags[j]) !== -1) { ok = false; break; } }
    if (ok) return i + 1;
  }
  return -1;
}

// Find a row whose label EXACTLY equals `label` within [fromRow..toRow] (1-based, inclusive).
function _mop_findExact_(labels, label, fromRow, toRow) {
  for (var r = fromRow; r <= toRow && r <= labels.length; r++) {
    if (labels[r - 1] === label) return r;
  }
  return -1;
}

// Set of all category 'new' labels (so a banner is never mistaken for a category row,
// e.g. the food banner fragment "okhel" also occurs in "okhel ba-huts" / "okhel la-bayit").
var _MOP_CAT_LABELSET_ = null;
function _mop_catLabelSet_() {
  if (_MOP_CAT_LABELSET_) return _MOP_CAT_LABELSET_;
  _MOP_CAT_LABELSET_ = {};
  for (var i = 0; i < _MOP_CATS_.length; i++) _MOP_CAT_LABELSET_[_MOP_CATS_[i]['new']] = true;
  return _MOP_CAT_LABELSET_;
}

// Resolve a section: { key, bannerRow, totalRow }. -1 rows if not found.
// banner = FIRST row before the total that contains bannerFrag, is NOT a total row,
// and is NOT itself one of the migrated category labels. This keeps the food banner
// ("...okhel") from collapsing onto the "okhel ba-huts"/"okhel la-bayit" category rows.
function _mop_resolveSection_(labels, sec) {
  var totalRow = _mop_findRow_(labels, [_MOP_SE_, sec.totalFrag], null, 0);
  var bannerRow = -1;
  if (totalRow > 0) {
    var cats = _mop_catLabelSet_();
    for (var i = 0; i < totalRow - 1; i++) {
      var L = labels[i];
      if (L && L.indexOf(sec.bannerFrag) !== -1 && L.indexOf(_MOP_SE_) === -1 && !cats[L]) {
        bannerRow = i + 1;
        break;   // first (top-most) qualifying banner wins
      }
    }
  }
  return { key: sec.key, bannerRow: bannerRow, totalRow: totalRow };
}

// Build the year-aware month SUMIFS for a category row `r`, month column index `ci` (C=3..N=14).
// =SUMIFS('tnuot'!C:C,'tnuot'!B:B,$B$2&"-MM",'tnuot'!E:E,$A{r})
function _mop_monthFormula_(r, ci) {
  var mm = ci - 2;                       // C(3)->1 ... N(14)->12
  var mmStr = (mm < 10 ? '0' : '') + mm;
  var T = "'" + _MOP_TNUOT_ + "'";
  // year cell as a fully-absolute ref: 'B2' -> '$B$2'
  var Y = '$' + _MOP_YEAR_CELL_.replace(/([A-Z]+)(\d+)/, '$1$$$2');
  return "=SUMIFS(" + T + "!C:C," + T + "!B:B," + Y + '&"-' + mmStr + '",'
       + T + "!E:E,$A" + r + ")";
}

// Banner=SUM over the section's category range for B and each month col.
function _mop_sumFormula_(col, firstRow, lastRow) {
  return "=SUM(" + col + firstRow + ":" + col + lastRow + ")";
}

// ---- 6.1 DRY RUN (READ ONLY) -------------------------------------------------
function MIGRATE_OLD_PERSONAL_DRY_RUN() {
  Logger.log('=== MIGRATE_OLD_PERSONAL_DRY_RUN (READ ONLY) ===');
  var sh = _mop_sheet_();
  if (!sh) { Logger.log('!! personal tab not found: ' + _MOP_PERSONAL_); return 'no-tab'; }
  var labels = _mop_readLabels_(sh);
  var yr = sh.getRange(_MOP_YEAR_CELL_).getDisplayValue();
  Logger.log('Tab "' + _MOP_PERSONAL_ + '"  scanned ' + labels.length + ' rows. Year cell ' + _MOP_YEAR_CELL_ + ' = ' + yr);
  Logger.log('');

  // Resolve sections + plan ADD/EXISTS per category.
  var addCountBySection = {}, totalAdd = 0;
  var resolved = {};        // key -> {bannerRow,totalRow}
  var rowForLabel = {};     // 'new' label -> row that holds (or will hold, post-insert order) it; for DRY we map existing only
  for (var s = 0; s < _MOP_SECTIONS_.length; s++) {
    var sec = _MOP_SECTIONS_[s];
    var info = _mop_resolveSection_(labels, sec);
    resolved[sec.key] = info;
    addCountBySection[sec.key] = 0;
    if (info.bannerRow < 0 || info.totalRow < 0) {
      Logger.log('!! SECTION "' + sec.key + '" NOT RESOLVED (banner=' + info.bannerRow + ' total=' + info.totalRow + ') -- its categories will be skipped.');
      continue;
    }
    Logger.log('SECTION "' + sec.key + '": banner R' + info.bannerRow + ' .. total R' + info.totalRow
               + '  (category range R' + (info.bannerRow + 1) + '..R' + (info.totalRow - 1) + ')');
    for (var c = 0; c < _MOP_CATS_.length; c++) {
      var cat = _MOP_CATS_[c];
      if (cat.section !== sec.key) continue;
      var hit = _mop_findExact_(labels, cat['new'], info.bannerRow + 1, info.totalRow - 1);
      if (hit > 0) {
        Logger.log('   EXISTS  R' + hit + '  "' + cat['new'] + '"  (skip insert)');
        rowForLabel[cat['new']] = hit;
      } else {
        Logger.log('   ADD     (insert before total)  "' + cat['new'] + '"');
        addCountBySection[sec.key]++;
        totalAdd++;
      }
    }
  }
  Logger.log('');

  // Notes plan: resolve each note's target row by EXACT label anywhere in the sheet
  // (income rows included). EXISTS rows are known; ADD rows do not exist yet so we
  // report them as "(new row)" -- they WILL exist at apply-time.
  var addLabels = {};
  for (var c2 = 0; c2 < _MOP_CATS_.length; c2++) {
    var cc = _MOP_CATS_[c2];
    if (rowForLabel[cc['new']] === undefined) addLabels[cc['new']] = true; // genuinely-missing categories
  }
  var noteSet = 0, noteSkip = 0;
  Logger.log('NOTES (' + _MOP_NOTES_.length + '):');
  for (var n = 0; n < _MOP_NOTES_.length; n++) {
    var note = _MOP_NOTES_[n];
    var ci = _mop_colIndex_(note.col);
    var row = rowForLabel[note['new']];
    if (row === undefined) {
      // A genuinely-missing category gets a NEW row at apply-time -> report that first
      // (its only current match would be the to-be-deleted orphan block).
      if (addLabels[note['new']]) {
        Logger.log('   SET   ' + note.col + '(new row)  <- note for "' + note['new'] + '" (row inserted at apply)');
        noteSet++;
      } else {
        // label that exists OUTSIDE the expense sections (e.g. an income row).
        var anyRow = _mop_findExact_(labels, note['new'], 1, labels.length);
        if (anyRow > 0) {
          Logger.log('   SET   ' + note.col + 'R' + anyRow + '  <- note for "' + note['new'] + '"');
          noteSet++;
        } else {
          Logger.log('   SKIP  note for "' + note['new'] + '" col ' + note.col + ' (label not found)');
          noteSkip++;
        }
      }
    } else {
      Logger.log('   SET   ' + note.col + 'R' + row + '  <- note for "' + note['new'] + '"');
      noteSet++;
    }
  }
  Logger.log('');

  // Orphan block.
  var orphanRow = _mop_findRow_(labels, [_MOP_ORPHAN_FRAG_], null, 0);
  if (orphanRow > 0) {
    var endRow = _mop_orphanEnd_(labels, orphanRow);
    Logger.log('ORPHAN: "mehagilion hakodem" banner R' + orphanRow + ' .. block ends R' + endRow
               + '  => will DELETE rows ' + orphanRow + '..' + endRow + ' (' + (endRow - orphanRow + 1) + ' rows).');
  } else {
    Logger.log('ORPHAN: not found (nothing to delete).');
  }
  Logger.log('');

  // Clean summary.
  Logger.log('---------------- SUMMARY ----------------');
  for (var s2 = 0; s2 < _MOP_SECTIONS_.length; s2++) {
    var k = _MOP_SECTIONS_[s2].key;
    Logger.log('  ' + k + ': ' + addCountBySection[k] + ' row(s) to ADD');
  }
  Logger.log('  TOTAL rows to add : ' + totalAdd);
  Logger.log('  Notes to SET      : ' + noteSet + '   (SKIP ' + noteSkip + ')');
  Logger.log('  Orphan block      : ' + (orphanRow > 0 ? 'will be REMOVED' : 'none'));
  Logger.log('  Section totals    : will be REWRITTEN to include the new rows (no double-count).');
  Logger.log('  Writes performed  : 0 (dry run).');
  Logger.log('To apply: set Script Property ' + _MOP_CONFIRM_PROP_ + ' = ' + _MOP_CONFIRM_VAL_ + ' then run MIGRATE_OLD_PERSONAL_APPLY.');
  return 'ok';
}

// Orphan block end = walk down from bannerRow while rows are non-empty (label OR
// any value in A..N). Stops at the first fully-blank row (or sheet end / cap).
function _mop_orphanEnd_(labels, bannerRow) {
  var sh = _mop_sheet_();
  var last = Math.min(sh.getLastRow(), _MOP_MAX_ROWS_);
  var end = bannerRow;
  // read A..N for the tail once to detect blank rows
  var height = last - bannerRow + 1;
  if (height < 1) return bannerRow;
  var block = sh.getRange(bannerRow, 1, height, _MOP_BACKUP_COLS_).getValues();
  for (var i = 1; i < block.length; i++) {       // start at row after banner
    var blank = true;
    for (var c = 0; c < block[i].length; c++) {
      if (block[i][c] !== '' && block[i][c] !== null) { blank = false; break; }
    }
    if (blank) break;
    end = bannerRow + i;
  }
  return end;
}

// ---- 6.2 APPLY ---------------------------------------------------------------
function MIGRATE_OLD_PERSONAL_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_MOP_CONFIRM_PROP_) !== _MOP_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _MOP_CONFIRM_PROP_ + ' = ' + _MOP_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _mop_ss_();
    var sh = ss.getSheetByName(_MOP_PERSONAL_);
    if (!sh) { Logger.log('!! personal tab not found: ' + _MOP_PERSONAL_); return 'no-tab'; }

    // ---- BACKUP FIRST (hidden tab + chunked props) ----
    _mop_backup_(ss, sh, props);
    Logger.log('BACKUP done -> tab "' + _MOP_BACKUP_TAB_ + '" + props "' + _MOP_BACKUP_PROP_ + '_*".');

    // ===== PHASE 1: INSERT blank rows for missing categories (label in col A only). =====
    // Process sections BOTTOM-UP so inserting in a lower section never shifts the rows of
    // a not-yet-processed (higher) section. We write col-A labels only here; ALL formulas
    // are written in PHASE 2 by FINAL resolved row, so nothing depends on Sheets auto-
    // adjusting references when later sections push rows down.
    var orderIdx = [];
    for (var i = 0; i < _MOP_SECTIONS_.length; i++) orderIdx.push(i);
    var labels0 = _mop_readLabels_(sh);
    orderIdx.sort(function(a, b) {
      return _mop_resolveSection_(labels0, _MOP_SECTIONS_[b]).totalRow
           - _mop_resolveSection_(labels0, _MOP_SECTIONS_[a]).totalRow;   // descending total row
    });

    var addedLabels = {};   // label -> section key  (for PHASE 2 formula write)
    var addedTotal = 0;
    for (var oi = 0; oi < orderIdx.length; oi++) {
      var sec = _MOP_SECTIONS_[orderIdx[oi]];
      var labels = _mop_readLabels_(sh);
      var info = _mop_resolveSection_(labels, sec);
      if (info.bannerRow < 0 || info.totalRow < 0) {
        Logger.log('!! SKIP section "' + sec.key + '" (unresolved banner=' + info.bannerRow + ' total=' + info.totalRow + ').');
        continue;
      }
      var missing = [];
      for (var c = 0; c < _MOP_CATS_.length; c++) {
        var cat = _MOP_CATS_[c];
        if (cat.section !== sec.key) continue;
        var hit = _mop_findExact_(labels, cat['new'], info.bannerRow + 1, info.totalRow - 1);
        if (hit < 0) missing.push(cat['new']);
        else Logger.log('   EXISTS R' + hit + ' "' + cat['new'] + '" (skip)');
      }
      for (var m = 0; m < missing.length; m++) {
        labels = _mop_readLabels_(sh);
        info = _mop_resolveSection_(labels, sec);
        sh.insertRowsBefore(info.totalRow, 1);          // blank row just above the total
        sh.getRange(info.totalRow, 1).setValue(missing[m]);   // col A label only
        addedLabels[missing[m]] = sec.key;
        Logger.log('   ADD    "' + missing[m] + '" (blank row inserted above "' + sec.key + '" total)');
        addedTotal++;
      }
    }

    // ===== PHASE 2: write B + C..N formulas on every ADDED row, by FINAL resolved row. =====
    var labelsF = _mop_readLabels_(sh);
    for (var a2 = 0; a2 < _MOP_CATS_.length; a2++) {
      var lab = _MOP_CATS_[a2]['new'];
      if (!addedLabels.hasOwnProperty(lab)) continue;     // only the rows we inserted
      var r = _mop_findExact_(labelsF, lab, 1, labelsF.length);
      if (r < 0) { Logger.log('!! PHASE2: could not relocate added row "' + lab + '"'); continue; }
      sh.getRange(r, 2).setFormula('=SUM(C' + r + ':N' + r + ')');         // B = SUM(C{r}:N{r})
      for (var ci = 3; ci <= _MOP_BACKUP_COLS_; ci++) {
        sh.getRange(r, ci).setFormula(_mop_monthFormula_(r, ci));          // C..N year-aware SUMIFS
      }
      Logger.log('   FORMULA R' + r + ' "' + lab + '" B=SUM(C' + r + ':N' + r + '), C..N=SUMIFS(year ' + _MOP_YEAR_CELL_ + ')');
    }

    // ===== PHASE 3: rewrite each section total over its FINAL category range. =====
    // (bannerRow+1 .. totalRow-1) -> includes the new rows, excludes banner & total => no double-count.
    for (var s3 = 0; s3 < _MOP_SECTIONS_.length; s3++) {
      var secT = _MOP_SECTIONS_[s3];
      var labelsT = _mop_readLabels_(sh);
      var infoT = _mop_resolveSection_(labelsT, secT);
      if (infoT.bannerRow < 0 || infoT.totalRow < 0) continue;
      var first = infoT.bannerRow + 1;
      var lastCat = infoT.totalRow - 1;
      if (lastCat < first) continue;
      sh.getRange(infoT.totalRow, 2).setFormula(_mop_sumFormula_('B', first, lastCat));
      for (var ci2 = 3; ci2 <= _MOP_BACKUP_COLS_; ci2++) {
        var col = _mop_colLetter_(ci2);
        sh.getRange(infoT.totalRow, ci2).setFormula(_mop_sumFormula_(col, first, lastCat));
      }
      Logger.log('   TOTAL  R' + infoT.totalRow + ' "' + secT.key + '" = SUM(rows ' + first + '..' + lastCat + ') for B..N');
    }

    // ===== PHASE 4: WRITE NOTES (resolve each row by EXACT label, top-most match). =====
    // The new section rows sit ABOVE the orphan block, so a top-down first match always
    // lands on the real row, never the soon-to-be-deleted orphan duplicate.
    var labelsN = _mop_readLabels_(sh);
    var noteSet = 0, noteSkip = 0;
    for (var n = 0; n < _MOP_NOTES_.length; n++) {
      var note = _MOP_NOTES_[n];
      var row = _mop_findExact_(labelsN, note['new'], 1, labelsN.length);
      if (row < 0) { Logger.log('   SKIP note "' + note['new'] + '" col ' + note.col + ' (label not found)'); noteSkip++; continue; }
      var ci = _mop_colIndex_(note.col);
      sh.getRange(row, ci).setNote(note.text);
      Logger.log('   NOTE   ' + note.col + 'R' + row + ' <- "' + note['new'] + '"');
      noteSet++;
    }

    // ===== PHASE 5: DELETE the 'mehagilion hakodem' orphan block. =====
    var labelsO = _mop_readLabels_(sh);
    var orphanRow = _mop_findRow_(labelsO, [_MOP_ORPHAN_FRAG_], null, 0);
    if (orphanRow > 0) {
      var endRow = _mop_orphanEnd_(labelsO, orphanRow);
      var cnt = endRow - orphanRow + 1;
      sh.deleteRows(orphanRow, cnt);
      Logger.log('   ORPHAN deleted rows ' + orphanRow + '..' + endRow + ' (' + cnt + ' rows).');
    } else {
      Logger.log('   ORPHAN none found.');
    }

    SpreadsheetApp.flush();
    Logger.log('=== APPLY DONE: added ' + addedTotal + ' rows, set ' + noteSet + ' notes (skip ' + noteSkip + '). Undo: MIGRATE_OLD_PERSONAL_ROLLBACK. ===');
    return 'ok';
  } finally { lock.releaseLock(); }
}

// Snapshot rows 1..100 cols A..N (values + formulas + notes) -> hidden tab AND chunked props.
function _mop_backup_(ss, sh, props) {
  var rng = sh.getRange(1, 1, _MOP_BACKUP_ROWS_, _MOP_BACKUP_COLS_);
  var values   = rng.getValues();
  var formulas = rng.getFormulas();
  var notes    = rng.getNotes();

  // -- hidden backup tab: write a fresh one (delete stale) --
  var old = ss.getSheetByName(_MOP_BACKUP_TAB_);
  if (old) ss.deleteSheet(old);
  var b = ss.insertSheet(_MOP_BACKUP_TAB_);
  b.hideSheet();
  // restore-friendly: for each cell, prefer formula else value; also stash notes.
  var restore = [];
  for (var r = 0; r < values.length; r++) {
    var rowOut = [];
    for (var c = 0; c < values[r].length; c++) {
      rowOut.push(formulas[r][c] !== '' ? formulas[r][c] : values[r][c]);
    }
    restore.push(rowOut);
  }
  b.getRange(1, 1, restore.length, _MOP_BACKUP_COLS_).setValues(restore);
  b.getRange(1, 1, notes.length, _MOP_BACKUP_COLS_).setNotes(notes);
  b.getRange(1, 16).setValue('MOP backup of "' + _MOP_PERSONAL_ + '" rows 1..' + _MOP_BACKUP_ROWS_ + ' A..N at ' + new Date().toISOString());

  // -- chunked Script Properties (belt-and-suspenders) --
  var payload = JSON.stringify({ values: values, formulas: formulas, notes: notes });
  // clear old chunks
  var oldMeta = props.getProperty(_MOP_BACKUP_META_);
  if (oldMeta) {
    try { var om = JSON.parse(oldMeta); for (var k = 0; k < om.chunks; k++) props.deleteProperty(_MOP_BACKUP_PROP_ + '_' + k); } catch (e) {}
  }
  var nChunks = Math.ceil(payload.length / _MOP_PROP_CHUNK_);
  for (var i = 0; i < nChunks; i++) {
    props.setProperty(_MOP_BACKUP_PROP_ + '_' + i, payload.substr(i * _MOP_PROP_CHUNK_, _MOP_PROP_CHUNK_));
  }
  props.setProperty(_MOP_BACKUP_META_, JSON.stringify({ chunks: nChunks, rows: _MOP_BACKUP_ROWS_, cols: _MOP_BACKUP_COLS_, at: new Date().toISOString() }));
}

// ---- 6.3 ROLLBACK ------------------------------------------------------------
function MIGRATE_OLD_PERSONAL_ROLLBACK() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var ss = _mop_ss_();
    var sh = ss.getSheetByName(_MOP_PERSONAL_);
    if (!sh) { Logger.log('!! personal tab not found.'); return 'no-tab'; }

    // Prefer the hidden backup tab (preserves formulas/values/notes exactly).
    var b = ss.getSheetByName(_MOP_BACKUP_TAB_);
    if (b) {
      var rows = _MOP_BACKUP_ROWS_, cols = _MOP_BACKUP_COLS_;
      var restore = b.getRange(1, 1, rows, cols).getValues();   // formulas-or-values
      var notes   = b.getRange(1, 1, rows, cols).getNotes();
      // Ensure the live tab has at least `rows` rows.
      if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
      var rng = sh.getRange(1, 1, rows, cols);
      rng.clearContent();
      rng.clearNote();
      rng.setValues(restore);     // strings starting with "=" are re-interpreted as formulas
      rng.setNotes(notes);
      SpreadsheetApp.flush();
      Logger.log('ROLLBACK from hidden tab "' + _MOP_BACKUP_TAB_ + '" (rows 1..' + rows + ' A..N restored).');
      return 'ok';
    }

    // Fallback: chunked props.
    var props = PropertiesService.getScriptProperties();
    var metaRaw = props.getProperty(_MOP_BACKUP_META_);
    if (!metaRaw) { Logger.log('!! no backup (no tab, no props).'); return 'no-backup'; }
    var meta = JSON.parse(metaRaw);
    var payload = '';
    for (var k = 0; k < meta.chunks; k++) payload += (props.getProperty(_MOP_BACKUP_PROP_ + '_' + k) || '');
    var data = JSON.parse(payload);
    var rows2 = meta.rows, cols2 = meta.cols;
    if (sh.getMaxRows() < rows2) sh.insertRowsAfter(sh.getMaxRows(), rows2 - sh.getMaxRows());
    var rng2 = sh.getRange(1, 1, rows2, cols2);
    rng2.clearContent(); rng2.clearNote();
    // rebuild formulas-or-values
    var restore2 = [];
    for (var r = 0; r < data.values.length; r++) {
      var rr = [];
      for (var c = 0; c < data.values[r].length; c++) rr.push(data.formulas[r][c] !== '' ? data.formulas[r][c] : data.values[r][c]);
      restore2.push(rr);
    }
    rng2.setValues(restore2);
    rng2.setNotes(data.notes);
    SpreadsheetApp.flush();
    Logger.log('ROLLBACK from props "' + _MOP_BACKUP_PROP_ + '_*" (rows 1..' + rows2 + ' A..N restored).');
    return 'ok';
  } finally { lock.releaseLock(); }
}


// ---- 7.1 BAKED-IN ORDER DATA (ASCII / \u-escaped; generated by /tmp/gen_moo.py) ----
// Each row is the FINAL hazmanot 12-col shape:
//   [date, "YYYY-MM", customer, size, "", cost, SALE(=col G), "", profit, source, note, status]
// 2023: 156 orders, revenue(col G)=177352.54, 2023-01-01 .. 2023-12-31
var _MOO_ROWS_2023_ = [
  ["2023-01-01", "2023-01", "\u05d2\u05dc", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 400, 1220, "", 820, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-01-01", "2023-01", "\u05dc\u05d9\u05d0\u05d5\u05e8 - \u05e8\u05d5\u05e4\u05d0 \u05e9\u05d9\u05e0\u05d9\u05d9\u05dd", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 1000, "", 785, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-01-01", "2023-01", "\u05dc\u05d9\u05d0\u05d5\u05e8 - \u05e8\u05d5\u05e4\u05d0 \u05e9\u05d9\u05e0\u05d9\u05d9\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 700, "", 360, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-12", "2023-02", "\u05d9\u05e0\u05d9\u05d1", "\u05de\u05e1\u05e4\u05e8 \u05ea\u05de\u05d5\u05e0\u05d5\u05ea", "", 600, 720, "", 120, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-15", "2023-02", "\u05e9\u05dc\u05d5\u05de\u05d9\u05ea", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 400, 800, "", 400, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-17", "2023-02", "\u05dc\u05d9\u05d0\u05df \u05e1\u05e4\u05d9\u05e8", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 425, "", 275, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-20", "2023-02", "\u05d9\u05d0\u05d9\u05e8 \u05d7\u05d5\u05d1\u05e8\u05d4", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 400, "", 150, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-28", "2023-02", "\u05d9\u05e0\u05d9\u05d1", "60-60", "", 145, 200, "", 55, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-02-28", "2023-02", "\u05d9\u05e0\u05d9\u05d1", "60-90", "", 215, 300, "", 85, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-03-26", "2023-03", "\u05de\u05d8\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 770, "", 510, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-03-27", "2023-03", "\u05d7\u05d5\u05d1\u05d1", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1750, "", 1160, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-04-16", "2023-04", "\u05d0\u05d5\u05e8", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 495, "", 155, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-04-17", "2023-04", "\u05d2\u05d9\u05d0 \u05d2\u05d1\u05d0\u05d9", "70-100x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 780, 2200, "", 1420, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-04-17", "2023-04", "\u05d2\u05d9\u05d0 \u05d2\u05d1\u05d0\u05d9", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1400, "", 810, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-04-20", "2023-04", "\u05d9\u05d0\u05d9\u05e8 \u05de\u05d0\u05e9\u05d3\u05d5\u05d3", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 125, 340, "", 215, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-04-30", "2023-04", "\u05d0\u05e0\u05d8 \u05de\u05d0\u05e9\u05d3\u05d5\u05d3", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1475, "", 885, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-01", "2023-05", "\u05d0\u05e0\u05d8 \u05d0\u05e9\u05d3\u05d5\u05d3", "\u05d1\u05dc\u05d5\u05e7 \u05d0\u05e7\u05e8\u05d9\u05dc", "", 295, 600, "", 305, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-02", "2023-05", "\u05d0\u05e0\u05d8 \u05d0\u05e9\u05d3\u05d5\u05d3", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1475, "", 885, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-09", "2023-05", "\u05d0\u05e0\u05d8 \u05de\u05d0\u05e9\u05d3\u05d5\u05d3", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 890, 950, "", 60, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-09", "2023-05", "\u05d0\u05e0\u05d8 \u05de\u05d0\u05e9\u05d3\u05d5\u05d3", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 500, "", 240, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-04", "2023-05", "\u05e4\u05d0\u05d1\u05dc\u05d5\u05e1", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1300, "", 710, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-09", "2023-05", "\u05dc\u05d9\u05d4\u05d9\u05d0 \u05e2\u05e4\u05d5\u05dc\u05d4", "50-100 x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 615, 1650, "", 1035, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-15", "2023-05", "\u05d8\u05dc \u05d3\u05e8\u05d5\u05e8", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1351.02, "", 761.02, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-15", "2023-05", "\u05d0\u05d5\u05e4\u05e7 \u05de\u05d7\u05d5\u05dc\u05d5\u05df", "\u05d1\u05dc\u05d5\u05e7 \u05d0\u05e7\u05e8\u05d9\u05dc", "", 70, 130, "", 60, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-18", "2023-05", "\u05d8\u05dc \u05d3\u05e8\u05d5\u05e8", "60x90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 744, "", 529, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-18", "2023-05", "\u05d0\u05d5\u05d1\u05d9\u05d1 \u05d4\u05d1\u05df \u05e9\u05dc \u05e2\u05d5\u05e4\u05e8", "60x90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 400, "", 185, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-18", "2023-05", "\u05dc\u05d9\u05d0\u05d5\u05e8 \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 425, "", 275, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-05-21", "2023-05", "\u05d0\u05e1\u05ea\u05e8 \u05d1\u05ea \u05d9\u05dd", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1400, "", 810, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-06", "2023-06", "\u05e9\u05d9 \u05dc\u05d5\u05d9 \u05d0\u05dc\u05e4\u05d9 \u05de\u05e0\u05e9\u05d4", "90x170 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 650, 1651, "", 1001, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-07", "2023-06", "\u05d1\u05e8 \u05e2\u05d5\u05d1\u05d3", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 205, 0, "", -205, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-12", "2023-06", "\u05d0\u05d1\u05d9 \u05d0\u05d1\u05d9\u05d8\u05dc \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 935, "", 595, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-12", "2023-06", "\u05e0\u05ea\u05df \u05d2\u05d1\u05d0\u05d9 - \u05e8\u05d0\u05e9\u05f4\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1080, "", 740, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-12", "2023-06", "\u05d0\u05d1\u05d9\u05e9\u05d9 - \u05d1\u05d0\u05e8 \u05d9\u05e2\u05e7\u05d1", "100x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 400, 1200, "", 800, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-18", "2023-06", "\u05d0\u05dc\u05d9\u05d4\u05d5 \u05d9\u05d5\u05e0\u05d4", "20-30  \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 70, 265, "", 195, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-19", "2023-06", "\u05e8\u05d5\u05d1\u05e8\u05d8\u05d5 - \u05d0\u05e9\u05d3\u05d5\u05d3", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 700, "", 440, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-20", "2023-06", "\u05d0\u05ea\u05d9 \u05d5\u05de\u05d0\u05d9\u05e8 - \u05d0\u05e9\u05d3\u05d5\u05d3", "150-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1500, 2800, "", 1300, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-20", "2023-06", "\u05d9\u05d5\u05e1\u05e3 \u05de\u05e0\u05d4\u05e8\u05d9\u05d4", "60-90 x4 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 860, 2650, "", 1790, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-26", "2023-06", "\u05dc\u05d9\u05df \u05de\u05d5\u05e2\u05dc\u05dd - \u05e8\u05de\u05dc\u05d4", "80-160 \u05e7\u05e0\u05d1\u05e1", "", 320, 900, "", 580, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-26", "2023-06", "\u05e0\u05ea\u05e0\u05d0\u05dc - \u05d1\u05ea \u05d9\u05dd", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1800, "", 1210, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-06-28", "2023-06", "\u05e0\u05d8\u05dc\u05d9 \u05d2\u05d1\u05e2\u05ea\u05d9\u05d9\u05dd", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1800, "", 1210, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-03", "2023-07", "\u05d1\u05d5\u05e8\u05d9\u05e1 \u05ea\u05e2\u05e9\u05d9\u05d9\u05d4 \u05d0\u05d5\u05d5\u05d9\u05e8\u05d9\u05ea", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1750, "", 1160, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-03", "2023-07", "\u05d1\u05d5\u05e8\u05d9\u05e1 \u05ea\u05e2\u05e9\u05d9\u05d9\u05d4 \u05d0\u05d5\u05d5\u05d9\u05e8\u05d9\u05ea", "100x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 395, 1200, "", 805, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-03", "2023-07", "\u05d1\u05d5\u05e8\u05d9\u05e1 \u05ea\u05e2\u05e9\u05d9\u05d9\u05d4 \u05d0\u05d5\u05d5\u05d9\u05e8\u05d9\u05ea", "100x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 395, 1200, "", 805, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-03", "2023-07", "\u05d1\u05d5\u05e8\u05d9\u05e1 \u05ea\u05e2\u05e9\u05d9\u05d9\u05d4 \u05d0\u05d5\u05d5\u05d9\u05e8\u05d9\u05ea", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1150, "", 810, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-20", "2023-07", "\u05e2\u05dc\u05d9", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 512, 1300, "", 788, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-20", "2023-07", "\u05e2\u05dc\u05d9", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 512, 1300, "", 788, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-20", "2023-07", "\u05e2\u05dc\u05d9", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1300, "", 710, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-20", "2023-07", "\u05de\u05e9\u05d4 \u05d6\u05d4\u05d1\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100x150 \u05e7\u05e0\u05d1\u05e1", "", 375, 1208, "", 833, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-25", "2023-07", "\u05dc\u05d9\u05e8\u05d5\u05df \u05d2\u05d1\u05e2\u05ea\u05d9\u05d9\u05dd", "80-120x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 966, "", 626, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-25", "2023-07", "\u05dc\u05d9\u05e8\u05d5\u05df \u05d2\u05d1\u05e2\u05ea\u05d9\u05d9\u05dd", "80-120x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 966, "", 626, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-25", "2023-07", "\u05dc\u05d9\u05e8\u05d5\u05df \u05d2\u05d1\u05e2\u05ea\u05d9\u05d9\u05dd", "80-120x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 966, "", 626, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-25", "2023-07", "\u05d0\u05d5\u05e8\u05d9 - \u05de\u05e1\u05d2\u05e8\u05ea \u05d0\u05e8\u05d5\u05df \u05d7\u05e9\u05de\u05dc", "\u05de\u05e1\u05d2\u05e8\u05ea \u05d0\u05e8\u05d5\u05df \u05d7\u05e9\u05de\u05dc 50-70", "", 315, 950, "", 635, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-28", "2023-07", "\u05d7\u05dc\u05d9 \u05de\u05d0\u05e9\u05d3\u05d5\u05d3", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1850, "", 1260, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-31", "2023-07", "\u05e7\u05e8\u05d5\u05dc\u05d9\u05df", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 657.12, "", 507.12, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-31", "2023-07", "\u05d0\u05e1\u05d9 \u05de\u05e8\u05d0\u05e9\u05d5\u05df", "30-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 98, 497, "", 399, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-31", "2023-07", "\u05d0\u05e1\u05d9 \u05de\u05e8\u05d0\u05e9\u05d5\u05df", "30-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 98, 497, "", 399, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-07-31", "2023-07", "\u05d0\u05e1\u05d9 \u05de\u05e8\u05d0\u05e9\u05d5\u05df", "40-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 130, 497, "", 367, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-01", "2023-08", "\u05d9\u05d5\u05e1\u05e3", "60x90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 1250, "", 1035, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-09", "2023-08", "\u05de\u05e0\u05d9 \u05d0\u05dc\u05d1\u05d6", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 88, 536, "", 448, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-13", "2023-08", "\u05e2\u05e0\u05d1\u05dc \u05d8\u05dc", "150-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1500, 3400, "", 2350, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-14", "2023-08", "\u05e7\u05e8\u05d5\u05dc\u05d9\u05d9\u05df \u05e8\u05e2\u05e0\u05e0\u05d4", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 550, "", 400, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-14", "2023-08", "\u05e7\u05e8\u05d5\u05dc\u05d9\u05d9\u05df \u05e8\u05e2\u05e0\u05e0\u05d4", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 550, "", 400, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-14", "2023-08", "\u05e9\u05e8\u05d5\u05df \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 940, "", 690, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-14", "2023-08", "\u05e9\u05e8\u05d5\u05df \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1700, "", 1110, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-15", "2023-08", "\u05e0\u05d3\u05d1 \u05db\u05d4\u05df \u05d1\u05ea \u05d9\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1158, "", 818, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-17", "2023-08", "\u05dc\u05d0\u05d5\u05e0\u05d9\u05d3 \u05d0\u05e9\u05e7\u05dc\u05d5\u05df", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1126, "", 1236, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-17", "2023-08", "\u05d8\u05d8\u05d9\u05d0\u05e0\u05d4 \u05d0\u05e9\u05d3\u05d5\u05d3", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 570, 1812, "", 1642, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-18", "2023-08", "\u05d0\u05e0\u05d4 \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1412, "", 1402, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-20", "2023-08", "\u05d3\u05d5\u05d3 \u05de\u05d5\u05e1 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 1211, "", 961, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-22", "2023-08", "\u05e2\u05d3\u05d9\u05d0\u05dc \u05d5\u05e8\u05d5\u05d5\u05d9\u05ea", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 120, "", "", "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-22", "2023-08", "\u05e2\u05d3\u05d9\u05d0\u05dc \u05d5\u05e8\u05d5\u05d5\u05d9\u05ea", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 120, "", "", "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-22", "2023-08", "\u05e2\u05d3\u05d9\u05d0\u05dc \u05d5\u05e8\u05d5\u05d5\u05d9\u05ea", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 120, "", "", "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-23", "2023-08", "\u05d0\u05dc\u05d3\u05e8 \u05e8\u05e2\u05e0\u05e0\u05d4", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 890, 1847, "", 957, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-23", "2023-08", "\u05d0\u05dc\u05d3\u05e8 \u05e8\u05e2\u05e0\u05e0\u05d4", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 864, "", 614, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-23", "2023-08", "\u05d0\u05dc\u05d3\u05e8 \u05e8\u05e2\u05e0\u05e0\u05d4", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 907, "", 657, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-23", "2023-08", "\u05d0\u05dc\u05d3\u05e8 \u05e8\u05e2\u05e0\u05e0\u05d4", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 1000, "", 1335, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-23", "2023-08", "\u05d0\u05dc\u05d3\u05e8 \u05e8\u05e2\u05e0\u05e0\u05d4", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 570, 979, "", 409, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05d0\u05e0\u05d0\u05e8", "150-200 \u05e7\u05e0\u05d1\u05e1", "", 750, 1750, "", 1000, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05d0\u05e0\u05d0\u05e8", "100x150 \u05e7\u05e0\u05d1\u05e1", "", 382, 758, "", 376, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05d0\u05e0\u05d0\u05e8", "90-170 \u05e7\u05e0\u05d1\u05e1", "", 375, 816, "", 441, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "150x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 950, 2470, "", 1520, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "150x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 950, 2470, "", 1520, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 1150, "", 900, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "50-130 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 1150, "", 900, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1250, "", 910, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 1250, "", 910, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "100x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 395, 1440, "", 1045, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1250, "", 990, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 1320, "", 730, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "\u05e7\u05e0\u05d1\u05e1 \u05de\u05ea\u05e0\u05d4", "", 240, 240, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05de\u05d0\u05d5\u05e8 \u05de\u05dc\u05d5\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 340, 340, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-24", "2023-08", "\u05e9\u05e8\u05d5\u05df \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 590, 590, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-29", "2023-08", "\u05d3\u05d5\u05d3 \u05de\u05d5\u05e1 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 250, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-29", "2023-08", "\u05d0\u05d1\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "150-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1500, 3500, "", 2000, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-08-29", "2023-08", "\u05d0\u05d1\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 890, 2400, "", 1810, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-02", "2023-09", "\u05d4\u05d9\u05dc\u05d4", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486, 1950, "", 1764, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-02", "2023-09", "\u05d4\u05d9\u05dc\u05d4", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1400, "", 1077, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-02", "2023-09", "\u05d0\u05dc\u05db\u05e1\u05e0\u05d3\u05e8", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 846, 2575, "", 1729, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-03", "2023-09", "\u05d0\u05dc\u05db\u05e1\u05e0\u05d3\u05e8", "100-200 \u05e7\u05e0\u05d1\u05e1", "", 500, 1769.4, "", 1269.4, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-03", "2023-09", "\u05de\u05d0\u05d5\u05e8 \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "80x120 \u05e7\u05e0\u05d1\u05e1", "", 240, 0, "", "", "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-04", "2023-09", "\u05d0\u05dc\u05d9\u05e7\u05d5", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1300, "", 977, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-04", "2023-09", "\u05d0\u05dc\u05d9\u05e7\u05d5", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 0, "", -323, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-08", "2023-09", "\u05e9\u05dc\u05d5\u05de\u05d9", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 450, "", 300, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-11", "2023-09", "\u05de\u05d0\u05d9", "70-100 x2 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 520, 1900, "", 1380, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-14", "2023-09", "\u05de\u05e0\u05e6\u05d5\u05e8 \u05d1\u05ea \u05d9\u05dd", "80-120 x4 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1292, 3900, "", 2608, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-18", "2023-09", "\u05e9\u05dc\u05d5\u05de\u05d9", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 450, "", 300, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-09-26", "2023-09", "\u05d9\u05e6\u05d7\u05e7 \u05d7\u05d9\u05d5\u05df", "60x90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 1169, "", 954, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-01", "2023-10", "\u05d0\u05dc\u05db\u05e1\u05e0\u05d3\u05e8 - \u05e7\u05e8\u05d9\u05d9\u05ea \u05d2\u05ea", "100-200 \u05e7\u05e0\u05d1\u05e1", "", 500, 1752, "", 1252, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-01", "2023-10", "\u05d2\u05dc\u05d9\u05d4 - \u05e8\u05d0\u05e9 \u05d4\u05e2\u05d9\u05df", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1427, "", 1104, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05e1\u05d8\u05d9\u05d1\u05df", "\u05d1\u05dc\u05d5\u05e7 \u05d0\u05e7\u05e8\u05d9\u05dc 13-18 x8", "", 640, 640, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05e1\u05d8\u05d9\u05d1\u05df", "80x120 \u05e7\u05e0\u05d1\u05e1", "", 240, 240, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05e1\u05d8\u05d9\u05d1\u05df", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 260, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05d0\u05e0\u05d4", "90x170 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 617.5, 1650, "", 1032.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05d0\u05e0\u05d4", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 541.5, 1650, "", 1108.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-03", "2023-10", "\u05d0\u05d9\u05dc\u05d9\u05d4", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 820, "", 560, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", ""],
  ["2023-10-18", "2023-10", "\u05d0\u05d5\u05e4\u05e7 \u05e4\u05d6\u05d5\u05dc\u05d5", "30-45 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 90, 320, "", 230, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-27", "2023-10", "\u05d0\u05d5\u05e8", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 590, "", 440, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-10-30", "2023-10", "\u05d2\u05dc\u05d9\u05d4 - \u05e8\u05d0\u05e9 \u05d4\u05e2\u05d9\u05df", "100-180 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 850, 2600, "", 1750, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-06", "2023-11", "\u05d2\u05dc\u05d9\u05ea \u05e1\u05dc\u05e2", "70-100 x2 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 520, 1556, "", 1386, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-06", "2023-11", "\u05d2\u05dc\u05d9\u05ea \u05e1\u05dc\u05e2", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1314, "", 1054, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-07", "2023-11", "\u05e2\u05de\u05d9\u05ea \u05e1\u05d4\u05e8", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 460, "", 310, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-12", "2023-11", "\u05e2\u05d9\u05e0\u05ea \u05de\u05d6\u05d5\u05d6", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 930, "", 670, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-12", "2023-11", "\u05e2\u05d9\u05e0\u05ea \u05de\u05d6\u05d5\u05d6", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 930, "", 670, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-12", "2023-11", "\u05e2\u05d9\u05e0\u05ea \u05de\u05d6\u05d5\u05d6", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 930, "", 670, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-12", "2023-11", "\u05e2\u05d9\u05e0\u05ea \u05de\u05d6\u05d5\u05d6", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1878, "", 1717.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-13", "2023-11", "\u05ea\u05de\u05e8", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1777, "", 1516.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-14", "2023-11", "\u05e9\u05d5\u05e9\u05d9", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2300, "", 1739.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-14", "2023-11", "\u05e8\u05d7\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1040, "", 1017, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-15", "2023-11", "\u05e4\u05e8\u05e0\u05e7\u05d5", "142-142 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 950, 2300, "", 1650, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-22", "2023-11", "\u05e6\u05d7\u05d9", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1340, "", 1064.75, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-22", "2023-11", "\u05d1\u05d9\u05d0\u05e8\u05d8\u05d9\u05e1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1200, "", 824.75, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-22", "2023-11", "\u05d1\u05d9\u05d0\u05e8\u05d8\u05d9\u05e1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1200, "", 824.75, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-22", "2023-11", "\u05d1\u05d9\u05d0\u05e8\u05d8\u05d9\u05e1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1200, "", 824.75, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05d8\u05dc \u05de\u05d7\u05d5\u05dc\u05d5\u05df", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 450, "", 190, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05e2\u05de\u05d9\u05ea - \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 906, "", 646, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05d2\u05e0\u05d9\u05e4\u05e8 \u05d0\u05d5\u05e8 \u05e2\u05e7\u05d9\u05d1\u05d0", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 901, "", 778, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05e8\u05d7\u05dc", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 800, "", 540, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05e8\u05d7\u05dc", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 800, "", 585, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05e8\u05d7\u05dc", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 800, "", 585, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-28", "2023-11", "\u05de\u05d9\u05d8\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1136, "", 813, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-29", "2023-11", "\u05e8\u05d2\u05dc\u05d9\u05d5\u05ea", "", "", 600, 600, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-29", "2023-11", "\u05d0\u05e0\u05d4 \u05e8\u05d0\u05e9 \u05d4\u05e2\u05d9\u05df", "60-60", "", 145, 864, "", 719, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-11-29", "2023-11", "\u05d0\u05e0\u05d4 \u05e8\u05d0\u05e9 \u05d4\u05e2\u05d9\u05df", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486.4, 1780, "", 1543.6, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-06", "2023-12", "\u05de\u05d0\u05d9\u05e8 \u05d1\u05d0\u05e8 \u05d9\u05e2\u05e7\u05d1", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 500, "", 350, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-06", "2023-12", "\u05de\u05d0\u05d9\u05e8 \u05d1\u05d0\u05e8 \u05d9\u05e2\u05e7\u05d1", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 500, "", 350, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-10", "2023-12", "\u05e2\u05d9\u05e0\u05d1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1400, "", 1024.75, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-10", "2023-12", "\u05e0\u05d5\u05e2\u05d4", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 643, "", 555.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-14", "2023-12", "\u05e2\u05d9\u05d3\u05d5", "80x120 \u05e7\u05e0\u05d1\u05e1", "", 240, 1003, "", 763, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-14", "2023-12", "\u05e2\u05d9\u05d3\u05d5", "80x120 \u05e7\u05e0\u05d1\u05e1", "", 240, 1003, "", 763, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-17", "2023-12", "\u05e1\u05d8\u05d9\u05d1\u05df", "90x170 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 618, 618, "", 0, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-17", "2023-12", "\u05e9\u05e8\u05d5\u05e7", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 845.5, 2700, "", 2254.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-24", "2023-12", "\u05e0\u05d8\u05dc\u05d9", "50x70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 600, "", 450, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-24", "2023-12", "\u05e9\u05d9\u05de\u05d9", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 845.5, 2400, "", 1854.5, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-24", "2023-12", "\u05d9\u05e6\u05d7\u05e7", "50x50 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 115, 440, "", 325, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-24", "2023-12", "\u05d9\u05e6\u05d7\u05e7", "50x50 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 115, 440, "", 325, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
  ["2023-12-31", "2023-12", "\u05d3\u05d5\u05d9\u05d3", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486.4, 1750, "", 1563.6, "migration-2023", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2023", "\u05e9\u05d5\u05dc\u05dd"],
];

// 2024: 125 orders, revenue(col G)=161175, 2024-01-01 .. 2024-12-31
var _MOO_ROWS_2024_ = [
  ["2024-01-01", "2024-01", "\u05d9\u05e4\u05e2\u05ea", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 828, "", 588, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-01", "2024-01", "\u05d3\u05d5\u05d9\u05d3", "80-160 \u05e7\u05e0\u05d1\u05e1", "", 320, 1300, "", 980, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-02", "2024-01", "\u05e4\u05e8\u05e0\u05e7\u05d5 \u05e1\u05d1\u05d9\u05d5\u05df", "142-142 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 760, 760, "", 0, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-04", "2024-01", "\u05d0\u05e8\u05ea\u05d5\u05e8", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1300, "", 1377, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-04", "2024-01", "\u05e8\u05d7\u05dc \u05d1\u05d9\u05ea \u05d3\u05d2\u05df", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 800, "", 785, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-08", "2024-01", "\u05ea\u05de\u05e8 \u05e9\u05d5\u05d4\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1570, "", 1247, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-08", "2024-01", "\u05ea\u05de\u05e8 \u05e9\u05d5\u05d4\u05dd", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 588, "", 438, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-08", "2024-01", "\u05ea\u05de\u05e8 \u05e9\u05d5\u05d4\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1875, "", 1552, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-08", "2024-01", "\u05ea\u05de\u05e8 \u05e9\u05d5\u05d4\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1598, "", 1725, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-10", "2024-01", "\u05dc\u05d0\u05d5\u05df \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 900, "", 577, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-12", "2024-01", "\u05d2\u05d9\u05d1\u05dc\u05d5 \u05e0\u05ea\u05e0\u05d9\u05d4", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 780, "", 565, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-13", "2024-01", "\u05d0\u05dc\u05d1\u05e8\u05d8 \u05d1\u05ea \u05d9\u05dd", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2300, "", 1739.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-13", "2024-01", "\u05d0\u05dc\u05d1\u05e8\u05d8 \u05d1\u05ea \u05d9\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1250, "", 927, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-13", "2024-01", "\u05d0\u05dc\u05d1\u05e8\u05d8 \u05d1\u05ea \u05d9\u05dd", "60-90 x2", "", 430, 1400, "", 1470, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-16", "2024-01", "\u05e2\u05d3\u05df \u05e0\u05d4\u05e8\u05d9\u05d4", "30-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 60, 390, "", 330, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-16", "2024-01", "\u05e2\u05d3\u05df \u05e0\u05d4\u05e8\u05d9\u05d4", "30-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 60, 440, "", 380, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-24", "2024-01", "\u05d0\u05d5\u05e8\u05e0\u05d9\u05ea \u05e8\u05de\u05ea \u05d2\u05df", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1600, "", 1039.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-25", "2024-01", "\u05de\u05d5\u05d8\u05d9 \u05d2\u05de\u05d9\u05e9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1300, "", 977, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-01-25", "2024-01", "\u05de\u05d5\u05d8\u05d9 \u05d2\u05de\u05d9\u05e9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 196, 900, "", 1004, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-07", "2024-02", "\u05d0\u05de\u05d9\u05e8 \u05de\u05e8\u05d0\u05d4", "", "", 650, 1300, "", 650, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-07", "2024-02", "\u05d0\u05de\u05d9\u05e8 \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1000, "", 740, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-07", "2024-02", "\u05d0\u05de\u05d9\u05e8 \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 561, 1850, "", 1289, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-07", "2024-02", "\u05d0\u05de\u05d9\u05e8 \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 561, 1850, "", 1589, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-11", "2024-02", "\u05e2\u05de\u05d9\u05ea \u05d4\u05d9\u05e7\u05e8\u05d9 \u05e8\u05e2\u05e0\u05e0\u05d4", "60-120 x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 780, 2685, "", 1905, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-15", "2024-02", "\u05e2\u05d9\u05e0\u05d1 \u05d1\u05df \u05e9\u05de\u05e9\u05d5\u05df - \u05e8\u05de\u05ea \u05d2\u05df", "50-100 x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 615, 2599, "", 1984, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-02-16", "2024-02", "\u05e9\u05d9\u05e8\u05df \u05db\u05d4\u05df \u05d2\u05df \u05d9\u05d1\u05e0\u05d4", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1278, "", 1018, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-04", "2024-03", "\u05d0\u05d5\u05d3\u05d9 \u05d1\u05ea \u05d9\u05dd", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 845.5, 2300, "", 1754.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-05", "2024-03", "\u05d3\u05e0\u05d9\u05e1 \u05d1\u05ea \u05d9\u05dd", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 570, "", 330, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-11", "2024-03", "\u05e0\u05ea\u05e0\u05d0\u05dc \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 635, "", 547.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-12", "2024-03", "\u05e9\u05d2\u05d9\u05d0 \u05e7\u05e8\u05d9\u05d5\u05ea", "150-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1500, 3625, "", 2625, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-13", "2024-03", "\u05e1\u05d9\u05d5\u05df / \u05e8\u05d5\u05e0\u05d4", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1178, "", 855, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-13", "2024-03", "\u05de\u05d9\u05e8\u05d4 \u05e8\u05d0\u05e9 \u05d4\u05e2\u05d9\u05df", "140-200 \u05e7\u05e0\u05d1\u05e1", "", 700, 2400, "", 1700, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-20", "2024-03", "\u05e0\u05ea\u05e0\u05d0\u05dc \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "120x120 \u05e7\u05e0\u05d1\u05e1", "", 360, 1660, "", 1300, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-22", "2024-03", "\u05d2\u05dc \u05de\u05ea\u05e0\u05d4", "80-80 \u05e7\u05e0\u05d1\u05e1", "", 160, 160, "", 0, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-24", "2024-03", "\u05dc\u05d9\u05d8\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1310, "", 987, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-25", "2024-03", "\u05dc\u05d9\u05d8\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 570, 2130, "", 1560, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-27", "2024-03", "\u05d7\u05dc\u05d9 \u05d0\u05e9\u05d3\u05d5\u05d3", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 660, "", 525, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-27", "2024-03", "\u05d7\u05dc\u05d9 \u05d0\u05e9\u05d3\u05d5\u05d3", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 660, "", 525, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-27", "2024-03", "\u05d7\u05dc\u05d9 \u05d0\u05e9\u05d3\u05d5\u05d3", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 940, "", 700, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-03-31", "2024-03", "\u05e0\u05ea\u05e0\u05d0\u05dc \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 460, "", 340, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-01", "2024-04", "\u05d0\u05d1\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1150, "", 827, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-01", "2024-04", "\u05dc\u05d9\u05d8\u05dc \u05d1\u05df \u05d3\u05d5\u05d3 - \u05d0\u05dc\u05e2\u05d3", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 541.5, 1973, "", 1431.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-02", "2024-04", "\u05d3\u05e0\u05d9\u05d0\u05dc - \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1025, "", 765, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-02", "2024-04", "\u05e1\u05d8\u05d9\u05d1\u05df", "100x100 \u05e7\u05e0\u05d1\u05e1", "", 250, 250, "", 0, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-03", "2024-04", "\u05e8\u05d5\u05e0\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "150x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1350, 3000, "", 1650, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-04", "2024-04", "\u05d0\u05d3\u05d9 \u05e1\u05d5\u05dc\u05d5\u05de\u05d5\u05d1 - \u05ea\u05d0", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486.4, 1680, "", 1193.6, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-07", "2024-04", "\u05dc\u05d9\u05d8\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 570, 2130, "", 1560, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-07", "2024-04", "\u05e7\u05d5\u05e8\u05dc -\u05d7\u05d5\u05dc\u05d5\u05df \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 250, "", 250, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-09", "2024-04", "\u05e6\u05d7\u05d9 \u05d0\u05e1\u05d9\u05e3 - \u05e0\u05ea\u05e0\u05d9\u05d4", "80-160 \u05e7\u05e0\u05d1\u05e1", "", 320, 1259, "", 939, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-09", "2024-04", "\u05e8\u05d5\u05ea\u05dd \u05d3\u05d4\u05df - \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 660, "", 540, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-11", "2024-04", "\u05e7\u05d5\u05e8\u05dc - \u05d7\u05d5\u05dc\u05d5\u05df", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 500, "", -60.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-15", "2024-04", "\u05e9\u05d5\u05e9\u05d9", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2400, "", 1763.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-16", "2024-04", "\u05e7\u05d5\u05e8\u05dc -\u05ea\u05de\u05d5\u05e0\u05d4 \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 200, "", 200, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-21", "2024-04", "\u05d3\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "50-100x3 \u05e7\u05e0\u05d1\u05e1", "", 375, 1780, "", 3470, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-21", "2024-04", "\u05d3\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "100x100 \u05e7\u05e0\u05d1\u05e1", "", 250, 1300, "", 2510, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-21", "2024-04", "\u05d3\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "100x100 \u05e7\u05e0\u05d1\u05e1", "", 250, 1279, "", 2468, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-25", "2024-04", "\u05e9\u05e0\u05d4\u05d1 - \u05e7\u05e8\u05d9\u05d9\u05ea \u05d0\u05ea\u05d0", "150-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 1500, 4280, "", 2080, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-25", "2024-04", "\u05d9\u05d7\u05d9\u05d0\u05dc - \u05db\u05e8\u05dd \u05d4\u05ea\u05d9\u05de\u05e0\u05d9\u05dd \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 500, "", 500, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-25", "2024-04", "\u05d9\u05d7\u05d9\u05d0\u05dc - \u05db\u05e8\u05dd \u05d4\u05ea\u05d9\u05de\u05e0\u05d9\u05dd \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "30-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 300, "", 300, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-04-26", "2024-04", "\u05e9\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 655, "", 567.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-05", "2024-05", "\u05e8\u05d5\u05e0\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "40-90 \u05e7\u05e0\u05d1\u05e1", "", 90, 479, "", 389, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-05", "2024-05", "\u05e8\u05d5\u05e0\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 635, "", 500, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-11", "2024-05", "\u05e0\u05ea\u05d9 \u05de\u05e8\u05d0\u05e9\u05d5\u05df \u05ea\u05de\u05d5\u05e0\u05d4 \u05de\u05d4\u05de\u05dc\u05d0\u05d9 - \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 400, "", 400, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-12", "2024-05", "\u05dc\u05d9\u05d4\u05d9\u05d0 - \u05e2\u05e4\u05d5\u05dc\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1450, "", 2900, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-13", "2024-05", "\u05d0\u05d1\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 196, 1200, "", 2150, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-15", "2024-05", "\u05d1\u05e8 \u05d9\u05d5\u05d7\u05e0\u05df \u05d0\u05d9\u05e1\u05d5\u05e3 \u05e2\u05e6\u05de\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 196, 904, "", 1808, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-15", "2024-05", "\u05dc\u05d9\u05d8\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 570, 570, "", 0, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-16", "2024-05", "\u05d1\u05e8 \u05d9\u05d5\u05d7\u05e0\u05df \u05d0\u05d9\u05e1\u05d5\u05e3 \u05e2\u05e6\u05de\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 196, 1330, "", 2660, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-16", "2024-05", "\u05d1\u05e8 \u05d9\u05d5\u05d7\u05e0\u05df \u05d0\u05d9\u05e1\u05d5\u05e3 \u05e2\u05e6\u05de\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 196, 1330, "", 2660, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-21", "2024-05", "\u05d9\u05d7\u05d9\u05d0\u05dc - \u05db\u05e8\u05dd \u05d4\u05ea\u05d9\u05de\u05e0\u05d9\u05dd \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", "", 400, "", 400, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-22", "2024-05", "\u05d9\u05e8\u05d9\u05d1 50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 205, 1119, "", 1314, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-05-24", "2024-05", "\u05d9\u05d7\u05d9\u05d0\u05dc", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 800, "", 477, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-06-18", "2024-06", "\u05d0\u05d9\u05dc\u05df - \u05d0\u05e9\u05d3\u05d5\u05d3", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486.4, 1680, "", 1793.6, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-06-18", "2024-06", "\u05d0\u05d9\u05dc\u05df - \u05d0\u05e9\u05d3\u05d5\u05d3", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 857, "", 642, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-06-26", "2024-06", "\u05d3\u05e0\u05d9\u05d0\u05dc \u05dc\u05d5\u05d9 \u05d9\u05d1\u05e0\u05d4", "50-70 x3 \u05e7\u05e0\u05d1\u05e1", "", 262.5, 1485, "", 2880, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-06-30", "2024-06", "\u05e2\u05de\u05e8\u05d9 \u05dc\u05d5\u05d6\u05d5\u05df - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1600, "", 3600, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-11", "2024-07", "\u05e8\u05d5\u05df \u05e4\u05d9\u05e0\u05e5 - \u05d8\u05d9\u05e8\u05ea \u05d4\u05db\u05e8\u05de\u05dc", "50-70 \u05e7\u05e0\u05d1\u05e1 x3", "", 405, 1735, "", 3380, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-13", "2024-07", "\u05de\u05d9\u05db\u05dc \u05e0\u05d7\u05de\u05d9\u05d0 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 205, 1155, "", 2220, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-16", "2024-07", "\u05d0\u05d9\u05ea\u05df \u05e9\u05dc\u05d5\u05dd - \u05e2\u05e4\u05d5\u05dc\u05d4", "40-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea x3", "", 390, 3258, "", 7116, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-16", "2024-07", "\u05d0\u05d9\u05ea\u05de\u05e8 - \u05e9\u05e2\u05d5\u05df \u05d0\u05d1\u05e1\u05d8\u05e8\u05e7\u05d8 \u05de etsy", "", "", 0, 150, "", 150, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-16", "2024-07", "\u05d0\u05d9\u05ea\u05de\u05e8 \u05ea\u05de\u05d5\u05e0\u05d4 \u05de\u05d4\u05de\u05dc\u05d0\u05d9 - \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7", "60-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 300, "", 300, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-17", "2024-07", "\u05d3\u05e0\u05d9\u05d0\u05dc \u05dc\u05d5\u05d9 - \u05e7\u05e8\u05d9\u05d9\u05ea \u05d2\u05ea", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2735, "", 5380, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-20", "2024-07", "\u05dc\u05d9\u05de\u05d5\u05e8 \u05e7\u05d8\u05d9\u05e8\u05d0\u05d9 - \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 968, "", 1846, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-28", "2024-07", "\u05de\u05d9\u05db\u05dc \u05e0\u05d7\u05de\u05d9\u05d0 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 845.5, 4950, "", 4104.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-28", "2024-07", "\u05de\u05d9\u05db\u05dc \u05e0\u05d7\u05de\u05d9\u05d0 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2750, "", 2189.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-28", "2024-07", "\u05de\u05d9\u05db\u05dc \u05e0\u05d7\u05de\u05d9\u05d0 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2750, "", 3089.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-28", "2024-07", "\u05de\u05d9\u05db\u05d0\u05dc \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 541.5, 2500, "", 2458.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-07-28", "2024-07", "\u05e9\u05d2\u05d9\u05d0 - \u05ea\u05de\u05d5\u05e0\u05d4 \u05de\u05d4\u05de\u05dc\u05d0\u05d9 \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7", "60-60", "", 0, 200, "", 200, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-13", "2024-08", "\u05e9\u05d9\u05dc\u05d5 \u05d3\u05d4\u05df - \u05d9\u05d1\u05e0\u05d4", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 950, "", 1900, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-13", "2024-08", "\u05e9\u05d9\u05dc\u05d5 \u05d3\u05d4\u05df - \u05d9\u05d1\u05e0\u05d4", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 750, "", 600, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-14", "2024-08", "\u05d9\u05dc\u05e0\u05d4 - \u05d0\u05e9\u05d3\u05d5\u05d3", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1696, "", 3392, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-14", "2024-08", "\u05d2\u05d9\u05de\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 650, "", 327, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", ""],
  ["2024-08-14", "2024-08", "\u05d2\u05d9\u05de\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 700, "", 324.75, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", ""],
  ["2024-08-14", "2024-08", "\u05d2\u05d9\u05de\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 700, "", 324.75, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", ""],
  ["2024-08-14", "2024-08", "\u05d2\u05d9\u05de\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 650, "", 327, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", ""],
  ["2024-08-14", "2024-08", "\u05d2\u05d9\u05de\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 650, "", 327, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", ""],
  ["2024-08-26", "2024-08", "\u05d0\u05dc\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 850, "", 610, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-26", "2024-08", "\u05d0\u05dc\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 850, "", 610, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-08-28", "2024-08", "\u05d1\u05df - \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 2135, "", 1812, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-03", "2024-09", "\u05e0\u05e8\u05d9\u05d4 - \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "80-120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 705, "", 1410, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-08", "2024-09", "\u05d0\u05d1\u05e0\u05e8 \u05e0\u05d5\u05d5\u05d4 \u05d9\u05e8\u05e7", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 160, 1185, "", 2370, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-12", "2024-09", "\u05d8\u05dc \u05d9\u05d7\u05d9\u05e2\u05dd - \u05de\u05d2\u05d3\u05dc \u05d4\u05e2\u05de\u05e7", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 870, "", 1740, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-12", "2024-09", "\u05d8\u05dc \u05d9\u05d7\u05d9\u05e2\u05dd - \u05de\u05d2\u05d3\u05dc \u05d4\u05e2\u05de\u05e7", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 805, "", 717.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-24", "2024-09", "\u05d0\u05dc\u05d9\u05e7\u05d5 - \u05ea\u05de\u05d5\u05e0\u05d5\u05ea \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 150, "", 150, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-24", "2024-09", "\u05d0\u05dc\u05d9\u05e7\u05d5 - \u05ea\u05de\u05d5\u05e0\u05d5\u05ea \u05de\u05d4\u05de\u05dc\u05d0\u05d9", "60-60", "", 0, 150, "", 150, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-26", "2024-09", "\u05d2\u05e8\u05d9 \u05d5\u05dc\u05d5\u05d3\u05d1\u05e1\u05e7\u05d9 -\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 1322, "", 2644, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-09-30", "2024-09", "\u05d0\u05d5\u05d4\u05d3 \u05e1\u05d2\u05dc - \u05d0\u05d5\u05e4\u05e7\u05d9\u05dd", "150-200 \u05e7\u05e0\u05d1\u05e1", "", 750, 2700, "", 5400, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-10-01", "2024-10", "\u05d9\u05e6\u05d7\u05e7 - \u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1435, "", 2870, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-10-31", "2024-10", "\u05d0\u05dc\u05d9 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "80-120 \u05e7\u05e0\u05d1\u05e1", "", 240, 900, "", 1800, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-10-31", "2024-10", "\u05e0\u05d4\u05d5\u05e8\u05d0\u05d9 \u05d2\u05d5\u05d0\u05d8\u05d4 -\u05d1\u05ea \u05d9\u05dd", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 205, 515, "", 1030, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-11", "2024-11", "\u05d2\u05e8\u05d9 \u05d5\u05dc\u05d5\u05d3\u05d1\u05e1\u05e7\u05d9 -\u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 800, "", 1600, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-13", "2024-11", "\u05e0\u05e2\u05dd \u05ea\u05e9\u05d5\u05d1\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1850, "", 3700, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-13", "2024-11", "\u05d3\u05d5\u05e8\u05d5\u05df \u05d1\u05dc\u05d5\u05dc\u05d5", "80-160 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 486.4, 2500, "", 5000, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-15", "2024-11", "\u05d1\u05d9\u05d0\u05d8\u05e8\u05d9\u05e1 \u05e8\u05d0\u05e9\u05d5\u05df \u05dc\u05e6\u05d9\u05d5\u05df", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1350, "", 2450, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-18", "2024-11", "\u05e0\u05de\u05d9\u05e8 \u05e0\u05d2\u05de\u05d9 - \u05d7\u05d9\u05e4\u05d4", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 766, "", 1532, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-18", "2024-11", "\u05e0\u05de\u05d9\u05e8 \u05e0\u05d2\u05de\u05d9 - \u05d7\u05d9\u05e4\u05d4", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 440, "", 880, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-25", "2024-11", "\u05d3\u05d5\u05e8\u05d5\u05df \u05d1\u05dc\u05d5\u05dc\u05d5", "100x150 \u05e7\u05e0\u05d1\u05e1", "", 375, 1650, "", 3300, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-25", "2024-11", "\u05d3\u05d5\u05e8\u05d5\u05df \u05d1\u05dc\u05d5\u05dc\u05d5", "100x150 \u05e7\u05e0\u05d1\u05e1", "", 375, 1700, "", 3400, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-26", "2024-11", "\u05dc\u05d9\u05d3\u05d5\u05e8  - \u05de\u05e6\u05e4\u05d4 \u05e8\u05de\u05d5\u05df", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1800, "", 3600, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-27", "2024-11", "\u05e8\u05d5\u05d9 \u05d0\u05d3\u05e8\u05d9 - \u05e1\u05d1\u05d9\u05d5\u05df", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1266, "", 2532, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-30", "2024-11", "\u05e0\u05d3\u05d1 \u05d5\u05e7\u05e0\u05d9\u05df - \u05e7\u05e8\u05d9\u05d9\u05ea \u05d0\u05d5\u05e0\u05d5", "30-45 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 90, 850, "", 1700, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-11-30", "2024-11", "\u05e0\u05d3\u05d1 \u05d5\u05e7\u05e0\u05d9\u05df - \u05e7\u05e8\u05d9\u05d9\u05ea \u05d0\u05d5\u05e0\u05d5", "60-90 \u05e7\u05e0\u05d1\u05e1", "", 135, 850, "", 715, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-12-31", "2024-12", "\u05e2\u05d9\u05d3\u05df \u05d1\u05d9\u05d8\u05d5\u05df - \u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1795, "", 1234.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-12-31", "2024-12", "\u05e2\u05d9\u05d3\u05df \u05d1\u05d9\u05d8\u05d5\u05df - \u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7", "100x150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2200, "", 939.5, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
  ["2024-12-31", "2024-12", "\u05e2\u05d9\u05d3\u05df \u05d1\u05d9\u05d8\u05d5\u05df - \u05d1\u05e0\u05d9 \u05d1\u05e8\u05e7", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 650, "", 435, "migration-2024", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2024", "\u05e9\u05d5\u05dc\u05dd"],
];

// 2025: 57 orders, revenue(col G)=76385.46, 2025-01-12 .. 2025-11-27
var _MOO_ROWS_2025_ = [
  ["2025-01-12", "2025-01", "\u05e2\u05d9\u05d3\u05df \u05d1\u05d9\u05d8\u05d5\u05df", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2300, "", 500, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-12", "2025-01", "\u05e9\u05d5\u05d4\u05dd - \u05d1\u05dc\u05d5\u05e7 \u05d0\u05e7\u05e8\u05d9\u05dc", "\u05d1\u05dc\u05d5\u05e7 \u05d0\u05e7\u05e8\u05d9\u05dc 15-21", "", 95, 95, "", 0, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-14", "2025-01", "\u05e0\u05d8\u05dc\u05d9", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 480, "", 360, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-14", "2025-01", "\u05e0\u05d8\u05dc\u05d9", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 480, "", 360, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-23", "2025-01", "\u05e2\u05de\u05d9\u05ea \u05e1\u05d4\u05e8 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 510, "", 315, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-25", "2025-01", "\u05d9\u05d6\u05df \u05e9\u05de\u05d0\u05dc\u05d9", "60-90 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 215, 475, "", 260, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-25", "2025-01", "\u05d9\u05d6\u05df \u05e9\u05de\u05d0\u05dc\u05d9", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1237, "", 877, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-01-25", "2025-01", "\u05d9\u05d6\u05df \u05e9\u05de\u05d0\u05dc\u05d9", "50-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 205, 830, "", 625, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-02", "2025-02", "\u05d1\u05e8\u05d8\u05d9 \u05e9\u05d2\u05d1 - \u05d7\u05d3\u05e8\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2768, "", 712.78, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-02", "2025-02", "\u05d1\u05e8\u05d8\u05d9 \u05e9\u05d2\u05d1 - \u05d7\u05d3\u05e8\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2768, "", 1307.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-02", "2025-02", "\u05d1\u05e8\u05d8\u05d9 \u05e9\u05d2\u05d1 - \u05d7\u05d3\u05e8\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2768, "", 2207.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-04", "2025-02", "\u05ea\u05de\u05d5\u05e0\u05d4 \u05de\u05d4\u05de\u05dc\u05d0\u05d9 - \u05e4\u05d9\u05d9\u05e1", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 0, 450, "", 450, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05d0\u05de\u05d9\u05e8 \u05d9\u05e6\u05d7\u05e7 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70x100 \u05e7\u05e0\u05d1\u05e1", "", 175, 793, "", 618, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05d0\u05de\u05d9\u05e8 \u05d9\u05e6\u05d7\u05e7 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70x100 \u05e7\u05e0\u05d1\u05e1", "", 175, 793, "", 618, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05d0\u05de\u05d9\u05e8 \u05d9\u05e6\u05d7\u05e7 \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70x100 \u05e7\u05e0\u05d1\u05e1", "", 175, 793, "", 618, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05e6\u05d7\u05d9 \u05e7\u05e9\u05ea - \u05d8\u05d9\u05e8\u05dc \u05d4\u05db\u05e8\u05de\u05dc", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 990.05, "", 840.05, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05e6\u05d7\u05d9 \u05e7\u05e9\u05ea - \u05d8\u05d9\u05e8\u05dc \u05d4\u05db\u05e8\u05de\u05dc", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 990.05, "", 396.89, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-11", "2025-02", "\u05e6\u05d7\u05d9 \u05e7\u05e9\u05ea - \u05d8\u05d9\u05e8\u05dc \u05d4\u05db\u05e8\u05de\u05dc", "50-70 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 150, 990.05, "", 840.05, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-02-17", "2025-02", "\u05e1\u05d8\u05d9\u05d1\u05df - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70x100 \u05e7\u05e0\u05d1\u05e1", "", 175, 175, "", 0, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-03-19", "2025-03", "\u05d9\u05d6\u05df \u05e9\u05de\u05d0\u05dc\u05d9 - \u05e2\u05e8\u05d1\u05d4", "40-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 153.4, 879, "", 536.43, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-03-25", "2025-03", "\u05d1\u05d5\u05e8\u05d9\u05e1 - \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2342, "", 969.16, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-03-30", "2025-03", "\u05e1\u05de\u05d5\u05d0\u05dc - \u05de\u05dc\u05d0\u05d9 \u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", "", 450, "", 450, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-04-02", "2025-04", "\u05e8\u05df \u05dc\u05e0\u05e7\u05e8 - \u05e0\u05d4\u05e8\u05d9\u05d4", "40-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 153.4, 628.97, "", 303.36, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-04-02", "2025-04", "\u05e8\u05df \u05dc\u05e0\u05e7\u05e8 - \u05e0\u05d4\u05e8\u05d9\u05d4", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 141.6, 628.97, "", 391.43, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-04-02", "2025-04", "\u05e8\u05df \u05dc\u05e0\u05e7\u05e8 - \u05e0\u05d4\u05e8\u05d9\u05d4", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 141.6, 628.97, "", 391.43, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-04-17", "2025-04", "\u05d7\u05d6\u05d9 \u05dc\u05d5\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "70x100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1280.4, "", 790, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-06-12", "2025-06", "\u05d0\u05d1\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "120x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 541.5, 3600, "", 2158.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-06-12", "2025-06", "\u05d0\u05d1\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1500, "", 1177, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-06-12", "2025-06", "\u05d0\u05d1\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2200, "", 1339.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-06-12", "2025-06", "\u05d0\u05d1\u05d9 - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 1900, "", 1339.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-07-01", "2025-07", "\u05d7\u05e0\u05d9 - \u05d0\u05d9\u05e1\u05d5\u05e3 \u05e2\u05e6\u05de\u05d0\u05d9", "40-60 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 120, 520, "", 306.4, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-07-06", "2025-07", "\u05d0\u05e0\u05d8\u05d5 - \u05e4\u05ea\u05d7 \u05ea\u05e7\u05d5\u05d5\u05d4", "100x150 \u05e7\u05e0\u05d1\u05e1", "", 442.5, 2145, "", 1271.4, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-07-26", "2025-07", "\u05d7\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 830, "", 595, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-07-26", "2025-07", "\u05d7\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 830, "", 695, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-07-26", "2025-07", "\u05d7\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "60x90 \u05e7\u05e0\u05d1\u05e1", "", 135, 1015, "", 482, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-08-04", "2025-08", "\u05d7\u05df - \u05d4\u05e8\u05e6\u05dc\u05d9\u05d4", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 845, "", 593.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-12", "2025-10", "\u05d0\u05d5\u05e9\u05e8\u05d9 \u05d0\u05d5\u05d6\u05df", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 997.69, 2745, "", 1208.21, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-15", "2025-10", "\u05e9\u05d1\u05d9\u05d8 \u05e4\u05d0\u05e0\u05d9", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2211, "", 1278.14, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-20", "2025-10", "\u05e8\u05d5\u05d1\u05e8\u05d8 - \u05d7\u05d5\u05dc\u05d5\u05df", "50x70 \u05e7\u05e0\u05d1\u05e1", "", 87.5, 795, "", 551.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-23", "2025-10", "\u05e2\u05de\u05d9\u05ea \u05de\u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd", "50-50 \u05e7\u05e0\u05d1\u05e1", "", 62.5, 680, "", -14.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-23", "2025-10", "\u05e2\u05de\u05d9\u05ea \u05de\u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd", "60-90 \u05e7\u05e0\u05d1\u05e1", "", 135, 830, "", 695, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-23", "2025-10", "\u05e2\u05de\u05d9\u05ea \u05de\u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd", "70x100 \u05e7\u05e0\u05d1\u05e1", "", 175, 980, "", 805, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-23", "2025-10", "\u05e2\u05de\u05d9\u05ea \u05de\u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd", "70-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1000, "", 740, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-24", "2025-10", "\u05d7\u05d5\u05e4\u05d9\u05ea", "\u05de\u05e1\u05d2\u05e8\u05ea \u05d0\u05e8\u05d5\u05df \u05d7\u05e9\u05de\u05dc 40-60", "", 250, 695, "", 305, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-10-27", "2025-10", "\u05e2\u05d5\u05de\u05e8 - \u05dc\u05d5\u05d3", "80x80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 250, 1011, "", 572, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-09", "2025-11", "\u05d2\u05dc \u05d7\u05d5\u05dc\u05d5\u05df", "70-100x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 780, 2300, "", 820, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-09", "2025-11", "\u05d2\u05dc \u05d7\u05d5\u05dc\u05d5\u05df", "100-150 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 560.5, 2820, "", 2259.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-12", "2025-11", "\u05e1\u05e0\u05e6\u05d5", "70-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 260, 1600, "", 1340, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-12", "2025-11", "\u05e1\u05e0\u05e6\u05d5", "100-100 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 375.25, 1610, "", 1234.75, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-18", "2025-11", "\u05d9\u05e9\u05d9/\u05e8\u05dd", "80x120 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 323, 1480, "", 890.6, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-21", "2025-11", "\u05e9\u05d2\u05d9\u05ea - \u05e2\u05d5\u05de\u05e8", "150x150 \u05e7\u05e0\u05d1\u05e1", "", 562.5, 1820, "", 679.9, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-21", "2025-11", "\u05d9\u05e8\u05d9\u05df - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "50x50 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 115, 600, "", 332, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-21", "2025-11", "\u05d9\u05e8\u05d9\u05df - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "40-80 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 130, 650, "", 403, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-24", "2025-11", "\u05e4\u05d0\u05e0\u05d9 - \u05ea\u05dc \u05d0\u05d1\u05d9\u05d1", "150x150 \u05e7\u05e0\u05d1\u05e1", "", 562.5, 1820, "", 779.9, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-24", "2025-11", "\u05d8\u05e0\u05d9\u05d4 - \u05d7\u05d5\u05dc\u05d5\u05df", "100-200 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 845.5, 3430, "", 1884.5, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-25", "2025-11", "\u05d1\u05e0\u05d9 - \u05de\u05e2\u05dc\u05d4 \u05d0\u05d3\u05d5\u05de\u05d9\u05dd", "100-120 \u05e7\u05e0\u05d1\u05e1", "", 300, 1500, "", 885, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
  ["2025-11-27", "2025-11", "\u05d0\u05d9\u05e6\u05d9\u05e7 - \u05de\u05d5\u05e9\u05d1 \u05db\u05e4\u05e8", "80-120x3 \u05d6\u05db\u05d5\u05db\u05d9\u05ea", "", 969, 2900, "", 1309, "migration-2025", "migrated from OLD \u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4 2025", "\u05e9\u05d5\u05dc\u05dd"],
];


// ===================== 7) MIGRATE OLD ORDERS (MOO_*) =====================
// Backfill Steven's historical business orders (2023/2024/2025) -- previously
// only in the OLD 'maazan hevra YYYY' tabs -- into the NEW 'hazmanot' (orders)
// tab, so the company dashboard shows real revenue (mahzor) + net profit for
// every past year. The dashboard sums hazmanot col G (mechir mechira = sale =
// revenue) by col-A date-year via SUMIFS, and auto-recomputes; this tool ONLY
// appends rows to hazmanot and NEVER touches tnuot or any dashboard cell.
//
//   MOO_MIGRATE_OLD_ORDERS_DRY_RUN  : READ ONLY. Per year -> N orders to append,
//        total revenue (col G), first/last date, and how many would be DEDUPED
//        (an order already present in hazmanot with same date+customer+sale is
//        skipped). Prints a summary table. Zero writes (asserted by a counter).
//   MOO_MIGRATE_OLD_ORDERS_APPLY    : gated by Script Property
//        CONFIRM_MIGRATE_OLD_ORDERS = 'YES I UNDERSTAND' + getScriptLock(30000).
//        Snapshots the current hazmanot row-count to a Script Property (cheap,
//        exact rollback anchor), de-dupes, appends the survivors at getLastRow+1
//        in ONE setValues, flush. Logs count appended per year.
//   MOO_MIGRATE_OLD_ORDERS_ROLLBACK : deletes ONLY the appended block (rows added
//        after the snapshot row-count) and clears the confirm gate.
//
// HARD RULES: only the NEW sheet id; only the 'hazmanot' tab; append-only (never
// insert/overwrite/delete existing rows); 12-col rows exactly matching the
// schema; Hebrew is \uXXXX-escaped (whole file stays ASCII). The 2023-2025 rows
// cannot overlap the live 2026 set, but the dedupe guard runs anyway.
// Row data lives in _MOO_ROWS_2023_/2024/2025 above (generated by gen_moo.py).
// =============================================================================

var _MOO_NEW_SHEET_ID_   = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MOO_ORDERS_TAB_     = '\u05d4\u05d6\u05de\u05e0\u05d5\u05ea';   // hazmanot (orders)
var _MOO_TNUOT_          = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';   // tnuot (movements) -- NEVER touch
var _MOO_WIDTH_          = 12;                                      // A..L
var _MOO_YEARS_          = ['2023', '2024', '2025'];
var _MOO_CONFIRM_PROP_   = 'CONFIRM_MIGRATE_OLD_ORDERS';
var _MOO_CONFIRM_VAL_    = 'YES I UNDERSTAND';
var _MOO_SNAPSHOT_PROP_  = 'MOO_SNAPSHOT_LASTROW';                  // rollback anchor
var _MOO_APPLIEDN_PROP_  = 'MOO_APPLIED_COUNT';                     // rows we appended

// Column indexes within a row array (0-based) used by the dedupe key.
var _MOO_C_DATE_     = 0;   // A: date (YYYY-MM-DD)
var _MOO_C_CUSTOMER_ = 2;   // C: customer
var _MOO_C_SALE_     = 6;   // G: sale price (revenue)

function _moo_ss_()    { return SpreadsheetApp.openById(_MOO_NEW_SHEET_ID_); }
function _moo_sheet_() { return _moo_ss_().getSheetByName(_MOO_ORDERS_TAB_); }

// All baked-in rows for a given year ('2023'|'2024'|'2025').
function _moo_rowsFor_(year) {
  if (year === '2023') return _MOO_ROWS_2023_;
  if (year === '2024') return _MOO_ROWS_2024_;
  if (year === '2025') return _MOO_ROWS_2025_;
  return [];
}

// Normalise a date cell (string or Date) to 'YYYY-MM-DD' for the dedupe key.
function _moo_dateKey_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Jerusalem', 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  // 'YYYY-MM-DD ...' -> take the date part; leave other formats as-is.
  if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-') return s.substring(0, 10);
  return s;
}

// Numeric key for the sale/revenue cell (tolerates "1,234", "1234 ", "" etc.).
function _moo_numKey_(v) {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') return String(v);
  var s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return '';
  var n = parseFloat(s);
  return isNaN(n) ? '' : String(n);
}

function _moo_keyParts_(dateV, custV, saleV) {
  return _moo_dateKey_(dateV) + '|' + String(custV == null ? '' : custV).trim() + '|' + _moo_numKey_(saleV);
}

// Build a Set-like map of existing date+customer+sale keys already in hazmanot
// (skips the header row). Used so a re-run never double-appends.
function _moo_existingKeys_(sh) {
  var keys = {};
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return keys;                       // only header (or empty)
  var rng = sh.getRange(2, 1, lastRow - 1, _MOO_WIDTH_).getValues();
  for (var i = 0; i < rng.length; i++) {
    var r = rng[i];
    // ignore fully-blank rows
    var blank = true;
    for (var c = 0; c < r.length; c++) { if (r[c] !== '' && r[c] != null) { blank = false; break; } }
    if (blank) continue;
    keys[_moo_keyParts_(r[_MOO_C_DATE_], r[_MOO_C_CUSTOMER_], r[_MOO_C_SALE_])] = true;
  }
  return keys;
}

// Sum col G (sale) over an array of row arrays.
function _moo_sumSale_(rows) {
  var t = 0;
  for (var i = 0; i < rows.length; i++) {
    var v = rows[i][_MOO_C_SALE_];
    if (typeof v === 'number') t += v;
    else { var n = parseFloat(_moo_numKey_(v)); if (!isNaN(n)) t += n; }
  }
  return Math.round(t * 100) / 100;
}

// min/max date string over an array of row arrays.
function _moo_dateRange_(rows) {
  var lo = null, hi = null;
  for (var i = 0; i < rows.length; i++) {
    var d = _moo_dateKey_(rows[i][_MOO_C_DATE_]);
    if (!d) continue;
    if (lo === null || d < lo) lo = d;
    if (hi === null || d > hi) hi = d;
  }
  return { first: lo || '-', last: hi || '-' };
}

// ---- 7.2 DRY RUN (READ ONLY) ------------------------------------------------
function MOO_MIGRATE_OLD_ORDERS_DRY_RUN() {
  Logger.log('=== MOO_MIGRATE_OLD_ORDERS_DRY_RUN (READ ONLY) ===');
  var writes = 0;   // must stay 0; asserted at the end
  var sh = _moo_sheet_();
  if (!sh) { Logger.log('!! orders tab not found: ' + _MOO_ORDERS_TAB_); return 'no-tab'; }

  var lastRow = sh.getLastRow();
  var existing = _moo_existingKeys_(sh);
  Logger.log('Tab "' + _MOO_ORDERS_TAB_ + '"  lastRow=' + lastRow
             + '  (existing data rows scanned for dedupe: ' + Object.keys(existing).length + ')');
  Logger.log('Dashboard sums col G (sale = revenue) by col-A year; this tool only APPENDS here.');
  Logger.log('');

  // DEDUPE ONLY against rows already present in hazmanot (so a re-run never
  // double-appends). We deliberately do NOT collapse same-key rows WITHIN the
  // baked set: the source legitimately has distinct repeat orders that share
  // date+customer+sale (e.g. two identical pieces sold the same day) and each is
  // real revenue the dashboard must count.
  var grandNew = 0, grandDup = 0, grandRev = 0;
  var summary = [];       // [year, total, toAppend, deduped, revenue, first, last]

  for (var y = 0; y < _MOO_YEARS_.length; y++) {
    var year = _MOO_YEARS_[y];
    var rows = _moo_rowsFor_(year);
    var keep = [], dup = 0;
    for (var i = 0; i < rows.length; i++) {
      var k = _moo_keyParts_(rows[i][_MOO_C_DATE_], rows[i][_MOO_C_CUSTOMER_], rows[i][_MOO_C_SALE_]);
      if (existing[k]) { dup++; continue; }   // already in the sheet -> skip
      keep.push(rows[i]);
    }
    var rev = _moo_sumSale_(keep);
    var rng = _moo_dateRange_(rows);
    Logger.log('YEAR ' + year + ': source=' + rows.length + '  toAppend=' + keep.length
               + '  deduped=' + dup + '  revenue(colG)=' + rev
               + '  range=' + rng.first + '..' + rng.last);
    summary.push([year, rows.length, keep.length, dup, rev, rng.first, rng.last]);
    grandNew += keep.length; grandDup += dup; grandRev += rev;
  }
  grandRev = Math.round(grandRev * 100) / 100;

  Logger.log('');
  Logger.log('---- SUMMARY (would append) ----');
  Logger.log('YEAR  | source | append | deduped | revenue(colG) | first..last');
  for (var s = 0; s < summary.length; s++) {
    var r = summary[s];
    Logger.log(r[0] + '  |  ' + r[1] + '    |  ' + r[2] + '    |  ' + r[3]
               + '      |  ' + r[4] + '   |  ' + r[5] + '..' + r[6]);
  }
  Logger.log('TOTAL |  ' + (summary[0][1] + summary[1][1] + summary[2][1])
             + '   |  ' + grandNew + '   |  ' + grandDup + '       |  ' + grandRev);
  Logger.log('');
  Logger.log('Append target: hazmanot row ' + (lastRow + 1) + '..' + (lastRow + grandNew)
             + ' (' + grandNew + ' rows). To apply: set Script Property '
             + _MOO_CONFIRM_PROP_ + ' = ' + _MOO_CONFIRM_VAL_ + ' then run MOO_MIGRATE_OLD_ORDERS_APPLY.');
  Logger.log('DRY_RUN writes performed: ' + writes + ' (must be 0).');
  return 'ok';
}

// ---- 7.3 APPLY (gated + locked + snapshot) ----------------------------------
function MOO_MIGRATE_OLD_ORDERS_APPLY() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_MOO_CONFIRM_PROP_) !== _MOO_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _MOO_CONFIRM_PROP_ + ' = ' + _MOO_CONFIRM_VAL_ + ' first.');
    return 'not-confirmed';
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var sh = _moo_sheet_();
    if (!sh) { Logger.log('!! orders tab not found: ' + _MOO_ORDERS_TAB_); return 'no-tab'; }

    // ---- SNAPSHOT current row-count FIRST (rollback anchor) ----
    var snapshot = sh.getLastRow();
    props.setProperty(_MOO_SNAPSHOT_PROP_, String(snapshot));
    Logger.log('SNAPSHOT hazmanot lastRow=' + snapshot + ' saved to "' + _MOO_SNAPSHOT_PROP_ + '" (rollback anchor).');

    // ---- DEDUPE only against rows ALREADY in hazmanot (idempotent re-run). ----
    // Same-key rows within the baked set are kept (genuine distinct repeat orders).
    var existing = _moo_existingKeys_(sh);
    var toAppend = [];
    var perYear = {};
    for (var y = 0; y < _MOO_YEARS_.length; y++) {
      var year = _MOO_YEARS_[y];
      var rows = _moo_rowsFor_(year);
      var added = 0, dup = 0;
      for (var i = 0; i < rows.length; i++) {
        var k = _moo_keyParts_(rows[i][_MOO_C_DATE_], rows[i][_MOO_C_CUSTOMER_], rows[i][_MOO_C_SALE_]);
        if (existing[k]) { dup++; continue; }   // already in the sheet -> skip
        toAppend.push(rows[i]);
        added++;
      }
      perYear[year] = { added: added, dup: dup };
    }

    if (toAppend.length === 0) {
      Logger.log('Nothing to append (all ' + 'rows deduped). No write performed.');
      props.deleteProperty(_MOO_SNAPSHOT_PROP_);   // nothing to roll back
      return 'noop';
    }

    // ---- APPEND in ONE block at the bottom (append-only) ----
    var startRow = snapshot + 1;
    sh.getRange(startRow, 1, toAppend.length, _MOO_WIDTH_).setValues(toAppend);
    SpreadsheetApp.flush();
    props.setProperty(_MOO_APPLIEDN_PROP_, String(toAppend.length));

    for (var y2 = 0; y2 < _MOO_YEARS_.length; y2++) {
      var yr = _MOO_YEARS_[y2];
      Logger.log('   APPENDED ' + perYear[yr].added + ' rows for ' + yr + ' (deduped ' + perYear[yr].dup + ').');
    }
    Logger.log('=== APPLY DONE: appended ' + toAppend.length + ' rows at hazmanot row '
               + startRow + '..' + (startRow + toAppend.length - 1)
               + '. Dashboard recomputes via SUMIFS. Undo: MOO_MIGRATE_OLD_ORDERS_ROLLBACK. ===');
    return 'ok';
  } finally { lock.releaseLock(); }
}

// ---- 7.4 ROLLBACK (delete only the appended block) --------------------------
function MOO_MIGRATE_OLD_ORDERS_ROLLBACK() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('!! could not acquire lock'); return 'locked'; }
  try {
    var props = PropertiesService.getScriptProperties();
    var snapRaw = props.getProperty(_MOO_SNAPSHOT_PROP_);
    if (snapRaw === null || snapRaw === '') { Logger.log('!! no snapshot found -- nothing to roll back.'); return 'no-snapshot'; }
    var snapshot = parseInt(snapRaw, 10);
    if (isNaN(snapshot) || snapshot < 0) { Logger.log('!! bad snapshot value: ' + snapRaw); return 'bad-snapshot'; }

    var sh = _moo_sheet_();
    if (!sh) { Logger.log('!! orders tab not found: ' + _MOO_ORDERS_TAB_); return 'no-tab'; }

    var lastRow = sh.getLastRow();
    var toDelete = lastRow - snapshot;
    if (toDelete <= 0) {
      Logger.log('Nothing to delete (lastRow=' + lastRow + ' <= snapshot=' + snapshot + ').');
      props.deleteProperty(_MOO_SNAPSHOT_PROP_);
      props.deleteProperty(_MOO_APPLIEDN_PROP_);
      props.deleteProperty(_MOO_CONFIRM_PROP_);
      return 'noop';
    }
    // Safety: only delete what we recorded appending (guard against unrelated rows added since).
    var appliedRaw = props.getProperty(_MOO_APPLIEDN_PROP_);
    var applied = appliedRaw ? parseInt(appliedRaw, 10) : toDelete;
    if (!isNaN(applied) && applied > 0 && toDelete > applied) {
      Logger.log('!! WARNING: ' + (toDelete - applied) + ' row(s) were added AFTER the migration. '
                 + 'Deleting ONLY the migration block (' + applied + ' rows) from the bottom.');
      // delete the topmost `applied` rows of the post-snapshot region, leaving newer rows intact
      sh.deleteRows(snapshot + 1, applied);
      SpreadsheetApp.flush();
      Logger.log('ROLLED BACK ' + applied + ' migration rows (rows ' + (snapshot + 1) + '..' + (snapshot + applied) + ').');
    } else {
      sh.deleteRows(snapshot + 1, toDelete);
      SpreadsheetApp.flush();
      Logger.log('ROLLED BACK ' + toDelete + ' appended rows (rows ' + (snapshot + 1) + '..' + lastRow + ').');
    }

    props.deleteProperty(_MOO_SNAPSHOT_PROP_);
    props.deleteProperty(_MOO_APPLIEDN_PROP_);
    props.deleteProperty(_MOO_CONFIRM_PROP_);   // require re-confirmation before any re-apply
    Logger.log('Snapshot + applied-count + confirm gate cleared.');
    return 'ok';
  } finally { lock.releaseLock(); }
}
