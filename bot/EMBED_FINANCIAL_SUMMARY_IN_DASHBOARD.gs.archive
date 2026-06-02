// EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs
//
// Writes a clean, styled financial summary INSIDE 'מאזן חברה' (not a separate tab),
// placed BELOW the existing השוואה רב-שנתית comparison block.
//
// Includes:
//   1. 4-year side-by-side table with sparkline column charts
//   2. Profit margin row in proper %
//   3. Year-over-year delta analysis
//   4. Auto-generated insights (which year was best/worst + WHY)
//
// Run:
//   PREVIEW_INSERT_POSITION_   first to confirm placement is safe
//   EMBED_SUMMARY_INTO_DASHBOARD  to install
//   REMOVE_EMBEDDED_SUMMARY      to wipe (clears the inserted rows)
//   REMOVE_STANDALONE_SUMMARY_TAB to delete the old 'סיכום פיננסי' separate tab

var KFL_SHEET_ID_EM = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var KFL_DASH = 'מאזן חברה';
var KFL_OLD_SUMMARY_TAB = 'סיכום פיננסי';
var KFL_EMBED_MARKER = 'EMBEDDED_FINANCIAL_SUMMARY';

// Year block sums in col B of dashboard:
//   2023 rev=B42 net=B49   2024 rev=B30 net=B37
//   2025 rev=B18 net=B25   2026 rev=B6  net=B13

// The הוצאות-row offsets relative to revenue row:
//   +0 revenue  +1 orders  +2 material  +3 marketing  +4 shipping
//   +5 operational  +6 total  +7 net

