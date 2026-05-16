// FINANCIAL_SUMMARY_TAB_CLEAN.gs
// Clean self-contained version. Replaces the older FIX_PROFITABILITY_AND_CHART.gs
// INSTALL_FINANCIAL_SUMMARY_TAB function (which had a frozen-column merge bug).
//
// Run INSTALL_FINANCIAL_SUMMARY to create the tab.
// Run REMOVE_FINANCIAL_SUMMARY to delete it if you want to start over.

var KFL_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var KFL_TAB_NAME = 'סיכום פיננסי';

function INSTALL_FINANCIAL_SUMMARY() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID);

  // Remove existing tab if present, then create fresh
  var existing = ss.getSheetByName(KFL_TAB_NAME);
  if (existing) ss.deleteSheet(existing);
  var sh = ss.insertSheet(KFL_TAB_NAME, 0);
  sh.setRightToLeft(true);

  // Row 1: title (merged across A:G)
  sh.getRange('A1:G1').merge();
  sh.getRange('A1').setValue('Financial Summary 4 years').setFontSize(16).setFontWeight('bold')
    .setBackground('#0f1422').setFontColor('#ffffff').setHorizontalAlignment('center');
  sh.setRowHeight(1, 36);

  // Row 3: header
  var headers = ['Category', '2023', '2024', '2025', '2026', '4 years total', 'Trend'];
  sh.getRange(3, 1, 1, 7).setValues([headers])
    .setFontWeight('bold').setBackground('#1e2638').setFontColor('#ffffff');

  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(7, 160);

  // Row 4-13: data rows referencing the מאזן חברה year blocks
  // 2023 sums in column B of rows 42-49
  // 2024 sums in column B of rows 30-37
  // 2025 sums in column B of rows 18-25
  // 2026 sums in column B of rows  6-13
  var rows = [
    ['Gross revenue',         "='" + 'מאזן חברה' + "'!B42", "='" + 'מאזן חברה' + "'!B30", "='" + 'מאזן חברה' + "'!B18", "='" + 'מאזן חברה' + "'!B6",  '=SUM(B4:E4)', '=SPARKLINE(B4:E4,{"charttype","column";"color1","#16a34a"})'],
    ['Orders',                "='" + 'מאזן חברה' + "'!B43", "='" + 'מאזן חברה' + "'!B31", "='" + 'מאזן חברה' + "'!B19", "='" + 'מאזן חברה' + "'!B7",  '=SUM(B5:E5)', '=SPARKLINE(B5:E5,{"charttype","column";"color1","#2563eb"})'],
    ['Avg order value',       '=IFERROR(B4/B5,0)','=IFERROR(C4/C5,0)','=IFERROR(D4/D5,0)','=IFERROR(E4/E5,0)','=IFERROR(F4/F5,0)','=SPARKLINE(B6:E6,{"charttype","column";"color1","#a855f7"})'],
    ['Raw materials',         "='" + 'מאזן חברה' + "'!B44", "='" + 'מאזן חברה' + "'!B32", "='" + 'מאזן חברה' + "'!B20", "='" + 'מאזן חברה' + "'!B8",  '=SUM(B7:E7)', '=SPARKLINE(B7:E7,{"charttype","column";"color1","#dc2626"})'],
    ['Marketing',             "='" + 'מאזן חברה' + "'!B45", "='" + 'מאזן חברה' + "'!B33", "='" + 'מאזן חברה' + "'!B21", "='" + 'מאזן חברה' + "'!B9",  '=SUM(B8:E8)', '=SPARKLINE(B8:E8,{"charttype","column";"color1","#f59e0b"})'],
    ['Shipping & install',    "='" + 'מאזן חברה' + "'!B46", "='" + 'מאזן חברה' + "'!B34", "='" + 'מאזן חברה' + "'!B22", "='" + 'מאזן חברה' + "'!B10", '=SUM(B9:E9)', '=SPARKLINE(B9:E9,{"charttype","column";"color1","#7c3aed"})'],
    ['Operational',           "='" + 'מאזן חברה' + "'!B47", "='" + 'מאזן חברה' + "'!B35", "='" + 'מאזן חברה' + "'!B23", "='" + 'מאזן חברה' + "'!B11", '=SUM(B10:E10)', '=SPARKLINE(B10:E10,{"charttype","column";"color1","#9ca3af"})'],
    ['Total expenses',        "='" + 'מאזן חברה' + "'!B48", "='" + 'מאזן חברה' + "'!B36", "='" + 'מאזן חברה' + "'!B24", "='" + 'מאזן חברה' + "'!B12", '=SUM(B11:E11)', '=SPARKLINE(B11:E11,{"charttype","column";"color1","#ef4444"})'],
    ['Net profit',            "='" + 'מאזן חברה' + "'!B49", "='" + 'מאזן חברה' + "'!B37", "='" + 'מאזן חברה' + "'!B25", "='" + 'מאזן חברה' + "'!B13", '=SUM(B12:E12)', '=SPARKLINE(B12:E12,{"charttype","column";"color1","#10b981"})'],
    ['Profit margin %',       '=IFERROR(B12/B4,0)','=IFERROR(C12/C4,0)','=IFERROR(D12/D4,0)','=IFERROR(E12/E4,0)','=IFERROR(F12/F4,0)','=SPARKLINE(B13:E13,{"charttype","line";"linewidth",2;"color1","#22c55e"})'],
  ];

  sh.getRange(4, 1, rows.length, 7).setFormulas(rows);

  // Number formatting
  sh.getRange(4, 2, rows.length, 5).setNumberFormat('#,##0');
  sh.getRange(5, 2, 1, 5).setNumberFormat('#,##0');
  sh.getRange(6, 2, 1, 5).setNumberFormat('#,##0');
  sh.getRange(13, 2, 1, 5).setNumberFormat('0.0%');

  // Subtle row colors
  var colors = ['#dbeafe', '#dbeafe', '#fef3c7', '#fee2e2', '#fed7aa', '#e9d5ff', '#f3f4f6', '#fecaca', '#bbf7d0', '#dcfce7'];
  for (var i = 0; i < colors.length; i++) {
    sh.getRange(4 + i, 1, 1, 7).setBackground(colors[i]);
  }
  sh.getRange(13, 1, 1, 7).setFontWeight('bold');

  // Best/worst year chips
  sh.getRange('A15').setValue('Best profit year:').setFontWeight('bold');
  sh.getRange('B15').setFormula('=INDEX($B$3:$E$3, MATCH(MAX($B$12:$E$12), $B$12:$E$12, 0))');
  sh.getRange('A16').setValue('Top revenue year:').setFontWeight('bold');
  sh.getRange('B16').setFormula('=INDEX($B$3:$E$3, MATCH(MAX($B$4:$E$4), $B$4:$E$4, 0))');
  sh.getRange('A17').setValue('Lowest profit year:').setFontWeight('bold');
  sh.getRange('B17').setFormula('=INDEX($B$3:$E$3, MATCH(MIN($B$13:$E$13), $B$13:$E$13, 0))');

  // Freeze first 3 rows ONLY. Do NOT freeze columns — the title cell A1:G1
  // is merged across all 7 columns and Sheets refuses to freeze a partial merge.
  sh.setFrozenRows(3);

  try {
    SpreadsheetApp.getUi().alert('Tab "' + KFL_TAB_NAME + '" created with key metrics + sparkline charts.');
  } catch (e) {}
}

function REMOVE_FINANCIAL_SUMMARY() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID);
  var sh = ss.getSheetByName(KFL_TAB_NAME);
  if (sh) {
    ss.deleteSheet(sh);
    try { SpreadsheetApp.getUi().alert('Removed: ' + KFL_TAB_NAME); } catch (e) {}
  } else {
    try { SpreadsheetApp.getUi().alert('No tab named ' + KFL_TAB_NAME + ' found.'); } catch (e) {}
  }
}
