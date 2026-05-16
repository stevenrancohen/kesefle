// DASHBOARD_QUICK_WINS - adds 12-month sparklines to col O of revenue/total/net rows
// per year, plus a YoY annual chip on row 1 of each year block.
// Functions: DRY_RUN_QUICK_WINS, APPLY_QUICK_WINS, REVERT_QUICK_WINS
// Non-destructive: only writes to col O of dashboard region, which is empty.
// Sheet ID is hardcoded below.

var KESEFLE_SHEET_ID_QW = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// Same row map as FIX_DASHBOARD
var YEAR_BLOCKS_QW = {
  '2023': { header: 40, revenue: 42, total: 48, net: 49 },
  '2024': { header: 28, revenue: 30, total: 36, net: 37 },
  '2025': { header: 16, revenue: 18, total: 24, net: 25 },
  '2026': { header:  4, revenue:  6, total: 12, net: 13 }
};

// Sparkline templates - col O of each row shows 12-month trend (cols C..N = months Jan..Dec)
var SPARK_REV = '=IFERROR(SPARKLINE(C{R}:N{R}, {"charttype","line";"linewidth",2;"color1","#16a34a"}), "")';
var SPARK_TOT = '=IFERROR(SPARKLINE(C{R}:N{R}, {"charttype","line";"linewidth",2;"color1","#f59e0b"}), "")';
var SPARK_NET = '=IFERROR(SPARKLINE(C{R}:N{R}, {"charttype","line";"linewidth",2;"color1","#2563eb"}), "")';

// YoY annual chip - lives in col O of the header row (row 4, 16, 28, 40)
// shows current year revenue vs same-year-block-12-rows-down revenue (prior year)
// e.g. 2026 r4 col O = (2026 rev annual - 2025 rev annual) / 2025 rev annual
function _yoyFormula_(thisYearRev, prevYearRev) {
  if (!prevYearRev) return '';
  return '=IFERROR(IF(B' + prevYearRev + '=0,"",TEXT((B' + thisYearRev + '-B' + prevYearRev + ')/B' + prevYearRev + ',"+0.0%;-0.0%")&" YoY"),"")';
}

function DRY_RUN_QUICK_WINS() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_QW);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) { Logger.log('!! dashboard not found'); return; }

  var report = ['===== DRY RUN: QUICK_WINS =====', ''];
  report.push('Will write to col O of these cells (all currently empty):');
  report.push('');

  ['2023','2024','2025','2026'].forEach(function(year) {
    var b = YEAR_BLOCKS_QW[year];
    report.push('--- Year ' + year + ' (header r' + b.header + ') ---');
    [['revenue', b.revenue, 'green'], ['total', b.total, 'orange'], ['net', b.net, 'blue']].forEach(function(t) {
      var existing = dash.getRange(t[1], 15).getValue();
      report.push('  r' + t[1] + ' col O <- sparkline (' + t[2] + ') for ' + t[0] + ' row  [was: ' + (existing || 'empty') + ']');
    });
    report.push('  r' + b.header + ' col O <- YoY chip (annual revenue vs prior year)');
    report.push('');
  });

  report.push('===== END DRY RUN =====');
  Logger.log(report.join('\n'));
  return report.join('\n');
}

function APPLY_QUICK_WINS() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_QW);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) throw new Error('dashboard not found');

  // Backup col O of dashboard region before write
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_qw_' + ts;
  while (ss.getSheetByName(bakName)) bakName = '_BAK_qw_' + ts + '_' + Math.floor(Math.random()*1000);
  var bak = ss.insertSheet(bakName);
  bak.getRange(1, 1, 65, 1).setValues(dash.getRange(1, 15, 65, 1).getValues());
  bak.getRange(67, 1).setValue('Backup of col O rows 1-65 before QUICK_WINS at ' + ts);

  // Per-year metric sparklines
  ['2023','2024','2025','2026'].forEach(function(year) {
    var b = YEAR_BLOCKS_QW[year];
    dash.getRange(b.revenue, 15).setFormula(SPARK_REV.replace(/\{R\}/g, b.revenue));
    dash.getRange(b.total,   15).setFormula(SPARK_TOT.replace(/\{R\}/g, b.total));
    dash.getRange(b.net,     15).setFormula(SPARK_NET.replace(/\{R\}/g, b.net));
  });

  // YoY annual chips - link each year's revenue to the prior year's revenue cell
  // 2026 header r4 <- compares B6 (2026 rev) vs B18 (2025 rev)
  // 2025 header r16 <- B18 vs B30 (2024)
  // 2024 header r28 <- B30 vs B42 (2023)
  // 2023 header r40 <- no prior year, leave empty
  var pairs = [
    { headerRow: 4,  thisRev: 6,  prevRev: 18 },
    { headerRow: 16, thisRev: 18, prevRev: 30 },
    { headerRow: 28, thisRev: 30, prevRev: 42 }
  ];
  pairs.forEach(function(p) {
    dash.getRange(p.headerRow, 15).setFormula(_yoyFormula_(p.thisRev, p.prevRev));
  });

  // Column O width - widen so sparklines display nicely
  dash.setColumnWidth(15, 140);

  Logger.log('APPLY_QUICK_WINS done. Backup: ' + bakName);
  try {
    SpreadsheetApp.getUi().alert('Quick wins applied!\nBackup: ' + bakName);
  } catch (e) {}
}

function REVERT_QUICK_WINS() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID_QW);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) throw new Error('dashboard not found');
  dash.getRange(1, 15, 65, 1).clearContent();
  Logger.log('Cleared col O rows 1-65');
  try { SpreadsheetApp.getUi().alert('Reverted: col O rows 1-65 cleared.'); } catch (e) {}
}
