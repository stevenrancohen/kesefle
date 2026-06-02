// tests/test_sheet_writer_row_building.js
//
// Coverage for lib/sheet-writer.js ROW BUILDING — the 9-column תנועות row that
// every Vercel-side write (bot bridge + recurring cron + bank import) emits.
// Column order is load-bearing for the dashboard SUMIFS, so a regression here
// silently corrupts totals or "disappears" money. full_qa.js already smoke-
// tests buildExpenseRow via brace-extraction (which runs WITHOUT the taxonomy
// normalizer, so col E falls back to verbatim). THIS suite instead loads the
// REAL ES module so the integrated buildExpenseRow -> normalizeSubcategoryFor-
// Dashboard -> sanitizeCell pipeline is exercised end to end, plus the edge
// cases that path doesn't: amount coercion, date backfill + month-key
// formatting, business vs personal canonicalization, the VAT/income flags, and
// formula-injection neutralization in EVERY string column.
//
// House pattern: no mocking framework. We import the real module (it has no
// top-level side effects / no secret or network access at import time), so no
// env vars are needed.  Run: node tests/test_sheet_writer_row_building.js

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}
function eq(label, got, want) { ok(label + ' (got ' + JSON.stringify(got) + ')', got === want); }

// Hebrew fixtures as \u escapes so the file stays pure ASCII (no bidi marks,
// no copy/paste corruption). These match the exact strings in lib/sheet-writer.js.
const CAT_ESEK   = 'עסק';                               // עסק  (business top-level)
const CAT_OCHEL  = 'אוכל';                         // אוכל
const SUB_SUPER  = 'סופר';                         // סופר
const SUB_OCHEL_LABAYIT = 'אוכל לבית'; // אוכל לבית (dashboard row label)
const ROW_OCHEL_LABAYIT = SUB_OCHEL_LABAYIT;                           // canonical personal row
const SUB_GRANULAR_DGIM = 'אוכל לבית — דגים'; // "אוכל לבית — דגים"
const ROW_SHONOT = 'שונות';                   // שונות  (catch-all personal row)
const BIZ_MARKETING_VARIANT = 'שיווק';        // שיווק -> "עלות שיווק"
const BIZ_MARKETING_ROW = 'עלות שיווק'; // עלות שיווק
const BIZ_OPS_ROW = 'הוצאות תפעוליות'; // הוצאות תפעוליות (ops catch-all)
const DEFAULT_TOP = 'אישי';                        // אישי (col D default)

