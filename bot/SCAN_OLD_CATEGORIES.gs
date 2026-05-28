/**
 * bot/SCAN_OLD_CATEGORIES.gs
 *
 * One-shot diagnostic Apps Script. Paste this entire file into the bot's
 * Apps Script project, then run SCAN_OLD_CATEGORIES() from the function
 * dropdown. It is READ-ONLY against both OLD and NEW sheets.
 *
 * Purpose: Steven asked us to sync any categories that exist in the OLD
 * sheet (1UKr...) but are MISSING from the bot's CATEGORY_MAP /
 * BUSINESS_CATEGORY_MAP / _BIZ_DASH_SUBS taxonomy. Before we propose
 * additions (PR-B), we need a real dump of:
 *
 *   1. Every distinct (category, subcategory) tuple actually written in
 *      OLD tnu`ot col D + col E, with row counts.
 *   2. Every distinct row label in OLD ma'azan ishi col A (the personal
 *      dashboard's category list -- these are the rows the user designed
 *      her own taxonomy around).
 *   3. Every distinct row label in OLD ma'azan chevra col A (the business
 *      dashboard's category list -- same idea on the business side).
 *   4. Every cell that has a NOTE attached (getNote()) across the three
 *      tabs, with cell ref + note text. Steven flagged that historical
 *      notes/comments were never migrated.
 *
 * Output: Logger.log in markdown table format. Steven opens View ->
 * Execution log and copies the entire log back to Claude. We then diff
 * the dump against the bot's current taxonomy + ship PR-B with the
 * missing keywords/categories.
 *
 * Safety:
 *   - Refuses to write to either sheet (no .setValue, no .appendRow,
 *     no .setNote anywhere in this file).
 *   - Tolerates a missing tab (logs WARN, moves on -- does not throw).
 *   - Defensive against very wide / very tall sheets by capping
 *     getRange calls to the actual lastRow/lastCol.
 *   - Every Hebrew string in source is encoded as backslash-u escape
 *     sequences per the sheet-hebrew-encoding-safe-script skill --
 *     clipboard/Monaco-paste cannot corrupt bidi/RTL on the way in.
 *
 * No KFL_BUILD_VERSION bump -- this script does not ship with the
 * production bot, it's a one-off diagnostic.
 */

// OLD sheet ID -- frozen historical reference (per migration Phase 7).
var _SOC_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// Hebrew tab names -- escape every codepoint so clipboard-paste from
// chat/Monaco cannot corrupt the RTL strings before they reach the editor.
//   _SOC_TX_TAB_       decodes to: tnu`ot           (transactions)
//   _SOC_PERSONAL_TAB_ decodes to: ma'azan ishi     (personal balance)
//   _SOC_COMPANY_TAB_  decodes to: ma'azan chevra   (company balance)
var _SOC_TX_TAB_       = '\u05EA\u05E0\u05D5\u05E2\u05D5\u05EA';
var _SOC_PERSONAL_TAB_ = '\u05DE\u05D0\u05D6\u05DF\u0020\u05D0\u05D9\u05E9\u05D9';
var _SOC_COMPANY_TAB_  = '\u05DE\u05D0\u05D6\u05DF\u0020\u05D7\u05D1\u05E8\u05D4';

// Cap how far we scan when looking for cell notes. Most user notes live
// in the first 200 rows / 40 cols of dashboards. Bumping these is safe
// but slows the run -- be patient if you raise them.
var _SOC_NOTE_MAX_ROWS_ = 500;
var _SOC_NOTE_MAX_COLS_ = 50;

// Markdown-table row helper. Pipe-escapes any user content so a stray
// "|" in a description doesn't break the rendered table.
function _soc_mdRow_(cells) {
  var safe = [];
  for (var i = 0; i < cells.length; i++) {
    safe.push(String(cells[i] == null ? '' : cells[i]).replace(/\|/g, '\\|').replace(/\n/g, ' '));
  }
  return '| ' + safe.join(' | ') + ' |';
}

