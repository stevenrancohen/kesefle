/**
 * bot/BACKFILL_HISTORICAL_YEARS.gs
 *
 * Phase 9 of the Kesefle migration epic (Steven's section-23 plan).
 *
 * One-time historical backfill that reads OLD sheet (1UKr...) raw rows
 * from the transactions tab for years 2023/2024/2025, classifies each
 * row using the same shape MIGRATE_OLD_TO_KESEFLE.gs uses, then writes a
 * per-(year, month, category, subcategory) sum snapshot tab on the NEW
 * sheet (1rti...). The snapshot powers the year-pivot dashboard wired by
 * WIRE_YEAR_HISTORY_LOOKUP.gs so that B4 flipped to 2023/2024/2025
 * shows frozen historical numbers without re-aggregating raw rows on
 * every cell recompute.
 *
 * Three public entry points:
 *   DRY_RUN_BACKFILL_HISTORICAL_YEARS()
 *     scan only, NO writes. Reports per-year totals, per-month sums,
 *     per-category sums for 2023/2024/2025.
 *
 *   APPLY_BACKFILL_HISTORICAL_YEARS('YES I UNDERSTAND')
 *     gated write. Refuses without the literal confirmation string.
 *     Writes the snapshot tab on the NEW sheet only. OLD is read-only.
 *
 *   APPLY_BACKFILL_HISTORICAL_YEARS_NOW()
 *     zero-arg wrapper so it runs from the Apps Script function dropdown.
 *
 *   VERIFY_BACKFILL_HISTORICAL_YEARS()
 *     read the snapshot tab and print yearly totals + a sanity table.
 *
 * Per Steven's iron rules:
 *   - OLD is opened read-only. The script never calls
 *     setValue/setValues/setFormula/setNote on OLD.
 *   - Backup-first: snapshot tab is a brand-new hidden tab; nothing else
 *     on NEW is mutated. Idempotent: if a snapshot row for
 *     (year, month, category, subcategory) already exists, its sum is
 *     UPDATED IN PLACE rather than appended (no duplicate keys).
 *   - LockService.getScriptLock guards APPLY to block concurrent runs.
 *   - "YES I UNDERSTAND" arg gate (matches MIGRATE_OLD_TO_KESEFLE.gs).
 *
 * Encoding rule:
 *   Every Hebrew identifier is a backslash-u escape. The file has zero
 *   raw Hebrew bytes so chat-paste / Chrome MCP paste cannot corrupt it.
 *   Apps Script + node decode the escapes at parse time. Verify with
 *     grep -cP '[\x{0590}-\x{05FF}]' bot/BACKFILL_HISTORICAL_YEARS.gs
 *   which should return 0.
 *
 * Snapshot tab schema (5 columns, hidden tab):
 *   A: year       (number, e.g. 2024)
 *   B: month      (number 1..12)
 *   C: category   (string, raw col-D value from OLD tx tab)
 *   D: subcategory (string, raw col-E value from OLD tx tab)
 *   E: sum        (number, signed total for that bucket)
 *
 * The matching WIRE_YEAR_HISTORY_LOOKUP.gs uses these columns
 * verbatim in its IFS()-pivot SUMIFS args.
 */

// ---- CONFIGURE ---------------------------------------------------------

var _BH_OLD_SHEET_ID_  = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _BH_NEW_SHEET_ID_  = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Source tab on OLD: "tnuot" (transactions). Per memory
// expenses_year_tabs_real_structure.md the OLD tx tab holds personal
// rows for all years; business rows live in the year-specific
// "mazan chevra <year>" tabs. We classify each row as business vs.
// personal at scan time using the same column-G ("source") signal the
// MIGRATE_OLD_TO_KESEFLE.gs scan uses.
//
// Schema (8 cols, matches MIGRATE_OLD_TO_KESEFLE.gs):
//   A: date  B: month  C: amount  D: category  E: subcategory
//   F: detail  G: source  H: status
//
// Hebrew identifiers below are encoded as \uXXXX so paste cannot mangle.
// "tnuot" = transactions tab.
var _BH_OLD_TX_TAB_    = '\u05EA\u05E0\u05D5\u05E2\u05D5\u05EA';
// "mazan chevra " = OLD company-year tab prefix (trailing ASCII space).
var _BH_OLD_COMPANY_TAB_PREFIX_ =
  '\u05DE\u05D0\u05D6\u05DF \u05D7\u05D1\u05E8\u05D4 ';

// Destination tab on NEW: "sikum histori" (history summary).
var _BH_HIST_TAB_      =
  '\u05E1\u05D9\u05DB\u05D5\u05DD \u05D4\u05D9\u05E1\u05D8\u05D5\u05E8\u05D9';

