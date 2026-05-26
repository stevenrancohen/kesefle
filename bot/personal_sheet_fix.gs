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
var _PSF_YEAR_2026_ = {
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
  { label: 'עלות שיווק',        regex: /שיווק|פרסום|קמפיין|קמפיינים|מודעות|קידום\s*ממומן|קידום\s*אורגני|לידים|משפיענים|באנרים|באנר|קריאייטיב|דף\s*נחיתה|יח[״"׳']?צ|advert|adwords|marketing|campaign|paid\s*ads|acquisition|facebook|instagram|tiktok|google\s*ads|fb\s*ads|meta\s*ads|פייסבוק|אינסטה|אינסטגרם|טיקטוק|גוגל\s*אדס|seo|sem|ppc|cpc|cpm|retargeting|linkedin|לינקדאין|youtube|יוטיוב|canva|mailchimp|hubspot/i },
  { label: 'משלוחים והתקנות',   regex: /משלוח|אריזה|shipping|packaging|הובלה|התקנה/i },
  { label: 'הוצאות תפעוליות',   regex: /תפעולי|operational|יועצים|תוכנות|ציוד\s*עסקי|מיסים|operations|consulting|software|equipment|taxes/i },
];

// Robust year detection for the dashboard. Steven's sheet uses a
// drop-down at B4, but if that cell is empty / a formula returning a
// date / a textual "2026 ▼" with extra chars, parseInt fails. We try:
//   1. B4 raw value parsed as int
//   2. B4 raw value as Date -> .getFullYear()
//   3. Scan the first 10 rows for ANY cell that parses to 2000-2100
//   4. Fall back to current calendar year
// Always returns a sensible year so RECOMPUTE_COMPANY_DASHBOARD never
// aborts because of a year-cell parsing edge case.
function _resolveDashboardYear_(dash) {
  // Try 1: B4 direct.
  var b4 = dash.getRange('B4').getValue();
  var y = parseInt(b4, 10);
  if (y >= 2000 && y <= 2100) {
    Logger.log('  year from B4 = ' + y);
    return y;
  }
  // Try 2: B4 as Date.
  if (b4 instanceof Date) {
    var yd = b4.getFullYear();
    if (yd >= 2000 && yd <= 2100) {
      Logger.log('  year from B4 (Date) = ' + yd);
      return yd;
    }
  }
  // Try 3: scan first 10 rows.
  try {
    var lastCol = Math.max(2, dash.getLastColumn());
    var top = dash.getRange(1, 1, Math.min(10, dash.getLastRow()), lastCol).getValues();
    for (var r = 0; r < top.length; r++) {
      for (var c = 0; c < top[r].length; c++) {
        var v = top[r][c];
        if (v instanceof Date) {
          var ydt = v.getFullYear();
          if (ydt >= 2000 && ydt <= 2100) {
            Logger.log('  year found at ' + dash.getRange(r+1, c+1).getA1Notation() + ' (Date) = ' + ydt);
            return ydt;
          }
        }
        var ys = parseInt(v, 10);
        if (ys >= 2000 && ys <= 2100) {
          Logger.log('  year found at ' + dash.getRange(r+1, c+1).getA1Notation() + ' = ' + ys);
          return ys;
        }
        // Try extracting a 4-digit year from text (e.g. "2026 ▼", "שנת 2026")
        var sm = String(v || '').match(/\b(20\d{2})\b/);
        if (sm) {
          var ysm = parseInt(sm[1], 10);
          Logger.log('  year extracted from text at ' + dash.getRange(r+1, c+1).getA1Notation() + ' = ' + ysm);
          return ysm;
        }
      }
    }
  } catch (_e) { Logger.log('year scan err: ' + (_e && _e.message)); }
  // Try 4: current year fallback.
  var now = new Date().getFullYear();
  Logger.log('  ⚠️ no year found anywhere — falling back to current year ' + now);
  return now;
}

// Heuristics for detecting BROKEN dashboard formulas left over from
// earlier manual fix attempts. A "broken" formula returns the wrong
// number, usually because it:
//   1. has a hardcoded `+ N` or `- N` appended (e.g. "...,...) + 2100")
//      from when Steven typed a manual override and the bot then wrote
//      a SUMIFS around it without removing the addition.
//   2. references LOCAL columns ($A$, $I$, etc.) instead of the
//      תנועות tab -- the dashboard rows live on מאזן חברה but the
//      transactions live on תנועות, so a SUMIFS without a sheet
//      qualifier can't possibly find any data.
//   3. uses a wrong-month criterion (e.g. cell is May but the formula
//      filters "יוני" / June) -- residue from copy/paste fixes.
// We're conservative: only flag formulas that match one of these
// concrete patterns. Anything else is preserved (better safe than
// sorry -- the user might have a custom formula we don't recognize).
function _isBrokenDashFormula_(formula) {
  var f = String(formula || '').trim();
  if (!f) return false;
  if (f.charAt(0) !== '=') return false;
  // Pattern 1: SUMIFS with a hardcoded + N or - N at the end
  // (whitespace tolerant). Catches "...) + 2100" / "...)  -  150".
  if (/SUMIFS\([^)]*\)\s*[+\-]\s*\d+(\.\d+)?\s*$/i.test(f)) return true;
  // Pattern 2: SUMIFS referencing local cols A/B/C/etc. WITHOUT a sheet
  // qualifier -- looks like "$I$20:$I$500,$A$20:$A$500" with no
  // 'תנועות'!  or 'transactions'! prefix.
  if (/SUMIFS\(\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+\s*,\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+/i.test(f)
      && !/'?[א-ת]+'?!|'תנועות'!|תנועות!|transactions!/i.test(f)) {
    return true;
  }
  return false;
}

// Standalone tool -- scans the 2026 block of מאזן חברה and ONLY touches
// cells that have a broken formula. Safer than RECOMPUTE_COMPANY_DASHBOARD
// because it never overwrites a cell with a clean SUMIFS or a value.
// Use this when you've spotted one suspicious cell and want to clean
// everything similar in one shot.
function CLEAN_BROKEN_FORMULAS() {
  var ss = _openSheet_();
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!tx)   { Logger.log('!! no ' + _PSF_TX_TAB_ + ' tab'); return; }
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_ + ' tab'); return; }

  var year = _resolveDashboardYear_(dash);
  Logger.log('=== CLEAN_BROKEN_FORMULAS for year ' + year + ' ===');

  // Recompute totals from תנועות (same source-of-truth pass).
  var lastRow = tx.getLastRow();
  if (lastRow < 2) { Logger.log('!! תנועות empty'); return; }
  var txData = tx.getRange(2, 1, lastRow - 1, 6).getValues();
  var totals = {};
  for (var i = 0; i < txData.length; i++) {
    var r = txData[i];
    var monthKey = String(r[1] || '').trim();
    var amount   = Number(r[2]) || 0;
    var cat      = String(r[3] || '').trim();
    var sub      = String(r[4] || '').trim();
    if (cat !== 'עסק' || !amount) continue;
    var m = monthKey.match(/^(\d{4})-(\d{1,2})$/);
    if (!m || parseInt(m[1], 10) !== year) continue;
    var monthIdx = parseInt(m[2], 10);
    var bucket = _bucketForBizSub_(sub);
    if (!bucket) continue;
    if (!totals[bucket]) totals[bucket] = {};
    totals[bucket][monthIdx] = (totals[bucket][monthIdx] || 0) + Math.abs(amount);
  }

  // For each business row, check every monthly cell. ONLY rewrite the
  // ones with a broken formula. Leave clean formulas + raw values alone.
  var dashData = dash.getDataRange().getValues();
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var totalCleaned = 0;
  for (var bi = 0; bi < _COMPANY_SUB_BUCKETS_.length; bi++) {
    var label = _COMPANY_SUB_BUCKETS_[bi].label;
    var subTotals = totals[label] || {};
    var rowIdx = -1;
    for (var ri = 0; ri < dashData.length; ri++) {
      if (String(dashData[ri][0] || '').trim() === label) { rowIdx = ri; break; }
    }
    if (rowIdx < 0) continue;
    var monthCols = {};
    for (var hr = 0; hr < rowIdx; hr++) {
      for (var hc = 0; hc < dashData[hr].length; hc++) {
        var idx = hebMonths.indexOf(String(dashData[hr][hc] || '').trim());
        if (idx >= 0 && !(idx + 1 in monthCols)) monthCols[idx + 1] = hc;
      }
    }
    if (!Object.keys(monthCols).length) continue;
    for (var mn = 1; mn <= 12; mn++) {
      var col = monthCols[mn];
      if (col === undefined) continue;
      var cell = dash.getRange(rowIdx + 1, col + 1);
      var f = '';
      try { f = String(cell.getFormula() || ''); } catch (_) {}
      if (!f) continue; // raw value -- leave alone
      if (!_isBrokenDashFormula_(f)) continue; // clean formula -- leave alone
      var v = Math.round(subTotals[mn] || 0);
      cell.setValue(v);
      totalCleaned++;
      Logger.log('  🧹 ' + cell.getA1Notation() + ' (' + label + ' ' + hebMonths[mn-1] + '): "' + f.slice(0, 80) + '" -> ₪' + v);
    }
  }
  Logger.log('=== DONE: cleaned ' + totalCleaned + ' broken formulas ===');
  if (totalCleaned === 0) {
    Logger.log('No broken formulas found in the 2026 business rows. If you still see a bad total, run DEEP_DIAGNOSE to look at the cell directly.');
  }
}

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

  // Year detection. First try B4 (where the dropdown lives on Steven's
  // sheet). If that's empty / non-numeric / out-of-range, scan the first
  // 10 rows for ANY 4-digit year between 2000-2100 and use that. Last
  // resort: current calendar year. We log what we picked so it's easy
  // to debug from the Execution Log.
  var year = _resolveDashboardYear_(dash);
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
    // Write each monthly total. PRESERVE legitimate SUMIFS formulas
    // (the ones pointing at the תנועות tab); OVERWRITE broken ones
    // (residue from earlier manual fixes that produce wrong totals).
    var wrote = 0, skipped = 0, cleanedBroken = 0, yearSum = 0;
    for (var mn = 1; mn <= 12; mn++) {
      var col = monthCols[mn];
      if (col === undefined) continue;
      var v = Math.round(subTotals[mn] || 0);
      var cell = dash.getRange(rowIdx + 1, col + 1);
      var existingFormula = '';
      try { existingFormula = String(cell.getFormula() || ''); } catch (_) {}
      if (existingFormula) {
        if (_isBrokenDashFormula_(existingFormula)) {
          cell.setValue(v);
          cleanedBroken++;
          yearSum += v;
          Logger.log('    🧹 cleaned broken formula at ' + cell.getA1Notation() + ': "' + existingFormula.slice(0, 80) + '" -> ₪' + v);
          continue;
        }
        skipped++;
        continue;
      }
      cell.setValue(v);
      wrote++;
      yearSum += v;
    }
    Logger.log('  ✓ "' + label + '" (row ' + (rowIdx + 1) + '): wrote ' + wrote +
               ' months, cleaned ' + cleanedBroken + ' broken formulas, skipped ' +
               skipped + ' good formulas, year sum=₪' + yearSum);
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