// ---------------------------------------------------------------------------
// Section 1: dump OLD tnu`ot col D + col E unique values with counts.
// Schema (per docs/BOT_TAXONOMY_RECONCILE_2026-05-28.md section 1.1):
//   A=timestamp, B=month, C=amount, D=category, E=subcategory,
//   F=description, G=source, H=isExpense
// ---------------------------------------------------------------------------
function _soc_dumpTxCategories_(oldSS) {
  Logger.log('');
  Logger.log('## 1. OLD tnu`ot col D (category) + col E (subcategory) unique values');
  var sheet = oldSS.getSheetByName(_SOC_TX_TAB_);
  if (!sheet) {
    Logger.log('!! WARN: OLD has no "' + _SOC_TX_TAB_ + '" tab -- skipping section 1.');
    return;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('(no data rows)');
    return;
  }
  // Read D + E only (cols 4, 5). 2 cols wide.
  var data = sheet.getRange(2, 4, lastRow - 1, 2).getValues();

  // Build (category, subcategory) -> count map. Empty cells get bucketed
  // to '(empty)' so Steven sees how many rows were never categorized.
  var tupleCount = {};
  var dOnly = {};
  var eOnly = {};
  for (var i = 0; i < data.length; i++) {
    var d = String(data[i][0] == null ? '' : data[i][0]).trim();
    var e = String(data[i][1] == null ? '' : data[i][1]).trim();
    var dKey = d || '(empty)';
    var eKey = e || '(empty)';
    var tk = dKey + ' >> ' + eKey;
    tupleCount[tk] = (tupleCount[tk] || 0) + 1;
    dOnly[dKey]  = (dOnly[dKey] || 0) + 1;
    eOnly[eKey]  = (eOnly[eKey] || 0) + 1;
  }

  Logger.log('Total rows scanned: ' + data.length);
  Logger.log('Distinct col D values: ' + Object.keys(dOnly).length);
  Logger.log('Distinct col E values: ' + Object.keys(eOnly).length);
  Logger.log('Distinct (D >> E) tuples: ' + Object.keys(tupleCount).length);

  // Top-50 (D, E) tuples by count, descending. 50 is enough that we see
  // every real category -- the long tail is invariably typos or one-offs.
  Logger.log('');
  Logger.log('### 1a. Top 50 (D >> E) tuples by row count');
  Logger.log(_soc_mdRow_(['Rank', 'D (category)', 'E (subcategory)', 'Count']));
  Logger.log(_soc_mdRow_(['---', '---', '---', '---']));
  var tuples = Object.keys(tupleCount).map(function (k) {
    var parts = k.split(' >> ');
    return { d: parts[0], e: parts[1], n: tupleCount[k] };
  });
  tuples.sort(function (a, b) { return b.n - a.n; });
  var take = Math.min(50, tuples.length);
  for (var t = 0; t < take; t++) {
    Logger.log(_soc_mdRow_([t + 1, tuples[t].d, tuples[t].e, tuples[t].n]));
  }

  // Every distinct col E (subcategory) the user has EVER written -- this
  // is the actual mismatched-vocabulary set we'll close with PR-B.
  Logger.log('');
  Logger.log('### 1b. ALL distinct col E (subcategory) values, sorted by count desc');
  Logger.log(_soc_mdRow_(['Subcategory (col E)', 'Count']));
  Logger.log(_soc_mdRow_(['---', '---']));
  var eList = Object.keys(eOnly).map(function (k) { return { e: k, n: eOnly[k] }; });
  eList.sort(function (a, b) { return b.n - a.n; });
  for (var s = 0; s < eList.length; s++) {
    Logger.log(_soc_mdRow_([eList[s].e, eList[s].n]));
  }

  // Every distinct col D (top-level category).
  Logger.log('');
  Logger.log('### 1c. ALL distinct col D (category) values, sorted by count desc');
  Logger.log(_soc_mdRow_(['Category (col D)', 'Count']));
  Logger.log(_soc_mdRow_(['---', '---']));
  var dList = Object.keys(dOnly).map(function (k) { return { d: k, n: dOnly[k] }; });
  dList.sort(function (a, b) { return b.n - a.n; });
  for (var dd = 0; dd < dList.length; dd++) {
    Logger.log(_soc_mdRow_([dList[dd].d, dList[dd].n]));
  }
}

// ---------------------------------------------------------------------------
// Section 2: dump col A row labels from a dashboard tab. The personal
// dashboard (ma'azan ishi) and the company dashboard (ma'azan chevra) both
// use col A as the row label, with the SUMIFS formula in B..M (months).
// Pure label dump -- no formula parsing.
// ---------------------------------------------------------------------------
function _soc_dumpDashboardLabels_(oldSS, tabName, sectionTitle, sectionNumber) {
  Logger.log('');
  Logger.log('## ' + sectionNumber + '. ' + sectionTitle + ' (tab: "' + tabName + '") col A row labels');
  var sheet = oldSS.getSheetByName(tabName);
  if (!sheet) {
    Logger.log('!! WARN: OLD has no "' + tabName + '" tab -- skipping.');
    return;
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    Logger.log('(empty tab)');
    return;
  }
  var labels = sheet.getRange(1, 1, lastRow, 1).getValues();

  Logger.log(_soc_mdRow_(['Row', 'Label (col A)']));
  Logger.log(_soc_mdRow_(['---', '---']));
  for (var i = 0; i < labels.length; i++) {
    var label = String(labels[i][0] == null ? '' : labels[i][0]).trim();
    // Skip blank rows but keep header rows visible so Steven sees row
    // numbers in context.
    if (!label) continue;
    Logger.log(_soc_mdRow_([i + 1, label]));
  }
}

