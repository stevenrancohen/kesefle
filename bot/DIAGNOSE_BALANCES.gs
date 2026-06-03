// DIAGNOSE_BALANCES.gs  --  READ-ONLY diagnostic for maazan ishi + maazan hevra
// =============================================================================
// WHY THIS EXISTS
//   Steven 2026-05-31 reported (1) "hachnasa 2 - esek" shows no data (should be
//   the business net profit), and (2) many errors in maazan ishi -- e.g. the
//   total-expenses row sums ONLY the fixed-expenses section instead of every
//   expense section. The repo template (lib/sheet-writer.js) is correct, so the
//   LIVE sheet has drifted. The browser DOM shows cell VALUES, not FORMULAS --
//   only Apps Script getFormulas() can reveal the actual broken formula. This
//   tool dumps the exact label + formula + value of every row so the fix can be
//   built precisely.
//
// HARD RULE: THIS FILE NEVER WRITES.
//   Only openById / getSheetByName / getSheets / getRange / getFormulas /
//   getDisplayValues / getName / getLastRow / getLastColumn are used. There is
//   NO setValue / setFormula / setNote / insertSheet / deleteRow anywhere.
//   It is safe to run as many times as you like -- it cannot change your data.
//
// USAGE (Apps Script editor):
//   1. Function dropdown -> DB_SELF_TEST_HEBREW -> Run  (verify Hebrew renders)
//   2. Function dropdown -> DB_RUN_ALL -> Run
//   3. View -> Logs (or Executions) -> copy the whole log and send it to Claude.
//
// All Hebrew is \uXXXX-escaped (sheet-hebrew-encoding-safe-script rule) so
// clipboard / browser bidi cannot corrupt a tab name before it reaches the
// editor. Comments are ASCII-only.
// =============================================================================

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
