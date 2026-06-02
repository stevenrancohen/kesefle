// Classification "dialogues" test — loads the REAL matchCategory family +
// CATEGORY_MAP from ExpenseBot_FIXED.gs and checks realistic Hebrew expense
// messages classify by intent (or fall to DEFAULT so the bot ASKS). Guards
// against substring false-positives. Run: node bot/test_classify.js
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
(0, eval)(fn('_coerceCategoryBySubcategory')); (0, eval)(fn('matchCategory'));

let pass = 0, fail = 0;
// expected: 'DEFAULT' (should ask) | 'sub:X' (subcategory contains X) | category prefix
function check(msg, expected) {
  const r = matchCategory(msg);
  const isDef = r && r.category === DEF.category && r.subcategory === DEF.subcategory;
  let ok, got = (r.category || '') + ' / ' + (r.subcategory || '');
  if (expected === 'DEFAULT') { ok = isDef; got = isDef ? 'DEFAULT' : got; }
  else if (expected.startsWith('sub:')) ok = !isDef && (r.subcategory || '').indexOf(expected.slice(4)) >= 0;
  else ok = !isDef && (r.category || '').indexOf(expected) === 0;
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg.padEnd(26) + ' → ' + got + (ok ? '' : '   (want ' + expected + ')'));
  ok ? pass++ : fail++;
}

console.log('\n── food ──');
['250 סופר','רמי לוי 340','שופרסל 120','ארוחת צהריים 65','מקדונלדס 55','פיצה 80','וולט 90','קפה 18','שווארמה 45','סושי 120','קניות בסופר 400','פלאפל 30','המבורגר 70'].forEach(m => check(m, 'אוכל'));

console.log('\n── transport ──');
['דלק 300','תדלוק 250','אובר 60','חניה 20','דמי חניה 15','רכבת 27','כרטיס אוטובוס 12','נסיעה במונית 50','רב קו 50'].forEach(m => check(m, 'תחבורה'));

console.log('\n── bills & taxes (fixed expenses) ──');
['חשמל 450','חשבון חשמל 450','מים 120','חשבון מים 120','אינטרנט 99','ארנונה 600','מס הכנסה 2000','ביטוח לאומי 500','תשלום מס הכנסה 1500'].forEach(m => check(m, 'הוצאות קבועות'));

console.log('\n── entertainment ──');
['נטפליקס 45','ספוטיפיי 20','קולנוע 80','הופעה 250','יציאה עם חברים 250','ערב עם חברים 180','מסיבה 100','בילוי 120'].forEach(m => check(m, 'בידור'));

console.log('\n── health (intent: בריאות) ──');
['תרופות 60','סופרפארם 85','רופא שיניים 400','מרפאה פרטית 250','בדיקת דם 150'].forEach(m => check(m, 'בריאות'));

console.log('\n── education / shopping / grooming / gifts ──');
['שכר לימוד 5000','גן ילדים 2500','שיעור פרטי 150'].forEach(m => check(m, 'חינוך'));
['זארה 200','אייפון 4000','קניתי נעליים 300','איקאה 800'].forEach(m => check(m, 'קניות'));
check('תספורת 80', 'טיפוח'); check('מספרה 120', 'טיפוח');
check('מתנה ליום הולדת 150', 'מתנות');

console.log('\n── pets (intent: subcategory חיות מחמד) ──');
['וטרינר 350','אוכל לכלב 120'].forEach(m => check(m, 'sub:חיות מחמד'));

console.log('\n── income ──');
check('משכורת 12000', 'הכנס');

console.log('\n── ambiguous → must ASK (DEFAULT) ──');
['250','תשלום 500','העברה 1000','משהו 50','קניתי דברים 100','עוד הוצאה 30','החזר חוב 200','יציאה'].forEach(m => check(m, 'DEFAULT'));

console.log('\n── false-positive regressions (must NOT mis-hit) ──');
check('שמעתי הרצאה', 'DEFAULT');   // 'מע'
check('הוצאה על חברים', 'DEFAULT'); // 'רי'/'בר'
check('תשלומים שונים', 'DEFAULT');  // 'לום' removed

