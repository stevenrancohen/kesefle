/**
 * bot/CELL_NOTES_INVENTORY_TAB_BY_TAB.gs
 *
 * Paste-once Apps Script tool for inventorying cell notes (Sheets
 * comments attached via setNote/getNote) in the OLD sheet
 * (1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo) and the NEW Kesefle
 * sheet (1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A).
 *
 * WHY THIS EXISTS (timeout workaround):
 *   A previous full-sweep tool tried to scan every tab in one run and
 *   hit Apps Script's hard 6-minute execution cap. OLD has multiple
 *   year tabs (2023, 2024, 2025, 2026) plus דשבורד / תנועות / הזמנות
 *   / etc., and the combined cell count is enough to time out.
 *
 *   This tool processes ONE TAB PER RUN, picked via Script Property
 *   CNI_TAB_NAME. Each run fits comfortably under 6 minutes because:
 *     1. We use sheet.getDataRange().getNotes() — ONE batched API call
 *        returning a 2D array — instead of looping cell-by-cell and
 *        calling getNote() each time (which would be N round-trips).
 *     2. We iterate the 2D array purely in memory.
 *     3. Output is capped at 200 cells (configurable) — anything more
 *        is summarized so we never blow the Logger size limit either.
 *
 * HARD RULE — READ-ONLY ON OLD:
 *   OLD sheet (1UKr...) is READ-ONLY FOREVER. This tool NEVER calls
 *   setNote / setValue / setFormula / clearContents / deleteRow on
 *   OLD. It only calls openById + getSheetByName + getNotes() +
 *   getLastRow() + getLastColumn() + getName() on OLD. No mutation
 *   paths exist in this file. There is NO APPLY variant. This is an
 *   inventory / DRY_RUN tool only.
 *
 * USAGE (per-tab workflow):
 *   1. (Once) Run CNI_SELF_TEST_HEBREW — verifies Hebrew constants
 *      render correctly in your editor.
 *   2. (Once per sheet) Run CNI_LIST_TABS_OLD then CNI_LIST_TABS_NEW
 *      to print every tab name + dimensions to the log. Copy the
 *      Hebrew tab name you want to inventory.
 *   3. Project Settings > Script Properties > add CNI_TAB_NAME = <tab>
 *      (paste the exact Hebrew tab name, e.g. תנועות).
 *   4. Run CNI_INVENTORY_ONE_TAB_OLD. Read the log. Copy the output
 *      somewhere safe (the log is ephemeral after 7 days).
 *   5. Change CNI_TAB_NAME to the next tab. Run again. Repeat for
 *      every tab in OLD.
 *   6. For NEW you can either follow the same per-tab workflow with
 *      CNI_INVENTORY_ONE_TAB_NEW, OR run CNI_INVENTORY_ALL_TABS_NEW
 *      once — NEW is smaller and fits in 6 minutes.
 *
 * SAFETY:
 *   - LockService.getScriptLock + tryLock(30000) at the top of every
 *     entry point so concurrent runs (manual click + open editor)
 *     don't race.
 *   - No writes to OLD ever. No writes to NEW either — this is purely
 *     an inventory tool.
 *   - Hebrew constants encoded as \u05XX escape sequences (per the
 *     sheet-hebrew-encoding-safe-script skill) so clipboard / Monaco
 *     paste cannot corrupt RTL on the way in.
 *   - Tab names READ FROM THE SHEET at runtime are normal strings —
 *     Apps Script handles UTF-8 natively in memory; the escape rule
 *     only applies to source-code literals.
 */

// ============================================================
// Constants
// ============================================================
var _CNI_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _CNI_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _CNI_TAB_NAME_PROP_ = 'CNI_TAB_NAME';
var _CNI_MAX_CELLS_LOGGED_ = 200;

// Hebrew constants used by CNI_SELF_TEST_HEBREW only, to verify the
// editor and Logger render UTF-8 round-trip correctly. Each one is
// the well-known Kesefle tab name for the corresponding sheet area.
//   תנועות = תנועות (transactions)
//   הזמנות = הזמנות (orders)
//   מאזן חברה = מאזן חברה
//   מאזן אישי = מאזן אישי
//   דשבורד = דשבורד (dashboard)
var _CNI_HEBREW_TX_       = 'תנועות';
var _CNI_HEBREW_ORDERS_   = 'הזמנות';
var _CNI_HEBREW_BIZ_      = 'מאזן חברה';
var _CNI_HEBREW_PERSONAL_ = 'מאזן אישי';
var _CNI_HEBREW_DASH_     = 'דשבורד';

