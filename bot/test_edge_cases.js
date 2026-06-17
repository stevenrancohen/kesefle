// Edge-case regression guard for the bot's classifier. Complements
// bot/test_classify.js by asserting CORNER cases nobody tests today:
//
//   A. "אישי" ordering safety -- the bare keyword on line 427 of
//      ExpenseBot_FIXED.gs could swallow compounds like "אימון אישי",
//      "ביטוח אישי", "מאמן אישי". Today the longer-keyword-first
//      sort in _matchCategory_long (line ~8758) saves most cases,
//      but no test ASSERTS the ordering -- a future CATEGORY_MAP
//      refactor could silently regress. Locks in current behavior.
//
//   B. Ambiguity defaults -- short/vague messages MUST land in
//      DEFAULT_CATEGORY so the bot pops a category picker. A
//      regression that routes ANY of these to a real category =
//      silent misclassification.
//
//   C. Income detection -- the entries on lines 386-389 mark a
//      handful of subcategories with isIncome:true. PR #138 / #140
//      (B1) ensures the isIncome flag propagates to col H so income
//      shows as negative (false) in תנועות. Locks in current behavior
//      so a future entry edit can't silently flip income -> expense.
//
//   D. English business aliases -- PR-B (2026-05-28) added English
//      aliases marketing / shipping / operations / vat payment for
//      cross-language business expense entry. Already in test_classify
//      via checkBiz, but re-asserted here so deleting checkBiz wouldn't
//      lose the coverage.
//
// Run: node bot/test_edge_cases.js
//
// IMPORTANT: Every assertion below was VERIFIED against the bot's
// ACTUAL matchCategory output before being added. Where a test input
// surfaced a real bug (the bare "אישי" eating "ביטוח אישי"), the
// assertion locks in the CURRENT (wrong) behavior with a "BUG:"
// comment and is flagged separately in the PR description, NOT
// patched here -- per the broad-keyword finding in
// docs/AUDIT_BOT_CATEGORY_MAP_2026_05_31.md, fixes need Steven
// approval before shipping.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');
function balanced(marker, open, close) {
  const s = src.indexOf(marker); const i = src.indexOf(open, s);
  let d = 0, j = i; for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
function fn(name) {
  const start = src.indexOf('function ' + name + '('); let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i; for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
globalThis.CATEGORY_MAP = eval(balanced('const CATEGORY_MAP = [', '[', ']'));
globalThis.BUSINESS_CATEGORY_MAP = eval('(' + balanced('var BUSINESS_CATEGORY_MAP = {', '{', '}') + ')');
globalThis.DEFAULT_CATEGORY = eval('(' + balanced('const DEFAULT_CATEGORY =', '{', '}') + ')');
const DEF = globalThis.DEFAULT_CATEGORY;
(0, eval)(fn('_kflIsWordChar_')); (0, eval)(fn('_kflKwHit_'));
(0, eval)(fn('_matchCategory_orig')); (0, eval)(fn('_matchCategory_long'));
(0, eval)(fn('_coerceCategoryBySubcategory')); (0, eval)(fn('_kflBizOpHit_')); (0, eval)(fn('matchCategory'));

let pass = 0, fail = 0;
// expected: 'DEFAULT' | 'sub:X' (subcategory contains X) | category prefix
function check(msg, expected) {
  const r = matchCategory(msg);
  const isDef = r && r.category === DEF.category && r.subcategory === DEF.subcategory;
  let ok, got = (r.category || '') + ' / ' + (r.subcategory || '');
  if (expected === 'DEFAULT') { ok = isDef; got = isDef ? 'DEFAULT' : got; }
  else if (expected.startsWith('sub:')) ok = !isDef && (r.subcategory || '').indexOf(expected.slice(4)) >= 0;
  else ok = !isDef && (r.category || '').indexOf(expected) === 0;
  console.log((ok ? '  PASS ' : '  FAIL ') + msg.padEnd(30) + ' -> ' + got + (ok ? '' : '   (want ' + expected + ')'));
  ok ? pass++ : fail++;
}
// Strict: assert NOT the שונות ואחרים/אישי dump. Used by Section A so
// any compound containing "אישי" that lands in the dump is flagged.
function checkNotPersonalDump(msg) {
  const r = matchCategory(msg) || {};
  const got = (r.category || '') + ' / ' + (r.subcategory || '');
  const ok = !(r.category === 'שונות ואחרים' && r.subcategory === 'אישי');
  console.log((ok ? '  PASS ' : '  FAIL ') + msg.padEnd(30) + ' -> ' + got + (ok ? '' : '   (BUG: bare "אישי" eating compound)'));
  ok ? pass++ : fail++;
}

// ─── Section A: "אישי" ordering safety ──────────────────────────────────────
// The bare "אישי" keyword at line 427 of ExpenseBot_FIXED.gs routes to
// "שונות ואחרים / אישי". The longer-keyword-first sort in
// _matchCategory_long means specific compounds like "אימון אישי" (10 chars)
// should beat bare "אישי" (4 chars). VERIFIED against the actual bot
// output -- 4 of 5 compounds DO route correctly, one is a known bug
// flagged in the PR description.
console.log('\n-- Section A: "אישי" ordering safety (compounds must beat bare "אישי") --');
// "אימון אישי" is a line-317 keyword -> בריאות/ספורט ותוספים. Correct.
check('אימון אישי 200',           'sub:ספורט');
// "מאמן אישי" is a line-317 keyword -> בריאות/ספורט ותוספים. Correct.
check('מאמן אישי 300',            'sub:ספורט');
// "מטפלת" routes to חינוך וילדים/חינוך וטיפול (NOT to the personal dump).
// The point of this assertion is that the compound "מטפלת אישית" does NOT
// fall into bare "אישי". Locks in current correct behavior.
checkNotPersonalDump('מטפלת אישית 150');
// "ביטוח אישי" subcategory exists (line 448) but its KEYWORDS are insurer
// names (הראל, מגדל, ...) -- the literal phrase "ביטוח אישי" is NOT a
// keyword. So today "ביטוח אישי 500" matches bare "אישי" and routes to
// the personal dump. This is the documented broad-keyword bug. The
// assertion below LOCKS IN that wrong behavior so a future fix is
// visible in the diff -- the PR description flags this as the real
// bug the suite surfaced. checkBiz-style ('sub:אישי') would also work,
// but using check on the full subcategory is more explicit.
check('ביטוח אישי 500',           'sub:אישי');  // BUG: should be ביטוח אישי (insurance)
// "הוצאה אישית" arguably IS personal (no specific category), so routing
// to "שונות ואחרים / אישי" is acceptable. Locks in current behavior.
check('הוצאה אישית 100',          'sub:אישי');

// ─── Section B: Ambiguity defaults (MUST fall to DEFAULT so bot asks) ───────
// These mirror the existing block in test_classify.js line 67. Re-asserted
// here so a single "delete this block" mistake in test_classify can't
// erase the coverage. If ANY of these starts matching a real category,
// the bot will silently misclassify and skip the picker.
console.log('\n-- Section B: Ambiguity defaults (must fall to DEFAULT) --');
check('250',                       'DEFAULT');
check('תשלום 500',                 'DEFAULT');
check('העברה 1000',                'DEFAULT');
check('החזר חוב 200',              'DEFAULT');
check('משהו 50',                   'DEFAULT');
check('יציאה',                     'DEFAULT');
check('קניתי דברים 100',           'DEFAULT');
check('עוד הוצאה 30',              'DEFAULT');

// ─── Section C: Income detection (lines 386-389, isIncome:true) ─────────────
// matchCategory DOES recognize income for the explicit keyword lists in
// CATEGORY_MAP. The richer _detectIncomeIntent_ pre-filter ("קיבלתי",
// "+500", "נכנס לי") lives in matchCategorySmart, NOT matchCategory --
// so messages like "קיבלתי 5000 מעבודה" or bare "הכנסה 8000" fall to
// DEFAULT under matchCategory. The asserted behavior below mirrors what
// matchCategory actually returns today.
//
// PR #138/#140 (B1): isIncome flag must propagate from CATEGORY_MAP to
// col H -- "עסק הכנסה 10000" routed to "הכנסה 2 -- עסק" but col H
// was hardcoded TRUE (expense), silently flipping income to expense.
// Asserting the category match keeps the income vocabulary alive.
console.log('\n-- Section C: Income detection (matchCategory level) --');
// "משכורת" -> הכנסות / הכנסה 1 -- משכורת (line 386). The flagship.
check('משכורת 12000',              'הכנס');
// "הכנסה עסקית" -> הכנסות / הכנסה 2 -- עסק (line 387). PR #138/#140 fix.
check('הכנסה עסקית 8000',          'הכנס');
// "הכנסה נוספת" -> הכנסות / הכנסה 3 -- נוסף (line 388).
check('הכנסה נוספת 5000',          'הכנס');
// "בונוס" -> הכנסות / שונות (הכנסות) (line 389).
check('בונוס 1500',                'הכנס');
// "תקבול" -> הכנסות / שונות (הכנסות) (line 389).
check('תקבול 700',                 'הכנס');

// ─── Section D: English business aliases (PR-B 2026-05-28) ──────────────────
// PR-B added English business aliases so a bilingual user can type
// "marketing 320" and have it land in מאזן חברה row 8 just like
// "שיווק 320" would. checkBiz in test_classify.js already asserts these,
// but losing that block would silently lose the coverage. Re-assert here.
console.log('\n-- Section D: English business aliases (PR-B 2026-05-28) --');
function checkBiz(msg, wantCat, wantSub) {
  const r = matchCategory(msg) || {};
  const ok = (r.category === wantCat) && (r.subcategory === wantSub);
  const got = (r.category || '') + ' / ' + (r.subcategory || '');
  console.log((ok ? '  PASS ' : '  FAIL ') + msg.padEnd(30) + ' -> ' + got + (ok ? '' : '   (want ' + wantCat + ' / ' + wantSub + ')'));
  ok ? pass++ : fail++;
}
checkBiz('marketing 320',          'עסק', 'עלות שיווק');
checkBiz('raw materials 800',      'עסק', 'עלות חומרי גלם');
checkBiz('shipping 60',            'עסק', 'משלוחים והתקנות');
checkBiz('operations 200',         'עסק', 'הוצאות תפעוליות');
checkBiz('vat payment 4500',       'עסק', 'הוצאות תפעוליות');

console.log('\n' + (fail === 0 ? 'PASS: ALL ' + pass + ' EDGE-CASE CHECKS PASSED' : 'FAIL: ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
