// Classification test — loads the REAL matchCategory family + CATEGORY_MAP from
// ExpenseBot_FIXED.gs and checks realistic Hebrew expense messages classify
// correctly (or fall to DEFAULT so the bot ASKS). Guards against the
// short-keyword substring false-positives that caused misclassification.
//   node bot/test_classify.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');

function balanced(marker, open, close) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('not found: ' + marker);
  const i = src.indexOf(open, s);
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close) { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

globalThis.CATEGORY_MAP = eval(balanced('const CATEGORY_MAP = [', '[', ']'));
globalThis.BUSINESS_CATEGORY_MAP = eval('(' + balanced('var BUSINESS_CATEGORY_MAP = {', '{', '}') + ')');
globalThis.DEFAULT_CATEGORY = eval('(' + balanced('const DEFAULT_CATEGORY =', '{', '}') + ')');
const DEFAULT_CATEGORY = globalThis.DEFAULT_CATEGORY;
(0, eval)(fn('_matchCategory_orig'));
(0, eval)(fn('_matchCategory_long'));
(0, eval)(fn('_coerceCategoryBySubcategory'));
(0, eval)(fn('matchCategory'));

let pass = 0, fail = 0;
// expected: a category string, or 'DEFAULT' meaning it should fall through to ask/LLM
function check(msg, expected) {
  const r = matchCategory(msg);
  const isDefault = r && r.category === DEFAULT_CATEGORY.category && r.subcategory === DEFAULT_CATEGORY.subcategory;
  const got = isDefault ? 'DEFAULT' : r.category;
  const ok = got === expected;
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg.padEnd(24) + ' → ' + got + (ok ? '' : '   (expected ' + expected + ')'));
  ok ? pass++ : fail++;
}

console.log('\n── reported bugs (must be fixed) ──');
check('יציאה עם חברים', 'בידור');
check('ערב עם חברים', 'בידור');
check('תשלום מס הכנסה', 'הוצאות קבועות');
check('מס הכנסה', 'הוצאות קבועות');

console.log('\n── everyday expenses classify correctly ──');
check('245 סופר', 'אוכל');
check('42 קפה', 'אוכל');
check('משלוח אוכל', 'אוכל');
check('קניות בסופר', 'אוכל');
check('תדלוק', 'תחבורה');
check('דמי חניה', 'תחבורה');
check('נסיעה במונית', 'תחבורה');
check('כרטיס אוטובוס', 'תחבורה');
check('חשבון חשמל', 'הוצאות קבועות');
check('חשבון מים', 'הוצאות קבועות');
check('גן ילדים', 'חינוך');
check('שיעור פרטי', 'חינוך');
check('מתנה ליום הולדת', 'מתנות');
check('אוכל לכלב', 'חיות מחמד');
check('רופא שיניים', 'בריאות');
check('בית מרקחת', 'בריאות');
check('מסיבה', 'בידור');
check('הופעה', 'בידור');

console.log('\n── ambiguous → must fall to DEFAULT so the bot ASKS ──');
check('יציאה', 'DEFAULT');
check('העברה לחבר', 'DEFAULT');
check('קניתי משהו', 'DEFAULT');

console.log('\n── short-keyword false-positive regressions (must NOT mis-hit) ──');
check('קניתי דברים', 'DEFAULT');      // used to hit 'רי' → bakeries
check('הוצאה על חברים', 'DEFAULT');   // 'חברים' alone is ambiguous → should ask (no longer bakeries)
check('שמעתי הרצאה', 'DEFAULT');      // used to hit 'מע' → taxes
check('עוד הוצאה קטנה', 'DEFAULT');   // 'עוד' is a common word

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CLASSIFICATION CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