// =====================================================================
// PREVIEW where the summary will land
// =====================================================================
function PREVIEW_INSERT_POSITION_() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID_EM);
  var dash = ss.getSheetByName(KFL_DASH);
  if (!dash) throw new Error('dashboard not found');
  var startRow = findInsertRow_(dash);
  var lines = [
    '===== INSERT POSITION =====',
    'Embedded summary will start at row: ' + startRow,
    '',
    'Rows ' + startRow + '-' + (startRow + 22) + ' will be overwritten.',
    'Current content at that range:',
  ];
  for (var r = startRow; r <= startRow + 22; r++) {
    var v = dash.getRange(r, 1).getValue();
    lines.push('  r' + r + ': ' + (v || '(empty)'));
  }
  Logger.log(lines.join('\n'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

// =====================================================================
// MAIN: embed the summary into 'מאזן חברה'
// =====================================================================
function EMBED_SUMMARY_INTO_DASHBOARD() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID_EM);
  var dash = ss.getSheetByName(KFL_DASH);
  if (!dash) throw new Error('dashboard not found');

  // 1) Backup the target rows
  var startRow = findInsertRow_(dash);
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_emb_' + ts;
  while (ss.getSheetByName(bakName)) bakName = '_BAK_emb_' + ts + '_' + Math.floor(Math.random() * 1000);
  var bak = ss.insertSheet(bakName);
  bak.getRange(1, 1, 25, 14).setValues(dash.getRange(startRow, 1, 25, 14).getValues());

  // 2) Clear target area
  dash.getRange(startRow, 1, 25, 14).clearContent().clearFormat().breakApart();

  // 3) Write the summary block
  var r = startRow;

  // Title row (merged A:G)
  dash.getRange(r, 1, 1, 7).merge();
  dash.getRange(r, 1).setValue('📊 סיכום פיננסי — תמונת מצב 4 שנים')
    .setFontSize(14).setFontWeight('bold')
    .setBackground('#0f1422').setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  dash.setRowHeight(r, 32);
  // Hidden marker so REMOVE function can locate this block
  dash.getRange(r, 8).setValue(KFL_EMBED_MARKER + ':START').setFontColor('#ffffff');
  r += 2;

  // Header row
  var headers = ['קטגוריה', '2023', '2024', '2025', '2026', 'סך 4 שנים', 'מגמה'];
  dash.getRange(r, 1, 1, 7).setValues([headers])
    .setFontWeight('bold').setBackground('#1e2638').setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  dash.setRowHeight(r, 28);
  r++;

  // Data rows (use setValues for labels + setFormula for formulas separately to avoid #NAME?)
  var dataRows = [
    { label: 'מחזור ברוטו',         color: '#dcfce7', refs: ['B42','B30','B18','B6'],  sparkColor: '#16a34a', isPct: false },
    { label: 'מס׳ הזמנות',          color: '#dbeafe', refs: ['B43','B31','B19','B7'],  sparkColor: '#2563eb', isPct: false },
    { label: 'ערך הזמנה ממוצע',     color: '#e9d5ff', refs: null /* computed below */, sparkColor: '#a855f7', isPct: false },
    { label: 'עלות חומרי גלם',     color: '#fee2e2', refs: ['B44','B32','B20','B8'],  sparkColor: '#dc2626', isPct: false },
    { label: 'עלות שיווק',         color: '#fed7aa', refs: ['B45','B33','B21','B9'],  sparkColor: '#f59e0b', isPct: false },
    { label: 'משלוחים והתקנות',    color: '#e9d5ff', refs: ['B46','B34','B22','B10'], sparkColor: '#7c3aed', isPct: false },
    { label: 'הוצאות תפעוליות',    color: '#f3f4f6', refs: ['B47','B35','B23','B11'], sparkColor: '#9ca3af', isPct: false },
    { label: 'סה״כ הוצאות עסקיות', color: '#fecaca', refs: ['B48','B36','B24','B12'], sparkColor: '#ef4444', isPct: false },
    { label: 'רווח נטו שנתי',      color: '#bbf7d0', refs: ['B49','B37','B25','B13'], sparkColor: '#10b981', isPct: false },
    { label: 'אחוז רווחיות',        color: '#dcfce7', refs: null /* computed below */, sparkColor: '#22c55e', isPct: true,  isLine: true },
  ];

  var dataStartRow = r;
  for (var i = 0; i < dataRows.length; i++) {
    var d = dataRows[i];
    // Label in col A
    dash.getRange(r, 1).setValue(d.label).setFontWeight('bold');

    if (d.refs) {
      // Direct cell references for each year column B-E
      dash.getRange(r, 2).setFormula("='" + KFL_DASH + "'!" + d.refs[0]); // 2023 -> col B
      dash.getRange(r, 3).setFormula("='" + KFL_DASH + "'!" + d.refs[1]); // 2024 -> col C
      dash.getRange(r, 4).setFormula("='" + KFL_DASH + "'!" + d.refs[2]); // 2025 -> col D
      dash.getRange(r, 5).setFormula("='" + KFL_DASH + "'!" + d.refs[3]); // 2026 -> col E
      // 4-year total
      dash.getRange(r, 6).setFormula('=SUM(B' + r + ':E' + r + ')');
    } else if (d.label === 'ערך הזמנה ממוצע') {
      // = revenue row / orders row (relative to summary block: rows dataStartRow + 0 and +1)
      var revR = dataStartRow;
      var ordR = dataStartRow + 1;
      dash.getRange(r, 2).setFormula('=IFERROR(B' + revR + '/B' + ordR + ',0)');
      dash.getRange(r, 3).setFormula('=IFERROR(C' + revR + '/C' + ordR + ',0)');
      dash.getRange(r, 4).setFormula('=IFERROR(D' + revR + '/D' + ordR + ',0)');
      dash.getRange(r, 5).setFormula('=IFERROR(E' + revR + '/E' + ordR + ',0)');
      dash.getRange(r, 6).setFormula('=IFERROR(F' + revR + '/F' + ordR + ',0)');
    } else if (d.isPct) {
      // = net / revenue
      var revR2 = dataStartRow;          // row of revenue (the first row in this block)
      var netR2 = dataStartRow + 8;      // row of net (revenue + 8)
      dash.getRange(r, 2).setFormula('=IFERROR(B' + netR2 + '/B' + revR2 + ',0)');
      dash.getRange(r, 3).setFormula('=IFERROR(C' + netR2 + '/C' + revR2 + ',0)');
      dash.getRange(r, 4).setFormula('=IFERROR(D' + netR2 + '/D' + revR2 + ',0)');
      dash.getRange(r, 5).setFormula('=IFERROR(E' + netR2 + '/E' + revR2 + ',0)');
      dash.getRange(r, 6).setFormula('=IFERROR(F' + netR2 + '/F' + revR2 + ',0)');
    }

    // Sparkline in col G (use line chart for the profit margin %, column for everything else)
    var sparkType = d.isLine ? 'line' : 'column';
    var sparkFormula = '=SPARKLINE(B' + r + ':E' + r + ',{"charttype","' + sparkType + '";"linewidth",2;"color1","' + d.sparkColor + '"})';
    dash.getRange(r, 7).setFormula(sparkFormula);

    // Row background
    dash.getRange(r, 1, 1, 7).setBackground(d.color);

    // Number formatting
    if (d.isPct) {
      dash.getRange(r, 2, 1, 5).setNumberFormat('0.0%');
    } else {
      dash.getRange(r, 2, 1, 5).setNumberFormat('#,##0');
    }
    r++;
  }

  // Spacer
  r++;

  // ====== Year-over-Year delta analysis ======
  dash.getRange(r, 1, 1, 7).merge();
  dash.getRange(r, 1).setValue('📈 שינוי שנה-לעומת-שנה (רווח נטו)')
    .setFontWeight('bold').setBackground('#1e2638').setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  dash.setRowHeight(r, 26);
  r++;

  var netRow = dataStartRow + 8; // row of net profit in our embedded block
  dash.getRange(r, 1).setValue("Δ נטו %");
  dash.getRange(r, 1).setFontWeight('bold').setBackground('#f3f4f6');
  // For each year except the first (2023), compute % change vs previous year
  dash.getRange(r, 2).setValue('—'); // 2023 has no prior year
  dash.getRange(r, 3).setFormula('=IFERROR((C' + netRow + '-B' + netRow + ')/B' + netRow + ',0)'); // 2024 vs 2023
  dash.getRange(r, 4).setFormula('=IFERROR((D' + netRow + '-C' + netRow + ')/C' + netRow + ',0)'); // 2025 vs 2024
  dash.getRange(r, 5).setFormula('=IFERROR((E' + netRow + '-D' + netRow + ')/D' + netRow + ',0)'); // 2026 vs 2025
  dash.getRange(r, 6).setValue('');
  dash.getRange(r, 7).setFormula('=SPARKLINE(B' + r + ':E' + r + ',{"charttype","line";"color1","#16a34a"})');
  dash.getRange(r, 2, 1, 4).setNumberFormat('+0.0%;-0.0%');
  dash.getRange(r, 1, 1, 7).setBackground('#fef9c3');
  r++;

  // Spacer
  r++;

  // ====== Auto-insights ======
  dash.getRange(r, 1, 1, 7).merge();
  dash.getRange(r, 1).setValue('💡 תובנות אוטומטיות')
    .setFontWeight('bold').setBackground('#1e2638').setFontColor('#ffffff')
    .setHorizontalAlignment('center');
  dash.setRowHeight(r, 26);
  r++;

  // Best year
  dash.getRange(r, 1).setValue('שנה רווחית ביותר').setFontWeight('bold');
  dash.getRange(r, 2, 1, 6).merge();
  dash.getRange(r, 2).setFormula(
    '=INDEX(B' + dataStartRow + ':E' + dataStartRow + ', MATCH(MAX(B' + netRow + ':E' + netRow + '), B' + netRow + ':E' + netRow + ', 0)) & "  ·  רווח נטו " & TEXT(MAX(B' + netRow + ':E' + netRow + '), "₪#,##0") & "  ·  מתוך מחזור " & TEXT(INDEX(B' + dataStartRow + ':E' + dataStartRow + ', MATCH(MAX(B' + netRow + ':E' + netRow + '), B' + netRow + ':E' + netRow + ', 0)), "₪#,##0")'
  );
  dash.getRange(r, 1, 1, 7).setBackground('#dcfce7');
  r++;

  dash.getRange(r, 1).setValue('שנה עם מחזור שיא').setFontWeight('bold');
  dash.getRange(r, 2, 1, 6).merge();
  dash.getRange(r, 2).setFormula(
    '=INDEX(B' + dataStartRow + ':E' + dataStartRow + ', MATCH(MAX(B' + dataStartRow + ':E' + dataStartRow + '), B' + dataStartRow + ':E' + dataStartRow + ', 0)) & "  ·  מחזור " & TEXT(MAX(B' + dataStartRow + ':E' + dataStartRow + '), "₪#,##0")'
  );
  dash.getRange(r, 1, 1, 7).setBackground('#dbeafe');
  r++;

  dash.getRange(r, 1).setValue('שנה הכי פחות רווחית').setFontWeight('bold');
  dash.getRange(r, 2, 1, 6).merge();
  dash.getRange(r, 2).setFormula(
    '=INDEX(B' + dataStartRow + ':E' + dataStartRow + ', MATCH(MIN(B' + netRow + ':E' + netRow + '), B' + netRow + ':E' + netRow + ', 0)) & "  ·  רווח נטו " & TEXT(MIN(B' + netRow + ':E' + netRow + '), "₪#,##0")'
  );
  dash.getRange(r, 1, 1, 7).setBackground('#fee2e2');
  r++;

  // Diagnosis: what caused the worst year's loss
  dash.getRange(r, 1).setValue('הגורם העיקרי').setFontWeight('bold');
  dash.getRange(r, 2, 1, 6).merge();
  // Compare highest-expense-category share in worst year vs overall
  // Worst-year column index: 2..5 (2023..2026)
  var worstColMatch = 'MATCH(MIN(B' + netRow + ':E' + netRow + '), B' + netRow + ':E' + netRow + ', 0)';
  var rev_row = dataStartRow;
  var mat_row = dataStartRow + 3;
  var mkt_row = dataStartRow + 4;
  var ship_row = dataStartRow + 5;
  var op_row = dataStartRow + 6;
  // Find the biggest cost as % of revenue in the worst year
  dash.getRange(r, 2).setFormula(
    '=IF(INDEX(B' + mat_row + ':E' + mat_row + ', ' + worstColMatch + ')/INDEX(B' + rev_row + ':E' + rev_row + ', ' + worstColMatch + ') > 0.4, "חומרי גלם גבוהים מדי (>40% מהמחזור)", ' +
    'IF(INDEX(B' + mkt_row + ':E' + mkt_row + ', ' + worstColMatch + ')/INDEX(B' + rev_row + ':E' + rev_row + ', ' + worstColMatch + ') > 0.4, "עלות שיווק גבוהה מדי (>40% מהמחזור)", ' +
    'IF(INDEX(B' + mat_row + ':E' + mat_row + ', ' + worstColMatch + ')/INDEX(B' + rev_row + ':E' + rev_row + ', ' + worstColMatch + ') > 0.3, "חומרי גלם גבוהים (>30% מהמחזור)", ' +
    'IF(INDEX(B' + mkt_row + ':E' + mkt_row + ', ' + worstColMatch + ')/INDEX(B' + rev_row + ':E' + rev_row + ', ' + worstColMatch + ') > 0.3, "עלות שיווק גבוהה (>30% מהמחזור)", ' +
    '"מחזור נמוך (לא מספיק הזמנות)"))))'
  );
  dash.getRange(r, 1, 1, 7).setBackground('#fef3c7');
  r++;

  // Recommendation
  dash.getRange(r, 1).setValue('המלצה אופרטיבית').setFontWeight('bold');
  dash.getRange(r, 2, 1, 6).merge();
  dash.getRange(r, 2).setFormula(
    '=IF(INDEX(B' + mkt_row + ':E' + mkt_row + ', 4)/INDEX(B' + rev_row + ':E' + rev_row + ', 4) > 0.3, ' +
    '"שקול לחתוך 20-30% בהוצאות שיווק או להגדיל את ה-ROAS", ' +
    'IF(INDEX(B' + mat_row + ':E' + mat_row + ', 4)/INDEX(B' + rev_row + ':E' + rev_row + ', 4) > 0.4, ' +
    '"שקול להחליף ספקים או להעלות מחירים כדי להחזיר מרווחיות", ' +
    '"הגדל את מספר ההזמנות החודשי (היעד: לעבור את 2023)"))'
  );
  dash.getRange(r, 1, 1, 7).setBackground('#dbeafe');
  r++;

  // End marker
  dash.getRange(r, 8).setValue(KFL_EMBED_MARKER + ':END').setFontColor('#ffffff');

  // Adjust column widths
  dash.setColumnWidth(1, 180);
  dash.setColumnWidth(7, 140);

  try {
    SpreadsheetApp.getUi().alert(
      'Embedded financial summary into מאזן חברה\n' +
      'Rows ' + startRow + '-' + r + '\n' +
      'Backup: ' + bakName + '\n\n' +
      'Includes: 4-year table, YoY delta, best/worst year, root cause, recommendation.'
    );
  } catch (e) {}
}

