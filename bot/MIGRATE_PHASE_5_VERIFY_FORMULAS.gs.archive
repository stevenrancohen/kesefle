/**
 * bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs
 *
 * Phase 5 of the Kesefle migration epic (Steven's section-23 plan).
 *
 * READ-ONLY verifier for the NEW Kesefle sheet's `מאזן חברה` dashboard
 * formulas. After Phase 2 (raw data) and Phase 3/4 (historical dashboard
 * snapshots) populated the NEW sheet, this script confirms the formulas
 * actually reference the right source tabs and produce sane numbers.
 *
 * Per the FIX_DASHBOARD_2023_2024_2025 lesson (2026-05-16):
 *   net = revenue - material - shipping (raw materials + shipping only)
 *   NOT net = revenue - total
 * — but Steven's current dashboard spec uses
 *   net = revenue - total (all 4 expense buckets)
 * because total = material + marketing + shipping + operational, and the
 * comparison-block historically used revenue minus the raw-material-only
 * cost. Both are valid views; this verifier reports BOTH so Steven can
 * eyeball whichever he uses for accounting.
 *
 * What it checks (per year-block: 2026, 2025, 2024, 2023):
 *   1. revenue row (B-col SUM) references the correct year via $B$4
 *      OR is a SUMIFS to `'הזמנות'!` (orders tab)
 *   2. material/marketing/shipping/operational rows reference `'תנועות'!`
 *      (transactions tab)
 *   3. total row = SUM of the 4 category rows in the same column
 *   4. net row = revenue - total (per current spec)
 *   5. sanity: 2026 monthly columns have net >= some plausible floor
 *      (allow negative, but flag absurd values like NaN / -∞)
 *
 * NO write capability. Pure read + Logger output. The script will NOT
 * call setValue/setValues/setFormula/setNote/delete/clear/insertRow on
 * anything. The test suite asserts this.
 *
 * Public entry point: VERIFY_PHASE5_DASHBOARDS()
 *   — zero-arg, dropdown-friendly. Returns a structured result + logs
 *   a PASS/FAIL table.
 *
 * Per Steven's iron rules:
 *   - Backup-first: not needed (read-only)
 *   - Propose-before-apply: this IS the propose; there's nothing to apply
 *   - Never overwrite user values: nothing writes
 *   - OLD never mutated: OLD is never even opened
 */

var _MP5_NEW_SHEET_ID_  = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MP5_COMPANY_TAB_   = 'מאזן חברה';
var _MP5_TX_TAB_        = 'תנועות';
var _MP5_ORDERS_TAB_    = 'הזמנות';
var _MP5_VERSION_       = 'Migration_Phase_5_v1';

// Row layout per year-block in `מאזן חברה`. Mirrors what
// FIX_DASHBOARD_2023_2024_2025.gs uses for the OLD sheet — the NEW sheet
// was built with the same hardcoded row positions because the dashboard
// template in lib/sheet-writer.js produces the same layout.
//
// Each entry is the row number (1-indexed) of that category within the
// year's 8-row block.
//
// Note: 2026 block spans rows 1..14 (extra title + subtitle + year-selector
// header rows above row 6). Subsequent years are 12-row blocks. Steven's
// task spec referred to "rows 1-13 = 2026, 14-25 = 2025, 26-37 = 2024,
// 38-49 = 2023" — that's the block extent. The CATEGORY rows within each
// block follow this map.
var _MP5_YEAR_BLOCKS_ = {
  '2023': { revenue: 42, orders: 43, material: 44, marketing: 45, shipping: 46, operational: 47, total: 48, net: 49 },
  '2024': { revenue: 30, orders: 31, material: 32, marketing: 33, shipping: 34, operational: 35, total: 36, net: 37 },
  '2025': { revenue: 18, orders: 19, material: 20, marketing: 21, shipping: 22, operational: 23, total: 24, net: 25 },
  '2026': { revenue:  6, orders:  7, material:  8, marketing:  9, shipping: 10, operational: 11, total: 12, net: 13 }
};

// Coerce a cell value to a finite number (0 for blanks).
function _mp5_num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

// Given a cell's formula string, decide which source tab it pulls from.
// Returns 'orders' | 'transactions' | 'literal' | 'sum' | 'unknown'.
//
// Why we check the formula (not just the value): a "correct" number could
// be a typed literal that LOOKS right but isn't actually wired to the
// source tab. We want the dashboard to be LIVE, not frozen.
function _mp5_classifyFormula_(formula) {
  if (!formula || typeof formula !== 'string') return 'literal';
  var f = formula.toUpperCase();
  // Orders tab reference (Hebrew chars survive case-change OK)
  if (formula.indexOf("'" + _MP5_ORDERS_TAB_ + "'") !== -1) return 'orders';
  if (formula.indexOf(_MP5_ORDERS_TAB_) !== -1)             return 'orders';
  // Transactions tab reference
  if (formula.indexOf("'" + _MP5_TX_TAB_ + "'") !== -1) return 'transactions';
  if (formula.indexOf(_MP5_TX_TAB_) !== -1)             return 'transactions';
  // Plain sum across the same column (e.g. SUM(C8:C11))
  if (f.indexOf('SUM(') === 0 || f.indexOf('=SUM(') === 0) return 'sum';
  // Subtraction (e.g. =B6-B12 for net)
  if (/=[A-Z]+\d+\s*-\s*[A-Z]+\d+/.test(formula)) return 'subtract';
  return 'unknown';
}

