#!/usr/bin/env node
// bot/test_income_recognition.js (auto-discovered by the gauntlet)
// Locks the NL receive-verb income rules added 2026-06-24 via _resolveIsIncome_
// AND the CATEGORY_MAP income-noun additions (malgat, tamlugim, tip/tipim).
//
// Two testing strategies:
//   (1) _resolveIsIncome_ direct eval -- for NL-rule cases (matched=null, raw cat passed).
//   (2) classify-one replay -- for CATEGORY_MAP cases where the classifier must route first.
//
// Loads the REAL _resolveIsIncome_ + _isIncomeCategory_ from source (no mocks).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { started = true; depth++; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  return '';
}
eval(extract('_isIncomeCategory_'));
eval(extract('_resolveIsIncome_'));

function classifyOne(msg) {
  const out = execFileSync('node', [path.join(__dirname, 'classify-one.js'), msg], { encoding: 'utf8' });
  return { income: /income=true/.test(out), line: out.split('\n')[0] };
}

// ── SECTION 1: NL receive-verb rules tested via _resolveIsIncome_ directly ──
// Call: _resolveIsIncome_(null, msg, cat, sub)
// cat/sub = what the classifier would assign (the NL rule fires BEFORE cat check).

// Rule A: machar conjugations (sold something -> money in)
const NL_INCOME = [
  // wa-sim 2026-06-26 round 2: collection / deposited-to-me / fem. came-in
  ['גבייה משוכר שאיחר 5500',             null, null],
  ['גמרתי עבודה והכניסו לי 2700',        null, null],
  ['השקעה מהמשקיע נכנסה 250000',         null, null],
  ['תרומה נכנסה 750',                    null, null],
  // wa-sim 2026-06-26: customer-paid / invoice-to-customer / money-came-in / earned / revenue
  ['לקוחה שילמה 350 על צבע',             null, null],
  ['לקוח העביר 3000 בביט',               null, null],
  ['חשבונית מלקוח 6800',                 null, null],
  ['שכר טרחה מלקוח 8000',                null, null],
  ['נכנס תשלום 2200 על צילום',           null, null],
  ['דמי מזונות 3500 נכנסו לחשבון',       null, null],
  ['הרווחתי 620 נסיעות',                 null, null],
  ['פדיון יומי 4350',                    null, null],
  ['הכנסות היום מהחנות 2300',            null, null],
  ['קיבלנו 5000 מלקוח',                  null, null],
  ['תרומה התקבלה 500',                   null, null],
  ['קיבלתי החזר על מנוי שביטלתי 320',    null, null],
  ['מכרתי עגלה ישנה ב300',               'חינוך וילדים', 'עגלות תינוק'],
  ['מכרנו סחורה 1000',                    'שונות ואחרים', 'שונות'],
  ['מכרת גיטרה ישנה ב2.5k',              'שונות ואחרים', 'שונות'],
  ['מכרה את הרהיטים 4000',               'שונות ואחרים', 'שונות'],
  ['מכרו 5 חולצות באיביי 1250',           'שונות ואחרים', 'שונות'],
  ['מכרתי אופניים 800',                   'שונות ואחרים', 'שונות'],
  // Rule B: niknas li
  ['נכנס לי החזר 240 מהעבודה',            'שונות ואחרים', 'שונות'],
  ['נכנסה לי פנסיה 6200',                 'הוצאות קבועות', 'ביטוח'],
  // Rule C: kibalti + income noun (noun-gated)
  ['קיבלתי 500 מתנה מסבתא',              'שונות ואחרים', 'מתנות'],
  ['קיבלתי מתנה כספית 1000',             'שונות ואחרים', 'מתנות'],
  ['קיבלתי 1000 מתנה',                    'שונות ואחרים', 'מתנות'],
  ['קיבלתי תשלום על פרויקט 7500',         'שונות ואחרים', 'שונות'],
  ['קיבלתי תשלום 7500',                   'שונות ואחרים', 'שונות'],
  ['קיבלתי מקדמה 4500 מלקוח',            'שונות ואחרים', 'שונות'],
  ['קיבלתי פנסיה 6200',                   'הוצאות קבועות', 'ביטוח'],
  ['קיבלתי מלגה 3500',                    'שונות ואחרים', 'שונות'],
  ['קיבלתי תמלוגים מאקום',               'שונות ואחרים', 'שונות'],
  ['קיבלתי טיפ 100',                      'שונות ואחרים', 'שונות'],
  ['קיבלתי טיפים 600',                    'שונות ואחרים', 'שונות'],
  ['קיבלתי תשר מהמשמרת 80',              'שונות ואחרים', 'שונות'],
  ['קיבלתי מזונות 3500',                  'שונות ואחרים', 'שונות'],
  ['קיבלתי ריטיינר חודשי 5500 מהחברה',   'שונות ואחרים', 'שונות'],
  ['קיבלתי שכר טרחה 12000',              'שונות ואחרים', 'שונות'],
  ['קיבלתי שכירות מהדייר 5500',          'שונות ואחרים', 'שונות'],
  ['קבלתי 180 על תספורת',                 'טיפוח',        'טיפוח'],
  ['קבלתי טיפ 100',                       'שונות ואחרים', 'שונות'],
  // Rule D: kibalti + mi-source
  ['קיבלתי מהורים 1000',                  'שונות ואחרים', 'שונות'],
  ['קיבלתי 1200 מביטוח לאומי',           'שונות ואחרים', 'שונות'],
  ['קיבלתי 500 מתנה מסבתא לילד',         'שונות ואחרים', 'שונות'],
  // Rule E: kibalti + al (received for service)
  ['קיבלתי 540 על נסיעות גט',            'שונות ואחרים', 'שונות'],
  ['קיבלתי 250 על אימון אישי',           'שונות ואחרים', 'שונות'],
  ['קיבלתי 3500 על התקנת לוח חשמל',     'שונות ואחרים', 'שונות'],
  ['קיבלתי 1200 על תיקון בלמים',         'שונות ואחרים', 'שונות'],
  // Rule F: gaviiti
  ['גביתי 2000 מלקוחה ניקיון',           'שונות ואחרים', 'שונות'],
  ['גביתי 1200 על החלפת ברז מטבח',       'שונות ואחרים', 'שונות'],
  // Rule G: bare income noun + mi-source
  ['מקדמה מלקוח 4500',                    'שונות ואחרים', 'שונות'],
  ['תמלוגים מאקום 3450',                  'שונות ואחרים', 'שונות'],
  ['טיפ מהמשמרת 120',                     'שונות ואחרים', 'שונות'],
  ['מזונות מהאבא 3500',                   'שונות ואחרים', 'שונות'],
  ['שכירות מהדייר 4500',                  'שונות ואחרים', 'שונות'],
];