// ---------------------------------------------------------------------------
// Section 4: cell notes (getNote()). Walk every cell in (row<=NOTE_MAX_ROWS,
// col<=NOTE_MAX_COLS) and log every one whose .getNote() is non-empty.
// Cap is per-tab. Apps Script limits notes to ~50k chars per cell, but
// we truncate display to 500 chars so the log stays readable.
// ---------------------------------------------------------------------------
function _soc_dumpNotes_(oldSS, tabName, sectionNumber, alphaIdx) {
  Logger.log('');
  Logger.log('## ' + sectionNumber + alphaIdx + '. Cell notes in OLD "' + tabName + '"');
  var sheet = oldSS.getSheetByName(tabName);
  if (!sheet) {
    Logger.log('!! WARN: OLD has no "' + tabName + '" tab -- skipping.');
    return;
  }
  var lastRow = Math.min(_SOC_NOTE_MAX_ROWS_, sheet.getLastRow());
  var lastCol = Math.min(_SOC_NOTE_MAX_COLS_, sheet.getLastColumn());
  if (lastRow < 1 || lastCol < 1) {
    Logger.log('(empty tab)');
    return;
  }
  // getNotes() returns a 2-D array of strings matching the range.
  // Single batched call -- way faster than per-cell getNote().
  var notes = sheet.getRange(1, 1, lastRow, lastCol).getNotes();
  var found = 0;
  var rows = [];
  for (var r = 0; r < notes.length; r++) {
    for (var c = 0; c < notes[r].length; c++) {
      var n = notes[r][c];
      if (!n) continue;
      var cellRef = _soc_colLetter_(c + 1) + (r + 1);
      var truncated = n.length > 500 ? (n.slice(0, 500) + '...[truncated, ' + n.length + ' chars]') : n;
      rows.push({ ref: cellRef, note: truncated });
      found++;
    }
  }
  if (found === 0) {
    Logger.log('(no cell notes found in row 1.._SOC_NOTE_MAX_ROWS_=' + _SOC_NOTE_MAX_ROWS_ + ' x col 1.._SOC_NOTE_MAX_COLS_=' + _SOC_NOTE_MAX_COLS_ + ')');
    return;
  }
  Logger.log('Found ' + found + ' cells with notes (scanned ' + lastRow + ' rows x ' + lastCol + ' cols).');
  Logger.log(_soc_mdRow_(['Cell', 'Note']));
  Logger.log(_soc_mdRow_(['---', '---']));
  for (var i = 0; i < rows.length; i++) {
    Logger.log(_soc_mdRow_([rows[i].ref, rows[i].note]));
  }
}

// Convert 1-based column index to A1-style letter(s). Handles >26 cols
// for AA/AB/etc. -- the company tab can be ~40 cols wide.
function _soc_colLetter_(colIdx) {
  var s = '';
  while (colIdx > 0) {
    var rem = (colIdx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    colIdx = Math.floor((colIdx - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Public entry point -- Steven runs this from the function dropdown.
// ---------------------------------------------------------------------------
function SCAN_OLD_CATEGORIES() {
  Logger.log('# OLD sheet category + notes diagnostic dump');
  Logger.log('Sheet ID: ' + _SOC_OLD_SHEET_ID_);
  Logger.log('Run at: ' + new Date().toISOString());
  Logger.log('');

  var oldSS;
  try {
    oldSS = SpreadsheetApp.openById(_SOC_OLD_SHEET_ID_);
  } catch (e) {
    Logger.log('!! FATAL: cannot open OLD sheet: ' + e.message);
    Logger.log('   Confirm the bot Apps Script has read access to ' + _SOC_OLD_SHEET_ID_);
    return { error: 'cannot_open_old' };
  }
  Logger.log('OLD sheet name: "' + oldSS.getName() + '"');

  // Section 1 -- transactions col D + col E.
  _soc_dumpTxCategories_(oldSS);

  // Section 2 -- personal dashboard row labels.
  _soc_dumpDashboardLabels_(oldSS, _SOC_PERSONAL_TAB_,
    'OLD ma\'azan ishi (personal dashboard)', 2);

  // Section 3 -- company dashboard row labels.
  _soc_dumpDashboardLabels_(oldSS, _SOC_COMPANY_TAB_,
    'OLD ma\'azan chevra (company dashboard)', 3);

  // Section 4 -- cell notes from all three tabs.
  Logger.log('');
  Logger.log('## 4. Cell notes across all 3 tabs');
  _soc_dumpNotes_(oldSS, _SOC_TX_TAB_, 4, 'a');
  _soc_dumpNotes_(oldSS, _SOC_PERSONAL_TAB_, 4, 'b');
  _soc_dumpNotes_(oldSS, _SOC_COMPANY_TAB_, 4, 'c');

  Logger.log('');
  Logger.log('=== DIAGNOSTIC DUMP COMPLETE ===');
  Logger.log('Steven: open View -> Execution log, select all, copy, paste to Claude.');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Optional self-test -- verifies Hebrew escapes decoded correctly after
// paste. Run once after first paste to confirm tab names round-trip.
// ---------------------------------------------------------------------------
function _SOC_SELF_TEST_HEBREW_() {
  Logger.log('TX tab decoded: ' + _SOC_TX_TAB_);
  Logger.log('Personal tab decoded: ' + _SOC_PERSONAL_TAB_);
  Logger.log('Company tab decoded: ' + _SOC_COMPANY_TAB_);
  Logger.log('If any of these prints garbled or backwards, the paste corrupted the strings.');
}
