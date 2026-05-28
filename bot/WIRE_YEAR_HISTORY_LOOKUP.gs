/**
 * bot/WIRE_YEAR_HISTORY_LOOKUP.gs
 *
 * Phase 9b of the Kesefle migration epic. Companion to
 * BACKFILL_HISTORICAL_YEARS.gs.
 *
 * Wraps every SUMIFS / SUMPRODUCT formula in "mazan ishi" (personal
 * dashboard) and "mazan chevra" (company dashboard) that pulls from the
 * raw "tnuot" transactions tab with an IFS() switch on $B$4 (the
 * year-selector dropdown PR #127 installed):
 *
 *   = IFS(
 *       $B$4 = YEAR(TODAY()), <original LIVE formula>,
 *       TRUE,                 SUMIFS(snapshot!E:E,
 *                                    snapshot!A:A, $B$4,
 *                                    snapshot!B:B, <month>,
 *                                    snapshot!C:C, "<category>",
 *                                    snapshot!D:D, "<subcategory>")
 *     )
 *
 * "snapshot" above is the "sikum histori" tab that BACKFILL_HISTORICAL_YEARS
 * writes (5 cols: year, month, category, subcategory, sum).
 *
 * <month> + <category> + <subcategory> for each cell are derived from
 * the row's col-A LABEL (which carries the row's category +
 * subcategory) and the column-header month (col B = annual, cols C..N
 * = Jan..Dec). The label parser is generous: it splits on common
 * separators and reads "category | subcategory" or
 * "category - subcategory" formats. If a row has no parseable label
 * the historical fallback emits SUMIFS with an empty subcategory
 * criterion (which matches snapshot rows where col D is empty).
 *
 * Three public entry points:
 *   DRY_RUN_WIRE_YEAR_HISTORY()
 *     scan only, NO writes. Logs every wrap proposal.
 *
 *   APPLY_WIRE_YEAR_HISTORY('YES I UNDERSTAND')
 *     gated write. Backs up each old formula to DocumentProperties
 *     before writing the wrapped form. Skips cells whose formula
 *     does NOT reference the transactions tab. Skips cells already
 *     wrapped (idempotent).
 *
 *   APPLY_WIRE_YEAR_HISTORY_NOW()
 *     zero-arg wrapper for the function dropdown.
 *
 *   UNDO_WIRE_YEAR_HISTORY()
 *     restore the original formulas from DocumentProperties backups.
 *
 * Per Steven's iron rules:
 *   - Backup-first: ALWAYS write to DocumentProperties before changing
 *     a cell. Keys are unique per (sheet, row, col).
 *   - Propose-before-apply: DRY_RUN is the propose phase.
 *   - Never overwrite user values: only cells whose CURRENT formula
 *     references the transactions tab get wrapped. Literal numbers,
 *     plain-SUM formulas, and already-wrapped cells are left alone.
 *   - YES I UNDERSTAND gate (matches MIGRATE_OLD_TO_KESEFLE.gs).
 *   - LockService.getScriptLock guards APPLY.
 *
 * Encoding rule:
 *   Every Hebrew literal is a backslash-u escape. The file has zero
 *   raw Hebrew bytes. Verify with
 *     grep -cP '[\x{0590}-\x{05FF}]' bot/WIRE_YEAR_HISTORY_LOOKUP.gs
 *   which should return 0.
 */

// ---- CONFIGURE ---------------------------------------------------------

var _WY_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Hebrew tab names. Encoded so paste cannot mangle.
// "mazan ishi"   -- personal dashboard tab.
var _WY_PERSONAL_TAB_ =
  '\u05DE\u05D0\u05D6\u05DF \u05D0\u05D9\u05E9\u05D9';
// "mazan chevra" -- company dashboard tab.
var _WY_COMPANY_TAB_  =
  '\u05DE\u05D0\u05D6\u05DF \u05D7\u05D1\u05E8\u05D4';
// "sikum histori" -- snapshot tab written by BACKFILL_HISTORICAL_YEARS.
var _WY_HISTORY_TAB_  =
  '\u05E1\u05D9\u05DB\u05D5\u05DD \u05D4\u05D9\u05E1\u05D8\u05D5\u05E8\u05D9';
// "tnuot" -- transactions tab (the LIVE source we are detecting in
// existing formulas).
var _WY_TX_TAB_       =
  '\u05EA\u05E0\u05D5\u05E2\u05D5\u05EA';

var _WY_VERSION_      = 'WireYearHistory_v1';

