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

// Multi-line frozen-year pattern (Steven 2026-05-30, PR #152 WS2 follow-up):
//   var year = 2026;                                  // ← literal year assignment
//   var monthKey = year + '-' + MM;                   // ← concat
//   sheet.getRange(...).setFormula(... "' + monthKey + '" ...);  // ← write
// The single-line scanner above does NOT catch this because the year literal
// and the setFormula sit on different lines. This static backward-walk
// closes that gap: for every setFormula call in a .gs file, scan back N
// lines for `var year = <numeric literal>` (or `let`/`const`). If found
// AND a `monthKey` (or similar concatenation of `year` with a hyphen) sits
// between them, flag the file/line as a frozen-year installer.
//
// NOTE: dynamic assignments — `var year = _dashResolveYear_(sheet);`,
// `var year = now.getFullYear();`, `var year = blk.year;` — are NOT
// flagged because the right-hand side is a function call / property
// access, not a numeric literal. The config-object pattern in
// personal_sheet_fix.gs (`year: 2026` inside `_PSF_YEAR_2026_`) is also
// not flagged — only direct numeric assignment to a bare `year` variable.
const LITERAL_YEAR_ASSIGN_RE = /\b(?:var|let|const)\s+year\s*=\s*(20[2-9][0-9])\s*[;,]/;
const SETFORMULA_RE = /\.setFormula[s]?\s*\(/;
const MONTHKEY_CONCAT_RE = /\b(monthKey|monthkey|mKey|mk)\s*=\s*\b(year|y)\b\s*\+\s*['"`]-/;
const BACKWARD_WINDOW = 30;

const frozenYearFindings = [];

for (const fname of botFiles) {
  const full = path.join(BOT_DIR, fname);
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SETFORMULA_RE.test(line)) continue;
    // Walk backward up to BACKWARD_WINDOW lines.
    const lo = Math.max(0, i - BACKWARD_WINDOW);
    let foundLiteralYearAt = -1;
    let foundMonthKeyAt = -1;
    for (let k = i - 1; k >= lo; k--) {
      const back = lines[k];
      const trimmedBack = back.trim();
      // Skip comments inside the window — they should not count.
      if (trimmedBack.startsWith('//') || trimmedBack.startsWith('*') ||
          trimmedBack.startsWith('/*')) continue;
      if (foundLiteralYearAt < 0 && LITERAL_YEAR_ASSIGN_RE.test(back)) {
        foundLiteralYearAt = k;
      }
      if (foundMonthKeyAt < 0 && MONTHKEY_CONCAT_RE.test(back)) {
        foundMonthKeyAt = k;
      }
      if (foundLiteralYearAt >= 0 && foundMonthKeyAt >= 0) break;
    }
    // Both signals must be present AND the literal year must precede the
    // monthKey concat (i.e. monthKey was actually built from the literal).
    if (foundLiteralYearAt >= 0 &&
        foundMonthKeyAt >= 0 &&
        foundLiteralYearAt <= foundMonthKeyAt) {
      frozenYearFindings.push({
        file: fname,
        setFormulaLine: i + 1,
        literalYearLine: foundLiteralYearAt + 1,
        literalYearSnippet: lines[foundLiteralYearAt].trim().slice(0, 120),
        monthKeyLine: foundMonthKeyAt + 1,
        monthKeySnippet: lines[foundMonthKeyAt].trim().slice(0, 120),
      });
    }
  }
}

if (frozenYearFindings.length === 0) {
  assert(true, 'no multi-line frozen-year installer pattern found (backward-walk check)');
} else {
  for (const f of frozenYearFindings) {
    console.error('    -> ' + f.file + ':' + f.setFormulaLine + ' setFormula reads frozen year');
    console.error('       year literal at line ' + f.literalYearLine + ': ' + f.literalYearSnippet);
    console.error('       monthKey concat at line ' + f.monthKeyLine + ': ' + f.monthKeySnippet);
  }
  assert(false,
    'found ' + frozenYearFindings.length +
    ' multi-line frozen-year installer pattern(s) — replace `var year = 2026` with a dynamic resolution (_dashResolveYear_ / B4 / YEAR(TODAY()))');
}

// Self-test: the backward-walk SHOULD fire on a deliberately broken sample
// so a future refactor that breaks the walker is caught here. We use a
// synthetic string (no file write) to exercise the logic without touching
// the repo.
(function selfTest() {
  const sample = [
    'function _installerBad_(sheet) {',
    '  var year = 2026;',
    '  for (var m = 1; m <= 12; m++) {',
    "    var monthKey = year + '-' + (m < 10 ? '0' + m : m);",
    "    sheet.getRange(1, m).setFormula('=SUMIFS(A:A, B:B, \"' + monthKey + '\")');",
    '  }',
    '}',
  ];
  let hits = 0;
  for (let i = 0; i < sample.length; i++) {
    if (!SETFORMULA_RE.test(sample[i])) continue;
    const lo = Math.max(0, i - BACKWARD_WINDOW);
    let yIdx = -1, mIdx = -1;
    for (let k = i - 1; k >= lo; k--) {
      if (yIdx < 0 && LITERAL_YEAR_ASSIGN_RE.test(sample[k])) yIdx = k;
      if (mIdx < 0 && MONTHKEY_CONCAT_RE.test(sample[k])) mIdx = k;
      if (yIdx >= 0 && mIdx >= 0) break;
    }
    if (yIdx >= 0 && mIdx >= 0 && yIdx <= mIdx) hits++;
  }
  assert(hits === 1,
    'backward-walk self-test catches the deliberately broken sample (expected 1 hit, got ' + hits + ')');
})();

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
