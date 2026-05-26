// Unit test: income intent detection (PR #16).
//
// Validates _detectIncomeIntent_ — the pre-filter that catches natural
// Hebrew income phrasings the static keyword classifier misses:
//   "קיבלתי 5000 משכורת"
//   "+500"
//   "נכנס לי 200 מלקוח"
//   "פיצויים 4000"
//   "החזר מס 1200"
//
// AND validates the negative cases — phrases that LOOK like they might
// be income but are actually expenses or neutral, so we never flip a
// real expense to income:
//   "המכולת קיבלה 200"  (the store received 200 = expense)
//   "החזר 50"  (ambiguous, no qualifier)
//   "שילמתי 300 לעו״ד"  (I paid X = expense)
//
// Run: node tests/test_income_intent.js

import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../bot/ExpenseBot_FIXED.gs', import.meta.url), 'utf8');

// Extract just _detectIncomeIntent_ + sandbox it.
function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, j);
}
const detectSrc = sliceBetween(
  SRC,
  'function _detectIncomeIntent_',
  '\nfunction _applyIncomeIntentOverride_'
);
const sandbox = {};
new Function('sandbox', detectSrc + '\nsandbox.detect = _detectIncomeIntent_;')(sandbox);
const detect = sandbox.detect;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('=== POSITIVE CASES (should detect income) ===\n');

const positives = [
  // Leading +
  '+500',
  '+ 500',
  '+5000 משכורת',
  // קיבלתי / קיבלנו
  'קיבלתי 8500 משכורת',
  'קיבלתי 200 מלקוח',
  'קיבלנו 1000 מענק',
  // נכנס לי / הכניסו לי
  'נכנס לי 300 לחשבון',
  'נכנס לי 5000 משכורת',
  'הכניסו לי 1200',
  // שילם לי / שילמו לי
  'שילם לי לקוח 2000',
  'שילמו לי 800',
  // החזיר לי
  'החזיר לי 150 דני',
  'החזירו לי 300 מהביטוח',
  // העביר לי
  'העביר לי דוד 500',
  'העבירו לי 1200',
  // Income-only words
  'פיצויים 50000',
  'מענק 5000',
  'תמלוגים 1500',
  'דיבידנד 8000',
  'דמי אבטלה 6000',
  'דמי לידה 12000',
  // Refund patterns with qualifier
  'החזר מס 1200',
  'החזר מע״מ 450',
  'החזר ביטוח לאומי 800',
  'החזר אשראי 50',
  // Income verbs
  'הרווחתי 1200 על פרויקט',
  'הרווחנו 5000 השבוע',
];

positives.forEach((input) => {
  check('detects income: "' + input + '"', detect(input) === true, 'got false');
});

console.log('\n=== NEGATIVE CASES (should NOT detect income) ===\n');

const negatives = [
  // Empty / null
  '',
  null,
  undefined,
  // Plain expenses
  '50 קפה',
  '1200 ארנונה',
  '300 דלק',
  '85 סופר',
  // Looks like an income verb but is actually expense (the store received money = I paid)
  'המכולת קיבלה 200',
  'הקפה קיבל 50',
  'החנות קיבלה 1000',
  // Plain "החזר" without qualifier (ambiguous — leave alone)
  'החזר 50',
  'החזר על קפה',
  // Past expense
  'שילמתי 300 לעו״ד',
  'שילמתי 200 חניה',
  // Numbers in the middle, not at start
  'אתמול 50 קפה',
  // Future-tense verbs
  'אקבל מחר 5000',
  // "נכנס" without "לי" — likely "I entered" not "money entered"
  'נכנסתי לסניף',
  'נכנס לחנות',
  // Just a vendor name
  'נטפליקס',
];

negatives.forEach((input) => {
  check('does NOT flag: "' + (input === null ? 'null' : input === undefined ? 'undefined' : input) + '"', detect(input) === false);
});

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
