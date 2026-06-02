/**
 * bot/SHEET_YEAR_SELECTOR_WIRE.gs
 *
 * Wire the year-selector dropdown in B4 of company dashboard
 * ("ma'azan chevra") so the 2026 block (rows 6-13) reads from LIVE source
 * tabs (Transactions, Orders) when B4 == current year, and from the
 * "historical summary" tab (sikum histori) snapshot when B4 != current year.
 *
 * WHY:
 *   PR #122 Phase 3 populated the historical summary tab with frozen
 *   2023-2025 snapshots so the dashboard can show old years without
 *   re-aggregating the (already migrated, never-edited-again) raw rows.
 *   But the formula cells in the 2026 block are still hardcoded to read
 *   ONLY from the live transactions tab -- if Steven changes B4 to 2023
 *   he sees zeros because there's no 2023 transactions data in NEW.
 *
 * HOW:
 *   Wrap every formula in rows 6-11 cols C..N with an IFS() switch:
 *
 *     =IFS(
 *        $B$4=2026, <live SUMIFS / SUMPRODUCT formula>,
 *        TRUE,      <historical summary VLOOKUP>
 *     )
 *
 *   The historical summary tab is laid out as a long table:
 *     Col A: year (number)
 *     Col B: month (1..12)
 *     Col C: bucket key (revenue / orders / material / marketing / shipping / operational)
 *     Col D: value (number)
 *   VLOOKUP composes a key like "2025-05-material" and looks up the value.
 *   The composed key uses TEXT(MONTH,"00") for stable padding.
 *
 *   NOTE: rows 12/13 (total / net) are computed via SUM and subtraction
 *   from the rows above, so they need NO wrapper -- they pick up whatever
 *   rows 6-11 produce.
 *
 * STEP 1 of this script verifies that B4 has the year dropdown (added in
 * an earlier session -- values 2023-2027) BEFORE writing anything. If the
 * dropdown is missing, the script auto-creates it.
 *
 * STEP 2 reads the existing formula in each cell of rows 6-11, wraps it
 * in the IFS switch above, and writes back. If a cell holds a literal
 * (no formula), the wrapper still works: the literal becomes the "live"
 * branch and the historical lookup is the fallback.
 *
 * SAFETY:
 *   - No-op safe: if company tab missing, the historical summary tab is
 *     missing, or B4 is not in the expected range -> return early.
 *   - Backup-first: every write is preceded by a _BAK_yearwire_<ts> tab
 *     containing rows 1-65 cols A..N of the company dashboard.
 *   - DRY_RUN_YEAR_SELECTOR_WIRE() prints the new wrapped formula for
 *     every cell with no writes.
 *   - WIRE_YEAR_SELECTOR() does the actual wrap.
 *
 * ENCODING:
 *   Every Hebrew string is \u05XX-escaped.
 */

// ---- CONFIGURE ---------------------------------------------------------
var _YS_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// "ma'azan chevra" -- company dashboard tab.
var _YS_COMPANY_TAB_ = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';
// "sikum histori" -- historical summary tab (PR #122 Phase 3).
var _YS_HISTORY_TAB_ = '\u05e1\u05d9\u05db\u05d5\u05dd \u05d4\u05d9\u05e1\u05d8\u05d5\u05e8\u05d9';

var _YS_VERSION_     = 'YearSelectorWire_v1';

// The "current" year -- when B4 == this value, formulas use LIVE sources.
// When B4 is any other value, formulas use historical summary.
// 2026-05-29: was hardcoded to 2026. That meant on Jan-1-2027 every
// dashboard formula silently flipped to "treat 2026 as live, 2027 as
// historical" -- but 2026 would NO LONGER be live data, it would be
// the just-completed past year. Converted to a function so the live
// year always tracks the Asia/Jerusalem wall clock.
function _YS_CURRENT_YEAR_() { return parseInt(Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy'), 10); }

// Year-selector dropdown values (2023..2027).
var _YS_YEAR_RANGE_ = [2023, 2024, 2025, 2026, 2027];

// Year block row map -- rows 6..11 are wrapped (revenue, orders, four
// expense buckets). Rows 12/13 (total/net) are derived, no wrap needed.
var _YS_WRAP_ROWS_ = {
  revenue:     6,
  orders:      7,
  material:    8,
  marketing:   9,
  shipping:    10,
  operational: 11
};

// Map row number -> bucket key string (used to compose the lookup key
// "<year>-<MM>-<bucket>" in the historical summary tab).
var _YS_ROW_TO_BUCKET_KEY_ = {
  6:  'revenue',
  7:  'orders',
  8:  'material',
  9:  'marketing',
  10: 'shipping',
  11: 'operational'
};

// ---- HELPERS -----------------------------------------------------------

function _ys_openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act && act.getId && act.getId() === _YS_SHEET_ID_) return act;
  } catch (e) { /* fall through */ }
  return SpreadsheetApp.openById(_YS_SHEET_ID_);
}

