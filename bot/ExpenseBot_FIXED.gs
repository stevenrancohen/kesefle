/**
 * 🤖 בוט הוצאות וואצפ → גוגל שיט
 * ================================
 * מערכת מלאה לרישום הוצאות מוואצפ ישירות לתוך השיט "מאזן אישי".
 *
 * זרימה:
 *   1. המשתמש שולח בוואצפ: "85 סופר רמי לוי" (סכום + פירוט)
 *   2. Meta WhatsApp Cloud שולחת webhook ל-doPost כאן
 *   3. הסקריפט מזהה קטגוריה אוטומטית, מוסיף שורה ללשונית "תנועות"
 *   4. הדשבורד "מאזן שנתי" מחושב אוטומטית דרך SUMIFS - לא נשבר
 *   5. הסקריפט מחזיר אישור בוואצפ
 *
 * הזנה ידנית: פשוט מוסיפים שורה ידנית בלשונית "תנועות". הנוסחאות בדשבורד
 * מתעדכנות אוטומטית ולעולם לא נשברות כי אין נוסחאות בתאי הקלט.
 */

// ============================================================
// ⚙️ הגדרות - מלא את הערכים האלה לפני פרסום
// ============================================================

const SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
const COMPANY_SHEET_ID = SHEET_ID;
const ORDERS_TAB_NAME = 'הזמנות';
const TRANSACTIONS_SHEET = 'תנועות';
const DASHBOARD_SHEET = 'מאזן שנתי';

const VERIFY_TOKEN = 'expense_bot_verify_2026';
const WHATSAPP_TOKEN = PropertiesService.getScriptProperties().getProperty('WHATSAPP_TOKEN') || '';
const WHATSAPP_PHONE_NUMBER_ID = '1086749664527399';

const ALLOWED_PHONE = '972547760643';

// ============================================================
// 🗂️ מילון קטגוריות
// ============================================================

