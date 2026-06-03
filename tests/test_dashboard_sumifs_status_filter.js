// tests/test_dashboard_sumifs_status_filter.js
//
// Regression guard for the income-vs-expense SIGN-FLIP in the dashboard
// formula GENERATOR (lib/sheet-writer.js -> buildTenantSheetSpec).
//
// THE BUG (data audit, 2026-06-03): the generated dashboards summed money by
// col D (category) + col E (subcategory text) ALONE — they did NOT filter the
// status column (col H of 'תנועות': boolean, TRUE=expense / FALSE=income),
// even though the repair/recompute builder (bot/personal_sheet_fix.gs,
// _psf_buildFormula_v2_) DOES segregate income (H=FALSE) from expense
// (H=TRUE). Consequences on freshly-provisioned sheets:
//
//   * מאזן חברה (company): the 4 business-expense rows summed col E by
//     wildcard with no H filter, so any business INCOME whose subcategory
//     matched an expense wildcard would be booked as a cost.
//   * מאזן אישי (personal): the income subcategory "שונות (הכנסות)" CONTAINS
//     "שונות", and the expense row "שונות" matches "*שונות*" — so that income
//     leaked into the misc-EXPENSE total (an ACTIVE flip with today's vocab).
//   * פירוט מורחב (extended): INCOME_GROUPS and EXPENSE_GROUPS use the SAME 88
//     subcategory labels (Pa'amonim convention), so EVERY income row and its
//     identically-named expense row swept each other's rows wholesale.
//
// All three understate net profit / savings. The fix adds the col-H criterion
// to every 'תנועות'-sourced SUMIFS (expense -> TRUE, income -> FALSE). This
// suite locks that in by building a real tenant spec and asserting the
// criterion is present and correctly signed on every relevant formula.
//
// House pattern: no mocking framework. Import the real ES module (no top-level
// side effects / no secret or network access at import time).
//   Run: node tests/test_dashboard_sumifs_status_filter.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}

// Hebrew literals as \u escapes so this file stays pure ASCII (no bidi marks,
// no copy/paste corruption). These match the exact strings in sheet-writer.js.
const TAB_COMPANY  = 'מאזן חברה'; // מאזן חברה
const TAB_PERSONAL = 'מאזן אישי'; // מאזן אישי
const TAB_EXTENDED = 'פירוט מורחב'; // פירוט מורחב
const TX_TAB       = 'תנועות'; // תנועות
const CAT_ESEK     = 'עסק'; // עסק

// A SUMIFS reads from 'תנועות'!E (subcategory) iff it references that range.
const TX_E_RANGE = "'" + TX_TAB + "'!E:E";
// The expense / income status criterion we expect (col H of תנועות).
const H_TRUE_CRIT  = "'" + TX_TAB + "'!H:H, TRUE";
const H_FALSE_CRIT = "'" + TX_TAB + "'!H:H, FALSE";

// Split a (possibly multi-SUMIFS) formula into its individual SUMIFS(...) call
// substrings so we can assert the criterion on EACH one (the company ops row
// sums up to 11 SUMIFS, one per wildcard criterion).
function sumifsCalls(formula) {
  const out = [];
  let i = 0;
  while ((i = formula.indexOf('SUMIFS(', i)) >= 0) {
    // Walk balanced parens from the opening '(' after SUMIFS.
    let p = formula.indexOf('(', i), depth = 0, j = p;
    for (; j < formula.length; j++) {
      if (formula[j] === '(') depth++;
      else if (formula[j] === ')') { depth--; if (!depth) { j++; break; } }
    }
    out.push(formula.slice(i, j));
    i = j;
  }
  return out;
}

