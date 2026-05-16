// FIX_PROFITABILITY_AND_CHART.gs
//
// Fixes the percentage-of-profit cells that were still pointing to OLD net profit values
// (left behind by the earlier FIX_DASHBOARD_2023_2024_2025 which only fixed the net row).
//
// Also creates a clean financial summary tab with chart + a per-year audit.
//
// Run these in order:
//   1. AUDIT_DASHBOARD_FORMULAS — read-only; shows the current state of every percentage cell
//   2. FIX_PROFITABILITY_PERCENTAGES — replaces stale percentages with live formulas
//   3. INSTALL_FINANCIAL_SUMMARY_TAB — creates 'סיכום פיננסי' tab with key metrics + chart
//   4. VERIFY_AFTER_FIX — sanity check

var KESEFLE_SHEET_ID_FP = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// Year-block row mapping (matches FIX_DASHBOARD_2023_2024_2025)
var YEARS = [
  { year: '2023', headerRow: 40, revRow: 42, orders: 43, mat: 44, mkt: 45, ship: 46, op: 47, total: 48, net: 49 },
  { year: '2024', headerRow: 28, revRow: 30, orders: 31, mat: 32, mkt: 33, ship: 34, op: 35, total: 36, net: 37 },
  { year: '2025', headerRow: 16, revRow: 18, orders: 19, mat: 20, mkt: 21, ship: 22, op: 23, total: 24, net: 25 },
  { year: '2026', headerRow:  4, revRow:  6, orders:  7, mat:  8, mkt:  9, ship: 10, op: 11, total: 12, net: 13 },
];

function col_(n) { return String.fromCharCode(64 + n); }

// ============================================================
// AUDIT_DASHBOARD_FORMULAS — read-only diagnostic
// ============================================================
function AUDIT_DASHBOARD_FORMULAS() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_FP);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) { Logger.log('Dashboard not found'); return; }

  var report = ['===== AUDIT: DASHBOARD FORMULAS =====', ''];

  // Find ALL percentage rows (search col A for רווחיות or %)
  report.push('Scanning for profitability % rows (search "רווחיות"):');
  var lastRow = dash.getLastRow();
  var pctRows = [];
  for (var r = 1; r <= lastRow; r++) {
    var label = dash.getRange(r, 1).getValue();
    if (typeof label === 'string' && (label.indexOf('רווחיות') >= 0 || label.indexOf('אחוז ') >= 0)) {
      pctRows.push({ row: r, label: label });
    }
  }
  pctRows.forEach(function(p) {
    var b = dash.getRange(p.row, 2);
    var bFormula = b.getFormula();
    var bValue = b.getValue();
    report.push('  r' + p.row + ': "' + p.label + '" — col B value=' + bValue + ' formula=' + (bFormula || '(hardcoded)'));
  });

  // For each year, check: net / revenue vs the stored % nearby
  report.push('');
  report.push('Per-year audit (showing stored vs expected):');
  YEARS.forEach(function(y) {
    var rev = num_(dash.getRange(y.revRow, 2).getValue());
    var net = num_(dash.getRange(y.net, 2).getValue());
    var expected = rev > 0 ? (net / rev * 100) : 0;
    report.push('  ' + y.year + ': revenue=' + rev.toFixed(0) + ' net=' + net.toFixed(0) + ' expected_pct=' + expected.toFixed(1) + '%');

    // Find the "אחוז רווחיות" cell associated with this year — typically at netRow+1 or in comparison block
    var nextLabel = dash.getRange(y.net + 1, 1).getValue();
    var pctCellVal = dash.getRange(y.net + 1, 2).getValue();
    var pctFormula = dash.getRange(y.net + 1, 2).getFormula();
    report.push('    Cell r' + (y.net + 1) + ' B: label="' + nextLabel + '" stored=' + (typeof pctCellVal === 'number' ? (pctCellVal * 100).toFixed(1) + '%' : pctCellVal) + ' formula=' + (pctFormula || '(hardcoded)'));
  });

  // Check the multi-year comparison block
  report.push('');
  report.push('Multi-year comparison block (looking for אחוז רווחיות row):');
  for (var r = 53; r <= 67 && r <= lastRow; r++) {
    var label = dash.getRange(r, 1).getValue();
    if (typeof label === 'string' && label.length > 0) {
      var b = dash.getRange(r, 2).getValue();
      var c = dash.getRange(r, 3).getValue();
      var d = dash.getRange(r, 4).getValue();
      var e = dash.getRange(r, 5).getValue();
      var formula = dash.getRange(r, 2).getFormula();
      report.push('  r' + r + ': "' + label + '" 2023=' + fmt_(b) + ' 2024=' + fmt_(c) + ' 2025=' + fmt_(d) + ' 2026=' + fmt_(e) + ' (formula: ' + (formula || 'hardcoded') + ')');
    }
  }

  Logger.log(report.join('\n'));
  try { SpreadsheetApp.getUi().alert(report.join('\n')); } catch (e) {}
}