// ============================================================
// Helpers
// ============================================================

// Convert 1-based column index to A1-style letter(s) (1 -> A, 27 -> AA).
function _cni_colLetter_(colIdx) {
  var s = '';
  var n = colIdx;
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Truncate a note to 80 chars, replace newlines with spaces, for log lines.
function _cni_truncNote_(note) {
  if (note == null) return '';
  var s = String(note).replace(/[\r\n]+/g, ' ');
  if (s.length <= 80) return s;
  return s.slice(0, 80) + '...';
}

// Acquire a script-level lock so concurrent runs don't race.
// Returns the lock or throws.
function _cni_acquireLock_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('CNI: another run is in progress; try again in 30s.');
  }
  return lock;
}

// Read CNI_TAB_NAME Script Property. Throws if unset.
function _cni_readTabNameProp_() {
  var props = PropertiesService.getScriptProperties();
  var tab = props.getProperty(_CNI_TAB_NAME_PROP_);
  if (!tab || !String(tab).trim()) {
    throw new Error('Script Property ' + _CNI_TAB_NAME_PROP_ + ' is not set. ' +
                    'Add it in Project Settings > Script Properties, then re-run.');
  }
  return String(tab).trim();
}

// Inventory one tab. The `label` is used in the log header to make
// it obvious whether we read OLD or NEW. Returns { tab, rows, cols,
// withNotes, sample } — the sample is the first _CNI_MAX_CELLS_LOGGED_
// hits as { a1, note } pairs. Pure function: no mutation, no I/O
// beyond reading the sheet you pass in.
function _cni_inventoryTab_(sheet, label) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return { tab: sheet.getName(), rows: 0, cols: 0, withNotes: 0, sample: [], truncated: false };
  }

  // ONE batched call returns a 2D array of notes for the whole used
  // range. This is the timeout-fix: getNotes once vs getNote per cell.
  var notes = sheet.getRange(1, 1, lastRow, lastCol).getNotes();

  var withNotes = 0;
  var sample = [];
  var truncated = false;
  for (var r = 0; r < notes.length; r++) {
    var rowArr = notes[r];
    for (var c = 0; c < rowArr.length; c++) {
      var n = rowArr[c];
      if (!n) continue;
      withNotes++;
      if (sample.length < _CNI_MAX_CELLS_LOGGED_) {
        sample.push({
          a1: _cni_colLetter_(c + 1) + (r + 1),
          note: _cni_truncNote_(n)
        });
      } else {
        truncated = true;
      }
    }
  }
  return {
    tab: sheet.getName(),
    rows: lastRow,
    cols: lastCol,
    withNotes: withNotes,
    sample: sample,
    truncated: truncated,
    label: label
  };
}

// Format an inventory result as a log block and log it.
function _cni_logInventory_(headerLine, inv) {
  var L = [];
  L.push('=== ' + headerLine + ' ===');
  L.push('Tab: ' + inv.tab + '  Rows: ' + inv.rows + '  Cols: ' + inv.cols);
  L.push('Cells with notes: ' + inv.withNotes);
  for (var i = 0; i < inv.sample.length; i++) {
    L.push('  ' + inv.sample[i].a1 + ' [' + inv.sample[i].note + ']');
  }
  if (inv.truncated) {
    L.push('  ... +' + (inv.withNotes - inv.sample.length) +
           ' more (output capped at ' + _CNI_MAX_CELLS_LOGGED_ + ').');
  }
  Logger.log(L.join('\n'));
  return L.join('\n');
}

// ============================================================
// Entry points
// ============================================================

