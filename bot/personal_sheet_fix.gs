/**
 * Comprehensive sheet dashboard fixer for Steven's setup.
 *
 * Steven's "מאזן חברה" was built by a custom MASTER_FIX_v2 / FIX_DASHBOARD
 * script that writes VALUES (not formulas). So every time the bot writes
 * a new row to "תנועות" the dashboard does NOT auto-update.
 *
 * This file ships 3 functions:
 *
 *   1) recomputeCompanyDashboard()
 *      Reads תנועות, groups by month, writes the correct VALUES into
 *      'מאזן חברה' rows 6 (revenue), 7 (order count), 8..11 (expense
 *      categories), 12 (total expenses), 13 (net profit), 14 (margin %).
 *      Wildcard-matches all subcategory variants the bot writes:
 *        - row 8 raw materials:  "חומרי גלם" / "עלות חומרי גלם"
 *        - row 9 marketing:      "שיווק" / "עלות שיווק"
 *        - row 10 shipping:      "משלוח" / "משלוחים והתקנות" / "אריזה ומשלוח"
 *        - row 11 ops:           "תפעוליות" / "הוצאות תפעוליות" / "יועצים"
 *                                / "תוכנות" / "ציוד עסקי" / "מיסים"
 *      Revenue (row 6) sums:
 *        - הזמנות col D (sale price) by month  AND
 *        - תנועות col C where col D="עסק" AND col E="מחזור" (bot's
 *          revenue marker) by month
 *      Order count (row 7) = COUNT of הזמנות rows by month + תנועות
 *        rows where E="מחזור".
 *
 *   2) recomputePersonalDashboard()
 *      Same idea for 'מאזן אישי'. For every data row, sums תנועות col C
 *      where col E CONTAINS the row's label (col A).
 *
 *   3) recomputeAllDashboards()
 *      Runs both. Use this one.
 *
 * NO menus, NO getUi() — runs cleanly in standalone Apps Script.
 * Watch the Execution Log (יומן ביצוע) for results.
 *
 * Safe to re-run anytime. Idempotent.
 */

// ─── CONFIGURE ──────────────────────────────────────────────────────────
// Steven's "מאזן אישי" spreadsheet ID (from his earlier WhatsApp link).
// Swap if you want to run this on a different sheet.
var SHEET_ID_TO_FIX  = '1nRR9w6kU7hPx_62gsPy7-a4_ABurtGuvfhW4XkOinXU';

var TX_TAB_NAME       = 'תנועות';
var ORDERS_TAB_NAME   = 'הזמנות';
var COMPANY_TAB_NAME  = 'מאזן חברה';
var PERSONAL_TAB_NAME = 'מאזן אישי';

// Company dashboard row layout — adjust if your sheet's row numbers
// differ. (Steven's matches the Kesefle template.)
var COMPANY_ROWS = {
  revenue:      6,
  orderCount:   7,
  rawMaterials: 8,
  marketing:    9,
  shipping:     10,
  ops:          11,
  totalExp:     12,
  netProfit:    13,
  marginPct:    14,
};

// Business expense bucket → list of substring matchers (case-sensitive
// because Hebrew). A row is bucketed into the FIRST matcher that hits.
var BUSINESS_BUCKETS = {
  rawMaterials: ['חומרי גלם'],
  marketing:    ['שיווק'],
  shipping:     ['משלוח', 'אריזה'],
  ops:          ['תפעולי', 'יועצים', 'תוכנות', 'ציוד עסקי', 'מיסים'],
};

// ─── No need to edit below this line ────────────────────────────────────

function _openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act) return act;
  } catch (_) {}
  if (!SHEET_ID_TO_FIX || SHEET_ID_TO_FIX.indexOf('<') >= 0) {
    throw new Error('SHEET_ID_TO_FIX is not set.');
  }
  return SpreadsheetApp.openById(SHEET_ID_TO_FIX);
}

// Convert col A label "אוכל בחוץ" → simple substring matcher. Strip any
// leading emoji + whitespace + Hebrew direction marks.
function _cleanLabel_(s) {
  return String(s || '')
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*/u, '')
    .replace(/[‎‏‪-‮]/g, '')
    .trim();
}

