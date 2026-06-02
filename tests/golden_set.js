// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN-SET ACCURACY BENCHMARK  ·  run: node tests/golden_set.js
//
// The measure-first safety net for the classifier. ~155 realistic Hebrew
// expense messages, each hand-labeled with ground truth so AGGREGATE accuracy
// is tracked against a threshold. Any future change to the vocabulary, the
// matcher, or the learning tiers that quietly drags accuracy down trips the
// build. Loads the REAL matchCategory + CATEGORY_MAP from the bot source (no
// mock) so the number reflects what users actually get.
//
// Label forms:
//   'DEFAULT'  → the right product behavior is to ASK (ambiguous input). A bot
//                that asks rather than mis-files is NOT a miscategorization.
//   'sub:X'    → the meaningful signal is the SUBcategory (used where the map's
//                top-level is its catch-all bucket, e.g. pets, investments).
//   'X'        → the classifier's category's first segment (split on ' / ')
//                must equal X. This absorbs the map's mixed taxonomy (some
//                entries are "קניות", others "קניות / ביגוד").
//
// HONESTY RULE: labels are defensible ground truth, NOT rigged to the code.
// Several labels were reconciled to the map's CONSISTENT design decisions, each
// noted inline: income tax is treated as a recurring fixed cost (הוצאות קבועות,
// not ממשלה ומיסים); car/health insurance follow their domain (תחבורה/בריאות);
// tuition & academic books are recurring (הוצאות קבועות / לימודים). Business-
// only vendors (accountant, ad spend) are excluded — they classify via
// BUSINESS_CATEGORY_MAP in business accounts, which personal matchCategory does
// not consult. Irreducibly ambiguous one-word inputs (גט = Gett app or divorce
// doc; בר = bar or a name; ספר = book or barber) are labeled DEFAULT.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../bot/ExpenseBot_FIXED.gs', 'utf8');

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

