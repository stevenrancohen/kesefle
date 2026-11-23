import { classifyTransactionDescription, __test } from '../lib/transaction-classifier.js';

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log('  ✅ ' + label);
  } else {
    fail++;
    console.log('  ❌ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function expectMatch(label, text, isIncome, category, subcategory) {
  const result = classifyTransactionDescription(text, { isIncome });
  check(label,
    result?.category === category &&
    result?.subcategory === subcategory &&
    result?.source === 'keyword' &&
    result?.confidence === 'high',
    JSON.stringify(result));
}

console.log('\n=== deterministic transaction classifier ===');
check('has a deliberately small rule set', __test.ruleCount >= 40 && __test.ruleCount < 100, String(__test.ruleCount));
expectMatch('Israeli supermarket', 'קנייה שבועית בשופרסל', false, 'מזון ופארמה', 'מזון');
expectMatch('pharmacy beats generic super', 'סופר פארם דיזנגוף', false, 'מזון ופארמה', 'פארמה וטואלטיקה');
expectMatch('restaurant / cafe', 'קפה ארומה', false, 'פנאי, בילוי ותחביבים', 'מסעדה ואוכל בחוץ');
expectMatch('delivery app', 'WOLT תל אביב', false, 'פנאי, בילוי ותחביבים', 'מסעדה ואוכל בחוץ');
expectMatch('fuel', 'דלק פז סניף 412', false, 'תחבורה', 'דלק');
expectMatch('parking', 'חניון עזריאלי', false, 'תחבורה', 'חניה');
expectMatch('public transit', 'טעינת רב קו', false, 'תחבורה', 'תחבורה ציבורית');
expectMatch('electric utility', 'תשלום חברת חשמל', false, 'אחזקת בית', 'חשמל');
expectMatch('telecom', 'חשבון סלקום', false, 'תקשורת', 'טלפון נייד ונייח');
expectMatch('salary when income is explicit', 'משכורת נובמבר', true, 'שכר', 'שכר עבודה 1');
expectMatch('rental income respects direction', 'שכר דירה נובמבר', true, 'הכנסות שונות', 'הכנסה מנכס');
expectMatch('rental expense respects direction', 'שכר דירה נובמבר', false, 'דיור', 'שכר דירה');

console.log('\n=== false-positive guards ===');
check('unknown text returns null', classifyTransactionDescription('תשלום כללי', { isIncome: false }) === null);
check('short text returns null', classifyTransactionDescription(' ', { isIncome: false }) === null);
check('income phrase cannot flip explicit expense', classifyTransactionDescription('שכר עובדים', { isIncome: false }) === null);
check('expense merchant cannot flip explicit income', classifyTransactionDescription('החזר משופרסל', { isIncome: true }) === null);
check('broad water word is excluded from web text', classifyTransactionDescription('מים מינרליים', { isIncome: false }) === null);
check('short merchant token does not match inside another word', classifyTransactionDescription('מפזרים תשלומים', { isIncome: false }) === null);
check('legacy bank matcher keeps broad water behavior',
  classifyTransactionDescription('תאגיד מים', { isIncome: false, legacyDirection: true })?.subcategory === 'מים וביוב');
check('bidi marks are ignored',
  classifyTransactionDescription('\u200fשופרסל\u200e', { isIncome: false })?.subcategory === 'מזון');

console.log('\n' + (fail === 0
  ? `✅ ALL ${pass} TRANSACTION-CLASSIFIER CHECKS PASSED`
  : `❌ ${fail} FAILED, ${pass} passed`));
process.exit(fail === 0 ? 0 : 1);