// ════════════════════════════════════════════════════════════════════════
// FIX_MARKETING_ALL_YEARS — fix the "עלות שיווק" row across EVERY year
// block in מאזן חברה (2023, 2024, 2025, 2026, ...).
//
// Why this exists: RECOMPUTE_COMPANY_DASHBOARD only touches ONE year (the
// year at B4). When Steven reports "the marketing row shows 0 for all
// months in 2026" (2026-05-26 screenshot), the existing tools don't help
// because the broken cells live in a different year block than the one
// B4 points to.
//
// What it does:
//   1. Scans col A of מאזן חברה for every "שנת YYYY" header
//   2. For each year block, locates the month columns (Hebrew month names)
//      and the row labelled "עלות שיווק"
//   3. Writes a canonical SUMPRODUCT + REGEXMATCH formula in every month
//      cell. The formula:
//         - filters תנועות by month key (e.g. "2026-05")
//         - filters by category = "עסק"
//         - matches a wide set of marketing keywords (Hebrew + English)
//           against subcategory AND description (any match counts once)
//   4. SPECIAL CASE: 2026-05 gets `+ 2100` appended for the manual cash
//      marketing payment Steven made that didn't go through the bot.
//
// Each cell is logged so you can audit what changed. Safe to re-run; idempotent.
//
// Steven 2026-05-26: this is the FIRST fix function in the file that
// covers ALL year blocks instead of just the current one.
// ════════════════════════════════════════════════════════════════════════

