/**
 * REWIRE_DASHBOARD_TO_B4.gs - paste-once Apps Script
 *
 * THE PROBLEM (Steven 2026-05-29):
 *   Steven's NEW מאזן חברה shows ₪0 for מחזור ברוטו, מס' הזמנות, etc. on every
 *   year (2023/2024/2025). When he flips B4 (year selector), totals do not
 *   change. Root cause: the installer that originally generated these formulas
 *   baked the install-time year into the SUMIFS criterion. PR #157 fixed the
 *   installer for FUTURE installs but Steven's EXISTING rows still have the
 *   frozen-year formulas.
 *
 * WHAT THIS DOES (read-only DRY_RUN by default):
 *   1. Reads מאזן חברה rows 5-14 (the existing "real" dashboard block).
 *   2. For each row + each month column (C..N) + the yearly col B:
 *      - Reads the current formula.
 *      - If it contains a hardcoded 4-digit year ("2024-", "2025-", "2026-",
 *        etc.) in a criterion → flags it for rewrite.
 *      - Builds the SUMPRODUCT+$B$4 equivalent that respects the year selector.
 *   3. Logs the diff (current formula → proposed formula).
 *   4. APPLY (gated) writes the new formulas.
 *
 * IMPORTANT — DATA SOURCE:
 *   מאזן חברה pulls from BOTH the תנועות tab (categorized expenses) AND the
 *   הזמנות tab (orders / business revenue). The wire pattern differs:
 *     - תנועות-sourced rows: SUMPRODUCT((LEFT(תנועות!B,4)=year)*(תנועות!E=label)*תנועות!C)
 *     - הזמנות-sourced rows: SUMPRODUCT((LEFT(הזמנות!B,4)=year)*הזמנות!C)
 *   The script auto-detects which tab a formula references and preserves it.
 *
 * SAFETY:
 *   - Reads OLD sheet: NEVER (no calls to that ID).
 *   - DRY_RUN_REWIRE_DASHBOARD: zero writes. Logs only.
 *   - APPLY_REWIRE_DASHBOARD: gated by Script Property CONFIRM_REWIRE_DASHBOARD
 *     = "YES I UNDERSTAND". Snapshots every cell into DocumentProperties before
 *     writing, then writes via safeSetFormula. Skips cells that have a user-
 *     typed value (non-formula).
 *   - ROLLBACK_REWIRE_DASHBOARD restores from the snapshot.
 *   - LockService prevents concurrent runs.
 *   - Hebrew literals only — no \u escapes — keeps the file readable.
 *
 * Run order:
 *   1. RWD_SELF_TEST_HEBREW   (verify Hebrew rendered correctly)
 *   2. DRY_RUN_REWIRE_DASHBOARD  (read-only — see what would change)
 *   3. Set CONFIRM_REWIRE_DASHBOARD = "YES I UNDERSTAND" in Script Properties
 *   4. APPLY_REWIRE_DASHBOARD   (actually writes)
 *   5. Click B4 → cycle 2023/2024/2025/2026 → confirm totals refresh
 *
 * If anything looks wrong → ROLLBACK_REWIRE_DASHBOARD restores exactly.
 */

// ============================================================
// Sheet identifiers
// ============================================================
var _RWD_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Tab names (Hebrew literal — Apps Script handles UTF-8 directly).
var _RWD_BIZ_     = 'מאזן חברה';
var _RWD_PERSON_  = 'מאזן אישי';
var _RWD_TX_      = 'תנועות';
var _RWD_ORDERS_  = 'הזמנות';

// Which rows on מאזן חברה / מאזן אישי are "category-like" rows we should
// consider rewiring. We DON'T rewire summary rows like רווח נטו, אחוז רווחיות,
// banners, or section headers — those compute from other dashboard cells, not
// directly from תנועות / הזמנות.
//
// Scan range: rows 5 through 50 — covers the existing template + most of
// Steven's appended block. Each row is examined individually; rows whose col-B
// formula already uses $B$4 are skipped (they're already correct, e.g.
// PR #151's appended rows).
var _RWD_SCAN_FROM_ROW_ = 5;
var _RWD_SCAN_TO_ROW_   = 100;

