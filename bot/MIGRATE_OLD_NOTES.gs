/**
 * bot/MIGRATE_OLD_NOTES.gs
 *
 * One-shot migration that copies cell NOTES from the OLD sheet (1UKr...)
 * to the corresponding cells in the NEW Kesefle sheet (1rti...). Steven
 * flagged that the Phase 2 migration (PR #120) moved row VALUES but did
 * NOT move the historical notes/comments Steven and his wife attached
 * to specific transactions in OLD over years of use.
 *
 * Three entry points (mirrors bot/MIGRATE_OLD_TO_KESEFLE.gs):
 *
 *   DRY_RUN_MIGRATE_NOTES()                   -- read-only scan, NO writes.
 *                                                Logs plan + sample.
 *   APPLY_MIGRATE_NOTES_NOW()                 -- zero-arg wrapper, calls
 *                                                APPLY_MIGRATE_NOTES('YES I UNDERSTAND')
 *                                                so Apps Script function dropdown works.
 *   APPLY_MIGRATE_NOTES('YES I UNDERSTAND')   -- actual write. Refuses without arg.
 *
 * Steven's iron rules (per feedback_backup_propose_apply +
 * feedback_step_by_step_instructions):
 *   - DRY_RUN never writes
 *   - APPLY refuses without the literal "YES I UNDERSTAND" arg
 *   - LockService.getScriptLock for APPLY (serializes concurrent runs)
 *   - OLD sheet is NEVER mutated (read-only on source side)
 *   - NEW sheet writes only setNote() -- no setValue, no setFormula
 *   - Skips any NEW cell that ALREADY has a note (no clobber)
 *   - Audit-trail note on NEW tnu`ot A1 records run timestamp + count
 *
 * Matching strategy (transactions): each OLD tnu`ot row with a note in
 * cols A-H is matched against NEW tnu`ot rows by the deterministic key
 *   (yyyy-MM-dd, amount, category, subcategory, description[:60])
 * which is the same key bot/MIGRATE_OLD_TO_KESEFLE.gs used to dedupe the
 * Phase 2 row migration. If the same (date, amount, category) tuple
 * exists in NEW, the note is copied to the matching col in that row.
 *
 * Matching strategy (dashboard tabs): for OLD ma'azan ishi + OLD ma'azan chevra
 * the cell is row-label-keyed -- the note in A12 of OLD goes to the row
 * in NEW that has the same col A label. If NEW has shifted rows (rows
 * inserted/deleted between OLD and NEW templates), the label-walker
 * finds the right NEW row regardless of position.
 *
 * Idempotency: re-running APPLY is safe. Notes are skipped if the NEW
 * cell already has any note (we never overwrite -- per Steven's
 * "never overwrite user-typed values" rule).
 *
 * Hebrew strings encoded as backslash-u escapes per the
 * sheet-hebrew-encoding-safe-script skill so clipboard/Monaco paste
 * cannot corrupt RTL on the way in.
 */

// Sheet IDs - constants shared with bot/MIGRATE_OLD_TO_KESEFLE.gs.
var _MN_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MN_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Hebrew tab names -- all four. Same encoding as MIGRATE_OLD_TO_KESEFLE.
var _MN_TX_TAB_       = '\u05EA\u05E0\u05D5\u05E2\u05D5\u05EA';
var _MN_PERSONAL_TAB_ = '\u05DE\u05D0\u05D6\u05DF\u0020\u05D0\u05D9\u05E9\u05D9';
var _MN_COMPANY_TAB_  = '\u05DE\u05D0\u05D6\u05DF\u0020\u05D7\u05D1\u05E8\u05D4';
var _MN_ORDERS_TAB_   = '\u05D4\u05D6\u05DE\u05E0\u05D5\u05EA';

// Cap how far we scan in dashboard tabs (most labeled rows live in
// rows 1..200). Bumping this up is safe but slows the run.
var _MN_DASH_MAX_ROWS_ = 300;
var _MN_DASH_MAX_COLS_ = 50;

// Version tag for the audit-trail note.
var _MN_VERSION_ = 'Migration_Phase_8_notes_v1';