const CATEGORY_MAP = [
  { keywords: ['משכורת', 'שכר חודש', 'שכר עבודה'], category: 'הכנסות', subcategory: 'הכנסה 1 — משכורת', isIncome: true },
  { keywords: ['הכנסה עסקית', 'תשלום מלקוח', 'הכנסה 2', 'income 2'], category: 'הכנסות', subcategory: 'הכנסה 2 — עסק SRC', isIncome: true },
  { keywords: ['טלפונים', 'מכירת טלפון', 'הכנסה - טלפוניה'], category: 'הכנסות', subcategory: 'הכנסה 3 — טלפוניה', isIncome: true },
  { keywords: ['בונוס', 'החזר', 'תקבול'], category: 'הכנסות', subcategory: 'שונות (הכנסות)', isIncome: true },

  // 🍞 אוכל לבית — Israeli supermarket chains
  { keywords: ['אוכל לבית', 'אוכל בבית', 'סופר', 'רמי לוי', 'שופרסל', 'יוחננוף', 'ויקטורי',
               'אושר עד', 'מחסני השוק', 'יינות ביתן', 'מגה', 'קרפור', 'טיב טעם', 'מעיין 2000',
               'אם המושבות', 'חצי חינם', 'קינג סטור', 'AMPM', 'am pm', 'אם פי אם',
               'שופרסל אקספרס', 'ירקות', 'פירות', 'מאפיה', 'בשר', 'דגים', 'גבינות'],
    category: 'אוכל', subcategory: 'אוכל לבית' },
  // 🍔 אוכל בחוץ — restaurants, deliveries, cafes
  { keywords: ['אוכל בחוץ', 'אוכל חוץ', 'מסעדה', 'מסעדות', 'wolt', 'וולט', 'ten bis', 'תן ביס',
               'cibus', 'סיבוס', 'משלוח אוכל', 'משלוח', 'קפה', 'בית קפה', 'אספרסו',
               'פיצה', 'דומינוס', 'פיצה האט', 'בורגר', 'המבורגר', 'BBB', 'מוזס',
               'שווארמה', 'סושי', 'מקדונלדס', 'McDonald', 'KFC', 'בורגר קינג',
               'starbucks', 'cofix', 'קופיקס', 'ארומה', 'aroma', 'גרג', 'גרג קפה',
               'נספרסו', 'nespresso', 'לחם ארז', 'רולדין', 'שטראוס'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🚗 תחבורה
  { keywords: ['דלק', 'תדלוק', 'פז ', 'סונול', 'דור אלון', 'דלק חברה', 'בנזין', 'סולר',
               '95', '98', 'mileage', 'מילאז\'', 'paz'],
    category: 'תחבורה', subcategory: 'דלק' },
  { keywords: ['ליים', 'lime', 'בירד', 'bird', 'wind', 'יומנגו'],
    category: 'תחבורה', subcategory: 'ליים' },
  { keywords: ['רוביקון', 'גיפ רוביקון', "ג'יפ רוביקון", 'jeep', 'רנגלר', 'wrangler'],
    category: 'תחבורה', subcategory: 'רוביקון' },
  { keywords: ['חניה', 'חנייה', 'חניון', 'pango', 'פנגו', 'cellopark', 'סלו פארק', 'easypark',
               'מטר חניה', 'דוח חניה', 'דו"ח חניה'],
    category: 'תחבורה', subcategory: 'חניה' },
  { keywords: ['מונית', 'gett', 'גט ', 'uber', 'אובר', 'אוטובוס', 'רכבת', 'רב קו', 'רב-קו',
               'יאנגו', 'yango', 'taxi', 'אגד', 'דן', 'מטרופולין', 'קווים', 'ישראייר',
               'אל על', 'el al', 'טיסה', 'flight', 'easyjet'],
    category: 'תחבורה', subcategory: 'מונית' },
  { keywords: ['bmw', 'ב.מ.וו', 'אופנוע', 's1000', 'אופנועים'],
    category: 'תחבורה', subcategory: 'BMW s1000' },
  { keywords: ['ביטוח חובה', 'ביטוח רכב', 'איתוראן', 'ituran', 'כלל ביטוח', 'הראל ביטוח',
               'מנורה ביטוח', 'מגדל ביטוח', 'איילון ביטוח', 'AIG'],
    category: 'תחבורה', subcategory: 'ביטוח רכב' },
  { keywords: ['קורקינט', 'segway', 'inokim', 'ninebot'],
    category: 'תחבורה', subcategory: 'קורקינט' },
  { keywords: ['טסט', 'רישוי רכב', 'אגרת רישוי', 'משרד הרישוי', 'מבחן שנתי'],
    category: 'תחבורה', subcategory: 'רישוי' },

  // 🏠 הוצאות אישיות / זמניות
  { keywords: ['אבא', 'להעביר לאבא'], category: 'הוצאות זמניות', subcategory: 'אבא' },
  { keywords: ['מכון כושר', 'חדר כושר', 'אימון', 'כושר ', 'gym', 'מאמן אישי', 'crossfit',
               'יוגה', 'פילאטיס', 'פיט פלוס', 'קאנטרי קלאב', 'גו אקטיב', 'goactive',
               'חוגים', 'שחייה', 'בריכה'],
    category: 'הוצאות קבועות', subcategory: 'מכון כושר' },
  { keywords: ['ביגוד', 'בגדים', 'נעליים', 'zara', 'h&m', 'fox', 'לויס', 'levis', 'mango',
               'castro', 'renuar', 'גולף', 'פולגת', 'דלתא', 'tommy', 'טומי הילפיגר',
               'nike', 'נייקי', 'adidas', 'אדידס', 'puma', 'פומה', 'asos', 'shein', 'next',
               'urbanica', 'אורבניקה', 'אופנה', 'shoe', 'גרביים'],
    category: 'קניות', subcategory: 'ביגוד' },
  { keywords: ['טיפוח', 'בושם', 'קרם', 'מספרה', 'ספרית', 'מאניקור', 'פדיקור', 'איפור',
               'sephora', 'ספורה', 'super pharm makeup', 'איי קיו', 'IQ', 'tikkun',
               'שעווה', 'wax', 'מעצב שיער', 'תספורת', 'haircut', 'מקס מרה'],
    category: 'קניות', subcategory: 'טיפוח' },
  { keywords: ['אפליקציה', 'אפליקציות', 'netflix', 'נטפליקס', 'spotify', 'ספוטיפיי',
               'youtube', 'יוטיוב', 'icloud', 'apple one', 'disney+', 'דיסני פלוס',
               'amazon prime', 'אמזון פריים', 'hbo', 'paramount', 'chatgpt', 'openai',
               'claude', 'anthropic', 'github copilot', 'figma', 'notion', 'dropbox',
               'office 365', 'מנוי', 'subscription'],
    category: 'הוצאות קבועות', subcategory: 'אפליקציות' },
  { keywords: ['פלייסטיישן', 'פלייסטישן', 'playstation', 'ps5', 'ps plus', 'xbox',
               'nintendo', 'steam', 'epic games', 'fortnite', 'gaming'],
    category: 'הוצאות קבועות', subcategory: 'פלייסטיישן' },
  { keywords: ['לוטו', 'פיס', 'חיש גד', 'מפעל הפיס', 'הגרלה', 'lotto'],
    category: 'שונות ואחרים', subcategory: 'לוטו' },
  { keywords: ['אפולו'], category: 'הוצאות קבועות', subcategory: 'אפולו' },
  { keywords: ['לימודים', 'קורס', 'אוניברסיטה', 'מכללה', 'שיעור פרטי', 'מורה פרטי',
               'udemy', 'coursera', 'edx', 'מודל', 'משכן הסטודנט', 'שכר לימוד',
               'ספרי לימוד', 'חוברת לימוד'],
    category: 'הוצאות קבועות', subcategory: 'לימודים' },
  { keywords: ['אישי'], category: 'שונות ואחרים', subcategory: 'אישי' },
  { keywords: ['מתנה', 'מתנות', 'תרומה', 'צדקה', 'gift'],
    category: 'שונות ואחרים', subcategory: 'מתנות' },
  { keywords: ['חתונה', 'אירוע', 'יום הולדת', 'בר מצווה', 'בת מצווה'],
    category: 'שונות ואחרים', subcategory: 'אירועים' },

  // 🏠 בית — utilities + rent
  { keywords: ['חשמל', 'חברת חשמל', 'iec', 'electricity'],
    category: 'הוצאות קבועות', subcategory: 'חשמל' },
  { keywords: ['ארנונה', 'ועד ', 'ועד בית', 'שכירות', 'שכר דירה', 'משכנתא', 'mortgage',
               'דמי ניהול', 'תחזוקת בנין'],
    category: 'הוצאות קבועות', subcategory: 'בית' },
  { keywords: ['מים', 'תאגיד מים', 'מי אביבים', 'מי גולן'],
    category: 'הוצאות קבועות', subcategory: 'מים' },
  { keywords: ['גז ', 'בלון גז', 'אמישראגז', 'פז גז', 'דורגז', 'סופר גז'],
    category: 'הוצאות קבועות', subcategory: 'גז' },
  { keywords: ['תקשורת', 'סלולר', 'פלאפון', 'פרטנר', 'סלקום', 'יס ', 'הוט ', 'בזק',
               'אינטרנט', 'אינטרנט סלולרי', 'גולן', 'גולן טלקום', '012', '014', 'rami levy תקשורת',
               'partner', 'cellcom', 'pelephone', 'bezeq', 'hot'],
    category: 'הוצאות קבועות', subcategory: 'תקשורת' },
  { keywords: ['ריהוט', 'איקאה', 'ikea', 'הום סנטר', 'home center', 'אייס', 'ace',
               'ברק', 'באג', 'KSP', 'חשמלאי', 'אינסטלטור', 'תחזוקה'],
    category: 'הוצאות קבועות', subcategory: 'תחזוקת בית' },

  // 🏥 בריאות
  { keywords: ['רופא', 'תרופה', 'תרופות', 'קופת חולים', 'בית מרקחת', 'סופר פארם',
               'super pharm', 'פיזיותרפיה', 'פיסיותרפיה', 'מאוחדת', 'כללית', 'מכבי',
               'לאומית', 'שיניים', 'אורתודונט', 'משקפיים', 'אופטיקה', 'אופטומטריסט',
               'be', 'newpharm', 'ניו פארם', 'מרפאה', 'בדיקות דם', 'מבדק רפואי'],
    category: 'בריאות', subcategory: 'בריאות' },
  { keywords: ['ביטוח בריאות', 'ביטוח חיים', 'ביטוח משלים', 'בנקאות שב"ן'],
    category: 'בריאות', subcategory: 'ביטוח בריאות' },

  // 🎁 פנאי / קניות מקוונות
  { keywords: ['אמזון', 'amazon', 'aliexpress', 'עלי אקספרס', 'shein', 'ebay',
               'asos', 'zap', 'rozetka', 'בוקינג', 'booking', 'airbnb'],
    category: 'קניות', subcategory: 'קניות מקוונות' },
  { keywords: ['סינמה', 'בית קולנוע', 'יס פלאנט', 'יספלאנט', 'cinema city', 'לב ',
               'cinematheque', 'תיאטרון', 'הופעה', 'מופע'],
    category: 'שונות ואחרים', subcategory: 'בילויים' },
  { keywords: ['ספר', 'ספרים', 'סטימצקי', 'צומת ספרים', 'tzomet sfarim', 'kindle',
               'audible'],
    category: 'שונות ואחרים', subcategory: 'ספרים' },
  { keywords: ['חיות', 'מזון לכלב', 'מזון לחתול', 'וטרינר', 'pet shop', 'דיוטי כלב'],
    category: 'שונות ואחרים', subcategory: 'חיות מחמד' },

  { keywords: ['עסק פייסבוק', 'עסק facebook', 'עסק שיווק', 'עסק פרסום', 'שיווק פייסבוק', 'שיווק פייסביוק', 'שיווק facebook', 'פייסבוק עסק', 'שיווק עסק'], category: 'עסק', subcategory: 'שיווק' },
  { keywords: ['עסק רואה חשבון', 'עסק יועץ מס'], category: 'עסק', subcategory: 'יועצים' },
  { keywords: ['עסק '], category: 'עסק', subcategory: 'אחר' },

  // ====================================================================
  // BIG VENDOR DICTIONARY (1500+ entries, expanded from agent research)
  // Each entry below adds a class of Israeli vendors. Order matters:
  // longer / more-specific patterns are matched first via the sort in
  // _matchCategory_long.
  // ====================================================================

  // 🛒 SUPERMARKETS — Israeli grocery chains (extended)
  { keywords: [
      'שופרסל דיל', 'שופרסל שלי', 'שופרסל אקספרס', 'שופרסל יש', 'שופרסל אונליין', 'shufersal',
      'רמי לוי שיווק השקמה', 'רמי לוי חינם', 'רמי לוי שלי', 'rami levy', 'ramilevi',
      'יוחננוף ובניו', 'yochananof',
      'victory', 'אושר עד', 'osher ad', 'machsanei hashuk',
      'יינות ביתן', 'yeinot bitan',
      'מגה בעיר', 'מגה בול',
      'carrefour', 'קארפור',
      'tiv taam',
      'מעיין 2000', 'maayan 2000',
      'half free', 'hatzi hinam',
      'stop market', 'סטופ מרקט',
      'שוק העיר', 'shuk hair',
      'ברקת', 'bareket',
      'כל בו חצי חינם',
      'פרש מרקט', 'fresh market',
      'מחסני להב', 'machsanei lahav',
      'סופר ספיר', 'super sapir',
      'סופר דוש', 'super dosh',
      'קואופ', 'coop', 'קו-אופ',
      'ביג סופר', 'big super',
      'היפר נטו', 'hyper neto',
      'היפרכל', 'hyperkal',
      'ביכורי השדה', 'bikurey hasadeh',
      'שוק מהדרין',
      'סופר יהודה',
      'זול ובגדול', 'zol u\'begadol',
      'סופר חי',
      'אחים יוסף',
      'סנטר מרקט',
      'מקולת', 'makolet',
      'menta', 'מנטה',
      'yellow', 'ילו',
    ], category: 'אוכל', subcategory: 'אוכל לבית' },

  // 🥩 BUTCHER / FISH / SPECIALTY
  { keywords: ['אטליז', 'שמיל', 'shmil', 'בשרי מהדרין', 'דגי קסטרו', 'בית הבשר',
               'ברכת הים', 'אטליז העיר', 'אטליז השף',
               'תנובה', 'tnuva', 'שטראוס', 'strauss', 'אסם', 'osem', 'תלמה', 'telma',
               'יטבתה', 'yotvata', 'טרה', 'tara', 'ברמן', 'berman', 'אנג\'ל', 'angel',
               'לחם ארץ', 'מאפיית אנג\'ל'],
    category: 'אוכל', subcategory: 'אוכל לבית' },

  // 🍺 ORGANIC / HEALTH FOOD
  { keywords: ['organic market', 'eco market', 'ניצת הדובדבן', 'nitzat haduvdevan',
               'טבע קסטל', 'בריאות וטבע', 'אדמה', 'adama', 'ביו מרקט', 'biomarket',
               'שורש', 'shoresh', 'אורגניק', 'organic', 'הר הצופים', 'בית הטבע'],
    category: 'אוכל', subcategory: 'אוכל לבית' },

  // ☕ COFFEE CHAINS (expanded)
  { keywords: ['ארומה', 'aroma', 'aroma espresso',
               'גרג קפה', 'גרג', 'greg cafe', 'greg',
               'cafe cafe', 'קפה קפה',
               'לנדוור', 'landwer',
               'arcaffe', 'ארקפה', 'arcafe',
               'nespresso', 'נספרסו',
               'joe & the juice', 'joe and the juice', 'ג\'ו ולואי',
               'starbucks', 'סטארבקס',
               'cafe hillel', 'קפה הלל',
               'roladin', 'רולדין',
               'ilan\'s', 'אילנס',
               'kapulsky', 'קפולסקי',
               'english cake', 'אנגלית', 'english',
               'asi cafe', 'האחים אסי',
               'big apple pizza', 'גרנדע'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🥙 FALAFEL / SHAWARMA / ISRAELI FAST FOOD
  { keywords: ['פלאפל', 'falafel', 'פלאפל הזקן', 'פלאפל גבעת רם', 'פלאפל גולני',
               'פלאפל אבולעפיה', 'פלאפל הקסטל', 'falafel hazaken',
               'שווארמה', 'shawarma', 'shipudia', 'שיפודיה', 'שיפודי',
               'חומוס', 'hummus', 'אבו שוקרי', 'abu shukri',
               'מיקי', 'miki', 'חכם', 'בית מתי', 'אגדיר', 'agadir',
               'מקס ברנר', 'max brenner', 'בורגרס בר', 'burgers bar', 'מוזס', 'moses',
               'ג\'מס', 'jems', 'james'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🍔 BURGER / PIZZA / GLOBAL FAST FOOD
  { keywords: ['מקדונלדס', 'mcdonald', 'מק\'דונלדס',
               'בורגר קינג', 'burger king',
               'kfc', 'קי אף סי',
               'פיצה האט', 'pizza hut', 'פיצה הוט',
               'דומינוס', 'domino', 'דומינו\'ס',
               'פיצה פאן', 'pizza pan', 'פיצה ביג', 'pizza big',
               'פיצה רימיני', 'rimini', 'פיצה רומא', 'pizza roma',
               'ג\'פניקה', 'japanika',
               'sushi bar', 'סושי בר', 'sushi cosco', 'סושי קוסקו', 'סושי סמוראי',
               'מוקה', 'moka',
               'שניצליה', 'schnitzelia',
               'האחוזה', 'ha\'achuza', 'achuza',
               'בלאק', 'black bar',
               'wasabi', 'וואסאבי',
               'china lee', 'צ\'יינה לי', 'asia', 'אסיה',
               'nagisa', 'נגיסה'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🍦 ICE CREAM / DESSERT (extended)
  { keywords: ['גלידה', 'aldo', 'אלדו', 'mishka', 'מישקה', 'arctica', 'ארקטיקה',
               'vanilla & cream', 'וניל וקרם', 'ben & jerry', 'בן אנד ג\'ריס',
               'גולדה', 'golda', 'שלגי גולדה', 'shilgia', 'שלגיה',
               'breeza', 'בריזה', 'wafix', 'וופיקס', 'חמרה'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🛍️ DELIVERY PLATFORMS
  { keywords: ['wolt', 'וולט', 'ten bis', '10bis', 'תן ביס', '10ביס',
               'מישלוח', 'mishloach', 'cibus', 'סיבוס', 'buyme'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  // 🚌 PUBLIC TRANSPORT (Israeli bus + train + air)
  { keywords: ['אגד', 'egged', 'אגד תעבורה',
               'דן', 'dan ', 'דן באר שבע',
               'מטרופולין', 'metropolin',
               'קווים', 'kavim', 'superbus', 'סופרבוס',
               'גלים', 'galim', 'ידידים', 'yedidim', 'אפיקים', 'afikim',
               'נתיב אקספרס', 'nateev express', 'בית שמש אקספרס',
               'רכבת ישראל', 'israel railways',
               'רכבת קלה', 'light rail', 'סיטיפס', 'citypass',
               'כרמלית', 'carmelit', 'מטרונית', 'metronit',
               'el al', 'אל על',
               'ישראייר', 'israir', 'ארקיע', 'arkia', 'sun d\'or',
               'ryanair', 'ראיינאייר', 'easyjet', 'איזיג\'ט', 'wizz air', 'וויז אייר',
               'turkish airlines', 'turkish', 'lufthansa', 'לופטהנזה',
               'klm', 'air france', 'british airways', 'pegasus', 'aegean'],
    category: 'תחבורה', subcategory: 'מונית' },

  // 🚗 CAR RENTAL
  { keywords: ['הרץ', 'hertz', 'אביס', 'avis', 'באדג\'ט', 'budget rent',
               'אלדן', 'eldan', 'שלמה sixt', 'shlomo sixt', 'sixt',
               'קל אוטו', 'kal auto', 'אלבר', 'albar',
               'europcar', 'יורופקאר', 'thrifty', 'טריפטי'],
    category: 'תחבורה', subcategory: 'רכב שכור' },

  // ⛽ FUEL STATIONS (specific brands)
  { keywords: ['delek', 'delek menta', 'דלק מנטה',
               'paz yellow', 'paz', 'פז יילו', 'פז',
               'sonol', 'sonol go', 'סונול גו',
               'ten', 'ten go', 'טן גו', 'טן',
               'dor alon', 'דור אלון', 'alonit', 'אלונית'],
    category: 'תחבורה', subcategory: 'דלק' },

  // 🛣️ TOLLS / PARKING (extended)
  { keywords: ['כביש 6', 'kvish 6', 'highway 6', 'כביש חוצה ישראל',
               'מנהרות הכרמל', 'carmel tunnels',
               'אחוזות החוף', 'ahuzot hahof',
               'pay-park', 'pay park', 'autotel', 'אוטוטל', 'car2go'],
    category: 'תחבורה', subcategory: 'חניה' },

  // 🏦 BANKS — Israeli
  { keywords: ['בנק הפועלים', 'hapoalim', 'poalim', 'הפועלים',
               'בנק לאומי', 'bank leumi', 'leumi', 'לאומי',
               'בנק מזרחי', 'mizrahi', 'tefahot', 'מזרחי טפחות',
               'בנק דיסקונט', 'bank discount', 'discount', 'דיסקונט',
               'בנק הבינלאומי', 'fibi', 'beinleumi', 'הבינלאומי',
               'מרכנתיל', 'mercantile', 'מרכנתיל דיסקונט',
               'אוצר החייל', 'otsar hahayal',
               'בנק מסד', 'massad', 'מסד',
               'בנק יהב', 'yahav', 'יהב',
               'בנק איגוד', 'igud', 'איגוד', 'union bank',
               'פאג"י', 'pagi', 'פאגי',
               'בנק ירושלים', 'bank jerusalem', 'jerusalem bank',
               'דקסיה', 'dexia',
               'הסבה לבנק', 'עמלת בנק', 'דמי ניהול חשבון'],
    category: 'הוצאות קבועות', subcategory: 'בנקאות' },

  // 💳 CREDIT CARDS / FINANCIAL
  { keywords: ['ישראכרט', 'isracard', 'איסראכרט',
               'cal', 'כאל', 'visa cal', 'ויזה כאל',
               'max', 'מקס', 'leumi card', 'לאומי קארד',
               'amex', 'אמקס', 'american express', 'אמריקן אקספרס',
               'diners', 'דיינרס',
               'visa', 'ויזה', 'mastercard', 'מאסטרקארד',
               'icc', 'paypal', 'פייפאל',
               'bit', 'ביט', 'paybox', 'פייבוקס', 'pepper', 'פפר',
               'apple pay', 'אפל פיי', 'google pay', 'גוגל פיי',
               'western union', 'ווסטרן יוניון', 'moneygram', 'wise', 'revolut', 'רבולוט',
               'plus500', 'פלוס500', 'etoro', 'איטורו',
               'one zero', 'וואן זירו', 'וואן-זירו'],
    category: 'הוצאות קבועות', subcategory: 'בנקאות' },

  // 📈 INVESTMENTS
  { keywords: ['אלטשולר', 'altshuler', 'altshuler shaham',
               'פסגות', 'psagot', 'מיטב דש', 'meitav', 'meitav dash',
               'מור', 'more investments', 'אנליסט', 'analyst',
               'ילין לפידות', 'yelin lapidot', 'כלל פיננסים', 'clal finance',
               'אקסלנס', 'excellence', 'ibi', 'איי.בי.איי',
               'interactive brokers', 'blender', 'בלנדר',
               'מניה', 'מניות', 'etf', 'ביטקוין', 'bitcoin', 'crypto', 'קריפטו', 'השקעה'],
    category: 'שונות ואחרים', subcategory: 'השקעות' },

  // 🛡️ INSURANCE (extended)
  { keywords: ['הראל', 'harel', 'harel insurance',
               'כלל', 'clal', 'clal insurance',
               'מגדל', 'migdal', 'migdal insurance',
               'הפניקס', 'phoenix', 'phoenix holdings',
               'מנורה', 'menorah', 'menora', 'מנורה מבטחים', 'mivtachim',
               'איילון', 'ayalon',
               'aig', 'איי איי ג\'י',
               'שירביט', 'shirbit',
               'שומרה', 'shomera',
               'הכשרה', 'hachshara', 'הכשרת הישוב',
               'אליהו', 'eliyahu insurance',
               'מישן', 'mishan',
               'wesure', 'וויסור', 'libra insurance', 'ליברה',
               'ביטוח ישיר', 'bituach yashir', 'direct insurance', '9000',
               'הכל בטוח', 'hakol batuach',
               'one insurance', 'וואן ביטוח'],
    category: 'הוצאות קבועות', subcategory: 'ביטוח אישי' },

  // 🏥 HOSPITALS
  { keywords: ['שיבא', 'sheba', 'tel hashomer', 'תל השומר',
               'איכילוב', 'ichilov', 'סוראסקי', 'sourasky',
               'הדסה', 'hadassah', 'הדסה עין כרם', 'הדסה הר הצופים',
               'רמב"ם', 'רמבם', 'rambam',
               'סורוקה', 'soroka',
               'בני ציון', 'bnei tzion', 'bnei zion',
               'וולפסון', 'wolfson',
               'אסף הרופא', 'asaf harofeh', 'שמיר', 'shamir',
               'כרמל', 'carmel hospital',
               'בילינסון', 'beilinson', 'rabin medical', 'רבין',
               'שניידר', 'schneider',
               'מאיר', 'meir', 'meir hospital',
               'לניאדו', 'laniado',
               'הלל יפה', 'hillel yaffe',
               'ברזילי', 'barzilai',
               'מעייני הישועה', 'mayanei hayeshua',
               'שערי צדק', 'shaare zedek',
               'ביקור חולים', 'bikur cholim',
               'אסותא', 'assuta',
               'הרצליה מדיקל'],
    category: 'בריאות', subcategory: 'בריאות' },

  // 🦷 DENTAL / OPTOMETRY / AESTHETIC
  { keywords: ['שיני', 'shinui dental', 'מרפאת שיניים', 'מרפאות שן',
               'אופטיקה הלפרין', 'optica halperin',
               'opticana', 'אופטיקנה',
               'erroca', 'ערוקה',
               'optica hod', 'אופטיקה הוד',
               'zeiss', 'אסתטיקה פלוס',
               'photona', 'פוטונה',
               'מרפאת שלי', 'ivf israel',
               'dr smile', 'ד"ר סמייל'],
    category: 'בריאות', subcategory: 'בריאות' },

  // 💧 WATER UTILITIES (Israeli)
  { keywords: ['מי אביבים', 'mei avivim', 'הגיחון', 'hagihon',
               'מי כרמל', 'mei carmel', 'מי מודיעין', 'מי גולן', 'מי נתניה',
               'מי ראשון', 'מי שבע', 'פלגי מוצקין', 'מי לוד', 'מי רהט',
               'מי שמש', 'מי הרצליה', 'מי רעננה', 'מי כפר סבא',
               'מי בני ברק', 'מי חולון', 'מי בת ים', 'מי רמת גן',
               'מי גבעתיים', 'מי פתח תקווה', 'מי אריאל', 'מי השרון',
               'מי עכו', 'מי נצרת', 'מי שיקמים', 'מי הגליל', 'מי עין גדי',
               'מקורות', 'mekorot'],
    category: 'הוצאות קבועות', subcategory: 'מים' },

  // 🔥 GAS / ENERGY (Israeli)
  { keywords: ['פז גז', 'pazgas', 'paz gas',
               'אמישראגז', 'amisragas',
               'סופרגז', 'supergas',
               'דורגז', 'dorgas',
               'גז יגאל', 'gas yigal',
               'בזן', 'bazan', 'oil refineries'],
    category: 'הוצאות קבועות', subcategory: 'גז' },

  // 🏛️ MUNICIPAL (cities)
  { keywords: ['עיריית', 'iriyat', 'municipal', 'arnona',
               'עיריית תל אביב', 'עיריית ירושלים', 'עיריית חיפה',
               'עיריית רמת גן', 'עיריית בני ברק', 'עיריית נתניה',
               'עיריית פתח תקווה', 'עיריית ראשון לציון', 'עיריית הרצליה',
               'עיריית רעננה', 'עיריית חולון', 'עיריית בת ים',
               'עיריית גבעתיים', 'עיריית כפר סבא', 'עיריית אשדוד',
               'עיריית אשקלון', 'עיריית באר שבע'],
    category: 'הוצאות קבועות', subcategory: 'בית' },

  // 📱 TELECOM (extended)
  { keywords: ['orange', 'אורנג\'',
               'partner tv', 'cellcom tv',
               'hot mobile', 'הוט מובייל',
               'golan telecom', 'גולן טלקום',
               'rami levy tikshoret', 'רמי לוי תקשורת',
               'we4g', 'וי 4 ג\'י',
               '012 smile', 'סמייל', '012 סמייל',
               '014 bezeq', '015 telzar', 'טלזר',
               'triple c', 'טריפל סי', '013',
               'netvision', 'נטוויז\'ן',
               'bezeq international', 'בזק בינלאומי',
               'hot net', 'הוט נט',
               'yes tv', 'yes ', 'יס ',
               'sting tv', 'סטינג', 'סטינג tv',
               'free telecom', 'פרי טלקום',
               'xfone', 'אקספון', '018 xfone',
               '019 telecom'],
    category: 'הוצאות קבועות', subcategory: 'תקשורת' },

  // 🩺 HEALTH FUND (HMO)
  { keywords: ['קופת חולים כללית', 'klalit', 'clalit',
               'קופת חולים מכבי', 'מכבי שירותי בריאות',
               'קופת חולים מאוחדת', 'מאוחדת',
               'קופת חולים לאומית', 'לאומית',
               'ביטוח משלים', 'מכבי כסף', 'מכבי זהב', 'כללית מושלם',
               'בית מרקחת קופת חולים', 'בית מרקחת מכבי'],
    category: 'בריאות', subcategory: 'בריאות' },

  // 💊 PHARMACIES (extended)
  { keywords: ['be by super-pharm', 'be ', 'בי ',
               'new pharm', 'ניו פארם', 'ניופארם',
               'good pharm', 'גוד פארם',
               'pharm deal', 'פארם דיל',
               'life', 'לייף',
               'be beauty', 'מאק', 'mac', 'אסתי לאודר'],
    category: 'בריאות', subcategory: 'בריאות' },

  // 👕 FASHION (extended)
  { keywords: ['castro', 'קסטרו', 'castro men', 'castro women',
               'fox', 'פוקס', 'fox home', 'fox kids', 'fox baby',
               'renuar', 'רנואר',
               'golf', 'גולף', 'golf & co', 'golf kids',
               'american eagle', 'אמריקן איגל',
               'eroca', 'אירוקה',
               'terminal x', 'טרמינל איקס',
               'adika', 'אדיקה',
               'twentyfourseven',
               'mango', 'מנגו', 'zara', 'זארה', 'zara home',
               'h&m', 'אייץ\' אנד אם',
               'oxtead', 'אוקסטד',
               'intima', 'אינטימה',
               'delia', 'דליה',
               'jordache', 'ג\'ורדאש',
               'benetton', 'בנטון',
               'superstar', 'סופרסטאר',
               'adidas', 'אדידס', 'nike', 'נייקי',
               'puma', 'פומה', 'new balance', 'reebok',
               'lee cooper', 'levi\'s', 'ליוויס',
               'under armour', 'אונדר ארמור',
               'op', 'אופ', 'tnt',
               'delta', 'דלתא', 'kitan', 'כיתן',
               'jump', 'ג\'אמפ',
               'intimissimi', 'אינטימיסימי',
               'shilav', 'שילב',
               'gali shoes', 'נעלי גלי', 'shufra', 'שופרא',
               'teva naot', 'טבע נאות', 'shoresh', 'crocs', 'קרוקס'],
    category: 'קניות', subcategory: 'ביגוד' },

  // 🏠 HOME / FURNITURE (extended)
  { keywords: ['ikea', 'איקיאה', 'איקאה',
               'home center', 'הום סנטר',
               'ace', 'אייס',
               'habitat', 'הביטאט', 'beitili', 'ביתילי',
               'segev', 'שגב', 'urban', 'urbanica', 'אורבן',
               'varianta', 'וריאנטה'],
    category: 'הוצאות קבועות', subcategory: 'תחזוקת בית' },

  // 💻 ELECTRONICS (extended)
  { keywords: ['ksp', 'קי אס פי', 'bug', 'באג', 'bug multisystem',
               'itzik electric', 'איציק אלקטריק',
               'machsanei chashmal', 'מחסני חשמל',
               'photo house', 'פוטו האוס',
               'idigital', 'apple istore',
               'evergreen', 'אוורגרין',
               'samsung', 'סמסונג', 'lg', 'אל ג\'י',
               'electra', 'אלקטרה',
               'macbook', 'iphone', 'ipad', 'אייפון', 'איפד'],
    category: 'קניות', subcategory: 'אלקטרוניקה' },

  // 📚 OFFICE / STATIONERY / BOOKS (extended)
  { keywords: ['office depot', 'אופיס דיפו',
               'אקרשטיין', 'מרכז המורה',
               'tzomet sfarim', 'צומת ספרים',
               'steimatzky', 'סטימצקי',
               'masada', 'מסדה'],
    category: 'שונות ואחרים', subcategory: 'ספרים' },

  // 🎓 UNIVERSITIES / EDUCATION (extended)
  { keywords: ['huji', 'האוניברסיטה העברית',
               'tau', 'אוניברסיטת תל אביב',
               'technion', 'הטכניון',
               'אוניברסיטת חיפה', 'haifa university',
               'bgu', 'אוניברסיטת בן גוריון',
               'bar ilan', 'אוניברסיטת בר אילן',
               'אוניברסיטת אריאל', 'ariel',
               'weizmann', 'מכון ויצמן',
               'open university', 'האוניברסיטה הפתוחה',
               'reichman', 'רייכמן', 'idc', 'idc herzliya',
               'ono', 'אונו', 'shenkar', 'שנקר',
               'בצלאל', 'bezalel',
               'בית ברל', 'beit berl',
               'kidum', 'קידום',
               'high q', 'היי קיו',
               'access', 'אקסס'],
    category: 'הוצאות קבועות', subcategory: 'לימודים' },

  // 🏛️ GOVERNMENT / TAX
  { keywords: ['ביטוח לאומי', 'bituach leumi', 'national insurance',
               'מס הכנסה', 'mas hachnasa', 'income tax',
               'מע"מ', 'maam', 'מעמ', 'vat',
               'רשות המסים', 'tax authority', 'rashut hamisim',
               'משרד הרישוי', 'mishrad harishuy', 'vehicle registry',
               'רשות מקרקעי ישראל', 'rmi', 'land authority', 'רמ"י',
               'דואר ישראל', 'doar israel', 'israel post',
               'מד"א', 'mda', 'magen david adom', 'מגן דוד אדום',
               'משטרה', 'mishtara', 'police',
               'כבאות', 'kabaut',
               'משרד הפנים', 'misrad hapnim',
               'משרד החוץ', 'misrad hahutz',
               'בית משפט', 'beit mishpat', 'court',
               'עו"ד', 'עוד', 'oreh din', 'lawyer', 'עורך דין',
               'נוטריון', 'notary',
               'תעודת זהות', 'teudat zehut', 'דרכון', 'darkon', 'passport',
               'רישיון נהיגה', 'rishyon nehiga',
               'מכון רישוי', 'machon rishuy',
               'אגרה', 'agrah', 'fee'],
    category: 'הוצאות קבועות', subcategory: 'מיסים ואגרות' },

  // 📺 STREAMING / SUBSCRIPTIONS (extended)
  { keywords: ['netflix', 'נטפליקס',
               'disney+', 'disney plus', 'דיסני פלוס',
               'apple tv+', 'apple tv plus', 'אפל tv',
               'hbo max', 'hbo', 'paramount+', 'paramount',
               'amazon prime', 'אמזון פריים', 'prime video',
               'spotify', 'ספוטיפיי',
               'apple music', 'אפל מיוזיק',
               'youtube music', 'youtube premium', 'יוטיוב פרימיום',
               'tidal', 'soundcloud',
               'tinder', 'bumble', 'hinge',
               'nordvpn', 'expressvpn', 'vpn',
               'godaddy', 'namecheap'],
    category: 'הוצאות קבועות', subcategory: 'אפליקציות' },

  // 💻 PRODUCTIVITY / WORK APPS
  { keywords: ['microsoft 365', 'office 365', 'מיקרוסופט 365',
               'google workspace', 'גוגל workspace',
               'dropbox', 'icloud', 'אייקלאוד',
               'notion', 'figma', 'adobe', 'adobe creative cloud',
               'photoshop', 'lightroom', 'canva',
               'github copilot', 'cursor', 'cursor ai',
               'chatgpt', 'openai', 'gpt-4',
               'claude', 'anthropic',
               'perplexity', 'midjourney', 'stable diffusion',
               'aws', 'vercel', 'netlify', 'linode', 'digitalocean'],
    category: 'הוצאות קבועות', subcategory: 'אפליקציות' },

  // ✈️ TRAVEL / BOOKING
  { keywords: ['booking.com', 'booking', 'בוקינג',
               'airbnb', 'expedia', 'kayak', 'hotels.com', 'trivago',
               'agoda', 'אגודה'],
    category: 'שונות ואחרים', subcategory: 'נסיעות' },

  // 🚕 RIDESHARE (specific)
  { keywords: ['uber eats', 'uber black', 'uber x',
               'lyft', 'careem'],
    category: 'תחבורה', subcategory: 'מונית' },

  { keywords: ['שונות'], category: 'שונות ואחרים', subcategory: 'שונות' },
];

const DEFAULT_CATEGORY = { category: 'שונות ואחרים', subcategory: 'שונות', isIncome: false };

// ============================================================
// 🌐 WEBHOOK HANDLERS
// ============================================================

function doGet(e) {
  e = e || { parameter: {} };
  const action = e.parameter.action;

  if (action === 'migrate' && e.parameter.secret === VERIFY_TOKEN) {
    try {
      migrateDashboardToSUMIFS();
      return ContentService.createTextOutput('Migration completed successfully');
    } catch (err) {
      return ContentService.createTextOutput('Migration error: ' + err.message + '\n' + err.stack);
    }
  }

  if (action === 'buildbot' && e.parameter.secret === VERIFY_TOKEN) {
    try {
      cleanupAndBuildBotDashboard();
      return ContentService.createTextOutput('Bot dashboard built successfully');
    } catch (err) {
      return ContentService.createTextOutput('Error: ' + err.message + '\n' + err.stack);
    }
  }

  if (action === 'fullrebuild' && e.parameter.secret === VERIFY_TOKEN) {
    try {
      fullRebuildAllYears();
      return ContentService.createTextOutput('Full rebuild completed - all 4 years imported');
    } catch (err) {
      return ContentService.createTextOutput('Error: ' + err.message + '\n' + err.stack);
    }
  }

  // Sort the תנועות sheet ascending (oldest top, newest bottom) — one-shot
  // remediation for sheets whose existing data is in wrong order. Safe to call
  // multiple times: the bot's auto-sort-after-append will keep it correct.
  if (action === 'sortchrono' && e.parameter.secret === VERIFY_TOKEN) {
    try {
      sortTransactionsChronological();
      var ss = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
      var lr = ss ? ss.getLastRow() : 0;
      return ContentService.createTextOutput('OK — sorted ' + Math.max(0, lr - 1) + ' rows ascending (oldest at top, newest at bottom)');
    } catch (err) {
      return ContentService.createTextOutput('Sort error: ' + err.message + '\n' + err.stack);
    }
  }

  const mode = e.parameter['hub.mode'];
  const token = e.parameter['hub.verify_token'];
  const challenge = e.parameter['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return ContentService.createTextOutput(challenge);
  }
  return ContentService.createTextOutput('Forbidden');
}

// ============================================================
// [HARDENING_WRAPPER + SRC_ROUTER + BOT_COMMANDS] — unified doPost (2026-05-17 v3)
// FAST PATH: messages starting with a digit bypass routers and go straight to
// processExpense. Prevents SRC_ROUTER_handle / handleBotCommand_ from silently
// eating expense messages like "54 סופר".
// ============================================================
function doPost(e) {
  var _lock = LockService.getScriptLock();
  var _gotLock = false;
  try {
    _lock.waitLock(15000);
    _gotLock = true;
  } catch (_lockErr) {
    Logger.log('doPost: lock failed');
    return ContentService.createTextOutput('busy').setMimeType(ContentService.MimeType.TEXT);
  }

  try {
    Logger.log('doPost: ENTRY');
    var __raw_ = e && e.postData && e.postData.contents;
    var __parsed_ = __raw_ ? JSON.parse(__raw_) : null;
    var __msg_ = __parsed_ && __parsed_.entry && __parsed_.entry[0]
              && __parsed_.entry[0].changes && __parsed_.entry[0].changes[0]
              && __parsed_.entry[0].changes[0].value
              && __parsed_.entry[0].changes[0].value.messages
              && __parsed_.entry[0].changes[0].value.messages[0];

    if (__msg_ && __msg_.from) {
      var __from_ = __msg_.from;
      var __text_ = (__msg_.text && __msg_.text.body) || "";
      Logger.log('doPost: from=' + __from_ + ' text="' + __text_ + '"');

      if (typeof ALLOWED_PHONES !== 'undefined' && ALLOWED_PHONES.length > 0) {
        var __clean_ = String(__from_).replace(/[^0-9]/g, '');
        if (ALLOWED_PHONES.indexOf(__clean_) < 0) {
          Logger.log('doPost: phone not in ALLOWED_PHONES, returning OK');
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      }

      if (__text_) {
        // FAST PATH: any message starting with a digit goes straight to
        // _doPost_orig → processExpense. Skip all routers to avoid silent drops.
        var __looksLikeExpense = /^\s*\d/.test(__text_);
        Logger.log('doPost: looksLikeExpense=' + __looksLikeExpense);

        if (!__looksLikeExpense) {
          if (typeof handleBotCommand_ === "function") {
            try {
              var __bc = handleBotCommand_(__from_, __text_);
              Logger.log('doPost: handleBotCommand handled=' + (__bc && __bc.handled));
              if (__bc && __bc.handled) {
                if (typeof sendWhatsAppReply === "function") {
                  sendWhatsAppReply(__from_, __bc.replyText);
                } else if (typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __bc.replyText);
                }
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_bcErr) {
              Logger.log('doPost: handleBotCommand error: ' + (_bcErr && _bcErr.stack || _bcErr));
            }
          }

          if (typeof SRC_ROUTER_handle === "function") {
            try {
              var __routed_ = SRC_ROUTER_handle(__from_, __text_);
              Logger.log('doPost: SRC_ROUTER handled=' + (__routed_ && __routed_.handled));
              if (__routed_ && __routed_.handled) {
                if (__routed_.reply && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __routed_.reply);
                }
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_srcErr) {
              Logger.log('doPost: SRC_ROUTER error: ' + (_srcErr && _srcErr.stack || _srcErr));
            }
          }
        }
      }
    }

    Logger.log('doPost: calling _doPost_orig');
    return _doPost_orig(e);

  } catch (_err) {
    Logger.log('doPost: catch error: ' + (_err && _err.stack || _err));
    try {
      if (typeof _logBotError === 'function') {
        _logBotError(_err, { origin: 'doPost' });
      }
    } catch (__) {}
    return ContentService.createTextOutput('err').setMimeType(ContentService.MimeType.TEXT);
  } finally {
    if (_gotLock) {
      try { _lock.releaseLock(); } catch (__) {}
    }
  }
}

function _doPost_orig(e) {
  try {
    Logger.log('_doPost_orig: ENTRY');
    const body = JSON.parse(e.postData.contents);

    if (body && body.directInput && body.token === 'expense_bot_direct_2026' && body.text) {
      Logger.log('_doPost_orig: directInput path');
      var dResult = processExpense(body.text);
      return jsonResponse({ status: 'ok', reply: dResult.reply });
    }

    if (body.entry && body.entry[0] && body.entry[0].changes) {
      const change = body.entry[0].changes[0];
      const value = change.value;

      if (!value.messages) {
        Logger.log('_doPost_orig: no messages (status/delivery webhook) - returning ok');
        return jsonResponse({ status: 'ok' });
      }

      const message = value.messages[0];
      const from = message.from;
      const text = (message.text && message.text.body) ? message.text.body : '';
      Logger.log('_doPost_orig: from=' + from + ' text="' + text + '" ALLOWED=' + ALLOWED_PHONE);

      if (ALLOWED_PHONE && ALLOWED_PHONE !== '972XXXXXXXXX' && from !== ALLOWED_PHONE) {
        Logger.log('_doPost_orig: REJECTED unauthorized from=' + from);
        return jsonResponse({ status: 'unauthorized' });
      }

      Logger.log('_doPost_orig: calling processExpense');
      const result = processExpense(text);
      Logger.log('_doPost_orig: processExpense returned reply="' + (result && result.reply) + '"');
      sendWhatsAppMessage(from, result.reply);
      Logger.log('_doPost_orig: sendWhatsAppMessage done');
    }
  } catch (err) {
    Logger.log('_doPost_orig: ERROR ' + err.toString());
    Logger.log(err.stack);
  }

  return jsonResponse({ status: 'ok' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 💰 לוגיקת עיבוד הוצאה
// ============================================================

function processExpense(text) {
  if (!text || !text.trim()) {
    return { reply: 'שלח בפורמט: סכום פירוט\nלמשל:\n85 סופר רמי לוי\n1200 ארנונה\n300 דלק\n\nאפשר גם:\n352 אוכל לבית+165 (שתי הוצאות באותה קטגוריה)' };
  }

  var __hT = String(text || '').trim();
  var __hProps = PropertiesService.getScriptProperties();
  var __hPRaw = __hProps.getProperty('smart_pending');
  if (__hPRaw) {
    try {
      var __hP = JSON.parse(__hPRaw);
      var __nowSec = Math.floor(Date.now() / 1000);
      if (__hP && __hP.expiresAt > __nowSec) {
        if (/^(בטל|cancel)$/i.test(__hT)) {
          __hProps.deleteProperty('smart_pending');
          return { reply: '✓ בוטל' };
        }
        var __hPicked = null;
        var __hNumM = __hT.match(/^([1-9][0-9]?)$/);
        if (__hNumM) {
          var __hIdx = parseInt(__hNumM[1], 10) - 1;
          if (__hIdx >= 0 && __hIdx < __hP.options.length) {
            __hPicked = __hP.options[__hIdx];
          }
        }
        if (__hPicked) {
          __hProps.deleteProperty('smart_pending');
          text = 'עסק - ' + __hP.amount + ' ' + __hPicked.subcategory;
        }
      } else {
        __hProps.deleteProperty('smart_pending');
      }
    } catch (__hErr) {}
  }
  var __hIsBiz = /^(עסק|biz|business)/i.test(__hT);
  if (__hIsBiz) {
    var __hAM = __hT.replace(/,/g, '').match(/(?:^|[\s:\-])([0-9]+(?:\.[0-9]+)?)/);
    var __hA = __hAM ? parseFloat(__hAM[1]) : null;
    if (__hA && __hA > 0) {
      var __hOpts = [
        { label: 'שיווק', subcategory: 'שיווק' },
        { label: 'יועצים', subcategory: 'יועצים' },
        { label: 'אריזה ומשלוח', subcategory: 'אריזה ומשלוח' },
        { label: 'חומרי גלם', subcategory: 'חומרי גלם' },
        { label: 'תוכנות / SaaS', subcategory: 'תוכנות' },
        { label: 'ציוד עסקי', subcategory: 'ציוד' },
        { label: 'מיסים', subcategory: 'מיסים' },
        { label: 'שונות עסק', subcategory: 'שונות' },
        { label: 'הזמנה לקוח', subcategory: 'הזמנה' },
        { label: 'תשלום מלקוח', subcategory: 'תשלום מלקוח' },
        { label: 'החזר מס', subcategory: 'החזר מס' }
      ];
      var __payload = JSON.stringify({ amount: __hA, options: __hOpts, expiresAt: Math.floor(Date.now()/1000) + 900 });
      __hProps.setProperty('smart_pending', __payload);
      var __hLn = [];
      __hLn.push('🏢 עסק — ₪' + __hA);
      __hLn.push('');
      __hLn.push('בחר/י קטגוריה:');
      __hLn.push('');
      for (var __hK = 0; __hK < __hOpts.length; __hK++) {
        __hLn.push((__hK + 1) + '. ' + __hOpts[__hK].label);
      }
      __hLn.push('');
      __hLn.push('או הקלד/י שם קטגוריה / בטל');
      return { reply: __hLn.join('\n') };
    }
  }

  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'עזרה' || trimmed === 'help' || trimmed === '?') {
    return { reply: getHelpMessage() };
  }
  if (trimmed === 'סיכום' || trimmed === 'summary') {
    return { reply: getMonthlySummary() };
  }
  if (trimmed === 'סנכרן' || trimmed === 'sync') {
    try { var s = syncEverything(); return { reply: '✅ סונכרן: ' + s }; }
    catch (e) { return { reply: '❌ שגיאה בסנכרון: ' + e.message }; }
  }
  if (trimmed === 'מיגרציה' || trimmed === 'migrate') {
    try { var n = migrateSubcategoriesAndCategories(); return { reply: '✅ הועברו ' + n + ' שורות לקטגוריות חדשות.' }; }
    catch (e) { return { reply: '❌ שגיאה: ' + e.message }; }
  }
  if (trimmed === 'מרווחים' || trimmed === 'margins') {
    try { addRowMargins(); return { reply: '✅ הוספתי מרווחים בלוח האישי. רענני את השיט כדי לראות.' }; }
    catch (e) { return { reply: '❌ שגיאה בהוספת מרווחים: ' + e.message }; }
  }
  if (trimmed === 'בנה מחדש' || trimmed === 'rebuild') {
    try { buildHistorySheet(); return { reply: '✅ נבנה מחדש (כולל מרווחים).' }; }
    catch (e) { return { reply: '❌ שגיאה בבנייה מחדש: ' + e.message }; }
  }
  if (trimmed === 'מחק אחרון' || trimmed === 'undo') {
    return { reply: deleteLastTransaction() };
  }
  if (trimmed === 'מנוע' || trimmed === 'engine' || trimmed === 'status' || trimmed === 'stats') {
    return { reply: getEngineStatus() };
  }
  if (trimmed === 'מילון' || trimmed === 'dict' || trimmed === 'dictionary') {
    return { reply: getDictionaryLink() };
  }
  if (trimmed === 'גיליון' || trimmed === 'sheet') {
    return { reply: '📊 הגיליון שלך:\nhttps://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit' };
  }
  if (trimmed === 'מטבעות' || trimmed === 'currencies' || trimmed === 'fx') {
    return { reply: getCurrenciesMessage() };
  }

  const fx = parseForeignCurrencyHint(text);
  const parsed = parseAmountAndDescription(fx ? (fx.ilsAmount + ' ' + fx.cleanedText) : text);
  if (!parsed || !parsed.items || parsed.items.length === 0) {
    return { reply: '❌ לא זיהיתי סכום בהודעה.\nשלח: סכום פירוט\nלמשל: 85 סופר\nאו: 352 אוכל לבית+165' };
  }

  try {
    Logger.log('processExpense: opening sheet ' + SHEET_ID + ' tab ' + TRANSACTIONS_SHEET);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) {
      Logger.log('processExpense: sheet not found!');
      return { reply: '❌ לא נמצאה לשונית "תנועות". הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט.' };
    }
    Logger.log('processExpense: sheet found, items=' + parsed.items.length);
    const now = new Date();
    const monthKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM');
    const writtenLines = [];
    let runningTotal = 0;
    parsed.items.forEach(function(item){
      const matched = matchCategorySmart(item.description);
      const finalAmount = Math.abs(item.amount);
      runningTotal += finalAmount;
      _coerceCategoryBySubcategory(matched);
      Logger.log('processExpense: appendRow amount=' + finalAmount + ' sub=' + matched.subcategory);
      sheet.appendRow([now, monthKey, finalAmount, matched.category, matched.subcategory, item.description, 'WhatsApp', true]);
      Logger.log('processExpense: appendRow DONE, lastRow=' + sheet.getLastRow());
      // Keep the sheet sorted ascending (oldest at top → newest at bottom).
      // Runs on every append so the order is always correct without user
      // intervention. Sort 8 columns (A–H) to keep checkbox synced with row.
      try {
        var __lastRow = sheet.getLastRow();
        if (__lastRow > 2) {
          sheet.getRange(2, 1, __lastRow - 1, 8).sort({ column: 1, ascending: true });
          Logger.log('processExpense: sorted asc (oldest top)');
        }
      } catch (__sortErr) {
        Logger.log('processExpense: sort err: ' + (__sortErr && __sortErr.message));
      }
      if (fx && fx.note) {
        try { setDashboardNoteForTransaction_(matched.category, matched.subcategory, monthKey, fx.note); } catch (eN) { Logger.log('note err: ' + eN.message); }
      }
      try { _updateNoteForLastTransaction(); } catch(_e){}
      const emoji = matched.isIncome ? '💵' : '💸';
      writtenLines.push(emoji + ' ₪' + finalAmount.toLocaleString('he-IL') + ' → ' + matched.subcategory);
    });
    if (parsed.items.length === 1) {
      const it = parsed.items[0];
      const matched = matchCategorySmart(it.description);
      return { reply: '✅ נרשם בהצלחה!\n💸 סכום: ₪' + Math.abs(it.amount).toLocaleString('he-IL') + '\n📂 ' + matched.category + '\n🏷️ ' + matched.subcategory + '\n📝 ' + it.description + '\n\nשלח "סיכום" לראות סיכום החודש' };
    }
    return { reply: '✅ נרשמו ' + parsed.items.length + ' פעולות (סה"כ ₪' + runningTotal.toLocaleString('he-IL') + '):\n' + writtenLines.join('\n') };
  } catch (err) {
    return { reply: '❌ שגיאה בכתיבה לשיט: ' + err.message };
  }
}

// Rough fixed-rate conversion table — used when user writes "50$ amazon" without ILS amount.
// Rates conservative for late 2025/early 2026. Bot prefers user-supplied ILS amount when present.
var KFL_FX_RATES = {
  USD: 3.65, EUR: 3.95, GBP: 4.65,
  '$': 3.65, '€': 3.95, '£': 4.65
};

function _kfl_fxLookup(symbolOrCode) {
  if (!symbolOrCode) return null;
  var k = String(symbolOrCode).toUpperCase().trim();
  if (KFL_FX_RATES[k]) return KFL_FX_RATES[k];
  if (/דולר/i.test(symbolOrCode)) return KFL_FX_RATES.USD;
  if (/יורו|אירו/i.test(symbolOrCode)) return KFL_FX_RATES.EUR;
  if (/פאונד/i.test(symbolOrCode)) return KFL_FX_RATES.GBP;
  return null;
}

function parseForeignCurrencyHint(text) {
  if (!text) return null;
  var s = String(text);
  var foreignRe = /(\$|€|£|usd|eur|gbp|דולר|דולרים|יורו|אירו|פאונד)/i;
  if (!foreignRe.test(s)) return null;

  // Path A — user gave both amounts (e.g. "50$ amazon 180 שח")
  var ilsRe = /(\d+(?:[.,]\d+)?)\s*(?:שקל(?:ים)?|ש["״']?ח|nis|ils)/i;
  var m = s.match(ilsRe);
  if (m) {
    var ilsAmount = Number(String(m[1]).replace(/,/g, ''));
    if (!isNaN(ilsAmount) && ilsAmount > 0) {
      var note = s.trim();
      var fxBlockRe = /(\$|€|£|\d)[^,\n]{0,80}?(שקל|ש["״']?ח|nis|ils)/i;
      var blockMatch = s.match(fxBlockRe);
      if (blockMatch && blockMatch[0].length < note.length) note = blockMatch[0].trim();
      var cleanedTextA = s.replace(/\d+(?:[.,]\d+)?\s*(?:\$|€|£|usd|eur|gbp|דולר(?:ים)?|יורו|אירו|פאונד|שקל(?:ים)?|ש["״']?ח|nis|ils)/gi, '').replace(/[\\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
      return { ilsAmount: ilsAmount, note: note, cleanedText: cleanedTextA, autoConverted: false };
    }
  }

  // Path B — auto-convert from foreign currency using fixed rates.
  // Patterns: "50$ amazon", "$50 amazon", "50 usd amazon", "50 דולר", "12 יורו spotify"
  var foreignAmountRe = /(\d+(?:[.,]\d+)?)\s*(\$|€|£|usd|eur|gbp|דולר(?:ים)?|יורו|אירו|פאונד)/i;
  var foreignSymRe = /(\$|€|£)\s*(\d+(?:[.,]\d+)?)/i;
  var fm = s.match(foreignAmountRe) || s.match(foreignSymRe);
  if (!fm) return null;
  var amount, sym;
  if (fm[1] && isNaN(parseFloat(fm[1]))) {
    sym = fm[1]; amount = parseFloat(String(fm[2]).replace(',', '.'));
  } else {
    amount = parseFloat(String(fm[1]).replace(',', '.')); sym = fm[2] || fm[1];
  }
  if (!amount || isNaN(amount) || amount <= 0) return null;
  var rate = _kfl_fxLookup(sym);
  if (!rate) return null;
  var converted = Math.round(amount * rate * 100) / 100;
  var noteB = sym + ' ' + amount + ' → ₪' + converted;
  var cleanedTextB = s.replace(/\d+(?:[.,]\d+)?\s*(?:\$|€|£|usd|eur|gbp|דולר(?:ים)?|יורו|אירו|פאונד)/gi, '').replace(/(\$|€|£)\s*\d+(?:[.,]\d+)?/gi, '').replace(/\s+/g, ' ').trim();
  return { ilsAmount: converted, note: noteB, cleanedText: cleanedTextB, autoConverted: true, fxRate: rate, foreignAmount: amount, foreignSymbol: sym };
}

function parseAmountAndDescription(text) {
  var t = String(text || '').trim();
  if (!t) return null;
  var numberRe = /\d+(?:[.,]\d+)?/g;
  var nums = [];
  var match;
  while ((match = numberRe.exec(t)) !== null) {
    var n = parseFloat(match[0].replace(',', '.'));
    if (!isNaN(n) && n > 0) nums.push(n);
  }
  if (nums.length === 0) return null;
  var note = t.replace(/[\d.,+]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!note) note = 'ללא פירוט';
  return {
    items: nums.map(function(n){ return { amount: n, description: note }; })
  };
}

function _splitAmounts_(block) {
  return String(block || '').split('+').map(function(p){ return parseFloat(String(p).replace(/\s+/g,'').replace(',', '.')); }).filter(function(n){ return !isNaN(n) && n > 0; });
}

var BUSINESS_CATEGORY_MAP = {
  "עסק": {
    "עלות שיווק": ["פייסבוק", "facebook", "fb", "אינסטגרם", "instagram", "ig", "טיקטוק", "tiktok", "גוגל אדס", "google ads", "פרסום", "שיווק", "קמפיין"],
    "הוצאות תפעוליות": ["פוטושופ", "photoshop", "תוכנת עריכה", "תוכנה", "תוכנות", "שכירות משרד", "אינטרנט", "חשמל עסק", "טלפון עסק", "ציוד משרדי", "תפעול", "אדובי", "adobe"],
    "משלוחים והתקנות": ["משלוח", "משלוחים", "התקנה", "התקנות", "שילוח", "shipping", "delivery"],
    "עלות חומרי גלם": ["זכוכית", "קנבס", "חומרי גלם", "ספק", "ספקים", "פלסטיק", "אלומיניום", "עץ", "מסגרת", "מדפסת", "דיו", "נייר", "צבע", "מברשת", "פריימר"],
    "מחזור": ["הכנסה", "מכירה", "מכירות", "תשלום מלקוח", "מקדמה", "הזמנה"]
  }
};

function matchCategory(text) {
  if (!text) return _matchCategory_long(text);
  var t = String(text).toLowerCase().trim();
  t = t.replace(/[   ​]/g, ' ').replace(/\s+/g, ' ');
  var hasBusinessPrefix = /(^|\s)עסק($|\s)/.test(t);
  if (hasBusinessPrefix) {
    var entries = [];
    for (var cat in BUSINESS_CATEGORY_MAP) {
      var subs = BUSINESS_CATEGORY_MAP[cat];
      for (var sub in subs) {
        var kws = subs[sub];
        for (var k = 0; k < kws.length; k++) {
          entries.push({ kw: String(kws[k]).toLowerCase(), category: cat, subcategory: sub });
        }
      }
    }
    entries.sort(function(a, b) { return b.kw.length - a.kw.length; });
    for (var i = 0; i < entries.length; i++) {
      var kw = entries[i].kw;
      if (kw && t.indexOf(kw) >= 0) {
        return { category: entries[i].category, subcategory: entries[i].subcategory };
      }
    }
    return { category: "עסק", subcategory: "הוצאות תפעוליות" };
  }
  return _matchCategory_long(text);
}

var _CANONICAL_CAT_BY_SUB = {
  'אוכל לבית': 'אוכל',
  'אוכל בחוץ': 'אוכל',
  'מסעדות': 'אוכל',
  'סופר': 'אוכל'
};
function _coerceCategoryBySubcategory(matched) {
  if (!matched || !matched.subcategory) return matched;
  var canon = _CANONICAL_CAT_BY_SUB[String(matched.subcategory).trim()];
  if (canon && matched.category !== canon) {
    matched.category = canon;
  }
  return matched;
}

function _matchCategory_long(text) {
  if (!text) return _matchCategory_orig(text);
  var t = String(text).toLowerCase().trim();
  t = t.replace(/[   ​]/g, ' ').replace(/\s+/g, ' ');
  if (typeof CATEGORY_MAP === 'undefined') return _matchCategory_orig(text);
  var entries = [];
  if (Array.isArray(CATEGORY_MAP)) {
    for (var i = 0; i < CATEGORY_MAP.length; i++) {
      var item = CATEGORY_MAP[i];
      if (!item) continue;
      var kws = item.keywords;
      if (!Array.isArray(kws)) continue;
      var cat = item.category || '';
      var sub = item.subcategory || '';
      for (var k = 0; k < kws.length; k++) {
        entries.push({ kw: String(kws[k]).toLowerCase(), category: cat, subcategory: sub });
      }
    }
  } else if (typeof CATEGORY_MAP === 'object') {
    for (var cat in CATEGORY_MAP) {
      var subs = CATEGORY_MAP[cat];
      if (!subs || typeof subs !== 'object') continue;
      for (var sub in subs) {
        var kws = subs[sub];
        if (!Array.isArray(kws)) continue;
        for (var k = 0; k < kws.length; k++) {
          entries.push({ kw: String(kws[k]).toLowerCase(), category: cat, subcategory: sub });
        }
      }
    }
  }
  if (entries.length === 0) return _matchCategory_orig(text);
  entries.sort(function(a, b) { return b.kw.length - a.kw.length; });
  for (var i = 0; i < entries.length; i++) {
    var kw = entries[i].kw;
    if (!kw) continue;
    if (t.indexOf(kw) >= 0) {
      return { category: entries[i].category, subcategory: entries[i].subcategory };
    }
  }
  return _matchCategory_orig(text);
}

function _matchCategory_orig(description) {
  const lower = (description || '').toLowerCase();
  for (const rule of CATEGORY_MAP) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        return rule;
      }
    }
  }
  return DEFAULT_CATEGORY;
}

// Alias for callers using matchCategorySmart
// Smart entry-point: tries (1) learned cache from user corrections,
// (2) keyword maps, (3) LLM fallback via Claude API for the long tail.
// Falls back to DEFAULT_CATEGORY only if everything fails.
function matchCategorySmart(text) {
  // Step 1: learned cache (user-corrected categorizations)
  var cached = _learnedLookup(text);
  if (cached) {
    Logger.log('matchCategorySmart: cache hit "' + text + '" → ' + cached.subcategory);
    return cached;
  }

  // Step 2: keyword maps (CATEGORY_MAP + BUSINESS_CATEGORY_MAP)
  var matched = matchCategory(text);
  var isDefault = matched && matched.category === DEFAULT_CATEGORY.category &&
                  matched.subcategory === DEFAULT_CATEGORY.subcategory;

  if (!isDefault) return matched;

  // Step 3: LLM fallback for ambiguous / new vendor names
  var ai = _aiCategorize(text);
  if (ai) {
    Logger.log('matchCategorySmart: AI categorized "' + text + '" → ' + ai.subcategory);
    _learnedSave(text, ai); // remember for next time
    return ai;
  }

  return matched; // DEFAULT_CATEGORY
}

// ============================================================
// 🤖 LLM Fallback — Claude Haiku via Anthropic API
// ============================================================
// Triggered only when local keyword matching returns DEFAULT_CATEGORY.
// Sends ~30 input tokens to Claude Haiku 3.5; cost is <$0.0001 per call.
// Requires ANTHROPIC_API_KEY in Script Properties (no key → silently
// returns null so the bot still works without AI).
function _aiCategorize(text) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) return null;

    var prompt = 'תקטלג את תיאור ההוצאה הישראלית הבא לקטגוריה.\n' +
      'תיאור: "' + String(text || '').slice(0, 200) + '"\n\n' +
      'החזר אך ורק שורה אחת בפורמט "קטגוריה / תת-קטגוריה" — בלי שום הסבר.\n' +
      'קטגוריות חוקיות: הכנסות, אוכל, תחבורה, הוצאות קבועות, הוצאות זמניות, קניות, שונות ואחרים, בריאות, עסק.\n' +
      'דוגמאות:\n' +
      '"wolt" → אוכל / אוכל בחוץ\n' +
      '"ארנונה" → הוצאות קבועות / בית\n' +
      '"netflix" → הוצאות קבועות / אפליקציות\n' +
      '"בנזין דלק" → תחבורה / דלק\n' +
      '"שיניים" → בריאות / בריאות\n' +
      '"booking" → קניות / קניות מקוונות\n' +
      '"chatgpt" → הוצאות קבועות / אפליקציות';

    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 30,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('_aiCategorize: API error ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 200));
      return null;
    }

    var body = JSON.parse(response.getContentText());
    var reply = (body.content && body.content[0] && body.content[0].text) || '';
    var clean = String(reply).replace(/["״'`]/g, '').trim();
    var parts = clean.split('/').map(function(s){ return s.trim(); }).filter(Boolean);
    if (parts.length < 2) return null;

    var validCats = ['הכנסות','אוכל','תחבורה','הוצאות קבועות','הוצאות זמניות','קניות','שונות ואחרים','בריאות','עסק'];
    if (validCats.indexOf(parts[0]) < 0) {
      Logger.log('_aiCategorize: invalid category from AI: ' + parts[0]);
      return null;
    }
    return { category: parts[0], subcategory: parts[1] };
  } catch (e) {
    Logger.log('_aiCategorize error: ' + e.message);
    return null;
  }
}

// ============================================================
// 📚 Learning cache — remembers user corrections + AI inferences
// Stored in the 'מילון לימוד' tab so it survives between executions.
// ============================================================
var _LEARNED_TAB_NAME = 'מילון לימוד';
var _learnedCache = null;
var _learnedCacheLoadedAt = 0;

function _learnedLoad() {
  var now = Date.now();
  // Cache for 60s within an execution
  if (_learnedCache && (now - _learnedCacheLoadedAt < 60000)) return _learnedCache;
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) {
      sh = ss.insertSheet(_LEARNED_TAB_NAME);
      sh.appendRow(['keyword', 'category', 'subcategory', 'source', 'updated_at']);
    }
    var data = sh.getDataRange().getValues();
    var map = {};
    for (var i = 1; i < data.length; i++) {
      var kw = String(data[i][0] || '').toLowerCase().trim();
      if (!kw) continue;
      map[kw] = { category: data[i][1], subcategory: data[i][2] };
    }
    _learnedCache = map;
    _learnedCacheLoadedAt = now;
    return map;
  } catch (e) {
    Logger.log('_learnedLoad error: ' + e.message);
    return {};
  }
}

function _learnedLookup(text) {
  var t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  var map = _learnedLoad();
  // Exact match first
  if (map[t]) return map[t];
  // Substring: pick the longest learned keyword contained in text
  var bestKw = null;
  var bestLen = 0;
  for (var kw in map) {
    if (kw.length > bestLen && t.indexOf(kw) >= 0) {
      bestKw = kw;
      bestLen = kw.length;
    }
  }
  return bestKw ? map[bestKw] : null;
}

function _learnedSave(text, result, source) {
  try {
    var t = String(text || '').toLowerCase().trim();
    if (!t || !result || !result.category || !result.subcategory) return;
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) {
      sh = ss.insertSheet(_LEARNED_TAB_NAME);
      sh.appendRow(['keyword', 'category', 'subcategory', 'source', 'updated_at']);
    }
    // Refuse duplicates (last writer wins by replacing row)
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').toLowerCase().trim() === t) {
        sh.getRange(i + 1, 2).setValue(result.category);
        sh.getRange(i + 1, 3).setValue(result.subcategory);
        sh.getRange(i + 1, 4).setValue(source || 'ai');
        sh.getRange(i + 1, 5).setValue(new Date());
        _learnedCacheLoadedAt = 0; // invalidate cache
        return;
      }
    }
    sh.appendRow([t, result.category, result.subcategory, source || 'ai', new Date()]);
    _learnedCacheLoadedAt = 0; // invalidate
  } catch (e) {
    Logger.log('_learnedSave error: ' + e.message);
  }
}

// Public: user can manually teach the bot via WhatsApp:
// "תלמד: קפה ארומה → אוכל / אוכל בחוץ"
function teachCategory(text, category, subcategory) {
  _learnedSave(text, { category: category, subcategory: subcategory }, 'user');
  return 'נלמד: "' + text + '" → ' + category + ' / ' + subcategory;
}

// ============================================================
// 📊 פקודות עזר
// ============================================================

function getMonthlySummary() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return '❌ אין לשונית תנועות';

  const data = sheet.getDataRange().getValues();
  const monthKey = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM');

  const totals = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Column B can be either a String "2026-05" or a Date depending on cell
    // formatting in the sheet. Normalize to "yyyy-MM" before comparing.
    var rowMonth = row[1];
    if (rowMonth instanceof Date) {
      rowMonth = Utilities.formatDate(rowMonth, 'Asia/Jerusalem', 'yyyy-MM');
    } else if (rowMonth) {
      rowMonth = String(rowMonth).slice(0, 7); // handle "2026-05-01" etc.
    }
    if (rowMonth !== monthKey) continue;
    const amount = parseFloat(row[2]) || 0;
    const category = row[3];

    totals[category] = (totals[category] || 0) + amount;
    if (category === 'הכנסות') totalIncome += amount;
    else totalExpense += amount;
  }

  let reply = '📊 סיכום ' + monthKey + ':\n\n';
  reply += '💵 הכנסות: ₪' + totalIncome.toLocaleString('he-IL') + '\n';
  reply += '💸 הוצאות: ₪' + totalExpense.toLocaleString('he-IL') + '\n';
  reply += '🟰 נטו: ₪' + (totalIncome - totalExpense).toLocaleString('he-IL') + '\n\n';
  reply += 'פירוט לפי קטגוריה:\n';
  for (const cat in totals) {
    if (cat === 'הכנסות') continue;
    reply += '• ' + cat + ': ₪' + totals[cat].toLocaleString('he-IL') + '\n';
  }
  return reply;
}

function deleteLastTransaction() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return '❌ אין לשונית תנועות';

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '❌ אין מה למחוק';

  const data = sheet.getRange(lastRow, 1, 1, 7).getValues()[0];
  sheet.deleteRow(lastRow);

  return '🗑️ נמחק:\nסכום: ₪' + data[2] + '\nתת-קטגוריה: ' + data[4] + '\nפירוט: ' + data[5];
}

// Auto-duplicate detection — flags if the same amount+description was added
// within the last 10 minutes. Returns null if no dupe, or {row, when} if found.
function detectDuplicate(amount, description) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return null;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;
    const lookback = Math.min(15, lastRow - 1);
    const startRow = lastRow - lookback + 1;
    const data = sheet.getRange(startRow, 1, lookback, 7).getValues();
    const now = new Date();
    const tenMinAgo = now.getTime() - 10*60*1000;
    const descNorm = String(description || '').trim().toLowerCase();
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      const rowDate = row[0] instanceof Date ? row[0].getTime() : new Date(row[0]).getTime();
      if (isNaN(rowDate) || rowDate < tenMinAgo) continue;
      const rowAmount = Number(row[2]);
      const rowDesc = String(row[5] || '').trim().toLowerCase();
      if (Math.abs(rowAmount - amount) < 0.01 && rowDesc === descNorm) {
        return { row: startRow + i, when: new Date(rowDate), amount: rowAmount, desc: rowDesc };
      }
    }
    return null;
  } catch (e) {
    Logger.log('detectDuplicate error: ' + e);
    return null;
  }
}

function getHelpMessage() {
  return '🤖 *כסף\'לה — מדריך מהיר*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '📝 *רישום הוצאה:*\n' +
    '  • "85 סופר רמי לוי"\n' +
    '  • "1200 ארנונה"\n' +
    '  • "245 wolt דאלי"\n' +
    '  • "50$ amazon" (מטבע זר → ILS)\n\n' +
    '💰 *רישום הכנסה:*\n' +
    '  • "8500 משכורת"\n' +
    '  • "3000 הכנסה עסקית"\n\n' +
    '💳 *פיצול לתשלומים:*\n' +
    '  • "5000 ב-10 תשלומים מחשב"\n\n' +
    '📊 *פקודות מהירות:*\n' +
    '  • "סיכום" — סיכום החודש\n' +
    '  • "מחק אחרון" — בטל את האחרון\n' +
    '  • "סנכרן" — ריענון דשבורד\n' +
    '  • "מילון" — קישור ללשונית הלמידה\n' +
    '  • "מנוע" — מצב המנוע (AI/cache/keywords)\n' +
    '  • "עזרה" — הודעה זו\n\n' +
    '🧠 *המנוע:*\n' +
    'המנוע מקטלג ב-3 שכבות — cache, 1,480 מילים, ו-Claude AI לגיבוי.\n' +
    'דיוק >99% אחרי 30-50 הוצאות.\n\n' +
    '🔒 הנתונים נשמרים *רק* בגיליון Drive שלך. לא אצלנו.';
}

function getEngineStatus() {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('מילון לימוד');
    var learnedCount = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
    var aiEnabled = !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    var keywordCount = (typeof CATEGORY_MAP !== 'undefined') ? CATEGORY_MAP.reduce(function(a,b){ return a + (b.keywords ? b.keywords.length : 0); }, 0) : 0;
    var categoryCount = (typeof CATEGORY_MAP !== 'undefined') ? CATEGORY_MAP.length : 0;
    return '⚡ *מצב המנוע*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      '🥇 *שכבה 1 — Cache*\n' +
      '   ' + learnedCount + ' מילים שנלמדו אישית\n' +
      '   ~50ms • חינם\n\n' +
      '🥈 *שכבה 2 — Keywords*\n' +
      '   ' + keywordCount + ' מילים פרושות על ' + categoryCount + ' קטגוריות\n' +
      '   ~5ms • חינם\n\n' +
      '🥉 *שכבה 3 — Claude AI*\n' +
      '   ' + (aiEnabled ? '✅ מופעל (claude-3-5-haiku)' : '⚠️ לא מופעל (חסר API key)') + '\n' +
      '   ~800ms • $0.0001/קריאה\n\n' +
      '🔒 הכל נשמר ב-Drive שלך. לא אצלנו.';
  } catch (e) {
    return '❌ לא הצלחתי לקרוא מצב מנוע: ' + e.message;
  }
}

function getCurrenciesMessage() {
  return '💱 *המרות מטבע אוטומטיות*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    'שערים נוכחיים (מקובעים):\n' +
    '  • USD ($) → ₪' + KFL_FX_RATES.USD + '\n' +
    '  • EUR (€) → ₪' + KFL_FX_RATES.EUR + '\n' +
    '  • GBP (£) → ₪' + KFL_FX_RATES.GBP + '\n\n' +
    '*דוגמאות:*\n' +
    '  • "50$ amazon"\n' +
    '  • "12 יורו spotify"\n' +
    '  • "£25 amazon uk"\n\n' +
    'הבוט ירשום את הסכום ב-₪ אוטומטית ויציין במקור שזה הומר.';
}

function getDictionaryLink() {
  return '📖 *לשונית "מילון לימוד" בגיליון שלך:*\n' +
    'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit\n\n' +
    'שם הלשונית: *מילון לימוד*\n' +
    'מבנה: keyword | category | subcategory | source | updated_at\n\n' +
    '💡 אתה יכול לערוך ידנית כדי ללמד את הבוט מילה חדשה.';
}

// ============================================================
// 📤 שליחת הודעה ל-WhatsApp
// ============================================================

function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('WhatsApp token not configured - skipping reply');
    return;
  }

  const url = 'https://graph.facebook.com/v21.0/' + WHATSAPP_PHONE_NUMBER_ID + '/messages';
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log('WhatsApp response: ' + response.getContentText());
}

// ============================================================
// 🛠️ פונקציות התקנה
// ============================================================

// ============================================================
// Sort transactions chronologically (oldest at top, newest at bottom).
// Run once after pasting to fix existing data order.
// ============================================================
function sortTransactionsChronological() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) { Logger.log('no Transactions sheet'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) { Logger.log('nothing to sort, rows=' + lastRow); return; }
  sheet.getRange(2, 1, lastRow - 1, 7).sort({ column: 1, ascending: true });
  Logger.log('sorted ' + (lastRow - 1) + ' rows by timestamp ascending (oldest first)');
}

function setupTransactionsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(TRANSACTIONS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(TRANSACTIONS_SHEET);
  } else {
    if (sheet.getLastRow() > 0) {
      Logger.log('הלשונית כבר קיימת עם נתונים - מדלג על reset');
      return;
    }
  }

  sheet.getRange('A1:G1').setValues([[
    'תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור'
  ]]);
  sheet.setFrozenRows(1);
  sheet.getRange('A1:G1')
    .setFontWeight('bold')
    .setBackground('#4a86e8')
    .setFontColor('white')
    .setHorizontalAlignment('center');

  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('B:B').setNumberFormat('yyyy-mm');
  sheet.getRange('C:C').setNumberFormat('₪#,##0.00');

  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 180);
  sheet.setColumnWidth(6, 250);
  sheet.setColumnWidth(7, 90);

  const categories = Array.from(new Set(CATEGORY_MAP.map(function(c){return c.category;}).concat(DEFAULT_CATEGORY.category)));
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(categories, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange('D2:D1000').setDataValidation(rule);

  Logger.log('✅ לשונית "תנועות" מוכנה!');
}

function testSetup() {
  Logger.log('SHEET_ID: ' + SHEET_ID);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    Logger.log('✅ שיט נפתח: ' + ss.getName());

    const sheet = ss.getSheetByName(TRANSACTIONS_SHEET);
    if (sheet) Logger.log('✅ לשונית "תנועות" קיימת');
    else Logger.log('❌ אין לשונית "תנועות" - הרץ setupTransactionsSheet');

    const dashboard = ss.getSheetByName(DASHBOARD_SHEET);
    if (dashboard) Logger.log('✅ לשונית "מאזן שנתי" קיימת');
    else Logger.log('⚠️ לא מצאתי "מאזן שנתי" - בדוק שם בדיוק');
  } catch (err) {
    Logger.log('❌ שגיאה: ' + err.message);
  }

  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('⚠️ WHATSAPP_TOKEN לא הוגדר');
  } else {
    Logger.log('✅ WHATSAPP_TOKEN מוגדר');
  }

  const result = processExpense('250 סופר רמי לוי');
  Logger.log('בדיקת parser: ' + result.reply);
}