// Read תנועות into in-memory rows. Each row: { date, monthKey, amount,
// category, subcategory, descr, source, status }. Skips header + blanks.
function _readTx_(ss) {
  var sheet = ss.getSheetByName(TX_TAB_NAME);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Read cols A..I = 9 cols. We don't need J+ if present.
  var values = sheet.getRange(2, 1, lastRow - 1, Math.min(9, sheet.getLastColumn())).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var amount = Number(r[2]) || 0;
    if (!amount) continue;
    var monthKey = String(r[1] || '').trim();
    // If col B is empty but col A has a date, derive YYYY-MM from it.
    if (!monthKey && r[0]) {
      try {
        var d = new Date(r[0]);
        if (!isNaN(d)) monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      } catch (_) {}
    }
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) continue;
    out.push({
      date: r[0],
      monthKey: monthKey,
      amount: amount,
      category: String(r[3] || '').trim(),
      subcategory: String(r[4] || '').trim(),
      descr: String(r[5] || ''),
      source: String(r[6] || ''),
      status: r[7],
    });
  }
  return out;
}

// Read הזמנות into in-memory rows. Each row: { date, monthKey, salePrice }.
function _readOrders_(ss) {
  var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, Math.min(8, sheet.getLastColumn())).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    var price = Number(r[3]) || 0;
    if (!price) continue;
    var date = r[0];
    if (!date) continue;
    var d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d)) continue;
    var monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    out.push({ date: d, monthKey: monthKey, salePrice: price });
  }
  return out;
}

// Which business bucket does (category, subcategory) fall into? Returns
// one of 'rawMaterials' | 'marketing' | 'shipping' | 'ops' | null.
function _classifyBusinessRow_(category, subcategory) {
  if (String(category).trim() !== 'עסק') return null;
  var sub = String(subcategory || '').trim();
  if (!sub) return null;
  // Walk buckets in order; first match wins.
  var keys = ['rawMaterials', 'marketing', 'shipping', 'ops'];
  for (var i = 0; i < keys.length; i++) {
    var matchers = BUSINESS_BUCKETS[keys[i]];
    for (var j = 0; j < matchers.length; j++) {
      if (sub.indexOf(matchers[j]) >= 0) return keys[i];
    }
  }
  return null;
}

// Build a {monthKey -> {bucket -> sum}} map from תנועות rows.
function _aggregateBusiness_(txRows) {
  var out = {};
  for (var i = 0; i < txRows.length; i++) {
    var r = txRows[i];
    var bucket = _classifyBusinessRow_(r.category, r.subcategory);
    if (!bucket) continue;
    if (!out[r.monthKey]) out[r.monthKey] = { rawMaterials: 0, marketing: 0, shipping: 0, ops: 0, revenue: 0, revenueCount: 0 };
    out[r.monthKey][bucket] += r.amount;
  }
  // Add revenue (col D=עסק AND col E contains "מחזור") + revenue count.
  for (var k = 0; k < txRows.length; k++) {
    var rr = txRows[k];
    if (String(rr.category).trim() !== 'עסק') continue;
    if (String(rr.subcategory || '').indexOf('מחזור') < 0) continue;
    if (!out[rr.monthKey]) out[rr.monthKey] = { rawMaterials: 0, marketing: 0, shipping: 0, ops: 0, revenue: 0, revenueCount: 0 };
    out[rr.monthKey].revenue += rr.amount;
    out[rr.monthKey].revenueCount += 1;
  }
  return out;
}

// Add orders to the same map.
function _addOrdersToAggregate_(agg, orderRows) {
  for (var i = 0; i < orderRows.length; i++) {
    var r = orderRows[i];
    if (!agg[r.monthKey]) agg[r.monthKey] = { rawMaterials: 0, marketing: 0, shipping: 0, ops: 0, revenue: 0, revenueCount: 0 };
    agg[r.monthKey].revenue += r.salePrice;
    agg[r.monthKey].revenueCount += 1;
  }
  return agg;
}