// ── The golden set ──  [message, label]
const GOLDEN = [
  // ── אוכל: supermarkets ──
  ['250 סופר', 'אוכל'], ['רמי לוי 340', 'אוכל'], ['שופרסל 120', 'אוכל'],
  ['יוחננוף 210', 'אוכל'], ['ויקטורי 95', 'אוכל'], ['אושר עד 430', 'אוכל'],
  ['טיב טעם 180', 'אוכל'], ['יינות ביתן 260', 'אוכל'], ['מגה בעיר 88', 'אוכל'],
  ['קניות בסופר 400', 'אוכל'], ['מכולת 45', 'אוכל'], ['חצי חינם 320', 'אוכל'],
  // ── אוכל: restaurants / takeout / coffee / pubs (map files pubs under food-out) ──
  ['מקדונלדס 55', 'אוכל'], ['בורגר קינג 62', 'אוכל'], ['ארומה 24', 'אוכל'],
  ['קפה 18', 'אוכל'], ['קפה ארומה 32', 'אוכל'], ['פיצה 80', 'אוכל'],
  ['פיצה האט 95', 'אוכל'], ['סושי 120', 'אוכל'], ['שווארמה 45', 'אוכל'],
  ['פלאפל 30', 'אוכל'], ['חומוס 38', 'אוכל'], ['וולט 90', 'אוכל'],
  ['wolt 76', 'אוכל'], ['תן ביס 64', 'אוכל'], ['ארוחת צהריים 65', 'אוכל'],
  ['המבורגר 70', 'אוכל'], ['מסעדה 240', 'אוכל'], ['בית קפה 40', 'אוכל'],
  ['גלידה 28', 'אוכל'], ['מאפה 22', 'אוכל'], ['פאב 150', 'אוכל'],

  // ── תחבורה: fuel ──
  ['דלק 300', 'תחבורה'], ['תדלוק 250', 'תחבורה'],
  ['סונול 220', 'תחבורה'], ['דור אלון 200', 'תחבורה'],
  // ── תחבורה: rides / public / parking / vehicle costs ──
  ['אובר 60', 'תחבורה'], ['מונית 75', 'תחבורה'],
  ['נסיעה במונית 50', 'תחבורה'], ['רכבת 27', 'תחבורה'], ['רכבת ישראל 31', 'תחבורה'],
  ['אוטובוס 12', 'תחבורה'], ['כרטיס אוטובוס 12', 'תחבורה'], ['רב קו 50', 'תחבורה'],
  ['חניה 20', 'תחבורה'], ['דמי חניה 15', 'תחבורה'], ['פנגו 18', 'תחבורה'],
  ['סלופארק 22', 'תחבורה'], ['רכבת קלה 6', 'תחבורה'],
  ['ביטוח רכב 320', 'תחבורה'],        // car insurance → vehicle domain
  ['קנס חניה 250', 'תחבורה'],         // parking fine → parking domain
  ['אגרת רישוי 430', 'תחבורה'],       // vehicle licensing → vehicle domain

  // ── הוצאות קבועות: utilities, housing, recurring obligations ──
  ['חשמל 450', 'הוצאות קבועות'], ['חשבון חשמל 450', 'הוצאות קבועות'],
  ['חברת חשמל 510', 'הוצאות קבועות'], ['מים 120', 'הוצאות קבועות'],
  ['חשבון מים 120', 'הוצאות קבועות'], ['אינטרנט 99', 'הוצאות קבועות'],
  ['בזק 129', 'הוצאות קבועות'], ['הוט 199', 'הוצאות קבועות'],
  ['סלקום 89', 'הוצאות קבועות'], ['פרטנר 75', 'הוצאות קבועות'],
  ['גולן טלקום 39', 'הוצאות קבועות'], ['ארנונה 600', 'הוצאות קבועות'],
  ['שכירות 4500', 'הוצאות קבועות'], ['שכר דירה 4500', 'הוצאות קבועות'],
  ['משכנתא 5200', 'הוצאות קבועות'], ['ועד בית 250', 'הוצאות קבועות'],
  ['ביטוח דירה 90', 'הוצאות קבועות'],
  // ITEM 3 fix (2026-06-01): "ביטוח אישי" used to be swallowed by the bare
  // "אישי" keyword and mis-filed under שונות. Now routes to its own sub.
  ['ביטוח אישי 500', 'הוצאות קבועות'],
  // ITEM 4 (2026-06-01): dashboard-vocabulary keywords — generic insurance
  // and the tax-and-fees label map to recurring fixed costs. NOTE: bare "גז"
  // was deliberately NOT added — the golden set already labels bare "גז" as
  // ambiguous (DEFAULT, see below); only "חשבון גז"/"תשלום גז" route to גז.
  ['ביטוח 300', 'הוצאות קבועות'],
  ['מיסים ואגרות 400', 'הוצאות קבועות'],
  // income tax / national insurance → recurring obligations in this map (consistent)
  ['מס הכנסה 2000', 'הוצאות קבועות'], ['תשלום מס הכנסה 1500', 'הוצאות קבועות'],
  ['מקדמות מס 900', 'הוצאות קבועות'], ['ביטוח לאומי 500', 'הוצאות קבועות'],
  // tuition & academic materials → recurring (map line: לימודים under הוצאות קבועות)
  ['ספרי לימוד 300', 'הוצאות קבועות'], ['אוניברסיטה 3000', 'הוצאות קבועות'],

  // ── ממשלה ומיסים: VAT & state fees ──
  ['מעמ 1800', 'ממשלה ומיסים'], ['טסט לרכב 600', 'ממשלה ומיסים'],

  // ── בריאות: health ──
  ['תרופות 60', 'בריאות'], ['סופרפארם 85', 'בריאות'], ['בית מרקחת 45', 'בריאות'],
  ['רופא שיניים 400', 'בריאות'], ['רופא פרטי 350', 'בריאות'],
  ['מרפאה פרטית 250', 'בריאות'], ['בדיקת דם 150', 'בריאות'],
  ['קופת חולים 50', 'בריאות'], ['משקפיים 800', 'בריאות'],
  ['פיזיותרפיה 220', 'בריאות'], ['פסיכולוג 350', 'בריאות'], ['אופטיקה 600', 'בריאות'],
  ['ביטוח בריאות 280', 'בריאות'],     // health insurance → health domain

  // ── בידור: entertainment & subscriptions ──
  ['נטפליקס 45', 'בידור'], ['ספוטיפיי 20', 'בידור'], ['דיסני פלוס 30', 'בידור'],
  ['קולנוע 80', 'בידור'], ['הופעה 250', 'בידור'], ['תיאטרון 180', 'בידור'],
  ['מסיבה 100', 'בידור'], ['בילוי 120', 'בידור'],

  // ── חינוך: childcare, lessons, professional courses ──
  ['שכר לימוד 5000', 'חינוך'], ['גן ילדים 2500', 'חינוך'], ['צהרון 1200', 'חינוך'],
  ['שיעור פרטי 150', 'חינוך'], ['חוג העשרה 220', 'חינוך'], ['מעון 2800', 'חינוך'],
  ['קורס תכנות 400', 'חינוך'],

  // ── קניות: shopping (clothing, electronics, home) ──
  ['זארה 200', 'קניות'], ['קסטרו 180', 'קניות'], ['פוקס 140', 'קניות'],
  ['קניתי נעליים 300', 'קניות'], ['אייפון 4000', 'קניות'], ['אוזניות 250', 'קניות'],
  ['מחשב נייד 5500', 'קניות'], ['איקאה 800', 'קניות'], ['רהיט 1200', 'קניות'],
  ['אלקטרוניקה 500', 'קניות'],   // ITEM 4 (2026-06-01): dashboard label
  ['רהיטים 800', 'קניות'],       // ITEM 4: already routed; anchored as golden
  ['ספה 3000', 'קניות'], ['כיסא משרדי 600', 'קניות'], ['בגדים 350', 'קניות'],
  ['חולצה 90', 'קניות'], ['מתנה ליום הולדת 150', 'מתנות'],

  // ── טיפוח: grooming ──
  ['תספורת 80', 'טיפוח'], ['מספרה 120', 'טיפוח'], ['מניקור 100', 'טיפוח'],
  ['פדיקור 110', 'טיפוח'], ['קוסמטיקאית 300', 'טיפוח'],

  // ── pets: top-level is the catch-all bucket, so assert the subcategory ──
  ['וטרינר 350', 'sub:חיות מחמד'], ['אוכל לכלב 120', 'sub:חיות מחמד'],
  ['חתול וטרינר 280', 'sub:חיות מחמד'], ['חול לחתול 40', 'sub:חיות מחמד'],

  // ── finance ──
  ['קרן השתלמות 1500', 'פיננסים'],
  ['השקעה 2000', 'sub:השקעות'],       // subcategory carries the signal
  ['עמלת בנק 25', 'בנקאות'],

  // ── הכנסות: income ──
  ['משכורת 12000', 'הכנסות'], ['הכנסה ממשכורת 9500', 'הכנסות'], ['בונוס 5000', 'הכנסות'],

  // PR-B 2026-05-28 — "לימים" is Steven's actual typo of "לימודים" living
  // in the OLD sheet's top-20 col E values (per docs section 3.2). Added
  // as a CATEGORY_MAP keyword so future writes route to לימודים row.
  ['לימים 400', 'הוצאות קבועות'],

  // 2026-05-31 — Steven OLD-sheet reconciliation anchors. These 4 named
  // subcategories already route in CATEGORY_MAP (lines ~410-413); the bot
  // writes the col-E string the parallel migration's dashboard rows expect.
  // The signal is the SUB (top-level הוצאות זמניות is a bucket), so
  // sub: locks the exact bucket name and trips the build if anyone regresses
  // a route back to שונות or flips its taxonomy. Categories are intentionally
  // per Steven's OLD-sheet sections (NOT בריאות/נסיעות): גיא + race expenses
  // sit under הוצאות זמניות.
  ['גיא 500', 'sub:גיא'],
  ['חצי איירון מן 1200', 'sub:חצי איירון מן'],
  ['מרוץ אוסטריה 800', 'sub:מרוץ - אוסטריה'],
  // 2026-05-31: Steven CONFIRMED קולקציות = his SRC BUSINESS, rerouted from
  // תחביבים to category "עסק" (per docs/PERSONALIZED_CATEGORY_PROFILES.md
  // row #4). Two anchors guard the change: the bare-category row asserts the
  // BUSINESS category "עסק" (FAILS if it ever falls back to שונות or תחביבים),
  // the sub: row pins the exact bucket "קולקציות". Together: business cat + sub.
  ['קולקציות 300', 'עסק'],
  ['קולקציות 300', 'sub:קולקציות'],

  // ── עסק: business (PR-B 2026-05-28 — canonical subs per docs section 4) ──
  // After PR-B, CATEGORY_MAP business rows emit the EXACT subcategory the
  // company dashboard SUMIFS expects, so a non-עסק-prefixed message that
  // hits a business keyword classifies into category 'עסק' with the
  // canonical sub. Top-of-category is 'עסק'; sub: assertions guard the
  // canonical bucket name.
  ['marketing 320', 'sub:עלות שיווק'],
  ['advertising 500', 'sub:עלות שיווק'],
  ['קמפיין 1200', 'sub:עלות שיווק'],
  ['raw materials 900', 'sub:עלות חומרי גלם'],
  ['חומרי גלם 1500', 'sub:עלות חומרי גלם'],
  ['shipping 60', 'sub:משלוחים והתקנות'],
  ['אריזה ומשלוח 90', 'sub:משלוחים והתקנות'],
  ['saas 150', 'sub:הוצאות תפעוליות'],
  ['vat payment 4500', 'sub:הוצאות תפעוליות'],
  ['accountant 1500', 'sub:יועצים'],
  ['רואה חשבון 800', 'sub:יועצים'],

  // ── 2026-06-01 NATURAL BUSINESS EXPENSE anchors. Steven's bug: a plain
  // "עסק [business name] [amount] [category]" message (and the "הוצאה עסק ..."
  // variant) must route to the BUSINESS top-level "עסק", never to a personal
  // dropdown. matchCategory's standalone-עסק detection already yields category
  // "עסק"; these anchors lock it so a future taxonomy change can't regress the
  // natural business shape back to personal/שונות. (The processExpense write
  // path is covered separately by the bot replay + harness in the PR.) ──
  ['הוצאה עסק תמונות 288 שיווק', 'עסק'],
  ['עסק תמונות 288 שיווק', 'עסק'],
  ['עסק 288 שיווק', 'עסק'],
  ['עסק תמונות 500 משלוחים', 'עסק'],

  // ── DEFAULT: genuinely ambiguous → the bot SHOULD ask ──
  ['250', 'DEFAULT'], ['תשלום 500', 'DEFAULT'], ['העברה 1000', 'DEFAULT'],
  ['משהו 50', 'DEFAULT'], ['קניתי דברים 100', 'DEFAULT'], ['עוד הוצאה 30', 'DEFAULT'],
  ['החזר חוב 200', 'DEFAULT'], ['הוצאה 80', 'DEFAULT'], ['שילמתי 300', 'DEFAULT'],
  ['כסף 500', 'DEFAULT'], ['בר 130', 'DEFAULT'],
  ['משחק כדורגל 200', 'DEFAULT'], ['גז 90', 'DEFAULT'], ['צעצוע לילד 120', 'DEFAULT'],
  ['קיבלתי תשלום 3000', 'DEFAULT'], ['פרילנס 4000', 'DEFAULT'], ['קצבה לפנסיה 900', 'DEFAULT'],
  // bare 2-char brand/word inputs are genuinely ambiguous (פז = Paz / topaz /
  // name; גט = Gett app / divorce doc) → asking IS the correct behavior here.
  ['פז 280', 'DEFAULT'], ['גט 48', 'DEFAULT'],
  ['ספר 80', 'sub:ספרים'],   // the map files a lone "ספר" as a book

  // ── 2026-06-01 classifier-accuracy fixes (ADDITIVE, length-sorted). Each
  // anchor pins a GENUINE misroute fixed this cycle; the paired guard anchor
  // proves the additive keyword did not relax an existing correct match. ──
  //
  // (1) Migdal INSURANCE was silently written to קניות/אלקטרוניקה because the
  // bare "מגדל" (PC tower) tied the insurer "מגדל" on length-4 and won by map
  // order. Added "מגדל ביטוח"/"ביטוח מגדל" (len 10) -> insurance. NEVER-CORRUPT
  // note: this was a SILENT keyword write to the wrong category, now corrected.
  ['מגדל ביטוח 280', 'הוצאות קבועות'],
  ['ביטוח מגדל 280', 'הוצאות קבועות'],
  // guard: the other insurers + bare-tower must be untouched.
  ['הראל 280', 'הוצאות קבועות'], ['כלל 500', 'הוצאות קבועות'],
  ['הפניקס 300', 'הוצאות קבועות'], ['מנורה 200', 'הוצאות קבועות'],
  //
  // (2) VAT REFUND with no geresh ("החזר מעמ") hit the bare 3-char "מעמ" in the
  // business-tax EXPENSE row -> a refund (income) booked as an operating
  // expense: a SIGN FLIP on the company P&L. Added the no-geresh "החזר מעמ"
  // (len 8) to the canonical income/מחזור row. The signal is the sub.
  ['החזר מעמ 900', 'sub:מחזור'],
  // guard: a plain VAT PAYMENT stays an expense (must NOT flip to income).
  ['תשלום מעמ 4500', 'sub:הוצאות תפעוליות'],
  //
  // (3) "בוסט לפוסט" (boost a post = ad spend) matched the 4-char restaurant
  // keyword "פוסט" -> filed under dining-out, polluting both food AND marketing
  // totals. Added "בוסט לפוסט" (len 9) to the marketing/שיווק row.
  ['בוסט לפוסט 90', 'sub:שיווק'],
  // (4) influencer SINGULAR "משפיען" fell through to DEFAULT (only the plural
  // "משפיענים" routed). Added the singular for consistency. No competing kw.
  ['משפיען 1500', 'sub:שיווק'],
  // guard: the bare restaurant keyword still files dining-out correctly.
  ['פוסט 60', 'אוכל'],
  //
  // (5) "בית ספר" (school fees) matched the bare 3-char "ספר" (book) -> filed
  // under שונות/ספרים. Added "בית ספר"/"בית הספר" (len 7-8) -> חינוך.
  ['בית ספר 2000', 'חינוך'], ['בית הספר 2000', 'חינוך'],
  // guard above already pins ['ספר 80','sub:ספרים'] (a lone book stays a book).
  //
  // (6) "דמי טיפול רפואי" (a medical handling/treatment fee) was captured by the
  // bank-fee "דמי טיפול" (len 9) -> בנקאות. Added the explicit 14-char medical
  // phrase -> בריאות. The bare "דמי טיפול" still routes to bank (defensible).
  ['דמי טיפול רפואי 200', 'בריאות'],
  //
  // (7) "בקבוק יין" (a wine bottle = retail alcohol for home) matched the bare
  // 3-char "יין" in the restaurant row -> dining-out. Added "בקבוק יין" (len 9)
  // -> the home alcohol bucket. Signal is the sub.
  ['בקבוק יין 90', 'sub:אוכל לבית — יין ואלכוהול'],

  // ── 2026-06-02 SIGN-FLIP + INCOME/INSTALLMENT coverage (ADDITIVE). A 45-msg
  // Hebrew corpus was replayed through the REAL classifier (bot/bot-replay.js)
  // hunting income/expense sign-flips; see bot/BOT_IMPROVEMENTS.md for the full
  // report. Every anchor below ALREADY passes on current source — they lock the
  // classifier's correct income/expense polarity so a future taxonomy edit that
  // quietly flips a refund into an expense (or a payment into income) trips the
  // build. The 4 GENUINE misroutes the corpus found are NOT anchored here yet
  // (they fail today); BOT_IMPROVEMENTS.md carries the exact additive fix + the
  // anchor to add the moment that fix lands in ExpenseBot_FIXED.gs.
  //
  // (A) VAT/tax REFUNDS are revenue (מחזור, isIncome) — must NOT book as an
  // operating expense (a sign-flip on the company P&L). The geresh + no-geresh +
  // English forms all route income today; pinned so they stay income.
  ['החזר מע"מ 900', 'sub:מחזור'],
  ['החזר מעמ 900', 'sub:מחזור'],
  ['vat refund 900', 'sub:מחזור'],
  ['tax refund 900', 'sub:מחזור'],
  ['rebate 300', 'sub:מחזור'],
  // (A-guard) the OPPOSITE polarity: a VAT PAYMENT is an expense and must stay
  // one — the matching guard that proves the refund keywords above did not
  // relax the payment route.
  ['תשלום מעמ 4500', 'sub:הוצאות תפעוליות'],
  ['עסק תשלום מעמ 4500', 'עסק'],
  //
  // (B) business REVENUE phrases (customer receipt, product/service sale) route
  // to מחזור income; pinned so the company top-line can't silently lose a sale.
  ['תקבול לקוח 5000', 'sub:מחזור'],
  ['מכירת מוצר 1500', 'sub:מחזור'],
  ['מכירת שירות 1200', 'sub:מחזור'],
  // business revenue via the עסק prefix (BUSINESS_CATEGORY_MAP path).
  ['עסק הכנסה 10000', 'עסק'],
  ['עסק תמונות הכנסה 8000', 'עסק'],
  //
  // (C) PERSONAL income: salary (incl. the natural "קיבלתי משכורת") and the
  // business-income personal row stay income, top-level הכנסות.
  ['קיבלתי משכורת 9000', 'הכנסות'],
  ['הכנסה עסקית 10000', 'הכנסות'],
  //
  // (D) INSTALLMENTS (תשלומים / "N תשלומים" / "תשלום X מתוך Y"): the multi-
  // payment phrasing must NOT change the category or flip the sign — each stays
  // an expense in its real domain (a fridge/iphone is shopping, car insurance is
  // transport), the amount handling is covered by bot/test_installments_hebrew.js.
  ['תשלום 1 מתוך 12 על אייפון 400', 'קניות'],
  ['רהיטים 6 תשלומים 1800', 'קניות'],
  ['ביטוח רכב 12 תשלומים 320', 'תחבורה'],
  //
  // (E) a pro-equipment purchase carrying the עסק prefix routes business opex,
  // not a personal electronics buy.
  ['מצלמה מקצועית לעסק 4000', 'עסק'],
];

