/**
 * bot/MIGRATE_PHASE_4_CATEGORIES_NOTES.gs
 *
 * Phase 4 of the Kesefle migration epic (Steven's section-23 plan).
 * One-time preservation script that captures (a) Steven's personal
 * dashboard category structure from OLD `מאזן אישי` and (b) any
 * historical notes (either from an OLD `Notes`/`הערות` tab or
 * inline cell-notes on the OLD `תנועות` description column) and
 * writes them to NEW Kesefle (1rti...) as STATIC reference tabs:
 *   - `קטגוריות_מקור`     — category structure snapshot
 *   - `הערות_היסטוריות`   — historical notes snapshot
 *
 * Two entry points (same pattern as Phase 2 + Phase 3):
 *   DRY_RUN_PHASE4()                  — scan only, NO writes. Logs counts
 *                                       + dedupe plan + samples.
 *   APPLY_PHASE4_NOW()                — zero-arg wrapper that calls
 *                                       APPLY_PHASE4('YES I UNDERSTAND')
 *                                       so it runs from the function
 *                                       dropdown.
 *   APPLY_PHASE4('YES I UNDERSTAND')  — actual write. Refuses without arg.
 *
 * Per the verify-data-sources-before-formula-repair skill:
 *   - Read every source row before deciding to capture
 *   - Compute deterministic dedupe key per row
 *   - Skip rows already present in NEW (idempotent — safe to re-run)
 *   - Report EVERY decision in the dry-run log
 *   - APPLY refuses without literal "YES I UNDERSTAND" arg
 *   - Writes audit-trail note to A1 of each created NEW tab
 *
 * Notes sources scanned (in order, first available wins per row):
 *   1. OLD `הערות` tab (Hebrew label, preferred)
 *   2. OLD `Notes` tab (English label, fallback)
 *   3. OLD `תנועות` col F (description) cell-notes (inline)
 *
 * Rollback: nothing in this script DELETES rows. To undo, filter the
 * NEW tabs by 'Migration_Phase_4' in the source column and delete.
 */

var _MIG4_OLD_SHEET_ID_  = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MIG4_NEW_SHEET_ID_  = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MIG4_OLD_PERSONAL_TAB_   = 'מאזן אישי';
var _MIG4_OLD_TX_TAB_         = 'תנועות';
var _MIG4_OLD_NOTES_HEB_TAB_  = 'הערות';
var _MIG4_OLD_NOTES_EN_TAB_   = 'Notes';
var _MIG4_NEW_CATEGORIES_TAB_ = 'קטגוריות_מקור';
var _MIG4_NEW_NOTES_TAB_      = 'הערות_היסטוריות';
var _MIG4_VERSION_            = 'Migration_Phase_4_v1';

// Personal dashboard capture: rows 1-60, cols A-N (label + 12 months + total).
// Per FIX_DASHBOARD_2023_2024_2025.gs the company dashboard uses rows 1-65,
// so we take a similar 60-row slab for the personal one — defensive enough
// for whatever Steven has set up.
var _MIG4_PERSONAL_ROW_START_ = 1;
var _MIG4_PERSONAL_ROW_END_   = 60;
var _MIG4_PERSONAL_COL_START_ = 1;   // A
var _MIG4_PERSONAL_COL_END_   = 14;  // N

// Build deterministic dedupe key for a category-snapshot row.
function _mig4_catKey_(sourceRow, label) {
  return [String(sourceRow), String(label || '').slice(0, 80)].join('|');
}

// Build deterministic dedupe key for a notes-snapshot row.
// (sourceTab, sourceRow, noteTextHead) — collapses identical re-runs.
function _mig4_noteKey_(sourceTab, sourceRow, noteText) {
  return [String(sourceTab || ''), String(sourceRow), String(noteText || '').slice(0, 120)].join('|');
}

// Ensure a destination tab exists. APPEND-ONLY semantics — if missing in
// APPLY mode we create with a header row. In dry-run we report whether
// it exists but never create.
function _mig4_ensureCategoriesTab_(newSS, applyMode) {
  var tab = newSS.getSheetByName(_MIG4_NEW_CATEGORIES_TAB_);
  if (tab) return tab;
  if (!applyMode) return null;
  tab = newSS.insertSheet(_MIG4_NEW_CATEGORIES_TAB_);
  // 18-col header to match the row schema
  var header = [
    'מקור שורה',     // A: source row index in OLD מאזן אישי
    'תווית',         // C-like: label (col A from OLD personal)
    'ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יונ',
    'יול', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ',
    'סה"כ',          // total (col N from OLD)
    'גרסת מיגרציה',  // version tag
    'נלכד ב'         // captured-at timestamp
  ];
  tab.getRange(1, 1, 1, header.length).setValues([header]);
  tab.setFrozenRows(1);
  return tab;
}

