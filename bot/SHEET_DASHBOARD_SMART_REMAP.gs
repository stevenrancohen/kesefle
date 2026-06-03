/**
 * bot/SHEET_DASHBOARD_SMART_REMAP.gs
 *
 * Smart category re-mapping for Steven's NEW company dashboard
 * ("ma'azan chevra") -- rows 8-11 (material / marketing / shipping /
 * operational).
 *
 * THE PROBLEM (diagnosed earlier session):
 *   Steven's NEW 2026 block shows revenue row 6 = 40,226 (FIXED),
 *   orders row 7 = 28 (working), but expense rows 8-11 all read 0.
 *   The dashboard SUMIFS formulas filter the transactions col E for the
 *   EXACT literal strings (sivuq, chomrei gelem, ariza u'mishloach,
 *   tochnot), but Steven's actual col E values are mostly personal-
 *   category items (limim, applications, shonot, apolo, bayit, ...).
 *   His business expenses ARE in there -- they just don't match the
 *   literal category labels the dashboard expects.
 *
 * THE FIX (no data migration required):
 *   Replace the four exact-match SUMIFS with category-aware SUMPRODUCT +
 *   REGEXMATCH formulas. Each formula evaluates every transactions row of
 *   col E against a regex of Hebrew synonyms for that category and sums
 *   col C for matches in the current month + year + business ("esek").
 *
 *   Pattern (per monthly col):
 *     =IFERROR(SUMPRODUCT(
 *        ('Transactions'!B2:B10000=$B$4&"-MM") *
 *        ('Transactions'!D2:D10000="esek") *
 *        IFERROR(REGEXMATCH('Transactions'!E2:E10000, "regex|of|synonyms"), 0) *
 *        'Transactions'!C2:C10000
 *     ),0)
 *
 *   For the annual cell (col B): =SUM(C{row}:N{row}) -- bubbles monthly up.
 *
 *   We use SUMPRODUCT not SUMIFS because SUMIFS does not support
 *   REGEXMATCH inside its criteria -- only literal wildcards * and ?.
 *
 * SAFETY (per Steven's iron rules + kesefle-financial-data-integrity-guard):
 *   - DRY_RUN_SMART_REMAP_DASHBOARD() prints proposed formula per row
 *     plus the evaluated sum it would produce -- read-only.
 *   - SMART_REMAP_DASHBOARD() is GATED: it refuses unless Script Property
 *     CONFIRM_SMART_REMAP_DASHBOARD == "YES I UNDERSTAND". It also takes a
 *     LockService script lock and backs up the company dashboard rows 1-65
 *     to a _BAK_remap_<ts> tab BEFORE writing.
 *   - ROLLBACK_SMART_REMAP_DASHBOARD() restores rows 8-11 from the newest
 *     _BAK_remap_* tab if the remap produced wrong values.
 *   - Touches ONLY the 12 monthly formula cells in rows 8/9/10/11 (cols
 *     C..N) and the col B annual SUM. Does NOT touch labels in col A,
 *     row 6/7 (revenue/orders -- those are correctly wired already),
 *     row 12/13 (total/net -- those are SUM formulas, auto-update).
 *   - No-op safe: if company tab is missing -> return early.
 *
 * Public entry points (zero-arg, dropdown friendly):
 *   DRY_RUN_SMART_REMAP_DASHBOARD()   -- read-only diagnostic + proposal
 *   SMART_REMAP_DASHBOARD()           -- gate + lock + backup + apply
 *   ROLLBACK_SMART_REMAP_DASHBOARD()  -- restore rows 8-11 from newest backup
 *   VERIFY_SMART_REMAP_DASHBOARD()    -- post-write read of new values
 *
 * ENCODING:
 *   Every Hebrew string in this file is written as \u05XX escapes so
 *   clipboard/paste cycles never mangle the bytes (Steven's iron rule
 *   after the bidi/UTF-8 corruption incidents).
 */

// ---- CONFIGURE ---------------------------------------------------------
// NEW Kesefle sheet (Phase 1 migration target). Rollback to OLD:
// '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo'.
var _SR_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// "Ma'azan chevra" -- company dashboard tab. (transliterated: ma'azan chevra)
var _SR_COMPANY_TAB_ = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';
// "Tnu'ot" -- raw transactions tab.
var _SR_TX_TAB_ = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';
// "Esek" -- business tag in col D.
var _SR_BUSINESS_TAG_ = '\u05e2\u05e1\u05e7';

