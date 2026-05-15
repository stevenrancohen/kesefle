// FIX_DASHBOARD - safe version (ASCII-only comments)
// Functions: DRY_RUN_FIX_DASHBOARD, APPLY_FIX_DASHBOARD, POST_APPLY_VERIFY
// Sheet ID is hardcoded below.

var KESEFLE_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

var YEAR_BLOCKS_ = {
  '2023': { revenue: 42, orders: 43, material: 44, marketing: 45, shipping: 46, operational: 47, total: 48, net: 49 },
  '2024': { revenue: 30, orders: 31, material: 32, marketing: 33, shipping: 34, operational: 35, total: 36, net: 37 },
  '2025': { revenue: 18, orders: 19, material: 20, marketing: 21, shipping: 22, operational: 23, total: 24, net: 25 },
  '2026': { revenue:  6, orders:  7, material:  8, marketing:  9, shipping: 10, operational: 11, total: 12, net: 13 }
};

var DASH_SHEET = 'מאזן חברה';
var Y2023_SHEET = 'מאזן חברה 2023';

var HEB_MONTH_MAP_ = {};
HEB_MONTH_MAP_['ינואר']=1; HEB_MONTH_MAP_['פברואר']=2; HEB_MONTH_MAP_['מרץ']=3;
HEB_MONTH_MAP_['אפריל']=4; HEB_MONTH_MAP_['מאי']=5; HEB_MONTH_MAP_['יוני']=6;
HEB_MONTH_MAP_['יולי']=7; HEB_MONTH_MAP_['אוגוסט']=8; HEB_MONTH_MAP_['ספטמבר']=9;
HEB_MONTH_MAP_['אוקטובר']=10; HEB_MONTH_MAP_['נובמבר']=11; HEB_MONTH_MAP_['דצמבר']=12;

function DRY_RUN_FIX_DASHBOARD() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName(DASH_SHEET);
  if (!dash) { Logger.log('!! dashboard sheet not found'); return; }

  var report = ['===== DRY RUN: FIX_DASHBOARD =====', ''];

  ['2023','2024','2025'].forEach(function(year) {
    var b = YEAR_BLOCKS_[year];
    report.push('--- Year ' + year + ' ---');
    var rev = num_(dash.getRange(b.revenue, 2).getValue());
    var mat = num_(dash.getRange(b.material, 2).getValue());
    var mkt = num_(dash.getRange(b.marketing, 2).getValue());
    var shp = num_(dash.getRange(b.shipping, 2).getValue());
    var op  = num_(dash.getRange(b.operational, 2).getValue());
    var totStored = num_(dash.getRange(b.total, 2).getValue());
    var netStored = num_(dash.getRange(b.net, 2).getValue());
    var totExpected = mat + mkt + shp + op;
    var netExpected = rev - totExpected;
    report.push('  rev=' + rev + ' mat=' + mat + ' mkt=' + mkt + ' shp=' + shp + ' op=' + op);
    report.push('  total stored=' + totStored + ' expected=' + totExpected + ' ' + (Math.abs(totStored-totExpected)<1?'OK':'MISMATCH'));
    report.push('  net   stored=' + netStored + ' expected=' + netExpected + ' ' + (Math.abs(netStored-netExpected)<1?'OK':'WILL BE FIXED'));
    report.push('');
  });

  var instByMonth = computeMonthlyInstallations2023_(ss);
  var b23 = YEAR_BLOCKS_['2023'];
  report.push('--- 2023 shipping monthly spread (current vs new) ---');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (var m = 0; m < 12; m++) {
    var cur = num_(dash.getRange(b23.shipping, 3 + m).getValue());
    var nw  = instByMonth[m];
    report.push('  ' + months[m] + ': current=' + cur + ' new=' + nw + (cur !== nw ? '  *' : ''));
  }
  report.push('  SUM: ' + instByMonth.reduce(function(a,b){return a+b;}, 0));
  report.push('');

  report.push('===== END DRY RUN =====');
  report.push('Run APPLY_FIX_DASHBOARD() to commit. A backup tab will be created automatically.');
  Logger.log(report.join('\n'));
  return report.join('\n');
}

