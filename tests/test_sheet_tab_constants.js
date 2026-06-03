#!/usr/bin/env node
// tests/test_sheet_tab_constants.js
//
// Guards the tab-name centralization (2026-06-03):
//
//   lib/sheet-tabs.js is now the SINGLE SOURCE OF TRUTH for the Hebrew
//   worksheet (tab) names of a Kesefle tenant sheet. Previously these names
//   were duplicated as bare string literals in ~10 files across lib/ + api/
//   (four endpoints each re-declared `const TX_TAB = '<tx>'`, plus inline
//   `'<tx>'!RANGE` A1-notation strings). A silent rename of a tab would have
//   updated some copies and left others stale -> writes to a phantom tab.
//
// This test pins three invariants:
//
//   #1  The values in lib/sheet-tabs.js are BYTE-IDENTICAL (codepoint by
//       codepoint) to the tab names the live Apps Script bot
//       (bot/ExpenseBot_FIXED.gs) writes to. The bot is a separate runtime
//       and cannot import the module, so it keeps its own literals -- this
//       test is what keeps the two runtimes from drifting. If someone renames
//       a tab in one place but not the other, this fails.
//
//   #2  Every file that previously re-declared a local tab literal now has
//       NO local `const <NAME> = '<hebrew tab>'` declaration -- it must import
//       from lib/sheet-tabs.js instead. This locks in the de-duplication so a
//       future edit can't silently reintroduce a divergent copy.
//
//   #3  lib/sheet-writer.js still re-exports the tab constants (backwards
//       compat for the many api/ files that import them from there).
//
// Loads REAL source via fs (the house pattern -- no ESM import, no mocking,
// no secrets/deps needed).
//   Run: node tests/test_sheet_tab_constants.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TABS = fs.readFileSync(path.join(ROOT, 'lib/sheet-tabs.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'lib/sheet-writer.js'), 'utf8');
const BOT = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_FIXED.gs'), 'utf8');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

// Codepoint comparison so a stray bidi/RTL control char or a look-alike can't
// sneak past a == that "looks" equal in a terminal.
function cp(s) { return [...s].map((c) => c.codePointAt(0)).join(','); }
function sameBytes(a, b) { return cp(a) === cp(b); }