var _SR_VERSION_ = 'SmartRemap_v1';

// CONFIRM gate (per kesefle-financial-data-integrity-guard discipline).
// SMART_REMAP_DASHBOARD already has LockService + an automatic _BAK_remap_*
// backup, but it had NO confirmation gate -- so a stray dropdown-pick in the
// Apps Script function selector could rewrite rows 8-11. APPLY now refuses
// unless this Script Property is set to the exact value. Set it in
// Project Settings -> Script Properties, run SMART_REMAP_DASHBOARD(), then
// (optionally) clear the property again. ROLLBACK_SMART_REMAP_DASHBOARD()
// restores the newest _BAK_remap_* tab.
var _SR_CONFIRM_PROP_ = 'CONFIRM_SMART_REMAP_DASHBOARD';
var _SR_CONFIRM_VAL_  = 'YES I UNDERSTAND';

// 2026 year block rows (mirrors personal_sheet_fix.gs and Phase 5 verifier).
var _SR_YEAR_2026_ = {
  revenue: 6, orders: 7,
  material: 8, marketing: 9, shipping: 10, operational: 11,
  total: 12, net: 13
};

// ---- CATEGORY MAPPING --------------------------------------------------
// Each bucket's key is the dashboard row name and the value is a RE2
// regex of Hebrew synonyms (OR'd). All Hebrew is \u05XX-escaped.
//
// Mapping (plain English next to each pattern):
//   material    -- raw materials for printing:
//                  kanvas | madbeka | nyar | dyo | tzeva | chomer | hadpasa
//   marketing   -- marketing & ads:
//                  shivuk | pirsum | moda'a | facebook | instagram | tiktok |
//                  google | meta | lekohot | leadim | apollo | bay-book
//   shipping    -- packaging + shipping:
//                  mishloach | ariza | hatkana | hovala | havila | doar | baldar
//   operational -- software / subscriptions / banking fees:
//                  tochnot | aplikatziot | aplikatzia | minui | achsun |
//                  domain | cheshbonit | bank | omla | sherut
var _SR_CATEGORY_REGEX_ = {
  material:
    '\u05e7\u05e0\u05d1\u05e1|\u05de\u05d3\u05d1\u05e7\u05d4|\u05e0\u05d9\u05d9\u05e8|' +
    '\u05d3\u05d9\u05d5|\u05e6\u05d1\u05e2|\u05d7\u05d5\u05de\u05e8|\u05d4\u05d3\u05e4\u05e1\u05d4',
  marketing:
    '\u05e9\u05d9\u05d5\u05d5\u05e7|\u05e4\u05e8\u05e1\u05d5\u05dd|\u05de\u05d5\u05d3\u05e2\u05d4|' +
    '\u05e4\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7|\u05d0\u05d9\u05e0\u05e1\u05d8\u05d2\u05e8\u05dd|' +
    '\u05d8\u05d9\u05e7\u05d8\u05d5\u05e7|\u05d2\u05d5\u05d2\u05dc|\u05de\u05d8\u05d0|' +
    '\u05dc\u05e7\u05d5\u05d7\u05d5\u05ea|\u05dc\u05d9\u05d3\u05d9\u05dd|\u05d0\u05e4\u05d5\u05dc\u05d5|' +
    '\u05d1\u05d9\u05d9\u05e1\u05d1\u05d5\u05e7',
  shipping:
    '\u05de\u05e9\u05dc\u05d5\u05d7|\u05d0\u05e8\u05d9\u05d6\u05d4|\u05d4\u05ea\u05e7\u05e0\u05d4|' +
    '\u05d4\u05d5\u05d1\u05dc\u05d4|\u05d7\u05d1\u05d9\u05dc\u05d4|\u05d3\u05d5\u05d0\u05e8|' +
    '\u05d1\u05dc\u05d3\u05e8',
  operational:
    '\u05ea\u05d5\u05db\u05e0\u05d5\u05ea|\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d5\u05ea|' +
    '\u05d0\u05e4\u05dc\u05d9\u05e7\u05e6\u05d9\u05d4|\u05de\u05e0\u05d5\u05d9|\u05d0\u05d7\u05e1\u05d5\u05df|' +
    '\u05d3\u05d5\u05de\u05d9\u05d9\u05df|\u05d7\u05e9\u05d1\u05d5\u05e0\u05d9\u05ea|\u05d1\u05e0\u05e7|' +
    '\u05e2\u05de\u05dc\u05d4|\u05e9\u05d9\u05e8\u05d5\u05ea'
};