// ── SECTION 2: CATEGORY_MAP income-noun additions tested via classify-one ────
// These rely on the classifier routing to the income entry first.
const CATMAP_INCOME = [
  'מלגת הצטיינות 3500',
  'מלגת קיום 2700',
  'תמלוגים 3450 מאקום',
  'טיפ מהמשמרת 120',
  'טיפים 600',
  'מלגת לימודים 1200',
];

// ── SECTION 3: MUST-STAY-EXPENSE via _resolveIsIncome_ directly ──────────────
const NL_EXPENSE = [
  // wa-sim 2026-06-26: "entered a store" is NOT money-came-in; bare donation = given
  ['נכנסתי לחנות וקניתי 80',                null,           null],
  ['תרומה 100 לעמותה',                    null,           null],
  // gift GIVEN (not received)
  ['מתנה לאמא 80',                         'שונות ואחרים', 'מתנות'],
  ['קניתי מתנה 500 לסבתא',                'שונות ואחרים', 'שונות'],
  ['80 מתנה ליום הולדת',                  'מתנות',        'מתנות'],
  // payroll: paying salary to employee
  ['שילמתי משכורת לעובד 6000',            'עסק',          'הוצאות תפעוליות'],
  ['משכורת לעובד 6000',                   'עסק',          'הוצאות תפעוליות'],
  // bill / quote RECEIVED = money owed, NOT income (over-broad-flip guard, 2026-06-24)
  ['קיבלתי חשבונית מספק 500',             null,           null],
  ['קיבלתי הצעת מחיר על שיפוץ 5000',      null,           null],
  ['קיבלתי הצעת מחיר מהקבלן 5000',        null,           null],
  // MONEY OUT: paid/given by the user = EXPENSE, even with an income noun
  // (wa-sim 2026-06-25, 24 over-flips). bonus/tip/rent PAID, refund GIVEN.
  ['שילמתי שכירות משרד 2800',             null,           null],
  ['שכירות משרד 6500',                    null,           null],
  ['שכר דירה משרד 3200',                  null,           null],
  ['שילמתי שכירות מספרה 6000',            null,           null],
  ['בונוס לעובד 500',                     null,           null],
  ['תשלום עמלה לאתר המכירות 75',          null,           null],
  ['שילמתי 600 טיפים לצוות',              null,           null],
  ['משכורת לדנה המלצרית 4800',            null,           null],
  ['שילמתי לפועל שלי 4500 משכורת',        null,           null],
  ['החזר ללקוח 120 על הזמנה שבוטלה',      null,           null],
  ['החזר מלקוח שביטל 1500',               null,           null],
  ['החזרתי ללקוחה 200 ביטול הזמנה',       null,           null],
  // normal expenses
  ['50 קפה',                               'אוכל',         'אוכל בחוץ'],
  ['245 סופר',                             'אוכל',         'אוכל לבית'],
  ['החזר משכנתא 4000',                    'הוצאות קבועות', 'בית'],
  ['קניתי אופניים 800',                   'שונות ואחרים', 'שונות'],
  ['שילמתי מזונות 3500',                  'שונות ואחרים', 'שונות'],
  // fines RECEIVED are still EXPENSES
  ['קיבלתי דוח חניה 250',                 'תחבורה',       'חניה'],
  ['קיבלתי קנס 500',                      'שונות ואחרים', 'שונות'],
  // tip/advance GIVEN (not received)
  ['טיפ למלצרית 200',                      'שונות ואחרים', 'שונות'],
  ['טיפ לשמפיניסטית 50',                  'שונות ואחרים', 'שונות'],
  ['מקדמה לקבלן 5000',                    'שונות ואחרים', 'שונות'],
  // paying rent/alimony
  ['שילמתי שכירות 12000',                 'שונות ואחרים', 'שונות'],
  ['מזונות לילד 2000',                    'שונות ואחרים', 'שונות'],
  // realtor fee paid (expense)
  ['עמלה לסוכן נדלן 5000',               'שונות ואחרים', 'שונות'],
  // bonus paid to employee
  ['בונוס לעובד 500',                     'שונות ואחרים', 'שונות'],
];

let pass = 0, fail = 0;

// Section 1: NL rules
for (const [msg, cat, sub] of NL_INCOME) {
  const got = _resolveIsIncome_(null, msg, cat, sub);
  if (got === true) pass++;
  else { fail++; console.log('  FAIL must-be-income [NL] "' + msg + '" -> got income=' + got); }
}

// Section 2: CATEGORY_MAP additions (via classify-one)
for (const msg of CATMAP_INCOME) {
  const r = classifyOne(msg);
  if (r.income === true) pass++;
  else { fail++; console.log('  FAIL must-be-income [CATMAP] "' + msg + '" -> ' + r.line); }
}

// Section 3: Expense guard
for (const [msg, cat, sub] of NL_EXPENSE) {
  const got = _resolveIsIncome_(null, msg, cat, sub);
  if (got === false) pass++;
  else { fail++; console.log('  FAIL must-stay-expense "' + msg + '" -> got income=' + got); }
}

console.log('test_income_recognition: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