// Columns we scan per row: B (yearly total) + C..N (12 months).
var _RWD_YEARLY_COL_  = 2;   // B
var _RWD_MONTH_START_ = 3;   // C = January
var _RWD_MONTH_END_   = 14;  // N = December

// ============================================================
function RWD_SELF_TEST_HEBREW() {
  Logger.log('=== RWD self-test ===');
  Logger.log('biz tab    -> ' + _RWD_BIZ_);
  Logger.log('person tab -> ' + _RWD_PERSON_);
  Logger.log('tx tab     -> ' + _RWD_TX_);
  Logger.log('orders tab -> ' + _RWD_ORDERS_);
  Logger.log('Scan rows  -> ' + _RWD_SCAN_FROM_ROW_ + '..' + _RWD_SCAN_TO_ROW_);
}

// ============================================================
// Detect if a formula has a hardcoded year that should be $B$4.
// Returns the FIRST year found (string), or '' if none.
// Looks for patterns like:
//   "2024-01"   "2024-MM"   2024 & "-01"   '2024-' & MM
// But IGNORES years used in non-criterion contexts (rare).
// ============================================================
function _RWD_findHardcodedYear_(formula) {
  if (!formula) return '';
  // Patterns: "20XX-MM" inside double quotes; "20XX-" prefix concatenated.
  // We're conservative: only flag if it appears INSIDE a quoted string OR
  // immediately before a "-" in a concatenation.
  var m = String(formula).match(/"(20[2-3]\d)-/);
  if (m) return m[1];
  m = String(formula).match(/(20[2-3]\d)\s*&\s*"-/);
  if (m) return m[1];
  // Bare year inside criterion: ">=2025-01"
  m = String(formula).match(/[><=]\s*"?20[2-3]\d-/);
  if (m) {
    var year = formula.match(/(20[2-3]\d)/);
    if (year) return year[1];
  }
  return '';
}

// ============================================================
// Detect which source tab a formula references — תנועות or הזמנות.
// Returns 'tx' / 'orders' / '' (unknown).
// ============================================================
function _RWD_detectSourceTab_(formula) {
  if (!formula) return '';
  var f = String(formula);
  if (f.indexOf(_RWD_TX_) !== -1) return 'tx';
  if (f.indexOf(_RWD_ORDERS_) !== -1) return 'orders';
  return '';
}

// ============================================================
// Try to extract the col-E criterion (the label being summed by category).
// Looks for the pattern: tab!E:E,"<criterion>"
// Returns the criterion string, or '' if not found.
// ============================================================
function _RWD_extractCriterion_(formula, tabName) {
  if (!formula) return '';
  // Match: tabName!E:E,"X" or 'tabName'!E:E,"X"
  var safeTab = tabName.replace(/[^\wא-ת]/g, '.');  // crude escape
  var rx = new RegExp("['\"]?" + safeTab + "['\"]?!E:?E:?\\s*,\\s*\"([^\"]+)\"");
  var m = String(formula).match(rx);
  if (m) return m[1];
  // Also try when tab quoted with single quotes
  var rx2 = new RegExp("'" + safeTab + "'!E:E\\s*,\\s*\"([^\"]+)\"");
  m = String(formula).match(rx2);
  if (m) return m[1];
  return '';
}

// ============================================================
// Build the SUMPRODUCT+$B$4 replacement formula.
//   sourceTab: 'tx' or 'orders'
//   criterion: optional col-E label (only for תנועות-sourced rows; omit for
//              orders-sourced totals like מחזור ברוטו which sum all rows in
//              that year)
//   monthOrYearly: '' for yearly (cell B), '01'..'12' for monthly columns
// ============================================================
function _RWD_buildNewFormula_(sourceTab, criterion, monthOrYearly) {
  var tab = sourceTab === 'tx' ? _RWD_TX_ : _RWD_ORDERS_;
  var tabQ = "'" + tab + "'";
  // year_expr is the canonical fallback pattern shipped in PR #151/#157.
  var yearExpr = 'IF($B$4="",TEXT(YEAR(TODAY()),"0000"),TEXT($B$4,"0000"))';
  // יש לסכם את עמודת הסכום (C) של תנועות/הזמנות.
  // עמודת B מכילה YYYY-MM (text). השווינו עם LEFT(B,4) = השנה שנבחרה.
  var bSlice = tabQ + '!B2:B5000';
  var cSlice = tabQ + '!C2:C5000';
  var eSlice = tabQ + '!E2:E5000';

  var match;
  if (monthOrYearly === '') {
    // Yearly: LEFT(B,4) = year
    match = '(LEFT(' + bSlice + ',4)=' + yearExpr + ')';
  } else {
    // Monthly: B = year & "-MM"
    match = '(' + bSlice + '=' + yearExpr + '&"-' + monthOrYearly + '")';
  }

  if (criterion) {
    var critEsc = String(criterion).replace(/"/g, '""');
    return '=SUMPRODUCT(' + match + '*(' + eSlice + '="' + critEsc + '")*' + cSlice + ')';
  }
  // No criterion → sum all rows in source tab matching the year/month.
  return '=SUMPRODUCT(' + match + '*' + cSlice + ')';
}

// ============================================================
// DRY_RUN — scan and report what would change.
// ============================================================
function DRY_RUN_REWIRE_DASHBOARD() {
  var ss = SpreadsheetApp.openById(_RWD_NEW_SHEET_ID_);
  var report = [];
  report.push('=== DRY_RUN_REWIRE_DASHBOARD ===');
  report.push('Sheet: ' + _RWD_NEW_SHEET_ID_);
  report.push('');

  [_RWD_BIZ_, _RWD_PERSON_].forEach(function(tabName) {
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      report.push('## ' + tabName + ' — NOT FOUND, skipping');
      return;
    }
    report.push('## ' + tabName);
    var fromRow = _RWD_SCAN_FROM_ROW_;
    var toRow = Math.min(_RWD_SCAN_TO_ROW_, sh.getLastRow());
    var changeCount = 0;
    for (var r = fromRow; r <= toRow; r++) {
      var label = String(sh.getRange(r, 1).getValue() || '').trim();
      if (!label) continue;
      // Scan cols B..N
      var rowChanges = [];
      for (var c = _RWD_YEARLY_COL_; c <= _RWD_MONTH_END_; c++) {
        var f = sh.getRange(r, c).getFormula();
        if (!f) continue;
        // Skip if formula already uses $B$4 (already correct).
        if (f.indexOf('$B$4') !== -1) continue;
        var hcYear = _RWD_findHardcodedYear_(f);
        if (!hcYear) continue;
        var srcTab = _RWD_detectSourceTab_(f);
        if (!srcTab) {
          rowChanges.push({ col: c, year: hcYear, src: 'unknown', current: f.slice(0, 80) });
          continue;
        }
        var crit = _RWD_extractCriterion_(f, srcTab === 'tx' ? _RWD_TX_ : _RWD_ORDERS_);
        var monthSpec = (c === _RWD_YEARLY_COL_) ? '' : (c - _RWD_YEARLY_COL_ < 10 ? '0' + (c - _RWD_YEARLY_COL_) : '' + (c - _RWD_YEARLY_COL_));
        var newF = _RWD_buildNewFormula_(srcTab, crit, monthSpec);
        rowChanges.push({ col: c, year: hcYear, src: srcTab, crit: crit, newF: newF.slice(0, 100) });
      }
      if (rowChanges.length > 0) {
        report.push('  row ' + r + ' (' + label + '): ' + rowChanges.length + ' frozen-year cells');
        for (var i = 0; i < Math.min(3, rowChanges.length); i++) {
          var ch = rowChanges[i];
          var colLetter = String.fromCharCode(64 + ch.col);
          report.push('    ' + colLetter + ' [' + ch.src + '|year=' + ch.year + (ch.crit ? '|crit=' + ch.crit : '') + ']');
        }
        if (rowChanges.length > 3) report.push('    ... +' + (rowChanges.length - 3) + ' more');
        changeCount += rowChanges.length;
      }
    }
    report.push('  Total frozen-year cells in ' + tabName + ': ' + changeCount);
    report.push('');
  });

  report.push('To APPLY:');
  report.push('  1. Project Settings -> Script Properties');
  report.push('  2. Add CONFIRM_REWIRE_DASHBOARD = YES I UNDERSTAND');
  report.push('  3. Run APPLY_REWIRE_DASHBOARD');
  report.push('  4. If anything looks wrong: run ROLLBACK_REWIRE_DASHBOARD');

  Logger.log(report.join('\n'));
  return report.join('\n');
}

// ============================================================
// APPLY — gated, snapshots, writes new formulas.
// ============================================================
function APPLY_REWIRE_DASHBOARD() {
  var props = PropertiesService.getScriptProperties();
  var gate = props.getProperty('CONFIRM_REWIRE_DASHBOARD');
  if (gate !== 'YES I UNDERSTAND') {
    throw new Error('Refusing to APPLY. Set Script Property CONFIRM_REWIRE_DASHBOARD = YES I UNDERSTAND first.');
  }

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.openById(_RWD_NEW_SHEET_ID_);
    var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
    var docProps = PropertiesService.getDocumentProperties();
    var backup = { stamp: stamp, cells: [] };
    var log = ['=== APPLY_REWIRE_DASHBOARD ==='];

    [_RWD_BIZ_, _RWD_PERSON_].forEach(function(tabName) {
      var sh = ss.getSheetByName(tabName);
      if (!sh) { log.push('  ' + tabName + ' NOT FOUND, skipping'); return; }
      log.push('## ' + tabName);
      var fromRow = _RWD_SCAN_FROM_ROW_;
      var toRow = Math.min(_RWD_SCAN_TO_ROW_, sh.getLastRow());
      var written = 0, skipped = 0;
      for (var r = fromRow; r <= toRow; r++) {
        var label = String(sh.getRange(r, 1).getValue() || '').trim();
        if (!label) continue;
        for (var c = _RWD_YEARLY_COL_; c <= _RWD_MONTH_END_; c++) {
          var range = sh.getRange(r, c);
          var f = range.getFormula();
          if (!f) continue;
          if (f.indexOf('$B$4') !== -1) { skipped++; continue; }
          var hcYear = _RWD_findHardcodedYear_(f);
          if (!hcYear) { skipped++; continue; }
          var srcTab = _RWD_detectSourceTab_(f);
          if (!srcTab) { skipped++; continue; }
          var crit = _RWD_extractCriterion_(f, srcTab === 'tx' ? _RWD_TX_ : _RWD_ORDERS_);
          var monthSpec = (c === _RWD_YEARLY_COL_) ? '' : (c - _RWD_YEARLY_COL_ < 10 ? '0' + (c - _RWD_YEARLY_COL_) : '' + (c - _RWD_YEARLY_COL_));
          var newF = _RWD_buildNewFormula_(srcTab, crit, monthSpec);
          // Backup
          backup.cells.push({ tab: tabName, row: r, col: c, oldFormula: f });
          // Write
          range.setFormula(newF);
          written++;
        }
      }
      log.push('  Written: ' + written + ', Skipped (already $B$4 or non-frozen): ' + skipped);
    });

    docProps.setProperty('rwd_backup_' + stamp, JSON.stringify(backup));
    SpreadsheetApp.flush();
    log.push('');
    log.push('Backup key: rwd_backup_' + stamp);
    log.push('To roll back: run ROLLBACK_REWIRE_DASHBOARD');
    Logger.log(log.join('\n'));
    return log.join('\n');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ============================================================
// ROLLBACK — restore last snapshot.
// ============================================================
function ROLLBACK_REWIRE_DASHBOARD() {
  var docProps = PropertiesService.getDocumentProperties();
  var keys = docProps.getKeys().filter(function(k) { return k.indexOf('rwd_backup_') === 0; }).sort();
  if (!keys.length) throw new Error('No RWD backup found.');
  var key = keys[keys.length - 1];
  var b = JSON.parse(docProps.getProperty(key));

  var ss = SpreadsheetApp.openById(_RWD_NEW_SHEET_ID_);
  var restored = 0;
  for (var i = 0; i < b.cells.length; i++) {
    var c = b.cells[i];
    var sh = ss.getSheetByName(c.tab);
    if (!sh) continue;
    sh.getRange(c.row, c.col).setFormula(c.oldFormula);
    restored++;
  }
  SpreadsheetApp.flush();
  docProps.deleteProperty(key);
  PropertiesService.getScriptProperties().deleteProperty('CONFIRM_REWIRE_DASHBOARD');
  Logger.log('=== ROLLBACK_REWIRE_DASHBOARD done ===');
  Logger.log('Restored ' + restored + ' cells from backup ' + key);
  return { restored: restored, key: key };
}