// ============================================================
// 🔁 מיגרציה: דשבורד דינמי מ-'תנועות'
// ============================================================

function migrateDashboardToSUMIFS() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const dashboard = ss.getSheetByName('מאזן שנתי');
  const transactions = ss.getSheetByName(TRANSACTIONS_SHEET);
  if (!dashboard || !transactions) {
    Logger.log('שגיאה: לא נמצאו לשוניות');
    return;
  }
  const yearVal = dashboard.getRange('B2').getValue();
  const year = parseInt(yearVal) || new Date().getFullYear();
  Logger.log('שנה: ' + year);
  const monthCols = [3,4,5,6,7,8,9,10,11,12,13,14];
  const lastRow = dashboard.getLastRow();
  const colA = dashboard.getRange(1,1,lastRow,1).getValues();
  const sectionHeaders = {
    'הכנסות': 'הכנסות',
    'הוצאות': null,
    'הוצאות קבועות': 'הוצאות קבועות',
    'הוצאות זמניות': 'הוצאות זמניות',
    'אוכל': 'אוכל',
    'תחבורה': 'תחבורה',
    'תחזוקה': 'תחבורה',
    'תמורה': 'תחבורה',
    'שונות ואחרים': 'שונות ואחרים',
    'שונות': null,
    'קטגוריה': null,
    'מאזן אישי': null
  };
  let legacy = 0, formulas = 0, currentSection = 'שונות ואחרים', skipped = 0, processed = 0;
  for (let r = 4; r < colA.length; r++) {
    const cellRow = r + 1;
    const name = String(colA[r][0] || '').trim();
    if (!name) continue;
    if (name.indexOf('סה') === 0) { skipped++; continue; }
    if (sectionHeaders.hasOwnProperty(name)) {
      const newSection = sectionHeaders[name];
      if (newSection) currentSection = newSection;
      skipped++;
      continue;
    }
    processed++;
    for (let mi = 0; mi < monthCols.length; mi++) {
      const col = monthCols[mi];
      const monthNum = mi + 1;
      const monthKey = year + '-' + (monthNum < 10 ? '0' + monthNum : '' + monthNum);
      const cell = dashboard.getRange(cellRow, col);
      const formula = cell.getFormula();
      const val = cell.getValue();
      if (!formula && typeof val === 'number' && val > 0) {
        const dt = new Date(year, monthNum - 1, 15, 12, 0, 0);
        transactions.appendRow([dt, monthKey, val, currentSection, name, 'מיגרציה אוטומטית מהדשבורד', 'Legacy']);
        legacy++;
      }
      cell.setFormula('=IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, $A' + cellRow + ', תנועות!B:B, "' + monthKey + '"), 0)');
      formulas++;
    }
    dashboard.getRange(cellRow, 2).setFormula('=SUM(C' + cellRow + ':N' + cellRow + ')');
  }
  Logger.log('Migration done. Processed: ' + processed + ' rows, ' + legacy + ' legacy + ' + formulas + ' formulas');
}

