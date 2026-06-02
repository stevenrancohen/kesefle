// tests/test_taxonomy_normalize.js
//
// Guards the two "disappearing money" root-cause fixes (2026-06-02):
//
//   #1  Every subcategory the classifier can emit (CATEGORY_MAP +
//       BUSINESS_CATEGORY_MAP) must, after normalizeSubcategoryForDashboard /
//       _normalizeSubForDashboard_, land on a row that ACTUALLY EXISTS in the
//       personal (מאזן אישי) OR company (מאזן חברה) template -- otherwise the
//       SUMIFS misses it and the amount is invisible on the dashboard.
//
//   #2  Every business ("עסק") expense sub the bot now emits must match
//       EXACTLY ONE company-dashboard expense row (no zero, no double-count),
//       and the operating-costs row must catch the canonical ops vocabulary
//       ("הוצאות תפעוליות" / "יועצים" / "קולקציות").
//
// Also asserts the lib/sheet-writer.js (Vercel) and bot/ExpenseBot_FIXED.gs
// (Apps Script) normalizers agree cell-for-cell, since they are hand-mirrored.
//
// Loads the REAL source via balanced-brace extraction (the house pattern -- no
// mocking framework, no ESM import so no secrets/deps needed).
//   Run: node tests/test_taxonomy_normalize.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'lib/sheet-writer.js'), 'utf8');
const BOT = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_FIXED.gs'), 'utf8');