// English-name display labels (for the dry-run log).
var _SR_BUCKET_DISPLAY_ = {
  material:    'material   (chomrei gelem)',
  marketing:   'marketing  (shivuk)',
  shipping:    'shipping   (ariza u-mishloach)',
  operational: 'operational(tif-ulit)'
};

// ---- HELPERS -----------------------------------------------------------

function _sr_openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act && act.getId && act.getId() === _SR_SHEET_ID_) return act;
  } catch (e) { /* fall through */ }
  return SpreadsheetApp.openById(_SR_SHEET_ID_);
}

function _sr_num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

// Build the 13-cell row [annualB, jan, ..., dec] of FORMULA strings.
// Annual = SUM(C..N) of THIS same row (so a month edit propagates up).
// Monthly = SUMPRODUCT( monthMatch * businessTag * REGEXMATCH(catRegex) * amount ).
function _sr_buildBucketRowFormulas_(rowNum, bucketKey) {
  var regex = _SR_CATEGORY_REGEX_[bucketKey];
  if (!regex) throw new Error('Unknown bucket: ' + bucketKey);

  var cells = [];
  cells.push('=SUM(C' + rowNum + ':N' + rowNum + ')');

  // Tab name with single-quote wrap (required because the tab name
  // contains non-A-Z chars).
  var tx = "'" + _SR_TX_TAB_ + "'";

  for (var m = 1; m <= 12; m++) {
    var mm = m < 10 ? ('0' + m) : ('' + m);
    var safeRegex = String(regex).replace(/"/g, '""');

    // SUMPRODUCT factors:
    //   1. month-tag match: B:B = $B$4 & "-MM"  -> 1/0 vector
    //   2. business-tag match: D:D = "esek"     -> 1/0 vector
    //   3. category regex:   REGEXMATCH(E:E, regex) -> TRUE/FALSE, wrapped
    //      in IFERROR so blank rows / #N/A become 0.
    //   4. amount:           C:C
    //
    // Range bound: rows 2..10000 (skip header, scan ~10 years of dense
    // data) so SUMPRODUCT doesn't scan an infinite empty range.
    var f =
      '=IFERROR(SUMPRODUCT(' +
        '(' + tx + '!B2:B10000=$B$4&"-' + mm + '")*' +
        '(' + tx + '!D2:D10000="' + _SR_BUSINESS_TAG_ + '")*' +
        'IFERROR(REGEXMATCH(' + tx + '!E2:E10000,"' + safeRegex + '"),FALSE)*' +
        tx + '!C2:C10000' +
      '),0)';

    cells.push(f);
  }

  return cells;
}

// ---- BACKUP ------------------------------------------------------------

function _sr_backupCompanyDashboard_(ss) {
  var src = ss.getSheetByName(_SR_COMPANY_TAB_);
  if (!src) return null;
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_remap_' + ts;
  while (ss.getSheetByName(bakName)) {
    bakName = '_BAK_remap_' + ts + '_' + Math.floor(Math.random() * 1000);
  }
  var dst = ss.insertSheet(bakName);
  var range = src.getRange(1, 1, 65, 14);
  range.copyTo(dst.getRange(1, 1), { contentsOnly: false });
  Logger.log('Backup written -> ' + bakName);
  return bakName;
}

// ---- PUBLIC: DRY RUN ---------------------------------------------------

function DRY_RUN_SMART_REMAP_DASHBOARD() {
  Logger.log('===== DRY RUN: SMART_REMAP_DASHBOARD (' + _SR_VERSION_ + ') =====');
  Logger.log('Sheet: ' + _SR_SHEET_ID_);
  Logger.log('Tab:   ' + _SR_COMPANY_TAB_);
  Logger.log('Target rows: 8 (material), 9 (marketing), 10 (shipping), 11 (operational)');
  Logger.log('');

  var ss;
  try { ss = _sr_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }

  var dash = ss.getSheetByName(_SR_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no company tab -- no-op'); return; }

  var b = _SR_YEAR_2026_;

  Logger.log('--- CURRENT state (rows 8-11, col B annual + col G May) ---');
  ['material','marketing','shipping','operational'].forEach(function (key) {
    var r = b[key];
    var labelA  = dash.getRange(r, 1).getValue();
    var valB    = dash.getRange(r, 2).getValue();
    var formB   = dash.getRange(r, 2).getFormula();
    var valG    = dash.getRange(r, 7).getValue();
    var formG   = dash.getRange(r, 7).getFormula();
    Logger.log('  r' + r + ' (' + key + ')  label="' + labelA + '"  annual=' +
      valB + (formB ? '  [formula]' : '  [literal]'));
    Logger.log('    May cell:  ' + valG + (formG ? '  formula=' + formG : '  (literal)'));
  });

  Logger.log('');
  Logger.log('--- PROPOSED new formulas (sample: May col G) ---');
  ['material','marketing','shipping','operational'].forEach(function (key) {
    var r = b[key];
    var cells = _sr_buildBucketRowFormulas_(r, key);
    Logger.log('  r' + r + ' (' + _SR_BUCKET_DISPLAY_[key] + '):');
    Logger.log('    annual: ' + cells[0]);
    Logger.log('    May:    ' + cells[5]);
  });

  Logger.log('');
  Logger.log('--- CATEGORY REGEX MAP ---');
  Object.keys(_SR_CATEGORY_REGEX_).forEach(function (k) {
    Logger.log('  ' + k + ': ' + _SR_CATEGORY_REGEX_[k]);
  });

  Logger.log('');
  Logger.log('To apply: set Script Property ' + _SR_CONFIRM_PROP_ + ' = ' + _SR_CONFIRM_VAL_ +
             ' then run SMART_REMAP_DASHBOARD(). A backup tab is created automatically;');
  Logger.log('ROLLBACK_SMART_REMAP_DASHBOARD() undoes it.');
}

// ---- PUBLIC: APPLY -----------------------------------------------------

function SMART_REMAP_DASHBOARD() {
  // CONFIRM gate -- refuse unless the Script Property is set. This stops an
  // accidental dropdown-run from rewriting the dashboard. (Lock + backup are
  // already present below; the gate is the missing third guardrail.)
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(_SR_CONFIRM_PROP_) !== _SR_CONFIRM_VAL_) {
    Logger.log('!! REFUSING: set Script Property ' + _SR_CONFIRM_PROP_ +
               ' = ' + _SR_CONFIRM_VAL_ + ' first (Project Settings -> Script Properties),');
    Logger.log('   then run SMART_REMAP_DASHBOARD() again. Run DRY_RUN_SMART_REMAP_DASHBOARD() to preview.');
    return 'refused-no-confirm';
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    Logger.log('!! could not acquire lock -- abort: ' + e.message);
    return;
  }
  try {
    var ss = _sr_openSheet_();
    var dash = ss.getSheetByName(_SR_COMPANY_TAB_);
    if (!dash) { Logger.log('!! no company tab -- no-op'); return; }

    Logger.log('===== APPLY: SMART_REMAP_DASHBOARD (' + _SR_VERSION_ + ') =====');
    var bakName = _sr_backupCompanyDashboard_(ss);
    Logger.log('Backup: ' + bakName);

    var b = _SR_YEAR_2026_;
    var buckets = ['material', 'marketing', 'shipping', 'operational'];

    buckets.forEach(function (key) {
      var rowNum = b[key];
      var row = _sr_buildBucketRowFormulas_(rowNum, key);
      // setFormulas takes a 2D array; one row, 13 cols (B..N = cols 2..14).
      dash.getRange(rowNum, 2, 1, 13).setFormulas([row]);
      Logger.log('  r' + rowNum + ' (' + key + ') -> 13 formulas written');
    });

    SpreadsheetApp.flush();
    Logger.log('SpreadsheetApp.flush() done.');

    Logger.log('');
    Logger.log('DONE. Backup at: ' + bakName);
    Logger.log('Run VERIFY_SMART_REMAP_DASHBOARD() to read the new values.');
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

// ---- PUBLIC: VERIFY ----------------------------------------------------

function VERIFY_SMART_REMAP_DASHBOARD() {
  Logger.log('===== VERIFY: SMART_REMAP_DASHBOARD (' + _SR_VERSION_ + ') =====');
  var ss;
  try { ss = _sr_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }

  var dash = ss.getSheetByName(_SR_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no company tab -- no-op'); return; }

  var b = _SR_YEAR_2026_;
  var labels = ['material', 'marketing', 'shipping', 'operational'];

  Logger.log('After remap -- annual + per-month for rows 8-11:');
  Logger.log('');

  labels.forEach(function (key) {
    var rowNum = b[key];
    var annual = _sr_num_(dash.getRange(rowNum, 2).getValue());
    var months = dash.getRange(rowNum, 3, 1, 12).getValues()[0];
    var monthSum = 0;
    var monthStrs = [];
    for (var i = 0; i < 12; i++) {
      var v = _sr_num_(months[i]);
      monthSum += v;
      monthStrs.push((i + 1) + '=' + v.toFixed(0));
    }
    var ok = Math.abs(annual - monthSum) < 1;
    Logger.log('  r' + rowNum + ' (' + key + '):  annual=' + annual.toFixed(2) +
      '  months sum=' + monthSum.toFixed(2) + '  ' + (ok ? '[OK]' : '[MISMATCH]'));
    Logger.log('    per-month: ' + monthStrs.join('  '));
  });

  var totalAnnual   = _sr_num_(dash.getRange(b.total, 2).getValue());
  var netAnnual     = _sr_num_(dash.getRange(b.net, 2).getValue());
  var revenueAnnual = _sr_num_(dash.getRange(b.revenue, 2).getValue());
  Logger.log('');
  Logger.log('Derived rows:');
  Logger.log('  r' + b.revenue + ' revenue: ' + revenueAnnual.toFixed(2));
  Logger.log('  r' + b.total   + ' total  : ' + totalAnnual.toFixed(2));
  Logger.log('  r' + b.net     + ' net    : ' + netAnnual.toFixed(2) +
    ' (expected ' + (revenueAnnual - totalAnnual).toFixed(2) + ')');
}

// ---- PUBLIC: ROLLBACK --------------------------------------------------
// Restore rows 8-11 cols B..N of the company dashboard from the newest
// _BAK_remap_* backup tab created by SMART_REMAP_DASHBOARD(). The backup tab
// holds a full copy of the dashboard (rows 1-65, cols A..N), so we copy back
// only the cells SMART_REMAP wrote (the four expense-bucket rows). Read-only
// if no backup tab is found.
function ROLLBACK_SMART_REMAP_DASHBOARD() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    Logger.log('!! could not acquire lock -- abort: ' + e.message);
    return;
  }
  try {
    var ss = _sr_openSheet_();
    var dash = ss.getSheetByName(_SR_COMPANY_TAB_);
    if (!dash) { Logger.log('!! no company tab -- no-op'); return 'no-company-tab'; }

    // Find the newest _BAK_remap_* tab by name (timestamp sorts lexicographically).
    var tabs = ss.getSheets();
    var newest = null;
    var newestName = '';
    for (var i = 0; i < tabs.length; i++) {
      var name = tabs[i].getName();
      if (name.indexOf('_BAK_remap_') === 0 && name > newestName) {
        newestName = name;
        newest = tabs[i];
      }
    }
    if (!newest) {
      Logger.log('!! no _BAK_remap_* backup tab found -- nothing to roll back.');
      return 'no-backup';
    }

    Logger.log('===== ROLLBACK: SMART_REMAP_DASHBOARD (' + _SR_VERSION_ + ') =====');
    Logger.log('Restoring rows 8-11 cols B..N from backup tab: ' + newestName);

    var b = _SR_YEAR_2026_;
    // rows 8..11 (material..operational) are contiguous; restore in one copy.
    var firstRow = b.material; // 8
    var lastRow  = b.operational; // 11
    var numRows  = lastRow - firstRow + 1; // 4
    // cols B..N = col 2..14 = 13 cols.
    var srcRange = newest.getRange(firstRow, 2, numRows, 13);
    srcRange.copyTo(dash.getRange(firstRow, 2), { contentsOnly: false });

    SpreadsheetApp.flush();
    Logger.log('DONE. Rows ' + firstRow + '-' + lastRow + ' restored from ' + newestName + '.');
    Logger.log('Run VERIFY_SMART_REMAP_DASHBOARD() to confirm the restored values.');
    return 'rolled-back:' + newestName;
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}