// Scan window. The company dashboard year-blocks span rows 6..49 per
// MIGRATE_PHASE_5_VERIFY_FORMULAS.gs. The personal dashboard is
// shorter -- we scan rows 1..60 cols A..N to cover everything safely
// without iterating empty cells beyond that.
var _WY_SCAN_MAX_ROW_ = 60;
var _WY_SCAN_MAX_COL_ = 14;  // A..N

// Tabs to wire. Personal first, company second.
var _WY_TARGET_TABS_  = [
  { name: _WY_PERSONAL_TAB_, slug: 'personal' },
  { name: _WY_COMPANY_TAB_,  slug: 'company'  }
];

// ---- HELPERS -----------------------------------------------------------

function _wy_openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act && act.getId && act.getId() === _WY_SHEET_ID_) return act;
  } catch (e) { /* fall through */ }
  return SpreadsheetApp.openById(_WY_SHEET_ID_);
}

// DocumentProperties key for a backed-up formula. Slug avoids collisions
// between personal + company tabs.
function _wy_backupKey_(slug, row, col) {
  return 'yearhist_backup_' + slug + '_' + row + '_' + col;
}

// Detect a wrapped cell so re-runs are idempotent. We embed the
// IFS($B$4=YEAR(TODAY()), ... ) head so a substring check is enough.
var _WY_WRAP_HEAD_ = 'IFS($B$4=YEAR(TODAY())';

function _wy_isAlreadyWrapped_(formula) {
  return !!(formula && formula.indexOf(_WY_WRAP_HEAD_) !== -1);
}

// Does this formula pull from the transactions tab? We accept both
//   ='tnuot'!A:A   and   =tnuot!A:A   forms.
function _wy_referencesTxTab_(formula) {
  if (!formula || typeof formula !== 'string') return false;
  if (formula.indexOf("'" + _WY_TX_TAB_ + "'") !== -1) return true;
  if (formula.indexOf(_WY_TX_TAB_) !== -1) return true;
  return false;
}

// Pull "category" + "subcategory" out of the row's col-A label. Labels
// in the tenant template look like:
//   "category | subcategory"
//   "category - subcategory"
//   "category"
//   plain category string with no separator
// Returns { category, subcategory } where either may be empty string.
function _wy_parseLabel_(label) {
  var s = String(label || '').trim();
  if (!s) return { category: '', subcategory: '' };

  // Try pipe first, then dash. We split only on the FIRST separator so
  // subcategories that themselves contain a dash stay intact.
  var parts;
  if (s.indexOf('|') !== -1) {
    parts = s.split('|');
  } else if (s.indexOf(' - ') !== -1) {
    parts = s.split(' - ');
  } else {
    parts = [s];
  }
  var cat = String(parts[0] || '').trim();
  var sub = parts.length > 1 ? String(parts.slice(1).join(' - ')).trim() : '';
  return { category: cat, subcategory: sub };
}

// Map a 1-based column index to its month criterion for the SUMIFS:
//   col B (idx 2) -> "annual" (no month filter)
//   col C (idx 3) -> 1 (Jan)
//   ...
//   col N (idx 14) -> 12 (Dec)
// Returns null for "annual" so the caller drops the month criterion.
function _wy_colMonth_(colIdx) {
  if (colIdx === 2) return null;   // annual / B column
  if (colIdx >= 3 && colIdx <= 14) return colIdx - 2;
  return null;
}