// ─── PR-B (2026-05-28): canonical business subcategories ────────────────────
// After PR-B every business CATEGORY_MAP row emits the EXACT subcategory
// string that the company dashboard SUMIFS literally expects -- so newly
// written business expenses land in מאזן חברה rows 8-11 without going
// through _BIZ_DASH_SUBS fallback. Asserts: matched.category === 'עסק'
// AND matched.subcategory equals one of the 4 canonical buckets (or
// יועצים for the dedicated row, or מחזור for revenue).
function checkBiz(msg, wantCat, wantSub) {
  const r = matchCategory(msg) || {};
  const ok = (r.category === wantCat) && (r.subcategory === wantSub);
  const got = (r.category || '') + ' / ' + (r.subcategory || '');
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg.padEnd(28) + ' → ' + got + (ok ? '' : '   (want ' + wantCat + ' / ' + wantSub + ')'));
  ok ? pass++ : fail++;
}
console.log('\n── PR-B: business CATEGORY_MAP emits canonical subs (no עסק prefix) ──');
// Marketing -> עלות שיווק
checkBiz('marketing 320',          'עסק', 'עלות שיווק');
checkBiz('advertising 500',        'עסק', 'עלות שיווק');
checkBiz('יחסי ציבור 800',         'עסק', 'עלות שיווק');
checkBiz('קמפיין 1200',            'עסק', 'עלות שיווק');
// Raw materials -> עלות חומרי גלם
checkBiz('raw materials 900',      'עסק', 'עלות חומרי גלם');
checkBiz('חומרי גלם 1500',         'עסק', 'עלות חומרי גלם');
checkBiz('סחורה 700',              'עסק', 'עלות חומרי גלם');
checkBiz('מלאי 400',               'עסק', 'עלות חומרי גלם');
// Shipping + install -> משלוחים והתקנות
// (`fedex` alone is multi-meaning -- could be personal mail relocation
// in CATEGORY_MAP line 508; ambiguity is correct product behavior.
// Without `עסק` prefix we assert the business-routed marker words.)
checkBiz('shipping 60',            'עסק', 'משלוחים והתקנות');
checkBiz('courier 80',             'עסק', 'משלוחים והתקנות');
checkBiz('אריזה ומשלוח 90',        'עסק', 'משלוחים והתקנות');
checkBiz('packaging 45',           'עסק', 'משלוחים והתקנות');
// Operations -> הוצאות תפעוליות (includes software/equipment/tax)
checkBiz('operations 200',         'עסק', 'הוצאות תפעוליות');
checkBiz('overhead 300',           'עסק', 'הוצאות תפעוליות');
checkBiz('saas 150',               'עסק', 'הוצאות תפעוליות');
checkBiz('business equipment 800', 'עסק', 'הוצאות תפעוליות');
checkBiz('vat payment 4500',       'עסק', 'הוצאות תפעוליות');
// Consultants -> יועצים (separate dashboard row)
checkBiz('consultant 1000',        'עסק', 'יועצים');
checkBiz('accountant 1500',        'עסק', 'יועצים');
checkBiz('cpa 800',                'עסק', 'יועצים');

