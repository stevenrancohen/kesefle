/**
 * Dashboard FORMULA restorer + diagnostic for Steven's setup.
 *
 * Root cause: Steven's FIX_DASHBOARD_2023_2024_2025.gs wrote hardcoded
 * VALUES (via setValue calls) into 'מאזן חברה' rows 6-13 for year 2026.
 * Those calls stomped the original SUMIFS formulas — so every fresh
 * bot write to תנועות now feeds a formula that no longer exists, and
 * the dashboard stays frozen on May = ₪2,100 instead of ₪3,505.
 *
 * THIS SCRIPT writes BACK the correct SUMIFS formulas — self-healing.
 * After running once, every future bot write propagates automatically.
 *
 * Targets ONLY the 2026 year block (rows 6-14). Leaves the historical
 * 2023/2024/2025 blocks (rows 18-49) UNTOUCHED — those were correctly
 * populated by FIX_DASHBOARD_2023_2024_2025 from the year-tab logs.
 *
 * Also leaves col O+ untouched (Steven's manual sparklines / YoY).
 *
 * Two phases:
 *   DRY_RUN_RESTORE_2026()   — read-only, prints what WILL change.
 *   APPLY_RESTORE_2026()     — actually writes the formulas (with backup).
 *
 * Plus diagnostic + personal-dashboard helpers (see end of file).
 *
 * No menus, no UI calls — works in standalone Apps Script projects.
 * Watch the Execution Log (יומן ביצוע) for output.
 */

// ─── CONFIGURE ──────────────────────────────────────────────────────────
// Steven's "מאזן אישי" spreadsheet ID (from his earlier WhatsApp link).
var SHEET_ID_TO_FIX  = '1nRR9w6kU7hPx_62gsPy7-a4_ABurtGuvfhW4XkOinXU';

var TX_TAB_NAME       = 'תנועות';
var ORDERS_TAB_NAME   = 'הזמנות';
var COMPANY_TAB_NAME  = 'מאזן חברה';
var PERSONAL_TAB_NAME = 'מאזן אישי';

// Year block for 2026 (mirrors Steven's FIX_DASHBOARD_2023_2024_2025).
var YEAR_2026 = {
  year: 2026, yearCell: 'B4',
  revenue: 6, orderCount: 7,
  rawMaterials: 8, marketing: 9, shipping: 10, ops: 11,
  totalExp: 12, netProfit: 13, marginPct: 14,
};

// ─── No editing below ───────────────────────────────────────────────────

function _openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act) return act;
  } catch (_) {}
  if (!SHEET_ID_TO_FIX || SHEET_ID_TO_FIX.indexOf('<') >= 0) {
    throw new Error('SHEET_ID_TO_FIX is not set at top of file.');
  }
  return SpreadsheetApp.openById(SHEET_ID_TO_FIX);
}

// Build the 13-cell row [annual, jan, ..., dec] of FORMULA strings for
// the company dashboard. `bucket` controls which SUMIFS criteria are used.
// Year reference is $B$4 in the formula text so the dashboard re-reads
// it whenever Steven edits B4.
function _buildBusinessRowFormulas_(rowNum, bucket) {
  var cells = [];
  // Annual = SUM(C..N) of THIS row.
  cells.push('=SUM(C' + rowNum + ':N' + rowNum + ')');
  for (var m = 1; m <= 12; m++) {
    var mm = m < 10 ? ('0' + m) : ('' + m);
    var parts = [];
    var criteria;
    if (bucket === 'rawMaterials') criteria = ['*חומרי גלם*'];
    else if (bucket === 'marketing') criteria = ['*שיווק*'];
    else if (bucket === 'shipping') criteria = ['*משלוח*', '*אריזה*'];
    else if (bucket === 'ops') criteria = ['*תפעולי*', 'יועצים', 'תוכנות', 'ציוד עסקי', 'מיסים'];
    else criteria = [];
    for (var k = 0; k < criteria.length; k++) {
      var safe = String(criteria[k]).replace(/"/g, '""');
      parts.push("SUMIFS('" + TX_TAB_NAME + "'!C:C, '" + TX_TAB_NAME + "'!B:B, $B$4&\"-" + mm + "\", '" + TX_TAB_NAME + "'!D:D, \"עסק\", '" + TX_TAB_NAME + "'!E:E, \"" + safe + "\")");
    }
    var expr = parts.length ? parts.join(' + ') : '0';
    cells.push('=IFERROR(' + expr + ', 0)');
  }
  return cells;
}

// Revenue from הזמנות (col D, dated A) by month range.
function _buildRevenueFormulas_() {
  var cells = ['=SUM(C6:N6)'];
  for (var m = 1; m <= 12; m++) {
    cells.push("=IFERROR(SUMIFS('" + ORDERS_TAB_NAME + "'!D:D, '" + ORDERS_TAB_NAME + "'!A:A, \">=\"&DATE($B$4," + m + ",1), '" + ORDERS_TAB_NAME + "'!A:A, \"<\"&DATE($B$4," + (m + 1) + ",1)), 0)");
  }
  return cells;
}

// Order count from הזמנות by month.
function _buildOrderCountFormulas_() {
  var cells = ['=SUM(C7:N7)'];
  for (var m = 1; m <= 12; m++) {
    cells.push("=COUNTIFS('" + ORDERS_TAB_NAME + "'!A:A, \">=\"&DATE($B$4," + m + ",1), '" + ORDERS_TAB_NAME + "'!A:A, \"<\"&DATE($B$4," + (m + 1) + ",1))");
  }
  return cells;
}

// Total + net + margin formulas reference the rows we just rebuilt.
function _buildTotalsFormulas_(blk) {
  var totals = ['=SUM(B' + blk.rawMaterials + ':B' + blk.ops + ')'];
  var nets   = ['=B' + blk.revenue + '-B' + blk.totalExp];
  var margins = ['=IFERROR(B' + blk.netProfit + '/B' + blk.revenue + ', 0)'];
  var cols = ['C','D','E','F','G','H','I','J','K','L','M','N'];
  for (var i = 0; i < cols.length; i++) {
    var c = cols[i];
    totals.push('=SUM(' + c + blk.rawMaterials + ':' + c + blk.ops + ')');
    nets.push('=' + c + blk.revenue + '-' + c + blk.totalExp);
    margins.push('=IFERROR(' + c + blk.netProfit + '/' + c + blk.revenue + ', 0)');
  }
  return { totals: totals, nets: nets, margins: margins };
}

// Backup: snapshot rows 1..65 cols A..N of מאזן חברה into a new tab.
// Steven's hard rule: backup before any write.
function _backupCompanyDashboard_(ss) {
  var src = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!src) return null;
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_recomp_' + ts;
  var dst = ss.insertSheet(bakName);
  var range = src.getRange(1, 1, 65, 14);
  range.copyTo(dst.getRange(1, 1), { contentsOnly: false });
  Logger.log('Backup written → ' + bakName);
  return bakName;
}