// Business marker -- "esek" -- the col-G/col-F flag that signals a row
// belongs to the company side of the books.
var _BH_BUSINESS_MARKER_ =
  '\u05E2\u05E1\u05E7';

// Years to backfill.
var _BH_YEARS_         = [2023, 2024, 2025];

var _BH_VERSION_       = 'BackfillHistorical_v1';

// ---- HELPERS -----------------------------------------------------------

function _bh_openOld_() {
  try { return SpreadsheetApp.openById(_BH_OLD_SHEET_ID_); }
  catch (e) { Logger.log('!! cannot open OLD (' + _BH_OLD_SHEET_ID_ + '): ' + e.message); return null; }
}

function _bh_openNew_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act && act.getId && act.getId() === _BH_NEW_SHEET_ID_) return act;
  } catch (e) { /* fall through */ }
  try { return SpreadsheetApp.openById(_BH_NEW_SHEET_ID_); }
  catch (e) { Logger.log('!! cannot open NEW (' + _BH_NEW_SHEET_ID_ + '): ' + e.message); return null; }
}

// Coerce a cell value to a finite number (0 for blanks / NaN).
function _bh_num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

// Derive year + month from an OLD row's col-A date cell. Falls back to
// col-B month string if col-A is not a Date. Returns { year, month } or
// null if neither field yields a usable year.
function _bh_rowYearMonth_(row) {
  var dateCell = row[0];
  if (dateCell instanceof Date && !isNaN(dateCell.getTime())) {
    return { year: dateCell.getFullYear(), month: dateCell.getMonth() + 1 };
  }
  // Fallback: col B sometimes holds "2024-05" or "05/2024".
  var b = String(row[1] || '').trim();
  var m1 = b.match(/^(\d{4})[-\/](\d{1,2})$/);
  if (m1) return { year: parseInt(m1[1], 10), month: parseInt(m1[2], 10) };
  var m2 = b.match(/^(\d{1,2})[-\/](\d{4})$/);
  if (m2) return { year: parseInt(m2[2], 10), month: parseInt(m2[1], 10) };
  // Fallback 2: col A is a string like "2024-05-12".
  var a = String(dateCell || '').trim();
  var m3 = a.match(/(\d{4})[-\/](\d{1,2})/);
  if (m3) return { year: parseInt(m3[1], 10), month: parseInt(m3[2], 10) };
  return null;
}

// Classify a row as "business" or "personal" using the col-G source
// signal the MIGRATE_OLD_TO_KESEFLE.gs convention establishes. The OLD
// sheet historically uses an "esek" (business) marker in col G or in
// col F (detail) for company rows. Personal rows usually have other
// markers (e.g. "WhatsApp").
//
// We keep this generous on purpose: the snapshot tab carries category +
// subcategory so the dashboard's SUMIFS can filter further at display
// time without us hard-coding policy here.
function _bh_isBusinessRow_(row) {
  var src   = String(row[6] || '');
  var det   = String(row[5] || '');
  var cat   = String(row[3] || '');
  if (src.indexOf(_BH_BUSINESS_MARKER_) !== -1) return true;
  if (det.indexOf(_BH_BUSINESS_MARKER_) !== -1) return true;
  if (cat.indexOf(_BH_BUSINESS_MARKER_) === 0)  return true;
  var srcLow = src.toLowerCase();
  if (srcLow.indexOf('biz') !== -1 || srcLow.indexOf('company') !== -1) return true;
  return false;
}

// Build the bucket key "<year>|<month>|<category>|<subcategory>" used to
// dedupe + sum at scan time and to find existing snapshot rows at write
// time.
function _bh_bucketKey_(year, month, category, subcategory) {
  return [
    String(year),
    String(month),
    String(category || ''),
    String(subcategory || '')
  ].join('|');
}

// ---- SCAN OLD -> AGGREGATE --------------------------------------------