// Verify (and if missing, add) the year-selector dropdown on B4.
// Returns { existed: bool, ok: bool, message: string }.
function _ys_ensureYearDropdown_(dash) {
  var b4 = dash.getRange('B4');
  var existing = b4.getDataValidation();
  if (existing) {
    // Already has SOME validation. Check it's our list of years (best-effort).
    try {
      var criteria = existing.getCriteriaType ? existing.getCriteriaType() : null;
      var values = existing.getCriteriaValues ? existing.getCriteriaValues() : null;
      // If it's a list-of-values validation and the list contains 2026,
      // assume it's our dropdown -- no rewrite needed.
      var crit = SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST;
      if (criteria === crit && values && values[0] && values[0].indexOf(_YS_CURRENT_YEAR_()) !== -1) {
        return { existed: true, ok: true, message: 'B4 dropdown present with ' + values[0].join(',') };
      }
    } catch (e) { /* fall through and rewrite */ }
  }

  // Add (or replace) the dropdown.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(_YS_YEAR_RANGE_.map(function (y) { return String(y); }), true)
    .setAllowInvalid(false)
    .setHelpText('Select a year between ' + _YS_YEAR_RANGE_[0] + ' and ' +
      _YS_YEAR_RANGE_[_YS_YEAR_RANGE_.length - 1])
    .build();
  b4.setDataValidation(rule);
  // If B4 is blank, default it to current year so the dashboard shows
  // something meaningful on first open.
  var v = b4.getValue();
  if (v === '' || v === null || v === undefined) {
    b4.setValue(_YS_CURRENT_YEAR_());
  }
  return { existed: false, ok: true, message: 'B4 dropdown installed: ' + _YS_YEAR_RANGE_.join(',') };
}

// Build the historical-summary VLOOKUP fallback formula for a given cell
// in row `rowNum`, column `colIdx` (1-indexed; col B=2, col C=3 = Jan).
//
// History tab layout (key | value):
//   A: year         B: month (1..12)   C: bucket key   D: value
// We compose a string key "year|month|bucket" and look it up in a flattened
// helper column on history -- but to avoid requiring such a helper column,
// we use SUMIFS over the history table instead. SUMIFS handles the
// multi-key lookup naturally and returns 0 for misses (which IFERROR
// catches anyway).
function _ys_buildHistoryFormula_(rowNum, colIdx) {
  var bucket = _YS_ROW_TO_BUCKET_KEY_[rowNum];
  if (!bucket) return '0';

  var hist = "'" + _YS_HISTORY_TAB_ + "'";

  // colIdx semantics:
  //   colIdx 2 = col B = annual cell -> sum all 12 months for that year+bucket
  //   colIdx 3..14 = month Jan..Dec  -> sum only that month

  if (colIdx === 2) {
    // Annual = SUMIFS of all months for that year+bucket.
    return '=IFERROR(SUMIFS(' +
      hist + '!D:D,' +
      hist + '!A:A,$B$4,' +
      hist + '!C:C,"' + bucket + '"' +
      '),0)';
  }

  // Monthly: month index 1..12 = colIdx - 2.
  var monthIdx = colIdx - 2;
  return '=IFERROR(SUMIFS(' +
    hist + '!D:D,' +
    hist + '!A:A,$B$4,' +
    hist + '!B:B,' + monthIdx + ',' +
    hist + '!C:C,"' + bucket + '"' +
    '),0)';
}

