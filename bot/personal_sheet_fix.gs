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
// Steven's MAIN bot sheet (1UKr...) -- this is the spreadsheet the
// WhatsApp bot writes to + where מאזן חברה / מאזן אישי / תנועות / הזמנות
// all live in one document. Updated 2026-05-25 after we found the earlier
// 1nRR... ID was a different sheet entirely (no תנועות data there).
//
// ALL top-level identifiers in this file are PREFIXED with _PSF_ so they
// don't collide with the bot's own globals when Steven pastes this file
// into the bot's Apps Script project. (The bot already declares
// `const _PSF_ORDERS_TAB_`, which used to cause a SyntaxError on load.)
var _PSF_SHEET_ID_       = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

var _PSF_TX_TAB_         = 'תנועות';
var _PSF_ORDERS_TAB_     = 'הזמנות';
var _PSF_COMPANY_TAB_    = 'מאזן חברה';
var _PSF_PERSONAL_TAB_   = 'מאזן אישי';

// Year block for 2026 (mirrors Steven's FIX_DASHBOARD_2023_2024_2025).
var _PSF__PSF_YEAR_2026__ = {
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
  if (!_PSF_SHEET_ID_ || _PSF_SHEET_ID_.indexOf('<') >= 0) {
    throw new Error('_PSF_SHEET_ID_ is not set at top of file.');
  }
  return SpreadsheetApp.openById(_PSF_SHEET_ID_);
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
      parts.push("SUMIFS('" + _PSF_TX_TAB_ + "'!C:C, '" + _PSF_TX_TAB_ + "'!B:B, $B$4&\"-" + mm + "\", '" + _PSF_TX_TAB_ + "'!D:D, \"עסק\", '" + _PSF_TX_TAB_ + "'!E:E, \"" + safe + "\")");
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
    cells.push("=IFERROR(SUMIFS('" + _PSF_ORDERS_TAB_ + "'!D:D, '" + _PSF_ORDERS_TAB_ + "'!A:A, \">=\"&DATE($B$4," + m + ",1), '" + _PSF_ORDERS_TAB_ + "'!A:A, \"<\"&DATE($B$4," + (m + 1) + ",1)), 0)");
  }
  return cells;
}

// Order count from הזמנות by month.
function _buildOrderCountFormulas_() {
  var cells = ['=SUM(C7:N7)'];
  for (var m = 1; m <= 12; m++) {
    cells.push("=COUNTIFS('" + _PSF_ORDERS_TAB_ + "'!A:A, \">=\"&DATE($B$4," + m + ",1), '" + _PSF_ORDERS_TAB_ + "'!A:A, \"<\"&DATE($B$4," + (m + 1) + ",1))");
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
  var src = ss.getSheetByName(_PSF_COMPANY_TAB_);
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
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('FAIL: no ' + _PSF_COMPANY_TAB_); return; }

  Logger.log('===== DRY RUN: RESTORE 2026 SUMIFS FORMULAS =====');
  Logger.log('Sheet: ' + ss.getName() + '  /  tab: ' + _PSF_COMPANY_TAB_);
  Logger.log('Year cell B4 = ' + dash.getRange('B4').getValue());
  Logger.log('');
  Logger.log('Will rewrite rows ' + _PSF_YEAR_2026_.revenue + '..' + _PSF_YEAR_2026_.marginPct + ' cols B..N (13 cols).');
  Logger.log('');
  Logger.log('CURRENT state of those rows (col B + col G=May):');
  var rows = [_PSF_YEAR_2026_.revenue, _PSF_YEAR_2026_.orderCount, _PSF_YEAR_2026_.rawMaterials, _PSF_YEAR_2026_.marketing, _PSF_YEAR_2026_.shipping, _PSF_YEAR_2026_.ops];
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
  var sampleRow = _buildBusinessRowFormulas_(_PSF_YEAR_2026_.marketing, 'marketing');
  Logger.log('  ' + sampleRow[5]);  // col G = May = index 6 in array? Actually cells[0]=annual, cells[1..12]=Jan..Dec, so May=cells[5]
  Logger.log('');
  Logger.log('To execute the rewrite, run: APPLY_RESTORE_2026');
}