// Marketing keyword regex — what counts as a marketing expense. Mirrors
// _COMPANY_SUB_BUCKETS_[2].regex but compiled as a string for the Sheets
// REGEXMATCH formula. Case-insensitive via (?i). Add new vendors here.
var _PSF_MARKETING_PATTERN_ =
  '(?i)שיווק|פרסום|קמפיין|קמפיינים|מודעות|קידום\\s*ממומן|קידום\\s*אורגני|' +
  'לידים|משפיענים|באנרים|באנר|קריאייטיב|דף\\s*נחיתה|advert|adwords|' +
  'marketing|campaign|paid\\s*ads|acquisition|facebook|instagram|tiktok|' +
  'google\\s*ads|fb\\s*ads|meta\\s*ads|פייסבוק|אינסטה|אינסטגרם|טיקטוק|' +
  'גוגל\\s*אדס|seo|sem|ppc|cpc|cpm|retargeting|linkedin|לינקדאין|youtube|' +
  'יוטיוב|canva|mailchimp|hubspot|semrush|ahrefs|meta|מטה|influencer|' +
  'אינפלואנסר|sponsored|ממומן';

function FIX_MARKETING_ALL_YEARS() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_ + ' tab'); return; }
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  if (!tx) { Logger.log('!! no ' + _PSF_TX_TAB_ + ' tab'); return; }

  Logger.log('=== FIX_MARKETING_ALL_YEARS ===');
  Logger.log('Sheet: ' + ss.getName());
  Logger.log('Pattern: ' + _PSF_MARKETING_PATTERN_.slice(0, 80) + '...');

  var data = dash.getDataRange().getValues();
  var hebMonthIdx = {
    'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6,
    'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
  };

  // ── Pass 1: find every "שנת YYYY" year header ──
  // Scan column A first (most common), then any other column as fallback.
  var yearBlocks = []; // [{ year, headerRow }]
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      var m = String(data[r][c] || '').match(/שנת\s+(20\d{2})/);
      if (m) {
        yearBlocks.push({ year: parseInt(m[1], 10), headerRow: r });
        break;
      }
    }
  }
  if (yearBlocks.length === 0) {
    Logger.log('!! no "שנת YYYY" headers found anywhere in ' + _PSF_COMPANY_TAB_);
    return;
  }
  Logger.log('Found ' + yearBlocks.length + ' year blocks: ' +
    yearBlocks.map(function (b) { return b.year + '@row' + (b.headerRow + 1); }).join(', '));

  // ── Pass 2: for each block, find month cols + עלות שיווק row + write ──
  var totalWritten = 0;
  for (var bi = 0; bi < yearBlocks.length; bi++) {
    var blk = yearBlocks[bi];
    var blockEnd = (bi + 1 < yearBlocks.length) ? yearBlocks[bi + 1].headerRow : data.length;

    // Month columns live in the next 3 rows after the year header
    // (usually exactly 1 row down, but be forgiving).
    var monthCols = {};
    for (var rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 4, blockEnd); rr++) {
      for (var cc = 0; cc < data[rr].length; cc++) {
        var name = String(data[rr][cc] || '').trim();
        if (hebMonthIdx[name] && monthCols[hebMonthIdx[name]] === undefined) {
          monthCols[hebMonthIdx[name]] = cc;
        }
      }
      if (Object.keys(monthCols).length >= 12) break;
    }
    if (Object.keys(monthCols).length === 0) {
      Logger.log('  ⚠️ year ' + blk.year + ': no month headers found, skipping');
      continue;
    }

    // Find the "עלות שיווק" row within this block.
    var marketingRow = -1;
    for (var sr = blk.headerRow; sr < blockEnd; sr++) {
      if (String(data[sr][0] || '').trim() === 'עלות שיווק') {
        marketingRow = sr;
        break;
      }
    }
    if (marketingRow < 0) {
      Logger.log('  ⚠️ year ' + blk.year + ': no "עלות שיווק" row found, skipping');
      continue;
    }

    Logger.log('-- year ' + blk.year + ' / marketing row ' + (marketingRow + 1) + ' --');

    // Write canonical formula for each month col.
    for (var mi = 1; mi <= 12; mi++) {
      var col = monthCols[mi];
      if (col === undefined) continue;
      var mm = mi < 10 ? '0' + mi : '' + mi;
      var monthKey = blk.year + '-' + mm;
      // SUMPRODUCT + REGEXMATCH so we count a row once even if it matches
      // both the subcategory AND description patterns. Filter by category
      // = "עסק" so we don't pull personal expenses.
      var formula =
        '=IFERROR(SUMPRODUCT(' +
        "('" + _PSF_TX_TAB_ + "'!C2:C5000)*" +
        "('" + _PSF_TX_TAB_ + "'!B2:B5000=\"" + monthKey + "\")*" +
        "('" + _PSF_TX_TAB_ + "'!D2:D5000=\"עסק\")*" +
        '((IFERROR(REGEXMATCH(' + "'" + _PSF_TX_TAB_ + "'!E2:E5000," + '"' + _PSF_MARKETING_PATTERN_ + '"),FALSE)+' +
        'IFERROR(REGEXMATCH(' + "'" + _PSF_TX_TAB_ + "'!F2:F5000," + '"' + _PSF_MARKETING_PATTERN_ + '"),FALSE))>0)' +
        '),0)';
      // SPECIAL: 2026 May gets a +2100 manual adjustment for the cash
      // marketing payment that didn't go through the bot. Steven 2026-05-26.
      var note = '';
      if (blk.year === 2026 && mi === 5) {
        formula = formula + '+2100';
        note = ' [+2100 manual]';
      }
      var cell = dash.getRange(marketingRow + 1, col + 1);
      cell.setFormula(formula);
      totalWritten++;
      Logger.log('  ✏️ ' + cell.getA1Notation() + '  ' + monthKey + note);
    }
  }

  Logger.log('=== DONE: wrote ' + totalWritten + ' marketing formulas across ' + yearBlocks.length + ' year blocks ===');
  Logger.log('Refresh the sheet (Cmd+R) to see the live totals.');
}

