// Unit test: broken-dashboard-formula detector.
// Run: node bot/test_broken_formula.js
//
// Extracts the live _isBrokenBotDashFormula_ from ExpenseBot_FIXED.gs
// and the parallel _isBrokenDashFormula_ from personal_sheet_fix.gs.
// Both MUST agree on every test case so the manual cleaner and the
// bot's auto-self-heal never disagree (otherwise a cell would
// oscillate between "broken-cleaned" and "preserved as good").

'use strict';

const fs = require('fs');
const path = require('path');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

const botSrc = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const psfSrc = fs.readFileSync(path.join(__dirname, 'personal_sheet_fix.gs'), 'utf8');

// Load both detectors. They live in different files but must agree.
const botFn = extractFn(botSrc, '_isBrokenBotDashFormula_');
const psfFn = extractFn(psfSrc, '_isBrokenDashFormula_');
// eslint-disable-next-line no-new-func
new Function(botFn + '\nglobalThis.botDetect = _isBrokenBotDashFormula_;')();
// eslint-disable-next-line no-new-func
new Function(psfFn + '\nglobalThis.psfDetect = _isBrokenDashFormula_;')();

let pass = 0, fail = 0;

function expectBroken(formula, label) {
  const a = globalThis.botDetect(formula);
  const b = globalThis.psfDetect(formula);
  if (a && b) { pass++; console.log('  ✅ flagged broken (both): ' + label); }
  else { fail++; console.log('  ❌ missed broken: ' + label + ' [bot=' + a + ', psf=' + b + '] -- ' + formula); }
}
function expectClean(formula, label) {
  const a = globalThis.botDetect(formula);
  const b = globalThis.psfDetect(formula);
  if (!a && !b) { pass++; console.log('  ✅ preserved clean (both): ' + label); }
  else { fail++; console.log('  ❌ false-positive: ' + label + ' [bot=' + a + ', psf=' + b + '] -- ' + formula); }
}

console.log('=== BROKEN FORMULA DETECTION ===\n');

console.log('-- Real broken formulas from Steven\'s screenshot (2026-05-25) --');
expectBroken('=SUMIFS($I$20:$I$500,$A$20:$A$500,"יוני") + 2100', 'screenshot: local cols + hardcoded +2100');
expectBroken('=SUMIFS($I$20:$I$500,$A$20:$A$500,"מאי")+2100', 'local cols + hardcoded +2100 (no spaces)');
expectBroken('=SUMIFS($B$2:$B$100,$A$2:$A$100,"מאי") - 150', 'local cols + hardcoded -150');
expectBroken('=SUMIFS($I$20:$I$500,$A$20:$A$500,"יוני")', 'local cols, no תנועות qualifier');

console.log('\n-- Clean formulas that MUST be preserved --');
expectClean('=SUMIFS(\'תנועות\'!C:C,\'תנועות\'!B:B,"2026-05",\'תנועות\'!D:D,"עסק",\'תנועות\'!E:E,"*שיווק*")', 'proper SUMIFS pointing at תנועות');
expectClean('=IFERROR(SUMIFS(\'תנועות\'!C:C,\'תנועות\'!B:B,$B$4&"-05",\'תנועות\'!D:D,"עסק",\'תנועות\'!E:E,"*שיווק*"),0)', 'with IFERROR wrap');
expectClean('=SUM(C9:N9)', 'plain row sum, not a SUMIFS');
expectClean('=B9-B12', 'simple subtraction, no SUMIFS');
expectClean('=IFERROR(B13/B6,0)', 'margin formula');

console.log('\n-- Edge cases --');
expectClean('', 'empty string');
expectClean('1234', 'plain number, no formula');
expectClean(null, 'null');
expectClean(undefined, 'undefined');
expectClean('=2100', 'literal value masquerading as formula');
expectBroken('=SUMIFS(\'תנועות\'!C:C,\'תנועות\'!B:B,"2026-05") + 100', 'good SUMIFS WITH leftover +100 (still broken)');

console.log('\n=== RESULT: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail === 0 ? 0 : 1);
