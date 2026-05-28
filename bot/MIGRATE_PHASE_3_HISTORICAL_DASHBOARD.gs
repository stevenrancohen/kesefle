/**
 * bot/MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs
 *
 * Phase 3 of the Kesefle migration epic (Steven's section-23 plan).
 * One-time snapshot script that freezes the OLD `מאזן חברה` view
 * (1UKr...) as STATIC VALUES into a new `סיכום היסטורי` tab on the
 * NEW Kesefle sheet (1rti...). This is a frozen reference so the
 * Phase 5 dashboard rebuild cannot lose history if formulas break.
 *
 * Two entry points (same pattern as Phase 2 MIGRATE_OLD_TO_KESEFLE.gs):
 *   DRY_RUN_PHASE3()                  — scan only, NO writes. Logs counts
 *                                       + dedupe plan + sample of frozen
 *                                       rows so Steven can verify layout.
 *   APPLY_PHASE3_NOW()                — zero-arg wrapper that calls
 *                                       APPLY_PHASE3('YES I UNDERSTAND')
 *                                       so it runs from the function
 *                                       dropdown.
 *   APPLY_PHASE3('YES I UNDERSTAND')  — actual write. Refuses without arg.
 *
 * Per the verify-data-sources-before-formula-repair skill:
 *   - Read every source row before deciding to snapshot
 *   - Compute deterministic dedupe key per (year, label, row-index)
 *   - Skip rows already present in NEW סיכום היסטורי (idempotent)
 *   - Report EVERY decision in the dry-run log
 *   - APPLY refuses without literal "YES I UNDERSTAND" arg
 *   - Writes audit-trail note to A1 of NEW סיכום היסטורי tab
 *
 * Year-block row map (from FIX_DASHBOARD_2023_2024_2025.gs):
 *   2026 = rows  1-13
 *   2025 = rows 14-25
 *   2024 = rows 26-37
 *   2023 = rows 38-49
 *
 * Captured columns: A-O (label + 12 months + total + extras) for rows 1-50.
 *
 * Rollback: nothing in this script DELETES rows. To undo, filter NEW
 * סיכום היסטורי by 'Migration_Phase_3' in the source col and delete those rows.
 */

var _MIG3_OLD_SHEET_ID_  = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MIG3_NEW_SHEET_ID_  = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MIG3_OLD_COMPANY_TAB_ = 'מאזן חברה';
var _MIG3_NEW_SNAPSHOT_TAB_ = 'סיכום היסטורי';
var _MIG3_VERSION_       = 'Migration_Phase_3_v1';

// Read rows 1-50, cols A-O (15 cols: label + 12 months + total + 1 extra).
var _MIG3_ROW_START_ = 1;
var _MIG3_ROW_END_   = 50;
var _MIG3_COL_START_ = 1;   // A
var _MIG3_COL_END_   = 15;  // O

// Year-block row map (same as FIX_DASHBOARD_2023_2024_2025.gs)
var _MIG3_YEAR_BLOCKS_ = {
  '2026': { startRow:  1, endRow: 13 },
  '2025': { startRow: 14, endRow: 25 },
  '2024': { startRow: 26, endRow: 37 },
  '2023': { startRow: 38, endRow: 49 }
};

// Build deterministic dedupe key for a snapshot row.
// Schema written to NEW: [sourceRow, year, label, m1..m12, total, extra,
//                         migrationVersion, capturedAt]
// We dedupe on (sourceRow, year, label) — if Steven re-runs after editing
// OLD, the same OLD row will not be double-snapshotted.
function _mig3_snapKey_(sourceRow, year, label) {
  return [String(sourceRow), String(year || ''), String(label || '').slice(0, 80)].join('|');
}

// Map an OLD row index (1-based) to its year per _MIG3_YEAR_BLOCKS_.
// Returns null if the row is outside any year block (header rows etc).
function _mig3_yearForRow_(sourceRow) {
  var keys = Object.keys(_MIG3_YEAR_BLOCKS_);
  for (var i = 0; i < keys.length; i++) {
    var yr = keys[i];
    var blk = _MIG3_YEAR_BLOCKS_[yr];
    if (sourceRow >= blk.startRow && sourceRow <= blk.endRow) return yr;
  }
  return null;
}