function recomputeCompanyDashboard() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(COMPANY_TAB_NAME);
  if (!sheet) { Logger.log('FAIL: no ' + COMPANY_TAB_NAME + ' tab'); return; }
  // Year cell: $B$4 in Kesefle template; fall back to current year.
  var year = sheet.getRange('B4').getValue();
  if (!year || isNaN(year)) year = new Date().getFullYear();
  year = Number(year);

  var txRows = _readTx_(ss);
  var orderRows = _readOrders_(ss);
  var agg = _aggregateBusiness_(txRows);
  agg = _addOrdersToAggregate_(agg, orderRows);

  // For each row, build [annualSum, jan..dec] = 13 values.
  function rowFor(bucket) {
    var months = [];
    var annual = 0;
    for (var m = 1; m <= 12; m++) {
      var key = year + '-' + String(m).padStart(2, '0');
      var v = (agg[key] && agg[key][bucket]) || 0;
      months.push(v);
      annual += v;
    }
    return [annual].concat(months);
  }
  function countRow() {
    var months = [];
    var annual = 0;
    for (var m = 1; m <= 12; m++) {
      var key = year + '-' + String(m).padStart(2, '0');
      var v = (agg[key] && agg[key].revenueCount) || 0;
      months.push(v);
      annual += v;
    }
    return [annual].concat(months);
  }

  // Write rows 6, 7, 8, 9, 10, 11. Skip the section-header writes that
  // are NOT data rows (the col A label stays as-is).
  var writes = [
    [COMPANY_ROWS.revenue,      rowFor('revenue')],
    [COMPANY_ROWS.orderCount,   countRow()],
    [COMPANY_ROWS.rawMaterials, rowFor('rawMaterials')],
    [COMPANY_ROWS.marketing,    rowFor('marketing')],
    [COMPANY_ROWS.shipping,     rowFor('shipping')],
    [COMPANY_ROWS.ops,          rowFor('ops')],
  ];
  for (var i = 0; i < writes.length; i++) {
    var rowNum = writes[i][0];
    var data = writes[i][1]; // [annual, jan..dec] = 13 numbers
    sheet.getRange(rowNum, 2, 1, 13).setValues([data]);
  }

  // Compute totals (row 12) + net profit (row 13) + margin% (row 14)
  // from the rows we just wrote, so they're always consistent.
  var months13 = sheet.getRange(COMPANY_ROWS.revenue, 2, 6, 13).getValues();
  // months13[0] = revenue row, [1] = orderCount, [2..5] = expense rows.
  var totals = [];
  var nets = [];
  var margins = [];
  for (var col = 0; col < 13; col++) {
    var rev = Number(months13[0][col]) || 0;
    var raw = Number(months13[2][col]) || 0;
    var mkt = Number(months13[3][col]) || 0;
    var ship= Number(months13[4][col]) || 0;
    var ops = Number(months13[5][col]) || 0;
    var totExp = raw + mkt + ship + ops;
    totals.push(totExp);
    nets.push(rev - totExp);
    margins.push(rev > 0 ? (rev - totExp) / rev : 0);
  }
  sheet.getRange(COMPANY_ROWS.totalExp,  2, 1, 13).setValues([totals]);
  sheet.getRange(COMPANY_ROWS.netProfit, 2, 1, 13).setValues([nets]);
  // Margin row gets percent format.
  sheet.getRange(COMPANY_ROWS.marginPct, 2, 1, 13).setValues([margins]);
  try { sheet.getRange(COMPANY_ROWS.marginPct, 2, 1, 13).setNumberFormat('0.0%'); } catch (_) {}

  Logger.log('OK: מאזן חברה — recomputed year=' + year + ' from ' + txRows.length + ' תנועות + ' + orderRows.length + ' הזמנות rows.');
}

