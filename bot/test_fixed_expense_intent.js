// Ask C (2026-06-01): natural-language fixed-expense intent.
// Loads the REAL _isBareFixedExpenseIntent_ + _fixedExpenseGuide_ out of
// ExpenseBot_FIXED.gs and asserts that a BARE intent ("הוצאה קבועה", "קבוע",
// "הוצאה חודשית", ...) is recognized as a how-to request, while a real
// recurring-add command, an expense that merely mentions קבוע, and unrelated
// messages are NOT — so the guide never swallows a real write.
// Run: node bot/test_fixed_expense_intent.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

(0, eval)(extractFn('_isBareFixedExpenseIntent_'));
(0, eval)(extractFn('_fixedExpenseGuide_'));

let pass = 0, fail = 0;
function ok(label, cond) {
  console.log((cond ? '  PASS ' : '  FAIL ') + label);
  cond ? pass++ : fail++;
}

const isIntent = globalThis._isBareFixedExpenseIntent_;
const guide = globalThis._fixedExpenseGuide_;

console.log('\n-- bare fixed-expense intents MATCH --');
[
  'הוצאה קבועה',
  'הוצאות קבועות',
  'קבוע',
  'קבועה',
  'הוצאה חודשית',
  'הוצאות חודשיות',
  'הוראת קבע',
  'הוצאה קבועה?',          // trailing question mark
  '  הוצאה קבועה  ',       // surrounding whitespace
  'fixed expense',
  'recurring',
  'recurring expense',
  'monthly expense',
].forEach(t => ok('match: "' + t + '"', isIntent(t) === true));

console.log('\n-- real commands / expenses do NOT match (no false swallow) --');
[
  'קבוע 2500 שכירות',          // real recurring-add command (has amount)
  'קבוע 49 נטפליקס',           // real recurring-add command
  'הוצאה קבועה 3000 שכר דירה', // recurring-add with amount
  'שכר דירה 3000 קבוע',        // a plain expense that mentions קבוע
  '150 סופר',                  // ordinary expense
  'ארנונה 400',                // ordinary expense
  'קבועות',                    // list command (handled elsewhere)
  'רשימת קבועות',              // list command
  'מחק קבוע נטפליקס',          // delete command
  'עזרה',                      // help
  'סיכום',                     // summary
  'כספלה הוצאה קבועה',         // brand-prefixed -> owned by the group router, not this guard
  '',                          // empty
  '   ',                       // whitespace only
  'קבוע מאוד',                 // not a bare intent phrase
].forEach(t => ok('no-match: "' + t + '"', isIntent(t) === false));

console.log('\n-- guide reply sanity --');
const g = guide();
ok('guide is a non-empty string', typeof g === 'string' && g.length > 0);
ok('guide teaches the working syntax (mentions "קבוע")', g.indexOf('קבוע') >= 0);
ok('guide shows a concrete amount example', /קבוע 3000|קבוע 49/.test(g));
ok('guide points to the list command ("קבועות")', g.indexOf('קבועות') >= 0);
ok('guide is short (<= 9 lines)', g.split('\n').length <= 9);
ok('guide has no bidi/control chars', !/[‎‏‪-‮⁦-⁩]/.test(g));
ok('guide uses correct brand spelling (no כסף-with-final-fe)', g.indexOf("כסף'") < 0);

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' FAILED')) + ' (' + pass + ' passed)');
process.exit(fail === 0 ? 0 : 1);