function migrateSubcategoriesAndCategories() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) { Logger.log('no Transactions sheet'); return; }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return 0;
  var renamed = 0;
  for (var i = 1; i < data.length; i++) {
    var cat = data[i][3];
    var subcat = data[i][4];
    var note = String(data[i][5] || '');
    var newCat = cat;
    var newSubcat = subcat;
    if (subcat === 'סופר') { newCat = 'אוכל'; newSubcat = 'אוכל לבית'; }
    if (subcat === 'מסעדות') { newCat = 'אוכל'; newSubcat = 'אוכל בחוץ'; }
    if (subcat === 'אוכל בבית') { newCat = 'אוכל'; newSubcat = 'אוכל לבית'; }
    if (cat === 'הוצאות קבועות' && subcat === 'חזקת בית' && /אוכל\s*לבית/.test(note)) {
      newCat = 'אוכל'; newSubcat = 'אוכל לבית';
    }
    if (cat === 'הוצאות קבועות' && subcat === 'הוצאות בית' && /אוכל\s*לבית/.test(note)) {
      newCat = 'אוכל'; newSubcat = 'אוכל לבית';
    }
    if (newCat !== cat || newSubcat !== subcat) {
      sheet.getRange(i+1, 4).setValue(newCat);
      sheet.getRange(i+1, 5).setValue(newSubcat);
      renamed++;
    }
  }
  Logger.log('Renamed ' + renamed + ' rows.');
  return renamed;
}