// Build a deterministic key for a tnu`ot row, matching the Phase 2
// dedupe key (bot/MIGRATE_OLD_TO_KESEFLE.gs:_mig_txKey_). MUST match
// exactly -- if it doesn't, a row migrated in Phase 2 won't be findable
// here. Schema: [date, monthKey, amount, category, subcat, desc, src, isExpense]
function _mn_txKey_(row) {
  var d = row[0];
  var dStr = (d && d instanceof Date)
    ? Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm')
    : String(d || '').slice(0, 30);
  var amt = String(row[2] || '');
  var cat = String(row[3] || '');
  var sub = String(row[4] || '');
  var desc = String(row[5] || '').slice(0, 60);
  return [dStr, amt, cat, sub, desc].join('|');
}

// Convert 1-based column index to A1-style letter(s).
function _mn_colLetter_(colIdx) {
  var s = '';
  while (colIdx > 0) {
    var rem = (colIdx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    colIdx = Math.floor((colIdx - 1) / 26);
  }
  return s;
}

// Read every cell with a non-empty note from the given OLD sheet (capped
// by maxRows x maxCols). Returns array of { row1Based, col1Based, note }.
function _mn_collectOldNotes_(sheet, maxRows, maxCols) {
  var lastRow = Math.min(maxRows, sheet.getLastRow());
  var lastCol = Math.min(maxCols, sheet.getLastColumn());
  if (lastRow < 1 || lastCol < 1) return [];
  var notes = sheet.getRange(1, 1, lastRow, lastCol).getNotes();
  var out = [];
  for (var r = 0; r < notes.length; r++) {
    for (var c = 0; c < notes[r].length; c++) {
      var n = notes[r][c];
      if (!n) continue;
      out.push({ row1: r + 1, col1: c + 1, note: n });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration phase A: notes on OLD tnu`ot -> NEW tnu`ot
// Match strategy: row-by-row key lookup. The note is copied to the SAME
// column in NEW that it lived in on OLD (e.g. a note on OLD col F-description
// goes to NEW col F-description of the matching row).
// ---------------------------------------------------------------------------
function _mn_migrateTxNotes_(oldSS, newSS, applyMode) {
  Logger.log('');
  Logger.log('-- Phase A: \u05EA\u05E0\u05D5\u05E2\u05D5\u05EA (transactions) cell notes --');
  var oldTx = oldSS.getSheetByName(_MN_TX_TAB_);
  var newTx = newSS.getSheetByName(_MN_TX_TAB_);
  if (!oldTx) { Logger.log('!! WARN: OLD has no "' + _MN_TX_TAB_ + '" tab -- skipping Phase A.'); return { copied: 0, skipped: 0 }; }
  if (!newTx) { Logger.log('!! WARN: NEW has no "' + _MN_TX_TAB_ + '" tab -- skipping Phase A.'); return { copied: 0, skipped: 0 }; }

  var oldLastRow = oldTx.getLastRow();
  var newLastRow = newTx.getLastRow();
  if (oldLastRow < 2 || newLastRow < 2) {
    Logger.log('  (one side empty: OLD rows=' + oldLastRow + ', NEW rows=' + newLastRow + ')');
    return { copied: 0, skipped: 0 };
  }

  // Build NEW key -> row1Based map (8 cols A:H per the standard schema).
  var newData = newTx.getRange(2, 1, newLastRow - 1, 8).getValues();
  var newKeyToRow = {};
  for (var i = 0; i < newData.length; i++) {
    var k = _mn_txKey_(newData[i]);
    // First-occurrence wins -- duplicates would be a Phase 2 bug.
    if (!(k in newKeyToRow)) newKeyToRow[k] = i + 2; // sheet row (1-based + header)
  }

  // Read OLD rows + their notes. Need notes ACROSS the 8 cols.
  var oldDataValues = oldTx.getRange(2, 1, oldLastRow - 1, 8).getValues();
  var oldDataNotes  = oldTx.getRange(2, 1, oldLastRow - 1, 8).getNotes();

  var plan = []; // { newRow1, col1, note, oldKey }
  var skipped = { no_note: 0, no_match_in_new: 0, new_already_has_note: 0 };

  for (var r = 0; r < oldDataValues.length; r++) {
    var hasAnyNote = false;
    for (var c = 0; c < oldDataNotes[r].length; c++) if (oldDataNotes[r][c]) { hasAnyNote = true; break; }
    if (!hasAnyNote) { skipped.no_note++; continue; }
    var oldKey = _mn_txKey_(oldDataValues[r]);
    var newRow = newKeyToRow[oldKey];
    if (!newRow) {
      skipped.no_match_in_new++;
      // Trace first few for debugging
      if (skipped.no_match_in_new <= 3) {
        Logger.log('  unmatched OLD row ' + (r + 2) + ' key="' + oldKey.slice(0, 80) + '"');
      }
      continue;
    }
    for (var col = 0; col < oldDataNotes[r].length; col++) {
      if (!oldDataNotes[r][col]) continue;
      plan.push({
        newRow1: newRow,
        col1: col + 1,
        note: oldDataNotes[r][col],
        oldKey: oldKey
      });
    }
  }

  // Pre-flight check: is the NEW cell already noted? Skip if so.
  // (Steven's "never overwrite" rule.)
  var finalPlan = [];
  for (var p = 0; p < plan.length; p++) {
    var existing = '';
    try {
      existing = newTx.getRange(plan[p].newRow1, plan[p].col1).getNote();
    } catch (_eErr) {}
    if (existing) { skipped.new_already_has_note++; continue; }
    finalPlan.push(plan[p]);
  }

  Logger.log('  to copy: ' + finalPlan.length);
  Logger.log('  skipped (OLD row had no notes): ' + skipped.no_note);
  Logger.log('  skipped (OLD row not found in NEW -- never migrated, or Phase 2 dedupe key changed): ' + skipped.no_match_in_new);
  Logger.log('  skipped (NEW cell already has a note): ' + skipped.new_already_has_note);
  if (finalPlan.length > 0) {
    var sample = finalPlan[0];
    Logger.log('  sample: NEW ' + _mn_colLetter_(sample.col1) + sample.newRow1 + ' <- "' + sample.note.slice(0, 80) + '..."');
  }

  if (!applyMode) return { copied: 0, plan: finalPlan.length, skipped: skipped };

  var written = 0;
  for (var w = 0; w < finalPlan.length; w++) {
    try {
      newTx.getRange(finalPlan[w].newRow1, finalPlan[w].col1).setNote(finalPlan[w].note);
      written++;
    } catch (wErr) {
      Logger.log('  !! write err on NEW ' + _mn_colLetter_(finalPlan[w].col1) + finalPlan[w].newRow1 + ': ' + wErr.message);
    }
  }
  Logger.log('  WROTE ' + written + ' notes to NEW ' + _MN_TX_TAB_);
  return { copied: written, plan: finalPlan.length, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Migration phase B: notes on OLD dashboard tab -> NEW dashboard tab.
// Match strategy: col A label-walker. Find the row label in OLD col A
// (with a note attached), then find the row in NEW with the SAME col A
// label -- regardless of row number drift between templates.
// ---------------------------------------------------------------------------
function _mn_migrateDashboardNotes_(oldSS, newSS, tabName, applyMode) {
  Logger.log('');
  Logger.log('-- Phase B/C: dashboard tab "' + tabName + '" cell notes --');
  var oldD = oldSS.getSheetByName(tabName);
  var newD = newSS.getSheetByName(tabName);
  if (!oldD || !newD) {
    Logger.log('  !! missing tab on one side: OLD has=' + !!oldD + ', NEW has=' + !!newD + ' -- skipping');
    return { copied: 0, skipped: 0 };
  }

  // Build NEW col A label -> row1-based map.
  var newLastRow = Math.min(_MN_DASH_MAX_ROWS_, newD.getLastRow());
  if (newLastRow < 1) return { copied: 0, skipped: 0 };
  var newLabels = newD.getRange(1, 1, newLastRow, 1).getValues();
  var newLabelToRow = {};
  for (var i = 0; i < newLabels.length; i++) {
    var raw = String(newLabels[i][0] == null ? '' : newLabels[i][0]).trim();
    if (!raw) continue;
    // First-occurrence wins -- if NEW has duplicate labels (Steven's
    // memory says some templates do), the FIRST is the canonical row.
    if (!(raw in newLabelToRow)) newLabelToRow[raw] = i + 1;
  }

  // Collect OLD notes from rows 1..max, cols 1..max.
  var oldNotes = _mn_collectOldNotes_(oldD, _MN_DASH_MAX_ROWS_, _MN_DASH_MAX_COLS_);
  Logger.log('  OLD has ' + oldNotes.length + ' cell notes in scan range');

  // For each OLD note: read OLD col A on its row to get the label, then
  // look up NEW row by label. Copy note to NEW row + same col.
  var oldLastRow = oldD.getLastRow();
  var oldLabels = oldD.getRange(1, 1, Math.min(_MN_DASH_MAX_ROWS_, oldLastRow), 1).getValues();

  var plan = [];
  var skipped = { no_old_label: 0, no_new_label_match: 0, new_already_has_note: 0 };

  for (var n = 0; n < oldNotes.length; n++) {
    var on = oldNotes[n];
    var oldLabel = '';
    if (on.row1 - 1 < oldLabels.length) {
      oldLabel = String(oldLabels[on.row1 - 1][0] == null ? '' : oldLabels[on.row1 - 1][0]).trim();
    }
    if (!oldLabel) { skipped.no_old_label++; continue; }
    var newRow = newLabelToRow[oldLabel];
    if (!newRow) { skipped.no_new_label_match++; continue; }
    plan.push({ newRow1: newRow, col1: on.col1, note: on.note, oldLabel: oldLabel });
  }

  // Pre-flight: skip NEW cells that already have a note.
  var finalPlan = [];
  for (var p = 0; p < plan.length; p++) {
    var existing = '';
    try { existing = newD.getRange(plan[p].newRow1, plan[p].col1).getNote(); } catch (_eErr) {}
    if (existing) { skipped.new_already_has_note++; continue; }
    finalPlan.push(plan[p]);
  }

  Logger.log('  to copy: ' + finalPlan.length);
  Logger.log('  skipped (OLD row had no col-A label -- header / sep row): ' + skipped.no_old_label);
  Logger.log('  skipped (no matching col-A label in NEW): ' + skipped.no_new_label_match);
  Logger.log('  skipped (NEW cell already has a note): ' + skipped.new_already_has_note);

  if (!applyMode) return { copied: 0, plan: finalPlan.length, skipped: skipped };

  var written = 0;
  for (var w = 0; w < finalPlan.length; w++) {
    try {
      newD.getRange(finalPlan[w].newRow1, finalPlan[w].col1).setNote(finalPlan[w].note);
      written++;
    } catch (wErr) {
      Logger.log('  !! write err: ' + wErr.message);
    }
  }
  Logger.log('  WROTE ' + written + ' notes to NEW ' + tabName);
  return { copied: written, plan: finalPlan.length, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Core scanner. applyMode=false -> dry-run. applyMode=true -> write.
// ---------------------------------------------------------------------------
function _mn_scanAndOptionallyApply_(applyMode) {
  Logger.log('=== KESEFLE NOTES MIGRATION ' + (applyMode ? '-- APPLY MODE' : '-- DRY-RUN MODE') + ' ===');
  Logger.log('OLD: ' + _MN_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _MN_NEW_SHEET_ID_);
  Logger.log('Version: ' + _MN_VERSION_);

  // Lock service -- only when applying. Two concurrent APPLY runs could
  // both see "no note in NEW yet" and both write, causing duplicate
  // setNote calls (idempotent, but wasted quota). Lock serializes.
  var _lock = null;
  if (applyMode) {
    _lock = LockService.getScriptLock();
    if (!_lock || !_lock.tryLock(30000)) {
      Logger.log('!! Another migration run is in progress -- aborting');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout).');
  }

  var oldSS, newSS;
  try { oldSS = SpreadsheetApp.openById(_MN_OLD_SHEET_ID_); }
  catch (e) { Logger.log('!! cannot open OLD: ' + e.message); return { error: 'cannot_open_old' }; }
  try { newSS = SpreadsheetApp.openById(_MN_NEW_SHEET_ID_); }
  catch (e) { Logger.log('!! cannot open NEW: ' + e.message); return { error: 'cannot_open_new' }; }

  Logger.log('OLD name: "' + oldSS.getName() + '"');
  Logger.log('NEW name: "' + newSS.getName() + '"');

  var txResult = _mn_migrateTxNotes_(oldSS, newSS, applyMode);
  var personalResult = _mn_migrateDashboardNotes_(oldSS, newSS, _MN_PERSONAL_TAB_, applyMode);
  var companyResult = _mn_migrateDashboardNotes_(oldSS, newSS, _MN_COMPANY_TAB_, applyMode);

  var grandTotal = (txResult.copied || 0) + (personalResult.copied || 0) + (companyResult.copied || 0);

  if (applyMode) {
    // Audit trail -- stamp NEW tnu`ot A1 with run info. Use APPEND so
    // re-runs accumulate history rather than overwriting.
    try {
      var newTx = newSS.getSheetByName(_MN_TX_TAB_);
      if (newTx) {
        var existingNote = '';
        try { existingNote = newTx.getRange('A1').getNote() || ''; } catch (_e) {}
        var nowStr = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
        var trail = _MN_VERSION_ + ': ' + nowStr +
                    ' | tx=' + (txResult.copied || 0) +
                    ' | personal=' + (personalResult.copied || 0) +
                    ' | company=' + (companyResult.copied || 0);
        var combined = existingNote ? (existingNote + '\n' + trail) : trail;
        newTx.getRange('A1').setNote(combined);
        Logger.log('Audit trail appended to NEW ' + _MN_TX_TAB_ + ' A1: ' + trail);
      }
    } catch (auditErr) {
      Logger.log('audit note err (non-fatal): ' + auditErr.message);
    }

    Logger.log('');
    Logger.log('=== APPLY COMPLETE -- ' + grandTotal + ' notes copied OLD -> NEW ===');
  } else {
    Logger.log('');
    Logger.log('=== DRY-RUN COMPLETE -- would copy ' + grandTotal + ' notes (NEW was NOT modified) ===');
    Logger.log('To apply: run APPLY_MIGRATE_NOTES_NOW (zero-arg wrapper).');
  }

  // Release lock if held
  if (_lock) { try { _lock.releaseLock(); } catch (_lErr) {} }

  return {
    transactions: txResult,
    personalDashboard: personalResult,
    companyDashboard: companyResult,
    totalCopied: grandTotal
  };
}

// ─── PUBLIC ENTRY POINTS ────────────────────────────────────────────────────

function DRY_RUN_MIGRATE_NOTES() {
  return _mn_scanAndOptionallyApply_(false);
}

function APPLY_MIGRATE_NOTES(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED -- APPLY_MIGRATE_NOTES requires the EXACT string "YES I UNDERSTAND" as the argument.');
    Logger.log('   Easier: run APPLY_MIGRATE_NOTES_NOW from the function dropdown (no arg needed).');
    Logger.log('   First always run DRY_RUN_MIGRATE_NOTES() and review the log.');
    return { refused: true };
  }
  return _mn_scanAndOptionallyApply_(true);
}

// Apps Script function dropdown cannot pass arguments. This zero-arg wrapper
// makes APPLY runnable from the dropdown. Same safety: internal pass.
function APPLY_MIGRATE_NOTES_NOW() {
  return APPLY_MIGRATE_NOTES('YES I UNDERSTAND');
}

// Optional self-test -- verifies Hebrew escapes decoded correctly after
// paste. Run once after first paste to confirm tab names round-trip.
function _MN_SELF_TEST_HEBREW_() {
  Logger.log('TX tab: ' + _MN_TX_TAB_);
  Logger.log('Personal dashboard tab: ' + _MN_PERSONAL_TAB_);
  Logger.log('Company dashboard tab: ' + _MN_COMPANY_TAB_);
  Logger.log('Orders tab: ' + _MN_ORDERS_TAB_);
  Logger.log('If any of these prints garbled or backwards, the paste corrupted the strings.');
}