function recomputePersonalDashboard() {
  var ss = _openSheet_();
  var sheet = ss.getSheetByName(PERSONAL_TAB_NAME);
  if (!sheet) { Logger.log('FAIL: no ' + PERSONAL_TAB_NAME + ' tab'); return; }
  var year = sheet.getRange('B2').getValue();
  if (!year || isNaN(year)) year = new Date().getFullYear();
  year = Number(year);

  var txRows = _readTx_(ss);
  // Read col A labels for rows up to row 60 (template caps at 58).
  var lastRow = Math.min(sheet.getLastRow(), 60);
  if (lastRow < 5) return;
  var labels = sheet.getRange(1, 1, lastRow, 1).getValues();

  var updates = 0;
  for (var r = 4; r < labels.length; r++) {  // row 5+ in 1-indexed
    var rowNum = r + 1;
    var rawLabel = String(labels[r][0] || '').trim();
    if (!rawLabel) continue;
    if (/^סה/.test(rawLabel)) continue;                          // totals
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(rawLabel)) continue;  // section header w/ emoji
    var cleanLabel = _cleanLabel_(rawLabel);
    if (cleanLabel.length < 2) continue;

    var monthly = [0,0,0,0,0,0,0,0,0,0,0,0];
    for (var i = 0; i < txRows.length; i++) {
      var tx = txRows[i];
      // Sub must CONTAIN the row label (case-sensitive Hebrew is fine).
      if (String(tx.subcategory || '').indexOf(cleanLabel) < 0) continue;
      // Year + month parse
      var parts = tx.monthKey.split('-');
      if (parts.length !== 2) continue;
      if (Number(parts[0]) !== year) continue;
      var mIdx = Number(parts[1]) - 1;
      if (mIdx < 0 || mIdx > 11) continue;
      monthly[mIdx] += tx.amount;
    }
    var annual = 0;
    for (var k = 0; k < 12; k++) annual += monthly[k];
    var row13 = [annual].concat(monthly);
    try { sheet.getRange(rowNum, 2, 1, 13).setValues([row13]); updates++; } catch (_e) {}
  }
  Logger.log('OK: מאזן אישי — recomputed ' + updates + ' rows (year=' + year + ').');
}

// One-click runner.
function recomputeAllDashboards() {
  try { recomputeCompanyDashboard(); } catch (e) { Logger.log('company err: ' + e.message + ' @ ' + e.stack); }
  try { recomputePersonalDashboard(); } catch (e) { Logger.log('personal err: ' + e.message + ' @ ' + e.stack); }
  Logger.log('---');
  Logger.log('Both dashboards recomputed. Open the sheet, refresh, check the numbers.');
}

// ─── Diagnostic helpers (optional) ──────────────────────────────────────

// Dump what we see in תנועות so we can compare vs the dashboard claim.
function diagnoseBusinessRows() {
  var ss = _openSheet_();
  var rows = _readTx_(ss);
  var byMonth = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var bucket = _classifyBusinessRow_(r.category, r.subcategory);
    if (!bucket) continue;
    if (!byMonth[r.monthKey]) byMonth[r.monthKey] = { rawMaterials:0, marketing:0, shipping:0, ops:0, samples:{rawMaterials:[],marketing:[],shipping:[],ops:[]} };
    byMonth[r.monthKey][bucket] += r.amount;
    if (byMonth[r.monthKey].samples[bucket].length < 5) {
      byMonth[r.monthKey].samples[bucket].push({ amt: r.amount, sub: r.subcategory, descr: r.descr });
    }
  }
  Logger.log('=== Business buckets by month (from תנועות) ===');
  var keys = Object.keys(byMonth).sort();
  for (var k = 0; k < keys.length; k++) {
    var mk = keys[k];
    var m = byMonth[mk];
    Logger.log(mk + '  raw=₪' + m.rawMaterials + '  mkt=₪' + m.marketing + '  ship=₪' + m.shipping + '  ops=₪' + m.ops);
  }
  Logger.log('=== Samples (first 5 per bucket per month) ===');
  for (var kk = 0; kk < keys.length; kk++) {
    var mk2 = keys[kk];
    var m2 = byMonth[mk2];
    for (var b in m2.samples) {
      if (m2.samples[b].length) {
        Logger.log(mk2 + ' / ' + b + ': ' + JSON.stringify(m2.samples[b]));
      }
    }
  }
}