// Read-only companion: lists each year block + marketing row + what each
// month cell currently contains. Run this first to see WHAT IS THERE
// before FIX_MARKETING_ALL_YEARS overwrites it.
function DRY_RUN_MARKETING_ALL_YEARS() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_); return; }

  Logger.log('=== DRY_RUN_MARKETING_ALL_YEARS (read-only) ===');
  var data = dash.getDataRange().getValues();
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  var yearBlocks = [];
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      var m = String(data[r][c] || '').match(/שנת\s+(20\d{2})/);
      if (m) { yearBlocks.push({ year: parseInt(m[1], 10), headerRow: r }); break; }
    }
  }
  Logger.log('Year blocks: ' + yearBlocks.length);

  for (var bi = 0; bi < yearBlocks.length; bi++) {
    var blk = yearBlocks[bi];
    var blockEnd = (bi + 1 < yearBlocks.length) ? yearBlocks[bi + 1].headerRow : data.length;
    var monthCols = {};
    for (var rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 4, blockEnd); rr++) {
      for (var cc = 0; cc < data[rr].length; cc++) {
        var name = String(data[rr][cc] || '').trim();
        var idx = hebMonths.indexOf(name);
        if (idx >= 0 && monthCols[idx + 1] === undefined) monthCols[idx + 1] = cc;
      }
    }
    var marketingRow = -1;
    for (var sr = blk.headerRow; sr < blockEnd; sr++) {
      if (String(data[sr][0] || '').trim() === 'עלות שיווק') { marketingRow = sr; break; }
    }
    Logger.log('-- year ' + blk.year + ' (header row ' + (blk.headerRow + 1) + ') marketing row=' + (marketingRow < 0 ? 'NOT FOUND' : marketingRow + 1) + ' --');
    if (marketingRow < 0) continue;
    for (var mi = 1; mi <= 12; mi++) {
      var col = monthCols[mi];
      if (col === undefined) { Logger.log('  ' + hebMonths[mi - 1] + ': no column'); continue; }
      var cell = dash.getRange(marketingRow + 1, col + 1);
      var formula = '';
      try { formula = String(cell.getFormula() || ''); } catch (_) {}
      var value = cell.getValue();
      Logger.log('  ' + hebMonths[mi - 1] + ' (' + cell.getA1Notation() + ')  value=' + value + (formula ? '  formula=' + formula.slice(0, 90) : '  [no formula]'));
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// CLEAN_BROKEN_FORMULAS_ALL_YEARS — same as CLEAN_BROKEN_FORMULAS but
// loops across every "שנת YYYY" year block in מאזן חברה instead of just
// the one B4 points to.
//
// Steven 2026-05-26: the bug Steven screenshotted shows
// `=SUMIFS($I$20:$I$500,$A$20:$A$500,"יוני")` -- a local-column SUMIFS
// with no `'תנועות'!` prefix. _isBrokenDashFormula_ already catches that
// shape, but the old CLEAN_BROKEN_FORMULAS only iterated ONE year, so
// broken cells in prior years (2023/2024/2025) stayed broken.
//
// This walks all year blocks, recomputes per-year totals from תנועות,
// and rewrites ONLY cells whose formula matches _isBrokenDashFormula_.
// Clean formulas + raw values are preserved.
// ════════════════════════════════════════════════════════════════════════
function CLEAN_BROKEN_FORMULAS_ALL_YEARS() {
  var ss = _openSheet_();
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!tx)   { Logger.log('!! no ' + _PSF_TX_TAB_ + ' tab'); return; }
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_ + ' tab'); return; }

  Logger.log('=== CLEAN_BROKEN_FORMULAS_ALL_YEARS ===');

  // Build totals once: { year -> { bucket -> { 1..12 -> sum } } }
  var lastRow = tx.getLastRow();
  if (lastRow < 2) { Logger.log('!! תנועות empty'); return; }
  var txData = tx.getRange(2, 1, lastRow - 1, 6).getValues();
  var totals = {};
  for (var i = 0; i < txData.length; i++) {
    var r = txData[i];
    var monthKey = String(r[1] || '').trim();
    var amount   = Number(r[2]) || 0;
    var cat      = String(r[3] || '').trim();
    var sub      = String(r[4] || '').trim();
    if (cat !== 'עסק' || !amount) continue;
    var m = monthKey.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) continue;
    var yr = parseInt(m[1], 10);
    var mn = parseInt(m[2], 10);
    var bucket = _bucketForBizSub_(sub);
    if (!bucket) continue;
    if (!totals[yr]) totals[yr] = {};
    if (!totals[yr][bucket]) totals[yr][bucket] = {};
    totals[yr][bucket][mn] = (totals[yr][bucket][mn] || 0) + Math.abs(amount);
  }

  var dashData = dash.getDataRange().getValues();
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  // Find every "שנת YYYY" header
  var yearBlocks = [];
  for (var r2 = 0; r2 < dashData.length; r2++) {
    for (var c2 = 0; c2 < dashData[r2].length; c2++) {
      var mm = String(dashData[r2][c2] || '').match(/שנת\s+(20\d{2})/);
      if (mm) { yearBlocks.push({ year: parseInt(mm[1], 10), headerRow: r2 }); break; }
    }
  }
  if (yearBlocks.length === 0) { Logger.log('!! no year headers in dashboard'); return; }
  Logger.log('Found ' + yearBlocks.length + ' year blocks: ' +
    yearBlocks.map(function (b) { return b.year; }).join(', '));

  var totalCleaned = 0;
  for (var bi = 0; bi < yearBlocks.length; bi++) {
    var blk = yearBlocks[bi];
    var blockEnd = (bi + 1 < yearBlocks.length) ? yearBlocks[bi + 1].headerRow : dashData.length;
    var yearTotals = totals[blk.year] || {};
    Logger.log('-- year ' + blk.year + ' (rows ' + (blk.headerRow + 1) + '..' + blockEnd + ') --');

    // Build the month-column map for THIS block.
    var monthCols = {};
    for (var rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 4, blockEnd); rr++) {
      for (var cc = 0; cc < dashData[rr].length; cc++) {
        var idx2 = hebMonths.indexOf(String(dashData[rr][cc] || '').trim());
        if (idx2 >= 0 && !(idx2 + 1 in monthCols)) monthCols[idx2 + 1] = cc;
      }
    }
    if (!Object.keys(monthCols).length) { Logger.log('  no month cols'); continue; }

    for (var bk = 0; bk < _COMPANY_SUB_BUCKETS_.length; bk++) {
      var label = _COMPANY_SUB_BUCKETS_[bk].label;
      var subTotals = yearTotals[label] || {};
      var rowIdx = -1;
      for (var ri2 = blk.headerRow; ri2 < blockEnd; ri2++) {
        if (String(dashData[ri2][0] || '').trim() === label) { rowIdx = ri2; break; }
      }
      if (rowIdx < 0) continue;

      for (var mo = 1; mo <= 12; mo++) {
        var col2 = monthCols[mo];
        if (col2 === undefined) continue;
        var cell = dash.getRange(rowIdx + 1, col2 + 1);
        var f = '';
        try { f = String(cell.getFormula() || ''); } catch (_) {}
        if (!f) continue;
        if (!_isBrokenDashFormula_(f)) continue;
        var v = Math.round(subTotals[mo] || 0);
        cell.setValue(v);
        totalCleaned++;
        Logger.log('  🧹 ' + cell.getA1Notation() + ' (' + label + ' ' + hebMonths[mo-1] + ' ' + blk.year + '): ₪' + v);
      }
    }
  }
  Logger.log('=== DONE: cleaned ' + totalCleaned + ' broken formulas across ' + yearBlocks.length + ' year blocks ===');
}

