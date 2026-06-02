#!/usr/bin/env node
// bot/test_business_dash_tabs.js
//
// Regression test for the shared multi-business dashboard resolver
// _businessDashTabs_(ss, year) added 2026-05-31.
//
// Background: the 3 sites that resolve the company-dashboard tab used to
// hardcode a name list (['מאזן חברה 2026','מאזן חברה'] etc). After Steven
// renamed "מאזן חברה" -> "עסק תמונות" and started adding "עסק 2"/"עסק 3"
// per business, those lookups returned nothing. The shared helper now matches
// ANY tab whose name starts with /^(מאזן חברה|עסק )/ and prefers a tab that
// carries the requested year.
//
// This test loads the REAL helper out of ExpenseBot_FIXED.gs via balanced-
// brace extraction (same pattern as the other bot/test_*.js) and exercises it
// against fake spreadsheet objects that mimic the Apps Script Sheet API
// surface the helper touches (ss.getSheets(), sheet.getName()).

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = SRC.indexOf('{', start), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(start, j);
}

// eslint-disable-next-line no-new-func
const _businessDashTabs_ = new Function(
  extractFn('_businessDashTabs_') + '\nreturn _businessDashTabs_;',
)();

// Minimal fake Sheet + Spreadsheet honoring only what the helper uses.
function fakeSheet(name) {
  return { _name: name, getName: function () { return this._name; } };
}
function fakeSS(names) {
  const sheets = names.map(fakeSheet);
  return { getSheets: function () { return sheets; } };
}
function names(arr) { return arr.map(function (s) { return s.getName(); }); }

const failures = [];
function assertEq(got, want, label) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { console.log('  PASS ' + label); }
  else {
    console.error('  FAIL ' + label);
    console.error('       want=' + b);
    console.error('       got =' + a);
    failures.push(label);
  }
}

// 1. LEGACY case: only the plain "מאזן חברה" tab present -> exactly [it].
{
  const ss = fakeSS(['תנועות', 'מאזן חברה', 'מאזן אישי', 'מאזן שנתי', 'הזמנות']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['מאזן חברה'],
    'plain מאזן חברה returned alone (legacy behavior preserved)');
}

// 2. Renamed tab "עסק תמונות" is matched (the bug that motivated this).
{
  const ss = fakeSS(['תנועות', 'עסק תמונות', 'מאזן אישי', 'הזמנות']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['עסק תמונות'],
    'renamed עסק תמונות is matched');
}

// 3. Multiple businesses "עסק 1"/"עסק 2"/"עסק 3" all returned, original order.
{
  const ss = fakeSS(['תנועות', 'עסק 1', 'עסק 2', 'עסק 3', 'הזמנות']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['עסק 1', 'עסק 2', 'עסק 3'],
    'multi-business עסק 1/2/3 all matched in order');
}

// 4. Year preference: a year-suffixed snapshot is ordered FIRST when that
//    year is requested; the bare live tab follows.
{
  const ss = fakeSS(['מאזן חברה', 'מאזן חברה 2026', 'תנועות']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['מאזן חברה 2026', 'מאזן חברה'],
    'year-suffixed tab preferred (ordered first) when year matches');
}

// 4b. When the requested year does NOT match the suffix, the bare tab keeps
//     its place and the off-year snapshot is NOT promoted ahead of it.
{
  const ss = fakeSS(['מאזן חברה', 'מאזן חברה 2025']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['מאזן חברה', 'מאזן חברה 2025'],
    'off-year snapshot not promoted (stable order, bare first)');
}

// 4c. Year-suffixed renamed business tab is also preferred.
{
  const ss = fakeSS(['עסק תמונות', 'עסק תמונות 2026', 'תנועות']);
  assertEq(names(_businessDashTabs_(ss, 2026)), ['עסק תמונות 2026', 'עסק תמונות'],
    'year-suffixed renamed business tab preferred');
}

// 5. Non-business tabs are NEVER matched. Critically, "עסקים שלי" (the bot's
//    "my businesses" command label) is ONE word -> "עסק" is NOT followed by a
//    space, so the trailing-space anchor in /^עסק / correctly rejects it. The
//    transactions/orders/personal dashboards are likewise excluded.
{
  const ss = fakeSS(['תנועות', 'הזמנות', 'מאזן אישי', 'מאזן שנתי', 'עסקים שלי', 'Settings']);
  assertEq(names(_businessDashTabs_(ss, 2026)), [],
    'no false matches: עסקים/personal/orders/txn all excluded');
}

// 6. No year passed -> still returns all matches (no preference reordering).
{
  const ss = fakeSS(['מאזן חברה 2026', 'מאזן חברה']);
  assertEq(names(_businessDashTabs_(ss)), ['מאזן חברה 2026', 'מאזן חברה'],
    'no-year call returns all matches in original sheet order');
}

// 7. Defensive: null / falsy ss -> [].
{
  assertEq(_businessDashTabs_(null, 2026), [], 'null ss -> []');
  assertEq(_businessDashTabs_(undefined), [], 'undefined ss -> []');
}

console.log('');
if (failures.length) {
  console.error(failures.length + ' check(s) FAILED');
  process.exit(1);
}
console.log('ALL _businessDashTabs_ checks passed');
