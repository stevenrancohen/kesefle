// Installments Hebrew-boundary parser test — loads the REAL _detectInstallments_
// (+ its _extractProductName_ helper) from ExpenseBot_FIXED.gs via balanced-brace
// extraction (same technique as bot/test_classify.js) so the test can never drift
// from production code. Guards AUDIT_RECURRING_ENGINE_2026_05_31 F3: JS `\b` is
// ASCII-only and never forms a boundary on the right edge of a Hebrew letter, so
// the pre-fix Pattern B returned null on every natural Hebrew installments
// phrasing (incl. the headline product example "ספה 1000 שקל 5 תשלומים").
// Run: node bot/test_installments_hebrew.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');

// Extract a full `function name(...) { ... }` body by matching parens then braces.
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

// _detectInstallments_ calls _extractProductName_, so load both into scope.
(0, eval)(fn('_extractProductName_'));
(0, eval)(fn('_detectInstallments_'));

let pass = 0, fail = 0;
function check(label, rawText, total, wantCount, wantPer) {
  const r = _detectInstallments_(rawText, total);
  const ok = r && r.count === wantCount && r.perPayment === wantPer;
  const got = r ? (r.count + ' × ' + r.perPayment) : 'null';
  console.log((ok ? '  PASS ' : '  FAIL ') + label.padEnd(34) + ' → ' + got +
    (ok ? '' : '   (want ' + wantCount + ' × ' + wantPer + ')'));
  ok ? pass++ : fail++;
}

console.log('\n== Installments Hebrew-boundary parser (F3) ==');
// The 6 task-mandated phrasings — all MUST parse to (count, per-payment).
// Pattern B (count only): per = round(total / count). Pattern A ("...של Y"): per = Y.
check('ספה 1000 שקל 5 תשלומים',   'ספה 1000 שקל 5 תשלומים', 1000, 5, 200); // headline example
check('ב-5 תשלומים',              'ב-5 תשלומים',            1000, 5, 200);
check('ב5 תשלומים',               'ב5 תשלומים',             1000, 5, 200);
check('5 תשלומים של 200',         '5 תשלומים של 200',       1000, 5, 200); // Pattern A wins
check('10 תשלומים',               '10 תשלומים',             2000, 10, 200);
check('ב 3 תשלומים של 1000',      'ב 3 תשלומים של 1000',    3000, 3, 1000); // Pattern A

// Extra coverage: singular "תשלום", trailing punctuation, mid-sentence, English,
// and the per-payment division math on a non-round total.
console.log('\n== Extra robustness ==');
check('ב-10 תשלום',               'ב-10 תשלום',             1000, 10, 100); // singular form
check('רהיט 3000, 10 תשלומים!',   'רהיט 3000, 10 תשלומים!', 3000, 10, 300); // trailing punct
check('קניתי לפטופ ב-24 תשלומים', 'קניתי לפטופ ב-24 תשלומים', 4800, 24, 200); // mid-sentence
check('5 payments of 200',         '5 payments of 200',      1000, 5, 200);  // English (Pattern C)
check('non-round 1000 / 3',        'מקרר 1000 ב-3 תשלומים',  1000, 3, 333.33); // round(.333*100)/100

// Negative: a single payment / no installment phrase must NOT trigger a plan.
console.log('\n== Negatives (must return null) ==');
function checkNull(label, rawText, total) {
  const r = _detectInstallments_(rawText, total);
  const ok = r === null;
  console.log((ok ? '  PASS ' : '  FAIL ') + label.padEnd(34) + ' → ' + (ok ? 'null' : JSON.stringify(r)));
  ok ? pass++ : fail++;
}
checkNull('1 תשלום (count < 2)',   'ספה 1000 ב-1 תשלום',     1000);
checkNull('no installment phrase', 'קפה 18 שקל',             18);

console.log('\n' + (fail === 0 ? 'ALL PASS' : (fail + ' FAILED')) + '  (' + pass + ' passed)');
if (fail > 0) process.exit(1);