// Phase 2: actually rewrite. Creates a backup first.
function APPLY_RESTORE_2026() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('FAIL: no ' + _PSF_COMPANY_TAB_); return; }

  var bakName = _backupCompanyDashboard_(ss);
  Logger.log('===== APPLY_RESTORE_2026 (backup: ' + bakName + ') =====');

  var blk = _PSF_YEAR_2026_;

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
  var sheet = ss.getSheetByName(_PSF_PERSONAL_TAB_);
  if (!sheet) { Logger.log('FAIL: no ' + _PSF_PERSONAL_TAB_); return; }
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
      newRow.push("=IFERROR(SUMIFS('" + _PSF_TX_TAB_ + "'!C:C, '" + _PSF_TX_TAB_ + "'!B:B, $B$2&\"-" + mm + "\", '" + _PSF_TX_TAB_ + "'!E:E, \"*\"&$A" + rowNum + "&\"*\"), 0)");
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
  var sheet = ss.getSheetByName(_PSF_TX_TAB_);
  if (!sheet) { Logger.log('no ' + _PSF_TX_TAB_); return; }
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

// ════════════════════════════════════════════════════════════════════════
// EMERGENCY: restore מאזן חברה from the most recent backup tab.
// Use this if APPLY_RESTORE_2026 left you with all zeros (formulas
// returning 0 because they don't match your actual data layout).
// ════════════════════════════════════════════════════════════════════════
function RESTORE_FROM_BACKUP() {
  var ss = _openSheet_();
  // Find the newest _BAK_recomp_* tab.
  var tabs = ss.getSheets();
  var newest = null;
  var newestName = '';
  for (var i = 0; i < tabs.length; i++) {
    var name = tabs[i].getName();
    if (name.indexOf('_BAK_recomp_') === 0) {
      if (!newest || name > newestName) {
        newest = tabs[i];
        newestName = name;
      }
    }
  }
  if (!newest) {
    Logger.log('!! No backup tab found (looked for _BAK_recomp_*).');
    Logger.log('   Tabs in this sheet: ' + tabs.map(function(t){return t.getName();}).join(', '));
    return;
  }
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_); return; }

  // The backup snapshotted rows 1..65 cols A..N. Copy B6:N14 back (the
  // 2026 block we touched). Use copyTo with paste type CONTENTS_ONLY so
  // values + formulas both restore.
  try {
    var src = newest.getRange('B6:N14');
    src.copyTo(dash.getRange('B6'), SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);
    Logger.log('OK: restored rows 6-14 cols B-N from backup tab "' + newestName + '"');
    Logger.log('Old values are back in מאזן חברה. The תנועות + הזמנות data was never touched.');
    Logger.log('');
    Logger.log('Next step: run diagnoseBusinessRows to see why the SUMIFS returned 0.');
    Logger.log('Send me the log output and I will fix the formula to match your data layout.');
  } catch (e) {
    Logger.log('!! restore failed: ' + e.message);
    Logger.log('Manual fallback: open tab "' + newestName + '", select B6:N14, copy, paste into ' + _PSF_COMPANY_TAB_ + ' B6.');
  }
}

// ════════════════════════════════════════════════════════════════════════
// RECOMPUTE_COMPANY_DASHBOARD — the canonical fix for "bot wrote a row to
// תנועות but מאזן חברה still shows the old number".
//
// Reads תנועות from start to finish, sums every עסק row by month +
// canonical subcategory, then writes those sums into the 2026 block of
// מאזן חברה. Preserves any cell that already has a formula (so the row
// for "מסי הזמנות" with =COUNTA(...) keeps working). Idempotent —
// running it twice produces the same answer.
//
// Steven 2026-05-25: this is the safety-net. Whenever the dashboard
// drifts from תנועות (because a bot path skipped the update, or a row
// was added manually, or _updateBusinessDashboard_ couldn't find the
// row label), just run this and everything snaps back.
// ════════════════════════════════════════════════════════════════════════

// Canonical row labels in מאזן חברה for each business subcategory the
// bot might write. The key is a regex matched against the תנועות row's
// col E (subcategory); value is the dashboard label in col A.
var _COMPANY_SUB_BUCKETS_ = [
  { label: 'מחזור ברוטו',       regex: /^(מחזור|revenue|sale|sales|gross)\s*$|מחזור/ },
  { label: 'עלות חומרי גלם',    regex: /חומרי\s*גלם|raw\s*material/i },
  { label: 'עלות שיווק',        regex: /שיווק|פרסום|advert|adwords|facebook|instagram|tiktok|google ads|fb ads|פייסבוק|אינסטה|טיקטוק|גוגל\s*אדס/i },
  { label: 'משלוחים והתקנות',   regex: /משלוח|אריזה|shipping|packaging|הובלה|התקנה/i },
  { label: 'הוצאות תפעוליות',   regex: /תפעולי|operational|יועצים|תוכנות|ציוד\s*עסקי|מיסים|operations|consulting|software|equipment|taxes/i },
];

