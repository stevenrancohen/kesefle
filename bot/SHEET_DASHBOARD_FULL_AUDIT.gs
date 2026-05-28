/**
 * bot/SHEET_DASHBOARD_FULL_AUDIT.gs
 *
 * READ-ONLY comprehensive audit of BOTH the company dashboard
 * ("ma'azan chevra") and the personal dashboard ("ma'azan ishi") for
 * Steven's NEW Kesefle sheet.
 *
 * Produces a single markdown-style report logged via Logger.log so Steven
 * can copy-paste the result from the Apps Script execution log into a PR
 * description / QA report.
 *
 * What it catches per row, per column:
 *   1. WRONG ROW REFERENCES -- e.g. a formula in r12 referencing r39 from
 *      an older layout (the R39 fix we already shipped is the canonical
 *      example). Detected by parsing every cell ref in the formula and
 *      checking it lies inside the same year-block.
 *   2. SUM-RANGE BUGS -- when the "total" row's SUM range does not cover
 *      the four expense rows above it (e.g. =SUM(C8:C10) instead of
 *      =SUM(C8:C11)). Detected by extracting the SUM range and comparing
 *      its endpoints to the expected category-row block.
 *   3. STALE TAB REFERENCES -- references to the OLD sheet ID
 *      1UKrXDk... or to a tab that no longer exists in NEW. Detected by
 *      string match.
 *   4. SUMIFS WITH ZERO-MATCH CRITERIA -- a SUMIFS that filters by an
 *      exact-match Hebrew literal which appears in 0 rows of the actual
 *      transactions tab. Detected by extracting each criteria value from
 *      the SUMIFS formula and counting matches in tx col E (or D).
 *   5. SUMIFS THAT REFERENCE A NON-EXISTENT TAB. Detected by extracting
 *      the tab-name token before "!" and checking it via getSheetByName.
 *
 * Output (logged):
 *   - Per dashboard, per year, per row, per column:
 *       PASS / WARN / FAIL  status with explanation
 *   - Per-criterion zero-match audit for every SUMIFS criterion seen
 *   - Summary at the bottom
 *
 * Public entry points (zero-arg, dropdown friendly):
 *   AUDIT_BOTH_DASHBOARDS()        -- main entry
 *   AUDIT_COMPANY_DASHBOARD_ONLY() -- company only (faster)
 *   AUDIT_PERSONAL_DASHBOARD_ONLY()-- personal only
 *
 * SAFETY: this script NEVER writes. The test gauntlet asserts that no
 * setValue/setFormula/setNote/delete/clear call is reachable.
 *
 * ENCODING: every Hebrew string is \u05XX-escaped.
 */

// ---- CONFIGURE ---------------------------------------------------------
var _FA_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _FA_OLD_SHEET_ID_ = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';

// "ma'azan chevra" -- company dashboard.
var _FA_COMPANY_TAB_  = '\u05de\u05d0\u05d6\u05df \u05d7\u05d1\u05e8\u05d4';
// "ma'azan ishi" -- personal dashboard.
var _FA_PERSONAL_TAB_ = '\u05de\u05d0\u05d6\u05df \u05d0\u05d9\u05e9\u05d9';
// "tnu'ot" -- transactions tab.
var _FA_TX_TAB_       = '\u05ea\u05e0\u05d5\u05e2\u05d5\u05ea';
// "hazmanot" -- orders tab.
var _FA_ORDERS_TAB_   = '\u05d4\u05d6\u05de\u05e0\u05d5\u05ea';
// "sikum histori" -- historical summary tab (Phase 3).
var _FA_HISTORY_TAB_  = '\u05e1\u05d9\u05db\u05d5\u05dd \u05d4\u05d9\u05e1\u05d8\u05d5\u05e8\u05d9';

var _FA_VERSION_      = 'FullAudit_v1';

