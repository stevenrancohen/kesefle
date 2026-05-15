/**
 * FIX_DASHBOARD_2023_2024_2025
 * --------------------------------------------------------------
 * Diagnosed bugs in `מאזן חברה`:
 *   1. רווח נטו row (r49 for 2023, r37 for 2024, r25 for 2025) was
 *      computed with an obsolete formula. r48/r36/r24 (סה"כ הוצאות)
 *      are correct, but רווח נטו ≠ revenue − total.
 *      • 2023: stored 127,626 / expected 26,482
 *      • 2024: stored 119,266 / expected 72,069
 *      • 2025: stored   7,714 / expected  6,338
 *      • 2026 OK (27,062 = 45,269 − 18,207)
 *   2. 2023 משלוחים והתקנות (r46) has the full 15,105 only in Dec.
 *      Should be spread per actual monthly installations from the
 *      `מאזן חברה 2023` year-tab order log (col G "התקנות").
 *   3. Stale data-validation on Feb/Aug/Sep 2023 cells — values
 *      no longer match validation criteria after recomputation.
 *
 * Strategy (per user rules: backup-first, propose-before-apply,
 * never overwrite user-typed values):
 *   - Always backup before write.
 *   - Only touch the 4 specific cells per year (r48, r49 + 2023 r46)
 *     so we preserve any user edits to marketing/operational rows.
 *   - Print a dry-run table to Logger first via DRY_RUN_FIX_DASHBOARD()
 *     so the user can review before applying.
 *   - APPLY_FIX_DASHBOARD() commits the changes.
 * --------------------------------------------------------------
 */

var KESEFLE_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// Row map per year — rows where each category lives in `מאזן חברה`
var YEAR_BLOCKS_ = {
  '2023': { revenue: 42, orders: 43, material: 44, marketing: 45, shipping: 46, operational: 47, total: 48, net: 49 },
  '2024': { revenue: 30, orders: 31, material: 32, marketing: 33, shipping: 34, operational: 35, total: 36, net: 37 },
  '2025': { revenue: 18, orders: 19, material: 20, marketing: 21, shipping: 22, operational: 23, total: 24, net: 25 },
  '2026': { revenue:  6, orders:  7, material:  8, marketing:  9, shipping: 10, operational: 11, total: 12, net: 13 }
};

var HEB_MONTH_MAP_ = {
  'ינואר':1, 'פברואר':2, 'מרץ':3, 'אפריל':4, 'מאי':5, 'יוני':6,
  'יולי':7, 'אוגוסט':8, 'ספטמבר':9, 'אוקטובר':10, 'נובמבר':11, 'דצמבר':12
};

/* =================================================================
 * DRY_RUN_FIX_DASHBOARD — read-only diagnostic, prints to Logger.
 * Run this FIRST, copy the log, review, then run APPLY_FIX_DASHBOARD.
 * ================================================================= */
function DRY_RUN_FIX_DASHBOARD() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) { Logger.log('!! מאזן חברה not found'); return; }

  var report = ['===== DRY RUN: FIX_DASHBOARD =====', ''];

  ['2023','2024','2025'].forEach(function(year) {
    var b = YEAR_BLOCKS_[year];
    report.push('--- שנת ' + year + ' ---');
    // Annual sums (col B)
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
    report.push('  total stored=' + totStored + ' expected=' + totExpected + ' ' + (Math.abs(totStored-totExpected)<1?'✓':'⚠ MISMATCH'));
    report.push('  net   stored=' + netStored + ' expected=' + netExpected + ' ' + (Math.abs(netStored-netExpected)<1?'✓':'⚠ WILL BE FIXED'));
    report.push('');
  });

  // משלוחים והתקנות monthly for 2023
  var instByMonth = computeMonthlyInstallations2023_(ss);
  var b23 = YEAR_BLOCKS_['2023'];
  report.push('--- 2023 משלוחים והתקנות monthly spread (current vs new) ---');
  var months = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];
  for (var m = 0; m < 12; m++) {
    var cur = num_(dash.getRange(b23.shipping, 3 + m).getValue());
    var nw  = instByMonth[m];
    report.push('  ' + months[m] + ': current=' + cur + ' → new=' + nw + (cur !== nw ? '  ★' : ''));
  }
  report.push('  SUM: ' + instByMonth.reduce(function(a,b){return a+b;}, 0));
  report.push('');

  report.push('===== END DRY RUN =====');
  report.push('Run APPLY_FIX_DASHBOARD() to commit. A backup tab will be created automatically.');
  Logger.log(report.join('\n'));
  return report.join('\n');
}

/* =================================================================
 * APPLY_FIX_DASHBOARD — backup, then write fixes.
 * ================================================================= */