// Returns:
//   {
//     buckets: { "<year>|<month>|<cat>|<sub>": { year, month, category, subcategory, sum } },
//     perYear: { 2023: { rows, business, personal, sumTotal, perMonth, perCategory }, ... },
//     skipped: { no_amount, no_year, out_of_range, empty }
//   }
function _bh_scanOldTransactions_() {
  var result = {
    buckets: {},
    perYear: {},
    skipped: { no_amount: 0, no_year: 0, out_of_range: 0, empty: 0 }
  };
  _BH_YEARS_.forEach(function (y) {
    result.perYear[y] = {
      rows: 0, business: 0, personal: 0, sumTotal: 0,
      perMonth: {}, perCategory: {}
    };
    for (var m = 1; m <= 12; m++) result.perYear[y].perMonth[m] = 0;
  });

  var oldSS = _bh_openOld_();
  if (!oldSS) return { error: 'cannot_open_old' };

  var tx = oldSS.getSheetByName(_BH_OLD_TX_TAB_);
  if (!tx) {
    Logger.log('!! OLD has no transactions tab (' + _BH_OLD_TX_TAB_ + ')');
    return { error: 'no_old_tx_tab' };
  }

  var lastRow = tx.getLastRow();
  if (lastRow < 2) {
    Logger.log('OLD transactions tab is empty.');
    return result;
  }

  // Read 8 cols batched.
  var data = tx.getRange(2, 1, lastRow - 1, 8).getValues();
  Logger.log('-- OLD tx tab: ' + data.length + ' total data rows scanned --');

  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    if (!row[0] && !row[2] && !row[5]) { result.skipped.empty++; continue; }

    var amt = parseFloat(row[2]);
    if (!isFinite(amt) || amt === 0) { result.skipped.no_amount++; continue; }

    var ym = _bh_rowYearMonth_(row);
    if (!ym) { result.skipped.no_year++; continue; }
    if (_BH_YEARS_.indexOf(ym.year) === -1) {
      result.skipped.out_of_range++; continue;
    }

    var category    = String(row[3] || '').trim();
    var subcategory = String(row[4] || '').trim();
    var isBiz       = _bh_isBusinessRow_(row);

    // Aggregate into the (year, month, category, subcategory) bucket.
    var key = _bh_bucketKey_(ym.year, ym.month, category, subcategory);
    if (!result.buckets[key]) {
      result.buckets[key] = {
        year: ym.year, month: ym.month,
        category: category, subcategory: subcategory, sum: 0
      };
    }
    result.buckets[key].sum += amt;

    // Stat counters for the dry-run report.
    var py = result.perYear[ym.year];
    py.rows++;
    py.sumTotal += amt;
    py.perMonth[ym.month] = (py.perMonth[ym.month] || 0) + amt;
    var catKey = category || '(blank)';
    py.perCategory[catKey] = (py.perCategory[catKey] || 0) + amt;
    if (isBiz) py.business++; else py.personal++;
  }

  return result;
}

// ---- WRITE SNAPSHOT TAB (idempotent) ----------------------------------

// Ensure the snapshot tab exists, has the header row, and is hidden.
// Returns the Sheet object.
function _bh_ensureHistoryTab_(newSS) {
  var hist = newSS.getSheetByName(_BH_HIST_TAB_);
  if (!hist) {
    hist = newSS.insertSheet(_BH_HIST_TAB_);
    // 5-column header (English ASCII to keep the source clean for grep).
    hist.getRange(1, 1, 1, 5).setValues([[
      'year', 'month', 'category', 'subcategory', 'sum'
    ]]);
    Logger.log('Created snapshot tab: ' + _BH_HIST_TAB_);
  }
  try { hist.hideSheet(); } catch (e) { /* already hidden or no perm */ }
  return hist;
}

// Build a map of (key -> rowIndex 1-based) for snapshot rows already on
// the tab, so APPLY can update-in-place instead of appending duplicates.
function _bh_loadExistingSnapshotIndex_(hist) {
  var idx = {};
  var lastRow = hist.getLastRow();
  if (lastRow < 2) return idx;
  var data = hist.getRange(2, 1, lastRow - 1, 5).getValues();
  for (var i = 0; i < data.length; i++) {
    var year  = parseInt(data[i][0], 10);
    var month = parseInt(data[i][1], 10);
    var cat   = String(data[i][2] || '');
    var sub   = String(data[i][3] || '');
    if (!isFinite(year) || !isFinite(month)) continue;
    var key = _bh_bucketKey_(year, month, cat, sub);
    idx[key] = i + 2;  // 1-based, +1 for header
  }
  return idx;
}

// Write (or update) the snapshot rows. Returns counts.
function _bh_writeSnapshot_(hist, buckets) {
  var existingIdx = _bh_loadExistingSnapshotIndex_(hist);

  var toAppend = [];
  var toUpdate = [];  // [{ row, sum }]
  Object.keys(buckets).forEach(function (k) {
    var b = buckets[k];
    var existingRow = existingIdx[k];
    if (existingRow) {
      toUpdate.push({ row: existingRow, sum: b.sum });
    } else {
      toAppend.push([b.year, b.month, b.category, b.subcategory, b.sum]);
    }
  });

  // Update existing rows in place (column E only -- we never overwrite
  // year/month/category/subcategory because they are the key).
  for (var u = 0; u < toUpdate.length; u++) {
    hist.getRange(toUpdate[u].row, 5).setValue(toUpdate[u].sum);
  }

  // Append new rows in a single batch.
  if (toAppend.length > 0) {
    var startRow = hist.getLastRow() + 1;
    hist.getRange(startRow, 1, toAppend.length, 5).setValues(toAppend);
  }

  return { appended: toAppend.length, updated: toUpdate.length };
}