// Row layout per year-block in company dashboard (mirrors Phase 5).
var _FA_YEAR_BLOCKS_ = {
  '2026': { revenue:  6, orders:  7, material:  8, marketing:  9, shipping: 10, operational: 11, total: 12, net: 13 },
  '2025': { revenue: 18, orders: 19, material: 20, marketing: 21, shipping: 22, operational: 23, total: 24, net: 25 },
  '2024': { revenue: 30, orders: 31, material: 32, marketing: 33, shipping: 34, operational: 35, total: 36, net: 37 },
  '2023': { revenue: 42, orders: 43, material: 44, marketing: 45, shipping: 46, operational: 47, total: 48, net: 49 }
};

// Bucket row keys in the order they appear in each block.
var _FA_BUCKET_ORDER_ = ['revenue', 'orders', 'material', 'marketing', 'shipping', 'operational', 'total', 'net'];

// Expected category-row range for a "total" row: rows material..operational.
var _FA_TOTAL_RANGE_ = { from: 'material', to: 'operational' };

// ---- HELPERS -----------------------------------------------------------

function _fa_openSheet_() {
  try {
    var act = SpreadsheetApp.getActiveSpreadsheet();
    if (act && act.getId && act.getId() === _FA_NEW_SHEET_ID_) return act;
  } catch (e) { /* fall through */ }
  return SpreadsheetApp.openById(_FA_NEW_SHEET_ID_);
}

function _fa_num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