// Self-test: verify Hebrew constants render correctly in your editor
// and the Logger. If you see boxes or '?' marks here, the file got
// corrupted on its way into the editor — re-paste using base64 or
// the sheet-hebrew-encoding-safe-script flow.
function CNI_SELF_TEST_HEBREW() {
  var lock = _cni_acquireLock_();
  try {
    Logger.log('=== CNI self-test ===');
    Logger.log('tx tab       -> ' + _CNI_HEBREW_TX_);
    Logger.log('orders tab   -> ' + _CNI_HEBREW_ORDERS_);
    Logger.log('biz tab      -> ' + _CNI_HEBREW_BIZ_);
    Logger.log('personal tab -> ' + _CNI_HEBREW_PERSONAL_);
    Logger.log('dash tab     -> ' + _CNI_HEBREW_DASH_);
    Logger.log('OLD sheet id -> ' + _CNI_OLD_SHEET_ID_);
    Logger.log('NEW sheet id -> ' + _CNI_NEW_SHEET_ID_);
    Logger.log('Max cells logged per run -> ' + _CNI_MAX_CELLS_LOGGED_);
    Logger.log('OK: Hebrew constants rendered. If any line above shows boxes/? — re-paste this file.');
    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// List all tabs (name + row/col count) in the OLD sheet. Read-only.
function CNI_LIST_TABS_OLD() {
  var lock = _cni_acquireLock_();
  try {
    return _cni_listTabs_(_CNI_OLD_SHEET_ID_, 'CNI_LIST_TABS_OLD');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// List all tabs (name + row/col count) in the NEW sheet. Read-only.
function CNI_LIST_TABS_NEW() {
  var lock = _cni_acquireLock_();
  try {
    return _cni_listTabs_(_CNI_NEW_SHEET_ID_, 'CNI_LIST_TABS_NEW');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function _cni_listTabs_(sheetId, headerLine) {
  var ss = SpreadsheetApp.openById(sheetId);
  var sheets = ss.getSheets();
  var L = ['=== ' + headerLine + ' ==='];
  L.push('Sheet id: ' + sheetId);
  L.push('Tab count: ' + sheets.length);
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var name = sh.getName();
    var rows = sh.getLastRow();
    var cols = sh.getLastColumn();
    L.push('  ' + (i + 1) + '. "' + name + '"  rows=' + rows + '  cols=' + cols);
  }
  Logger.log(L.join('\n'));
  return L.join('\n');
}

// Inventory ONE tab in OLD, picked by Script Property CNI_TAB_NAME.
// Read-only — OLD is never mutated.
function CNI_INVENTORY_ONE_TAB_OLD() {
  var lock = _cni_acquireLock_();
  try {
    var tabName = _cni_readTabNameProp_();
    var ss = SpreadsheetApp.openById(_CNI_OLD_SHEET_ID_);
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      throw new Error('Tab "' + tabName + '" not found in OLD sheet ' +
                      _CNI_OLD_SHEET_ID_ + '. Run CNI_LIST_TABS_OLD ' +
                      'to see the available tab names.');
    }
    var inv = _cni_inventoryTab_(sh, 'OLD');
    _cni_logInventory_('CNI_INVENTORY_ONE_TAB_OLD', inv);
    return inv;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Inventory ONE tab in NEW, picked by Script Property CNI_TAB_NAME.
// Read-only — this tool never writes to either sheet.
function CNI_INVENTORY_ONE_TAB_NEW() {
  var lock = _cni_acquireLock_();
  try {
    var tabName = _cni_readTabNameProp_();
    var ss = SpreadsheetApp.openById(_CNI_NEW_SHEET_ID_);
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      throw new Error('Tab "' + tabName + '" not found in NEW sheet ' +
                      _CNI_NEW_SHEET_ID_ + '. Run CNI_LIST_TABS_NEW ' +
                      'to see the available tab names.');
    }
    var inv = _cni_inventoryTab_(sh, 'NEW');
    _cni_logInventory_('CNI_INVENTORY_ONE_TAB_NEW', inv);
    return inv;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// Bonus: scan every NEW tab in one go. NEW is post-migration and
// smaller than OLD, so the full sweep fits in the 6-min budget.
// We do NOT offer an equivalent for OLD — that's exactly the case
// that times out, which is why this whole tool exists.
function CNI_INVENTORY_ALL_TABS_NEW() {
  var lock = _cni_acquireLock_();
  try {
    var ss = SpreadsheetApp.openById(_CNI_NEW_SHEET_ID_);
    var sheets = ss.getSheets();
    var results = [];
    var totalWithNotes = 0;
    var L = ['=== CNI_INVENTORY_ALL_TABS_NEW ==='];
    L.push('Sheet id: ' + _CNI_NEW_SHEET_ID_);
    L.push('Tabs to scan: ' + sheets.length);
    L.push('');
    Logger.log(L.join('\n'));
    for (var i = 0; i < sheets.length; i++) {
      var inv = _cni_inventoryTab_(sheets[i], 'NEW');
      _cni_logInventory_('NEW tab ' + (i + 1) + '/' + sheets.length, inv);
      totalWithNotes += inv.withNotes;
      results.push({ tab: inv.tab, withNotes: inv.withNotes, rows: inv.rows, cols: inv.cols });
    }
    Logger.log('=== CNI_INVENTORY_ALL_TABS_NEW summary === total cells with notes across all NEW tabs: ' + totalWithNotes);
    return { ok: true, totalWithNotes: totalWithNotes, perTab: results };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