function _mig4_ensureNotesTab_(newSS, applyMode) {
  var tab = newSS.getSheetByName(_MIG4_NEW_NOTES_TAB_);
  if (tab) return tab;
  if (!applyMode) return null;
  tab = newSS.insertSheet(_MIG4_NEW_NOTES_TAB_);
  var header = [
    'מקור טאב',      // A: source tab name in OLD (הערות / Notes / תנועות)
    'מקור שורה',     // B: source row index
    'תאריך',         // C: associated date if any
    'טקסט הערה',     // D: note text
    'הקשר',          // E: surrounding context (e.g. description for cell-notes)
    'גרסת מיגרציה',  // F: version tag
    'נלכד ב'         // G: captured-at timestamp
  ];
  tab.getRange(1, 1, 1, header.length).setValues([header]);
  tab.setFrozenRows(1);
  return tab;
}

// Core scanner. applyMode=false → dry-run. applyMode=true → write to NEW.
function _mig4_scanAndOptionallyApply_(applyMode) {
  Logger.log('=== KESEFLE PHASE 4 ' + (applyMode ? '— APPLY MODE' : '— DRY-RUN MODE') + ' ===');
  Logger.log('OLD: ' + _MIG4_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _MIG4_NEW_SHEET_ID_);
  Logger.log('Version: ' + _MIG4_VERSION_);

  // Concurrent-run guard. Use getScriptLock (not getDocumentLock) — the
  // bot's Apps Script is standalone, not container-bound. getDocumentLock
  // returns null for standalone scripts.
  var _migLock = null;
  if (applyMode) {
    _migLock = LockService.getScriptLock();
    if (!_migLock || !_migLock.tryLock(30000)) {
      Logger.log('!! Another Phase 4 run is in progress — aborting (try again in a minute)');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout); concurrent runs are blocked.');
  }

  // ── Open both sheets ──
  var oldSS, newSS;
  try { oldSS = SpreadsheetApp.openById(_MIG4_OLD_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open OLD: ' + e.message); return { error: 'cannot_open_old' }; }
  try { newSS = SpreadsheetApp.openById(_MIG4_NEW_SHEET_ID_); }
  catch (e) { Logger.log('!! Cannot open NEW: ' + e.message); return { error: 'cannot_open_new' }; }

  Logger.log('OLD name: "' + oldSS.getName() + '"');
  Logger.log('NEW name: "' + newSS.getName() + '"');

  // ── Ensure NEW destination tabs (only create in APPLY mode) ──
  var catTab = _mig4_ensureCategoriesTab_(newSS, applyMode);
  var notesTab = _mig4_ensureNotesTab_(newSS, applyMode);
  Logger.log('NEW ' + _MIG4_NEW_CATEGORIES_TAB_ + ' tab: ' + (catTab ? 'present' : 'absent (will be created on APPLY)'));
  Logger.log('NEW ' + _MIG4_NEW_NOTES_TAB_ + ' tab: ' + (notesTab ? 'present' : 'absent (will be created on APPLY)'));

  // ── Build existing-key sets for dedupe ──
  var existingCatKeys = {};
  if (catTab) {
    var catLastRow = catTab.getLastRow();
    if (catLastRow > 1) {
      var catData = catTab.getRange(2, 1, catLastRow - 1, 2).getValues();
      for (var ci = 0; ci < catData.length; ci++) {
        existingCatKeys[_mig4_catKey_(catData[ci][0], catData[ci][1])] = true;
      }
    }
    Logger.log('NEW ' + _MIG4_NEW_CATEGORIES_TAB_ + ': ' + Math.max(0, catTab.getLastRow() - 1) + ' existing rows.');
  }

  var existingNoteKeys = {};
  if (notesTab) {
    var notesLastRow = notesTab.getLastRow();
    if (notesLastRow > 1) {
      // cols A=sourceTab, B=sourceRow, D=note text → that's enough for the key
      var notesData = notesTab.getRange(2, 1, notesLastRow - 1, 4).getValues();
      for (var ni = 0; ni < notesData.length; ni++) {
        var nr = notesData[ni];
        existingNoteKeys[_mig4_noteKey_(nr[0], nr[1], nr[3])] = true;
      }
    }
    Logger.log('NEW ' + _MIG4_NEW_NOTES_TAB_ + ': ' + Math.max(0, notesTab.getLastRow() - 1) + ' existing rows.');
  }

  var capturedAt = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');

  // ── PHASE 4.A — capture OLD מאזן אישי category structure ──
  var oldPersonal = oldSS.getSheetByName(_MIG4_OLD_PERSONAL_TAB_);
  var catToWrite = [];
  var catSkipped = { duplicate: 0, empty: 0, missing_tab: 0 };

  if (!oldPersonal) {
    Logger.log('!! OLD has no ' + _MIG4_OLD_PERSONAL_TAB_ + ' tab — categories step skipped.');
    catSkipped.missing_tab++;
  } else {
    var personalLastRow = oldPersonal.getLastRow();
    var personalLastCol = oldPersonal.getLastColumn();
    var captureRowEnd = Math.min(_MIG4_PERSONAL_ROW_END_, personalLastRow);
    var captureColEnd = Math.min(_MIG4_PERSONAL_COL_END_, personalLastCol);
    Logger.log('\n-- OLD מאזן אישי: ' + personalLastRow + ' rows x ' + personalLastCol + ' cols --');
    Logger.log('Capturing rows ' + _MIG4_PERSONAL_ROW_START_ + '-' + captureRowEnd + ' cols A-' + String.fromCharCode(64 + captureColEnd));

    if (captureRowEnd >= _MIG4_PERSONAL_ROW_START_) {
      var personalData = oldPersonal.getRange(
        _MIG4_PERSONAL_ROW_START_, _MIG4_PERSONAL_COL_START_,
        captureRowEnd - _MIG4_PERSONAL_ROW_START_ + 1,
        captureColEnd - _MIG4_PERSONAL_COL_START_ + 1
      ).getValues();

      Logger.log('Raw sample of OLD מאזן אישי A-N (first 3 rows, for layout verification):');
      for (var prs = 0; prs < Math.min(3, personalData.length); prs++) {
        Logger.log('  row ' + (prs + 1) + ': ' + JSON.stringify(personalData[prs]).slice(0, 300));
      }

      for (var pr = 0; pr < personalData.length; pr++) {
        var srcRow = _MIG4_PERSONAL_ROW_START_ + pr;
        var prow = personalData[pr];
        var label = prow[0];
        var rowEmpty = true;
        for (var pc = 0; pc < prow.length; pc++) {
          if (prow[pc] !== '' && prow[pc] !== null && prow[pc] !== undefined) { rowEmpty = false; break; }
        }
        if (rowEmpty) { catSkipped.empty++; continue; }

        var catKey = _mig4_catKey_(srcRow, label);
        if (existingCatKeys[catKey]) { catSkipped.duplicate++; continue; }

        var monthVals = [];
        for (var mc = 1; mc <= 12; mc++) {
          monthVals.push(mc < prow.length ? prow[mc] : '');
        }
        var totalVal = prow.length > 13 ? prow[13] : '';

        // Schema (17 cols): [srcRow, label, m1..m12, total, version, capturedAt]
        var catRow = [srcRow, String(label || '')]
          .concat(monthVals)
          .concat([totalVal, _MIG4_VERSION_, capturedAt]);

        catToWrite.push(catRow);
        existingCatKeys[catKey] = true;
      }
    }
  }

  Logger.log('\nCategories plan:');
  Logger.log('  → to capture: ' + catToWrite.length);
  Logger.log('  skipped (already in NEW): ' + catSkipped.duplicate);
  Logger.log('  skipped (empty row): ' + catSkipped.empty);
  Logger.log('  skipped (missing OLD tab): ' + catSkipped.missing_tab);
  Logger.log('Sample (first 5 category rows to write):');
  for (var csm = 0; csm < Math.min(5, catToWrite.length); csm++) {
    Logger.log('  ' + JSON.stringify(catToWrite[csm]).slice(0, 300));
  }

  // ── PHASE 4.B — capture OLD notes ──
  // Three sources, in priority order. We try each and dedupe across sources.
  var notesToWrite = [];
  var notesSkipped = { duplicate: 0, empty: 0, no_dedicated_tab: 0, no_cell_notes: 0 };

  // (1) Hebrew dedicated notes tab
  var oldNotesHeb = oldSS.getSheetByName(_MIG4_OLD_NOTES_HEB_TAB_);
  // (2) English dedicated notes tab
  var oldNotesEn  = oldSS.getSheetByName(_MIG4_OLD_NOTES_EN_TAB_);

  function _harvestNoteTab_(tab, tabName) {
    if (!tab) return 0;
    var lastRow = tab.getLastRow();
    var lastCol = Math.min(tab.getLastColumn(), 5);
    if (lastRow < 1 || lastCol < 1) return 0;
    var data = tab.getRange(1, 1, lastRow, lastCol).getValues();
    var added = 0;
    for (var i = 0; i < data.length; i++) {
      var rrow = data[i];
      // Strategy: take col A as date (if Date) or context, col B as note,
      // fallback to whichever col has the longest string.
      var dateCell = (rrow[0] instanceof Date) ? rrow[0] : '';
      var noteText = '';
      var contextText = '';
      for (var cc = 0; cc < rrow.length; cc++) {
        var v = rrow[cc];
        if (typeof v === 'string' && v.trim().length > 0) {
          if (!noteText) noteText = v;
          else if (v.length > noteText.length) {
            contextText = noteText;
            noteText = v;
          } else if (!contextText) {
            contextText = v;
          }
        }
      }
      if (!noteText) { notesSkipped.empty++; continue; }
      var key = _mig4_noteKey_(tabName, i + 1, noteText);
      if (existingNoteKeys[key]) { notesSkipped.duplicate++; continue; }
      var dateStr = (dateCell instanceof Date)
        ? Utilities.formatDate(dateCell, 'Asia/Jerusalem', 'yyyy-MM-dd')
        : '';
      notesToWrite.push([tabName, i + 1, dateStr, noteText, contextText, _MIG4_VERSION_, capturedAt]);
      existingNoteKeys[key] = true;
      added++;
    }
    return added;
  }

  var hebAdded = 0, enAdded = 0;
  if (oldNotesHeb) {
    Logger.log('\n-- OLD ' + _MIG4_OLD_NOTES_HEB_TAB_ + ' tab found — harvesting.');
    hebAdded = _harvestNoteTab_(oldNotesHeb, _MIG4_OLD_NOTES_HEB_TAB_);
    Logger.log('  Hebrew notes tab → ' + hebAdded + ' new rows.');
  } else {
    Logger.log('\n-- OLD ' + _MIG4_OLD_NOTES_HEB_TAB_ + ' tab not found (skipping).');
    notesSkipped.no_dedicated_tab++;
  }
  if (oldNotesEn) {
    Logger.log('-- OLD ' + _MIG4_OLD_NOTES_EN_TAB_ + ' tab found — harvesting.');
    enAdded = _harvestNoteTab_(oldNotesEn, _MIG4_OLD_NOTES_EN_TAB_);
    Logger.log('  English Notes tab → ' + enAdded + ' new rows.');
  } else {
    Logger.log('-- OLD ' + _MIG4_OLD_NOTES_EN_TAB_ + ' tab not found (skipping).');
    notesSkipped.no_dedicated_tab++;
  }

  // (3) Inline cell-notes on תנועות col F (description)
  var oldTx = oldSS.getSheetByName(_MIG4_OLD_TX_TAB_);
  var inlineAdded = 0;
  if (oldTx) {
    var txLastRow = oldTx.getLastRow();
    if (txLastRow > 1) {
      // Cell-notes live on col F (6) per ExpenseBot. Pair them with the
      // row's date (col A) and description (col F value) for context.
      var fRange = oldTx.getRange(2, 6, txLastRow - 1, 1);
      var fValues = fRange.getValues();
      var fNotes  = fRange.getNotes();
      var aValues = oldTx.getRange(2, 1, txLastRow - 1, 1).getValues();
      Logger.log('\n-- OLD ' + _MIG4_OLD_TX_TAB_ + ' col F cell-notes scan: ' + fNotes.length + ' rows --');
      for (var fi = 0; fi < fNotes.length; fi++) {
        var noteVal = fNotes[fi][0];
        if (!noteVal || String(noteVal).trim().length === 0) {
          notesSkipped.no_cell_notes++; continue;
        }
        var descVal = String(fValues[fi][0] || '');
        var dCell = aValues[fi][0];
        var dStr = (dCell instanceof Date)
          ? Utilities.formatDate(dCell, 'Asia/Jerusalem', 'yyyy-MM-dd')
          : '';
        var srcRowIdx = fi + 2;
        var key = _mig4_noteKey_(_MIG4_OLD_TX_TAB_, srcRowIdx, noteVal);
        if (existingNoteKeys[key]) { notesSkipped.duplicate++; continue; }
        notesToWrite.push([_MIG4_OLD_TX_TAB_, srcRowIdx, dStr, String(noteVal), descVal, _MIG4_VERSION_, capturedAt]);
        existingNoteKeys[key] = true;
        inlineAdded++;
      }
      Logger.log('  תנועות col F inline cell-notes → ' + inlineAdded + ' new rows.');
    }
  } else {
    Logger.log('!! OLD has no ' + _MIG4_OLD_TX_TAB_ + ' tab (inline cell-notes step skipped).');
  }

  Logger.log('\nNotes plan:');
  Logger.log('  → to capture: ' + notesToWrite.length + ' (heb=' + hebAdded + ' en=' + enAdded + ' inline=' + inlineAdded + ')');
  Logger.log('  skipped (already in NEW): ' + notesSkipped.duplicate);
  Logger.log('  skipped (empty): ' + notesSkipped.empty);
  Logger.log('  skipped (no dedicated notes tab): ' + notesSkipped.no_dedicated_tab);
  Logger.log('  skipped (no cell-notes on row): ' + notesSkipped.no_cell_notes);
  Logger.log('Sample (first 3 notes to write):');
  for (var nsm = 0; nsm < Math.min(3, notesToWrite.length); nsm++) {
    Logger.log('  ' + JSON.stringify(notesToWrite[nsm]).slice(0, 300));
  }

  // ── APPLY mode: actually write to NEW ──
  if (applyMode) {
    Logger.log('\n=== APPLYING — writing to NEW ===');

    if (catTab && catToWrite.length > 0) {
      var catStartRow = catTab.getLastRow() + 1;
      var catColCount = catToWrite[0].length;
      catTab.getRange(catStartRow, 1, catToWrite.length, catColCount).setValues(catToWrite);
      Logger.log('Wrote ' + catToWrite.length + ' category rows to NEW ' + _MIG4_NEW_CATEGORIES_TAB_ + ' (starting at row ' + catStartRow + ').');
    }

    if (notesTab && notesToWrite.length > 0) {
      var notesStartRow = notesTab.getLastRow() + 1;
      var notesColCount = notesToWrite[0].length;
      notesTab.getRange(notesStartRow, 1, notesToWrite.length, notesColCount).setValues(notesToWrite);
      Logger.log('Wrote ' + notesToWrite.length + ' notes rows to NEW ' + _MIG4_NEW_NOTES_TAB_ + ' (starting at row ' + notesStartRow + ').');
    }

    // Audit trail
    try {
      var trail = _MIG4_VERSION_ + ': ' + capturedAt + ' | Categories=' + catToWrite.length + ' | Notes=' + notesToWrite.length;
      if (catTab) catTab.getRange('A1').setNote(trail);
      if (notesTab) notesTab.getRange('A1').setNote(trail);
      Logger.log('Audit trail note → NEW ' + _MIG4_NEW_CATEGORIES_TAB_ + ' + ' + _MIG4_NEW_NOTES_TAB_ + ' A1: ' + trail);
    } catch (auditErr) { Logger.log('audit note err (non-fatal): ' + auditErr.message); }

    Logger.log('=== APPLY COMPLETE ===');
    Logger.log('Refresh NEW sheet (Cmd+R) to see the new tabs.');
  } else {
    Logger.log('\n=== DRY-RUN COMPLETE — your sheet was NOT modified ===');
    Logger.log('To apply: run APPLY_PHASE4_NOW (zero-arg wrapper).');
  }

  // Release the lock if we held it (APPLY mode only)
  if (_migLock) {
    try { _migLock.releaseLock(); } catch (_lockErr) { /* ignore */ }
  }

  return {
    categories: { toWrite: catToWrite.length, skipped: catSkipped },
    notes: { toWrite: notesToWrite.length, skipped: notesSkipped, hebrew: hebAdded, english: enAdded, inline: inlineAdded }
  };
}

// ─── PUBLIC ENTRY POINTS ─────────────────────────────────────────────────

function DRY_RUN_PHASE4() {
  return _mig4_scanAndOptionallyApply_(false);
}

function APPLY_PHASE4(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED — APPLY_PHASE4 requires the EXACT string "YES I UNDERSTAND" as the argument.');
    Logger.log('   Easier: run APPLY_PHASE4_NOW from the function dropdown (no arg needed).');
    Logger.log('   First always run DRY_RUN_PHASE4() and review the log.');
    return { refused: true };
  }
  return _mig4_scanAndOptionallyApply_(true);
}

// Apps Script function dropdown can't pass arguments. This zero-arg wrapper
// makes APPLY_PHASE4 runnable from the dropdown. Same safety: passes the
// literal confirmation string internally.
function APPLY_PHASE4_NOW() {
  return APPLY_PHASE4('YES I UNDERSTAND');
}
