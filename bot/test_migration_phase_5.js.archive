#!/usr/bin/env node
// bot/test_migration_phase_5.js
// Regression test for bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs (Phase 5 of
// the Kesefle migration epic — Steven 2026-05-28).
//
// Same string-match style as bot/test_migration.js — we can't easily run
// Apps Script locally, so we lock the structural safety guards by asserting
// the source code.
//
// What Phase 5 must guarantee:
//   - Public entry point VERIFY_PHASE5_DASHBOARDS() exists, zero-arg
//   - Read-only contract: NO setValue, setValues, setFormula, setNote,
//     deleteRow(s), insertRow(s), clear, clearContent, clearDataValidations
//   - OLD sheet is NEVER opened (not even read)
//   - Only NEW sheet ID is referenced
//   - Verifies each row's formula source classification per year-block
//   - Returns a structured { years, overall } object
//   - 2026 monthly sanity loop is present

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'MIGRATE_PHASE_5_VERIFY_FORMULAS.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_migration_phase_5.js\n');

// ── Sheet IDs ───────────────────────────────────────────────────────────
console.log('Sheet IDs:');
assert(/_MP5_NEW_SHEET_ID_\s*=\s*['"]1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A['"]/.test(SRC),
  'NEW sheet ID is the canonical Kesefle (1rti...)');
assert(!/_MP5_OLD_SHEET_ID_/.test(SRC),
  'NO _MP5_OLD_SHEET_ID_ constant — Phase 5 is NEW-only');
assert(!/1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo/.test(SRC),
  'OLD sheet ID is NEVER referenced in Phase 5 source (verifier is NEW-only)');

// ── Tab name constants ─────────────────────────────────────────────────
console.log('\nTab name constants:');
assert(/_MP5_COMPANY_TAB_\s*=\s*['"]מאזן חברה['"]/.test(SRC),
  'מאזן חברה tab name constant defined');
assert(/_MP5_TX_TAB_\s*=\s*['"]תנועות['"]/.test(SRC),
  'תנועות tab name constant defined');
assert(/_MP5_ORDERS_TAB_\s*=\s*['"]הזמנות['"]/.test(SRC),
  'הזמנות tab name constant defined');
assert(/_MP5_VERSION_\s*=\s*['"]Migration_Phase_5_v1['"]/.test(SRC),
  'Phase 5 version tag set');

// ── Public entry point ─────────────────────────────────────────────────
console.log('\nPublic entry point:');
assert(/function VERIFY_PHASE5_DASHBOARDS\(\)/.test(SRC),
  'VERIFY_PHASE5_DASHBOARDS() exists (zero-arg, dropdown-friendly)');
assert(/return _mp5_verify_\(\)/.test(SRC),
  'VERIFY_PHASE5_DASHBOARDS delegates to _mp5_verify_()');

// ── READ-ONLY contract (the iron rule) ─────────────────────────────────
console.log('\nREAD-ONLY contract:');
const forbiddenWrites = [
  'setValue\\b',         // single cell
  'setValues\\b',        // bulk
  'setFormula\\b',
  'setFormulas\\b',
  'setNote\\b',
  'setNotes\\b',
  'setBackground\\b',
  'setFontWeight\\b',
  'deleteRow\\b',
  'deleteRows\\b',
  'deleteColumn\\b',
  'deleteColumns\\b',
  'deleteSheet\\b',
  'insertRow\\b',
  'insertRows\\b',
  'insertColumnsBefore\\b',
  'clear\\b',
  'clearContent\\b',
  'clearFormat\\b',
  'clearDataValidations\\b',
  'setDataValidation\\b',
  'insertSheet\\b',
  'copyTo\\b',
  'removeMenu\\b',
  'setName\\b'
];
forbiddenWrites.forEach(function (verb) {
  const re = new RegExp('\\.\\s*' + verb);
  assert(!re.test(SRC),
    'Phase 5 NEVER calls .' + verb.replace(/\\\\b/g, '') + ' (read-only)');
});

// Also: never call openByUrl with a write-capable spread (we only use openById on NEW).
assert(/SpreadsheetApp\.openById\(_MP5_NEW_SHEET_ID_\)/.test(SRC),
  'Opens NEW sheet via openById (the only sheet open call)');
const openCalls = (SRC.match(/SpreadsheetApp\.open/g) || []).length;
assert(openCalls === 1,
  'Exactly one SpreadsheetApp.open* call in the entire file (got ' + openCalls + ')');

// ── Year block layout (label-based, not row-index-based — per memory) ──
console.log('\nYear block layout:');
assert(/'2023'\s*:\s*\{\s*revenue:\s*42/.test(SRC),
  '2023 revenue row is 42 (matches FIX_DASHBOARD_2023_2024_2025 layout)');
assert(/'2024'\s*:\s*\{\s*revenue:\s*30/.test(SRC),
  '2024 revenue row is 30');
assert(/'2025'\s*:\s*\{\s*revenue:\s*18/.test(SRC),
  '2025 revenue row is 18');
assert(/'2026'\s*:\s*\{\s*revenue:\s*\s*6/.test(SRC),
  '2026 revenue row is 6');
assert(/net:\s*13/.test(SRC),
  '2026 net row is 13 (block end)');
assert(/net:\s*49/.test(SRC),
  '2023 net row is 49 (block end)');

// All 8 category names must be in the row map
['revenue','orders','material','marketing','shipping','operational','total','net']
  .forEach(function (k) {
    assert(new RegExp(k + ':').test(SRC),
      'Year block defines row for ' + k);
  });

// ── Expected-source map (the contract under test) ──────────────────────
console.log('\nExpected source per row type:');
assert(/_MP5_EXPECTED_SOURCE_/.test(SRC),
  '_MP5_EXPECTED_SOURCE_ map defined');
assert(/revenue:\s*['"]orders['"]/.test(SRC),
  'revenue row expects formula sourced from orders (הזמנות)');
assert(/material:\s*['"]transactions['"]/.test(SRC),
  'material row expects formula sourced from transactions (תנועות)');
assert(/marketing:\s*['"]transactions['"]/.test(SRC),
  'marketing row expects formula sourced from transactions');
assert(/shipping:\s*['"]transactions['"]/.test(SRC),
  'shipping row expects formula sourced from transactions');
assert(/operational:\s*['"]transactions['"]/.test(SRC),
  'operational row expects formula sourced from transactions');
assert(/total:\s*['"]sum['"]/.test(SRC),
  'total row expects sum-of-categories');
assert(/net:\s*['"]subtract['"]/.test(SRC),
  'net row expects revenue - total subtraction formula');

// ── Formula classifier ─────────────────────────────────────────────────
console.log('\nFormula classifier:');
assert(/function _mp5_classifyFormula_\(formula\)/.test(SRC),
  '_mp5_classifyFormula_ helper exists');
assert(/return 'orders'/.test(SRC),
  'classifier returns "orders" for הזמנות references');
assert(/return 'transactions'/.test(SRC),
  'classifier returns "transactions" for תנועות references');
assert(/return 'sum'/.test(SRC),
  'classifier returns "sum" for SUM(...) formulas');
assert(/return 'subtract'/.test(SRC),
  'classifier returns "subtract" for =A-B style net formulas');
assert(/return 'literal'/.test(SRC),
  'classifier returns "literal" for non-formula cells (Phase 3 snapshot)');

// ── 2026 sanity loop (current year — every month must be finite) ──────
console.log('\n2026 monthly sanity check:');
assert(/2026 monthly sanity/.test(SRC),
  'Sanity-check block for 2026 is present');
assert(/!isFin/.test(SRC) || /isFinite\(/.test(SRC),
  'Sanity check uses isFinite() to flag broken formulas');
assert(/NON-FINITE/.test(SRC),
  'Sanity check logs NON-FINITE when a month cell is broken');

// ── Logging discipline ─────────────────────────────────────────────────
console.log('\nLogging discipline:');
assert(/=== KESEFLE PHASE 5/.test(SRC),
  'Log header announces Phase 5');
assert(/PHASE 5 — FINAL RESULT/.test(SRC),
  'Logs explicit FINAL RESULT section');
assert(/PASS\s*\|\s*FAIL/.test(SRC) || /pass.*fail/i.test(SRC),
  'Logs PASS/FAIL table');
assert(/Overall:/.test(SRC),
  'Logs overall pass/fail count');

// ── Return shape ───────────────────────────────────────────────────────
console.log('\nReturn shape:');
assert(/results\.years/.test(SRC),
  'Returns { years: {...} } keyed by year');
assert(/results\.overall/.test(SRC),
  'Returns { overall: { pass, fail, warn } }');
assert(/pass:\s*0,\s*fail:\s*0,?\s*warn:\s*0/.test(SRC),
  'Overall counters initialized to 0');

// ── No APPLY function — Phase 5 is verify-only ─────────────────────────
console.log('\nNo APPLY function (Phase 5 is verify-only):');
assert(!/function APPLY_PHASE5/.test(SRC),
  'No APPLY_PHASE5* function — verify-only by design');
assert(!/YES I UNDERSTAND/.test(SRC),
  'No confirmation gate — nothing to confirm (read-only)');
assert(!/LockService/.test(SRC),
  'No LockService — read-only path needs no lock');

// ── Defensive sheet-not-found handling ─────────────────────────────────
console.log('\nDefensive sheet handling:');
assert(/cannot_open_new/.test(SRC),
  'Returns { error: "cannot_open_new" } if sheet cannot be opened');
assert(/no_company_tab/.test(SRC),
  'Returns { error: "no_company_tab" } if dashboard tab missing');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