// ── balanced-brace helpers ──────────────────────────────────────────────────
function balanced(src, marker, open, close) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('marker not found: ' + marker);
  const i = src.indexOf(open, s);
  let d = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === open) d++;
    else if (src[j] === close) { d--; if (!d) { j++; break; } }
  }
  return src.slice(i, j);
}
function fnSrc(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
// Pull an `export function NAME` body and strip the `export ` so it evals as a
// plain declaration into the current scope.
function exportedFnSrc(src, name) {
  return fnSrc(src, name); // `function NAME` substring still matches after `export `
}

// ── load classifier outputs from the bot ────────────────────────────────────
const CATEGORY_MAP = eval(balanced(BOT, 'const CATEGORY_MAP = [', '[', ']'));
const BUSINESS_CATEGORY_MAP = eval('(' + balanced(BOT, 'var BUSINESS_CATEGORY_MAP = {', '{', '}') + ')');

// ── load the JS-side (sheet-writer) normalizer + its data ───────────────────
const BIZ_SUB_TO_DASHBOARD_ROW = eval('(' + balanced(SW, 'const BIZ_SUB_TO_DASHBOARD_ROW = {', '{', '}') + ')');
const SUB_TO_DASHBOARD_ROW = eval('(' + balanced(SW, 'const SUB_TO_DASHBOARD_ROW = {', '{', '}') + ')');
const PERSONAL_INCOME_ROWS = eval(balanced(SW, 'const PERSONAL_INCOME_ROWS = [', '[', ']'));
const PERSONAL_FIXED_ROWS = eval(balanced(SW, 'const PERSONAL_FIXED_ROWS = [', '[', ']'));
const PERSONAL_VARIABLE_ROWS = eval(balanced(SW, 'const PERSONAL_VARIABLE_ROWS = [', '[', ']'));
const PERSONAL_FOOD_ROWS = eval(balanced(SW, 'const PERSONAL_FOOD_ROWS = [', '[', ']'));
const PERSONAL_TRANSPORT_ROWS = eval(balanced(SW, 'const PERSONAL_TRANSPORT_ROWS = [', '[', ']'));
const PERSONAL_MISC_ROWS = eval(balanced(SW, 'const PERSONAL_MISC_ROWS = [', '[', ']'));
const _PERSONAL_DASH_ROWS = [].concat(
  PERSONAL_INCOME_ROWS, PERSONAL_FIXED_ROWS, PERSONAL_VARIABLE_ROWS,
  PERSONAL_FOOD_ROWS, PERSONAL_TRANSPORT_ROWS, PERSONAL_MISC_ROWS
);
const COMPANY_EXPENSE_ROWS = eval(balanced(SW, 'const COMPANY_EXPENSE_ROWS = [', '[', ']'));
// The normalizers reference their data via free (module-scope) identifiers; a
// `(0, eval)`-loaded function runs in GLOBAL scope, so publish the data on
// globalThis first, then eval the function bodies.
globalThis.BIZ_SUB_TO_DASHBOARD_ROW = eval('(' + balanced(SW, 'const BIZ_SUB_TO_DASHBOARD_ROW = {', '{', '}') + ')');
globalThis.SUB_TO_DASHBOARD_ROW = eval('(' + balanced(SW, 'const SUB_TO_DASHBOARD_ROW = {', '{', '}') + ')');
globalThis._PERSONAL_DASH_ROWS = _PERSONAL_DASH_ROWS;
(0, eval)('globalThis.normalizeSubcategoryForDashboard = ' + exportedFnSrc(SW, 'normalizeSubcategoryForDashboard').replace(/^export\s+/, ''));
const normalizeSubcategoryForDashboard = globalThis.normalizeSubcategoryForDashboard;

// ── load the bot-side normalizer + its data ─────────────────────────────────
globalThis._BIZ_DASH_SUBS = eval('(' + balanced(BOT, 'var _BIZ_DASH_SUBS = {', '{', '}') + ')');
globalThis._KFL_PERSONAL_DASH_ROWS = eval(balanced(BOT, 'var _KFL_PERSONAL_DASH_ROWS = [', '[', ']'));
globalThis._KFL_SUB_TO_DASHBOARD_ROW = eval('(' + balanced(BOT, 'var _KFL_SUB_TO_DASHBOARD_ROW = {', '{', '}') + ')');
(0, eval)('globalThis._normalizeSubForDashboard_ = ' + fnSrc(BOT, '_normalizeSubForDashboard_').replace(/^function\s+_normalizeSubForDashboard_/, 'function'));
const _normalizeSubForDashboard_ = globalThis._normalizeSubForDashboard_;

// ── valid-row sets ──────────────────────────────────────────────────────────
// Personal rows are wildcard-matched ("*"&row&"*" on col E): a written value V
// is visible iff some personal row label is a SUBSTRING of V.
const PERSONAL_ROW_SET = new Set(_PERSONAL_DASH_ROWS);
// Company expense rows + the revenue bucket "מחזור" (revenue comes from הזמנות,
// but "מחזור" is still a legitimate canonical col-E value for income rows).
const COMPANY_CANON = new Set(['מחזור', 'עלות חומרי גלם', 'עלות שיווק', 'משלוחים והתקנות', 'הוצאות תפעוליות', 'יועצים']);

// Google-Sheets text criterion matcher: leading/trailing/inner "*" => wildcard,
// "?" => single char. Criterion without wildcards is an EXACT (full-string)
// match (that is how SUMIFS treats a plain string criterion).
function gsCriterionMatches(criterion, value) {
  const c = String(criterion);
  const v = String(value);
  const rx = new RegExp('^' + c.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return rx.test(v);
}
// Which of the 4 company EXPENSE rows match this col-E value? (Returns labels.)
function companyRowsMatching(value) {
  return COMPANY_EXPENSE_ROWS.filter(function (row) {
    const crits = Array.isArray(row.criteria) ? row.criteria : [];
    return crits.some(function (cr) { return gsCriterionMatches(cr, value); });
  }).map(function (r) { return r.label; });
}

// A normalized PERSONAL col-E value is "visible" iff some personal row label is
// a substring of it (the dashboard wildcard would sweep it up).
function personalVisible(value) {
  return _PERSONAL_DASH_ROWS.some(function (r) { return String(value).indexOf(r) >= 0; });
}

// ── collect every (sub, isBusiness) the classifier can emit ─────────────────
const personalSubs = new Set(); // non-business subcategories
const businessSubs = new Set(); // business ("עסק") subcategories
for (const e of CATEGORY_MAP) {
  if (!e || !e.subcategory) continue;
  if (e.category === 'עסק') businessSubs.add(e.subcategory);
  else personalSubs.add(e.subcategory);
}
for (const cat in BUSINESS_CATEGORY_MAP) {
  for (const sub in BUSINESS_CATEGORY_MAP[cat]) businessSubs.add(sub);
}

// ── run the suite ───────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}

console.log('\n══ ROOT CAUSE #1 — every classifier sub maps to a REAL dashboard row ══');
console.log('   personal subs: ' + personalSubs.size + ' | business subs: ' + businessSubs.size);

// 1a. Personal subs (col D != "עסק"): normalized value must be visible on מאזן
//     אישי -- i.e. its target is a personal row OR contains a personal row.
for (const sub of personalSubs) {
  const out = normalizeSubcategoryForDashboard(sub, 'אישי');
  ok('personal sub maps to a מאזן-אישי row: ' + JSON.stringify(sub) + ' -> ' + JSON.stringify(out),
     PERSONAL_ROW_SET.has(out) || personalVisible(out));
}

// 1b. Business subs (col D = "עסק"): normalized value must be one of the
//     canonical מאזן-חברה buckets.
for (const sub of businessSubs) {
  const out = normalizeSubcategoryForDashboard(sub, 'עסק');
  ok('business sub maps to a מאזן-חברה bucket: ' + JSON.stringify(sub) + ' -> ' + JSON.stringify(out),
     COMPANY_CANON.has(out));
}

console.log('   ✅ #1: ' + (personalSubs.size + businessSubs.size) + ' subs checked, ' + fail + ' invisible');

console.log('\n══ ROOT CAUSE #2 — every business expense sub hits EXACTLY ONE opex/company row ══');
let bizExpenseChecked = 0;
for (const sub of businessSubs) {
  const out = normalizeSubcategoryForDashboard(sub, 'עסק');
  if (out === 'מחזור') continue; // revenue, not an expense row
  bizExpenseChecked++;
  const rows = companyRowsMatching(out);
  ok('business expense sub matches exactly one company row: ' + JSON.stringify(sub) +
     ' -> ' + JSON.stringify(out) + ' matched=' + JSON.stringify(rows),
     rows.length === 1);
}
console.log('   business EXPENSE subs checked (excl. revenue): ' + bizExpenseChecked);

// 2b. The specific canonical ops strings must land in the operating-costs row.
const OPEX_LABEL = '🏢 הוצאות תפעוליות';
['הוצאות תפעוליות', 'יועצים', 'קולקציות', 'תוכנות', 'ייעוץ עסקי', 'רואה חשבון', 'יועץ מס'].forEach(function (v) {
  const rows = companyRowsMatching(v);
  ok('ops vocabulary "' + v + '" matches ONLY the opex row', rows.length === 1 && rows[0] === OPEX_LABEL);
});

// 2c. The legacy/canonical strings for the other three rows still match their
//     own row exactly one (no regression from widening the opex criteria).
[['חומרי גלם', '🎨 עלות חומרי גלם'], ['עלות חומרי גלם', '🎨 עלות חומרי גלם'],
 ['שיווק', '📣 עלות שיווק'], ['עלות שיווק', '📣 עלות שיווק'],
 ['משלוח', '🚚 משלוחים והתקנות'], ['אריזה', '🚚 משלוחים והתקנות'], ['משלוחים והתקנות', '🚚 משלוחים והתקנות'],
].forEach(function (pair) {
  const rows = companyRowsMatching(pair[0]);
  ok('"' + pair[0] + '" matches ONLY ' + pair[1], rows.length === 1 && rows[0] === pair[1]);
});

console.log('\n══ PARITY — sheet-writer.js and ExpenseBot_FIXED.gs normalizers agree ══');
const allSubs = [];
for (const s of personalSubs) allSubs.push([s, 'אישי']);
for (const s of personalSubs) allSubs.push([s, 'שונות ואחרים']);
for (const s of businessSubs) allSubs.push([s, 'עסק']);
// a few literal edge cases
[['', 'אישי'], ['  אוכל בחוץ  ', 'אוכל'], ['סופר', 'אוכל'], ['אוכל לבית — דגים', 'אוכל']].forEach(function (c) { allSubs.push(c); });
let parityChecked = 0;
for (const [s, c] of allSubs) {
  const a = normalizeSubcategoryForDashboard(s, c);
  const b = _normalizeSubForDashboard_(s, c);
  parityChecked++;
  ok('parity ' + JSON.stringify(s) + ' [' + c + ']: JS=' + JSON.stringify(a) + ' BOT=' + JSON.stringify(b), a === b);
}
console.log('   parity pairs checked: ' + parityChecked);

console.log('\n══ idempotence — normalizing a canonical value is a no-op ══');
_PERSONAL_DASH_ROWS.forEach(function (r) {
  ok('personal row idempotent: ' + JSON.stringify(r), normalizeSubcategoryForDashboard(r, 'אישי') === r);
});
['מחזור', 'עלות חומרי גלם', 'עלות שיווק', 'משלוחים והתקנות', 'הוצאות תפעוליות', 'יועצים'].forEach(function (r) {
  ok('company bucket idempotent: ' + JSON.stringify(r), normalizeSubcategoryForDashboard(r, 'עסק') === r);
});

console.log('\n──────────────────────────────────────────────');
console.log((fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + '  —  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFailures:'); fails.slice(0, 40).forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