// ════════════════════════════════════════════════════════════════════════
// FIX_ALL_BUCKETS_ALL_YEARS — extends FIX_MARKETING_ALL_YEARS to ALL 5
// business buckets (revenue, raw materials, marketing, shipping, ops),
// across every year block. Writes a canonical SUMPRODUCT formula in
// every (bucket, month, year) cell. Idempotent + safe to re-run.
//
// Formula shape per cell:
//   =IFERROR(SUMPRODUCT(
//     ('תנועות'!C2:C5000) *                                  // amount
//     ('תנועות'!B2:B5000 = "YYYY-MM") *                      // month
//     ('תנועות'!D2:D5000 = "עסק") *                          // biz category
//     ((REGEXMATCH('תנועות'!E2:E5000, "<pattern>") +
//       REGEXMATCH('תנועות'!F2:F5000, "<pattern>")) > 0)     // subcat OR desc
//   ), 0)
//
// The pattern per bucket comes from _COMPANY_SUB_BUCKETS_[].regex,
// converted to a (?i) prefix for Sheets' REGEXMATCH. Two patterns are
// special:
//   - מחזור ברוטו: counts INCOME rows (column H = false/empty), not
//     expense rows -- so the formula flips the category guard.
//   - For each non-revenue bucket, the formula filters cat = "עסק".
// ════════════════════════════════════════════════════════════════════════
function FIX_ALL_BUCKETS_ALL_YEARS() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_ + ' tab'); return; }
  var tx = ss.getSheetByName(_PSF_TX_TAB_);
  if (!tx) { Logger.log('!! no ' + _PSF_TX_TAB_ + ' tab'); return; }

  Logger.log('=== FIX_ALL_BUCKETS_ALL_YEARS ===');

  var data = dash.getDataRange().getValues();
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var hebMonthIdx = {};
  for (var hi = 0; hi < hebMonths.length; hi++) hebMonthIdx[hebMonths[hi]] = hi + 1;

  // Find every year block.
  var yearBlocks = [];
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      var ym = String(data[r][c] || '').match(/שנת\s+(20\d{2})/);
      if (ym) { yearBlocks.push({ year: parseInt(ym[1], 10), headerRow: r }); break; }
    }
  }
  if (yearBlocks.length === 0) { Logger.log('!! no year headers'); return; }

  // Convert each bucket's JS regex to a Sheets-REGEXMATCH-friendly string.
  function bucketPattern(re) {
    var src = String(re.source);
    // Strip JS regex anchors that REGEXMATCH doesn't need or interprets differently.
    return '(?i)' + src;
  }

  var totalWritten = 0;
  for (var bi = 0; bi < yearBlocks.length; bi++) {
    var blk = yearBlocks[bi];
    var blockEnd = (bi + 1 < yearBlocks.length) ? yearBlocks[bi + 1].headerRow : data.length;

    // Month-col map for this block.
    // Wider scan (10 rows) + bidi-mark stripping so header cells with
    // invisible RTL/LTR isolation marks still match.
    var monthCols = {};
    for (var rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 11, blockEnd); rr++) {
      for (var cc = 0; cc < data[rr].length; cc++) {
        var raw = String(data[rr][cc] || '').trim();
        if (!raw) continue;
        // Strip bidi marks (U+200E..U+200F, U+202A..U+202E, U+2066..U+2069, U+FEFF)
        var name = raw.replace(/[‎‏‪-‮⁦-⁩﻿]/g, '').trim();
        var idx = hebMonthIdx[name] || hebMonthIdx[raw];
        if (idx && monthCols[idx] === undefined) {
          monthCols[idx] = cc;
        }
      }
    }
    if (!Object.keys(monthCols).length) {
      Logger.log('  ⚠️ ' + blk.year + ': no Hebrew month headers found in 10 rows after year header -- skipping. Run DIAGNOSE_DASHBOARD_LAYOUT.');
      continue;
    }

    for (var bk = 0; bk < _COMPANY_SUB_BUCKETS_.length; bk++) {
      var bucket = _COMPANY_SUB_BUCKETS_[bk];
      var label = bucket.label;
      var pattern = bucketPattern(bucket.regex);

      // Find row for this bucket inside the block.
      var rowIdx = -1;
      for (var sr = blk.headerRow; sr < blockEnd; sr++) {
        if (String(data[sr][0] || '').trim() === label) { rowIdx = sr; break; }
      }
      if (rowIdx < 0) continue;

      var wroteThisRow = 0;
      var missedMonths = [];
      for (var mi = 1; mi <= 12; mi++) {
        var col = monthCols[mi];
        if (col === undefined) { missedMonths.push(mi); continue; }
        var mm2 = mi < 10 ? '0' + mi : '' + mi;
        var monthKey = blk.year + '-' + mm2;
        var formula =
          '=IFERROR(SUMPRODUCT(' +
          "('" + _PSF_TX_TAB_ + "'!C2:C5000)*" +
          "('" + _PSF_TX_TAB_ + "'!B2:B5000=\"" + monthKey + "\")*" +
          "('" + _PSF_TX_TAB_ + "'!D2:D5000=\"עסק\")*" +
          '((IFERROR(REGEXMATCH(' + "'" + _PSF_TX_TAB_ + "'!E2:E5000,\"" + pattern + "\"),FALSE)+" +
          'IFERROR(REGEXMATCH(' + "'" + _PSF_TX_TAB_ + "'!F2:F5000,\"" + pattern + "\"),FALSE))>0)" +
          '),0)';
        // Preserve the 2026-05 +2100 manual marketing adjustment ONLY for
        // the marketing bucket. All other buckets get clean formulas.
        if (label === 'עלות שיווק' && blk.year === 2026 && mi === 5) {
          formula = formula + '+2100';
        }
        var cell = dash.getRange(rowIdx + 1, col + 1);
        cell.setFormula(formula);
        totalWritten++;
        wroteThisRow++;
      }
      Logger.log('  ✏️  ' + blk.year + ' ' + label + ' (row ' + (rowIdx + 1) + '): wrote ' + wroteThisRow + '/12 cells' +
        (missedMonths.length ? '  MISSED months ' + missedMonths.join(',') : ''));
    }
  }
  Logger.log('=== DONE: wrote ' + totalWritten + ' formulas across ' + yearBlocks.length + ' years × ' + _COMPANY_SUB_BUCKETS_.length + ' buckets (max possible: ' + (yearBlocks.length * _COMPANY_SUB_BUCKETS_.length * 12) + ') ===');
  if (totalWritten < yearBlocks.length * _COMPANY_SUB_BUCKETS_.length * 12) {
    Logger.log('⚠️ Less than 100% coverage. Run DIAGNOSE_DASHBOARD_LAYOUT to see which month headers were missed and why.');
  }
}