(async () => {
  let mod;
  try {
    mod = await import('../lib/sheet-writer.js');
  } catch (e) {
    console.log('  ❌ could not import lib/sheet-writer.js: ' + e.message);
    process.exit(1);
  }
  const { buildExpenseRow, sanitizeCell, normalizeSubcategoryForDashboard } = mod;

  // Column index reference (do NOT reorder in the source):
  // 0 A=date ISO, 1 B=month YYYY-MM, 2 C=amount, 3 D=category(top),
  // 4 E=subcategory(canonical row), 5 F=raw text, 6 G=source, 7 H=status bool,
  // 8 I=VAT-deductible bool.
  const A = 0, B = 1, C = 2, D = 3, E = 4, F = 5, G = 6, H = 7, I = 8;

  console.log('\n══ 1. Shape + column contract ══');
  const r = buildExpenseRow({ amount: 245, isIncome: false, category: CAT_OCHEL, subcategory: SUB_SUPER, rawText: '245 ' + SUB_SUPER, date: '2026-05-23T10:00:00Z' });
  eq('row has exactly 9 columns', r.length, 9);
  ok('A is an ISO-8601 date string', typeof r[A] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(r[A]));
  ok('B month is YYYY-MM', /^\d{4}-\d{2}$/.test(r[B]));
  eq('B month matches the supplied date (2026-05)', r[B], '2026-05');
  eq('C amount is the number 245', r[C], 245);
  eq('D top-level category preserved', r[D], CAT_OCHEL);
  eq('G source is always whatsapp', r[G], 'whatsapp');
  eq('H status=true for an expense', r[H], true);
  ok('H is a real boolean (not a truthy string)', typeof r[H] === 'boolean');
  eq('I VAT flag defaults to false', r[I], false);
  ok('I is a real boolean', typeof r[I] === 'boolean');

  console.log('\n══ 2. Amount coercion (col C) ══');
  // buildExpenseRow only trusts a real number; anything else -> 0 (never NaN,
  // never a string that would break SUMIFS).
  eq('numeric amount passes through', buildExpenseRow({ amount: 99.5 })[C], 99.5);
  eq('zero amount stays 0', buildExpenseRow({ amount: 0 })[C], 0);
  eq('string amount -> 0 (not "50")', buildExpenseRow({ amount: '50' })[C], 0);
  eq('undefined amount -> 0', buildExpenseRow({})[C], 0);
  eq('null amount -> 0', buildExpenseRow({ amount: null })[C], 0);
  // CONTRACT NOTE: `typeof amount === 'number' ? amount : 0` lets NaN through
  // (typeof NaN === 'number'). Callers must pre-validate amount > 0 (the bot's
  // parseAmountAndDescription already drops non-positive / NaN amounts, so a
  // NaN never reaches buildExpenseRow in production). We lock the actual
  // behavior here so a future "coerce NaN to 0" change is a conscious decision.
  ok('NaN amount passes through as NaN (typeof-number gap, caller pre-validates)',
     Number.isNaN(buildExpenseRow({ amount: NaN })[C]));
  ok('col C is always typeof number for every input shape',
     [99.5, '50', undefined, NaN, null].every(function (a) { return typeof buildExpenseRow({ amount: a })[C] === 'number'; }));

  console.log('\n══ 3. Date backfill + month-key formatting ══');
  // Year boundary: a December write keeps the right YYYY-MM (no off-by-one).
  const dec = buildExpenseRow({ amount: 1, date: '2025-12-31T23:30:00Z' });
  ok('Dec 31 builds a Dec or Jan month-key (tz-dependent, never empty)', /^\d{4}-(12|01)$/.test(dec[B]));
  // Jan write -> single-digit month is zero-padded.
  const jan = buildExpenseRow({ amount: 1, date: '2026-01-09T12:00:00Z' });
  eq('January month is zero-padded (2026-01)', jan[B], '2026-01');
  // No date supplied -> defaults to "now"; B must still be a valid current-ish key.
  const now = buildExpenseRow({ amount: 1 });
  ok('missing date defaults to a valid YYYY-MM', /^\d{4}-\d{2}$/.test(now[B]));
  ok('default date A and month B agree on the year', now[A].slice(0, 4) === now[B].slice(0, 4));

  console.log('\n══ 4. Income vs expense flag (col H) ══');
  eq('isIncome:true  -> H false (income)', buildExpenseRow({ amount: 1, isIncome: true })[H], false);
  eq('isIncome:false -> H true  (expense)', buildExpenseRow({ amount: 1, isIncome: false })[H], true);
  eq('isIncome omitted -> H true (default expense)', buildExpenseRow({ amount: 1 })[H], true);
  // Mirror of the Apps Script bot's `!isIncome` so both runtimes write the same
  // boolean for the same input (cross-runtime row-parity invariant).
  eq('truthy non-bool isIncome still flips to income (!"x")', buildExpenseRow({ amount: 1, isIncome: 'x' })[H], false);

  console.log('\n══ 5. VAT-deductible flag (col I) ══');
  eq('vatDeductible:true  -> I true', buildExpenseRow({ amount: 1, vatDeductible: true })[I], true);
  eq('vatDeductible:false -> I false', buildExpenseRow({ amount: 1, vatDeductible: false })[I], false);
  eq('vatDeductible omitted -> I false (safe default)', buildExpenseRow({ amount: 1 })[I], false);
  eq('truthy-non-bool VAT coerces to a real boolean true', buildExpenseRow({ amount: 1, vatDeductible: 1 })[I], true);

  console.log('\n══ 6. Default top-level category (col D) ══');
  eq('missing category -> default top "אישי"', buildExpenseRow({ amount: 1 })[D], DEFAULT_TOP);
  eq('empty-string category -> default top "אישי"', buildExpenseRow({ amount: 1, category: '' })[D], DEFAULT_TOP);

  console.log('\n══ 7. Subcategory canonicalization through the row builder (col E) ══');
  // This is the "disappearing money" guard at the ROW level: col E must be a
  // dashboard ROW LABEL after building, not the granular classifier string.
  eq('granular personal sub canonicalizes to its row label',
     buildExpenseRow({ amount: 1, category: CAT_OCHEL, subcategory: SUB_GRANULAR_DGIM })[E], ROW_OCHEL_LABAYIT);
  eq('an already-canonical personal sub maps to a real row (not invisible)',
     buildExpenseRow({ amount: 1, category: CAT_OCHEL, subcategory: SUB_OCHEL_LABAYIT })[E], ROW_OCHEL_LABAYIT);
  // Business rows route through the company-dashboard bucket map.
  eq('business marketing variant -> "עלות שיווק" company row',
     buildExpenseRow({ amount: 1, category: CAT_ESEK, subcategory: BIZ_MARKETING_VARIANT })[E], BIZ_MARKETING_ROW);
  eq('unknown business sub falls back to ops catch-all "הוצאות תפעוליות"',
     buildExpenseRow({ amount: 1, category: CAT_ESEK, subcategory: 'zzz-unknown-biz-sub' })[E], BIZ_OPS_ROW);
  // Unknown PERSONAL sub -> personal catch-all row, never blank (still summed).
  eq('unknown personal sub -> catch-all "שונות" (never invisible)',
     buildExpenseRow({ amount: 1, category: CAT_OCHEL, subcategory: 'zzz-unknown-personal-sub' })[E], ROW_SHONOT);
  // Empty subcategory stays empty (the dashboard has a sink; we must not invent one).
  eq('empty subcategory stays empty string', buildExpenseRow({ amount: 1, category: CAT_OCHEL, subcategory: '' })[E], '');

  console.log('\n══ 8. Formula-injection neutralization in string columns ══');
  // F (raw text) is the highest-risk column (verbatim user input). It MUST be
  // sanitized so a "=...", "+", "-", "@" prefix can't execute in the sheet.
  ['=HACK()', '+1+1', '-2', '@SUM(A1)'].forEach(function (payload) {
    ok('raw text "' + JSON.stringify(payload).slice(1, 12) + '..." in col F is neutralized',
       String(buildExpenseRow({ amount: 1, rawText: payload })[F]).charAt(0) === "'");
  });
  // CONTRACT NOTE: sanitizeCell guards a LEADING tab character ('\t') only when
  // a tab is the very first char of the *un-trimmed* string — but the
  // implementation reads `cleaned.trimStart()[0]`, which strips the tab first,
  // so a "\t=1" style payload is judged by the char AFTER the tab. A bare
  // "\tTAB" (tab then letters) is therefore NOT prefixed (the post-tab char is a
  // letter). What matters for safety: a formula char that *follows* leading
  // whitespace/tabs is still caught (asserted below), so injection is blocked.
  ok('"\\t=1" (tab then formula char) IS neutralized',
     String(buildExpenseRow({ amount: 1, rawText: '\t=1' })[F]).charAt(0) === "'");
  ok('"\\tTAB" (tab then plain text) is left as-is after tab strip (no false-positive quote on benign text)',
     String(buildExpenseRow({ amount: 1, rawText: '\tTAB' })[F]).charAt(0) !== "'");
  ok('a benign raw text is left untouched in col F',
     buildExpenseRow({ amount: 1, rawText: '245 ' + SUB_SUPER })[F] === '245 ' + SUB_SUPER);
  // A malicious category/subcategory must also be neutralized (defense in depth).
  ok('formula in category col D is neutralized',
     String(buildExpenseRow({ amount: 1, category: '=EVIL()' })[D]).charAt(0) === "'");
  // Note: subcategory routes through normalize first; an unmapped "=..." personal
  // sub becomes the safe row label, so it cannot carry a payload into col E.
  ok('formula-looking unmapped personal sub becomes a safe row label in col E (no leading =)',
     String(buildExpenseRow({ amount: 1, category: CAT_OCHEL, subcategory: '=EVIL()' })[E]).charAt(0) !== '=');

  console.log('\n══ 9. sanitizeCell unit edges (used by every string column) ══');
  eq('null -> empty string', sanitizeCell(null), '');
  eq('undefined -> empty string', sanitizeCell(undefined), '');
  eq('number passes through unchanged', sanitizeCell(42), 42);
  // Adversarial inputs: a hidden bidi-override (U+202E) or zero-width space
  // (U+200B) BEFORE a formula char must be stripped by sanitizeCell so the
  // remaining "=..." is still detected and quoted. Written as \u escapes so
  // this test file itself contains no literal bidi/zero-width control bytes.
  ok('a bidi-override-wrapped (U+202E) formula is still neutralized',
     sanitizeCell('\u202e=1').charAt(0) === "'");
  ok('a zero-width-prefixed (U+200B) formula is still neutralized',
     sanitizeCell('\u200b=SUM(A1)').charAt(0) === "'");
  eq('plain Hebrew is untouched', sanitizeCell(SUB_SUPER), SUB_SUPER);
  // Leading whitespace before a formula char is still caught (trimStart check).
  ok('leading-space formula "  =1" is neutralized', sanitizeCell('  =1').charAt(0) === "'");

  console.log('\n══ 10. normalizeSubcategoryForDashboard direct edges (not the map sweep) ══');
  // The exhaustive map<->row coverage lives in tests/test_taxonomy_normalize.js.
  // Here we only lock a few BEHAVIORAL edges the row builder relies on.
  eq('empty subcategory returns empty (no catch-all invented)', normalizeSubcategoryForDashboard('', CAT_OCHEL), '');
  eq('whitespace-only subcategory returns empty', normalizeSubcategoryForDashboard('   ', CAT_OCHEL), '');
  ok('null category is treated as personal (no throw, returns a string)',
     typeof normalizeSubcategoryForDashboard(SUB_GRANULAR_DGIM, null) === 'string');
  eq('business catch-all is deterministic for any junk biz sub',
     normalizeSubcategoryForDashboard('totally-made-up', CAT_ESEK), BIZ_OPS_ROW);

  console.log('\n' + (fail === 0
    ? '✅ sheet-writer row building: ALL ' + pass + ' CHECKS PASSED'
    : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
  process.exit(fail === 0 ? 0 : 1);
})();