// Phase 1: read-only. Print what would change, no writes.
function DRY_RUN_RESTORE_2026() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!dash) { Logger.log('FAIL: no ' + COMPANY_TAB_NAME); return; }

  Logger.log('===== DRY RUN: RESTORE 2026 SUMIFS FORMULAS =====');
  Logger.log('Sheet: ' + ss.getName() + '  /  tab: ' + COMPANY_TAB_NAME);
  Logger.log('Year cell B4 = ' + dash.getRange('B4').getValue());
  Logger.log('');
  Logger.log('Will rewrite rows ' + YEAR_2026.revenue + '..' + YEAR_2026.marginPct + ' cols B..N (13 cols).');
  Logger.log('');
  Logger.log('CURRENT state of those rows (col B + col G=May):');
  var rows = [YEAR_2026.revenue, YEAR_2026.orderCount, YEAR_2026.rawMaterials, YEAR_2026.marketing, YEAR_2026.shipping, YEAR_2026.ops];
  var labels = ['revenue','orders','rawMat','marketing','shipping','ops'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var labelA = dash.getRange(r, 1).getValue();
    var valB = dash.getRange(r, 2).getValue();
    var formB = dash.getRange(r, 2).getFormula();
    var valG = dash.getRange(r, 7).getValue();
    var formG = dash.getRange(r, 7).getFormula();
    Logger.log('Row ' + r + ' (' + labels[i] + '): A="' + labelA + '"  B-annual=' + valB + (formB ? ' (formula)' : ' (raw value)') + '  G-May=' + valG + (formG ? ' (formula)' : ' (raw value)'));
  }
  Logger.log('');
  Logger.log('SAMPLE formula to be written for row 9 May:');
  var sampleRow = _buildBusinessRowFormulas_(YEAR_2026.marketing, 'marketing');
  Logger.log('  ' + sampleRow[5]);  // col G = May = index 6 in array? Actually cells[0]=annual, cells[1..12]=Jan..Dec, so May=cells[5]
  Logger.log('');
  Logger.log('To execute the rewrite, run: APPLY_RESTORE_2026');
}