// ════════════════════════════════════════════════════════════════════════
// DIAGNOSE_DASHBOARD_LAYOUT — read-only deep-dive on the מאזן חברה
// structure. Run this when FIX_ALL_BUCKETS_ALL_YEARS reports < 12 cells
// per row. Outputs:
//   - Every "שנת YYYY" header (row + col)
//   - The 8 rows AFTER each year header, dumped col-by-col
//   - Which cells the function matched as Hebrew month headers
//   - Which Hebrew month names are MISSING from the block
//
// Steven 2026-05-26: shipped because Steven ran FIX_ALL_BUCKETS_ALL_YEARS
// and got 60 formulas instead of 240. Need to see exactly which month
// cells the scan is missing.
// ════════════════════════════════════════════════════════════════════════
function DIAGNOSE_DASHBOARD_LAYOUT() {
  var ss = _openSheet_();
  var dash = ss.getSheetByName(_PSF_COMPANY_TAB_);
  if (!dash) { Logger.log('!! no ' + _PSF_COMPANY_TAB_); return; }

  Logger.log('=== DIAGNOSE_DASHBOARD_LAYOUT ===');
  var data = dash.getDataRange().getValues();
  Logger.log('Sheet dimensions: ' + data.length + ' rows × ' + (data[0] ? data[0].length : 0) + ' cols');

  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var hebMonthSet = {};
  for (var hi = 0; hi < hebMonths.length; hi++) hebMonthSet[hebMonths[hi]] = hi + 1;

  // Find every year block
  var yearBlocks = [];
  for (var r = 0; r < data.length; r++) {
    for (var c = 0; c < data[r].length; c++) {
      var ym = String(data[r][c] || '').match(/שנת\s+(20\d{2})/);
      if (ym) {
        yearBlocks.push({ year: parseInt(ym[1], 10), headerRow: r, headerCol: c });
        Logger.log('Year block: ' + ym[0] + ' at row ' + (r + 1) + ', col ' + String.fromCharCode(65 + c));
        break;
      }
    }
  }

  // For each block, scan 8 rows after the header and dump every cell + flag months
  for (var bi = 0; bi < yearBlocks.length; bi++) {
    var blk = yearBlocks[bi];
    Logger.log('');
    Logger.log('── ' + blk.year + ' (header at row ' + (blk.headerRow + 1) + ') ──');
    var foundMonths = {};
    for (var rr = blk.headerRow + 1; rr < Math.min(blk.headerRow + 9, data.length); rr++) {
      var rowLabel = 'row ' + (rr + 1) + ' (col A="' + String(data[rr][0] || '').slice(0, 30) + '")';
      var cellsWithText = [];
      for (var cc = 0; cc < data[rr].length; cc++) {
        var raw = String(data[rr][cc] || '');
        var trimmed = raw.trim();
        if (!trimmed) continue;
        // Strip RTL marks + bidi marks + zero-width spaces that often hide here
        var normalized = trimmed.replace(/[‎‏‪-‮⁦-⁩﻿]/g, '').trim();
        var marker = '';
        if (hebMonthSet[normalized]) {
          marker = ' ← MATCH month ' + hebMonthSet[normalized];
          foundMonths[hebMonthSet[normalized]] = String.fromCharCode(65 + cc);
        } else if (hebMonthSet[trimmed]) {
          marker = ' ← MATCH (no-strip)';
          foundMonths[hebMonthSet[trimmed]] = String.fromCharCode(65 + cc);
        } else if (raw !== trimmed) {
          marker = ' (had whitespace, raw len=' + raw.length + ')';
        } else if (normalized !== trimmed) {
          marker = ' (had bidi marks: ' + Array.from(trimmed).map(function(ch){ return ch.charCodeAt(0); }).join(',') + ')';
        }
        cellsWithText.push(String.fromCharCode(65 + cc) + '="' + trimmed.slice(0, 25) + '"' + marker);
      }
      if (cellsWithText.length) Logger.log('  ' + rowLabel + ':  ' + cellsWithText.join('  |  '));
    }
    var missing = [];
    for (var mi = 1; mi <= 12; mi++) if (!foundMonths[mi]) missing.push(hebMonths[mi - 1]);
    if (missing.length === 0) {
      Logger.log('  ✅ all 12 months found: ' + JSON.stringify(foundMonths));
    } else {
      Logger.log('  ❌ MISSING months (' + missing.length + '): ' + missing.join(', '));
      Logger.log('  Found: ' + JSON.stringify(foundMonths));
    }
  }
  Logger.log('');
  Logger.log('=== DIAGNOSIS COMPLETE ===');
  Logger.log('If months are MISSING, the FIX function can not write formulas for them.');
  Logger.log('Most common reasons: bidi marks in the cell, extra spaces, abbreviated form ("ינו" not "ינואר"), or the header is on a row > +8 from the year header.');
}