// Collect [{ label, formula }] for every cell on a tab that holds a SUMIFS.
function sumifsRows(tab) {
  const out = [];
  (tab.data[0].rowData || []).forEach(function (r) {
    const cells = r.values || [];
    const labelCell = cells[0];
    const label = (labelCell && labelCell.userEnteredValue && labelCell.userEnteredValue.stringValue) || '';
    cells.forEach(function (c) {
      const f = c.userEnteredValue && c.userEnteredValue.formulaValue;
      if (f && f.indexOf('SUMIFS(') >= 0) out.push({ label: label, formula: f });
    });
  });
  return out;
}

(async () => {
  let mod;
  try {
    mod = await import('../lib/sheet-writer.js');
  } catch (e) {
    console.log('  ❌ could not import lib/sheet-writer.js: ' + e.message);
    process.exit(1);
  }
  const { buildTenantSheetSpec } = mod;
  ok('buildTenantSheetSpec is exported', typeof buildTenantSheetSpec === 'function');

  const spec = buildTenantSheetSpec("QA", { year: 2026 });
  const tabs = {};
  spec.sheets.forEach(function (s) { tabs[s.properties.title] = s; });
  ok('spec has the company dashboard tab', !!tabs[TAB_COMPANY]);
  ok('spec has the personal dashboard tab', !!tabs[TAB_PERSONAL]);
  ok('spec has the extended dashboard tab', !!tabs[TAB_EXTENDED]);

  // ── 1. Core invariant: EVERY 'תנועות'!E SUMIFS carries a col-H criterion ──
  // (Orders-tab SUMIFS — company revenue — are exempt; they never touch E and
  // the orders tab is all-revenue.)
  console.log('\n══ 1. Every תנועות-subcategory SUMIFS filters col H ══');
  [TAB_COMPANY, TAB_PERSONAL, TAB_EXTENDED].forEach(function (tabName) {
    const rows = sumifsRows(tabs[tabName]);
    let txSumifsTotal = 0, missing = 0;
    rows.forEach(function (row) {
      sumifsCalls(row.formula).forEach(function (call) {
        if (call.indexOf(TX_E_RANGE) < 0) return; // not a subcategory SUMIFS
        txSumifsTotal++;
        const hasTrue = call.indexOf(H_TRUE_CRIT) >= 0;
        const hasFalse = call.indexOf(H_FALSE_CRIT) >= 0;
        if (!hasTrue && !hasFalse) missing++;
      });
    });
    ok(tabName + ': found תנועות-subcategory SUMIFS to check (>0)', txSumifsTotal > 0);
    ok(tabName + ': ALL ' + txSumifsTotal + ' subcategory SUMIFS carry a col-H criterion (0 missing)', missing === 0);
  });

  // ── 2. Company: business-expense rows must filter H=TRUE (expense only) ────
  console.log('\n══ 2. Company expense rows filter H=TRUE ══');
  {
    const rows = sumifsRows(tabs[TAB_COMPANY]);
    // The expense rows are the ones whose SUMIFS reference col D = "עסק".
    const bizCalls = [];
    rows.forEach(function (row) {
      sumifsCalls(row.formula).forEach(function (call) {
        if (call.indexOf("'" + TX_TAB + "'!D:D, \"" + CAT_ESEK + "\"") >= 0) bizCalls.push(call);
      });
    });
    ok('company has business-expense SUMIFS (cat="עסק")', bizCalls.length >= 48); // 4 rows x 12 months (ops row adds more)
    ok('every business-expense SUMIFS filters H=TRUE (expense)', bizCalls.every(function (c) { return c.indexOf(H_TRUE_CRIT) >= 0; }));
    ok('no business-expense SUMIFS accidentally filters H=FALSE (would zero costs)',
       bizCalls.every(function (c) { return c.indexOf(H_FALSE_CRIT) < 0; }));
    // The revenue row (R6) reads from the ORDERS tab, not תנועות — it must NOT
    // gain an H filter (orders tab has no col H of that meaning).
    const ordersCalls = [];
    rows.forEach(function (row) {
      sumifsCalls(row.formula).forEach(function (call) {
        if (call.indexOf(TX_E_RANGE) < 0 && call.indexOf("'" + TX_TAB + "'!H:H") < 0) ordersCalls.push(call);
      });
    });
    ok('orders-based revenue SUMIFS are left untouched (no col-H filter)',
       ordersCalls.length > 0 && ordersCalls.every(function (c) { return c.indexOf('!H:H') < 0; }));
  }

  // ── 3. Personal: income rows H=FALSE, expense rows H=TRUE ─────────────────
  // Pinpoints the concrete flip: income "שונות (הכנסות)" must NOT be summed by
  // the "*שונות*" EXPENSE row, because that expense SUMIFS now requires H=TRUE.
  console.log('\n══ 3. Personal income H=FALSE, expense H=TRUE (שונות flip) ══');
  {
    const rows = sumifsRows(tabs[TAB_PERSONAL]);
    // Income rows reference $A5..$A8 in their col-E wildcard criterion.
    let incomeChecked = 0, incomeBad = 0, expenseChecked = 0, expenseBad = 0;
    rows.forEach(function (row) {
      sumifsCalls(row.formula).forEach(function (call) {
        if (call.indexOf(TX_E_RANGE) < 0) return;
        const isIncomeRow = /\$A[5-8]&"\*"/.test(call); // $A5..$A8 are the 4 income rows
        if (isIncomeRow) {
          incomeChecked++;
          if (call.indexOf(H_FALSE_CRIT) < 0) incomeBad++;
        } else {
          expenseChecked++;
          if (call.indexOf(H_TRUE_CRIT) < 0) expenseBad++;
        }
      });
    });
    ok('personal income SUMIFS exist and ALL filter H=FALSE (income)', incomeChecked === 48 && incomeBad === 0);
    ok('personal expense SUMIFS exist and ALL filter H=TRUE (expense)', expenseChecked > 0 && expenseBad === 0);
  }

  // ── 4. Extended: 88 shared income/expense labels are segregated by col H ──
  console.log('\n══ 4. Extended income H=FALSE vs expense H=TRUE (shared 88 labels) ══');
  {
    const rows = sumifsRows(tabs[TAB_EXTENDED]);
    let incomeH = 0, expenseH = 0, neither = 0;
    rows.forEach(function (row) {
      sumifsCalls(row.formula).forEach(function (call) {
        if (call.indexOf(TX_E_RANGE) < 0) return;
        if (call.indexOf(H_FALSE_CRIT) >= 0) incomeH++;
        else if (call.indexOf(H_TRUE_CRIT) >= 0) expenseH++;
        else neither++;
      });
    });
    ok('extended has income SUMIFS filtered H=FALSE', incomeH > 0);
    ok('extended has expense SUMIFS filtered H=TRUE', expenseH > 0);
    ok('extended has ZERO subcategory SUMIFS without a col-H filter', neither === 0);
    // Each side is a multiple of 12 (one SUMIFS per month per subcategory row).
    ok('extended income SUMIFS count is a whole number of monthly rows (x12)', incomeH % 12 === 0);
    ok('extended expense SUMIFS count is a whole number of monthly rows (x12)', expenseH % 12 === 0);
  }

  // ── 5. Contract parity with the repair/recompute builder ──────────────────
  // The generator must agree with bot/personal_sheet_fix.gs, which is the
  // self-heal source of truth: business income = H=FALSE, expense = H=TRUE.
  console.log('\n══ 5. Repair builder still encodes the same income/expense contract ══');
  {
    const psf = fs.readFileSync(path.join(__dirname, '..', 'bot', 'personal_sheet_fix.gs'), 'utf8');
    ok('repair builder filters revenue/income by H=FALSE', /H2:H5000\s*=\s*FALSE/.test(psf));
    ok('repair builder filters expense by H=TRUE', /H2:H5000\s*=\s*TRUE/.test(psf));
  }

  console.log('\n' + (fail === 0
    ? '✅ dashboard SUMIFS status filter: ALL ' + pass + ' CHECKS PASSED'
    : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
  process.exit(fail === 0 ? 0 : 1);
})();