// ---- CORE: dry-run or apply -------------------------------------------

function _bh_scanAndOptionallyApply_(applyMode) {
  Logger.log('=== KESEFLE BACKFILL HISTORICAL YEARS ' +
    (applyMode ? '-- APPLY MODE' : '-- DRY-RUN MODE') + ' ===');
  Logger.log('OLD: ' + _BH_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _BH_NEW_SHEET_ID_);
  Logger.log('Years: ' + _BH_YEARS_.join(', '));
  Logger.log('Version: ' + _BH_VERSION_);

  // Concurrent-run guard for APPLY only.
  var _bhLock = null;
  if (applyMode) {
    _bhLock = LockService.getScriptLock();
    if (!_bhLock || !_bhLock.tryLock(30000)) {
      Logger.log('!! another backfill run is in progress -- aborting');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout); concurrent runs are blocked.');
  }

  try {
    var agg = _bh_scanOldTransactions_();
    if (agg.error) return agg;

    // ---- Dry-run report -----------------------------------------------
    var bucketCount = Object.keys(agg.buckets).length;
    Logger.log('');
    Logger.log('-- aggregated buckets: ' + bucketCount + ' unique (year,month,cat,sub) --');
    Logger.log('skipped rows:');
    Logger.log('  empty:        ' + agg.skipped.empty);
    Logger.log('  no_amount:    ' + agg.skipped.no_amount);
    Logger.log('  no_year:      ' + agg.skipped.no_year);
    Logger.log('  out_of_range: ' + agg.skipped.out_of_range);

    _BH_YEARS_.forEach(function (y) {
      var py = agg.perYear[y];
      Logger.log('');
      Logger.log('-- ' + y + ' --');
      Logger.log('  rows kept:     ' + py.rows);
      Logger.log('  business:      ' + py.business);
      Logger.log('  personal:      ' + py.personal);
      Logger.log('  sum total:     ' + py.sumTotal.toFixed(2));
      Logger.log('  per month:');
      for (var m = 1; m <= 12; m++) {
        var pad = (m < 10 ? '0' : '') + m;
        Logger.log('    ' + y + '-' + pad + ': ' + (py.perMonth[m] || 0).toFixed(2));
      }
      var catKeys = Object.keys(py.perCategory).sort();
      Logger.log('  per category (' + catKeys.length + '):');
      catKeys.forEach(function (ck) {
        Logger.log('    "' + ck + '": ' + py.perCategory[ck].toFixed(2));
      });
    });

    // Sample first 5 buckets so Steven can eyeball the data.
    var sampleKeys = Object.keys(agg.buckets).slice(0, 5);
    Logger.log('');
    Logger.log('-- sample buckets (first 5) --');
    sampleKeys.forEach(function (k) {
      var b = agg.buckets[k];
      Logger.log('  ' + JSON.stringify(b));
    });

    if (!applyMode) {
      Logger.log('');
      Logger.log('=== DRY-RUN COMPLETE -- NEW sheet was NOT modified ===');
      Logger.log('To apply: run APPLY_BACKFILL_HISTORICAL_YEARS_NOW from the function dropdown.');
      return { mode: 'dry-run', buckets: bucketCount, perYear: agg.perYear, skipped: agg.skipped };
    }

    // ---- Apply --------------------------------------------------------
    Logger.log('');
    Logger.log('=== APPLYING -- writing snapshot to NEW ===');

    var newSS = _bh_openNew_();
    if (!newSS) return { error: 'cannot_open_new' };

    var hist = _bh_ensureHistoryTab_(newSS);
    var counts = _bh_writeSnapshot_(hist, agg.buckets);

    // Audit-trail note on the header cell so re-runs leave a trace.
    try {
      var nowStr = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
      var trail = _BH_VERSION_ + ': ' + nowStr +
        ' | appended=' + counts.appended + ' | updated=' + counts.updated;
      hist.getRange('A1').setNote(trail);
      Logger.log('Audit note -> snapshot A1: ' + trail);
    } catch (auditErr) {
      Logger.log('audit note err (non-fatal): ' + auditErr.message);
    }

    Logger.log('Wrote ' + counts.appended + ' new rows; updated ' + counts.updated + ' existing rows.');
    Logger.log('=== APPLY COMPLETE ===');
    Logger.log('Next: run DRY_RUN_WIRE_YEAR_HISTORY to preview the dashboard pivot.');

    return { mode: 'apply', buckets: bucketCount, appended: counts.appended, updated: counts.updated };
  } finally {
    if (_bhLock) { try { _bhLock.releaseLock(); } catch (_) { /* ignore */ } }
  }
}