// Ensure the destination snapshot tab exists. APPEND-ONLY semantics —
// if the tab is missing in APPLY mode we create it with a header row.
// In dry-run we report whether it exists but never create.
function _mig3_ensureSnapshotTab_(newSS, applyMode) {
  var tab = newSS.getSheetByName(_MIG3_NEW_SNAPSHOT_TAB_);
  if (tab) return tab;
  if (!applyMode) return null; // dry-run: do not create
  tab = newSS.insertSheet(_MIG3_NEW_SNAPSHOT_TAB_);
  // 19-column header to match the row schema
  var header = [
    'מקור שורה',     // A: source row index in OLD מאזן חברה
    'שנה',           // B: year
    'תווית',         // C: label (col A from OLD)
    'ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יונ',
    'יול', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ',
    'סה"כ',          // P: total (col N from OLD)
    'נוסף',          // Q: extra (col O from OLD)
    'גרסת מיגרציה',  // R: migration version tag
    'נלכד ב'         // S: captured-at timestamp
  ];
  tab.getRange(1, 1, 1, header.length).setValues([header]);
  tab.setFrozenRows(1);
  return tab;
}

// Core scanner. applyMode=false → dry-run. applyMode=true → write to NEW.
function _mig3_scanAndOptionallyApply_(applyMode) {
  Logger.log('=== KESEFLE PHASE 3 ' + (applyMode ? '— APPLY MODE' : '— DRY-RUN MODE') + ' ===');
  Logger.log('OLD: ' + _MIG3_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _MIG3_NEW_SHEET_ID_);
  Logger.log('Version: ' + _MIG3_VERSION_);
  Logger.log('Source: OLD "' + _MIG3_OLD_COMPANY_TAB_ + '" rows ' + _MIG3_ROW_START_ + '-' + _MIG3_ROW_END_ + ' cols A-O');
  Logger.log('Destination: NEW "' + _MIG3_NEW_SNAPSHOT_TAB_ + '" (static values, no formulas)');

  // Concurrent-run guard. Even though dedupe makes re-runs idempotent,
  // two simultaneous APPLY runs could BOTH see the same OLD rows as "not
  // in NEW yet" and both write them. The lock serializes the critical
  // section.
  //
  // Use getScriptLock (not getDocumentLock) — the bot's Apps Script is a
  // standalone project, not container-bound. getDocumentLock() returns
  // null for standalone scripts.
  var _migLock = null;
  if (applyMode) {
    _migLock = LockService.getScriptLock();
    if (!_migLock || !_migLock.tryLock(30000)) {
      Logger.log('!! Another Phase 3 run is in progress — aborting (try again in a minute)');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout); concurrent runs are blocked.');
  }

  // ── Open both sheets ──
  var oldSS, newSS;
  try { oldSS = SpreadsheetApp.openById(_MIG3_OLD_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open OLD: ' + e.message); return { error: 'cannot_open_old' }; }
  try { newSS = SpreadsheetApp.openById(_MIG3_NEW_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open NEW: ' + e.message); return { error: 'cannot_open_new' }; }

  Logger.log('OLD name: "' + oldSS.getName() + '"');
  Logger.log('NEW name: "' + newSS.getName() + '"');

  // ── Ensure NEW snapshot tab exists (only create in APPLY mode) ──
  var snapTab = _mig3_ensureSnapshotTab_(newSS, applyMode);
  if (!snapTab && applyMode) {
    Logger.log('!! Could not create or open NEW סיכום היסטורי tab');
    if (_migLock) { try { _migLock.releaseLock(); } catch (_e) {} }
    return { error: 'no_snapshot_tab' };
  }
  Logger.log('NEW סיכום היסטורי tab: ' + (snapTab ? 'present' : 'absent (will be created on APPLY)'));

  // ── Build existing-key set in NEW snapshot tab (for dedupe) ──
  var existingSnapKeys = {};
  if (snapTab) {
    var snapLastRow = snapTab.getLastRow();
    if (snapLastRow > 1) {
      // Cols A=sourceRow, B=year, C=label — that's enough for the key
      var snapData = snapTab.getRange(2, 1, snapLastRow - 1, 3).getValues();
      for (var i = 0; i < snapData.length; i++) {
        var r = snapData[i];
        existingSnapKeys[_mig3_snapKey_(r[0], r[1], r[2])] = true;
      }
    }
    Logger.log('NEW סיכום היסטורי: ' + Math.max(0, snapTab.getLastRow() - 1) + ' existing rows, ' + Object.keys(existingSnapKeys).length + ' unique keys.');
  }

  // ── Read OLD מאזן חברה rows 1-50, cols A-O ──
  var oldCompany = oldSS.getSheetByName(_MIG3_OLD_COMPANY_TAB_);
  if (!oldCompany) {
    Logger.log('!! OLD has no ' + _MIG3_OLD_COMPANY_TAB_ + ' tab');
    if (_migLock) { try { _migLock.releaseLock(); } catch (_e) {} }
    return { error: 'no_old_company_tab' };
  }
  var oldLastRow = oldCompany.getLastRow();
  var oldLastCol = oldCompany.getLastColumn();
  var captureEndRow = Math.min(_MIG3_ROW_END_, oldLastRow);
  var captureEndCol = Math.min(_MIG3_COL_END_, oldLastCol);
  Logger.log('\n-- OLD מאזן חברה: ' + oldLastRow + ' rows x ' + oldLastCol + ' cols --');
  Logger.log('Capturing rows ' + _MIG3_ROW_START_ + '-' + captureEndRow + ' cols A-' + String.fromCharCode(64 + captureEndCol));

  if (captureEndRow < _MIG3_ROW_START_) {
    Logger.log('!! OLD מאזן חברה has fewer rows than expected (' + oldLastRow + ' < ' + _MIG3_ROW_START_ + ')');
    if (_migLock) { try { _migLock.releaseLock(); } catch (_e) {} }
    return { error: 'old_sheet_too_short' };
  }

  var sourceData = oldCompany.getRange(
    _MIG3_ROW_START_, _MIG3_COL_START_,
    captureEndRow - _MIG3_ROW_START_ + 1,
    captureEndCol - _MIG3_COL_START_ + 1
  ).getValues();

  // Dump first 3 RAW rows so Steven can verify the assumed col layout
  // (col A = label, cols B-M = 12 months, N = total, O = extras). If
  // the layout shifted in the real OLD sheet, the dry-run log shows it
  // and we abort before APPLY.
  Logger.log('Raw sample of OLD מאזן חברה A-O (first 3 rows, for layout verification):');
  for (var rs = 0; rs < Math.min(3, sourceData.length); rs++) {
    Logger.log('  row ' + (rs + 1) + ': ' + JSON.stringify(sourceData[rs]).slice(0, 300));
  }

  // ── Build the snapshot rows to write ──
  var snapToWrite = [];
  var snapSkipped = { duplicate: 0, empty: 0, no_year: 0 };
  var perYearCount = { '2023': 0, '2024': 0, '2025': 0, '2026': 0, 'other': 0 };
  var capturedAt = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');

  for (var r = 0; r < sourceData.length; r++) {
    var srcRow = _MIG3_ROW_START_ + r;
    var row = sourceData[r];
    var label = row[0];
    var isFullyEmpty = true;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { isFullyEmpty = false; break; }
    }
    if (isFullyEmpty) { snapSkipped.empty++; continue; }

    var year = _mig3_yearForRow_(srcRow);
    if (!year) { snapSkipped.no_year++; perYearCount.other++; continue; }

    var key = _mig3_snapKey_(srcRow, year, label);
    if (existingSnapKeys[key]) { snapSkipped.duplicate++; continue; }

    // Build a 15-element value slice padded to col O; then prepend
    // [srcRow, year, label] header and append [version, capturedAt].
    // Final schema (19 cols):
    //   A: sourceRow  (number)
    //   B: year       (string)
    //   C: label      (string from OLD col A)
    //   D-O: 12 months (m1..m12 from OLD cols B-M)
    //   P: total      (from OLD col N)
    //   Q: extra      (from OLD col O)
    //   R: version    (Migration_Phase_3_v1)
    //   S: capturedAt (string yyyy-MM-dd HH:mm)
    var monthVals = [];
    for (var mc = 1; mc <= 12; mc++) {
      monthVals.push(mc < row.length ? row[mc] : '');
    }
    var totalVal = row.length > 13 ? row[13] : '';
    var extraVal = row.length > 14 ? row[14] : '';

    var snapRow = [srcRow, year, String(label || '')]
      .concat(monthVals)
      .concat([totalVal, extraVal, _MIG3_VERSION_, capturedAt]);

    snapToWrite.push(snapRow);
    existingSnapKeys[key] = true;
    perYearCount[year]++;
  }

  Logger.log('\nSnapshot plan:');
  Logger.log('  → to snapshot: ' + snapToWrite.length);
  Logger.log('  skipped (already in NEW): ' + snapSkipped.duplicate);
  Logger.log('  skipped (empty row): ' + snapSkipped.empty);
  Logger.log('  skipped (no year block): ' + snapSkipped.no_year);
  Logger.log('Per-year counts:');
  Logger.log('  2023: ' + perYearCount['2023']);
  Logger.log('  2024: ' + perYearCount['2024']);
  Logger.log('  2025: ' + perYearCount['2025']);
  Logger.log('  2026: ' + perYearCount['2026']);
  Logger.log('  other (out-of-block): ' + perYearCount.other);
  Logger.log('Sample (first 5 snapshot rows to write):');
  for (var sm = 0; sm < Math.min(5, snapToWrite.length); sm++) {
    Logger.log('  ' + JSON.stringify(snapToWrite[sm]).slice(0, 300));
  }

  // ── APPLY mode: actually write to NEW ──
  if (applyMode) {
    Logger.log('\n=== APPLYING — writing to NEW סיכום היסטורי ===');

    if (snapToWrite.length > 0) {
      var startRow = snapTab.getLastRow() + 1;
      var colCount = snapToWrite[0].length;
      snapTab.getRange(startRow, 1, snapToWrite.length, colCount).setValues(snapToWrite);
      Logger.log('Wrote ' + snapToWrite.length + ' snapshot rows to NEW סיכום היסטורי (starting at row ' + startRow + ', ' + colCount + ' cols).');
    } else {
      Logger.log('No new snapshot rows to write (all already present or skipped).');
    }

    // Audit trail
    try {
      var trail = _MIG3_VERSION_ + ': ' + capturedAt + ' | Snapshots=' + snapToWrite.length +
        ' | 2023=' + perYearCount['2023'] +
        ' | 2024=' + perYearCount['2024'] +
        ' | 2025=' + perYearCount['2025'] +
        ' | 2026=' + perYearCount['2026'];
      snapTab.getRange('A1').setNote(trail);
      Logger.log('Audit trail note → NEW סיכום היסטורי A1: ' + trail);
    } catch (auditErr) { Logger.log('audit note err (non-fatal): ' + auditErr.message); }

    Logger.log('=== APPLY COMPLETE ===');
    Logger.log('Refresh NEW sheet (Cmd+R) to see the סיכום היסטורי tab.');
  } else {
    Logger.log('\n=== DRY-RUN COMPLETE — your sheet was NOT modified ===');
    Logger.log('To apply: run APPLY_PHASE3_NOW (zero-arg wrapper).');
  }

  // Release the lock if we held it (APPLY mode only)
  if (_migLock) {
    try { _migLock.releaseLock(); } catch (_lockErr) { /* ignore */ }
  }

  return {
    snapshot: { toWrite: snapToWrite.length, skipped: snapSkipped, perYear: perYearCount }
  };
}

// ─── PUBLIC ENTRY POINTS ─────────────────────────────────────────────────

function DRY_RUN_PHASE3() {
  return _mig3_scanAndOptionallyApply_(false);
}

function APPLY_PHASE3(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED — APPLY_PHASE3 requires the EXACT string "YES I UNDERSTAND" as the argument.');
    Logger.log('   Easier: run APPLY_PHASE3_NOW from the function dropdown (no arg needed).');
    Logger.log('   First always run DRY_RUN_PHASE3() and review the log.');
    return { refused: true };
  }
  return _mig3_scanAndOptionallyApply_(true);
}

// Apps Script function dropdown can't pass arguments. This zero-arg wrapper
// makes APPLY_PHASE3 runnable from the dropdown. Same safety: passes the
// literal confirmation string internally.
function APPLY_PHASE3_NOW() {
  return APPLY_PHASE3('YES I UNDERSTAND');
}