function num_(v) {
  if (v == null || v === '') return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}
function fmt_(v) {
  if (typeof v === 'number') {
    if (v > 0 && v < 1) return (v * 100).toFixed(1) + '%';
    return v.toFixed(0);
  }
  return String(v).slice(0, 20);
}

// ============================================================
// FIX_PROFITABILITY_PERCENTAGES — replaces stale percentages with formulas
// ============================================================
function FIX_PROFITABILITY_PERCENTAGES() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_FP);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) throw new Error('Dashboard not found');

  // Backup col A-N rows 1-67
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_pct_' + ts;
  while (ss.getSheetByName(bakName)) bakName = '_BAK_pct_' + ts + '_' + Math.floor(Math.random() * 1000);
  var bak = ss.insertSheet(bakName);
  bak.getRange(1, 1, 67, 14).setValues(dash.getRange(1, 1, 67, 14).getValues());

  var fixed = 0;
  var details = [];

  // 1. Fix per-year profitability cells (the row right after the net row, if labeled "רווחיות")
  YEARS.forEach(function(y) {
    var pctRow = y.net + 1;
    var label = dash.getRange(pctRow, 1).getValue();
    if (typeof label === 'string' && label.indexOf('רווחיות') >= 0) {
      // Annual % at col B
      dash.getRange(pctRow, 2).setFormula('=IFERROR(B' + y.net + '/B' + y.revRow + ', 0)');
      // Per-month % at cols C-N (3..14)
      for (var c = 3; c <= 14; c++) {
        var letter = col_(c);
        dash.getRange(pctRow, c).setFormula('=IFERROR(' + letter + y.net + '/' + letter + y.revRow + ', 0)');
      }
      // Format as percentage
      dash.getRange(pctRow, 2, 1, 13).setNumberFormat('0.0%');
      fixed++;
      details.push(y.year + ': fixed % row r' + pctRow);
    }
  });

  // 2. Fix multi-year comparison block percentage row (search for the row label)
  for (var r = 53; r <= 67; r++) {
    var label = dash.getRange(r, 1).getValue();
    if (typeof label === 'string' && label.indexOf('רווחיות') >= 0) {
      // Columns: B=2023, C=2024, D=2025, E=2026, F=4-year-sum, G=change
      dash.getRange(r, 2).setFormula('=IFERROR(B49/B42, 0)'); // 2023 net/rev
      dash.getRange(r, 3).setFormula('=IFERROR(B37/B30, 0)'); // 2024
      dash.getRange(r, 4).setFormula('=IFERROR(B25/B18, 0)'); // 2025
      dash.getRange(r, 5).setFormula('=IFERROR(B13/B6, 0)');  // 2026
      dash.getRange(r, 6).setFormula('=IFERROR(SUM(B49,B37,B25,B13)/SUM(B42,B30,B18,B6), 0)'); // 4-year total
      dash.getRange(r, 2, 1, 5).setNumberFormat('0.0%');
      details.push('Comparison block r' + r + ': fixed % formulas');
      fixed++;
      break;
    }
  }

  Logger.log('Fixed ' + fixed + ' percentage rows.\n' + details.join('\n'));
  try { SpreadsheetApp.getUi().alert('Fixed ' + fixed + ' percentage rows.\nBackup: ' + bakName + '\n\n' + details.join('\n')); } catch (e) {}
}

