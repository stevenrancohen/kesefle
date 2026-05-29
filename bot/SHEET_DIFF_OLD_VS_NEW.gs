// ============================================================
// bot/SHEET_DIFF_OLD_VS_NEW.gs
// Paste-once Apps Script: diff OLD vs NEW Kesefle sheets.
// READ-ONLY (no writes to existing tabs). Creates one hidden
// tab `_DIFF_REPORT_` in the NEW sheet with the diff markdown.
//
// Steven 2026-05-29: built to investigate "why do OLD and NEW
// show so many differences in the dashboard?" The migration
// (PR #120) brought 614 transactions + 28 orders, but anything
// Steven typed in OLD AFTER the migration date didn't move.
//
// All Hebrew strings use \u05XX escapes per the
// sheet-hebrew-encoding-safe-script skill.
//
// Usage:
//   1. _SDOLD_SELF_TEST_HEBREW_()    -- verify Hebrew decoding
//   2. DRY_RUN_DIFF_SHEETS()         -- print report to Logger only
//   3. APPLY_DIFF_TO_TAB()           -- create/update _DIFF_REPORT_
//      tab in NEW sheet with the report
// ============================================================

var _SDOLD_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _SDOLD_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// Tab names (Hebrew, \u05XX escaped)
var _SDOLD_TABS_ = {
  // תנועות = תנועות
  tx: 'תנועות',
  // הזמנות = הזמנות
  orders: 'הזמנות',
  // מאזן אישי = מאזן אישי
  personalDash: 'מאזן אישי',
  // מאזן חברה = מאזן חברה
  companyDash: 'מאזן חברה',
};

// דוח השוואה = דוח השוואה
var _SDOLD_REPORT_TAB_ = '_DIFF_REPORT_';

function _SDOLD_SELF_TEST_HEBREW_() {
  Logger.log('=== Self-test: Hebrew tab names ===');
  Logger.log('tx          = ' + _SDOLD_TABS_.tx);
  Logger.log('orders      = ' + _SDOLD_TABS_.orders);
  Logger.log('personalDash= ' + _SDOLD_TABS_.personalDash);
  Logger.log('companyDash = ' + _SDOLD_TABS_.companyDash);
  Logger.log('Expected:');
  Logger.log('  tx          = ' + 'תנועות');
  Logger.log('  orders      = ' + 'הזמנות');
  Logger.log('  personalDash= ' + 'מאזן אישי');
  Logger.log('  companyDash = ' + 'מאזן חברה');
}

function DRY_RUN_DIFF_SHEETS() {
  var report = _SDOLD_buildReport_();
  Logger.log(report);
  Logger.log('\n=== DRY-RUN COMPLETE -- NO TAB CREATED ===');
  Logger.log('To save report to a tab, run APPLY_DIFF_TO_TAB()');
  return report;
}

function APPLY_DIFF_TO_TAB() {
  var report = _SDOLD_buildReport_();
  var newSS = SpreadsheetApp.openById(_SDOLD_NEW_SHEET_ID_);
  var sh = newSS.getSheetByName(_SDOLD_REPORT_TAB_);
  if (!sh) {
    sh = newSS.insertSheet(_SDOLD_REPORT_TAB_);
    sh.hideSheet();
  } else {
    // Only clear OUR tab (never any data tab)
    sh.clear();
  }
  var lines = report.split('\n');
  var values = lines.map(function (l) { return [l]; });
  sh.getRange(1, 1, values.length, 1).setValues(values);
  sh.setColumnWidth(1, 1200);
  Logger.log('Wrote diff report to ' + _SDOLD_REPORT_TAB_ + ' (' + lines.length + ' lines)');
  Logger.log('Tab is HIDDEN. Unhide via View > Hidden sheets.');
}

