// bot/test_classifier_primitives.js
//
// Unit coverage for the CLASSIFIER's load-bearing primitives in
// bot/ExpenseBot_FIXED.gs. The existing bot/test_classify.js exercises the
// high-level matchCategory() end to end on Hebrew sentences; this suite drills
// the lower layer those results depend on and that nothing else tests directly:
//
//   * _kflKwHit_ / _kflIsWordChar_ — the word-boundary keyword matcher. This is
//     THE precision guard: short (<=3 char) keywords must match as whole words
//     so "מים" (water) does not false-positive inside "תשלומים" (payments) and
//     "קפה" (coffee) does not fire inside "מקפה". Long keywords (brand names)
//     match as substrings so Hebrew prefixes ("בשופרסל") still hit.
//   * parseAmountAndDescription / _parseIsraeliNumber_ — amount extraction +
//     the Israeli thousands-vs-decimal-comma disambiguation, the phone-number
//     guard, currency-word stripping, multi-amount "100+50" split, and the
//     drop-non-positive rule. The amount feeds col C of the תנועות row, so a
//     misparse writes the wrong number to the sheet.
//   * _coerceCategoryBySubcategory — keeps col D (top category) consistent with
//     col E (subcategory) for the food family so dashboard SUMIFS bucket right.
//
// House pattern: balanced-brace extraction of the REAL source, eval into scope,
// no mocking framework, no network/secret access. Hebrew fixtures are written
// as \u escapes so the file is pure ASCII (no bidi marks / paste corruption).
//   Run: node bot/test_classifier_primitives.js

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');

// ── balanced-brace function extractor (handles destructuring param lists) ──
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}
function objLiteral(marker) {
  const s = src.indexOf(marker);
  if (s < 0) throw new Error('marker not found: ' + marker);
  const i = src.indexOf('{', s);
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}

// ── load REAL source into scope ──
const _CANONICAL_CAT_BY_SUB = eval('(' + objLiteral('var _CANONICAL_CAT_BY_SUB = {') + ')');
globalThis._CANONICAL_CAT_BY_SUB = _CANONICAL_CAT_BY_SUB;
(0, eval)(fn('_kflIsWordChar_'));
(0, eval)(fn('_kflKwHit_'));
(0, eval)(fn('_parseIsraeliNumber_'));
(0, eval)(fn('parseAmountAndDescription'));
(0, eval)(fn('_coerceCategoryBySubcategory'));

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}
function eq(label, got, want) { ok(label + ' (got ' + JSON.stringify(got) + ')', got === want); }

// ── Hebrew fixtures (\u escapes; ASCII-only file) ──
const MAYIM      = 'מים';                                          // water (short kw)
const TASHLUMIM  = 'תשלומים';                  // payments (contains מים)
const KAFE       = 'קפה';                                          // coffee (3-char kw)
const MIKAFE     = 'מקפה';                                    // contains קפה
const SHATITI_KAFE = 'שתיתי קפה';        // "I drank coffee"
const KAFE_PUNCT = 'קפה!';                                         // coffee!
const KAFE_DIGIT = 'קפה3';                                         // coffee3
const SHUFERSAL  = 'שופרסל';                        // Shufersal (6-char brand)
const BSHUFERSAL = 'בשופרסל';                  // "at Shufersal" (Hebrew prefix)
const SUPER      = 'סופר';                                    // super
const RENT       = 'שכירות';                        // rent
const OCHEL      = 'אוכל';                                    // food
const SHALOM     = 'שלום';                                    // hello (no amount)
const NO_DETAIL  = 'ללא פירוט';          // "ללא פירוט" fallback note
const OCHEL_LABAYIT = 'אוכל לבית';        // food-at-home (a canonical sub)

// ── 1. _kflIsWordChar_ ──
console.log('\n== 1. _kflIsWordChar_ ==');
ok('Hebrew letter is a word char', _kflIsWordChar_(MAYIM.charAt(0)) === true);
ok('latin letter is a word char', _kflIsWordChar_('a') === true);
ok('digit is a word char', _kflIsWordChar_('7') === true);
ok('space is NOT a word char', _kflIsWordChar_(' ') === false);
ok('punctuation "!" is NOT a word char', _kflIsWordChar_('!') === false);
ok('empty / undefined is NOT a word char', _kflIsWordChar_('') === false && _kflIsWordChar_(undefined) === false);

// ── 2. _kflKwHit_ : short keyword = whole-word (the precision guard) ──
console.log('\n== 2. _kflKwHit_ short keyword (<=3) whole-word matching ==');
ok('short kw matches an exact whole word ("מים" in "מים")', _kflKwHit_(MAYIM, MAYIM) === true);
ok('short kw does NOT match inside a longer word ("מים" in "תשלומים")', _kflKwHit_(TASHLUMIM, MAYIM) === false);
ok('3-char kw matches exact ("קפה" in "קפה")', _kflKwHit_(KAFE, KAFE) === true);
ok('3-char kw does NOT match inside a word ("קפה" in "מקפה")', _kflKwHit_(MIKAFE, KAFE) === false);
ok('short kw matches at end of a space-separated phrase', _kflKwHit_(SHATITI_KAFE, KAFE) === true);
ok('short kw matches when followed by punctuation ("קפה!")', _kflKwHit_(KAFE_PUNCT, KAFE) === true);
ok('short kw does NOT match when followed by a digit ("קפה3")', _kflKwHit_(KAFE_DIGIT, KAFE) === false);

console.log('\n== 2b. _kflKwHit_ long keyword (>3) substring matching ==');
ok('long brand kw matches exact ("שופרסל")', _kflKwHit_(SHUFERSAL, SHUFERSAL) === true);
ok('long brand kw matches with a Hebrew prefix ("בשופרסל")', _kflKwHit_(BSHUFERSAL, SHUFERSAL) === true);

