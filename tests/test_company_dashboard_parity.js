#!/usr/bin/env node
/*
 * test_company_dashboard_parity.js  (standalone; auto-discovered by the gauntlet)
 *
 * MONEY-CORRECTNESS GUARD. Three independent builders produce the מאזן חברה
 * (company dashboard) expense formulas, and they must agree or identical data
 * yields different totals:
 *   1. lib/sheet-writer.js COMPANY_EXPENSE_ROWS  (canonical fresh-tenant template)
 *   2. api/sheet/fix-company-dashboard.js COMPANY_EXPENSE_ROWS + buildBusinessRowFormulas()
 *      (the live "fix dashboard" button on account.html + the bot-secret path)
 *   3. bot/personal_sheet_fix.gs cost-recompute loops (the repair path)
 *
 * Historic drift this locks out:
 *   - (2) had NARROWER, non-wildcard ops criteria than (1) -> business costs
 *     (consultants/accountants/collections) vanished from the dashboard.
 *   - (2) OMITTED the col H = TRUE sign filter -> a business income/refund row
 *     whose col E matched a cost wildcard INFLATED costs.
 *   - (3) read only cols A-F (no col H) -> same sign-blind cost inflation.
 *
 * Loads the REAL source by balanced-bracket / regex extraction (no mocking
 * framework), mirroring tests/test_taxonomy_normalize.js + test_sheet_tab_constants.js.
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

// Extract a `const NAME = [ ... ];` array literal by balanced-bracket matching.
function extractArrayLiteral(src, name) {
  const at = src.indexOf('const ' + name + ' = [');
  if (at < 0) return null;
  const start = src.indexOf('[', at);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// Extract a top-level `function NAME(...) { ... }` by balanced braces.
function extractFn(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  return null;
}

const libSrc = fs.readFileSync(path.join(REPO, 'lib', 'sheet-writer.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(REPO, 'api', 'sheet', 'fix-company-dashboard.js'), 'utf8');
const botSrc = fs.readFileSync(path.join(REPO, 'bot', 'personal_sheet_fix.gs'), 'utf8');

// ---- 1. The two COMPANY_EXPENSE_ROWS tables are deep-equal ----
const libLit = extractArrayLiteral(libSrc, 'COMPANY_EXPENSE_ROWS');
const apiLit = extractArrayLiteral(apiSrc, 'COMPANY_EXPENSE_ROWS');
ok('lib COMPANY_EXPENSE_ROWS extracted', !!libLit);
ok('api COMPANY_EXPENSE_ROWS extracted', !!apiLit);

let libArr = null, apiArr = null;
try { libArr = eval(libLit); } catch (e) { ok('lib array evals', false, e.message); }
try { apiArr = eval(apiLit); } catch (e) { ok('api array evals', false, e.message); }

if (Array.isArray(libArr) && Array.isArray(apiArr)) {
  ok('same number of company expense rows', libArr.length === apiArr.length, 'lib=' + libArr.length + ' api=' + apiArr.length);
  // normalize to {label, criteria} so an incidental extra key can't mask drift
  const norm = (a) => a.map((r) => ({ label: String(r.label || ''), criteria: (r.criteria || []).slice() }));
  const L = JSON.stringify(norm(libArr));
  const A = JSON.stringify(norm(apiArr));
  ok('COMPANY_EXPENSE_ROWS deep-equal (labels order + criteria arrays)', L === A,
     '\n    lib=' + L + '\n    api=' + A);
}

// ---- 2. Every api business SUMIFS carries the col H = TRUE sign filter ----
const fnLit = extractFn(apiSrc, 'buildBusinessRowFormulas');
ok('buildBusinessRowFormulas extracted', !!fnLit);
if (fnLit && Array.isArray(apiArr)) {
  let matrix = null;
  try {
    // TX_TAB value is irrelevant to the sign-filter assertion; pass the real one.
    const run = new Function('TX_TAB', 'COMPANY_EXPENSE_ROWS', fnLit + '\nreturn buildBusinessRowFormulas();');
    matrix = run('תנועות', apiArr);
  } catch (e) { ok('buildBusinessRowFormulas runs', false, e.message); }
  if (Array.isArray(matrix)) {
    let sumifsCells = 0, signed = 0;
    for (const row of matrix) {
      for (let c = 1; c < row.length; c++) { // skip col B annual SUM cell
        const cell = String(row[c]);
        if (cell.indexOf('SUMIFS') >= 0) {
          sumifsCells++;
          if (cell.indexOf('!H:H, TRUE') >= 0) signed++;
        }
      }
    }
    ok('api builds >0 SUMIFS cells', sumifsCells > 0, 'got ' + sumifsCells);
    ok('EVERY api business SUMIFS has the H:H, TRUE sign filter', sumifsCells > 0 && signed === sumifsCells, signed + '/' + sumifsCells + ' signed');
  }
}

// ---- 3. The bot cost-recompute reads col H and filters the sign ----
ok('bot cost-recompute no longer reads only cols A-F (6)', botSrc.indexOf('getRange(2, 1, lastRow - 1, 6)') < 0,
   'a sign-blind 6-col read remains in personal_sheet_fix.gs');
ok('bot cost-recompute reads col H (8 cols)', botSrc.indexOf('getRange(2, 1, lastRow - 1, 8)') >= 0);
ok('bot cost-recompute applies a col-H sign filter to cost buckets', /bucket !== 'מחזור ברוטו'[\s\S]{0,260}r\[7\]/.test(botSrc),
   'expected a revenue-bucket guard + r[7] (col H) check');

console.log('test_company_dashboard_parity: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