// ─── PR-B: _BIZ_DASH_SUBS coverage ──────────────────────────────────────────
// Load _normalizeBizSub_ so we can assert every short-form historical
// subcategory the OLD sheet might contain canonicalizes correctly. This
// is the safety net for migrated rows whose col E was written by an
// earlier bot generation. Steven's data dump (PR-A) will surface any
// short-forms still missing -- we'll grow this table in a follow-up.
globalThis._BIZ_DASH_SUBS = eval('(' + balanced('var _BIZ_DASH_SUBS = {', '{', '}') + ')');
(0, eval)(fn('_normalizeBizSub_'));
console.log('\n── PR-B: _BIZ_DASH_SUBS maps every historical short-form to canonical ──');
function checkNorm(input, wantOut) {
  const got = _normalizeBizSub_(input);
  const ok = got === wantOut;
  console.log((ok ? '  ✅ ' : '  ❌ ') + ('"' + input + '"').padEnd(24) + ' → ' + (got || 'null') + (ok ? '' : '   (want ' + wantOut + ')'));
  ok ? pass++ : fail++;
}
// raw materials family
['חומרי גלם','חומרים','חומר גלם','רכש','מלאי','סחורה'].forEach(s => checkNorm(s, 'עלות חומרי גלם'));
// marketing family
['שיווק','פרסום','קמפיין'].forEach(s => checkNorm(s, 'עלות שיווק'));
// shipping family
['משלוח','משלוחים','אריזה','אריזה ומשלוח','הובלה','התקנה','התקנות'].forEach(s => checkNorm(s, 'משלוחים והתקנות'));
// operations family (software/equipment/tax all roll up here)
['תפעוליות','תפעול','תוכנות','ציוד עסקי','מיסים','אחר','שונות','שונות עסק'].forEach(s => checkNorm(s, 'הוצאות תפעוליות'));
// יועצים stays separate (PR-B override -- was 'הוצאות תפעוליות' pre-fix)
checkNorm('יועצים', 'יועצים');
// already-canonical names are idempotent
['מחזור','עלות חומרי גלם','עלות שיווק','משלוחים והתקנות','הוצאות תפעוליות'].forEach(s => checkNorm(s, s));

// ─── Steven personalized routes (PRs #151-#160 regression guard) ────────────
// Locks in the 6 idiosyncratic category routes Steven added during the
// 2026-05-29 deep-review cycle. Before these PRs every one of these
// expenses silently routed to 'שונות ואחרים' (the bot DEFAULT) and the
// dashboard had no row for them -- Steven's historical-data continuity
// depended on getting them right. A future CATEGORY_MAP reorder/refactor
// could resurrect that silent breakage, so each route is now under test.
// Routes verified against bot/ExpenseBot_FIXED.gs lines 392-413, 431, 696.
console.log('\n── Steven personalized routes (PRs #151-#160 regression guard) ──');
// קולקציות (PR #156) — art canvas / glass collection hobby buys → תחביבים/קולקציות
check('קולקציה 800',           'sub:קולקציות');
check('קולקציות 1200',         'sub:קולקציות');
check('אספנות 200',            'sub:קולקציות');
check('art canvas 320',         'sub:קולקציות');
check('glass collection 400',   'sub:קולקציות');
check('קנבס אומנותי 200',       'sub:קולקציות');
// רוביקון (PRs #151+#154) — Steven's Jeep, under תחבורה
check('רוביקון תיקון 1200',     'sub:רוביקון');
check('דלק לרוביקון 400',       'sub:רוביקון');
check('גיפ רוביקון 800',        'sub:רוביקון');
// חצי איירון מן (PR #156) — race registration under הוצאות זמניות
check('חצי איירון מן הרשמה 1500', 'sub:חצי איירון מן');
check('triathlon registration 800', 'sub:חצי איירון מן');
check('ironman 800',             'sub:חצי איירון מן');
// גיא (PR #156) — Steven's brother, money he forwards on
check('להעביר לגיא 500',         'sub:גיא');
check('תשלום לגיא 300',          'sub:גיא');
check('גיא 200',                 'sub:גיא');
// חצי אוסטריה (PR #156) — Austria race → 'מרוץ - אוסטריה' subcategory
check('חצי אוסטריה רישום 1200',  'sub:אוסטריה');
check('austria race 900',         'sub:אוסטריה');
check('מרוץ אוסטריה 500',         'sub:אוסטריה');
// ארנונה (PR #154) — rolled into the בית subcategory under הוצאות קבועות
check('ארנונה רבעון 1200',       'sub:בית');
check('ארנונה 1200',             'sub:בית');
// חופשות (PR #155) — promoted to its own dashboard row under הוצאות זמניות
check('חופשה משפחתית 5000',      'sub:חופשות');
check('חופשת חורף 3000',         'sub:חופשות');
check('vacation 2000',            'sub:חופשות');
check('נופש 2000',                'sub:חופשות');

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CLASSIFICATION CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