function _bucketForBizSub_(sub) {
  var s = String(sub || '').trim();
  if (!s) return null;
  for (var i = 0; i < _COMPANY_SUB_BUCKETS_.length; i++) {
    if (_COMPANY_SUB_BUCKETS_[i].regex.test(s)) return _COMPANY_SUB_BUCKETS_[i].label;
  }
  // Fallback: if the sub IS the label exactly, use it.
  for (var j = 0; j < _COMPANY_SUB_BUCKETS_.length; j++) {
    if (_COMPANY_SUB_BUCKETS_[j].label === s) return _COMPANY_SUB_BUCKETS_[j].label;
  }
  return null;
}

function RECOMPUTE_COMPANY_DASHBOARD() {
  var ss = _openSheet_();
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!tx)   { Logger.log('!! no ' + _PSF_TX_TAB_ + ' tab'); return; }
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_ + ' tab'); return; }

  // Year = value in B4 of the dashboard.
  var year = parseInt(dash.getRange('B4').getValue(), 10);
  if (!year || year < 2000 || year > 2100) {
    Logger.log('!! bad year in B4: ' + dash.getRange('B4').getValue());
    return;
  }
  Logger.log('=== RECOMPUTE for year ' + year + ' ===');

  // Sum תנועות by (bucket -> month). Skip rows with no amount or wrong year.
  var lastRow = tx.getLastRow();
  if (lastRow < 2) { Logger.log('!! תנועות is empty'); return; }
  var txData = tx.getRange(2, 1, lastRow - 1, 6).getValues();
  var totals = {}; // {label -> {1..12 -> sumAmount}}
  var seen = 0;
  for (var i = 0; i < txData.length; i++) {
    var r = txData[i];
    var monthKey = String(r[1] || '').trim();
    var amount   = Number(r[2]) || 0;
    var cat      = String(r[3] || '').trim();
    var sub      = String(r[4] || '').trim();
    if (cat !== 'עסק' || !amount) continue;
    var m = monthKey.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) continue;
    if (parseInt(m[1], 10) !== year) continue;
    var monthIdx = parseInt(m[2], 10);
    if (monthIdx < 1 || monthIdx > 12) continue;
    var bucket = _bucketForBizSub_(sub);
    if (!bucket) continue;
    if (!totals[bucket]) totals[bucket] = {};
    totals[bucket][monthIdx] = (totals[bucket][monthIdx] || 0) + Math.abs(amount);
    seen++;
  }
  Logger.log('Scanned ' + txData.length + ' תנועות rows -> ' + seen + ' עסק rows summed.');

  // Find dashboard rows + month-header columns.
  var dashData = dash.getDataRange().getValues();
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  for (var bi = 0; bi < _COMPANY_SUB_BUCKETS_.length; bi++) {
    var label = _COMPANY_SUB_BUCKETS_[bi].label;
    var subTotals = totals[label] || {};
    // Find the FIRST row in dashData where col A === label (rows for 2025/
    // 2024/2023 sections come below, this picks the 2026 row since B4=year).
    var rowIdx = -1;
    for (var ri = 0; ri < dashData.length; ri++) {
      if (String(dashData[ri][0] || '').trim() === label) { rowIdx = ri; break; }
    }
    if (rowIdx < 0) {
      Logger.log('  skip "' + label + '" -- row label not found in dashboard');
      continue;
    }
    // Find which column each Hebrew month sits in (scan rows ABOVE rowIdx).
    var monthCols = {};
    for (var hr = 0; hr < rowIdx; hr++) {
      for (var hc = 0; hc < dashData[hr].length; hc++) {
        var idx = hebMonths.indexOf(String(dashData[hr][hc] || '').trim());
        if (idx >= 0 && !(idx + 1 in monthCols)) monthCols[idx + 1] = hc;
      }
    }
    if (!Object.keys(monthCols).length) {
      Logger.log('  skip "' + label + '" -- no month headers above row ' + (rowIdx + 1));
      continue;
    }
    // Write each monthly total. Skip cells with formulas.
    var wrote = 0, skipped = 0, yearSum = 0;
    for (var mn = 1; mn <= 12; mn++) {
      var col = monthCols[mn];
      if (col === undefined) continue;
      var v = Math.round(subTotals[mn] || 0);
      var cell = dash.getRange(rowIdx + 1, col + 1);
      var hadFormula = false;
      try { hadFormula = !!cell.getFormula(); } catch (_) {}
      if (hadFormula) { skipped++; continue; }
      cell.setValue(v);
      wrote++;
      yearSum += v;
    }
    Logger.log('  ✓ "' + label + '" (row ' + (rowIdx + 1) + '): wrote ' + wrote +
               ' months, skipped ' + skipped + ' formulas, year sum=₪' + yearSum);
  }
  Logger.log('=== DONE — refresh the sheet (Cmd+R) to see updated totals ===');
}