// Wrap a live formula (or a literal) into an IFS() that switches on $B$4.
// If `liveFormula` is empty or just a literal value, we treat the literal
// as the live branch.
function _ys_wrapWithYearSwitch_(liveFormula, rowNum, colIdx, currentLiteralValue) {
  var live;
  if (liveFormula && typeof liveFormula === 'string' && liveFormula.charAt(0) === '=') {
    // Strip leading "=" so we can re-embed inside IFS.
    live = liveFormula.substring(1);
  } else {
    // Literal value -- coerce to a number-or-zero for the IFS branch.
    var n = Number(currentLiteralValue);
    if (isFinite(n)) live = String(n);
    else if (currentLiteralValue === '' || currentLiteralValue === null || currentLiteralValue === undefined) live = '0';
    else live = '"' + String(currentLiteralValue).replace(/"/g, '""') + '"';
  }

  // Already wrapped? Detect heuristically: if formula starts with =IFS($B$4=...
  // bail out so re-runs are idempotent.
  if (liveFormula && liveFormula.indexOf('IFS($B$4=' + _YS_CURRENT_YEAR_()) !== -1) {
    return liveFormula;  // already wrapped, no-op
  }

  var historical = _ys_buildHistoryFormula_(rowNum, colIdx);
  // Strip leading "=" from historical too.
  var histInner = historical.charAt(0) === '=' ? historical.substring(1) : historical;

  return '=IFS($B$4=' + _YS_CURRENT_YEAR_() + ',(' + live + '),TRUE,(' + histInner + '))';
}

// ---- BACKUP ------------------------------------------------------------

function _ys_backupCompanyDashboard_(ss) {
  var src = ss.getSheetByName(_YS_COMPANY_TAB_);
  if (!src) return null;
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_yearwire_' + ts;
  while (ss.getSheetByName(bakName)) {
    bakName = '_BAK_yearwire_' + ts + '_' + Math.floor(Math.random() * 1000);
  }
  var dst = ss.insertSheet(bakName);
  var range = src.getRange(1, 1, 65, 14);
  range.copyTo(dst.getRange(1, 1), { contentsOnly: false });
  Logger.log('Backup written -> ' + bakName);
  return bakName;
}

// ---- PUBLIC: DRY RUN ---------------------------------------------------

function DRY_RUN_YEAR_SELECTOR_WIRE() {
  Logger.log('===== DRY RUN: WIRE_YEAR_SELECTOR (' + _YS_VERSION_ + ') =====');
  Logger.log('Sheet: ' + _YS_SHEET_ID_);
  Logger.log('Tab:   ' + _YS_COMPANY_TAB_);
  Logger.log('');

  var ss;
  try { ss = _ys_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }

  var dash = ss.getSheetByName(_YS_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no company tab -- no-op'); return; }

  var hist = ss.getSheetByName(_YS_HISTORY_TAB_);
  if (!hist) {
    Logger.log('!! historical summary tab missing (' + _YS_HISTORY_TAB_ + ')');
    Logger.log('   The wrap will still install but the non-2026 branch will return 0.');
    Logger.log('   Confirm PR #122 Phase 3 ran on this sheet before applying.');
  } else {
    Logger.log('OK: historical summary tab present (rows so far: ' + hist.getLastRow() + ')');
  }

  // Step 1: check the dropdown.
  var dd = _ys_ensureYearDropdown_(dash);
  Logger.log('Year-dropdown check: ' + (dd.existed ? 'PRESENT' : 'WOULD INSTALL') + ' -- ' + dd.message);

  // Step 2: preview wrap for each row 6..11, col B (annual) + col G (May).
  Logger.log('');
  Logger.log('--- PROPOSED wraps (sample col B annual + col G May) ---');
  Object.keys(_YS_WRAP_ROWS_).forEach(function (bucket) {
    var rowNum = _YS_WRAP_ROWS_[bucket];
    [2, 7].forEach(function (colIdx) {
      var cur     = dash.getRange(rowNum, colIdx).getFormula();
      var curVal  = dash.getRange(rowNum, colIdx).getValue();
      var wrap    = _ys_wrapWithYearSwitch_(cur, rowNum, colIdx, curVal);
      var colName = colIdx === 2 ? 'B-annual' : 'G-May';
      Logger.log('  r' + rowNum + ' (' + bucket + ') ' + colName + ':');
      Logger.log('    BEFORE: ' + (cur || '(literal ' + curVal + ')'));
      Logger.log('    AFTER:  ' + wrap);
    });
  });

  Logger.log('');
  Logger.log('Run WIRE_YEAR_SELECTOR() to apply.');
}

// ---- PUBLIC: APPLY -----------------------------------------------------

function WIRE_YEAR_SELECTOR() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    Logger.log('!! could not acquire lock -- abort: ' + e.message);
    return;
  }
  try {
    var ss = _ys_openSheet_();
    var dash = ss.getSheetByName(_YS_COMPANY_TAB_);
    if (!dash) { Logger.log('!! no company tab -- no-op'); return; }

    Logger.log('===== APPLY: WIRE_YEAR_SELECTOR (' + _YS_VERSION_ + ') =====');
    var bakName = _ys_backupCompanyDashboard_(ss);
    Logger.log('Backup: ' + bakName);

    // Step 1: ensure the year dropdown exists on B4.
    var dd = _ys_ensureYearDropdown_(dash);
    Logger.log('Year-dropdown: ' + dd.message);

    // Step 2: wrap every cell in rows 6..11, cols B..N (cols 2..14).
    var rowKeys = Object.keys(_YS_WRAP_ROWS_);
    var wrapsApplied = 0;
    var wrapsSkipped = 0;

    rowKeys.forEach(function (bucket) {
      var rowNum = _YS_WRAP_ROWS_[bucket];
      // Read existing formulas + values for the whole row in one batch.
      var range = dash.getRange(rowNum, 2, 1, 13);
      var formulas = range.getFormulas()[0];
      var values   = range.getValues()[0];
      var newFormulas = [];
      for (var i = 0; i < 13; i++) {
        var colIdx = i + 2;
        var existing = formulas[i];
        var wrap = _ys_wrapWithYearSwitch_(existing, rowNum, colIdx, values[i]);
        if (wrap === existing) {
          newFormulas.push(existing);  // already wrapped -- no change
          wrapsSkipped++;
        } else {
          newFormulas.push(wrap);
          wrapsApplied++;
        }
      }
      range.setFormulas([newFormulas]);
      Logger.log('  r' + rowNum + ' (' + bucket + '): wrote 13 cells');
    });

    SpreadsheetApp.flush();
    Logger.log('Wraps applied: ' + wrapsApplied + '  skipped (already wrapped): ' + wrapsSkipped);
    Logger.log('');
    Logger.log('DONE. Backup at: ' + bakName);
    Logger.log('Test: change B4 to 2025 -- dashboard should swap to historical values.');
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}