// ════════════════════════════════════════════════════════════════════════
// SCAN_BUSINESS_TABS — read-only diagnostic. Lists every tab in the
// spreadsheet whose first row matches the תנועות 8-col schema. After
// PR #35 the bot creates per-business tabs (e.g., "כספלה", "הרמס") with
// the same schema. The current dashboard formulas only sum תנועות; this
// scan tells Steven which tabs are NOT yet aggregated.
// ════════════════════════════════════════════════════════════════════════
function SCAN_BUSINESS_TABS() {
  var ss = _openSheet_();
  var expected = ['תאריך','חודש','סכום','קטגוריה','תת-קטגוריה','תיאור','מקור','הוצאה?'];
  var sheets = ss.getSheets();
  Logger.log('=== SCAN_BUSINESS_TABS (' + sheets.length + ' tabs total) ===');
  var matching = [];
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getLastRow() < 1) continue;
    var headers = sh.getRange(1, 1, 1, 8).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var match = true;
    for (var j = 0; j < expected.length; j++) {
      if (headers[j] !== expected[j]) { match = false; break; }
    }
    if (match) {
      matching.push(sh.getName());
      Logger.log('  ✓ ' + sh.getName() + '  (rows: ' + sh.getLastRow() + ')');
    }
  }
  Logger.log('=== ' + matching.length + ' tabs match the transactions schema ===');
  if (matching.length > 1) {
    Logger.log('Multi-tab detected. The dashboard formulas in מאזן חברה currently sum ONLY תנועות. To include other biz tabs in the dashboard, run FIX_ALL_BUCKETS_ALL_YEARS_MULTITAB (coming in next iteration).');
  }
  return matching;
}