// ── Run ──────────────────────────────────────────────────────────────────────
const topOf = (c) => String(c || '').split('/')[0].trim();
let correct = 0;
const byCat = {};       // label → {ok, total}
const misses = [];
for (const [msg, want] of GOLDEN) {
  const r = matchCategory(msg) || {};
  const isDef = r.category === DEF.category && r.subcategory === DEF.subcategory;
  let ok;
  if (want === 'DEFAULT') ok = isDef;
  else if (want.startsWith('sub:')) ok = !isDef && String(r.subcategory || '').indexOf(want.slice(4)) >= 0;
  else ok = !isDef && topOf(r.category) === want;
  byCat[want] = byCat[want] || { ok: 0, total: 0 };
  byCat[want].total++; if (ok) byCat[want].ok++;
  if (ok) correct++;
  else misses.push({ msg, want, got: isDef ? 'DEFAULT' : (r.category + ' / ' + r.subcategory) });
}

const total = GOLDEN.length;
const acc = correct / total;
const THRESHOLD = 0.93;   // honest regression floor; measured accuracy printed below

console.log('\n══ GOLDEN-SET ACCURACY ══  (' + total + ' labeled messages)');
console.log('  per-label (correct / total):');
Object.keys(byCat).sort().forEach(c => {
  const b = byCat[c];
  const pct = ((b.ok / b.total) * 100).toFixed(0);
  console.log('    ' + (b.ok === b.total ? '✅' : '⚠️ ') + ' ' + c.padEnd(18) + ' ' + b.ok + '/' + b.total + '  (' + pct + '%)');
});
if (misses.length) {
  console.log('\n  misses (label → classifier):');
  misses.forEach(m => console.log('    ✗ ' + m.msg.padEnd(24) + ' want ' + m.want + '  got ' + m.got));
}
console.log('\n  ACCURACY: ' + (acc * 100).toFixed(1) + '%  (' + correct + '/' + total + ')   threshold ' + (THRESHOLD * 100) + '%');

if (acc >= THRESHOLD) {
  console.log('✅ GOLDEN SET PASSED\n');
  process.exit(0);
} else {
  console.log('❌ GOLDEN SET BELOW THRESHOLD — classifier accuracy regressed\n');
  process.exit(1);
}