function APPLY_FIX_DASHBOARD() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName(DASH_SHEET);
  if (!dash) throw new Error('dashboard not found');

  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_dashFix_' + ts;
  while (ss.getSheetByName(bakName)) bakName = '_BAK_dashFix_' + ts + '_' + Math.floor(Math.random()*1000);
  var bak = ss.insertSheet(bakName);
  var srcRange = dash.getRange(1, 1, 65, 14);
  bak.getRange(1, 1, 65, 14).setValues(srcRange.getValues());
  bak.getRange(67, 1).setValue('Backup of dashboard rows 1-65 cols A-N before FIX at ' + ts);
  Logger.log('Backup created: ' + bakName);

  var instByMonth = computeMonthlyInstallations2023_(ss);
  var b23 = YEAR_BLOCKS_['2023'];
  var instSum = instByMonth.reduce(function(a,b){return a+b;}, 0);
  dash.getRange(b23.shipping, 2).setValue(instSum);
  dash.getRange(b23.shipping, 3, 1, 12).setValues([instByMonth]);

  ['2023','2024','2025'].forEach(function(year) {
    var b = YEAR_BLOCKS_[year];
    var rev = num_(dash.getRange(b.revenue, 2).getValue());
    var mat = num_(dash.getRange(b.material, 2).getValue());
    var mkt = num_(dash.getRange(b.marketing, 2).getValue());
    var shp = num_(dash.getRange(b.shipping, 2).getValue());
    var op  = num_(dash.getRange(b.operational, 2).getValue());
    var total = mat + mkt + shp + op;
    dash.getRange(b.total, 2).setValue(total);
    dash.getRange(b.net,   2).setValue(rev - total);

    for (var col = 3; col <= 14; col++) {
      var rev_c = num_(dash.getRange(b.revenue, col).getValue());
      var mat_c = num_(dash.getRange(b.material, col).getValue());
      var mkt_c = num_(dash.getRange(b.marketing, col).getValue());
      var shp_c = num_(dash.getRange(b.shipping, col).getValue());
      var op_c  = num_(dash.getRange(b.operational, col).getValue());
      var tot_c = mat_c + mkt_c + shp_c + op_c;
      dash.getRange(b.total, col).setValue(tot_c);
      dash.getRange(b.net,   col).setValue(rev_c - tot_c);
    }
  });

  dash.getRange(40, 1, 10, 30).clearDataValidations();
  dash.getRange(28, 1, 10, 30).clearDataValidations();
  dash.getRange(16, 1, 10, 30).clearDataValidations();

  Logger.log('APPLY_FIX_DASHBOARD complete. Backup: ' + bakName);
  try {
    SpreadsheetApp.getUi().alert('FIX applied!\nBackup tab: ' + bakName);
  } catch (e) {}
}

function computeMonthlyInstallations2023_(ss) {
  var yr = ss.getSheetByName(Y2023_SHEET);
  if (!yr) throw new Error('year 2023 sheet not found');
  var lastRow = yr.getLastRow();
  var data = yr.getRange(5, 1, Math.max(1, lastRow - 4), 11).getValues();
  var instByMonth = [0,0,0,0,0,0,0,0,0,0,0,0];
  var currentMonth = null;
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var colA = row[0];
    var colB = row[1];
    var colG = row[6];
    if (colA && HEB_MONTH_MAP_[colA]) currentMonth = HEB_MONTH_MAP_[colA];
    if (colB instanceof Date) currentMonth = colB.getMonth() + 1;
    else if (typeof colB === 'string') {
      var m = colB.match(/^(\d+)\.(\d+)\./);
      if (m) currentMonth = parseInt(m[2], 10);
    }
    if (currentMonth && typeof colG === 'number') instByMonth[currentMonth-1] += colG;
  }
  return instByMonth;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function POST_APPLY_VERIFY() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName(DASH_SHEET);
  var lines = ['===== POST-APPLY VERIFY =====', ''];
  var pass = 0, fail = 0;

  ['2023','2024','2025','2026'].forEach(function(year) {
    var b = YEAR_BLOCKS_[year];
    var rev = num_(dash.getRange(b.revenue, 2).getValue());
    var mat = num_(dash.getRange(b.material, 2).getValue());
    var mkt = num_(dash.getRange(b.marketing, 2).getValue());
    var shp = num_(dash.getRange(b.shipping, 2).getValue());
    var op  = num_(dash.getRange(b.operational, 2).getValue());
    var tot = num_(dash.getRange(b.total, 2).getValue());
    var net = num_(dash.getRange(b.net, 2).getValue());
    var expTot = mat + mkt + shp + op;
    var expNet = rev - expTot;
    var totOk = Math.abs(tot - expTot) < 1;
    var netOk = Math.abs(net - expNet) < 1;
    lines.push('Year ' + year + ':');
    lines.push('  total ' + tot + ' vs expected ' + expTot + ' ' + (totOk ? 'OK' : 'FAIL'));
    lines.push('  net   ' + net + ' vs expected ' + expNet + ' ' + (netOk ? 'OK' : 'FAIL'));
    if (totOk) pass++; else fail++;
    if (netOk) pass++; else fail++;
  });

  var b23 = YEAR_BLOCKS_['2023'];
  var shpAnnual = num_(dash.getRange(b23.shipping, 2).getValue());
  var monthSum = 0;
  for (var col = 3; col <= 14; col++) monthSum += num_(dash.getRange(b23.shipping, col).getValue());
  var shipOk = Math.abs(shpAnnual - monthSum) < 1;
  lines.push('');
  lines.push('2023 shipping: annual=' + shpAnnual + ' months sum=' + monthSum + ' ' + (shipOk ? 'OK' : 'FAIL'));
  if (shipOk) pass++; else fail++;

  lines.push('');
  lines.push('RESULT: ' + pass + ' pass / ' + fail + ' fail');
  Logger.log(lines.join('\n'));
  try {
    SpreadsheetApp.getUi().alert('Verify: ' + pass + ' pass, ' + fail + ' fail.');
  } catch (e) {}
  return { pass: pass, fail: fail };
}