function syncEverything() {
  var summary = [];
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var tx = ss.getSheetByName(TRANSACTIONS_SHEET);
    if (tx) {
      var allCats = ['הכנסות','הוצאות קבועות','הוצאות זמניות','אוכל','תחבורה','שונות ואחרים','בריאות','קניות','בידור','עסק'];
      var ruleD = SpreadsheetApp.newDataValidation().requireValueInList(allCats, true).setAllowInvalid(true).build();
      tx.getRange('D2:D5000').setDataValidation(ruleD);
      summary.push('✓ ולידציה');
    }
  } catch(e) { summary.push('✗ Validation: ' + e.message); }
  try {
    if (typeof buildHistorySheet === 'function') {
      buildHistorySheet();
      summary.push('✓ דשבורד');
    }
  } catch(e) { summary.push('✗ Dashboard: ' + e.message); }
  try {
    if (typeof migrateSubcategoriesAndCategories === 'function') {
      var n = migrateSubcategoriesAndCategories();
      summary.push('✓ מיגרציה: ' + n + ' שורות');
    }
  } catch(e) { summary.push('✗ Migration: ' + e.message); }
  Logger.log(summary.join('\n'));
  return summary.join(' | ');
}

function setDashboardNoteForTransaction_(category, subcategory, monthKey, noteText) {
  if (!noteText) return;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var bizCats = {'מחזור':1,'עלות חומרי גלם':1,'עלות שיווק':1,'משלוחים והתקנות':1,'הוצאות תפעוליות':1};
  var dashNames = bizCats[category] ? ['מאזן חברה 2026','מאזן חברה'] : ['מאזן שנתי','מאזן אישי'];
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var monthIdx = parseInt((monthKey || '').split('-')[1], 10);
  var monthLabel = (!isNaN(monthIdx) && monthIdx >= 1 && monthIdx <= 12) ? hebMonths[monthIdx - 1] : null;
  if (!monthLabel) return;
  for (var d = 0; d < dashNames.length; d++) {
    var ds = ss.getSheetByName(dashNames[d]);
    if (!ds) continue;
    var dvals = ds.getDataRange().getValues();
    for (var r = 0; r < dvals.length; r++) {
      for (var c = 0; c < dvals[r].length; c++) {
        if (String(dvals[r][c] || '').trim() === subcategory) {
          for (var hr = 0; hr < r; hr++) {
            for (var hc = 0; hc < dvals[hr].length; hc++) {
              if (String(dvals[hr][hc] || '').trim() === monthLabel) {
                var cell = ds.getRange(r + 1, hc + 1);
                var existing = cell.getNote();
                var combined = existing ? (existing + '\n' + noteText) : noteText;
                cell.setNote(combined);
                return;
              }
            }
          }
        }
      }
    }
  }
}