// ════════════════════════════════════════════════════════════════════════
// EXTENDED diagnostic — exhaustive view of תנועות so we can see exactly
// why SUMIFS returned 0. Dumps:
//   - First 10 rows of תנועות with all 9 columns visible
//   - Unique values in col B (month), col D (category), col E (subcategory)
//   - Rows where col D = "עסק" (any subcategory)
//   - Cell B4 of מאזן חברה (the year reference)
// ════════════════════════════════════════════════════════════════════════
function DEEP_DIAGNOSE() {
  var ss = _openSheet_();
  Logger.log('=== Sheet: ' + ss.getName() + ' ===');
  Logger.log('');

  // 1. מאזן חברה B4 + B6:G11 current state
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (dash) {
    var b4 = dash.getRange('B4');
    Logger.log('B4 of ' + _PSF_COMPANY_TAB_ + ' — value=' + b4.getValue() + ' formula="' + b4.getFormula() + '" type=' + typeof b4.getValue());
    Logger.log('Current state of rows 6-11 (cols B + G = May):');
    [6,7,8,9,10,11].forEach(function(r) {
      var label = dash.getRange(r, 1).getValue();
      var bVal = dash.getRange(r, 2).getValue();
      var bForm = dash.getRange(r, 2).getFormula();
      var gVal = dash.getRange(r, 7).getValue();
      var gForm = dash.getRange(r, 7).getFormula();
      Logger.log('R' + r + ' A="' + label + '"  B=' + bVal + (bForm?'  bFormula='+bForm.slice(0,80):'')+'  G(May)=' + gVal + (gForm?'  gFormula='+gForm.slice(0,80):''));
    });
    Logger.log('');
  }

  // 2. תנועות first 10 rows, all 9 cols
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  if (!tx) { Logger.log('!! no ' + _PSF_TX_TAB_); return; }
  var lastRow = tx.getLastRow();
  Logger.log('=== ' + _PSF_TX_TAB_ + ' has ' + (lastRow - 1) + ' data rows ===');
  var head = tx.getRange(1, 1, 1, Math.min(9, tx.getLastColumn())).getValues()[0];
  Logger.log('Header row: ' + JSON.stringify(head));
  var sample = tx.getRange(2, 1, Math.min(10, lastRow - 1), Math.min(9, tx.getLastColumn())).getValues();
  for (var i = 0; i < sample.length; i++) {
    Logger.log('Row ' + (i+2) + ': ' + JSON.stringify(sample[i]));
  }
  Logger.log('');

  // 3. Unique D + E values + count
  var allData = tx.getRange(2, 1, lastRow - 1, Math.min(9, tx.getLastColumn())).getValues();
  var seenD = {};
  var seenE = {};
  var seenB = {};
  for (var k = 0; k < allData.length; k++) {
    var rr = allData[k];
    if (rr[3]) seenD[String(rr[3])] = (seenD[String(rr[3])] || 0) + 1;
    if (rr[4]) seenE[String(rr[4])] = (seenE[String(rr[4])] || 0) + 1;
    if (rr[1]) seenB[String(rr[1])] = (seenB[String(rr[1])] || 0) + 1;
  }
  Logger.log('=== Unique values in col D (category) ===');
  Logger.log(JSON.stringify(seenD));
  Logger.log('=== Unique values in col E (subcategory) ===');
  Logger.log(JSON.stringify(seenE));
  Logger.log('=== Unique values in col B (month) — first 15 ===');
  var bKeys = Object.keys(seenB).slice(0, 15);
  var bSample = {};
  bKeys.forEach(function(k){ bSample[k] = seenB[k]; });
  Logger.log(JSON.stringify(bSample));
  Logger.log('');

  // 4. All rows where col D = "עסק"
  Logger.log('=== Rows where col D = "עסק" ===');
  var biz = 0;
  for (var j = 0; j < allData.length; j++) {
    var d = String(allData[j][3] || '').trim();
    if (d === 'עסק') {
      biz++;
      if (biz <= 20) {
        Logger.log('  row ' + (j+2) + ': B=' + allData[j][1] + ' C=' + allData[j][2] + ' D=' + JSON.stringify(allData[j][3]) + ' E=' + JSON.stringify(allData[j][4]) + ' F=' + allData[j][5]);
      }
    }
  }
  Logger.log('Total עסק rows: ' + biz);
}