function _SDOLD_buildReport_() {
  var out = [];
  out.push('# OLD vs NEW Kesefle Sheet Diff');
  out.push('Generated: ' + new Date().toISOString());
  out.push('OLD: ' + _SDOLD_OLD_SHEET_ID_);
  out.push('NEW: ' + _SDOLD_NEW_SHEET_ID_);
  out.push('');

  var oldSS, newSS;
  try { oldSS = SpreadsheetApp.openById(_SDOLD_OLD_SHEET_ID_); }
  catch (e) { out.push('FATAL: cannot open OLD: ' + e.message); return out.join('\n'); }
  try { newSS = SpreadsheetApp.openById(_SDOLD_NEW_SHEET_ID_); }
  catch (e) { out.push('FATAL: cannot open NEW: ' + e.message); return out.join('\n'); }

  // ───── Section 1: tab inventory ─────
  out.push('## 1. Tab Inventory');
  out.push('');
  var oldTabs = oldSS.getSheets().map(function (s) { return s.getName(); });
  var newTabs = newSS.getSheets().map(function (s) { return s.getName(); });
  out.push('OLD has ' + oldTabs.length + ' tabs, NEW has ' + newTabs.length + ' tabs');
  out.push('');
  out.push('| Tab | OLD | NEW |');
  out.push('|---|---|---|');
  var allTabs = {};
  oldTabs.forEach(function (t) { allTabs[t] = (allTabs[t] || 0) | 1; });
  newTabs.forEach(function (t) { allTabs[t] = (allTabs[t] || 0) | 2; });
  Object.keys(allTabs).sort().forEach(function (t) {
    var b = allTabs[t];
    out.push('| ' + t + ' | ' + (b & 1 ? '✓' : ' ') + ' | ' + (b & 2 ? '✓' : ' ') + ' |');
  });
  out.push('');

  // ───── Section 2: row count comparison ─────
  out.push('## 2. Row Counts per Common Tab');
  out.push('');
  out.push('| Tab | OLD rows | NEW rows | Parity % |');
  out.push('|---|---|---|---|');
  Object.keys(_SDOLD_TABS_).forEach(function (key) {
    var tab = _SDOLD_TABS_[key];
    var o = oldSS.getSheetByName(tab);
    var n = newSS.getSheetByName(tab);
    var oRows = o ? o.getLastRow() : 0;
    var nRows = n ? n.getLastRow() : 0;
    var parity = oRows > 0 ? Math.round((nRows / oRows) * 100) : 'n/a';
    out.push('| ' + tab + ' | ' + oRows + ' | ' + nRows + ' | ' + parity + '% |');
  });
  out.push('');

  // ───── Section 3: תנועות col E top categories ─────
  out.push('## 3. תנועות Top Categories (col E)');
  out.push('');
  ['OLD', 'NEW'].forEach(function (which) {
    var ss = which === 'OLD' ? oldSS : newSS;
    var sh = ss.getSheetByName(_SDOLD_TABS_.tx);
    if (!sh || sh.getLastRow() < 2) {
      out.push('### ' + which);
      out.push('(no data)');
      out.push('');
      return;
    }
    var lr = Math.min(sh.getLastRow(), 5000);
    var col = sh.getRange(2, 5, lr - 1, 1).getValues();
    var counts = {};
    col.forEach(function (r) {
      var v = String(r[0] || '').trim();
      if (v) counts[v] = (counts[v] || 0) + 1;
    });
    var entries = Object.keys(counts).map(function (k) { return [k, counts[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    out.push('### ' + which + ' (top 15)');
    entries.slice(0, 15).forEach(function (e) {
      out.push('  ' + e[1] + ' × ' + e[0]);
    });
    out.push('');
  });

  // ───── Section 4: dashboard row labels (col A) ─────
  out.push('## 4. Dashboard Row Labels (col A)');
  ['personalDash', 'companyDash'].forEach(function (k) {
    var tab = _SDOLD_TABS_[k];
    out.push('');
    out.push('### ' + tab);
    out.push('');
    var oSh = oldSS.getSheetByName(tab);
    var nSh = newSS.getSheetByName(tab);
    if (!oSh || !nSh) {
      out.push('(one of the dashboards is missing)');
      return;
    }
    var oLabels = oSh.getRange(1, 1, oSh.getLastRow(), 1).getValues().map(function (r) { return String(r[0] || '').trim(); }).filter(Boolean);
    var nLabels = nSh.getRange(1, 1, nSh.getLastRow(), 1).getValues().map(function (r) { return String(r[0] || '').trim(); }).filter(Boolean);
    var oSet = {}; oLabels.forEach(function (l) { oSet[l] = true; });
    var nSet = {}; nLabels.forEach(function (l) { nSet[l] = true; });
    var onlyOld = oLabels.filter(function (l) { return !nSet[l]; });
    var onlyNew = nLabels.filter(function (l) { return !oSet[l]; });
    out.push('OLD labels: ' + oLabels.length + '  /  NEW labels: ' + nLabels.length);
    out.push('');
    out.push('**' + onlyOld.length + ' labels in OLD that are NOT in NEW** (Steven typed them in OLD, never migrated):');
    onlyOld.slice(0, 50).forEach(function (l) { out.push('  - ' + l); });
    if (onlyOld.length > 50) out.push('  ... (+' + (onlyOld.length - 50) + ' more)');
    out.push('');
    out.push('**' + onlyNew.length + ' labels in NEW that are NOT in OLD** (template additions in NEW):');
    onlyNew.slice(0, 50).forEach(function (l) { out.push('  - ' + l); });
    if (onlyNew.length > 50) out.push('  ... (+' + (onlyNew.length - 50) + ' more)');
  });
  out.push('');

  // ───── Section 5: per-year row counts in תנועות ─────
  out.push('## 5. תנועות Rows Per Year (col B "YYYY-MM" parse)');
  out.push('');
  out.push('| Year | OLD | NEW |');
  out.push('|---|---|---|');
  var yearStats = { OLD: {}, NEW: {} };
  [['OLD', oldSS], ['NEW', newSS]].forEach(function (pair) {
    var which = pair[0], ss = pair[1];
    var sh = ss.getSheetByName(_SDOLD_TABS_.tx);
    if (!sh || sh.getLastRow() < 2) return;
    var lr = Math.min(sh.getLastRow(), 5000);
    var col = sh.getRange(2, 2, lr - 1, 1).getValues();
    col.forEach(function (r) {
      var v = String(r[0] || '');
      var m = v.match(/^(\d{4})/);
      if (m) yearStats[which][m[1]] = (yearStats[which][m[1]] || 0) + 1;
    });
  });
  var years = {};
  Object.keys(yearStats.OLD).forEach(function (y) { years[y] = true; });
  Object.keys(yearStats.NEW).forEach(function (y) { years[y] = true; });
  Object.keys(years).sort().forEach(function (y) {
    out.push('| ' + y + ' | ' + (yearStats.OLD[y] || 0) + ' | ' + (yearStats.NEW[y] || 0) + ' |');
  });
  out.push('');

  // ───── Section 6: takeaways ─────
  out.push('## 6. Takeaways');
  out.push('');
  out.push('- The migration on ~2026-05-XX (PR #120) brought 614 transactions + 28 orders.');
  out.push('- Anything typed in OLD AFTER that date will appear here as a NEW-side gap.');
  out.push('- Labels in OLD but not in NEW (section 4) are categories Steven typed manually');
  out.push('  that the migration did not promote into the template — fix-up candidates.');
  out.push('- Year parity < 100% means rows missing in NEW for that year.');
  out.push('');

  return out.join('\n');
}