// Strip `//` line comments so a comment that merely SHOWS a declaration (e.g.
// the doc header in sheet-tabs.js: `const TX_TAB = '<txTab>'`) can't be
// mistaken for the real one.
function stripLineComments(src) {
  return src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

// Pull the REAL `const NAME = '...'` (or "...") string value out of a source
// file, ignoring any look-alike inside a comment.
function constLiteral(src, name) {
  const re = new RegExp('const\\s+' + name + "\\s*=\\s*(['\"])([^'\"]*)\\1");
  const m = stripLineComments(src).match(re);
  return m ? m[2] : null;
}

console.log('\ntests/test_sheet_tab_constants.js\n');

// ── Source-of-truth values (read out of lib/sheet-tabs.js itself) ────────────
const T = {
  TX_TAB: constLiteral(TABS, 'TX_TAB'),
  ORDERS_TAB: constLiteral(TABS, 'ORDERS_TAB'),
  PERSONAL_DASHBOARD_TAB: constLiteral(TABS, 'PERSONAL_DASHBOARD_TAB'),
  COMPANY_DASHBOARD_TAB: constLiteral(TABS, 'COMPANY_DASHBOARD_TAB'),
  EXTENDED_DASHBOARD_TAB: constLiteral(TABS, 'EXTENDED_DASHBOARD_TAB'),
  GROUP_LEDGER_TAB: constLiteral(TABS, 'GROUP_LEDGER_TAB'),
};

// The known-good values (the historical literals, encoded as \u escapes so
// THIS test file is ASCII-only and itself immune to Hebrew bidi/chat-paste
// corruption -- per the repo's hebrew-encoding-safe-script rule).
const EXPECTED = {
  TX_TAB: 'תנועות',                                   // transactions
  ORDERS_TAB: 'הזמנות',                                // orders
  PERSONAL_DASHBOARD_TAB: 'מאזן אישי',        // personal balance
  COMPANY_DASHBOARD_TAB: 'מאזן חברה',         // company balance
  EXTENDED_DASHBOARD_TAB: 'פירוט מורחב', // extended detail
  GROUP_LEDGER_TAB: 'הוצאות קבוצה', // group expenses
};

console.log('-- source-of-truth values match the locked spec (byte-identical) --');
for (const k of Object.keys(EXPECTED)) {
  assert(T[k] !== null, k + ' is defined in lib/sheet-tabs.js');
  assert(T[k] !== null && sameBytes(T[k], EXPECTED[k]),
    k + ' value is byte-identical to spec (' + JSON.stringify(EXPECTED[k]) + ')');
}

console.log('\n-- bot/ExpenseBot_FIXED.gs (separate runtime) agrees byte-for-byte --');
// The bot defines its own literals: TRANSACTIONS_SHEET + ORDERS_TAB_NAME, and
// uses the dashboard names in many strings. Cross-check the two it declares as
// named constants -- those are its source of truth and the highest-risk drift.
const BOT_TX = constLiteral(BOT, 'TRANSACTIONS_SHEET');
const BOT_ORDERS = constLiteral(BOT, 'ORDERS_TAB_NAME');
assert(BOT_TX !== null && sameBytes(BOT_TX, T.TX_TAB),
  "bot TRANSACTIONS_SHEET === sheet-tabs TX_TAB");
assert(BOT_ORDERS !== null && sameBytes(BOT_ORDERS, T.ORDERS_TAB),
  "bot ORDERS_TAB_NAME === sheet-tabs ORDERS_TAB");
// The dashboard tab names appear in bot user-facing strings -- assert the exact
// byte sequence is present so a rename here would force a bot update too.
assert(BOT.includes(T.PERSONAL_DASHBOARD_TAB),
  'bot references PERSONAL_DASHBOARD_TAB value verbatim');
assert(BOT.includes(T.COMPANY_DASHBOARD_TAB),
  'bot references COMPANY_DASHBOARD_TAB value verbatim');

console.log('\n-- de-duplication is locked: no local tab literal re-declarations --');
// These files USED to re-declare a local `const TX_TAB = '<tx>'` (and
// fix-company-dashboard also COMPANY_TAB). They must now import instead.
const NO_LOCAL_DECL = [
  ['api/sheet/delete-last.js', ['TX_TAB']],
  ['api/sheet/relabel-row.js', ['TX_TAB']],
  ['api/import/bank-csv.js', ['TX_TAB']],
  ['api/sheet/fix-company-dashboard.js', ['TX_TAB']],
];
for (const [rel, names] of NO_LOCAL_DECL) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const n of names) {
    // Fail if a local `const <name> = '<hebrew>'` literal declaration exists.
    const declRe = new RegExp('const\\s+' + n + "\\s*=\\s*['\"][\\u0590-\\u05FF]");
    assert(!declRe.test(src), rel + ' no longer hardcodes ' + n + ' (imports it)');
    // And it must actually import from sheet-tabs.js.
    assert(/from\s+['"][^'"]*lib\/sheet-tabs\.js['"]/.test(src),
      rel + ' imports from lib/sheet-tabs.js');
  }
}

console.log('\n-- no executable inline tab-range literals remain (excl source) --');
// Scan the formerly-offending api files for any inline 'תנועות'!... literal in
// CODE (a quick guard against reintroduction). Comments are allowed to mention
// the tab name; only quoted-then-bang `'<tx>'!` is a real range literal.
const INLINE_SCAN = [
  'api/account.js', 'api/sheet/tax-report.js', 'api/sheet/mark-vat.js',
  'api/sheet/bot-query.js', 'api/sheet/summary.js', 'api/sheet/getExpenses.js',
  'api/sheet/stats.js', 'api/cron/budget-check.js',
];
const txRangeRe = new RegExp("['\"]" + T.TX_TAB + "'!");
for (const rel of INLINE_SCAN) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // Strip // line comments before scanning so a comment mention doesn't trip it.
  const codeOnly = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert(!txRangeRe.test(codeOnly),
    rel + ' has no inline ' + JSON.stringify(T.TX_TAB) + "'! range literal");
}

console.log('\n-- lib/sheet-writer.js still re-exports the constants (compat) --');
assert(/export\s*\{[^}]*\bTX_TAB\b[^}]*\}/.test(SW) || /export\s+\{[\s\S]*TX_TAB[\s\S]*\}/.test(SW),
  'sheet-writer.js re-exports TX_TAB');
assert(/from\s+['"]\.\/sheet-tabs\.js['"]/.test(SW),
  'sheet-writer.js imports the tab names from ./sheet-tabs.js');

console.log('');
if (failures.length) {
  console.error('FAILED ' + failures.length + ' assertion(s):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED (tab-name constants centralized + byte-identical)\n');
process.exit(0);