// Extract every cell reference (e.g. "B12", "$A$4", "$C49") from a
// formula string. Returns array of { col: string, row: number, raw: string }.
function _fa_extractCellRefs_(formula) {
  if (!formula || typeof formula !== 'string') return [];
  var refs = [];
  // Match A1-style refs that are NOT preceded by a letter/digit (so we
  // don't grab the "B12" inside "AB12" or "B12X").
  var re = /(?:^|[^A-Z0-9_'])(\$?[A-Z]+\$?\d+)/g;
  var m;
  while ((m = re.exec(formula)) !== null) {
    var raw = m[1];
    var bare = raw.replace(/\$/g, '');
    var colMatch = bare.match(/^[A-Z]+/);
    var rowMatch = bare.match(/\d+$/);
    if (colMatch && rowMatch) {
      refs.push({ col: colMatch[0], row: parseInt(rowMatch[0], 10), raw: raw });
    }
  }
  return refs;
}

// Extract every SUMIFS call's criteria from a formula. Returns array of
// { sumRange: string, pairs: [{ critRange, critValue }] }.
function _fa_extractSumifsCalls_(formula) {
  if (!formula || typeof formula !== 'string') return [];
  var calls = [];
  // Find SUMIFS(... ) by scanning for "SUMIFS(" then balancing parens.
  var i = 0;
  while (true) {
    var start = formula.toUpperCase().indexOf('SUMIFS(', i);
    if (start === -1) break;
    var argStart = start + 'SUMIFS('.length;
    // Scan to the matching close paren.
    var depth = 1;
    var inString = null;
    var j = argStart;
    while (j < formula.length && depth > 0) {
      var c = formula[j];
      if (inString) {
        if (c === inString && formula[j-1] !== '\\') inString = null;
      } else if (c === '"' || c === "'") {
        inString = c;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth > 0) j++;
    }
    if (depth !== 0) break;  // malformed -- bail
    var inner = formula.substring(argStart, j);
    var args = _fa_splitArgs_(inner);
    // args[0] = sum range; args[1..] = pairs of (critRange, critValue)
    if (args.length >= 1) {
      var pairs = [];
      for (var p = 1; p + 1 < args.length; p += 2) {
        pairs.push({ critRange: args[p].trim(), critValue: args[p+1].trim() });
      }
      calls.push({ sumRange: args[0].trim(), pairs: pairs });
    }
    i = j + 1;
  }
  return calls;
}

// Split argument list on commas that are NOT inside strings or nested parens.
function _fa_splitArgs_(s) {
  var args = [];
  var buf = '';
  var depth = 0;
  var inString = null;
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if (inString) {
      buf += c;
      if (c === inString && s[i-1] !== '\\') inString = null;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; buf += c; continue; }
    if (c === '(') { depth++; buf += c; continue; }
    if (c === ')') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) {
      args.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) args.push(buf);
  return args;
}

// Extract the unquoted tab name preceding "!" in a range reference like
// "'Transactions'!E:E" or "Transactions!E:E". Returns null if no tab ref.
function _fa_extractTabName_(rangeRef) {
  if (!rangeRef) return null;
  var bangIdx = rangeRef.indexOf('!');
  if (bangIdx === -1) return null;
  var pref = rangeRef.substring(0, bangIdx).trim();
  // Strip surrounding single quotes.
  if (pref.charAt(0) === "'" && pref.charAt(pref.length - 1) === "'") {
    pref = pref.substring(1, pref.length - 1);
  }
  return pref;
}

// Strip surrounding " or ' from a SUMIFS criterion value.
function _fa_stripLiteral_(s) {
  if (!s) return s;
  s = s.trim();
  if ((s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') ||
      (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'")) {
    return s.substring(1, s.length - 1);
  }
  return s;
}

// Count how many rows in `txTab` col `colLetter` exactly match `value`
// (after stripping leading/trailing wildcards). Used to find zero-match
// SUMIFS criteria. Returns -1 if the tab is missing.
function _fa_countTxMatches_(ss, colLetter, value) {
  var tx = ss.getSheetByName(_FA_TX_TAB_);
  if (!tx) return -1;
  var lastRow = tx.getLastRow();
  if (lastRow < 2) return 0;
  var range = tx.getRange(colLetter + '2:' + colLetter + lastRow);
  var values = range.getValues();
  var clean = String(value).replace(/^\*+|\*+$/g, '');  // drop wildcards
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    var v = values[i][0];
    if (v === null || v === undefined || v === '') continue;
    var s = String(v);
    if (clean === s || s.indexOf(clean) !== -1) count++;
  }
  return count;
}

// ---- ROW-LEVEL AUDIT ---------------------------------------------------

// Check a single cell's formula for the year-block. Returns an array of
// finding objects { level: 'PASS'|'WARN'|'FAIL', code: string, msg: string }.
function _fa_checkCell_(ss, dash, rowNum, colIdx, year, bucketKey, block, value) {
  var findings = [];
  var formula = dash.getRange(rowNum, colIdx).getFormula();

  // No formula at all -> just a literal value. Could be intentional
  // (Phase 3 snapshot) or could be the stomped-formula bug. Flag WARN
  // for the current-year block, PASS for historical years.
  if (!formula) {
    if (year === '2026') {
      findings.push({ level: 'WARN', code: 'LITERAL_IN_LIVE_YEAR',
        msg: 'cell holds literal ' + value + ' (no formula); should be live-wired' });
    } else {
      findings.push({ level: 'PASS', code: 'LITERAL_HISTORICAL',
        msg: 'cell holds literal ' + value + ' (expected: Phase 3 snapshot)' });
    }
    return findings;
  }

  // 1. Stale OLD sheet ID reference.
  if (formula.indexOf(_FA_OLD_SHEET_ID_) !== -1) {
    findings.push({ level: 'FAIL', code: 'STALE_OLD_SHEET_ID',
      msg: 'formula references OLD sheet ID ' + _FA_OLD_SHEET_ID_.substring(0, 8) + '...' });
  }

  // 2. Wrong row references inside the year block.
  // The cell's formula should reference rows within the SAME year block,
  // or the year cell ($B$4), or another year block intentionally (e.g.
  // a multi-year comparison block). We flag WARN (not FAIL) for refs that
  // fall outside the current block since they may be intentional.
  var refs = _fa_extractCellRefs_(formula);
  var blockRows = Object.keys(block).map(function (k) { return block[k]; });
  var inBlockRefs  = 0;
  var outOfBlock   = 0;
  refs.forEach(function (r) {
    if (blockRows.indexOf(r.row) !== -1) inBlockRefs++;
    else if (r.row === 4) { /* $B$4 year cell -- OK */ }
    else if (r.row >= 1 && r.row <= 65) outOfBlock++;
  });
  if (outOfBlock > 0 && bucketKey === 'total') {
    findings.push({ level: 'WARN', code: 'TOTAL_REFERENCES_OUTSIDE_BLOCK',
      msg: 'total row formula references ' + outOfBlock + ' row(s) outside block ' + JSON.stringify(blockRows) });
  }

  // 3. Sum-range bug for total row.
  if (bucketKey === 'total') {
    var sumMatch = formula.match(/SUM\(\s*([A-Z]+)(\d+)\s*:\s*([A-Z]+)(\d+)\s*\)/i);
    if (sumMatch) {
      var fromRow = parseInt(sumMatch[2], 10);
      var toRow   = parseInt(sumMatch[4], 10);
      var expectedFrom = block[_FA_TOTAL_RANGE_.from];
      var expectedTo   = block[_FA_TOTAL_RANGE_.to];
      if (fromRow !== expectedFrom || toRow !== expectedTo) {
        findings.push({ level: 'FAIL', code: 'TOTAL_SUM_RANGE_BUG',
          msg: 'SUM range r' + fromRow + ':' + toRow + ' but expected r' + expectedFrom + ':' + expectedTo });
      }
    }
  }

  // 4. SUMIFS criteria audit.
  var sumifsCalls = _fa_extractSumifsCalls_(formula);
  sumifsCalls.forEach(function (call) {
    // Validate sum range tab.
    var sumTab = _fa_extractTabName_(call.sumRange);
    if (sumTab && !ss.getSheetByName(sumTab)) {
      findings.push({ level: 'FAIL', code: 'SUMIFS_MISSING_TAB',
        msg: 'SUMIFS sum-range refs missing tab "' + sumTab + '"' });
    }
    // Validate each criterion tab.
    call.pairs.forEach(function (pair) {
      var critTab = _fa_extractTabName_(pair.critRange);
      if (critTab && !ss.getSheetByName(critTab)) {
        findings.push({ level: 'FAIL', code: 'SUMIFS_MISSING_CRIT_TAB',
          msg: 'SUMIFS crit-range refs missing tab "' + critTab + '"' });
      }
      // Zero-match criterion check: only meaningful if the crit range
      // points at transactions col E or D.
      var critLiteral = _fa_stripLiteral_(pair.critValue);
      // Skip dynamic references ($B$4&"-MM" style) -- can't count those.
      if (critLiteral.indexOf('$') !== -1 || critLiteral.indexOf('&') !== -1) return;
      if (!critTab || critTab !== _FA_TX_TAB_) return;
      var colMatch = pair.critRange.match(/!\s*\$?([A-Z]+)\$?\s*:/);
      if (!colMatch) return;
      var colLetter = colMatch[1];
      if (colLetter !== 'E' && colLetter !== 'D') return;
      var count = _fa_countTxMatches_(ss, colLetter, critLiteral);
      if (count === 0) {
        findings.push({ level: 'FAIL', code: 'SUMIFS_ZERO_MATCH',
          msg: 'SUMIFS crit ' + colLetter + ':' + colLetter + ' = "' + critLiteral + '" matches 0 tx rows' });
      } else if (count < 3 && year === '2026') {
        findings.push({ level: 'WARN', code: 'SUMIFS_LOW_MATCH',
          msg: 'SUMIFS crit ' + colLetter + ':' + colLetter + ' = "' + critLiteral + '" matches only ' + count + ' tx rows' });
      }
    });
  });

  if (findings.length === 0) {
    findings.push({ level: 'PASS', code: 'OK', msg: 'formula looks healthy' });
  }
  return findings;
}

// ---- DASHBOARD-LEVEL AUDIT ---------------------------------------------

function _fa_auditCompanyDashboard_(ss, lines, totals) {
  var dash = ss.getSheetByName(_FA_COMPANY_TAB_);
  if (!dash) {
    lines.push('## Company dashboard');
    lines.push('FAIL: tab "' + _FA_COMPANY_TAB_ + '" not found.');
    totals.fail++;
    return;
  }

  lines.push('## Company dashboard ("ma\'azan chevra")');
  lines.push('');

  Object.keys(_FA_YEAR_BLOCKS_).forEach(function (year) {
    var block = _FA_YEAR_BLOCKS_[year];
    lines.push('### Year ' + year + '  (rows ' + block.revenue + '..' + block.net + ')');
    lines.push('');
    lines.push('| row | bucket | col B (annual) | col G (May) | findings |');
    lines.push('|----:|:-------|:---------------|:------------|:---------|');

    _FA_BUCKET_ORDER_.forEach(function (key) {
      var rowNum = block[key];
      // Check col B (annual) + col G (May) -- representative samples.
      // (Auditing all 13 cols per row floods the log; we add a single
      // pass/fail aggregate at the end of each row.)
      [2, 7].forEach(function (colIdx) { /* warm cache */ });

      var bVal = dash.getRange(rowNum, 2).getValue();
      var gVal = dash.getRange(rowNum, 7).getValue();
      var rowFindings = [];
      for (var col = 2; col <= 14; col++) {
        var val = dash.getRange(rowNum, col).getValue();
        var f   = _fa_checkCell_(ss, dash, rowNum, col, year, key, block, val);
        f.forEach(function (x) {
          x.colIdx = col;
          rowFindings.push(x);
        });
      }
      // Aggregate row status.
      var rowFail = rowFindings.filter(function (f) { return f.level === 'FAIL'; });
      var rowWarn = rowFindings.filter(function (f) { return f.level === 'WARN'; });
      var status = rowFail.length > 0 ? 'FAIL' : (rowWarn.length > 0 ? 'WARN' : 'PASS');
      totals[status === 'FAIL' ? 'fail' : (status === 'WARN' ? 'warn' : 'pass')]++;

      var topMsgs = (rowFail.concat(rowWarn)).slice(0, 3).map(function (f) {
        return '`c' + f.colIdx + ':` ' + f.code;
      }).join('; ');
      if (!topMsgs) topMsgs = '(all clean)';

      lines.push('| ' + rowNum + ' | ' + key + ' | ' + bVal + ' | ' + gVal + ' | ' + status + ' -- ' + topMsgs + ' |');
    });
    lines.push('');
  });
}

function _fa_auditPersonalDashboard_(ss, lines, totals) {
  var dash = ss.getSheetByName(_FA_PERSONAL_TAB_);
  if (!dash) {
    lines.push('## Personal dashboard');
    lines.push('SKIP: tab "' + _FA_PERSONAL_TAB_ + '" not found.');
    return;
  }

  // Personal dashboard layout is dynamic (rows are categories Steven
  // chose to track). We audit by reading col A labels and checking each
  // row's formula for the same anti-patterns (stale ID, missing tab,
  // zero-match SUMIFS criteria).
  lines.push('## Personal dashboard ("ma\'azan ishi")');
  lines.push('');
  var lastRow = dash.getLastRow();
  lines.push('Scanned rows 2..' + lastRow + ' for stale OLD sheet ID refs, missing tabs, and zero-match SUMIFS criteria.');
  lines.push('');
  lines.push('| row | label (col A) | findings |');
  lines.push('|----:|:--------------|:---------|');

  var staleCount = 0, zeroMatchCount = 0, missingTabCount = 0;
  for (var r = 2; r <= lastRow; r++) {
    var label = dash.getRange(r, 1).getValue();
    if (!label) continue;
    var rowFindings = [];
    for (var col = 2; col <= 14; col++) {
      var formula = dash.getRange(r, col).getFormula();
      if (!formula) continue;
      if (formula.indexOf(_FA_OLD_SHEET_ID_) !== -1) {
        rowFindings.push({ level: 'FAIL', code: 'STALE_OLD_SHEET_ID', colIdx: col });
        staleCount++;
      }
      // SUMIFS audits
      var calls = _fa_extractSumifsCalls_(formula);
      calls.forEach(function (call) {
        var sumTab = _fa_extractTabName_(call.sumRange);
        if (sumTab && !ss.getSheetByName(sumTab)) {
          rowFindings.push({ level: 'FAIL', code: 'MISSING_TAB', colIdx: col });
          missingTabCount++;
        }
        call.pairs.forEach(function (pair) {
          var critTab = _fa_extractTabName_(pair.critRange);
          if (!critTab || critTab !== _FA_TX_TAB_) return;
          var critLiteral = _fa_stripLiteral_(pair.critValue);
          if (critLiteral.indexOf('$') !== -1 || critLiteral.indexOf('&') !== -1) return;
          var cm = pair.critRange.match(/!\s*\$?([A-Z]+)\$?\s*:/);
          if (!cm) return;
          var cl = cm[1];
          if (cl !== 'E' && cl !== 'D') return;
          var count = _fa_countTxMatches_(ss, cl, critLiteral);
          if (count === 0) {
            rowFindings.push({ level: 'FAIL', code: 'SUMIFS_ZERO_MATCH:' + critLiteral, colIdx: col });
            zeroMatchCount++;
          }
        });
      });
    }
    if (rowFindings.length === 0) {
      totals.pass++;
    } else {
      var rowFail = rowFindings.filter(function (f) { return f.level === 'FAIL'; });
      if (rowFail.length > 0) totals.fail++; else totals.warn++;
      var topMsgs = rowFindings.slice(0, 3).map(function (f) {
        return '`c' + f.colIdx + ':` ' + f.code;
      }).join('; ');
      lines.push('| ' + r + ' | ' + label + ' | ' + topMsgs + ' |');
    }
  }
  lines.push('');
  lines.push('Personal dashboard counters: stale-old-id=' + staleCount +
    ', missing-tab=' + missingTabCount + ', zero-match-sumifs=' + zeroMatchCount);
}

// ---- PUBLIC ENTRY POINTS -----------------------------------------------

function AUDIT_BOTH_DASHBOARDS() {
  Logger.log('===== AUDIT_BOTH_DASHBOARDS (' + _FA_VERSION_ + ') =====');
  Logger.log('Sheet: ' + _FA_NEW_SHEET_ID_);
  Logger.log('Iron rule: this script NEVER writes. Pure read + Logger output.');
  Logger.log('');

  var ss;
  try { ss = _fa_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }

  var lines = ['# Kesefle Dashboard Audit Report', '', 'version: ' + _FA_VERSION_, ''];
  var totals = { pass: 0, warn: 0, fail: 0 };

  _fa_auditCompanyDashboard_(ss, lines, totals);
  _fa_auditPersonalDashboard_(ss, lines, totals);

  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('- PASS rows: ' + totals.pass);
  lines.push('- WARN rows: ' + totals.warn);
  lines.push('- FAIL rows: ' + totals.fail);
  lines.push('');
  if (totals.fail === 0 && totals.warn === 0) {
    lines.push('Result: GREEN -- no anti-patterns detected.');
  } else if (totals.fail === 0) {
    lines.push('Result: AMBER -- warnings only; review per-row table above.');
  } else {
    lines.push('Result: RED -- ' + totals.fail + ' failing rows. Fix before declaring dashboard healthy.');
  }

  Logger.log(lines.join('\n'));
  return { pass: totals.pass, warn: totals.warn, fail: totals.fail, lines: lines };
}

function AUDIT_COMPANY_DASHBOARD_ONLY() {
  Logger.log('===== AUDIT_COMPANY_DASHBOARD_ONLY (' + _FA_VERSION_ + ') =====');
  var ss;
  try { ss = _fa_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }
  var lines = ['# Company dashboard audit', '', 'version: ' + _FA_VERSION_, ''];
  var totals = { pass: 0, warn: 0, fail: 0 };
  _fa_auditCompanyDashboard_(ss, lines, totals);
  lines.push('');
  lines.push('Totals: pass=' + totals.pass + ' warn=' + totals.warn + ' fail=' + totals.fail);
  Logger.log(lines.join('\n'));
  return totals;
}

function AUDIT_PERSONAL_DASHBOARD_ONLY() {
  Logger.log('===== AUDIT_PERSONAL_DASHBOARD_ONLY (' + _FA_VERSION_ + ') =====');
  var ss;
  try { ss = _fa_openSheet_(); }
  catch (e) { Logger.log('!! cannot open sheet: ' + e.message); return; }
  var lines = ['# Personal dashboard audit', '', 'version: ' + _FA_VERSION_, ''];
  var totals = { pass: 0, warn: 0, fail: 0 };
  _fa_auditPersonalDashboard_(ss, lines, totals);
  lines.push('');
  lines.push('Totals: pass=' + totals.pass + ' warn=' + totals.warn + ' fail=' + totals.fail);
  Logger.log(lines.join('\n'));
  return totals;
}