// ============================================================
// INSTALL_FINANCIAL_SUMMARY_TAB — creates a clean overview tab
// ============================================================
function INSTALL_FINANCIAL_SUMMARY_TAB() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_FP);
  var existing = ss.getSheetByName('סיכום פיננסי');
  if (existing) ss.deleteSheet(existing);
  var sh = ss.insertSheet('סיכום פיננסי', 0); // create as first tab
  sh.setRightToLeft(true);

  // Header
  sh.getRange('A1').setValue('📊 סיכום פיננסי — 4 שנים').setFontSize(16).setFontWeight('bold').setBackground('#0f1422').setFontColor('#ffffff');
  sh.getRange('A1:G1').merge();
  sh.setRowHeight(1, 36);

  // Year headers
  var headers = ['קטגוריה', '2023', '2024', '2025', '2026', '4 שנים', 'מגמה'];
  sh.getRange(3, 1, 1, 7).setValues([headers]).setFontWeight('bold').setBackground('#1e2638').setFontColor('#ffffff');
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(7, 140);

  // Rows: each pulls from 'מאזן חברה' via direct cell references
  var rows = [
    ['מחזור ברוטו',         "='מאזן חברה'!B42", "='מאזן חברה'!B30", "='מאזן חברה'!B18", "='מאזן חברה'!B6",  '=SUM(B4:E4)', '=SPARKLINE(B4:E4,{"charttype","column";"color1","#16a34a"})'],
    ['מס׳ הזמנות',          "='מאזן חברה'!B43", "='מאזן חברה'!B31", "='מאזן חברה'!B19", "='מאזן חברה'!B7",  '=SUM(B5:E5)', '=SPARKLINE(B5:E5,{"charttype","column";"color1","#2563eb"})'],
    ['ערך הזמנה ממוצע',     '=IFERROR(B4/B5,0)','=IFERROR(C4/C5,0)','=IFERROR(D4/D5,0)','=IFERROR(E4/E5,0)','=IFERROR(F4/F5,0)','=SPARKLINE(B6:E6,{"charttype","column";"color1","#a855f7"})'],
    ['עלות חומרי גלם',      "='מאזן חברה'!B44", "='מאזן חברה'!B32", "='מאזן חברה'!B20", "='מאזן חברה'!B8",  '=SUM(B7:E7)', '=SPARKLINE(B7:E7,{"charttype","column";"color1","#dc2626"})'],
    ['עלות שיווק',          "='מאזן חברה'!B45", "='מאזן חברה'!B33", "='מאזן חברה'!B21", "='מאזן חברה'!B9",  '=SUM(B8:E8)', '=SPARKLINE(B8:E8,{"charttype","column";"color1","#f59e0b"})'],
    ['משלוחים והתקנות',     "='מאזן חברה'!B46", "='מאזן חברה'!B34", "='מאזן חברה'!B22", "='מאזן חברה'!B10", '=SUM(B9:E9)', '=SPARKLINE(B9:E9,{"charttype","column";"color1","#7c3aed"})'],
    ['הוצאות תפעוליות',     "='מאזן חברה'!B47", "='מאזן חברה'!B35", "='מאזן חברה'!B23", "='מאזן חברה'!B11", '=SUM(B10:E10)', '=SPARKLINE(B10:E10,{"charttype","column";"color1","#9ca3af"})'],
    ['סה״כ הוצאות עסקיות', "='מאזן חברה'!B48", "='מאזן חברה'!B36", "='מאזן חברה'!B24", "='מאזן חברה'!B12", '=SUM(B11:E11)', '=SPARKLINE(B11:E11,{"charttype","column";"color1","#ef4444"})'],
    ['רווח נטו',            "='מאזן חברה'!B49", "='מאזן חברה'!B37", "='מאזן חברה'!B25", "='מאזן חברה'!B13", '=SUM(B12:E12)', '=SPARKLINE(B12:E12,{"charttype","column";"color1","#10b981"})'],
    ['אחוז רווחיות',        '=IFERROR(B12/B4,0)','=IFERROR(C12/C4,0)','=IFERROR(D12/D4,0)','=IFERROR(E12/E4,0)','=IFERROR(F12/F4,0)','=SPARKLINE(B13:E13,{"charttype","line";"linewidth",2;"color1","#22c55e"})'],
  ];

  sh.getRange(4, 1, rows.length, 7).setFormulas(rows.map(function(r) {
    return r.map(function(c) { return typeof c === 'string' && c.charAt(0) === '=' ? c : c; });
  }));

  // Formatting
  sh.getRange(4, 2, rows.length, 5).setNumberFormat('₪#,##0');
  sh.getRange(5, 2, 1, 5).setNumberFormat('#,##0'); // orders count
  sh.getRange(6, 2, 1, 5).setNumberFormat('₪#,##0'); // avg order value
  sh.getRange(13, 2, 1, 5).setNumberFormat('0.0%');  // profit %

  // Row colors (subtle)
  var colors = [null, '#dbeafe', '#fef3c7', '#fee2e2', '#fed7aa', '#e9d5ff', '#f3f4f6', '#fecaca', '#bbf7d0', '#dcfce7'];
  for (var i = 0; i < colors.length; i++) {
    if (colors[i]) sh.getRange(4 + i, 1, 1, 7).setBackground(colors[i]);
  }
  sh.getRange(13, 1, 1, 7).setFontWeight('bold'); // profit % row bold

  // Highlight best year
  sh.getRange('A15').setValue('🏆 שנה רווחית ביותר:').setFontWeight('bold');
  sh.getRange('B15').setFormula('=INDEX($B$3:$E$3, MATCH(MAX($B$12:$E$12), $B$12:$E$12, 0))');
  sh.getRange('A16').setValue('📅 שנה עם מחזור שיא:').setFontWeight('bold');
  sh.getRange('B16').setFormula('=INDEX($B$3:$E$3, MATCH(MAX($B$4:$E$4), $B$4:$E$4, 0))');
  sh.getRange('A17').setValue('📉 שנה הכי פחות רווחית:').setFontWeight('bold');
  sh.getRange('B17').setFormula('=INDEX($B$3:$E$3, MATCH(MIN($B$13:$E$13), $B$13:$E$13, 0))');

  // Freeze first 3 rows + first column
  sh.setFrozenRows(3);
  sh.setFrozenColumns(1);

  try { SpreadsheetApp.getUi().alert('Created tab "סיכום פיננסי" with key metrics + sparkline charts.'); } catch (e) {}
}

// ============================================================
// VERIFY_AFTER_FIX — check that everything is sane
// ============================================================
function VERIFY_AFTER_FIX() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_FP);
  var dash = ss.getSheetByName('מאזן חברה');
  var lines = ['===== VERIFY =====', ''];
  YEARS.forEach(function(y) {
    var rev = num_(dash.getRange(y.revRow, 2).getValue());
    var net = num_(dash.getRange(y.net, 2).getValue());
    var pctRow = y.net + 1;
    var label = dash.getRange(pctRow, 1).getValue();
    var pctVal = dash.getRange(pctRow, 2).getValue();
    var expected = rev > 0 ? (net / rev) : 0;
    var ok = Math.abs(pctVal - expected) < 0.005;
    lines.push(y.year + ': stored ' + (pctVal * 100).toFixed(1) + '% expected ' + (expected * 100).toFixed(1) + '% ' + (ok ? '✓' : '✗'));
  });
  Logger.log(lines.join('\n'));
  try { SpreadsheetApp.getUi().alert(lines.join('\n')); } catch (e) {}
}