// =====================================================================
// Find a safe insertion row (below the existing comparison block)
// =====================================================================
function findInsertRow_(dash) {
  // Walk down from row 50 looking for the last non-empty row, then start 2 rows below.
  var lastRow = dash.getLastRow();
  // Check column A for content; the comparison block uses col A for labels.
  var startSearch = 50;
  var lastContentRow = startSearch;
  for (var r = startSearch; r <= lastRow + 1; r++) {
    var v = dash.getRange(r, 1).getValue();
    if (v && String(v).trim().length > 0) lastContentRow = r;
  }
  return lastContentRow + 2;
}

// =====================================================================
// REMOVE: wipe the embedded summary (by locating the START/END markers)
// =====================================================================
function REMOVE_EMBEDDED_SUMMARY() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID_EM);
  var dash = ss.getSheetByName(KFL_DASH);
  if (!dash) throw new Error('dashboard not found');

  var lastRow = dash.getLastRow();
  var startMarker = -1;
  var endMarker = -1;
  for (var r = 1; r <= lastRow; r++) {
    var v = dash.getRange(r, 8).getValue();
    if (v === KFL_EMBED_MARKER + ':START') startMarker = r;
    if (v === KFL_EMBED_MARKER + ':END') endMarker = r;
  }
  if (startMarker < 0 || endMarker < 0) {
    SpreadsheetApp.getUi().alert('No embedded summary found (markers missing).');
    return;
  }
  var rowsToClear = endMarker - startMarker + 1;
  dash.getRange(startMarker, 1, rowsToClear, 14).clearContent().clearFormat().breakApart();
  SpreadsheetApp.getUi().alert('Removed embedded summary (rows ' + startMarker + '-' + endMarker + ').');
}

// =====================================================================
// REMOVE the standalone 'סיכום פיננסי' tab created by older scripts
// =====================================================================
function REMOVE_STANDALONE_SUMMARY_TAB() {
  var ss = SpreadsheetApp.openById(KFL_SHEET_ID_EM);
  var sh = ss.getSheetByName(KFL_OLD_SUMMARY_TAB);
  if (sh) {
    ss.deleteSheet(sh);
    SpreadsheetApp.getUi().alert('Deleted standalone tab: ' + KFL_OLD_SUMMARY_TAB);
  } else {
    SpreadsheetApp.getUi().alert('Tab "' + KFL_OLD_SUMMARY_TAB + '" not found (already removed?).');
  }
}