// Escape a string for use as a SUMIFS criterion literal in a Google
// Sheets formula. We double any double-quote.
function _wy_escapeCriterion_(s) {
  return String(s || '').replace(/"/g, '""');
}

// Build the historical-branch SUMIFS for a cell. month=null means
// "all months for that year" (annual column).
function _wy_buildHistoricalSumifs_(month, category, subcategory) {
  var hist = "'" + _WY_HISTORY_TAB_ + "'";
  var parts = [
    hist + '!E:E',
    hist + '!A:A', '$B$4',
    hist + '!C:C', '"' + _wy_escapeCriterion_(category) + '"',
    hist + '!D:D', '"' + _wy_escapeCriterion_(subcategory) + '"'
  ];
  if (month !== null) {
    // Insert month criterion right after the year one for readability.
    parts = [
      hist + '!E:E',
      hist + '!A:A', '$B$4',
      hist + '!B:B', String(month),
      hist + '!C:C', '"' + _wy_escapeCriterion_(category) + '"',
      hist + '!D:D', '"' + _wy_escapeCriterion_(subcategory) + '"'
    ];
  }
  return 'SUMIFS(' + parts.join(', ') + ')';
}

// Build the wrapped IFS() formula. liveFormula keeps its original "=".
// Returns a formula string starting with "=".
function _wy_buildWrappedFormula_(liveFormula, month, category, subcategory) {
  // Strip leading "=" so we can embed in the IFS branches.
  var live = liveFormula;
  if (typeof live === 'string' && live.charAt(0) === '=') {
    live = live.substring(1);
  }
  var hist = _wy_buildHistoricalSumifs_(month, category, subcategory);
  return '=IFS($B$4=YEAR(TODAY()), (' + live + '), TRUE, (' + hist + '))';
}

// ---- SCAN -------------------------------------------------------------

// Returns an array of { sheetName, slug, row, col, label, month,
// category, subcategory, current, wrapped, action }.
//   action is one of:
//     'wrap'              -- new wrap to apply
//     'skip_no_tx'        -- formula does not reference tnuot, leave alone
//     'skip_wrapped'      -- formula already wrapped
//     'skip_no_formula'   -- cell holds a literal (or is empty)
function _wy_scanTab_(ss, target) {
  var sheet = ss.getSheetByName(target.name);
  if (!sheet) {
    Logger.log('!! tab missing: ' + target.name + ' -- skipping');
    return [];
  }

  var maxRow = Math.min(sheet.getLastRow(), _WY_SCAN_MAX_ROW_);
  var maxCol = Math.min(sheet.getLastColumn(), _WY_SCAN_MAX_COL_);
  if (maxRow < 2 || maxCol < 2) return [];

  // Batched reads: col A labels for every row, plus the whole grid B..N
  // formulas. Saves API roundtrips vs. reading each cell.
  var labels = sheet.getRange(1, 1, maxRow, 1).getValues();
  var formulas = sheet.getRange(1, 1, maxRow, maxCol).getFormulas();

  var proposals = [];
  for (var r = 1; r <= maxRow; r++) {
    var rawLabel = labels[r - 1][0];
    var parsed = _wy_parseLabel_(rawLabel);
    if (!parsed.category) continue;  // rows without a category label = headers/totals/etc.

    for (var c = 2; c <= maxCol; c++) {
      var f = formulas[r - 1][c - 1];
      if (!f) {
        proposals.push({
          sheetName: target.name, slug: target.slug,
          row: r, col: c, label: rawLabel,
          month: _wy_colMonth_(c),
          category: parsed.category, subcategory: parsed.subcategory,
          current: '', wrapped: null, action: 'skip_no_formula'
        });
        continue;
      }
      if (_wy_isAlreadyWrapped_(f)) {
        proposals.push({
          sheetName: target.name, slug: target.slug,
          row: r, col: c, label: rawLabel,
          month: _wy_colMonth_(c),
          category: parsed.category, subcategory: parsed.subcategory,
          current: f, wrapped: null, action: 'skip_wrapped'
        });
        continue;
      }
      if (!_wy_referencesTxTab_(f)) {
        proposals.push({
          sheetName: target.name, slug: target.slug,
          row: r, col: c, label: rawLabel,
          month: _wy_colMonth_(c),
          category: parsed.category, subcategory: parsed.subcategory,
          current: f, wrapped: null, action: 'skip_no_tx'
        });
        continue;
      }

      var month = _wy_colMonth_(c);
      var wrapped = _wy_buildWrappedFormula_(f, month, parsed.category, parsed.subcategory);
      proposals.push({
        sheetName: target.name, slug: target.slug,
        row: r, col: c, label: rawLabel,
        month: month,
        category: parsed.category, subcategory: parsed.subcategory,
        current: f, wrapped: wrapped, action: 'wrap'
      });
    }
  }
  return proposals;
}

// ---- PUBLIC: DRY RUN --------------------------------------------------

function DRY_RUN_WIRE_YEAR_HISTORY() {
  Logger.log('=== KESEFLE WIRE YEAR HISTORY -- DRY RUN (' + _WY_VERSION_ + ') ===');
  Logger.log('Sheet: ' + _WY_SHEET_ID_);
  Logger.log('History tab (must exist before APPLY): ' + _WY_HISTORY_TAB_);

  var ss;
  try { ss = _wy_openSheet_(); }
  catch (e) { Logger.log('!! cannot open NEW: ' + e.message); return { error: 'cannot_open_new' }; }

  var hist = ss.getSheetByName(_WY_HISTORY_TAB_);
  if (!hist) {
    Logger.log('!! snapshot tab missing -- run APPLY_BACKFILL_HISTORICAL_YEARS_NOW first.');
    Logger.log('   DRY RUN will still preview the wraps but APPLY will refuse to wire.');
  } else {
    Logger.log('OK snapshot tab present: ' + hist.getLastRow() + ' rows');
  }

  var allProposals = [];
  _WY_TARGET_TABS_.forEach(function (tgt) {
    Logger.log('');
    Logger.log('-- scanning tab: ' + tgt.name + ' (' + tgt.slug + ') --');
    var proposals = _wy_scanTab_(ss, tgt);
    allProposals = allProposals.concat(proposals);

    var counts = { wrap: 0, skip_no_tx: 0, skip_wrapped: 0, skip_no_formula: 0 };
    proposals.forEach(function (p) { counts[p.action] = (counts[p.action] || 0) + 1; });
    Logger.log('  proposals: wrap=' + counts.wrap +
      ' | skip_no_tx=' + counts.skip_no_tx +
      ' | skip_wrapped=' + counts.skip_wrapped +
      ' | skip_no_formula=' + counts.skip_no_formula);

    // Show every wrap proposal so Steven can review before APPLY.
    var wraps = proposals.filter(function (p) { return p.action === 'wrap'; });
    if (wraps.length > 0) {
      Logger.log('  -- wrap proposals --');
      wraps.forEach(function (p) {
        var colLetter = String.fromCharCode(64 + p.col);
        Logger.log('    ' + colLetter + p.row + '  cat="' + p.category + '" sub="' + p.subcategory +
          '" month=' + (p.month === null ? 'annual' : p.month));
        Logger.log('      BEFORE: ' + p.current);
        Logger.log('      AFTER : ' + p.wrapped);
      });
    }
  });

  var total = allProposals.filter(function (p) { return p.action === 'wrap'; }).length;
  Logger.log('');
  Logger.log('=== DRY-RUN COMPLETE -- sheet was NOT modified ===');
  Logger.log('Total wraps proposed: ' + total);
  Logger.log('To apply: run APPLY_WIRE_YEAR_HISTORY_NOW from the function dropdown.');
  return { mode: 'dry-run', proposals: allProposals.length, wraps: total };
}

// ---- PUBLIC: APPLY ----------------------------------------------------

function APPLY_WIRE_YEAR_HISTORY(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED -- APPLY_WIRE_YEAR_HISTORY requires the EXACT string "YES I UNDERSTAND".');
    Logger.log('   Easier: run APPLY_WIRE_YEAR_HISTORY_NOW from the function dropdown.');
    Logger.log('   ALWAYS run DRY_RUN_WIRE_YEAR_HISTORY first and review the log.');
    return { refused: true };
  }

  var lock = LockService.getScriptLock();
  if (!lock || !lock.tryLock(30000)) {
    Logger.log('!! could not acquire script lock -- abort');
    return { error: 'lock_held' };
  }

  try {
    Logger.log('=== KESEFLE WIRE YEAR HISTORY -- APPLY (' + _WY_VERSION_ + ') ===');
    var ss = _wy_openSheet_();

    var hist = ss.getSheetByName(_WY_HISTORY_TAB_);
    if (!hist) {
      Logger.log('!! snapshot tab missing (' + _WY_HISTORY_TAB_ + ')');
      Logger.log('   Run APPLY_BACKFILL_HISTORICAL_YEARS_NOW first.');
      return { error: 'no_snapshot_tab' };
    }

    var docProps = PropertiesService.getDocumentProperties();
    var totalApplied = 0;
    var totalSkipped = 0;

    _WY_TARGET_TABS_.forEach(function (tgt) {
      var sheet = ss.getSheetByName(tgt.name);
      if (!sheet) { Logger.log('!! tab missing: ' + tgt.name); return; }

      Logger.log('');
      Logger.log('-- applying to tab: ' + tgt.name + ' (' + tgt.slug + ') --');
      var proposals = _wy_scanTab_(ss, tgt);

      // Group wraps by row so we can batch setFormulas per row.
      var wraps = proposals.filter(function (p) { return p.action === 'wrap'; });
      if (wraps.length === 0) {
        Logger.log('  no wraps needed');
        return;
      }

      // Backup every cell we are about to change.
      wraps.forEach(function (p) {
        var key = _wy_backupKey_(tgt.slug, p.row, p.col);
        // Only back up if not already backed up -- never clobber a
        // previous backup with a subsequent run's (possibly already
        // wrapped) formula. Idempotent backups protect UNDO.
        var existing = docProps.getProperty(key);
        if (!existing) {
          docProps.setProperty(key, p.current);
        }
      });

      // Apply wraps cell-by-cell. We avoid batching writes because the
      // wraps may be sparse across columns and setFormula is the
      // simplest correct path.
      wraps.forEach(function (p) {
        sheet.getRange(p.row, p.col).setFormula(p.wrapped);
      });

      Logger.log('  wrapped: ' + wraps.length + ' cell(s)');
      totalApplied += wraps.length;
      totalSkipped += proposals.length - wraps.length;
    });

    // Audit-trail property so we can verify last-run from outside.
    var nowStr = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
    docProps.setProperty('yearhist_last_apply',
      _WY_VERSION_ + ' | ' + nowStr + ' | wrapped=' + totalApplied);

    SpreadsheetApp.flush();
    Logger.log('');
    Logger.log('=== APPLY COMPLETE ===');
    Logger.log('Total wraps applied: ' + totalApplied);
    Logger.log('Skipped (not tx, already wrapped, or no formula): ' + totalSkipped);
    Logger.log('Backups: DocumentProperties under "yearhist_backup_*" keys.');
    Logger.log('To revert: run UNDO_WIRE_YEAR_HISTORY.');

    return { mode: 'apply', applied: totalApplied, skipped: totalSkipped };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* ignore */ }
  }
}

