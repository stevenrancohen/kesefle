#!/usr/bin/env node
/**
 * bot/VALIDATE_NO_HARDCODED_YEAR.js
 *
 * Non-destructive read-only validator. Scans every bot/*.gs file for
 * hardcoded year strings inside *formula-building code* and fails if any
 * are found.
 *
 * WHY (Steven, 2026-05-28):
 *   The migrated single-תנועות model needs every dashboard SUMIFS to use
 *   the live $B$4 year reference, NOT a hardcoded "2026", "2025-MM", or
 *   DATE(2026,...). If a SUMIFS literal year sneaks in, the year-selector
 *   dropdown silently breaks for that one cell, and the user sees zeros
 *   when they switch B4 to a different year.
 *
 *   This validator gates that exact regression. It runs in CI / pre-merge.
 *
 * WHAT IT DOES (high level):
 *   1. Walk bot/*.gs (skip *.bak.*, *.md, *.js).
 *   2. For each line, decide if it is *formula-building code* — i.e. the
 *      Apps Script string literal that becomes a Google Sheets formula.
 *      Markers: presence of SUMIFS / SUMPRODUCT / COUNTIFS / DATE( / B$4 /
 *      $B$4 / $B$2 in the same line OR within 3 lines above/below.
 *   3. In those lines, look for hardcoded year patterns:
 *        - "2023-" / "2024-" / "2025-" / "2026-" / "2027-" / "2028-"
 *          (year-month string literals used as SUMIFS criteria)
 *        - DATE(2023,/ DATE(2024,/ ... (numeric DATE arg)
 *        - YEAR() == 2024 etc. (rare but covered)
 *   4. Whitelist: lines inside JSDoc /* ... ​*​/ blocks, lines that are
 *      obviously comments (//), lines that just *log* a year (Logger.log
 *      / console.log), the special-case 2026-05 +2100 marketing adjustment
 *      (Steven's documented manual override), and Logger / informational
 *      strings.
 *   5. Print a violation report (file:line | snippet) and exit 1 if any
 *      remain. Otherwise exit 0.
 *
 * USAGE:
 *   node bot/VALIDATE_NO_HARDCODED_YEAR.js
 *   node bot/VALIDATE_NO_HARDCODED_YEAR.js --verbose
 *   node bot/VALIDATE_NO_HARDCODED_YEAR.js --json
 *
 * EXIT CODES:
 *   0 — no violations
 *   1 — at least one violation OR scan failure
 *
 * NEVER WRITES TO SHEETS. PURE STATIC ANALYSIS.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────────────
// CONFIG
// ────────────────────────────────────────────────────────────────────────

const BOT_DIR = path.join(__dirname);  // bot/

// .gs files only. Skip .bak.* (backup snapshots), .md, .js.
function listGsFiles() {
  const all = fs.readdirSync(BOT_DIR);
  return all
    .filter(function (n) { return n.endsWith('.gs'); })
    .filter(function (n) { return n.indexOf('.bak.') === -1; })
    .filter(function (n) { return n.indexOf('.bak') === -1; })
    .sort()
    .map(function (n) { return path.join(BOT_DIR, n); });
}

// Year-string regexes. Note: we anchor on "20XX-" (with the trailing
// hyphen) so we hit SUMIFS month-keys like "2026-05" but NOT free-form
// dates or commit dates like "2026-05-26" in a comment.
//
// Pattern A: "YYYY-MM" hardcoded month key — single OR double quoted,
// raw OR escaped. Examples that MUST be caught:
//     'תנועות'!B:B,"2026-05"
//     "תנועות'!B:B,\"2025-12\""    (escaped double quote in JS string lit)
//     'B:B','2024-03'
// The quote character can be \" (escaped) or " or ' — we allow optional
// backslash before the quote. Trailing quote can also be \" or " or '.
const RE_HARDCODED_YEAR_STRING = /\\?["']2(0[2-9][0-9])-\d{2}\\?["']/;

// Pattern B: DATE(YYYY,...) inside a formula. The third arg is usually a
// month index (1..12) and the second is a literal year. Catches DATE(2026,5,1).
const RE_HARDCODED_DATE_YEAR = /DATE\s*\(\s*2(0[2-9][0-9])\s*,/;

// Pattern C: YEAR(...)==YYYY style criterion. Rare but covered.
const RE_HARDCODED_YEAR_COMPARE = /YEAR\s*\([^)]*\)\s*[=<>!]+\s*2(0[2-9][0-9])/;

// Pattern D: dashboard SUMIFS that concatenates a literal year, e.g.
//   "B:B,2026&\"-05\""  or  "$B$4&\"-05\""  — the LITERAL form is the bug,
//   the $B$4 form is what we want. Match: digit-year followed by &"-MM"
// where the opening quote can be escaped (\") or raw (").
const RE_HARDCODED_YEAR_AMPERSAND = /\b2(0[2-9][0-9])\s*&\s*\\?["']-\d{2}/;

// ────────────────────────────────────────────────────────────────────────
// Markers that this line is FORMULA-BUILDING (vs just talking about a
// year in a comment or log). Used as a co-occurrence filter to reduce
// false positives.
// ────────────────────────────────────────────────────────────────────────
const FORMULA_HINTS = [
  'SUMIFS', 'SUMPRODUCT', 'COUNTIFS', 'SUMIF', 'COUNTIF',
  '!B:B', '!C:C', '!D:D', '!E:E', '!F:F', '!H:H',
  'DATE(', '$B$4', '$B$2', '$B$1',
  "'תנועות'!", "'הזמנות'!",
  '_TX_TAB_', '_ORDERS_TAB_', 'TX_TAB',
  'setFormula', 'setFormulas',
];

function lineLooksLikeFormulaContext(line) {
  for (var i = 0; i < FORMULA_HINTS.length; i++) {
    if (line.indexOf(FORMULA_HINTS[i]) !== -1) return true;
  }
  return false;
}

// Pure-comment detection. A line is "obviously a comment" if its first
// non-whitespace chars are //, * or */ or // or # or it begins a block
// comment. We exclude these from violations — they're documentation, not
// code that builds formulas.
function lineIsPureComment(line) {
  var t = line.replace(/^\s+/, '');
  if (t.indexOf('//') === 0) return true;
  if (t.indexOf('*') === 0) return true;  // inside /* ... */ block
  if (t.indexOf('#') === 0) return true;
  return false;
}

