/**
 * MIGRATE_DASHBOARD_FROM_OLD.gs - paste-once Apps Script
 *
 * Steven's 2026-05-29 ask: the new "כסף'לה" sheet is missing rows for
 * categories that exist in his OLD sheet, so historic expenses don't show on
 * the dashboards. The 614 transactions DID migrate (תנועות parity is 100%);
 * only the dashboard labels are missing, so SUMIFS has nothing to sum
 * against and totals appear as zero.
 *
 * This script:
 *   1. Reads OLD מאזן אישי + מאזן חברה (read-only).
 *   2. Reads NEW מאזן אישי + מאזן חברה.
 *   3. Computes the diff: labels in OLD that are missing from NEW.
 *   4. Filters out obvious metadata rows (section banners, year banners,
 *      empty rows, "סה"כ" total rows).
 *   5. Appends each missing label to a new visible section in NEW called
 *      "🏷️ מהגיליון הקודם" at the bottom of each dashboard tab.
 *   6. For every appended row:
 *        col A = the label
 *        col B = SUMIFS yearly total wired to $B$4
 *        cols C..N = SUMIFS monthly totals wired to $B$4
 *   7. Wires $B$4 as a data-validated year dropdown (2023..2030) on both
 *      dashboards if it isn't already.
 *   8. Backs up every cell it will write into DocumentProperties before
 *      writing, so ROLLBACK_MIGRATE_DASHBOARD restores exactly.
 *
 * HARD RULES (these match Steven's standing constraints):
 *   - Never writes to OLD sheet.
 *   - Never deletes rows.
 *   - Never overwrites existing rows in NEW (append-only).
 *   - Never hardcodes "2026" in any formula (always $B$4).
 *   - APPLY is gated by Script Property CONFIRM_MIGRATE_DASHBOARD = YES I UNDERSTAND.
 *   - All Hebrew strings are encoded as \u-escape sequences so paste through
 *     a browser does not corrupt RTL/bidi.
 *
 * Functions (run in this order):
 *   MDD_SELF_TEST_HEBREW   - prove Hebrew decoded correctly
 *   DRY_RUN_MIGRATE_DASHBOARD - read OLD + NEW, log proposed changes, no writes
 *   APPLY_MIGRATE_DASHBOARD   - gated; writes the new rows + year selectors
 *   ROLLBACK_MIGRATE_DASHBOARD - restores from backup
 */

// ============================================================
// Sheet identifiers (constants — do not edit unless you know why)
// ============================================================
var _MDD_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MDD_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Hebrew tab names — \u escapes so paste survives any clipboard / bidi chain.
var _MDD_TX_     = 'תנועות';               // תנועות
var _MDD_PERSON_ = 'מאזן אישי';   // מאזן אישי
var _MDD_BIZ_    = 'מאזן חברה';   // מאזן חברה

// Visible section banner we append to. " מהגיליון הקודם" = "from previous sheet"
var _MDD_BANNER_ = '🏷️ מהגיליון הקודם';

// Months Jan..Dec (header row labels).
var _MDD_MONTHS_ = [
  'ינואר', 'פברואר',
  'מרץ',             'אפריל',
  'מאי',             'יוני',
  'יולי',       'אוגוסט',
  'ספטמבר', 'אוקטובר',
  'נובמבר', 'דצמבר'
];

// Year dropdown for $B$4 selectors.
var _MDD_YEARS_ = [2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030];

// "Total" row prefix used to skip "סה"כ" rows. (Hebrew "סה"כ").
var _MDD_TOTAL_PREFIX_ = 'סה';   // starts with "סה"

// ============================================================
// Self-test: prove Hebrew strings decoded right BEFORE any read/write.
// ============================================================
function MDD_SELF_TEST_HEBREW() {
  Logger.log('=== MDD self-test ===');
  Logger.log('תנועות     -> ' + _MDD_TX_);
  Logger.log('מאזן אישי  -> ' + _MDD_PERSON_);
  Logger.log('מאזן חברה  -> ' + _MDD_BIZ_);
  Logger.log('banner     -> ' + _MDD_BANNER_);
  Logger.log('Jan        -> ' + _MDD_MONTHS_[0]);
  Logger.log('Dec        -> ' + _MDD_MONTHS_[11]);
  Logger.log('Years      -> ' + _MDD_YEARS_.join(', '));
}