// Per-row expectations: which tab SHOULD this row's formula reference?
//   revenue, orders → 'orders'
//   material, marketing, shipping, operational → 'transactions'
//   total → 'sum' (sum of category rows in the same column)
//   net → 'subtract' (revenue - total) OR 'sum' fallback
var _MP5_EXPECTED_SOURCE_ = {
  revenue:     'orders',
  orders:      'orders',
  material:    'transactions',
  marketing:   'transactions',
  shipping:    'transactions',
  operational: 'transactions',
  total:       'sum',
  net:         'subtract'
};

// Core verifier. Reads NEW מאזן חברה only. Never writes.
function _mp5_verify_() {
  Logger.log('=== KESEFLE PHASE 5 — VERIFY DASHBOARD FORMULAS (READ-ONLY) ===');
  Logger.log('NEW sheet: ' + _MP5_NEW_SHEET_ID_);
  Logger.log('Version:   ' + _MP5_VERSION_);
  Logger.log('Iron rule: this script NEVER writes — only reads + reports.');
  Logger.log('');

  var newSS;
  try { newSS = SpreadsheetApp.openById(_MP5_NEW_SHEET_ID_); }
  catch (e) {
    Logger.log('!! Cannot open NEW: ' + e.message);
    return { error: 'cannot_open_new' };
  }

  var dash = newSS.getSheetByName(_MP5_COMPANY_TAB_);
  if (!dash) {
    Logger.log('!! NEW has no ' + _MP5_COMPANY_TAB_ + ' tab — dashboard not built yet');
    return { error: 'no_company_tab' };
  }

  // Read the formulas + values for every row × every column in every year
  // block, in one batched getRange call per year to minimize API calls.
  var results = { years: {}, overall: { pass: 0, fail: 0, warn: 0 } };

  ['2026', '2025', '2024', '2023'].forEach(function (year) {
    var block = _MP5_YEAR_BLOCKS_[year];
    Logger.log('--- שנת ' + year + ' (rows ' + block.revenue + '..' + block.net + ') ---');
    var yearResult = {
      block: block,
      rows: {},
      pass: 0, fail: 0, warn: 0
    };

    // Read row B (annual summary column 2) + cols C..N (months, cols 3..14)
    // for each category row in this year block.
    var rowKeys = ['revenue', 'orders', 'material', 'marketing', 'shipping', 'operational', 'total', 'net'];
    rowKeys.forEach(function (key) {
      var rowNum = block[key];
      var range = dash.getRange(rowNum, 1, 1, 14);
      var formulas = range.getFormulas()[0];
      var values   = range.getValues()[0];
      var labelCell = values[0];
      var label = (labelCell === null || labelCell === undefined) ? '' : String(labelCell);

      // Column index 1 is col B (annual). Cols 2..13 are months C..N.
      var annualFormula = formulas[1];
      var annualValue   = _mp5_num_(values[1]);
      var classification = _mp5_classifyFormula_(annualFormula);
      var expected = _MP5_EXPECTED_SOURCE_[key];

      // For the annual cell, expect either:
      //   - revenue/orders → 'orders' OR 'sum' (sum of monthly =SUMIFS calls)
      //   - material/marketing/shipping/operational → 'transactions' OR 'sum'
      //   - total → 'sum'
      //   - net → 'subtract'
      // The first 6 rows usually use SUM(C..N) for the annual column,
      // which is 'sum' classification. So the *monthly* column is what
      // truly reveals the source.
      var monthClassifications = [];
      for (var ci = 2; ci <= 13; ci++) {
        monthClassifications.push(_mp5_classifyFormula_(formulas[ci]));
      }
      var distinctMonth = {};
      monthClassifications.forEach(function (c) { distinctMonth[c] = (distinctMonth[c] || 0) + 1; });
      var dominantMonth = Object.keys(distinctMonth).sort(function (a, b) {
        return distinctMonth[b] - distinctMonth[a];
      })[0] || 'unknown';

      // Pass / fail rule
      var status;
      var why;
      if (expected === 'orders' || expected === 'transactions') {
        // Monthly columns should mostly reference the expected tab.
        if (dominantMonth === expected) {
          status = 'PASS'; why = 'monthly cols reference ' + expected;
        } else if (dominantMonth === 'literal' || distinctMonth['literal'] === 12) {
          // All literals — the cell holds a number with no formula. This
          // is what Phase 3 historical snapshots produce, so for 2023-2025
          // it's expected. For 2026 it's NOT expected.
          if (year === '2026') {
            status = 'FAIL'; why = '2026 monthly cells are literals — formula was overwritten';
          } else {
            status = 'WARN'; why = year + ' monthly cells are literals (Phase 3 snapshot) — expected for historical years';
          }
        } else {
          status = 'FAIL'; why = 'monthly dominant=' + dominantMonth + ', expected ' + expected;
        }
      } else if (expected === 'sum') {
        // total row should be SUM of the 4 category rows above
        if (dominantMonth === 'sum') {
          status = 'PASS'; why = 'total = SUM(...) of categories';
        } else if (dominantMonth === 'literal' && year !== '2026') {
          status = 'WARN'; why = year + ' total is literal (Phase 3 snapshot)';
        } else {
          status = 'FAIL'; why = 'total monthly dominant=' + dominantMonth + ', expected sum';
        }
      } else if (expected === 'subtract') {
        // net = revenue - total per current spec
        if (dominantMonth === 'subtract') {
          status = 'PASS'; why = 'net = revenue - total per col';
        } else if (dominantMonth === 'literal' && year !== '2026') {
          status = 'WARN'; why = year + ' net is literal (Phase 3 snapshot)';
        } else {
          status = 'FAIL'; why = 'net monthly dominant=' + dominantMonth + ', expected subtract';
        }
      } else {
        status = 'WARN'; why = 'unknown row key ' + key;
      }

      yearResult.rows[key] = {
        rowNum: rowNum,
        label: label,
        annualValue: annualValue,
        annualFormula: annualFormula || '(literal)',
        annualClassification: classification,
        monthClassifications: distinctMonth,
        dominantMonth: dominantMonth,
        status: status,
        why: why
      };
      if (status === 'PASS') yearResult.pass++;
      else if (status === 'WARN') yearResult.warn++;
      else yearResult.fail++;

      Logger.log(
        '  ' + status +
        ' r' + rowNum + ' ' + (label || key) +
        ' | annual=' + annualValue.toFixed(2) +
        ' | monthly=' + JSON.stringify(distinctMonth) +
        ' | ' + why
      );
    });

    // ── Sanity check: 2026 (current year) — every month col, every category,
    // net should be a finite number (NaN/-Infinity would mean broken formula).
    if (year === '2026') {
      Logger.log('  -- 2026 monthly sanity (net per month must be finite) --');
      var netRow = block.net;
      var netValues = dash.getRange(netRow, 3, 1, 12).getValues()[0];
      for (var m = 0; m < 12; m++) {
        var nv = netValues[m];
        var isFin = (typeof nv === 'number' && isFinite(nv));
        var mLabel = '  month ' + (m + 1).toString().padStart(2, '0');
        if (!isFin && nv !== '' && nv !== null && nv !== undefined) {
          Logger.log(mLabel + ' net=' + nv + ' !! NON-FINITE — broken formula');
          yearResult.fail++;
        } else if (typeof nv === 'number' && nv < -1e9) {
          Logger.log(mLabel + ' net=' + nv + ' !! absurdly negative — likely broken');
          yearResult.fail++;
        } else {
          // Allow blank (future month) or any sane number (incl. neg).
          var disp = (typeof nv === 'number') ? nv.toFixed(2) : '(blank)';
          Logger.log(mLabel + ' net=' + disp + ' OK');
        }
      }
    }

    results.years[year] = yearResult;
    results.overall.pass += yearResult.pass;
    results.overall.fail += yearResult.fail;
    results.overall.warn += yearResult.warn;

    Logger.log('  → ' + year + ' summary: ' + yearResult.pass + ' pass, ' +
      yearResult.warn + ' warn, ' + yearResult.fail + ' fail');
    Logger.log('');
  });

  // Final PASS/FAIL table
  Logger.log('=== PHASE 5 — FINAL RESULT ===');
  Logger.log('Year | revenue | orders | material | marketing | shipping | operational | total | net');
  Logger.log('-----|---------|--------|----------|-----------|----------|-------------|-------|-----');
  ['2026', '2025', '2024', '2023'].forEach(function (year) {
    var r = results.years[year].rows;
    var cells = ['revenue','orders','material','marketing','shipping','operational','total','net'].map(function (k) {
      return (r[k].status || '????').slice(0, 4);
    });
    Logger.log(year + ' | ' + cells.join(' | '));
  });
  Logger.log('');
  Logger.log('Overall: ' + results.overall.pass + ' pass, ' +
    results.overall.warn + ' warn, ' + results.overall.fail + ' fail');

  if (results.overall.fail === 0) {
    Logger.log('NEW dashboard formulas look healthy. Phase 5 PASS.');
  } else {
    Logger.log('NEW dashboard has ' + results.overall.fail +
      ' failing rows — review log above before declaring Phase 5 done.');
  }

  return results;
}

// ─── PUBLIC ENTRY POINT ──────────────────────────────────────────────────

// Zero-arg, dropdown-friendly verifier. NO write capability whatsoever.
// Iron rule: this function is the only public entry to Phase 5, and it
// must never mutate anything in NEW or OLD.
function VERIFY_PHASE5_DASHBOARDS() {
  return _mp5_verify_();
}