// Logger / console / message strings that just talk about a year are
// fine. Avoid them.
function lineIsLoggerOrStringMessage(line) {
  // Logger.log('... 2026 ...') or console.log('... 2025 ...')
  if (/Logger\.log\s*\(/.test(line) || /console\.(log|warn|error|info)\s*\(/.test(line)) {
    // But: ONLY if the year is inside the log call. We give logging a pass
    // wholesale because the bot uses Logger.log diagnostic dumps liberally.
    return true;
  }
  // Throw / Error / Note messages
  if (/throw\s+new\s+Error/.test(line)) return true;
  if (/\.setNote\s*\(/.test(line)) return true;
  // .replace, .indexOf with year arg (utility string ops, not formulas)
  if (/\.indexOf\s*\(\s*['"]2(0[2-9][0-9])/.test(line)) return true;
  if (/\.replace\s*\(/.test(line) && !lineLooksLikeFormulaContext(line)) return true;
  return false;
}

// Whitelisted documented exceptions. These are SPECIFIC, NARROW string
// matches that Steven has documented in commits / comments and we DO NOT
// want to flag because they represent intentional manual overrides.
//
// WHITELIST 1: the 2026-05 +2100 marketing manual adjustment in
// personal_sheet_fix.gs and ExpenseBot_FIXED.gs.
// WHITELIST 2: the SHEET_YEAR_SELECTOR_WIRE.gs file (LEGACY/REJECTED approach,
// kept in repo for archeology — Steven explicitly REJECTED its design,
// see audit-year-selector-plan branch).
// WHITELIST 3: MIGRATE_OLD_NOTES.gs migration script which contains
// historical year references for one-time data movement, not live formulas.
const WHITELISTED_FILES = new Set([
  // The OLD year-selector wire script — REJECTED architecture (uses a
  // separate "סיכום היסטורי" snapshot tab). Steven REJECTED this approach.
  // File stays in repo for historical reference.
  'SHEET_YEAR_SELECTOR_WIRE.gs',
  // FIX_DASHBOARD_2023_2024_2025.gs is a ONE-SHOT migration that wrote
  // historical (frozen) values into past-year blocks before the new
  // single-תנועות model. Reading from it = looking at frozen history; it
  // is NOT a live formula builder.
  'FIX_DASHBOARD_2023_2024_2025.gs',
]);

function isWhitelistedLine(filePath, line, lineNo, allLines) {
  // The 2026-05 +2100 marketing manual adjustment: documented, intentional.
  if (line.indexOf("blk.year === 2026") !== -1 && line.indexOf("mi === 5") !== -1) return true;
  if (line.indexOf("year === 2026 && mo === 5") !== -1) return true;
  if (line.indexOf("'מאי 2026'") !== -1) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// SCAN ONE FILE
// ────────────────────────────────────────────────────────────────────────
function scanFile(filePath) {
  var src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { error: 'read_failed: ' + e.message, violations: [] };
  }
  var lines = src.split(/\r?\n/);
  var violations = [];

  // Track block-comment state across lines. /* ... */ blocks span multiple
  // lines and we want to give them a free pass.
  var inBlockComment = false;

  for (var i = 0; i < lines.length; i++) {
    var lineNo = i + 1;
    var line = lines[i];

    // Block-comment state machine.
    var workingLine = line;
    if (inBlockComment) {
      var endIdx = workingLine.indexOf('*/');
      if (endIdx === -1) continue;  // still inside the comment
      workingLine = workingLine.slice(endIdx + 2);
      inBlockComment = false;
    }
    while (true) {
      var startIdx = workingLine.indexOf('/*');
      if (startIdx === -1) break;
      var endIdx2 = workingLine.indexOf('*/', startIdx + 2);
      if (endIdx2 === -1) {
        // Strip everything from /* to end-of-line; rest of file is inside.
        workingLine = workingLine.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
      // Strip the inline /* ... */ chunk.
      workingLine = workingLine.slice(0, startIdx) + workingLine.slice(endIdx2 + 2);
    }
    if (!workingLine.trim()) continue;

    // Pure-comment line? Skip.
    if (lineIsPureComment(workingLine)) continue;

    // Strip trailing line comment "// ..." (but keep it if it's inside a
    // string literal — defer to a quick heuristic: only strip "//" that's
    // outside of any single/double quote span).
    workingLine = stripTrailingLineComment(workingLine);
    if (!workingLine.trim()) continue;

    // Logger / Error / Note line — fine.
    if (lineIsLoggerOrStringMessage(workingLine)) continue;

    // Whitelisted exception?
    if (isWhitelistedLine(filePath, workingLine, lineNo, lines)) continue;

    // Now actually look for the year patterns.
    var hits = [];
    if (RE_HARDCODED_YEAR_STRING.test(workingLine)) hits.push('hardcoded YYYY-MM string');
    if (RE_HARDCODED_DATE_YEAR.test(workingLine)) hits.push('DATE(YYYY,...)');
    if (RE_HARDCODED_YEAR_COMPARE.test(workingLine)) hits.push('YEAR(...)==YYYY');
    if (RE_HARDCODED_YEAR_AMPERSAND.test(workingLine)) hits.push('YYYY&"-MM" concat');

    if (!hits.length) continue;

    // Co-occurrence filter: is THIS line OR a neighbor a formula-building
    // line? We accept "formula-context" within ±3 lines so the helper that
    // builds parts of a formula string across lines is caught.
    if (!withinFormulaContext(lines, i, 3)) continue;

    violations.push({
      file: filePath,
      line: lineNo,
      reason: hits.join(' + '),
      snippet: line.replace(/^\s+/, '').slice(0, 160),
    });
  }

  return { error: null, violations: violations };
}

// Look at the current line and ±N neighbors. If any of them contains a
// FORMULA_HINT marker, return true.
function withinFormulaContext(lines, idx, n) {
  var lo = Math.max(0, idx - n);
  var hi = Math.min(lines.length - 1, idx + n);
  for (var k = lo; k <= hi; k++) {
    if (lineLooksLikeFormulaContext(lines[k])) return true;
  }
  return false;
}

// Quick & simple: strip a trailing "// ..." comment iff the // is not
// inside a single/double quote. Not perfect (doesn't track escapes or
// backticks) but works on our codebase where the bot files use ASCII
// quoting consistently in formula strings.
function stripTrailingLineComment(line) {
  var inSingle = false, inDouble = false;
  for (var i = 0; i < line.length - 1; i++) {
    var c = line[i];
    var prev = i > 0 ? line[i - 1] : '';
    if (c === '\'' && prev !== '\\' && !inDouble) inSingle = !inSingle;
    else if (c === '"' && prev !== '\\' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === '/' && line[i + 1] === '/') {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

// ────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────
function main() {
  var argv = process.argv.slice(2);
  var verbose = argv.indexOf('--verbose') !== -1;
  var asJson = argv.indexOf('--json') !== -1;

  var files = listGsFiles();
  var allViolations = [];
  var scanErrors = [];
  var filesScanned = 0;
  var filesSkipped = 0;

  files.forEach(function (fp) {
    var basename = path.basename(fp);
    if (WHITELISTED_FILES.has(basename)) {
      if (verbose) console.log('SKIP (whitelisted) ' + basename);
      filesSkipped++;
      return;
    }
    filesScanned++;
    var res = scanFile(fp);
    if (res.error) {
      scanErrors.push({ file: fp, error: res.error });
      return;
    }
    if (res.violations.length) {
      allViolations = allViolations.concat(res.violations);
    }
    if (verbose) {
      console.log('SCANNED ' + basename + ' — ' + res.violations.length + ' violation(s)');
    }
  });

  if (asJson) {
    var out = {
      filesScanned: filesScanned,
      filesSkipped: filesSkipped,
      whitelistedFiles: Array.from(WHITELISTED_FILES),
      scanErrors: scanErrors,
      violations: allViolations,
      pass: allViolations.length === 0 && scanErrors.length === 0,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log('');
    console.log('bot/VALIDATE_NO_HARDCODED_YEAR.js');
    console.log('Scanned ' + filesScanned + ' .gs file(s) under bot/ (' +
                filesSkipped + ' whitelisted, skipped).');
    if (scanErrors.length) {
      console.log('');
      console.log('Scan errors (' + scanErrors.length + '):');
      scanErrors.forEach(function (e) {
        console.log('  ' + path.relative(process.cwd(), e.file) + ' — ' + e.error);
      });
    }
    if (allViolations.length) {
      console.log('');
      console.log('Violations (' + allViolations.length + '):');
      allViolations.forEach(function (v) {
        console.log('  ' + path.relative(process.cwd(), v.file) + ':' + v.line +
                    '  [' + v.reason + ']');
        console.log('    ' + v.snippet);
      });
      console.log('');
      console.log('FAIL: hardcoded year refs in formula-building code.');
      console.log('Year selector requires every dashboard SUMIFS to read $B$4, not a literal year.');
      console.log('Fix: replace the literal year with the $B$4 cell reference (or DATE($B$4,...)).');
      console.log('Whitelist exceptions live in WHITELISTED_FILES / isWhitelistedLine at top of this file.');
      process.exit(1);
    }
    console.log('');
    console.log('OK: no hardcoded year references in formula-building code.');
  }
  if (allViolations.length || scanErrors.length) process.exit(1);
  process.exit(0);
}

// Run only if invoked directly (not when require()'d from a test harness).
if (require.main === module) {
  main();
}

module.exports = { scanFile, listGsFiles, WHITELISTED_FILES };