console.log('\n== 2c. _kflKwHit_ degenerate inputs ==');
ok('empty text never hits', _kflKwHit_('', KAFE) === false);
ok('empty keyword never hits', _kflKwHit_(KAFE, '') === false);
ok('null keyword never hits', _kflKwHit_(KAFE, null) === false);

// ── 3. _parseIsraeliNumber_ : thousands vs decimal comma ──
console.log('\n== 3. _parseIsraeliNumber_ ==');
eq('plain integer', _parseIsraeliNumber_('245'), 245);
eq('thousands comma "1,200" -> 1200', _parseIsraeliNumber_('1,200'), 1200);
eq('multi-group thousands "1,234,567"', _parseIsraeliNumber_('1,234,567'), 1234567);
eq('decimal comma "12,5" -> 12.5', _parseIsraeliNumber_('12,5'), 12.5);
eq('period decimal "99.90" -> 99.9', _parseIsraeliNumber_('99.90'), 99.9);
eq('period present: commas treated as thousands ("1,234.56")', _parseIsraeliNumber_('1,234.56'), 1234.56);
ok('blank -> NaN', Number.isNaN(_parseIsraeliNumber_('')));
ok('null -> NaN', Number.isNaN(_parseIsraeliNumber_(null)));

// ── 4. parseAmountAndDescription : amount + clean note ──
console.log('\n== 4. parseAmountAndDescription ==');
function one(text) { const r = parseAmountAndDescription(text); return r && r.items && r.items.length === 1 ? r.items[0] : null; }
let it = one('245 ' + SUPER);
ok('"245 <super>" -> amount 245', it && it.amount === 245);
ok('"245 <super>" -> description is the word only (digits stripped)', it && it.description === SUPER);
it = one('1,200 ' + RENT);
ok('thousands amount "1,200 <rent>" -> 1200', it && it.amount === 1200);
it = one('12,5 ' + KAFE);
ok('decimal-comma "12,5 <kafe>" -> 12.5', it && it.amount === 12.5);
// currency words + symbol stripped from the note
it = one('50 שח ' + KAFE);   // "50 שח קפה"
ok('"50 <shach> <kafe>" -> amount 50', it && it.amount === 50);
ok('currency word "שח" stripped from description', it && it.description === KAFE);
it = one('₪50 ' + KAFE);          // "₪50 קפה"
ok('shekel-sign "₪50 <kafe>" -> amount 50, note "<kafe>"', it && it.amount === 50 && it.description === KAFE);
// originalText preserved verbatim for the cell-note path
ok('originalText preserves the exact raw input', one('245 ' + SUPER).originalText === '245 ' + SUPER);

console.log('\n== 4b. parseAmountAndDescription edge cases ==');
ok('no number at all ("שלום") -> null', parseAmountAndDescription(SHALOM) === null);
ok('empty string -> null', parseAmountAndDescription('') === null);
ok('null input -> null', parseAmountAndDescription(null) === null);
ok('zero amount ("0 <kafe>") -> null (non-positive dropped)', parseAmountAndDescription('0 ' + KAFE) === null);
// amount-only (number with no words) -> falls back to the ללא פירוט note
let amtOnly = one('50');
ok('"50" alone -> amount 50 with "ללא פירוט" note', amtOnly && amtOnly.amount === 50 && amtOnly.description === NO_DETAIL);
// phone-number guard: a dashed mobile is stripped, leaving no amount -> null
ok('phone "050-1234567 <text>" is NOT parsed as an amount (guard)', parseAmountAndDescription('050-1234567 דמי') === null);

console.log('\n== 4c. multi-amount "+" split ==');
const multi = parseAmountAndDescription('100+50 ' + OCHEL);
ok('"100+50 <ochel>" yields two items', multi && multi.items && multi.items.length === 2);
ok('first item amount 100', multi && multi.items[0].amount === 100);
ok('second item amount 50', multi && multi.items[1].amount === 50);
ok('both items share the cleaned description', multi && multi.items[0].description === OCHEL && multi.items[1].description === OCHEL);

// ── 5. _coerceCategoryBySubcategory : keep col D consistent with col E ──
console.log('\n== 5. _coerceCategoryBySubcategory ==');
// A food-family subcategory must force the top category to the food top, so the
// personal dashboard's category-level SUMIFS buckets it correctly.
const FOOD_TOP = _CANONICAL_CAT_BY_SUB[OCHEL_LABAYIT]; // 'אוכל'
ok('fixture sanity: "אוכל לבית" maps to the food top in _CANONICAL_CAT_BY_SUB', typeof FOOD_TOP === 'string' && FOOD_TOP.length > 0);
let coerced = _coerceCategoryBySubcategory({ category: 'WRONG', subcategory: OCHEL_LABAYIT });
eq('mismatched top is corrected to the canonical food top', coerced.category, FOOD_TOP);
let already = _coerceCategoryBySubcategory({ category: FOOD_TOP, subcategory: OCHEL_LABAYIT });
eq('already-correct top is left unchanged (idempotent)', already.category, FOOD_TOP);
let unknown = _coerceCategoryBySubcategory({ category: OCHEL, subcategory: 'דלק' }); // "דלק" (fuel) not in the map
eq('a subcategory NOT in the canonical map leaves the top untouched', unknown.category, OCHEL);
ok('no subcategory -> returned unchanged (no throw)', _coerceCategoryBySubcategory({ category: OCHEL }).category === OCHEL);
ok('null arg -> returned as-is (no throw)', _coerceCategoryBySubcategory(null) === null);

console.log('\n' + (fail === 0
  ? '✅ classifier primitives: ALL ' + pass + ' CHECKS PASSED'
  : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