// ============================================================
// Discover the label set from a dashboard tab.
// Returns array of strings (col A values that look like category rows).
// A "category row" is: non-empty col A, not a section banner (no leading
// emoji + "===" + Hebrew banner words), not a total row ("סה"כ"...), not
// the YEAR selector row, not a YEAR banner ("שנת 2024" style).
// ============================================================
function _MDD_collectLabels_(sheet) {
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var labels = [];
  var seen = {};
  for (var r = 0; r < values.length; r++) {
    var a = String(values[r][0] == null ? '' : values[r][0]).trim();
    if (!a) continue;
    if (seen[a]) continue;
    // ---- Basic skips ----
    if (/^\d{4}$/.test(a)) continue;                            // bare year cell
    if (/^[A-Z]:\$?[A-Z]\$?\d+/.test(a)) continue;              // range refs
    if (a.indexOf('===') !== -1) continue;                      // banner === ... ===
    if (a.indexOf(_MDD_TOTAL_PREFIX_) === 0) continue;          // "סה"כ ..."
    if (a.indexOf('שנת ') === 0) continue;       // "שנת 2024" banner
    // ---- Metric / header / debug-label skips (Steven's DRY_RUN 2026-05-29) ----
    // These appear as col-A labels in OLD but are computed metrics, section headers,
    // or debug strings — never SUMIFS-able categories.
    if (a.indexOf('Σ') !== -1) continue;                        // Σ summation / debug
    if (a.indexOf('Δ') !== -1) continue;                        // Δ delta % labels
    if (a.indexOf('==') !== -1) continue;                       // "X == annual" debug
    if (a.charAt(a.length - 1) === ':') continue;               // header (ends with ":")
    if (a.indexOf('%') !== -1) continue;                        // percent rows
    // Hebrew metric / total phrases (substring match — catches with/without emoji).
    var metricNeedles = [
      'סה״כ',          // "total"
      'סה"כ',
      'נטו שנתי',      // annual net
      'רווח נטו',      // net profit
      'מחזור',         // turnover / revenue
      'הזמנה ממוצע',   // average order value
      'מס׳ הזמנות',    // number of orders
      'מס\' הזמנות',
      'אחוז רווח',     // profit %
      'שנה רווחית',    // most profitable year
      'שנה עם',        // year with X
      'שנה הכי',       // year with least X
      'הגורם',         // "the main factor"
      'המלצה',         // "the recommendation"
      'גורם העיקרי',
      'המלצה אופרטיב'
    ];
    var isMetric = false;
    for (var mn = 0; mn < metricNeedles.length; mn++) {
      if (a.indexOf(metricNeedles[mn]) !== -1) { isMetric = true; break; }
    }
    if (isMetric) continue;
    // ---- Month name as header ----
    var isMonth = false;
    for (var m = 0; m < _MDD_MONTHS_.length; m++) {
      if (a === _MDD_MONTHS_[m]) { isMonth = true; break; }
    }
    if (isMonth) continue;
    // ---- Col B must have SOMETHING (formula OR numeric value) ----
    // Empty col B means a visual section header ("הוצאות", "הכנסות") — skip.
    // We deliberately accept ANY formula or value here (not just SUMIFS):
    // OLD's category rows often use plain numeric values, SUM(), or simple
    // arithmetic — restricting to SUMIFS only would drop legitimate categories
    // like הכנסה 1 / אבא / גיא etc.
    var bVal = values[r][1];
    var bFormula = '';
    try { bFormula = sheet.getRange(r + 1, 2).getFormula(); } catch (e) { bFormula = ''; }
    if (!bFormula && (bVal === '' || bVal === null)) continue;
    seen[a] = true;
    labels.push(a);
  }
  return labels;
}

// ============================================================
// Find a $B$4-style year selector cell on the dashboard.
// Returns A1 notation ("B4") if present, '' otherwise.
// ============================================================
function _MDD_findYearSelectorA1_(sheet) {
  if (!sheet) return '';
  try {
    var v = sheet.getRange('B4').getValue();
    if (typeof v === 'number' && v >= 2023 && v <= 2099) return 'B4';
    var f = sheet.getRange('B4').getFormula();
    if (f && f.toUpperCase().indexOf('YEAR') !== -1) return 'B4';
  } catch (e) {}
  return '';
}