// ---- PUBLIC ENTRY POINTS ----------------------------------------------

function DRY_RUN_BACKFILL_HISTORICAL_YEARS() {
  return _bh_scanAndOptionallyApply_(false);
}

function APPLY_BACKFILL_HISTORICAL_YEARS(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED -- APPLY_BACKFILL_HISTORICAL_YEARS requires the EXACT string "YES I UNDERSTAND".');
    Logger.log('   Easier: run APPLY_BACKFILL_HISTORICAL_YEARS_NOW from the function dropdown.');
    Logger.log('   ALWAYS run DRY_RUN_BACKFILL_HISTORICAL_YEARS first and review the log.');
    return { refused: true };
  }
  return _bh_scanAndOptionallyApply_(true);
}

// Apps Script function dropdown cannot pass args -- this wrapper is the
// one Steven runs after reviewing the dry-run.
function APPLY_BACKFILL_HISTORICAL_YEARS_NOW() {
  return APPLY_BACKFILL_HISTORICAL_YEARS('YES I UNDERSTAND');
}

// Read the snapshot tab and dump yearly totals so Steven can sanity-check
// the numbers landed correctly. Pure read; never writes.
function VERIFY_BACKFILL_HISTORICAL_YEARS() {
  Logger.log('=== KESEFLE BACKFILL HISTORICAL YEARS -- VERIFY (read-only) ===');
  var newSS = _bh_openNew_();
  if (!newSS) return { error: 'cannot_open_new' };
  var hist = newSS.getSheetByName(_BH_HIST_TAB_);
  if (!hist) {
    Logger.log('!! NEW has no snapshot tab yet (' + _BH_HIST_TAB_ + ')');
    Logger.log('   Run APPLY_BACKFILL_HISTORICAL_YEARS_NOW first.');
    return { error: 'no_snapshot_tab' };
  }

  var lastRow = hist.getLastRow();
  if (lastRow < 2) {
    Logger.log('Snapshot tab is empty (header only).');
    return { rows: 0 };
  }

  var data = hist.getRange(2, 1, lastRow - 1, 5).getValues();
  Logger.log('Snapshot rows: ' + data.length);

  // Per-year totals + per-(year, month) totals + per-(year, category).
  var perYear = {};
  var perYearMonth = {};
  var perYearCat = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var year  = parseInt(row[0], 10);
    var month = parseInt(row[1], 10);
    var cat   = String(row[2] || '');
    var sum   = _bh_num_(row[4]);
    if (!isFinite(year)) continue;

    perYear[year] = (perYear[year] || 0) + sum;
    var ymKey = year + '-' + (month < 10 ? '0' + month : month);
    perYearMonth[ymKey] = (perYearMonth[ymKey] || 0) + sum;
    var ycKey = year + '|' + (cat || '(blank)');
    perYearCat[ycKey] = (perYearCat[ycKey] || 0) + sum;
  }

  Logger.log('');
  Logger.log('-- per-year totals --');
  Object.keys(perYear).sort().forEach(function (y) {
    Logger.log('  ' + y + ': ' + perYear[y].toFixed(2));
  });

  Logger.log('');
  Logger.log('-- per (year, month) totals --');
  Object.keys(perYearMonth).sort().forEach(function (ym) {
    Logger.log('  ' + ym + ': ' + perYearMonth[ym].toFixed(2));
  });

  Logger.log('');
  Logger.log('-- per (year, category) totals --');
  Object.keys(perYearCat).sort().forEach(function (yc) {
    Logger.log('  ' + yc + ': ' + perYearCat[yc].toFixed(2));
  });

  return { rows: data.length, perYear: perYear };
}

// Self-test that the encoded Hebrew constants survived the paste path.
// Steven runs this once after pasting to confirm there are no bidi marks.
function _BH_SELF_TEST_HEBREW_() {
  Logger.log('tx tab:       ' + _BH_OLD_TX_TAB_);
  Logger.log('history tab:  ' + _BH_HIST_TAB_);
  Logger.log('company pref: ' + _BH_OLD_COMPANY_TAB_PREFIX_);
  Logger.log('biz marker:   ' + _BH_BUSINESS_MARKER_);
}