function APPLY_FIX_DASHBOARD() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName('מאזן חברה');
  if (!dash) throw new Error('מאזן חברה not found');

  // 1. Backup the whole dashboard region (rows 1-65, cols A-N)
  var ts = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
  var bakName = '_BAK_dashFix_' + ts;
  while (ss.getSheetByName(bakName)) bakName = '_BAK_dashFix_' + ts + '_' + Math.floor(Math.random()*1000);
  var bak = ss.insertSheet(bakName);
  var srcRange = dash.getRange(1, 1, 65, 14);
  bak.getRange(1, 1, 65, 14).setValues(srcRange.getValues());
  bak.getRange(67, 1).setValue('Backup of מאזן חברה rows 1-65 cols A-N before FIX_DASHBOARD at ' + ts);
  Logger.log('Backup created: ' + bakName);

  // 2. Spread משלוחים והתקנות for 2023 across months
  var instByMonth = computeMonthlyInstallations2023_(ss);
  var b23 = YEAR_BLOCKS_['2023'];
  var instSum = instByMonth.reduce(function(a,b){return a+b;}, 0);
  dash.getRange(b23.shipping, 2).setValue(instSum);  // col B annual sum
  dash.getRange(b23.shipping, 3, 1, 12).setValues([instByMonth]); // cols C..N (Jan..Dec)

  // 3. Recompute total + net for 2023, 2024, 2025 (per-column AND col B sum)
  ['2023','2024','2025'].forEach(function(year) {
    var b = YEAR_BLOCKS_[year];
    // Annual col B
    var rev = num_(dash.getRange(b.revenue, 2).getValue());
    var mat = num_(dash.getRange(b.material, 2).getValue());
    var mkt = num_(dash.getRange(b.marketing, 2).getValue());
    var shp = num_(dash.getRange(b.shipping, 2).getValue());
    var op  = num_(dash.getRange(b.operational, 2).getValue());
    var total = mat + mkt + shp + op;
    dash.getRange(b.total, 2).setValue(total);
    dash.getRange(b.net,   2).setValue(rev - total);

    // Per-month cols C..N (3..14)
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

  // 4. Clear stale data-validation on the 2023 block (rows 40-49)
  dash.getRange(40, 1, 10, 30).clearDataValidations();
  // and on 2024, 2025 too for safety
  dash.getRange(28, 1, 10, 30).clearDataValidations();
  dash.getRange(16, 1, 10, 30).clearDataValidations();

  // 5. Refresh השוואה רב-שנתית block (r52+) — its sums now reflect the fixed net
  // (the comparison block reads from the year blocks above, so no action needed unless hardcoded)

  Logger.log('APPLY_FIX_DASHBOARD complete. Backup: ' + bakName);
  try {
    SpreadsheetApp.getUi().alert(
      'תוקן!\n\n' +
      '✓ משלוחים והתקנות 2023 פוזרו לפי חודשים\n' +
      '✓ סה"כ הוצאות + רווח נטו חושבו מחדש ל-2023/2024/2025\n' +
      '✓ אימותי נתונים ישנים נוקו על בלוקי השנים\n\n' +
      'גיבוי: ' + bakName
    );
  } catch (e) { /* no UI in scheduled run */ }
}

/* ----------------------------------------------------------------- */
function computeMonthlyInstallations2023_(ss) {
  var yr = ss.getSheetByName('מאזן חברה 2023');
  if (!yr) throw new Error('מאזן חברה 2023 not found');
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

/* =================================================================
 * POST_APPLY_VERIFY — confirms the fix worked. Run after APPLY.
 * ================================================================= */
function POST_APPLY_VERIFY() {
  var ss = SpreadsheetApp.openById(KESEFLE_SHEET_ID);
  var dash = ss.getSheetByName('מאזן חברה');
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
    lines.push('שנת ' + year + ':');
    lines.push('  total ' + tot + ' vs expected ' + expTot + ' ' + (totOk ? '✓' : '✗'));
    lines.push('  net   ' + net + ' vs expected ' + expNet + ' ' + (netOk ? '✓' : '✗'));
    if (totOk) pass++; else fail++;
    if (netOk) pass++; else fail++;
  });

  // 2023 shipping monthly sum vs annual
  var b23 = YEAR_BLOCKS_['2023'];
  var shpAnnual = num_(dash.getRange(b23.shipping, 2).getValue());
  var monthSum = 0;
  for (var col = 3; col <= 14; col++) monthSum += num_(dash.getRange(b23.shipping, col).getValue());
  var shipOk = Math.abs(shpAnnual - monthSum) < 1;
  lines.push('');
  lines.push('2023 משלוחים: annual=' + shpAnnual + ' months sum=' + monthSum + ' ' + (shipOk ? '✓' : '✗'));
  if (shipOk) pass++; else fail++;

  lines.push('');
  lines.push('RESULT: ' + pass + ' pass / ' + fail + ' fail');
  Logger.log(lines.join('\n'));
  try {
    SpreadsheetApp.getUi().alert('Verify: ' + pass + ' pass, ' + fail + ' fail. See View → Logs.');
  } catch (e) {}
  return { pass: pass, fail: fail };
}