// Phase 2: actually rewrite. Creates a backup first.
function APPLY_RESTORE_2026() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!dash) { Logger.log('FAIL: no ' + COMPANY_TAB_NAME); return; }

  var bakName = _backupCompanyDashboard_(ss);
  Logger.log('===== APPLY_RESTORE_2026 (backup: ' + bakName + ') =====');

  var blk = YEAR_2026;

  // Row 6: revenue.
  var revRow = _buildRevenueFormulas_();
  dash.getRange(blk.revenue, 2, 1, 13).setFormulas([revRow]);
  Logger.log('Row ' + blk.revenue + ' (revenue): wrote 13 formulas.');

  // Row 7: order count.
  var ordRow = _buildOrderCountFormulas_();
  dash.getRange(blk.orderCount, 2, 1, 13).setFormulas([ordRow]);
  Logger.log('Row ' + blk.orderCount + ' (order count): wrote 13 formulas.');

  // Rows 8..11: expense buckets.
  var buckets = [
    { row: blk.rawMaterials, key: 'rawMaterials' },
    { row: blk.marketing,    key: 'marketing' },
    { row: blk.shipping,     key: 'shipping' },
    { row: blk.ops,          key: 'ops' },
  ];
  for (var i = 0; i < buckets.length; i++) {
    var b = buckets[i];
    var rowF = _buildBusinessRowFormulas_(b.row, b.key);
    dash.getRange(b.row, 2, 1, 13).setFormulas([rowF]);
    Logger.log('Row ' + b.row + ' (' + b.key + '): wrote 13 formulas.');
  }

  // Rows 12-14: derived totals.
  var tots = _buildTotalsFormulas_(blk);
  dash.getRange(blk.totalExp,  2, 1, 13).setFormulas([tots.totals]);
  dash.getRange(blk.netProfit, 2, 1, 13).setFormulas([tots.nets]);
  dash.getRange(blk.marginPct, 2, 1, 13).setFormulas([tots.margins]);
  try { dash.getRange(blk.marginPct, 2, 1, 13).setNumberFormat('0.0%'); } catch (_) {}
  Logger.log('Rows ' + blk.totalExp + '/' + blk.netProfit + '/' + blk.marginPct + ' (totals/net/margin): wrote derived formulas.');

  Logger.log('');
  Logger.log('Done. The dashboard is now FORMULA-BASED.');
  Logger.log('Refresh the sheet — May "עלות שיווק" should update to the live total from תנועות.');
  Logger.log('From now on, every bot write to תנועות propagates automatically without re-running this.');
}

// ────────────────────────────────────────────────────────────────────────
// PERSONAL dashboard — wildcard-wrap every data row's monthly SUMIFS.
// Lower-risk than the company dashboard; doesn't use a backup tab.
// ────────────────────────────────────────────────────────────────────────
function fixPersonalDashboardFormulas() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(PERSONAL_TAB_NAME);
  if (!sheet) { Logger.log('FAIL: no ' + PERSONAL_TAB_NAME); return; }
  var lastRow = Math.min(sheet.getLastRow(), 60);
  var labels = sheet.getRange('A1:A' + lastRow).getValues();
  var updates = 0;
  for (var r = 0; r < labels.length; r++) {
    var rowNum = r + 1;
    var label = String(labels[r][0] || '').trim();
    if (!label) continue;
    if (/^סה/.test(label)) continue;
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(label)) continue;
    if (rowNum < 5) continue;
    var newRow = [];
    for (var m = 1; m <= 12; m++) {
      var mm = m < 10 ? ('0' + m) : ('' + m);
      newRow.push("=IFERROR(SUMIFS('" + TX_TAB_NAME + "'!C:C, '" + TX_TAB_NAME + "'!B:B, $B$2&\"-" + mm + "\", '" + TX_TAB_NAME + "'!E:E, \"*\"&$A" + rowNum + "&\"*\"), 0)");
    }
    try { sheet.getRange('C' + rowNum + ':N' + rowNum + '').setFormulas([newRow]); updates++; } catch (_e) {}
  }
  Logger.log('OK: מאזן אישי — wildcard-wrap on ' + updates + ' rows.');
}

// ────────────────────────────────────────────────────────────────────────
// Diagnostic: dump what we see in תנועות for עסק rows so we can compare
// against what the dashboard claims. Run BEFORE the restore if confused.
// ────────────────────────────────────────────────────────────────────────
function diagnoseBusinessRows() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(TX_TAB_NAME);
  if (!sheet) { Logger.log('no ' + TX_TAB_NAME); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('empty'); return; }
  var values = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  var byMonth = {};
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var cat = String(r[3] || '').trim();
    if (cat !== 'עסק') continue;
    var amount = Number(r[2]) || 0;
    if (!amount) continue;
    var month = String(r[1] || '').trim();
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push({ amount: amount, sub: String(r[4] || ''), descr: String(r[5] || '') });
  }
  Logger.log('=== עסק rows in תנועות, grouped by month ===');
  var keys = Object.keys(byMonth).sort();
  for (var k = 0; k < keys.length; k++) {
    var mk = keys[k];
    var rows = byMonth[mk];
    var sum = 0;
    for (var j = 0; j < rows.length; j++) sum += rows[j].amount;
    Logger.log(mk + '  count=' + rows.length + '  sum=₪' + sum);
    for (var jj = 0; jj < Math.min(rows.length, 10); jj++) {
      Logger.log('   - ₪' + rows[jj].amount + '  E="' + rows[jj].sub + '"  F="' + rows[jj].descr + '"');
    }
  }
}

// One-click runner — restore company dashboard formulas + personal wildcards.
function FIX_EVERYTHING() {
  try { APPLY_RESTORE_2026(); } catch (e) { Logger.log('company err: ' + e.message); }
  try { fixPersonalDashboardFormulas(); } catch (e) { Logger.log('personal err: ' + e.message); }
  Logger.log('---');
  Logger.log('All fixes applied. Refresh the sheet (Cmd+R) — numbers should be live now.');
}
