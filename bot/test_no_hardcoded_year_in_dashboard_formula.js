#!/usr/bin/env node
// Pins the contract that bot dashboard-formula emitters MUST reference the
// year-selector cell B4 (or YEAR(TODAY())) rather than a hardcoded literal
// like 2026, 2025, 2024, 2023.
//
// Why this exists:
//   In May 2026 we shipped FIX_DASHBOARD_2023_2024_2025 to repair a
//   net-profit bug. The root cause was hardcoded years in SUMIFS criteria
//   that broke at year rollover. With 2027 < 7 months away, a structural
//   test prevents recurrence without depending on code-review prayer.
//
// What this tests:
//   1. _emitDashboardFormula_ helpers don't bake a year into the SUMIFS literal.
//   2. RECOMPUTE_COMPANY_DASHBOARD references B4 (or the named range) when
//      it rebuilds formulas.
//   3. If a year literal IS found in a formula-emitting site (not a comment
//      or a one-off historical fix), the test FAILS with the file and line.
//
// Loads REAL source via fs.readFileSync — no mocking framework, per
// the Kesefle test-add-suite pattern.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BOT_DIR = path.join(ROOT, 'bot');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_no_hardcoded_year_in_dashboard_formula.js\n');

// Files known to be historical one-shot fixes — they're SUPPOSED to have
// hardcoded years because they were targeted repairs. Excluded from scan.
const HISTORICAL_FIXES = new Set([
  'FIX_DASHBOARD_2023_2024_2025.gs',
  // Add other one-shot historical fix files here if/when added.
]);

const SUSPECT_YEAR_RE = /["'`]\b(202[3-9])\b["'`]/g;
const SUMIFS_RE = /SUMIFS\s*\(/i;

let scannedFiles = 0;
let problemFiles = [];

const botFiles = fs.readdirSync(BOT_DIR)
  .filter(f => f.endsWith('.gs'))
  .filter(f => !HISTORICAL_FIXES.has(f));

for (const fname of botFiles) {
  scannedFiles++;
  const full = path.join(BOT_DIR, fname);
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only lines.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // Only flag if the line ALSO contains a SUMIFS or a formula-emit marker.
    const hasFormulaContext =
      SUMIFS_RE.test(line) ||
      /setFormula/.test(line) ||
      /buildSumifs|emitDashFormula|composeFormula/.test(line);
    if (!hasFormulaContext) continue;
    // Now look for a hardcoded year literal in that context line.
    const match = line.match(SUSPECT_YEAR_RE);
    if (match) {
      problemFiles.push({
        file: fname,
        line: i + 1,
        snippet: trimmed.slice(0, 120),
        years: match,
      });
    }
  }
}

console.log('Scanned ' + scannedFiles + ' .gs files (excluding historical fixes).');

assert(scannedFiles >= 10,
  'scanner covered enough .gs files (>= 10; got ' + scannedFiles + ')');

if (problemFiles.length === 0) {
  assert(true, 'no hardcoded year literal found in any SUMIFS / setFormula context');
} else {
  for (const p of problemFiles) {
    console.error('    -> ' + p.file + ':' + p.line + ' contains years ' + p.years.join(', '));
    console.error('       ' + p.snippet);
  }
  assert(false,
    'found ' + problemFiles.length + ' formula-emit line(s) with hardcoded year literals — must reference B4 or YEAR(TODAY())');
}

// Also verify RECOMPUTE_COMPANY_DASHBOARD exists AND references B4 or YEAR.
const fixSrc = (() => {
  try {
    return fs.readFileSync(path.join(BOT_DIR, 'personal_sheet_fix.gs'), 'utf8');
  } catch (_e) { return ''; }
})();

if (fixSrc) {
  assert(/RECOMPUTE_COMPANY_DASHBOARD/.test(fixSrc),
    'RECOMPUTE_COMPANY_DASHBOARD function exists in personal_sheet_fix.gs');

  const recomputeHasYearRef =
    /RECOMPUTE_COMPANY_DASHBOARD[\s\S]{0,8000}(B4|YEAR\(TODAY|getYear|currentYear)/.test(fixSrc);
  assert(recomputeHasYearRef,
    'RECOMPUTE_COMPANY_DASHBOARD references B4 / YEAR(TODAY()) / getYear within its body');
} else {
  console.log('  INFO  personal_sheet_fix.gs not present — skipping RECOMPUTE checks');
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