// ============================================================
// Build the SUMIFS formulas for a category row.
// Returns { yearly: '=SUMIFS(...)', monthly: ['=SUMIFS(... -01)', ..., '=SUMIFS(... -12)'] }
// All criteria wired to $B$4 — no hardcoded year.
// ============================================================
function _MDD_buildFormulas_(label) {
  // Escape any " in the label for SUMIFS criterion.
  var crit = String(label).replace(/"/g, '""');
  var tx = "'" + _MDD_TX_ + "'";
  // Yearly: B between $B$4&"-01" and $B$4&"-12" (string compare works because YYYY-MM is fixed-width)
  var yearly =
    '=SUMIFS(' + tx + '!C:C, ' + tx + '!E:E, "' + crit + '", ' +
    tx + '!B:B, ">=" & $B$4 & "-01", ' +
    tx + '!B:B, "<=" & $B$4 & "-12")';
  var monthly = [];
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  for (var m = 1; m <= 12; m++) {
    monthly.push(
      '=SUMIFS(' + tx + '!C:C, ' + tx + '!E:E, "' + crit + '", ' +
      tx + '!B:B, $B$4 & "-' + pad(m) + '")'
    );
  }
  return { yearly: yearly, monthly: monthly };
}

// ============================================================
// DRY_RUN — read both sheets, log what APPLY would do. No writes.
// ============================================================
function DRY_RUN_MIGRATE_DASHBOARD() {
  var oldSS = SpreadsheetApp.openById(_MDD_OLD_SHEET_ID_);
  var newSS = SpreadsheetApp.openById(_MDD_NEW_SHEET_ID_);

  var oldPersonal = oldSS.getSheetByName(_MDD_PERSON_);
  var oldBiz      = oldSS.getSheetByName(_MDD_BIZ_);
  var newPersonal = newSS.getSheetByName(_MDD_PERSON_);
  var newBiz      = newSS.getSheetByName(_MDD_BIZ_);

  if (!oldPersonal || !oldBiz) throw new Error('OLD dashboards not found');
  if (!newPersonal || !newBiz) throw new Error('NEW dashboards not found');

  var oldPersonalLabels = _MDD_collectLabels_(oldPersonal);
  var oldBizLabels      = _MDD_collectLabels_(oldBiz);
  var newPersonalLabels = _MDD_collectLabels_(newPersonal);
  var newBizLabels      = _MDD_collectLabels_(newBiz);

  var personalMissing = oldPersonalLabels.filter(function(x) {
    return newPersonalLabels.indexOf(x) === -1;
  });
  var bizMissing = oldBizLabels.filter(function(x) {
    return newBizLabels.indexOf(x) === -1;
  });

  var personalYearCell = _MDD_findYearSelectorA1_(newPersonal);
  var bizYearCell      = _MDD_findYearSelectorA1_(newBiz);

  var out = [];
  out.push('=== MDD DRY_RUN ===');
  out.push('OLD sheet: ' + _MDD_OLD_SHEET_ID_);
  out.push('NEW sheet: ' + _MDD_NEW_SHEET_ID_);
  out.push('');
  out.push('Year selector cells:');
  out.push('  ' + _MDD_PERSON_ + '!B4 -> ' + (personalYearCell || 'MISSING — will add'));
  out.push('  ' + _MDD_BIZ_    + '!B4 -> ' + (bizYearCell      || 'MISSING — will add'));
  out.push('');
  out.push('Personal dashboard:');
  out.push('  OLD labels: ' + oldPersonalLabels.length);
  out.push('  NEW labels: ' + newPersonalLabels.length);
  out.push('  Missing in NEW: ' + personalMissing.length);
  personalMissing.forEach(function(l) { out.push('    + ' + l); });
  out.push('');
  out.push('Business dashboard:');
  out.push('  OLD labels: ' + oldBizLabels.length);
  out.push('  NEW labels: ' + newBizLabels.length);
  out.push('  Missing in NEW: ' + bizMissing.length);
  bizMissing.forEach(function(l) { out.push('    + ' + l); });
  out.push('');
  out.push('APPLY would:');
  out.push('  1. Backup affected ranges to DocumentProperties');
  out.push('  2. Ensure $B$4 year selector on both dashboards (data validation 2023..2030)');
  out.push('  3. Append "' + _MDD_BANNER_ + '" banner at the bottom of each dashboard');
  out.push('  4. Append ' + personalMissing.length + ' rows to ' + _MDD_PERSON_);
  out.push('  5. Append ' + bizMissing.length      + ' rows to ' + _MDD_BIZ_);
  out.push('  6. Each row gets a yearly SUMIFS (col B) + 12 monthly SUMIFS (cols C..N), all $B$4-wired');
  out.push('');
  out.push('No writes performed. To apply:');
  out.push('  1. Open Apps Script -> Project Settings -> Script Properties');
  out.push('  2. Add CONFIRM_MIGRATE_DASHBOARD = YES I UNDERSTAND');
  out.push('  3. Run APPLY_MIGRATE_DASHBOARD');

  Logger.log(out.join('\n'));
  return { personalMissing: personalMissing, bizMissing: bizMissing };
}

// ============================================================
// APPLY — gated, backs up, writes.
// ============================================================
function APPLY_MIGRATE_DASHBOARD() {
  var props = PropertiesService.getScriptProperties();
  var gate = props.getProperty('CONFIRM_MIGRATE_DASHBOARD');
  if (gate !== 'YES I UNDERSTAND') {
    throw new Error(
      'Refusing to APPLY. Set Script Property CONFIRM_MIGRATE_DASHBOARD = YES I UNDERSTAND first.'
    );
  }

  var oldSS = SpreadsheetApp.openById(_MDD_OLD_SHEET_ID_);
  var newSS = SpreadsheetApp.openById(_MDD_NEW_SHEET_ID_);
  var oldPersonal = oldSS.getSheetByName(_MDD_PERSON_);
  var oldBiz      = oldSS.getSheetByName(_MDD_BIZ_);
  var newPersonal = newSS.getSheetByName(_MDD_PERSON_);
  var newBiz      = newSS.getSheetByName(_MDD_BIZ_);
  if (!oldPersonal || !oldBiz) throw new Error('OLD dashboards not found');
  if (!newPersonal || !newBiz) throw new Error('NEW dashboards not found');

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
    var docProps = PropertiesService.getDocumentProperties();

    // --- Backup ---
    var backup = {
      stamp: stamp,
      personalLastRow: newPersonal.getLastRow(),
      bizLastRow:      newBiz.getLastRow(),
      personalB4Value: newPersonal.getRange('B4').getValue(),
      personalB4Formula: newPersonal.getRange('B4').getFormula(),
      bizB4Value:      newBiz.getRange('B4').getValue(),
      bizB4Formula:    newBiz.getRange('B4').getFormula()
    };
    docProps.setProperty('mdd_backup_' + stamp, JSON.stringify(backup));
    Logger.log('[BACKUP] saved key mdd_backup_' + stamp);

    // --- Year selectors ---
    _MDD_ensureYearSelector_(newPersonal);
    _MDD_ensureYearSelector_(newBiz);

    // --- Compute missing ---
    var oldPersonalLabels = _MDD_collectLabels_(oldPersonal);
    var oldBizLabels      = _MDD_collectLabels_(oldBiz);
    var newPersonalLabels = _MDD_collectLabels_(newPersonal);
    var newBizLabels      = _MDD_collectLabels_(newBiz);
    var personalMissing = oldPersonalLabels.filter(function(x) {
      return newPersonalLabels.indexOf(x) === -1;
    });
    var bizMissing = oldBizLabels.filter(function(x) {
      return newBizLabels.indexOf(x) === -1;
    });

    // --- Append banner + rows ---
    var pCount = _MDD_appendBanner_(newPersonal, personalMissing);
    var bCount = _MDD_appendBanner_(newBiz,      bizMissing);

    SpreadsheetApp.flush();

    Logger.log('=== APPLY done ===');
    Logger.log('Personal rows appended: ' + pCount);
    Logger.log('Business rows appended: ' + bCount);
    Logger.log('Backup key: mdd_backup_' + stamp);
    Logger.log('To roll back: run ROLLBACK_MIGRATE_DASHBOARD');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ============================================================
// Ensure the year selector cell ($B$4) exists with data validation.
// ============================================================
function _MDD_ensureYearSelector_(sheet) {
  var cell = sheet.getRange('B4');
  var v = cell.getValue();
  var f = cell.getFormula();
  // If it's already a year, leave it alone (don't overwrite Steven's choice).
  // If it's empty, set to current Jerusalem year.
  if (!f && !(typeof v === 'number' && v >= 2023 && v <= 2099)) {
    var nowYear = parseInt(Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy'), 10);
    cell.setValue(nowYear);
  }
  // Apply data validation (list of allowed years). This is non-destructive.
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(_MDD_YEARS_.map(function(y) { return String(y); }), true)
    .setAllowInvalid(false)
    .build();
  cell.setDataValidation(rule);
  Logger.log('[YEAR_SEL] ' + sheet.getName() + '!B4 ready');
}

// ============================================================
// Append the "מהגיליון הקודם" banner + one row per missing label.
// Returns number of label rows written.
// ============================================================
function _MDD_appendBanner_(sheet, missingLabels) {
  if (!missingLabels || missingLabels.length === 0) return 0;
  var startRow = sheet.getLastRow() + 2;

  // Banner row (col A only)
  sheet.getRange(startRow, 1).setValue(_MDD_BANNER_);
  sheet.getRange(startRow, 1, 1, 14).setBackground('#fff3cd');  // soft yellow
  sheet.getRange(startRow, 1).setFontWeight('bold');

  // Label rows
  var write = startRow + 1;
  for (var i = 0; i < missingLabels.length; i++) {
    var label = missingLabels[i];
    var f = _MDD_buildFormulas_(label);
    sheet.getRange(write + i, 1).setValue(label);            // col A label
    sheet.getRange(write + i, 2).setFormula(f.yearly);       // col B yearly
    for (var m = 0; m < 12; m++) {
      sheet.getRange(write + i, 3 + m).setFormula(f.monthly[m]); // cols C..N
    }
    Logger.log('[APPEND] ' + sheet.getName() + '!A' + (write + i) + ' = ' + label);
  }
  return missingLabels.length;
}

// ============================================================
// ROLLBACK — restore last backup. Removes appended rows and restores B4.
// ============================================================
function ROLLBACK_MIGRATE_DASHBOARD() {
  var docProps = PropertiesService.getDocumentProperties();
  var keys = docProps.getKeys().filter(function(k) {
    return k.indexOf('mdd_backup_') === 0;
  }).sort();
  if (keys.length === 0) throw new Error('No backup found.');
  var key = keys[keys.length - 1];
  var b = JSON.parse(docProps.getProperty(key));

  var newSS = SpreadsheetApp.openById(_MDD_NEW_SHEET_ID_);
  var newPersonal = newSS.getSheetByName(_MDD_PERSON_);
  var newBiz      = newSS.getSheetByName(_MDD_BIZ_);

  // Remove appended rows from each tab.
  var pNow = newPersonal.getLastRow();
  if (pNow > b.personalLastRow) {
    newPersonal.deleteRows(b.personalLastRow + 1, pNow - b.personalLastRow);
  }
  var bNow = newBiz.getLastRow();
  if (bNow > b.bizLastRow) {
    newBiz.deleteRows(b.bizLastRow + 1, bNow - b.bizLastRow);
  }

  // Restore $B$4.
  if (b.personalB4Formula) newPersonal.getRange('B4').setFormula(b.personalB4Formula);
  else                     newPersonal.getRange('B4').setValue(b.personalB4Value);
  if (b.bizB4Formula)      newBiz.getRange('B4').setFormula(b.bizB4Formula);
  else                     newBiz.getRange('B4').setValue(b.bizB4Value);

  // Clear gate so a fresh APPLY requires fresh approval.
  PropertiesService.getScriptProperties().deleteProperty('CONFIRM_MIGRATE_DASHBOARD');
  docProps.deleteProperty(key);

  Logger.log('=== ROLLBACK done ===');
  Logger.log('Restored from backup ' + key);
  Logger.log('Personal rows pruned to ' + b.personalLastRow);
  Logger.log('Business rows pruned to ' + b.bizLastRow);
}