function APPLY_WIRE_YEAR_HISTORY_NOW() {
  return APPLY_WIRE_YEAR_HISTORY('YES I UNDERSTAND');
}

// ---- PUBLIC: UNDO -----------------------------------------------------

function UNDO_WIRE_YEAR_HISTORY() {
  var lock = LockService.getScriptLock();
  if (!lock || !lock.tryLock(30000)) {
    Logger.log('!! could not acquire script lock -- abort');
    return { error: 'lock_held' };
  }
  try {
    Logger.log('=== KESEFLE WIRE YEAR HISTORY -- UNDO ===');
    var ss = _wy_openSheet_();
    var docProps = PropertiesService.getDocumentProperties();
    var props = docProps.getProperties();
    var keys = Object.keys(props).filter(function (k) {
      return k.indexOf('yearhist_backup_') === 0;
    });
    if (keys.length === 0) {
      Logger.log('No backups found -- nothing to undo.');
      return { restored: 0 };
    }

    var restored = 0;
    var byTab = { personal: 0, company: 0 };

    keys.forEach(function (k) {
      // key format: yearhist_backup_<slug>_<row>_<col>
      var m = k.match(/^yearhist_backup_([^_]+)_(\d+)_(\d+)$/);
      if (!m) {
        Logger.log('  ?? unrecognized backup key: ' + k);
        return;
      }
      var slug = m[1];
      var row  = parseInt(m[2], 10);
      var col  = parseInt(m[3], 10);
      var tabName = slug === 'personal' ? _WY_PERSONAL_TAB_
                  : slug === 'company'  ? _WY_COMPANY_TAB_
                  : null;
      if (!tabName) {
        Logger.log('  ?? unknown slug: ' + slug);
        return;
      }
      var sheet = ss.getSheetByName(tabName);
      if (!sheet) {
        Logger.log('  ?? tab missing on undo: ' + tabName);
        return;
      }
      var original = props[k];
      if (typeof original === 'string' && original.length > 0) {
        sheet.getRange(row, col).setFormula(original);
      } else {
        // Backup was an empty string -- clear the cell's formula.
        sheet.getRange(row, col).setFormula('');
      }
      docProps.deleteProperty(k);
      restored++;
      byTab[slug] = (byTab[slug] || 0) + 1;
    });

    SpreadsheetApp.flush();
    Logger.log('Restored ' + restored + ' cell(s)');
    Logger.log('  personal: ' + (byTab.personal || 0));
    Logger.log('  company:  ' + (byTab.company  || 0));
    Logger.log('All "yearhist_backup_*" keys cleared from DocumentProperties.');
    return { mode: 'undo', restored: restored, byTab: byTab };
  } finally {
    try { lock.releaseLock(); } catch (_) { /* ignore */ }
  }
}

// Self-test that the encoded Hebrew constants survived the paste path.
// Steven runs this once after pasting to confirm there are no bidi marks.
function _WY_SELF_TEST_HEBREW_() {
  Logger.log('personal tab: ' + _WY_PERSONAL_TAB_);
  Logger.log('company tab:  ' + _WY_COMPANY_TAB_);
  Logger.log('history tab:  ' + _WY_HISTORY_TAB_);
  Logger.log('tx tab:       ' + _WY_TX_TAB_);
}
