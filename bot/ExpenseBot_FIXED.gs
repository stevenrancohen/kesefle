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
// ── SECURITY — owner of the hardcoded SHEET_ID above ──────────────────
// The legacy single-tenant code in this file writes DIRECTLY to SHEET_ID
// (the script owner's personal sheet). That path must run for the owner
// ONLY. OWNER_PHONE (E.164 digits) is the owner's WhatsApp number and the
// safe fallback when the SHEET_OWNER_PHONE Script Property is unset.
// WITHOUT this, an unset property made _resolveTenant_ treat EVERY sender
// as the owner — leaking other people's expenses into this sheet. The
// SHEET_OWNER_PHONE Script Property, if present, overrides this constant.
const OWNER_PHONE = '972547760643';
const ORDERS_TAB_NAME = 'הזמנות';
const TRANSACTIONS_SHEET = 'תנועות';
const DASHBOARD_SHEET = 'מאזן שנתי';

const VERIFY_TOKEN = 'expense_bot_verify_2026';
const WHATSAPP_TOKEN = PropertiesService.getScriptProperties().getProperty('WHATSAPP_TOKEN') || '';
// Live bot number: +1 555 640 8123 (Meta TEST number) → Phone Number ID
// 1086749664527399. Site links + outbound sends all use this number now.
//
// ⚠️ This Meta app has TWO numbers: the test number (id 1086749664527399) and a
// Numero number +1 774 544 8053 (id 1090404180828069) that was NEVER activated
// on WhatsApp ("isn't on WhatsApp"). We must use the TEST number. If the Script
// Property WHATSAPP_PHONE_NUMBER_ID is set, it MUST equal 1086749664527399 —
// otherwise replies + crons go out the dead Numero number. (Replies also
// auto-target the inbound number via _ACTIVE_PHONE_NUMBER_ID_, set in doPost.)
// WABA ID: 986476207210292. Test numbers deliver only to allow-listed recipients.
const WHATSAPP_PHONE_NUMBER_ID = PropertiesService.getScriptProperties().getProperty('WHATSAPP_PHONE_NUMBER_ID') || '1086749664527399';
const BOT_PHONE_E164 = '+15556408123';

// Set per-request from the inbound webhook metadata (phone_number_id) so the
// bot ALWAYS replies from the SAME number the user messaged — even if the
// configured default/Script-Property points elsewhere. See doPost + sendWhatsAppMessage.
var _ACTIVE_PHONE_NUMBER_ID_ = '';
const KESEFLE_API_BASE = PropertiesService.getScriptProperties().getProperty('KESEFLE_API_BASE') || 'https://kesefle.com';
// Bump on every deploy so the "בדיקה" self-check confirms which build is live.
const KFL_BUILD_VERSION = '2026-05-26-multi-biz-naming';

// ALLOWED_PHONE removed for multi-tenant operation — bot now accepts messages
// from any phone and routes them to the sender's own Sheet via KV lookup.
// Keep this commented for reference / rollback:
// const ALLOWED_PHONE = '972547760643';
const ALLOWED_PHONE = '';

// ============================================================
// 🗂️ מילון קטגוריות
// ============================================================

const CATEGORY_MAP = [
  // ===== BUSINESS (עסק) — English + Hebrew aliases, top of list so they
  // win priority. Subcategories match the short forms the dashboard
  // SUMIFS literally expects ("שיווק", "תפעוליות", etc.). =====
  {"keywords":["marketing","advertising","ads","promotion","promo","branding","campaign","sponsored","influencer","social media ads","content marketing","email marketing","seo","sem","ppc","pr","press release","יחסי ציבור","קמפיין","פרסומת","קידום","שיווק","פרסום"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["operations","operational","ops","admin","administrative","admin fee","running cost","overhead","operating expense","תפעול","תפעולי","הוצאות תפעוליות"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["raw materials","materials","material","supplies","supply","inventory","stock","wholesale","ingredients","components","parts","חומרי גלם","חומר גלם","סחורה","מלאי","חומרים","רכש"],"category":"עסק","subcategory":"חומרי גלם"},
  {"keywords":["shipping","delivery","courier","freight","logistics","packaging","packing","postage","fulfillment","משלוח","משלוחים","הובלה","אריזה","שילוח","אריזה ומשלוח"],"category":"עסק","subcategory":"משלוח"},
  {"keywords":["consultant","consulting","consultancy","advisor","advisory","freelancer","contractor","attorney","lawyer","accountant","cpa","bookkeeper","יועץ","יועצים","ייעוץ","רואה חשבון","עו\"ד","עורך דין","עורכי דין","מנהלת חשבונות","פרילנסר","ספק שירות"],"category":"עסק","subcategory":"יועצים"},
  {"keywords":["software","saas","subscription tool","tool","app","application","license","software license","cloud service","אופיס","תוכנה","תוכנת חשבוניות","סאאס","רישיון","כלי עבודה"],"category":"עסק","subcategory":"תוכנות"},
  {"keywords":["business equipment","office equipment","equipment","printer","scanner","laptop","monitor","desk","office chair","ציוד עסקי","ציוד למשרד","מדפסת","סורק","ציוד משרד"],"category":"עסק","subcategory":"ציוד עסקי"},
  {"keywords":["business tax","corporate tax","vat","vat payment","income tax","tax payment","sales tax","מע\"מ","מעמ","תשלום מעמ","מס הכנסה עסקי","מסי עסק","ביטוח לאומי עצמאי"],"category":"עסק","subcategory":"מיסים"},
  {"keywords":["revenue","sale","sales","income payment","customer payment","invoice paid","order received","קבלת תשלום","תשלום לקוח","הזמנה","מחזור","מכירה","מכירות","ssayhe"],"category":"עסק","subcategory":"מחזור","isIncome":true},

  // ===== FAMILY + KIDS + BABY (expanded 2026-05-24 per Steven's request) =====
  {"keywords":["טיטול","טיטולים","האגיס","פמפרס","ליברה","מוליקס","מגבונים לחים","מגבונים לתינוק","חיתולים","חיתול","דיאפר","פמפרסים","חיתולי לילה","חיתולי בריכה","חיתול בריכה","תחתוני אימון","פולים","טיטולי גמילה"],"category":"חינוך וילדים","subcategory":"חיתולים ותינוקות"},
  {"keywords":["מטרנה","סימילק","אפטמיל","אנפמיל","ננק","תרכובת חלב","דייסת תינוקות","דייסת אורז","דייסת תירס","מחית","מחית גזר","מחית בננה","מחית תפוח","מטרנה גולד","מטרנה אקסטרה","חליטות לתינוק","דייסה לתינוק","אבקת חלב","ביסקוויט תינוק","וופל תינוק","יוגורט תינוק"],"category":"חינוך וילדים","subcategory":"מזון תינוקות ופעוטות"},
  {"keywords":["מוצץ","מוצצים","אביב מוצץ","נובי","טומיטיפאי","פיליפס אבנט","בקבוק האכלה","בקבוקים","סטריליזטור","מחמם בקבוקים","משאבת חלב","מדלה","רפידות הנקה","קרם פטמות","טיפות גזים","תרסיס אף","פיזיומר","מדחום תינוק","משאבת אף","סיר לילה","אמבטית תינוק","מגבת ברדס","שמן תינוקות","תחליב רחצה","שמפו תינוקות","קרם חיתולים","סודוקרם","מוסטלה","ולסידה","אבקת טלק","מי קלן","מברשת שיניים לתינוק","פטמות לבקבוק","שקיות חלב"],"category":"חינוך וילדים","subcategory":"ציוד וטיפוח לתינוק"},
  {"keywords":["עגלה","עגלת תינוק","בוגאבו","גרייקו","קוסאטו","בייבי ג'וגר","סיטק","ג'ואי","איינג'ל","סילבר קרוס","עגלת ריצה","עגלה קומפקטית","עגלה זוגית","ערסל לתינוק","טוטסיט","יואיא","סטוקה"],"category":"חינוך וילדים","subcategory":"עגלות תינוק"},
  {"keywords":["כסא בטיחות","מקסי קוסי","רומר","בריטקס","רקארו","סייפ קיפ","בוסטר","מושב הגבהה","אגונומיה לרכב","סלקל"],"category":"תחבורה","subcategory":"כסאות בטיחות לילדים"},
  {"keywords":["מנשא","נשא תינוק","מנטקה","ארגו","בייבי ביירן","נונה","מנשא גב","מנשא קדמי","מנשא ירך","סלינג","טבעת בד","מובי רפ"],"category":"חינוך וילדים","subcategory":"מנשאי תינוק"},
  {"keywords":["מיטת תינוק","לול","מובייל לתינוק","מלונה","מתקן החתלה","שידת החתלה","תיק החתלה","שק שינה לתינוק","מצעי תינוק","סדין פיט","מזרון תינוק","מגן מיטה","וילון האפלה","מנורת לילה","מוניטור תינוק"],"category":"חינוך וילדים","subcategory":"רהיטי תינוק"},
  {"keywords":["ג'ימבורי","חליפת ג'ימבורי","סרבל תינוק","אוברול","פיג'מת תינוק","גרביוני תינוק","כובע תינוק","חליפת תינוק","בגדי תינוק","חוליות","גופיות תינוק","שכפ\"צ תינוק","מעיל פוך לתינוק","סוודר תינוק","פעוטון","טופטף","עולם הילד","ילדינו","שילב","קרטר","ילדים בגדים","ביגוד ילדים","חליפת ילד","חולצה לילד","מכנסיים לילד","שמלה לילדה","שמלת ילדה","חצאית לילדה","קסטרו קיד","פולגת ילדים","הודיס ילדים"],"category":"חינוך וילדים","subcategory":"ביגוד והנעלה לילדים"},
  {"keywords":["מעון","מעון יום","גן ילדים","גנון","פעוטון","צהרון","משפחתון","בייביסיטר","מטפלת","ילדים שמרטף","מטפלת לילדים","אופר","אומנה","חינוך","שכר לימוד","אגרת חינוך","גני ילדים פרטי","מעון פרטי","חוג לילדים","חוג בלט","חוג שחייה","חוג כדורגל","חוג ג'ודו","חוג קראטה","חוג מוזיקה","חוג פסנתר","חוג גיטרה","חוג ציור","חוג מחול","חוג רובוטיקה","חוג שחמט","חוג אנגלית","מחנה קיץ","מחנה חורף","מחנה ספורט","טיול שנתי"],"category":"חינוך וילדים","subcategory":"חינוך וטיפול"},
  {"keywords":["צעצוע","צעצועים","לגו","דופלו","פאזל","פאזלים","בובה","בובת תינוק","בית בובות","דובון","מכונית צעצוע","מכונית שלט","מכונית רחוק","טרקטור צעצוע","רכבת צעצוע","מסילה","משחק קופסה","דמקה","שחמט","מונופול","קלפים לילדים","פלסטלינה","בצק משחק","צבעי אצבעות","עפרונות צבעוניים","טושים","דפי צביעה","קישוט","מדבקות","חותמות","ערכת רופא","ערכת בישול","ערכת מדעים","מיקרוסקופ ילדים","טלסקופ ילדים","שעון ילדים","טוויסטר","ג'אנגה","יו-יו","חרוזים","חבל קפיצה","בועות סבון","עפיפון","אקדח קפיצים","קונסולת משחקים","נינטנדו","פלייסטיישן","אקס בוקס","נינטנדו סוויץ'","סוויץ' משחק","משחק וידאו"],"category":"בידור","subcategory":"צעצועים ומשחקי ילדים"},
  {"keywords":["ספר ילדים","ספרי ילדים","ספר תמונות","ספר קרטון","חוברת פעילות","ספרי הדבקה","ילקוט","תיק גב לילד","קלמר","מחברות","ספרי לימוד","חוברות עבודה","עפרונות","טושים","מחק","סרגל","מספריים לילד","דבק","מחדד","ציוד גן","ציוד בית ספר","מדבקות שם","מצביעים","פנקס","טפיט","קלסר","תיקייה","ערכה לכיתה א","פתיחת שנה"],"category":"חינוך וילדים","subcategory":"ספרים וציוד לבית ספר"},
  {"keywords":["רופא ילדים","ילד חולה","בדיקת רופא","חיסון","טיפת חלב","דיאטנית לילדים","פסיכולוג ילדים","רופא שיניים לילדים","אורתודנט","אינהלציה","נבולייזר","אקמול ילדים","נורופן ילדים","סירופ שיעול","אנטיביוטיקה","מדבקת חום","פלסטרים לילדים"],"category":"בריאות","subcategory":"בריאות ילדים"},
  // ===== ADULT HOBBIES + LIFESTYLE =====
  {"keywords":["שטיפת רכב","שטיפה לרכב","טיפול לרכב","טיפול תקופתי","החלפת שמן","שמן מנוע","פילטר שמן","פילטר אוויר","פילטר דלק","מצבר","החלפת מצבר","צמיגים","החלפת צמיגים","איזון גלגלים","מאזניים","פילוס רכב","בלמים","דיסקיות","רפידות בלם","החלפת בלמים","טסט","טסט שנתי","אגרת רכב","חלקי חילוף","מוסך","תיקון רכב","תיקון פנצ'ר","פנצ'ר","כיסויי מושב","שטיחוני רכב","ניקיון רכב","שעוות רכב","פוליש","פוליש לרכב","ארגונומיה לרכב","קונסולה","מטען לרכב","שמן בלמים","נוזל קירור","נוזל מגבים","מגבים","החלפת מגבים","נורות לרכב","פנס לרכב","חלקי חילוף לרכב","ציוד לרכב","אביזרי רכב","אביזרים לרכב","סטריאו לרכב","רמקולים לרכב","מקרן הקרנה"],"category":"תחבורה","subcategory":"אחזקת רכב"},
  {"keywords":["מסרק","מסרק שיער","מברשת שיער","פן","מייבש שיער","מחליק שיער","מסלסל","קייזר","אבן מלטשת","פלייר","פלייר לעצמות","מספריים לשיער","סכין גילוח","קצף גילוח","ג'ילט","ג'יליט","קרם גילוח","קרם אחרי גילוח","דאודורנט","שפתון","סוגי שפתון","אודם","איפור","איפור פנים","איפור עיניים","מסקרה","אייליינר","צללית","צללית עיניים","אבקה","פאודר","סומק","קונסילר","פריימר","ג'לסט","לק","לק לציפורניים","מסיר לק","פילר","מסיכת פנים","קרם פנים","קרם לחות","קרם עיניים","סרום","חלב פנים","טוניק","קלינסר","סקראב פנים","קרם אנטי אייג'ינג","קרם עיניים","ויטמין C קרם","קרם נגד קמטים","שמפו","מרכך","מסיכה לשיער","סטיילינג שיער","ג'ל לשיער","ספריי שיער","מוס","קרם שיער","שמן שיער","קרם הזנה","ציפי"],"category":"טיפוח","subcategory":"מוצרי טיפוח ויופי"},
  {"keywords":["חדר כושר","מנוי לחדר כושר","היט","פולס","הולמס פלייס","אנרגיים","פיט פיט","קרוספיט","יוגה","פילאטיס","אימון אישי","מאמן אישי","טרנר","חיטוב","תוסף תזונה","חלבון","אבקת חלבון","חטיף חלבון","תוסף ספורט","קריאטין","BCAA","ויטמינים","ויטמין D","ויטמין C","חומצה פולית","שמן דגים","אומגה 3","מולטי ויטמין","ברזל"],"category":"בריאות","subcategory":"ספורט ותוספים"},
  {"keywords":["בילוי","בילויים","בילוי זוגי","בילוי משפחתי","סופ\"ש בצימר","צימר","צימר רומנטי","בית הארחה","פאב","קולנוע","בית קולנוע","סרט","תיאטרון","הופעה","קונצרט","פסטיבל","אטרקציה","פארק שעשועים","סופרלנד","חוויה זוגית","חוויה משפחתית","ערב זוגי","יציאה זוגית"],"category":"בידור","subcategory":"בילוי ויציאה"},
  {"keywords":["סטים","סטים אפליקציה","אפליקציה","מנוי לאפליקציה","שופיפיי","שטריימר","מנוי שופיפיי","נטפליקס","ספוטיפיי","דיסני פלוס","יוטיוב פרימיום","אפל מיוזיק","אפל טיוי","אמזון פריים","קרים","עוקבים","אינסטגרם פרימיום","טינדר","בומבל","הינג'","אוקיו פיד","פייטר","דואולינגו","דואו לינגו","אנקי","טדם","HBO","אופיס 365","אופיס","Office 365","אדובי","פוטושופ","פרמייר","אילוסטרייטור","קנבה","Canva","קנבה פרו","Adobe Cloud","אפליקציות","דיג'יטל","תוכנה","תוכנה לעסק","תוכנת חשבוניות","אייקלאוד","iCloud","שטרגראם","פינטרסט"],"category":"בידור","subcategory":"מנויים דיגיטליים"},
  {"keywords":["משחק מחשב","משחקים","משחקי וידאו","סטים","Steam","אפיק","Epic Games","פלייסטיישן פלוס","PS Plus","אקס בוקס לייב","Xbox Game Pass","פורטנייט","Fortnite","מיינקראפט","Minecraft","FIFA","COD","Call of Duty","קונסולה","בקר משחק","קונטרולר","ג'וי קון","ניקרק","מקלדת גיימינג","עכבר גיימינג","אוזניות גיימינג","כסא גיימינג","שולחן גיימינג","Roblox","רובלוקס","V-Bucks","ג'מים","סקינים","כספים במשחק"],"category":"בידור","subcategory":"משחקי מחשב וקונסולה"},
  {"keywords":["מים","חשבון המים","תאגיד מים","אגרת מים"],"category":"הוצאות קבועות","subcategory":"מים"},
  {"keywords":["נטפליקס","ספוטיפיי","דיסני פלוס","יוטיוב פרימיום","אמזון פריים","אפל מיוזיק","אפל טיוי","מנוי נטפליקס","דיסני+"],"category":"בידור","subcategory":"סטרימינג"},
  {"keywords":["זארה","קסטרו","רנואר","טרמינל איקס","אמריקן איגל","פול אנד בר","מנגו בגדים","בגדים חדשים","נעלי ספורט","חולצה חדשה"],"category":"קניות","subcategory":"ביגוד"},
  // ===== ELECTRONICS — expanded 2026-05-25 (laptops/phones/TVs/etc) =====
  // Massive keyword coverage so "לפטופ" / "laptop" / "computer" / etc don't
  // fall through to שונות. Hebrew + English + transliterations.
  {"keywords":[
    // Laptops — Hebrew + English + transliterations
    "לפטופ","לפ טופ","לאפטופ","laptop","mac book","macbook","macbook air","macbook pro","מקבוק","מקבוק אייר","מקבוק פרו","ultrabook","אולטרבוק",
    "chromebook","כרומבוק","gaming laptop","לפטופ גיימינג","מחשב נייד","נייד","מחשב נישא","פורטבל",
    "thinkpad","lenovo","לנובו","dell","דל","hp","hp pavilion","asus","אסוס","acer","אייסר","msi","razer","ריזר",
    "alienware","framework laptop","surface laptop","surface pro","סרפס","surface book",
    // Desktops + workstations
    "מחשב","מחשב נייח","desktop","desktop pc","pc","tower pc","מגדל","workstation","ווקסטיישן","gaming pc","מחשב גיימינג",
    "imac","אייימק","mac mini","mac studio","mac pro","intel nuc","raspberry pi","רספברי פאי",
    // Phones
    "אייפון","iphone","iphone 15","iphone 16","iphone pro","iphone plus","iphone se","iphone mini",
    "סמסונג","samsung","samsung galaxy","galaxy s","galaxy a","galaxy z","galaxy fold","galaxy flip","סמסונג גלקסי",
    "פיקסל","pixel","google pixel","oneplus","ואן פלוס","שיאומי","xiaomi","mi","redmi","poco","huawei","הואווי","oppo","vivo","realme","nothing phone",
    "טלפון","טלפון חדש","טלפון נייד","cell phone","cellphone","smartphone","סמארטפון","מכשיר","פלאפון","פלייפון",
    // Tablets
    "אייפד","ipad","ipad pro","ipad air","ipad mini","tablet","טאבלט","galaxy tab","surface tablet","kindle","קינדל","amazon kindle",
    // TVs + displays
    "טלוויזיה","טלוויזיה חדשה","tv","television","smart tv","סמארט טי וי","oled","qled","טלוויזיית oled","טלוויזיית qled",
    "lg tv","lg oled","sony tv","sony bravia","סוני","tcl","hisense","samsung tv",
    "מסך","monitor","מסך מחשב","מסך 27","מסך אולטרא וייד","ultrawide","gaming monitor","מסך גיימינג","4k monitor","5k monitor",
    "projector","מקרן","epson projector","benq projector",
    // Accessories
    "אוזניות","headphones","אוזניות בלוטות","אוזניות אלחוטיות","wireless earbuds","אירפודס","airpods","airpods pro","airpods max",
    "מקלדת","keyboard","mechanical keyboard","מקלדת מכאנית","עכבר","mouse","wireless mouse","עכבר אלחוטי","mouse pad","פד עכבר",
    "מצלמת רשת","webcam","ring light","אור טבעת","microphone","מיקרופון","podcasting mic",
    "כרטיס גרפי","gpu","rtx","rtx 4090","rtx 5090","nvidia","amd radeon","gpu חדש",
    "ssd","hdd","דיסק קשיח","דיסק חיצוני","external drive","ram","זיכרון ram","ddr5",
    "מטען","charger","charger usb-c","מטען מהיר","fast charger","wireless charger","מטען אלחוטי","powerbank","פאוורבנק","power bank","סוללה ניידת",
    "כבל usb","כבל hdmi","hdmi cable","usb cable","usb-c cable","דונגל","dongle","מפצל","hub","usb hub","docking station","תחנת עגינה",
    // Smartwatches + wearables
    "שעון חכם","smartwatch","apple watch","apple watch ultra","אפל ווטש","garmin","גרמין","fitbit","פיטביט","whoop","וופ",
    // Smart home
    "אלקסה","alexa","amazon echo","google nest","נסט","smart speaker","רמקול חכם","sonos","סונוס","bose","שיאומי בית חכם","smart bulb","נורה חכמה","smart plug","שקע חכם"
  ],"category":"קניות","subcategory":"אלקטרוניקה"},
  {"keywords":["איקאה","ביתילי","רהיט","רהיט חדש","מזרן חדש","מערכת ישיבה","שולחן אוכל"],"category":"קניות","subcategory":"רהיטים"},
  {"keywords":["פלאפל","חומוס","המבורגר","גלידה","קינוח","ארוחת בוקר עסקית","בראנץ"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["ירקות ופירות","בשר טרי","מאפים","מצרכי בית"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["מרפאה פרטית","בדיקת דם","משקפי ראייה","חיסון","בדיקה רפואית"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["תספורת","מספרה","מניקור","פדיקור","קוסמטיקה","טיפול פנים","עיצוב שיער"],"category":"טיפוח","subcategory":"טיפוח"},
  {"keywords":["ביטוח רכב","ביטוח חובה","ביטוח מקיף"],"category":"תחבורה","subcategory":"ביטוח רכב"},
  {"keywords":["רב קו","טעינת רב קו","מטרונית","נסיעה ברכבת ישראל"],"category":"תחבורה","subcategory":"תחבורה ציבורית"},
  {"keywords":["יציאה עם חברים","ערב עם חברים","בילוי עם חברים","יצאנו עם חברים","יציאה עם חברות","ערב עם חברות","בילוי בעיר","ערב בעיר","יציאה לעיר","בילוי","בילויים","מסיבה","מסיבת","הופעה","הופעות","מופע","קולנוע","סרט בקולנוע","תיאטרון","סטנדאפ","קריוקי","מועדון","מועדון לילה","דרינק","דרינקים","ערב בילוי"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["תשלום מס הכנסה","מס הכנסה","מקדמת מס","מקדמות מס","דמי ביטוח לאומי","ביטוח לאומי","תשלום מעמ","תשלום מע״מ","מס שבח","מס רכישה","שומת מס","אגרת מס","תשלום לרשות המיסים","רשות המיסים"],"category":"הוצאות קבועות","subcategory":"מיסים ואגרות"},
  {"keywords":["ארוחה בחוץ","ארוחת צהריים","ארוחת בוקר","ארוחת ערב","ארוחה במסעדה","אוכל במשלוח","הזמנת אוכל","משלוח אוכל","אכלנו בחוץ","בית קפה","קפה ומאפה"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["קניות בסופר","קנייה בסופר","קניות לבית","קניות שבועיות","מצרכים","קניות במכולת"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["חשבון חשמל","תשלום חשמל"],"category":"הוצאות קבועות","subcategory":"חשמל"},
  {"keywords":["חשבון מים","תשלום מים"],"category":"הוצאות קבועות","subcategory":"מים"},
  {"keywords":["חשבון גז","תשלום גז"],"category":"הוצאות קבועות","subcategory":"גז"},
  {"keywords":["חשבון טלפון","חבילת סלולר","תשלום אינטרנט","חשבון אינטרנט","חבילת אינטרנט","חשבון סלולר"],"category":"הוצאות קבועות","subcategory":"תקשורת"},
  {"keywords":["תדלוק","דלק לרכב","תחנת דלק","מילאתי דלק"],"category":"תחבורה","subcategory":"דלק"},
  {"keywords":["נסיעה במונית","הזמנתי מונית","נסיעה בגט","נסיעה באובר"],"category":"תחבורה","subcategory":"מונית"},
  {"keywords":["דמי חניה","כרטיס חניה","תשלום חניון","חניון בתשלום"],"category":"תחבורה","subcategory":"חניה"},
  {"keywords":["כרטיס אוטובוס","נסיעה ברכבת","כרטיס רכבת","טעינת רב קו","נסיעה באוטובוס"],"category":"תחבורה","subcategory":"תחבורה ציבורית"},
  {"keywords":["ביקור אצל רופא","תור לרופא","רופא פרטי","ביקור במרפאה","בדיקת דם פרטית"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["תרופות במרשם","קניתי תרופות","בית מרקחת"],"category":"בריאות","subcategory":"תרופות"},
  {"keywords":["טיפול שיניים","רופא שיניים","ניקוי אבנית","סתימה אצל שיניים"],"category":"בריאות","subcategory":"שיניים"},
  {"keywords":["גן ילדים","שכר לימוד","חוג לילדים","שיעור פרטי","צהרון","מעון","מעון יום","קייטנה"],"category":"חינוך","subcategory":"חינוך"},
  {"keywords":["מתנה ליום הולדת","מתנה לחתונה","מתנה לחבר","מתנה לחברה","שי לחג","מתנת יום נישואין"],"category":"מתנות","subcategory":"מתנות"},
  {"keywords":["אוכל לכלב","אוכל לחתול","מזון לכלב","מזון לחתול","ביקור אצל וטרינר","חיסון לכלב"],"category":"חיות מחמד","subcategory":"חיות מחמד"},
  {"keywords":["משכורת","שכר חודש","שכר עבודה"],"category":"הכנסות","subcategory":"הכנסה 1 — משכורת","isIncome":true},
  {"keywords":["income 2","הכנסה 2","הכנסה עסקית","תשלום מלקוח"],"category":"הכנסות","subcategory":"הכנסה 2 — עסק","isIncome":true},
  {"keywords":["הכנסה - טלפוניה","טלפונים","מכירת טלפון","income 3","הכנסה 3","הכנסה נוספת"],"category":"הכנסות","subcategory":"הכנסה 3 — נוסף","isIncome":true},
  {"keywords":["בונוס","תקבול"],"category":"הכנסות","subcategory":"שונות (הכנסות)","isIncome":true},
  {"keywords":["am pm","ampm","אוכל בבית","אוכל לבית","אושר עד","אם המושבות","אם פי אם","בשר","גבינות","דגים","ויקטורי","חצי חינם","טיב טעם","יוחננוף","יינות ביתן","ירקות","מאפיה","מגה","מחסני השוק","מעיין 2000","סופר","פירות","קינג סטור","קרפור","רמי לוי","שופרסל","שופרסל אקספרס"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["aroma","bbb","cibus","cofix","kfc","mcdonald","nespresso","starbucks","ten bis","wolt","אוכל בחוץ","אוכל חוץ","אספרסו","ארומה","בורגר","בורגר קינג","בית קפה","גרג","גרג קפה","דומינוס","המבורגר","וולט","לחם ארז","מוזס","מסעדה","מסעדות","מקדונלדס","משלוח","משלוח אוכל","נספרסו","סושי","סיבוס","פיצה","פיצה האט","קופיקס","קפה","רולדין","שווארמה","שטראוס","תן ביס"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["95 octane","98 octane","ad blue","adblue","almanhig","alonit","alonit fuel","delek","delek eilat","delek israel","delek menta","delek motors","diesel","diesel israel","diesel plus","dor alon","fill up","fuel card","fuel pass","fuel pass israel","fuel pump","fuel station israel","fuel up","gas pump","gas station","manofim supergas","mileage","mishavat delek","pangaia","pangaia fuel","paz","paz diesel plus","paz fuel","paz self gas","paz selfgas","paz yam","paz yellow","paz zriza","premium 95","refuel","refueling","refueling station","regular gasoline","sdom fuel","self fueling","self refuel","self service paz","smart card delek","smart card דלק","sodom fuel","solar fuel","sonol","sonol eilat","sonol go","sonol israel","sonol self service","sonol selfservice","ten","ten 95","ten 98","ten eilat","ten exclusive","ten fuel","ten go","ten premium","ten premium 95","ten אילת","ten בלעדי","yellow card","yellow card paz","אד בלו","אדבלו","אלונית","אלמנהיג","אלמנהיג דלק","בנזין","בנזין 95","בנזין 98","בנזין רגיל","דור אלון","דיזל","דיזל פלוס","דלק","דלק אילת","דלק חברה","דלק חברת דלק","דלק מנטה","טן בלעדי","טן גו","טן פרימיום","כרטיס דלק","מילאז\\\\","מילוי דלק","מנופים סופרגז","משאבת דלק","סדום דלק","סולר","סונול","סונול 24","סונול 98","סונול אילת","סונול גו","סונול גוו","סונול סלף","סונול שטינמץ","סונול שירות עצמי","סונול תחנת דלק","פז 24","פז 98","פז דיזל פלוס","פז דלק","פז זריזה","פז יילו","פז ים","פז כנען","פז סלף גז","פז סלפ","פז שירות מהיר","פז שירות עצמי","פנגאיה","פנגאיה דלק","תדלוק","תדלוק עצמי","תחנה גז","תחנת דלק","תחנת תדלוק"],"category":"תחבורה","subcategory":"דלק"},
  {"keywords":["bird","lime","wind","בירד","יומנגו","ליים"],"category":"תחבורה","subcategory":"ליים"},
  {"keywords":["גיפ רוביקון","רוביקון"],"category":"תחבורה","subcategory":"רוביקון"},
  {"keywords":["ahuza parking","ahuzot","ahuzot hahof","ahuzot hahof parking","airport parking","arlozorov parking","autopark","basel parking","beit hasfarim parking","beit hazamarim parking","ben gurion airport parking","blue white parking","carmel checkpost","carmelton","cellopark","central bus station parking","central station parking","checkpost carmel","covered parking","dizengoff parking","dmei chaniya","duach chaniya","duch chaniya","easy park","easy park israel","easy park ישראל","easypark","easypark israel","hadassah parking","ichilov parking","industrial parking","jerusalem parking","kartis chaniya","mahane yehuda parking","mamilla parking","meter chaniya","modiin parking","namir parking","open parking","p1 parking","pango","pango app","pango israel","pango parking","pango premium","park park","parking fee","parking fine","parking meter","parking payment","parking permit","parking spot","parking subscription","parking ticket","parkme","parkpark","public parking","reading parking","reserved parking","selopark","shalom parking","sheba parking","spot hero","spothero","tav chaniya","tlv port parking","underground parking","yodfat parking","אוטו פארק","אוטופארק","אחוזה חניון","אחוזות החוף","אחוזות חוף","איזי פארק","דוח חניה","דמי חניה","חניה","חניה כחול לבן","חניון","חניון אחוזה","חניון איכילוב","חניון ארלוזורוב","חניון בזל","חניון בית הזמרים","חניון בית הספרים","חניון דיזנגוף","חניון הדסה","חניון השלום","חניון התחנה","חניון התחנה המרכזית","חניון התעשייה","חניון ירושלים","חניון מודיעין","חניון מחנה יהודה","חניון ממילא","חניון מקורה","חניון נמיר","חניון נמל ת","חניון נמל ת\"א","חניון נמל תא","חניון נתב\"ג","חניון נתבג","חניון פתוח","חניון רידינג","חניון שדה התעופה","חניון שיבא","חניון ת","חניון ת\"א ארלוזורוב","חניון תחנה מרכזית","חניון תת קרקעי","חניוני אחוזות חוף","חניות ציבוריות","חניות שמורות","יודפת","יודפת חניה","כחול לבן","כרטיס חניה","מנוי חניה","מקום חניה","סלופארק","סלופארק חניה","סלופארק תשלום","ספוט הירו","פארק מי","פנגו אפליקציה","פנגו ישראל","פנגו פרימיום","צ'ק פוסט הכרמל","צק פוסט הכרמל","ק פוסט הכרמל","קרמלטון","תו חניה","תשלום חניה"],"category":"תחבורה","subcategory":"חניה"},
  {"keywords":["easyjet","el al","flight","gett","taxi","uber","yango","אגד","אובר","אוטובוס","אל על","טיסה","יאנגו","ישראייר","מונית","מטרופולין","קווים","רב קו","רב-קו","רכבת"],"category":"תחבורה","subcategory":"מונית"},
  {"keywords":["bmw","s1000","אופנוע","אופנועים","ב.מ.וו"],"category":"תחבורה","subcategory":"BMW s1000"},
  {"keywords":["9000 insurance","9000 ביטוח","aig","aig car insurance","aig ביטוח רכב","aluf insurance","ayalon car","car compulsory insurance","car premium","clal car","comprehensive insurance","deductible","direct car insurance","hachshara car","hakol batuach car","harel car","insurance certificate","ituran","libra car","libra רכב","menorah car","migdal car","phoenix car","professional car insurance","rechev mugan","rechev mugan insurance","shirbit car","shomera car","third party insurance","wesure car","wesure רכב","איילון ביטוח","איילון ביטוח רכב","איתוראן","אלוף ביטוח","אלוף ביטוח רכב","ביטוח חובה","ביטוח חובה רכב","ביטוח מקיף","ביטוח מקיף רכב","ביטוח צד ג'","ביטוח צד ג\\","ביטוח רכב הכל בטוח","ביטוח רכב ישיר","ביטוח רכב מקצועי","הכשרה רכב","הפניקס ביטוח רכב","הראל ביטוח רכב","השתתפות עצמית","השתתפות עצמית רכב","ישיר ביטוח רכב","כלל ביטוח רכב","מגדל ביטוח רכב","מנורה ביטוח רכב","פרמיה ביטוח רכב","רכב מוגן","שומרה רכב","שירביט רכב","תעודת ביטוח"],"category":"תחבורה","subcategory":"ביטוח רכב"},
  {"keywords":["inokim","ninebot","segway","קורקינט"],"category":"תחבורה","subcategory":"קורקינט"},
  {"keywords":["agrat rishui","annual test","appraiser report","car appraiser","carmel levin car appraisal","comprehensive test","department of motor vehicles israel","dmv israel","dmv ישראל","license validity","licensing fee","licensing institute","licensing test","misrad harishui","road accident","test rechev","testing center","vehicle license","vehicle test","vision test","wiscar appraisal","wiscar שמאות","yearly inspection","אגרת רישוי","דוח שמאי","טסט","טסט מקיף","טסט עיני","טסט רכב","טסט שנתי","מבחן רישוי","מבחן שנתי","מכון בודק","משרד הרישוי","רישוי רכב","רישיון רכב","שמאי כרמל לוין","שמאי רכב","תאונת דרכים","תוקף רישוי"],"category":"תחבורה","subcategory":"רישוי"},
  {"keywords":["להעביר לאבא"],"category":"הוצאות זמניות","subcategory":"אבא"},
  {"keywords":["crossfit","goactive","gym","אימון","בריכה","גו אקטיב","חדר כושר","חוגים","יוגה","כושר","מאמן אישי","מכון כושר","פיט פלוס","פילאטיס","קאנטרי קלאב","שחייה"],"category":"הוצאות קבועות","subcategory":"מכון כושר"},
  {"keywords":["adidas","asos","castro","fox","h&m","levis","mango","next","nike","puma","renuar","shein","shoe","tommy","urbanica","zara","אדידס","אופנה","אורבניקה","בגדים","ביגוד","גולף","גרביים","דלתא","טומי הילפיגר","לויס","נייקי","נעליים","פולגת","פומה"],"category":"קניות","subcategory":"ביגוד"},
  {"keywords":["haircut","sephora","super pharm makeup","tikkun","wax","איי קיו","איפור","בושם","טיפוח","מאניקור","מספרה","מעצב שיער","מקס מרה","ספורה","ספרית","פדיקור","קרם","שעווה","תספורת"],"category":"קניות","subcategory":"טיפוח"},
  {"keywords":["12 לייב","1blocker pro","1login","abc mouse","abcmouse","abode security","abonament","abracadabra","accuweather plus","acronis","acronis true image","ad guard","adguard premium","adt monitoring","alltrails","alltrails plus","alltrails+","alpha vantage premium","amazon kids unlimited","amazon kids+","amazon kindle unlimited","amazon music","amazon music hd","amazon music prime","amazon music unlimited","amazon prime","amazon prime video","amazon video","annual billing","annual saas","anthropic","app store subscription","apple app store","apple gift card subscription","apple icloud 200gb","apple icloud 2tb","apple icloud 50gb","apple news plus","apple news+","apple one","apple podcasts","apple tv","apple tv plus","apple tv+","arc browser","arkham pro","arlo secure","aroma subscription","arq backup","atlas coffee","atlas coffee club","atlas vpn","atlasvpn","atom finance","att unlimited extra","audible","audible plus","audible premium","audible premium plus","audirvana","auth zero","auth0","auto pay subscription","autocrit","avast premium","avg internet security","awal","back blaze","backblaze","bamboo learning","bandcamp","bandcamp pro","barchart premium","bear app","bear pro","beat stars","beatstars","beehiiv max","betternet","bfi player","bfi פליר","billed monthly","billed yearly","billing","bitdefender","blink subscription","blinkist","blockfolio","blue bottle subscription","bluesky subscription","book beat","bookbeat","boosty subscription","boots membership","boxit","boxit israel","boxit ישראל","brave premium","bumble","bumble bff","bumble boost","bumble premium","bunq premium","carbonite","card on file subscription","carrot weather","carrot weather premium","castro","ccleaner","ccleaner pro","cd baby","cellcom tv","cellcom סטרימינג","channel 12 live","channel 13","channels dvr","chatgpt","checkpoint vpn","ci-en","circle membership","cisco anyconnect","claude","cleanmymac","cleanmymac x","cloud subscription","cloudflare registrar","cmb","coffee meets bagel","coingecko premium","coingecko pro","coinmarketcap pro","coinstats premium","comixology","comixology unlimited","convertkit creator pro","craft docs","craft pro","crashplan","creative shrimp","creator support patreon","credit card subscription","criterion","criterion channel","crunchyroll","crunchyroll manga","crunchyroll premium","crypto pro","cryptopro","cyber ghost","cyberghost","darksky","day one journal","day one premium","dazn","dazn premium","dc comics","dc universe infinite","deezer","deezer premium","delta investments","delta pro","dexscreener","diarium pro","discord nitro basic","discord nitro classic","discord server boost","disney+","distro kid","distrokid","domain.com","doordash dashpass","dorico","drafts pro","dropbox","dropbox plus 2tb","duck duck go privacy","duck duck moose","dune analytics","duo security","duolingo english test","duolingo plus family","duplicati","dynadot","eharmony","eharmonyplus","elite","elite singles","epic for kids","epic kids books","eros now","eset internet security","esp שלוש","espn","espn plus","espn+","espresso club","etoro club","etoro premium","etoro pro","eufy security","everand","evermusic","expert flyer","express vpn","expressvpn","f-secure","f1 pro","f1 tv","f1 פרו","facebook dating","facetune pro","facetune2","fanbox creator","fanhouse","fansly","fantia","fastmail","fastmail family","fastmail premium","feedbin","feedly","feedly pro","feedwrangler","feeld","fender","fender play","fight pass","figma","filen","filmic firstlight","filmic pro","filmstruck","finale notation","finviz","finviz elite","firefox relay","five minute journal","flowkey","fluentu premium","fortigate vpn","free tv","frontpoint","fubo","fubo tv","fubotv","funimation","gaia gps","gaia gps premium","getepic","ghostery midnight","ginger software","github copilot","glassnode","glidan subscription","global entry","globalprotect","go daddy","godaddy","going","google authenticator backup","google domains","google drive 100gb","google drive 200gb","google drive 2tb","google nest aware","google one ai premium","google one premium","google one storage","google play credit","google play music","google play subscription","google podcasts","grindr","grindr unlimited","grindr xtra","guitareo","happn","hbo","headway","her app","her dating","hey email","hey hey","hey.com email","hide my ass","hidemyass","hinge","hinge premium","hinge x","hma vpn","hoichoi","homer learning","hot box","hot israel","hot magic","hot max","hot plus","hot sport","hot vod","hot חודשי","hotspot shield","hulu","hulu live","hulu plus","ia writer","ibkr pro","icedrive","icloud","icloud 200gb","icloud 2tb","icloud 50gb","idrive","iex cloud","iheart","iheartradio","illy","illy subscription","in app purchase","in-app purchase","infuse pro","inoreader","inoreader supporter","inshot pro","instacart plus","instacart+","instagram subscription","instapaper","instapaper premium","intelligentsia subscription","internxt","intotheblock pro","investorplace","ipvanish","ishpaz","israel pay","ivacy","ivanti pulse vpn","izotope","javy coffee","jdate plus","journey app","jriver media center","jswipe","jumpcloud","kafe israel subscription","kagi premium","kagi ultimate","kaiko","kan 11","kan maaman","kan meir","kan עוף","kanafol box","kaspersky","kayak premium","khan academy kids","kido tv","kindle paperwhite warranty","kindle subscription kids","kindle unlimited","kit pro","kk plus","kobo audio","kobo audiobook","kobo plus","kodi addon","kolab now","kolabnow","kontakt","koyfin","lalylala","landr","language transfer","libro fm","libro.fm","lightroom mobile","lingokids","lingvist premium","linkedin career","linkedin recruiter","linkedin sales nav","logseq sync","loopcloud","lounge buddy","loungekey","lyft pink","macrotrends","mailerlite premium","mako plus","mako tv","malwarebytes","malwarebytes premium","manoui","manoy","marketwatch premium","marvel comics","marvel unlimited","mastodon support","match","match premium","match.com","matter","matter app","mcafee","mcafee total protection","mega 400gb","memberium","memberkit","memberpress","memberspace","messari","messari pro","microsoft store subscription","minder","mlb tv","mlb.tv","monthly billing","monthly saas","monzo plus","monzo premium","moon plus reader","moon+ reader pro","moralis","morningstar premium","moshi sleep","motley fool stock advisor","mozilla vpn","mubi","mubi go","mullvad","musescore","musescore pro","musi premium","musicgurus","musictheory.net","muzz","muzzmatch","myradar pro","n12 לייב","n26 business","n26 metal","n26 you","name cheap","name.com","namecheap","namecheap premium","namesilo","nansen","nansen ai","native instruments","native komplete","naturalreader premium","nba league pass","nba tv","nba טיוי","neat banking","neeva","nespresso club","nest aware","netflix","newsblur","nfl game pass","nfl plus","nfl+","nhl tv","nhl.tv","noggin","noggin app","norton 360","norton antivirus","noteflight","notion","notion ai add-on","obsidian","obsidian publish","obsidian sync","office 365","ok cupid","okcupid","okta","okta workforce","omnivore","one login","onedrive 1tb","onelogin","only fans","onlyfans subscription","onx","onx hunt","onx maps","openai","openprovider","openvpn access server","opera gx","opera one","output","output arcade","overcast","panda dome","pandora","pandora plus","pandora premium","paramount","paramount plus","paramount+","partner tv","patreon 10 dollar","patreon 5 dollar","patreon creator membership","patreon premium tier","patreon supporter","patreon top tier","paybox premium","payment for subscription","pbs kids","pbskids subscription","peacock","peacock premium","perimeter 81","perimeter81","pia vpn","pianote","picsart gold","picsart premium","pixaloop pro","play store","playground sessions","playon cloud","plenty of fish","plex","plex lifetime","plex pass","plex pass annual","plex premium","pocket","pocket casts","pocket premium","pof","polarr pro","polygon.io","porkbun","prime gaming","prime membership","prime video","prime ישראל","prime סרטים","priority pass","priority pass select","private internet access","proton mail","proton vpn","protonmail","protonvpn","prowritingaid","ps express premium","radarscope pro","raindrop pro","raindrop.io","raya","readwise","readwise reader","reddit gold","reddit premium","reflect notes","reflect.app","remnote pro","renewal","renewed automatically","reshet 13","reshet plus","reshet+","revolut","revolut metal","revolut plus","revolut premium","revolut ultra","ridewise","ring protect","ring protect plan","roam research","roamresearch","robinhood gold","rome2rio","roon","roon labs","routenote","saas billing","salams","samsung galaxy store","santiment","scott's cheap flights","scott\\","scribd","scribd everand","scrivener","scrivener premium","scriverer","seat guru","seeking","seeking alpha premium","shazam","shazam premium","shipt","shipt membership","shonen jump","sibelius","sibelius cloud","simplisafe","simply guitar","simply piano","simply wall st","simplywallst","skiff mail","skoove","skratch","skyscanner premium","sling tv","snack","snapchat plus","snapchat+","snapseed","snowball analytics","sole in a box","songtrust","sonicwall vpn","sophos home premium","sos backup","sos online backup","soundcloud","soundcloud go","soundcloud pro","soundhound","soundslice","soundtrap","soundtrap by spotify","speakly","spideroak","splice","splice pro","splice sounds","splice video","sport 1 הוט","sport 5 הוט","spotify premium individual","spybot","starbucks gold","starbucks rewards plus","starbucks subscription","starfall","stationhead","sting tv","sting חודשי","stitcher","stockanalysis.com","stockcharts","stockunlock","stoic journal","storm radar","storytel","stumptown subscription","subscribestar","subscription annual","subscription auto","subscription box israel","subscription monthly","surf shark","surfshark","synology c2","synology drive","t-mobile magenta max","tablo dvr","tailscale","tapas","tea box israel","telegram premium plus","telegram stars","ten bis premium","tenbis +","tenuto","the league","the motley fool","the next stage","the old reader","thinkorswim","threads premium","thrifty traveler","tidal","tidal connect","tidal hifi","tidal premium","tikr terminal","tiktok coins","tiktok gifts","tiktok premium","tinder","tinder gold","tinder platinum","tinder plus","tivo plus","tivo+","tova wine","tovaw subscription","trade coffee","trading view","tradingview essential","tradingview plus","tradingview premium","tradingview pro","trail forks","trend micro","tripadvisor","tripadvisor plus","triple play","tsa precheck","ttp","tubi premium","tucows","tumblr crabs","tune core","tunecore","tunnelbear","tuta","tutanota","twelve data","twitch prime sub","twitter blue","twitter premium","uber one","uber pass","ufc","ufc fight pass","ulysses","ulysses subscription","verizon plus","videoleap pro","vivaldi","vivint","viz manga","vlc donation","voice dream reader","vsco premium","vsco x","vypr","vyprvpn","walla tv","wanderu","wasabi","wasabi cloud","watchguard vpn","weather strike pro","weather underground","weather.com plus","webtoon","webull premium","windscribe","windy.app pro","windy.com premium","wine box israel","wipr","wise account","wise business","wise multi currency","wise premium","wisesheets","wolt plus","wolt+","wwe","wwe network","wyze cam plus","x premium","x premium+","x פרימיום","x-vpn","xvpn","yaakobi box","yabla","yahoo finance plus","yahoo finance premium","ycharts","yes 4k","yes drama","yes go","yes israel","yes max","yes oh","yes plus","yes plus 4k","yes sport","yes stick","yes vod","yes vod מנוי","yes חבילת בסיס","yes חודשי","yes פרימיום","ynet plus","ynet tv","ynet+","yousician","youtube music","youtube music premium","youtube premium","youtube premium individual","youtube premium lite","youtube tv base","youtube tv premium","yt premium family","yubikey","zacks premium","zerotier","zoho mail","zoolz","אבונמנט","אובר וואן","אוברקאסט","אודיבל","אוואל","אוול","אוון","אוורנד","אוטפוט ארקייד","אי-דרייב","אייהארט","אייהארט רדיו","אייוסי","אייזוטופ","אישפז box","אם אל בי","אמזון וידאו","אמזון מיוזיק","אמזון פריים","אמזון פריים וידאו","אן אייץ אל","אן אף אל פלוס","אנימה מנוי","אספן","אספן פלוס","אספרסו קלאב","אפ סטור","אפ סטור קרדיט","אפל tv","אפל טי וי","אפל טיוי","אפל ניוז פלוס","אקספרס וי פי אן","אקרוניס","ארומה לשמ","ארוס נאו","באקבלייז","בוקביט","בוקס איט","בוקסיט","ביט pay","ביטדפנדר","ביטול מנוי","ביטסטארס","בלינקיסט","בנדקאמפ","גלידן מנוי","דאבליו וי אי","דאזן","דאזן פרימיום","דיזר","דיזר פרימיום","דיסטרוקיד","האפן","הדווי","הוט בוקס","הוט וויאודי","הוט וי או די","הוט ישראל","הוט מאג'יק","הוט מקס","הוט סטיק","הוט ספורט","הוט פלוס","הויצ'וי","הויצ\\","הולו","הולו לייב","הולו פלוס","החזר מנוי","הסיוול בקופסה","השלב הבא של הג'אוון","וואלה טיוי","וויינט פלוס","וולט+","ויאלה tv","וינדסקרייב","חבילה ישראלית","טאנל בר","טוטה","טיונקור","טיידאל","טיידל","טינדר","טריפל פליי","יו אף סי","יוטיוב","יוטיוב מוסיקה","יוטיוב מיוזיק","יוטיוב פרימיום","יוסיציאן","יין לבית","יס גו","יס דרמה","יס וויאודי","יס וי או די","יס ישראל","יס מקס","יס סטיק","יס ספורט","יס פלוס","יעקובי קופסה","ירול","כאן 11","כאן מעמן","כאן רשת","לאנדר","לופקלאוד","ליברו","ליגת nba","מאצ'","מאצ\\","מאקו טיוי","מאקו פלוס","מובי","מוזיקת אמזון","מולוואד","מנוי","מנוי 1password","מנוי adobe","מנוי apple","מנוי apple tv","מנוי audible","מנוי canva","מנוי chatgpt","מנוי crunchyroll","מנוי dazn","מנוי deezer","מנוי disney","מנוי disney+","מנוי dropbox","מנוי espn","מנוי f1","מנוי figma","מנוי gemini","מנוי hbo","מנוי hulu","מנוי icloud","מנוי kindle","מנוי lastpass","מנוי mlb","מנוי mubi","מנוי nba","מנוי netflix","מנוי nfl","מנוי notion","מנוי office","מנוי paramount","מנוי peacock","מנוי prime","מנוי slack","מנוי spotify","מנוי tidal","מנוי ufc","מנוי vpn","מנוי youtube","מנוי zoom","מנוי אפל","מנוי גוגל","מנוי דיגיטל","מנוי הוט","מנוי חודשי כפתור","מנוי יין","מנוי יס","מנוי מיקרוסופט","מנוי מקצועי","מנוי ערוץ הספורט","מנוי פעיל","מנוי פריים","מנוי קפה","מנוי שירות ענן","מנוי שנתי כפתור","מנוי שנתי שילם","מנוי תה","מקאפי","נורטון","סאבסקריפשן","סאונדקלאוד","סאונדקלאוד פרו","סאס תשלום","סונגטראסט","סטורי-טל","סטוריטל","סטינג","סטינג טיוי","סטינג מנוי","סטינג ספורט","סטיצ'ר","סטיצר","סידי בייבי","סייברגוסט","סלינג","סלקום tv","סלקום טיוי","סלקום סטרימינג","סנאפ פלוס","סנפצ'אט פלוס","סנפצ\\","ספיידר אוק","ספלייס","סקרייבד","סרפשארק","ערוץ 12 לייב","ערוץ 13","ערוץ הספורט","ערוץ הספורט מנוי","ערוץ ספורט 1","פ1 tv","פאנימיישן","פאסטמייל","פודקאסטים אפל","פודקאסטים גוגל","פוקט קאסטס","פוקט-קאסטס","פורמולה 1 טיוי","פידלי","פיובו","פילם סטראק","פיקוק","פיקוק פרימיום","פלקס","פלקס פאס","פנדורה","פסנתר פשוט","פעיל מנוי","פרוטון וי פי אן","פרוטון מייל","פרטנר tv","פרטנר טיוי","פרטנר סטרימינג","פרי טיוי","פרייבט אינטרנט","פריים וידאו","פרמאונט פלוס","פרמאונט+","פרמונט","קאסטרו","קובו אודיו","קינדל אנלימיטד","קספרסקי","קראנצ'ירול","קראנצירול","קראש פלאן","קרבונייט","קריטריון","קריטריון צ'נל","קריטריון צ\\","ראוטנוט","רינג חבילה","רכישה באפליקציה","רשת +","רשת פלוס","תשלום אוטומטי מנוי","תשלום חודשי שירות","תשלום מנוי","תשלום שירות מקוון","תשלום שנתי"],"category":"הוצאות קבועות","subcategory":"אפליקציות"},
  {"keywords":["epic games","fortnite","gaming","nintendo","playstation","ps plus","ps5","steam","xbox","פלייסטיישן","פלייסטישן"],"category":"הוצאות קבועות","subcategory":"פלייסטיישן"},
  {"keywords":["lotto","הגרלה","חיש גד","לוטו","מפעל הפיס","פיס"],"category":"שונות ואחרים","subcategory":"לוטו"},
  {"keywords":["אפולו"],"category":"הוצאות קבועות","subcategory":"אפולו"},
  {"keywords":["coursera","edx","udemy","אוניברסיטה","חוברת לימוד","לימודים","מודל","מורה פרטי","מכללה","משכן הסטודנט","ספרי לימוד","קורס","שיעור פרטי","שכר לימוד"],"category":"הוצאות קבועות","subcategory":"לימודים"},
  {"keywords":["אישי"],"category":"שונות ואחרים","subcategory":"אישי"},
  {"keywords":["gift","מתנה","מתנות","צדקה","תרומה"],"category":"שונות ואחרים","subcategory":"מתנות"},
  {"keywords":["אירוע","בר מצווה","בת מצווה","חתונה","יום הולדת"],"category":"שונות ואחרים","subcategory":"אירועים"},
  {"keywords":["electricity","iec","חברת חשמל","חשמל"],"category":"הוצאות קבועות","subcategory":"חשמל"},
  {"keywords":["mortgage","ארנונה","דמי ניהול","ועד בית","משכנתא","שכירות","שכר דירה","תחזוקת בנין"],"category":"הוצאות קבועות","subcategory":"בית"},
  {"keywords":["מי אביבים","מי גולן","תאגיד מים"],"category":"הוצאות קבועות","subcategory":"מים"},
  {"keywords":["אמישראגז","בלון גז","דורגז","סופר גז","פז גז"],"category":"הוצאות קבועות","subcategory":"גז"},
  {"keywords":["012","014","bezeq","cellcom","hot","partner","pelephone","rami levy תקשורת","אינטרנט","אינטרנט סלולרי","בזק","גולן","גולן טלקום","הוט","סלולר","סלקום","פלאפון","פרטנר","תקשורת"],"category":"הוצאות קבועות","subcategory":"תקשורת"},
  {"keywords":["ace","home center","ikea","ksp","אייס","אינסטלטור","איקאה","ברק","הום סנטר","חשמלאי","ריהוט","תחזוקה"],"category":"הוצאות קבועות","subcategory":"תחזוקת בית"},
  {"keywords":["newpharm","super pharm","אופטומטריסט","אופטיקה","אורתודונט","בדיקות דם","בית מרקחת","כללית","לאומית","מאוחדת","מבדק רפואי","מכבי","מרפאה","משקפיים","ניו פארם","סופר פארם","פיזיותרפיה","פיסיותרפיה","קופת חולים","רופא","שיניים","תרופה","תרופות"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["ביטוח בריאות","ביטוח חיים","ביטוח משלים","בנקאות שב"],"category":"בריאות","subcategory":"ביטוח בריאות"},
  {"keywords":["airbnb","aliexpress","amazon","asos","booking","ebay","rozetka","shein","zap","אמזון","בוקינג","עלי אקספרס"],"category":"קניות","subcategory":"קניות מקוונות"},
  {"keywords":["cinema city","cinematheque","בית קולנוע","הופעה","יס פלאנט","יספלאנט","מופע","סינמה","תיאטרון"],"category":"שונות ואחרים","subcategory":"בילויים"},
  {"keywords":["audible","kindle","tzomet sfarim","סטימצקי","ספר","ספרים","צומת ספרים"],"category":"שונות ואחרים","subcategory":"ספרים"},
  {"keywords":["pet shop","דיוטי כלב","וטרינר","חיות","מזון לחתול","מזון לכלב"],"category":"שונות ואחרים","subcategory":"חיות מחמד"},
  {"keywords":["עסק facebook","עסק פייסבוק","עסק פרסום","עסק שיווק","פייסבוק עסק","שיווק facebook","שיווק עסק","שיווק פייסבוק","שיווק פייסביוק"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["עסק יועץ מס","עסק רואה חשבון"],"category":"עסק","subcategory":"יועצים"},
  {"keywords":["עסק"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["avis","hertz","אביס","באדג\\\\","הרץ"],"category":"תחבורה","subcategory":"רכב שכור"},
  {"keywords":["bank discount","bank leumi","beinleumi","discount","fibi","hapoalim","igud","leumi","massad","mercantile","mizrahi","otsar hahayal","poalim","tefahot","union bank","yahav","אוצר החייל","איגוד","בנק איגוד","בנק דיסקונט","בנק הבינלאומי","בנק הפועלים","בנק יהב","בנק לאומי","בנק מזרחי","בנק מסד","דיסקונט","הבינלאומי","הפועלים","יהב","לאומי","מזרחי טפחות","מסד","מרכנתיל","מרכנתיל דיסקונט","פאג"],"category":"הוצאות קבועות","subcategory":"בנקאות"},
  {"keywords":["altshuler","altshuler shaham","analyst","bitcoin","blender","clal finance","crypto","etf","excellence","ibi","interactive brokers","meitav","meitav dash","more investments","psagot","yelin lapidot","איי.בי.איי","אלטשולר","אנליסט","אקסלנס","ביטקוין","בלנדר","השקעה","ילין לפידות","כלל פיננסים","מור","מיטב דש","מניה","מניות","פסגות","קריפטו"],"category":"שונות ואחרים","subcategory":"השקעות"},
  {"keywords":["aig","ayalon","clal","clal insurance","harel","harel insurance","menora","menorah","migdal","migdal insurance","mivtachim","phoenix","phoenix holdings","איי איי ג\\\\","איילון","הפניקס","הראל","כלל","מגדל","מנורה","מנורה מבטחים"],"category":"הוצאות קבועות","subcategory":"ביטוח אישי"},
  {"keywords":["apple istore","bug","bug multisystem","evergreen","idigital","itzik electric","ksp","machsanei chashmal","photo house","samsung","אוורגרין","איציק אלקטריק","אל ג\\\\","מחסני חשמל","סמסונג","פוטו האוס","קי אס פי"],"category":"קניות","subcategory":"אלקטרוניקה"},
  {"keywords":["agrah","bituach leumi","darkon","doar israel","fee","income tax","israel post","lawyer","machon rishuy","mas hachnasa","national insurance","notary","oreh din","passport","rishyon nehiga","teudat zehut","אגרה","ביטוח לאומי","דואר ישראל","דרכון","מכון רישוי","מס הכנסה","נוטריון","עורך דין","רישיון נהיגה","תעודת זהות"],"category":"הוצאות קבועות","subcategory":"מיסים ואגרות"},
  {"keywords":["agoda","airbnb","booking","booking.com","expedia","hotels.com","kayak","trivago","אגודה","בוקינג"],"category":"שונות ואחרים","subcategory":"נסיעות"},
  {"keywords":["שונות"],"category":"שונות ואחרים","subcategory":"שונות"},
  {"keywords":["big shuk","extra market","fresh shuk","kfar shop","market fair","marketplace","mini super","my market","quick shop","stop and shop","store 24","super 24","super asaf","super ashdod","super avi","super aviv","super barak","super beer sheva","super binyamina","super bitan","super deal","super eilat","super ein","super express","super ezra","super fair","super hai","super haifa","super hashuk","super idan","super kesem","super kfar","super lev","super meir","super mendelson","super moshe","super nachal","super naveh","super netanya","super of","super online","super paz","super rishon","super ron","super roni","super shalom","super shchunati","super shlomo","super shofra","super tchelet","super tel aviv","super top","super tor","super toto","super tov","super yam","super yirmiyahu","super yuda","super ziv","super zol","super zol shachen","אקסטרא","אקסטרה","ביג שוק","החנות של אבי","החנות של דוד","החנות של משה","השוק שלי","כפר שופ","מחסני השוק חיפה","מחסני השוק רמלה","מי מרקט","מיני מרקט","מיני סופר","מרקט פייר","מרקט פלייס","סופר 24","סופר 24/7","סופר אבי","סופר אביב","סופר אונליין","סופר אילת","סופר אילת ים","סופר אסף","סופר אקספרס","סופר אשדוד","סופר באבא","סופר באבא בורגר","סופר באר שבע","סופר ביתן","סופר בנימינה","סופר ברק","סופר בת ים","סופר גבעתיים","סופר דיל","סופר ההתחלה","סופר הזהב","סופר היופי","סופר הרצליה","סופר הרצליה פיתוח","סופר השוק","סופר השכונה","סופר זול","סופר זול ילדי","סופר זול שכן","סופר זיו","סופר חולון","סופר חיפה","סופר טוב","סופר טוב טעם","סופר טוטו","סופר טופ","סופר יודה","סופר ים","סופר ירושלים","סופר ירמיהו","סופר כפר","סופר לב","סופר מאיר","סופר מודיעין","סופר מנדלסון","סופר משה","סופר נווה","סופר נחל","סופר נס ציונה","סופר נצחון","סופר נתניה","סופר עוף","סופר עזרא","סופר עידן","סופר עין","סופר ערן","סופר פז","סופר פייר","סופר פתח תקווה","סופר קסם","סופר ראשון","סופר רון","סופר רוני","סופר רחובות","סופר רמלה","סופר רמת גן","סופר רמת השרון","סופר רעננה","סופר שופרה","סופר שכונתי","סופר שלום","סופר שלמה","סופר תור","סופר תכלת","סופר תל אביב","סופר תמר","סופרמרקט הביתי","סופרמרקט המרכז","סטופ אנד שופ","סטור 24","פרש שוק","קוויק שופ","ראש העין סופר"],"category":"אוכל","subcategory":"אוכל לבית — סופרמרקטים ארציים"},
  {"keywords":["shufersal big","shufersal deal","shufersal express","shufersal good","shufersal plus","shufersal sheli","שופרסל אקו","שופרסל ב3","שופרסל באתר","שופרסל ביג","שופרסל בריא","שופרסל גוד","שופרסל גרין","שופרסל יחיאל","שופרסל מועדון","שופרסל מתחת לחשבון","שופרסל סופר","שופרסל פיינסט","שופרסל פלוס","שופרסל פרימיום"],"category":"אוכל","subcategory":"אוכל לבית — שופרסל וריאציות"},
  {"keywords":["farmers market","mahane yehuda","sarona","sarona market","shuk hacarmel","shuk hatikva","shuk levinsky","shuk mahane yehuda","shuk namal","shuk yafo","השוק העירוני","השוק של מאיר","שוק בנימינה","שוק בת ים","שוק האיכרים","שוק הכרמל","שוק העיר העתיקה","שוק העיר העתיקה ירושלים","שוק העיר צפת","שוק העירוני אילת","שוק העירוני באר שבע","שוק העתיקה צפת","שוק הפועלים","שוק הראל","שוק התקווה","שוק חבצלת","שוק חולון","שוק חיפה","שוק חצי חינם","שוק טבריה","שוק טבריה הישנה","שוק טירת הכרמל","שוק טלמון","שוק יפו","שוק כפר סבא","שוק לוד","שוק לוינסקי","שוק מחנה יהודה","שוק נמל תל אביב","שוק נצרת","שוק עכו","שוק רחובות","שוק רמלה","שוק רמלה הצבעוני","שוק רמת גן","שוק רמת השרון","שוק שכונת התקווה","שוק שלמה המלך","שוק שרונה","שוק תלפיות","שוק תלפיות חיפה"],"category":"אוכל","subcategory":"אוכל לבית — שווקים פתוחים"},
  {"keywords":["atliz hair","atliz hashef","atliz kasher","atliz shmil","beit habasar","bisri","galil katzavim","katzaviya","kazaviya","ketzaviyat hatzafon","ketzaviyat meir","melech habasar","shmil basar","אטליז ביאליק","אטליז גושן","אטליז דבש","אטליז דקלים","אטליז דרור","אטליז הגוש","אטליז הכפר","אטליז המושב","אטליז המתמחה","אטליז העתיקים","אטליז הצפון","אטליז הר נוף","אטליז זוהר","אטליז יעקב","אטליז כרם","אטליז כשר","אטליז מהדרין","אטליז משה","אטליז שלום","אטליז שמיל","אטליז שערי תשובה","אטליז שריג","ארמון הבשר","ארץ הבשר","ביתן הבשר","בשרי","גליל קצבים","האחים אטליז","מלך הבשר","ממלכת הבשר","מעדני אביב","מעדני בשר","מעדני שיא","סטייקיה","קצביה","קצביית אבי","קצביית אילן","קצביית גליל","קצביית דוד","קצביית האחים","קצביית הצפון","קצביית הרצוג","קצביית כפר סבא","קצביית מאיר","קצביית מודיעין","קצביית רויאל","קצביית רמת גן","שמיל בשר"],"category":"אוכל","subcategory":"אוכל לבית — קצביות"},
  {"keywords":["achlas dagim","birkat hayam","dagei castro","fish shop","sapir dagim","אכלס דגים","דג זהב","דגי אורנים","דגי איגוד","דגי אמן","דגי בית","דגי בית הסירות","דגי גליל","דגי גלים","דגי דן","דגי הגליל","דגי הים","דגי הים האדום","דגי הכרמל","דגי המלך","דגי הסירה","דגי הצוללים","דגי הצפון","דגי הצפון רעננה","דגי חבצלת","דגי טבריה","דגי כינרת","דגי כסיף","דגי מים מתוקים","דגי מרגנית","דגי קוסטר","דגי קיש","דגי קלאסיק","דגי תל אביב","ספיר דגים","שוק הדגים"],"category":"אוכל","subcategory":"אוכל לבית — דגים"},
  {"keywords":["abba","abulafia","alfi bakery","bakery","boulangerie","boureka","boureka bakery","brodenhaus","jachnun","lechem erez","lehem erez","lehmim","ofen","regev bakery","אבולעפיה","אופה הלחמים","אופן","אנג'ל מאפיה","אנג\\","בולנג'רי","בורקס","ברודנהאוס","ברמן מאפיה","ג'חנון","ירמיהו לחמים","לחמים","מאפה אלפי","מאפה רחל","מאפיית אבא","מאפיית אבולעפיה","מאפיית אופן","מאפיית אורן","מאפיית אחים סבו","מאפיית בורקס","מאפיית בורקס יוסי","מאפיית בורקסים","מאפיית בייקרי","מאפיית בית הלחם","מאפיית בית לבנו","מאפיית בית שאן","מאפיית בני ברק","מאפיית ברמן","מאפיית גליל עליון","מאפיית הזהב","מאפיית הר חברון","מאפיית הרים","מאפיית התימני","מאפיית חיים","מאפיית טוב","מאפיית ירושלים","מאפיית כהן","מאפיית כרם תימנים","מאפיית לחם","מאפיית לחם הכפר","מאפיית נחלת בנימין","מאפיית נעם","מאפיית סהרה","מאפיית סוטא","מאפיית סמדר","מאפיית עירית","מאפיית עץ הזית","מאפיית פאר","מאפיית פז","מאפיית קיבוץ","מאפיית קל בריא","מאפיית רגב","מאפיית רגיל","מאפיית רוטשילד","מאפיית רננה","מלכת הלחמניות","פיטה גינה","תכלת לחמים"],"category":"אוכל","subcategory":"אוכל לבית — מאפיות ולחם"},
  {"keywords":["eco food","herbet","naturalia","optim","organic bait","raw food","rimon health","super herbet","teva neto","tivoni","vegan friendly","vegan shop","vegetable shop","אגוזי גולן","אגוזי הגליל","אגוזי יקיר","אגוזים","אופטים","אורגני בית","אקו פוד","ארץ הטבע","ארץ הפרי","בית התבלינים","בריאות עכשיו","חנות אורגנית","חנות טבעונית","טבליסט","טבע 365","טבע גליל","טבע השדה","טבע ובריא","טבע ובריאות","טבע לחיים","טבע נטו","טבעוני","טבעוני שופ","ים פירות יבשים","ירק וטבע","ירק חי","ירק טרי","כל בו אורגני","כל פרי","מתוקי הצפון","נטורליה","סופר בריא","סופר הרברט","סופר טבע","עולם הטבע","פירות אדמה","פירות הגליל","פירות הים","פירות יבשים","פירות יבשים אחים אלון","פירות יבשים השוק","פירות יבשים יוסי","פירות יבשים שוק הכרמל","פירות יבשים שוק מחנה יהודה","פירות ירושלים","פרי הגליל","צמחוני שופ","רימון","רימון אורגני","תבל אורגני","תבליני המאה","תבליני העיר","תבליני הצפון","תבליני הקסם","תפוחי אדמה"],"category":"אוכל","subcategory":"אוכל לבית — אורגני ובריאות"},
  {"keywords":["adir winery","alexander beer","anvey tirosh","barkan winery","becks","beer artzit","binyamina winery","carlsberg","carmel winery","corona","dalton","flam winery","gamla","golan heights winery","goldstar","hamivchar wines","heineken","macabbi beer","malka beer","merkaz hayayin","negev beer","recanati","stella","tabor","tishbi","tperberg","tuborg","tulip winery","vins de france","wine boutique","wine cellar","wine shop","yarden","yein bachevra","yikvei golan","אבק יין","אגף היין","אופיר","אינסטה ויין","אלכסנדר","ארץ היין","ארק ויין","בוטיק היין","בירה ארץ","בירה גולדסטאר","בירה הנגב","בקבוקייה","בקס","ג'מס בירות","היינקן","המבחר","ויין שופ","ויינות ביתן","ופיר","טוברג","טעם היין","טעמי היין","יין באתר","יין על השולחן","יקבי אדיר","יקבי אלפים","יקבי בית אל","יקבי בנימינה","יקבי בעלי הבית","יקבי ברקן","יקבי גולן","יקבי גוש עציון","יקבי גליל","יקבי גמלא","יקבי דלתון","יקבי הברון","יקבי טוליפ","יקבי טפרברג","יקבי ירדן","יקבי כרם","יקבי כרמל","יקבי עידן","יקבי פלם","יקבי רקנאטי","יקבי תבור","יקבי תשבי","כל היין","מבחר יינות","מבשלת ארמון","מבשלת בזלת","מבשלת בנימינה","מבשלת הצפון","מבשלת מלכה","מועדון היין","מקבת","מקס היין","מרכז היין","מרתף יין","סטלה","סנדרה","ענבי תירוש","פלאיון יינות","קורונה","קרלסברג"],"category":"אוכל","subcategory":"אוכל לבית — יין ואלכוהול"},
  {"keywords":["deli market","delicatessen","gad dairy","mai dairy","moulin rouge","ארץ הגבינות","גבינות באר טוביה","גבינות הר ברכה","גבינות מאי","גבינות מבחר","גבינות ניר עציון","גבינות עמק","דלי","טריפל בי","טריפל בי בייגלס","מולין רוז","מחלבת איפרגן","מחלבת גד","מחלבת טרה","מחלבת יטבתה","מחלבת מאי","מחלבת רגב","מחלבת רמת הגולן","מחלבת שדה","מחלבת שטראוס","מחלבת תנובה","מלכת הגבינות","מעדנייה","מעדניית הזיתים","מעדניית הכרם","מעדניית הצפון","מעדניית הצפון יוסי","מעדניית כרמל","מעדניית פיצוצים","מעדניית פלורנטין","מעדניית פרנקפורט","מעדניית קצבים","מעדניית רוטשילד","מעדניית רחביה","פלאפל גינה"],"category":"אוכל","subcategory":"אוכל לבית — גבינות ומעדנים"},
  {"keywords":["angel lehem","lehem","אבן עזר","אהרון לחם","אופן מאפיות","אנג'ל לחם","אנג\\","ביצי גליל","ביצים טריות","ביצים מהמושב","ברמן לחם","החלב והלחם","לחם","מאפיית פז ירושלים","מאפיית פיתות","סוף הלחם","פיתות מסביר","פרוטרום","פרידמן לחם","ראם ראם","תות לחם","תפוז מאפיה"],"category":"אוכל","subcategory":"אוכל לבית — קמחנים ודברי מאפה"},
  {"keywords":["best buy supermarket","best market","easy market","eco 24","freezer market","kal market","panda market","pesculos","soda club","vivaworen","אקו 24","בסט מרקט","ויטוורן","ירמיהו 24","מותגי בית","מפיצי עוף הצפון","סודה קלאב","סופר עוף ברקן","סופר עוף הצפון","פאנדה","פנדה","פסקלוס","פריזר מרקט","קל מרקט"],"category":"אוכל","subcategory":"אוכל לבית — סופר מינים אחרים"},
  {"keywords":["abu hasan","alfasi","andrea","arba avnei yesod","area","armani restaurant","avi hakerem","bamakom","belgika","benedict","biga","bil'adi","bil\\","bistro 56","brasserie","calil","celant","chakra","chicago restaurant","chili thai","cucina","espresso bar","even oman","exacta","ezori","feerero","ferrara","fichman","fira","foxy","ha'ulpan","haachim","hamakom","hummus ful","ima restaurant","katit","kayaks","kidush","lima","lookanda","maadanya","massa","matzah restaurant","menta rosa","merkaz hamizrach","mexicano","okeanus","onami","opal","pastel","piazza","pronto","psychim","rangoon","river restaurant","sela restaurant","shan ti","shanti","shipudei hatikva","shipudei hatzafon","sirsi","spagetim","spaggio","spago","stk","succini","susita","tabun restaurant","taizu","tembel","the lobby","topchik","topik","toto restaurant","touch","trio","ulpan","uri buri","vitrina","ymca","אבו חסן","אבטחה","אבי הכרם","אבן אומן","אגון","אגיוס","אדומה","אונאמי","אופאל","אוקיינוס","אורי בורי","אזורי","אלפסי","אמא ביתא","אמא יוסף","אמא מימה","אנדרומדה","אנדריה","אנטיגונה","אנקליי","אספרסו בר","אספרסו מרסי","אצל אבי","אצל איציק","אצל הזקן","אצל יוסי","אצל יענקלה","אקדמיה","אקוסטיק","אקסקטה","ארבע אבני יסוד","ארבעת אבני יסוד","אריאה","אריה","ארמני","באולפן","ביגה","בייט פוד","ביסטרו 56","ביץ' פוד","ביץ\\","בלאק בר","בלגיקה","בלעדי","במקום","בנדיקט","בנדיקטוס","ברסרי","האולפן","האחוזה אבן יהודה","האחים","האחים מסעדה","המושבה","המעיין","המעיין החם","המקום","המקסיקני","השף הגדול","השף הקטן","וונגייט","ויטרינה","חומוס פול","חצר הכרם","חצר השף","טאבולה","טאבון","טאי","טאיזו","טאל","טאצ'","טאקו דה לוקה","טוטו","טופיק","טופצ'יק","טיים אאוט","טמבל","טמפו טמפו","טריו","יבה צ\\","יילי תאי","יני","כידוש","כיוון","כניסה חזרה","כסיף","כתית","כתרון","לוקנדה","ליסבון","מאי","מאי תאי","מאסה","מאסה אורבן","מינו","מלרי","מנטה ברסרי","מנטה רוזה","מסעדה איטלקית","מסעדת אבטחה","מסעדת אורי בורי","מסעדת אסיה","מסעדת אצל","מסעדת אקדמיה","מסעדת בית הלחי","מסעדת הדייגים","מסעדת הים","מסעדת הירדן","מסעדת המושבה","מסעדת המושבה הגרמנית","מסעדת הצדף","מסעדת השף","מסעדת התחנה","מסעדת זהב","מסעדת חופית","מסעדת חצר אחורית","מסעדת ימקא","מסעדת כיוון","מסעדת כסיף","מסעדת כרמל","מסעדת לוקנדה","מסעדת לימה","מסעדת לימון","מסעדת מינו","מסעדת מלרי","מסעדת מנדי","מסעדת מרגוז","מסעדת נחלת בנימין","מסעדת סלסה","מסעדת ענבים","מסעדת פרארה","מסעדת קוצ'ינה","מסעדת קוצ\\","מסעדת קוקו","מסעדת קייקס","מסעדת רוטשילד","מסעדת רחביה","מסעדת רמת השרון","מפיוז","מצה","מקסיקנו","מקסיקני אחים","מרגוז","מרכז המזרח","סואצ'יני","סוסיתא","סלנט","סלסה","סלע","סנט פטרסבורג","סנטה לוצ'יה","סנטה לוצ\\","סנטה קתרינה","ספאגטים","ספאגיו","סרבי","סרסי","ענבים","פאסטל","פוקסי","פיכמן","פיצריה אנדרומדה","פירא","פירא תל אביב","פלורנטין מסעדה","פנייה ימינה","פסיו","פסיכים","פרארה","פרגיתה","פרונטו","פררו","צ'אם","צ'אקרה","צ'יבה צ'יבה","צ'יילי תאי","צ'יקאגו","צ'ליל","קוצ'ינה","קוצ\\","ריבר","רנגון","שאן-טי","שיפודי הצפון","שיפודי התקווה"],"category":"אוכל","subcategory":"אוכל בחוץ — רשתות מסעדות"},
  {"keywords":["blacktail","blaze","casa nova","chain","fenisia","front","hahar","hamiznon","lechem va'shinski","lechem va\\","milgo umilbar","mirona","miznon","palazzo restaurant","post restaurant","rothschild","salina","santorini","scoop","shef restaurant","tai house","the chef","urban restaurant","אוזן","אוזן הכרם","אומאקסה","אוצמיג","אוצר","אורבן","אורבן בייקרי","אורלי ושאול","בלאק קייב","בלייז'","האריות","ההר","המגדל","המגדל הלבן","המזנון","השף הצעיר","ושינסקי","טאי בון","טאי הוסה","טאי טאי","טאיזו טאיזו","יין","מילגו","מילגו ומילבר","מסעדת אוצר השף","מסעדת דליה","מסעדת הביטריאן","מסעדת הקבע","מסעדת זונדל","מסעדת מירונה","מסעדת קזה ארומה","מסעדת רוטשילד 9","מסעדת רוקח","מסעדת תהילה","סלינה","סנט פיטר","סנטוריני","ספירה","ספירה מסעדה","סקופ","פאלאצו","פוסט","פיט פוד","פניציה","פרונט","פרנדס","צ'יין"],"category":"אוכל","subcategory":"אוכל בחוץ — שף ויוקרה"},
  {"keywords":["antonio's","antonio\\","big pizza","mastefano","matachat lapizza","papa john's","papa pizza","pizza ahim savo","pizza chef","pizza go","pizza gusto","pizza hip","pizza house","pizza king","pizza maker","pizza store","pizza time","pizza tov","sbarro","solo pasta","tony vespa","ביג פיצה","ונס","וספה","טוני וגוצ'י","טוני וגוצ\\","מתחת לפיצה","סבארו","סולו פסטה","פאפא ג'ונס","פיצה אבא","פיצה אגאדיר","פיצה אדמת השף","פיצה אומאמי","פיצה אחים נשר","פיצה אחים סבו","פיצה איטליאנו","פיצה איטלקי","פיצה איל פורנו","פיצה אילת","פיצה אלפי","פיצה אנטוניו","פיצה אנטוניני","פיצה אנטוניני אחים סבו","פיצה ארטיזנל","פיצה ארץ","פיצה ארצי","פיצה בית","פיצה בנאי","פיצה גוטה","פיצה גוסטו","פיצה גורם","פיצה גורמא","פיצה גורמה","פיצה גליל","פיצה גלילי","פיצה גליליה","פיצה דאני","פיצה דה אורסטו","פיצה דה דייגו","פיצה דה ויטוריו","פיצה דה לוקס","פיצה דה רומולוס","פיצה דיוויד","פיצה דייגו","פיצה דלסה","פיצה דלסיה","פיצה האג","פיצה היחפנית","פיצה הים","פיצה היפ","פיצה הכפר","פיצה הצפון","פיצה הרצליה","פיצה הרצליה פיתוח","פיצה השכונה","פיצה השף","פיצה ויטה","פיצה וספה","פיצה זוהר","פיצה חיפה","פיצה טוב","פיצה יוסי","פיצה ילדה","פיצה יסמין","פיצה ירושלים","פיצה כורסי","פיצה כפר ויתקין","פיצה כפר סבא","פיצה לאכול","פיצה לוד","פיצה לוצ'ינה","פיצה לוצ\\","פיצה מאוסטרליה","פיצה מאמא","פיצה מאסטיפנו","פיצה מייקר","פיצה מסטיפנו","פיצה נאפולטנה","פיצה נאפולי","פיצה נתניה","פיצה סטדל","פיצה סטיו","פיצה סטיל","פיצה פיוז'ן","פיצה פלאי","פיצה פלוס","פיצה פלוס פלוס","פיצה קונדיטוריה","פיצה קוקו","פיצה קזה","פיצה קמחין","פיצה קמחיני","פיצה קקטוס","פיצה ראש העין","פיצה רב","פיצה רוטשילד","פיצה רוטשילד תל אביב","פיצה רומאן","פיצה רומה","פיצה רומולו","פיצה רומולו ורומולוס","פיצה רומולוס","פיצה רומולוס ורומולוס","פיצה רוסטיק","פיצה רחובות","פיצה רישון","פיצה רמלה","פיצה רמת אביב","פיצה רנואר","פיצה רנואר תל אביב","פיצה רנינו","פיצה רעננה","פיצה שף","פיצה תל אביב"],"category":"אוכל","subcategory":"אוכל בחוץ — פיצריות"},
  {"keywords":["adama burger","bbb אילת","bbb חיפה","bbb ירושלים","bbb תל אביב","burger 360","burger bar","burger beach","burger scout","burgeria","burgers baron","burgersity","burgerz","fatburger","five guys","five guys israel","moses burger","new york burger","regev's","regev\\","regevz","shake shack","smokehouse","smokers","אגאדיר tlv","אגאדיר אילת","אגאדיר אשדוד","אגאדיר באר שבע","אגאדיר ברגר","אגאדיר חולון","אגאדיר חיפה","אגאדיר ירושלים","אגאדיר מודיעין","אגאדיר נתניה","אגאדיר נתניה צפון","אגאדיר פתח תקווה","אגאדיר ראשון","אגאדיר רחובות","אגאדיר רמת גן","אגאדיר רעננה","אגאדיר תל אביב","אגאדיר תל אביב דרום","אגאדיר תל אביב מרכז","אגאדיר תל אביב צפון","אדמה ברגר","אריה אדום","ברגר 21","ברגר 22","ברגר 27","ברגר 33","ברגר 360","ברגר 99","ברגר אדמה","ברגר אחד","ברגר אילן","ברגר אלסקה","ברגר אריה","ברגר באר","ברגר ביץ'","ברגר בית","ברגר ביתי","ברגר האחים","ברגר האחים אלון","ברגר השף","ברגר ויטוריו","ברגר ויטוריו אילת","ברגר טוב","ברגר טוטו","ברגר טופ","ברגר טופאז","ברגר יוס","ברגר יוס תל אביב","ברגר ילד","ברגר ילדים","ברגר ים","ברגר ישראלי","ברגר כיכר","ברגר כסיף","ברגר כפר ויתקין","ברגר לחם","ברגר מאסטר","ברגר מאסטרו","ברגר מוזס","ברגר מנגל","ברגר משפחתי","ברגר נגב","ברגר נמל","ברגר נשים","ברגר עוף","ברגר עץ","ברגר ראש העין","ברגר רוטשילד","ברגר רומאן","ברגר רוסטיק","ברגר רוקפלר","ברגר רחביה","ברגר רחביה ירושלים","ברגר רנואר","ברגר רנואר אילת","ברגר רנואר אילת דרום","ברגר רנואר אילת מרכז","ברגר רנואר אילת צפון","ברגר רנואר אשדוד","ברגר רנואר אשקלון","ברגר רנואר באר שבע","ברגר רנואר הרצליה","ברגר רנואר חיפה","ברגר רנואר חיפה דרום","ברגר רנואר חיפה מרכז","ברגר רנואר חיפה צפון","ברגר רנואר ירושלים","ברגר רנואר כפר סבא","ברגר רנואר כפר סבא דרום","ברגר רנואר כפר סבא מרכז","ברגר רנואר כפר סבא צפון","ברגר רנואר נתניה","ברגר רנואר נתניה דרום","ברגר רנואר נתניה מרכז","ברגר רנואר נתניה צפון","ברגר רנואר ראשון לציון","ברגר רנואר רחובות","ברגר רנואר רמת השרון","ברגר רנואר רמת השרון דרום","ברגר רנואר רמת השרון מרכז","ברגר רנואר רמת השרון צפון","ברגר רנואר רעננה","ברגר רנואר רעננה דרום","ברגר רנואר רעננה מרכז","ברגר רנואר רעננה צפון","ברגר רנואר תל אביב","ברגר רנינו","ברגר רעננה","ברגר רעננה דרום","ברגר רעננה מרכז","ברגר רעננה צפון","ברגרז","ברגרים בארון","ברגרים מאסטר שף","ברגרים מוזס","ברגרס בר","ברגרסיטי","ברגרסקאוט","ג'מס ברגר","ג'מס המבורגר","האריה הצעיר","הברגר של אבי","הברגר של משה","המבורגר אחים","המבורגר ביתי","המבורגר הצפון","המבורגר של אילן","המבורגריה","מוזס אילת","מוזס באר שבע","מוזס ירושלים","מוזס תל אביב","מס ברגר","ניו יורק ברגר","סמוקהאוס","סמוקרס","סמוקרס בר","פייב גאיז","פרגיהקלע","רגב'ז","רגבז","שייק שק"],"category":"אוכל","subcategory":"אוכל בחוץ — המבורגרים"},
  {"keywords":["achibi","asian bite","bangkok","beijing","bollywood restaurant","cocopan","fu long","hanoi","indian restaurant","kimchi","kinmon","koday","musau","nihon","noodle bar","omakase","outugi","pad thai","pan asia","pattaya","ramen","rani","saigon","sing lee","sukya","sushi de","sushi dragon","sushi shop","sushia","sushigaku","taj mahal","thai how","wasabi sushi","wok shop","wok wok","yakitoria","אאוטיגי","אבן יהודה סושי","אומקאסה","אומקאסה חיפה","אומקאסה ירושלים","אומקאסה רעננה","אומקאסה תל אביב","אסיאן בייט","אסיה אילת","אסיה אשדוד","אסיה אשקלון","אסיה באר שבע","אסיה ביץ'","אסיה ביץ\\","אסיה בת ים","אסיה גבעתיים","אסיה דרום","אסיה היפה","אסיה הרצליה","אסיה חולון","אסיה חיפה","אסיה ירושלים","אסיה כפר סבא","אסיה לוד","אסיה מודיעין","אסיה מרכז","אסיה נס ציונה","אסיה פן","אסיה צפון","אסיה ראשון","אסיה רחובות","אסיה רמלה","אסיה רמת גן","אסיה רעננה","אסיה תל אביב","אצ'יבי","אצל אבא ניל","אצל היפני","אצל הסיני","אצל הקוריאני","באליווד","בייגינג","בנקוק","בנקוק מסעדה","האנוי","הוא מי","הוא מי תאי","הוא מי תאי תל אביב","הודי הצפון","ואסבי","ווק אילת","ווק ביתי","ווק הרצליה","ווק ווק","ווק חיפה","ווק ירושלים","ווק כפר סבא","ווק על","ווק על האש","ווק על הגריל","ווק רעננה","ווק שופ","ווק תל אביב","ון נודלס","טאג' מהאל","טאג\\","טאיוואן","טאיוואן סנטר","טאיוואני","טוקיו","טוקיו בר","טוקיו סושי","י ירושלים","יאקיטוריה","יבי","כינמון","מוסאו","מסעדת הודית","מסעדת וייטנאמית","מסעדת קוריאה","מסעדת קוריאנית","נודל בר","נודלס בר","ניהון","סוקאיה","סושי 10","סושי 20","סושי 24","סושי 5","סושי 89","סושי 99","סושי אחים","סושי אילת","סושי אשדוד","סושי באר שבע","סושי בית הכרם","סושי בנימינה","סושי בר רעננה","סושי גבעתיים","סושי דה","סושי דוד","סושי דניאל","סושי דניס","סושי דרגון","סושי דרום","סושי האחים","סושי הוד השרון","סושי הים","סושי הצפון","סושי הרצליה","סושי חיפה","סושי טאי","סושי טאקו","סושי טאקו טאי","סושי טבריה","סושי טוקיו","סושי יבוא","סושי יבוא תל אביב","סושי יוקוהמה","סושי כוכב יאיר","סושי כסיף","סושי כפר","סושי כפר ויתקין","סושי כפר חב\"ד","סושי כפר סבא","סושי כפר תבור","סושי כרמיאל","סושי לופט","סושי לופטר","סושי לעיר","סושי מיגנו","סושי מיגנון","סושי נינג'ה","סושי נינג\\","סושי נצרת","סושי נתניה","סושי סבארו","סושי סוסיתא","סושי סטיו","סושי סטיק","סושי סנפיר","סושי עכו","סושי צפת","סושי קיבוץ","סושי קיסריה","סושי קריות","סושי רמת גן","סושי רמת השרון","סושי רעננה","סושי שופ","סושי שיו","סושי שיף","סושי שמונה","סושי שמונה הצפון","סושי שמונה חיפה","סושי שמונה ירושלים","סושי שמונה מגדל","סושי שמיש","סושי תל אביב","סושי תל אביב דרום","סושי תל אביב מרכז","סושי תל אביב צפון","סושיגאקו","סושיה","סייגון","סינג ליי","סינגפור","פאד תאי","פאד תאי אילת","פאד תאי אשדוד","פאד תאי אשקלון","פאד תאי באר שבע","פאד תאי בת ים","פאד תאי גבעתיים","פאד תאי הצפון","פאד תאי הרצליה","פאד תאי חולון","פאד תאי חיפה","פאד תאי ירושלים","פאד תאי כפר סבא","פאד תאי לוד","פאד תאי מודיעין","פאד תאי נס ציונה","פאד תאי ראשון","פאד תאי רמלה","פאד תאי רמת גן","פאד תאי רעננה","פאד תאי תל אביב","פו לונג","פו פו","פטאיה","פן אסיה","פרק טייוואן","קודאיה","קוקופאן","קוקופאן רעננה","קימצ'י","קימצ'י בית הכרם","קימצ'י ירושלים","קימצ'י תל אביב","קימצ\\","ראמן","ראמן 1","ראמן אחים","ראמן באר","ראמן בר","ראמן הים","ראמן הצפון","ראמן יוסי","ראמן יפו","ראמן רוטשילד","ראני","תאי ג'ין","תאי האו","תאיוואן"],"category":"אוכל","subcategory":"אוכל בחוץ — סושי ואסייתי"},
  {"keywords":["abu adham","abu ghosh","alaee","humus dabash","knafayim","אבו טוני","אבו מאהר","אבו ספיק","אבו עזרי","אבו עלי","אבו ראשד","חומוס אבו אדהם","חומוס אבו גוש","חומוס אבו מארון","חומוס אחים","חומוס אליהו","חומוס אלמ","חומוס אסכוס","חומוס אסלי","חומוס אסלי אילת","חומוס אסלי אשדוד","חומוס אסלי אשקלון","חומוס אסלי באר שבע","חומוס אסלי בת ים","חומוס אסלי גבעתיים","חומוס אסלי הרצליה","חומוס אסלי חדרה","חומוס אסלי חולון","חומוס אסלי חיפה","חומוס אסלי טבריה","חומוס אסלי טירת הכרמל","חומוס אסלי ירושלים","חומוס אסלי כפר סבא","חומוס אסלי כרמיאל","חומוס אסלי לוד","חומוס אסלי מודיעין","חומוס אסלי נס ציונה","חומוס אסלי נצרת","חומוס אסלי פתח תקווה","חומוס אסלי ראשון","חומוס אסלי רחובות","חומוס אסלי רמלה","חומוס אסלי רמת גן","חומוס אסלי רעננה","חומוס אסלי תל אביב","חומוס אריאלי","חומוס בית הסולטן","חומוס בית הסולטן הדרום","חומוס בית הסולטן הצפון","חומוס בית הסולטן הרצליה","חומוס בית לחם","חומוס בנדורה","חומוס בני","חומוס בעיר","חומוס בעיר העתיקה","חומוס דבאש","חומוס דמיר","חומוס המגדל","חומוס חביב","חומוס חליל","חומוס יהודה","חומוס יפו","חומוס כדורי","חומוס מהשוק","חומוס מומחה","חומוס מומחה אחים סבו","חומוס מומחה הדרום","חומוס מומחה הצפון","חומוס מומחה רעננה","חומוס מיכאל","חומוס מסביב לחומוס","חומוס מסביב לעולם","חומוס מסעדה","חומוס נוסעים","חומוס סנדל","חומוס עזה","חומוס פולוס","חומוס פינת השוק","חומוס פינתי","חומוס פינתי אילת","חומוס פינתי אשדוד","חומוס פינתי אשקלון","חומוס פינתי באר שבע","חומוס פינתי בת ים","חומוס פינתי גבעתיים","חומוס פינתי הרצליה","חומוס פינתי חולון","חומוס פינתי חיפה","חומוס פינתי טבריה","חומוס פינתי ירושלים","חומוס פינתי כפר סבא","חומוס פינתי כרמיאל","חומוס פינתי לוד","חומוס פינתי מודיעין","חומוס פינתי נס ציונה","חומוס פינתי נצרת","חומוס פינתי פתח תקווה","חומוס פינתי רחובות","חומוס פינתי רמלה","חומוס פינתי רמת גן","חומוס פינתי רעננה","חומוס פינתי תל אביב","חומוס שאול","חומוס שכונתי","חומוס שמש","חומוס שריה","חומוס תהילה","חומוס תורקי","חומוס תורקי הצפון","חומוס תכלת","כנפיים","כנפיים אילת","כנפיים אשדוד","כנפיים אשקלון","כנפיים באר שבע","כנפיים בת ים","כנפיים גבעתיים","כנפיים הצפון","כנפיים הרצליה","כנפיים חדרה","כנפיים חולון","כנפיים חיפה","כנפיים טבריה","כנפיים טירת הכרמל","כנפיים ירושלים","כנפיים כפר סבא","כנפיים כרמיאל","כנפיים לוד","כנפיים מודיעין","כנפיים נס ציונה","כנפיים נצרת","כנפיים פתח תקווה","כנפיים רחובות","כנפיים רמלה","כנפיים רמת גן","כנפיים רעננה","כנפיים תל אביב","מסעדת אבו אדהם","מסעדת אבו ספיק","מסעדת אבו עלי","מסעדת אבו עלי אבו גוש","מסעדת אבו עלי אילת","מסעדת אבו עלי אשדוד","מסעדת אבו עלי אשקלון","מסעדת אבו עלי באבו גוש","מסעדת אבו עלי באר שבע","מסעדת אבו עלי בת ים","מסעדת אבו עלי גבעתיים","מסעדת אבו עלי הדרום","מסעדת אבו עלי הצפון","מסעדת אבו עלי הרצליה","מסעדת אבו עלי חדרה","מסעדת אבו עלי חולון","מסעדת אבו עלי חיפה","מסעדת אבו עלי טבריה","מסעדת אבו עלי טירת הכרמל","מסעדת אבו עלי ירושלים","מסעדת אבו עלי כפר סבא","מסעדת אבו עלי כרמיאל","מסעדת אבו עלי לוד","מסעדת אבו עלי מודיעין","מסעדת אבו עלי נס ציונה","מסעדת אבו עלי נצרת","מסעדת אבו עלי פתח תקווה","מסעדת אבו עלי רחובות","מסעדת אבו עלי רמלה","מסעדת אבו עלי רמת גן","מסעדת אבו עלי רעננה","מסעדת אבו עלי תל אביב","מסעדת אבו ערב","מסעדת אבו ראני","מסעדת בית הקבוץ","מסעדת בית הקבוץ דגניה","מסעדת עלאי","מצליח אחים","מצליח חומוס","פול אחים","פול אחים יוסף","פול האחים","פול הצפון","פולישוק","פלאפל אביב","פלאפל אורי","פלאפל אזולאי","פלאפל אחים","פלאפל אחים יוסף","פלאפל אחים סבו","פלאפל גואטה","פלאפל גוטמן","פלאפל גליל","פלאפל גליל סהר","פלאפל גליל סובב","פלאפל גליל עליון","פלאפל גליל תחתון","פלאפל גרינברג","פלאפל הגינה","פלאפל הגינה אילת","פלאפל הגינה באר שבע","פלאפל הגינה גבעתיים","פלאפל הגינה הרצליה","פלאפל הגינה חיפה","פלאפל הגינה ירושלים","פלאפל הגינה כפר סבא","פלאפל הגינה מודיעין","פלאפל הגינה פתח תקווה","פלאפל הגינה רחובות","פלאפל הגינה רמת גן","פלאפל הגינה רעננה","פלאפל הגינה תל אביב","פלאפל ההר","פלאפל הכיכר","פלאפל המוסיקאי","פלאפל המכון","פלאפל המלך","פלאפל המעיין","פלאפל המקווה","פלאפל הסולטן","פלאפל הסולטני","פלאפל הסולטנס","פלאפל הסמלון","פלאפל הרמלה","פלאפל הרמלי","פלאפל יהונתן","פלאפל יואב","פלאפל יוסי","פלאפל יעקב","פלאפל ירושלים","פלאפל כהן","פלאפל לוי","פלאפל לויטן","פלאפל מאיר","פלאפל מאיר חיפה","פלאפל מאיר ירושלים","פלאפל מאיר תל אביב","פלאפל מהמושב","פלאפל מורד","פלאפל מיכאל","פלאפל מיקי","פלאפל מנדי","פלאפל מצליח","פלאפל משה","פלאפל נסים","פלאפל סמי","פלאפל פינתי","פלאפל פלוס","פלאפל פני העץ","פלאפל פסיכי","פלאפל קליין","פלאפל קסיף","פלאפל ראם","פלאפל ראש העין","פלאפל ראשון","פלאפל ראשון לציון","פלאפל רחביה","פלאפל רחובות","פלאפל רינת","פלאפל רמת אביב","פלאפל רמת גן","פלאפל רמת השרון","פלאפל רנואר","שווארמה אבי","שווארמה אבי גליל","שווארמה אבישי","שווארמה אורי","שווארמה אורן","שווארמה אזולאי","שווארמה איטה","שווארמה איציק","שווארמה אכזיב","שווארמה אלון","שווארמה אלוף","שווארמה אמיר","שווארמה אקסל","שווארמה אריאלי","שווארמה דבי","שווארמה דבי בלום","שווארמה דוד","שווארמה דייגו","שווארמה דניאל","שווארמה דניס","שווארמה דקלים","שווארמה דרור","שווארמה האחים","שווארמה הזקן","שווארמה הזקנה","שווארמה החייב","שווארמה החייב לעולם","שווארמה החייט","שווארמה החצי","שווארמה החצי גמר","שווארמה החתום","שווארמה החתיך","שווארמה הכמהין","שווארמה הכרך","שווארמה הסיירת","שווארמה הסירה","שווארמה הצוללים","שווארמה הצפון","שווארמה הראש","שווארמה הראשון","שווארמה הרך","שווארמה השוק","שווארמה השמן","שווארמה השמן והרזה","שווארמה השף","שווארמה השף הזקן","שווארמה השף הצעיר","שווארמה התאומים"],"category":"אוכל","subcategory":"אוכל בחוץ — מזרח תיכוני / חומוסיות"},
  {"keywords":["aroma express","blue bottle","blue bottle coffee","blue bottle haifa","blue bottle israel","blue bottle jerusalem","blue bottle tel aviv","cafe beat","coffee shop","coffee t","dizengoff","dona pelaze","ein kos","gringo cafe","illy","jean cafe","lavazza","leeban","libna","limor cafe","manilo","manx","metpak","ofen hakafe","or cafe","ort cafe","peet's coffee","peet\\","roasters","segafredo","solo cafe","soup and bread","soup cafe","starbucks israel","starbucks tel aviv","super cafe","tik cafe","tikkafe","אדם קפה","אופן הקפה","אורט קפה","אורי קפה","אורקפה","אילי קפה","אן קפה","ארומה אילת","ארומה אקספרס","ארומה אשדוד","ארומה אשקלון","ארומה באר שבע","ארומה בת ים","ארומה גבעתיים","ארומה הרצליה","ארומה חולון","ארומה חיפה","ארומה טבריה","ארומה ירושלים","ארומה כפר סבא","ארומה כרמיאל","ארומה לוד","ארומה מודיעין","ארומה נס ציונה","ארומה נצרת","ארומה פתח תקווה","ארומה רחובות","ארומה רמלה","ארומה רמת גן","ארומה רעננה","ארומה תל אביב","גרינגו קפה","דונה פלסה","ז'אן קפה","לאוואצה","ליבן","מאי קפה","מאי קפה אילת","מאי קפה אשדוד","מאי קפה אשקלון","מאי קפה באר שבע","מאי קפה בת ים","מאי קפה גבעתיים","מאי קפה הדרום","מאי קפה הצפון","מאי קפה הרצליה","מאי קפה הרצליה פיתוח","מאי קפה חולון","מאי קפה חיפה","מאי קפה טבריה","מאי קפה ירושלים","מאי קפה כפר סבא","מאי קפה כרמיאל","מאי קפה לוד","מאי קפה מודיעין","מאי קפה נס ציונה","מאי קפה נצרת","מאי קפה פתח תקווה","מאי קפה רחובות","מאי קפה רמלה","מאי קפה רמת גן","מאי קפה רעננה","מאי קפה תל אביב","מסעדה לוצ'יה","מסעדה לוצ\\","מצליח קפה","מתחת לתאנה","מתפק","נמרוד קפה","ס קפה","סבארה קפה","סגפרדי","סוגרי קפה","סוגרי קפה חיפה","סוגרי קפה ירושלים","סוגרי קפה תל אביב","סודה סטרים קפה","סולו קפה","סופ אן ברד","סופ קפה","סופר קפה","סוקולוב","סטרבקס בן גוריון","סטרבקס ישראל","עין כוס","פיט'ס קפה","קופי טי","קופי שופ","קפה אביב","קפה אביבא","קפה אבן","קפה אבן בעיר","קפה אבן יהודה","קפה אבן עזר","קפה אבן עזרא","קפה אגדות","קפה אגן","קפה אגניה","קפה אדומה","קפה אדם","קפה אהבה","קפה אהדה","קפה אוסטר","קפה אופן","קפה אופן אילת","קפה אופן אשדוד","קפה אופן אשקלון","קפה אופן באר שבע","קפה אופן בת ים","קפה אופן גבעתיים","קפה אופן הדרום","קפה אופן הצפון","קפה אופן הרצליה","קפה אופן חולון","קפה אופן חיפה","קפה אופן טבריה","קפה אופן ירושלים","קפה אופן כפר סבא","קפה אופן כרמיאל","קפה אופן לוד","קפה אופן מודיעין","קפה אופן נס ציונה","קפה אופן נצרת","קפה אופן פתח תקווה","קפה אופן רחובות","קפה אופן רמלה","קפה אופן רמת גן","קפה אופן רעננה","קפה אופן תל אביב","קפה אורנים","קפה אחווה","קפה אילנס באר שבע","קפה אילנס חיפה","קפה אילנס ירושלים","קפה אילנס תל אביב","קפה איתי","קפה איתי בורק'ס","קפה איתי בורק\\","קפה איתי קיוסק","קפה אכזיב","קפה ביט","קפה ביטא","קפה ביטה","קפה ביטוח","קפה ביטון","קפה ביטון אילת","קפה ביטון אשדוד","קפה ביטון אשקלון","קפה ביטון באר שבע","קפה ביטון בת ים","קפה ביטון גבעתיים","קפה ביטון הרצליה","קפה ביטון חולון","קפה ביטון חיפה","קפה ביטון טבריה","קפה ביטון ירושלים","קפה ביטון כפר סבא","קפה ביטון כרמיאל","קפה ביטון לוד","קפה ביטון מודיעין","קפה ביטון נס ציונה","קפה ביטון נצרת","קפה ביטון פתח תקווה","קפה ביטון רחובות","קפה ביטון רמלה","קפה ביטון רמת גן","קפה ביטון רעננה","קפה ביטון תל אביב","קפה ביטחון","קפה ביטמן","קפה גרג אילת","קפה גרג אשדוד","קפה גרג אשקלון","קפה גרג באר שבע","קפה גרג בת ים","קפה גרג גבעתיים","קפה גרג הרצליה","קפה גרג חולון","קפה גרג חיפה","קפה גרג טבריה","קפה גרג ירושלים","קפה גרג כפר סבא","קפה גרג כרמיאל","קפה גרג לוד","קפה גרג מודיעין","קפה גרג נס ציונה","קפה גרג נצרת","קפה גרג פתח תקווה","קפה גרג רחובות","קפה גרג רמלה","קפה גרג רמת גן","קפה גרג רעננה","קפה גרג תל אביב","קפה גרינברג","קפה גרינברג חיפה","קפה גרינברג ירושלים","קפה גרינברג תל אביב","קפה גרינג'","קפה דיזינגוף סנטר","קפה דיזנגוף","קפה דרך הים","קפה הברך","קפה הכרם","קפה הלל אחווה","קפה הלל אילת","קפה הלל אשדוד","קפה הלל באר שבע","קפה הלל גבעתיים","קפה הלל הרצליה","קפה הלל חולון","קפה הלל חיפה","קפה הלל ירושלים","קפה הלל כפר סבא","קפה הלל מודיעין","קפה הלל נתניה","קפה הלל פתח תקווה","קפה הלל ראשון","קפה הלל רחובות","קפה הלל רמת גן","קפה הלל רעננה","קפה הלל תל אביב","קפה הצפון","קפה זוהר","קפה זוהר אילת","קפה זוהר אשדוד","קפה זוהר אשקלון","קפה זוהר באר שבע","קפה זוהר בת ים","קפה זוהר גבעתיים","קפה זוהר הדרום","קפה זוהר הצפון","קפה זוהר הרצליה","קפה זוהר חולון","קפה זוהר חיפה","קפה זוהר טבריה","קפה זוהר ירושלים","קפה זוהר כפר סבא","קפה זוהר כרמיאל","קפה זוהר לוד","קפה זוהר מודיעין","קפה זוהר נס ציונה","קפה זוהר נצרת","קפה זוהר פתח תקווה","קפה זוהר רחובות","קפה זוהר רמלה","קפה זוהר רמת גן","קפה זוהר רעננה","קפה זוהר תל אביב","קפה זוהרה","קפה זיו","קפה זית","קפה זיתים","קפה זנגוויל","קפה זנדל","קפה זפר","קפה זפרון","קפה זפת","קפה זרזיר","קפה זרני","קפה חוצות","קפה כרמל","קפה לב","קפה לבונטין","קפה לונדון","קפה לוצ'יה","קפה לימוסין","קפה לימור","קפה מאי","קפה מאסטו","קפה מודרני","קפה מולן רוז'","קפה מולן רוז\\","קפה מורגנשטיין","קפה מינו","קפה מנילו","קפה מנקס","קפה מסטיק","קפה מסע","קפה מסעדה","קפה מצב רוח","קפה מצויר","קפה נדב","קפה נומי","קפה נטע","קפה ניסן","קפה ניצחון","קפה ניצן","קפה ניקול","קפה ניקיטה","קפה ניקיתא","קפה ניר","קפה ניריה","קפה ניריט","קפה ניתאי","קפה נמרוד","קפה נסקאפה","קפה סולוויל","קפה סופי","קפה סופיה","קפה סופלה","קפה סטולן","קפה סטונסטון","קפה סטילו","קפה סטליין","קפה סינמה","קפה סינמטק","קפה סמדר","קפה סמיט","קפה סמיר","קפה סמיר חיפה","קפה סנדויץ'","קפה סנדל","קפה סנטרל","קפה ספארי","קפה ספגטים","קפה ספונטני","קפה ספור","קפה ספי","קפה ספי הדרום","קפה ספי הצפון","קפה ספי הצפון אילת","קפה ספי הצפון אשדוד","קפה ספי הצפון אשקלון","קפה ספי הצפון באר שבע","קפה ספי הצפון בת ים","קפה ספי הצפון גבעתיים","קפה ספי הצפון הרצליה","קפה ספי הצפון חולון","קפה ספי הצפון חיפה","קפה ספי הצפון טבריה","קפה ספי הצפון ירושלים","קפה ספי הצפון כפר סבא","קפה ספי הצפון כרמיאל","קפה ספי הצפון לוד","קפה ספי הצפון מודיעין","קפה ספי הצפון נס ציונה","קפה ספי הצפון נצרת","קפה ספי הצפון פתח תקווה","קפה ספי הצפון רחובות","קפה ספי הצפון רמלה","קפה ספי הצפון רמת גן","קפה ספי הצפון רעננה","קפה ספי הצפון תל אביב","קפה ספיגדה","קפה ספיין","קפה ספיציה","קפה ספיר","קפה ספירל","קפה ספלי","קפה ספמדה","קפה ספסל","קפה ספרי","קפה ספריג","קפה ספריט","קפה סקאלה","קפה סקופ","קפה סקיוויל","קפה סקרן","קפה סקרני","קפה סקרניות","קפה עירוני","קפה עירוני אילת","קפה עירוני אשדוד","קפה עירוני אשקלון","קפה עירוני באר שבע","קפה עירוני בת ים","קפה עירוני גבעתיים","קפה עירוני הדרום","קפה עירוני הצפון","קפה עירוני הרצליה","קפה עירוני חולון","קפה עירוני חיפה","קפה עירוני טבריה","קפה עירוני ירושלים","קפה עירוני כפר סבא","קפה עירוני כרמיאל","קפה עירוני לוד","קפה עירוני מודיעין","קפה עירוני נס ציונה","קפה עירוני נצרת","קפה עירוני פתח תקווה","קפה עירוני רחובות","קפה עירוני רמלה","קפה עירוני רמת גן","קפה עירוני רעננה","קפה עירוני תל אביב","קפה רוטשילד","קפה רוטשילד 10","קפה רוטשילד 12","קפה רוטשילד 18","קפה רוטשילד 19","קפה רוטשילד 22","קפה רוטשילד 23","קפה רוטשילד 29","קפה רוטשילד 3","קפה רוטשילד 9","קפה רוסטרס","קפה רוסטרס באר שבע","קפה רוסטרס הרצליה","קפה רוסטרס חיפה","קפה רוסטרס ירושלים","קפה רוסטרס כפר סבא","קפה רוסטרס רעננה","קפה רוסטרס תל אביב","קפה רוקח","קפה רחביה","קפה רחביה אילת","קפה רחביה אשדוד","קפה רחביה אשקלון","קפה רחביה באר שבע","קפה רחביה בת ים","קפה רחביה גבעתיים","קפה רחביה הדרום","קפה רחביה הצפון","קפה רחביה הרצליה","קפה רחביה הרצליה פיתוח","קפה רחביה חולון","קפה רחביה חיפה","קפה רחביה טבריה","קפה רחביה ירושלים","קפה רחביה כפר סבא","קפה רחביה כרמיאל","קפה רחביה לוד","קפה רחביה מודיעין","קפה רחביה נס ציונה","קפה רחביה נצרת","קפה רחביה פתח תקווה","קפה רחביה רחובות","קפה רחביה רמלה","קפה רחביה רמת גן","קפה רחביה רעננה","קפה רחביה תל אביב","קפה תיק קפה","תיק קפה"],"category":"אוכל","subcategory":"אוכל בחוץ — בתי קפה ישראליים"},
  {"keywords":["elin","konditoria","lechem","lehamim","my date","souffle","soufflé","tasta","velvet","אלין","אלין אילת","אלין אשדוד","אלין אשקלון","אלין באר שבע","אלין בת ים","אלין גבעתיים","אלין הרצליה","אלין חולון","אלין חיפה","אלין טבריה","אלין ירושלים","אלין כפר סבא","אלין כרמיאל","אלין לוד","אלין מודיעין","אלין נס ציונה","אלין נצרת","אלין פתח תקווה","אלין קונדיטוריה","אלין רחובות","אלין רמלה","אלין רמת גן","אלין רעננה","אלין תל אביב","ברנר","ברנר אילת","ברנר אשדוד","ברנר אשקלון","ברנר באר שבע","ברנר בת ים","ברנר גבעתיים","ברנר הרצליה","ברנר חולון","ברנר חיפה","ברנר טבריה","ברנר ירושלים","ברנר כפר סבא","ברנר כרמיאל","ברנר לוד","ברנר מודיעין","ברנר נס ציונה","ברנר נצרת","ברנר פתח תקווה","ברנר רחובות","ברנר רמלה","ברנר רמת גן","ברנר רעננה","ברנר תל אביב","ה אילת","ה אשקלון","ה בת ים","ה הרצליה","ה חיפה","ה ירושלים","ה כרמיאל","ה מודיעין","ה נצרת","ה רחובות","ה רמת גן","ה תל אביב","ולווט","ולווט קונדיטוריה","טאסטה","טאסטה אילת","טאסטה אשדוד","טאסטה אשקלון","טאסטה באר שבע","טאסטה בת ים","טאסטה גבעתיים","טאסטה הרצליה","טאסטה חולון","טאסטה חיפה","טאסטה טבריה","טאסטה ירושלים","טאסטה כפר סבא","טאסטה כרמיאל","טאסטה לוד","טאסטה מודיעין","טאסטה נס ציונה","טאסטה נצרת","טאסטה פתח תקווה","טאסטה רחובות","טאסטה רמלה","טאסטה רמת גן","טאסטה רעננה","טאסטה תל אביב","מאי דייט","מאי דייט ירושלים","מאי דייט קונדיטוריה","מאי דייט תל אביב","מאפיית גרג אילת","מאפיית גרג אשדוד","מאפיית גרג אשקלון","מאפיית גרג באר שבע","מאפיית גרג בת ים","מאפיית גרג גבעתיים","מאפיית גרג הרצליה","מאפיית גרג חולון","מאפיית גרג חיפה","מאפיית גרג טבריה","מאפיית גרג ירושלים","מאפיית גרג כפר סבא","מאפיית גרג כרמיאל","מאפיית גרג לוד","מאפיית גרג מודיעין","מאפיית גרג נס ציונה","מאפיית גרג נצרת","מאפיית גרג פתח תקווה","מאפיית גרג רחובות","מאפיית גרג רמלה","מאפיית גרג רמת גן","מאפיית גרג רעננה","מאפיית גרג תל אביב","מיני קונדיטוריה","מסעדת ההשוקולד","מסעדת השוקולד","מסעדת השוקולד אילת","מסעדת השוקולד אשדוד","מסעדת השוקולד אשקלון","מסעדת השוקולד באר שבע","מסעדת השוקולד בת ים","מסעדת השוקולד גבעתיים","מסעדת השוקולד הדרום","מסעדת השוקולד הצפון","מסעדת השוקולד הרצליה","מסעדת השוקולד חולון","מסעדת השוקולד חיפה","מסעדת השוקולד טבריה","מסעדת השוקולד ירושלים","מסעדת השוקולד כפר סבא","מסעדת השוקולד כרמיאל","מסעדת השוקולד לוד","מסעדת השוקולד מודיעין","מסעדת השוקולד נס ציונה","מסעדת השוקולד נצרת","מסעדת השוקולד פתח תקווה","מסעדת השוקולד רחובות","מסעדת השוקולד רמלה","מסעדת השוקולד רמת גן","מסעדת השוקולד רעננה","מסעדת השוקולד תל אביב","מקס ברנר אילת","מקס ברנר אשדוד","מקס ברנר אשקלון","מקס ברנר באר שבע","מקס ברנר בת ים","מקס ברנר גבעתיים","מקס ברנר הדרום","מקס ברנר הצפון","מקס ברנר הרצליה","מקס ברנר חולון","מקס ברנר חיפה","מקס ברנר טבריה","מקס ברנר ירושלים","מקס ברנר כפר סבא","מקס ברנר כרמיאל","מקס ברנר לוד","מקס ברנר מודיעין","מקס ברנר נס ציונה","מקס ברנר נצרת","מקס ברנר פתח תקווה","מקס ברנר רחובות","מקס ברנר רמלה","מקס ברנר רמת גן","מקס ברנר רעננה","מקס ברנר תל אביב","ניר עוגות","ניר עוגות אילת","ניר עוגות אשדוד","ניר עוגות אשקלון","ניר עוגות באר שבע","ניר עוגות בת ים","ניר עוגות גבעתיים","ניר עוגות הרצליה","ניר עוגות חולון","ניר עוגות חיפה","ניר עוגות טבריה","ניר עוגות ירושלים","ניר עוגות כפר סבא","ניר עוגות כרמיאל","ניר עוגות לוד","ניר עוגות מודיעין","ניר עוגות נס ציונה","ניר עוגות נצרת","ניר עוגות פתח תקווה","ניר עוגות רחובות","ניר עוגות רמלה","ניר עוגות רמת גן","ניר עוגות רעננה","ניר עוגות תל אביב","סופלה","סופלה אילת","סופלה אשדוד","סופלה אשקלון","סופלה באר שבע","סופלה בת ים","סופלה גבעתיים","סופלה הרצליה","סופלה חולון","סופלה חיפה","סופלה טבריה","סופלה ירושלים","סופלה כפר סבא","סופלה כרמיאל","סופלה לוד","סופלה מודיעין","סופלה נס ציונה","סופלה נצרת","סופלה פתח תקווה","סופלה רחובות","סופלה רמלה","סופלה רמת גן","סופלה רעננה","סופלה תל אביב","פדריקו","פדריקו טאקו","פדריקו טאקו אילת","פדריקו טאקו אשדוד","פדריקו טאקו אשקלון","פדריקו טאקו באר שבע","פדריקו טאקו בת ים","פדריקו טאקו גבעתיים","פדריקו טאקו הרצליה","פדריקו טאקו חולון","פדריקו טאקו חיפה","פדריקו טאקו טבריה","פדריקו טאקו ירושלים","פדריקו טאקו כפר סבא","פדריקו טאקו כרמיאל","פדריקו טאקו לוד","פדריקו טאקו מודיעין","פדריקו טאקו נס ציונה","פדריקו טאקו נצרת","פדריקו טאקו פתח תקווה","פדריקו טאקו רחובות","פדריקו טאקו רמלה","פדריקו טאקו רמת גן","פדריקו טאקו רעננה","פדריקו טאקו תל אביב","פוקצ'ה","פוקצ'ה אילת","פוקצ'ה אשדוד","פוקצ'ה אשקלון","פוקצ'ה באר שבע","פוקצ'ה בת ים","פוקצ'ה גבעתיים","פוקצ'ה הרצליה","פוקצ'ה חולון","פוקצ'ה חיפה","פוקצ'ה טבריה","פוקצ'ה ירושלים","פוקצ'ה כפר סבא","פוקצ'ה כרמיאל","פוקצ'ה לוד","פוקצ'ה מודיעין","פוקצ'ה נס ציונה","פוקצ'ה נצרת","פוקצ'ה פתח תקווה","פוקצ'ה רחובות","פוקצ'ה רמלה","פוקצ'ה רמת גן","פוקצ'ה רעננה","פוקצ'ה תל אביב","פוקצ\\","פטיפור","פטיפור אילת","פטיפור אשדוד","פטיפור אשקלון","פטיפור באר שבע","פטיפור בת ים","פטיפור גבעתיים","פטיפור הרצליה","פטיפור חולון","פטיפור חיפה","פטיפור טבריה","פטיפור ירושלים","פטיפור כפר סבא","פטיפור כרמיאל","פטיפור לוד","פטיפור מודיעין","פטיפור נס ציונה","פטיפור נצרת","פטיפור פתח תקווה","פטיפור רחובות","פטיפור רמלה","פטיפור רמת גן","פטיפור רעננה","פטיפור תל אביב","קונדיטוריה","קונדיטוריית אילת","קונדיטוריית אלון","קונדיטוריית אשדוד","קונדיטוריית אשקלון","קונדיטוריית באר שבע","קונדיטוריית בת ים","קונדיטוריית גבעתיים","קונדיטוריית גלקסי","קונדיטוריית הדרום","קונדיטוריית הצפון","קונדיטוריית הרצליה","קונדיטוריית חולון","קונדיטוריית טבריה","קונדיטוריית טוב","קונדיטוריית כפר סבא","קונדיטוריית כרמיאל","קונדיטוריית לוד","קונדיטוריית מאיר","קונדיטוריית מודיעין","קונדיטוריית נס ציונה","קונדיטוריית נצרת","קונדיטוריית פאר","קונדיטוריית פתח תקווה","קונדיטוריית ראש העין","קונדיטוריית רוטשילד","קונדיטוריית רוטשילד אילת","קונדיטוריית רוטשילד אשדוד","קונדיטוריית רוטשילד אשקלון","קונדיטוריית רוטשילד באר שבע","קונדיטוריית רוטשילד בת ים","קונדיטוריית רוטשילד גבעתיים","קונדיטוריית רוטשילד הדרום","קונדיטוריית רוטשילד הצפון","קונדיטוריית רוטשילד הרצליה","קונדיטוריית רוטשילד חולון","קונדיטוריית רוטשילד חיפה","קונדיטוריית רוטשילד טבריה","קונדיטוריית רוטשילד ירושלים","קונדיטוריית רוטשילד כפר סבא","קונדיטוריית רוטשילד כרמיאל","קונדיטוריית רוטשילד לוד","קונדיטוריית רוטשילד מודיעין","קונדיטוריית רוטשילד נס ציונה","קונדיטוריית רוטשילד נצרת","קונדיטוריית רוטשילד פתח תקווה","קונדיטוריית רוטשילד רחובות","קונדיטוריית רוטשילד רמלה","קונדיטוריית רוטשילד רמת גן","קונדיטוריית רוטשילד רעננה","קונדיטוריית רוטשילד תל אביב","קונדיטוריית רחביה","קונדיטוריית ריבר","קונדיטוריית רכז","קונדיטוריית רמלה","קונדיטוריית רמת גן","קונדיטוריית רנואר","קונדיטוריית רעננה","תפוז קונדיטוריה","תפוז קונדיטוריה אילת","תפוז קונדיטוריה אשדוד","תפוז קונדיטוריה אשקלון","תפוז קונדיטוריה באר שבע","תפוז קונדיטוריה בת ים","תפוז קונדיטוריה גבעתיים","תפוז קונדיטוריה הרצליה","תפוז קונדיטוריה חולון","תפוז קונדיטוריה חיפה","תפוז קונדיטוריה טבריה","תפוז קונדיטוריה ירושלים","תפוז קונדיטוריה כפר סבא","תפוז קונדיטוריה כרמיאל","תפוז קונדיטוריה לוד","תפוז קונדיטוריה מודיעין","תפוז קונדיטוריה נס ציונה","תפוז קונדיטוריה נצרת","תפוז קונדיטוריה פתח תקווה","תפוז קונדיטוריה רחובות","תפוז קונדיטוריה רמלה","תפוז קונדיטוריה רמת גן","תפוז קונדיטוריה רעננה","תפוז קונדיטוריה תל אביב"],"category":"אוכל","subcategory":"אוכל בחוץ — קונדיטוריות וקינוחים"},
  {"keywords":["anderson","baskin robbins","froyo","gelato","haagen dazs","häagen dazs","iceberg","magnum cafe","marzipan","milky shake","stam icecream","tnuva ice cream","vitman","yogurberry","אייסברג","אייסברג אילת","אייסברג אשדוד","אייסברג אשקלון","אייסברג באר שבע","אייסברג בת ים","אייסברג גבעתיים","אייסברג גלידה","אייסברג גלידות","אייסברג הרצליה","אייסברג חולון","אייסברג חיפה","אייסברג טבריה","אייסברג ירושלים","אייסברג כפר סבא","אייסברג כרמיאל","אייסברג לוד","אייסברג מודיעין","אייסברג נס ציונה","אייסברג נצרת","אייסברג פתח תקווה","אייסברג רחובות","אייסברג רמלה","אייסברג רמת גן","אייסברג רעננה","אייסברג תל אביב","אנדרסון","אקסל ארטיק","אקסל פירות יער","אקסל קרטיב","ארקטיקה אילת","ארקטיקה אשדוד","ארקטיקה אשקלון","ארקטיקה באר שבע","ארקטיקה בת ים","ארקטיקה גבעתיים","ארקטיקה הדרום","ארקטיקה הצפון","ארקטיקה הרצליה","ארקטיקה חולון","ארקטיקה חיפה","ארקטיקה טבריה","ארקטיקה ירושלים","ארקטיקה כפר סבא","ארקטיקה כרמיאל","ארקטיקה לוד","ארקטיקה מודיעין","ארקטיקה נס ציונה","ארקטיקה נצרת","ארקטיקה פתח תקווה","ארקטיקה רחובות","ארקטיקה רמלה","ארקטיקה רמת גן","ארקטיקה רעננה","ארקטיקה תל אביב","באסקין רובינס","באסקין רובינס אילת","באסקין רובינס אשדוד","באסקין רובינס אשקלון","באסקין רובינס באר שבע","באסקין רובינס בת ים","באסקין רובינס גבעתיים","באסקין רובינס הרצליה","באסקין רובינס חולון","באסקין רובינס חיפה","באסקין רובינס טבריה","באסקין רובינס ירושלים","באסקין רובינס כפר סבא","באסקין רובינס כרמיאל","באסקין רובינס לוד","באסקין רובינס מודיעין","באסקין רובינס נס ציונה","באסקין רובינס נצרת","באסקין רובינס פתח תקווה","באסקין רובינס רחובות","באסקין רובינס רמלה","באסקין רובינס רמת גן","באסקין רובינס רעננה","באסקין רובינס תל אביב","ביג גלידה","ג'לטו","ג'לטו אילת","ג'לטו אשדוד","ג'לטו אשקלון","ג'לטו באר שבע","ג'לטו בת ים","ג'לטו גבעתיים","ג'לטו הרצליה","ג'לטו חולון","ג'לטו חיפה","ג'לטו טבריה","ג'לטו ירושלים","ג'לטו כפר סבא","ג'לטו כרמיאל","ג'לטו לוד","ג'לטו מודיעין","ג'לטו נס ציונה","ג'לטו נצרת","ג'לטו פתח תקווה","ג'לטו רחובות","ג'לטו רמלה","ג'לטו רמת גן","ג'לטו רעננה","ג'לטו תל אביב","גלידה אדומה","גלידה אדומה אילת","גלידה אדומה אשדוד","גלידה אדומה אשקלון","גלידה אדומה באר שבע","גלידה אדומה בת ים","גלידה אדומה גבעתיים","גלידה אדומה הדרום","גלידה אדומה הצפון","גלידה אדומה הרצליה","גלידה אדומה חולון","גלידה אדומה חיפה","גלידה אדומה טבריה","גלידה אדומה ירושלים","גלידה אדומה כפר סבא","גלידה אדומה כרמיאל","גלידה אדומה לוד","גלידה אדומה מודיעין","גלידה אדומה נס ציונה","גלידה אדומה נצרת","גלידה אדומה פתח תקווה","גלידה אדומה רחובות","גלידה אדומה רמלה","גלידה אדומה רמת גן","גלידה אדומה רעננה","גלידה אדומה תל אביב","גלידה אופן","גלידה אופנת","גלידת אלדו","גלידת אלדו אילת","גלידת אלדו אשדוד","גלידת אלדו אשקלון","גלידת אלדו באר שבע","גלידת אלדו בת ים","גלידת אלדו גבעתיים","גלידת אלדו הרצליה","גלידת אלדו חולון","גלידת אלדו חיפה","גלידת אלדו טבריה","גלידת אלדו ירושלים","גלידת אלדו כפר סבא","גלידת אלדו כרמיאל","גלידת אלדו לוד","גלידת אלדו מודיעין","גלידת אלדו נס ציונה","גלידת אלדו נצרת","גלידת אלדו פתח תקווה","גלידת אלדו רחובות","גלידת אלדו רמלה","גלידת אלדו רמת גן","גלידת אלדו רעננה","גלידת אלדו תל אביב","האגן דאז","האגן דאז אילת","האגן דאז אשדוד","האגן דאז אשקלון","האגן דאז באר שבע","האגן דאז בת ים","האגן דאז גבעתיים","האגן דאז הרצליה","האגן דאז חולון","האגן דאז חיפה","האגן דאז טבריה","האגן דאז ירושלים","האגן דאז כפר סבא","האגן דאז כרמיאל","האגן דאז לוד","האגן דאז מודיעין","האגן דאז נס ציונה","האגן דאז נצרת","האגן דאז פתח תקווה","האגן דאז רחובות","האגן דאז רמלה","האגן דאז רמת גן","האגן דאז רעננה","האגן דאז תל אביב","וונילה ספיישל","ויטמן","וניל ושמיים","וניל ושמיים אילת","וניל ושמיים אשדוד","וניל ושמיים אשקלון","וניל ושמיים באר שבע","וניל ושמיים בת ים","וניל ושמיים גבעתיים","וניל ושמיים הרצליה","וניל ושמיים חולון","וניל ושמיים חיפה","וניל ושמיים טבריה","וניל ושמיים ירושלים","וניל ושמיים כפר סבא","וניל ושמיים כרמיאל","וניל ושמיים לוד","וניל ושמיים מודיעין","וניל ושמיים נס ציונה","וניל ושמיים נצרת","וניל ושמיים פתח תקווה","וניל ושמיים רחובות","וניל ושמיים רמלה","וניל ושמיים רמת גן","וניל ושמיים רעננה","וניל ושמיים תל אביב","טאמי 4 גלידה","יוגוברי","לטו אילת","לטו אשקלון","לטו בת ים","לטו הרצליה","לטו חיפה","לטו ירושלים","לטו כרמיאל","לטו מודיעין","לטו נצרת","לטו רחובות","לטו רמת גן","לטו תל אביב","מגנום","מילקי שייק","מנדריאן","מרציפן","סורבה","סורבה אילת","סורבה אשדוד","סורבה אשקלון","סורבה באר שבע","סורבה בת ים","סורבה גבעתיים","סורבה הרצליה","סורבה חולון","סורבה חיפה","סורבה טבריה","סורבה ירושלים","סורבה כפר סבא","סורבה כרמיאל","סורבה לוד","סורבה מודיעין","סורבה נס ציונה","סורבה נצרת","סורבה פתח תקווה","סורבה רחובות","סורבה רמלה","סורבה רמת גן","סורבה רעננה","סורבה תל אביב","סטרבקס פראפוצ'ינו","סטרבקס פראפוצ\\","סנטה גלידה","ספיישל גלידה","ספיישל קרטיב","סתם גלידה","סתם גלידה חיפה","סתם גלידה ירושלים","סתם גלידה תל אביב","פדה גלידה","פרוייו","תנובה גלידה"],"category":"אוכל","subcategory":"אוכל בחוץ — גלידה"},
  {"keywords":["bar","barbaron","beer 13","beer shave","d bar","imperial cocktail","jam bar","jimmy jimmy","klub","kuli alma","mike's place","mike\\","molly bloom","pargitha","pub","shtetl","speakeasy","stocks bar","tap","whisky bar","אבדוס","אבדוס אילת","אבדוס אשדוד","אבדוס אשקלון","אבדוס באר שבע","אבדוס בר","אבדוס בת ים","אבדוס גבעתיים","אבדוס הרצליה","אבדוס חולון","אבדוס חיפה","אבדוס טבריה","אבדוס ירושלים","אבדוס כפר סבא","אבדוס כרמיאל","אבדוס לוד","אבדוס מודיעין","אבדוס נס ציונה","אבדוס נצרת","אבדוס פתח תקווה","אבדוס רחובות","אבדוס רמלה","אבדוס רמת גן","אבדוס רעננה","אבדוס תל אביב","אילקה בר","אימפריאל קוקטייל","באר 13","באר אנד באר","באר אנד באר אילת","באר אנד באר אשדוד","באר אנד באר אשקלון","באר אנד באר באר שבע","באר אנד באר בת ים","באר אנד באר גבעתיים","באר אנד באר הרצליה","באר אנד באר חולון","באר אנד באר חיפה","באר אנד באר טבריה","באר אנד באר ירושלים","באר אנד באר כפר סבא","באר אנד באר כרמיאל","באר אנד באר לוד","באר אנד באר מודיעין","באר אנד באר נס ציונה","באר אנד באר נצרת","באר אנד באר פתח תקווה","באר אנד באר רחובות","באר אנד באר רמלה","באר אנד באר רמת גן","באר אנד באר רעננה","באר אנד באר תל אביב","באר הדרום","באר הים","באר הירדן","באר הכרם","באר העתיק","באר הצפון","באר שבע","באר שבע בר","באר שווה","בייגלה בר","בייגלה בר אילת","בייגלה בר אשדוד","בייגלה בר אשקלון","בייגלה בר באר שבע","בייגלה בר בת ים","בייגלה בר גבעתיים","בייגלה בר הדרום","בייגלה בר הצפון","בייגלה בר הרצליה","בייגלה בר חולון","בייגלה בר חיפה","בייגלה בר טבריה","בייגלה בר ירושלים","בייגלה בר כפר סבא","בייגלה בר כרמיאל","בייגלה בר לוד","בייגלה בר מודיעין","בייגלה בר נס ציונה","בייגלה בר נצרת","בייגלה בר פתח תקווה","בייגלה בר רחובות","בייגלה בר רמלה","בייגלה בר רמת גן","בייגלה בר רעננה","בייגלה בר תל אביב","ברברון","ג'ימי ג'ימי","ג'ם בר","די בר","די בר חיפה","די בר ירושלים","די בר תל אביב","האחים בר","האחים בר אילת","האחים בר אשדוד","האחים בר אשקלון","האחים בר באר שבע","האחים בר בת ים","האחים בר גבעתיים","האחים בר הרצליה","האחים בר חולון","האחים בר חיפה","האחים בר טבריה","האחים בר ירושלים","האחים בר כפר סבא","האחים בר כרמיאל","האחים בר לוד","האחים בר מודיעין","האחים בר נס ציונה","האחים בר נצרת","האחים בר פתח תקווה","האחים בר רחובות","האחים בר רמלה","האחים בר רמת גן","האחים בר רעננה","האחים בר תל אביב","הסטרבק","הסטרבק ירושלים","הסטרבק תל אביב","וויסקי בר","וויסקי בר 76","וויסקי בר אילת","וויסקי בר אשדוד","וויסקי בר אשקלון","וויסקי בר באר שבע","וויסקי בר בת ים","וויסקי בר גבעתיים","וויסקי בר הרצליה","וויסקי בר חולון","וויסקי בר חיפה","וויסקי בר טבריה","וויסקי בר ירושלים","וויסקי בר כפר סבא","וויסקי בר כרמיאל","וויסקי בר לוד","וויסקי בר מודיעין","וויסקי בר נס ציונה","וויסקי בר נצרת","וויסקי בר פתח תקווה","וויסקי בר רחובות","וויסקי בר רמלה","וויסקי בר רמת גן","וויסקי בר רעננה","וויסקי בר תל אביב","טאפ","טאפ אילת","טאפ אנטר","טאפ אשדוד","טאפ אשקלון","טאפ באר שבע","טאפ בר","טאפ בת ים","טאפ גבעתיים","טאפ הברונים","טאפ הדרום","טאפ הצפון","טאפ הרצליה","טאפ חולון","טאפ חיפה","טאפ טבריה","טאפ ירושלים","טאפ כפר סבא","טאפ כרמיאל","טאפ לוד","טאפ מודיעין","טאפ נס ציונה","טאפ נצרת","טאפ פתח תקווה","טאפ רחובות","טאפ רמלה","טאפ רמת גן","טאפ רעננה","טאפ תל אביב","טוסט באר","טוסט באר אילת","טוסט באר אשדוד","טוסט באר אשקלון","טוסט באר באר שבע","טוסט באר בת ים","טוסט באר גבעתיים","טוסט באר הרצליה","טוסט באר חולון","טוסט באר חיפה","טוסט באר טבריה","טוסט באר ירושלים","טוסט באר כפר סבא","טוסט באר כרמיאל","טוסט באר לוד","טוסט באר מודיעין","טוסט באר נס ציונה","טוסט באר נצרת","טוסט באר פתח תקווה","טוסט באר רחובות","טוסט באר רמלה","טוסט באר רמת גן","טוסט באר רעננה","טוסט באר תל אביב","ימי ג\\","ם בר","מולי בלום","מועדון לילה","מועדון לילה אילת","מועדון לילה אשדוד","מועדון לילה אשקלון","מועדון לילה באר שבע","מועדון לילה בת ים","מועדון לילה גבעתיים","מועדון לילה הרצליה","מועדון לילה חולון","מועדון לילה חיפה","מועדון לילה טבריה","מועדון לילה ירושלים","מועדון לילה כפר סבא","מועדון לילה כרמיאל","מועדון לילה לוד","מועדון לילה מודיעין","מועדון לילה נס ציונה","מועדון לילה נצרת","מועדון לילה פתח תקווה","מועדון לילה רחובות","מועדון לילה רמלה","מועדון לילה רמת גן","מועדון לילה רעננה","מועדון לילה תל אביב","מועדון רוטשילד","מועדון רוטשילד אילת","מועדון רוטשילד אשדוד","מועדון רוטשילד אשקלון","מועדון רוטשילד באר שבע","מועדון רוטשילד בת ים","מועדון רוטשילד גבעתיים","מועדון רוטשילד הדרום","מועדון רוטשילד הצפון","מועדון רוטשילד הרצליה","מועדון רוטשילד חולון","מועדון רוטשילד חיפה","מועדון רוטשילד טבריה","מועדון רוטשילד ירושלים","מועדון רוטשילד כפר סבא","מועדון רוטשילד כרמיאל","מועדון רוטשילד לוד","מועדון רוטשילד מודיעין","מועדון רוטשילד נס ציונה","מועדון רוטשילד נצרת","מועדון רוטשילד פתח תקווה","מועדון רוטשילד רחובות","מועדון רוטשילד רמלה","מועדון רוטשילד רמת גן","מועדון רוטשילד רעננה","מועדון רוטשילד תל אביב","מועדון תיאטרון","מייק פלייס","מייק'ס פלייס","מייק\\","סטוקס","סלינה בר","סלינה בר חיפה","סלינה בר ירושלים","סלינה בר תל אביב","ספיק איזי","ספיק איזי בר","ספיק איזי חיפה","ספיק איזי ירושלים","ספיק איזי תל אביב","פאב","פאב 10","פאב 100","פאב 1000","פאב 1001","פאב 1002","פאב 1003","פאב 1004","פאב 101","פאב 1010","פאב 105","פאב 1099","פאב 11","פאב 110","פאב 111","פאב 12","פאב 123","פאב 196","פאב 200","פאב 21","פאב 22","פאב 23","פאב 24","פאב 24/7","פאב 247","פאב 28","פאב 29","פאב 3","פאב 30","פאב 300","פאב 33","פאב 35","פאב 36","פאב 365","פאב 37","פאב 38","פאב 39","פאב 40","פאב 400","פאב 41","פאב 42","פאב 43","פאב 44","פאב 45","פאב 47","פאב 48","פאב 49","פאב 5","פאב 50","פאב 500","פאב 55","פאב 56","פאב 57","פאב 58","פאב 59","פאב 60","פאב 600","פאב 61","פאב 65","פאב 66","פאב 67","פאב 68","פאב 69","פאב 7","פאב 70","פאב 700","פאב 71","פאב 72","פאב 73","פאב 74","פאב 75","פאב 80","פאב 800","פאב 81","פאב 82","פאב 83","פאב 84","פאב 85","פאב 87","פאב 88","פאב 89","פאב 9","פאב 900","פאב 91","פאב 92","פאב 95","פאב 96","פאב 97","פאב 98","פאב 99","פאב גליל","פאב גלעד","פאב הבוץ","פאב הברד","פאב הברדס","פאב הברונים","פאב הברונים אילת","פאב הברונים אשדוד","פאב הברונים אשקלון","פאב הברונים באר שבע","פאב הברונים בת ים","פאב הברונים גבעתיים","פאב הברונים הדרום","פאב הברונים הצפון","פאב הברונים הרצליה","פאב הברונים חולון","פאב הברונים חיפה","פאב הברונים טבריה","פאב הברונים ירושלים","פאב הברונים כפר סבא","פאב הברונים כרמיאל","פאב הברונים לוד","פאב הברונים מודיעין","פאב הברונים נס ציונה","פאב הברונים נצרת","פאב הברונים פתח תקווה","פאב הברונים רחובות","פאב הברונים רמלה","פאב הברונים רמת גן","פאב הברונים רעננה","פאב הברונים תל אביב","פאב הגרז'","פאב הים","פאב היס","פאב היקב","פאב הירדן","פאב הכפר","פאב הכרם","פאב המקדם","פאב המקדם אילת","פאב המקדם אשדוד","פאב המקדם אשקלון","פאב המקדם באר שבע","פאב המקדם בת ים","פאב המקדם גבעתיים","פאב המקדם הדרום","פאב המקדם הצפון","פאב המקדם הרצליה","פאב המקדם חולון","פאב המקדם חיפה","פאב המקדם טבריה","פאב המקדם ירושלים","פאב המקדם כפר סבא","פאב המקדם כרמיאל","פאב המקדם לוד","פאב המקדם מודיעין","פאב המקדם נס ציונה","פאב המקדם נצרת","פאב המקדם פתח תקווה","פאב המקדם רחובות","פאב המקדם רמלה","פאב המקדם רמת גן","פאב המקדם רעננה","פאב המקדם תל אביב","פאב המרכז","פאב המרכז אילת","פאב המרכז אשדוד","פאב המרכז אשקלון","פאב המרכז באר שבע","פאב המרכז בת ים","פאב המרכז גבעתיים","פאב המרכז הרצליה","פאב המרכז חולון","פאב המרכז חיפה","פאב המרכז טבריה","פאב המרכז ירושלים","פאב המרכז כפר סבא","פאב המרכז כרמיאל","פאב המרכז לוד","פאב המרכז מודיעין","פאב המרכז נס ציונה","פאב המרכז נצרת","פאב המרכז פתח תקווה","פאב המרכז רחובות","פאב המרכז רמלה","פאב המרכז רמת גן","פאב המרכז רעננה","פאב המרכז תל אביב","פאב הסולטן","פאב הסולטנא","פאב הסולטני","פאב הסולטנס","פאב הסטרבק","פאב הסירה","פאב הסירה אילת","פאב הסירה אשדוד","פאב הסירה אשקלון","פאב הסירה באר שבע","פאב הסירה בת ים","פאב הסירה גבעתיים","פאב הסירה הרצליה","פאב הסירה חולון","פאב הסירה חיפה","פאב הסירה טבריה","פאב הסירה ירושלים","פאב הסירה כפר סבא","פאב הסירה כרמיאל","פאב הסירה לוד","פאב הסירה מודיעין","פאב הסירה נס ציונה","פאב הסירה נצרת","פאב הסירה פתח תקווה","פאב הסירה רחביה","פאב הסירה רחובות","פאב הסירה רמלה","פאב הסירה רמת גן","פאב הסירה רעננה","פאב הסירה תל אביב","פאב הצוללים","פאב הצפון","פאב מגנום","פאב מגנום חיפה","פאב מגנום ירושלים","פאב מגנום תל אביב","פאר בר","פאר בר אילת","פאר בר אשדוד","פאר בר אשקלון","פאר בר באר שבע","פאר בר בת ים","פאר בר גבעתיים","פאר בר הדרום","פאר בר הצפון","פאר בר הרצליה","פאר בר חולון","פאר בר חיפה","פאר בר טבריה","פאר בר ירושלים","פאר בר כפר סבא","פאר בר כרמיאל","פאר בר לוד","פאר בר מודיעין","פאר בר נס ציונה","פאר בר נצרת","פאר בר פתח תקווה","פאר בר רחובות","פאר בר רמלה","פאר בר רמת גן","פאר בר רעננה","פאר בר תל אביב","פבים סופי","פרגיתה אילת","פרגיתה אשדוד","פרגיתה אשקלון","פרגיתה באר שבע","פרגיתה בת ים","פרגיתה גבעתיים","פרגיתה הדרום","פרגיתה הצפון","פרגיתה הרצליה","פרגיתה חולון","פרגיתה חיפה","פרגיתה טבריה","פרגיתה ירושלים","פרגיתה כפר סבא","פרגיתה כרמיאל","פרגיתה לוד","פרגיתה מודיעין","פרגיתה נס ציונה","פרגיתה נצרת","פרגיתה פתח תקווה","פרגיתה רחובות","פרגיתה רמלה","פרגיתה רמת גן","פרגיתה רעננה","פרגיתה תל אביב","קולי אלמא","קלאב","קלאב 10","קלאב 100","קלאב 11","קלאב 12","קלאב 13","קלאב 14","קלאב 15","קלאב 16","קלאב 17","קלאב 18","קלאב 19","קלאב 20","קלאב 21","קלאב 22","קלאב 23","קלאב 24","קלאב 25","קלאב 26","קלאב 27","קלאב 28","קלאב 29","קלאב 3","קלאב 30","קלאב 31","קלאב 32","קלאב 33","קלאב 34","קלאב 35","קלאב 36","קלאב 37","קלאב 38","קלאב 39","קלאב 4","קלאב 40","קלאב 41","קלאב 42","קלאב 43","קלאב 44","קלאב 45","קלאב 46","קלאב 47","קלאב 48","קלאב 49","קלאב 5","קלאב 50","קלאב 51","קלאב 55","קלאב 56","קלאב 57","קלאב 58","קלאב 59","קלאב 6","קלאב 60","קלאב 61","קלאב 62","קלאב 63","קלאב 64","קלאב 65","קלאב 66","קלאב 67","קלאב 68","קלאב 69","קלאב 7","קלאב 70","קלאב 71","קלאב 72","קלאב 73","קלאב 74","קלאב 75","קלאב 76","קלאב 77","קלאב 78","קלאב 79","קלאב 8","קלאב 80","קלאב 81","קלאב 82","קלאב 83","קלאב 84","קלאב 85","קלאב 86","קלאב 87","קלאב 88","קלאב 89","קלאב 9","קלאב 90","קלאב 91","קלאב 92","קלאב 93","קלאב 94","קלאב 95","קלאב 96","קלאב 97","קלאב 98","קלאב 99","קלאב אילת","קלאב אשדוד","קלאב אשקלון","קלאב באר שבע","קלאב בלייז","קלאב בת ים","קלאב גבעתיים","קלאב הדרום","קלאב הצפון","קלאב הרצליה","קלאב חולון","קלאב חיפה","קלאב טבריה","קלאב ירושלים","קלאב כפר סבא","קלאב כרמיאל","קלאב לוד","קלאב מודיעין","קלאב נס ציונה","קלאב נצרת","קלאב פתח תקווה","קלאב רחובות","קלאב רמלה","קלאב רמת גן","קלאב רעננה","קלאב תל אביב","שטעטל","שטעטל אילת","שטעטל אשדוד","שטעטל אשקלון","שטעטל באר שבע","שטעטל בר","שטעטל בת ים","שטעטל גבעתיים","שטעטל הדרום","שטעטל הצפון","שטעטל הרצליה","שטעטל חולון","שטעטל חיפה","שטעטל טבריה","שטעטל ירושלים","שטעטל כפר סבא","שטעטל כרמיאל","שטעטל לוד","שטעטל מודיעין","שטעטל נס ציונה","שטעטל נצרת","שטעטל פתח תקווה","שטעטל רחובות","שטעטל רמלה","שטעטל רמת גן","שטעטל רעננה","שטעטל תל אביב"],"category":"אוכל","subcategory":"אוכל בחוץ — פאבים וברים"},
  {"keywords":["10bis at work","10bis premium","buyme dine","buyme eat","buyme food","cibus business","deliveroo","delivery israel","easybites","feet food","fit food","fitfood","get food","gett food","ghost kitchen","glovo","havilati","honest food","mishloha","moto food","pick quick","pickup food","rappi","uber eats","vmoney","vmoney food","wolt business","wolt drive","wolt market","wolt plus","wolt+","אפליקציית אוכל","אפליקציית מסעדה","אפליקציית משלוח","גט פוד","המסעדה הוירטואלית","וולט מרקט","ולט מנוי","ולט עסקי","חבילתי","מוטו פוד","מטבח רפאים","מטבח שיתופי","מילתא","מישלוחה","מסעדה וירטואלית","משלוחים ישראל","סיבוס תאגידי","סלקום וולט","פייט פוד","פיק קוויק","פרידום פיינסט","תווי 10bis","תווי אוכל","תווי וולט","תווי מסעדה","תווי מתנה","תווי סיבוס","תווי קניה","תווי שי","תווי תן ביס","תן ביס פלוס"],"category":"אוכל","subcategory":"אוכל בחוץ — אפליקציות משלוח"},
  {"keywords":["benoit","frenchy","g'an","klara","moshik roth","north abraxas","tatin","tehina","the brasserie","wolfstock","yaffo tel aviv","אברקסס","אורנה ואלה","אייל שני","אסף גרניט","ארז קומורובסקי","ברסרי תל אביב","ג'אן","הלובי","וולפסטוק","חיים כהן","טחינה מסעדה","טמפלין","יפו תל אביב","ישראל אהרוני","מסעדת אדומה","מסעדת אדומה חיפה","מסעדת אדומה ירושלים","מסעדת אדומה תל אביב","מסעדת אוצר","מסעדת אוצר חיפה","מסעדת אוצר ירושלים","מסעדת אוצר תל אביב","מסעדת אורנה","מסעדת אורנה ואלה","מסעדת אורקה","מסעדת אייל שני","מסעדת אסף גרניט","מסעדת ארז קומורובסקי","מסעדת ארטיק","מסעדת בן-יוסף","מסעדת בנואה","מסעדת הנמל","מסעדת הנמל אילת","מסעדת הנמל אשדוד","מסעדת הנמל אשקלון","מסעדת הנמל באר שבע","מסעדת הנמל חיפה","מסעדת הנמל יפו","מסעדת הנמל תל אביב","מסעדת ויקטור גלוגר","מסעדת חבית","מסעדת חיים כהן","מסעדת חצי","מסעדת חצי חיפה","מסעדת חצי ירושלים","מסעדת חצי כלי","מסעדת חצי תל אביב","מסעדת טמפלין","מסעדת ים","מסעדת ים אילת","מסעדת ים הרצליה","מסעדת ים חיפה","מסעדת ים ירושלים","מסעדת ים נמל","מסעדת ים נתניה","מסעדת ים תל אביב","מסעדת ירמיהו אוקיינוס","מסעדת ישראל אהרוני","מסעדת לונה","מסעדת לונה רוסה","מסעדת לונה רוסה חיפה","מסעדת לונה רוסה ירושלים","מסעדת לונה רוסה תל אביב","מסעדת מנשה","מסעדת ערב","מסעדת ערב הצפון","מסעדת ערב חיפה","מסעדת ערב ירושלים","מסעדת ערב רעננה","מסעדת ערב תל אביב","מסעדת קונדיטוריה","מסעדת קופי","מסעדת קזה","מסעדת קיוסק","מסעדת קייקס תל אביב","מסעדת קלרה","מסעדת קסטל","מסעדת קסטל הצפון","מסעדת קסטל חיפה","מסעדת קסטל ירושלים","מסעדת קסטל רעננה","מסעדת קסטל תל אביב","מסעדת קפה אבן עזר","מסעדת קפה אבן עזרא","מסעדת רוזה","מסעדת רוזה חיפה","מסעדת רוזה ירושלים","מסעדת רוזה תל אביב","מסעדת רומולוס","מסעדת רומולוס חיפה","מסעדת רומולוס ירושלים","מסעדת רומולוס תל אביב","מסעדת רפי כהן","משיק רוט","סנטוריה","סנטוריה תל אביב","פרון","רפי כהן","תאטין"],"category":"אוכל","subcategory":"אוכל בחוץ — מסעדות שף וגורמה"},
  {"keywords":["agi bakery","agi cafe","אגי בייקרי","אגי קפה","אגי קפה אילת","אגי קפה אשדוד","אגי קפה אשקלון","אגי קפה באר שבע","אגי קפה בת ים","אגי קפה גבעתיים","אגי קפה הדרום","אגי קפה הצפון","אגי קפה הרצליה","אגי קפה חולון","אגי קפה חיפה","אגי קפה טבריה","אגי קפה ירושלים","אגי קפה כפר סבא","אגי קפה כרמיאל","אגי קפה לוד","אגי קפה מודיעין","אגי קפה נס ציונה","אגי קפה נצרת","אגי קפה פתח תקווה","אגי קפה רחובות","אגי קפה רמלה","אגי קפה רמת גן","אגי קפה רעננה","אגי קפה תל אביב","ארוחת בוקר","ארוחת בוקר ישראלית","בוקר אביב","בוקר אגדי","בוקר אדומה","בוקר אורי","בוקר אילון","בוקר אילן","בוקר אילנה","בוקר אילנס","בוקר אילת","בוקר אילת חוף","בוקר אסי","בוקר אסיה","בוקר אסם","בוקר אספרסו","בוקר אספרסו אילת","בוקר אספרסו אשדוד","בוקר אספרסו אשקלון","בוקר אספרסו באר שבע","בוקר אספרסו בר","בוקר אספרסו בת ים","בוקר אספרסו גבעתיים","בוקר אספרסו הדרום","בוקר אספרסו הצפון","בוקר אספרסו הרצליה","בוקר אספרסו חולון","בוקר אספרסו חיפה","בוקר אספרסו טבריה","בוקר אספרסו ירושלים","בוקר אספרסו כפר סבא","בוקר אספרסו כרמיאל","בוקר אספרסו לוד","בוקר אספרסו מודיעין","בוקר אספרסו נס ציונה","בוקר אספרסו נצרת","בוקר אספרסו פתח תקווה","בוקר אספרסו רוטשילד","בוקר אספרסו רחובות","בוקר אספרסו רמלה","בוקר אספרסו רמת גן","בוקר אספרסו רעננה","בוקר אספרסו תל אביב","בוקר אקדמי","בוקר אקדמיה","בוקר אקוורד","בוקר טוב","בנדיקט אילת","בנדיקט גבעתיים","בנדיקט הרצליה","בנדיקט חיפה","בנדיקט ירושלים","בנדיקט נמל","בנדיקט פתח תקווה","בנדיקט רעננה","בנדיקט תל אביב","מסעדת בוקר","מסעדת בנדיקט","מסעדת בנדיקט אילת","מסעדת בנדיקט גבעתיים","מסעדת בנדיקט הרצליה","מסעדת בנדיקט חיפה","מסעדת בנדיקט ירושלים","מסעדת בנדיקט נמל","מסעדת בנדיקט פתח תקווה","מסעדת בנדיקט רעננה","מסעדת בנדיקט תל אביב","פתיחה בוקר"],"category":"אוכל","subcategory":"אוכל בחוץ — מסעדות בוקר"},
  {"keywords":["bamba","bisli","buenos","elite","elite chocolate","kinder","kiosk","kit kat","klik","lion","mars","mei eden","mentos","milka","neviot","orbit","psik zman","snickers","soda stream","spring","take away","take out","tapuzina","tivol","toffee","trident","tropikal","twix","אבוקדו","אבטיח","אגוז","אגוז מתוקים","אגוזי שוק","אסם חטיפים","בואנו","בוקסת מזון","ביסלי","במבה","וופל","וופל וופל","ויסקי קוקה","חטיף עלית","חטיף קליקס","טבעולים","טוויקס","טופוטוף","טופוטוף אילת","טופוטוף אשדוד","טופוטוף אשקלון","טופוטוף באר שבע","טופוטוף בת ים","טופוטוף גבעתיים","טופוטוף הדרום","טופוטוף הצפון","טופוטוף הרצליה","טופוטוף השוק","טופוטוף השוק אילת","טופוטוף השוק אשדוד","טופוטוף השוק אשקלון","טופוטוף השוק באר שבע","טופוטוף השוק בת ים","טופוטוף השוק גבעתיים","טופוטוף השוק הדרום","טופוטוף השוק הצפון","טופוטוף השוק הרצליה","טופוטוף השוק חולון","טופוטוף השוק חיפה","טופוטוף השוק טבריה","טופוטוף השוק ירושלים","טופוטוף השוק כפר סבא","טופוטוף השוק כרמיאל","טופוטוף השוק לוד","טופוטוף השוק מודיעין","טופוטוף השוק נס ציונה","טופוטוף השוק נצרת","טופוטוף השוק פתח תקווה","טופוטוף השוק רחובות","טופוטוף השוק רמלה","טופוטוף השוק רמת גן","טופוטוף השוק רעננה","טופוטוף השוק תל אביב","טופוטוף חולון","טופוטוף חיפה","טופוטוף טבריה","טופוטוף ירושלים","טופוטוף כפר סבא","טופוטוף כרמיאל","טופוטוף לוד","טופוטוף מודיעין","טופוטוף נס ציונה","טופוטוף נצרת","טופוטוף פתח תקווה","טופוטוף רחובות","טופוטוף רמלה","טופוטוף רמת גן","טופוטוף רעננה","טופוטוף תל אביב","טופי","טייק אווי","טייק אוט","טעמן עלית","טרופיק","טרופיק שייק","טרופיקל","טריידנט","ליון","מאכלים מוכנים","מארס","מבשל","מבשל אישי","מבשל ביתי","מבשל גורמה","מבשל השף","מטה זהב","מי עדן","מילקה","מים מים","מים מינרליים","מכולת","מכולת אילת","מכולת אשדוד","מכולת אשקלון","מכולת באר שבע","מכולת בת ים","מכולת גבעתיים","מכולת הדרום","מכולת הצפון","מכולת הרצליה","מכולת הרצליה פיתוח","מכולת השוק","מכולת השוק חיפה","מכולת השוק ירושלים","מכולת השוק רעננה","מכולת השוק תל אביב","מכולת השכונה","מכולת חולון","מכולת חיפה","מכולת טבריה","מכולת ירושלים","מכולת ירמיהו","מכולת ירמיהו חיפה","מכולת ירמיהו ירושלים","מכולת ירמיהו תל אביב","מכולת כפר סבא","מכולת כרמיאל","מכולת לוד","מכולת מודיעין","מכולת נס ציונה","מכולת נצרת","מכולת פתח תקווה","מכולת רחביה","מכולת רחובות","מכולת רמלה","מכולת רמת גן","מכולת רעננה","מכולת תל אביב","מנטוס","מסטיק אורביט","מסטיק מנטוס","מצרפטינו","מקופלת","מקופלת אילת","מקופלת אשדוד","מקופלת אשקלון","מקופלת באר שבע","מקופלת בת ים","מקופלת גבעתיים","מקופלת הדרום","מקופלת הצפון","מקופלת הרצליה","מקופלת חולון","מקופלת חיפה","מקופלת טבריה","מקופלת ירושלים","מקופלת כפר סבא","מקופלת כרמיאל","מקופלת לוד","מקופלת מודיעין","מקופלת נס ציונה","מקופלת נצרת","מקופלת פתח תקווה","מקופלת רחובות","מקופלת רמלה","מקופלת רמת גן","מקופלת רעננה","מקופלת תל אביב","נביעות","סדק חטיף","סודה סטרים מתקן","סניקרס","סעודה תיבול","ספלגטי טריו","ספרינג","ספרינג מים","ספרינג מתוקים","ספרינג סודה","עלית","עלית טעמן","עלית מטעמים","ענבים שוק","פיצוחים","פיצוחים אילת","פיצוחים אשדוד","פיצוחים אשקלון","פיצוחים באר שבע","פיצוחים בת ים","פיצוחים גבעתיים","פיצוחים הרצליה","פיצוחים השוק","פיצוחים השוק אילת","פיצוחים השוק אשדוד","פיצוחים השוק אשקלון","פיצוחים השוק באר שבע","פיצוחים השוק בת ים","פיצוחים השוק גבעתיים","פיצוחים השוק הדרום","פיצוחים השוק הצפון","פיצוחים השוק הרצליה","פיצוחים השוק חולון","פיצוחים השוק חיפה","פיצוחים השוק טבריה","פיצוחים השוק ירושלים","פיצוחים השוק כפר סבא","פיצוחים השוק כרמיאל","פיצוחים השוק לוד","פיצוחים השוק מודיעין","פיצוחים השוק נס ציונה","פיצוחים השוק נצרת","פיצוחים השוק פתח תקווה","פיצוחים השוק רחובות","פיצוחים השוק רמלה","פיצוחים השוק רמת גן","פיצוחים השוק רעננה","פיצוחים השוק תל אביב","פיצוחים חולון","פיצוחים חיפה","פיצוחים טבריה","פיצוחים ירושלים","פיצוחים כפר סבא","פיצוחים כרמיאל","פיצוחים לוד","פיצוחים מודיעין","פיצוחים נס ציונה","פיצוחים נצרת","פיצוחים פתח תקווה","פיצוחים רחובות","פיצוחים רמלה","פיצוחים רמת גן","פיצוחים רעננה","פיצוחים תל אביב","פיצוציה","פיצוציה אילת","פיצוציה אשדוד","פיצוציה אשקלון","פיצוציה באר שבע","פיצוציה בת ים","פיצוציה גבעתיים","פיצוציה הדרום","פיצוציה הצפון","פיצוציה הרצליה","פיצוציה השוק","פיצוציה השוק אילת","פיצוציה השוק אשדוד","פיצוציה השוק אשקלון","פיצוציה השוק באר שבע","פיצוציה השוק בת ים","פיצוציה השוק גבעתיים","פיצוציה השוק הדרום","פיצוציה השוק הצפון","פיצוציה השוק הרצליה","פיצוציה השוק חולון","פיצוציה השוק חיפה","פיצוציה השוק טבריה","פיצוציה השוק ירושלים","פיצוציה השוק כפר סבא","פיצוציה השוק כרמיאל","פיצוציה השוק לוד","פיצוציה השוק מודיעין","פיצוציה השוק נס ציונה","פיצוציה השוק נצרת","פיצוציה השוק פתח תקווה","פיצוציה השוק רחובות","פיצוציה השוק רמלה","פיצוציה השוק רמת גן","פיצוציה השוק רעננה","פיצוציה השוק תל אביב","פיצוציה חולון","פיצוציה חיפה","פיצוציה טבריה","פיצוציה ירושלים","פיצוציה כפר סבא","פיצוציה כרמיאל","פיצוציה לוד","פיצוציה מודיעין","פיצוציה נס ציונה","פיצוציה נצרת","פיצוציה פתח תקווה","פיצוציה רחובות","פיצוציה רמלה","פיצוציה רמת גן","פיצוציה רעננה","פיצוציה תל אביב","פסק זמן","פריגת","פריגת ארטיק","קיוסק","קיוסק 24","קיוסק השכונה","קיוסק רוטשילד","קיוסק רוטשילד אילת","קיוסק רוטשילד אשדוד","קיוסק רוטשילד אשקלון","קיוסק רוטשילד באר שבע","קיוסק רוטשילד בת ים","קיוסק רוטשילד גבעתיים","קיוסק רוטשילד הרצליה","קיוסק רוטשילד חולון","קיוסק רוטשילד חיפה","קיוסק רוטשילד טבריה","קיוסק רוטשילד ירושלים","קיוסק רוטשילד כפר סבא","קיוסק רוטשילד כרמיאל","קיוסק רוטשילד לוד","קיוסק רוטשילד מודיעין","קיוסק רוטשילד נס ציונה","קיוסק רוטשילד נצרת","קיוסק רוטשילד פתח תקווה","קיוסק רוטשילד רחובות","קיוסק רוטשילד רמלה","קיוסק רוטשילד רמת גן","קיוסק רוטשילד רעננה","קיוסק רוטשילד תל אביב","קיט קט","קינדר","קליק","קליק חטיפים","תיבול","תיבול עוף","תיבת מזון","תפוזינה"],"category":"אוכל","subcategory":"מזון רחוב / קיוסקים / חטיפים"},
  {"keywords":["argentinian restaurant","armenian restaurant","asado","brazilian restaurant","ceviche","chinese restaurant","churrascaria","ethiopian restaurant","georgian restaurant","german restaurant","habesha","iranian restaurant","italian restaurant","japanese restaurant","kebab","kebabci","khinkali","korean restaurant","mexican restaurant","osteria","persian restaurant","peruvian restaurant","pho","poke","poke bar","poke bowl","poke house","russian restaurant","syrian restaurant","taco","taco bay","taco fiesta","tapas","tehran","thai restaurant","trattoria","tukuls","turkish restaurant","tuscany restaurant","uzbek restaurant","vietnamese restaurant","אוכל תימני","אוסטריה","אסאדו","אריתריאי","אריתריאי דרום תל אביב","אריתריאי תל אביב","בולגרי מסעדה","ג'חנון בית","ג'חנון בר","וראסקריה","ורגיאנית","ח'נקלי","ח'נקלי ירושלים","ח'נקלי תל אביב","חבשה","חבשה מסעדה","חנון בר","טאפס","טאפס אילת","טאפס אשדוד","טאפס אשקלון","טאפס באר שבע","טאפס בר","טאפס בת ים","טאפס גבעתיים","טאפס הרצליה","טאפס חולון","טאפס חיפה","טאפס טבריה","טאפס ירושלים","טאפס כפר סבא","טאפס כרמיאל","טאפס לוד","טאפס מודיעין","טאפס נס ציונה","טאפס נצרת","טאפס פתח תקווה","טאפס רחובות","טאפס רמלה","טאפס רמת גן","טאפס רעננה","טאפס תל אביב","טאקו","טאקו ביי","טאקו פיאסטה","טאקו פיאסטה ירושלים","טאקו פיאסטה תל אביב","טהראן","טהראן מסעדה","טוסקנה","טראטוריה","י הצפון","י ירושלים","כבאבג'י","כבאבג'י הדרום","כבאבג'י הצפון","כבאבג'י חיפה","כבאבג'י ירושלים","כבאבג'י תל אביב","כבאבג\\","כבביה","כבביה אילת","כבביה אשדוד","כבביה אשקלון","כבביה באר שבע","כבביה בת ים","כבביה גבעתיים","כבביה הדרום","כבביה הצפון","כבביה הרצליה","כבביה חולון","כבביה חיפה","כבביה טבריה","כבביה ירושלים","כבביה כפר סבא","כבביה כרמיאל","כבביה לוד","כבביה מודיעין","כבביה נס ציונה","כבביה נצרת","כבביה פתח תקווה","כבביה רחובות","כבביה רמלה","כבביה רמת גן","כבביה רעננה","כבביה תל אביב","כרם תימנים","מסעדה איראנית","מסעדה ארגנטינאית","מסעדה ארמנית","מסעדה ברזילאית","מסעדה ג'ורגיאנית","מסעדה גיאורגית","מסעדה גרמנית","מסעדה הודית","מסעדה וייטנאמית","מסעדה יפנית","מסעדה כורדית","מסעדה כורדית הדרום","מסעדה כורדית הצפון","מסעדה כורדית חיפה","מסעדה כורדית ירושלים","מסעדה כורדית תל אביב","מסעדה לוב","מסעדה לובית","מסעדה לובית הדרום","מסעדה לובית הצפון","מסעדה לובית חיפה","מסעדה לובית ירושלים","מסעדה לובית תל אביב","מסעדה מקסיקנית","מסעדה סורית","מסעדה סינית","מסעדה ספרדית","מסעדה ספרדית הדרום","מסעדה ספרדית הצפון","מסעדה ספרדית חיפה","מסעדה ספרדית ירושלים","מסעדה ספרדית תל אביב","מסעדה עיראקית","מסעדה עיראקית הדרום","מסעדה עיראקית הצפון","מסעדה עיראקית חיפה","מסעדה עיראקית ירושלים","מסעדה עיראקית תל אביב","מסעדה פרואנית","מסעדה פרסית","מסעדה צרפתית","מסעדה צרפתית הדרום","מסעדה צרפתית הצפון","מסעדה צרפתית חיפה","מסעדה צרפתית ירושלים","מסעדה צרפתית תל אביב","מסעדה קוריאנית","מסעדה תוניסאית הדרום","מסעדה תוניסאית הצפון","מסעדה תוניסאית חיפה","מסעדה תוניסאית ירושלים","מסעדה תוניסאית תל אביב","מסעדה תורקית","מסעדה תורקית אילת","מסעדה תורקית אשדוד","מסעדה תורקית אשקלון","מסעדה תורקית באר שבע","מסעדה תורקית בת ים","מסעדה תורקית גבעתיים","מסעדה תורקית הדרום","מסעדה תורקית הצפון","מסעדה תורקית הרצליה","מסעדה תורקית חולון","מסעדה תורקית חיפה","מסעדה תורקית טבריה","מסעדה תורקית ירושלים","מסעדה תורקית כפר סבא","מסעדה תורקית כרמיאל","מסעדה תורקית לוד","מסעדה תורקית מודיעין","מסעדה תורקית נס ציונה","מסעדה תורקית נצרת","מסעדה תורקית פתח תקווה","מסעדה תורקית רחובות","מסעדה תורקית רמלה","מסעדה תורקית רמת גן","מסעדה תורקית רעננה","מסעדה תורקית תל אביב","מסעדת אוזבקית","מסעדת אוקראינה","מסעדת אריתריאית","מסעדת אתיופית","מסעדת בורקס בולגרי","מסעדת הונגריה","מסעדת מולדובה","מסעדת מרוקאית","מסעדת מרוקאית אילת","מסעדת מרוקאית אשדוד","מסעדת מרוקאית אשקלון","מסעדת מרוקאית באר שבע","מסעדת מרוקאית בת ים","מסעדת מרוקאית גבעתיים","מסעדת מרוקאית הדרום","מסעדת מרוקאית הצפון","מסעדת מרוקאית הרצליה","מסעדת מרוקאית חולון","מסעדת מרוקאית חיפה","מסעדת מרוקאית טבריה","מסעדת מרוקאית ירושלים","מסעדת מרוקאית כפר סבא","מסעדת מרוקאית כרמיאל","מסעדת מרוקאית לוד","מסעדת מרוקאית מודיעין","מסעדת מרוקאית נס ציונה","מסעדת מרוקאית נצרת","מסעדת מרוקאית פתח תקווה","מסעדת מרוקאית רחובות","מסעדת מרוקאית רמלה","מסעדת מרוקאית רמת גן","מסעדת מרוקאית רעננה","מסעדת מרוקאית תל אביב","מסעדת קובה","מסעדת רוסית","מסעדת תאי","מסעדת תוניסאית","מסעדת תימנית","מסעדת תימנית אילת","מסעדת תימנית אשדוד","מסעדת תימנית אשקלון","מסעדת תימנית באר שבע","מסעדת תימנית בת ים","מסעדת תימנית גבעתיים","מסעדת תימנית הדרום","מסעדת תימנית הצפון","מסעדת תימנית הרצליה","מסעדת תימנית חולון","מסעדת תימנית חיפה","מסעדת תימנית טבריה","מסעדת תימנית ירושלים","מסעדת תימנית כפר סבא","מסעדת תימנית כרמיאל","מסעדת תימנית לוד","מסעדת תימנית מודיעין","מסעדת תימנית נס ציונה","מסעדת תימנית נצרת","מסעדת תימנית פתח תקווה","מסעדת תימנית רחובות","מסעדת תימנית רמלה","מסעדת תימנית רמת גן","מסעדת תימנית רעננה","מסעדת תימנית תל אביב","ניצנים","נקלי ירושלים","סביצ'ה","סביצ\\","סוריה","פו חיפה","פו ירושלים","פו תל אביב","פוקה","פוקה אילת","פוקה אשדוד","פוקה אשקלון","פוקה באר שבע","פוקה בת ים","פוקה גבעתיים","פוקה הדרום","פוקה הצפון","פוקה הרצליה","פוקה חולון","פוקה חיפה","פוקה טבריה","פוקה ירושלים","פוקה כפר סבא","פוקה כרמיאל","פוקה לוד","פוקה מודיעין","פוקה נס ציונה","פוקה נצרת","פוקה פתח תקווה","פוקה רחובות","פוקה רמלה","פוקה רמת גן","פוקה רעננה","פוקה תל אביב","פרסי","פרסי אילת","פרסי אשדוד","פרסי אשקלון","פרסי באר שבע","פרסי בת ים","פרסי גבעתיים","פרסי הדרום","פרסי הצפון","פרסי הרצליה","פרסי חולון","פרסי חיפה","פרסי טבריה","פרסי ירושלים","פרסי כפר סבא","פרסי כרמיאל","פרסי לוד","פרסי מודיעין","פרסי נס ציונה","פרסי נצרת","פרסי פתח תקווה","פרסי רחובות","פרסי רמלה","פרסי רמת גן","פרסי רעננה","פרסי תל אביב","צ'וראסקריה","ק'בבה","קבבה","קבביה","קובה","תוכלס","תימני בר","תימני בר אילת","תימני בר אשדוד","תימני בר אשקלון","תימני בר באר שבע","תימני בר בת ים","תימני בר גבעתיים","תימני בר הדרום","תימני בר הצפון","תימני בר הרצליה","תימני בר השוק","תימני בר השוק חיפה","תימני בר השוק ירושלים","תימני בר השוק תל אביב","תימני בר חולון","תימני בר חיפה","תימני בר טבריה","תימני בר ירושלים","תימני בר כפר סבא","תימני בר כרמיאל","תימני בר לוד","תימני בר מודיעין","תימני בר נס ציונה","תימני בר נצרת","תימני בר פתח תקווה","תימני בר רחובות","תימני בר רמלה","תימני בר רמת גן","תימני בר רעננה","תימני בר תל אביב"],"category":"אוכל","subcategory":"אוכל בחוץ — אוכל אתני"},
  {"keywords":["מרקט אילת","מרקט אשקלון","מרקט בת ים","מרקט הדרום","מרקט הרצליה","מרקט חיפה","מרקט ירושלים","מרקט כרמיאל","מרקט מודיעין","מרקט נצרת","מרקט רחובות","מרקט רמת גן","מרקט תל אביב","24 7","24/7","24x7","am pm אונליין","am pm אקספרס","am:pm אונליין","ampm online","convenient store","easy shop","express market","expressmarket","fast shop","minit market","mira shop","quick mart","stop and go","super pharm 24","universal","universe shop","yellow boutique","איזי שופ","אקספרס מרקט","ביץ' מרקט","ביץ' מרקט אילת","ביץ' מרקט אשדוד","ביץ' מרקט אשקלון","ביץ' מרקט באר שבע","ביץ' מרקט בת ים","ביץ' מרקט גבעתיים","ביץ' מרקט הדרום","ביץ' מרקט הצפון","ביץ' מרקט הרצליה","ביץ' מרקט חולון","ביץ' מרקט חיפה","ביץ' מרקט טבריה","ביץ' מרקט ירושלים","ביץ' מרקט כפר סבא","ביץ' מרקט כרמיאל","ביץ' מרקט לוד","ביץ' מרקט מודיעין","ביץ' מרקט נס ציונה","ביץ' מרקט נצרת","ביץ' מרקט פתח תקווה","ביץ' מרקט רחובות","ביץ' מרקט רמלה","ביץ' מרקט רמת גן","ביץ' מרקט רעננה","ביץ' מרקט תל אביב","ביץ\\","חנות נוחות","חנות נוחות 24","חנות נוחות 24/7","חנות נוחות תחנת דלק","חנות תחנת דלק","יוניברס","יוניברסל","ילו אקספרס","ילו בוטיק","מיניט מרקט","מירה שופ","מירה שופ אילת","מירה שופ אשדוד","מירה שופ אשקלון","מירה שופ באר שבע","מירה שופ בת ים","מירה שופ גבעתיים","מירה שופ הדרום","מירה שופ הצפון","מירה שופ הרצליה","מירה שופ חולון","מירה שופ חיפה","מירה שופ טבריה","מירה שופ ירושלים","מירה שופ כפר סבא","מירה שופ כרמיאל","מירה שופ לוד","מירה שופ מודיעין","מירה שופ נס ציונה","מירה שופ נצרת","מירה שופ פתח תקווה","מירה שופ רחובות","מירה שופ רמלה","מירה שופ רמת גן","מירה שופ רעננה","מירה שופ תל אביב","מנטה אבן יהודה","מנטה רוטשילד","מנטה רחביה","מנטה רחביה ירושלים","מנטה תל אביב","סופר פארם 24/7","סטופ אנד גו","פאסט שופ","קוויק מרקט"],"category":"אוכל","subcategory":"אוכל לבית — חנויות נוחות 24/7"},
  {"keywords":["אייס תה","absolut","aperol","arak","arctic drink","bacardi","ballantines","bombay sapphire","boost juice","boost juice ashdod","boost juice ashkelon","boost juice bat yam","boost juice beer sheva","boost juice eilat","boost juice givatayim","boost juice haifa","boost juice herzliya","boost juice holon","boost juice jerusalem","boost juice karmiel","boost juice kfar saba","boost juice lod","boost juice modiin","boost juice nazareth","boost juice nes ziona","boost juice petah tikva","boost juice raanana","boost juice ramat gan","boost juice ramla","boost juice rehovot","boost juice tel aviv","boost juice tiberias","bourbon","campari","captain morgan","champagne","chivas","coca cola","coca-cola","coke","crystal","doctor doctor","doctor pepper","famous grouse","fanta","gatorade","gin","glenfiddich","hendrick's","hendrick\\","ice tea","jack daniels","jameson","johnnie walker","macallan","martini","milkshake","moet","monster","natural juice","natural mix","nestea","ouzo","pepsi","powerade","prigat","prosecco","raki","redbull","rum","schweppes","smirnoff","smoothie","spectrum","spring water","sprite","spritz","stolichnaya","sweat","swt","tanqueray","tapuz","tcheria","tequila","teva drinks","tonic water","top shake","touch up","vermouth","veuve clicquot","vinoteca","vodka","wine bar","אבסולוט","אוזו","אפרול","אפרסק קר","ארקטיק שתיה","בומביי ספיר","בורבון","בלנטיינס","בקרדי","ג'וני ווקר","ג'יימסון","ג'ין","ג'ק דניאלס","גטוריד","גלנפידיש","ד״ר פפר","הנדריקס","וו קליקו","וודקה","ויינריה","וינוטקה","וני ווקר","ורמוט","טאנקריי","טאצ' אייס תה","טאצ' אפ","טאצ\\","טבע","טופ שייק","טקילה","טשרה","מואט","מונסטר","מי טוניק","מילקשייק","מיץ אורגני","מיץ טבעי","מיץ ירוק","מיץ סחוט","מיץ קר","מיץ תפוזים","מיץ תפוזים טרי","מיץ תפוזים סחוט","מיקס טבעי","מיקס פירות","מיקס שייקים","מקאלן","מרטיני","נאיה","נסטי","סודה","סודה קלאסית","סווט","סטוליצ'נאיה","סמוטי","סמירנוף","ספקטרום","ספרייט","ספרינג מי","ספריץ","ערק","ערק אלטעאם","ערק עליטה","פאואר ליין","פאוורייד","פאנטה","פיימוס גראוס","פפסי","פרוסקו","פריגת קלאסי","קוקה קולה","קמפרי","קפטן מורגן","קריסטל","קריסטל מים","ראקי","רד בול","רום","שוופס","שווצפס","שיווז","שייק","שמפניה","תפוז סחוט"],"category":"אוכל","subcategory":"משקאות — מותגים שמופיעים בהוצאות"},
  {"keywords":["24/7","247","adika","adika.co.il","adrian","anne marie","ariel plus","ariella","emil","erika","erikson","factory 54","factory54","fox home","fox-wizel","gali","hanes","holst","interstone","intima","intimissimi","lc waikiki","max mara","max stock","moschino","op fashion","osver","paula","pivot","polgat","rani","scal","shaksh","sofrim","suzi","suzy","t boutique","tamara","tamra","terminal x","terminal-x","tery white","top ten","twentyfourseven","twist","twist collection","urbanica","vitamin","vitamin fashion","white out","אדריאן","אוסבר","אופ אופנה","אורבניקה","אינטימה","אינטימיסימי","אינטרסטון","אל סי ווייקיקי","אמיל","אמיל בוטיק","אן מארי","אנמרי","אריאל פלוס","אריאלה","אריקה","אריקסון","גלי","האנס","הולסט","וויט אאוט","וויטאמין","טוויסט","טוויסט קולקשן","טוונטיפורסבן","טופ טן","טופטן","טי בוטיק","טמרה","טרי וייט","טרמינל איקס","מוסקינו","מקס מרה","מקס סטוק","מקס-סטוק","נעלי גלי","סוזי בוטיק","סופרים","סקאל","עדיקה","פולגת","פולה","פוקס","פוקס הום","פיווט","פקטורי 54","ראני","שקש"],"category":"קניות / ביגוד","subcategory":"Israeli fashion chains - women"},
  {"keywords":["antwerpen","artic","boss","castro men","chris payton","golf men","hugo boss","jack & jones","jack and jones","jackjones","metro","metro fashion","organizer","pink","polos","powell","powell n","ralph lauren","scotch","scotch & soda","selected","sweet shop","t.m. lewin","ted baker","tm lewin","tommy hilfiger","tommy jeans","topman","topshop","אורגנייזר","אנטוורפן","ארטיק","ארטיק גברים","בוס","ג'ק אנד ג'ונס","גולף גברים","ונס","טומי ג'ינס","טומי ג\\","טומי הילפיגר","טופ שופ","טופמן","טי קנט","כריס פייטון","מטרו","סוויט שופ","סלקטד","סקוטש","פאוול אנד אן","פולו רלף לורן","פולוס","פינק","קסטרו גברים"],"category":"קניות / ביגוד","subcategory":"Israeli fashion chains - men"},
  {"keywords":["adumla","bibi chic","bibi go","bibibon","bon bon","bonbon","castro kids","come ilfu","costco kids","fox baby","fox kids","golf kids","gymboree","kids","kids brands","kids maadanim","kidz","kippli","mama","mama shop","mika kids","mini castro","motagit","motgey hayeladim","ok baby","okay baby","papaya kids","papayakids","pasta pajamas","pazli","petit bo","scoop kids","sweet kids","toto","toto kids","treli","yeladim shel bayit","אדומלה","אדומלה ילדים","אוקיי בייבי","בון בון","ביבי בון","ביבי גוו","ביבי שיק","ג'ימבוריה","טוטו","טרי-לי","ילדי גולף","ילדים של בית","כיפלי","מאמא","מות פסטה","מותגי הילדים","מותגי קידס","מותגית","מיני קסטרו","מיקה לילדים","סוויט קידס","סקופ קידס","פוקס בייבי","פוקס קידס","פז לי","פז-לי","פטיט בו","פיג'מות פסטה","פפקה","קום אילפו","קוסטוקס","קיד'ז","קיד\\","קידס מעדנים","קסטרו קידס"],"category":"קניות / ביגוד","subcategory":"Israeli kids fashion"},
  {"keywords":["aldo","aldo shoes","asics","aviam","avigezer","balshvar","balshwar","bara","birkenstock","bison","clarks","converse","dr martens","ecco","gali shoes","gingi","givani","hanes shoes","lotus shoes","marie claire shoes","may shoes","mizuno","naalei eretz","new balance","nine west","nineteen","ofnat hayam","palamib","palladium","pegasus","pulks","pundak shoes","reebok","salomon","scoop","scoop shoes","sebani shoes","shoresh","shufra","skechers","steve madden","superga","tambel","tambulance","teva naot","timberland","tivai","tofer","vans","אביגזר","אביעם","אופנת הים","אלדו נעליים","אסיקס","אקו","ביזון","בירקנשטוק","בלשואר","ג'ינג'י","ג'ינג'י נעליים","גיוואני","דר מרטינס","האנס נעליים","וונס","טבע נאות","טבעי","טימברלנד","טמבולנס","טמבל","טפר","י נעליים","לוטוס נעליים","מאי","מיזונו","מרי קליר","ניו באלאנס","ניו-באלאנס","ניין ווסט","ניינטיין","נעלי ארץ","נעלי גלי","נעלי טפר","נעלי שורש","סבני נעליים","סופרגה","סטיב מאדן","סלומון","סקופ","סקופ נעליים","סקצ'רס","סקצ'רס ישראל","סקצ\\","פגאסוס","פולקס","פונדק נעליים","פלדיום","פלמיב","קונברס","קלארקס","ריבוק","רס ישראל","שופרא","שורש"],"category":"קניות / נעליים","subcategory":"Shoes - Israeli chains"},
  {"keywords":["adidas","adidas israel","alpinism","asics sport","columbia","decathlon","decathlon israel","mega sport","nike","nike israel","north face","patagonia","puma","puma israel","ryan's","ryan\\","ryans","skechers sport","spider sport","sport center","sport plus","sport vip","spyder","status","stilos","the north face","tik tak","timberland sport","tiulon","under armour","אדידס ישראל","אונדר ארמור","אלפיניזם","אסיקס ספורט","דקאתלון","טיולון","טימברלנד ספורט","מגה ספורט","נורת פייס","נייקי ישראל","סטטוס","סטילוס","ספורט ויפ","ספורט סנטר","ספורט פלוס","ספיידר","ספיידרמן ספורט","סקצרס ספורט","פומה ישראל","פטגוניה","קלמבייה","ראיינס","תיק תק"],"category":"קניות / ביגוד","subcategory":"Sportswear chains"},
  {"keywords":["a&f","abercrombie","aleks","alex","almodnu","armani","armani exchange","austin","a|x","banana republic","bershka","calvin klein","diesel","franklin & marshall","franklin marshall","gap","guess","hollister","house of holland","lacoste","levi's store","levi\\","mango","massimo dutti","mng","nathan","old navy","oxstead","oxygen","oysho","pepe jeans","polenta","polo ralph lauren","primark","pull & bear","pull and bear","pull&bear","replay","scotch & soda","scotch soda","sebani","spirit","stradivarius","superdry","superdry x","swinston","tommy","topman","topshop","under color","uniqlo","waikiki","אבירקרומבי","אולד נייבי","אונייקלו","אוסטין","אוצ'ו","אוקסטד","אוקסיגן","אלמודנו","אלקס","אנדר קולור","ארמני","ארמני אקסצ'יינג'","ארמני אקסצ\\","ביננה","ברשקה","גאפ","דיזל","האוס אוף הולנד","הוליסטר","וייקיקי","טומי","טופמן","טופשופ","ינס","לאקוסט","ליוויס סטור","מאנגו","מאסימו דוטי","ניית'ן","סבני","סווינסטון","סופרדריי","סופרדריי איקס","סטרדיווריוס","ספיריט","סקאצ' אנד סודה","סקאצ\\","פול אנד בר","פולו רלף לורן","פולנטה","פפה ג'ינס","פרימרק","פרנקלין ומרשל","קלווין קליין","ריפליי"],"category":"קניות / ביגוד","subcategory":"International fashion chains"},
  {"keywords":["19 undies","almodo","aloe vera","aloevera","arena","blackvan","delia underwear","flori","gizan","gottex","intima undies","mini canny","oysho","peter pan","petit bateau","playtex","sol & pepper","speedo","supersol clothing","superstar undies","swimwear","top underwear","trico","triumph","victoria secret","wheels wear","אוקיה","אינטימה לבנים","אלוורה","אלמודו","אריונה","ביגוד גלגלים","ביגוד ים","בלקבן","ג'יזאן","גוטקס","דליה","ויקטוריה סיקרט","טופ","טריומף","טריקו","מיני קני","ניינטיין תחתונים","סול אנד פפר","סופרסטאר תחתונים","סופרסל ביגוד","ספידו","פטיט בטו","פיטר פן","פלאיטקס","פלורי"],"category":"קניות / ביגוד","subcategory":"Underwear and swimwear"},
  {"keywords":["abak","accel","accessorize","accessory","amigos","bagaje","beverly","blackstone","claire's","claire\\","claires","fal avi","fashik","frida","function","kf fashion","kris","melanie","sandal plus","stone","swatch","tamberlin","tosa","treat","אבק","אופנת ק.ש","אמיגוס","אקסל","אקססוריז","בגז'ה","בוורלי","בלאקסטון","טוסה","טמברלין","טריט","כריס","מלאני","סווצ'","סווצ\\","סטון","סנדל פלוס","פאל אבי","פאשיק","פונקציה","פרידה","קלייר'ז"],"category":"קניות / ביגוד","subcategory":"Accessories"},
  {"keywords":["adam vechava","ahuva jewelry","andrea","avnei hen","beni jewelry","breitling","bvlgari","cartier","casio","charlie tamir","diamond","exclusive jewelry","fair jewelry","fossil","fotuna","freidman","grotstein","h stern","h. stern","harel jewelers","ivy","ivy jewelry","lotus jewelry","love jewelry","master jewelry","melissa gold","metalurgia","michael kors","migdal hazahav","moto jewelry","my jewelry","omega","pandora","pandora bracelet","patek philippe","perfum","roge","rolex","sapir jewelry","seiko","shiri jewelry","steve miller","swatch israel","tag heuer","taplio","tavi","tiffany","tiffany & co","uri levi","uri levy","אבני חן","אדם וחווה","אהובה תכשיטים","אומגה","אורי לוי","אייבי","אנדריאה","ארלי טמיר","בולגרי","ברייטלינג","גרוטסטיין","ה. שטרן","הראל תכשיטנים","טאג הויאר","טבי","טייפני","טפליו","יהלום","מגדל הזהב","מוטו תכשיטים","מטלורגיה","מייקל קורס","מליסה גולד","מסטר תכשיטים","סוואץ'","סוואץ\\","סטיב מילר","סייקו","ספיר תכשיטים","פוטונה","פוסיל","פטק פיליפ","פנדורה","פנדורה ישראל","פנדורה צמיד","פרגון","פרידמן","פרידמן תכשיטים","צ'ארלי טמיר","קאסיו ישראל","קסיו","קרטייה","רוז'ה","רוז\\","רולקס","תכשיט בלעדי","תכשיט הוגן","תכשיט שלי","תכשיטי אהבה","תכשיטי בני","תכשיטי לוטוס","תכשיטי שירי"],"category":"קניות / תכשיטים","subcategory":"Jewelry and watches"},
  {"keywords":["ahsun 7","alpha","aprint","armator","barak chashmal","bir hasharon","bug digital","bug multi","bug דיגיטל","bug מולטי","castro digital","chashmalel","d mobile","dnm","electro deluxe","electro israel","electro israeli","electro moses","electro omek","electrodeal","electromaster","electrostore","em mishkan","evatec","feston","fototec","iec israel","ihsun 7","ivory","ivory digital","kishron","ksp gamers","ksp haifa","ksp tel aviv","ksp גיימרים","ksp חיפה","machsanei chashmal hot","mega electric","megabyte","merkaz hachashmal","multiq","ofir chashmal","otsar hashilton","phototec","plazma","practo","rma","stock chashmal","stock חשמל","super chashmal","tapuzim","tapuzim digital","techno lab","techno plus","techno rose","techno time","techno zerem","techno zone","yetzu","א-פרינט","אווה-טק","אופיר חשמל","אוצר השלטון","אחסון 7","אייווי","אלפא","אלקטרו דה לוקס","אלקטרו ישראל","אלקטרו ישראלי","אלקטרו מאסטר","אלקטרו מוזס","אלקטרו עומק","אלקטרודיל","אלקטרוסטור","אם משכן הטכנולוגיה","אר.אם.או","ארמטור","ביר השרון","ברק חשמל","די מובייל","די.אנ.אם","חברת חשמל ישראל","חשמלל","טכנו זון","טכנו זרם","טכנו טיים","טכנו לאב","טכנו פלוס","טכנו רוז","יצוא","כשרון","מגה אלקטריק","מגה בייט","מולטי-קיו","מחסני חשמל הוט","מרכז החשמל","סופר חשמל","סטוק חשמל","פוטוטק","פלאזמה","פסטון","פרקטו","קסטרו דיגיטל","תפוזים"],"category":"קניות / חשמל ואלקטרוניקה","subcategory":"Electronics - big chains"},
  {"keywords":["apple store israel","apple store ישראל","ard phone","ardphone","axiom mobile","extreme","extreme phones","fix phone","flip","flip phone","fone","galaxy","galaxy mobile","iphone fix","iphone plus","iphone repair","mahir phones","masach nishbar","mobile complex","mobile repair","mobile store","phone house","screen fix","sellfon","selular 2000","selular 247","selular 358","selular 365","selular 4u","selular 5g","selular express","selular israel","selular market","selular online","selular touch","selular zoom","tel-net","telefonia bayit","telefonia center","utopia mobile","yevuanei selular","אייפון פלוס","אקסטרים","אקסיום סלולר","ארד פון","גלאקסי","טל-נט","טלפוניה בית","טלפוניה מרכז","יבואני סלולר","יוטופיה","מהיר טלפונים","מובייל סטור","מובייל קומפלקס","מסך נשבר","מתקני אייפון","סלולר 2000","סלולר 247","סלולר 358","סלולר 365","סלולר 4u","סלולר 5g","סלולר אונליין","סלולר אקספרס","סלולר זום","סלולר טאץ'","סלולר טאץ\\","סלולר ישראל","סלולר מרקט","סלפון","סקרין פיקס","פון האוס","פונה","פיקס פון","פליפ","תיקון אייפון","תיקון סלולר"],"category":"קניות / חשמל ואלקטרוניקה","subcategory":"Mobile phones and accessories"},
  {"keywords":["alienware","alpha computers","alpha gaming","antec","asus","asus rog","canon","corsair","cyberpower","fujifilm","gaming store","hub computers","ivory digital","ksp computers","ksp מחשבים","logitech","matzlemot hatzafon","mpcter","msi","multi computers","nikon","panasonic","pc master","pc world","philips","photo arpaza","photo dekel","photo discount","photo express","photo fix","photo plus","photo tamri","photo zoom","razer","rog","sony","sony center","steelseries","tamhil electronics","tapuz 3","techno pc","techno photo","top pc","xpg","אייווי דיגיטל","אלינוויר","אלפא גיימינג","אלפא מחשבים","אם אס איי","אם פיוטר","אנטק","אקס פי ג'י","אקס פי ג\\","גיימינג סטור","האב מחשבים","טופ פיוטר","טכנו פוטו","טכנו פי סי","לוג'יטק","מולטי מחשבים","מצלמות הצפון","ניקון","סוני","סטילסיריס","סייברפאוור","פוג'יפילם","פוג\\","פוטו אקספרס","פוטו ארפזה","פוטו דיסקאונט","פוטו דקל","פוטו זום","פוטו פיקס","פוטו פלוס","פוטו תמרי","פיוטר וורלד","פיוטר מאסטר","פיליפס","פנסוניק","קורסייר","קנון","ריזר","תמהיל אלקטרוניקה","תפוז שלוש"],"category":"קניות / חשמל ואלקטרוניקה","subcategory":"Computer and gaming"},
  {"keywords":["admiral","aeg","air fryer","ariston","bosch","braun","candy","electra","electra mazganim","electrolux","fox mazganim","fryer","hambl","hamilton beach","indesit","ishchangun","jed","kenwood","miele","morphy richards","moulinex","philips air fryer","philips eidos","polaris","rowenta","sensor","sensor mazganim","siemens","soda club","soda stream","sodastream","stross","t-fal","tadiran","tami 4","tami 5","tami4","tami5","tefal","vitter","westinghouse","whirlpool","אדמירל","אי.אי.ג'י","אי.אי.ג\\","אינדזיט","אישחנגון","אלקטרא","אלקטרה מזגנים","אלקטרולוקס","אריסטון","בוש","ביטטר","ברוון","ג'אד","המבל","המילטון ביץ'","המילטון ביץ\\","וייסטינגהאוס","וירפול","טמי 5","טמי4","טפאל","מולטיקס","מורניק","מילה","סודה סטרים","סודה קלאב","סטרוס","סימנס","סנסור","סנסר מזגנים","פולאריס","פוקס מזגנים","פיליפס איידוס","פיליפס איר פראייר","פלייר","קנדי","קנווד","ראוונטה","תדיראן"],"category":"קניות / חשמל ואלקטרוניקה","subcategory":"Home appliances brands"},
  {"keywords":["abyss","alfa furniture","alfa home","ater furniture","beauty home","beitili","big bender","big store","emily","emily home","habitat","hamelech furniture","hatzi hinam furniture","hollandia","home plus","home polishing","home store","hyper sino","ikea beer sheva","ikea netanya","ikea raanana","ikea rishon","kfar furniture","master rehitim","melachim furniture","mio","mio furniture","mm design","mm furniture","olmika","orthopedia","paaman","psagot furniture","rehitey hamumchim","rehitey ilan","rehitey shleizer","scala","segev","segev furniture","sofa online","stock furniture","super furniture","tiferet furniture","tit sofa","tri home","trian furniture","urban furniture","varianta","wifo","wifo furniture","אביס","אולמיקה","אורבן רהיטים","אורתופדיה","אטר רהיטים","איקאה באר שבע","איקאה נתניה","איקאה ראשון","איקאה רעננה","אלפא הום","אלפא רהיטים","אם.אם רהיטים","אם.אם.דיזיין","אמילי","אמילי הום","ביג בנדר","ביג סטור","ביוטי הוום","ביתילי","הביטאט","הולנדיה","הום סטור","הום פולישינג","הום פלוס","היפר ל סינו","ויפו רהיטים","וריאנטה","חצי חינם רהיטים","טיט סופה","טרי הום","טריאן רהיטים","מאסטר רהיטים","מיו","סגב","סגב רהיטים","סופה אונליין","סופר רהיטים","סקאלה","פאמן","פסגות רהיטים","רהיטי אילן","רהיטי המומחים","רהיטי המלך","רהיטי הסטוק","רהיטי כפר","רהיטי מלכים","רהיטי שלזר","תפארת רהיטים"],"category":"קניות / רהיטים","subcategory":"Furniture and home decor chains"},
  {"keywords":["adminik","alon furniture","alovera","aqua decor","aqua home","asif","ava furniture","boksir","capes","habitzu","home art","itzuv center","itzuvim","maya home","meitar","meitarim","mika","mika decor","ora","ora decor","ora itzuv","plant","ploozon","pluto decor","raya itzuv","salat itzuv","tiferet habayit","tool home","trian itzuv","trion","veil home","wonder home","zohar","zohar decor","אדמיניק","אווה רהיטים","אורה","אורה עיצוב","אלוורה","אלון רהיטים","אסיף","אקווה דקור","אקווה הום","בוקסיר","הביצוע","הוום ארט","וונדר הום","וייל הום","זוהר","טול הום","טרוון","טריאן עיצוב","מאיה הום","מיקה","מיתר","מיתרים","סלט עיצוב","עיצוב סנטר","עיצובים","פלאנט","פלוזון","פלוטו","קייפים","ראיה עיצוב","תפארת הבית"],"category":"קניות / רהיטים","subcategory":"Home decor and accessories"},
  {"keywords":["anat home","bayit bedding","biotec textile","bioto","elvis bedding","fluff","fox bedding","fox home textile","kitan bayit","kitan textile","ktarim bedding","lexus bedding","malkat hamatzaim","matzaei gali","matzaei mila","menpazed","shalom bedding","smit","smit textile","test bedding","textile center","textily","yuki","yuki textile","אלוויס מצעים","ביוטו","ביוטיק טקסטיל","טסט מצעים","טקסטיל סנטר","טקסטילי","יוקי","כיתן בית","כיתן טקסטיל","כתרים מצעים","מלכת המצעים","מנפזד","מצעי בית","מצעי גלי","מצעי לקסוס","מצעי מילה","מצעי שלום","סמיט","ענת הוום","פוקס הום טקסטיל","פוקס מצעים","פלאפ"],"category":"קניות / רהיטים","subcategory":"Bedding and textiles"},
  {"keywords":["ace raanana","ace tel aviv","ace רעננה","ace תל אביב","agma","alfa tznurot","beit habrgim","beit hamasmerim","beit hareihim","beit haritzfot","beit hatznerut","beit hatzvaim","black & decker","black and decker","black decker","borgaya","bosch tools","bosch כלי עבודה","chaim shmerlik","dewalt","drill","einhell","hyper tool","karnei shemesh","klei avoda israel","klei habraga","kol bo tekhni","ma atem","machsanei bniya","makdekha","makita","masor","max lee","mefer 1+1","milwaukee","nirlat","patish iluts","patish shish","polgaz","rav bariach","saw","screwdriver","stanley","tambour","tzivei lapid","אגמא","אינהל","אלפא צנרת","בית האריחים","בית הברגים","בית המסמרים","בית הצבעים","בית הצנרת","בית הרצפות","ברגייה","דיוולט","היפר טול","חיים שמרליק","טמבור","כל בו טכני","כלי הברגה","כלי עבודה ישראל","מ.ע. אטם","מחסני בנייה","מילווקי","מסור","מפר 1+1","מקדחה","מקיטה","מקס לי","נירלט","סטנלי","פולגז","פטיש אילוץ","פטיש שיש","צבעי לפיד","קרני שמש","רב בריח"],"category":"קניות / רהיטים","subcategory":"Hardware and DIY"},
  {"keywords":["adanit","flowers","gan hashomer","ganan","gardener","hagan hayarok","kfar haganim","kfar hashashuim","metaim","mishtela","mishtelat hagenan","mishtelat hasharon","mishtelat hatzomeach","mishtelat leumi","nursery","perachim","pirhei golan","pirhei hamoshav","pirhei hasharon","pirhei shemesh","planter","plants","shuk hekologi","spot gan","tevat perachim","tzmachim","yad shniya gardens","yarkot maya","אדנית","גן השומר","גנן","הגן הירוק","השוק האקולוגי","יד שניה גינות","ירקות מאיה","כפר הגנים","כפר השעשועים","מטעים","משתלה","משתלת הגנן","משתלת הצומח","משתלת השרון","משתלת לאומי","ספוט גן","פרחי גולן","פרחי המושב","פרחי השרון","פרחי שמש","פרחים","צמחים","תיבת פרחים"],"category":"קניות / רהיטים","subcategory":"Garden and plants"},
  {"keywords":["ahavat baby","anderson baby","baby boutique","baby house","baby katan","baby plus","baby shop","baby world","babyland","bibi lev","city baby","etzel hababy","house of baby","kids now","kindergarten","kol bo baby","mama home","mini me","motgey gali","motgey kids express","petit baby","peuton","shilav center","shilav express","tov li baby","wonder baby","wonder kids","אהבת בייבי","אנדרסון בייבי","אצל הבייבי","ביבי לב","בייבי בוטיק","בייבי האוס","בייבי וורלד","בייבי פלוס","בייבי קטן","בייבי שופ","בייבילנד","האוס אוף בייבי","טוב לי לבייבי","ילדים עכשיו","כל בו בייבי","מאמא הום","מותגי גלי","מותגי הילדים אקספרס","מיני מי","סיטי בייבי","פטיט בייבי","פלא בייבי","פלא ילדים","פעוטון","שילב אקספרס","שילב סנטר"],"category":"קניות / ביגוד","subcategory":"Baby and children stores"},
  {"keywords":["ahim toys","bandai","barbie","bicycle","center toys","griver mishakim","gvula","gvula toys","hasbro","hot wheels","kol bo 99","leg","lego","mama loly","matos","mattel","mishakey hevra","mishakey loach","momo toys","monopoly","mutzrei tinokot","nintendo","ofanaim","ofanaim leyeladim","omega toys","playmobil","playstation 5","playstore","pokemon","ps5","puzzle","rc plane","robotim","robots","switch","toys r us","transformers","twiss","tzayatzuim sheli","tzayatzuim veshashuim","xbox","אומגה צעצועים","אופניים","אופניים לילדים","אקסבוקס","באנדאי","ברבי","גבולה","גריבר משחקים","האסברו","הוט וילס","טוויס","טוייז ר אס","טרנספורמרס","כל בו 99","לגו","מאטל","מאמא לולי","מומו צעצועים","מונופול","מוצרי תינוקות","מטוס","משחקי חברה","משחקי לוח","נינטנדו","סוויץ'","סוויץ\\","סנטר צעצועים","פאזל","פוקימון","פליימוביל","פלייסטור","פלייסטיישן 5","צעצועי האחים","צעצועים ושעשועים","צעצועים שלי","רובוטים"],"category":"קניות / ביגוד","subcategory":"Toys and games"},
  {"keywords":["adora","beauty box","beauty halsa","beauty plus","beautybox","biotec","center beauty","chanel cosmetics","christian dior","clinique","dior","estee lauder","face boutique","face center","face fix","faceline","feast","gercia","golbary","house of beauty","lancome","mac","mac cosmetics","moraz","moraz cosmetics","mostil","new pharm beauty","olifer","olify","omo","omo cosmetics","opi","opi israel","opi ישראל","palmolive","pini pelia","polly","salon bella","salon esti","salon ofna","salon paer","salon panim","sasley","sasley boutique","shiseido","spa vesalon","spiegel","spiegel plus","spirulina","super maxi","super pharm beauty","אדורה","אוליפי","אוליפר","אסתי לאודר","ביאופיק","ביוטי בוקס","ביוטי הלסה","ביוטי פלוס","ביוטיבוקס","גולברי","גרסיה","האוס אוף ביוטי","כריסטיאן דיור","לאנקום","לנקום ישראל","מאק קוסמטיקה","מוסטיל","מורז","מורז קוסמטיקה","ניו פארם ביוטי","סופר מקסי","סופר פארם ביוטי","סלון אופנה","סלון אסתי","סלון בלה","סלון פאר","סלון פנים","סנטר ביוטי","ססלי","ססלי בוטיק","ספא וסלון","ספיגל","ספיגל פלוס","ספיגל קוסמטיקה","ספירולינה","פולי","פייס בוטיק","פייס סנטר","פייס פיקס","פייסט","פייסליין","פיני פליה","פלמולייב","קליניק","שאנל קוסמטיקה","שיסיידו"],"category":"קניות / קוסמטיקה","subcategory":"Beauty and cosmetics chains"},
  {"keywords":["alon studio","aroma beauty","beauty plus hair","beauty white","body shop","hanes","hanes hair","kerastase","krasta","l'occitane","loreal professional","lush","matrix","matrix hair","misparat ava","misparat avi","misparat hamelech","misparat hasharon","misparat hechadasha","misparat otzer","misparat rachel","misparat roni","nitzan boutique","occitane","pantene","paul mitchell","redken","roni weiss","sabon","schwarzkopf","studio lasear","studio plus","tigi","toni & guy","toni and guy","wella","אוקיטן","אלון סטודיו","ארומה ביוטי","בודי שופ","ביוטי וייט","ביוטי פלוס שיער","האנס","וולה","טוני אנד גאי","טמטו","לאש","לוריאל פרופשיונל","מטריקס","מספרה החדשה","מספרת אבי","מספרת אווה","מספרת אוצר","מספרת המלך","מספרת השרון","מספרת רחל","מספרת רני","ניצן בוטיק","סבון","סטודיו לשיער","סטודיו פלוס","פאוול מיטשל","פנטין","קראסטה","קראסטס","רדקן","רוני וייס","שוורצקופף"],"category":"קניות / קוסמטיקה","subcategory":"Hair salons and styling"},
  {"keywords":["ahim books","akadmon","askur","eretz yisrael books","gesher theater","habima theater","haifa theater","kameri theater","kids books","lessin theater","magazin","menpazed","music books","otsar hasefer","redley","shalosh sukot","sifrei academia","sifrei hai","sifrei ira","sifrei kodesh","sifrei limud","sifrei tora","sifriyat encyclopedia","steimatzky haifa","steimatzky jerusalem","steimatzky tel aviv","steims stock","tmona theater","tzomet sfarim jerusalem","tzomet sfarim tel aviv","yerushalmi theater","אוצר הספר","אסקור","אקדמון","המגזין","מנפזד","סטים סטוק","סטימצקי חיפה","סטימצקי ירושלים","סטימצקי תל אביב","ספרי אקדמיה","ספרי ארץ ישראל","ספרי האחים","ספרי חי","ספרי ילדים","ספרי לימוד","ספרי מוזיקה","ספרי עירא","ספרי קודש","ספרי תורה","ספריית אנציקלופדיה","צומת ספרים ירושלים","צומת ספרים תל אביב","רידלי","שלוש סוכות","תאטרון בית לסין","תאטרון גשר","תאטרון הבימה","תאטרון הירושלמי","תאטרון הקאמרי","תאטרון חיפה","תאטרון תמונע"],"category":"קניות / ספרים","subcategory":"Books and culture"},
  {"keywords":["bluren","fender","gibson","haozen hazahav","kalman","kalman music","kinor hayam","klei negina israel","korg","music global","music personal","music plus","pesanterai yaron","roland","stranger","stranger ta","studio 5","studio music","studio pilin","sweet music","yamaha","בלורן","גיבסון","האוזן הזהב","ימאהה","כינור הים","כלי נגינה ישראל","מוזיקה גלובל","מוזיקה פלוס","מוזיקה פרסונל","סוויט מוזיקה","סטודיו 5","סטודיו מוזיקה","סטודיו פילין","סטריינג'ר ת\"א","סטריינג\\","פנדר","פסנתרי ירון","קורג","קלמן","רולנד"],"category":"קניות / ספרים","subcategory":"Music stores"},
  {"keywords":["akvariom","animals","aquarium","bear","birds","haya haahuva","haya yeruka","hevrat hateva","hills","kelev yam","kennel","klviya","pedigree","pet shop center","pet shop plus","petdeal","petman","petmarket","pets friend","pets israel","pets planet","petsmart","petstore","petworld","protein pet","royal canin","tofi","tziporim","whiskas","אנימלס","אקווריום","ביאר","החיה האהובה","הטופי","הילס","ויסקאס","חברת הטבע","חיה ירוקה","חיות מחמד ישראל","כלב ים","כלביה","פדיגרי","פט שופ סנטר","פט שופ פלוס","פטדיל","פטוורלד","פטמן","פטמרקט","פטס פלאנט","פטס פרינד","פטסטור","פטסמרט","פטסמרט ישראל","פרוטיין","ציפורים","רויאל קנין"],"category":"קניות / חיות מחמד","subcategory":"Pet stores - chains"},
  {"keywords":["animals hospital","avi elnekave","dr oz","dr oz vet","mersa","pet medicine","plagi vet","reut lahaya","sheba vet clinic","vet 24","vet center","vet emergency","vet haifa","vet hasharon","vet jerusalem","vet netanya","vet pharmacy","vet raanana","vet tel aviv","vet toran","veterinary clinic","veterinary hospital","אבי אלנקווה","ביה","ביה\"ח לחיות","בית חולים וטרינרי","בית מרקחת וטרינרי","ד\"ר עוז","וטרינר 24","וטרינר השרון","וטרינר חיפה","וטרינר חירום","וטרינר ירושלים","וטרינר נתניה","וטרינר רעננה","וטרינר תורן","וטרינר תל אביב","מרכז וטרינרי","מרסה","פלגי וטרינר","קליניק שיבא וטרינרית","קליניקה וטרינרית","ר עוז","רעות לחיה","תרופות לחיות"],"category":"קניות / חיות מחמד","subcategory":"Veterinary"},
  {"keywords":["altman","altman vitamins","assuta pharmacy","be pharma","bepharma","central pharmacy","centrum","energy","energy supplements","good pharm 24","habriut pharmacy","har hatzofim pharmacy","harel pharmacy","ichilov pharmacy","levy pharmacy","new pharm 247","ori pharmacy","pharm 24","pharm yavne","pharm-yavne","pharm24","ramat aviv pharmacy","rav hen pharmacy","rehavia pharmacy","sheba pharmacy","solgar","super pharm 247","superherbal","supersol pharm","supherb","trufa israel","vital","vitamins","אלטמן","אנרגיה","בית מרקחת אורי","בית מרקחת איכילוב","בית מרקחת אסותא","בית מרקחת הבריאות","בית מרקחת הר הצופים","בית מרקחת הראל","בית מרקחת לוי","בית מרקחת מרכזי","בית מרקחת רב חן","בית מרקחת רחביה","בית מרקחת רמת אביב","בית מרקחת תל השומר","גוד פארם 24","ויטל","ויטמינים","ניו פארם 24/7","סוופרי","סולגאר","סופר פארם 24/7","סופרהרבל","סופרסל פארם","סנטרום","פארם 24","פארם יבנה","תרופה ישראל"],"category":"בריאות / תרופות","subcategory":"Pharmacies extended"},
  {"keywords":["erroca optics","fangles","gucci eyewear","oakley","optica dror","optica galil","optica grand","optica haifa","optica halperin","optica hasharon","optica hod","optica jerusalem","optica merkaz","optica optics","optica paer","optica pini","optica raanana","optica tel aviv","opticana","police","police glasses","polo eyewear","prada eyewear","ray ban","ray-ban","sunglass hut","sunglasses hut","timberland glasses","tom ford","vision","אופטיקה אופטיקס","אופטיקה גליל","אופטיקה גרנד","אופטיקה דרור","אופטיקה הוד","אופטיקה הלפרין","אופטיקה השרון","אופטיקה חיפה","אופטיקה ירושלים","אופטיקה מרכז","אופטיקה פאר","אופטיקה פיני","אופטיקה רעננה","אופטיקה תל אביב","אופטיקנה","אוקלי","גוצ'י משקפיים","גוצ\\","ויז'יון","טום פורד","טימברלנד משקפיים","יון","סנגלסס האט","ערוקה אופטיקה","פאנגלס","פולו משקפיים","פוליס","פראדה משקפיים","ריי באן"],"category":"קניות / חשמל ואלקטרוניקה","subcategory":"Eyewear and optics"},
  {"keywords":["azrieli","azrieli center","big","big center","big fashion","cheap deal","dizengoff center","g center","gan hair","hakol b 1","hakol b 10","hakol b 20","hakol b 5","john bull","kanyon ayalon","kanyon grand","kanyon haifa","kanyon hasharon","kanyon hod hasharon","kanyon jerusalem","kanyon lev hamifratz","kanyon rehovot","kanyon renanim","kanyon tel aviv","kol bo afi","kol bo ahim","kol bo anak","kol bo dror","kol bo friedman","kol bo hasharon","kol bo ilan","kol bo nitzan","kol bo petach tikva","kol bo tapuz","malcha","malcha mall","max stock","merhav misachar","outlet","outlet ashdod","outlet bilu","outlet eilat","outlet modiin","ramat aviv center","ramat aviv mall","stock center","stock house","stock plus","tik lechol makom","אאוטלט","אאוטלט אילת","אאוטלט אשדוד","אאוטלט בילו","אאוטלט מודיעין","ביג","ביג סנטר","ג'ון בול","גן העיר","דיזנגוף סנטר","הכל ב 1","הכל ב 10","הכל ב 20","הכל ב 5","יפ דיל","כל בו אילן","כל בו אפי","כל בו דרור","כל בו האחים","כל בו השרון","כל בו ניצן","כל בו ענק","כל בו פרידנמן","כל בו פתח תקווה","כל בו תפוז","מלחה","מקס סטוק","מתחם g","מתחם המסחר","סטוק האוס","סטוק סנטר","סטוק פלוס","עזריאלי","צ'יפ דיל","קניון big fashion","קניון איילון","קניון גרנד","קניון הוד השרון","קניון השרון","קניון חיפה","קניון ירושלים","קניון לב המפרץ","קניון רחובות","קניון רננים","קניון תל אביב","רמת אביב סנטר","תיק לכל מקום"],"category":"קניות / ביגוד","subcategory":"Specialty retail"},
  {"keywords":["akerstein merkaz","askur center","askur menpazed","freidman sfarim","haahyanim","kol lakotev","ktavei yad","levin sfarim","menpazed center","merkaz hamore jerusalem","merkaz mila","mila rehavia","office depot jerusalem","office depot tel aviv","office max","office plus","office world","panda stationery","paper mart","polak","redley center","staples","steims stock haifa","stick","stick office","tzofim sfarim","אופיס דיפו ירושלים","אופיס דיפו תל אביב","אופיס וורלד","אופיס מקס","אופיס פלוס","אסקור מנפזד","אסקור מרכז","אקרשטיין מרכז","האחיינים","כל לכותב","כתבי יד","מילה רחביה","מנפזד מרכז","מספרי הצופים","מספרי לוין","מרכז המורה ירושלים","מרכז מילה","סטייפלס","סטים סטוק חיפה","סטיק","פולק","פייפר מארט","פנדה","פרידמן ספרי","רידלי מרכז"],"category":"קניות / ספרים","subcategory":"Stationery and office supplies"},
  {"keywords":["about you","aboutyou","anthropologie","asos","banggood","bloomingdales","boohoo","born pretty","desertcart","farfetch","fruugo","gearbest","jcpenney","macy's","macy\\","macys","matchesfashion","missguided","mr porter","nasty gal","nastygal","net a porter","net-a-porter","nordstrom","pretty little thing","prettylittlething","revolve","romwe","rozetka","saks","shein","temu","urban outfitters","wish","yoox","zaful","zalando","אבאוט יו","אורבן אאוטפיטרס","אנתרופולוג'י","אסוס","בוהוו","בורן פריטי","בלומינגדיילס","בנגוד","ג'יסיפניי","גירבסט","דזרטקארט","וויש","זאפול","זלאנדו","טמו","יוקס","ינג","מייסיס","מיסגיידד","מצ'ספאשן","מר פורטר","נורדסטרום","נט א פורטר","נסטי גאל","סאקס","ספאשן","פארפץ'","פארפץ\\","פרוגו","פריטי ליטל ת'ינג","רבולב","רוזטקה","רומווי","שיין"],"category":"קניות / ביגוד","subcategory":"Online shopping additional"},
  {"keywords":["balenciaga","brioni","burberry","celine","chanel","christian louboutin","dior","fendi","ferragamo","givenchy","gucci","hermes","isabel marant","jimmy choo","louboutin","louis vuitton","manolo blahnik","marc jacobs","max mara","miu miu","moncler","prada","saint laurent","salvatore ferragamo","stella mccartney","tiffany","tod's","tod\\","tods","valentino","versace","ysl","אילדומה","בורברי","בלנסיאגה","בריוני","ג'ימי צ'ו","גוצ'י","דיור","הרמס","וורסאצ'ה","וורסאצ\\","ולנטינו","ז'יבנשי","טוד'ס","טוד\\","טיפאני","יבנשי","ייקובס","ימי צ\\","כריסטיאן לובוטין","לואי ויטון","מאקס מארה","מונקלר","מיו מיו","מנולו בלאניק","מקס מארה","מרק ג'ייקובס","סטלה מק'קרטני","סטלה מק\\","סלבטור פרגמו","סלין","סן לורן","פנדי","פראדה","שאנל"],"category":"קניות / ביגוד","subcategory":"Luxury and designer brands"},
  {"keywords":["ahim yosef furniture","aloevera furniture","alon nagarim","alpi furniture","ara garden","carpenter","fun furniture","locksmith","masger","meatzvey bayit","merkaz hamizron","mitbach harsa","mitbach shish","mitbachei galil","mitbachei grand","mitbachei hanegev","mitbachei hasharon","mitbachei hatzafon","mitbachei ilan","mitbachei kfar saba","mitbachei melel","mitbachei ofna","nagar","rehitey gan","rehitey hakadur","rehitey hatzomet","rehitey luxor","rehitey mulan","rehitey new york","rehitey sharel","rehitey teomim","אחים יוסף רהיטים","אלוורה רהיטים","אלון נגרים","אלפי רהיטים","ארה רהיטי גן","מטבח חרסה","מטבח שיש","מטבחי אופנה","מטבחי אילן","מטבחי גליל","מטבחי גרנד","מטבחי הנגב","מטבחי הצפון","מטבחי השרון","מטבחי כפר סבא","מטבחי מלל","מסגר","מעצבי בית","מרכז המזרון","נגר","פאן רהיטים","רהיטי גן","רהיטי הכדור","רהיטי הצומת","רהיטי לוקסור","רהיטי מולן","רהיטי ניו יורק","רהיטי שראל","רהיטי תאומים"],"category":"קניות / רהיטים","subcategory":"Furniture additional"},
  {"keywords":["akiyam","bayit metzuyan","bayit metzuyan raanana","bayit tov","big zol labayit","em habayit","hakol labayit","hamerkaz labayit","home wonder","house center","kol hamutzarim labayit","kol labayit","kol labayit center","kol labayit plus","master home","matanot labayit","matanot leitzuv","merkaz habayit","stock home","super home","totzeret habayit","totzrei habayit","אם הבית","אקיים","ביג זול לבית","בית טוב","בית מצויין","בית מצוין רעננה","האוס סנטר","הוום וונדר","הכל לבית","המרכז לבית","כל המוצרים לבית","כל לבית","כל לבית סנטר","כל לבית פלוס","מאסטר הום","מרכז הבית","מתנות לבית","מתנות לעיצוב","סופר הום","סטוק הום","תוצרי הבית","תוצרת הבית"],"category":"קניות / רהיטים","subcategory":"Home goods small chains"},
  {"keywords":["american tourister","amerika lehul","ard travel","blisk","delsey","mizvadot center","mizvadot hatzafon","mizvadot hazri","mizvadot ofna","mizvadot paper","mizvadot plus","mizvadot zol","new travel","samsonite","travel center","travel line","travel plus","travel stock","travel world","trip","trip store","אמריקה לחו","אמריקה לחו\"ל","אמריקן טוריסטר","ארד טראבל","בליסק","דלסי","טראבל וורלד","טראבל סטוק","טראבל סנטר","טראבל פלוס","טראבליין","טריפ","טריפ סטור","מזוודות אופנה","מזוודות הצפון","מזוודות זול","מזוודות חזרי","מזוודות מרכז","מזוודות פלוס","ניו טראבל","ניירת מזוודות","סמסונייט"],"category":"קניות / ביגוד","subcategory":"Travel goods"},
  {"keywords":["פלוס","amazfit","apple watch","armani watches","diesel watches","electronic watches","fitbit","fossil watches","garmin","michael kors watches","suunto","swatch plus","tag heuer","tommy watches","watches commerce","watches haifa","watches mumchim","watches netanya","watches plus","watches yam","watches zol","withings","wonder watch","אמייזפיט","אפל ווץ'","אפל ווץ\\","ארמאני שעונים","גרמין","דקס","וויטינגס","וונדר ווץ'","טאג הוייר","טומי שעונים","מייקל קורס שעונים","סואנטו","סוואץ' פלוס","פוסיל שעונים","פיטביט","שעוני אלקטרוניק","שעוני הים","שעוני המומחים","שעוני זול","שעוני חיפה","שעוני נתניה","שעונים מסחר","שעונים פלוס"],"category":"קניות / תכשיטים","subcategory":"Watches additional"},
  {"keywords":["algae","atzot","calcium","ecopharm","energy plus","erika vitamins","findel","folic acid","iron supplement","magnesium","matzi med","melatonin","multivitamin","omega 3","probiotic","solgar omega","supherb israel","tivai supplement","vitamin b","vitamin c","vitamin d","zinc","אבץ","אומגה 3","אנרגיה אנד פלוס","אצות","אקופארם","אריקה ויטמינים","ברזל","ויטמין בי","ויטמין די","ויטמין סי","טבעי","מגנזיום","מולטיוויטמין","מלטונין","מצי מד","סולגאר אומגה","סופהר","פולית","פינדל","פרוביוטיקה","קלציום"],"category":"בריאות / תרופות","subcategory":"Cosmetic supplements"},
  {"keywords":["acana","advance","be one","blue buffalo","body guard pet","classic canin","feline","friskies","orijen","pedigree bowls","pro plan","protein pet food","royal vet","sensitive","sensitive pet","super beitzim","taste of the wild","taste wild","viscas","whiskas plus","yukanuba","אדבנס","אוריג'ן","אוריג\\","אקאנא","בודי גארד","ביוונד","בלו באפלו","וטרינר רויאל","ויסקאס פלוס","ויסקס","טסט אוף וויילד","יוקנובה","סופר ביצים","סינסיב","פדיגרי בולים","פליין","פרוטיין","פרופלן","פרסקיז","קלאסיק קנין"],"category":"קניות / חיות מחמד","subcategory":"Pet food brands"},
  {"keywords":["aborot","afikim israel","afikim transport","akko train","amtrak","annual rail pass","apple wallet transit","ashdod train","ashkelon train","barcelona metro","bart","beam","beam scooter","beersheba taxi","beersheba train","beit shemesh train","belgian rail","ben gurion taxi","ben gurion train","bird","bird scooter","blablacar","blablacar israel","bolt","bolt israel","bond","bond mobility","bts bangkok","cable car","captains mansion","carmel cruise","carmel metronit","carmelit haifa","carmiel train","carnival cruise","carpool il","carpool israel","cfir","child transport","cifir","city pass jerusalem","cosmo cab","costa","costa cruises","cruise","cruise israel","cyprus ferry","daily pass","dc metro","deutsche bahn","didi","disabled transport","dot","dot scooter","egged ta'avura","egged ta\\","egged taavura","egged taxi","egged tours","egged trips","elimelech cable","eurostar","extra","extra bus","ferry","fishing boat","free now","freenow","get taxi","get-taxi","gett booking","gett israel","gett ride","gett taxi","gett tlv","gettaxi","gold line","google wallet transit","greater anglia","green line","hadera train","haflaga","haifa cable car","haifa light rail","haifa sherut","haifa taxi","haifa train","hapoalim cab","har canaan cable","helbiz","helbiz scooter","herzliya train","hofshi chodshi","hofshi shavui","hofshi shnati","hofshi yomi","hop on","hopon israel","ice train","indriver","israel railways online","jerusalem light rail","jerusalem sherut","jerusalem taxi","jerusalem train","jordan river cruise","jr yamanote","kartisiya","katzrin train","kav adom","kav sagol","kav yarok","kav zahav","kfir","kfir transport","kiryat gat train","light rail station","lime","lime scooter","lod train","london tube","ma'aborot","madrid metro","mano cruises","masada cable car","mega cab","mesilaton","metro barcelona","metro dc","metro madrid","metro milan","metro paris","metro rome","metro tlv","metronit haifa","metropolitan tlv","migdal or cable","milan metro","minibus","mobike","modiin train","monit 11","monit 24","monit 4","monit 5","monit 7","monit avi","monit eilat","monit idan","monit plus","monit sherut","monit yozma","moniyot plus","monthly free","monthly free pass","monthly rail pass","monthly transit","moovit","moovit pass","moovit ride","moovit subscription","mrt","mrt singapore","msc cruises","mta","mta nyc","mtr","mtr hong kong","my taxi","mytaxi","nahariya train","navigo","navigo card","netanya train","network rail","northern rail line","norwegian cruise","ns dutch","ns dutch rail","nyc subway","obb","ofanei shitufim","ofo","ofo bike","oyster card","paid ride","paris metro","pinto cab","port cruise","princess cruise","public transport","purple line","rail ticket","rakevel","rakevet hashalom","rakevet savidor","rakevet tachtit","ramla train","ratp","rav cav","rav kav","rav kav monthly","rav kav online","rav kav recharge","rav kav top up","rav-kav","ravkav","ravkav online","red line","rehovot train","renfe","rome metro","royal caribbean","s bahn","s-bahn","saponim","sbb","scoo bee","scoobee","sea cab","senior transport","shared bicycles","shared bikes","shared ride","sherut taxi","shinkansen","snappcar","sncf","soldier transport","speed taxi","spin","spin scooter","student transport","subway israel","subway tlv","super bus","tachana cab","tachanat moniyot","taxi stand","tel aviv bike","tel aviv cabs","tel aviv light rail","tel aviv metro","tel aviv taxi","tel aviv train","tel o fun","tel ofan","tel-aviv bike","tel-o-fun","telofun","tfl","tgv","tier","tier mobility","tikni rail","tlv airport taxi","tlv bike","tlv port taxis","tlv sherut","tlv taxi","tlv taxis","togo","togo carpool","togo israel","tokyo subway","top taxi","tourist boat","train italia","train ticket israel","trans israel buses","transport for london","trenitalia","tube london","u bahn","u-bahn","u-bahn berlin","uber israel","uber tlv","underground","underground london","via rail","via rail canada","vienna u-bahn","voi","voi scooter","wallet pass","weekly pass","weekly transit","wind","wind scooter","yam lake tour","yamanote","yango israel","yango pro","yedidim cab","yedidim taxi","אגד תיירות","אגד-תעבורה","אובב","אובר איטס","אובר ישראל","אובר תא","אוטובוס 10","אוטובוס 11","אוטובוס 4","אוטובוס 5","אוטובוס 6","אוטובוס 7","אוטובוס 8","אוטובוס 9","אוטובוס אילת","אוטובוס אשדוד","אוטובוס אשקלון","אוטובוס באר שבע","אוטובוס בית שמש","אוטובוס בני ברק","אוטובוס הרצליה","אוטובוס חיפה","אוטובוס ירושלים","אוטובוס כפר סבא","אוטובוס מודיעין","אוטובוס נתניה","אוטובוס פתח תקווה","אוטובוס רחובות","אוטובוס רמת גן","אוטובוס תל אביב","אויסטר קארד","אופו","אופניים שיתופיים","אופנייני שותפים","אינדרייבר","אמטרק","אסאנסיאף","אקסטרא","אקסטרא בוס","אקסטרה","בולט","בונד קורקינט","ביירד","בים קורקינט","בירד קורקינט","בלהבלהקאר","גט טקסי","גט נסיעה","גט-טקסי","גמלאי תחבורה","דוט","דידי","הופאון","הלביז","הפלגה","הקו האדום","הקו הזהב","הקו הירוק","הקו הסגול","ווי נסיעה","ווי קורקינט","ווינד קורקינט","חוף הכרמל רכבת","חופשי חודשי","חופשי יומי","חופשי שבועי","חופשי שנתי","חוצה ישראל אוטובוסים","חייל תחבורה","טופ טקסי","טיג'יוי","טיג\\","טיר","טעינה רב-קו","טעינת רב קו","יאנגו ישראל","יאנגו פרו","ידידים מוניות","יוסטאר","ילד תחבורה","כפיר","כפיר רכבת","כפיר תחבורה","כרטיס אוטובוס","כרטיס חופשי חודשי","כרטיס חופשי-חודשי","כרטיס רכבת","כרטיסיה","כרטיסיית רכבת","ליים נסיעה","ליים קורקינט","ליפט","מאנו","מוביט","מובייק","מוניות 11","מוניות אבי","מוניות אגד","מוניות אילת","מוניות באר שבע","מוניות בן גוריון","מוניות חיפה","מוניות יוזמה","מוניות ירושלים","מוניות נמל ת\"א","מוניות נתב","מוניות נתב\"ג","מוניות עידן","מוניות פלוס","מוניות שירות חיפה","מוניות שירות ירושלים","מוניות שירות תל אביב","מוניות ת\"א","מוניות תא","מונית 24","מונית 4","מונית 5","מונית 7","מונית אבי","מונית קו 4","מונית קו 5","מונית שירות","מונית שירות תל אביב","מטרו לונדון","מטרו ת","מטרו ת\"א","מטרו תל אביב","מטרונית 1","מטרונית 2","מטרונית 3","מטרונית הכרמל","מטרונית חיפה","מטרופוליטן ת\"א","מטרופוליטן תא","מטרופוליטן תל אביב","מיי טקסי","מינוי חודשי רכבת","מינוי רב קו","מינוי רכבת","מינוי שנתי רכבת","מיני בוס","מיניבוס","מנוי חודשי תחבורה","מנוי יומי","מנוי שבועי","מנוי שבועי תחבורה","מסילה הצפונית","מסילתון","מסילתון נסיעות","מעבורת","מעבורת לקפריסין","נכה תחבורה","נסיעה בגט","נסיעה בתשלום","נסיעה משותפת","נסיעות אגד","נסיעת אוטובוס","סאבוויי ניו יורק","סאן פרנסיסקו מטרו","סופר בוס","סטודנט תחבורה","סירת דייגים","סירת תיירים","ספין קורקינט","ספנות","סקובי","פרי נאו","קו 10","קו 100","קו 11","קו 12","קו 13","קו 14","קו 142","קו 15","קו 16","קו 174","קו 18","קו 189","קו 19","קו 20","קו 21","קו 22","קו 224","קו 24","קו 240","קו 25","קו 4","קו 40","קו 47","קו 480","קו 488","קו 5","קו 51","קו 6","קו 61","קו 66","קו 7","קו 70","קו 8","קו 89","קו 9","קו 947","קו 950","קו אדום","קו זהב","קו ירוק","קו סגול","קווי אילת","קווי באר שבע","קווי בני ברק","קווי הדרום","קווי הצפון","קווי חיפה","קווי ירושלים","קווי ת","קווי ת\"א","קווי תא","קוסמו קאב","ראבע","רב קו אונליין","רב קו חודשי","רב קו טעינה","רבקו","רכבל","רכבל אלימלך","רכבל הר כנען","רכבל חיפה","רכבל מגדל אור","רכבל מנרה","רכבל מצדה","רכבת אוניברסיטה","רכבת אשדוד","רכבת אשקלון","רכבת באר שבע","רכבת בית שמש","רכבת בן גוריון","רכבת ההגנה","רכבת הרצליה","רכבת השלום","רכבת השלום ת\"א","רכבת חדרה","רכבת חיפה","רכבת ירושלים","רכבת ירושלים יצחק נבון","רכבת ישראל אונליין","רכבת כרמיאל","רכבת לוד","רכבת מודיעין","רכבת נהריה","רכבת נתב","רכבת נתב\"ג","רכבת נתבג","רכבת נתניה","רכבת סבידור","רכבת עכו","רכבת קלה חיפה","רכבת קלה ירושלים","רכבת קלה קו אדום","רכבת קלה קו ירוק","רכבת קלה קו סגול","רכבת קלה ת\"א","רכבת קלה תא","רכבת קלה תל אביב","רכבת קצרין","רכבת קרית גת","רכבת רחובות","רכבת רמלה","רכבת ת","רכבת ת\"א","רכבת תא","רכבת תחתית","רכבת תל אביב","רנפה","שייט בנהר הירדן","שייט בנמל","שינקנסן","שירות מונית","תח'צ","תחנת מוניות","תחנת רכבת אוניברסיטה","תחנת רכבת באר שבע","תחנת רכבת בן גוריון","תחנת רכבת ההגנה","תחנת רכבת השלום","תחנת רכבת חיפה","תחנת רכבת ירושלים","תחנת רכבת סבידור","תחנת רכבת קלה","תחנת רכבת ת","תחנת רכבת ת\"א","תח״צ","תיקני","תל אביב מוניות","תל אופן","תל-אופן","תעריף אוטובוס"],"category":"תחבורה","subcategory":"תחבורה ציבורית"},
  {"keywords":["ayalon interchange","carmel tunnel fee","carmel tunnels","carmel tunnels highway","cross israel highway","derech eretz","fast lane","fast lane israel","fast lane tlv","fast lane toll","fast lane נתיב מהיר","highway 431","highway 471","highway 531","highway 553","highway 6","highway 6 north","highway 6 south","iron interchange","itc toll","itc כביש 6","kvish 6","maaziv 6","machzik 6","nativ 6","nativ mahir","route 6","shapir highway","shapir כביש","shapirim interchange","sorek interchange","toll road","toll road 6","trans israel","trans israel highway","trans israel toll","tunnel fee","tunnel toll","אגרת חוצה ישראל","אגרת כביש 6","אגרת מנהרות","אגרת נתיב מהיר","דרך ארץ","דרך ארץ הייווי","חוצה ישראל","חוצה ת","חוצה ת\"א נתיב מהיר","כביש 431","כביש 471","כביש 531","כביש 553","כביש 6 אגרה","כביש 6 דרום","כביש 6 צפון","כביש אגרה","כביש חוצה ישראל","כביש שש","מחזיק 6","מחלף איילון","מחלף סורק","מחלף עירון","מחלף שפירים","מנהרות הכרמל","מנהרות מחיר","מנהרת הכרמל אגרה","נתיב 6","נתיב מהיר"],"category":"תחבורה","subcategory":"כביש 6"},
  {"keywords":["24 carwash","ac delco","ac gas refill","ac רכב","accessories for car","accident repair","acdelco","acura service","adir garage","air filter","alfa romeo garage","alignment","all season tire","alpha halafim","alpha spare parts","alpine","alpine car audio","alternator","amit garage","annual service","antifreeze","arie garage","armored insurance","asf auto","audi garage","authorized garage","auto car wash","auto care","auto depot","auto dpi","auto garage","auto i","auto parts","auto world","auto-dpi","auto-i","autoglass","autoplex","autoplex garage","avi spare parts","avidan parts","avidan חלפים","avishai garages","aviv garage","banner battery","battery","better place","bf goodrich","bfgoodrich","bizziness auto","bmw garage","bmw parts","body shop","body work and paint","bolmei zaazuim","boogie","bosch","bosch auto parts","bosch wipers","brake cylinder","brake discs","brake drums","brake fluid","brake oil","brake pads","brake replacement","brake system","bridgestone","bubble wash","bushing","byd service","car ac","car ac repair","car accessories","car audio system","car cooler","car garage","car heater","car multimedia","car paint","car polish","car repair","car service","car wash","car wash 24","car wax","carglass","carmiel garage","charge point","chargepoint","charging station","charging station israel","charging stations","chery service","chevrolet garage","citroen garage","clutch","computer diagnostics","continental","continental tires","convert to electric","coolant water","cooper tires","dalia garages","damage repair","delek drive","disks bilum","egzoz","eilat garage","electra charging","electric charging","electric garage","els halafim","els spare parts","els חלפים","engine cooler","engine diagnostics","engine wash","ev battery","ev box","ev charger","ev-box","exhaust","exhaust system","exide battery","extended insurance","falken","fattal green","fiat garage","firestone","flex auto","flexauto","ford garage","fox plus","fuel filter","gal garage","galaxy glass","garage","garage center","gearbox","geely service","geometria","gilon garage","goodyear","google maps","gouri garage","gps israel","green mobility","greenmobility","haifa licensing","halafei avi","halafim","halahmis tires","halkei chiluf","halogen","hankook","harechev garage","headlights","hella","honda garage","hyundai garage","infiniti service","infinity auto","infinity car service","interior cleaning","iron tires","israeli glass","jeep garage","jerusalem licensing","kaspi garages","kenwood","kenwood audio","kia garage","kumho","land rover service","led headlight","lexus service","licensing center","lithium battery car","lucid service","magna","magna car","magnetti marelli","mahle","mahle filter","main light","major service","mann filter","manual wash","maserati service","matne'a","matne\\","mazda garage","mercedes garage","mercedes parts","metzanen","mg service","michelin","mini service","ministry of transportation","minor service","mister auto","mister auto il","mister auto israel","mitsubishi garage","moovit","mot","mr service","mr wash","multimedia installer","multimedia system","musach","musach mahir","myauto","nahum garage","navigation system","nesher car wash","netanya garage","nimrod garage","nissan garage","nokian","north garage","north tires","northern mesilon","obd scanner","oil change","oil filter","opel garage","ozel beled","pachach","pachachut","panchar","paz electric","peugeot garage","pioneer","pioneer audio","pirelli","polestar service","polish rechev","polishant","polygon check","porsche service","premium auto","premium garage","puncher","puncher repair","puncture","quick garage","quick service","quick wash","radiator","range rover service","rear window","reflectors","renault garage","rivian service","rob's garages","robs garages","s garages","sachs","sec auto","service 10000","service 15000","service 20000","shock absorbers","shtifat rechev","side mirror","sika","sika windshield","skoda garage","smart service","sonol drive","south garage","spare parts","spare parts israel","spark plugs","speed auto","splash car wash","splash carwash","springs","starter motor","steering column","steering stabilizer","steering system","step","step charge","subaru service","summer tire","suzuki garage","taillights","tesla garage","tesla service","tesla supercharger","tikun rechev","tipul rechev","tire fee","tire garages","tire inflation","tire replacement","tire wear","tlv licensing","tnuva garages","tommy wash","total auto","toyo","toyo tires","toyota garage","transmission","turbo","tzeva rechev","tzmigei hatzafon","valeo","varta battery","volkswagen garage","volta battery","volvo garage","volvo parts","waze","wexler garages","wheel alignment","wheel balancing","wheel ladder","wheel service","windshield","winter tire","wipe out","wiper","wiper blade","wipers","wipers israel","wisecar","woody car wash","woody carwash","wurth israel","xenon","yad 2 auto","yarok rechev","yasur car service","yifat israel","yifat israel glass","yokohama","yossi greenberg tires","zeevi garage","zf parts","zonsom","אאודי שירות","אבחון מנוע","אביזרי רכב","אביזרים לרכב","אגזוז","אגרת צמיג","אוטו dpi","אוטו איי","אוטו די פי איי","אוטו די.פי.איי","אוטו דיפו","אוטו פלקס","אוטו-איי","אוטוגלאס","אוטופלקס","אופל שירות","אי סי דלקו","איזון גלגלים","אינפיניטי שירות","אינפיניטי שירות רכב","אלטרנטור","אלפא חלפים","אלקטרה טעינה","אנטיפריז","ב.מ.וו שירות","בוגייז","בולמי זעזועים","בוש חלפים","ביזנס אוטו","ביטוח מורחב","ביטוח שריון","בלאי צמיג","ברידג'סטון","ברידג\\","ג'יפ שירות","גוגל מפות","גודייר","גרין מובילטי","גרינברג צמיגים","דיסקים בלם","האנקוק","הונדה שירות","החלפת בלם","החלפת בלמים","החלפת מצמד","החלפת צמיג","החלפת צמיגים","החלפת שמן","החלפת שמן רכב","הלה","הלחמיס","הלחמיס צמיגים","המרה לחשמלי","וודי","וודי קאר ווש","ווייז","וויסקאר","וולוו שירות","ווקס רכב","ולאו","וקסלר מוסכים","זאקס","זונסום","חלפי אבי","חלפים","חלקי חילוף","טויו","טויוטה שירות","טורבו","טיפול 10000","טיפול 15000","טיפול 20000","טיפול גדול","טיפול קטן","טיפול רכב","טיפול שנתי","טסלה שירות","טעינה חשמלית","יונדאי שירות","יוסי גרינברג צמיגים","יוקוהמה","ייצוב","ייצוב הגה","יסעור","יסעור שירותי רכב","יפ שירות","ירוק רכב","כיוון גלגלים","כספי מוסכים","להב מגב","לקסוס שירות","מאזדה שירות","מאן פילטר","מגב","מגבים","מהלה","מולטימדיה רכב","מוסך","מוסך bmw","מוסך אאודי","מוסך אביב","מוסך אדיר","מוסך אוטו פלקס","מוסך אופל","מוסך אילת","מוסך אלפא רומיאו","מוסך אריה","מוסך ג'יפ","מוסך ג\\","מוסך גורי","מוסך גילון","מוסך גל","מוסך הדרום","מוסך הונדה","מוסך הצפון","מוסך הרכב","מוסך וולוו","מוסך זאבי","מוסך חשמלי","מוסך טויוטה","מוסך טסלה","מוסך יונדאי","מוסך כרמיאל","מוסך מאזדה","מוסך מהיר","מוסך מורשה","מוסך מיצובישי","מוסך מרצדס","מוסך נחום","מוסך ניסאן","מוסך נמרוד","מוסך נתניה","מוסך סוזוקי","מוסך סיטרואן","מוסך סקודה","מוסך עמית","מוסך פולקסווגן","מוסך פורד","מוסך פיאט","מוסך פיג'ו","מוסך פרימיום","מוסך קיה","מוסך רובס","מוסך רנו","מוסך שברולט","מוסכי אבישי","מוסכי דליה","מוסכי הצמיג","מוסכי תנובה","מזגן רכב","מטען חשמלי לרכב","מטען רכב חשמלי","מי בלם","מיי אוטו","מילוי גז מזגן","מים למצנן","מיני שירות","מיסטר אוטו","מיסטר-אוטו","מיצובישי שירות","מישלין","מכון רישוי חיפה","מכון רישוי ירושלים","מכון רישוי תל אביב","מסטר אוטו","מסילתון הצפוני","מערכת בלמים","מערכת הגה","מערכת מולטימדיה","מערכת ניווט","מערכת פליטה","מערכת קול לרכב","מצבר exide","מצבר באנר","מצבר וולטה","מצבר ורטא","מצבר לרכב","מצבר רכב","מצברים","מצמד","מצמן רכב","מצנן","מצנן מנוע","מצתים","מראה צד","מרצדס שירות","מתנע","מתקין מולטימדיה","מתקני טעינה","נוזל בלם","נוקיאן","ניסן שירות","ניפוח אוויר","ניפוח גלגלים","ניקוי פנים","נשר ווש","נשר שטיפת רכב","סובארו שירות","סוזוקי שירות","סוללת ליתיום רכב","סוללת רכב חשמלי","סולמי גלגלים","סופר צ'רג'ר","סופר צ\\","סורק obd","סמארט שירות","סנטר מוסכים","ספלאש","סקודה שירות","פוליגון בודק","פוליש רכב","פולישנט","פולקסווגן שירות","פוקס פלוס","פורד שירות","פורשה שירות","פחח","פחחות וצבע","פיאט שירות","פיג'ו שירות","פיג\\","פילטר אויר","פילטר דלק","פילטר שמן","פיריוסטון","פירלי","פלגים","פלקן","פלקס אוטו","פנס ראשי","פנסים","פנסים אחוריים","פנצ'ר","פנצר","פצירות בלם","פתאל גרין","צבע רכב","צילינדר בלם","צמיג all season","צמיג חורף","צמיג קיץ","צמיגי איירון","צמיגי הצפון","צמיגי עירון","ק.ו 24","קאר ווש 24","קארגלאס","קארגלס","קומהו","קונטיננטל","קופר צמיגים","קיה שירות","קפיצים","רובס","רובס מוסכים","ריפודי בלם","רנו שירות","שטיפה אוטומטית","שטיפה ידנית","שטיפת מנוע","שטיפת רכב","שמשה אחורית","שמשה קדמית","תא הגה","תופי בלם","תחנת הטענה","תחנת טעינה","תיבת הילוכים","תיקון מזגן רכב","תיקון פגיעה","תיקון פנצ'ר","תיקון פנצ\\","תיקון רכב","תיקון תאונה","תכשיר נגד קור","תנור רכב"],"category":"תחבורה","subcategory":"מוסך"},
  {"keywords":["alamo","alamo rent","albar","annual car rental","auto europe","autocard","autonation","autotel","avis eilat","avis leasing","budget","budget rent a car","capitol auto","car 2 go","car leasing","car rental","car share","car2go","carmel","carmel rent a car","carmel rental","cdw","collision damage waiver","commercial vehicle rental","convertible rental","daily car rental","dollar rent a car","drive now","driveme","drivenow","drivy","el al rent a car","eldan","eldan eilat","eldan leasing","enterprise","enterprise rent","europcar","getaround","greenwheels","hertz 24/7","hertz 247","hertz eilat","jeep rental","kal auto","kilometers ללא הגבלה","leasing rechev","minibus rental","mobilix","monthly car rental","orix","orix leasing","pacific rent a car","rent a car israel","rent plus","rental for trip","rental insurance","royal rent","shlomo leasing","shlomo sixt","sixt","sixt eilat","sixt international","super cdw","tamir rent a car","third party cover","thrifty","tpc","turo","universal","universal israel","unlimited km","wibe","zipcar","אבי ליסינג","אביס אילת","אביס השכרת רכב","אוטו אירופה","אוטו טל","אוטוטל","אוריקס","אורקס ליסינג","אלבר","אלבר ליסינג","אלדן","אלדן אילת","אלדן השכרת רכב","אלדן ליסינג","אלמו","אנטרפרייז","באדג'ט","באדג'ט השכרת רכב","באדג\\","ביטוח השכרה","גטאראונד","גרין וילס","דולר השכרה","הרץ אילת","הרץ השכרת רכב","השכרת ג'יפ","השכרת ג\\","השכרת מיני באס","השכרת קבריולט","השכרת רכב","השכרת רכב חודשית","השכרת רכב יומית","השכרת רכב לטיול","השכרת רכב מסחרי","השכרת רכב שנתית","זיפקאר","ט השכרת רכב","טורו","טריפטי","יוניברסל","יוניברסל השכרה","יורופקאר","ליסינג רכב","סיקסט","סיקסט אילת","קאר טו גו","קל אוטו","שלמה sixt","שלמה ליסינג","שלמה ליסינג רכב","שלמה סיקסט"],"category":"תחבורה","subcategory":"השכרת רכב"},
  {"keywords":["מהאל","achziv","acropolis","airbnb israel","allenby bridge","ammunition hill","amsalem","amsalem tours","asia travel israel","asia trips","australia visa","autopus team","av hatzofim","avdat","beit shean","berlin welcome card","biblical zoo","bicester village","biometric passport","birthright","birthright israel","bookatable","booking.com israel","border crossing","border crossing israel","caesarea","camping gardens","camping israel","camping north","camping northern israel","canada visa","cedar point","cheap flights","children museum","china visa","christian tours","city beach","city of david","city tax","colosseum","crossing aqaba","dahab","dead sea","departure tax","diesenhaus","diesenhaus unitours","disney world","disneyland paris","disneyland tokyo","dizengoff travel","dubai visa","eiffel tower","eilat aquarium","eilat border","ein gedi","ein gedi trips","eshet tours","esta usa","esta visa","eurail","eurodisney","ferry eilat petra","ganei camping","get your guide","getyourguide","goto travel","great wall","green card","green card parks","gulul","gulul tours","haganah museum","holiday check","holiday lebanon","holidaycheck","homeaway","hotel tax","hotels","hotwire","hurghada","india visa","interrail","israel museum","israel travel","israel travel co","issta","issta lines","issta travel","jerusalem aquarium","jewish heritage tours","jr pass","klook","knafayim","kotel tunnels","lametayel","lametayel המטייל","last minute travel","lastminute","legoland","lisboa card","london pass","louvre","ma'avar gvul","ma\\","mar'av hatzofim","masa israel","masada festival","masada theatre","masada tickets","mikve israel","mishal","mishal travel","mitzpe hayamim","mona tours","national library","national park","national parks israel","nature parks authority","new passport","new york pass","niagara falls","omega kfar blum","onward israel","open sky","open sky israel","opentable","orbitz","overnight parking sites","palm park","paris pass","park asterix","park timna","parthenon","passport card","passport renewal","passportcard","petra","petra jordan","pilgrim tours","port tax","priceline","pyramids giza","resort fee","resy","river jordan crossing","roma pass","russia visa","safari","safari ramat gan","safir","safir tours","sar el","savanna africa","schengen visa","sharm el sheikh","sheikh hussein bridge","sherry travel","sinai egypt","six flags","skyscanner","spa tax","taba","taj mahal","tasa li","team park","tel beer sheva","tel megiddo","thailand visa","the fork","thefork","timna park","tiqets","tlv museum","tlv museum of art","tlv zoo","tokyo pass","tourism tax","tourist visa","travel agent","travel concept","travel insurance","travel israel","travel tax","travelocity","travelup","trip planner","tripadvisor","tripplanner","trips israel","tzimmer","tzimmer dead sea","tzimmer ein gedi","tzimmer galilee","tzimmers galilee","tzimmers golan","tzimmers kinneret","tzimmers negev","tzimmers north","tzimmers south","universal studios","usa visa","vacation tzimmer","vacation villa","vatican","versailles","viator","vienna pass","vietnam visa","villa kinneret","villa north","visa australia","visa canada","visa china","visa dubai","visa india","visa russia","visa schengen","visa thailand","visa usa","visa vietnam","volunteer tours","vrbo","wadi rum","walt disney","water tunnels nes tziona","wooden cabins","wyndham","yad vashem","yad2 zimmers","yad2 צימרים","yala","yalla","yalla tours","yallatour","yarkon park","yitzhak rabin crossing","yoresh card","zen trip","zentrip","zimmeril","zimmers for sites","zimmers.com","אבדת","אוטופוס תים","אומגה כפר בלום","אופן סקאי","אורביץ","אייר בי אנד בי","איסטא","איסתא","אכרזיב","אמסל","אמסל נסיעות","אקווריום אילת","אקווריום ירושלים","אקספדיה","אקרופוליס","אשת תיירות","אתרי חניון לילה","ביומטרי","ביטוח נסיעות","בית הספרים","בית שאן","בקתות עץ","ג'ייאר פאס","גבול אילת","גט יור גייד","גלל טורס","גן החיות התנכי","גן החיות תל אביב","גן חיות תנכי","גן לאומי","גני קמפינג","גשר אלנבי","דהב","דיזנגוף נסיעות","דיזנהאוז","דיזנהאוז יוניתורס","דיסנילנד פריז","דמי מתקני","דרכון חדש","ה מטיילים","הורגדה","החומה הסינית","המטייל","ואדי ראם","וויאטור","ווינדהאם","וותיקן","ויארביאו","ויזה esta","ויזה אוסטרליה","ויזה ארהב","ויזה הודו","ויזה וייטנאם","ויזה סין","ויזה קנדה","ויזה רוסיה","ויזה תיירות","ויזת שנגן","וילה בכנרת","וילה בצפון","וילה לחופשה","ורסאי","חוף הים העיר","חוף ים","חידוש דרכון","טאבה","טאג' מהאל","טיסות זול","טיקטס","טסה לי","טראבל קונספט","טראבלוסיטי","טריוואגו","טריפאדויזר","יאל","יאל\"א","יאל\"ה מטיילים","יאלה","יד ושם","יורייל","ים המלח","כנפיים","כנפיים נסיעות","כרטיס יורש","כרטיס ירוק","לגולנד","לובר","לונדון פאס","מגדל אייפל","מוזיאון ההגנה","מוזיאון הילדים","מוזיאון השואה","מוזיאון ישראל","מוזיאון תל אביב","מוזיאון תל אביב לאמנות","מונה טורס","מנהרות הכותל","מנהרות מים בנס ציונה","מס יציאה","מס מלון","מס נמל","מס נסיעה","מס עיר","מעבר גבול","מעבר גבול נהר הירדן","מצדה","מצדה כרטיסים","מצדה תיאטרון","מצפה הימים","מקווה ישראל","מרחב הצופים","נסיעות אסיה","נסיעות עין גדי","סוואנה אפריקה","סוכן נסיעות","סיני","ספארי","ספארי רמת גן","ספיר","סקייסקנר","עיר דוד","פארק הירקון","פארק התמרים","פארק תים","פארק תמנע","פטרה","פירמידות גיזה","פסטיבל מצדה","פספורט קארד","פספורטקרד","פרייסליין","צימר","צימר galilee","צימר זוגי","צימר חופשה","צימר ים המלח","צימר משפחתי","צימר עין גדי","צימריל","צימרים בגליל","צימרים בדרום","צימרים בכנרת","צימרים בנגב","צימרים בצפון","צימרים ברמת הגולן","צימרים לאתרים","צימרס.קום","קולוסיאום","קייאק","קיסריה","קלוק","קמפינג ישראל","רשות הטבע והגנים","שארם אל שייח","תגלית","תל מגידו"],"category":"תחבורה","subcategory":"תיירות"},
  {"keywords":["אילת","abraham hostel","aman hotels","arbel hotel","aria hotel","astoria hotel","b&b","backpackers","bed and breakfast","beit bnei brak","beit oren","beresheet","beresheet hotel","best western","bnb","boutique hotel","brown beach","brown beach house","brown hotels","brown house tlv","brown mid town","brown midtown","brown tlv","brown tlv house","carlton","carlton hotel tlv","carlton tel aviv","carmel forest spa","carmel forest spa resort","comfort inn","cromwell hotel","crowne plaza","cucu","cucu hotel","dan caesarea","dan carmel","dan eilat","dan hotel","dan hotels","dan jerusalem","dan panorama","dan tel aviv","daniel dead sea","daniel herzliya","daniel hotel","david citadel","days inn","eden hotel","fattal","fattal hotels","four seasons","four seasons hotel","gilda hotel","hagoshrim","hagoshrim hotel","herods","herods eilat","herods jerusalem","herods tel aviv","herods vitalis","hilton","hilton jerusalem","hilton tel aviv","hod hamidbar","holiday inn","hostel","hostelling international","hostelworld","hyatt","hyatt regency","indigo","indigo hotel","intercontinental","isrotel","isrotel agamim","isrotel king solomon","isrotel lagoona","isrotel royal beach","kibbutz ginosar","kibbutz hotel","kibbutz lavi","kibbutz nof ginosar","king david","le meridien","leonardo","leonardo beach","leonardo boutique","leonardo club","leonardo israel","leonardo plaza","leonardo royal","leviathan hotel","lot hotel","magic kibbutz","mamilla hotel","mariott","marriott","masada hostel","massada hostel","meridien","merkaz hotel","metropolitan hotel","mitzpe ramon","mitzpe ramon hotel","motzkin hotel","neot midbar","neve ilan","nirvana spa","nirvana spa hotel","nof ginosar","norman","norman tel aviv","norman tlv","novotel","olive hotel","pastoral kfar blum","pastoral kibbutz","pension","place","place hotel","praga hotel","prima hotel","prima hotels","ramada","ramada hotel","ramada israel","ramat rachel","ramat rachel hotel","ramat razim","ramon inn","renaissance","rimonim","rimonim dead sea","rimonim galei kinneret","rimonim hotels","ritz carlton","royal beach","royal beach eilat","royal boutique","royal garden","royal hotel","sea net","sea net hotel","selina","selina hotel","setai","setai tel aviv","sheraton","sheraton moriah","sheraton tel aviv","six senses","spa club dead sea","stay inn","tel aviv hostel","tlv hostel","tower tel aviv","tower tlv","u coral beach","u hotels","u magic","u splendid","u suites","vert","vert hotels","w hotel","waldorf astoria","waldorf astoria jerusalem","westin","westin tel aviv","yam","yam hotel","yam suf akko","yam suf hotel","yarden hotel","yearim hotel","אברהם הוסטל","אינדיגו","אינטרקונטיננטל","ארבעת העונות","בסט ווסטרן","ברון","ברשית","גילדה","דוד המלך","דייז אין","דן אילת","דן הוטל","דן ירושלים","דן כרמל","דן פנורמה","דן קיסריה","דן תל אביב","דניאל","הגושרים","הוד המדבר","הוליידיי אין","הוסטל","הוסטלוורלד","הייאט","הייאט רידג'נסי","הייאט רידג\\","הילטון","הילטון ירושלים","הילטון ת\"א","המלון הנורמן","הרודס","הרודס אילת","הרודס ירושלים","הרודס תל אביב","וולדורף אסטוריה","ווסטין","יאם","יאם מלון","יו מג'יק","יו מג\\","יו ספלנדיד","ים סוף akko","ים סוף עכו","ישרוטל","ישרוטל אילת","לאונרדו","לאונרדו פלאזה","מלון beresheet","מלון w","מלון אדן","מלון אסתוריה","מלון ארבל","מלון בוטיק","מלון דניאל ים המלח","מלון המלך דוד","מלון ים סוף","מלון יערים","מלון לאוניתן","מלון לאונרדו","מלון לוט","מלון מוצקין","מלון מטרופוליטן","מלון מרידיאן","מלון מרכז","מלון נאות מדבר","מלון נובוטל","מלון נווה אילן","מלון פראיגי","מלון פרימה","מלון קיבוץ","מלון רויאל","מלון רויאל בוטיק","מלון רויאל ביץ'","מלון רויאל ביץ' אילת","מלון רויאל גארדן","מלון רויאל גרדן","מלון רימונים","מלון רמדה","מלונות פתאל","ממילא מלון","מצפה רמון","מריוט","נירוונה","סטאי","סלינה","פלייס","פלייס מלון","פנסיון","פסטורל כפר בלום","פתאל","קראון פלאזה","קרלטון ת","קרלטון ת\"א","קרלטון תל אביב","רימונים","רימונים בים המלח","רימונים גלי כנרת","ריץ קרלטון","ריץ-קרלטון","רמת רחל","רנסנס","שרתון","שרתון ת\"א","תרמילאים"],"category":"תחבורה","subcategory":"מלונות"},
  {"keywords":["aaa movers","aaa הובלה","aaa הובלות","achsana","apartment moving","aramex","argaz boutique","bezeq cargo","capital exchange","capital forex","car financing","car loan","car purchase","car sale","car storage","cargo israel","carmeli moves","change","change exchange","cheap movers","chronopost","containers","courier mail","cubes","cubes storage","currency exchange","dan app","designer moves","dhl","dhl israel","doral logistics","dpd","egged app","egged online","egged tour bus","electric skateboard","eshel travel","exchange bureau","fast mover","fedex","fedex israel","forex center","forex מרכז","furniture storage","get pack","globus logistics","gw logistics","haifa exchange","hermes israel","hop on hop off","hovalot lakol","jerusalem exchange","levy moving","maersk","masa trips","masa נסיעות","miklat ichsun","mini storage","ministry of transport","minivan","money changer","money gram","moneygram","moovit app","mot israel","motorcycle rental","moving boxes","moving vehicle","msc cargo","net 4 u","net 4u","netivei israel","new car purchase","nili movers","nili moves","ofakim shipping","office moving","ono car sales","orchel hovalot","oren exchange","passenger ticket","personal travel accident","photo storage","public storage israel","rav kav army","rechev hovalot","registered mail","ride hailing","ride to work","saliban moves","sea air","self storage","self storage israel","shipping containers","skateboard rental","social trips","storage","storage mart","storage shelter","storage warehouse","tlv exchange","tlv storage","tnt express","tnufa","tourist bus","transport ministry","transportation authority","travel reimbursement","ups","ups israel","used car","used motorcycle","van rental","western union","wolt drive","work commute","yad2 car","yad2 רכב","yam suf exchange","yango deliveries","yefe nof","zim","zim shipping","אגד אונליין","אוטובוס תיירותי","אונו מכירת רכבים","אופנוע השכרה","אופנוע יד שניה","אורכל הובלות","אחסון עצמי","אחסון רהיטים","אחסון רכב","אחסון תמונות","אחסנה","אכסון תל אביב","אפליקציית אגד","אפליקציית דן","אפליקציית מוביט","ארגז בוטיק","אריזות הובלה","ארמקס","אש\"ל נסיעות","ביטוח תאונות אישיות נסיעה","דואר רשום","דואר שליחים","די אייץ' אל","הובלות זול","הובלות לכל","הובלת דירה","הובלת משרד","החזר נסיעות","הלוואת רכב","המרת מטח","ואן השכרה","ווסטרן יוניון","חלפן אורן","חלפנות אורן","חלפנות חיפה","חלפנות ים סוף","חלפנות ים סוף ת","חלפנות ים סוף ת\"א","חלפנות ירושלים","חלפנות ת\"א","חלפנות תל אביב","טיולים סוציאליים","יאנגו משלוחים","יד2 רכב","יפה נוף","כרטיס נוסע","כרמלי הובלות","לוי הובלות","מאני גראם","מארסק","מוביל מהיר","מחסן אחסון","מימון רכב","מיני אחסון","מיני ואן","מיניוואן","מכולות","מכירת רכב","מעצב הובלות","מעצב הובלות בע","מעצב הובלות בע\"מ","מקלט אחסון","משרד התחבורה","נילי הובלות","נסיעה לעבודה","נסיעת עבודה","נציבות התעבורה","נתיבי ישראל","סי אייר","סלבן הובלות","סקייטבורד חשמלי","פדקס","צים","קיוּבּס","קניית רכב","קניית רכב חדש","רב קו צבאי","רב-קו צבא","רכב הובלות","רכב יד שניה","תנופה"],"category":"תחבורה","subcategory":"שונות"},
  {"keywords":["דוד המלך","פאס","4e arkia","4e טיסה","6h israir","6h טיסה","aadvantage","abu dhabi airport","aegean airlines","aegean greece","aeroflot","aerolineas argentinas","aeromexico","af air france","af טיסה","ai air india","air algerie","air arabia","air arabia israel","air asia","air berlin","air cairo","air canada","air china","air europa","air france af","air india","air malta","air new zealand","air seychelles","air tahiti","air transat","airasia","airport tax","ajet","alaska airlines","albatros","albatros airways","albawings","alitalia","all nippon airways","allegiant","ams","amsterdam schiphol","ana","ana airways","anadolu jet","arkia airlines","arkia flight","arn","arrival tax","asiana","asiana airlines","ath","athens airport","atl","atlanta airport","auh","austrian airlines","avianca","award flight","ay finnair","ay טיסה","az ita","azul","azul airlines","ba british airways","ba טיסה","baggage fee","baggage upgrade","bahamas air","bangkok airport","bangkok don mueang","barcelona airport","bcn","beijing capital","ben gurion airport","ben gurion airport israel","ben gurion terminals","ber","berlin airport","bgn","bicycle cargo","biman bangladesh","bkk","bluebird airways","bom","booking flight","bos","boston airport","british airways ba","bru","brussels airlines","brussels airport","bud","budapest airport","buenos aires","business class","cancellation fee","carrier imposed","cathay pacific","cathay pacific cx","cdg","cebu pacific","change fee","charles de gaulle","charter flight","charters","check in","check-in","chicago airport","children discount","children discount flight","china eastern","china southern","concierge airport","connecting flight","copenhagen airport","corendon","cph","croatia airlines","cx cathay","cx טיסה","cyprus airways","czech airlines","dallas airport","del","delhi airport","delta dl","departure tax","dfw","diners lounge","direct flight","dl delta","dl טיסה","dmk","domestic flight israel","domestic flights","dubai airport","dus","dusseldorf airport","dxb","eagle air","easyjet israel","economy class","economy plus","edelweiss","edelweiss air","egypt air","egyptair","eilat airport","ek emirates","el al flight","el al israel","el al israel airlines","emirates","ethiopian airlines","etihad","etihad airways","etm","eurowings","ewr","excess baggage","expediter","ey etihad","eze","fast track","fast track airport","fco","finnair ay","first class","flight aware","flight booking","flight radar","flight subscription","flight ticket","flight to eilat","flight to haifa","flight to ramon","flightaware","flightradar","flightradar24","flydubai","flydubai israel","flying blue","fra","frankfurt airport","freebird","freebird airlines","frequent flyer","frequent flyer israel","frontier","frontier airlines","fuel surcharge","garuda indonesia","gatwick","geneva airport","gol","gol airlines","golf bag","gru","gulf air","gva","haifa airport","hainan","hainan airlines","halal meal","ham","hamburg airport","haneda tokyo","hawaiian airlines","heathrow","hel","helsinki airport","herzliya airport","hfa","hh israir","hh טיסה","hkg","hnd","hong kong airlines","hong kong airport","iad","iberia","iberia airlines","icn","indigo airlines","infant discount","infant discount flight","israir airlines","israir flight","ist","istanbul airport","ita airways","jal","japan airlines","jeju air","jet blue","jet blue israel","jetblue","jfk","jfk airport","jin air","kenya airways","king david lounge","kl klm","kl טיסה","klm kl","korean air","kosher meal","kuala lumpur airport","kul","laguardia","larnaca airport","latam","latam airlines","lax","lca","lga","lgw","lh lufthansa","lh טיסה","lhr","los angeles airport","lot polish","lot polish airlines","lounge access","lounge pass","lufthansa lh","ly airlines","ly el al","ly טיסה","mad","madrid airport","malaysia airlines","malaysian airlines","masada lounge","matmid","mauritius air","meal selection","mel","melbourne airport","mex","mexico airport","mia","miami airport","milan malpensa","mileage bank","mileage plus","miles & more","miles and more","miles redemption","mobility assistance","montreal airport","ms egypt air","muc","multi city flight","mumbai airport","munich airport","musical instrument cargo","mxp","narita tokyo","new york jfk","newark airport","non refundable","norwegian","norwegian air","nrt","oman air","one way","one way flight","one world","oneworld","onur air","open jaw","open jaw flight","ord","ory","osl","oslo airport","paphos airport","paris cdg","paris orly","pegasus airlines","pek","pet cargo","pet in cabin","pfo","philippine airlines","pobeda","porter airlines","prague airport","prg","priority pass","private jet","ps ukraine international","pvg","qantas","qatar airways","qr qatar","ramon airport","refundable","refundable ticket","rmn","ro tarom","rome fiumicino","round trip","round trip flight","royal brunei","royal jordanian","rwandair","ryanair israel","s7 airlines","s7 sibir","saa","sabiha gokcen","salam air","san francisco airport","santiago airport","sao paulo airport","sas scandinavia","sas scandinavian","sas sk","saudia","saudia airlines","saw","scl","seat selection","senior discount","senior discount flight","seoul incheon","sfo","shanghai pudong","sichuan","sichuan airlines","sin","singapore airlines","singapore changi","sk sas","sk טיסה","skip line","skyteam","skywards","skywest","smartwings","south african airways","spice jet","spicejet","spirit","spirit airlines","sports equipment","sports equipment cargo","sri lankan airlines","stansted","star alliance","stn","stockholm airport","stroller cargo","student discount flight","su aeroflot","sun d'or","sun d\\","sun express","sundor","sunexpress","surfboard cargo","swiss","swiss air","syd","sydney airport","tap air portugal","tap portugal","tarom","terminal 1","terminal 3","thai airways","tk turkish","tk טיסה","tlv","tlv airport","toronto airport","turkish airlines tk","tus airways","ua united","ua טיסה","ukraine international","united ua","vegan meal","vegetarian meal","vie","vienna airport","vietnam airlines","vip airport service","vip service airport","vistara","vistara airlines","volaris","vueling","warsaw airport","washington dulles","waw","westjet","wheelchair service","wizz air israel","wizz israel","yul","yyz","zrh","zurich airport","אארופלוט","אגיאן","אגיפט אייר","אול ניפון","אוסטריאן איירליינס","אוקראינה איירליינס","אורד שיקגו","אורלי","איבריה","אייר אינדיה","אייר אירופה","אייר אסיה","אייר מאלטה","אייר ערביה","אייר צ'יינה","אייר קהיר","אייר קנדה","אליטליה","אמירייטס","אנאדולו ג'ט","אנאדולו ג\\","אנגי","אסיאנה","אפן איירליינס","אקספדיטור","ארוחה כשרה","אתיחאד","בחירת מושב","בלובירד","ברוסלס איירליינס","ג'אפן איירליינס","ג'ון קנדי","גטוויק","דמי ביטול","דמי שינוי","האינאן","הית'רו","הלוך חזור","וואן וורלד","וויולינג","וולאריס","וייטנאם איירליינס","חיפה airport","חלקי בן גוריון","טארום","טוס איירוויס","טיסה ישירה","טיסה לאילת","טיסה לחיפה","טיסה לרמון","טיסות פנים","טיסת אל על","טיסת ארקיע","טיסת המשך","טיסת ישראייר","טיסת צ'רטר","טיסת צ\\","טרמינל 1","טרמינל 3","טרמינל בן גוריון","יורווינגס","יינה","כיוון אחד","כרטיס טיסה","לאונג' דוד המלך","לאונג' מצדה","לאונג' פאס","לאונג\\","לוט","מחלקה ראשונה","מחלקת עסקים","מחלקת תיירים","מטוס פרטי","מטען עודף","מיילס אנד מור","מלפנסה","מנוי טיסה","מס שדה תעופה","מצרים אייר","מתמיד","מתמיד אל על","נורווגיאן","ניוארק","נמל בן גוריון","נמל התעופה בן גוריון","סאן אקספרס","סאן דור","סבחא גקצ'ן","סבחא גקצ\\","סוואנאבומי","סוויס","סטאר אלייאנס","סטנסטד","סינגפור איירליינס","סכיפול","סמרטוויניגס","ספיריט","סקייוורדס","סקייטיים","פגסוס","פגסוס איירליינס","פיומיצינו","פלייד דובאי","פליינג בלו","פריוריטי פאס","פרימיום אקונומי","צ'אנגי","צ'כיה איירליינס","צ'קאין","צ'רטר","קאין","קאתיי פסיפיק","קוואנטס","קוריאן אייר","קורנדון","קטר איירווייז","קרואטיה איירליינס","רמון airport","שארל דה גול","שדה תעופה אבו דאבי","שדה תעופה אילת","שדה תעופה איסטנבול","שדה תעופה אתונה","שדה תעופה בודפשט","שדה תעופה ברצלונה","שדה תעופה דובאי","שדה תעופה הרצליה","שדה תעופה וינה","שדה תעופה ורשה","שדה תעופה חיפה","שדה תעופה לרנקה","שדה תעופה מדריד","שדה תעופה מיאמי","שדה תעופה מינכן","שדה תעופה פראג","שדה תעופה פרנקפורט","שדה תעופה ציריך","שדה תעופה רמון","תאי איירווייז","תוספת דלק","תוספת מטען"],"category":"תחבורה","subcategory":"טיסות"},
  {"keywords":["אגרת טאבו","אחזקת מעלית","ארנונה אבן יהודה","ארנונה אום אל פחם","ארנונה אופקים","ארנונה אור יהודה","ארנונה אור עקיבא","ארנונה אילת","ארנונה אלעד","ארנונה אלקנה","ארנונה אריאל","ארנונה אשדוד","ארנונה אשקלון","ארנונה באר שבע","ארנונה בית שאן","ארנונה בית שמש","ארנונה ביתר עילית","ארנונה בני ברק","ארנונה בנימינה","ארנונה ג'דיידה מכר","ארנונה ג'סר א-זרקא","ארנונה ג\\","ארנונה גבעת זאב","ארנונה גבעת שמואל","ארנונה גבעתיים","ארנונה גני תקווה","ארנונה דבוריה","ארנונה דימונה","ארנונה דליית אל כרמל","ארנונה הוד השרון","ארנונה זכרון יעקב","ארנונה חולון","ארנונה חורה","ארנונה חיפה","ארנונה טבעון","ארנונה טבריה","ארנונה טייבה","ארנונה טירה","ארנונה טמרה","ארנונה יבנה","ארנונה יהוד","ארנונה יקנעם","ארנונה ירושלים","ארנונה כסיפה","ארנונה כפר ברא","ארנונה כפר חבד","ארנונה כפר יונה","ארנונה כפר מנדא","ארנונה כפר סבא","ארנונה כפר קאסם","ארנונה כרכור","ארנונה כרמיאל","ארנונה לוד","ארנונה לקיה","ארנונה מודיעין","ארנונה מטולה","ארנונה מכבים רעות","ארנונה מעלה אדומים","ארנונה מעלות","ארנונה מעלות תרשיחא","ארנונה נהריה","ארנונה נוף הגליל","ארנונה נצרת","ארנונה נצרת עילית","ארנונה נשר","ארנונה נתיבות","ארנונה נתניה","ארנונה סביון","ארנונה סחנין","ארנונה עין הוד","ארנונה עכו","ארנונה עפולה","ארנונה ערד","ארנונה ערערה","ארנונה ערערה בנגב","ארנונה פרדס חנה","ארנונה פתח תקווה","ארנונה צפת","ארנונה קלנסווה","ארנונה קצרין","ארנונה קריות","ארנונה קרית אונו","ארנונה קרית שמונה","ארנונה קרני שומרון","ארנונה ראשון לציון","ארנונה רהט","ארנונה רחובות","ארנונה רכסים","ארנונה רמלה","ארנונה רמת גן","ארנונה רמת השרון","ארנונה רעננה","ארנונה שדרות","ארנונה תל אביב","ארנונה תל שבע","ועד בית","ועד בנין","ועד הבית","ועד הדיירים","טאבו","ליפט","מועצה אזורית באר טוביה","מועצה אזורית בני שמעון","מועצה אזורית גזר","מועצה אזורית גליל עליון","מועצה אזורית גליל תחתון","מועצה אזורית גן רווה","מועצה אזורית דרום השרון","מועצה אזורית חבל יבנה","מועצה אזורית חוף הכרמל","מועצה אזורית יואב","מועצה אזורית לכיש","מועצה אזורית מטה אשר","מועצה אזורית מטה יהודה","מועצה אזורית מרום הגליל","מועצה אזורית עמק חפר","מועצה אזורית עמק יזרעאל","מועצה אזורית רמת הנגב","מועצה אזורית שפיר","מעלית","ניקיון בנין","סר א-זרקא","עירייה בת ים","עירייה גבעתיים","עירייה הרצליה","עירייה חולון","עירייה כפר סבא","עירייה נתניה","עירייה ראשון לציון","עירייה רחובות","עירייה רמת גן","עירייה רעננה","רישום מקרקעין","תחזוקת בנין","תשלום ועד בית"],"category":"הוצאות קבועות / בית","subcategory":"ארנונה - ערים נוספות"},
  {"keywords":["mei avivim","mekorot","yuvalim","אגרת מים","חשבון מים","מי אביבים","מי אבן יהודה","מי אום אל פחם","מי אופקים","מי אור יהודה","מי אילון","מי אילת","מי אלעד","מי אריאל","מי אריאל יהודה","מי באקה אל גרבייה","מי באר טוביה","מי באר שבע","מי בית שאן","מי בית שמש","מי ביתר עילית","מי בני ברק","מי בת ים","מי גבעתיים","מי גולן","מי גזר","מי גליל","מי גן יבנה","מי גן רווה","מי גני אביב","מי גני יהודה","מי גני תקווה","מי דימונה","מי דליית אל כרמל","מי דרום","מי דרום השרון","מי הגיחון","מי הגליל המערבי","מי הוד השרון","מי הים האדום","מי הרצליה","מי השרון","מי השרון תאגיד","מי חבל אילות","מי חבל לכיש","מי חולון","מי חוף הכרמל","מי חיפה","מי טבעון","מי טבריה","מי טייבה","מי טירה","מי טמרה","מי יהוד מונסון","מי יזרעאל","מי יקנעם","מי ירושלים","מי כפר ברא","מי כפר יונה","מי כפר סבא","מי כפר קאסם","מי כפר קרע","מי כרמיאל","מי כרמל","מי לוד","מי לכיש","מי מודיעין","מי מטה יהודה","מי מנשה","מי מעלה אדומים","מי מעלות","מי נגב","מי נהריה","מי נצרת","מי נשר","מי נתיבות","מי נתניה","מי ספרא","מי עוספיה","מי עין גדי","מי עכו","מי עמק חפר","מי עפולה","מי ערד","מי ערערה","מי פתח תקווה","מי צפת","מי קדימה צורן","מי קלנסווה","מי קצרין","מי קרית אונו","מי קרית גת","מי קרית מלאכי","מי קרית שמונה","מי קרני שומרון","מי ראש העין","מי ראשון לציון","מי רהט","מי רחובות","מי רמת גן","מי רעננה","מי שגב","מי שדה תימן","מי שדרות","מי שורק","מי שורק תאגיד","מי שחורת","מי שיקמים","מי שמש","מי שפיר","מי תל אביב","מקורות","מקורות חברה לאומית","פלגי גליל","פלגי השרון","פלגי מוצקין","תאגיד מים אביבים","תאגיד מים יובלים","תאגיד מים סובב גילבוע","תאגיד מים סובב שפרעם","תאגיד מים פלגי השרון"],"category":"הוצאות קבועות / מים","subcategory":"מים - תאגידי מים בכל הארץ"},
  {"keywords":["alon tabor","amisra energy","cellcom energy","dorad","edf ישראל","edison","electra power","electricity company","energix","enlight","iec","israel electric","nofar energy","ofz energy","ofz אנרגיה","or energy","paragon","powerhouse","solar energy","solar panels","solgreen","x power","אווצ׳ר אנרגיה","אוז אנרגיה","אור אנרגיה","אלון תבור","אלקטרה פאוור","אמישראגז אנרגיה","אנלייט","אנרגיה ישראלית","אנרגיה לישראל","אנרגיקס","אנרגית שמש","אקס פאוור","דוראד","החשמל","המאיר אנרגיה","התקנת סולארי","חברת חשמל","חברת חשמל לישראל","חח\"י","חחי","חשבון חשמל","טבעי אור","מד חשמל חכם","מונה חכם","מערכת סולארית","נופר אנרגיה","סולאר","סולגרין","סולגרין מערכות","סופרגז אנרגיה","סלקום אנרגיה","ספק חשמל","ספק חשמל פרטי","פאזגז חשמל","פאנלים סולאריים","פז חשמל","פרגון אנרגיה","תחנת כוח אלון תבור"],"category":"הוצאות קבועות / חשמל","subcategory":"חשמל - ספקים ושירותים"},
  {"keywords":["amisra gaz","amisragas","balloon gas","delek gas","dor gas","dorgas","gas gilad","gas israel","gas systems","gas yigal","gaz systems","orot hagalil gas","paz gas","pazgas","super gas","supergas","אורות הגליל גז","אמיסראגז","אמישראגז","בודק גז","בלון גז","גז בלון","גז גלעד","גז דלק","גז יגאל","גז ישראל","גז מערכות","גזן","דורגז","החלפת בלון גז","התקנת גז","חשבון גז","טכנאי גז","מד גז","מערכות גז","סופרגז","פז גז","פזגז ביתי","פזגז מרכזי","צריכת גז","שעון גז","תחזוקת גז","תיקון גז"],"category":"הוצאות קבועות / בית","subcategory":"גז ביתי - חברות הגז"},
  {"keywords":["012 mobile","012 בזק","012 גולן","012 סמייל","012 קווי","013 triple c","013 triplec","014 bezeq","014 בזק בינלאומי","015 telzar","015 טלזר","018 xfone","018 אקספון","019 telecom","019 טלקום","alpha web","bezeq","bezeq beinleumi","bezeq international","bundle","cellcom internet","cellcom tv","fenicia","fiber israel","free telecom","godaddy ישראל","golan telecom","home box telecom","hot internet","hot mobile","hot net","namecheap","netvision","octopus telecom","orange internet","partner internet","partner tv","pelephone internet","rami levy tikshoret","rimon","smile 012","spicket","spinet","sting tv","strata","sugarhive","triple c","voip","we 4g","we4g","wireless internet","wix","wix.com","wordpress","xfone","yes tv","yes ישראל","yokneam telecom","אוקטופוס","אורנג אינטרנט","אינטרנט אלחוטי","אינטרנט בזק","אינטרנט סיבים","אינטרנט סלולרי","אינטרנט רימון","אלפא וב","באנדל","בזק","בזק בינלאומי","גולן טלקום","ההום בוקס","הוט אינטרנט","הוט מובייל","הוט נט","וויקס","וורדפרס","וי 4 ג'י","וי 4 ג\\","ויאו איי פי","ויז'ן","חבילת אינטרנט","חוט מים","טלפון בזק","טלפוניה עסקית","טריפל סי","יס לוויין","יקנעם תקשורת","נטוויז'ן","נטוויז\\","סטינג tv","סטרטה","סיבים אופטיים","סלקום tv","סלקום אינטרנט","סלקום טי וי","סלקום נייח","סלקום קווי","ספיקנט","ספק אינטרנט עסקי","ספק בזק","פלאפון אינטרנט","פנגיון","פרטנר tv","פרטנר אינטרנט","פרטנר קווי","פרי טלקום","קו בזק","רמי לוי תקשורת","שורגרהוב"],"category":"הוצאות קבועות / חשבונות","subcategory":"תקשורת - ספקי אינטרנט ושירותי תקשורת"},
  {"keywords":["9000","avi insurance","avi ביטוח","bituach bituchim","bituach dira","bituach esek","bituach hayim","bituach menahalim","bituach mivneh","bituach nesiyot","bituach rechush","bituach siudi","bituach tchula","bituach yashir","clal pension","direct insurance","eliyahu insurance","energy ביטוח","hakol batuach","harel pension","helian insurance","idi","idi direct","idi insurance","idi ביטוח","keren pensia","libra insurance","menorah mivtachim","migdal pension","mishan insurance","one insurance","pasifas","polisa","shadma insurance","shlomo insurance","soken bituach","wesure","yoter insurance","אגף הביטוח","אובדן כושר","אי די איי","אליהו ביטוח","אנרגי ביטוח","ביטוח אובדן כושר עבודה","ביטוח אובדן עבודה","ביטוח אחריות מקצועית","ביטוח ביטוחים","ביטוח גגונים","ביטוח גרירה","ביטוח דירה","ביטוח דרכים","ביטוח חבות","ביטוח חבות מעבידים","ביטוח חוץ לארץ","ביטוח חיים","ביטוח ימי","ביטוח ישיר","ביטוח מבנה","ביטוח מטענים","ביטוח מנהלים","ביטוח מקצועי","ביטוח נסיעות","ביטוח נסיעות לחו","ביטוח נסיעות לחו\"ל","ביטוח סיעודי","ביטוח עסק","ביטוח רכוש","ביטוח רעידת אדמה","ביטוח שמשה","ביטוח שמשות","ביטוח תכולה","ביטוחי בריאות פרטיים","הכל בטוח","הליאן ביטוח","הסכם פנסיוני","הפקדות פנסיה","הראל פנסיה","השלמת פנסיה","וואן ביטוח","וואן זירו ביטוח","וויסור","יותר","יותר ביטוח","כלל פנסיה","כתב מינוי","ליברה","מגדל פנסיה","מישן ביטוח","מנורה מבטחים","ניהול תיק ביטוחים","סוכן ביטוח","סוכנויות ביטוח","סוכנות ביטוח","פוליסת ביטוח","פיצויים פנסיה","פנסיה חובה","פסיפס ביטוח","קרן פנסיה","רשות שוק ההון","שדמה","שדמה ביטוח","שלמה ביטוח","שלמה ביטוחים","תוכנית הוני","תוכנית קולקטיב","תכנון פיננסי"],"category":"הוצאות קבועות / ביטוח","subcategory":"ביטוח כללי - חברות נוספות"},
  {"keywords":["altshuler gemel","altshuler shaham gemel","analyst gemel","axioma","clal gemel","excellence gemel","harel gemel","harel pension fund","hasachar hadinami","helman aldubi","ibi pension","ibi גמל","infinity gemel","keren hishtalmut","meitav dash gemel","meitav gemel","menora gemel","menorah gemel","migdal gemel","mivtachim","more gemel","psagot gemel","psagot pension","psagot pension fund","yelin hishtalmut","yelin lapidot gemel","אינפיניטי גמל","אלטרנטיב גמל","אלטשולר השתלמות","אלטשולר שחם גמל","אלטשולר שחם פנסיה","אנליסט גמל","אנליסט השתלמות","אקסיומה","אקסלנס גמל","ביטוח לאומי גמל","הלמן אלדובי","הראל גמל","הראל השתלמות","השכר הדינמי","חיסכון לילד","חיסכון לכל ילד","חיסכון פנסיוני","חכי","ילין השתלמות","ילין לפידות גמל","כלל גמל","מבטחים","מגדל גמל","מגדל השתלמות","מור גמל","מור השתלמות","מיטב דש גמל","מיטב דש פנסיה","מנורה גמל","מנורה השתלמות","ניהול תיקים אנליסט","ניהול תיקים אקסיומה","ניהול תיקים מור","ניהול תיקים פסגות","פנסיה ברירת מחדל","פסגות גמל","פסגות השתלמות","פסגות פנסיה","פסגות פנסיה ברירת מחדל","קופת גמל","קופת גמל להשקעה","קרן השתלמות","קרן פנסיה ברירת מחדל"],"category":"פיננסים / השקעות","subcategory":"חיסכון ופנסיה - גמל וקרנות השתלמות"},
  {"keywords":["abarbanel","abarbanel hospital","alyn","asaf harofeh","assuta","assuta ashdod","assuta haifa","assuta ramat gan","assuta ramat hahayal","assuta tel aviv","barzilai","be'er yaacov","be\\","beilinson","bikur cholim","bnei tzion","bnei zion","carmel hospital","ein kerem","geha","hadassah","hadassah ein kerem","hadassah mount scopus","har hatzofim","herzliya medical","hillel jaffe","hillel yaffe","ichilov","laniado","mayanei hayeshua","meir","naharia hospital","poriya","rabin","rambam","schneider","shaare zedek","shalvata","shamir medical","sharei zedek","sheba","soroka","sourasky","tel hashomer","tirat hacarmel","wolfson","ziv","אבירים","אברבנאל","אגף אישפוז","איכילוב","אלין","אלין בית לויניטון","אסותא","אסותא אשדוד","אסותא חיפה","אסותא רמת גן","אסותא רמת החייל","אסותא תל אביב","אסף הרופא","באר יעקב","באר יעקב נס ציונה","בילינסון","ביקור חולים","בית חולים איכילוב","בית חולים בילינסון","בית חולים ברזילי","בית חולים גהה","בית חולים וולפסון","בית חולים זיו","בית חולים כרמל","בית חולים לניאדו","בית חולים מאיר","בית חולים פוריה","בית חולים רבין","בית חולים שלוותה","בית חולים תל השומר","בני ציון","ברזילי","בריאות הנפש","גהה","הדסה","הדסה הר הצופים","הדסה עין כרם","הלל יפה","המרכז הרפואי סורוקה","המרכז הרפואי ת\"א","הרצליה מדיקל","וולפסון","זיו","חדר מיון","חדר מיון פרטי","טיפול נמרץ","טירת הכרמל","יולדות","ילדים שניידר","כרמל","לניאדו","מאיר","מחלקה אורתופדית","מחלקה כירורגית","מחלקת יולדות","מעייני הישועה","מעיני הישועה","מערבי","מרכז רפואי","מרכז רפואי איכילוב","מרכז רפואי ברזילי","מרכז רפואי גליל","מרכז רפואי מאיר","מרכז רפואי רמבם","מרפאת בית חולים","מרפאת חוץ","נהריה","סוראסקי","סורוקה","סורסקי","סורסקי המרכז הרפואי","פגיה","פגייה","פוריה","צפת","רבין","רמב","רמב\"ם","רמבם","שיבא","שלוותה","שמיר","שניידר","שערי צדק","תינוקות תל השומר","תל השומר","תל השומר ילדים"],"category":"בריאות / בריאות","subcategory":"בריאות - בתי חולים"},
  {"keywords":["acupuncture","allergist","alternative medicine","cardiologist","cbt","chinese medicine","chiropractor","dbt","dentist","dermatologist","dietician","emdr","emdr טיפול","endocrinologist","ent","gastroenterologist","gynecologist","holistic","homeopathy","klinika pratit","macrotologist","marpa pratit","marpat assuta","marpat hasharon","naturopath","neurologist","nlp","occupational therapy","oncologist","ophthalmologist","orthopedist","pediatrician","physiotherapist","private doctor","psychiatrist","psychologist","psychology","reflexology","rheumatologist","rofe prati","rothschild clinic","speech therapist","therapist","urologist","אא\"ג","אונקולוג","אונקולוגיה","אורולוג","אורולוגיה","אורטופד","אורתופד","אלרגולוג","אנדוקרינולוג","אסתטיקה","אף אוזן גרון","אקופונקטורה","גינקולוג","גסטרואנטרולוג","דיקור סיני","דרמטולוג","הומאופתיה","הומיאופתיה","טיפול אישי","טיפול באומנות","טיפול בילדים","טיפול דיאלקטי","טיפול זוגי","טיפול קוגניטיבי","טיפול רגשי","ייעוץ זוגי","ייעוץ זוגיות","ייעוץ פסיכולוגי","ייעוץ פסיכיאטרי","ייעוץ תזונאי","יעוץ תזונה","כירופרקט","כירופרקטור","מאמן nlp","מאמן מנטלי","מוזיקה תרפיה","מטפל אלטרנטיבי","מטפל במוסיקה","מטפל בספורט","מטפל ברפלקסולוגיה","מטפל הוליסטי","מטפל זוגי","מטפלת ב cbt","מטפלת באומנות","מנתח פלסטי","מקרוטטולוג","מרפאה פרטית","מרפאת אסותא","מרפאת השרון","מרפאת לב הארץ","מרפאת קופחת","מרפאת קופת חולים","מרפאת רוטשילד","מרפאת רפואה משלימה","נוירולוג","נוירולוגיה","נטורופת","נטורופתיה","ניתוח פלסטי","ספורט תרפיה","פיזיוטרפיה","פיזיותרפיסט","פיסיותרפיה","פסיכולוג","פסיכותרפיה","פסיכיאטר","קלינאי תקשורת","קליניקה פרטית","קרדיולוג","קרדיולוגיה","ראומטולוג","רופא אא\"ג","רופא ילדים","רופא לב","רופא משפחה פרטי","רופא נשים","רופא עור","רופא עיניים","רופא עצבים","רופא פרטי","רופא שיניים","ריפוי בעיסוק","רפואה משלימה","רפואה סינית","תזונאי","תזונאית קלינית","תרפיסט"],"category":"בריאות / רופא פרטי","subcategory":"בריאות - מרפאות פרטיות וקליניקות"},
  {"keywords":["boost","center shinaim","crown","dexshine","dr smile","dr yaron","endodontics","esthetics plus","filling","floridenta","general dental","implant","implants","invisalign","marpat shinaim","masuf shinaim","orthodont","orthodontics","oz dental","periodontics","photona","prosthodontics","scaling","smily dental","urban dent","whitening","zeiss אסתטיקה","אורבן דנט","אורתודונט","אורתודונטיה","אורתודנט","אינוויזליין","אנדודונט","אסתטיקה דנטלית","אסתטיקה פלוס","בוסט הלבנה","גשרים דנטליים","ד\"ר ירון","ד\"ר סמייל","ד\"ר שיניים פרטי","דקס שיין","הלבנת שיניים","השתלת שיניים","טיפול בלייזר","טיפול דחוף שיניים","טיפול שורש","כתר שיניים","מומחה שיניים","מומחה שן","מחלות חניכיים","מסוף שיניים","מרפאות שיניים שלי","מרפאות שלי","מרפאות שן","מרפאת שיניים","ניקוי אבנית","סדרציה שיניים","סמיילי","סמיילי שיניים","סנטר שיניים","סתימה","עוז שיניים","עוז שן","פדודונט","פדודונטיה","פוטונה","פוטונה לייזר","פלורידנט","פלורידנטה","פרוסטודונט","פריודונט","ר סמייל","רפואת שיניים אסתטית","רפואת שיניים כללית","שיניים לילדים","שיניים תותבות","שתל שיניים","תותבות"],"category":"בריאות / שיניים","subcategory":"בריאות - רשתות שיניים ואסתטיקה"},
  {"keywords":["adashot","chibson","contact lenses","erroca","essilor","eye exam","glasses","halperin","hoya lenses","laser eyes","mishkafayim","oakley","optica danziger","optica halperin","optica hod","optica lotus","optica menahart","optica rachel","optica uri","opticana","optometrist","persol","polizer","ray ban","ray-ban","sunglasses","zeiss lenses","אופטומטריה","אופטומטריסט","אופטיקאי","אופטיקאית","אופטיקה אורי","אופטיקה דנציגר","אופטיקה הוד","אופטיקה הלפרין","אופטיקה רחל","אופטיקנה","אופטיקת לוטוס","אופטיקת מנהרות","אוקלי","אסילור","ארוקה","בדיקת ראיה","הואיה","מולטיפוקל","מומחה לעיניים","מסגרות משקפיים","משקפי שמש","משקפיים","ניתוח לייזר עיניים","עדשות אנטי רפלקס","עדשות זייס","עדשות מגע","עדשות מולטיפוקל","עדשות פרוגרסיב","עדשות צבע","ערוקה","פוליצר","פרוגרסיב","פרסול","צ'יבסון","ריי באן"],"category":"בריאות / בריאות","subcategory":"בריאות - אופטיקה ומשקפיים"},
  {"keywords":["achva college","afeka","ariel","ariel university","bar ilan","bar-ilan","beit berl","ben gurion university","bezalel","bgu","haifa university","hebrew university","hemdat hadarom","herzog college","huji","idc","idc herzliya","idc הרצליה","kaye","kinneret college","lander","lander institute","levinsky","master degree","mba","minshar","netanya college","ono academic college","open university","orot yisrael","ort braude","phd","ramat gan college","reichman","reichman university","sapir college","seminar hakibbutzim","shaanan","shenkar","shenkar college","talpiot","tau","technion","tel aviv university","tel hai","the academic college of tel aviv jaffa","tuition","weizmann","weizmann institute","yezreel","א אוניברסיטה","אגודת סטודנטים","אונו","אוניברסיטה עברית","אוניברסיטת אריאל","אוניברסיטת בן גוריון","אוניברסיטת בר אילן","אוניברסיטת חיפה","אוניברסיטת רייכמן","אוניברסיטת תל אביב","אפקה","בן גוריון","בצלאל","דוקטורט","האוניברסיטה העברית","האוניברסיטה הפתוחה","האקדמיה לאמנות בצלאל","הטכניון","המכון הטכנולוגי","המכללה האקדמית להנדסה אורט בראודה","המכללה האקדמית של תל אביב יפו","המכללה הטכנולוגית באר שבע","המכללה הטכנולוגית להנדסה ע","המכללה הטכנולוגית להנדסה ע\"ש מהרישראל","המכללה לאומנות מינשר","המרכז הבינתחומי הרצליה","טכניון חיפה","מאסטר","מאסטר במנהל עסקים","מכון ויצמן","מכון לנדר","מכללה אקדמית כנרת","מכללת אונו","מכללת אורות","מכללת אורות ישראל","מכללת אורט בראודה","מכללת אורט הרמלין","מכללת אורט סינגלובסקי","מכללת אחווה","מכללת בית ברל","מכללת הרצוג","מכללת חמדת","מכללת חמדת הדרום","מכללת לוינסקי","מכללת לוינסקי לחינוך","מכללת נתניה","מכללת ספיר","מכללת עמק יזרעאל","מכללת קיי","מכללת רמת גן","מכללת שאנן","מכללת שנקר","מכללת תל חי","מכללת תלמה ילין","מכללת תלפיות","מעונות אוניברסיטה","מעונות סטודנטים","סמינר הקיבוצים","ספיר","ספריית אוניברסיטה","פוסט דוקטורט","שכר לימוד אוניברסיטה","שכר לימוד מכללה","ת\"א אוניברסיטה","תואר ראשון","תואר שני","תל חי","תעודת תואר"],"category":"חינוך","subcategory":"חינוך - אוניברסיטאות ומכללות"},
  {"keywords":["afternoon care","amali","amit","anthroposophical","atidim","beit yaakov","chabad kindergarten","chendi","day care","democratic school","hova kindergarten","ironi","ironi alef","ironi heh","lehava","matriculation","midrasha","montessori","montessori israel","nitzanim","ort high school","peuton","private high school","private kindergarten","private school","reggio","seminar nashim","snunit","talmud torah","trom hova","tzaharon","ulpana","vaad horim","waldorf","yeshiva gevoha","yeshiva tichonit","אולפנא","אולפנת בני עקיבא","אקסטרניזם","בגרות","בית יעקב","בית ספר אנתרופוסופי","בית ספר דמוקרטי","בית ספר פרטי","גן ולדורף","גן חב","גן חב\"ד","גן חבד","גן ילדים פרטי","גן ישיבה","גן מונטסורי","גן סנונית","גן עירייה","גן פרטי","גן צ'נדי","גני נחלים","ולדורף","ועד הורים","חובה","טרום חובה","ישיבה גבוהה","ישיבה תיכונית","כיתה א","כיתה א'","כיתה א\\","מבחן בגרות","מבחני אקסטרני","מדרשה","מונטסורי","מונטסורי ישראל","מעון יום","מצלם בית ספר","נדי","נחלים","ניצנים","סמינר נשים","סנונית","פעוטון","צ'נדי","צהרון","ריג'יו","ריג\\","תיכון אורט","תיכון איתורא","תיכון אמית","תיכון בית ספר אורט","תיכון בני עקיבא","תיכון הראלי","תיכון לאמנויות","תיכון להב\"ה","תיכון נעלה","תיכון עירוני","תיכון עירוני א","תיכון עירוני ד","תיכון עירוני ה","תיכון עמלי","תיכון עתידים","תיכון פרטי","תיכון תלפיות","תיכון תקווה","תלמוד תורה","תמונת בית ספר"],"category":"חינוך","subcategory":"חינוך - גנים ובתי ספר פרטיים"},
  {"keywords":["acrobatics","ballet","biking class","biking school","boxing kids","capoeira","ceramics","chess class","choir","cinema class","circus","cooking class","dance studio","drawing kids","drums","eged hugim","english class","first lego league","fll","galil hugim","guitar lessons","guitar tel aviv","gymnastics","hiking","hip hop kids","hugim","judo","karate","kung fu","lego robotics","madatech","magic class","matnas","matnas community","modern dance","music class","music studio","piano lessons","programming kids","robotics","sabi","sabri","saybel","science class","sculpting","singing class","skateboard class","swimming class","taekwondo","tennis school","theater class","אגד החוגים","בית הספר לאופניים","בית הספר לטניס","בלט","בסקטבול","ג'אז ילדים","גיטרה ת\"א","גליל חוגים","ודו","חוג","חוג אופניים","חוג איגרוף","חוג אנגלית","חוג אסטרונומיה","חוג אקרובטיקה","חוג בישול","חוג ג'אז","חוג ג'ודו","חוג ג\\","חוג גיטרה","חוג היפ הופ","חוג הליכה","חוג התעמלות","חוג טאי קוונדו","חוג טניס","חוג כדורגל","חוג כדורסל","חוג כלי הקשה","חוג מדע","חוג מודרני","חוג מוסיקה","חוג מחול","חוג מנהיגות","חוג מתמטיקה","חוג ספורט","חוג סקייטבורד","חוג עברית","חוג פיסול","חוג פסנתר","חוג ציור","חוג צירק","חוג קולנוע","חוג קונג פו","חוג קסמים","חוג קפוארה","חוג קרטה","חוג קרמיקה","חוג רובוטיקה","חוג שחייה","חוג שחמט","חוג שירה","חוג תיאטרון","חוג תכנות","חוגים","ישיבת מוסיקה","לגו רובוטיקה","מדעטק","מקהלה","מרכז קהילתי","מתנ","מתנ\"ס","סטודיו הכוכבים","סטודיו לבלט","סטודיו לריקוד","סטודיו מוסיקה","סייבי","סייבל","סייברי","סייענות","פוטבול ילדים","ציור לילדים","צילום ילדים","תמיכה לימודית"],"category":"חינוך","subcategory":"חינוך - חוגים והעשרה"},
  {"keywords":["academyoc","access psychometric","akademon","amir","amiram","berlitz","blobischool","bootcamp","coding academy","codingacademy","coursera","duolingo plus","edx","ef education first","ef english","elevation","english 1","etzion","geek brains","geekbrains","high q","highq","israel tech challenge","itc","itc bootcamp","kaplan test","kidum","manhattan prep","matriculation prep","private lessons","private teacher","psychometric","qualification exam","sela","shiurey bait","shiurim pratiim","studio 8","studio niv","tuition insurance","udemy","ulpan","ulpan akiva","wall street english","wix academy","wix code","אדאקס","אולפן","אולפן עברית","אולפן עציון","אלוויישן","אמיר","אמירם","אנגלית 1","אקדמון","אקדמיה","אקסס","בוט קמפ","ביטוח לימודי","בלובי","ברליץ","גיק בריינס","דואולינגו","היי קיו","הכנה לאמיר","הכנה לבגרות","הכנה לפסיכומטרי","ועדת קבלה","חוברת תרגול","יודמי","לימודי בגרות","מורה לאנגלית פרטי","מורה לכימיה","מורה למתמטיקה פרטי","מורה לספרדית","מורה לספרות","מורה לעברית","מורה לערבית","מורה לפיזיקה פרטי","מורה לצרפתית","מורה לרוסית","מורה לתנ","מורה לתנ\"ך","מורה פרטי","מורה פרטית","מורן","סטודיו 8","סטודיו ניב","סייענות לבגרות","סייענת","סלע","ספיר אקדמי","עוזרת לימודית","פסיכומטרי","קודינג אקדמי","קורסרה","קידום","קידום פסיכומטרי","שיעור פרטי באנגלית","שיעור פרטי במתמטיקה","שיעורי בית","שיעורים פרטיים","תרגול לבגרות","תרגום פרטי"],"category":"חינוך","subcategory":"חינוך - שיעורים פרטיים ובגרות"},
  {"keywords":["afi kavim","afikim","autonet","beit shemesh express","carmelit","city bus","citypass","cordata","dan ahavi","dan north","dan north shomron","dan transport","egged","egged taavura","electra afikim","extra buses","free monthly","galim","intercity bus","israel railways","kavim","kfir transport","light rail","mai transport","metronit","metropolin","monit sherut","monthly transport","moovit","multiple ride","natbag shuttle","nateev express","outo-bus","rav kav","ravkav","saba transport","shuttle netbag","superbus","tafen","tlv light rail","yedidim","אאוטו-בוס","אאוטובוס","אגד","אגד תעבורה","אוטו נט","אוטובוס בין עירוני","אוטובוס עירוני","אוטונט","אלקטרה אפיקים","אפי קווים","אפיקים","אקסטרא בוסים","אקסטרא ביג","בית שמש אקספרס","גלים","דן אהבי","דן באר שבע","דן צפון","חודשי תחבורה","חופשי חודשי","ידידים","כפיר","כרטיס רב קו","כרמלית","מאי תחבורה","מוביט","מוניות ירושלים","מוניות מרכז","מוניות שירות","מוניות תל אביב","מטרונית","מטרופולין","מסלול תחבורה","מסע מרובה","נתיב אקספרס","סבא","סופרבוס","סופרבוס נתב","סופרבוס נתב\"ג","סיטיפס","ע\"ץ ת\"א","ץ ת","קווים","קורדאטה","רב קו","רב-קו","רכבת ישראל","רכבת קלה","רכבת קלה ירושלים","רכבת קלה תל אביב","שירות לנתב\"ג","תפן","תפן תחבורה"],"category":"תחבורה / תחבורה ציבורית","subcategory":"תחבורה - אגד, דן וחברות אוטובוסים"},
  {"keywords":["1301","agra","agrat beit mishpat","agrat bniya","agrat briut","agrat hotzla","agrat hotzla\"p","agrat rishum","agrat rishuy","agrat tabu","biometric","bituach leumi","business license","darkon","demey leida","doar israel","doar rashum","doh hania","doh matzlema","doh mehirut","doh osek","doh shnati","doh tnua","ems משלוח","execution fee","execution office","export tax","fire department","heter bniya","hotzaa lapoel","import tax","income tax","israel post","kabaut","kitzbat nechut","kitzbat yeladim","kitzbat zikna","klita","knas iriya","knas mishtara","maam","machon rishuy","magen david adom","mas hachnasa","mas rekisha","mas shevah","mda","minhal hamechus","minhal mekarkin","mishtara","misrad habitachon","misrad habriut","misrad hadatot","misrad hahaklaut","misrad hahinuch","misrad hahutz","misrad hakalkala","misrad hamishpatim","misrad hapnim","misrad harevacha","misrad hatahbura","misrad hatarbut","misrad hateshurim","national insurance","parking fine","passport","pkid shuma","police","purchase tax","rasham haamutot","rasham hachevarot","rasham patentim","rashut hamisim","rashut sde teufa","rishyon esek","rishyon nehiga","rmi","speeding fine","tagmulei miluim","tax authority","test rechev","teudat gerushin","teudat leda","teudat nisuin","teudat yosher","teudat zehut","tevat doar","tik mishrad","traffic fine","tzav rishum","vat","vehicle license","vehicle registration","visa application","אגף המכס","אגרת אישור עסק","אגרת אמבולנס","אגרת בית משפט","אגרת בנייה","אגרת בריאות","אגרת הוצל\"פ","אגרת חיבור חשמל","אגרת חיבור מים","אגרת חניה","אגרת טאבו","אגרת ירידה לנמל","אגרת כבאות","אגרת מד","אגרת מד\"א","אגרת רישוי","אגרת רישוי רכב","אגרת רישום","אגרת תיבה","אגרת תעודת יושר","אישור הסכמה","אישור משטרה","אישור עסק","אישור שהייה","ארנונה - תשלום ישיר עיריה","ביומטרי","ביטוח לאומי","ביטוח לאומי - דמי בריאות","ביטוח לאומי - דמי גמל","דואר ישראל","דואר רשום","דוח 1301","דוח חניה","דוח מהירות","דוח מצלמה","דוח עוסק","דוח שנתי","דוח תנועה","דמי לידה","דמי מילואים","דמי משלוח דואר","דרכון","הוצאה לפועל","הוצאת רישיון","החלפת תעודת זהות","היתר בנייה","המוסד לביטוח לאומי","הנפקת דרכון","הנפקת תעודת זהות","השגות מכס","ויזה","חידוש דרכון","חידוש רישיון","טסט רכב","כבאות והצלה","כיבוי אש","מ עוסק","מבחן מעשי רישוי","מבחן רישוי","מבחן שנתי לרכב","מבחן תאוריה רישוי","מד\"א","מד\"א שירות מיוחד","מילואים","מכון רישוי","מכס","מכס יבוא","מכס ייצוא","מנהל המכס","מנהל מקרקעי ישראל","מס בריאות","מס דמי בריאות","מס דמי גמל","מס הכנסה","מס יסף","מס יסף עתיר הכנסות","מס מעסיק","מס מקלט","מס רכישה","מס שבח","מס שבח מקרקעין","מס שכר","מע\"מ","מע\"מ ירידה לנמל","מע\"מ עוסק","מע\"מ פטור","מעמ","משטרת ישראל","משרד הביטחון","משרד הבריאות","משרד הדתות","משרד החוץ","משרד החינוך","משרד החקלאות","משרד הכלכלה","משרד המשפטים","משרד העבודה","משרד העלייה והקליטה","משרד הפנים","משרד הקיבוצים","משרד הרווחה","משרד התחבורה","משרד התיירות","משרד התרבות","ניידת רישוי","ניכוי במקור","ערעור דוח","פירעון דוח","פנסיה צבאית","פסיכולוגית רישוי","פקיד שומה","צו רישום","קנס משטרה","קנס עיריה","קצבת זקנה","קצבת ילדים","קצבת נכות","רישיון נהיגה","רישיון עסק","רישיון רכב","רמ\"י","רמי","רשות האכיפה","רשות ההגירה","רשות המסים","רשות חברות","רשות מקרקעי ישראל","רשות שדות התעופה","רשם הדירות","רשם החברות","רשם המשכונות","רשם הסכמי ממון","רשם העמותות","רשם הצוואות","רשם הקבלנים","רשם הרכב","רשם השעבודים","רשם פטנטים","תגמולי מילואים","תוכנית עסקית עירייה","תיבת דואר","תיק בית משפט","תיק במשרד הפנים","תיק הוצל","תיק הוצל\"פ","תעבורה תעודה","תעודת גירושין","תעודת זהות","תעודת זוגיות","תעודת יושר","תעודת לידה","תעודת לידה ילד","תעודת מבחן","תעודת מעבר","תעודת נישואין","תעודת פטירה","תעודת רישוי","תעודת רישום נישואין","תעריף מכסי","תרגום נוטריוני","תשלום אגרה","תשלום למדינה","תשלום למשרד התחבורה","תשלום קנס"],"category":"ממשלה ומיסים","subcategory":"ממשלה - מיסים, אגרות ודוחות"},
  {"keywords":["hashlamat hachnasa","kitzbat ezrach vatik","kitzbat niyadut","kitzbat sheirim","tosefet em","השלמה לפנסיה","השלמת הכנסה","מענק לידה","מענק נישואין","מענק שחרור","ניכוי ביטוח לאומי","ניכוי בלי","ניכוי בלי\"ע","ניכוי דמי בריאות","ניכוי דמי גמל","פדיון ימי חופשה","פדיון ימי מחלה","פיצויי פיטורין","פיצויי פרישה","קצבת אזרח ותיק","קצבת אסיר ציון","קצבת הבטחת הכנסה","קצבת חוסים","קצבת ניידות","קצבת נפגעי שואה","קצבת רכישת רכב לנכים","קצבת שאירים","קרן ידידות","תגמולי שיקום","תוספת אם","תוספת ותק","תוספת ילד שלישי"],"category":"ממשלה ומיסים","subcategory":"ביטוח לאומי - קצבאות וניכויים מיוחדים"},
  {"keywords":["agena trader","angel investor","avatrade","bit2c","bitcoin israel","bits of gold","bitsofgold","blender","blender finance","bnk","bnk-to-the-future","coinmama","coliseum","cryptojungle","etf","etoro","etoro israel","excellence","excellence brokerage","ezbob","forex israel","fxcm","fxcm israel","hedge fund","iangels","ib israel","ibi","ibi investment","ibi ניהול תיקים","interactive","interactive brokers","interactive brokers il","ironfx","keren hashka'a","keren hashka\\","keren neemanut","markets.com","meitav dash","meitav investment","more gemel","oanda","ourcrowd","pipelbiz","plus500","promotrade","pym ישראל","teudat sal","tradeo","tribecho","vc ישראלי","venture capital","yaval","אבא טרייד","אוור קראוד","אונדה","אי אנג'לס","איטורו","איי בי איי","אילים קרנות","אירון אף איקס","אלטשולר שחם בית השקעות","אנג'ל ישראל","אנג\\","אנליסט בית השקעות","אנליסט קרנות","אקסיומה","אקסלנס","אקסלנס נשואה","אקסלנס קרנות","ביט טו סי","ביטקוין ישראל","בלנדר","השקעות אלטרנטיביות","השקעות ערך","טריבץ'ו","טריידיו","יבל","ילין לפידות בית השקעות","ילין לפידות קרנות","מגדל קרנות","מור בית השקעות","מור גמל","מור קרנות","מיטב דש","מיטב דש בית השקעות","סוכנות השקעות","פורקס ישראל","פייפלביז","פלוס 500","פלוס500","פלטפורמת מימון המונים","פסגות בית השקעות","פסגות מניות","פסגות קרנות","קוינמאמא","קוליזיאום","קריפטו ג'אנגל","קריפטו ג\\","קרן גידור","קרן השקעות","קרן נאמנות","קרן פרייבט אקוויטי","תעודת סל"],"category":"פיננסים / השקעות","subcategory":"שירותים פיננסיים - ברוקרים והשקעות"},
  {"keywords":["advocate","apostille","criminal lawyer","lawyer","lawyer nadlan","notary","notary verify","rabbinical court","schar tirha","toen rabbani","yiutz mishpati","אגרת תרגום נוטריוני","אימות נוטריוני","אפוסטיל","בית דין רבני","בית דין שרעי","טוען רבני","ייעוץ משפטי","ייצוג משפטי","כתב הגנה","כתב תביעה","ליטיגציה","נוטריון","עו\"ד","עורך דין","עורך דין ביטוח","עורך דין דיירות","עורך דין דין צבאי","עורך דין דיני מגזר","עורך דין דיני משפחה","עורך דין דיני עבודה","עורך דין הגירה","עורך דין הוצאה לפועל","עורך דין הלוואות","עורך דין הסכמי ממון","עורך דין חברות","עורך דין חוזים","עורך דין מיסים","עורך דין מסחרי","עורך דין מקרקעין","עורך דין נדל\"ן","עורך דין נזיקין","עורך דין פטנטים","עורך דין פלילי","עורך דין צוואות וירושות","ערעור משפטי","פתיחת תיק","שכר טרחה עו","שכר טרחה עו\"ד","תביעה משפטית","תיק משפטי","תרגום נוטריוני"],"category":"ממשלה ומיסים","subcategory":"שירותים מקצועיים - עורכי דין"},
  {"keywords":["accountant","bdo ישראל","bookkeeping","cheshbonai","comacx","comax","cpa","deloitte ישראל","ey ישראל","hashavshevet","heshbonit mas","icount","icount היחיד","icount עוסק מורשה","invoicex","kpmg ישראל","menahel cheshbonot","nihul sfarim","open sync","opensync","pinkasim","pricewaterhousecoopers","pwc ישראל","rivhit","roeh cheshbon","rua hechson","tax advisor","tax consultant","tichnun pinansi","toshsheet","yiutz mas","yiutz pensioni","yoetz hashka'ot","yoetz hashka\\","yoetz mas","אלי כהן רואי חשבון","ארנסט אנד יאנג","ביקורת חשבונאית","דוחות כספיים","דלויט","הגשת דו\"ח שנתי","הגשת דוח ולעלם","הכנת דוחות מס","ח שנתי","חשבונאי","חשבונית מס","חשבשבת","יועץ השקעות","יועץ מס","יועץ פנסיוני","ייעוץ מס","ייעוץ פנסיוני","מאזן בוחן","מבקר פנימי","מנהל חשבונות","מערכת ערב","משרד רואי חשבון","ניהול ספרים","סופר ארגנטינה","ספיר רואי חשבון","פאהן קנה רואי חשבון","פירמת רואי חשבון","פנקסים","פרידמן רואי חשבון","קבלה ממוחשבת","קומקס","רואה חשבון פרטי","רואי חשבון","רווחית","תוכנה לחשבוניות","תוכנת הנהלת חשבונות","תכנון פיננסי"],"category":"פיננסים / השקעות","subcategory":"שירותים מקצועיים - רואי חשבון ומיסים"},
  {"keywords":["activetrail","airtable","amplitude","asana","atlassian","aws israel","azure","basecamp","bluehost","calendly","cardcom","clickup","cloudflare","confluence","cpanel","crisp","cyberduck","digitalocean","domain registration","freshbooks","freshdesk","gcp","godaddy","google cloud","greeninvoice","gtpay","heroku","hostinger","hotjar","hubspot","hyp","icredit","integromat","intercom","jira","linear","linode","looker","loom","mailchimp","make","microsoft azure","microsoft teams","mixpanel","monday","monday.com","mongodb atlas","n8n","namecheap","netlify","notion","payplus","pelecard","pipedrive","plus500 פלטפורמה","powerbi","quickbooks","render","salesforce","segment","sendgrid","sendlane","siteground","slack","square","ssl certificate","stripe","tableau","teams","tranzila","trello","twilio","vercel","vultr","webflow","whm","wp engine","xero","zapier","zendesk","zoom","אזור","אטלסיאן","אי קרדיט","איירטייבל","אינטרקום","אמפליטיוד","אסאנה","אקטיב טרייל","בלוהוסט","ג'י טי פיי","ג'ירה","גודאדי","גרין אינווייס","דיגיטל אושן","האב ספוט","הוטג'אר","הוטג\\","הוסטינגר","היפ","הרוקו","וובפלאו","וולטר","ורסל","זאפייר","זום","זירו","זנדסק","טאבלו","טימס","טרלו","טרנזילה","ימפ","ירה","לוקר","לינאר","לינוד","מאנדיי","מיילצ'ימפ","מייק","מיקספאנל","נושיון","נושן","נטליפיי","ניימצ'יפ","ניימצ\\","סגמנט","סטרייפ","סי פאנל","סייל פורס","סלאק","סקוור","פאוור ביאיי","פיי פלוס","פייפדרייב","פלקארד","קארדקום","קוויק בוקס","קונפלואנס","קלאודפלר","קליק אפ","קלנדלי","רישום דומיין","רנדר","תעודת ssl"],"category":"הוצאות קבועות / חשבונות","subcategory":"שירותים מקצועיים - SaaS עסקי וIT"},
  {"keywords":["klalit mushlam","klalit platinum","leumit kesef","leumit zahav","long term care","maccabi kesef","maccabi sheli","maccabi zahav","meuhedet adif","meuhedet shi'a","meuhedet shi\\","private medical insurance","ביטוח בריאות פרטי","ביטוח הריון","ביטוח לידה","ביטוח לתאונות אישיות","ביטוח לתינוק","ביטוח מחלות קשות","ביטוח משלים כללית","ביטוח משלים לאומית","ביטוח משלים מאוחדת","ביטוח משלים מכבי","ביטוח סיעודי","ביטוח קולקטיב סיעודי","ביטוח רפואי לחו\"ל","ביטוח רפואי לתיירים","ביטוח רפואי מקיף","ביטוח רפואי פרטי","ביטוח רפואי תושב חוץ","ביטוח שיניים פרטי","החזר מקופת חולים","החזר רפואי","השתתפות עצמית רפואית","כללית מושלם","כללית פלטינום","לאומית זהב","לאומית כסף","מאוחדת עדיף","מאוחדת שיא","מכבי זהב","מכבי כסף","מכבי שלי","תוכנית בריאות פרטית"],"category":"בריאות / בריאות","subcategory":"ביטוח רפואי - השלמות וביטוחים פרטיים"},
  {"keywords":["altman","anavi","be by super pharm","be super","be בי","centrum","good pharm","hadas","life pharm","melatonin","new pharm","otc","pharm deal","pharmex ישראל","probiotic","solgar","super pharm","tosef tzunatzi","vitamins","אינסולין","אלטמן","אלטמן תוספי תזונה","אנובי","אקס פארם","בית מרקחת","בית מרקחת כללית","בית מרקחת לאומית","בית מרקחת מאוחדת","בית מרקחת מכבי","בית מרקחת מקוון","בית מרקחת פרטי","בית מרקחת קופת חולים","גוד פארם","הדס תוסף","ויטמין","ויטמינים","כדור מצב","לייף","מלטונין","מרקחת מהירה","ניו פארם","ניופארם","סולגאר","סופר פארם","סופרפארם","סנטרום","פארם דיל","פארמסי","פרוביוטיק","פרוביוטיקה","תוסף אומגה 3","תוסף ברזל","תוסף ויטמין d","תוסף תזונה","תרופה","תרופה ללא מרשם","תרופה מרשם","תרופות otc","תרופות אנטיביוטיקה","תרופות כולסטרול","תרופות כרוניות","תרופות לחץ דם","תרופות לסוכרת","תרופות סוכרת","תרופות שינה"],"category":"בריאות / בריאות","subcategory":"תרופות ובתי מרקחת"},
  {"keywords":["agrat kvura","brit milah","chevra kadisha","headstone","kadisha","kashrut","ktuba","lulav","matzeva","mikveh","moetza datit","mohel","shiva","tzedaka","אבל","אגרת ברית","אגרת חופה וקידושין","אגרת מקווה","אגרת קבורה","ארבעת המינים","אתרוג","בד\"ץ העדה החרדית","ברית מילה","בריתה","הדס","השגחת כשרות","חברת קדישא","טהרה","ישיבת חברון","ישיבת מיר","ישיבת פוניבז","ישיבת קול תורה","ישיבת רבנו חיים","כולל אברכים","כשרות","כשרות בד\"ץ","כשרות רבנות","כתובה","לולב","מוהל","מועצה דתית","מימון תורני","מעות חיטין","מעות פירות","מפעל כשר","מצבה","מצוות","מצות יד","מקווה","מקווה נשים","סוכה","סוכן רבני","סוכת עץ","ערבה","פדיון הבן","פדיון פטר חמור","פסח כשר","צדקה","קבורה אזרחית","רב הרושם","שבעה","תעודת כשרות","תעודת נישואין רבנית","תשלום למועצה דתית"],"category":"ממשלה ומיסים","subcategory":"שירותי דת ומועצות דתיות"},
  {"keywords":["airbnb ארוכת טווח","anglo saxon","appraiser","architect","ariach","arvut","beit kal","blacksmith","booking ארוכת טווח","century 21","coldwell banker","demey schirut","electrician","gzeret","hadarim","homeless israel","hovalat dira","i dira","instalatzia","interior designer","kablan shiputzim","kitchen cabinets","komo","komo נדל","tzviiat dira","urbana","yad 2","yad2","zap real estate","אדריכל","אדריכלות","אורבנה","אחסון רהיטים","אחסנת חפצים","אינסטלטור","אינסטלציה","אנגלו סקסון","ארונות מטבח","אריחים","ארנונה שכירות","ב.מ. נדל","דמי שכירות","הובלת דירה","החלפת מנעול","הסכם שכירות","ועד בית שכירות","חדרים","חדרים שותפים","חוזה שכירות","חשמלאי","יד2","כיורים","מ-בית","מבית","מדלן","מהנדס בנין","מובילי דירות","מובילים","מטבח חדש","מילר נדל","ניסט","ניקיון אחר שיפוץ","סוכן נדל","עיצוב פנים","ערבות שכירות","פועלי שיפוצים","פיקדון שכירות","פרקט","פתיחת דלת מנעולן","צביעת בית","צביעת דירה","צבע דירה","צבעי דירה","קבלן שיפוצים","רובי נדל","רי 21","תיקון אינסטלציה","תיקון בית","תיקון חשמל בדירה","תיקון לאחר שכירות","תיקון פתח","תיקון תקלה בבית","תכנון אדריכלי","תכנון פנים","תשלום שכ"],"category":"הוצאות קבועות / בית","subcategory":"תיווך ונדל"},
  {"keywords":["aircall","callhub","cisco webex","cloud pbx","five9","genesys","google workspace business","goto meeting","justcall","merkaziya","microsoft 365 business","plivo","ringcentral","skype business","talkdesk","twillio","voip business","vonage","אייר קול","טאלקדסק","מספר וירטואלי","מרכזיה","מרכזיה וירטואלית","מרכזיה ענן"],"category":"הוצאות קבועות / חשבונות","subcategory":"מוקדי שירות וטלפוניה לעסקים"},
  {"keywords":["cyber insurance","directors & officers","ביטוח אוטובוסים","ביטוח אחריות מוצר","ביטוח אש","ביטוח בית משותף","ביטוח דירה למשכנתא","ביטוח דירקטורים","ביטוח חיים למשכנתא","ביטוח חקלאי","ביטוח מבנה משותף","ביטוח מחסן","ביטוח מטוסים","ביטוח מטעים","ביטוח מקצועי לעו","ביטוח מקצועי לעו\"ד","ביטוח מקצועי לרופאים","ביטוח משאיות","ביטוח סייבר","ביטוח ספינות","ביטוח עסק קטן","ביטוח פריצה","ביטוח קבוצתי","ביטוח קולקטיב","ביטוח קיברנטי","ביטוח רכבים מסחריים","ביטוח רכוש משותף","ביטוח שבר זכוכית"],"category":"הוצאות קבועות / ביטוח","subcategory":"ביטוח בנייני ועסקים"},
  {"keywords":["aramex","babylon translation","cheetah delivery","dhl","direct mail","dpi israel","fedex","ilim","israpost","maman shipping","metargem","office depot ישראל","otter.ai","pikud","pony express","print מהיר","quickprint","sonix","timlul","tirgum","tnt israel","transcription","translated.net","translator","trint","trustlate","ups israel","verbit","אילים שירותים","ארמקס","דואר מהיר","די אייץ' אל","די אייץ\\","יטה","ישראפוסט","מעלים תמונות","מתרגם","סקריבר","סריקת מסמכים","פדקס","פרסום ישיר","צ'יטה","צילום מסמכים","שירותי הדפסה","שירותי מזכירות","תמלול","תמלול אודיו","תמלול וידאו","תרגום אנגלית","תרגום מסמכים","תרגום ערבית","תרגום רוסית"],"category":"הוצאות קבועות / חשבונות","subcategory":"שירותים אדמיניסטרטיביים"},
  {"keywords":["adsl","cable tv","cellcom tv+","dsl","free tv","hot 3","hot 8","hot box","hot cable","hot hd","hot כבלים","partner tv+","pelephone tv","smart box","sting tv","vdsl","yes movies","yes plus","yes satellite","yes sport","yes לוויין","yes לוויין hd","אינטרנט סיב אופטי","אינטרנט קווי","באנדל סלולר ואינטרנט","באנדל סלולר וטלוויזיה","כבלים","ניתוק הוט","ניתוק יס","ספק לוויין","פרי טי וי","תיבת חכמה"],"category":"הוצאות קבועות / חשבונות","subcategory":"תקשורת - שירותי לוויין וכבלים"},
  {"keywords":["ahuzot hahof","apparko","carmel tunnels","cellopark","cellopark plus","easypark","highway 6","iipark","ipgsystem","kvish 6","pango","pango pay","pango vip","parkapp","pay-park","yarok","yarok חברה","אגרת חניה","אגרת חניון","אגרת כביש 6","אגרת כניסה לעיר","אחוזות החוף","אחוזות חוף תל אביב","איזיפארק","חניון אחוזות החוף","ירוק","כביש 6","מטר חניה","מטר חניה דיגיטלי","מנהרות הכרמל","סלופארק","פדיון חניה","פיי פארק","פנגו"],"category":"תחבורה / תחבורה ציבורית","subcategory":"תחבורה - אגרות חניה ודוחות"},
  {"keywords":["betterhelp","calm app","er\"an","headspace","mindfi","natal","sahar","talkspace","אשפוז יום","בית רוטשילד","גמילה","הדספייס","טיפול במכורים","טיפול בנערות","מוקד ערן","מטפל מוסמך","מרכז גמילה","מרכז יום פסיכיאטרי","מרכזי טיפול בנוער","נטל","סהר","ערן","תמורה לסיוע פסיכולוגי"],"category":"בריאות / רופא פרטי","subcategory":"שירותי בריאות הנפש ורווחה"},
  {"keywords":["akim","alut","alyn","beit issie shapiro","nitzan center","אבחון adhd","אבחון לקות למידה","אבחון מקצועי","אבחון פסיכודידקטי","אופק לחיים","אלוט","אלי","אלי\"ן","אקים","אקסטרא ילדים בריאות","בית איזי שפירא","טיפול בילדים בעלי צרכים מיוחדים","ליווי רגשי","מאמן אישי לילדים","מורה הוראה מתקנת","ניצן","סייענת לימודית","סייעת רפואית","פאזל ילדים מיוחד","פסיכוגרפיה","פסיכודידקטי","קלינאות תקשורת","ריפוי בעיסוק","תיקווה דחופה"],"category":"בריאות / רופא פרטי","subcategory":"שירותי קלינאות והעצמה"},
  {"keywords":["aaa israel","autoglass","carglass","drag tow","glassboard","israeli tow service","israli roadside","ituran emergency","ituran תקלות","memsi","plus ביטוח רכב","pomerantz tow","shagrir","shagrir tow","גרר רכב","החלפת שמשה","מועדון plus","ממסי","מערכת אזעקה רכב","סדהיים גרר","פוינטר","פוינטר הצלה","קרגלאס","שגריר","שגריר גרר","שירותי גרירה","תיקון שמשה","תיקון שמשה רכב"],"category":"הוצאות קבועות / ביטוח","subcategory":"ביטוח רכב מיוחד וגוררים"},
  {"keywords":["beit avot","beit avot tzipora","beit balev","care.com israel","goodlife israel","mediton day center","metapel siudi","nursing home","senior israel","אגד בית אבות","אהבת חיים","אחוזת הגיל","אחוזת הזהב","בית אבות","טיפול ביתי","טיפול קלינאות תקשורת לקשיש","טיפול שיקומי","מגדלי הים התיכון","מטפל סיעודי","מטפלת לקשיש","מעון יום לקשישים","מצוות ושלום","מרפאת שיקום","מתב גמלאים","סיעוד בבית","סיעוד מקצועי","עזרה סיעודית","פרוטיאה"],"category":"בריאות / רופא פרטי","subcategory":"שירותי שיקום וגיל הזהב"},
  {"keywords":["sherut ezrahi","sherut leumi","אגף הרווחה","בני נוער בסיכון","טיפול במשפחות","מחלקת רווחה","מענק הסדרת מעמד","מענק חורף","מענק לבנייה","מענק לעולה","מענק שיניים לקשיש","מענק שיקום","סבסוד עירייה","סבסוד פיקדון","סל בריאות","סל קליטה","שירות אזרחי","שירות לאומי","שירותי רווחה","תוכניות חינוך מיוחד","תוכנית התנדבות","תוכנית חברתית","תוכנית סייעות","תוכנית סל","תוכנית רווחה","תכנית טיפול"],"category":"ממשלה ומיסים","subcategory":"תוכניות ושוברי תרבות"},
  {"keywords":["academy 100","accelerator israel","adva course","business coach","coding academy","course programming","geek brains","ils tech","israel tech challenge","itc","itc bootcamp","jct","mba לימודי המשך","naya college","teudat handasai","teudat hora'a","teudat hora\\","triangle training","wix academy","wize israel","בית ספר לטכנאות","טכנאי מוסמך","טכנאי רכב","מאמן עסקי","מבוא לקבלנות","מהנדס מעשי","מכון לב","מסלול אינסטלציה","מסלול חשמלאות מוסמך","ניא קולג'","קורס javascript","קורס python","קורס פיתוח web","קורס תכנות","תוכנית האצה","תעודת הוראה","תעודת הנדסאי"],"category":"חינוך","subcategory":"מסלולי לימוד מקצועיים ותעודות"},
  {"keywords":["akademic books","booklit","milga","pera","pera\"m","scholarship","yedioth books","אגודת סטודנטים ארצית","אגודת סטודנטים בן גוריון","אגודת סטודנטים בר אילן","אגודת סטודנטים העברית","אגודת סטודנטים חיפה","אגודת סטודנטים תל אביב","אגרת דוקטורנט","אגרת ספרייה","אגרת פרויקט גמר","אגרת רישום אוניברסיטה","אגרת תרגיל","ביטוח סטודנט","דמי אבטחה","דמי רווחה סטודנטים","דמי שירותים אקדמיים","השכרת ספרי לימוד","חוברת תרגול אוניברסיטה","מילגה","סטודנטים יד שניה","ספרי לימוד יד 2","ספריית האוניברסיטה","פרויקט גמר","פרל\"מ","קנס ספרייה","תוכנית להגנת תזה","תזה מאסטר"],"category":"חינוך","subcategory":"אקדמיה - אגרות וביטוחי סטודנט"},
  {"keywords":["time of use","tou","התנתקות חשמל","חיבור 3 פאזות","חיבור חשמל חדש","מד דיגיטלי","מד חכם חשמל","מרכז חשמל","תעריף 1","תעריף 2","תעריף 3","תעריף חשמל יומי","תעריף חשמל לילי","תעריף חשמל שיא","תעריף מקטעי","תעריף משולב","תעריף סוגיא לבית","תקלה בחשמל","תקלות חברת חשמל"],"category":"הוצאות קבועות / חשמל","subcategory":"תעריפי חשמל - תכניות מיוחדות"},
  {"keywords":["btl.gov.il","אישור ביטוח לאומי","אישור הכנסות","אישור הצהרה","אישור ניהול ספרים","אישור ניכוי מס במקור","אישור עיסוק","אישור על מצב","באתר ביטוח לאומי","מלכ","מלכ\"ר","עמותה","תיק במלכ\"ר","תיק לפי 46"],"category":"ממשלה ומיסים","subcategory":"ביטוח לאומי - שירותים מקוונים"},
  {"keywords":["carcom","cardatas","cellpoint","dahua","g4s israel","hikvision","ituran","nest","pointer israel","pointer telematics","ring camera","securitas israel","sela security","shmira","tracker","tracker israel","vodafone security","אגב שמירה","אזעקה לבית","איתורן","מאבטח אישי","מודיעין אזרחי","מערכת אזעקה","מצלמה ביתית","מצלמות אבטחה","מקבוצת g4s","סורק תנועה","פוינטר","צפייה מרחוק","שירותי שמירה","שמירה חצוי"],"category":"הוצאות קבועות / ביטוח","subcategory":"ספקי אבטחה ואזעקות"},
  {"keywords":["אהוב כפר סבא","אחוזת באר שבע","אחוזת בית הכרם","אחוזת גני תקווה","אחוזת הכרם","אחוזת חוף תל אביב","אחוזת מצדה","אחוזת פולג","אחוזת רמת השרון","אחוזת רעננה","אחוזת תל אביב","בית בלב","בית בלב הוד השרון","דיור מוגן","כפר אז","כפר אז\"ר","מגדלי הים התיכון","נופי גני אביב","נופי הים","פרוטיאה ב\"ש","פרוטיאה גני תקווה","פרוטיאה דיור מוגן","פרוטיאה הוד השרון","פרוטיאה כפר סבא","פרוטיאה תל אביב"],"category":"בריאות / רופא פרטי","subcategory":"שירותי דיור מוגן וגיל הזהב"},
  {"keywords":["doula","pediatrician","tipat halav","דולה","התעמלות הריון","התפתחות הילד","טיפת חלב","טיפת חלב עירוני","יוגה הריון","יועצת הנקה","ילדים אסותא","ילדים מאיר","כללית טיפת חלב","לאומית טיפת חלב","מאוחדת טיפת חלב","מטפלת בלידה","מטרני","מטרני המרכז","מטרני הצפון","מיון ילדים","מכבי טיפת חלב","מכון התפתחות הילד","מרפאת התפתחות","פגישת ייעוץ הנקה","פדיאטר","פדיאטר תורן","פילאטיס הריון","קורס הכנה ללידה","קורס הריון","קורס לידה","רופא ילדים פרטי","תאומים"],"category":"בריאות / רופא פרטי","subcategory":"שירותי לידה ובריאות הילד"},
  {"keywords":["cardcom","easybill","easycount","greeninvoice","hashavshevet","hashavshevet cloud","hashavshevet erp","icount","icount business","invoicex","israel invoice","iקאונט","microsoft dynamics","mytax","netsuite","okongo","oracle erp","priority israel","rivhit","rivhit online","sap israel","sumit","tipalti","איזיקאונט","גרין אינווייס","חשבשבת","טיפלטי","סומיט","פריוריטי","רווחית"],"category":"פיננסים / השקעות","subcategory":"תוכנות חשבונאות וניהול"},
  {"keywords":["histadrut","אגד אגוד מקצועי","אגד תקשורת","ארגון השיניים","ארגון רואי חשבון","דמי חבר ועד","ההסתדרות הכללית","ההסתדרות הרפואית","הסתדרות","הסתדרות המורים","הסתדרות העובדים הלאומית","הסתדרות הציונית","ועד הרופאים","ועד עובדים","כוח לעובדים","לשכת האדריכלים","לשכת המהנדסים","לשכת המתווכים","לשכת הסוכנים","לשכת השמאים","לשכת עורכי הדין","לשכת רואי החשבון","תשלום ועד עובדים"],"category":"ממשלה ומיסים","subcategory":"ועדת מנהלת ואיגוד מקצועי"},
  {"keywords":["coding israel","hebrew open","le wagon israel","polyglot israel","toastmasters israel","אוניברסיטה ברדיו","אוניברסיטה משודרת","אילוף כלבים","אילוף לכלבים","כתיבה יצירתית","מורה לדיבור בציבור","מורה לטוס","סדנת אילוף כלבים","סדנת כתיבה","סדנת תיאטרון","סטודיו לציור מבוגרים","תעודת מאלף"],"category":"חינוך","subcategory":"מסלולי לימוד מבוגרים והעצמה"},
  {"keywords":["ezer mizion","latet","latet ישראל","mda תרומה","sela","yad sarah","zichron menachem","אגודת ניצולי השואה","ארגון יד שרה","ארגון לרווחה","זכרון מנחם","יד אליעזר","יד שרה","להב","תרומה לחיילים","תרומה למלאכי השמיים"],"category":"ממשלה ומיסים","subcategory":"שירותי דת והלכה - גמ"},
  {"keywords":["sedacare","smile kids","אורתודונט ילדים","ד\"ר שיניים ילדים פרטי","המקובל שיניים","ילדים שיניים פרטיות","ילדים שיניים קופת חולים","מכון שיניים לילדים","מרפאת שיניים אוניברסיטאית","מרפאת שיניים הילדים","מרפאת שיניים סמיילי ילדים","ניתוח חיתוך שפתיים","סדציה לילדים","שיניים בהכרה","שיניים לילדים"],"category":"בריאות / שיניים","subcategory":"שכר טיפול ושיניים בילדים"},
  {"keywords":["אגף האחיות","בית הספר לרפואה בן גוריון","בית הספר לרפואה הוצא ישראל","בית הספר לרפואה טכניון","בית הספר לרפואה ירושלים","בית הספר לרפואה צפת","בית הספר לרפואה תל אביב","בית ספר לסיעוד","פקולטה לסיעוד","פקולטה לפיזיותרפיה","פקולטה לקלינאות תקשורת","פקולטה לרוקחות","פקולטה לרפואה","פקולטת רפואה","תכנית הרפואה הבינתחומית"],"category":"חינוך","subcategory":"מוסדות חינוך - מקצועות הרפואה"},
  {"keywords":["auto tel","car2go ישראל","carpool ישראל","הסעות באומל","הסעות בית ספר","הסעות גן","הסעות לאירועים","הסעות לויטל","הסעות לחתונה","הסעות מורגנפלד","הסעות עובדים","הסעות פרטיות","הסעות צוקרמן","הסעות ש.ש.","הסעות תורניות","השכרת רכב חודשית","צי רכב חברה","שיתוף רכב"],"category":"תחבורה / תחבורה ציבורית","subcategory":"שירותי הסעות פרטיות וצי רכבים"},
  {"keywords":["אייאיג'י קפיטל","אייאיג\\","איילון ביטוחי חיים","ארכיון ביטוחים","ביטוחי קלנובסקי","הפניקס ביטוחי חיים","הפניקס בעיר","הפניקס בריאות","הפניקס סוכנויות","הראל ביטוחי חיים","הראל בעיר","הראל בריאות","הראל סוכנויות","כלל ביטוחי חיים","כלל בעיר","כלל בריאות","כלל סוכנויות","מבטח סימון","מבטחים החדשה","מגדל ביטוחי חיים","מגדל בעיר","מגדל בריאות","מגדל סוכנויות","מנורה ביטוחי חיים","מנורה בעיר","מנורה בריאות","מנורה סוכנויות","סוכנות גמל ופנסיה","סקיא סוכנויות","פסיפס סוכנות","פרי ביטוחים"],"category":"הוצאות קבועות / ביטוח","subcategory":"ביטוחי חיים וחיסכון - מותגי משנה"},
  {"keywords":["clal travel","davidshield","esta","etias","harel travel","hofim","insurance for travelers","migdal insurance travel","passportcard","אגרת בטחון נמל","אגרת יציאה","אגרת נמל","אגרת נסיעה לחו","אגרת נסיעה לחו\"ל","אגרת תעופה","אסטה","ביטוח חירום בנסיעה","ביטוח מטען בנסיעה","ביטוח נסיעות passportcard","ביטוח נסיעות הפניקס","ביטוח נסיעות הראל","ביטוח נסיעות כלל","ביטוח נסיעות מגדל","ביטוח נסיעות מנורה","ויזה לאוסטרליה","ויזה לארה\"ב","ויזה לקנדה","טופס אישור שהייה","טופס ויזה","טופס יציאה לחו","טופס יציאה לחו\"ל","פספורט קארד"],"category":"ממשלה ומיסים","subcategory":"תיירות, אגרות וביטוחי נסיעות"},
  {"keywords":["business consultant","mashkanta consult","pension net","personal finance israel","yoetz iski","אגרת חוות דעת","יועץ משכנתאות","יועץ עסקי","ייעוץ אסטרטגי","ייעוץ ארגוני","ייעוץ מס בנדל","ייעוץ מס בנדל\"ן","ייעוץ מס רכישה","ייעוץ מס שבח","ייעוץ משכנתאות","ייעוץ נדל\"ני","ייעוץ עסקי","ייעוץ פיננסי","להב המרכז למשכנתאות","ליווי עסקי","ליווי פיננסי","מאמן עסקי","מומחה משכנתאות","מומחה פנסיה","מומחית פנסיה","מרכז חינוך פיננסי","סוכן פנסיה","סופיה משכנתאות","פנסיה נטו","ראשי הסבר פנסיוני","תכנון פיננסי אישי"],"category":"פיננסים / השקעות","subcategory":"שירותים מקצועיים נוספים - יעוץ"},
  {"keywords":["assa כלל","drive!","plus care","plus road","plus track plus","pointercar","tag smart","אורקל פלוס","דרייב ישראל","טאג גארד","מועדון plus","מרכז השירות הראל","מרכז השירות כלל","מרכז השירות מגדל","פלוס דרך","פלוס שירותי דרך"],"category":"הוצאות קבועות / ביטוח","subcategory":"ביטוח רכב - שירותי דרך"},
  {"keywords":["corporate tax","hahzer mas","mas hevrot","אישור תיאום מס","החזר מס","טופס 102","טופס 103","טופס 106","טופס 1301","טופס 1399","טופס 161","טופס 856","טופס פטור","טופס תיאום מס","מס חברות","מס יבוא","מס יחסי","מס ייצוא","מס מעסיק תוסף","מס מקלט","מס נחלי הקיץ","מס שכר עליון","מס שכר עצמאי","מקדמה רבעונית","מקדמות מס","ניהול חשבונות מומחה","ניכוי במקור 30%","פיצויים בפיטורים","רישום שכר","שכר חודשי","שכר עבודה רגיל","שכר שעתי","תוספת שכר","תלוש שכר"],"category":"ממשלה ומיסים","subcategory":"מיסי חברה - תאגידי וניהול"},
  {"keywords":["aegean israel","aero israel","aeroflot israel","air europa israel","arkia פנים ארצי","border tax","brussels airlines","cyprus airways","departure tax","elal cargo","emirates","etihad","iberia israel","israir פנים ארצי","qatar airways","royal jordanian","singapore airlines","sun dor","tarom","אגרת עזיבה ישראל","אגרת שדה תעופה","אגרת תעופה","אל על פנים ארצי","טיסה פנים ארצית","טיסת פנים"],"category":"תחבורה / תחבורה ציבורית","subcategory":"תחבורה - נסיעות לחו"},
  {"keywords":["heital hashbacha","heter bniyah","moded musmach","tatsa"],"category":"הוצאות קבועות / בית","subcategory":"נדל"},
  {"keywords":["אגרת בטיחות רכב","אגרת רישוי אוטובוס","אגרת רישוי טרקטור","אגרת רישוי מיניבוס","אגרת רישוי משאית","אגרת רישוי קרוואן","אגרת רכב היברידי","אגרת רכב חשמלי","אגרת תקני זיהום","חוות דעת רכב","טסט שמאות","טרם תאריך","ירידת ערך רכב","פוליסת חובה","פוליסת מקיף","פוליסת רכב צד ג","פוליסת תאונות אישיות","שמאי רכב","תיק תאונה","תעודת בדיקה רישוי","תעודת ביטוח חובה","תעודת ביטוח רכב","תקן זיהום אוויר"],"category":"ממשלה ומיסים","subcategory":"אגרות תעבורה - לרכב ולמשאיות"},
  {"keywords":["bus.gov.il","citymapper","easy israel bus","hopon","iride israel","israel routes","maon נסיעות","mobit","moovit","pelephone pay&go","rav kav online","tov la'sviva","tov la\\","train.gov.il","waze ישראל","אגרת רכבת ישראל","אפליקציית רב קו","כרטיס גמלאי תחבורה","כרטיס חייל תחבורה","כרטיס סטודנט תחבורה","כרטיס רכבת","כרטיסים מוזלים סטודנט","שוברי רכבת"],"category":"תחבורה / תחבורה ציבורית","subcategory":"תחבורה - שירותים מקוונים ואפליקציות"},
  {"keywords":["agarot","esg השקעות","forex spread","makam","one zero אפליקציה","pepper app","pepper הבנק","אגרת חוב ממשלתית","אגרת ממשלתית","אפליקציית דיסקונט","אפליקציית הבינלאומי","אפליקציית הפועלים","אפליקציית לאומי","אפליקציית מזרחי טפחות","אפליקציית פאגי","המרת מטבע חוץ","השקעה אחראית","התקנת אפליקציית בנק","מטבע חוץ אירו","מטבע חוץ דולר","מק\"מ","עמלת swift","עמלת המרת מטבע","עמלת העברה בנקאית","עמלת הקצאת מסגרת","עמלת חריגה","עמלת כספומט","עמלת מטבע חוץ","עמלת משיכת מזומן","עמלת ניהול חשבון","עמלת שיק","ערוץ סולידי","פיקדון יומי","פיקדון מובנה","פיקדון מטבע חוץ","פיקדון פנסיוני","פיקדון פרישה","פיקדון שקלי","ריבית בנקאית","ריבית חריגה","ריבית סולידית","ריבית פיגורים","ריבית פנקאית"],"category":"פיננסים / השקעות","subcategory":"פיקדונות, ניהול חשבון ועמלות בנקאיות"},
  {"keywords":["har habituach","harel הר הכסף","migdal הר הכסף","pension clearing house","אישור הפקדות","אישור פנסיוני","המסלקה","המסלקה הפנסיונית","הר הביטוח","הר הכסף","מסלקת הזמנים","ניוד גמל","ניוד השתלמות","ניוד פנסיה","סעיף 14","סעיף 187","סעיף 45א","סעיף 47","ספק לפנסיה","רשות שוק ההון ביטוח וחיסכון","תיק מסלקה","תיקון 190","תמא 13","תמא 60"],"category":"פיננסים / השקעות","subcategory":"תכנון פנסיוני וזכויות"},
  {"keywords":["impoex","magnit","metron","mt-test","mytest","אינוקס רכב","אישור זיהום אוויר","טסט שנתי","מבחן זיהום אוויר","מבחן רכב","מבחן רכב לאחר תאונה","מבחן רכב משומש","מטרון ישראל","מכון רישוי אשדוד","מכון רישוי באר שבע","מכון רישוי חיפה","מכון רישוי ירושלים","מכון רישוי כפר סבא","מכון רישוי נתניה","מכון רישוי רעננה","מכון רישוי תל אביב","סקר אבזרי בטיחות","סקר תקופתי"],"category":"תחבורה / תחבורה ציבורית","subcategory":"אגף הרישוי - מבחנים לרכב"},
  {"keywords":["betterclean israel","cleani","cleaning service","cleano","dryclean israel","easy wash","home cleaner","laundry","machbasa","magiclean","maids israel","maman cleaning","mishmar cleaning","niko","quick wash israel","מכבסה","מכבסה אצלך","מכבסה דאניה","מכבסה חיפה","מכבסה ירושלים","מכבסה תל אביב","מעיין שירותי ניקיון","ניקיון בית","ניקיון חודשי","ניקיון יבש","ניקיון לאחר שיפוץ","ניקיון לפני חג","ניקיון לפסח","ניקיון משרד","עוזר בית","עוזרת בית","פולוקס"],"category":"הוצאות קבועות / בית","subcategory":"שירותי ניקיון בית ועזרה"},
  {"keywords":["tav nechut","אגרת רישוי נכה","הנחה ארנונה","הנחה ארנונה גמלאי","הנחה ארנונה ילד מיוחד","הנחה ארנונה משפחה מרובת ילדים","התאמת רכב לנכה","ועדה רפואית","ועדה רפואית ביטוח לאומי","ועדה רפואית משרד הביטחון","מס הרכישה לנכה","סובסידיה נכה","פטור ארנונה גמלאי","פטור ארנונה נכה","פטור ממס שבח","תג נכה","תו נכה","תיק חוסים","תיק נכה","תיק נפגעי איבה","תיק נפגעי תאונת דרכים"],"category":"ממשלה ומיסים","subcategory":"שירותים מיוחדים - גמלאים ונכים"},
  {"keywords":["doh service","hadarei pataq","lock24","locksmith israel","plumber 24","quick plumber","smart lock","אחזקת דוד שמש","אינסטלטור 24","אינסטלטור חירום","ביוב סתום","החלפת מנעול","התקנת דוד שמש","מנעול דיגיטלי","מנעולן 24/7","מנעולן חירום","פתיחת ביוב","פתיחת דלת חירום","תיקון אסלה","תיקון ברז","תיקון דוד שמש","תיקון מנעול"],"category":"הוצאות קבועות / בית","subcategory":"ספקי מנעולים ושירות חירום"},
  {"keywords":["israeli opera","leaan","leaan tickets","tarbuta","tickets tel aviv","אופרה ישראלית","הבימה","המשכן לאמנויות הבמה","הפילהרמונית הישראלית","הקאמרי","חוג תרבות","כרטיס תרבות עובד","כרטיסי תיאטרון","מוזיאון ישראל","מוזיאון לאמנות מודרנית","מוזיאון תל אביב לאמנות","מועצה לתרבות ואמנות","סל תרבות עירוני","סלע תרבות","פילהרמונית","תזמורת סימפונית","תיאטרון באר שבע","תיאטרון בית ליסין","תיאטרון הספרייה","תיאטרון הקאמרי","תיאטרון חיפה","תיאטרון ירושלים","תיאטרון עידן","תיאטרון תמונע","תרבותא"],"category":"ממשלה ומיסים","subcategory":"מוסדות תרבות וטריבליות"},
  {"keywords":["12 צעדים","al anon israel","beit hahalama","beit lessin rehab","beit mishpaha","carmei haim","elem ישראל","methadon israel","retorno","tikvati","אלם ישראל","בית ההחלמה","גמילה מאלכוהול","גמילה מהימורים","גמילה מסמים","גמילה מעישון","מועדון יום","מועדון יום שיקומי","מקלט גברים","מקלט נשים","מרכז גמילה","רטורנו","תכניות שיקום נפשי"],"category":"בריאות / רופא פרטי","subcategory":"בריאות - גמילה ובעיות תלות"},
  {"keywords":["hadarim academic","אגרת השכלה גבוהה","אגרת רישום מל","אגרת רישום מל\"ג","אגרת תעודת הוראה","אישור מל\"ג","המועצה להשכלה גבוהה","התאמה אקדמית","התאמת לימודים","ועדה לתכנון ולתקצוב","ות\"ת","מל\"ג","ראש ההון האנושי"],"category":"חינוך","subcategory":"מוסדות אקדמיים - תקצוב מדינה"},
  {"keywords":["hama'aliyot vet","hama\\","pet clinic","pets israel","vetcare","veterinar","veterinarian","vetokim","vetsmile","אגד וטרינריה","אגרת וטרינר עירונית","אילוף כלבים","אישור בריאות לכלב","וטסל","וטרינר","וטרינר חיפה","וטרינר ירושלים","וטרינר תל אביב","חיסון לחתול","חיסון לכלב","מאלף כלבים","מעון לכלבים","מעקה כלב","מרפאת וטרינר","סטרילציה לחתולה","סטרילציה לכלב","פנסיון לחתול","פנסיון לכלב","תעודת זהות לכלב"],"category":"בריאות / רופא פרטי","subcategory":"הוצאות לבעלי חיים - וטרינר ושירותים"},
  {"keywords":["פי סטורם","(mt) media temple","1 password","123 rf","123rf","1password","1password family","365 family","365 personal","500px awesome","500px pro","99designs","a2 hosting","ab tasty","abstract","abstract design","acast","acrobat pro","active campaign","activecampaign","activepieces","adalo","adobe","adobe acrobat","adobe after effects","adobe all apps","adobe analytics","adobe audition","adobe cc","adobe creative cloud","adobe fonts","adobe illustrator","adobe indesign","adobe lightroom","adobe photoshop","adobe premiere","adobe sign","adobe stock","adobe xd","affinity designer","affinity photo","affinity publisher","affinity suite","after effects","agora pulse","agorapulse","ahrefs","airbase","airbyte","airmeet","airtable","airtable business","airtable pro","akamai connected cloud","alamy","alien skin","amazon ses","amazon web services","amberscript","amplify hosting","amplitude","amplitude analytics","amplitude growth","anchor by spotify","ansys student","any.do","any.do premium","anydo","apollo crm","apollo io","apollo.io","app sumo","appgyver","apple icloud+","apple one","apple one family","apple one premier","appsmith","appsumo","appsumo plus","art19","asana","asana business","asana premium","ashby","askable","attentive mobile","audition","auphonic","auto cad","autocad","autocad lt","automate.io","aweber","aweber pro","aws","aws billing","aws ec2","aws lambda","aws s3","azure","azure functions","azure static web apps","balsamiq","balsamiq cloud","bamboo hr","bamboohr","basecamp","be.live","beacons","beacons.ai","beehiiv","beehiiv pro","behance prosite","bigcommerce","bill.com","bio.site","bitbucket","bitwarden","bitwarden family","bitwarden premium","bizzabo","blender cloud","blubrry","blue host","bluehost","bmc","boomi","box","box business","box.com","brandwatch","brevo","brex","bubble","bubble pro","bubble.io","buffer","buffer essentials","buffer team","bugsnag","buy me a coffee","buymeacoffee","buzz sprout","buzzsprout","cal.com","calendly","calendly pro","calendly teams","campaign monitor","camtasia","canva","canva for teams","canva pro","cap cut pro","capcut pro","captions ai","captions app","captivate","captivate.fm","capture one","capture one pro","carbonmade","carrd","carrd pro","casttagram","circle community","circle.so","cleanup.pictures","clearscope","clickup","clickup business","clickup unlimited","clion","close crm","close.io","cloud functions","cloud run","cloudflare","cloudflare business","cloudflare pro","cloudflare workers","cloudways","coda","coda doc","codeium","codesandbox","concord","concord contracts","concur sap","confluence","constant","constant contact","convert.com","convertkit","convesio","copper","copper crm","coroflot","crazy egg","crazyegg","creately","creative cloud","creative fabrica","creative market","creativemarket","creator iq","creator studio","crisp","crisp chat","cvent","darktable","dashlane","dashlane premium","data dog","databricks","datadog","datagrip","davinci resolve","davinci resolve studio","ddeposit photos","dedicated server","deel","deel hr","demio","demio webinar","deno deploy","depositphotos","descript","descript pro","design cuts","designcrowd","designhill","diagrams.net","digital ocean","digitalocean","discord boost","discord nitro","divvy bill","docsign","docusign","domain renewal","domain renewal fee","domain rew","domo","doodle","doodle premium","drawio pro","dreamhost","dreamstime","dribbble pro","drift","drift conversational","drip","drip ecommerce","dropbox","dropbox business","dropbox plus","dropbox professional","dropbox sign","dxo","dxo photolab","easywebinar","ecamm live","edgio","elai.io","elastic cloud","elasticsearch","elementor","elementor pro","email octopus","emailoctopus","envato","envato elements","envato pro","envatoelements","epic megagrant","erp next","eventbrite organizer","eventbrite premium","evernote","evernote premium","evernote professional","eversign","everwebinar","expensify","exposure x","factorial","fathom","fathom analytics","feathery","feefo","fig jam","figjam","fillout","filmora","final cut","final cut pro","firebase","firebase blaze","fireside.fm","fiverr business","fiverr pro","fivetran","flaticon","flaticon premium","flickr","flickr pro","fliki tts","flutter flow","flutterflow","fly","fly machines","fly postgres","fly.io","flywheel","font awesome pro","fontawesome pro","fonts.com","format portfolio","format.com","formstack","framer","frase","freelancer plus","freelancer.com","fresh books","fresh sales","freshbooks","freshdesk","freshsales","freshteam","freshworks","front","frontapp","full story","fullstory","fusion 360","g suite","ga 360","ga4 360","garageband","gather.town","gcp","get response","getresponse","ghost","ghost pro","ghost professional","gigapixel","gigapixel ai","gitlab","gitlab premium","gitlab ultimate","glide","glide pro","go to meeting","godaddy hosting","goland","google analytics 360","google business","google cloud","google cloud platform","google fonts","google forms premium","google meet","google one","google optimize","google storage","google workspace","google workspace business","gorgias","gotomeeting","grammarly","grammarly business","grammarly premium","graphic river","graphpad prism","greenhouse","gridpane","gun.io","guru.com","gusto","happy scribe","happyscribe","heap","heap analytics","hello sign","hellosign","help scout","helpscout","heroku","hetzner","heygen creator","hibob","hilan","hilan tech","hoot suite","hootsuite","hopin","hostgator","hostinger","hotjar","houdini","hubspot","hubspot enterprise","hubspot marketing","hubspot pro","hubspot sales","hubspot service","hubspot starter","huggin","huginn","humi","icloud plus","icloud storage","icloud+","iconfinder","icono square","iconosquare","iconscout","if this then that","ifttt","ifttt pro","illustrator","in video","indesign","insomnia","insomnia plus","instantly","instantly.ai","integromat","intellij","intellij ultimate","intercom","intercom pro","invideo","invision","invision freehand","invision studio","ionos","ironclad","israeli payroll: שכר","istock","istockphoto","jet brains","jetbrains","jetbrains all","jetbrains all pack","jetbrains all products","jetbrains toolbox","jira","jira premium","jira software","jmp pro","jotform","judge.me","justworks","kajabi","kamatera","kapwing","kapwing pro","keeper","keeper security","kinsta","kit by convertkit","klaviyo","klaviyo email","klaviyo sms","klear","ko fi","ko-fi","kofi","krisp pro","kumospace","labview","lambda compute","lastpass","lastpass premium","later","later analytics","later influence","later social","lawpath","learn worlds","learnworlds","leaseweb","legalzoom","lemlist","less annoying","less annoying crm","lets enhance","letsenhance","lever","lib syn","libsyn","lightroom","linear","linear app","link tree","linkin.bio","linktree","linktree pro","linode","live chat","livechat","logic","logic pro","logrocket","lookback.io","looker","looker studio pro","loom","loom business","loom pro","loomly","loox","lottiefiles pro","lu.ma","lucid chart","lucidchart","lucidspark","lucky orange","luma","luma ai","luma events","lumen5","luminar ai","luminar neo subscription","mailchimp","mailchimp premium","mailchimp standard","mailer lite","mailerlite","mailgun","majestic seo","make","make.com","marketmuse","marmoset toolbag","marvel app","marvelous designer","matillion","matlab","matomo","maze","maze design","media temple","medium","medium friend","medium membership","mega","mega upload","mega.nz","megaphone","meltwater","memberful","mendix","mention","metabase","metricool","michpal","michpal שכר","microsoft 365","microsoft azure","microsoft business","microsoft teams","microsoft visio","mighty","mighty networks","milanote","minitab","miro","miro business","miro team","mixpanel","mixpanel growth","mockplus","mode analytics","modo","monday","monday crm","monday work","monday work management","monday.com","mongodb atlas","monotype fonts","moosend","moz","moz pro","mparticle","ms 365","mulesoft","mural","mural app","muralto","myfonts","n8n","n8n cloud","namecheap hosting","namely","narakeet","natural reader pro","navan","neil patel","neon","neon db","netlify","netlify business","netlify pro","netsuite","new relic","ngrok","nitro","nordpass","notion ai","notion business","notion family","notion plus","notion pro","noun project","nvidia broadcast","obs studio donation","odoo","odoo enterprise","office 365","office business","office home","okendo","on1 photo raw","on24","one drive","onedrive","onedrive personal","openai whisper","optimizely","opus clip","opus.pro","oracle netsuite","organize software","origin pro","otter premium","otter.ai","outreach","outreach.io","outsystems","ovh","pandadoc","pantheon","papaya global","paperform","passion pro","patreon","patreon membership","paypal","paypal business","pcloud","pcloud lifetime","peopleperhour","personio","phase one capture","photo mechanic plus","photoshelter","photoshop","phpstorm","pipedream","pipedrive","pixpa","planet scale","planetscale","planoly","plausible","playbook ux","podbean","podcastle","podia","podiant","posthog","posthog cloud","postman","postman pro","postman team","postmark","postscript","power bi","powerbi","premiere","premiere pro","preset","preset.io","pressable","priority software","procreate","proton drive","publer","pycharm","pycharm pro","qbo","qlik sense","qualtrics","quick books","quickbooks","quickbooks online","quickbooks self-employed","railway","railway.app","ramp","rankmath pro","rapid api","rapidapi","raw therapee","redcircle","redis cloud","remo","remote.com","remove.bg pro","removebg","render","render free tier upgrade","render.com","replit","replit core","replit hacker","replit pro","respondent.io","restream","retool","rev","rev caption","rev transcript","rev translation","rev video","rev.com","reviews.io","revue twitter","rhino 3d","rider","rippling","rive app","riverside","riverside.fm","rivery","roboform","rocket lawyer","rocket.net","rollbar","rubymine","rudderstack","rustrover","sage accounting","sage business cloud","sales cloud","salesforce","salesforce essentials","salesforce professional","salesforce starter","salesloft","sap","sas software","scaleway","screaming frog","screencast o matic","screencast-o-matic","scribie","segment","semrush","semrush business","semrush guru","semrush pro","send grid","send in blue","sendgrid","sendible","sendinblue","sentry","service cloud","shakarit","shopify","shopify advanced","shopify basic","shopify payments","shopify plus","sigma computing","sign easy","signeasy","signnow","signrequest","simple analytics","simplecast","site ground","sitegrond","siteground","sketch","sketch app","skool","skool.com","skylum","slack","slack business","slack pro","slack standard","smart lead","smart sheet","smartdraw","smartlead","smartlook","smartsheet","smsbump","smugmug","smugmug pro","snowflake","social pilot","socialpilot","softr","softr pro","solidworks","sonix","sourcegraph","speakatoo","speechpad","speedtree","spendesk","splash events","splash hq","spotify for podcasters","spreaker","sprinklr","sprout social","sproutsocial","spss","spyfu","square","square pos","squarespace","squarespace business","squarespace commerce","squarespace personal","squarespace portfolio","ssl certificate","ssl premium","stackblitz","stackpath","stamped.io","stan store","stata","stitch data","streamyard","stripe","stripe atlas","submagic","substack","substack pro","substance designer","substance painter","substance suite","supabase","supabase enterprise","supabase pro","supabase team","surfer seo","surferseo","survey monkey","surveymonkey","sync","sync.com","synthesia studio","tab nine","tableau","tableau creator","tableau pro","tabnine","tabula","tabula shaltrum","tailwind","tailwind app","tailwind plus","tailwind ui","tailwindapp","talkwalker","tally forms","tally.so","tawk.to","tawkto","teachable","telegram premium","temi","the noun project","things 3","things app","thinkific","thoughtspot","thunkable","ticktick","ticktick premium","tinkercad subscription","tip jar","tipalti","tipeee","todoist","todoist premium","todoist pro","tooljet","topaz denoise","topaz gigapixel","topaz labs","topaz photo ai","topaz sharpen","topaz video ai","toptal","transistor","transistor.fm","transkriptor","tray","tray.io","trello","trello business","trello premium","trello standard","tresorit","trinet","trint","trint plus","tripactions","trustpilot business","twilio segment","twist","type form","typeform","ubersuggest","unity industry","unity plus","unity pro","unreal engine","upcloud","upwork basic","upwork freelancer plus","upwork plus","useberry","user interviews","user testing","userinterviews","usertesting","vecteezy","vector eezy","veed","veed.io","veo","veo video","verbit","vercel enterprise","vercel pro","vercel teams","viewbug premium","visio","voicebooking","voicemod","voicemod pro","vps server","vps שרת","vue infinite","vultr","vwo","vwo testing","wave","wave accounting","wave invoicing","wave payroll","webex","webex events","webex meetings","webflow","webflow agency","webflow cms","webflow ecommerce","webflow premium","webflow pro","webflow workspace","webinarjam","webstorm","whimsical","whisper api","wirecast","wix","wix business","wix combo","wix premium","wix unlimited","wix vip","wolfram alpha","wolfram alpha pro","wolfram mathematica","woocommerce","woodpecker","woodpecker email","wordpress premium","wordpress.com","workable","workato","workspace standard","workspace starter","world machine","wp engine","wp vip","wpengine","wpx hosting","wrike","wufoo","xero","xero premium","yoast premium","yoast seo","yotpo","z brush","zapier","zapier company","zapier premium","zapier professional","zapier team","zendesk","zendesk suite","zendesk support","zenfolio","zoho","zoho books","zoho crm","zoho one","zoom","zoom one","zoom pro","zoom workplace","אבי","אדאלו","אדובה","אדובי","אדובי אדישן","אדובי כל","אדובי סטוק","אדובי פוטושופ","אדובי פרמייר","אדובי קלאוד","אדישן","אהרפס","אהרפס סאו","אובר-סאג'סט","אובר-סאג\\","אווברר","אוורנוט","אוטר","אופוס קליפ","אופטימייזלי","אופיס 365","אופיס משפחה","אופיס פמילי","אופיס פרסונל","אורגנייז","אז'ור","אז'ור ענן","אז\\","אחסון גוגל","אייקלאוד אחסון","אייקלאוד פלוס","אייר-טייבל","אילוסטרייטור","אינדיזיין","אינטגרומאט","אינטלי-ג'יי","אינטרקום","אינסומניה","אירטייבל","אלמנטור","אמזון ענן","אמפליטוד","אנגרוק","אסנה","אפטר אפקטס","אפיניטי דיזיינר","אפיניטי סוויט","אפיניטי פבלישר","אפיניטי פוטו","אפל וואן","אקטיב קמפיין","אקס די","אקרובט","באגסנג","באי מי אה קופי","באפר","בוקס","ביג קומרס","ביהיב","ביטבאקט","ביטוורדן","בייסקאמפ","ברבו","ג'וט פורם","ג'ט ברינס","ג'טברינס","ג'י סוויט","ג'י-מיט","ג'ירה","גוגל וואן","גוגל וורקספייס","גוגל קלאוד","גולנד","גוסט פרו","גורגיאס","גיטלאב","גלייד","גראז' בנד","גראז\\","גרמרלי","דאוינצ'י","דאוינצי","דאטהבריקס","דאטהגריפ","דאטהדוג","דאשליין","דודל","דוקיוסיין","דיג'יטל אושן","דיג\\","דיגיטל אושן","דיסקורד ניטרו","דיסקריפט","דרופבוקס","האבספוט","הוטג'אר","הוטסוויט","הוסטינגר","הירוקו","הצנר","הרוקו","ואן פסוורד","וב-סטורם","ובאנג'ין","ובאנג\\","ובסטורם","ובפלאו","וו קומרס","וואן דרייב","וואן פאסוורד","ווב אקס","וויקס","וולטר","וורדפרס פרימיום","ויאד","ויקס פרימיום","ולפרם","זאפייר","זוהו","זום","זום פרימיום","זנדסק","חידוש דומיין","חילן","ט ברינס","טאבניין","טודויסט","טווילאו סנדגריד","טוויסט app","טייל וינד יו אי","טייפפורם","טיצ'בל","טיק טיק","טלגרם פרימיום","טרזוריט","טרינט","טרלו","י סוויט","ימפ","ינקיפיק","ירה","לאסטפס","לוג רוקט","לוג'יק פרו","לוג\\","לומן5","לייטר","לייטרום","ליינוד","ליניאר","למליסט","לסט-פאס","מ-ברפול","מאטומו","מאנדיי","מאנדיי דוט קום","מאנקי סקר","מגה nz","מדיום","מוז פרו","מונגו אטלס","מטהבייס","מיילצ'ימפ","מיילרלייט","מייק.קום","מיכפל","מילגאן","מיקס פנל","מיקרוסופט 365","מיקרוסופט טימס","מירו","נורד-פאס","נטליפיי","ניאון","ניו רליק","סאבמאג'יק","סאבמאג\\","סאבסטאק","סוניקס","סופאבייס","סופטר","סורסגרף","סטאקבליץ","סטרייפ","סי ליון","סיילסלופט","סיילספורס","סינטל שכר","סינק","סירקל","סלאק","סם-ראש","סמארטשיט","סנדיבל","סנדינבלו","סנופלייק","סנטרי","ספייפו","ספראוט סושיאל","ספרינקלר","סקאצ'","סקוור ספייס","סקוורספייס","סקול","סקצ'","ענן אמזון","ענן גוגל","פאבלר","פאואר ביאי","פודיה","פוטושופ","פוסטהוג","פוסטמן","פטראון","פי אייץ' פי סטורם","פיי פאל","פיינל קאט","פייפדרייב","פייפדרים","פייצ'ארם","פייצ\\","פייצארם","פיירבייס","פילמורה","פיפדרייב","פיקלאוד","פלאוזיבל","פלאנולי","פלאנט סקייל","פליי","פרוטון דרייב","פרוקריאט","פריוריטי","פריימר","פרמייר","פרש דסק","פרשסיילס","קאג'אבי","קאנבה","קאפ קאט","קאפקאט פרו","קוד סנדבוקס","קודה","קודיום","קונברטקיט","קונפלואנס","קינסטה","קלאודפלייר","קלאוויו","קליק אפ","קלנדלי","קמטסיה","קנבה פרו","ראסט-רובר","ראפיד-אפיאיי","רב טרנסקריפט","רדיס","רובופורם","רובי מיין","רולבר","ריברסייד","ריזולב","ריטול","ריידר","רייק","ריפליט","שופיפיי","שיקלולית","שכרית","שרת ייעודי","ת'אנקאבל","ת'ינקיפיק","תוכנת שכר","תעודת ssl"],"category":"הוצאות קבועות","subcategory":"כלי עבודה"},
  {"keywords":["11labs","adobe firefly","agent ops","agent.ai","alfred","alfred powerpack","amazon q","amazon q developer","amazon q developer pro","anthropic api","anthropic claude code","anthropic claude max","anthropic computer use","anthropic pro","anyword","atlas browser","beautiful.ai","bolt new","bolt.new","browse use","browse use ai","browser-use","browseruse","byword","character ai","character ai plus","character.ai plus","chat gpt plus","chat pdf","chat-pdf","chatgpt enterprise","chatgpt go","chatgpt plus","chatgpt pro","chatgpt team","chatgpt teams","chatpdf","civitai","claude atlas","claude code","claude max","claude opus","claude opus 4","claude opus 4.7","claude pro","claude team","claude.ai","codeium enterprise","codeium pro","codewhisperer","cody sourcegraph","comet browser","computer use","consensus app","copy ai","copy.ai","cursor business","cursor pro","cursor team","d id","d-id","dall-e","dalle","dalle 3","decktopus","deepl","deepl premium","deepl pro","deepl write","deepseek","deepseek pro","devin","devin ai","eleven labs","elevenlabs","elicit","explainpaper","fal.ai","fathom note taker","fathom video","fig ai","fliki ai","freepik ai","freepik premium","galileo","galileo ai","gamma ai","gamma app","gamma.app","gemini advanced","gemini ai","gemini api","gemini pro","getty images","github copilot business","github copilot enterprise","github copilot individual","github copilot pro","github copilot+","google ai pro","google gemini","google translate api","gpt 4","gpt-4","gpt-5","gpt4","gpt5","groq cloud","growthbar","hey gen","heygen","hugging face","hugging face pro","huggingface pro","humata","humata ai","ideogram","ideogram pro","jasper","jasper ai","jenni ai","kagi","kagi search","kling","kling ai","krea","krea.ai","krisp","krisp ai","language tool","languagetool premium","le chat","le chat pro","leonardo ai","leonardo.ai","lex.page","lindy","lindy ai","linguee pro","longshot ai","lovable","lovable.dev","luma dream","luma labs","lumen5 ai","mage.space","magnific","make agent","manus","manus ai","mem ai","mem.ai","metaphor","metaphor labs","midjourney","midjourney basic","midjourney mega","midjourney pro","midjourney standard","mistral le chat","morph","murf","murf ai","n8n agent","neuroflash","notion ai plus","notion ai pro","novelai","open ai","openai","openai api","openai canvas","openai dall-e api","openai operator","openai plus","openai pro","openai sora pro","otter chat","outranking","papago","perplexity","perplexity api","perplexity enterprise","perplexity pro","phind","phind plus","phind pro","pi ai","pi.ai pro","pika","pika labs","play.ht","playht","poe","poe quora","presentations.ai","quillbot","quillbot premium","qwen chat","raycast","raycast pro","raycast pro ai","replicate ai","replicate.com","research rabbit","resemble","resemble.ai","rewind ai","rewindai","ritr ai","rive design ai","runway","runway ml","runway pro","rytr","rytr premium","scalenut","scholarcy","scispace","scite","scite ai","shortlyai","shutterstock ai","slidesgo ai","smodin","sora","sourcegraph cody","speechify","speechify premium","stable diffusion","sudowrite","super maven","supermaven","synthesia","tabnine business","tabnine pro","tldraw","tldraw ai","together.ai","tome ai","tome app","turnitin","type.ai","uizard","vercel v0","warp ai","warp pro","warp.dev pro","wellsaid","wellsaid labs","windsurf","windsurf ai","wordtune","writer ai","writer.com","writesonic","writesonic premium","you pro","you.com","you.com pro","אדובי פיירפליי","אופן אי איי","אופן איי-איי","אופן-איי","אט gpt פלוס","אט-gpt","אידאוגרם","אלבן לאבס","אלבן-לאבס","אני וורד","ג'אספר","ג'מיני אדוונסד","ג'מיני פרו","דאל אי","די אי-די","דיפל פרו","היי-ג'ן","וורד טיון","ליאונרדו","מאגניפיק","מורף איי-איי","מיד ג'רני","מיד ג\\","מידג'רני","מיני אדוונסד","מנוי gpt","מנוי gpt-5","מנוי ג'מיני","מנוי ג\\","מנוי מידג'רני","מנוי צאטגפט","מנוי קלוד","סורה","סטייבל דיפוז'ן","סטייבל דיפוז\\","סינטסיה","ספיצ'יפיי","פאי איי איי","פו ai","פיירפליי","פיקה","פליי איץ' טי","פליי איץ\\","פרי-פיק","פריפיק","פרפלקסיטי","פרפלקסיטי פרו","צ'אט gpt פלוס","צ'אט בוט","צ'אט-gpt","צ'אטגפט","צאט gpt","צאט גיפיטי","צאטגפט","קאגי","קופי-איי","קלוד טים","קלוד מקס","קלוד פרו","קלינג","קריאה","ראנווי","ראנוויי","ריזמבל","רייקאסט","רני","שאטרסטוק"],"category":"הוצאות קבועות","subcategory":"AI ובינה"},
  {"keywords":["acorn","acorn tv","amazon freevee","amc plus","amc+","anghami","apple music classical","apple music family","apple music student","apple music voice","binge","binge.com.au","boomplay","britbox","canal plus","canal+","claro video","coupang play","curiosity stream","curiositystream","discovery plus","discovery+","freevee","gaana","gaana plus","globo play","globoplay","hayu","history vault","idagio","iflix","iqiyi","joox","kk box","kkbox","lifetime","lifetime movie club","magellan tv","magellantv","magenta","magenta tv","mixcloud","mixcloud pro","molotov","molotov tv","mubi tickets","napster","nebula","now broadband","now tv","now tv sports","ott platform","ott מנוי","pluto tv","primephonic","qobuz","rai italia","rai play","rakuten viki","rappi favor","rappi music","saavn","saavn pro","salto","showtime","shudder","shudder horror","shudder tv","sky go","sky sports","sky tv","sony liv","sonyliv","spotify duo","spotify family","spotify premium","spotify student","starhub","starhub tv+","starz","tidal family","tidal hifi plus","tubi","tubi tv","tving","twitch","twitch prime","twitch sub","twitch subscription","twitch turbo","viki rakuten","vimeo","vimeo business","vimeo enterprise","vimeo plus","vimeo premium","vimeo pro","viu","vivo play","voot","wavve","we tv","we טי וי","wetv","weverse","winnk music","wow plus","wow presents plus","wynk music","yandex music","youtube music family","youtube premium family","youtube tv","youtube משפחה","yt premium","zee5","אי-פליקס","אידאג'יו","אידאג\\","אייקיווייי","אם-סי","אנגאמי","אפל מיוזיק קלאסי","אקורן","בום פלאי","בינג'","בריט בוקס","ג'וקס","דיסקאברי פלוס","האיו","ווט","וי-וורס","ויב","ויו","וימאו","ויקי","וקס","זי-5","טובי","טוויץ'","טוויץ\\","טי-וינג","יוטיוב tv","מולוטוב","מוסיקת אפל משפחה","מנוי אפל מיוזיק","נאפסטר","נבולה","סאלטו","סטארז","סלארו וידאו","ספוטיפיי דואו","ספוטיפיי משפחה","ספוטיפיי סטודנט","ספוטיפיי פרימיום","פלוטו טיוי","פריבי","קובוז","קיוריוסיטי","קנאל פלוס","שאדר","שואטיים"],"category":"בידור","subcategory":"סטרימינג"},
  {"keywords":["אונליין","amazon luna","apple arcade","battle.net","blizzard balance","blizzard battle.net","boosteroid","cataclysm classic","counter strike","cs2 prime","csgo prime","destiny 2 season pass","destiny 2 silver","destiny silver","diablo 4 battle pass","diablo immortal","diablo iv subscription","dota 2 plus","dota battle pass","dota plus","ea access","ea play","ea play pro","elder scrolls online","elder scrolls plus","epic games","epic games store","epic store","eso","eso plus","eve online","eve online omega","ff14","ffxiv","final fantasy 14","final fantasy xiv","fortnite battle pass","fortnite crew","g force now","game pass","game pass core","game pass pc","game pass ultimate","geforce now","geforce priority","geforce ultimate","genshin crystals","genshin impact","genshin welkin","gog galaxy","gog premium","google play pass","guild wars 2","gw2","honkai","honkai star rail","humble bundle","humble choice","itch","itch creator","itch.io","league of legends","league rp","lol rp","luna plus","luna+","minecoins","minecraft","minecraft realms","nintendo eshop","nintendo expansion pack","nintendo online","nintendo switch online","nso","old school runescape","omega clone","osrs","osrs membership","play pass","playstation plus","playstation plus deluxe","playstation plus essential","playstation plus extra","playstation plus premium","ps now","ps plus","ps plus essential","ps plus extra","ps plus premium","ps store","rainbow six pass","roblox premium","roblox robux","robux","runescape","runescape membership","shadow gaming","shadow pc","siege pass","stadia","star wars old republic","steam","steam funds","steam subscription","steam wallet","switch online","swtor subscription","ubisoft plus","ubisoft+","uplay+","v bucks","v-bucks","valorant","valorant points","vbucks","warcraft game time","warframe platinum","warframe prime","welkin moon","world of warcraft","wotlk classic","wow","wow classic","wow game time","wow subscription","x split","xbox","xbox game pass","xbox game pass ultimate","xbox gold","xbox live","xbox live gold","xgp","xsplit","אב אונליין","אי איי פליי","אי-איי פליי","אפיק גיימס","אפל ארקייד","אקסבוקס","ארקייד","בוסטרויד","ג'יפורס נאו","גיים פאס","האמבל","הונקאי","ולקין מון","יוביסופט פלוס","מיינקראפט","מיינקראפט רלמס","נינטנדו אונליין","סוויץ' אונליין","סטדיה","סטים","פורטנייט קרו","פלי-פלוס","פליי פאס","פלייסטיישן","פלייסטיישן פלוס","פסטיישן פלוס","ראנסקייפ","רובוקס","רובלוקס פרימיום"],"category":"בידור","subcategory":"משחקים"},
  {"keywords":["404 media","ars technica","atlantic premium","axios","axios pro","ben thompson","bloomberg","bloomberg digital","bloomberg subscription","calcalist","calcalist premium","der spiegel","financial times","foreign affairs","ft.com","globes","globes premium","haaretz","haaretz digital","harper's bazaar","harper\\","harpers bazaar","harvard business review","hbr","hbr digital","israel hayom","kikar hashabat","le monde","le monde digital","maariv","makor rishon","mit tech review","mit technology review","mit סקירה טכנולוגית","morning brew","morning brew premium","n12","n12 premium","n12 פרימיום","national geographic","new york times","new yorker","nyt","nyt audio","nyt cooking","nyt crossword","nyt games","nyt wirecutter","nytimes","puck","puck news","reuters","reuters pro","scientific american","semafor","spiegel","stat news","stratechery","techcrunch plus","techcrunch+","telegraph","the atlantic","the atlantic+","the economist","the guardian","the information","the marker","the points guy","the times","the times of london","the verge","themarker","themarker premium","tpg","vanity","vanity fair","vogue","wall street journal","walla premium","walla! premium","washington post","wired","wsj","ynet","ynet+ דיגיטל","ynet+ פרימיום","אטלנטיק","אקונומיסט","אקסיוס","בלומברג","גארדיאן","גלובס","גלובס פרימיום","דה-מארקר","האטלנטיק","האקונומיסט","הארץ","הארץ דיגיטל","הארץ פרימיום","הגרדיאן","הוורג'","הניו יורקר","וואג","וואלה פרימיום","וול סטריט ג'ורנל","ויירד","ורנל","ושיגנטון פוסט","ושינגטון פוסט","טיימס לונדון","טלגרף","ישראל היום","כיכר השבת","כלכליסט","כלכליסט פרימיום","מעריב","מעריב פרימיום","מקור ראשון","ניו יורק טיימס","ניו יורקר","ניו-יורק טיימס","נשיונל גאוגרפיק","סטרטכרי","סייאנטיפיק אמריקן","ערוץ 7","פוריין אפיירס","פייננשל טיימס","רויטרס"],"category":"בידור","subcategory":"חדשות ומגזינים"},
  {"keywords":["abletono","abletonton","akademon","alison","anki","anki app","babbel","babbel live","bloc.io","brilliant","brilliant premium","busuu","campus il","chegg","chegg study","codecademy","codecademy pro","course hero","coursera","coursera plus","coursera professional","coursera specialization","courshero","datacamp","datacamp pro","domestika","drops","drops language","duolingo","duolingo family","duolingo max","duolingo plus","duolingo super","edx","edx programs","edx unlimited","flatiron school","fluentu","free code camp","freecodecamp","futurelearn","general assembly","hello talk","hellotalk","huji online","interaction design foundation","italki","italki plus","ixdf","kahoot","kahoot premium","khan academy","khan academy donations","khanmigo","lambda","lambda school","ling-q","lingoda","lingq","linkedin learning","linkedin premium","linkedin sales navigator","lynda","lynda.com","memrise","memrise pro","minecraft edu","minecraft education","mondly","navot","open university","outschool","pimsleur","pluralsight","preply","psagot","quizlet","quizlet plus","rami levy school","rav-tech","ravtech","rosetta stone","skillshare","skillshare premium","speechling","springboard","tandem","tau online","thinkful","tinkercad","treehouse","udacity","udacity nanodegree","udemy","udemy business","udemy personal plan","udemy pro","wize","wize.live","אאוט סקול","אדאקס","אודאסיטי","איטלקי","אליסון","אקאדמון","אקדמון","באבל","בוסו","ברילליאנט","דאטה קאמפ","דואולינגו","דומסטיקה","האוניברסיטה העברית online","האוניברסיטה הפתוחה","חאן אקדמי","טאו אונליין","טאנדם","טריהאוס","יודמי","ינקפול","לינגודה","לינקדאין לרנינג","מונדלי","ממרייז","נבות","ספיצ'לינג","ספיצ\\","ספרינגבורד","סקילשייר","פיוצ'ר לרן","פימסלאור","פלאטירון","פלואנטיו","פלורלסייט","פסגות לימודים","פרי קוד קאמפ","פרפלי","צ'אג","קוד אקדמי","קוויזלט","קורסרה","קורסרה פלוס","קמפוס il","קמפוס.il","ר לרן","רב-טק","רוזטה סטון","רוזטהסטון","רמי לוי בית ספר","ת'ינקפול","תל אביב online"],"category":"חינוך","subcategory":"קורסים מקוונים"},
  {"keywords":["10 percent happier","10% happier","aaptiv","apple fitness plus","apple fitness+","atmosphere","autosleep","balance app","balance meditation","barre 3","barre3","bbg","beachbody","beachbody on demand","better help","betterhelp","bloom mental","bod","buddhify","calm","calm app","calm premium","carb manager","centr","centr fitness","country club","cronometer","cronometer gold","crossfit israel","down dog","downdog","energy gym","extreme power","fit plus","fitbit","fitbit premium","fitbod","fitfor","fitfor3","fitness blender","fitness blender plus","foodducate premium","fooducate","freeletics","future coaching","future fitness","garmin connect+","garmin premium","glo","glo yoga","go active","goactive premium","gymshark training","happify","headspace","headspace family","headspace plus","holmes place","holmesplace","icon","icon gym","insight timer","insight timer plus","kantri club","kayla itsines sweat","kris hemsworth centr","leumi gym","lifesum","lifesum premium","lose it","lose it premium","macros first","map my run","mapmyfitness","mapmyride","mapmyrun","mapmyrun premium","mindspace tlv","moodfit","moodpath","my fitness pal","myfitnesspal","myfitnesspal premium","nike run club","nike training club","noom","noom premium","ntc premium","obe fitness","obé fitness","ora gym","oura membership","oura ring","peloton app","peloton digital","pillow","pillow premium","polar flow","relax melodies","rise sleep","rouvy","sam harris waking up","shine","shuteye","sleep cycle","sleep cycle premium","smiling mind","strava","strava premium","studio c","sweat","sweat app","talkspace","ten percent happier","trainer road","trainerroad","training peaks","waking up","weight watchers","weightwatchers","whoop","whoop membership","whoop strap","wwapp","wysa","yazio","yoga international","youper","zwift","אורה","אורה כושר","אינסייט טיימר","אנרג'י","אנרג\\","אפטיב","אפל פיטנס פלוס","אקסטרים פאוור","בטר הלפ","גו אקטיב","הדספייס","הולמס פלייס","ווופ","וויקינג אפ","זוויפט","טוקספייס","יאז'יו","מיי פיטנס פאל","נום","סוויט","סטודיו c","סטראבה פרימיום","סטרבה","סלייפ סייקל","סם הריס","סנטר","פיט פלוס","פיט-פלוס","פיטבוד","פלוטון","פרילטיקס","קאלם","קאנטרי קלאב","קרוספיט ישראל","רוויי"],"category":"בריאות","subcategory":"כושר ומנויים"},
  {"keywords":["all access pass","annual subscription","auto renewal","auto-renewal","bundle subscription","business plan","creator support","digital subscription","early bird subscription","enterprise plan","family plan","founder plan","founder's plan","founder\\","lifetime deal","ltd","memberful subscription","membership","monthly subscription","newsletter paid","newsletter premium","patreon tier","podcast subscription","podcast tip","premium content","premium newsletter","premium plan","pro plan","subscription fee","supporter","supporter membership","tier monthly","אפליקצייה","דמי מנוי","חידוש אוטומטי","מנוי באנדל","מנוי דיגיטלי","מנוי חודשי","מנוי שנתי","תוכן פרימיום","תוכנית ארגונית","תוכנית משפחה","תוכנית עסק","תוכנית עסקית","תוכנית פרו","תוכנית פרימיום","תומך חודשי"],"category":"שונות","subcategory":"שונות"},
  {"keywords":["airbnb ארוכת טווח","anglo saxon","appraiser","architect","ariach","arvut","beit kal","blacksmith","booking ארוכת טווח","century 21","coldwell banker","demey schirut","electrician","gzeret","hadarim","homeless israel","hovalat dira","instalatzia","interior designer","kablan shiputzim","kitchen cabinets","komo","komo נדל\"ן","locksmith","madlan","marble","mehandes binyan","metavech","miller realty","movers","moving","moving company","nadlanist","parquet","pikadon","plumber","plumbing","real estate agent","remax","remax israel","renovation","ritzuf","ruby","schar dira","shaish","shamai","shiputzim","storage","structural engineer","tashlum schad","tiling","tzava'i dira","tzviiat dira","urbana","yad 2","yad2","zap real estate","אדריכל","אדריכלות","אורבנה","אחסון רהיטים","אחסנת חפצים","אינסטלטור","אינסטלציה","אנגלו סקסון","ארונות מטבח","אריחים","ארנונה שכירות","ב.מ. נדל\"ן","בית-קל","גוזרת","גוזרת ת\"א","דמי שכירות","הובלת דירה","החלפת מנעול","הסכם שכירות","ועד בית שכירות","חדרים","חדרים שותפים","חוזה שכירות","חשמלאי","יד2","כיורים","מ-בית","מבית","מדלן","מהנדס בנין","מובילי דירות","מובילים","מטבח חדש","מילר נדל\"ן","מנעולן","מסגר","מסגרות מתכת","מעצב פנים","מתווך","מתווכת","נדל\"ניסט","ניקיון אחר שיפוץ","סוכן נדל\"ן","סנצ'רי 21","עיצוב פנים","ערבות שכירות","פועלי שיפוצים","פיקדון שכירות","פרקט","פתיחת דלת מנעולן","צביעת בית","צביעת דירה","צבע דירה","צבעי דירה","קבלן שיפוצים","רובי נדל\"ן","רימקס","ריצוף","שיפוצים","שיש","שכר דירה","שמאי","שמאי מקרקעין","תווי שכירות","תחזוקת בית","תיווך נדל\"ן","תיקון אינסטלציה","תיקון בית","תיקון חשמל בדירה","תיקון לאחר שכירות","תיקון פתח","תיקון תקלה בבית","תכנון אדריכלי","תכנון פנים","תשלום שכ\"ד"],"category":"הוצאות קבועות / בית","subcategory":"תיווך ונדל\"ן - תשלומי שכירות"},
  {"keywords":["ezer mizion","latet","latet ישראל","mda תרומה","sela","yad sarah","zichron menachem","אגודת ניצולי השואה","ארגון יד שרה","ארגון לרווחה","גמ\"ח","גמח","הלוואה גמ\"ח","זכרון מנחם","יד אליעזר","יד שרה","להב\"ה תרומות","מטה לישראל","מטריה תפילה","סלע","סלע ארגון","עזר מציון","פתחון לב","קופת גמ\"ח","תרומה לחיילים","תרומה למלאכי השמיים"],"category":"ממשלה ומיסים","subcategory":"שירותי דת והלכה - גמ\"חים"},
  {"keywords":["aegean israel","aero israel","aeroflot israel","air europa israel","arkia פנים ארצי","border tax","brussels airlines","cyprus airways","departure tax","elal cargo","emirates","etihad","iberia israel","israir פנים ארצי","qatar airways","royal jordanian","singapore airlines","sun dor","tarom","אגרת עזיבה ישראל","אגרת שדה תעופה","אגרת תעופה","אל על פנים ארצי","טיסה פנים ארצית","טיסת פנים"],"category":"תחבורה / תחבורה ציבורית","subcategory":"תחבורה - נסיעות לחו\"ל וטיסות פנים ארץ"},
  {"keywords":["heital hashbacha","heter bniyah","moded musmach","tatsa\"r","אגרת בנייה","אגרת בקשה","אגרת השפעה סביבתית","אגרת חיבור חשמל","אגרת חיבור מים לאתר","אגרת תוכנית מתאר","אגרת תוכנית עירונית","אישור בנייה","אישור גמר בנייה","היטל השבחה","היתר בנייה","התנגדות תוכנית","ועדה מחוזית","ועדה מקומית לתכנון ובנייה","חיבור חשמל לאתר בנייה","טופס 4","טופס 5","טופס תיק עבודה","מודד מוסמך","מודד מקצועי","מס השבחה","מס מכירה","תוכנית בנייה","תוכנית מדידה","תעודת גמר","תצ\"ר"],"category":"הוצאות קבועות / בית","subcategory":"נדל\"ן - אגרות בנייה והיתרים"},
  {"keywords":["facebook ads","fb ads","fbads","meta ads","meta business","meta business suite","meta marketing","meta pixel","pixel facebook","instagram ads","ig ads","igads","reels ads","instagram promote","אינסטה אדס","אינסטה ads","אינסטגרם פרסום","אינסטה ממומן","אינסטה קמפיין","מטא אדס","מטא ads","מטא פרסום","מטא ביזנס","מטא ביזנס סוויט","פיקסל פייסבוק","פיקסל מטא","פייסבוק אדס","פייסבוק ads","פייסבוק קמפיין","פייסבוק ממומן","פייסבוק פרסום","פייסביוק אדס","פייסבוק'ק","פייסבוק business","פייסבוק שיווק","פייסבוק מנהל מודעות","מנהל מודעות פייסבוק","מודעות פייסבוק","בוסט פוסט","boost post","boosted post","reels promotion"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["google ads","googleads","google adwords","adwords","google ad words","google ad","google promote","youtube ads","youtube promote","youtube ad","youtube ammumemen","youtube ממומן","יוטיוב אדס","יוטיוב ads","יוטיוב פרסום","יוטיוב קמפיין","יוטיוב ממומן","גוגל אדס","גוגל ads","גוגל אדוורדס","גוגל פרסום","גוגל ממומן","גוגל קמפיין","גוגל מודעות","גוגל מודעה","גוגל'ל","google pixel ad","gads","דיספליי גוגל","display google","google display"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["tiktok ads","tiktok promote","tiktok shop ads","tiktok business","tiktok marketing","טיקטוק אדס","טיקטוק ads","טיקטוק פרסום","טיקטוק קמפיין","טיקטוק ממומן","טיקטוק שיווק","tik tok ads","tiktok ad","spark ad tiktok"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["linkedin ads","linkedin promote","linkedin marketing","linkedin business","sponsored content linkedin","לינקדאין אדס","לינקדאין ads","לינקדאין פרסום","לינקדאין קמפיין","לינקדאין ממומן","לינקדאין שיווק"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["twitter ads","x ads","x promote","twitter promote","twitter business","snapchat ads","pinterest ads","pinterest promote","reddit ads","spotify ads","discord ads","טוויטר אדס","טוויטר פרסום","איקס אדס","אקס אדס","אקס פרסום","סנאפצ'אט אדס","סנאפצ'אט פרסום","פינטרסט אדס","פינטרסט פרסום","רדיט אדס","רדיט פרסום","דיסקורד אדס"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["שיווק דיגיטלי","פרסום ממומן","קמפיין שיווק","קמפיין ממומן","קמפיין פרסום","פרומו","prom","promo","ads","advert","advertising","advertise","advertisement","sponsored","sponsored post","sponsor","ממומן","מקדם מכירות","יח\"צ","יחצן","יחסי ציבור","pr agency","agency פרסום","משרד פרסום","משרד יח\"צ","גרילה מרקטינג","גרילה שיווק","אינפלואנסר","influencer","influencer marketing","שיווק משפיענים","משפיענים","אפיליאט","affiliate","affiliate marketing","newsletter ads","email marketing","דיוור","דיוור שיווקי","mailchimp","klaviyo","sendgrid","constant contact","hubspot marketing","salesforce marketing","מיילצימפ","קלוויו","הבספוט"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["seo","sem","ppc","cpc","cpm","אופטימיזציה למנועי חיפוש","מיקום בגוגל","דירוג בגוגל","קידום אורגני","קידום ממומן","sem rush","semrush","ahrefs","moz","ubersuggest","serpstat","screaming frog","similarweb","simple analytics","plausible","fathom analytics","google analytics","google tag manager","gtm","mixpanel","amplitude","heap analytics","hotjar","fullstory","crazy egg","optimizely","vwo","google search console","bing webmaster"],"category":"עסק","subcategory":"שיווק"},
  {"keywords":["canva","canva pro","figma","figma pro","adobe creative cloud","adobe cc","photoshop","illustrator","after effects","premiere pro","lightroom","indesign","sketch","invision","webflow","wordpress","squarespace","wix","shopify","shopify plus","bigcommerce","magento","wordpress hosting","wp engine","cloudflare","siteground","bluehost","godaddy hosting","namecheap hosting","aws","amazon web services","gcp","google cloud","azure","digital ocean","linode","vultr","netlify","vercel","heroku","render","fly.io","railway","firebase","supabase","mongodb atlas","planetscale","neon","github","github copilot","gitlab","bitbucket","jira","confluence","trello","asana","monday.com","monday","clickup","notion business","slack pro","slack business","discord nitro","zoom pro","loom","loom pro","cal.com","calendly","doodle","typeform","tally","jotform","airtable pro","airtable business","zapier","make.com","integromat","n8n","pipedream","תוכנת עיצוב","תוכנת עריכה","תוכנה עסקית","שירות ענן עסקי","אחסון אתר","דומיין","דומיין עסקי","אחסון אתר עסקי","cms","cms עסקי","crm","crm עסקי","erp","erp עסקי"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["stripe","paypal business","square","tranzila","pelecard","pelekard","icount","green invoice","greeninvoice","rivhit","priority","sap business one","quickbooks","xero","wave","freshbooks","icount חשבונית","יבשבונית ירוקה","חשבונית ירוקה","גרין אינווייס","ריבחית","איקאונט","תרנזילה","פלאקארד","פלקארד","פלאסקארד","בית עסק stripe","בית עסק paypal","בית עסק tranzila","סליקה","תוכנת הנהלת חשבונות","הנה\"ח"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["anglo saxon market","דוכן מכירה","דמי כניסה ירידי שיווק","יריד עסקי","יריד מסחר","תערוכה","תערוכה עסקית","kenes","expo","tlv expo","tlv international expo","expo tlv","big expo","congress","wifi בכנס","business conference","business event","b2b event","הרצאה עסקית","סדנה עסקית","workshop business","business workshop","training session","הכשרה עסקית"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["accountant","cpa","bookkeeper","bookkeeping","יועץ עסקי","יועץ עסקים","יועץ שיווק","יועץ פיננסי עסקי","business consultant","business advisor","business coach","startup advisor","mentor עסקי","מנטור עסקי","מאמן עסקי","יועץ משפטי","עו\"ד","עו״ד","עורך דין עסקים","חוזה עסקי","עורך דין חוזים","עורך דין קניין רוחני","עורך דין מסחרי","יועץ מס נוסף","מורשה חתימה","רואה חשבון נוסף","הנה\"ח חיצונית","בודק שכר","בדיקת שכר עסקית","consultant fee","consultancy fee","legal fee","lawyer fee"],"category":"עסק","subcategory":"יועצים"},
  {"keywords":["shipping label","usps","fedex","dhl","dhl express","ups","tnt","aramex","doar","doar 24","doar shaliach","shaliach 24","shipping carrier","fulfillment","fulfillment service","shipbob","shipstation","pirate ship","pirateship","דואר 24","דואר ישראל עסקי","דואר שליחים","דואר שליח","שליח ישראל","שליחויות עסקיות","דאצ'ה","דצ'ה","דצה","משלוח עסקי","משלוחים עסקיים","התקנת מוצר","התקנה לקוח","אריזה ומשלוח","אריזה לעסק","חומרי אריזה","נייר אריזה","קרטונים","קרטוני אריזה","מדבקות משלוח","בועות אריזה","נייר בועות","bubble wrap","tape","אריזת מתנה"],"category":"עסק","subcategory":"משלוח"},
  {"keywords":["raw material","raw materials","wholesale","wholesaler","b2b supplier","supplier invoice","ספק חומרי גלם","ספק עסקי","ספקים עסקיים","מחסן ספקים","אתר ספקים","alibaba","alibaba.com","1688","1688.com","made in china","taobao","aliexpress עסקי","מנעולנים עסקי","נחושת","פלדה","מתכת","גומי","בדים","חוטים","יריעות","יריעות גומי","יריעות פלסטיק","דבק תעשייתי","מוטות","מסמרים תעשייה","ברגים תעשייה","אנקרים","תפסים","פינות מסגרת","זוויות מתכת","פרזול","חומרי דפוס","חומרי הדפסה","דיו הדפסה","דיו פלוטר","יריעות הדפסה","נייר אומנותי","נייר זהב","נייר צילום","נייר מאט","נייר ברק","glossy paper","matte paper","canvas roll","גליל קנבס","גלילי קנבס","דבק תרסיס","spray adhesive"],"category":"עסק","subcategory":"חומרי גלם"},
  {"keywords":["invoice paid","payment received","customer payment","client payment","תקבול לקוח","תקבול עסקי","הוראת קבע מלקוח","קבלה ללקוח","תשלום מלקוח עסקי","מקדמה לקוח","מקדמה עסקית","מקדמת עבודה","מקדמת לקוח","order online","order placed","הזמנה אונליין","הזמנת לקוח","הזמנה אתר","הזמנת אתר","הזמנה עסקית","מכירה אונליין","מכירה אתר","מכירת מוצר","מכירת שירות","sale online","sale website","product sale","service sale","rebate","מע\"מ החזר","החזר מע\"מ","מע״מ החזר","vat refund","tax refund"],"category":"עסק","subcategory":"מחזור","isIncome":true},
  {"keywords":["mac mini","mac studio","macbook pro","macbook air","imac","mac pro","monitor 27","monitor 4k","monitor 5k","lg ultrafine","dell ultrasharp","asus prophet","logitech mx","magic keyboard","magic mouse","magic trackpad","wacom","cintiq","huion","xp pen","מחשב לעבודה","מחשב משרדי","מחשב עסקי","מסך עבודה","מסך 4k","מסך עסקי","מקלדת מקצועית","עכבר עיצוב","טבלט עיצוב","טאבלט עיצוב","wacom intuos","wacom cintiq","מסך מגע גרפי","גרפיקת אומנים","ipad pro","ipad pro 12.9","apple pencil","apple pencil 2","מקרן עבודה","מקרן פגישות","מקרן עסקי","מצלמה מקצועית","מצלמת מקצוע","מצלמת dslr","מצלמת mirrorless","sony a7","canon 5d","lumix s5","sigma art","tamron art","tripod","gimbal","dji ronin","dji rs2","dji rs3","rode mic","rode microphone","shure sm7b","shure mv7","audio interface","focusrite scarlett","softlight","ring light","softbox","תאורת סטודיו"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["workspace google","google workspace","gsuite","g suite","microsoft 365 business","microsoft 365 enterprise","office 365 business","דומיין עסקי","מייל עסקי","g suite business","workspace business","starter workspace","workspace starter","workspace standard","workspace plus"],"category":"עסק","subcategory":"תפעוליות"},
  {"keywords":["שופרסל דיל","שופרסל אקספרס","שופרסל אונליין","שופרסל סופר","שופרסל איתי","שופרסל יחיאל","shufersal big","shufersal sheli","shufersal yesh","shufersal exists","מגה בעיר","מגה בעיר אונליין","מגה ברמת השרון","יוחננוף סופר","יוחננוף מאיר","יוחננוף און ליין","יוחננוף אונליין","יוחננוף שוקי","מחסני השוק חיפה","מחסני השוק ראשון","מחסני השוק רמת גן","מחסני השוק אזור","מחסני השוק רחובות","מחסני השוק קניון","מחסני להב","רמי לוי שוקי המזון","רמי לוי שיווק השקמה","רמי לוי קמפוס","רמי לוי אונליין","רמי לוי קמפוס און ליין","ויקטורי אונליין","ויקטורי שיווק","ויקטורי בעיר","ויקטורי אילת","ויקטורי באר שבע","כוורת שיווק","כוורת השרון","כוורת אונליין","חצי חינם אונליין","חצי חינם רעננה","חצי חינם שיווק","אושר עד אונליין","אושר עד בנימינה","אושר עד חיפה","סופר ביצ' צ'יפ","ביצ'יפ","ביצ'ה צ'יפ","super pharm market","סופר פארם מרקט","סופר פארם קמפוס","super yuda online","יודה אונליין","super deal online","סופר דיל אונליין","tiv taam","טיב טעם אונליין","טיב טעם רמת השרון","טיב טעם תל אביב","טיב טעם תל-אביב","יינות ביתן אונליין","יינות ביתן רחוב","יינות ביתן רב חן"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["mcdonalds","mcdonald's","mc donalds","mcd","macdonald","מקדונלד","מקדונלדס תל אביב","מקדונלד'ס","burger king","burger-king","burgerking","בורגר קינג רעננה","בורגר קינג אזור","kfc israel","kfc תל אביב","kentucky","קנטאקי פרייד צ'יקן","קנטאקי","pizza hut","pizza-hut","pizzahut","פיצה האט אונליין","פיצה האט תל אביב","dominos","domino's","דומינוס תל אביב","דומינוס אונליין","דומינוס פיצה","דומינו'ס","jumbo","jumbo tor","ג'מבו","ג'מבו תור","jumbo grill","aroma cafe","aroma espresso bar","ארומה אספרסו בר","ארומה אונליין","ארומה תל אביב","roladin","רולדין תל אביב","רולדין אונליין","נמירה ירושלים","יורם בוקר","אגדה הודית","איתי מזרחי","אבו גוש","הומוס אבו גוש","אבו חסן","הומוס אבו חסן","shawarma hapinati","שווארמה הפינתי","שווארמה הגלעד","שווארמה רביב","falafel hakosem","הקוסם","פלאפל הקוסם","בורגרס בר","burgers bar","אסקימו לימון","eskimo limon","פינוקיו פיצה","פיצה פינוקיו","pizza pinokio","big apple pizza","גוצ'י פיצה","pizza gucci","גודיז","goodies","goodee","cafe joe","קפה ג'ו","cafe greg","קפה גרג","cafe louise","קפה לואיס","café roma","גרינלף","green leaf","agadir","אגדיר","shipudei tsipora","שיפודי ציפורה","דאחר","דאחר חיפה"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["חברת חשמל לישראל","חח\"י","חחי","iec israel","electric company israel","גוביינא חשמל","חשבון חשמל","חשמל דו חודשי","חשמל חודשי","תאגיד חשמל","תשלום חשמל אונליין"],"category":"הוצאות קבועות","subcategory":"חשמל"},
  {"keywords":["bezeq international","bezeq בינלאומי","בזק בינלאומי","בזק בנט","bezeqnet","partner tv","cellcom tv","sting tv","sting","hot tv","hot סלולר","hot moblie","hot mobile","הוט סלולר","הוט סלולר חודשי","גולן טלקום אונליין","גולן טלקום חודשי","rami levi תקשורת","רמי לוי תקשורת","יס סלולר","פלאפון עסקי","partner business","cellcom business","orange","orange israel","phone bill","mobile bill","דמי שיחה","דמי גלישה","גלישה סלולרית","חבילת סלולר","סלולר חודשי","partner שיחות","cellcom שיחות"],"category":"הוצאות קבועות","subcategory":"תקשורת"},
  {"keywords":["mei avivim","mei eden","מי עדן","מים שיא","מקורות","מי גולן אונליין","מי שבע","הגיחון","גיחון ירושלים","מי כפר סבא","מי נטופה","מי רעננה","מי הוד השרון","מי טיב","מי נופי גליל","מי גליל","מי כרמל","מי בית שמש","מי קריות","מי שדות","מי שיתוף","תאגיד מים אזורי","water company","water bill","חשבון מים"],"category":"הוצאות קבועות","subcategory":"מים"},
  {"keywords":["pazgaz","paz gaz online","sonol gaz","amisragas online","דורגז ביתן","דורגז סופרגז","amisragaz","אמישראגז ביתן","amisra gaz","mateve gas","supergaz online","gaz delivery","משלוח גז","תאגיד גז","גז מרכזי","גז ביתי","תיקון גז","gas company","gas bill","חשבון גז"],"category":"הוצאות קבועות","subcategory":"גז"},
  {"keywords":["paz yaer","פז יאיר","פז יאיר אילת","sonol express","סונול אקספרס","סונול אקספרס תחנה","ten fuel","ten 95 plus","bp israel","bp gas","bp דלק","sinopec","סינופק","fuel star","star fuel","אלון fuel","אלונית fuel","dor alon כרטיס","מיפלגה דלק","מילוי דלק עצמי","תחנת דלק ראשי","תחנה ראשית דלק"],"category":"תחבורה","subcategory":"דלק"},
  {"keywords":["mas hachnasa online","מס הכנסה אונליין","mas hachnasa עצמאי","tax authority israel","רשות המסים","רשות המסים אונליין","mas hachnasa עצמאית","דמי גמל עצמאי","דמי גמל שכיר","tochnit hisachon","ביטוח לאומי עצמאי","ביטוח לאומי שכיר","ביטוח לאומי הוראת קבע","ארנונה הוראת קבע","ארנונה אונליין","ועד בית הוראת קבע","ועד בית אונליין","מים הוראת קבע","חשמל הוראת קבע","גז הוראת קבע","pango online","cellopark online","easypark online","spothero online","parkpark online","pango monthly","cellopark monthly","easypark monthly","בולתון","דמי חבר ועד","נטיו","נטיו ביטוח","נטיו רכב","נטיו דירה"],"category":"הוצאות קבועות","subcategory":"מיסים ואגרות"},
  {"keywords":["ש\"ח","שיח","ש״ח","אגורות","גרושים","פרוטה","nis","shekel","shekalim","ils","דמי ניהול","דמי טיפול","דמי מימוש","דמי שירות","service charge","handling fee","admin fee"],"category":"הוצאות קבועות","subcategory":"בנקאות"},
  {"keywords":["קניתי","קניתיו","קנינו","נקנה","נקנו","רכשתי","רכשנו","נרכש","שילמתי","שילמתיו","שילמנו","נשלם","נשלמה","נשלמו","הוצאתי","הוצאתיו","הוצאנו","הוצאו","משולם","משולמת"],"category":"שונות ואחרים","subcategory":"שונות"},
  {"keywords":["ביגה","biga","big a","mr cebola","mr. cebola","מר סבולה","היכל הטעמים","hechal hateamim","אגדה הודית תל אביב","אגדה תל אביב","בני הדייג","bnei hadayag","אבו עלי קסבה","סגפי","סמיקי","eyn gedi restaurant","עין גדי מסעדה","ירמלי","מסעדת ירמלי","ירמלי תל אביב","יורם ביטון","george and john","ג'ורג' אנד ג'ון","הסלון","hasalon","taizu","טאיזו","ouzeria","אוזריה","manta ray","מנטה ריי","אוקיאנוס","oceanos","meat bar","מיט בר","machneyuda","מחניודה","מחניודה ירושלים","eucalyptus jerusalem","אקליפטוס ירושלים","satya tel aviv","סטיה תל אביב","pasta basta","פסטה באסטה","shilav","שלאוו","gyros","גירוס","sabich tchernichovsky","סביח תחבושת","סביח תשרי","סביח תחנה"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["wolt+","wolt plus","wolt express","וולט פלוס","וולט אקספרס","tenbis","ten bis online","tenbis card","tenbis הזמנה","tenbis מסעדה","ten bis monthly","ten bis ב","cibus card","cibus order","cibus business","סיבוס הזמנה","סיבוס תשלום","סיבוס מסעדה"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["fresh market natanya","super online netanya","super of netanya","super sheli","super hai online","super haifa online","super zol online","super zol shachen online","super kfar online","super lev online","super meir online","super tel aviv online","super yam online","super yirmiyahu online","super yuda online","super ziv online","אגד תרבות","מאפיית אנג'ל","מאפיית בארקאי","אנג'ל לחם","אנג'ל אונליין","אנג'ל סופר","lehem angel","דגנית עם","דגנית עם בריאות","lechem chaviv","לחם חביב","לחמי בריאות","שמינית אקטיב","mevashlim","מבשלים","mevashelet","מבשלת","shibolet","שיבולת","shibolet זאיתים","shaltifa","שלטיפה","shifron","שיפרון"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["parkme","parkme app","pango premium","pango plus","easypark plus","cellopark plus","cellopark premium","tav chaniya online","תו חניה אונליין","תו דייר","תו תושב","ארנונה חניה","sticker resident","דמי חניה תושב","דוח חניה ערעור","ערעור דוח חניה","מטרופולין חניה"],"category":"תחבורה","subcategory":"חניה"},
  {"keywords":["gett delivery","gett premium","gett business","גט שליחויות","גט פרימיום","יאנגו פלוס","yango plus","yango deli","uber israel","uber israel app","אובר ישראל","taxi tlv","מונית מטרופולין","מונית רכבת","sherut","sherut taxi","מונית שירות","monit sherut","rav kav online","רב קו אונליין","רב קו פלוס","הופ אופ","hop on hop off"],"category":"תחבורה","subcategory":"מונית"},
  {"keywords":["kupat cholim klalit","klalit mushlam","klalit platinum","maccabi sheli","maccabi gold","maccabi platinum","meuhedet adif","meuhedet shaul","leumit zahav","leumit silver","shaul beis hofesh","מאוחדת עדיף","מאוחדת שאול","מכבי שלי","מכבי זהב","מכבי פלטינום","לאומית זהב","לאומית כסף","לאומית פלוס","כללית מושלם","כללית פלטינום","דמי שיניים אופציונלי","ביטוח דנטלי","דנטל ביטוח","phoenix dental","הפניקס דנטלי","מגדל דנטלי","הראל דנטלי","מנורה דנטלי","שיניים שלמות","שיני ילדים","שיני נוער","מיישר שיניים","invisalign","אינביזליין","יישור שיניים"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["vetreinarian","pet vet","דוקטור וטרינר","ד\"ר וטרינר","דוקטור וטרינר תל אביב","מרפאת חיות מחמד","pet emergency","pet hospital","בית חולים וטרינרי","מזון יבש כלב","מזון לח כלב","מזון יבש חתול","מזון לח חתול","royal canin","hills science diet","science diet","purina pro plan","orijen","acana","יום הולדת לכלב","יום הולדת לחתול","משלוח כלב","גידום ציפורניים כלב","גידום ציפורניים חתול","מאלף כלבים אונליין","אילוף","pet boarding","pet daycare"],"category":"שונות ואחרים","subcategory":"חיות מחמד"},
  {"keywords":["cinema city malcha","cinema city ramat gan","cinema city aviva","יס פלאנט תל אביב","יס פלאנט קניון איילון","יספלאנט ראשון","yes planet rishon","yes planet jerusalem","cinemathèque tel aviv","cinemathèque israel","סינמטק תל אביב","סינמטק ירושלים","סינמטק חיפה","הופעה של עומר אדם","הופעה של ריטה","הופעה של נטע ברזילי","הופעה של אביב גפן","הופעה של שלמה ארצי","הופעה של עידן רייכל","הופעה של דוד ברוזה","הופעה ברביעי","הופעה ב סטטוס","הופעה ביציבה","הופעה במנורה","מנורה מבטחים מופע","מנורה אריאל"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["חוג שחיה","חוג ג'ודו","חוג כדורגל","חוג כדורסל","חוג ריקוד","חוג מחול","חוג בלט","חוג ציור","חוג מוזיקה","חוג נגינה","חוג מחשבים","חוג רובוטיקה","חוג שחמט","גן ילדים פרטי","גן עירוני","גן ויצו","גן ילדים ויצו","גן ילדים חרדי","גן ילדים ממלכתי","מעון יום","מעון רב תכליתי","משפחתון","משפחתון פרטי","משפחתון מסובסד","צהרון","צהרון בית ספר","צהרון גן","בייביסיטר","baby sitter","בייבי סיטר","מטפלת","מטפלת בית","מטפלת אונליין"],"category":"שונות ואחרים","subcategory":"אישי"},
  {"keywords":["airpods","airpods pro","airpods max","beats studio","beats solo","sony wh1000xm5","sony wh-1000xm5","bose qc45","bose qc35","sennheiser","jbl flip","jbl charge","jbl xtreme","bose soundbar","sonos beam","sonos arc","apple homepod","apple homepod mini","amazon echo","amazon echo dot","google nest mini","google nest hub","nest thermostat","nest doorbell","philips hue","philips hue starter","tp link tapo","aqara","roborock","rooomba","dyson v15","dyson airwrap","dyson hairdryer","dyson supersonic","dyson air purifier"],"category":"קניות","subcategory":"אלקטרוניקה"},
  {"keywords":["nike running","adidas running","on running","asics gel","asics nimbus","asics kayano","hoka","hoka clifton","hoka bondi","new balance","new balance 990","reebok classic","salomon trail","salomon speedcross","merrell hiking","columbia outdoor","north face","the north face","patagonia","arc'teryx","arcteryx","mammut","fjallraven","pull and bear","pull&bear","bershka","stradivarius","zara home","urban outfitters","anthropologie","free people","cos store","cos clothing","arket","mango outlet","h&m home","h and m","gap","banana republic","old navy","american eagle","hollister","abercrombie","lululemon","athleta","gymshark"],"category":"קניות","subcategory":"ביגוד"},
  {"keywords":["mac cosmetics","mac makeup","sephora online","sephora israel","fenty beauty","rare beauty","glossier","huda beauty","charlotte tilbury","urban decay","too faced","maybelline","l'oreal","loreal","revlon","nyx cosmetics","morphe","kylie cosmetics","kylie skin","estee lauder","mac lipstick","lancome","lancôme","clinique","origins","bobbi brown","shiseido","sk-ii","skin ceuticals","la mer","la roche posay","la roche-posay","vichy","eucerin","cerave","cetaphil","aveeno","neutrogena","olay","ordinary","the ordinary","paula's choice","paulas choice","drunk elephant","glow recipe","pixi beauty","lush cosmetics","mac maquillage"],"category":"קניות","subcategory":"טיפוח"},
  {"keywords":["gan yeladim shel","kindergarten","בית ספר יסודי","בית ספר תיכון","תיכון פרטי","תיכון מקיף","תיכון אזורי","תיכון אורט","תיכון אמית","תיכון רנה קסין","תיכון אחד העם","תיכון רעות","תיכון רמות","תיכון יום הולדת","תיכון עירוני","תיכון ביאליק","תיכון לאדה","תיכון רוטשילד","תיכון אוסטרובסקי","תיכון עירוני א","תיכון תלמה ילין","תיכון אלון","תיכון רקפת","תיכון רנה","תיכון תיכל","הסעות תלמידים","הסעות בית ספר","הסעת ילדים","school transport","school bus"],"category":"שונות ואחרים","subcategory":"אישי"},
  {"keywords":["decathlon","דקתלון","דקתלון תל אביב","דקתלון רעננה","דקתלון ראשון","דקתלון אונליין","מגזין רץ","sports authority israel","spalding israel","wilson tennis","tennis racquet","tennis racket","מחבט טניס","tennis ball","כדור טניס","כדור משחק","כדורסל ערב","כדור-סל ערב","כדור-רגל","goalkeeper gloves","gloves goalkeeper","נעלי כדורגל","נעלי ספורט","נעלי ריצה","נעלי כושר","נעלי הליכה","נעלי טיפוס","נעלי טרק","נעלי טיולים","sneaker","sneakers","מכנס ספורט","חולצת ספורט","חליפת ספורט","תיק ספורט","תיק חדר כושר","gym bag"],"category":"קניות","subcategory":"ביגוד"},
  {"keywords":["gather round books","magazine subscription","mango languages","lingq","rosetta stone","fluentu","busuu","duolingo plus","duolingo super","duolingo annual","duolingo family","מנוי duolingo","מנוי לימוד שפה","מנוי לימודי","מסטרקלס","masterclass","master class","coursera plus","coursera annual","udemy course","udemy plus","udacity","skillshare","pluralsight","oreilly","o'reilly learning","oreilly online","oreilly subscription","edx subscription","futurelearn","open university","הוצאה לפועל לימודים"],"category":"הוצאות קבועות","subcategory":"לימודים"},
  {"keywords":["bnei brak gan","גן ילדים בני ברק","גן עירוני ת\"א","גן עירוני תל אביב","גן עירוני ירושלים","גן עירוני חיפה","גן עירוני נתניה","משפחתון פרטי תל אביב","משפחתון בני ברק","מעון יום ויצו","מעון יום נעמת","מעון יום אמונה","מעון יום ישיר","naamat","נעמת","wizo daycare","emunah daycare","merkaz yom","מרכז יום","מרכז יום קשישים","דמי טיפול בנכים","דמי טיפול קשישים","מטפל סיעודי","מטפלת סיעודית","בית אבות פרטי","דיור מוגן","הוצאות סבא","הוצאות סבתא"],"category":"שונות ואחרים","subcategory":"אישי"},
  {"keywords":["חנוכה מתנות","חנוכה מתנה","דמי חנוכה","מתנות חנוכה","מתנה לראש השנה","מתנות ראש השנה","מתנת ראש השנה","מתנת חנוכה","מתנת פסח","מתנת ל\"ב בעומר","מתנת ט\"ו בשבט","מתנת חג","מתנות חג","תרומה לבית כנסת","בית כנסת תרומה","תרומה לישיבה","תרומה לכולל","תרומה לחב\"ד","תרומת מעשר","מעשר כספים","tzedakah online","צדקה אונליין","gemach","גמ\"ח כסף","mishloach manot","משלוח מנות","מנה לחבר","דמי שמחה","דמי אבל","אבל ושמחות","הספד","הספדים"],"category":"שונות ואחרים","subcategory":"מתנות"},
  {"keywords":["restaurant tip","gratuity","service charge restaurant","cover charge","corkage fee","דמי פתיחת בקבוק","דמי תפריט","דמי טיפ","טיפ למלצר","טיפ למלצרית","מע\"מ מסעדה","מע״מ מסעדה"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["fixie","urban bike","mountain bike","mtb","אופניים חשמליים","אופניים חשמליות","אופניים מתקפלים","אופניים שטח","אופניים עירוניים","אופניים מרוץ","אופניים ילדים","אופניים פיגי","electric bike","e-bike","ebike","אופניים סוסיתא","אופניים smart","smart bike israel","fido d4i","בייסיק קטנועים","קטנוע חשמלי","kugoo","kugoo s1","kugoo m4","mi scooter","xiaomi scooter","xiaomi mi scooter","aiways scooter","בית קורקינטים","תיקון אופניים","תיקון קורקינט","גידום פדאלים"],"category":"תחבורה","subcategory":"קורקינט"},
  {"keywords":["kalkalim mishpati","דוח רואה חשבון","דוח רואי חשבון","דוח שנתי","דוח שנתי לרשות המסים","דוח מס שנתי","דוח 1301","דוח 1301 שנתי","דוח רווח והפסד","דוח כספי","דוח שנתי עוסק","שכר טרחה רואה חשבון","שכר טרחה עורך דין","דמי תיק רואה חשבון","דמי ניהול תיק","דמי שירות תיק","דמי שירות עורך דין","מס תאגיד","מע\"מ שנתי","מע״מ שנתי","מע\"מ עוסק מורשה","מע״מ עוסק מורשה"],"category":"עסק","subcategory":"יועצים"},
  {"keywords":["domino sugar israel","sukar","cocoa powder","דבש כפר","דבש ים סוף","דבש דבורה","דבורה דבש","דבש לבן","דבש שיטה","בריאות לב","תוסף בריאות","omega 3","אומגה 3","אומגה-3","ויטמין d","ויטמין דk","ויטמין c","ויטמין מולטי","multivitamin","multi vitamin","תוספי תזונה","centrum","altman vitamins","altman תוספי תזונה","altman ojhcim","אלטמן ויטמינים","fitne tea","תה ירוק לב בריא","תה ירוק רב חבילה","protein powder","protein bar","אבקת חלבון","whey protein","whey","plant protein","vegan protein","אבקת חלבון צמחית"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["ima moshe yair","דמי טיפול הורים","דמי טיפול אחים","דמי טיפול קרובי משפחה","הוצאת אבא","הוצאת אמא","הוצאת סבא","הוצאת סבתא","הוצאת אח","הוצאת אחות","משלוח לאמא","משלוח לאבא","משלוח לסבא","משלוח לסבתא","תמיכה כספית להורים","תמיכה כספית סבא וסבתא","דמי ילד למשפחה","דמי בני נוער","דמי נסיעות ילדים"],"category":"שונות ואחרים","subcategory":"אישי"},
  {"keywords":["hertz israel","avis israel","budget israel","thrifty israel","thrifty rental","sixt israel","sixt rent a car","sixt rentacar","enterprise israel","eldan rentacar","eldan rent a car","eldan כירות רכב","אלדן השכרת רכב","אלדן השכרה רכב","אלדן רכב","budget השכרת רכב","budget רכב","thrifty השכרת רכב","sixt השכרת רכב","shlomo sixt","שלמה sixt","שלמה השכרת רכב","שלמה רכב","שלמה רנט א קאר","getaway car","turo car","turo car rental","דמי שכירות רכב","דמי השכרה רכב"],"category":"תחבורה","subcategory":"רכב שכור"},
  {"keywords":["kfar shlomo","shtoffel","shichunat ben gurion","mahane yehuda food","sarona market food","נמל יפו אוכל","levinski food","shuk levinski food","נמל תל אביב מסעדה","נמל תל אביב אוכל","נמל קיסריה אוכל","tlv port","נמל בית ים","yafo food","mahane yehuda restaurants","shuk machne yehuda restaurants","tachana merkazit food"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["חברתי עירוני","חברתי דמי השתתפות","דמי שותפות פרטית","שותפות עסקית","חברתי דמי חבר","דמי חבר מועדון","דמי חבר אגודה","דמי חבר ארגון","דמי חבר מערכת","דמי חבר קואופרטיב","membership fee","club fee","דמי הרשמה למועדון","דמי הרשמה לחוג"],"category":"הוצאות קבועות","subcategory":"אפליקציות"},
  {"keywords":["shooting range","מטווח","דמי מטווח","paintball","פיינטבול","lazer tag","לייזר טאג","kart racing","gokart","go kart","go-kart","go karting","גו-קארט","גוקארט","escape room","חדר בריחה","חדרי בריחה","climbing gym","climbing wall","קיר טיפוס","אולם טיפוס","gradient climbing","גרדיאנט טיפוס","climbing fix","fix climbing","הטיפוסים","נחושת","park yarkon","פארק הירקון","safari ramat gan","ספארי רמת גן","גן חיות הולנדי","גן חיות תנ\"כי","גן חיות תנ״כי","גן חיות ירושלים","jerusalem biblical zoo"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["גורי כלבים","גורי חתולים","מכרז עצמות","חוטם מנוקה","משחק חתול","משחק כלב","צעצוע לחתול","צעצוע לכלב","מתקני כלב","מתקני חתול","נחושת לחתול","אביזרים לחיות","pet accessories","pet toys","cat toys","dog toys","cat litter","חול לחתול","מצע חתולים","מצע גרגרים","fancy feast","whiskas","felix","sheba","cesar dog","cesar","נוטרילון","בונזו לחתולים","בונזו לכלבים","מזון מארק","מארק מזון","maxx mark"],"category":"שונות ואחרים","subcategory":"חיות מחמד"},
  {"keywords":["אריקסון","ericsson","iphone case","samsung case","phone case","מגן טלפון","נרתיק טלפון","מטען טלפון","מטען לטלפון","כבל usb","כבל usb-c","כבל lightning","מטען מהיר","fast charger","wireless charger","מטען אלחוטי","מטען מגנטי","magsafe","מגן מסך","screen protector","אוזניות","אוזניות חוטיות","אוזניות אלחוטיות","אוזניות bluetooth","אוזניות בלוטוס","אוזניות גיימינג","gaming headset","rgb keyboard","מקלדת rgb","מקלדת גיימינג","gaming keyboard","gaming mouse","עכבר גיימינג","gaming chair","כסא גיימינג","gaming pc","מחשב גיימינג","gaming monitor"],"category":"קניות","subcategory":"אלקטרוניקה"},
  {"keywords":["avant garde","avant-garde","אוונגרד","הופ הופ","hop hop","מרכז ילדים","מרכז משפחות","family center","kids center","kindergarten activity","פעילות גן","יום הולדת לילד","יום הולדת לילדה","מסיבת ילדים","מסיבת ילדה","מסיבת יום הולדת","הפעלה יום הולדת","הפעלת ילדים","אטרקציה לילדים","מטוס לילד","קוסם יום הולדת","קוסם לילדים","magic for kids","kids magic show","מופע ילדים","מופע ילדה","מופע פעוטון","מופע פעוטונים"],"category":"בידור","subcategory":"אירועים"},
  {"keywords":["gymboree","gymboree israel","kidsworld","kids world","mothercare","mothercare israel","baby cuts","baby cuts israel","fox kids","fox baby","baby outlet","kids outlet","next kids","next baby","h&m kids","h and m kids","zara kids","castro kids","kids store online","חנות ילדים","חנות בני נוער","בני נוער חנות","בגדי ילדים","בגדי תינוקות","בגדי תינוק","בגדי תינוקת","בגדי תינוקת חדשה","בגדים לתינוקת","בגדים לילד","בגדים לילדה","מקאני","mekani","mekani נעליים","נעלי ילדים","נעלי ילדה","נעלי תינוק","נעלי בני נוער"],"category":"קניות","subcategory":"ביגוד"},
  {"keywords":["matnas","מתנ\"ס","מתנ״ס","matnas online","matnas הרצליה","matnas רמת גן","matnas רעננה","matnas כפר סבא","matnas רחובות","matnas ראשון","matnas פתח תקווה","matnas חולון","matnas בני ברק","מתנ\"ס ירושלים","מתנ\"ס חיפה","מתנ\"ס באר שבע","מתנ\"ס נצרת עילית","מתנ\"ס נצרת","מתנ\"ס אילת","community center","דמי מתנ\"ס","דמי מתנס","חבר מתנ\"ס"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["kupat shabat","קופת שבת","tomche shabbos","תומכי שבת","mikve","מקווה","מקווה נשים","מקווה גברים","מקוואות","rabbi fee","דמי רב","דמי כשרות","כשרות פרטית","בדיקת כשרות","תרומה לישיבה הצעירה","תרומה לכולל","תרומה לחב\"ד","תרומה לבית מדרש","תרומת מצוות","הלוואת חסד","כספי הלוואת חסד","חברה קדישא","חברה-קדישא","דמי חברה קדישא","תרומה לחברה קדישא","הקדש","הקדש דתי"],"category":"שונות ואחרים","subcategory":"מתנות"},
  {"keywords":["eilat hotel","eilat resort","eilat ipanema","isrotel","isrotel eilat","isrotel king solomon","isrotel agamim","isrotel royal beach","fattal hotels","fattal israel","leonardo hotel","leonardo plaza","leonardo club","leonardo eilat","leonardo netanya","leonardo jerusalem","leonardo dead sea","isrotel dead sea","isrotel ramon","isrotel ganim","isrotel mizpe","orient jerusalem","jerusalem hotel","king david hotel","king david jerusalem","mamilla hotel","mamilla jerusalem","waldorf astoria jerusalem","inbal jerusalem","inbal hotel","crowne plaza tel aviv","crowne plaza jerusalem","crowne plaza haifa","hilton tel aviv","hilton jerusalem","sheraton tel aviv","royal beach","royal beach hotel","dan hotel","dan tel aviv","dan eilat","dan accadia","dan accadia herzliya","dan boutique","dan boutique jerusalem","dan panorama","dan panorama haifa","dan panorama tel aviv","dan jerusalem"],"category":"שונות ואחרים","subcategory":"נסיעות"},
  {"keywords":["ima מטבח","אבא מטבח","מטבחים אבא","מטבחי אבא","מטבחי גליה","מטבחי כרמלי","מטבחי דניאל","מטבחי גרניט","מטבחי ויקטור","מטבחי שילב","מטבחי מילר","מטבחי דקל","מטבחי עץ","מטבחי שיש","מטבחי לבנה","מטבחי שחור","מטבחי לבן","מטבחי אקריליק","נגרי אבא","נגרי דוד","נגרים","נגרות","kitchen carpenter","carpenter","carpentry","נגרות מטבחים","נגרות בית","נגרות פנים"],"category":"הוצאות קבועות","subcategory":"תחזוקת בית"},
  {"keywords":["פרי וירק","פרי הדר","פירות וירקות","פירות יבשים","אגוזים","גרעינים","גרעיני חמניות","גרעיני דלעת","גרעיני פשתן","גרעיני צ'יה","chia seeds","flax seeds","pumpkin seeds","sunflower seeds","cashew","cashews","almond","almonds","walnut","walnuts","אגוזי קשיו","אגוזי מלך","שקדים","בוטנים","פירות יבשים","אומגה 3 דגים","דגי סלמון","סלמון","salmon","טונה משומרת","טונה בקופסה","tuna can","sardines","סרדינים"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["ttb","gett go","gettgo","gett delivery","wolt market","wolt express market","cibus express","tenbis express","pikadon delivery","mishloach mahir","משלוח מהיר","delivery quick","rappi","lalamove","dolly","shipt","shoprider","doordash","instacart","grubhub","getir","gorillas","just eat","just eat takeaway"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["hama","חמא","חמאה","חמאת בוטנים","peanut butter","almond butter","cashew butter","tahini","tahini al hapach","tehina","תחינה","תחינה גולמית","תחינה אל הפח","tehina al hapach","achva tahini","achva tehina","בייגלה","בייגלה ביסלי","beigele","beygele","apropo","bamba","במבה","בייגל"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["eurovision","אירוויזיון","olympics","אולימפיאדה","world cup","מונדיאל","fifa world cup","champions league","ליגת אלופים","euro league","יורוליג","ufa","efa","super bowl","super-bowl","nba ticket","nba game","mlb ticket","mlb game","nfl ticket","nhl ticket","football ticket","ticketmaster","eventim","eventbrite","tlv tickets","tlv-tickets","lev hair","ראש העין כרטיסים"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["drone","drone dji","dji mavic","dji mini","dji air","dji avata","dji fpv","fpv drone","fpv kit","drone parts","drone battery","drone repair","drone insurance","ביטוח רחפן","תיקון רחפן","רחפן","רחפנים","בית רחפן","מטוס דגם","מטוסי דגם","rc plane","rc car","rc helicopter","rc drone","rc battery","lipo battery"],"category":"קניות","subcategory":"אלקטרוניקה"},
  {"keywords":["קניות בסופר","קניות לבית","קניות שבועיות","מצרכים","עגבניות","מלפפונים","בצל ירוק","תפוחי אדמה","בטטה","קישואים","חצילים","כרובית","ברוקולי","תפוזים","בננות","תפוחי עץ","אבטיח","מלון","ענבים","תותים","אבוקדו","בשר טחון","חזה עוף","שניצלים","כנפי עוף","בשר בקר","קבב","נקניקיות","סלמון","פילה דג","אמנון","ביצים","חלב טרי","גבינה צהובה","גבינה לבנה","קוטג","יוגורט","שמנת חמוצה","חמאה","לחמניות","פיתות","אורז","פתיתים","קוסקוס","קמח","שמן זית","קטשופ","מיונז","חומוס קנוי","טחינה גולמית","דגני בוקר","עוגיות","גלידה","שתייה קלה","מים מינרליים","מיץ תפוזים","קפה נמס","קפה טחון"],"category":"אוכל","subcategory":"אוכל לבית"},
  {"keywords":["ארוחת צהריים","ארוחת ערב","ארוחת בוקר","ארוחה במסעדה","פלאפל","שווארמה","סביח","המבורגר","ציפס","פיצה משפחתית","נודלס","פסטה במסעדה","סטייק","מסעדה איטלקית","מסעדה אסייתית","אוכל תאילנדי","אוכל הודי","טאקו","בורקס","כריך","טוסט אישי","בייגל","קינוח","עוגה בקפה","קפה הפוך","אספרסו","קפוצינו","אמריקנו","שוקו חם","תה צמחים","מאפה","קרואסון","דונאט"],"category":"אוכל","subcategory":"אוכל בחוץ"},
  {"keywords":["תדלוק","דלק 95","דלק 98","בנזין","סולר","תחנת דלק","מילוי דלק","כביש אגרה","אגרת כביש","נסיעה ברכבת","כרטיס רכבת","נסיעה באוטובוס","כרטיס אוטובוס","רכבת קלה","טעינת רב קו","כרטיסיית נסיעות","נסיעת מונית","הזמנת מונית","השכרת אופניים","השכרת קורקינט","קורקינט חשמלי","אופניים חשמליים","טיסת פנים"],"category":"תחבורה","subcategory":"תחבורה"},
  {"keywords":["דמי חניה","חניה בתשלום","תשלום חניה","חניון יומי","דוח חניה","קנס חניה","חניה כחול לבן","מנוי חניה","אגרת חניה"],"category":"תחבורה","subcategory":"חניה"},
  {"keywords":["חשבון חשמל","חשבון מים","חשבון גז","חשבון טלפון","חשבון אינטרנט","חבילת אינטרנט","חבילת סלולר","חבילת גלישה","חבילת טלוויזיה","מנוי טלוויזיה","דמי ניהול","ועד בית","דמי ועד","שכר דירה","דמי שכירות","ארנונה חודשית","חשבון סלולרי","גלישה ניידת"],"category":"הוצאות קבועות","subcategory":"חשבונות"},
  {"keywords":["ביטוח דירה","ביטוח רכב","ביטוח חובה","ביטוח מקיף","ביטוח צד שלישי","ביטוח בריאות","ביטוח חיים","ביטוח משכנתא","ביטוח נסיעות","ביטוח שיניים","פרמיית ביטוח","דמי ביטוח"],"category":"הוצאות קבועות","subcategory":"ביטוח"},
  {"keywords":["ביקור רופא","רופא פרטי","השתתפות עצמית","קופת חולים","בדיקות דם","בדיקה רפואית","חיסון","ייעוץ רפואי","בדיקת עיניים","אופטומטריסט","משקפי ראייה","עדשות מגע","פיזיותרפיה","טיפול פסיכולוגי","דיאטנית","תזונאית"],"category":"בריאות","subcategory":"בריאות"},
  {"keywords":["תרופות","מרשם","בית מרקחת","כדורים","אנטיביוטיקה","משכך כאבים","אקמול","נורופן","ויטמינים","תוספי תזונה","מד חום","פלסטרים","קרם הגנה","משחה רפואית"],"category":"בריאות","subcategory":"תרופות"},
  {"keywords":["רופא שיניים","טיפול שיניים","סתימה","עקירת שן","יישור שיניים","אורתודונט","ניקוי אבנית","כתר שן","שתל שן","הלבנת שיניים"],"category":"בריאות","subcategory":"שיניים"},
  {"keywords":["בגדים","חולצה","חולצת טי","מכנסיים","גינס","שמלה","חצאית","מעיל","סוודר","קפוצון","גופייה","גרביים","הלבשה תחתונה","תחתונים","חזייה","בגד ים","פיגמה","נעלי ספורט","סנדלים","מגפיים","כפכפים","נעלי עקב","תיק יד","ארנק","חגורה","כובע","צעיף","משקפי שמש"],"category":"קניות / ביגוד","subcategory":"ביגוד"},
  {"keywords":["תספורת","מספרה","צבע שיער","החלקת שיער","מניקור","פדיקור","לק גל","בניית ציפורניים","טיפול פנים","קוסמטיקאית","הסרת שיער","הסרת שיער בלייזר","עיסוי","עיסוי רפואי","עיצוב גבות","בושם","פרפיום","קרם פנים","שפתון","מסקרה"],"category":"טיפוח","subcategory":"טיפוח"},
  {"keywords":["גן ילדים","צהרון","מטפלת","שמרטף","בייביסיטר","חוג ילדים","שיעור פרטי","מורה פרטי","קייטנה","שכר לימוד","תשלום לבית ספר","ספרי לימוד","ציוד לבית ספר","ילקוט","קלמר","חיתולים","מגבונים","מטרנה","סימילק","אוכל לתינוק","עגלת תינוק","סלקל","מוצץ","בקבוק לתינוק"],"category":"חינוך","subcategory":"חינוך"},
  {"keywords":["כרטיס לסרט","סרט בקולנוע","הצגה בתיאטרון","כרטיס להופעה","קונצרט","מופע","פסטיבל","מוזיאון","לונה פארק","פארק מים","כניסה לבריכה","באולינג","חדר בריחה","משחקייה","כרטיסים להופעה","פאב"],"category":"בידור","subcategory":"יציאות"},
  {"keywords":["חדר כושר","מנוי לחדר כושר","אימון אישי","מאמן כושר","שיעור יוגה","פילאטיס","קרוספיט","חוג ספורט","מנוי שחייה","סטודיו לכושר"],"category":"כושר ומנויים","subcategory":"כושר"},
  {"keywords":["כרטיס טיסה","טיסה לחול","בית מלון","לינה במלון","צימר","וילה לחופשה","חבילת נופש","השכרת רכב בחול","ביטוח נסיעות","דיוטי פרי","מזוודה","אגרת יציאה","חידוש דרכון"],"category":"נסיעות","subcategory":"נסיעות"},
  {"keywords":["אוכל לכלב","אוכל לחתול","מזון לכלבים","מזון לחתולים","וטרינר","חיסון לכלב","חול לחתול","מספרה לכלבים","פנסיון לכלבים","צעצוע לכלב","רצועה לכלב","אקווריום"],"category":"חיות מחמד","subcategory":"חיות מחמד"},
  {"keywords":["חומרי ניקוי","אקונומיקה","נוזל כלים","אבקת כביסה","מרכך כביסה","נייר טואלט","מגבונים לחים","שקיות אשפה","משחת שיניים","אינסטלטור","חשמלאי","מנעולן","גנן","שיפוצים","צבע לקיר","ברגים","כלי עבודה לבית"],"category":"תחזוקת בית","subcategory":"תחזוקת בית"},
  {"keywords":["ספה","מיטה","מזרן","שולחן אוכל","כיסא","ארון בגדים","מדף","כוננית","שידה","מנורה","נברשת","וילון","שטיח","כלי מטבח","סירים","מחבת","צלחות","כוסות","סכום","מגבות","מצעים","כריות","שמיכה","מקרר","מכונת כביסה","מדיח כלים","תנור","מיקרוגל","מזגן","מאוורר","שואב אבק","קומקום","טוסטר","בלנדר"],"category":"קניות / רהיטים","subcategory":"רהיטים"},
  {"keywords":["מתנת יום הולדת","זר פרחים","מתנה לחתונה","שי לחג","שוקולד מתנה","מתנה לאירוע","כרטיס ברכה","בלונים","עוגת יום הולדת"],"category":"מתנות","subcategory":"מתנות"},
  {"keywords":["עמלת בנק","עמלות בנק","דמי ניהול חשבון","עמלת כרטיס","עמלת משיכה","החזר הלוואה","תשלום הלוואה","החזר אשראי","דמי כרטיס אשראי","העברה בבנק"],"category":"בנקאות","subcategory":"בנקאות"},
  {"keywords":["אגרת רישוי","טסט שנתי","טסט לרכב","חידוש רישיון","ביטוח לאומי","מס הכנסה","תשלום מעמ","מקדמות מס","דוח תנועה","אגרת טלוויזיה","אגרה ממשלתית","נוטריון","אגרת בית משפט","דמי רישום"],"category":"ממשלה ומיסים","subcategory":"מיסים ואגרות"}
];

const DEFAULT_CATEGORY = { category: 'שונות ואחרים', subcategory: 'שונות', isIncome: false };

/**
 * sanitizeForSheet — prevents formula injection when user-typed strings land in a cell.
 * Sheets/Excel evaluate any cell whose value begins with =, +, -, @, or a tab as a formula,
 * so a malicious description like "=HYPERLINK(...)" could exfiltrate data on open. Prepending
 * a single quote forces the cell to be treated as plain text. Non-strings pass through unchanged
 * because numbers, dates, and booleans never enter formula parsing.
 */
function sanitizeForSheet(value) {
  if (typeof value !== 'string') return value;
  if (value.length === 0) return value;
  var first = value.charAt(0);
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t') {
    return "'" + value;
  }
  return value;
}

// ════════════════════════════════════════════════════════════════════════════
// ORIGINAL-TEXT CELL NOTES
// Every successful appendRow records the user's raw message (or receipt/voice
// origin) as a cell note on column F (description) of the new row. Notes are
// invisible until hovered/clicked — they don't trigger any user-facing message.
// Capped at 1000 chars (Google Sheets ceiling is ~1024; we leave headroom).
// All errors are swallowed so a note-write failure never blocks the expense.
// ════════════════════════════════════════════════════════════════════════════
var _KFL_NOTE_MAX = 1000;

function _kfl_buildOriginalNote(prefix, rawText, extraLines) {
  try {
    var tz = 'Asia/Jerusalem';
    var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
    var body = (prefix || 'Original') + ': "' + String(rawText || '').trim() + '" (' + stamp + ')';
    if (extraLines && extraLines.length) {
      body += '\n' + extraLines.join('\n');
    }
    if (body.length > _KFL_NOTE_MAX) body = body.slice(0, _KFL_NOTE_MAX - 1) + '…';
    return body;
  } catch (_e) {
    return String(rawText || '').slice(0, _KFL_NOTE_MAX);
  }
}

function _kfl_setRowOriginalNote(sheet, rowNumber, note) {
  if (!sheet || !rowNumber || !note) return;
  try {
    // Column 6 = F = "פירוט" (description) in the תנועות tab.
    sheet.getRange(rowNumber, 6).setNote(note);
    Logger.log('_kfl_setRowOriginalNote: row=' + rowNumber + ' noteLen=' + note.length);
  } catch (e) {
    Logger.log('_kfl_setRowOriginalNote err: ' + (e && e.message));
  }
}

function _kfl_appendOriginalNoteLine(sheet, rowNumber, line) {
  if (!sheet || !rowNumber || !line) return;
  try {
    var range = sheet.getRange(rowNumber, 6);
    var existing = range.getNote() || '';
    var combined = existing ? (existing + '\n' + line) : line;
    if (combined.length > _KFL_NOTE_MAX) combined = combined.slice(0, _KFL_NOTE_MAX - 1) + '…';
    range.setNote(combined);
    Logger.log('_kfl_appendOriginalNoteLine: row=' + rowNumber + ' newLen=' + combined.length);
  } catch (e) {
    Logger.log('_kfl_appendOriginalNoteLine err: ' + (e && e.message));
  }
}

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
// 🔐 Webhook authenticity — verify the payload actually came from Meta.
// ------------------------------------------------------------
// Meta signs every WhatsApp Cloud webhook with HMAC-SHA256 over the raw body
// using the App Secret as the key, and ships the digest in the
// X-Hub-Signature-256 header (format: "sha256=<hex>"). We verify two things:
//   1) The HMAC matches (only possible when Apps Script exposes the header —
//      historically it does NOT for public web apps, so we degrade gracefully).
//   2) The payload's WABA id matches WHATSAPP_BUSINESS_ACCOUNT_ID. This works
//      regardless of header access and filters random spam against the /exec
//      URL even when full HMAC verification can't run inside Apps Script.
//
// Configuration (all optional Script Properties):
//   META_APP_SECRET                — the Meta App Secret. If unset, HMAC check
//                                    is skipped with a logged warning.
//   WHATSAPP_BUSINESS_ACCOUNT_ID   — the WABA id we expect in entry[0].id.
//                                    If unset, this secondary check is skipped.
//   STRICT_WEBHOOK_VERIFY          — "1" to reject when HMAC verification is
//                                    not possible (header missing, secret
//                                    unset). Default off for backward compat.
//
// Returns { valid: bool, reason: string }. Callers log the reason but never
// echo it to the response (so probers can't infer why they failed).
// ============================================================
function _verifyMetaWebhook_(e, rawBody) {
  try {
    var props = PropertiesService.getScriptProperties();
    var appSecret = props.getProperty('META_APP_SECRET') || '';
    var expectedWaba = props.getProperty('WHATSAPP_BUSINESS_ACCOUNT_ID') || '';
    var strict = props.getProperty('STRICT_WEBHOOK_VERIFY') === '1';

    // -- Attempt HMAC-SHA256 over the raw body --
    // Apps Script's doPost has historically NOT exposed request headers on
    // standard web-app deployments. We probe a few possible locations Apps
    // Script may surface them in (e.headers, e.parameter, e.postData.headers)
    // so this code "just works" if Google ever ships header support.
    var sigHeader = '';
    if (e) {
      if (e.headers) {
        sigHeader = e.headers['X-Hub-Signature-256']
                 || e.headers['x-hub-signature-256']
                 || '';
      }
      if (!sigHeader && e.parameter) {
        sigHeader = e.parameter['X-Hub-Signature-256']
                 || e.parameter['x-hub-signature-256']
                 || '';
      }
      if (!sigHeader && e.postData && e.postData.headers) {
        sigHeader = e.postData.headers['X-Hub-Signature-256']
                 || e.postData.headers['x-hub-signature-256']
                 || '';
      }
    }

    var hmacRan = false;
    if (appSecret && sigHeader && rawBody) {
      var prefix = 'sha256=';
      var supplied = String(sigHeader).indexOf(prefix) === 0
                   ? String(sigHeader).substring(prefix.length).toLowerCase()
                   : String(sigHeader).toLowerCase();
      var bytes = Utilities.computeHmacSha256Signature(rawBody, appSecret);
      // Convert raw bytes to lowercase hex.
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i] & 0xff;
        var h = b.toString(16);
        if (h.length < 2) h = '0' + h;
        hex += h;
      }
      hmacRan = true;
      // Constant-time-ish compare to avoid trivial timing leaks. Apps Script
      // doesn't expose a true constant-time comparator, but iterating over
      // both strings is closer than `===` short-circuiting on first byte.
      if (hex.length !== supplied.length) {
        return { valid: false, reason: 'hmac_length_mismatch' };
      }
      var diff = 0;
      for (var k = 0; k < hex.length; k++) {
        diff |= hex.charCodeAt(k) ^ supplied.charCodeAt(k);
      }
      if (diff !== 0) {
        return { valid: false, reason: 'hmac_mismatch' };
      }
    } else if (strict) {
      // Strict mode demands HMAC; refuse if we couldn't run it.
      return { valid: false, reason: !appSecret
        ? 'strict_mode_secret_unset'
        : (!sigHeader ? 'strict_mode_signature_header_missing' : 'strict_mode_no_body') };
    } else {
      Logger.log('Webhook HMAC skipped: secret=' + (appSecret ? 'set' : 'unset')
        + ' header=' + (sigHeader ? 'present' : 'absent'));
    }

    // -- Secondary check: WABA id must match (when configured) --
    if (expectedWaba && rawBody) {
      try {
        var parsed = JSON.parse(rawBody);
        var gotWaba = parsed && parsed.entry && parsed.entry[0] && parsed.entry[0].id;
        if (!gotWaba) {
          return { valid: false, reason: 'waba_id_absent' };
        }
        if (String(gotWaba) !== String(expectedWaba)) {
          return { valid: false, reason: 'waba_id_mismatch' };
        }
      } catch (_jsonErr) {
        return { valid: false, reason: 'body_not_json' };
      }
    }

    return { valid: true, reason: hmacRan ? 'hmac_ok' : 'hmac_skipped' };
  } catch (err) {
    // Never block on our own bug — log + allow through to preserve uptime.
    Logger.log('_verifyMetaWebhook_ err: ' + (err && err.stack || err));
    return { valid: true, reason: 'verify_error_fail_open' };
  }
}

// ============================================================
// 🚦 Per-phone rate limit — silent drop when a single sender goes over
// MAX_MSGS_PER_WINDOW messages in WINDOW_SECONDS. Uses CacheService (LRU,
// not durable, but adequate for spam suppression). Fails open if cache I/O
// breaks so a CacheService outage never blocks legitimate users.
// ============================================================
// ─────────────────────────────────────────────────────────────────────
// Examples — onboarding helper. Returns the "write like you talk" list.
// Tailored slightly by persona if one was stored via the settings flow.
// ─────────────────────────────────────────────────────────────────────
function _getExamplesMessage_(fromPhone) {
  var base =
    'עוד דוגמאות — תכתוב חופשי, אני כבר מסדר 🤓\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '• *320 ביטוח רכב*\n' +
    '• *90 בית מרקחת*\n' +
    '• *250 חשבון חשמל*\n' +
    '• *1,500 גן ילדים*\n' +
    '• *180 מספרה*\n' +
    '• *35 חניון*\n' +
    '• *750 מסעדה עם המשפחה*\n' +
    '• *2,400 טיסה לחו"ל*\n\n' +
    'את כל אלה אני יודע לקטלג לבד ✅\n' +
    'אפשר גם הפוך — *"סופר 150"* בדיוק כמו *"150 סופר"*.\n\n' +
    'שלח *סיכום* למצב החודש, או *עזרה* לכל הפקודות.';
  // Persona tailoring (best-effort).
  try {
    if (typeof _getSettings_ === 'function') {
      var s = _getSettings_(fromPhone);
      if (s && s.persona === 'business') {
        base += '\n\n🏢 *לעסק:* "עסק 880 לקוח ליה גודל 50-70 קנבס עלות מוצר 240 משלוח 45"';
      }
    }
  } catch (_e) {}
  return base;
}

// ─────────────────────────────────────────────────────────────────────
// Note — append free text to the LAST expense's cell note (column G's
// cell comment). The original message is already preserved there; this
// adds the user's remark on a new line, timestamped.
// ─────────────────────────────────────────────────────────────────────
function _addNoteToLast_(noteText) {
  if (!noteText || noteText.length < 1) return '😬 הערה ריקה. נסה "הערה: שילמתי במזומן".';
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '😬 לא מצאתי את לשונית התנועות.';
    var last = sheet.getLastRow();
    if (last < 2) return '📭 אין הוצאה להוסיף לה הערה.';
    var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM HH:mm');
    if (typeof _kfl_appendOriginalNoteLine === 'function') {
      _kfl_appendOriginalNoteLine(sheet, last, '📝 ' + noteText.slice(0, 200) + ' (' + stamp + ')');
    } else {
      // Fallback: write into a Note column if the sheet has one, else the cell note.
      var note = sheet.getRange(last, 6).getNote() || '';
      sheet.getRange(last, 6).setNote((note ? note + '\n' : '') + '📝 ' + noteText.slice(0, 200) + ' (' + stamp + ')');
    }
    return '✅ ההערה נוספה להוצאה האחרונה:\n"' + noteText.slice(0, 80) + '"';
  } catch (e) {
    Logger.log('_addNoteToLast_ err: ' + (e && e.message));
    return '😬 לא הצלחתי להוסיף הערה: ' + (e && e.message || '');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Correction — edit the LAST logged expense's amount / description /
// date. Operates on the bottom data row of the תנועות tab. Columns:
// A date | B month | C amount | D category | E sub | F description.
// ─────────────────────────────────────────────────────────────────────
function _correctLastExpense_(field, value) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '😬 לא מצאתי את לשונית התנועות.';
    var last = sheet.getLastRow();
    if (last < 2) return '📭 אין הוצאה לתיקון.';
    var f = String(field).toLowerCase();
    if (/סכום|amount/.test(f)) {
      var amt = _parseIsraeliNumber_(value);
      if (!isFinite(amt) || amt <= 0) return '😬 סכום לא תקין. נסה "תיקון סכום 250".';
      sheet.getRange(last, 3).setValue(amt);
      return '✅ הסכום של ההוצאה האחרונה עודכן ל-₪' + amt.toLocaleString('he-IL') + '.';
    }
    if (/פירוט|תיאור|description/.test(f)) {
      sheet.getRange(last, 6).setValue(sanitizeForSheet(value.slice(0, 200)));
      return '✅ הפירוט של ההוצאה האחרונה עודכן ל-"' + value.slice(0, 60) + '".';
    }
    if (/תאריך|date/.test(f)) {
      var di = (typeof _extractLeadingDate_ === 'function') ? _extractLeadingDate_(value + ' x') : null;
      if (!di || !di.date) return '😬 תאריך לא תקין. נסה "תיקון תאריך 12/4".';
      var d = di.date;
      sheet.getRange(last, 1).setValue(d);
      sheet.getRange(last, 2).setValue(Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM'));
      return '✅ התאריך של ההוצאה האחרונה עודכן ל-' + Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM/yyyy') + '.';
    }
    return '😬 אפשר לתקן: סכום / פירוט / תאריך. דוגמה: "תיקון סכום 250".';
  } catch (e) {
    Logger.log('_correctLastExpense_ err: ' + (e && e.message));
    return '😬 שגיאה בתיקון: ' + (e && e.message || '');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Search — "חפש <term>" scans the תנועות tab for matching rows and
// returns the most recent matches + a running total. Owner sheet only
// for now (tenants would query via a future Vercel endpoint).
// ─────────────────────────────────────────────────────────────────────
function _searchExpenses_(term) {
  if (!term || term.length < 2) return '😬 חיפוש קצר מדי. נסה "חפש קפה".';
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '😬 לא מצאתי את לשונית התנועות.';
    var last = sheet.getLastRow();
    if (last < 2) return '📭 אין הוצאות לחיפוש.';
    var rng = sheet.getRange(2, 1, last - 1, 7).getValues(); // date, month, amount, cat, sub, desc, source
    var needle = String(term).toLowerCase();
    var matches = [];
    var total = 0;
    for (var i = rng.length - 1; i >= 0; i--) {
      var r = rng[i];
      var hay = (String(r[3]) + ' ' + String(r[4]) + ' ' + String(r[5])).toLowerCase();
      if (hay.indexOf(needle) < 0) continue;
      var amt = Number(r[2]) || 0;
      total += amt;
      if (matches.length < 10) {
        var when = r[0] instanceof Date ? Utilities.formatDate(r[0], 'Asia/Jerusalem', 'dd/MM') : String(r[0]).slice(0, 5);
        matches.push('  • ' + when + ' · ₪' + amt.toLocaleString('he-IL') + ' · ' + (r[5] || r[4] || r[3]));
      }
    }
    if (!matches.length) return '🔍 לא נמצאו תוצאות ל-"' + term + '".';
    var out = ['🔍 *תוצאות חיפוש: "' + term + '"*', '━━━━━━━━━━━━━━━━━━', ''];
    out = out.concat(matches);
    out.push('');
    out.push('💰 סה"כ: ₪' + total.toLocaleString('he-IL') + ' (' + matches.length + (matches.length === 10 ? '+' : '') + ' תוצאות)');
    return out.join('\n');
  } catch (e) {
    Logger.log('_searchExpenses_ err: ' + (e && e.message));
    return '😬 שגיאה בחיפוש: ' + (e && e.message || '');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Settings — per-user preferences in a Script Property settings:<phone>.
// "הגדרות" with no args shows the current settings + how to change them;
// "הגדרות שפה אנגלית" / "הגדרות אזור זמן ..." etc. set a value.
// ─────────────────────────────────────────────────────────────────────
function _settingsKey_(phone) { return 'settings:' + String(phone).replace(/[^0-9]/g, ''); }
function _getSettings_(phone) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(_settingsKey_(phone));
    return raw ? JSON.parse(raw) : {};
  } catch (_e) { return {}; }
}
function _handleSettings_(phone, arg) {
  var s = _getSettings_(phone);
  if (!arg) {
    return '⚙️ *ההגדרות שלך*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      '🌐 שפה: ' + (s.lang === 'en' ? 'English' : 'עברית') + '\n' +
      '📂 קטגוריית ברירת מחדל: ' + (s.defaultCategory || 'שונות') + '\n' +
      '📅 יום דיגסט: ' + (s.digestDay || 'ראשון') + '\n' +
      '🕐 אזור זמן: ' + (s.tz || 'Asia/Jerusalem') + '\n\n' +
      'לשינוי:\n' +
      '  • "הגדרות שפה אנגלית" / "הגדרות שפה עברית"\n' +
      '  • "הגדרות קטגוריה <שם>"\n' +
      '  • "הגדרות יום <ראשון/שני/...>"';
  }
  var m;
  if ((m = arg.match(/^(?:שפה|language)\s+(אנגלית|english|עברית|hebrew)/i))) {
    s.lang = /אנגלית|english/i.test(m[1]) ? 'en' : 'he';
  } else if ((m = arg.match(/^(?:קטגוריה|category)\s+(.+)$/i))) {
    s.defaultCategory = m[1].trim().slice(0, 40);
  } else if ((m = arg.match(/^(?:יום|day)\s+(.+)$/i))) {
    s.digestDay = m[1].trim().slice(0, 20);
  } else if ((m = arg.match(/^(?:אזור\s+זמן|timezone|tz)\s+(.+)$/i))) {
    s.tz = m[1].trim().slice(0, 40);
  } else {
    return '😬 לא הבנתי. שלח "הגדרות" לרשימת האפשרויות.';
  }
  try { PropertiesService.getScriptProperties().setProperty(_settingsKey_(phone), JSON.stringify(s)); }
  catch (_e) { return '😬 שמירה נכשלה.'; }
  return '✅ עודכן. שלח "הגדרות" כדי לראות את ההגדרות הנוכחיות.';
}

// ─────────────────────────────────────────────────────────────────────
// Account deletion — GDPR/PPL. Two-step: first call shows a warning and
// asks for confirmation; "מחק חשבון כן" performs it. Calls the Vercel
// /api/account delete path (which revokes the OAuth token + drops KV),
// and clears local Script-Property state for this phone.
// ─────────────────────────────────────────────────────────────────────
function _handleAccountDeletion_(phone, confirmed) {
  if (!confirmed) {
    return '⚠️ *מחיקת חשבון*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      'זה ימחק:\n' +
      '  • את הקישור בין המספר שלך לגיליון\n' +
      '  • את אסימוני ההזדהות שלך\n' +
      '  • את ההגדרות והתזכורות שלך\n\n' +
      'הגיליון עצמו נשאר ב-Google Drive שלך — אנחנו לא נוגעים בו.\n\n' +
      'בטוח? שלח *"מחק חשבון כן"* כדי לאשר.';
  }
  // Confirmed — clear local state + ask Vercel to purge KV/OAuth.
  var clean = String(phone).replace(/[^0-9]/g, '');
  try {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty(_settingsKey_(phone));
    props.deleteProperty('lastPing:' + clean);
  } catch (_e) {}
  // HONESTY (2026-05-24): GDPR-sensitive. The original silently swallowed
  // a server failure and told the user "deleted" anyway. Capture the
  // response code and only confirm success on 2xx. On failure return a
  // try-again message so the user knows their tokens are STILL on file.
  var delOk = false;
  var delDetail = '';
  try {
    var secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '');
    if (!secret) {
      delDetail = 'bot_secret_not_set';
    } else {
      var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/account?action=delete-by-phone', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-kesefle-bot-secret': secret },
        payload: JSON.stringify({ botSecret: secret, phone: clean }),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        delOk = true;
      } else {
        delDetail = 'http_' + code + ' ' + String(resp.getContentText() || '').slice(0, 100);
        Logger.log('_handleAccountDeletion_ failed: ' + delDetail);
      }
    }
  } catch (e) {
    delDetail = 'threw: ' + (e && e.message);
    Logger.log('_handleAccountDeletion_ threw: ' + delDetail);
  }
  if (!delOk) {
    return '😬 לא הצלחתי למחוק את החשבון עכשיו. הקישור והאסימונים עדיין על השרת.\n' +
      'נסה/י שוב בעוד דקה. אם החיוב הזה חוזר — כתוב לתמיכה ב-support@kesefle.com.\n\n' +
      '(שגיאה: ' + delDetail.slice(0, 60) + ')';
  }
  return '✅ החשבון נמחק. הקישור והאסימונים הוסרו.\n' +
    'הגיליון נשאר אצלך ב-Drive. תודה שניסית את כספ\'לה 💚\n\n' +
    'אם תרצה לחזור — היכנס שוב ל-https://kesefle.com/account.';
}

// New-lead alert. The first time a given phone ever messages the bot,
// notify the owner — email (MailApp) + a WhatsApp ping to the alert
// number — with the customer's phone. Deduped permanently per phone via
// a leadNotified:<phone> Script Property, so it fires exactly once per
// new customer. The alert WhatsApp number is configurable via the
// LEAD_ALERT_PHONE Script Property (defaults to +972547760643). That
// number must be in the bot number's recipient allowlist for the
// WhatsApp ping to deliver (the email always works).
function _notifyOwnerNewLead_(fromPhone) {
  if (!fromPhone) return;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  if (!clean) return;
  var props = PropertiesService.getScriptProperties();
  // Don't alert on the owner's own messages.
  var owner = String(props.getProperty('SHEET_OWNER_PHONE') || '').replace(/[^0-9]/g, '');
  if (owner && clean === owner) return;
  var flagKey = 'leadNotified:' + clean;
  if (props.getProperty(flagKey)) return; // already alerted for this customer
  props.setProperty(flagKey, new Date().toISOString());

  var when = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'dd/MM/yyyy HH:mm');
  var displayPhone = '+' + clean;

  // 1) Email the owner.
  try {
    var addr = Session.getActiveUser().getEmail();
    if (addr) {
      MailApp.sendEmail({
        to: addr,
        subject: '🆕 כספ\'לה — לקוח חדש התחבר לבוט',
        body: 'לקוח חדש שלח הודעה ראשונה לבוט:\n\n' +
          '📞 מספר: ' + displayPhone + '\n' +
          '🕐 זמן: ' + when + '\n\n' +
          '(התראה זו נשלחת פעם אחת בלבד לכל מספר חדש.)',
      });
    }
  } catch (_me) { Logger.log('new-lead email err: ' + (_me && _me.message)); }

  // 2) WhatsApp ping to the alert number.
  try {
    var alertPhone = String(props.getProperty('LEAD_ALERT_PHONE') || '+972547760643');
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(alertPhone,
        '🆕 *לקוח חדש התחבר לבוט*\n' +
        '📞 ' + displayPhone + '\n' +
        '🕐 ' + when);
    }
  } catch (_we) { Logger.log('new-lead whatsapp err: ' + (_we && _we.message)); }
}

// Resolve the Google Sheet URL for a given sender. Owner → the main
// company sheet; tenants → their own provisioned sheet (cached 1h to
// avoid an HTTP lookup on every reply).
function _userSheetUrl_(fromPhone) {
  try {
    var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
    // Resolve the owner via the canonical helper / constant — NOT just the
    // Script Property (an unset property must never make every tenant "owner").
    var owner = '';
    try { if (typeof _ownerPhoneDigits_ === 'function') owner = String(_ownerPhoneDigits_() || '').replace(/[^0-9]/g, ''); } catch (_oe) {}
    if (!owner) {
      owner = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || '').replace(/[^0-9]/g, '')
           || ((typeof OWNER_PHONE !== 'undefined') ? String(OWNER_PHONE).replace(/[^0-9]/g, '') : '');
    }
    // ONLY the verified owner gets the company SHEET_ID. A tenant whose own sheet
    // can't be resolved gets '' (no link) — never the owner's sheet (leak guard).
    if (owner && clean === owner) {
      return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
    }
    var cache = CacheService.getScriptCache();
    var ck = 'sheeturl:' + clean;
    var cached = cache.get(ck);
    if (cached) return cached;
    var rec = (typeof _kvLookupPhone_ === 'function') ? _kvLookupPhone_(clean) : null;
    var url = (rec && rec.sheetId) ? ('https://docs.google.com/spreadsheets/d/' + rec.sheetId + '/edit')
            : (rec && rec.sheetUrl) ? rec.sheetUrl : '';
    if (url) cache.put(ck, url, 3600);
    return url;
  } catch (_e) {
    return '';   // on error, show no link rather than risk leaking the owner sheet
  }
}

// The compact "check it in your sheet" line appended to expense/order
// confirmations so the user can verify the row landed correctly.
function _sheetLinkLine_(fromPhone) {
  var u = _userSheetUrl_(fromPhone);
  return u ? ('\n\n📊 לבדיקה: ' + u) : '';
}

// One-time welcome. The first time a phone messages the bot, send a
// ≤3-line intro (what the service is + why it helps), how to use it, a
// pin tip, and a link to their sheet. Deduped per phone via
// welcomed:<phone>. NOTE: WhatsApp Cloud API has no programmatic
// "pin message" button — pinning is a user gesture — so we instruct the
// user how to pin (long-press → Pin) rather than fake a button.
function _maybeSendWelcome_(fromPhone) {
  if (!fromPhone) return false;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  if (!clean) return false;
  var props = PropertiesService.getScriptProperties();
  var key = 'welcomed:' + clean;
  if (props.getProperty(key)) return false;
  props.setProperty(key, new Date().toISOString());

  var sheetUrl = _userSheetUrl_(fromPhone);
  var msg =
    '👋 *ברוכים הבאים לכספ\'לה!*\n' +
    'אני עוקב אחרי ההוצאות שלך ישר בוואטסאפ — בלי אפליקציה ובלי אקסל. כל הוצאה נשמרת אוטומטית בגיליון Google הפרטי שלך.\n\n' +
    'פשוט תכתוב לי כמו שאתה מדבר 😎\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '• *150 סופר* ← יסווג כ"אוכל"\n' +
    '• *ארנונה 400* ← יסווג כ"בית"\n' +
    '• *200 דלק* ← יסווג כ"רכב"\n' +
    '• *80 מתנה לאמא* ← יסווג כ"משפחה"\n' +
    '• *1,200 שכר דירה* ← יסווג כ"בית"\n' +
    '• *45 קפה ארומה* ← יסווג כ"בתי קפה"\n\n' +
    'כל מילה שתחשוב עליה — אני כבר מכיר.\n\n' +
    '💡 עוד דברים שאני יודע לעשות:\n' +
    '• *אתמול 60 מכולת* — תאריך אחר\n' +
    '• *$50 שרת* — מטבע זר (מומר לשקלים)\n' +
    '• 🧾 *צילום קבלה* — שלח לי תמונה\n' +
    '• *הערה: שילמתי במזומן* — הוסף הערה להוצאה האחרונה\n' +
    '• *סיכום* — סיכום החודש\n' +
    '• *עזרה* — כל הפקודות\n\n' +
    '📌 *טיפ:* לחיצה ארוכה על ההודעה הזו ← "הצמד" (Pin), כדי שתהיה תמיד בהישג יד.\n\n' +
    (sheetUrl ? ('📊 הגיליון שלך:\n' + sheetUrl + '\n\n') : '') +
    '🎁 *הביאו חבר → חודש Pro חינם לשניכם:*\nhttps://kesefle.com/referral';
  try {
    if (typeof sendWhatsAppMessage === 'function') sendWhatsAppMessage(fromPhone, msg);
  } catch (_e) { Logger.log('welcome send err: ' + (_e && _e.message)); }

  // Kick off the personalization questionnaire once, right after the welcome.
  // Guarded by its own Script Property so re-welcomes (if the welcomed guard
  // is ever cleared) never re-trigger Q1 on a user mid-flow.
  try {
    var surveyedKey = 'surveyed:' + clean;
    if (!props.getProperty(surveyedKey) && typeof _surveyStart_ === 'function') {
      props.setProperty(surveyedKey, new Date().toISOString());
      _surveyStart_(fromPhone);
    }
  } catch (_sErr) { Logger.log('welcome survey kickoff err: ' + (_sErr && _sErr.message)); }
  return true;
}

// Abuse blacklist — a Script Property holding a comma-separated list of
// blocked phone numbers (digits only). Cached 5 min to avoid a property
// read on every message. Manage via "blacklist" Script Property.
function _isBlacklisted_(fromPhone) {
  if (!fromPhone) return false;
  try {
    var clean = String(fromPhone).replace(/[^0-9]/g, '');
    var cache = CacheService.getScriptCache();
    var raw = cache.get('blacklist');
    if (raw === null) {
      raw = String(PropertiesService.getScriptProperties().getProperty('BLACKLIST_PHONES') || '');
      cache.put('blacklist', raw, 300);
    }
    if (!raw) return false;
    return raw.split(',').map(function(s){ return s.replace(/[^0-9]/g, ''); }).indexOf(clean) >= 0;
  } catch (_e) { return false; }
}

// Spam-pattern detector. Blocks messages that contain a URL to anything
// other than a known payment/finance provider, plus obvious injection
// attempts (script tags, sheet-formula triggers). Returns true = spam.
var _SPAM_URL_RE_ = /(https?:\/\/|www\.)[^\s]+/i;
var _SPAM_ALLOWED_HOSTS_ = /\b(kesefle\.com|wa\.me|whatsapp\.com|paybox|bit\.ly\/kesefle|tranzila|cardcom|payme|grow|meshulam|isracard|max\.co\.il|cal-online)\b/i;
var _SPAM_INJECT_RE_ = /(<script|javascript:|onerror=|onload=|=\s*importxml|=\s*importdata|\beval\()/i;
function _looksSpammy_(text) {
  if (!text) return false;
  var t = String(text);
  if (_SPAM_INJECT_RE_.test(t)) return true;
  if (_SPAM_URL_RE_.test(t) && !_SPAM_ALLOWED_HOSTS_.test(t)) return true;
  return false;
}

// Append a suspicious-activity record to a dedicated KV abuse log via the
// Vercel bridge (so it's reviewable centrally, not buried in Apps Script
// Logger). Best-effort, never throws into the caller.
function _logAbuse_(fromPhone, reason, sample) {
  try {
    Logger.log('ABUSE ' + reason + ' from=' + String(fromPhone).replace(/\d(?=\d{4})/g, '*') + ' sample="' + String(sample || '').slice(0, 60) + '"');
    var secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '');
    if (!secret) return;
    UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/abuse-log', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({
        botSecret: secret,
        phone: String(fromPhone).replace(/[^0-9]/g, ''),
        reason: reason,
        sample: String(sample || '').slice(0, 120),
      }),
      muteHttpExceptions: true,
    });
  } catch (_e) {}
}

// ════════════════════════════════════════════════════════════════════════
// BOT-LOOP GUARDS (Steven 2026-05-25)
//
// Symptom: Steven connected another auto-responder ("Hermes Agent") to
// the same WhatsApp number our bot uses. Their bot replied to our
// "✅ recorded" message; our bot tried to process that reply as an
// expense; their bot replied to ours; ours replied again. Both bots
// burned through quota in seconds.
//
// Defense in depth — three independent guards stack in doPost:
//   1. _shouldMuteBotLoop_  : signature-based detection + per-phone
//                              counter; 3 bot-like messages in 2 min
//                              -> mute 30 min + alert owner
//   2. _checkReplyCap_      : per-phone outbound cap, 20 replies/60s
//   3. _killSwitchActive_   : Script-Property panic button for ops
//
// All three fail-open on error (we never want a guard bug to silence
// the bot for everyone), but log loudly.
// ════════════════════════════════════════════════════════════════════════

// Regexes that strongly indicate the inbound message was generated by
// another LLM agent / autoresponder, not by a human user. Tuned on the
// actual Hermes traffic Steven captured.
var _BOT_ECHO_REGEXES_ = [
  /```json/,                                // markdown json block
  /"action"\s*:\s*"(chat|reply|message)"/,  // generic agent JSON
  /^\s*\[(Silent|Loop|Interrupting|Auto-?reply|Vacation)/i,
  /Interrupting current task/i,
  /\bbot[- ]?loop\b/i,
  /I'?ll respond to your message/i,
  /this is an automated/i,
  /^הודעה אוטומטית/,                          // hebrew "automatic message"
  /^בוט:?\s/,                                // "bot: ..."
  /^\[bot\]/i,
];

function _looksLikeBotEcho_(text, interactive) {
  if (interactive) return false; // button taps from real WA users aren't bot echoes
  if (!text) return false;
  var t = String(text);
  for (var i = 0; i < _BOT_ECHO_REGEXES_.length; i++) {
    if (_BOT_ECHO_REGEXES_[i].test(t)) return true;
  }
  return false;
}

// Decide whether to mute this sender RIGHT NOW. Bumps a counter every
// time we see a bot-echo from them. Returns true (mute) once we cross
// the threshold or if they're already muted from a prior episode.
function _shouldMuteBotLoop_(fromPhone, text, interactive) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  var cache = CacheService.getScriptCache();
  // Already muted?
  if (cache.get('botloop:mute:' + clean)) return true;
  // Not a bot echo? Don't bump anything.
  if (!_looksLikeBotEcho_(text, interactive)) return false;
  // Bump counter (2-minute window).
  var key = 'botloop:cnt:' + clean;
  var cur = parseInt(cache.get(key) || '0', 10) || 0;
  cur += 1;
  cache.put(key, String(cur), 120);
  Logger.log('botloop: ' + clean + ' echo #' + cur);
  if (cur >= 3) {
    // Mute for 30 minutes + alert owner ONCE per episode.
    cache.put('botloop:mute:' + clean, '1', 1800);
    try { _logAbuse_(clean, 'bot_loop_detected', text); } catch (_) {}
    try {
      if (typeof _adminAlertOnce_ === 'function') {
        _adminAlertOnce_('🤖 חשד ללולאת בוטים: השתקתי את ' + clean + ' ל-30 דקות (זוהו ' + cur + ' הודעות אוטומטיות ברצף).', 'botloop:' + clean);
      }
    } catch (_) {}
    return true;
  }
  // Below threshold but still suspicious — drop THIS reply silently
  // (we don't reply to bot-shaped messages even before the threshold).
  return true;
}

// Hard per-phone reply cap. Counts every reply attempt in a 60-second
// window; rejects (returns false) once 20 are spent. Numbers reset
// automatically when the cache key expires.
function _checkReplyCap_(fromPhone) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return true;
  var cache = CacheService.getScriptCache();
  var key = 'replycap:' + clean;
  var cur = parseInt(cache.get(key) || '0', 10) || 0;
  cur += 1;
  cache.put(key, String(cur), 60);
  if (cur > 20) {
    try { _logAbuse_(clean, 'reply_cap_exceeded', 'count=' + cur + '/60s'); } catch (_) {}
    return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════
// KILL SWITCH (Steven 2026-05-25)
// Set Script Property KFL_DISABLE_BOT_WRITES=true to halt all message
// processing instantly. Useful when:
//   - WhatsApp quota is about to blow
//   - a runaway bug is corrupting sheets
//   - you need to deploy a fix and don't want writes mid-flight
// Set KFL_MAINTENANCE_MODE=true for the same effect (alias).
// ════════════════════════════════════════════════════════════════════════
function _killSwitchActive_() {
  try {
    var p = PropertiesService.getScriptProperties();
    var v1 = String(p.getProperty('KFL_DISABLE_BOT_WRITES') || '').toLowerCase();
    var v2 = String(p.getProperty('KFL_MAINTENANCE_MODE') || '').toLowerCase();
    return v1 === 'true' || v1 === '1' || v2 === 'true' || v2 === '1';
  } catch (_) { return false; }
}

// Reply once per hour per user during maintenance so they know we're alive.
function _maintenanceReply_(fromPhone) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'maint:notif:' + String(fromPhone || '').replace(/[^0-9]/g, '');
    if (cache.get(key)) return;
    cache.put(key, '1', 3600);
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(fromPhone, '🛑 כספ\'לה במצב תחזוקה קצר. נחזור לפעולה בעוד כמה דקות.');
    }
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════
// DELETE-LAST-ROW (Steven 2026-05-25)
//
// User says "מחק" / "תמחק" / "בטל" / "מחק אחרון" / "תמחק את האחרון" /
// "undo" / "cancel" -> bot deletes the most recent expense row from
// their OWN sheet (not Steven's). Routes:
//   - Owner phone -> local deleteLastTransaction() on SHEET_ID
//   - Tenant phone -> POST /api/sheet/delete-last (drive.file scoped)
//
// After a successful delete we also recompute the per-business
// dashboard cell if the deleted row was a עסק row -- so the running
// total drops back to match the actual transactions.
// ════════════════════════════════════════════════════════════════════════

// Strict regex: accept ONLY phrases that are unambiguously a delete
// request. We deliberately do NOT match "מחק" anywhere in a longer
// sentence -- that would catch real expense descriptions like
// "מחק לילד" (eraser for kid) and silently nuke a row.
var _DELETE_LAST_RE_ = /^(?:\s*\/?\s*)(?:תמחק|מחק|בטל|undo|cancel)(?:\s+(?:את\s+)?(?:ה?אחרון|הוצאה|זה|שורה|רשומה|last))?[\s.!?]*$/i;

function _handleDeleteRowCommand_(fromPhone, text) {
  if (!text) return { handled: false };
  var t = String(text).trim();
  if (!_DELETE_LAST_RE_.test(t)) return { handled: false };

  var isOwner = (typeof _isOwnerPhone_ === 'function') && _isOwnerPhone_(fromPhone);

  if (isOwner) {
    try {
      // Capture the row BEFORE deletion so we know whether to recompute
      // the business dashboard. deleteLastTransaction itself returns a
      // confirmation string but doesn't expose the deleted row, so we
      // peek at תנועות one row above the new lastRow afterwards isn't
      // useful; instead read the row first, then delete.
      var ss = SpreadsheetApp.openById(SHEET_ID);
      var sh = ss.getSheetByName(TRANSACTIONS_SHEET);
      if (!sh) return { handled: true, replyText: '😬 לא מצאתי לשונית תנועות.' };
      var lastRow = sh.getLastRow();
      if (lastRow < 2) return { handled: true, replyText: '🤔 אין מה למחוק — הלשונית ריקה.\nשלח הוצאה ראשונה למשל "85 סופר".' };
      var data = sh.getRange(lastRow, 1, 1, 7).getValues()[0];
      sh.deleteRow(lastRow);
      var amount = Number(data[2]) || 0;
      var cat = String(data[3] || '').trim();
      var sub = String(data[4] || '').trim();
      var desc = String(data[5] || '').trim();
      var month = String(data[1] || '').trim();
      // If this was a business row, refresh the matching dashboard cell
      // so the company total drops by the deleted amount.
      try {
        if (cat === 'עסק' && month) {
          if (typeof _updateBusinessDashboard_ === 'function') {
            _updateBusinessDashboard_('עסק', sub, month, amount);
          }
        }
      } catch (_dErr) { Logger.log('delete recompute err: ' + (_dErr && _dErr.message)); }
      return { handled: true, replyText:
        '🗑️ נמחק:\n' +
        '  סכום: ₪' + amount.toLocaleString('he-IL') + '\n' +
        '  קטגוריה: ' + (sub || cat || '—') + '\n' +
        '  פירוט: ' + (desc || '—')
      };
    } catch (e) {
      return { handled: true, replyText: '😬 משהו השתבש במחיקה: ' + (e && e.message || '') };
    }
  }

  // Tenant: call the Vercel bridge so the delete happens with THEIR
  // OAuth token against THEIR sheet -- never ours.
  try {
    var secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '');
    if (!secret) return { handled: true, replyText: '😬 התצורה לא הוגדרה לבוט. צור קשר עם התמיכה.' };
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/delete-last', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({ phone: String(fromPhone).replace(/[^0-9]/g, ''), botSecret: secret }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = {};
    try { body = JSON.parse(resp.getContentText() || '{}'); } catch (_) {}
    if (code === 200 && body && body.ok && body.deleted) {
      var d = body.deleted;
      return { handled: true, replyText:
        '🗑️ נמחק מהגיליון שלך:\n' +
        '  סכום: ₪' + (Number(d.amount) || 0).toLocaleString('he-IL') + '\n' +
        '  קטגוריה: ' + (d.subcategory || d.category || '—') + '\n' +
        '  פירוט: ' + (d.description || '—')
      };
    }
    if (code === 404 && body && body.error === 'empty_sheet') {
      return { handled: true, replyText: '🤔 אין מה למחוק — הגיליון ריק.' };
    }
    if (code === 404 && body && body.error === 'no_user_for_phone') {
      return { handled: true, replyText: '🤔 לא מצאתי גיליון מקושר למספר שלך. שלח "התחבר" כדי לקשר.' };
    }
    Logger.log('_handleDeleteRowCommand_ tenant fail code=' + code + ' body=' + JSON.stringify(body).slice(0, 200));
    return { handled: true, replyText: '😬 משהו השתבש במחיקה. נסה שוב בעוד דקה.' };
  } catch (e) {
    Logger.log('_handleDeleteRowCommand_ exception: ' + (e && e.message));
    return { handled: true, replyText: '😬 שגיאת רשת. נסה שוב.' };
  }
}

function _isRateLimited_(fromPhone) {
  if (!fromPhone) return false;
  var WINDOW_SECONDS = 60;
  var MAX_MSGS_PER_WINDOW = 30;
  try {
    var cache = CacheService.getScriptCache();
    var key = 'rateLimit:' + fromPhone;
    var raw = cache.get(key);
    var now = Date.now();
    var state;
    if (raw) {
      try { state = JSON.parse(raw); } catch (_) { state = null; }
    }
    if (!state || !state.windowStart || (now - state.windowStart) >= WINDOW_SECONDS * 1000) {
      state = { count: 1, windowStart: now };
    } else {
      state.count = (state.count || 0) + 1;
    }
    cache.put(key, JSON.stringify(state), WINDOW_SECONDS);
    if (state.count > MAX_MSGS_PER_WINDOW) {
      Logger.log('Rate limit: phone=' + fromPhone + ' count=' + state.count
        + ' in ' + WINDOW_SECONDS + 's — dropping');
      return true;
    }
    return false;
  } catch (e) {
    Logger.log('_isRateLimited_ err: ' + (e && e.message || e));
    return false; // fail open
  }
}

// ============================================================
// [HARDENING_WRAPPER + SRC_ROUTER + BOT_COMMANDS] — unified doPost (2026-05-17 v3)
// FAST PATH: messages starting with a digit bypass routers and go straight to
// processExpense. Prevents SRC_ROUTER_handle / handleBotCommand_ from silently
// eating expense messages like "54 סופר".
// ============================================================
function doPost(e) {
  // SCALABILITY: the script lock exists only to serialize concurrent
  // writes to the OWNER's single shared sheet. Tenants write to their
  // OWN sheets via the Vercel bridge and never contend. The old code
  // did waitLock(15000) and returned "busy" on failure — under load,
  // the 2nd simultaneous message waited 15s then got DROPPED (Meta
  // returns 200 late, never retries). That collapses at scale.
  //
  // New behaviour: try for 5s, but if the lock is contended, process
  // ANYWAY rather than drop. The residual risk is a rare owner-sheet
  // row race (one person sending two messages within ~200ms) — far
  // cheaper than losing a user's expense. _gotLock gates the release.
  var _lock = LockService.getScriptLock();
  var _gotLock = false;
  try {
    _gotLock = _lock.tryLock(5000);
    if (!_gotLock) Logger.log('doPost: lock contended after 5s — processing without it');
  } catch (_lockErr) {
    Logger.log('doPost: lock error — processing without it: ' + (_lockErr && _lockErr.message));
    _gotLock = false;
  }

  try {
    Logger.log('doPost: ENTRY');
    var __raw_ = e && e.postData && e.postData.contents;

    // 🔐 Authenticity gate — verify HMAC (if header is available) + WABA id.
    // Returns 200 OK on rejection so Meta does not retry the forged delivery.
    var __verify_ = _verifyMetaWebhook_(e, __raw_);
    if (!__verify_.valid) {
      Logger.log('doPost: webhook rejected — ' + __verify_.reason);
      return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
    }

    var __parsed_ = __raw_ ? JSON.parse(__raw_) : null;
    // Reply from the SAME number the user messaged: capture the inbound
    // phone_number_id so sendWhatsAppMessage uses it instead of the (possibly
    // stale) configured default. This is what makes the test number work even
    // if WHATSAPP_PHONE_NUMBER_ID/Script-Property still points at the old number.
    try {
      var __meta_ = __parsed_ && __parsed_.entry && __parsed_.entry[0]
                 && __parsed_.entry[0].changes && __parsed_.entry[0].changes[0]
                 && __parsed_.entry[0].changes[0].value
                 && __parsed_.entry[0].changes[0].value.metadata;
      _ACTIVE_PHONE_NUMBER_ID_ = (__meta_ && __meta_.phone_number_id) ? String(__meta_.phone_number_id) : '';
    } catch (_pnidErr) { _ACTIVE_PHONE_NUMBER_ID_ = ''; }
    var __msg_ = __parsed_ && __parsed_.entry && __parsed_.entry[0]
              && __parsed_.entry[0].changes && __parsed_.entry[0].changes[0]
              && __parsed_.entry[0].changes[0].value
              && __parsed_.entry[0].changes[0].value.messages
              && __parsed_.entry[0].changes[0].value.messages[0];

    if (__msg_ && __msg_.from) {
      var __from_ = __msg_.from;
      var __text_ = (__msg_.text && __msg_.text.body) || "";
      var __interactive_ = __msg_.interactive || null;
      var __msgId_ = __msg_.id || '';
      Logger.log('doPost: from=' + __from_ + ' text="' + __text_ + '" interactive=' + (__interactive_ ? __interactive_.type : 'no'));

      // 🔁 IDEMPOTENCY — Meta retries webhook delivery when our response is
      // slow (>~20s) or on transient errors, sending the SAME message id
      // again. Without this guard the bot writes the expense twice. We
      // mark each wamid in CacheService for 10 min; a repeat is dropped.
      if (__msgId_) {
        try {
          var __dupCache = CacheService.getScriptCache();
          var __seenKey = 'seenmsg:' + __msgId_;
          if (__dupCache.get(__seenKey)) {
            Logger.log('doPost: duplicate message ' + __msgId_ + ' — ignoring (idempotency)');
            return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
          }
          __dupCache.put(__seenKey, '1', 600);
        } catch (_dupErr) { /* cache outage is non-fatal — process anyway */ }
      }

      // 🚫 Abuse blacklist — silently ignore flagged numbers.
      try {
        if (typeof _isBlacklisted_ === 'function' && _isBlacklisted_(__from_)) {
          Logger.log('doPost: blacklisted ' + __from_ + ' — ignoring');
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      } catch (_blErr) {}

      // 🤖 BOT-LOOP GUARD (Steven 2026-05-25): if another auto-responder
      // on the user's side replies to our messages, we used to reply
      // back, triggering an infinite loop that burns WhatsApp quota.
      // Detect "looks like a bot reply" + count per-sender; after 3 such
      // messages in 2 minutes, silently mute that number for 30 minutes
      // and alert the owner. See _looksLikeBotEcho_ for the heuristics.
      try {
        if (typeof _shouldMuteBotLoop_ === 'function' && _shouldMuteBotLoop_(__from_, __text_, __interactive_)) {
          Logger.log('doPost: bot-loop mute triggered for ' + __from_);
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      } catch (_blpErr) { Logger.log('bot-loop guard err: ' + (_blpErr && _blpErr.message)); }

      // 🚦 OUTBOUND REPLY CAP — never reply to the same number more than
      // 20 times in 60s. Hard cap defending against any runaway pattern
      // (corrupt webhook replay, OS-level retry, our own bug).
      try {
        if (typeof _checkReplyCap_ === 'function' && !_checkReplyCap_(__from_)) {
          Logger.log('doPost: reply cap exceeded for ' + __from_ + ' — silent drop');
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      } catch (_rcErr) { Logger.log('reply cap err: ' + (_rcErr && _rcErr.message)); }

      // 🛑 GLOBAL KILL SWITCH — Script Property KFL_DISABLE_BOT_WRITES=true
      // makes the bot stop processing messages (single-flip incident
      // response). Replies with a maintenance message once per user per
      // hour so users aren't left in the dark, but performs zero writes.
      try {
        if (typeof _killSwitchActive_ === 'function' && _killSwitchActive_()) {
          _maintenanceReply_(__from_);
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      } catch (_ksErr) {}

      // 🛑 Spam-pattern detection — block messages with non-payment URLs
      // or obvious injection attempts. Logs to the abuse log for review.
      try {
        if (__text_ && typeof _looksSpammy_ === 'function' && _looksSpammy_(__text_)) {
          _logAbuse_(__from_, 'spam_pattern', __text_);
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      } catch (_spErr) {}

      // 🚦 Per-phone rate limit — silent drop on abuse (30 msgs / 60s).
      // Applied before ALLOWED_PHONES so even allow-listed phones can't spam.
      if (_isRateLimited_(__from_)) {
        // Send the friendly throttle notice exactly once per window.
        try {
          var __rlCache = CacheService.getScriptCache();
          var __rlKey = 'rlnotice:' + String(__from_).replace(/[^0-9]/g, '');
          if (!__rlCache.get(__rlKey)) {
            __rlCache.put(__rlKey, '1', 60);
            if (typeof sendWhatsAppMessage === 'function') {
              sendWhatsAppMessage(__from_, '⏳ יותר מדי הודעות, נסה שוב בעוד דקה.');
            }
          }
        } catch (_rlErr) {}
        return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
      }

      // 🕒 Mark the user as active so cronDailyMotivation can skip if they
      // already chatted in the last 2 hours (don't be annoying).
      try { PropertiesService.getScriptProperties().setProperty('lastUserMessageAt', new Date().toISOString()); } catch (_lumErr) {}

      // 🆕 NEW-LEAD ALERT — the first time ANY phone messages the bot,
      // notify the owner once (email + WhatsApp to the alert number) with
      // the customer's phone. Deduped permanently per phone via a Script
      // Property so it fires once per customer, not per message. Placed
      // after the spam/rate-limit guards so junk doesn't trigger alerts.
      try { _notifyOwnerNewLead_(__from_); } catch (_nlErr) { Logger.log('new-lead alert err: ' + (_nlErr && _nlErr.message)); }

      // 👋 One-time welcome — sent BEFORE processing so a brand-new user
      // sees the intro + how-to + sheet link first, then their first
      // expense confirmation. Deduped per phone.
      var __welcomedNow = false;
      try { __welcomedNow = _maybeSendWelcome_(__from_); } catch (_wErr) { Logger.log('welcome err: ' + (_wErr && _wErr.message)); }
      // If this is the user's first-ever message and it isn't itself an expense
      // (e.g. "שלום"), the welcome + questionnaire we just sent ARE the response.
      // Don't also run it through the expense parser and reply "couldn't identify
      // amount". A first message that DOES contain an amount falls through and is
      // logged normally.
      if (__welcomedNow && !__interactive_) {
        var __looksExpense = false;
        try {
          var __wp = (typeof parseAmountAndDescription === 'function') ? parseAmountAndDescription(__text_) : null;
          __looksExpense = !!(__wp && __wp.items && __wp.items.length);
        } catch (_we) {}
        if (!__looksExpense) {
          Logger.log('doPost: first-message greeting — welcome+survey sent, skipping expense parse');
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      }

      if (typeof ALLOWED_PHONES !== 'undefined' && ALLOWED_PHONES.length > 0) {
        var __clean_ = String(__from_).replace(/[^0-9]/g, '');
        if (ALLOWED_PHONES.indexOf(__clean_) < 0) {
          Logger.log('doPost: phone not in ALLOWED_PHONES, returning OK');
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      }

      // === INTERACTIVE MESSAGE REPLY — user tapped a category from our list ===
      if (__interactive_) {
        try {
          var __reply = handleInteractiveReply_(__from_, __interactive_);
          if (__reply && __reply.replyText) {
            sendWhatsAppMessage(__from_, __reply.replyText);
          }
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        } catch (__intErr) {
          Logger.log('doPost: interactive error: ' + (__intErr && __intErr.stack || __intErr));
        }
      }

      // === RECEIPT OCR — user sent a photo instead of text ===
      // Must run BEFORE text dispatchers because image messages have no __text_
      // but we still want to acknowledge them on the same locked execution.
      if (__msg_.image && __msg_.image.id) {
        try {
          var ocrRes = _handleReceiptImage_(__from_, __msg_.image);
          if (ocrRes && ocrRes.replyText && typeof sendWhatsAppMessage === "function") {
            sendWhatsAppMessage(__from_, ocrRes.replyText);
          }
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        } catch (_ocrErr) {
          Logger.log('doPost: receipt OCR error: ' + (_ocrErr && _ocrErr.stack || _ocrErr));
          try { sendWhatsAppMessage(__from_, '😬 הייתה בעיה בקריאת הקבלה\n💡 נסה לשלוח שוב או רשום ידנית'); } catch (__) {}
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      }

      // === VOICE MESSAGE — Meta sends `audio` (OGG/Opus) for voice notes.
      // Whisper transcribes Hebrew well; transcribed text is then run through
      // the existing processExpense flow so corrections via "קטגוריה X" keep
      // working on the resulting sheet row.
      if (__msg_.audio && __msg_.audio.id) {
        try {
          var voiceRes = _handleVoiceMessage_(__from_, __msg_.audio);
          if (voiceRes && voiceRes.replyText && typeof sendWhatsAppMessage === "function") {
            sendWhatsAppMessage(__from_, voiceRes.replyText);
          }
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        } catch (_voiceErr) {
          Logger.log('doPost: voice error: ' + (_voiceErr && _voiceErr.stack || _voiceErr));
          try { sendWhatsAppMessage(__from_, '😬 בעיה בקריאת הקול\n💡 נסה לרשום בכתב במקום'); } catch (__) {}
          return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
        }
      }

      if (__text_) {
        // === PERSONALIZATION QUESTIONNAIRE ("survey") ===
        // Must run FIRST: the freeform recurring step captures digit-leading
        // text (e.g. an amount + description list) that would otherwise hit
        // the expense fast-path below. Also handles the survey / advanced-
        // settings / confirm commands. handled=false -> normal routing.
        if (typeof _surveyHandleText_ === "function") {
          try {
            var __survRes = _surveyHandleText_(__from_, __text_);
            if (__survRes && __survRes.handled) {
              if (__survRes.replyText && typeof sendWhatsAppMessage === "function") {
                sendWhatsAppMessage(__from_, __survRes.replyText);
              }
              Logger.log('doPost: survey text handled');
              return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
            }
          } catch (_survErr) {
            Logger.log('doPost: survey text error: ' + (_survErr && _survErr.stack || _survErr));
          }
        }

        // === PENDING CATEGORY RESPONSE ===
        // Steven 2026-05-25: when the bot asked "which category?" via
        // _askBeforeDefaulting_ and the user replied with text instead of
        // tapping, route here. Matches numeric picks (1-17), exact group
        // names, "צור קטגוריה X", or any name while pendingCreate mode is
        // on. handled=false -> let normal routing continue.
        if (typeof _handlePendingCategoryText_ === "function") {
          try {
            var __pcRes = _handlePendingCategoryText_(__from_, __text_);
            if (__pcRes && __pcRes.handled) {
              if (__pcRes.replyText && typeof sendWhatsAppMessage === "function") {
                sendWhatsAppMessage(__from_, __pcRes.replyText);
              }
              Logger.log('doPost: pending-category text handled');
              return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
            }
          } catch (_pcErr) {
            Logger.log('doPost: pending-category text error: ' + (_pcErr && _pcErr.stack || _pcErr));
          }
        }

        // === CONTEXT-BASED ROUTING for explicit prefix or KV context ===
        // The user can flip a persistent "context" between personal/family via
        // "מצב משפחתי" / "מצב אישי" (handled in _handleFamilyMultiCommand_).
        // Per-message override is supported via the leading "אישי " / "משפחה "
        // prefix, or the EN equivalents. When the resolved sheet is family,
        // we hand off to _familyWriteExpense_ instead of _doPost_orig.
        try {
          if (typeof _routeExpenseByContext_ === "function") {
            var __routed = _routeExpenseByContext_(__from_, __text_);
            if (__routed && __routed.handled) {
              if (__routed.replyText && typeof sendWhatsAppMessage === "function") {
                sendWhatsAppMessage(__from_, __routed.replyText);
              }
              Logger.log('doPost: family-context routed handled=true');
              return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
            }
          }
        } catch (_ctxErr) {
          Logger.log('doPost: context-routing error: ' + (_ctxErr && _ctxErr.stack || _ctxErr));
        }

        // === DELETE LAST ROW (Steven 2026-05-25) ===
        // Owner OR tenant -- whoever says "מחק" / "תמחק" / "בטל" gets
        // their last row deleted from their OWN sheet. Tenant path
        // goes through /api/sheet/delete-last via the bot bridge.
        try {
          if (typeof _handleDeleteRowCommand_ === "function") {
            var __delRes = _handleDeleteRowCommand_(__from_, __text_);
            if (__delRes && __delRes.handled) {
              if (__delRes.replyText && typeof sendWhatsAppMessage === "function") {
                sendWhatsAppMessage(__from_, __delRes.replyText);
              }
              Logger.log('doPost: delete-row routed');
              return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
            }
          }
        } catch (_delErr) { Logger.log('doPost: delete-row err: ' + (_delErr && _delErr.message)); }

        // === MULTI-BUSINESS routing (Steven 2026-05-25) ===
        // "עסק 2 320 שיווק" -> writes to a SECOND business sheet (auto-
        // created from the main sheet on first use). "עסק 1 ..." routes
        // to the main bot SHEET_ID, same as today. Owner-only for now;
        // tenants still flow through the standard /api/sheet/append path.
        if (typeof _isOwnerPhone_ === 'function' && _isOwnerPhone_(__from_)) {
          // "עסקים שלי" lists provisioned biz sheets.
          if (typeof _handleMyBusinessesCommand_ === "function") {
            try {
              var __mbRes = _handleMyBusinessesCommand_(__from_, __text_);
              if (__mbRes && __mbRes.handled) {
                if (__mbRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __mbRes.replyText);
                }
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_mbErr) { Logger.log('doPost: my-biz cmd err: ' + (_mbErr && _mbErr.message)); }
          }
          // "עסק N <amount> <description>" -> per-business sheet.
          if (typeof _parseBusinessNumberPrefix_ === "function") {
            try {
              var __bizPref = _parseBusinessNumberPrefix_(__text_);
              if (__bizPref) {
                var __bizRes = _writeBusinessNExpense_(__from_, __bizPref.n, __bizPref.name || null, __bizPref.rest);
                if (__bizRes && __bizRes.handled) {
                  if (__bizRes.replyText && typeof sendWhatsAppMessage === "function") {
                    sendWhatsAppMessage(__from_, __bizRes.replyText);
                  }
                  Logger.log('doPost: multi-biz routed N=' + __bizPref.n);
                  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
                }
              }
            } catch (_bizErr) {
              Logger.log('doPost: multi-biz error: ' + (_bizErr && _bizErr.stack || _bizErr));
            }
          }
        }

        // FAST PATH: any message starting with a digit goes straight to
        // _doPost_orig → processExpense. Skip all routers to avoid silent drops.
        var __looksLikeExpense = /^\s*\d/.test(__text_);
        Logger.log('doPost: looksLikeExpense=' + __looksLikeExpense);

        if (!__looksLikeExpense) {
          if (typeof _handleTimezoneCommand_ === "function") {
            try {
              var __tzRes = _handleTimezoneCommand_(__from_, __text_);
              if (__tzRes && __tzRes.handled) {
                if (typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __tzRes.replyText);
                }
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_tzErr) {
              Logger.log('doPost: timezone command error: ' + (_tzErr && _tzErr.stack || _tzErr));
            }
          }

          // Subscription auto-detector commands (checked first so router does
          // not need to know about them). See _handleSubscriptionCommand_ below.
          if (typeof _handleSubscriptionCommand_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __subRes = _handleSubscriptionCommand_(__from_, __text_);
              if (__subRes && __subRes.handled) {
                if (typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __subRes.replyText);
                }
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_subErr) {
              Logger.log('doPost: subscription command error: ' + (_subErr && _subErr.stack || _subErr));
            }
          }

          // Budget commands: תקציבים / budgets list + "יעד תקציב X = Y" override.
          // See _handleBudgetCommand_ below.
          if (typeof _handleBudgetCommand_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __bgtRes = _handleBudgetCommand_(__from_, __text_);
              if (__bgtRes && __bgtRes.handled) {
                if (__bgtRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __bgtRes.replyText);
                }
                Logger.log('doPost: budget command handled');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_bgtErr) {
              Logger.log('doPost: budget command error: ' + (_bgtErr && _bgtErr.stack || _bgtErr));
            }
          }

          // Learning dashboard: לימוד, למד: ..., מחק לימוד N, איפוס לימוד.
          // Must be BEFORE category correction so its own כן/לא reset
          // confirmation isn't swallowed by the correction handler.
          if (typeof _handleLearningCommand_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __lrnRes = _handleLearningCommand_(__from_, __text_);
              if (__lrnRes && __lrnRes.handled) {
                if (__lrnRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __lrnRes.replyText);
                }
                Logger.log('doPost: learning command handled');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_lrnErr) {
              Logger.log('doPost: learning command error: ' + (_lrnErr && _lrnErr.stack || _lrnErr));
            }
          }

          // Category correction flow — "קטגוריה X" then "כן/לא". Must be
          // checked early so כן/לא tokens don't get caught by other routers.
          if (typeof _handleCategoryCorrection_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __corRes = _handleCategoryCorrection_(__from_, __text_);
              if (__corRes && __corRes.handled) {
                if (__corRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __corRes.replyText);
                }
                Logger.log('doPost: category-correction handled');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_corErr) {
              Logger.log('doPost: category-correction error: ' + (_corErr && _corErr.stack || _corErr));
            }
          }

          // Family / household commands: הקמת משפחה, הצטרפות למשפחה,
          // אישור/דחייה, משפחה {amount}, דו"ח משפחתי, מצב משפחתי/אישי.
          // Real KV-backed logic lives in _handleFamilyMultiCommand_ below.
          if (typeof _handleFamilyMultiCommand_ === "function") {
            try {
              var __famM = _handleFamilyMultiCommand_(__from_, __text_);
              if (__famM && __famM.handled) {
                if (__famM.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __famM.replyText);
                }
                Logger.log('doPost: family-multi command handled=true');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_famMErr) {
              Logger.log('doPost: family-multi command error: ' + (_famMErr && _famMErr.stack || _famMErr));
            }
          }

          // Family / household commands: הזמן, משפחה, פרישה (and EN aliases).
          // STUB: real KV logic lives in the Vercel layer — see docs/family-sharing.md.
          if (typeof _handleFamilyCommand_ === "function") {
            try {
              var __fam = _handleFamilyCommand_(__from_, __text_);
              if (__fam && __fam.handled) {
                if (typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __fam.replyText);
                }
                Logger.log('doPost: family command handled=true');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_famErr) {
              Logger.log('doPost: family command error: ' + (_famErr && _famErr.stack || _famErr));
            }
          }

          if (typeof handleBotCommand_ === "function" && _isOwnerPhone_(__from_)) {
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

          if (typeof SRC_ROUTER_handle === "function" && _isOwnerPhone_(__from_)) {
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

// ============================================================
// 🎯 Interactive reply handler — fires when user taps a category from our list.
// ============================================================
// Meta sends an `interactive` payload of type "list_reply" or "button_reply".
// We decode the option id (cat|<category>|<sub>|<amount>|<textKey>), look up
// the pending state, write the row to the sheet, save the category to the
// learning cache, and reply with confirmation.
function handleInteractiveReply_(fromPhone, interactive) {
  if (!fromPhone || !interactive) return null;

  var picked = null;
  if (interactive.type === 'list_reply' && interactive.list_reply) {
    picked = interactive.list_reply.id;
  } else if (interactive.type === 'button_reply' && interactive.button_reply) {
    picked = interactive.button_reply.id;
  }
  if (!picked) {
    Logger.log('handleInteractiveReply_: no id in interactive payload');
    return null;
  }

  // Family approval/denial taps from _familyJoinRequest_.
  var famAp = String(picked).match(/^fam_approve_(\d+)$/);
  if (famAp && typeof _familyApprove_ === 'function') {
    var r = _familyApprove_(fromPhone, famAp[1]);
    return { replyText: (r && r.replyText) || '✅' };
  }
  var famDn = String(picked).match(/^fam_deny_(\d+)$/);
  if (famDn && typeof _familyDeny_ === 'function') {
    var r2 = _familyDeny_(fromPhone, famDn[1]);
    return { replyText: (r2 && r2.replyText) || '✅' };
  }

  // Personalization questionnaire taps (q1_*/q2_*/q3_*/q_pets_*/q_car_*).
  // The handler sends any follow-up question itself; it returns { replyText }
  // only when a TEXT reply is the next step (Q2 "yes" -> ask for recurring
  // items), else null.
  if ((/^q[123]_/.test(String(picked)) || /^q_(pets|car)_/.test(String(picked))) &&
      typeof _surveyHandleInteractive_ === 'function') {
    return _surveyHandleInteractive_(fromPhone, picked);
  }

  // Change-category picker shown under every tenant expense confirmation
  // (Steven 2026-05-24). Format: "relabel|<newCategory>".
  var __relMatch = String(picked).match(/^relabel\|(.+)$/);
  if (__relMatch && typeof _handleRelabelTap_ === 'function') {
    return _handleRelabelTap_(fromPhone, __relMatch[1]);
  }

  // Ask-before-default picker (Steven 2026-05-25) — when classifier was
  // uncertain we sent a category list INSTEAD of writing to שונות.
  // Format: "pending|<category>".
  var __pendMatch = String(picked).match(/^pending\|(.+)$/);
  if (__pendMatch && typeof _handlePendingTenantPick_ === 'function') {
    return _handlePendingTenantPick_(fromPhone, __pendMatch[1]);
  }

  // Installments first-charge day picker (Steven 2026-05-25). Format:
  // "installday|<1|2|10|15|today>".
  var __instDayMatch = String(picked).match(/^installday\|(.+)$/);
  if (__instDayMatch && typeof _handleInstallmentsDayPick_ === 'function') {
    return _handleInstallmentsDayPick_(fromPhone, __instDayMatch[1]);
  }

  var decoded = _decodeCategoryOptionId(picked);
  if (!decoded) {
    Logger.log('handleInteractiveReply_: could not decode id="' + picked + '"');
    return { replyText: '😬 לא הצלחתי להבין את הבחירה\n💡 שלח שוב את ההוצאה ובחר קטגוריה' };
  }

  // Look up pending state — should match the most recent ambiguous message from this phone.
  var pendingKey = 'pending:' + fromPhone;
  var pendingRaw = PropertiesService.getScriptProperties().getProperty(pendingKey);
  var pending = null;
  if (pendingRaw) {
    try { pending = JSON.parse(pendingRaw); } catch (e) {}
  }

  // Prefer the pending record (full text) over the encoded textKey.
  var amount = (pending && pending.amount) || decoded.amount || 0;
  var description = (pending && pending.description) || decoded.textKey.replace(/_/g, ' ');

  if (!amount || amount <= 0) {
    return { replyText: '😬 פג תוקף הבחירה (5 דק׳ עברו)\n💡 שלח שוב את ההוצאה כדי לקטלג' };
  }

  // SECURITY: only the owner writes to the hardcoded SHEET_ID. A non-owner
  // who disambiguated a category must have their row written to THEIR OWN
  // sheet via the tenant bridge — never this one. (This handler previously
  // appended every sender's pick straight into the owner's sheet, and also
  // polluted the owner's learning/audit tabs with foreign data.)
  if (!_isOwnerPhone_(fromPhone)) {
    var __tt = _resolveTenant_(fromPhone);
    try { PropertiesService.getScriptProperties().deleteProperty(pendingKey); } catch (_dp) {}
    if (__tt && !__tt.isOwner && __tt.userRecord) {
      var __ar = _tenantAppendStructured_(fromPhone, {
        amount: amount,
        category: decoded.category,
        subcategory: decoded.subcategory,
        rawText: (pending && pending.rawText) || description,
        isIncome: false,
      });
      if (__ar.ok) {
        return { replyText: '✅ נרשם בגיליון שלך!\n💰 ₪' + amount + '\n📁 ' + decoded.category + (decoded.subcategory ? ' / ' + decoded.subcategory : '') + '\n📝 ' + description + _celebrateIfFirstExpense_(fromPhone) };
      }
      Logger.log('handleInteractiveReply_ tenant append failed: ' + __ar.code + ' ' + String(__ar.body).slice(0, 200));
      return { replyText: '😬 לא הצלחתי לשמור עכשיו. שלח שוב את ההוצאה בעוד רגע.' };
    }
    // Neither owner nor a linked tenant — onboard, do NOT write anywhere.
    return { replyText:
      'היי! 👋 אני עוד לא מזהה את המספר הזה.\n' +
      'התחבר ב-https://kesefle.com/account וקשר את המספר — לוקח 30 שניות.' };
  }
  // Owner-only beyond this point. Final guard before the SHEET_ID write.
  if (!_assertOwnerLegacyWrite_(fromPhone, 'interactive')) {
    return { replyText: '😬 משהו לא תקין בזיהוי המספר. נסה שוב.' };
  }

  // Write the row to the sheet with the chosen category
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return { replyText: '😬 לא נמצאה לשונית "תנועות"\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט' };
    var now = new Date();
    var monthKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM');
    var category = decoded.category;
    var subcategory = decoded.subcategory;
    sheet.appendRow([now, monthKey, amount, sanitizeForSheet(category), sanitizeForSheet(subcategory), sanitizeForSheet(description), 'WhatsApp (interactive)', true]);
    // Original-text cell note — capture the raw user message that triggered
    // this categorization (preserves provenance even after corrections).
    try {
      var __interactiveRow = sheet.getLastRow();
      var __interactiveRaw = (pending && pending.rawText) || description;
      _kfl_setRowOriginalNote(sheet, __interactiveRow, _kfl_buildOriginalNote('Original WhatsApp (interactive)', __interactiveRaw, ['Picked: ' + category + ' / ' + subcategory]));
    } catch (_noteErr) { Logger.log('interactive note err: ' + (_noteErr && _noteErr.message)); }
    // Keep chronological sort
    try {
      var lastRow = sheet.getLastRow();
      if (lastRow > 2) sheet.getRange(2, 1, lastRow - 1, 8).sort({ column: 1, ascending: true });
    } catch (_sortErr) {}

    try { _updateBusinessDashboard_(category, subcategory, monthKey, amount); }
    catch (_dashErr) { Logger.log('handleInteractiveReply_: dashboard err: ' + (_dashErr && _dashErr.message)); }
    // Mirror the chosen-category expense into the dashboard cell note too.
    try { _dashboardDetailNote_(category, subcategory, monthKey, amount, description, now); }
    catch (_dnErr) { Logger.log('handleInteractiveReply_: dashboard note err: ' + (_dnErr && _dnErr.message)); }

    // Save to the learning cache so next time we don't ask
    try { _learnedSave(description, { category: category, subcategory: subcategory }, 'user'); }
    catch (_lsErr) { Logger.log('handleInteractiveReply_: learnedSave failed: ' + _lsErr); }

    // TASK 1 + 4: audit log + anti-degradation guard.
    var __needsReview = false;
    try {
      var __priorCorrections = _countCorrectionsForText_(description);
      if (__priorCorrections >= 2) __needsReview = true;
      _logMLAudit_({
        user_text: description,
        amount: amount,
        final_category: category,
        final_subcategory: subcategory,
        via: 'ambiguity_picked',
        user_correction: category + ' / ' + subcategory,
        needs_review: __needsReview,
        from_phone: fromPhone
      });
      if (__needsReview) {
        _adminAlertOnce_('🚨 צריך בדיקה ידנית — "' + description + '" תוקן ' + (__priorCorrections + 1) + ' פעמים.', fromPhone);
      }
    } catch (_auditErr) { Logger.log('handleInteractiveReply_ audit: ' + _auditErr.message); }

    // Clear pending
    try { PropertiesService.getScriptProperties().deleteProperty(pendingKey); } catch (_dpErr) {}

    return {
      replyText: '✅ נרשם!\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '💰 סכום: ₪' + amount + '\n' +
        '📁 קטגוריה: ' + category + ' / ' + subcategory + '\n' +
        '📝 פירוט: ' + description + '\n\n' +
        '💡 בפעם הבאה שתשלח "' + description + '" — אזכור את הקטגוריה הזו אוטומטית.' +
        _celebrateIfFirstExpense_(fromPhone)
    };
  } catch (e) {
    Logger.log('handleInteractiveReply_: write error: ' + (e && e.stack || e));
    return { replyText: '😬 משהו השתבש בכתיבה לגיליון: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
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
      var result = null;
      try {
        result = processExpense(text, from);
      } catch (_peErr) {
        Logger.log('_doPost_orig: processExpense THREW ' + (_peErr && _peErr.stack || _peErr));
        try { if (typeof _logBotError_ === 'function') _logBotError_('processExpense', _peErr); } catch (__) {}
        result = { reply: '😬 משהו השתבש בעיבוד: ' + (_peErr && _peErr.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
      }
      Logger.log('_doPost_orig: processExpense returned reply="' + (result && result.reply ? String(result.reply).slice(0, 100) : '(none)') + '" ambiguousSent=' + (result && result.ambiguousSent));
      // If the bot already sent an interactive list (ambiguous case), the user
      // will respond via interactive — no text reply needed here.
      if (result && result.ambiguousSent) {
        Logger.log('_doPost_orig: ambiguous list sent inline, skipping text reply');
      } else {
        var replyText = (result && result.reply) ? result.reply : '✓ נרשם.';
        // Smart group-expense detection: if the user is in an active
        // group and the message looks like a split candidate (large
        // amount vs their history, OR contains share-keywords), tack
        // an upsell line onto the reply.
        try {
          var suggestion = _maybeSuggestGroupSplit_(from, text);
          if (suggestion) replyText += '\n\n' + suggestion;
        } catch (_sgErr) { Logger.log('group suggestion err: ' + (_sgErr && _sgErr.message)); }
        try {
          var sendRes = sendWhatsAppMessage(from, replyText);
          if (sendRes && sendRes.ok === false) {
            Logger.log('_doPost_orig: sendWhatsAppMessage NOT OK: ' + JSON.stringify(sendRes));
          } else {
            Logger.log('_doPost_orig: sendWhatsAppMessage done');
          }
        } catch (_sendErr) {
          Logger.log('_doPost_orig: sendWhatsAppMessage THREW ' + (_sendErr && _sendErr.stack || _sendErr));
        }
      }
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
// 🌍 אזור זמן לפי משתמש
// ============================================================

var DEFAULT_TZ = 'Asia/Jerusalem';

var COUNTRY_TZ_MAP = {
  '972': 'Asia/Jerusalem',
  '1':   'America/New_York',
  '44':  'Europe/London',
  '33':  'Europe/Paris',
  '49':  'Europe/Berlin',
  '39':  'Europe/Rome',
  '34':  'Europe/Madrid',
  '31':  'Europe/Amsterdam',
  '32':  'Europe/Brussels',
  '41':  'Europe/Zurich',
  '43':  'Europe/Vienna',
  '46':  'Europe/Stockholm',
  '47':  'Europe/Oslo',
  '45':  'Europe/Copenhagen',
  '358': 'Europe/Helsinki',
  '353': 'Europe/Dublin',
  '351': 'Europe/Lisbon',
  '30':  'Europe/Athens',
  '7':   'Europe/Moscow',
  '380': 'Europe/Kiev',
  '48':  'Europe/Warsaw',
  '420': 'Europe/Prague',
  '36':  'Europe/Budapest',
  '40':  'Europe/Bucharest',
  '90':  'Europe/Istanbul',
  '61':  'Australia/Sydney',
  '64':  'Pacific/Auckland',
  '81':  'Asia/Tokyo',
  '82':  'Asia/Seoul',
  '86':  'Asia/Shanghai',
  '852': 'Asia/Hong_Kong',
  '65':  'Asia/Singapore',
  '91':  'Asia/Kolkata',
  '971': 'Asia/Dubai',
  '966': 'Asia/Riyadh',
  '20':  'Africa/Cairo',
  '27':  'Africa/Johannesburg',
  '55':  'America/Sao_Paulo',
  '54':  'America/Argentina/Buenos_Aires',
  '52':  'America/Mexico_City',
  '56':  'America/Santiago',
  '57':  'America/Bogota'
};

function _tzFromPhone_(phone) {
  if (!phone) return DEFAULT_TZ;
  var clean = String(phone).replace(/[^0-9]/g, '');
  if (!clean) return DEFAULT_TZ;
  var codes = ['972', '971', '966', '852', '358', '353', '351', '380', '420'];
  for (var i = 0; i < codes.length; i++) {
    if (clean.indexOf(codes[i]) === 0 && COUNTRY_TZ_MAP[codes[i]]) {
      return COUNTRY_TZ_MAP[codes[i]];
    }
  }
  var lens = [3, 2, 1];
  for (var j = 0; j < lens.length; j++) {
    var prefix = clean.slice(0, lens[j]);
    if (COUNTRY_TZ_MAP[prefix]) return COUNTRY_TZ_MAP[prefix];
  }
  return DEFAULT_TZ;
}

function _getUserTz_(fromPhone) {
  if (!fromPhone) return DEFAULT_TZ;
  try {
    if (typeof kvGet === 'function') {
      var stored = kvGet('tz:' + fromPhone);
      if (stored && typeof stored === 'string') return stored;
    }
  } catch (_e) {}
  var detected = _tzFromPhone_(fromPhone);
  try {
    if (typeof kvSet === 'function') kvSet('tz:' + fromPhone, detected, 0);
  } catch (_e2) {}
  return detected;
}

function _setUserTz_(fromPhone, tz) {
  if (!fromPhone || !tz) return false;
  try {
    if (typeof kvSet === 'function') return kvSet('tz:' + fromPhone, tz, 0);
  } catch (_e) {}
  return false;
}

function _isValidTz_(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Utilities.formatDate(new Date(), tz, 'yyyy');
    return true;
  } catch (_e) { return false; }
}

function _handleTimezoneCommand_(fromPhone, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };
  var norm = raw.replace(/^\//, '').trim();
  var m = norm.match(/^(?:אזור\s*זמן|timezone|tz)(?:\s+(.+))?$/i);
  if (!m) return { handled: false };
  var arg = (m[1] || '').trim();
  if (!arg) {
    var cur = _getUserTz_(fromPhone);
    return { handled: true, replyText:
      '🌍 *אזור הזמן שלך*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      cur + '\n\n' +
      '💡 לשינוי: "אזור זמן America/Los_Angeles"\n' +
      'רשימה: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
    };
  }
  if (!_isValidTz_(arg)) {
    return { handled: true, replyText:
      '😬 אזור זמן לא תקין: ' + arg + '\n' +
      '💡 השתמש בפורמט IANA, למשל "America/Los_Angeles" או "Europe/London"'
    };
  }
  var ok = _setUserTz_(fromPhone, arg);
  if (!ok) {
    return { handled: true, replyText:
      '😬 לא הצלחתי לשמור את אזור הזמן\n' +
      '💡 ננסה שוב בעוד דקה?'
    };
  }
  return { handled: true, replyText:
    '✅ אזור הזמן עודכן ל-' + arg + '\n' +
    'מעכשיו תאריכים בתגובות יוצגו לפי השעון הזה.'
  };
}

// ============================================================
// 💰 לוגיקת עיבוד הוצאה
// ============================================================

// ─────────────────────────────────────────────────────────────────────
// Rich business-order parser
//
// Handles messages like:
//   "עסק 880 שם לקוח אביזכר גודל תמונה 120-80 קנבס עלות ייצור 240 עלות מכירה 880 משלוח 45"
//   "עסק 1200 לקוח שרון 50x70 בד עלות 400 משלוח 30"
//   "עסק 880 אביזכר 120-80 קנבס ייצור 240 מכירה 880 משלוח 45"
//
// Extracts the labeled fields (customer, size, material, production cost,
// sale price, shipping) so we can write a structured row into the הזמנות
// tab and compute profit, rather than dumping the whole string into the
// flat תנועות sheet. Returns null if the message doesn't look like a
// rich order (so the caller falls back to the existing one-line flow).
// ─────────────────────────────────────────────────────────────────────
var _ORDER_MATERIALS_ = ['קנבס','בד','נייר','אקריליק','עץ','זכוכית','מתכת','PVC','קרטון','משי','עור','פוליאסטר'];

function parseBusinessOrder_(text) {
  if (!text) return null;
  var s = String(text).trim();
  // Must start with the עסק / biz prefix; otherwise treat as personal.
  if (!/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i.test(s)) return null;
  s = s.replace(/^(עסק|biz|business)\s*[:\-]?\s*/i, '');

  function _num(re) {
    var m = s.match(re);
    if (!m) return null;
    var raw = m[1].replace(/,/g, '');
    var n = parseFloat(raw);
    return isFinite(n) && n > 0 ? n : null;
  }
  function _word(re) {
    var m = s.match(re);
    return m ? m[1].trim() : null;
  }

  // Numeric fields — each label has multiple Hebrew + English aliases so
  // the user can write fluidly. "עלות מוצר" (product cost) and "עלות
  // פריט" (item cost) are treated as production cost, matching how
  // Steven uses them in practice. Order matters: specific multi-word
  // labels must come BEFORE the bare "עלות" fallback so we never
  // mistake "עלות מכירה 880" for productionCost=880.
  var productionCost = _num(/(?:עלות\s+ייצור|עלות\s+יצור|עלות\s+מוצר|עלות\s+פריט|עלות\s+חומר|ייצור|יצור|production|עלות)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);
  var salePrice      = _num(/(?:עלות\s+מכירה|מחיר\s+מכירה|מכירה|מחיר|sale)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);
  var shipping       = _num(/(?:דמי\s+משלוח|משלוח|שילוח|shipping)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);

  // Customer name: try the explicit label first ("שם לקוח X" / "לקוח X").
  var customer = _word(/(?:שם\s+לקוח|לקוח|customer)\s*[:=]?\s*([^\d\n]+?)(?=\s*(?:גודל|תמונה|קנבס|בד|נייר|אקריליק|עץ|זכוכית|מתכת|PVC|קרטון|עלות|מחיר|מכירה|ייצור|יצור|מוצר|פריט|משלוח|שילוח|\d{2,})|$)/i);
  // Fallback: if no explicit label, grab the leading Hebrew text right
  // after the "עסק" prefix up to the first labelled field or number.
  // Lets the user write "עסק ליה מרמת גן גודל ..." without forcing the
  // "לקוח" keyword. Capped at 40 chars to avoid grabbing the whole
  // message when no labelled field appears later.
  if (!customer) {
    var leadM = s.match(/^([^\d\n]+?)(?=\s*(?:גודל|תמונה|קנבס|בד|נייר|אקריליק|עץ|זכוכית|מתכת|PVC|קרטון|עלות|מחיר|מכירה|ייצור|יצור|מוצר|פריט|משלוח|שילוח|\d{2,}))/);
    if (leadM) {
      var lead = leadM[1].trim();
      // Skip bare prefixes like "biz:" or "business" that the strip-
      // regex above already consumed, plus single-token noise.
      if (lead.length >= 2 && lead.length <= 40 && !/^(?:biz|business)\b/i.test(lead)) {
        customer = lead;
      }
    }
  }

  // Size: accepts "120-80", "120x80", "120×80", optional "ס\"מ" / "cm".
  var sizeRaw = _word(/(?:גודל(?:\s+תמונה)?|size)\s*[:=]?\s*([0-9]+\s*[-xX×]\s*[0-9]+(?:\s*(?:cm|ס["׳']?ם))?)/i);
  if (!sizeRaw) {
    // Fall back: any bare "NxN" / "N-N" pattern (e.g. user wrote
    // "אביזכר 120-80 קנבס" without the "גודל" label).
    var sizeMatch = s.match(/(?:^|\s)([0-9]{2,4}\s*[-xX×]\s*[0-9]{2,4})(?=\s|$)/);
    if (sizeMatch) sizeRaw = sizeMatch[1];
  }
  var size = sizeRaw ? sizeRaw.replace(/\s+/g, '').replace(/[xX×]/, '×') : null;

  // Material: look for any of the known material tokens. First hit wins.
  var material = null;
  for (var i = 0; i < _ORDER_MATERIALS_.length; i++) {
    var mat = _ORDER_MATERIALS_[i];
    if (new RegExp('(?:^|\\s)' + mat + '(?:\\s|$)', 'i').test(s)) { material = mat; break; }
  }

  // Headline amount — first standalone number that ISN'T already eaten
  // by one of the labelled fields. Used as a fallback for salePrice and
  // for the תנועות "amount" column.
  var headline = null;
  var allNums = s.match(/\d+(?:[.,]\d+)?/g) || [];
  for (var j = 0; j < allNums.length; j++) {
    var n = parseFloat(allNums[j].replace(',', ''));
    if (!isFinite(n) || n <= 0) continue;
    // Skip if this number is the only digit in a size like "120-80"
    if (/-\s*\d/.test(allNums[j]) || /×|x/i.test(allNums[j])) continue;
    headline = n;
    break;
  }
  if (salePrice == null && headline != null) salePrice = headline;

  // Only treat as a "rich order" when we got at least 2 distinct fields
  // beyond a bare amount. Otherwise the caller falls back to the existing
  // dropdown flow (which serves "עסק 24 שיווק" style messages).
  var fieldsFound = 0;
  if (customer)       fieldsFound++;
  if (size)           fieldsFound++;
  if (material)       fieldsFound++;
  if (productionCost) fieldsFound++;
  if (shipping)       fieldsFound++;
  if (salePrice && headline !== salePrice) fieldsFound++;
  if (fieldsFound < 2) return null;

  var profit = null;
  if (salePrice != null) {
    profit = salePrice - (productionCost || 0) - (shipping || 0);
  }

  return {
    customer:       customer || '',
    size:           size || '',
    material:       material || '',
    productionCost: productionCost,
    salePrice:      salePrice,
    shipping:       shipping,
    profit:         profit,
    rawText:        text,
    amount:         salePrice || headline || 0,
  };
}

// Append a parsed order to the הזמנות tab on the company sheet. Columns
// (A-L) match the existing year-tab order log we already maintain:
//   A: timestamp
//   B: month (yyyy-MM)
//   C: customer
//   D: size
//   E: material
//   F: production cost
//   G: sale price
//   H: shipping
//   I: profit
//   J: source ('WhatsApp')
//   K: raw text
//   L: status ('paid' assumed; user can edit)
function _writeOrderRow_(parsed) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
    if (!sheet) {
      Logger.log('_writeOrderRow_: orders tab "' + ORDERS_TAB_NAME + '" not found');
      return { ok: false, error: 'orders_tab_not_found' };
    }
    var now = new Date();
    var month = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM');
    var row = [
      now,
      month,
      sanitizeForSheet(parsed.customer),
      sanitizeForSheet(parsed.size),
      sanitizeForSheet(parsed.material),
      parsed.productionCost || 0,
      parsed.salePrice || 0,
      parsed.shipping || 0,
      parsed.profit != null ? parsed.profit : '',
      'WhatsApp',
      sanitizeForSheet(parsed.rawText),
      'paid',
    ];
    sheet.appendRow(row);
    // Also push the gross revenue into the מאזן חברה dashboard so the
    // monthly מחזור ברוטו cell reflects the new order immediately.
    try {
      if (typeof _updateBusinessDashboard_ === 'function' && parsed.salePrice) {
        _updateBusinessDashboard_('עסק', 'מחזור', month, parsed.salePrice);
      }
    } catch (_dashErr) { Logger.log('_writeOrderRow_ dashboard err: ' + (_dashErr && _dashErr.message)); }
    return { ok: true, rowNumber: sheet.getLastRow() };
  } catch (e) {
    Logger.log('_writeOrderRow_ THREW: ' + (e && e.stack || e));
    return { ok: false, error: 'append_threw', detail: e && e.message };
  }
}

// Aggregate the הזמנות tab for the current calendar month and return a
// human-readable Hebrew summary. Designed for the "הזמנות" / "orders"
// WhatsApp command — fits inside a single message and gives the owner
// a quick "how am I doing this month" snapshot without opening Sheets.
function getOrdersSummary() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
    if (!sheet) {
      return '😬 לא מצאתי את לשונית "' + ORDERS_TAB_NAME + '". ננסה שוב בעוד דקה?';
    }
    var last = sheet.getLastRow();
    if (last < 2) {
      return '📦 *הזמנות החודש*\n━━━━━━━━━━━━━━━━━━\n\nאין הזמנות עדיין החודש.\nשלח לי הזמנה כדי להתחיל — לדוגמה:\n"עסק 880 לקוח ליה גודל 50-70 קנבס עלות מוצר 240 משלוח 45"';
    }
    var thisMonth = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM');
    // Columns A-L: timestamp, month, customer, size, material, prod, sale, ship, profit, source, raw, status
    var rng = sheet.getRange(2, 1, last - 1, 12).getValues();
    var count = 0, revenue = 0, productionCost = 0, shipping = 0, profit = 0;
    var lastFive = [];
    for (var i = rng.length - 1; i >= 0; i--) {
      var r = rng[i];
      var rowMonth = String(r[1] || '');
      if (rowMonth !== thisMonth) continue;
      count++;
      revenue        += Number(r[6]) || 0;
      productionCost += Number(r[5]) || 0;
      shipping       += Number(r[7]) || 0;
      profit         += Number(r[8]) || 0;
      if (lastFive.length < 5) {
        var when = r[0] instanceof Date
          ? Utilities.formatDate(r[0], 'Asia/Jerusalem', 'dd/MM')
          : String(r[0]).slice(0, 5);
        var who = String(r[2] || '?');
        var sale = Number(r[6]) || 0;
        lastFive.push('  • ' + when + ' · ' + who + ' · ₪' + sale.toLocaleString('he-IL'));
      }
    }
    var out = [];
    out.push('📦 *הזמנות החודש (' + thisMonth + ')*');
    out.push('━━━━━━━━━━━━━━━━━━');
    out.push('');
    out.push('סה"כ הזמנות: ' + count);
    out.push('💰 מחזור: ₪' + revenue.toLocaleString('he-IL'));
    out.push('🏭 עלות מוצר: ₪' + productionCost.toLocaleString('he-IL'));
    out.push('🚚 משלוח: ₪' + shipping.toLocaleString('he-IL'));
    out.push('📈 רווח: ₪' + profit.toLocaleString('he-IL'));
    if (revenue > 0) {
      out.push('   (' + Math.round((profit / revenue) * 100) + '% רווחיות)');
    }
    if (lastFive.length) {
      out.push('');
      out.push('🕒 *אחרונות:*');
      lastFive.forEach(function(l){ out.push(l); });
    }
    return out.join('\n');
  } catch (e) {
    Logger.log('getOrdersSummary err: ' + (e && e.stack || e));
    return '😬 לא הצלחתי לקרוא את הזמנות החודש: ' + (e && e.message || '');
  }
}

// Remove the most recent row from the הזמנות tab and reverse its impact
// on the מאזן חברה dashboard. Used by the "מחק הזמנה" / "undo order"
// command. We compare against the בעלות-of-this-script user, which for
// the Apps Script bot is the owner — tenants don't have orders-tab
// access yet so this is owner-only behaviour for now.
function deleteLastOrder() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(ORDERS_TAB_NAME);
    if (!sheet) return '😬 לא מצאתי את לשונית "' + ORDERS_TAB_NAME + '".';
    var last = sheet.getLastRow();
    if (last < 2) return '📭 אין הזמנות למחיקה.';
    var row = sheet.getRange(last, 1, 1, 12).getValues()[0];
    var when = row[0] instanceof Date
      ? Utilities.formatDate(row[0], 'Asia/Jerusalem', 'dd/MM HH:mm')
      : String(row[0]);
    var customer = String(row[2] || '?');
    var sale = Number(row[6]) || 0;
    var month = String(row[1] || '');
    sheet.deleteRow(last);
    // Reverse the dashboard impact if we can.
    try {
      if (typeof _updateBusinessDashboard_ === 'function' && sale > 0 && month) {
        _updateBusinessDashboard_('עסק', 'מחזור', month, -sale);
      }
    } catch (_dErr) { Logger.log('deleteLastOrder dashboard reverse err: ' + (_dErr && _dErr.message)); }
    return '🗑 הזמנה נמחקה:\n  ' + when + ' · ' + customer + ' · ₪' + sale.toLocaleString('he-IL');
  } catch (e) {
    Logger.log('deleteLastOrder err: ' + (e && e.stack || e));
    return '😬 משהו השתבש במחיקה: ' + (e && e.message || '');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group expense commands ("כספלה ...") — Splitwise-style ledger
//
// WhatsApp Cloud API doesn't deliver group-chat webhooks, so we
// implement "groups" as virtual ledgers anyone can join with a 6-char
// invite code. Each member texts the bot 1:1 with "כספלה <command>"
// and the bot routes everything by the member's active group pointer
// (stored in KV via the Vercel /api/group endpoint).
//
// Supported sub-commands (all in Hebrew, English aliases where useful):
//   כספלה צור <name>           Create a new group, return invite code
//   כספלה הצטרף <code>          Join an existing group by code
//   כספלה מצב                  Show current active group + member list
//   כספלה החלף <code>           Switch active group
//   כספלה עזוב                 Leave (clear active group pointer)
//   כספלה <amount> <desc>      Record an expense, split equally among members
//   כספלה יתרות                Show net balance per member + suggested transfers
//   כספלה סידור                Same as יתרות, focused on transfers only
//   כספלה הוצאות               Show the 5 most recent expenses
//   כספלה הוסף <name> <phone>  Add a member manually
//   כספלה הסר <phone>          Remove a member
//   כספלה מחק                  Undo the last expense (payer/creator only)
//   כספלה עזרה                 This help
// ─────────────────────────────────────────────────────────────────────
function _handleGroupCommand_(fromPhone, text) {
  if (!text) return { handled: false };
  // Strip the trigger word + optional separator.
  var body = String(text).replace(/^\s*כספלה\s*[:\-]?\s*/i, '').trim();

  // No body → show help.
  if (!body || /^(עזרה|help|\?)$/i.test(body)) {
    return { handled: true, replyText: _groupHelp_() };
  }

  // Sub-command parsing. We try the keyword commands first; anything
  // starting with a digit is treated as a "record an expense" message.

  // Create a new group: "צור [name]" / "create [name]" / "התחל [name]".
  // REQUIRE a word boundary after the keyword (whitespace or end), not
  // \s* — otherwise "כספלה צורה יפה" (a sentence about a shape) would
  // match "צור" as a prefix and create a group named "ה יפה". The
  // mandatory \s+ (or $) means the keyword must be a standalone word.
  var mCreate = body.match(/^(?:צור|create|התחל|start|הקם)(?:\s+(.*))?$/i);
  if (mCreate) return _groupCreate_(fromPhone, (mCreate[1] || '').trim());

  // Join: "הצטרף <code>" / "join <code>" / "קוד <code>" — code is 6-8
  // chars (8 for new CSPRNG codes, 6 for legacy). The mandatory \s+
  // already prevents prefix-matching here.
  var mJoin = body.match(/^(?:הצטרף|join|קוד\s+קבוצה|קוד)\s+([A-Z0-9]{6,8})\b/i);
  if (mJoin) return _groupJoin_(fromPhone, mJoin[1].toUpperCase());

  // Switch active group: "החלף <code>" / "switch <code>"
  var mSwitch = body.match(/^(?:החלף|switch|מצב\s+קבוצה|הפעל)\s+([A-Z0-9]{6,8})\b/i);
  if (mSwitch) return _groupSetActive_(fromPhone, mSwitch[1].toUpperCase());

  // Leave the current group.
  if (/^(?:עזוב|leave|יציאה)$/i.test(body)) return _groupLeave_(fromPhone);

  // Status: "מצב" / "info" / "פרטים"
  if (/^(?:מצב|info|פרטים|status)$/i.test(body)) return _groupInfo_(fromPhone);

  // Context: show "active group" + all groups the user belongs to.
  if (/^(?:הקשר|context|רשימה|הקבוצות שלי|my groups)$/i.test(body)) return _groupContext_(fromPhone);

  // Personal mode: clear the active-group pointer so plain expenses
  // (without a "כספלה" prefix) go to the personal sheet again.
  if (/^(?:אישי|personal|מצב אישי)$/i.test(body)) return _groupLeave_(fromPhone, /*personal*/ true);

  // Quick switch to a specific group by code.
  var mSwitchTo = body.match(/^(?:עבור\s+ל|switch\s+to|הפעל\s+קבוצה)\s+([A-Z0-9]{6,8})\b/i);
  if (mSwitchTo) return _groupSetActive_(fromPhone, mSwitchTo[1].toUpperCase());

  // Force a sheet provision / resync for the active group.
  if (/^(?:סנכרן|resync|רענן)$/i.test(body)) return _groupResync_(fromPhone);

  // Group report (alias for balances, kept for family-mode parity).
  if (/^(?:דו(?:["׳']*?)ח|דוח|report)$/i.test(body)) return _groupBalances_(fromPhone, 'full');

  // Recurring expense management.
  var mRecur = body.match(/^(?:קבוע|recurring|חוזר)\s+(.+)$/i);
  if (mRecur) return _groupAddRecurring_(fromPhone, mRecur[1]);
  if (/^(?:קבועים|recurring list|רשימת חוזרים)$/i.test(body)) return _groupListRecurring_(fromPhone);

  // Export — email a CSV of the group's expenses.
  if (/^(?:ייצא|export|csv|הורד)$/i.test(body)) return _groupExport_(fromPhone);

  // Balances + settlements
  if (/^(?:יתרות|balances?|חוב)$/i.test(body)) return _groupBalances_(fromPhone, 'full');
  if (/^(?:סידור|settle|העברות)$/i.test(body)) return _groupBalances_(fromPhone, 'settle');

  // Recent expenses
  if (/^(?:הוצאות|expenses|אחרונות|recent)$/i.test(body)) return _groupRecent_(fromPhone);

  // Add / remove members
  var mAdd = body.match(/^(?:הוסף|add)\s+(.+)$/i);
  if (mAdd) return _groupAddMember_(fromPhone, mAdd[1]);
  var mRm = body.match(/^(?:הסר|remove|delete)\s+(.+)$/i);
  if (mRm) return _groupRemoveMember_(fromPhone, mRm[1]);

  // Undo
  if (/^(?:מחק|undo|בטל)$/i.test(body)) return _groupUndo_(fromPhone);

  // Otherwise: treat as expense entry — must start with an amount.
  if (/^\d/.test(body)) return _groupRecordExpense_(fromPhone, body);

  return { handled: true, replyText: '😬 לא הבנתי. שלח "כספלה עזרה" לרשימת הפקודות.' };
}

function _groupHelp_() {
  return '🤝 *כספ\'לה — הוצאות קבוצתיות*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '*התחלה:*\n' +
    '  • "כספלה צור משפחה כהן" — צור קבוצה חדשה\n' +
    '  • "כספלה הצטרף ABC123" — הצטרף לקבוצה עם קוד\n' +
    '  • "כספלה מצב" — פרטי הקבוצה הפעילה\n' +
    '  • "כספלה הקשר" — כל הקבוצות שאני חבר בהן\n\n' +
    '*רישום הוצאות (פיצול שווה אוטומטי):*\n' +
    '  • "כספלה 245 סופר"\n' +
    '  • "כספלה 1200 ארנונה"\n\n' +
    '*קבועים (חוזרים):*\n' +
    '  • "כספלה קבוע 3000 שכירות חודשי"\n' +
    '  • "כספלה קבועים" — רשימת הקבועים\n\n' +
    '*ניהול:*\n' +
    '  • "כספלה יתרות" — מי חייב למי ובכמה\n' +
    '  • "כספלה סידור" — העברות לסידור חובות\n' +
    '  • "כספלה הוצאות" — 10 ההוצאות האחרונות\n' +
    '  • "כספלה דו״ח" — דו״ח מלא\n' +
    '  • "כספלה הוסף יוסי 972526003090"\n' +
    '  • "כספלה הסר 972526003090"\n' +
    '  • "כספלה מחק" — בטל את ההוצאה האחרונה\n' +
    '  • "כספלה סנכרן" — צור/רענן את הגיליון המשותף\n\n' +
    '*החלפת קבוצה:*\n' +
    '  • "כספלה החלף ABC123" — עבור לקבוצה אחרת\n' +
    '  • "כספלה אישי" — חזור למצב אישי\n' +
    '  • "כספלה עזוב" — צא מהקבוצה הנוכחית\n\n' +
    '📌 *אליאסים תואמים:*\n' +
    '"הקמת משפחה" = "כספלה צור משפחה"\n' +
    '"הצטרפות למשפחה <קוד>" = "כספלה הצטרף <קוד>"\n' +
    '"דו״ח משפחתי" = "כספלה יתרות"';
}

// ============ HTTP helper for /api/group ============
function _groupAPI_(action, payload) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) {
    Logger.log('_groupAPI_: KESEFLE_BOT_SECRET not set in Script Properties');
    return { ok: false, error: 'bot_secret_not_set' };
  }
  payload = payload || {};
  payload.action = action;
  payload.botSecret = secret;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/group', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('_groupAPI_ ' + action + ' HTTP ' + code + ': ' + body.slice(0, 300));
      try { return JSON.parse(body); } catch (_je) { return { ok: false, error: 'http_' + code }; }
    }
    return JSON.parse(body);
  } catch (e) {
    Logger.log('_groupAPI_ ' + action + ' threw: ' + (e && e.message));
    return { ok: false, error: 'fetch_threw', detail: e && e.message };
  }
}

// ============ command implementations ============

function _groupCreate_(fromPhone, name) {
  var groupName = name && name.length > 0 ? name : 'הקבוצה שלי';
  var senderName = _groupSenderName_(fromPhone);
  var r = _groupAPI_('create', { creatorPhone: fromPhone, creatorName: senderName, groupName: groupName });
  if (!r || !r.ok) {
    return { handled: true, replyText: '😬 לא הצלחתי ליצור קבוצה: ' + (r && r.error || 'שגיאה') };
  }
  // HONESTY: server creates the KV record either way, but the SHARED SHEET
  // creation is best-effort and depends on the creator having an OAuth-linked
  // account. We must NOT lie that "group created" if the user can't actually
  // use it. Tell the user the true state.
  var sheetCreated = !!(r.group && (r.group.sheetUrl || r.group.sheetId));
  var sheetLine = sheetCreated
    ? '📊 גיליון משותף נוצר ב-Drive שלך:\n' + (r.group.sheetUrl || ('https://docs.google.com/spreadsheets/d/' + r.group.sheetId)) + '\n\n'
    : '⚠️  *הקבוצה רשומה אבל בלי גיליון משותף עדיין.* כדי שאני אוכל ליצור את הגיליון:\n' +
      '1. כנס/י ל-kesefle.com/account עם המספר הזה\n' +
      '2. התחבר עם Google\n' +
      '3. שלח שוב "כספלה צור משפחה ' + groupName + '"\n\n';
  return { handled: true, replyText:
    '✅ נוצרה קבוצה: *' + groupName + '*\n' +
    '🔑 קוד הזמנה: *' + r.code + '*\n\n' +
    sheetLine +
    'שתף/י את הקוד עם חברי הקבוצה כדי שיצטרפו:\n' +
    '"כספלה הצטרף ' + r.code + '"\n\n' +
    'או הזמן/י אותם ב-https://kesefle.com/family-invite\n\n' +
    (sheetCreated ? 'עכשיו אפשר לרשום הוצאה: "כספלה 245 סופר"' : '(לאחר שתשלים/י את החיבור, הוצאות יזוהו אוטומטית)') };
}

function _groupJoin_(fromPhone, code) {
  var senderName = _groupSenderName_(fromPhone);
  var r = _groupAPI_('join', { phone: fromPhone, name: senderName, code: code });
  if (!r || !r.ok) {
    if (r && r.error === 'group_not_found') {
      return { handled: true, replyText: '😬 לא מצאתי קבוצה עם קוד "' + code + '". בדוק את הקוד ונסה שוב.' };
    }
    return { handled: true, replyText: '😬 לא הצלחתי להצטרף: ' + (r && r.error || 'שגיאה') };
  }
  var memberCount = r.group && r.group.members ? r.group.members.length : '?';
  return { handled: true, replyText:
    '✅ הצטרפת ל-*' + (r.group && r.group.name || 'הקבוצה') + '* (' + memberCount + ' חברים).\n\n' +
    'מעכשיו "כספלה <סכום> <פירוט>" יירשם בקבוצה הזאת.\n' +
    'נסה: "כספלה 50 קפה"' };
}

function _groupSetActive_(fromPhone, code) {
  var r = _groupAPI_('setactive', { phone: fromPhone, code: code });
  if (!r || !r.ok) return { handled: true, replyText: '😬 לא הצלחתי להחליף: ' + (r && r.error || 'שגיאה') };
  return { handled: true, replyText: '✅ עברת לקבוצה ' + code + '.' };
}

function _groupLeave_(fromPhone, personalMode) {
  var r = _groupAPI_('leave', { phone: fromPhone });
  if (!r || !r.ok) return { handled: true, replyText: '😬 שגיאה: ' + (r && r.error || 'unknown') };
  if (personalMode) {
    return { handled: true, replyText: '🏠 חזרת למצב אישי. הוצאות בלי "כספלה" יירשמו בגיליון האישי שלך.' };
  }
  return { handled: true, replyText: '👋 עזבת את הקבוצה הפעילה. שלח "כספלה הצטרף <קוד>" או "כספלה החלף <קוד>" כדי להצטרף לאחרת.' };
}

function _groupContext_(fromPhone) {
  var r = _groupAPI_('mygroups', { phone: fromPhone });
  if (!r || !r.ok) return { handled: true, replyText: '😬 לא הצלחתי לבדוק.' };
  if (!r.groups || !r.groups.length) {
    return { handled: true, replyText: '🏠 *מצב אישי* — אתה לא חבר באף קבוצה.\n\nשלח "כספלה צור <שם>" כדי ליצור אחת.' };
  }
  var lines = ['📋 *הקבוצות שלי*', '━━━━━━━━━━━━━━━━━━', ''];
  r.groups.forEach(function(g){
    var marker = (r.active === g.code) ? '🟢 פעילה' : '⚪';
    lines.push('  ' + marker + ' *' + g.name + '* · ' + g.code + ' · ' + g.memberCount + ' חברים · ' + g.expenseCount + ' הוצאות');
  });
  lines.push('');
  lines.push('להחלפה: "כספלה החלף <קוד>"');
  lines.push('למצב אישי: "כספלה אישי"');
  return { handled: true, replyText: lines.join('\n') };
}

function _groupResync_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) return { handled: true, replyText: 'אתה לא בקבוצה.' };
  var r = _groupAPI_('resync', { code: a.active });
  if (!r || !r.ok) {
    if (r && r.error === 'creator_not_oauth') {
      return { handled: true, replyText: '😬 יוצר הקבוצה עוד לא חיבר את חשבון Google. הוא צריך להירשם ב-https://kesefle.com/account קודם.' };
    }
    return { handled: true, replyText: '😬 שגיאה: ' + (r && r.error || 'unknown') };
  }
  if (r.already) {
    return { handled: true, replyText: '✓ הקבוצה כבר מסונכרנת.\n📄 הגיליון: ' + r.sheetUrl };
  }
  return { handled: true, replyText: '✅ נוצר גיליון משותף ב-Google Drive של יוצר הקבוצה.\n📄 ' + r.sheetUrl + '\n\n' + (r.mirrored || 0) + ' הוצאות סונכרנו לגיליון.' };
}

function _groupAddRecurring_(fromPhone, rest) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) return { handled: true, replyText: 'אתה לא בקבוצה. שלח "כספלה הצטרף <קוד>" קודם.' };
  // Parse "<amount> <description> [interval]"
  var m = rest.match(/^([0-9]+(?:[.,][0-9]+)?)\s+(.+?)(?:\s+(חודשי|שבועי|דו-שבועי|יומי|monthly|weekly|biweekly|daily))?$/i);
  if (!m) return { handled: true, replyText: '😬 פורמט: "כספלה קבוע 3000 שכירות חודשי"' };
  var amount = parseFloat(m[1].replace(',', '.'));
  var description = m[2].trim();
  var ilabel = (m[3] || 'חודשי').toLowerCase();
  var interval = 'monthly';
  if (/שבועי|weekly/i.test(ilabel)) interval = 'weekly';
  if (/דו-שבועי|biweekly/i.test(ilabel)) interval = 'biweekly';
  if (/יומי|daily/i.test(ilabel)) interval = 'daily';
  var r = _groupAPI_('addrecurring', {
    code: a.active, payerPhone: fromPhone, amount: amount, description: description, interval: interval,
  });
  if (!r || !r.ok) return { handled: true, replyText: '😬 שגיאה: ' + (r && r.error || 'unknown') };
  // HONESTY (2026-05-24): cronGroupRecurring runs only on the bot owner's
  // Apps Script project, so the "auto-reminders" line only applies to
  // owner-installed setups. For everyone else the recurring item is stored
  // but no cron fires it. Be honest about that.
  var reminderLine = (typeof _isOwnerPhone_ === 'function' && _isOwnerPhone_(fromPhone))
    ? 'הבוט יזכיר לך אוטומטית בכל מחזור.'
    : 'הקבוע נשמר ויופיע ברשימה. תזכורות אוטומטיות לכל הקבוצות בפיתוח.';
  return { handled: true, replyText:
    '🔁 קבוע נוסף:\n' +
    '  ₪' + amount.toLocaleString('he-IL') + ' · ' + description + '\n' +
    '  כל ' + ilabel + '\n\n' +
    reminderLine + ' שלח "כספלה קבועים" לרשימה המלאה.' };
}

function _groupListRecurring_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) return { handled: true, replyText: 'אתה לא בקבוצה.' };
  var r = _groupAPI_('listrecurring', { code: a.active });
  if (!r || !r.ok) return { handled: true, replyText: '😬 שגיאה.' };
  if (!r.recurring || !r.recurring.length) return { handled: true, replyText: '📭 אין קבועים בקבוצה. הוסף עם "כספלה קבוע 3000 שכירות חודשי".' };
  var lines = ['🔁 *הוצאות קבועות בקבוצה*', '━━━━━━━━━━━━━━━━━━', ''];
  r.recurring.forEach(function(rec){
    lines.push('  • ₪' + Number(rec.amount).toLocaleString('he-IL') + ' · ' + rec.description + ' · ' + rec.intervalLabel);
  });
  return { handled: true, replyText: lines.join('\n') };
}

// Build a CSV of the active group's expenses and email it to the
// requester. Uses Apps Script's MailApp (free 100 emails/day quota).
// The recipient address is the requester's Google account (whoever
// runs the script — which for the owner-installed bot is Steven).
// Tenants on /api/group can request a CSV via a future web export.
function _groupExport_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) return { handled: true, replyText: 'אתה לא בקבוצה.' };
  var info = _groupAPI_('info', { code: a.active, requesterPhone: fromPhone });
  if (!info || !info.ok) return { handled: true, replyText: '😬 שגיאה.' };
  var group = info.group;
  var lines = ['date,amount,category,description,paidBy,participants,splitMode,shares'];
  (group.expenses || []).forEach(function(e) {
    var shares = e.shares ? Object.entries(e.shares).map(function(kv){ return kv[0] + ':' + kv[1]; }).join('|') : '';
    var participants = e.shares ? Object.keys(e.shares).join('|') : '';
    var safe = function(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; };
    lines.push([
      e.timestamp || '',
      e.amount || 0,
      safe(e.category),
      safe(e.description),
      e.payerPhone || '',
      safe(participants),
      e.splitMode || '',
      safe(shares),
    ].join(','));
  });
  var csv = lines.join('\n');
  // HONESTY + PRIVACY (2026-05-24 audit): Session.getActiveUser().getEmail()
  // returns the BOT OWNER's Gmail (Steven), not the requester. The old
  // reply lied to non-owners that their CSV was emailed to them — it was
  // actually emailed to the owner. Two problems: privacy leak + lying.
  //
  // Fix: only auto-email when the requester IS the owner. Everyone else
  // gets directed to the web export at /dashboard which is the real,
  // authenticated download path for their own data.
  try {
    var addr = '';
    try { addr = Session.getActiveUser().getEmail(); } catch (_e) {}
    var isOwner = (typeof _isOwnerPhone_ === 'function') && _isOwnerPhone_(fromPhone);
    if (!isOwner || !addr) {
      return { handled: true, replyText:
        '📥 ייצוא CSV של הקבוצה:\n' +
        '1. כנס/י ל-' + KESEFLE_API_BASE.replace(/^https?:\/\//, '') + '/dashboard\n' +
        '2. התחבר עם Google\n' +
        '3. לחצ/י על "ייצוא" → CSV\n\n' +
        'הקובץ ירד ישירות אליך באופן מאובטח (' + (group.expenses || []).length + ' הוצאות בקבוצה).' };
    }
    MailApp.sendEmail({
      to: addr,
      subject: 'כספלה — ייצוא קבוצה ' + group.code,
      body: 'מצורף ייצוא CSV של הקבוצה "' + group.name + '" (' + group.code + ').\n\n' +
            'סה"כ ' + (group.expenses || []).length + ' הוצאות.\n\n' +
            'נשלח על-ידי הבוט בעקבות פקודת "כספלה ייצא" מ-' + fromPhone + '.',
      attachments: [Utilities.newBlob(csv, 'text/csv', group.code + '-' + new Date().toISOString().slice(0,10) + '.csv')],
    });
    return { handled: true, replyText: '📧 שלחתי לך CSV למייל ' + addr + ' (' + (group.expenses || []).length + ' הוצאות).' };
  } catch (e) {
    Logger.log('_groupExport_ err: ' + (e && e.message));
    return { handled: true, replyText: '😬 לא הצלחתי לשלוח: ' + (e && e.message || '') };
  }
}

// Daily cron — fires recurring group expenses whose intervalDays has
// elapsed since lastFiredAt (or createdAt). Posts to the same Vercel
// /api/group?action=addexpense so the regular split + sheet-mirror
// pipeline runs. The payer gets a WhatsApp message confirming.
function cronGroupRecurring() {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) {
    Logger.log('cronGroupRecurring: KESEFLE_BOT_SECRET not set');
    return;
  }
  // We need to know which groups to scan. The Vercel endpoint doesn't
  // expose a "list all groups" action (and we shouldn't — that's a
  // privacy footgun). Instead the cron iterates the bot owner's own
  // groups via mygroups, which covers Steven's own roommates/family
  // for now. Multi-tenant cron is a future enhancement that requires
  // a server-side scheduler instead of Apps Script.
  var ownerPhone = '';
  try { ownerPhone = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || ''); } catch (_e) {}
  ownerPhone = ownerPhone.replace(/[^0-9]/g, '');
  if (!ownerPhone) {
    Logger.log('cronGroupRecurring: SHEET_OWNER_PHONE not set, skipping');
    return;
  }

  var groups = _groupAPI_('mygroups', { phone: ownerPhone });
  if (!groups || !groups.ok || !groups.groups || !groups.groups.length) return;

  var now = Date.now();
  groups.groups.forEach(function(g) {
    var info = _groupAPI_('listrecurring', { code: g.code });
    if (!info || !info.ok || !info.recurring) return;
    info.recurring.forEach(function(rec) {
      if (!rec.active) return;
      var lastFired = rec.lastFiredAt ? new Date(rec.lastFiredAt).getTime() : new Date(rec.createdAt).getTime();
      var elapsedDays = (now - lastFired) / 86400000;
      if (elapsedDays < rec.intervalDays - 0.1) return; // not due yet
      // Fire the expense.
      var fireRes = _groupAPI_('addexpense', {
        code: g.code,
        payerPhone: rec.payerPhone,
        requesterPhone: rec.payerPhone,
        payerName: '(אוטומטי)',
        amount: rec.amount,
        description: '[קבוע] ' + rec.description,
        category: 'הוצאות קבועות',
        splitMode: 'equal',
      });
      if (fireRes && fireRes.ok) {
        // Persist lastFiredAt SERVER-SIDE so the recurring item doesn't
        // re-fire tomorrow. The old local "rec.lastFiredAt = ..." was a
        // no-op (the mutation never reached KV), so every recurring
        // expense fired daily instead of on its interval. The cron
        // secret authorizes this cron-only write.
        try {
          var __cronSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_CRON_SECRET') || '');
          _groupAPI_('markrecurringfired', { code: g.code, recurringId: rec.id, cronSecret: __cronSecret });
        } catch (_mfErr) { Logger.log('markrecurringfired err: ' + (_mfErr && _mfErr.message)); }
        // Notify the payer in WhatsApp.
        if (typeof sendWhatsAppMessage === 'function') {
          try {
            sendWhatsAppMessage('+' + rec.payerPhone,
              '🔁 הוצאה קבועה נרשמה אוטומטית:\n' +
              '₪' + Number(rec.amount).toLocaleString('he-IL') + ' · ' + rec.description + '\n' +
              'בקבוצה: ' + g.name + ' (' + g.code + ')');
          } catch (_e) {}
        }
      } else {
        Logger.log('cronGroupRecurring: addexpense failed for ' + g.code + '/' + rec.id);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Bill reminders — per-user date-scheduled WhatsApp pings
// ─────────────────────────────────────────────────────────────────────
function _remindersAPI_(action, payload) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return { ok: false, error: 'bot_secret_not_set' };
  payload = payload || {};
  payload.action = action;
  payload.botSecret = secret;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/reminders', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('_remindersAPI_ ' + action + ' HTTP ' + code + ': ' + body.slice(0, 200));
      try { return JSON.parse(body); } catch (_e) { return { ok: false, error: 'http_' + code }; }
    }
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'fetch_threw', detail: e && e.message };
  }
}

function _addReminder_(fromPhone, when, description, amount) {
  var r = _remindersAPI_('add', { phone: fromPhone, when: when, description: description, amount: amount });
  if (!r || !r.ok) {
    if (r && r.error === 'invalid_date') {
      return '😬 לא הבנתי את התאריך. נסה: "תזכורת 15/6 ארנונה" או "תזכורת מחר חשמל 450".';
    }
    return '😬 שגיאה: ' + (r && r.error || 'unknown');
  }
  var amountTxt = amount ? ' (₪' + Number(amount).toLocaleString('he-IL') + ')' : '';
  return '🔔 תזכורת נוספה: ' + r.entry.when + ' — ' + description + amountTxt + '\nID: ' + r.entry.id.slice(0, 8);
}

function _listReminders_(fromPhone) {
  var r = _remindersAPI_('list', { phone: fromPhone });
  if (!r || !r.ok) return '😬 שגיאה.';
  if (!r.reminders.length) return '📭 אין תזכורות פעילות.\n\nהוסף: "תזכורת 15/6 חשמל 450"';
  var lines = ['🔔 *תזכורות קרובות*', '━━━━━━━━━━━━━━━━━━', ''];
  r.reminders.forEach(function(rem) {
    var amt = rem.amount ? ' · ₪' + Number(rem.amount).toLocaleString('he-IL') : '';
    var when = rem.when.split('-').reverse().slice(0, 2).join('/');
    lines.push('  • ' + when + ' · ' + rem.description + amt + '  `' + rem.id.slice(0, 8) + '`');
  });
  lines.push('');
  lines.push('למחיקה: "מחק תזכורת <ID>"');
  return lines.join('\n');
}

function _removeReminder_(fromPhone, idPrefix) {
  // Resolve ID prefix to the full ID by listing first.
  var listing = _remindersAPI_('list', { phone: fromPhone });
  if (!listing || !listing.ok) return '😬 שגיאה.';
  var match = listing.reminders.find(function(r){ return r.id.indexOf(idPrefix) === 0; });
  if (!match) return '😬 לא מצאתי תזכורת עם ID "' + idPrefix + '". שלח "תזכורות" לרשימה.';
  var r = _remindersAPI_('remove', { phone: fromPhone, id: match.id });
  if (!r || !r.ok) return '😬 מחיקה נכשלה.';
  return '🗑 תזכורת נמחקה: ' + match.description;
}

function _getReferralLink_(fromPhone) {
  return '🎁 *הזמן חברים, קבל חודש Pro חינם*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    'כל חבר שמצטרף דרכך:\n' +
    '  • הוא מקבל חודש Pro חינם\n' +
    '  • אתה מקבל חודש Pro חינם\n\n' +
    'הקוד והקישור שלך נמצאים בלוח הבקרה:\n' +
    'https://kesefle.com/dashboard#referral\n\n' +
    'שתף עם החברים שלך:\n' +
    '"היי, נסה את כספ\'לה — בוט הוצאות בעברית בוואטסאפ:\n' +
    'https://kesefle.com"';
}

// Daily cron — scans cross-user reminders due today and fires WhatsApp
// pings. Single-tenant for now (runs as the bot owner) — the Vercel
// /api/reminders?action=due endpoint scans ALL users' reminders and
// returns the firing list, then this function iterates and pings each.
function cronBillReminders() {
  // The cross-user "due" scan requires a separate cron secret (the bot
  // secret alone isn't enough — see api/reminders.js). Read it from
  // Script Properties; if unset, the call will 503 and we skip quietly.
  var cronSecret = '';
  try { cronSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_CRON_SECRET') || ''); } catch (_e) {}
  var resp = _remindersAPI_('due', { onDate: new Date().toISOString().slice(0, 10), cronSecret: cronSecret });
  if (!resp || !resp.ok || !resp.due || !resp.due.length) return;
  resp.due.forEach(function(r) {
    if (typeof sendWhatsAppMessage !== 'function') return;
    try {
      var amt = r.amount ? '\n💰 ' + Number(r.amount).toLocaleString('he-IL') + ' ₪' : '';
      sendWhatsAppMessage('+' + r.phone,
        '🔔 *תזכורת*\n' +
        r.description + amt + '\n\n' +
        'אם שילמת — שלח "[הסכום] ' + r.description + '" כדי לרשום.');
    } catch (_e) {}
  });
}

function installBillRemindersTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronBillReminders') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronBillReminders').timeBased().atHour(9).everyDays(1).create();
  Logger.log('✅ cronBillReminders installed: daily @ 09:00');
}

// ─────────────────────────────────────────────────────────────────────
// Smart group-expense suggestion
//
// Lightweight classifier (no external API): if the user is in an active
// group AND the new personal expense either contains a share-keyword
// (שכירות / ארנונה / חשמל / מים / ועד / שותפים / דירה / משותף / ביחד)
// OR the amount is > 1.5σ above the user's 50-row median, append a
// one-line suggestion to the bot's reply. Dedup per-day per-description
// so the user doesn't see the same prompt twice for the same expense.
// ─────────────────────────────────────────────────────────────────────
var _GROUP_KEYWORDS_RE_ = /(שכירות|ארנונה|חשמל|מים|ועד|שותפים?|דירה|משותפ|ביחד|together)/i;

function _maybeSuggestGroupSplit_(fromPhone, text) {
  if (!fromPhone || !text) return null;
  try {
    // Cheap pre-check: only run for messages that look like an expense.
    if (!/^\s*\d/.test(text)) return null;
    // Active group?
    var ctx = (typeof _groupAPI_ === 'function') ? _groupAPI_('getactive', { phone: fromPhone }) : null;
    if (!ctx || !ctx.ok || !ctx.active) return null;
    // Already suggested today for this description?
    var dedupKey = 'groupSugg:' + fromPhone + ':' + (new Date().toISOString().slice(0, 10)) + ':' + text.slice(0, 32);
    try {
      if (CacheService.getScriptCache().get(dedupKey)) return null;
    } catch (_e) {}
    var triggered = false;
    if (_GROUP_KEYWORDS_RE_.test(text)) triggered = true;
    if (!triggered) {
      // Amount anomaly check vs the user's own median.
      var parsed = (typeof parseAmountAndDescription === 'function') ? parseAmountAndDescription(text) : null;
      if (parsed && parsed.items && parsed.items.length) {
        var amount = parsed.items[0].amount;
        var stats = _userExpenseStats_(50);
        if (stats && amount > stats.median + 1.5 * stats.stddev && amount >= 100) {
          triggered = true;
        }
      }
    }
    if (!triggered) return null;
    try { CacheService.getScriptCache().put(dedupKey, '1', 86400); } catch (_e) {}
    return '👥 שייכת לקבוצה? שלח "כספלה ' + text.trim() + '" כדי לפצל אוטומטית.';
  } catch (e) {
    return null;
  }
}

function _userExpenseStats_(rows) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return null;
    var last = sheet.getLastRow();
    if (last < 5) return null;
    var n = Math.min(rows || 50, last - 1);
    var amounts = sheet.getRange(last - n + 1, 3, n, 1).getValues()
      .map(function(r){ return Number(r[0]); })
      .filter(function(v){ return isFinite(v) && v > 0; });
    if (amounts.length < 5) return null;
    var sorted = amounts.slice().sort(function(a, b){ return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    var mean = amounts.reduce(function(a,b){ return a + b; }, 0) / amounts.length;
    var variance = amounts.reduce(function(s,v){ return s + (v - mean) * (v - mean); }, 0) / amounts.length;
    return { median: median, mean: mean, stddev: Math.sqrt(variance), n: amounts.length };
  } catch (_e) { return null; }
}

// ─────────────────────────────────────────────────────────────────────
// Admin alerts — if the bot's Executions log shows >5 errors in the
// last 10 minutes, email the script owner. Runs every 10 min.
// Uses Apps Script's free MailApp (~100 emails/day quota; the daily
// rate-limiter below caps us at 6 alerts/hour so we stay well below).
// ─────────────────────────────────────────────────────────────────────
function cronAdminAlerts() {
  try {
    var props = PropertiesService.getScriptProperties();
    var lastAlertStr = props.getProperty('admin_alert_last_sent');
    if (lastAlertStr) {
      var elapsed = (Date.now() - new Date(lastAlertStr).getTime()) / 60000;
      if (elapsed < 30) return; // hard cooldown — no more than 2/hour
    }
    // Apps Script doesn't expose Executions log via API, but we can
    // observe error counters we write ourselves. The bot's _doPost_orig
    // already logs catches via Logger.log — we mirror them to a script
    // property bucket so this cron can read them.
    var bucketStr = props.getProperty('errorBucket') || '[]';
    var bucket;
    try { bucket = JSON.parse(bucketStr); } catch (_) { bucket = []; }
    var tenMinAgo = Date.now() - 10 * 60 * 1000;
    var recent = bucket.filter(function(t) { return t > tenMinAgo; });
    // Persist trimmed bucket (keep only the last 10 min).
    props.setProperty('errorBucket', JSON.stringify(recent));
    if (recent.length < 5) return;
    // Send the alert.
    var addr = '';
    try { addr = Session.getActiveUser().getEmail(); } catch (_e) {}
    if (!addr) return;
    MailApp.sendEmail({
      to: addr,
      subject: '[Kesefle Bot] ' + recent.length + ' errors in 10 min',
      body: 'The Kesefle bot logged ' + recent.length + ' errors in the last 10 minutes.\n\n' +
            'Most recent timestamps:\n  ' + recent.slice(-5).map(function(t){ return new Date(t).toISOString(); }).join('\n  ') + '\n\n' +
            'Open the Apps Script Executions log to triage: https://script.google.com\n\n' +
            'Cooldown: this alert will not repeat for 30 minutes.',
    });
    props.setProperty('admin_alert_last_sent', new Date().toISOString());
  } catch (e) {
    Logger.log('cronAdminAlerts err: ' + (e && e.stack || e));
  }
}

// Helper to log a bot error into the rolling 10-min bucket the alert
// cron reads. Callers should invoke this from their catch blocks.
function _logBotError_(label, err) {
  try {
    Logger.log('BOT_ERROR ' + label + ': ' + (err && (err.stack || err.message) || err));
    var props = PropertiesService.getScriptProperties();
    var bucketStr = props.getProperty('errorBucket') || '[]';
    var bucket;
    try { bucket = JSON.parse(bucketStr); } catch (_) { bucket = []; }
    bucket.push(Date.now());
    if (bucket.length > 100) bucket = bucket.slice(-100);
    props.setProperty('errorBucket', JSON.stringify(bucket));
  } catch (_e) {}
}

function installAdminAlertsTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronAdminAlerts') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronAdminAlerts').timeBased().everyMinutes(10).create();
  Logger.log('✅ cronAdminAlerts installed: every 10 min');
}

// ─────────────────────────────────────────────────────────────────────
// Keep-warm cron — pings the bot's own webhook every 5 min so the
// Apps Script process stays warm and the first user message of the
// hour doesn't pay the ~2s cold-start penalty.
// Costs: 1 free Apps Script execution per 5 min (well within quota).
// ─────────────────────────────────────────────────────────────────────
function cronKeepWarm() {
  // We just touch SpreadsheetApp and read the script properties — both
  // are enough to keep the V8 runtime hot. No external HTTP needed
  // (which would burn UrlFetchApp quota for no benefit).
  try {
    SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET).getLastRow();
    PropertiesService.getScriptProperties().getProperty('WHATSAPP_TOKEN');
  } catch (_e) {}
}

function installKeepWarmTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronKeepWarm') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronKeepWarm').timeBased().everyMinutes(5).create();
  Logger.log('✅ cronKeepWarm installed: every 5 min');
}

// Daily heartbeat — POSTs the bot's KFL_BUILD_VERSION + timestamp to Vercel
// even when no WhatsApp messages have arrived. Without this, a silent Apps
// Script outage (revoked permissions, trigger broken, project disabled) is
// invisible -- the admin would only notice "no new bot writes" after hours.
// Runs once an hour to keep bot_version_latest fresh in KV.
function cronBotHeartbeat() {
  try {
    var url = KESEFLE_API_BASE + '/api/log/bot-heartbeat';
    var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (botSecret) headers['x-kesefle-bot-secret'] = botSecret;
    UrlFetchApp.fetch(url, {
      method: 'post',
      headers: headers,
      payload: JSON.stringify({
        version: KFL_BUILD_VERSION,
        at: Date.now(),
        source: 'cron'
      }),
      muteHttpExceptions: true,
    });
  } catch (e) { Logger.log('cronBotHeartbeat err: ' + (e && e.message)); }
}

function installBotHeartbeatTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronBotHeartbeat') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronBotHeartbeat').timeBased().everyHours(1).create();
  Logger.log('✅ cronBotHeartbeat installed: every 1 hour');
}

// ─────────────────────────────────────────────────────────────────────
// Re-engagement engine — daily 18:00 ping of users gone quiet
//
// Targets users who logged something in the last 30 days but have been
// silent for 5+ days. The ping references their ACTUAL data so it
// doesn't feel like spam: their most-recent expense category, their
// unsettled group balance, or their pending savings goal.
//
// Dedup: each user gets pinged at most once every 7 days. KV key
// `lastPing:{phone}` holds the timestamp.
// ─────────────────────────────────────────────────────────────────────
function cronReEngagement() {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // date, month, amount, category, sub, desc, source
    // Build per-phone aggregates of "last activity" + "most recent expense".
    // We key on the owner phone (single-tenant for now); the multi-tenant
    // expansion uses the Vercel /api/whatsapp/link mapping to find per-
    // tenant phones, but for the current single-owner bot one ping covers
    // the owner.
    var ownerPhone = '';
    try { ownerPhone = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || ''); } catch (_e) {}
    ownerPhone = ownerPhone.replace(/[^0-9]/g, '');
    if (!ownerPhone) {
      Logger.log('cronReEngagement: SHEET_OWNER_PHONE not set');
      return;
    }
    var now = new Date();
    var lastActivity = null, lastExpense = null;
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      var when = row[0] instanceof Date ? row[0] : new Date(row[0]);
      if (!lastActivity || when > lastActivity) {
        lastActivity = when;
        lastExpense = { amount: Number(row[2]) || 0, category: String(row[3] || ''), description: String(row[5] || '') };
      }
      if (data.length - i > 50) break; // only scan recent rows
    }
    if (!lastActivity) return;
    var daysSilent = (now - lastActivity) / 86400000;
    if (daysSilent < 5) return; // not yet stale
    if (daysSilent > 60) return; // probably churned, save the API call

    // Dedup: don't ping the same user twice in 7 days.
    try {
      var lastPingStr = PropertiesService.getScriptProperties().getProperty('lastPing:' + ownerPhone);
      if (lastPingStr) {
        var lastPing = new Date(lastPingStr);
        if ((now - lastPing) / 86400000 < 7) return;
      }
    } catch (_e) {}

    var lines = [];
    lines.push('היי 👋');
    if (lastExpense && lastExpense.amount > 0) {
      var cat = lastExpense.category || 'הוצאות';
      lines.push('עברו ' + Math.round(daysSilent) + ' ימים מאז ההוצאה האחרונה שלך — ₪' + Number(lastExpense.amount).toLocaleString('he-IL') + ' על ' + cat + '.');
      lines.push('');
      lines.push('הכל בסדר? 📊 שלח "סיכום" לראות איפה אתה החודש.');
    } else {
      lines.push('עבר שבוע מאז שרשמת הוצאה. הכל בסדר?');
      lines.push('שלח לי מספר ותיאור ואני אעקוב — למשל "45 קפה".');
    }
    if (typeof sendWhatsAppMessage === 'function') {
      try { sendWhatsAppMessage('+' + ownerPhone, lines.join('\n')); } catch (_e) {}
    }
    try { PropertiesService.getScriptProperties().setProperty('lastPing:' + ownerPhone, now.toISOString()); } catch (_e) {}
  } catch (e) {
    Logger.log('cronReEngagement err: ' + (e && e.stack || e));
  }
}

function installReEngagementTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronReEngagement') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronReEngagement').timeBased().atHour(18).everyDays(1).create();
  Logger.log('✅ cronReEngagement installed: daily @ 18:00');
}

// ─────────────────────────────────────────────────────────────────────
// Milestone celebrations — fire at meaningful moments to build emotional
// attachment. Hooked off processExpense so the celebration message
// piggybacks on the user's "✅ נרשם" reply rather than firing a
// separate cron.
// ─────────────────────────────────────────────────────────────────────
function getMilestoneMessage_(fromPhone, totalExpensesAfter) {
  try {
    var props = PropertiesService.getScriptProperties();
    // 100 / 250 / 500 / 1000 / 2500 milestones.
    var thresholds = [100, 250, 500, 1000, 2500];
    for (var i = 0; i < thresholds.length; i++) {
      var th = thresholds[i];
      if (totalExpensesAfter === th) {
        var key = 'milestone:' + fromPhone + ':' + th;
        if (props.getProperty(key)) return null; // already fired
        props.setProperty(key, new Date().toISOString());
        if (th === 100) return '\n\n🎉 הוצאה מספר 100! מתחילה להראות תמונה מלאה. שלח "סיכום" לראות.';
        if (th === 250) return '\n\n📈 250 הוצאות. אתה בקצב מצוין.';
        if (th === 500) return '\n\n🏆 500 הוצאות! חצי דרך לאלף.';
        if (th === 1000) return '\n\n👑 אלף הוצאות. אתה אלוף.';
        if (th === 2500) return '\n\n🚀 2,500 הוצאות. הנתונים שלך שווים זהב — ב-https://kesefle.com/dashboard יש דברים מעניינים.';
      }
    }
  } catch (e) {}
  return null;
}

// Install the daily recurring-group-expense trigger. Run this once.
function installGroupRecurringTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronGroupRecurring') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronGroupRecurring').timeBased().atHour(8).everyDays(1).create();
  Logger.log('✅ cronGroupRecurring installed: daily @ 08:00');
}

// ─────────────────────────────────────────────────────────────────────
// Personal recurring expenses ("הוצאות קבועות") — templates stored in the
// Vercel KV via /api/recurring. The bot parses the Hebrew command, posts
// to the API, and a daily cron asks the API to log anything that is due.
// Mirrors the _remindersAPI_ helper pattern (single POST helper + the bot
// secret header), and reuses KESEFLE_API_BASE like _tenantWriteExpense_.
// ─────────────────────────────────────────────────────────────────────
function _recurringAPI_(action, payload) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return { ok: false, error: 'bot_secret_not_set' };
  payload = payload || {};
  payload.action = action;
  payload.botSecret = secret;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/recurring', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('_recurringAPI_ ' + action + ' HTTP ' + code + ': ' + body.slice(0, 200));
      try { return JSON.parse(body); } catch (_e) { return { ok: false, error: 'http_' + code }; }
    }
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'fetch_threw', detail: e && e.message };
  }
}

// Hebrew day-of-week names → getDay() index (0=Sunday … 6=Saturday).
var _RECUR_DOW_ = {
  'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3,
  'חמישי': 4, 'שישי': 5, 'שבת': 6,
};

// Parse a recurring-expense command body (the leading command word like
// "קבוע" is ALREADY stripped by the caller). Returns
// { amount, description, freq, category, startDate } or null when no
// amount is present. `text` example: "2500 שכירות כל 1 לחודש".
function _parseRecurringCommand_(text) {
  if (!text) return null;
  var work = String(text).trim();
  if (!work) return null;

  // NOTE: JS \b word boundaries do NOT work around Hebrew letters (\w is
  // ASCII-only), so all Hebrew-adjacent anchors use whitespace/edge groups.

  // 1. Optional "קטגוריה X" — pull it out first so it never pollutes the
  //    description or the freq clause. Capture a single word as category.
  var category = null;
  work = work.replace(/(^|\s)קטגוריה\s+(\S+)/i, function(_m, _pre, cat) { category = cat; return ' '; });

  // 2. Optional "החל מ-DD/MM/YYYY" or "החל מ-DD/MM" anywhere → startDate.
  var startDate = null;
  work = work.replace(/(^|\s)החל\s*מ[-\s]*(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?/i,
    function(_m, _pre, dd, mm, yy) {
      var day = ('0' + parseInt(dd, 10)).slice(-2);
      var mon = ('0' + parseInt(mm, 10)).slice(-2);
      var year;
      if (yy) {
        year = parseInt(yy, 10);
        if (year < 100) year += 2000;
      } else {
        year = new Date().getFullYear();
      }
      startDate = year + '-' + mon + '-' + day;
      return ' ';
    });

  work = work.replace(/\s+/g, ' ').trim();

  // 3. amount = the first number in the remaining text.
  var amountM = work.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountM) return null;
  var amount = parseFloat(amountM[1].replace(',', '.'));
  if (!isFinite(amount) || amount <= 0) return null;

  // 4. Split off the "כל ..." recurrence clause (if any). Everything between
  //    the amount and "כל" is the description. We anchor on a whitespace/edge
  //    boundary (not \b) because "כל" is Hebrew. The match captures the
  //    leading separator, so the clause itself starts after that group.
  var afterAmount = work.slice(amountM.index + amountM[1].length).trim();
  var freq = null;
  var description = afterAmount;
  var kolM = afterAmount.match(/(^|\s)(כל(?:\s|$))/);
  if (kolM) {
    var clauseStart = kolM.index + kolM[1].length;
    description = afterAmount.slice(0, clauseStart).trim();
    var clause = afterAmount.slice(clauseStart).trim();
    freq = _parseRecurFreqClause_(clause);
  }

  // Default: monthly on today's day-of-month when no "כל" clause is given.
  if (!freq) {
    freq = { type: 'monthly', day: new Date().getDate() };
  }

  description = description.replace(/\s+/g, ' ').trim();

  return {
    amount: amount,
    description: description,
    freq: freq,
    category: category,
    startDate: startDate,
  };
}

// Parse the "כל ..." recurrence clause into a freq object. Returns null on
// no match (caller then applies the monthly-today default).
function _parseRecurFreqClause_(clause) {
  if (!clause) return null;
  var c = String(clause).trim();
  var m;

  // "כל <D> לחודשיים" → every 2 months on day D.
  m = c.match(/^כל\s+(\d{1,2})\s+לחודשיים/);
  if (m) return { type: 'months', n: 2, day: parseInt(m[1], 10) };

  // "כל <D> לחודש" → monthly on day D.
  m = c.match(/^כל\s+(\d{1,2})\s+לחודש(?=\s|$)/);
  if (m) return { type: 'monthly', day: parseInt(m[1], 10) };

  // "כל <D> ל-<N> חודשים" → every N months on day D.
  m = c.match(/^כל\s+(\d{1,2})\s+ל[-\s]*(\d{1,2})\s+חודשים/);
  if (m) return { type: 'months', n: parseInt(m[2], 10), day: parseInt(m[1], 10) };

  // "כל <N> חודשים" (day optional, default 1).
  m = c.match(/^כל\s+(\d{1,2})\s+חודשים/);
  if (m) return { type: 'months', n: parseInt(m[1], 10), day: 1 };

  // "כל חודשיים" (no day) → every 2 months on day 1.
  if (/^כל\s+חודשיים/.test(c)) return { type: 'months', n: 2, day: 1 };

  // "כל חודש" (no day) → monthly on day 1.
  if (/^כל\s+חודש(?=\s|$)/.test(c)) return { type: 'monthly', day: 1 };

  // "כל יום <DOW>" / "כל <DOW>" → weekly with that day-of-week.
  m = c.match(/^כל\s+(?:יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?=\s|$)/);
  if (m) return { type: 'weekly', dow: _RECUR_DOW_[m[1]] };

  // "כל שבוע" → weekly on today's day-of-week.
  if (/^כל\s+שבוע(?=\s|$)/.test(c)) return { type: 'weekly', dow: new Date().getDay() };

  // "כל <N> ימים" → every N days.
  m = c.match(/^כל\s+(\d{1,3})\s+ימים/);
  if (m) return { type: 'days', n: parseInt(m[1], 10) };

  // "כל יום" / "כל יומיים" → every 1 / 2 days.
  if (/^כל\s+יומיים(?=\s|$)/.test(c)) return { type: 'days', n: 2 };
  if (/^כל\s+יום(?=\s|$)/.test(c)) return { type: 'days', n: 1 };

  return null;
}

// Render a freq object as a short Hebrew phrase for list output.
function _recurFreqHuman_(freq) {
  if (!freq || !freq.type) return '';
  if (freq.type === 'monthly') return 'כל ' + freq.day + ' לחודש';
  if (freq.type === 'months') {
    if (freq.n === 2) return 'כל ' + (freq.day || 1) + ' לחודשיים';
    return 'כל ' + (freq.day || 1) + ' ל-' + freq.n + ' חודשים';
  }
  if (freq.type === 'weekly') {
    var names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    return 'כל יום ' + (names[freq.dow] || '?');
  }
  if (freq.type === 'days') {
    if (freq.n === 1) return 'כל יום';
    if (freq.n === 2) return 'כל יומיים';
    return 'כל ' + freq.n + ' ימים';
  }
  return '';
}

function _money_(n) {
  return '₪' + Number(n || 0).toLocaleString('he-IL');
}

// ─── Recurring command handlers ───
// "קבוע 2500 שכירות כל 1 לחודש" → add a template.
function _recurringAdd_(fromPhone, body) {
  var parsed = _parseRecurringCommand_(body);
  if (!parsed || !parsed.amount) {
    return '😕 לא הבנתי. נסה: "קבוע 2500 שכירות כל 1 לחודש".';
  }
  var payload = {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    amount: parsed.amount,
    description: parsed.description || 'הוצאה קבועה',
    freq: parsed.freq,
  };
  if (parsed.category) payload.category = parsed.category;
  if (parsed.startDate) payload.startDate = parsed.startDate;
  var r = _recurringAPI_('add', payload);
  if (!r || !r.ok) return '😬 שגיאה: ' + (r && r.error || 'unknown');
  return '🔁 נרשמה הוצאה קבועה: ' + _money_(parsed.amount) + ' ' + payload.description +
    ' — הרישום הבא: ' + (r.nextDue || '?') + '.\n' +
    'רוצה לרשום למפרע מתחילת החודש? שלח: *סנכרן הוצאות קבועות*';
}

// "רשימת קבועות" / "קבועות" → list all templates.
function _recurringList_(fromPhone) {
  var r = _recurringAPI_('list', { phone: String(fromPhone).replace(/[^0-9]/g, '') });
  if (!r || !r.ok) return '😬 שגיאה: ' + (r && r.error || 'unknown');
  if (!r.templates || !r.templates.length) {
    return 'אין לך הוצאות קבועות עדיין. הוסף עם: קבוע 2500 שכירות כל 1 לחודש';
  }
  var lines = ['🔁 *הוצאות קבועות*', '━━━━━━━━━━━━━━━━━━', ''];
  r.templates.forEach(function(t) {
    var line = '• ' + _money_(t.amount) + ' ' + (t.description || '') +
      ' — ' + _recurFreqHuman_(t.freq) +
      ' — הבא: ' + (t.nextDue || '?');
    if (t.status === 'paused') line += ' (מושהה)';
    lines.push(line);
  });
  return lines.join('\n');
}

// "מחק קבוע <ref>" → remove by id or a word from the description.
function _recurringRemove_(fromPhone, ref) {
  ref = String(ref || '').trim();
  if (!ref) return '😕 ציין מה למחוק: "מחק קבוע שכירות".';
  var r = _recurringAPI_('remove', { phone: String(fromPhone).replace(/[^0-9]/g, ''), ref: ref });
  if (!r || !r.ok) return 'לא נמצא';
  return '🗑 נמחקה הוצאה קבועה: ' + (r.removed || ref);
}

// "עדכן קבוע <ref> ..." → ref = first word, rest parsed for new fields.
function _recurringUpdate_(fromPhone, rest) {
  rest = String(rest || '').trim();
  var spaceIdx = rest.indexOf(' ');
  var ref = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
  var changes = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';
  if (!ref) return '😕 ציין מה לעדכן: "עדכן קבוע שכירות 2700".';
  var payload = { phone: String(fromPhone).replace(/[^0-9]/g, ''), ref: ref };
  var parsed = _parseRecurringCommand_(changes);
  if (parsed) {
    if (parsed.amount) payload.amount = parsed.amount;
    if (parsed.category) payload.category = parsed.category;
    if (parsed.freq && /\bכל\b/.test(changes)) payload.freq = parsed.freq;
    var desc = (parsed.description || '').trim();
    if (desc) payload.description = desc;
  }
  if (payload.amount == null && payload.freq == null &&
      payload.category == null && payload.description == null) {
    return '😕 לא הבנתי מה לעדכן. נסה: "עדכן קבוע שכירות 2700".';
  }
  var r = _recurringAPI_('update', payload);
  if (!r || !r.ok) return '😬 שגיאה: ' + (r && r.error || 'unknown');
  var t = r.template || {};
  return '✏️ עודכן: ' + _money_(t.amount) + ' ' + (t.description || '') +
    (t.freq ? ' — ' + _recurFreqHuman_(t.freq) : '') + '.';
}

// "החלף מצב קבוע <ref>" / "השהה קבוע <ref>" / "הפעל קבוע <ref>" → toggle.
function _recurringToggle_(fromPhone, ref, status) {
  ref = String(ref || '').trim();
  if (!ref) return '😕 ציין איזו הוצאה קבועה.';
  var payload = { phone: String(fromPhone).replace(/[^0-9]/g, ''), ref: ref };
  if (status) payload.status = status;
  var r = _recurringAPI_('toggle', payload);
  if (!r || !r.ok) return '😬 שגיאה: ' + (r && r.error || 'unknown');
  var stateTxt = r.status === 'paused' ? 'הושהתה ⏸' : 'הופעלה ▶️';
  return 'ההוצאה הקבועה "' + (r.description || ref) + '" ' + stateTxt + '.';
}

// "סנכרן הוצאות קבועות" → log everything due since the template start.
function _recurringSync_(fromPhone) {
  var r = _recurringAPI_('sync', { phone: String(fromPhone).replace(/[^0-9]/g, '') });
  if (!r || !r.ok) return '😬 שגיאה: ' + (r && r.error || 'unknown');
  if (!r.count) return 'אין מה לסנכרן.';
  return '✅ נרשמו ' + r.count + ' הוצאות קבועות למפרע (סה"כ ' + _money_(r.totalAmount) + ').';
}

// =====================================================================
// Personalization questionnaire (Hebrew "she'elon hat'amah ishit") — a
// 3-step flow driven by WhatsApp interactive replies + one free-text step.
//
// The user profile (trackingType / hasRecurring / autoLogPref) is stored
// server-side via /api/profile (see _profileAPI_ below — same shape and
// secret header as _recurringAPI_). Because each interactive reply arrives
// as a SEPARATE webhook event, we persist the current step in CacheService
// under survey_state:<phone>. Interactive row ids are namespaced
// (q1_*/q2_*/q3_*) so the webhook can route them; see
// _surveyHandleInteractive_ wired from handleInteractiveReply_.
// =====================================================================

// POST helper for the profile endpoint. Identical shape to _recurringAPI_:
// header x-kesefle-bot-secret = KESEFLE_BOT_SECRET, body { action, ... }.
// Actions: set { phone, fields:{trackingType,hasRecurring,autoLogPref} }
//          get { phone } → both return { ok, profile }.
function _profileAPI_(action, payload) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return { ok: false, error: 'bot_secret_not_set' };
  payload = payload || {};
  payload.action = action;
  payload.botSecret = secret;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/profile', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('_profileAPI_ ' + action + ' HTTP ' + code + ': ' + body.slice(0, 200));
      try { return JSON.parse(body); } catch (_e) { return { ok: false, error: 'http_' + code }; }
    }
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'fetch_threw', detail: e && e.message };
  }
}

// --- Add a custom row to the user's "מאזן אישי" dashboard via the Vercel
// bridge. Used by:
//   (1) the "צור קטגוריה X" command in processExpense,
//   (2) the onboarding questionnaire's kids step (one row per child).
// Accepts a comma-separated list of names so a single message like
// "צור קטגוריה דניאל, מיכל, יואב" creates three rows.
// Returns a Hebrew reply string the caller passes back to WhatsApp.
function _addCategoryRows_(fromPhone, rawNames) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return 'לא הצלחתי לזהות את המספר שלך. נסה שוב.';
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return '😬 שגיאה בהגדרות הבוט (KESEFLE_BOT_SECRET חסר).';

  // Split on commas + Hebrew "ו" conjunction. Strip "ילד 1 " / "ילדה 2 "
  // prefixes so "ילד 1 דניאל" gives just "דניאל".
  var raw = String(rawNames || '').trim();
  if (!raw) return 'אחרי "צור קטגוריה" צריך לכתוב את השם. לדוגמה:\n*צור קטגוריה דניאל*\nאו לכמה ילדים יחד:\n*צור קטגוריה דניאל, מיכל, יואב*';
  var pieces = raw.split(/[,،;\n]+/).map(function (p) {
    return String(p || '')
      .replace(/^\s*(?:ילד(?:ה|ים|ות)?|בן|בת|תינוק(?:ת)?|child)\s*\d*\s*[:\-]?\s*/i, '')
      .trim();
  }).filter(function (p) { return p && p.length >= 2; });
  if (!pieces.length) return 'לא הצלחתי לזהות שמות. תכתוב למשל: *צור קטגוריה דניאל* או *צור קטגוריה ילד 1 דניאל, ילד 2 מיכל*';
  if (pieces.length > 6) pieces = pieces.slice(0, 6);

  var ok = [], failed = [], duplicates = [], sheetUrl = '';
  // Default emoji: 👶 for likely-kid names (short Hebrew first names).
  // Users can always rename the row in their sheet — col A is editable.
  var emoji = '✨';
  if (pieces.length > 1 || pieces.some(function (p) { return p.length <= 10 && !/[A-Za-z0-9]/.test(p); })) emoji = '👶';

  for (var i = 0; i < pieces.length; i++) {
    var name = pieces[i];
    try {
      var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/add-category-row', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-kesefle-bot-secret': secret },
        payload: JSON.stringify({ phone: clean, name: name, emoji: emoji, botSecret: secret }),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      var j; try { j = JSON.parse(body); } catch (_pe) { j = null; }
      if (code === 200 && j && j.ok) {
        if (j.duplicate) duplicates.push(name); else ok.push(name);
        if (j.sheetUrl) sheetUrl = j.sheetUrl;
      } else if (code === 404 && j && j.error === 'no_user') {
        return '😬 המספר הזה לא מקושר לחשבון. כנס/י ל-kesefle.com/account, התחבר עם Google ואז שלח שוב.';
      } else if (code === 404 && j && j.error === 'no_sheet') {
        return '😬 עדיין אין לך גיליון. כנס/י ל-kesefle.com/account להשלים את ההגדרה.';
      } else if (code === 409 && j && j.error === 'reauth_required') {
        return '🔑 צריך להתחבר מחדש: kesefle.com/account';
      } else {
        Logger.log('_addCategoryRows_ HTTP ' + code + ': ' + body.slice(0, 200));
        failed.push(name);
      }
    } catch (e) {
      Logger.log('_addCategoryRows_ threw on "' + name + '": ' + (e && e.message));
      failed.push(name);
    }
  }

  var lines = [];
  if (ok.length) {
    lines.push('✅ נוספו לגיליון *מאזן אישי*: ' + ok.map(function (n) { return emoji + ' ' + n; }).join(', '));
  }
  if (duplicates.length) {
    lines.push('ℹ️ כבר קיים: ' + duplicates.join(', '));
  }
  if (failed.length) {
    lines.push('😬 לא הצליח: ' + failed.join(', '));
  }
  if (ok.length) {
    lines.push('');
    lines.push('מעכשיו כל הוצאה שמזכירה את השם תיכנס לשורה הזאת אוטומטית.');
    lines.push('דוגמה: *200 דניאל בית ספר* → נוסף לדניאל.');
    if (sheetUrl) lines.push('📊 ' + sheetUrl);
  }
  return lines.join('\n');
}

// --- Survey state helpers (CacheService, 1h TTL — long enough for a user
// to finish, short enough to self-clean if abandoned). ---
var _SURVEY_TTL_SEC_ = 3600;
function _surveyStateKey_(fromPhone) {
  return 'survey_state:' + String(fromPhone).replace(/[^0-9]/g, '');
}
function _surveyGetState_(fromPhone) {
  try { return CacheService.getScriptCache().get(_surveyStateKey_(fromPhone)); }
  catch (_e) { return null; }
}
function _surveySetState_(fromPhone, state) {
  try { CacheService.getScriptCache().put(_surveyStateKey_(fromPhone), String(state), _SURVEY_TTL_SEC_); }
  catch (_e) {}
}
function _surveyClearState_(fromPhone) {
  try { CacheService.getScriptCache().remove(_surveyStateKey_(fromPhone)); }
  catch (_e) {}
}
// Remember the user's autoLog preference (chosen in Q3) so that recurring
// items added during the freeform step inherit it. Stored alongside state.
function _surveyAutoLogKey_(fromPhone) {
  return 'survey_autolog:' + String(fromPhone).replace(/[^0-9]/g, '');
}
function _surveyGetAutoLogPref_(fromPhone) {
  try { return CacheService.getScriptCache().get(_surveyAutoLogKey_(fromPhone)); }
  catch (_e) { return null; }
}
function _surveySetAutoLogPref_(fromPhone, pref) {
  try { CacheService.getScriptCache().put(_surveyAutoLogKey_(fromPhone), String(pref), _SURVEY_TTL_SEC_); }
  catch (_e) {}
}

// --- Interactive List sender for the questionnaire. Wraps the existing,
// proven low-level sender (sendWhatsAppInteractiveList) which already uses
// the right token / phoneId / Graph URL. Each row id is namespaced so the
// webhook can route the reply, e.g. q1_personal. `rows` =
// [{ id:'q1_personal', title:'...', description:'...' }, ...].
function _surveySendList_(fromPhone, bodyText, buttonText, rows, headerText) {
  var sections = [{ title: 'אפשרויות', rows: (rows || []).map(function(r) {
    return {
      id: String(r.id),
      title: String(r.title).slice(0, 24),
      description: r.description ? String(r.description).slice(0, 72) : '',
    };
  }) }];
  return sendWhatsAppInteractiveList(
    fromPhone,
    headerText || 'שאלון התאמה אישית',
    bodyText,
    'אפשר לשנות בכל עת עם *שאלון*',
    buttonText || 'בחר',
    sections
  );
}

// --- The three questions (each sends one interactive message). ---
function _surveySendQ1_(fromPhone) {
  _surveySetState_(fromPhone, 'q1');
  _surveySendList_(
    fromPhone,
    'מהו סוג המעקב העיקרי שלך?',
    'בחר סוג',
    [
      { id: 'q1_personal', title: 'אישי בלבד', description: 'מעקב על ההוצאות שלך' },
      { id: 'q1_family', title: 'משפחתי', description: 'הוצאות משק הבית' },
      { id: 'q1_group', title: 'שותפים/קבוצה', description: 'חלוקת הוצאות בקבוצה' },
      { id: 'q1_business', title: 'עסק קטן/עוסק פטור', description: 'הכנסות והוצאות עסקיות' },
    ]
  );
}
function _surveySendQ2_(fromPhone) {
  _surveySetState_(fromPhone, 'q2');
  // Yes/No → quick-reply buttons (cleaner than a list for 2 options).
  sendWhatsAppQuickButtons(fromPhone, 'האם יש לך הוצאות קבועות בכל חודש?', [
    { id: 'q2_yes', title: 'כן' },
    { id: 'q2_no', title: 'לא' },
  ]);
}
function _surveySendQ3_(fromPhone) {
  _surveySetState_(fromPhone, 'q3');
  sendWhatsAppQuickButtons(fromPhone, 'האם הבוט ירשום אוטומטית, או רק יתזכר?', [
    { id: 'q3_auto', title: 'רישום אוטומטי' },
    { id: 'q3_remind', title: 'תזכורת בלבד' },
  ]);
}

// --- Q4: profession picker. 9 popular Israeli professions + "other" tap.
// Each id matches lib/professions.js so /api/profile stores the same string
// the LLM classifier + sheet seeding will read later. Tapping "other" sets
// state=await_profession_freetext; the user types free text and we fuzzy
// match to the full 119-entry catalog server-side. Steven 2026-05-26.
//
// We embed (not import) the popular list because Apps Script has no ESM.
// If the lib/professions.js catalog drifts, only the human labels here can
// go stale — the ids are pure ASCII and the LLM boost still works as long
// as the id round-trips intact through /api/profile.
var _KESEFLE_POPULAR_PROFESSIONS_ = [
  { id: 'general_contractor',           he: 'קבלן בניין',          desc: 'שיפוצים, בנייה, פועלים' },
  { id: 'software_developer_freelance', he: 'מפתח/ת תוכנה',         desc: 'פרילנס, סטארטאפ, לפטופ' },
  { id: 'lawyer',                       he: 'עורך/ת דין',           desc: 'שכר טרחה, ייעוץ משפטי' },
  { id: 'accountant',                   he: 'רואה חשבון',           desc: 'חשבשבת, דוחות, מע״מ' },
  { id: 'private_tutor',                he: 'מורה פרטי/ת',          desc: 'שיעורים פרטיים, חוגים' },
  { id: 'hairstylist',                  he: 'מספרה / קוסמטיקה',     desc: 'מספרה, ציפורניים, איפור' },
  { id: 'taxi_driver',                  he: 'נהג מונית / גט',       desc: 'דלק, ביטוח רכב, gett' },
  { id: 'cashier',                      he: 'עובד/ת קופה',          desc: 'שכיר/ה בסופר/חנות' },
  { id: 'office_worker',                he: 'עובד/ת משרד',          desc: 'שכיר/ה במשרד / היי-טק' },
];

// Human-readable labels keyed by profession id, used by _surveyFinish_ for
// the closing summary so the user sees their pick spelled out in Hebrew.
var _KESEFLE_PROFESSION_HUMAN_ = (function () {
  var m = {};
  _KESEFLE_POPULAR_PROFESSIONS_.forEach(function (p) { m[p.id] = p.he; });
  // Extra labels for ids the fuzzy-matcher can return that aren't in the
  // quick-pick list (covers the most common "other" answers).
  m.private_tutor = 'מורה פרטי/ת';
  m.dentist = 'רופא/ת שיניים';
  m.doctor = 'רופא/ה';
  m.psychologist = 'פסיכולוג/ית';
  m.physiotherapist = 'פיזיותרפיסט/ית';
  m.architect = 'אדריכל/ית';
  m.electrician = 'חשמלאי/ת';
  m.plumber = 'אינסטלטור/ית';
  m.painter_construction = 'צבע/ית בניין';
  m.handyman = 'הנדימן';
  m.gardener = 'גנן/ית';
  m.cleaner = 'מנקה';
  m.babysitter = 'בייביסיטר/ית';
  m.dog_walker = 'מטייל/ת כלבים';
  m.veterinarian = 'וטרינר/ית';
  m.real_estate_agent = 'מתווך/ת';
  m.insurance_agent = 'סוכן/ת ביטוח';
  m.financial_advisor = 'יועץ/ת פיננסי/ת';
  m.translator = 'מתרגם/ת';
  m.copywriter = 'קופירייטר/ית';
  m.graphic_designer = 'מעצב/ת גרפי/ת';
  m.photographer = 'צלם/ת';
  m.videographer = 'צלם/ת וידאו';
  m.musician = 'מוזיקאי/ת';
  m.event_planner = 'מארגן/ת אירועים';
  m.makeup_artist = 'מאפר/ת';
  m.personal_trainer = 'מאמן/ת כושר';
  m.yoga_instructor = 'מורה ליוגה';
  m.nutritionist = 'דיאטן/ית';
  m.chef = 'שף/ית';
  m.caterer = 'קייטרינג';
  m.baker = 'אופה';
  m.restaurant_owner = 'בעל/ת מסעדה';
  m.cafe_owner = 'בעל/ת בית קפה';
  m.shop_owner = 'בעל/ת חנות';
  m.online_store = 'חנות אונליין';
  m.delivery_driver = 'שליח/ה';
  m.truck_driver = 'נהג/ת משאית';
  m.farmer = 'חקלאי/ת';
  m.fisherman = 'דייג/ית';
  m.uber_driver = 'נהג/ת אובר/יאנגו';
  m.other_employee = 'שכיר/ה אחר/ת';
  return m;
})();

function _surveySendQ4_(fromPhone) {
  _surveySetState_(fromPhone, 'q4');
  // 9 popular + 1 "other" = 10 rows, exactly at WhatsApp's interactive-list cap.
  var rows = _KESEFLE_POPULAR_PROFESSIONS_.map(function (p) {
    return { id: 'q4_' + p.id, title: p.he, description: p.desc };
  });
  rows.push({ id: 'q4_other', title: 'אחר / לא ברשימה', description: 'נכתוב את המקצוע ביד' });
  _surveySendList_(
    fromPhone,
    'מה המקצוע שלך? אתאים את הקטגוריות בגיליון.',
    'בחר מקצוע',
    rows,
    'שאלה אחרונה: המקצוע שלך'
  );
}

// Very small fuzzy matcher for the free-text "other" path. Returns a known
// profession id from lib/professions.js or null. We deliberately keep this
// list tight + Hebrew-first — the goal isn't to identify every profession
// in the world, it's to catch the 90% case so the user doesn't have to
// retype. Anything we don't recognize is saved as the raw cleaned text so
// the user at least sees their answer back; the LLM-boost path then
// degrades gracefully (no boost) instead of mis-classifying.
function _matchProfessionFromText_(text) {
  var t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  // Order matters: more specific first so "רופא שיניים" wins over "רופא".
  var rules = [
    { id: 'dentist',                       re: /רופא[ת]?\s*שיניים|שיניים|dentist/ },
    { id: 'veterinarian',                  re: /וטרינר|veterinar/ },
    { id: 'psychologist',                  re: /פסיכולוג|psycholog/ },
    { id: 'physiotherapist',               re: /פיזיותרפ|פיזיו|physiother/ },
    { id: 'doctor',                        re: /^רופא|רופאה|רופא\s|doctor|physician|md\b/ },
    { id: 'architect',                     re: /אדריכל|architect/ },
    { id: 'electrician',                   re: /חשמלאי|electrician/ },
    { id: 'plumber',                       re: /אינסטל|plumber/ },
    { id: 'painter_construction',          re: /צבעי|painter/ },
    { id: 'handyman',                      re: /הנדימן|handyman/ },
    { id: 'gardener',                      re: /גנן|gardener|landscape/ },
    { id: 'cleaner',                       re: /מנקה|ניקיון|cleaner|cleaning/ },
    { id: 'babysitter',                    re: /בייביסיטר|מטפל[ת]?\s*ילד|babysitter|nanny/ },
    { id: 'dog_walker',                    re: /מטייל\s*כלב|dog\s*walk/ },
    // Final-form Hebrew letters (ן ם ך ף ץ) only appear at word-end. When the
    // user types a plural or feminine form ("קבלנים", "דיאטנית"), the same
    // root letter shows up in its NON-final form (נ ם כ פ צ). Patterns that
    // need to catch both use a char class like [ןנ] to match either form.
    // Hebrew abbreviations use either ASCII " or the gershayim ״ (U+05F4);
    // patterns that include them use ["״] to accept both. Steven 2026-05-26.
    { id: 'real_estate_agent',             re: /מתווך|נדל["״]?[ןנ]|real\s*estate|realtor/ },
    { id: 'insurance_agent',               re: /סוכן\s*ביטוח|insurance\s*agent/ },
    { id: 'financial_advisor',             re: /יועץ\s*(פיננס|כספ|השקע)|financial\s*advisor/ },
    { id: 'translator',                    re: /מתרגם|תרגום|translator/ },
    { id: 'copywriter',                    re: /קופירייטר|copywriter|content\s*writer/ },
    { id: 'graphic_designer',              re: /מעצב\s*גרפ|graphic\s*design/ },
    { id: 'photographer',                  re: /צלם|photograph/ },
    { id: 'videographer',                  re: /צלם\s*וידא|videograph|video\s*editor/ },
    { id: 'musician',                      re: /מוזיקאי|נג[ןנ]|musician/ },
    { id: 'event_planner',                 re: /אירוע|הפקת\s*אירוע|event\s*plan|wedding\s*plan/ },
    { id: 'makeup_artist',                 re: /מאפר|makeup/ },
    { id: 'personal_trainer',              re: /מאמ[ןנ]\s*כושר|כושר\s*אישי|personal\s*train/ },
    { id: 'yoga_instructor',               re: /יוגה|yoga|pilates|פילאטיס/ },
    { id: 'nutritionist',                  re: /דיאט[ןנ]|תזונאי|nutrition|dietitian/ },
    { id: 'chef',                          re: /^שף|chef/ },
    { id: 'caterer',                       re: /קייטרינג|cater/ },
    { id: 'baker',                         re: /אופה|מאפי|baker|bakery/ },
    { id: 'restaurant_owner',              re: /מסעדה|מסעד[ןנ]|restaurant/ },
    { id: 'cafe_owner',                    re: /בית\s*קפה|בריסטה|barista|cafe|coffee\s*shop/ },
    { id: 'shop_owner',                    re: /בעל[ת]?\s*חנות|חנות\s*קטנה|shop\s*owner/ },
    { id: 'online_store',                  re: /חנות\s*אונליין|איקומרס|ecommerce|e-?commerce|shopify/ },
    { id: 'delivery_driver',               re: /שליח|wolt|10bis|delivery/ },
    { id: 'truck_driver',                  re: /נהג\s*משאית|משאית|truck\s*driver/ },
    { id: 'taxi_driver',                   re: /מונית|gett|נהג|taxi|uber|אובר|יאנגו|yango/ },
    { id: 'farmer',                        re: /חקלאי|חקלאות|farmer|farm/ },
    { id: 'fisherman',                     re: /דייג|fisher/ },
    { id: 'general_contractor',            re: /קבל[ןנ]|שיפוצ|בנייה|construction|contractor/ },
    { id: 'software_developer_freelance',  re: /מפתח|תוכנה|software|developer|programmer|engineer|מתכנת|פולסטאק|fullstack|backend|frontend/ },
    { id: 'lawyer',                        re: /עו["״]?ד|עורך\s*די[ןנ]|עורכת\s*די[ןנ]|lawyer|attorney|legal/ },
    { id: 'accountant',                    re: /רו["״]?ח|רואה\s*חשבו[ןנ]|חשבונאי|accountant|cpa\b/ },
    { id: 'private_tutor',                 re: /מורה\s*פרטי|מורה\s*פרטית|מורה|tutor|teacher/ },
    { id: 'hairstylist',                   re: /מספרה|ספר|ספרית|hairdresser|hairstyl|barber|קוסמטיקה|cosmetic|ציפורניים|manicure/ },
    { id: 'cashier',                       re: /קופאי|קופה|cashier/ },
    { id: 'office_worker',                 re: /משרד|פקיד|office|admin\b|administrative/ },
  ];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].re.test(t)) return rules[i].id;
  }
  return null;
}

// Lifestyle Q after kids: car. If yes, creates a dedicated "רכב" dashboard
// row so the user sees their car spend (fuel + parking + maintenance) at
// a glance. Steven 2026-05-24.
function _surveySendCarQuestion_(fromPhone) {
  _surveySetState_(fromPhone, 'await_car_button');
  try {
    sendWhatsAppQuickButtons(fromPhone, '🚗 יש לך רכב? (אם כן, אוסיף שורה ייעודית לדלק/חניה/אחזקה)', [
      { id: 'q_car_yes', title: 'כן' },
      { id: 'q_car_no',  title: 'אין' },
    ]);
  } catch (_e) { Logger.log('car question send err: ' + (_e && _e.message)); }
}

// Public entry: start the questionnaire at Q1.
function _surveyStart_(fromPhone) {
  _surveySendQ1_(fromPhone);
}

// Map a q1_* id to the trackingType value persisted server-side.
var _SURVEY_TRACKING_ = {
  q1_personal: 'personal', q1_family: 'family',
  q1_group: 'group', q1_business: 'business',
};
var _SURVEY_TRACKING_HUMAN_ = {
  personal: 'אישי בלבד', family: 'משפחתי',
  group: 'שותפים/קבוצה', business: 'עסק קטן/עוסק פטור',
};
// One-line nudges fed to the LLM categorizer based on how the customer said
// they track money (from the onboarding questionnaire). English on purpose —
// the model's system prompt is English. Used ONLY to break ties on ambiguous
// expenses; clear vendor matches never reach the LLM.
var _SURVEY_TRACKING_AI_HINT_ = {
  personal: 'This person tracks PERSONAL spending. Lean toward everyday personal categories (אוכל, תחבורה, קניות, בידור, בריאות).',
  family: 'This person tracks a FAMILY/household budget. Expect household items — ילדים, חינוך, אוכל לבית, הוצאות קבועות (ועד בית, חשמל, מים).',
  group: 'This person tracks SHARED/GROUP expenses split among people. Expect group outings and events — בידור (יציאות, אירועים), אוכל בחוץ.',
  business: 'This person runs a small BUSINESS / עוסק. When an expense could be personal OR business, prefer the business category עסק (חומרי גלם, ציוד עסקי, שיווק, תוכנות עסק, יועצים) and treat income as עצמאי.',
};

// Cached read of a customer's trackingType (profile:{phone}) so the LLM hint
// costs at most one network call per hour per phone. Guarded everywhere: any
// failure returns '' and the categorizer behaves exactly as before.
function _profileTrackingTypeCached_(fromPhone) {
  if (!fromPhone) return '';
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  if (!clean) return '';
  var cacheKey = 'profileTT:' + clean;
  try {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(cacheKey);
    if (hit !== null) return hit === '_none_' ? '' : hit;
    var tt = '';
    try {
      if (typeof _profileAPI_ === 'function') {
        var g = _profileAPI_('get', { phone: clean });
        if (g && g.ok && g.profile && g.profile.trackingType) tt = String(g.profile.trackingType);
      }
    } catch (_apiErr) { Logger.log('_profileTrackingTypeCached_ api err: ' + _apiErr.message); }
    cache.put(cacheKey, tt || '_none_', _SURVEY_TTL_SEC_);
    return tt;
  } catch (_cErr) {
    Logger.log('_profileTrackingTypeCached_ err: ' + _cErr.message);
    return '';
  }
}

// === Gemini conversational layer ("concierge") =======================
// Makes the bot UNDERSTAND free-form messages and reply personally instead of
// a generic "didn't understand". Degrades gracefully: if GEMINI_API_KEY is not
// set in Script Properties (or the call fails), this returns null and callers
// keep their existing reply. Model is configurable via GEMINI_MODEL.
var _KFL_GEMINI_LAST_ERR = '';
function _geminiGenerate_(systemPrompt, userText) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) { _KFL_GEMINI_LAST_ERR = 'no_api_key'; return null; }
    // Try several models so a model-name mismatch (the most common failure)
    // self-heals. A configured GEMINI_MODEL is tried first.
    var models = [];
    var configured = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
    if (configured) models.push(configured);
    ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'].forEach(function (m) {
      if (models.indexOf(m) < 0) models.push(m);
    });
    var payload = JSON.stringify({
      systemInstruction: { parts: [{ text: String(systemPrompt || '') }] },
      contents: [{ role: 'user', parts: [{ text: String(userText || '').slice(0, 1000) }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 400 }
    });
    for (var i = 0; i < models.length; i++) {
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[i]) + ':generateContent?key=' + encodeURIComponent(apiKey);
      var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      if (code === 200) {
        var body = JSON.parse(resp.getContentText());
        var cand = body && body.candidates && body.candidates[0];
        var txt = cand && cand.content && cand.content.parts && cand.content.parts[0] && cand.content.parts[0].text;
        if (txt) { _KFL_GEMINI_LAST_ERR = ''; return String(txt); }
        _KFL_GEMINI_LAST_ERR = models[i] + ': 200 but no text (safety block?)';
        continue;
      }
      _KFL_GEMINI_LAST_ERR = models[i] + ' → HTTP ' + code + ': ' + String(resp.getContentText() || '').replace(/\s+/g, ' ').slice(0, 160);
      Logger.log('_geminiGenerate_ ' + _KFL_GEMINI_LAST_ERR);
    }
    return null;
  } catch (e) {
    _KFL_GEMINI_LAST_ERR = 'exception: ' + (e && e.message);
    Logger.log('_geminiGenerate_ err: ' + (e && e.message));
    return null;
  }
}

// Compact, REAL spending context for a tenant so the concierge can answer
// personally ("הוצאת החודש כ-₪X, בעיקר על Y") instead of generically. Pulls
// from /api/sheet/stats (bot-secret, read-only), cached 10 min per phone.
// Owner is skipped (uses the full summary command); any failure returns ''.
function _spendingContextLine_(fromPhone) {
  try {
    if (!fromPhone) return '';
    if (typeof _isOwnerPhone_ === 'function' && _isOwnerPhone_(fromPhone)) return '';
    var clean = String(fromPhone).replace(/[^0-9]/g, '');
    if (!clean) return '';
    var cacheKey = 'spendctx:' + clean;
    var cache = CacheService.getScriptCache();
    var hit = cache.get(cacheKey);
    if (hit !== null) return hit === '_none_' ? '' : hit;
    var secret = '';
    try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
    if (!secret) return '';
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/stats', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({ phone: clean, botSecret: secret }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) { cache.put(cacheKey, '_none_', 600); return ''; }
    var j = JSON.parse(resp.getContentText());
    if (!j || !j.ok || !j.thisMonth) { cache.put(cacheKey, '_none_', 600); return ''; }
    var tm = j.thisMonth, lm = j.lastMonth || {};
    var line = 'נתוני אמת של המשתמש לחודש הנוכחי (השתמשי בהם כדי לענות אישית, אל תמציאי מספרים): ' +
      'סך הוצאות כ-₪' + (tm.total || 0) + ' ב-' + (tm.count || 0) + ' תנועות';
    if (tm.topCategory) line += ', קטגוריה מובילה: ' + tm.topCategory + ' (₪' + (tm.topCategoryAmount || 0) + ')';
    if (typeof lm.total === 'number') line += '. חודש קודם: ₪' + lm.total;
    line += '.';
    cache.put(cacheKey, line, 600);
    return line;
  } catch (e) { Logger.log('_spendingContextLine_ err: ' + (e && e.message)); return ''; }
}

// Understand a message that is NOT a logged expense and decide how to respond.
// Returns { action: 'summary'|'help'|'examples'|'orders'|'chat', reply } or
// null when Gemini is unavailable (caller then uses its own fallback).
function _botConcierge_(fromPhone, text) {
  var tt = '';
  try { tt = _profileTrackingTypeCached_(fromPhone) || ''; } catch (_e) {}
  var who = (typeof _SURVEY_TRACKING_HUMAN_ !== 'undefined' && _SURVEY_TRACKING_HUMAN_[tt]) || '';
  var spend = '';
  try { spend = _spendingContextLine_(fromPhone) || ''; } catch (_spe) {}
  var sys =
    'את כספ\'לה — עוזרת פיננסית חכמה וחמה בעברית בתוך וואטסאפ. ' +
    'המשתמש כתב הודעה שאינה רישום הוצאה. הביני מה הוא רוצה ותגיבי בעברית, קצר וחם (מתאים לוואטסאפ), בלי להיות גנרית. ' +
    (who ? ('המשתמש סימן שהוא עוקב אחרי כספים מסוג: ' + who + ' — התאימי את הטון.\n') : '') +
    (spend ? (spend + ' אם המשתמש שואל כמה הוציא/על מה — עני מהנתונים האלה (action=chat), אל תמציאי.\n') : '') +
    'מה הבוט יודע לעשות: לרשום הוצאות (כמו "150 סופר"), לתת סיכום חודשי, עזרה, דוגמאות, וסיכום הזמנות לעסקים. ' +
    'החזירי אך ורק JSON תקין, בלי טקסט נוסף: ' +
    '{"action":"summary|help|examples|orders|chat","reply":"<טקסט בעברית רק כש-action הוא chat, אחרת מחרוזת ריקה>"}. ' +
    'כללי החלטה: בקשת סיכום/יתרה/כמה הוצאתי/מצב → summary. בקשת עזרה/מה אפשר לעשות → help. בקשת דוגמאות → examples. ' +
    'סיכום הזמנות/לקוחות/מחזור → orders. כל שאלה/בקשה/שיחה אחרת (למשל "אפשר להוסיף קטגוריה?") → chat, ' +
    'וב-reply תני תשובה אמיתית, אישית ומועילה — לא משפט גנרי.';
  var raw = _geminiGenerate_(sys, text);
  if (!raw) return null;
  var m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return { action: 'chat', reply: String(raw).slice(0, 600) };
  try {
    var p = JSON.parse(m[0]);
    var action = String(p.action || 'chat').trim();
    return { action: action, reply: String(p.reply || '').slice(0, 600) };
  } catch (_pe) {
    return { action: 'chat', reply: String(raw).slice(0, 600) };
  }
}

// ============================================================
// Deterministic data-query path: pattern-match common Hebrew
// questions ("how much did I spend this week", "what is my
// biggest expense this month", etc.) and answer with REAL
// numbers from the user's sheet via /api/sheet/bot-query.
//
// Runs BEFORE the Gemini money-coach so we don't pay for an
// LLM call AND we don't hallucinate a number. Premium-only
// (free users get an upgrade nudge). Returns:
//   { ok: true,  reply: '...' }  -- matched + answered
//   { ok: false, reason: '...' } -- no pattern matched OR API failed
// On any return value where ok!==true the caller falls through
// to the existing Gemini concierge -> coach -> generic chain.
// ============================================================
function _botQueryAnswer_(fromPhone, rawText) {
  if (!fromPhone || !rawText) return { ok: false, reason: 'no_input' };
  var text = String(rawText).trim();
  if (text.length < 4) return { ok: false, reason: 'too_short' };

  // Owner is always premium; for everyone else, gate on the cached
  // /api/whatsapp/link plan field via _hasActivePremium_. We must run
  // the regex match FIRST so a free user who clearly asked a data
  // question gets the upgrade nudge -- not the generic "didn't
  // understand" reply at the very bottom.
  var matched = _botQueryMatchPattern_(text);
  if (!matched) return { ok: false, reason: 'no_pattern' };

  var isPremium = false;
  try { isPremium = !!_hasActivePremium_(fromPhone); } catch (_pe) {}
  if (!isPremium) {
    return { ok: true, reply:
      'שאלות חופשיות על הכסף שלך זמינות במסלול Pro.\n' +
      'שדרוג ב-' + KESEFLE_API_BASE.replace(/^https?:\/\//, '') + '/pricing'
    };
  }

  // Call the bridge. Lazy try/catch on EVERYTHING so a bot-query
  // outage never crashes the bot -- we fall through to Gemini.
  var apiResp = null;
  try { apiResp = _botQueryCall_(fromPhone, matched); }
  catch (_ce) { Logger.log('_botQueryCall_ err: ' + (_ce && _ce.message)); }
  if (!apiResp || !apiResp.ok) return { ok: false, reason: 'api_failed' };

  // Format the reply per queryType. Hebrew, friendly, with a tip.
  var reply = _botQueryFormatReply_(matched, apiResp);
  if (!reply) return { ok: false, reason: 'format_failed' };
  return { ok: true, reply: reply };
}

// Match user text against 7 question shapes. Conservative: ONLY
// fires on clear question patterns (question word + topic) so an
// expense entry like "150 על מזון" doesn't false-positive into
// a data query.
function _botQueryMatchPattern_(text) {
  // Normalize lightweight: trim + collapse whitespace. Preserve
  // Hebrew chars verbatim (no transliteration).
  var t = String(text).trim().replace(/\s+/g, ' ');

  // 1. Comparison vs last month: "השוואה לחודש שעבר", "השווה לחודש שעבר"
  if (/(?:השוואה|השווה|השוו|בהשוואה)[^?!.]{0,20}(?:לחודש שעבר|חודש שעבר|קודם)/.test(t)) {
    return { queryType: 'comparison', period: 'month' };
  }

  // 2. Largest expense (this month / week): MUST have a question-word
  // shape, not a bare phrase. "ההוצאה הכי גדולה החודש?"
  if (/(?:ההוצאה|הוצאה|מה ההוצאה).{0,12}(?:הכי גדולה|הגדולה ביותר|גבוהה ביותר|הכי גבוהה)/.test(t)
      || /מה(?:י)?\s+(?:ההוצאה|הוצאה)\s+(?:הכי גדולה|הגדולה|הגבוהה)/.test(t)) {
    var perLg = /השבוע/.test(t) ? 'week' : (/החודש שעבר|חודש שעבר/.test(t) ? 'last_month' : 'month');
    return { queryType: 'largest', period: perLg };
  }

  // 3. Income this month: "כמה משכורת קיבלתי החודש", "כמה הכנסות החודש"
  if (/(?:כמה|איך|מה)[^?!.]{0,30}(?:משכורת|הכנסה|הכנסות|רווח|רווחים|הכנסנו|הרווחתי|קיבלתי)/.test(t)) {
    var perInc = /השבוע/.test(t) ? 'week' : (/השנה/.test(t) ? 'year' : (/החודש שעבר|חודש שעבר/.test(t) ? 'last_month' : 'month'));
    return { queryType: 'income', period: perInc };
  }

  // 4. Top categories: "איפה הוצאתי הכי הרבה", "על מה הכי הרבה כסף"
  if (/(?:איפה|במה|על מה)[^?!.]{0,20}(?:הכי הרבה|הוצאתי הכי|המוצא|הרבה כסף)/.test(t)
      || /(?:הקטגוריות|קטגוריות)[^?!.]{0,12}(?:המובילות|העיקריות|הכי גדולות)/.test(t)) {
    var perTop = /השבוע/.test(t) ? 'week' : (/השנה/.test(t) ? 'year' : 'month');
    return { queryType: 'top_categories', period: perTop };
  }

  // 5. Spend on a specific category: "כמה הוצאתי על מזון השבוע?"
  //    "כמה הוצאתי על דלק החודש". The "על X" makes this unambiguous.
  var catM = t.match(/כמה[^?!.]{0,15}(?:הוצאתי|בזבזתי|שילמתי|הוצאנו)[^?!.]{0,5}על\s+([֐-׿A-Za-z'׳"\-\s]{2,30}?)(?:\s+(?:השבוע|השבוע הזה|החודש|החודש הזה|השנה|חודש שעבר|החודש שעבר))?\s*[?!.]*\s*$/);
  if (catM) {
    var cat = catM[1].trim().replace(/[\s,]+$/, '');
    var perCat = /השבוע/.test(t) ? 'week' : (/השנה/.test(t) ? 'year' : (/החודש שעבר|חודש שעבר/.test(t) ? 'last_month' : 'month'));
    return { queryType: 'category', period: perCat, category: cat };
  }

  // 6. Total this week: "כמה הוצאתי השבוע?"
  if (/(?:כמה)[^?!.]{0,15}(?:הוצאתי|בזבזתי|שילמתי|הוצאנו)[^?!.]{0,15}(?:השבוע|השבוע הזה)\s*[?!.]*\s*$/.test(t)) {
    return { queryType: 'total', period: 'week' };
  }

  // 7. Total this month: "כמה הוצאתי החודש?" / "כמה הוצאתי בסך הכל החודש"
  if (/(?:כמה)[^?!.]{0,15}(?:הוצאתי|בזבזתי|שילמתי|הוצאנו)[^?!.]{0,25}(?:החודש|החודש הזה|בסך הכל|בסה"כ)\s*[?!.]*\s*$/.test(t)
      || /^\s*(?:סך הכל|סה"כ|סך הכל החודש|כמה הוצאתי)\s*[?!.]*\s*$/.test(t)) {
    var perTot = /חודש שעבר|החודש שעבר/.test(t) ? 'last_month' : 'month';
    return { queryType: 'total', period: perTot };
  }

  // 8. Total last month: explicit "כמה הוצאתי חודש שעבר?"
  if (/(?:כמה)[^?!.]{0,15}(?:הוצאתי|בזבזתי|שילמתי)[^?!.]{0,15}(?:חודש שעבר|בחודש שעבר|חודש קודם)\s*[?!.]*\s*$/.test(t)) {
    return { queryType: 'total', period: 'last_month' };
  }

  return null;
}

// POST to /api/sheet/bot-query with the bot secret + match params.
// Returns parsed JSON or null on any failure.
function _botQueryCall_(fromPhone, match) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
  if (!secret) return null;
  var payload = {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    queryType: match.queryType,
    period: match.period || 'month',
    botSecret: secret,
  };
  if (match.category) payload.category = match.category;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/bot-query', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) return null;
    return JSON.parse(resp.getContentText());
  } catch (e) {
    Logger.log('_botQueryCall_ throw: ' + (e && e.message));
    return null;
  }
}

// Format the bot-query JSON response into a friendly Hebrew reply.
function _botQueryFormatReply_(match, j) {
  var fmt = function(n) { return '₪' + Number(n || 0).toLocaleString('he-IL'); };
  var periodLabel = j.periodLabel || (
    match.period === 'week' ? 'השבוע' :
    match.period === 'last_month' ? 'חודש שעבר' :
    match.period === 'year' ? 'השנה' : 'החודש'
  );

  if (match.queryType === 'total') {
    if (!j.total && !j.count) {
      return 'לא רשמת הוצאות ' + periodLabel + ' עדיין.\nתכתוב הוצאה כמו "150 סופר" ונתחיל לעקוב.';
    }
    var line = 'הוצאת ' + fmt(j.total) + ' ' + periodLabel + ' (' + j.count + ' תנועות).';
    if (j.breakdown && j.breakdown.length) {
      line += '\nהקטגוריה המובילה: ' + j.breakdown[0].label + ' (' + fmt(j.breakdown[0].amount) + ')';
    }
    return line;
  }

  if (match.queryType === 'category') {
    if (!j.count) {
      return 'לא מצאתי הוצאות על "' + (match.category || '') + '" ' + periodLabel + '.\n' +
             'אולי הקטגוריה רשומה בשם אחר? תכתוב "סיכום" לראות הכל.';
    }
    var catLine = 'הוצאת ' + fmt(j.total) + ' על ' + (match.category || j.matchedCategory || '') + ' ' + periodLabel + ' (' + j.count + ' תנועות).';
    if (j.breakdown && j.breakdown.length && j.breakdown.length > 1) {
      catLine += '\nהאחרונות:';
      for (var k = 0; k < Math.min(3, j.breakdown.length); k++) {
        catLine += '\n  - ' + j.breakdown[k].label + ' ' + fmt(j.breakdown[k].amount);
      }
    }
    return catLine;
  }

  if (match.queryType === 'largest') {
    if (!j.breakdown || !j.breakdown.length) {
      return 'אין הוצאות רשומות ' + periodLabel + '.';
    }
    var top = j.breakdown[0];
    var largeLine = 'ההוצאה הגדולה ' + periodLabel + ':\n' +
      fmt(top.amount) + ' - ' + (top.label || top.category || 'הוצאה');
    if (top.category && top.label && top.label !== top.category) {
      largeLine += ' (' + top.category + ')';
    }
    return largeLine;
  }

  if (match.queryType === 'income') {
    if (!j.count) {
      return 'לא רשמת הכנסות ' + periodLabel + '.\nכתוב "8500 משכורת" ואני אוסיף.';
    }
    var incLine = 'הכנסת ' + fmt(j.total) + ' ' + periodLabel + ' (' + j.count + ' תנועות).';
    if (j.breakdown && j.breakdown.length) {
      incLine += '\nמקור עיקרי: ' + j.breakdown[0].label + ' (' + fmt(j.breakdown[0].amount) + ')';
    }
    return incLine;
  }

  if (match.queryType === 'comparison') {
    var cmp = j.comparison || {};
    var prev = cmp.prev_total || 0;
    var pct = cmp.pct;
    if (!prev && !j.total) {
      return 'אין מספיק נתונים להשוואה - כתוב כמה הוצאות ונחזור לזה.';
    }
    var arrow = pct === null ? '' : (pct > 0 ? 'יותר' : (pct < 0 ? 'פחות' : 'אותו דבר'));
    var cmpLine = 'החודש: ' + fmt(j.total) + '\nחודש שעבר: ' + fmt(prev);
    if (pct !== null && pct !== undefined) {
      cmpLine += '\n' + (pct > 0 ? '+' : '') + pct + '% (' + arrow + ')';
    }
    return cmpLine;
  }

  if (match.queryType === 'top_categories') {
    if (!j.breakdown || !j.breakdown.length) {
      return 'אין הוצאות רשומות ' + periodLabel + '.';
    }
    var topLine = 'הקטגוריות הגדולות ' + periodLabel + ':';
    for (var i = 0; i < Math.min(5, j.breakdown.length); i++) {
      topLine += '\n' + (i + 1) + '. ' + j.breakdown[i].label + ' - ' + fmt(j.breakdown[i].amount);
    }
    topLine += '\n\nסך הכל: ' + fmt(j.total);
    return topLine;
  }

  return null;
}

// Build + send the closing profile summary, then clear state.
function _surveyFinish_(fromPhone) {
  var pref = _surveyGetAutoLogPref_(fromPhone);
  var prof = null;
  try {
    var g = _profileAPI_('get', { phone: String(fromPhone).replace(/[^0-9]/g, '') });
    if (g && g.ok) prof = g.profile;
  } catch (_e) {}
  prof = prof || {};
  var trackingHuman = _SURVEY_TRACKING_HUMAN_[prof.trackingType] || '—';
  var recurringHuman = (prof.hasRecurring === true) ? 'כן' : (prof.hasRecurring === false ? 'לא' : '—');
  var autoLog = prof.autoLogPref || pref;
  var autoLogHuman = (autoLog === 'auto') ? 'רישום אוטומטי מלא' : (autoLog === 'remind' ? 'תזכורת בלבד' : '—');
  var professionHuman = prof.profession
    ? (_KESEFLE_PROFESSION_HUMAN_[prof.profession] || prof.profession)
    : '—';
  var msg =
    '✅ *סיימנו! זה הפרופיל שלך:*\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    '• סוג מעקב: ' + trackingHuman + '\n' +
    '• הוצאות קבועות: ' + recurringHuman + '\n' +
    '• אופן הרישום: ' + autoLogHuman + '\n' +
    '• מקצוע: ' + professionHuman + '\n\n' +
    'אפשר לשנות בכל עת עם הפקודה *שאלון*';
  try { sendWhatsAppMessage(fromPhone, msg); } catch (_e) {}
  _surveyClearState_(fromPhone);
  try { CacheService.getScriptCache().remove(_surveyAutoLogKey_(fromPhone)); } catch (_e) {}
}

// Route an interactive reply id (q1_*/q2_*/q3_*) through the flow. Returns
// { replyText } when a TEXT follow-up is needed, or null when the step
// already sent its own interactive/text message (so the caller sends
// nothing more). Called from handleInteractiveReply_.
function _surveyHandleInteractive_(fromPhone, picked) {
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  // --- Q1: tracking type ---
  if (_SURVEY_TRACKING_.hasOwnProperty(picked)) {
    var tt = _SURVEY_TRACKING_[picked];
    _profileAPI_('set', { phone: clean, fields: { trackingType: tt } });
    // For family / group trackers we ask about kids' names FIRST -- if they
    // give names we'll create one dashboard row per child (real work, not
    // fake). Anyone else jumps straight to Q2. Steven's request 2026-05-24.
    if (tt === 'family' || tt === 'group') {
      _surveySetState_(fromPhone, 'await_kids_freeform');
      try {
        sendWhatsAppMessage(
          fromPhone,
          'נחמד! 👨‍👩‍👧 יש לך ילדים? אם כן — מה השמות שלהם?\n' +
          'לדוגמה: דניאל, מיכל, יואב\n' +
          'אצור לכל ילד שורה משלו בגיליון *מאזן אישי*, כדי שתראה כמה הוצאת על כל אחד.\n\n' +
          'אם אין, כתוב *דלג* או *לא*.'
        );
      } catch (_kqErr) { Logger.log('kids question send err: ' + (_kqErr && _kqErr.message)); }
      return null;
    }
    _surveySendQ2_(fromPhone);
    return null;
  }
  // --- Q2: has recurring? ---
  if (picked === 'q2_no') {
    _profileAPI_('set', { phone: clean, fields: { hasRecurring: false } });
    _surveySendQ3_(fromPhone);
    return null;
  }
  if (picked === 'q2_yes') {
    _profileAPI_('set', { phone: clean, fields: { hasRecurring: true } });
    _surveySetState_(fromPhone, 'await_recurring_freeform');
    return { replyText: 'אילו הוצאות קבועות יש לך? (לדוגמה: 2500 שכירות, 400 ארנונה, 99 נטפליקס)' };
  }
  // --- Pets follow-up (after kids step) ---
  if (picked === 'q_pets_dog' || picked === 'q_pets_cat' || picked === 'q_pets_no') {
    if (picked !== 'q_pets_no') {
      // Create a dedicated row for the pet so the user sees how much they
      // spend on it per month (food, vet, grooming).
      var petName = (picked === 'q_pets_dog') ? 'כלב' : 'חתול';
      try {
        var pr = _addCategoryRows_(fromPhone, petName);
        if (pr) sendWhatsAppMessage(fromPhone, pr);
      } catch (_pErr) { Logger.log('pets row create err: ' + (_pErr && _pErr.message)); }
    }
    _surveySendCarQuestion_(fromPhone);
    return null;
  }
  // --- Car follow-up ---
  if (picked === 'q_car_yes' || picked === 'q_car_no') {
    if (picked === 'q_car_yes') {
      try {
        var cr = _addCategoryRows_(fromPhone, 'רכב');
        if (cr) sendWhatsAppMessage(fromPhone, cr);
      } catch (_cErr) { Logger.log('car row create err: ' + (_cErr && _cErr.message)); }
    }
    _surveySendQ2_(fromPhone);
    return null;
  }
  // --- Q3: auto-log preference ---
  if (picked === 'q3_auto' || picked === 'q3_remind') {
    var pref = (picked === 'q3_auto') ? 'auto' : 'remind';
    _profileAPI_('set', { phone: clean, fields: { autoLogPref: pref } });
    _surveySetAutoLogPref_(fromPhone, pref);
    // Steven 2026-05-26: Q4 added so the bot learns the user's profession --
    // drives the LLM classifier boost + (PR #11) profession-tailored sheet rows.
    _surveySendQ4_(fromPhone);
    return null;
  }
  // --- Q4: profession picker. Quick-pick ids look like "q4_<profession_id>";
  // "q4_other" routes to free-text capture. We persist the id (not the
  // Hebrew label) because lib/professions.js + the LLM-boost path key on
  // the snake_case id.
  if (typeof picked === 'string' && picked.indexOf('q4_') === 0) {
    if (picked === 'q4_other') {
      _surveySetState_(fromPhone, 'await_profession_freetext');
      return { replyText: 'איזה מקצוע? כתוב חופשי -- לדוגמה: רופא שיניים, מעצב גרפי, וטרינר. אם אין מקצוע מובהק כתוב *דלג*.' };
    }
    var pid = picked.slice(3); // strip "q4_"
    if (/^[a-z0-9_]{1,64}$/.test(pid)) {
      _profileAPI_('set', { phone: clean, fields: { profession: pid } });
    }
    _surveyFinish_(fromPhone);
    return null;
  }
  return null;
}

// Handle the free-text recurring step + the survey/confirm commands. Runs
// from doPost BEFORE the expense parser (so digit-leading freeform text
// like an "amount + description" list isn't logged as a single expense).
// Returns { handled, replyText } — handled=false means "not a survey msg,
// continue normal routing".
function _surveyHandleText_(fromPhone, text) {
  var t = String(text || '').trim();
  if (!t) return { handled: false };
  var clean = String(fromPhone).replace(/[^0-9]/g, '');

  // Commands that (re)start the questionnaire.
  if (t === 'שאלון' || t === 'הגדרות מתקדמות') {
    _surveyStart_(fromPhone);
    return { handled: true };
  }

  // Confirm command (exact) — confirms a pending recurring reminder that the
  // cron sent when autoLog=false. Endpoint returns { ok, logged|null }.
  if (t === 'אשר') {
    var r = _recurringAPI_('confirm', { phone: clean });
    if (!r || !r.ok) return { handled: true, replyText: '😬 שגיאה: ' + (r && r.error || 'unknown') };
    if (!r.logged) return { handled: true, replyText: 'אין מה לאשר כרגע.' };
    return { handled: true, replyText: '✅ נרשם: ' + _money_(r.logged.amount) + ' ' + (r.logged.description || '') };
  }

  // Free-text kids capture (only while the survey is in that step). Steven's
  // request 2026-05-24: if the family-tracker user gives names, REALLY create
  // a row per child in מאזן אישי -- don't fake it. "דלג"/"לא"/"אין" skip.
  // Then chain into the pets question, which can also create real rows.
  if (_surveyGetState_(fromPhone) === 'await_kids_freeform') {
    if (!/^(?:דלג|לא|אין|skip|no)\s*$/i.test(t)) {
      var reply = _addCategoryRows_(fromPhone, t);
      try { sendWhatsAppMessage(fromPhone, reply); } catch (_e) {}
    } else {
      try { sendWhatsAppMessage(fromPhone, 'בסדר, ממשיכים. 👍'); } catch (_e) {}
    }
    // Advance to pets — quick yes/no, dog/cat pickable.
    _surveySetState_(fromPhone, 'await_pets_yesno');
    try {
      sendWhatsAppQuickButtons(fromPhone, '🐶 יש בבית חיית מחמד? (אם כן, אוסיף שורה ייעודית למזון/וטרינר)', [
        { id: 'q_pets_dog',   title: 'כלב' },
        { id: 'q_pets_cat',   title: 'חתול' },
        { id: 'q_pets_no',    title: 'אין' },
      ]);
    } catch (_pqErr) { Logger.log('pets question send err: ' + (_pqErr && _pqErr.message)); }
    return { handled: true };
  }

  // Q4 free-text path: user picked "אחר / לא ברשימה" on the profession picker
  // and is now typing the profession by hand. We fuzzy-match to a known id
  // when possible (so the LLM-boost path can use it) and fall back to the
  // raw cleaned text so the user at least sees their answer back. Either
  // way we close the survey afterwards. Steven 2026-05-26.
  if (_surveyGetState_(fromPhone) === 'await_profession_freetext') {
    if (/^(?:דלג|לא|אין|skip|no)\s*$/i.test(t)) {
      try { sendWhatsAppMessage(fromPhone, 'אין בעיה -- אפשר להוסיף מקצוע מאוחר יותר עם הפקודה *שאלון*.'); } catch (_e) {}
      _surveyFinish_(fromPhone);
      return { handled: true };
    }
    var matchedId = _matchProfessionFromText_(t);
    if (matchedId) {
      _profileAPI_('set', { phone: clean, fields: { profession: matchedId } });
      var humanLabel = _KESEFLE_PROFESSION_HUMAN_[matchedId] || matchedId;
      try { sendWhatsAppMessage(fromPhone, 'אוקיי, סימנתי אותך כ-*' + humanLabel + '*. 👍'); } catch (_e) {}
    } else {
      // Unrecognised. We still save the cleaned text under a synthetic id so
      // /api/profile keeps a record (max 60 chars, ASCII-safe slug). The
      // LLM-boost path won't find keywords for this id and gracefully
      // skips the boost.
      var slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'custom';
      // Profile API regex is /^[a-z0-9_]{1,64}$/ -- guard against empty.
      if (/^[a-z0-9_]{1,64}$/.test(slug)) {
        _profileAPI_('set', { phone: clean, fields: { profession: slug } });
      }
      try { sendWhatsAppMessage(fromPhone, 'תודה! שמרתי את *' + t.slice(0, 60) + '* כמקצוע. 👍'); } catch (_e) {}
    }
    _surveyFinish_(fromPhone);
    return { handled: true };
  }

  // Free-text custom-row capture from pets/car follow-up steps (typed text,
  // not button). Rare path — user might just type "כלב + שם" instead of
  // tapping the button. Fall through to category-row creation either way.
  if (_surveyGetState_(fromPhone) === 'await_pets_freeform' ||
      _surveyGetState_(fromPhone) === 'await_car_freeform') {
    if (!/^(?:דלג|לא|אין|skip|no)\s*$/i.test(t)) {
      var reply2 = _addCategoryRows_(fromPhone, t);
      try { sendWhatsAppMessage(fromPhone, reply2); } catch (_e) {}
    }
    // Move on to next step.
    if (_surveyGetState_(fromPhone) === 'await_pets_freeform') {
      _surveySendCarQuestion_(fromPhone);
    } else {
      _surveySendQ2_(fromPhone);
    }
    return { handled: true };
  }

  // Free-text recurring capture (only while the survey is in that step).
  if (_surveyGetState_(fromPhone) === 'await_recurring_freeform') {
    var prefRaw = _surveyGetAutoLogPref_(fromPhone);
    // autoLog defaults to true unless Q3 already set 'remind'.
    var autoLog = (prefRaw === 'remind') ? false : true;
    var items = t.split(',');
    var added = 0;
    var skipped = 0;
    for (var i = 0; i < items.length; i++) {
      var piece = items[i].trim();
      if (!piece) continue;
      var parsed = _parseRecurringCommand_(piece);
      if (!parsed || !parsed.amount) { skipped++; continue; }
      var payload = {
        phone: clean,
        amount: parsed.amount,
        description: parsed.description || 'הוצאה קבועה',
        freq: parsed.freq,
        autoLog: autoLog,
      };
      if (parsed.category) payload.category = parsed.category;
      if (parsed.startDate) payload.startDate = parsed.startDate;
      var ar = _recurringAPI_('add', payload);
      if (ar && ar.ok) added++; else skipped++;
    }
    var summary = added > 0
      ? ('🔁 נרשמו ' + added + ' הוצאות קבועות.' + (skipped ? ' (' + skipped + ' לא זוהו)' : ''))
      : ('😕 לא הצלחתי לזהות הוצאות קבועות מההודעה.' + (skipped ? '' : ''));
    try { sendWhatsAppMessage(fromPhone, summary); } catch (_e) {}
    // Continue to Q3 regardless (state advances inside _surveySendQ3_).
    _surveySendQ3_(fromPhone);
    return { handled: true };
  }

  return { handled: false };
}

// Daily cron — asks the Vercel API to scan ALL users' templates and log
// anything due today. Authorized by the cron secret (not the bot secret),
// mirroring cronBillReminders. Install via installRecurringExpensesTrigger().
function cronRecurringExpenses() {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) {
    Logger.log('cronRecurringExpenses: KESEFLE_BOT_SECRET not set');
    return;
  }
  var cronSecret = '';
  try { cronSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_CRON_SECRET') || ''); } catch (_e) {}
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/recurring', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-kesefle-bot-secret': secret,
        'x-kesefle-cron-secret': cronSecret,
      },
      payload: JSON.stringify({ action: 'cron', botSecret: secret, cronSecret: cronSecret }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('cronRecurringExpenses HTTP ' + code + ': ' + body.slice(0, 200));
      return;
    }
    Logger.log('cronRecurringExpenses OK: ' + body.slice(0, 200));
  } catch (e) {
    Logger.log('cronRecurringExpenses threw: ' + (e && e.message));
  }
}

// Install the daily recurring-expense cron (~08:00 Israel). Run once.
function installRecurringExpensesTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronRecurringExpenses') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronRecurringExpenses').timeBased().atHour(8).everyDays(1).create();
  Logger.log('✅ cronRecurringExpenses installed: daily @ 08:00');
}

function _groupInfo_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה כרגע. שלח "כספלה צור <שם>" או "כספלה הצטרף <קוד>".' };
  }
  var g = a.group;
  var lines = [];
  lines.push('📋 *' + g.name + '* — קוד ' + g.code);
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('חברים (' + g.members.length + '):');
  g.members.forEach(function(m){ lines.push('  • ' + m.name); });
  lines.push('');
  lines.push('הוצאות נרשמו: ' + ((g.expenses || []).length));
  return { handled: true, replyText: lines.join('\n') };
}

function _groupRecordExpense_(fromPhone, body) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה כרגע. שלח "כספלה צור <שם>" או "כספלה הצטרף <קוד>".' };
  }
  // Parse amount + description from the body. Reuse the bot's existing
  // Israeli-format number parser so "1,200" works correctly.
  var parsed = (typeof parseAmountAndDescription === 'function') ? parseAmountAndDescription(body) : null;
  if (!parsed || !parsed.items || !parsed.items.length) {
    return { handled: true, replyText: '😬 לא זיהיתי סכום. דוגמה: "כספלה 245 סופר"' };
  }
  var first = parsed.items[0];
  var matched = null;
  try { matched = typeof matchCategory === 'function' ? matchCategory(body) : null; } catch (_) {}
  var category = (matched && matched.category) || '';
  var subcategory = (matched && matched.subcategory && matched.subcategory !== matched.category) ? matched.subcategory : '';

  var senderName = _groupSenderName_(fromPhone);
  var r = _groupAPI_('addexpense', {
    code: a.active,
    payerPhone: fromPhone,
    requesterPhone: fromPhone,
    payerName: senderName,
    amount: first.amount,
    description: first.description,
    category: category,
    subcategory: subcategory,
    splitMode: 'equal',
  });
  if (!r || !r.ok) {
    if (r && r.error === 'not_a_member') {
      return { handled: true, replyText: '😬 אתה לא חבר בקבוצה הזאת. שלח "כספלה הצטרף <קוד>" קודם.' };
    }
    return { handled: true, replyText: '😬 כתיבת ההוצאה נכשלה: ' + (r && r.error || 'unknown') };
  }
  var perShare = (first.amount / (r.memberCount || 1)).toFixed(2);
  return { handled: true, replyText:
    '✅ נרשם: ₪' + first.amount.toLocaleString('he-IL') + ' · ' + (first.description || category || 'הוצאה') + '\n' +
    '👤 שולם ע"י: ' + senderName + '\n' +
    '👥 פיצול שווה בין ' + r.memberCount + ' חברים (₪' + perShare + ' כל אחד)' };
}

function _groupBalances_(fromPhone, mode) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה. שלח "כספלה צור" או "כספלה הצטרף <קוד>".' };
  }
  var b = _groupAPI_('balances', { code: a.active, requesterPhone: fromPhone });
  if (!b || !b.ok) return { handled: true, replyText: '😬 שגיאה בקריאת היתרות.' };
  if (!b.totalExpenses) return { handled: true, replyText: 'אין הוצאות עדיין בקבוצה. שלח "כספלה 245 סופר" כדי להתחיל.' };

  var lines = [];
  if (mode !== 'settle') {
    lines.push('📊 *יתרות (' + a.active + ')*');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('');
    b.balances.forEach(function(m){
      var arrow = m.net > 0 ? '🟢' : (m.net < 0 ? '🔴' : '⚪');
      var verb = m.net > 0 ? 'מקבל' : (m.net < 0 ? 'חייב' : 'מאוזן');
      var amt = Math.abs(m.net).toLocaleString('he-IL');
      lines.push('  ' + arrow + ' ' + m.name + ': ' + verb + ' ₪' + amt);
    });
    lines.push('');
  }
  if (b.settlements && b.settlements.length) {
    lines.push('💸 *העברות מומלצות:*');
    b.settlements.forEach(function(t){
      lines.push('  ' + t.fromName + ' → ' + t.toName + '  ₪' + t.amount.toLocaleString('he-IL'));
    });
  } else {
    lines.push('✅ הקבוצה מאוזנת — אין צורך בהעברות.');
  }
  return { handled: true, replyText: lines.join('\n') };
}

function _groupRecent_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה. שלח "כספלה צור" או "כספלה הצטרף <קוד>".' };
  }
  var r = _groupAPI_('recent', { code: a.active, limit: 10, requesterPhone: fromPhone });
  if (!r || !r.ok) return { handled: true, replyText: '😬 שגיאה בקריאת ההוצאות.' };
  if (!r.expenses || !r.expenses.length) return { handled: true, replyText: 'אין הוצאות עדיין.' };
  var lines = ['🕒 *הוצאות אחרונות:*', ''];
  r.expenses.forEach(function(e){
    var when = e.timestamp ? e.timestamp.slice(5, 10).replace('-', '/') : '?';
    lines.push('  ' + when + ' · ' + e.payerName + ' · ₪' + e.amount.toLocaleString('he-IL') + ' · ' + (e.description || e.category || ''));
  });
  return { handled: true, replyText: lines.join('\n') };
}

function _groupAddMember_(fromPhone, rest) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה. שלח "כספלה צור".' };
  }
  // Accept "name 972XXX" or just "972XXX". Phone must be present.
  var m = rest.match(/(\+?\d[\d\-\s]{6,15})/);
  if (!m) return { handled: true, replyText: '😬 צריך מספר טלפון. דוגמה: "כספלה הוסף יוסי 972526003090"' };
  var phone = m[1].replace(/\D+/g, '');
  var name = rest.replace(m[0], '').trim() || phone;
  var r = _groupAPI_('addmember', { code: a.active, phone: phone, name: name, requesterPhone: fromPhone });
  if (!r || !r.ok) return { handled: true, replyText: '😬 הוספה נכשלה: ' + (r && r.error || 'unknown') };
  return { handled: true, replyText: '✅ הוסף ' + name + ' (' + r.members + ' חברים בסה"כ).' };
}

function _groupRemoveMember_(fromPhone, rest) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) {
    return { handled: true, replyText: 'אתה לא בקבוצה.' };
  }
  var m = rest.match(/(\+?\d[\d\-\s]{6,15})/);
  if (!m) return { handled: true, replyText: '😬 ציין מספר טלפון של החבר להסרה.' };
  var phone = m[1].replace(/\D+/g, '');
  var r = _groupAPI_('removemember', { code: a.active, phone: phone, requesterPhone: fromPhone });
  if (!r || !r.ok) return { handled: true, replyText: '😬 הסרה נכשלה.' };
  return { handled: true, replyText: '🗑 הוסר מהקבוצה (' + r.members + ' חברים נותרו).' };
}

function _groupUndo_(fromPhone) {
  var a = _groupAPI_('getactive', { phone: fromPhone });
  if (!a || !a.ok || !a.active) return { handled: true, replyText: 'אתה לא בקבוצה.' };
  var r = _groupAPI_('undo', { code: a.active, requesterPhone: fromPhone });
  if (!r || !r.ok) {
    if (r && r.error === 'only_payer_or_creator_can_undo') {
      return { handled: true, replyText: '😬 רק מי ששילם או מי שיצר את הקבוצה יכול לבטל את ההוצאה האחרונה.' };
    }
    return { handled: true, replyText: '😬 ביטול נכשל.' };
  }
  if (!r.removed) return { handled: true, replyText: 'אין הוצאות לביטול.' };
  var e = r.removed;
  return { handled: true, replyText: '🗑 בוטלה: ₪' + Number(e.amount).toLocaleString('he-IL') + ' · ' + (e.description || '') };
}

// Read the user's WhatsApp profile name from the most-recent message
// metadata if Apps Script saved one (it doesn't by default — falls back
// to phone). Future: thread the `profile.name` from doPost into here.
function _groupSenderName_(fromPhone) {
  try {
    var saved = PropertiesService.getScriptProperties().getProperty('profileName:' + fromPhone);
    if (saved) return saved;
  } catch (_e) {}
  return String(fromPhone);
}

// ─────────────────────────────────────────────────────────────────────
// Multi-tenant helpers
//
// The Apps Script bot was originally written as a single-tenant tool
// against a hardcoded SHEET_ID. The Kesefle web/backend, however, lets
// any Google user provision their OWN sheet via /api/sheet/provision,
// and the WhatsApp number that maps them is stored in Vercel KV. We
// don't have to throw out the rich Apps Script parser to support that
// — we just have to route the WRITE step to the right tenant.
//
// _resolveTenant_ tells us whether the inbound sender is:
//   { isOwner: true }                          — Steven (script owner), legacy path
//   { isOwner: false, userRecord: {...} }      — Registered Kesefle tenant
//   { isOwner: false, userRecord: null }       — Unregistered phone, needs onboarding
//
// _tenantWriteExpense_ does the rich parse + a POST to /api/sheet/append
// which decrypts the user's refresh token, exchanges for an access
// token, and appends to THEIR Google Sheet.
// ─────────────────────────────────────────────────────────────────────
// The configured owner phone (digits only). SHEET_OWNER_PHONE Script
// Property wins; otherwise the hardcoded OWNER_PHONE constant (which is
// tied to the hardcoded SHEET_ID). NEVER returns empty — an empty owner
// was the root of the cross-tenant leak.
function _ownerPhoneDigits_() {
  var p = '';
  try { p = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || ''); } catch (_e) {}
  p = p.replace(/[^0-9]/g, '');
  return p || OWNER_PHONE;
}

// Single source of truth: is this inbound sender the script owner?
// An empty/unknown sender is NEVER the owner.
function _isOwnerPhone_(fromPhone) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return false;
  return clean === _ownerPhoneDigits_();
}

// Defense-in-depth. Call IMMEDIATELY before any legacy write to SHEET_ID
// that was triggered by an inbound message. Returns true only if the
// sender is the owner (or there is NO sender — a trusted internal/cron/
// debug context with no tenant to mis-route to). On a real non-owner
// sender it logs + alerts the owner + returns false, so the caller aborts.
// This guarantees no cross-tenant write even if upstream routing regresses.
function _assertOwnerLegacyWrite_(fromPhone, ctx) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return true;                       // internal/cron/debug — no inbound sender
  if (clean === _ownerPhoneDigits_()) return true;
  try { Logger.log('🚨 BLOCKED non-owner legacy write [' + (ctx || '?') + '] from ' + clean + ' → SHEET_ID'); } catch (_l) {}
  try { _adminAlertOnce_('🚨 חסמתי כתיבה של מספר לא מוכר (' + clean + ') לגיליון שלך [' + (ctx || '') + ']. בדוק את קישור המספרים.', clean); } catch (_a) {}
  return false;
}

function _resolveTenant_(fromPhone) {
  if (!fromPhone) return null;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  // 1. Script owner — ONLY the configured/known owner phone takes the
  //    legacy single-tenant path that writes to the hardcoded SHEET_ID.
  //    (Previously, an unset SHEET_OWNER_PHONE returned {isOwner:true} for
  //    EVERYONE — that was the cross-tenant data leak. Now fixed: unknown
  //    senders fall through to the KV tenant lookup / onboarding below.)
  if (_isOwnerPhone_(clean)) return { isOwner: true };
  // 2. Lookup the tenant in Kesefle KV via /api/whatsapp/link?phone=
  var rec = _kvLookupPhone_(clean);
  if (rec && rec.linked && rec.userSub) {
    return { isOwner: false, userRecord: rec };
  }
  return { isOwner: false, userRecord: null };
}

function _kvLookupPhone_(phoneClean) {
  try {
    var url = KESEFLE_API_BASE + '/api/whatsapp/link?phone=' + encodeURIComponent(phoneClean);
    // Present the bot secret so the server returns the full record (userSub +
    // sheetId + effective plan for _hasActivePremium_ gating). Without it,
    // the server returns only { linked } to prevent directory enumeration.
    // ALSO present our build version so the Vercel side can warn the admin
    // if the deployed bot is stale (drift detector at /api/admin/bot-version).
    var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '';
    var headers = { 'x-kesefle-bot-version': KFL_BUILD_VERSION };
    if (botSecret) headers['x-kesefle-bot-secret'] = botSecret;
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: headers });
    if (resp.getResponseCode() !== 200) return null;
    var j = JSON.parse(resp.getContentText());
    return j && j.ok ? j : null;
  } catch (e) {
    Logger.log('_kvLookupPhone_ err: ' + (e && e.message));
    return null;
  }
}

// Fetch a tenant's month-to-date total for a given category. Best-effort;
// returns '' on any failure so the caller can omit the line cleanly.
// Calls /api/sheet/bot-query (already exists) with queryType=category,
// caches the answer per (phone, category) for 5 min so a chatty user
// who logs five "סופר" expenses doesn't hit the API five times.
function _tenantCategoryMtdLine_(fromPhone, category) {
  try {
    if (!fromPhone || !category) return '';
    var clean = String(fromPhone).replace(/[^0-9]/g, '');
    if (!clean) return '';
    var cache = CacheService.getScriptCache();
    var cacheKey = 'catMtd:' + clean + ':' + category;
    var cached = cache.get(cacheKey);
    if (cached !== null) return cached === '_none_' ? '' : cached;
    var secret = '';
    try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
    if (!secret) return '';
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/bot-query', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({
        phone: clean,
        queryType: 'category',
        period: 'month',
        category: category,
        botSecret: secret,
      }),
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) { cache.put(cacheKey, '_none_', 300); return ''; }
    var j = JSON.parse(resp.getContentText() || '{}');
    if (!j || !j.ok || !j.count) { cache.put(cacheKey, '_none_', 300); return ''; }
    var line = '📊 סה"כ ' + category + ' החודש: ₪' + Number(j.total || 0).toLocaleString('he-IL');
    cache.put(cacheKey, line, 300);
    return line;
  } catch (e) {
    Logger.log('_tenantCategoryMtdLine_ err: ' + (e && e.message));
    return '';
  }
}

// Send the "change category" interactive list AFTER an expense was logged.
// Steven 2026-05-24: every confirmation should expose a one-tap way to
// re-classify if the bot got it wrong. Six top-level Pa'amonim groups +
// "אחר" so we stay under the 10-row WhatsApp list cap.
function _sendChangeCategoryPicker_(fromPhone, currentCategory) {
  try {
    if (!fromPhone) return;
    // Six common top-level options + "אחר" = 7 rows, well under the cap.
    var TOP_CATEGORIES = [
      { name: 'אוכל',     icon: '🍞' },
      { name: 'תחבורה',   icon: '🚗' },
      { name: 'קניות',    icon: '🛍' },
      { name: 'בידור',    icon: '🎬' },
      { name: 'הוצאות קבועות', icon: '🏠' },
      { name: 'בריאות',   icon: '💊' },
      { name: 'אחר',      icon: '✨' },
    ];
    var rows = [];
    for (var i = 0; i < TOP_CATEGORIES.length; i++) {
      var c = TOP_CATEGORIES[i];
      // Skip the row that matches the current pick to avoid wasted taps.
      if (c.name === currentCategory) continue;
      rows.push({
        id: 'relabel|' + c.name,
        title: (c.icon + ' ' + c.name).slice(0, 24),
        description: '',
      });
    }
    if (!rows.length) return;
    sendWhatsAppInteractiveList(
      fromPhone,
      'לשנות קטגוריה?',
      'הבוט בחר *' + currentCategory + '*. אפשר לבחור אחרת:',
      'אפשר להתעלם — הרישום נשמר',
      'בחר',
      [{ title: 'קטגוריות אחרות', rows: rows }]
    );
  } catch (e) { Logger.log('_sendChangeCategoryPicker_ err: ' + (e && e.message)); }
}

// Handle a tap on a row from _sendChangeCategoryPicker_. Called from
// handleInteractiveReply_. Looks up lastTenantExp, POSTs to the new
// /api/sheet/relabel-row endpoint, returns a reply confirming the change.
function _handleRelabelTap_(fromPhone, newCategory) {
  if (!fromPhone || !newCategory) return null;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  var cache = CacheService.getScriptCache();
  var last = null;
  try {
    var raw = cache.get('lastTenantExp:' + clean);
    if (raw) last = JSON.parse(raw);
  } catch (_e) {}
  if (!last || !last.rowIndex) {
    return { replyText: '🤔 לא מצאתי הוצאה אחרונה לשנות. שלח את ההוצאה שוב, ואז תוכל לבחור קטגוריה.' };
  }
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
  if (!secret) return { replyText: '😬 שגיאת קונפיגורציה זמנית.' };
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/relabel-row', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({
        phone: clean,
        rowIndex: last.rowIndex,
        newCategory: newCategory,
        newSubcategory: '',
        botSecret: secret,
      }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      // Invalidate the MTD cache for both old and new category so the next
      // expense in either reflects the move.
      try {
        cache.remove('catMtd:' + clean + ':' + last.category);
        cache.remove('catMtd:' + clean + ':' + newCategory);
      } catch (_ce) {}
      // Update lastExp so a re-tap on the picker still works.
      try {
        last.category = newCategory;
        last.subcategory = '';
        cache.put('lastTenantExp:' + clean, JSON.stringify(last), 1800);
      } catch (_pe) {}
      // Steven 2026-05-25: TEACH the bot from every tap. Without this the
      // user retags the same expense over and over and the bot never learns.
      // _learnedSave with 'user-correction' source auto-publishes to the
      // global cross-tenant store too, so EVERY tenant tap improves the
      // classifier for EVERY future user typing the same description.
      try {
        if (typeof _learnedSave === 'function' && last.description) {
          _learnedSave(last.description, { category: newCategory, subcategory: '' }, 'user-correction');
        }
      } catch (_lsErr) { Logger.log('_handleRelabelTap_ learnedSave err: ' + (_lsErr && _lsErr.message)); }
      return { replyText: '✅ עברה ל-' + newCategory + ' (ולמדתי — בפעם הבאה אזהה לבד). השורה בגיליון מעודכנת.' };
    }
    Logger.log('_handleRelabelTap_ HTTP ' + code + ' ' + resp.getContentText().slice(0, 200));
    return { replyText: '😬 לא הצלחתי לעדכן את השורה (' + code + '). נסה/י דרך הגיליון ישירות.' };
  } catch (e) {
    Logger.log('_handleRelabelTap_ threw: ' + (e && e.message));
    return { replyText: '😬 בעיה בחיבור לשרת.' };
  }
}

// Installments detector (2026-05-25 Steven): match "N תשלומים [של Y]" /
// "ב-N תשלומים" / "N payments of Y" / "split into N". Returns
// { count, perPayment, productName } or null if no installment pattern.
function _detectInstallments_(rawText, totalAmount) {
  if (!rawText || !totalAmount) return null;
  var t = String(rawText).trim();
  // Pattern A: "5 תשלומים של 200" / "10 תשלומים של 100 ש"ח"
  var m = t.match(/(\d{1,3})\s*תשלומים\s*של\s*(\d{1,7})/);
  if (m) {
    var nA = parseInt(m[1], 10);
    var perA = parseFloat(m[2]);
    if (nA >= 2 && nA <= 60 && perA > 0) {
      return { count: nA, perPayment: perA, productName: _extractProductName_(t, m[0]) };
    }
  }
  // Pattern B: "5 תשלומים" / "ב-10 תשלומים" / "10 תשלום" — N is the count,
  // per-payment = total / N. Most natural Hebrew phrasing.
  m = t.match(/(?:ב[\-\s]?)?(\d{1,3})\s*תשלומים?\b/);
  if (m) {
    var nB = parseInt(m[1], 10);
    if (nB >= 2 && nB <= 60) {
      var perB = Math.round((totalAmount / nB) * 100) / 100;
      return { count: nB, perPayment: perB, productName: _extractProductName_(t, m[0]) };
    }
  }
  // Pattern C (English): "5 payments of 200" / "split into 10 payments"
  m = t.match(/(\d{1,3})\s*payments?\s*of\s*(\d{1,7})/i);
  if (m) {
    var nC = parseInt(m[1], 10);
    var perC = parseFloat(m[2]);
    if (nC >= 2 && nC <= 60 && perC > 0) {
      return { count: nC, perPayment: perC, productName: _extractProductName_(t, m[0]) };
    }
  }
  return null;
}

// Strip the amount + installments phrase + currency tokens so the
// product name (e.g. "ספה", "laptop") is what remains.
function _extractProductName_(rawText, installmentsPhrase) {
  var s = String(rawText || '');
  if (installmentsPhrase) s = s.replace(installmentsPhrase, ' ');
  s = s.replace(/(?:^|\s)\d+(?:[.,]\d+)?(?:\s|$)/g, ' ');
  s = s.replace(/(?:ש["׳']?ח|שקל|ש"ח|ils|ש)/gi, ' ');
  s = s.replace(/(?:קניתי|שילמתי|רכשתי|הזמנתי|לקחתי|bought|paid)/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || 'הוצאה בתשלומים';
}

// Register an installments plan as a recurring monthly expense. Calls
// /api/recurring (action=add) so the plan rides the existing daily cron
// that writes one row per due month. We also stash the plan in
// CacheService so "תשלומים" command can list remaining counts.
function _setupInstallmentsRecurring_(fromPhone, botSecret, inst, category, subcategory, rawText, startISOArg) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  var label = (inst.productName || 'הוצאה בתשלומים') + ' (' + inst.count + ' תשלומים)';
  // Use the user-picked startDate when provided (Steven 2026-05-25 — was
  // hardcoded to today, which is wrong for credit-card charges that hit
  // on 1/2/10/15 of the month). Fallback: today.
  var startISO = startISOArg || new Date().toISOString().slice(0, 10);
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/recurring', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify({
        action: 'add',
        botSecret: botSecret,
        phone: clean,
        amount: inst.perPayment,
        description: label,
        category: category || 'אחר',
        subcategory: subcategory || '',
        freq: 'monthly',
        autoLog: true,
        startDate: startISO,
        installments: { total: inst.count, remaining: inst.count, productName: inst.productName },
      }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('_setupInstallmentsRecurring_ http=' + code + ' ' + resp.getContentText().slice(0, 200));
      return { reply:
        '😬 לא הצלחתי לרשום את תשלומי הקבע. נסה/י שוב או הקלד את ההוצאה בלי "תשלומים".'
      };
    }
    // Local cache so "תשלומים" command can show without hitting KV.
    try {
      var cache = CacheService.getScriptCache();
      var listKey = 'installments:' + clean;
      var existing = [];
      var raw = cache.get(listKey);
      if (raw) { try { existing = JSON.parse(raw); } catch (_) { existing = []; } }
      existing.push({
        product: inst.productName,
        per: inst.perPayment,
        total: inst.count,
        remaining: inst.count,
        startedAt: Date.now(),
      });
      cache.put(listKey, JSON.stringify(existing), 60 * 60 * 24 * 30);  // 30d
    } catch (_ce) {}
    var per = '₪' + Number(inst.perPayment).toLocaleString('he-IL');
    // Pretty-print the start date for the user (DD/MM/YYYY) — startISO is ISO.
    var startDateDisplay;
    try {
      var d0 = new Date(startISO);
      startDateDisplay = d0.getDate() + '/' + (d0.getMonth() + 1) + '/' + d0.getFullYear();
    } catch (_) { startDateDisplay = startISO; }
    return { reply:
      '💳 *תשלומים נקלטו*\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🛍 ' + (inst.productName || 'הוצאה') + '\n' +
      '💰 ' + inst.count + ' × ' + per + ' = ₪' + Number(inst.perPayment * inst.count).toLocaleString('he-IL') + '\n' +
      '📅 חיוב ראשון: ' + startDateDisplay + ', מתחדש כל חודש באותו יום\n' +
      '🔁 ייכנס לגיליון אוטומטית בכל חודש\n\n' +
      'לראות תשלומים פעילים: כתוב *תשלומים*\n' +
      'לבטל: כתוב *בטל תשלומים ' + (inst.productName || 'אחרון') + '*'
    };
  } catch (e) {
    Logger.log('_setupInstallmentsRecurring_ threw: ' + (e && e.message));
    return { reply: '😬 בעיה זמנית בחיבור. נסה/י שוב בעוד דקה.' };
  }
}

// Steven 2026-05-25: ask the user when the credit-card charges hit BEFORE
// setting up the recurring. Israeli credit cards typically charge on the
// 1st, 2nd, 10th, or 15th of each month — defaulting to today produces
// wrong dates. Cache the pending installment + send quick buttons.
function _askInstallmentsStartDate_(fromPhone, inst, category, subcategory, rawText) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return { reply: '😬 לא הצלחתי לזהות את המספר שלך.' };
  // Stash everything we need to complete the setup once the user answers.
  try {
    var cache = CacheService.getScriptCache();
    cache.put('installPending:' + clean, JSON.stringify({
      inst: inst, category: category, subcategory: subcategory,
      rawText: rawText, at: Date.now(),
    }), 1800); // 30 min TTL
  } catch (_e) { Logger.log('_askInstallmentsStartDate_ cache err: ' + (_e && _e.message)); }

  // Quick-reply buttons for the 4 most common card-charge days. WhatsApp
  // caps reply buttons at 3, so use a list. Today = "now" escape hatch.
  try {
    sendWhatsAppInteractiveList(
      fromPhone,
      'מתי החיוב הראשון?',
      '💳 *' + inst.count + ' תשלומים של ₪' + Number(inst.perPayment).toLocaleString('he-IL') + '*\n' +
      'בכרטיסי אשראי בישראל החיוב יורד בדרך כלל ב-1, 2, 10 או 15 לחודש.\n\n' +
      'בחר את היום של החיוב הראשון:',
      'או הקלד יום (1-31) או תאריך מלא (DD/MM/YYYY)',
      'בחר',
      [{
        title: 'יום בחודש',
        rows: [
          { id: 'installday|1',     title: '1 לחודש',  description: 'חיוב ב-1 של החודש הבא' },
          { id: 'installday|2',     title: '2 לחודש',  description: 'חיוב ב-2 של החודש הבא' },
          { id: 'installday|10',    title: '10 לחודש', description: 'חיוב ב-10 של החודש הבא' },
          { id: 'installday|15',    title: '15 לחודש', description: 'חיוב ב-15 של החודש הבא' },
          { id: 'installday|today', title: 'היום',     description: 'התשלום הראשון יוצא היום' },
        ],
      }]
    );
  } catch (_sErr) { Logger.log('_askInstallmentsStartDate_ send err: ' + (_sErr && _sErr.message)); }
  return { reply: '' }; // the picker IS the reply
}

// Build the ISO startDate for next month's payment on a given day-of-month.
// E.g. today is 25/05/2026, dayOfMonth=10 → 10/06/2026 (next 10th).
// If the requested day already passed this month, jump to next month; if it
// hasn't passed yet, use this month so the user doesn't wait a full cycle.
function _computeNextChargeDate_(dayOfMonth) {
  var n = parseInt(dayOfMonth, 10);
  if (!n || n < 1 || n > 31) return null;
  var now = new Date();
  var thisMonth = new Date(now.getFullYear(), now.getMonth(), n);
  var targetDate = (thisMonth.getDate() === n && thisMonth >= now)
    ? thisMonth
    : new Date(now.getFullYear(), now.getMonth() + 1, n);
  // Clamp if day overflows (e.g. 31 → Feb has 28); JS Date already handles
  // overflow by rolling forward but we want the user's intent — use the
  // last day of the target month.
  if (targetDate.getDate() !== n) {
    targetDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 0);
  }
  return targetDate.toISOString().slice(0, 10);
}

// Handle the day-pick from the interactive list. Format: "installday|<day>".
// Wired into handleInteractiveReply_.
function _handleInstallmentsDayPick_(fromPhone, dayValue) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return { replyText: '😬 לא הצלחתי לזהות את המספר שלך.' };
  var cache = CacheService.getScriptCache();
  var raw = cache.get('installPending:' + clean);
  if (!raw) {
    return { replyText: '🤔 לא מצאתי תשלומים שמחכים לתאריך. שלח שוב את ההוצאה.' };
  }
  var pending;
  try { pending = JSON.parse(raw); } catch (_) { return { replyText: '😬 שגיאה בקריאה.' }; }
  cache.remove('installPending:' + clean);

  var startISO;
  if (String(dayValue).toLowerCase() === 'today') {
    startISO = new Date().toISOString().slice(0, 10);
  } else {
    startISO = _computeNextChargeDate_(dayValue);
    if (!startISO) return { replyText: '😬 יום לא תקין (1-31). שלח שוב את ההוצאה.' };
  }
  var botSecret = '';
  try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
  if (!botSecret) return { replyText: '😬 שגיאת קונפיגורציה.' };

  // Call the underlying recurring setup with the chosen startDate. We pass
  // a custom inst object so the existing setup function reuses its logic
  // (single source of truth for the recurring registration + cache).
  var r = _setupInstallmentsRecurring_(fromPhone, botSecret, pending.inst,
    pending.category, pending.subcategory, pending.rawText, startISO);
  return { replyText: (r && r.reply) || '✅ נרשם.' };
}

// Free-text fallback: user types a day number (1-31) or a date DD/MM/YYYY
// instead of tapping the picker. Returns { handled, reply } or null.
function _maybeHandleInstallmentsFreeText_(fromPhone, text) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return null;
  var raw = null;
  try { raw = CacheService.getScriptCache().get('installPending:' + clean); } catch (_) {}
  if (!raw) return null;
  var t = String(text || '').trim();
  // Day number 1-31
  var m = t.match(/^(\d{1,2})$/);
  if (m) {
    var d = parseInt(m[1], 10);
    if (d >= 1 && d <= 31) {
      var r = _handleInstallmentsDayPick_(fromPhone, String(d));
      return { handled: true, reply: r.replyText };
    }
  }
  // Full date DD/MM/YYYY (or D/M/YYYY)
  m = t.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
  if (m) {
    var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yy >= 2020 && yy <= 2099) {
      var dateObj = new Date(yy, mm - 1, dd);
      var startISO = dateObj.toISOString().slice(0, 10);
      var cache = CacheService.getScriptCache();
      var pendRaw = cache.get('installPending:' + clean);
      cache.remove('installPending:' + clean);
      if (!pendRaw) return null;
      var pending;
      try { pending = JSON.parse(pendRaw); } catch (_) { return null; }
      var botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '');
      if (!botSecret) return { handled: true, reply: '😬 שגיאת קונפיגורציה.' };
      var rr = _setupInstallmentsRecurring_(fromPhone, botSecret, pending.inst,
        pending.category, pending.subcategory, pending.rawText, startISO);
      return { handled: true, reply: (rr && rr.reply) || '✅ נרשם.' };
    }
  }
  // "היום" / "today"
  if (/^(היום|today)$/i.test(t)) {
    var r2 = _handleInstallmentsDayPick_(fromPhone, 'today');
    return { handled: true, reply: r2.replyText };
  }
  return null;
}

// "תשלומים" command — list active installment plans with remaining count.
function _listInstallments_(fromPhone) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return '😬 לא הצלחתי לזהות את המספר שלך.';
  var cache = CacheService.getScriptCache();
  var raw = cache.get('installments:' + clean);
  var list = [];
  if (raw) { try { list = JSON.parse(raw); } catch (_) { list = []; } }
  // Filter out finished (remaining 0).
  list = list.filter(function (p) { return p && p.remaining > 0; });
  if (!list.length) {
    return '📭 אין תשלומים פעילים כרגע.\n\nלפתיחת תשלומים — כתוב את ההוצאה עם מספר תשלומים, למשל:\n*ספה 1000 שקל 5 תשלומים*';
  }
  var lines = ['💳 *תשלומים פעילים*', '━━━━━━━━━━━━━━━━━━'];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    var per = '₪' + Number(p.per).toLocaleString('he-IL');
    lines.push('');
    lines.push((i + 1) + '. *' + (p.product || 'הוצאה') + '*');
    lines.push('   ' + p.remaining + '/' + p.total + ' תשלומים נותרו · ' + per + ' לחודש');
    lines.push('   נותר לשלם: ₪' + Number(p.remaining * p.per).toLocaleString('he-IL'));
  }
  lines.push('');
  lines.push('לביטול תשלום: *בטל תשלומים <שם המוצר>*');
  return lines.join('\n');
}

// Steven 2026-05-25: instead of silently dumping to "שונות" when the
// classifier+LLM are both uncertain, ASK the user. Send a category list
// + stash the pending expense in cache. When the user taps a category,
// _handlePendingTenantPick_ writes the row + calls _learnedSave so the
// bot remembers (global cross-tenant learn store improves for everyone).
//
// Pa'amonim full taxonomy (mirrors lib/categories.js) — these labels are
// what the sheet dashboard rows expect, so SUMIFS picks them up cleanly.
// Order = "most common first" so the first WhatsApp list page (rows 1-9)
// shows the categories most likely to be the right answer.
var _CATEGORY_PICKER_GROUPS_ = [
  // page 1 (rows 1-9)
  { name: 'מזון ופארמה',                  icon: '🍞' },
  { name: 'תחבורה',                       icon: '🚗' },
  { name: 'פנאי, בילוי ותחביבים',         icon: '🎬' },
  { name: 'דיור',                         icon: '🏘' },
  { name: 'אחזקת בית',                    icon: '🏠' },
  { name: 'בריאות',                       icon: '🩺' },
  { name: 'תכולת בית',                    icon: '🛋' },
  { name: 'חינוך',                        icon: '🎓' },
  { name: 'תקשורת',                       icon: '📱' },
  // page 2 (rows 10-16 + "create new")
  { name: 'ביגוד והנעלה',                 icon: '👕' },
  { name: 'טיפוח',                        icon: '💇' },
  { name: 'אירועים, תרומות, צרכי דת',     icon: '🎁' },
  { name: 'משפחה',                        icon: '👨‍👩‍👧' },
  { name: 'התחייבויות',                   icon: '💳' },
  { name: 'נכסים',                        icon: '💰' },
  { name: 'פיננסים',                      icon: '🏦' },
  { name: 'עסק',                          icon: '💼' },
];
var _CATEGORY_PICKER_PAGE_SIZE_ = 9;

// Build the all-categories text block shown alongside the interactive
// list, so a user who DOESN'T tap can read every available option and
// reply with a number, the category name, or "צור קטגוריה <שם>".
function _buildFullCategoriesTextBlock_(amount) {
  var lines = ['📋 *כל הקטגוריות הזמינות:*'];
  for (var i = 0; i < _CATEGORY_PICKER_GROUPS_.length; i++) {
    var c = _CATEGORY_PICKER_GROUPS_[i];
    lines.push((i + 1) + '. ' + c.icon + ' ' + c.name);
  }
  lines.push('');
  lines.push('✍️ אין קטגוריה מתאימה?');
  lines.push('כתוב: *צור קטגוריה <שם>*');
  lines.push('לדוגמה: "צור קטגוריה אופטיקה"');
  lines.push('');
  lines.push('או פשוט השב/י עם מספר (1-' + _CATEGORY_PICKER_GROUPS_.length + ') או עם שם הקטגוריה.');
  lines.push('סכום ההוצאה: ₪' + Number(amount).toLocaleString('he-IL'));
  return lines.join('\n');
}

function _askBeforeDefaulting_(fromPhone, rawText, amount, description) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  try {
    var cache = CacheService.getScriptCache();
    cache.put('pendingExpense:' + clean, JSON.stringify({
      rawText: rawText, amount: amount, description: description, at: Date.now(),
    }), 1800); // 30 min
  } catch (_e) {}
  _sendPendingCategoryPicker_(fromPhone, amount, description, 1);
  // Follow up the interactive picker with the FULL text list so the user
  // sees every option (Steven 2026-05-25). WhatsApp interactive lists cap
  // at 10 rows total, but a text message has no such cap — this gives the
  // user the complete map + the create-new path.
  try {
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(fromPhone, _buildFullCategoriesTextBlock_(amount));
    }
  } catch (_tErr) { Logger.log('_askBeforeDefaulting_ text follow-up err: ' + (_tErr && _tErr.message)); }
  return { reply: '' }; // interactive picker + text IS the reply
}

// Render one page of the category picker. Page 1 = first 9 + "more".
// Page 2 = remaining 8 + "create new" + "back".
function _sendPendingCategoryPicker_(fromPhone, amount, description, page) {
  var start = (page === 2) ? _CATEGORY_PICKER_PAGE_SIZE_ : 0;
  var end = (page === 2)
    ? _CATEGORY_PICKER_GROUPS_.length
    : Math.min(_CATEGORY_PICKER_PAGE_SIZE_, _CATEGORY_PICKER_GROUPS_.length);
  var slice = _CATEGORY_PICKER_GROUPS_.slice(start, end);
  var rows = [];
  for (var i = 0; i < slice.length; i++) {
    var c = slice[i];
    rows.push({
      id: 'pending|' + c.name,
      title: (c.icon + ' ' + c.name).slice(0, 24),
      description: '',
    });
  }
  if (page === 1) {
    rows.push({
      id: 'pending|__more__',
      title: '⋯ עוד אפשרויות',
      description: 'יש עוד ' + (_CATEGORY_PICKER_GROUPS_.length - _CATEGORY_PICKER_PAGE_SIZE_) + ' קטגוריות',
    });
  } else {
    rows.push({
      id: 'pending|__create__',
      title: '✍️ צור קטגוריה חדשה',
      description: 'שם חופשי, יתווסף לגיליון',
    });
    rows.push({
      id: 'pending|__back__',
      title: '🔙 חזרה לרשימה הראשית',
      description: '',
    });
  }
  var header = (page === 1) ? 'איזה קטגוריה?' : 'עוד אפשרויות';
  var body = (page === 1)
    ? '🤔 לא ידעתי איך לסווג: "' + String(description || '').slice(0, 80) + '" — ₪' + Number(amount).toLocaleString('he-IL') +
        '\n\nההוצאה לא נרשמה — בחר קטגוריה, ואני אכניס אותה ואלמד.'
    : 'יש עוד ' + (_CATEGORY_PICKER_GROUPS_.length - _CATEGORY_PICKER_PAGE_SIZE_) + ' קטגוריות. בחר אחת, או צור חדשה.';
  try {
    sendWhatsAppInteractiveList(
      fromPhone, header, body, 'תוקף הבחירה: 30 דקות', 'בחר',
      [{ title: 'קטגוריות', rows: rows }]
    );
  } catch (_sErr) { Logger.log('_sendPendingCategoryPicker_ send err: ' + (_sErr && _sErr.message)); }
  return { reply: '' };
}

// Handle a tap on a row from _askBeforeDefaulting_. Called from
// handleInteractiveReply_ when the picked id matches /^pending\|/.
// Special control-row ids: "__more__" (page 2), "__back__" (page 1),
// "__create__" (prompt for new-category name).
function _handlePendingTenantPick_(fromPhone, pickedCategory) {
  if (!fromPhone || !pickedCategory) return null;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('pendingExpense:' + clean);
  if (!raw) {
    return { replyText: '🤔 לא מצאתי הוצאה שמחכה לסיווג. שלח שוב את ההוצאה.' };
  }
  var pending;
  try { pending = JSON.parse(raw); } catch (_) { return { replyText: '😬 שגיאה בקריאת הבקשה. שלח שוב.' }; }

  // Control rows — DO NOT consume the cache, just navigate.
  if (pickedCategory === '__more__') {
    _sendPendingCategoryPicker_(fromPhone, pending.amount, pending.description, 2);
    return { replyText: '' };
  }
  if (pickedCategory === '__back__') {
    _sendPendingCategoryPicker_(fromPhone, pending.amount, pending.description, 1);
    return { replyText: '' };
  }
  if (pickedCategory === '__create__' || /אחר.*צור קטגוריה|צור קטגוריה/.test(pickedCategory)) {
    try { cache.put('pendingCreate:' + clean, '1', 1800); } catch (_e) {}
    return { replyText:
      '✍️ *צור קטגוריה חדשה*\n\n' +
      'כתוב את השם של הקטגוריה (לדוגמה: "אופטיקה", "כלב", "תינוק").\n\n' +
      'אני אוסיף אותה לגיליון *מאזן אישי* ואכניס את ההוצאה (₪' +
      Number(pending.amount).toLocaleString('he-IL') + ') לתוכה.'
    };
  }

  // Normal path — consume cache + write the row.
  cache.remove('pendingExpense:' + clean);
  cache.remove('pendingCreate:' + clean);

  var botSecret = '';
  try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
  if (!botSecret) return { replyText: '😬 שגיאת קונפיגורציה.' };
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/append', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify({
        phone: clean, amount: pending.amount, currency: 'ILS', isIncome: false,
        category: pickedCategory, subcategory: '', rawText: pending.rawText, botSecret: botSecret,
      }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      // Teach the bot — next time same description routes correctly automatically.
      try {
        if (typeof _learnedSave === 'function' && pending.description) {
          _learnedSave(pending.description, { category: pickedCategory, subcategory: '' }, 'user-correction');
        }
      } catch (_lsErr) {}
      return { replyText:
        '✅ נרשם: ₪' + Number(pending.amount).toLocaleString('he-IL') + ' · ' + pickedCategory +
        ' (ולמדתי — בפעם הבאה אזהה לבד).' + _sheetLinkLine_(fromPhone)
      };
    }
    return { replyText: '😬 לא הצלחתי לרשום (' + code + '). נסה/י שוב.' };
  } catch (e) {
    return { replyText: '😬 בעיה בחיבור: ' + (e && e.message) };
  }
}

// When the user replied with a TEXT message (not a tap) while there is
// a pending expense awaiting categorization, route here. We try:
//   1. "צור קטגוריה <name>" or pendingCreate-mode -> add row + write
//   2. A number 1..N -> map to picker index
//   3. An exact category-group name (or icon+name) -> use it as category
// Anything else returns { handled: false } so normal expense/command
// routing continues — we don't want to swallow unrelated messages.
function _handlePendingCategoryText_(fromPhone, text) {
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean || !text) return { handled: false };
  var cache = CacheService.getScriptCache();
  var raw = cache.get('pendingExpense:' + clean);
  if (!raw) return { handled: false };
  var t = String(text).trim();
  if (!t) return { handled: false };

  // Anything starting with a digit looks like a new expense — let it through.
  // EXCEPT a pure 1-2 digit number, which is interpreted as picker index.
  var mNum = t.match(/^\s*(\d{1,2})\s*$/);
  if (!mNum && /^\s*\d/.test(t)) return { handled: false };

  var pending;
  try { pending = JSON.parse(raw); } catch (_) { return { handled: false }; }
  var pendingCreate = cache.get('pendingCreate:' + clean);

  function _writePendingWith_(category) {
    cache.remove('pendingExpense:' + clean);
    cache.remove('pendingCreate:' + clean);
    var botSecret = '';
    try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
    if (!botSecret) return { handled: true, replyText: '😬 שגיאת קונפיגורציה.' };
    try {
      var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/append', {
        method: 'post', contentType: 'application/json',
        headers: { 'x-kesefle-bot-secret': botSecret },
        payload: JSON.stringify({
          phone: clean, amount: pending.amount, currency: 'ILS', isIncome: false,
          category: category, subcategory: '', rawText: pending.rawText, botSecret: botSecret,
        }),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        try {
          if (typeof _learnedSave === 'function' && pending.description) {
            _learnedSave(pending.description, { category: category, subcategory: '' }, 'user-correction');
          }
        } catch (_lsErr) {}
        return { handled: true, replyText:
          '✅ נרשם: ₪' + Number(pending.amount).toLocaleString('he-IL') + ' · ' + category + _sheetLinkLine_(fromPhone)
        };
      }
      return { handled: true, replyText: '😬 לא הצלחתי לרשום (' + code + '). נסה/י שוב.' };
    } catch (e) {
      return { handled: true, replyText: '😬 בעיה בחיבור: ' + (e && e.message) };
    }
  }

  // 1) Explicit create command OR pendingCreate-mode is on.
  var mCreate = t.match(/^\s*(?:צור|הוסף|create|add)\s+קטגור(?:יה|יות)\s+(.+)$/i);
  if (mCreate || pendingCreate) {
    var name = mCreate ? mCreate[1].trim() : t;
    if (name.length > 40) return { handled: true, replyText: '😬 שם הקטגוריה ארוך מדי. נסה/י קצר יותר (עד 40 תווים).' };
    var addReply = '';
    try {
      if (typeof _addCategoryRows_ === 'function') {
        addReply = _addCategoryRows_(fromPhone, name);
      }
    } catch (_arErr) { Logger.log('_addCategoryRows_ from pending: ' + (_arErr && _arErr.message)); }
    var writeRes = _writePendingWith_(name);
    return { handled: true, replyText: (addReply ? addReply + '\n\n' : '') + (writeRes.replyText || '') };
  }

  // 2) Numeric reply 1..N — pick that index in the picker.
  if (mNum) {
    var idx = parseInt(mNum[1], 10) - 1;
    if (idx >= 0 && idx < _CATEGORY_PICKER_GROUPS_.length) {
      return _writePendingWith_(_CATEGORY_PICKER_GROUPS_[idx].name);
    }
    return { handled: false }; // out-of-range number — let it through
  }

  // 3) Exact group-name match (with or without icon).
  for (var i = 0; i < _CATEGORY_PICKER_GROUPS_.length; i++) {
    var g = _CATEGORY_PICKER_GROUPS_[i];
    if (t === g.name || t === (g.icon + ' ' + g.name) || t === g.icon) {
      return _writePendingWith_(g.name);
    }
  }

  return { handled: false };
}

// Payment-method detector (Steven 2026-05-25). Returns one of:
//   'credit' | 'cash' | 'bit' | 'transfer' | null
// Hebrew + English variants. Conservative: only matches whole words so
// "מזומנים שונים" doesn't false-positive into 'cash'.
function _detectPaymentMethod_(rawText) {
  if (!rawText) return null;
  var t = String(rawText).toLowerCase();
  if (/\b(אשראי|כרטיס אשראי|אשראי שלי|credit|credit card|card)\b/.test(t)) return 'credit';
  if (/\b(מזומן|cash|בלי כרטיס|in cash)\b/.test(t)) return 'cash';
  if (/\b(ביט|bit|בביט|via bit|paid bit)\b/.test(t)) return 'bit';
  if (/\b(העברה בנקאית|העברה|wire|bank transfer|transfer)\b/.test(t)) return 'transfer';
  return null;
}

// Display label for a payment method code. Used both in row prefix + bot
// reply text. ASCII tag preserves grepability + reads naturally in Hebrew.
function _paymentMethodLabel_(code) {
  switch (code) {
    case 'credit':   return 'אשראי';
    case 'cash':     return 'מזומן';
    case 'bit':      return 'ביט';
    case 'transfer': return 'העברה';
    default:         return '';
  }
}

// Look up the user's default payment method from their profile (cached
// 1h per phone). Returns null on any failure / no default set.
var _PMT_CACHE_TTL_SEC = 3600;
function _profilePaymentDefault_(fromPhone) {
  if (!fromPhone) return null;
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  if (!clean) return null;
  try {
    var cache = CacheService.getScriptCache();
    var key = 'pmtDef:' + clean;
    var hit = cache.get(key);
    if (hit !== null) return hit === '_none_' ? null : hit;
    var got = '';
    if (typeof _profileAPI_ === 'function') {
      var g = _profileAPI_('get', { phone: clean });
      if (g && g.ok && g.profile && g.profile.paymentDefault) got = String(g.profile.paymentDefault);
    }
    cache.put(key, got || '_none_', _PMT_CACHE_TTL_SEC);
    return got || null;
  } catch (e) {
    Logger.log('_profilePaymentDefault_ err: ' + (e && e.message));
    return null;
  }
}

function _tenantWriteExpense_(fromPhone, rawText, userRecord) {
  // Reuse the rich Apps Script parser for amount + (cat, subcat) so
  // tenants get the same classification quality as the owner path.
  var parsed = parseAmountAndDescription(rawText);
  if (!parsed || !parsed.items || !parsed.items.length) {
    // Not an expense — let the concierge understand + reply personally. For a
    // tenant we must NOT call owner-sheet summaries; we give safe guidance.
    var __tcg = null;
    try { __tcg = _botConcierge_(fromPhone, rawText); } catch (_tcge) { Logger.log('tenant concierge err: ' + (_tcge && _tcge.message)); }
    if (__tcg) {
      if (__tcg.action === 'help') { try { return { reply: getHelpMessage() }; } catch (_h) {} }
      if (__tcg.reply) return { reply: __tcg.reply };
      if (__tcg.action === 'summary') return { reply: '📊 רוצה לראות איפה אתה עומד? הכל מתעדכן בגיליון שלך' + _sheetLinkLine_(fromPhone) };
      if (__tcg.action === 'examples') return { reply: '💡 דוגמאות: "150 סופר", "ארנונה 500", "60 דלק", "8500 משכורת". פשוט כותבים כמו שמדברים.' };
    }
    return { reply: '😕 לא הצלחתי לזהות סכום. נסה: "245 סופר"' };
  }
  var first = parsed.items[0];
  var matched = null;
  try { matched = typeof matchCategory === 'function' ? matchCategory(rawText) : null; } catch (_) {}
  var category = (matched && matched.category) || 'אחר';
  var subcategory = (matched && matched.subcategory && matched.subcategory !== matched.category) ? matched.subcategory : '';

  var botSecret = '';
  try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!botSecret) {
    Logger.log('_tenantWriteExpense_: KESEFLE_BOT_SECRET not set in Script Properties');
    return { reply: '😬 הבוט עוד בקונפיגורציה. רגע.' };
  }

  // Steven 2026-05-25: when classifier returns "אחר"/"שונות" the bot was
  // writing the row blindly into the misc bucket. He explicitly asked:
  // ASK the user instead of guessing. We send a category picker AND
  // suspend the write — stash the pending expense in cache; when the
  // user taps a category, _handlePendingPick_ writes the row with the
  // chosen classification AND teaches the bot.
  var __isUncertain = (!matched || !matched.category ||
                      matched.category === 'אחר' || matched.category === 'שונות' ||
                      matched.category === 'שונות ואחרים');
  if (__isUncertain) {
    return _askBeforeDefaulting_(fromPhone, rawText, first.amount, first.description || rawText);
  }

  // Steven 2026-05-25: installments detection. "ספה 1000 שקל 5 תשלומים" →
  // bot should set up monthly recurring payments — but FIRST ask the user
  // when the credit-card charges hit (1st/2nd/10th/15th are common Israeli
  // card-billing days). Otherwise the recurring lands on the wrong date.
  try {
    var inst = _detectInstallments_(rawText, first.amount);
    if (inst && inst.count >= 2) {
      return _askInstallmentsStartDate_(fromPhone, inst, category, subcategory, rawText);
    }
  } catch (_iErr) { Logger.log('installments detect err: ' + (_iErr && _iErr.message)); }

  // Payment method (Steven 2026-05-25). Detect from the user's text;
  // fall back to their profile default if any. Prefix the description so
  // it's visible in the sheet AND searchable. Sheet schema stays the
  // same (no new column) — works on every user's existing sheet.
  var __pm = _detectPaymentMethod_(rawText);
  if (!__pm) __pm = _profilePaymentDefault_(fromPhone);
  var __pmLabel = __pm ? _paymentMethodLabel_(__pm) : '';
  var __rawTextWithPM = __pmLabel ? ('[' + __pmLabel + '] ' + String(rawText || '')) : rawText;

  var payload = {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    amount: first.amount,
    currency: 'ILS',
    isIncome: false,
    category: category,
    subcategory: subcategory,
    rawText: __rawTextWithPM,
    messageId: '',
    botSecret: botSecret,
  };

  try {
    var url = KESEFLE_API_BASE + '/api/sheet/append';
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code >= 200 && code < 300) {
      var nice = '₪' + Number(first.amount).toLocaleString('he-IL') + ' · ' + category;
      if (subcategory) nice += ' · ' + subcategory;
      // Parse the rowIndex out of the response so the "change category"
      // picker can address the exact row. Best-effort -- if parsing fails
      // we just skip the picker (the user can still type "קטגוריה X").
      var __rowIndex = 0;
      try {
        var __j = JSON.parse(body);
        if (__j && __j.rowIndex) __rowIndex = Number(__j.rowIndex) || 0;
      } catch (_pe) {}
      // Steven 2026-05-24: stash last-expense in cache + send the change-
      // category picker as a follow-up. Both are best-effort -- the
      // primary confirmation message goes out either way.
      var __twClean = String(fromPhone || '').replace(/[^0-9]/g, '');
      try {
        if (__rowIndex > 0 && __twClean) {
          CacheService.getScriptCache().put(
            'lastTenantExp:' + __twClean,
            JSON.stringify({
              rowIndex: __rowIndex,
              category: category,
              subcategory: subcategory || '',
              amount: Number(first.amount) || 0,
              description: String(first.description || rawText || ''),
              at: Date.now(),
            }),
            1800 // 30 min — long enough to change one's mind, short enough to age out.
          );
        }
      } catch (_cErr) { Logger.log('lastTenantExp cache err: ' + (_cErr && _cErr.message)); }
      // MTD line for THIS category, fetched best-effort.
      var __mtdLine = '';
      try { __mtdLine = _tenantCategoryMtdLine_(fromPhone, category); } catch (_mtdErr) {}
      // Schedule the change-category picker as a second message a moment
      // after the confirmation. Done inline (Apps Script has no real timers)
      // so users see ✅ → tap option to change.
      try { _sendChangeCategoryPicker_(fromPhone, category); } catch (_pkErr) {}
      return { reply:
        '✅ נרשם: ' + nice +
        (__mtdLine ? '\n' + __mtdLine : '') +
        _sheetLinkLine_(fromPhone) +
        _celebrateIfFirstExpense_(fromPhone)
      };
    }
    Logger.log('_tenantWriteExpense_ HTTP ' + code + ' ' + body.slice(0, 300));
    var errCode = '';
    try { errCode = (JSON.parse(body) || {}).error || ''; } catch (_pe) {}
    // Structural failures: retrying never helps, so give real guidance instead
    // of "try again in a minute".
    if (errCode === 'no_user_for_phone') {
      // The user's account exists on the website but this PHONE isn't linked
      // yet -- we need them to do the 6-digit code dance. The previous copy
      // told them to "complete signup" which was confusing because they
      // already did sign up; they just hadn't linked the phone.
      return { reply:
        '👋 כמעט שם!\n\n' +
        'החשבון שלך באתר מוכן ✓ — אבל המספר הזה עדיין לא מחובר אליו.\n\n' +
        '*כדי לחבר אותו (30 שניות):*\n' +
        '1. פתח בטלפון: ' + KESEFLE_API_BASE.replace(/^https?:\/\//, '') + '/welcome\n' +
        '2. לחץ/י על "חבר/י את המספר הזה"\n' +
        '3. תקבל קוד בן 6 ספרות — שלח לי אותו (לדוגמה: "קוד 123456")\n\n' +
        'אחרי זה — כל הוצאה תיכנס אוטומטית לגיליון שלך 📊'
      };
    }
    if (errCode === 'no_sheet_provisioned' || errCode === 'incomplete_user_record' || errCode === 'reauth_required') {
      return { reply: '😬 נראה שעוד לא סיימת את ההרשמה — אין עדיין גיליון מחובר למספר הזה.\n👉 כנס/י ל-' + KESEFLE_API_BASE.replace(/^https?:\/\//, '') + '/account כדי לסיים את החיבור, ואז שלח שוב את ההוצאה.' };
    }
    if (errCode === 'sheet_ownership_mismatch') {
      try { _adminAlertOnce_('🚨 sheet_ownership_mismatch לטלפון ' + String(fromPhone).replace(/[^0-9]/g, ''), fromPhone); } catch (_ae) {}
      return { reply: '😬 נתקלנו בתקלה בחיבור הגיליון שלך. הצוות קיבל התראה ויטפל בהקדם 🙏' };
    }
    if (errCode === 'bot_secret_not_configured') {
      try { _adminAlertOnce_('🚨 KESEFLE_BOT_SECRET לא תואם בין הבוט ל-Vercel — כתיבות נכשלות.', fromPhone); } catch (_ae2) {}
      return { reply: '😬 הבוט בתחזוקה קצרה. ננסה שוב בעוד דקה 🙏' };
    }
    // 502 write_failed / 5xx / unknown → genuinely transient, retry is sensible.
    return { reply: '😬 לא הצלחתי לשמור עכשיו. ננסה שוב בעוד דקה?' };
  } catch (e) {
    Logger.log('_tenantWriteExpense_ throw: ' + (e && e.message));
    return { reply: '😬 בעיה בחיבור לשרת. ננסה שוב?' };
  }
}

// Post an ALREADY-PARSED expense (amount + category chosen) to a tenant's
// own sheet via the Vercel bridge. Used when we already know the structured
// fields (e.g. after an interactive category pick) and must NOT re-parse.
// Returns { ok, code, body }.
function _tenantAppendStructured_(fromPhone, fields) {
  var botSecret = '';
  try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!botSecret) {
    Logger.log('_tenantAppendStructured_: KESEFLE_BOT_SECRET not set');
    return { ok: false, code: 0, body: 'no_secret' };
  }
  var payload = {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    amount: fields.amount,
    currency: fields.currency || 'ILS',
    isIncome: !!fields.isIncome,
    category: fields.category || 'אחר',
    subcategory: fields.subcategory || '',
    rawText: fields.rawText || '',
    messageId: fields.messageId || '',
    botSecret: botSecret,
  };
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/append', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    return { ok: code >= 200 && code < 300, code: code, body: resp.getContentText() };
  } catch (e) {
    Logger.log('_tenantAppendStructured_ throw: ' + (e && e.message));
    return { ok: false, code: 0, body: String(e && e.message) };
  }
}

// ───── VAT DEDUCTIBLE — flip col I of the user's LAST row to TRUE ─────
// Two paths:
//   1. OWNER PATH (legacy single-tenant): the message came from the script
//      owner's WhatsApp number. We edit SHEET_ID directly via SpreadsheetApp
//      since this script has full access to that sheet.
//   2. TENANT PATH (multi-tenant via Vercel): the message came from any other
//      registered Kesefle user. We hit POST /api/sheet/append-vat with the
//      bot secret + phone; Vercel does the OAuth + Sheets API dance.
//
// "Last row" = the bottom non-empty data row in the תנועות tab. We constrain
// to rows whose timestamp is within the last 24 hours -- so accidentally
// sending "מעמ" days later doesn't retroactively edit a stale row.
// Returns the Hebrew reply string.
function _markLastExpenseAsVatDeductible_(fromPhone) {
  // 1. OWNER PATH -- script-owned SHEET_ID.
  if (_isOwnerPhone_(fromPhone)) {
    try {
      var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
      if (!sh) return '😬 אין לשונית תנועות עדיין. שלח הוצאה ראשונה.';
      var last = sh.getLastRow();
      if (last < 2) return '🤔 אין הוצאה אחרונה לסמן. תרשום/תרשמי קודם הוצאה.';
      // Make sure the row is from the last 24h -- otherwise the user probably
      // meant to flag a fresh expense, not an old one.
      var ts = sh.getRange(last, 1).getValue();
      var when = (ts instanceof Date) ? ts.getTime() : new Date(ts).getTime();
      if (!isNaN(when) && (Date.now() - when) > 24 * 60 * 60 * 1000) {
        return '⚠️ ההוצאה האחרונה בת יותר מ-24 שעות. סמן/י ידנית בעמודה ניכוי מע״מ בגיליון.';
      }
      // Make sure the sheet has at least 9 columns (legacy sheets may have 8).
      var maxCols = sh.getMaxColumns();
      if (maxCols < 9) sh.insertColumnsAfter(maxCols, 9 - maxCols);
      // Seed the I1 header if it's empty -- a sheet that predates this feature
      // won't have "ניכוי מע״מ" in row 1. Don't overwrite if the user already
      // labelled it themselves.
      var hdr = sh.getRange(1, 9).getValue();
      if (hdr === '' || hdr == null) sh.getRange(1, 9).setValue('ניכוי מע״מ');
      sh.getRange(last, 9).setValue(true);
      return '✅ סומן לניכוי מע״מ. לסיכום בסוף השנה: /מעמ-סיכום';
    } catch (e) {
      Logger.log('_markLastExpenseAsVatDeductible_ owner err: ' + (e && e.message));
      return '😬 שגיאה בסימון. נסה/י שוב בעוד רגע.';
    }
  }

  // 2. TENANT PATH -- multi-tenant via Vercel bridge.
  var botSecret = '';
  try { botSecret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!botSecret) {
    Logger.log('_markLastExpenseAsVatDeductible_: KESEFLE_BOT_SECRET not set');
    return '😬 הבוט עוד בקונפיגורציה. רגע.';
  }
  var payload = {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    botSecret: botSecret,
  };
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/mark-vat', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code >= 200 && code < 300) {
      return '✅ סומן לניכוי מע״מ. לסיכום בסוף השנה: /מעמ-סיכום';
    }
    Logger.log('_markLastExpenseAsVatDeductible_ HTTP ' + code + ' ' + body.slice(0, 200));
    if (code === 404) return '🤔 אין הוצאה אחרונה לסמן. תרשום/תרשמי קודם הוצאה ואז שלח "מעמ".';
    if (code === 409) return '⚠️ ההוצאה האחרונה בת יותר מ-24 שעות. סמן/י ידנית בעמודה ניכוי מע״מ בגיליון.';
    return '😬 שגיאה בסימון. נסה/י שוב בעוד רגע.';
  } catch (e) {
    Logger.log('_markLastExpenseAsVatDeductible_ tenant err: ' + (e && e.message));
    return '😬 שגיאת רשת בסימון. נסה/י שוב בעוד רגע.';
  }
}

// ============================================================
// 💰 BUDGETS — per-category monthly caps (talks to Vercel /api/budgets)
// ============================================================
//
// Bot UX for budgets. Storage + threshold checks live on the Vercel side
// (api/budgets.js + the daily api/cron/budget-check.js). The bot is just the
// command surface -- same pattern as recurring expenses.
//
//   "תקציב"                      -> show current budgets + this-month MTD
//   "תקציב <full category> <NIS>" -> set monthly cap
//
// The category MUST be the FULL group label from lib/categories.js (e.g.
// "מזון ופארמה", "תחבורה", "דיור"). The server validates and rejects
// unknowns with a useful list -- we surface that list back to the user.

function _budgetAPI_(action, payload) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return { ok: false, error: 'bot_secret_not_set' };
  payload = payload || {};
  payload.action = action;
  payload.botSecret = secret;
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/budgets', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      Logger.log('_budgetAPI_ ' + action + ' HTTP ' + code + ': ' + body.slice(0, 200));
      try { return JSON.parse(body); } catch (_e) { return { ok: false, error: 'http_' + code }; }
    }
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: 'fetch_threw', detail: e && e.message };
  }
}

// Read MTD per top-category via the existing /api/sheet/stats endpoint.
// stats.js currently returns the TOP category only, so we get a partial
// view -- the server-side cron is the source of truth for alerts; this is
// just a best-effort progress display for the inline "תקציב" command.
// Returns { cat -> NIS } (often a single-entry object) or {} on any failure.
function _budgetReadMtdByCategory_(fromPhone) {
  var secret = '';
  try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_e) {}
  if (!secret) return {};
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/sheet/stats', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({ phone: String(fromPhone).replace(/[^0-9]/g, ''), botSecret: secret }),
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return {};
    var body = JSON.parse(resp.getContentText() || '{}');
    var out = {};
    if (body && body.thisMonth && body.thisMonth.topCategory) {
      out[body.thisMonth.topCategory] = Number(body.thisMonth.topCategoryAmount) || 0;
    }
    return out;
  } catch (e) {
    return {};
  }
}

function _budgetListAndProgress_(fromPhone) {
  var r = _budgetAPI_('list', { phone: String(fromPhone).replace(/[^0-9]/g, '') });
  if (!r || !r.ok) {
    return '😬 שגיאה בקריאת התקציבים: ' + (r && r.error || 'unknown') +
      '\nננסה שוב בעוד דקה?';
  }
  var cats = (r.budget && r.budget.categories) || {};
  var names = Object.keys(cats);
  if (!names.length) {
    return '📊 *תקציבים*\n━━━━━━━━━━━━━━━━━━\n\n' +
      'אין לך עדיין תקציבים מוגדרים.\n\n' +
      'הגדר עם: *תקציב <קטגוריה> <NIS>*\n' +
      'לדוגמה: *תקציב מזון ופארמה 1500*\n\n' +
      'אחרי שתעבור 80% מהתקציב, אשלח לך התראה כאן בוואטסאפ.';
  }
  var mtd = _budgetReadMtdByCategory_(fromPhone);
  var lines = ['📊 *תקציבים החודש*', '━━━━━━━━━━━━━━━━━━', ''];
  names.forEach(function(cat) {
    var conf = cats[cat] || {};
    var cap = Number(conf.cap) || 0;
    var th = Number(conf.threshold) || 80;
    var spent = Math.round(Number(mtd[cat] || 0));
    var pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
    var bar;
    if (pct >= th) bar = '🔴';
    else if (pct >= 60) bar = '🟡';
    else bar = '🟢';
    lines.push(bar + ' ' + cat + ' — ₪' + spent.toLocaleString('he-IL') +
      ' / ₪' + Math.round(cap).toLocaleString('he-IL') + ' (' + pct + '%)');
  });
  lines.push('');
  lines.push('שינוי: *תקציב <קטגוריה> <NIS>*');
  return lines.join('\n');
}

function _budgetSet_(fromPhone, category, amount) {
  if (!category || !isFinite(amount) || amount <= 0) {
    return '😕 פורמט: *תקציב <קטגוריה> <NIS>*\nלדוגמה: *תקציב מזון ופארמה 1500*';
  }
  var r = _budgetAPI_('set', {
    phone: String(fromPhone).replace(/[^0-9]/g, ''),
    category: category,
    monthlyCap: Math.round(amount),
  });
  if (!r || !r.ok) {
    if (r && r.error === 'invalid_category' && Array.isArray(r.allowed)) {
      return '😕 קטגוריה לא מוכרת: "' + category + '"\n\n' +
        'הקטגוריות הזמינות:\n' +
        r.allowed.map(function(c) { return '• ' + c; }).join('\n') +
        '\n\nנסה/י שוב — הקלד את שם הקטגוריה במדויק.';
    }
    if (r && r.error === 'too_many_categories') {
      return '😕 הגעת למקסימום של ' + r.max + ' תקציבים. מחק אחד לפני שמוסיפים חדש.';
    }
    if (r && r.error === 'invalid_cap') {
      return '😕 הסכום צריך להיות בין 1 ל-' + (r.maxCap || 100000) + ' שח.';
    }
    return '😬 שגיאה: ' + (r && r.error || 'unknown') + '\nננסה שוב בעוד דקה?';
  }
  return '✅ נקבע תקציב חודשי: ₪' + Math.round(amount).toLocaleString('he-IL') +
    ' לקטגוריית "' + category + '"\n\n' +
    'אשלח התראה כאן כשתעבור 80% מהתקציב החודשי.\n' +
    'לרשימת התקציבים שלך: *תקציב*';
}

function processExpense(text, fromPhone) {
  if (!text || !text.trim()) {
    return { reply: 'שלח בפורמט: סכום פירוט\nלמשל:\n85 סופר רמי לוי\n1200 ארנונה\n300 דלק\n\nאפשר גם:\n352 אוכל לבית+165 (שתי הוצאות באותה קטגוריה)' };
  }

  // ───── GROUP COMMAND ROUTER ─────
  // Any message starting with "כספלה" enters Splitwise-style group mode.
  // Also accept the legacy family aliases ("הקמת משפחה", "הצטרפות
  // למשפחה", "דו"ח משפחתי") so existing users keep working — we just
  // rewrite the text into the כספלה equivalent and route through the
  // same handler.
  try {
    var __aliased = text;
    var __famCreate = text.match(/^\s*(?:הקמת\s+משפחה|הקמ\s+משפחה|create\s+family)\s*(.*)$/i);
    if (__famCreate) __aliased = 'כספלה צור ' + (__famCreate[1].trim() || 'משפחה');
    var __famJoin = text.match(/^\s*(?:הצטרפות\s+למשפחה|join\s+family)\s+([A-Z0-9]{6,8})\b/i);
    if (__famJoin) __aliased = 'כספלה הצטרף ' + __famJoin[1];
    var __famReport = text.match(/^\s*(?:דו(?:["׳']*?)ח\s+משפחת(?:י|ה)|family\s+report)\s*$/i);
    if (__famReport) __aliased = 'כספלה יתרות';
    if (/^\s*כספלה(?=\s|$)/i.test(__aliased) && typeof _handleGroupCommand_ === 'function') {
      var __groupRes = _handleGroupCommand_(fromPhone, __aliased);
      if (__groupRes && __groupRes.handled) {
        return { reply: __groupRes.replyText || '' };
      }
    }
  } catch (__grpErr) {
    Logger.log('group router err: ' + (__grpErr && __grpErr.message));
  }

  // ───── MULTI-TENANT ROUTER ─────
  // CRITICAL: link-code verification MUST happen before the tenant router.
  // Otherwise an unknown phone sending "קוד 123456" gets routed to
  // _tenantWriteExpense_ -> /api/sheet/append -> 404 no_user_for_phone
  // -> "כמעט שם!" message, and the code is never actually verified.
  // (Bug Steven hit 2026-05-24 -- sent two different codes, both got the
  // same welcome reply.) The codeMatch lower in the function is dead code
  // for non-owner phones; this is the canonical entry point.
  var __codeMatchEarly = text.match(/(?:קוד|code|link)\s*[:\-]?\s*(\d{6})\b/i);
  if (__codeMatchEarly) {
    return { reply: handleLinkCode_(__codeMatchEarly[1], fromPhone) };
  }

  // ── "צור קטגוריה X" / "הוסף קטגוריה X" ─────────────────────────────────
  // Adds a custom row to the user's "מאזן אישי" dashboard sheet. Used by
  // Steven's request (2026-05-24): "תכניס גם את האופציה שדרך הבוט אפשר
  // לכתוב לו ליצור קטגוריה חדשה במאזן אישי/מאזן חברה של משהו נוסף למשל
  // ילדים, ילד 1 + שם". Supports a single name or a comma-separated list
  // ("ילד 1 דניאל, ילד 2 מיכל") -- creates one row per item.
  //
  // The new row in מאזן אישי gets a SUMPRODUCT formula that sums any row
  // in 'תנועות' where the name appears in category/subcategory/description.
  // So the very next time the user types "200 לדניאל" or "350 דניאל גן",
  // it lights up in the dashboard. Honest behavior, no faking.
  var __catCreate = text.match(/^\s*(?:כספלה\s+)?(?:צור|הוסף|create|add)\s+קטגור(?:יה|יות)\s+(.+)$/i);
  if (__catCreate) {
    return { reply: _addCategoryRows_(fromPhone, __catCreate[1]) };
  }

  // If the sender is NOT the script owner, route the write to that user's
  // own Google Sheet via the Kesefle Vercel bridge. We still run the rich
  // parsers below for category/subcategory, then post the parsed expense
  // to /api/sheet/append which handles the OAuth dance and tenant write.
  // Owners (the script's home phone) keep the legacy single-tenant path --
  // it has features like _updateBusinessDashboard_, smart_pending,
  // installCompanyDashboardFormulas etc. that aren't yet ported.
  // Guard: only route to tenant-write when we actually HAVE a userRecord.
  // Without this guard, unknown phones (userRecord=null) get routed to a
  // doomed write that always 404s, masking other onboarding signals.
  try {
    var __tenant = _resolveTenant_(fromPhone);
    if (__tenant && !__tenant.isOwner && __tenant.userRecord) {
      return _tenantWriteExpense_(fromPhone, text, __tenant.userRecord);
    }
    if (__tenant && __tenant.isOwner === false && !__tenant.userRecord) {
      // Unknown phone — neither owner nor registered tenant.
      return { reply:
        'היי! 👋 אני כספ\'לה — בוט ההוצאות שלך בוואטסאפ.\n' +
        'אני לא מזהה את המספר הזה עדיין, אז בוא נתחיל יחד.\n\n' +
        '1️⃣ פתח: https://kesefle.com/account\n' +
        '2️⃣ התחבר עם Google\n' +
        '3️⃣ קשר את המספר הזה — לוקח 30 שניות\n\n' +
        'אחרי שנקשרים, תוכל לשלוח לי הוצאות ואני אכניס אותן לגיליון שלך אוטומטית. 📊' };
    }
    // Fall through — sender is the owner (or resolver failed safely);
    // continue with the existing single-tenant path.
  } catch (__tenantErr) {
    Logger.log('tenant router err (falling back to owner path): ' + (__tenantErr && __tenantErr.message));
  }

  // SECURITY belt-and-suspenders: every line below writes to the hardcoded
  // owner SHEET_ID. If a real non-owner sender somehow reached here (e.g. a
  // future routing regression, or _kvLookupPhone_ failing open), abort
  // before any write rather than leak into the owner's sheet.
  if (fromPhone && !_isOwnerPhone_(fromPhone)) {
    Logger.log('🚨 processExpense legacy path reached by non-owner ' + String(fromPhone).replace(/[^0-9]/g, '') + ' — aborting write.');
    try { _adminAlertOnce_('🚨 נחסמה כתיבה של מספר לא מוכר לגיליון שלך (processExpense). בדוק קישור מספרים.', String(fromPhone).replace(/[^0-9]/g, '')); } catch (_e) {}
    return { reply:
      'היי! 👋 אני כספ\'לה — אבל אני עוד לא מזהה את המספר הזה.\n' +
      'התחבר ב-https://kesefle.com/account וקשר את המספר — לוקח 30 שניות, ואז ההוצאות יישמרו בגיליון שלך.' };
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
        // Steven 2026-05-25: also accept the CATEGORY NAME as free text.
        // Users instinctively type "הוצאות תפעוליות" rather than the row
        // number, and the old code only matched numbers — leaving the
        // smart_pending stuck until it expired. Match by:
        //  (1) exact label, then (2) bidirectional substring on label
        //      OR subcategory (so "תפעוליות" matches "הוצאות תפעוליות"
        //      option AND a "תפעוליות" subcategory).
        if (!__hPicked && __hT && !/^[0-9]+$/.test(__hT)) {
          var __hNorm = __hT.toLowerCase().trim();
          for (var __pi = 0; __pi < __hP.options.length; __pi++) {
            var __opt = __hP.options[__pi];
            var __lab = String(__opt.label || '').toLowerCase();
            var __sub = String(__opt.subcategory || '').toLowerCase();
            if (__lab === __hNorm || __sub === __hNorm) { __hPicked = __opt; break; }
            if (__lab && (__lab.indexOf(__hNorm) >= 0 || __hNorm.indexOf(__lab) >= 0)) { __hPicked = __opt; break; }
            if (__sub && (__sub.indexOf(__hNorm) >= 0 || __hNorm.indexOf(__sub) >= 0)) { __hPicked = __opt; break; }
          }
        }
        if (__hPicked) {
          __hProps.deleteProperty('smart_pending');
          try {
            var __hPSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
            if (__hPSheet) {
              var __hPNow = new Date();
              var __hPMonth = Utilities.formatDate(__hPNow, 'Asia/Jerusalem', 'yyyy-MM');
              var __hPCategory = 'עסק';
              var __hPSubcategory = __hPicked.subcategory || 'תפעוליות';
              var __hPDesc = __hPicked.label || __hPSubcategory;
              __hPSheet.appendRow([__hPNow, __hPMonth, __hP.amount, sanitizeForSheet(__hPCategory), sanitizeForSheet(__hPSubcategory), sanitizeForSheet(__hPDesc), 'WhatsApp', true]);
              // Original-text cell note — preserves the business amount input + picked category.
              try {
                var __hPLastForNote = __hPSheet.getLastRow();
                var __hPRawTxt = (__hP.rawText || (__hP.amount + ' ' + (__hPDesc || ''))) + ' [picked: ' + __hPicked.label + ']';
                _kfl_setRowOriginalNote(__hPSheet, __hPLastForNote, _kfl_buildOriginalNote('Original WhatsApp (business pick)', __hPRawTxt));
              } catch (__hPNoteErr) { Logger.log('smart_pending note err: ' + (__hPNoteErr && __hPNoteErr.message)); }
              try {
                var __hPLast = __hPSheet.getLastRow();
                if (__hPLast > 2) __hPSheet.getRange(2, 1, __hPLast - 1, 8).sort({ column: 1, ascending: true });
              } catch (__hPSortErr) {}
              try { _updateBusinessDashboard_(__hPCategory, __hPSubcategory, __hPMonth, __hP.amount); } catch (__hPDashErr) { Logger.log('smart_pending dashboard err: ' + (__hPDashErr && __hPDashErr.message)); }
              try { _dashboardDetailNote_(__hPCategory, __hPSubcategory, __hPMonth, __hP.amount, __hPDesc, __hPNow); } catch (__hPDnErr) { Logger.log('smart_pending dashboard note err: ' + (__hPDnErr && __hPDnErr.message)); }
              return { reply: '✅ ₪' + __hP.amount.toLocaleString('he-IL') + ' ל' + __hPDesc + '. נשמר אצלך בגיליון 📊\n📂 ' + __hPCategory + '\n🏷️ ' + __hPSubcategory };
            }
          } catch (__hPWriteErr) {
            Logger.log('smart_pending write err: ' + (__hPWriteErr && __hPWriteErr.message));
          }
          text = 'עסק - ' + __hP.amount + ' ' + __hPicked.subcategory;
        }
      } else {
        __hProps.deleteProperty('smart_pending');
      }
    } catch (__hErr) {}
  }
  var __hIsBiz = /^(עסק|biz|business)(?=$|[\s:\-,0-9])/i.test(__hT);
  if (__hIsBiz) {
    // First try the rich-order parser. If the message contains at least
    // 2 labelled fields (customer, size, material, costs, shipping…) we
    // write a structured row to the orders tab and bypass the dropdown
    // flow entirely. Simpler "עסק 24 שיווק" messages return null here
    // and continue to the existing categoriser below.
    try {
      var __order = parseBusinessOrder_(__hT);
      if (__order) {
        __hProps.deleteProperty('smart_pending');
        var __orderRes = _writeOrderRow_(__order);
        if (__orderRes.ok) {
          var __ln = [];
          __ln.push('✅ הזמנה נרשמה');
          if (__order.customer) __ln.push('👤 ' + __order.customer);
          if (__order.size || __order.material) {
            __ln.push('🖼 ' + [__order.size, __order.material].filter(Boolean).join(' · '));
          }
          if (__order.salePrice)      __ln.push('💰 מחזור: ₪' + Number(__order.salePrice).toLocaleString('he-IL'));
          if (__order.productionCost) __ln.push('🏭 עלות ייצור: ₪' + Number(__order.productionCost).toLocaleString('he-IL'));
          if (__order.shipping)       __ln.push('🚚 משלוח: ₪' + Number(__order.shipping).toLocaleString('he-IL'));
          if (__order.profit != null) __ln.push('📈 רווח: ₪' + Number(__order.profit).toLocaleString('he-IL'));
          return { reply: __ln.join('\n') };
        }
        Logger.log('order parse OK but write failed: ' + (__orderRes && __orderRes.error));
        // Fall through to legacy path if the orders-tab write blew up.
      }
    } catch (__orderErr) {
      Logger.log('parseBusinessOrder_ THREW: ' + (__orderErr && __orderErr.message));
    }

    var __hAM = __hT.replace(/,/g, '').match(/(?:^|[\s:\-])([0-9]+(?:\.[0-9]+)?)/);
    var __hA = __hAM ? parseFloat(__hAM[1]) : null;
    if (__hA && __hA > 0) {
      var __hRest = __hT.replace(/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i, '').replace(String(__hA), '').replace(/[,\-:\s]+/g, ' ').trim();
      if (__hRest && __hRest.length >= 2) {
        var __hBizMatched = matchCategory(__hT);
        var __hBizDefaultSub = (__hBizMatched && __hBizMatched.subcategory === 'הוצאות תפעוליות');
        var __hBizFoundKw = false;
        try {
          var __hBizT = __hT.toLowerCase();
          for (var __hBizCat in BUSINESS_CATEGORY_MAP) {
            var __hBizSubs = BUSINESS_CATEGORY_MAP[__hBizCat];
            for (var __hBizSub in __hBizSubs) {
              var __hBizKws = __hBizSubs[__hBizSub];
              for (var __hBizKi = 0; __hBizKi < __hBizKws.length; __hBizKi++) {
                if (__hBizT.indexOf(String(__hBizKws[__hBizKi]).toLowerCase()) >= 0) {
                  __hBizFoundKw = true;
                  break;
                }
              }
              if (__hBizFoundKw) break;
            }
            if (__hBizFoundKw) break;
          }
        } catch (__hBizErr) {}
        if (__hBizFoundKw && __hBizMatched && !__hBizDefaultSub) {
          __hProps.deleteProperty('smart_pending');
          text = __hT;
        } else {
          var __hOpts = [
            { label: 'שיווק',           subcategory: 'שיווק' },
            { label: 'הוצאות תפעוליות', subcategory: 'תפעוליות' },
            { label: 'חומרי גלם',       subcategory: 'חומרי גלם' },
            { label: 'אריזה ומשלוח',    subcategory: 'משלוח' },
            { label: 'יועצים',          subcategory: 'יועצים' },
            { label: 'תוכנות / SaaS',   subcategory: 'תפעוליות' },
            { label: 'ציוד עסקי',       subcategory: 'תפעוליות' },
            { label: 'מיסים',           subcategory: 'תפעוליות' },
            { label: 'שונות עסק',       subcategory: 'תפעוליות' },
            { label: 'הזמנה לקוח',      subcategory: 'מחזור' },
            { label: 'תשלום מלקוח',     subcategory: 'מחזור' },
            { label: 'החזר מס',         subcategory: 'מחזור' }
          ];
          var __payload = JSON.stringify({ amount: __hA, options: __hOpts, rawText: text, expiresAt: Math.floor(Date.now()/1000) + 900 });
          __hProps.setProperty('smart_pending', __payload);
          var __hLn = [];
          __hLn.push('🏢 עסק — ₪' + __hA);
          __hLn.push('');
          __hLn.push('בחר קטגוריה:');
          __hLn.push('');
          for (var __hK = 0; __hK < __hOpts.length; __hK++) {
            __hLn.push((__hK + 1) + '. ' + __hOpts[__hK].label);
          }
          __hLn.push('');
          __hLn.push('או הקלד שם קטגוריה / בטל');
          return { reply: __hLn.join('\n') };
        }
      } else {
        var __hOptsBare = [
          { label: 'שיווק',           subcategory: 'שיווק' },
          { label: 'הוצאות תפעוליות', subcategory: 'תפעוליות' },
          { label: 'חומרי גלם',       subcategory: 'חומרי גלם' },
          { label: 'אריזה ומשלוח',    subcategory: 'משלוח' },
          { label: 'יועצים',          subcategory: 'יועצים' },
          { label: 'תוכנות / SaaS',   subcategory: 'תפעוליות' },
          { label: 'ציוד עסקי',       subcategory: 'תפעוליות' },
          { label: 'מיסים',           subcategory: 'תפעוליות' },
          { label: 'שונות עסק',       subcategory: 'תפעוליות' },
          { label: 'הזמנה לקוח',      subcategory: 'מחזור' },
          { label: 'תשלום מלקוח',     subcategory: 'מחזור' },
          { label: 'החזר מס',         subcategory: 'מחזור' }
        ];
        var __payloadBare = JSON.stringify({ amount: __hA, options: __hOptsBare, rawText: text, expiresAt: Math.floor(Date.now()/1000) + 900 });
        __hProps.setProperty('smart_pending', __payloadBare);
        var __hLnBare = [];
        __hLnBare.push('🏢 עסק — ₪' + __hA);
        __hLnBare.push('');
        __hLnBare.push('בחר קטגוריה:');
        __hLnBare.push('');
        for (var __hKB = 0; __hKB < __hOptsBare.length; __hKB++) {
          __hLnBare.push((__hKB + 1) + '. ' + __hOptsBare[__hKB].label);
        }
        __hLnBare.push('');
        __hLnBare.push('או הקלד שם קטגוריה / בטל');
        return { reply: __hLnBare.join('\n') };
      }
    }
  }

  const trimmed = text.trim().toLowerCase();
  // Self-check: confirms which build is live + whether the Gemini key is visible.
  if (trimmed === 'בדיקה' || trimmed === 'diag' || trimmed === 'דיבאג') {
    var _hasGem = false, _hasSecret = false, _gemOk = false;
    try { _hasGem = !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'); } catch (_e1) {}
    try { _hasSecret = !!PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET'); } catch (_e2) {}
    if (_hasGem) { try { _gemOk = !!_geminiGenerate_('Reply with the single word OK.', 'OK'); } catch (_e3) {} }
    return { reply:
      '🔧 בדיקת מערכת\n' +
      'גרסה: ' + KFL_BUILD_VERSION + '\n' +
      'מפתח Gemini: ' + (_hasGem ? '✅ קיים' : '❌ חסר (הוסף ב-Script Properties)') + '\n' +
      'חיבור Gemini: ' + (_hasGem ? (_gemOk ? '✅ עובד' : ('❌ נכשל\nשגיאה: ' + (_KFL_GEMINI_LAST_ERR || 'unknown'))) : '—') + '\n' +
      'בוט-סיקרט: ' + (_hasSecret ? '✅' : '❌') };
  }
  if (trimmed === 'עזרה' || trimmed === 'help' || trimmed === '?') {
    return { reply: getHelpMessage() };
  }
  // "What's new" command: show recent feature announcements pushed by admin.
  if (trimmed === 'חדש' || trimmed === '/חדש' || trimmed === 'whats new' || trimmed === "what's new" || trimmed === 'מה חדש') {
    try {
      var __annReply = _fetchAnnouncements_(fromPhone);
      if (__annReply) return { reply: __annReply };
    } catch (_aErr) { Logger.log('announcement fetch err: ' + (_aErr && _aErr.message)); }
    return { reply: 'אין עדכונים חדשים כרגע. עקוב/י אחרינו ב-kesefle.com/changelog' };
  }
  // Greetings: catch "שלום"/"היי"/"hi"/"hello"/"hey" as standalone short
  // message. Respond with a real intro + capabilities, not "didn't understand".
  // Conservative regex: only fires for a pure greeting, not a sentence that
  // contains the word (e.g. "שלום, אכלתי בסופר ב-45" still goes to the parser).
  // Free-text answer to the installments "when's first charge?" question.
  // Tries to parse a day number (1-31), full date DD/MM/YYYY, or "היום".
  // Only fires when an installPending:{phone} key exists in cache — won't
  // hijack other replies. Steven 2026-05-25.
  try {
    var __instFT = (typeof _maybeHandleInstallmentsFreeText_ === 'function')
      ? _maybeHandleInstallmentsFreeText_(fromPhone, trimmed) : null;
    if (__instFT && __instFT.handled) {
      return { reply: __instFT.reply };
    }
  } catch (_iftErr) { Logger.log('installments free-text err: ' + (_iftErr && _iftErr.message)); }

  // "תשלומים" / "תשלום" / "installments" — list active installment plans.
  if (/^\s*(תשלומים|תשלום|installments|payments)\s*[!.?]*\s*$/i.test(trimmed)) {
    return { reply: _listInstallments_(fromPhone) };
  }

  // Steven 2026-05-25: payment-method default commands. Sets per-user
  // paymentDefault that stamps every future expense with [METHOD] prefix.
  // "תמיד אשראי" / "תמיד מזומן" / "תמיד ביט" / "תמיד העברה"
  // + reset: "בטל ברירת מחדל" / "שכח אמצעי תשלום"
  var __pmCmd = trimmed.match(/^\s*(?:תמיד|always)\s+(אשראי|מזומן|ביט|העברה|credit|cash|bit|transfer)\s*[!.?]*\s*$/i);
  if (__pmCmd) {
    var __pmRaw = __pmCmd[1].toLowerCase();
    var __pmCode = ({
      'אשראי':'credit','credit':'credit',
      'מזומן':'cash','cash':'cash',
      'ביט':'bit','bit':'bit',
      'העברה':'transfer','transfer':'transfer'
    })[__pmRaw];
    if (__pmCode) {
      try {
        var __cleanPm = String(fromPhone).replace(/[^0-9]/g, '');
        _profileAPI_('set', { phone: __cleanPm, fields: { paymentDefault: __pmCode } });
        try { CacheService.getScriptCache().remove('pmtDef:' + __cleanPm); } catch (_e) {}
      } catch (_pmErr) { Logger.log('paymentDefault set err: ' + (_pmErr && _pmErr.message)); }
      return { reply:
        '✅ ברירת מחדל נשמרה: *' + _paymentMethodLabel_(__pmCode) + '*\n\n' +
        'מעכשיו כל הוצאה שתשלח תסומן ב-[' + _paymentMethodLabel_(__pmCode) + '] אוטומטית.\n' +
        'אם תרצה לרשום במזומן/ביט פעם אחת בלבד — פשוט כתוב את זה בהודעה (למשל "50 קפה במזומן").\n\n' +
        'לבטל את ברירת המחדל: *בטל ברירת מחדל*'
      };
    }
  }
  if (/^\s*(?:בטל\s+ברירת\s+מחדל|שכח\s+אמצעי\s+תשלום|reset\s+payment\s+default)\s*[!.?]*\s*$/i.test(trimmed)) {
    try {
      var __cleanReset = String(fromPhone).replace(/[^0-9]/g, '');
      _profileAPI_('set', { phone: __cleanReset, fields: { paymentDefault: null } });
      try { CacheService.getScriptCache().remove('pmtDef:' + __cleanReset); } catch (_e) {}
    } catch (_) {}
    return { reply: '✓ ברירת המחדל בוטלה. מעכשיו אזהה אמצעי תשלום רק אם תכתוב אותו בהודעה.' };
  }

  var __greetMatch = trimmed.match(/^\s*(שלום|היי|hi|hey|hello|בוקר טוב|ערב טוב|שבוע טוב|מה נשמע|מה קורה|good morning|good evening)\s*[!.?]*\s*$/i);
  if (__greetMatch) {
    // Steven 2026-05-24: every greeting should auto-launch the personalization
    // survey for any user who hasn't completed it. The survey BUILDS the right
    // dashboard rows for their life (kids/pets/car) -- it can't do that work
    // if it never runs. Guarded by Script Property so repeated "שלום"
    // messages don't re-prompt mid-flow.
    try {
      var __gcl = String(fromPhone || '').replace(/[^0-9]/g, '');
      if (__gcl) {
        var __gprops = PropertiesService.getScriptProperties();
        var __gkey = 'surveyed:' + __gcl;
        if (!__gprops.getProperty(__gkey) && typeof _surveyStart_ === 'function') {
          __gprops.setProperty(__gkey, new Date().toISOString());
          // Schedule the first survey question for ~1.5 sec after the
          // greeting so the user reads the intro first. Apps Script has
          // no real setTimeout — just send both synchronously, WhatsApp
          // delivers them in order.
          Utilities.sleep(1500);
          _surveyStart_(fromPhone);
        }
      }
    } catch (_geSurvErr) { Logger.log('greet survey kickoff err: ' + (_geSurvErr && _geSurvErr.message)); }
    return { reply:
      '👋 היי! אני כספ\'לה — הבוט שעוקב אחרי ההוצאות שלך *בלי טפסים ובלי אקסל*.\n\n' +
      '📝 *פשוט תכתוב הוצאה כמו שאתה מדבר:*\n' +
      '  • "45 קפה"\n' +
      '  • "1,200 שכר דירה"\n' +
      '  • "230 סופר רמי לוי"\n' +
      '  • "אתמול 60 מכולת" (תאריך אחר)\n' +
      '  • "50$ אמזון" (מטבע זר -> ILS אוטומטית)\n\n' +
      '🧾 *גם ככה:*\n' +
      '  • שלח לי *צילום קבלה* — אני אקרא אותה\n' +
      '  • שלח לי *הודעה קולית* — אני אתמלל\n' +
      '  • "/קבוע 2500 שכירות" — הוצאה חוזרת חודשית\n' +
      '  • "/תקציב מזון 1500" — תקציב + התראות\n' +
      '  • "/מעמ" — סמן הוצאה לניכוי מס\n\n' +
      '📊 *לראות מה רשמתי:*\n' +
      '  • "סיכום" — סיכום החודש\n' +
      '  • "עזרה" — רשימת הפקודות המלאה\n\n' +
      '💬 יש לך שאלה על הכסף שלך? תשאל אותי חופשי — אני יודע להסביר.'
    };
  }
  // NPS reply: user replies with a 0-10 score (optionally followed by a
  // comment) within 48h of being prompted. Prompt is fired by the lifecycle
  // cron via /api/whatsapp/send at day-60.
  var __npsCtxKey = 'nps_pending:' + String(fromPhone).replace(/[^0-9]/g, '');
  var __npsPending = false;
  try { __npsPending = !!PropertiesService.getScriptProperties().getProperty(__npsCtxKey); } catch (_npsErr) {}
  if (__npsPending) {
    var __npsMatch = text.trim().match(/^\s*(10|[0-9])\s*([\s\S]*)$/);
    if (__npsMatch) {
      var __npsScore = parseInt(__npsMatch[1], 10);
      var __npsComment = (__npsMatch[2] || '').trim().slice(0, 280);
      try {
        _submitNps_(fromPhone, __npsScore, __npsComment);
        try { PropertiesService.getScriptProperties().deleteProperty(__npsCtxKey); } catch (_npsCtxErr) {}
      } catch (_npsSubErr) { Logger.log('nps submit err: ' + (_npsSubErr && _npsSubErr.message)); }
      var __npsThanks = __npsScore >= 9
        ? 'תודה רבה! 🙏 שמחים שאתה ממליץ. אם מתחשק לך לעזור לחבר/ה — ' + 'wa.me/15556408123?text=שלום'
        : __npsScore >= 7
        ? 'תודה על המשוב! 🙏 איפה אנחנו יכולים להשתפר?'
        : 'תודה על הכנות. 🙏 נשמח שתשלח לנו הצעות שיפור ל-info@kesefle.com';
      return { reply: __npsThanks };
    }
  }
  // Testimonial submission: user replies with their experience after the bot
  // asks at day-14. Pattern: starts with 'המלצה:' / 'המלצה ' / 'recommend:'.
  // Anything else goes through the normal classifier. Submission is queued
  // for admin review (not auto-published).
  var __testimonialMatch = text.match(/^\s*(?:המלצה[\s:]+|recommend[\s:]+)(.{10,280})$/i);
  if (__testimonialMatch) {
    try {
      var __testimonialText = __testimonialMatch[1].trim();
      var __submitResp = _submitTestimonial_(fromPhone, __testimonialText);
      if (__submitResp && __submitResp.ok) {
        return { reply: 'תודה רבה! 🙏 ההמלצה התקבלה ותעבור בדיקה לפני שתפורסם באתר.' };
      }
      return { reply: 'תודה! קיבלנו את ההמלצה (ייתכן עיכוב בעיבוד).' };
    } catch (_tErr) { Logger.log('testimonial submit err: ' + (_tErr && _tErr.message)); }
  }
  // Support escalation: customer needs a human. Match common Hebrew + English
  // phrases. We DO NOT classify these as expenses, we DO notify the owner via
  // the existing admin-alert path, and we reply with a friendly ack.
  if (_isSupportEscalation_(trimmed)) {
    try {
      _adminAlertOnce_(
        '🆘 SUPPORT REQUEST\n' +
        'From: +' + fromPhone + '\n' +
        'Text: "' + text.slice(0, 280) + '"\n\n' +
        'Reply to them on WhatsApp directly: https://wa.me/' + fromPhone,
        fromPhone
      );
    } catch (_supErr) { Logger.log('support escalation alert err: ' + (_supErr && _supErr.message)); }
    return { reply: 'קיבלתי. הצוות יחזור אליך כאן בוואטסאפ תוך כמה שעות.\nאם זה דחוף — info@kesefle.com 📧' };
  }
  if (trimmed === 'סיכום' || trimmed === 'summary') {
    return { reply: getMonthlySummary(fromPhone) };
  }
  if (trimmed === 'הזמנות' || trimmed === 'orders' ||
      trimmed === 'הזמנות החודש' || trimmed === 'סיכום הזמנות') {
    return { reply: getOrdersSummary() };
  }
  if (trimmed === 'מחק הזמנה' || trimmed === 'מחק הזמנה אחרונה' || trimmed === 'undo order') {
    return { reply: deleteLastOrder() };
  }
  if (trimmed === 'סנכרן' || trimmed === 'sync') {
    try { var s = syncEverything(); return { reply: '✅ סונכרן: ' + s }; }
    catch (e) { return { reply: '😬 משהו השתבש בסנכרון: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' }; }
  }
  if (trimmed === 'מיגרציה' || trimmed === 'migrate') {
    try { var n = migrateSubcategoriesAndCategories(); return { reply: '✅ הועברו ' + n + ' שורות לקטגוריות חדשות.' }; }
    catch (e) { return { reply: '😬 משהו השתבש במיגרציה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' }; }
  }
  if (trimmed === 'מרווחים' || trimmed === 'margins') {
    try { addRowMargins(); return { reply: '✅ הוספתי מרווחים בלוח האישי. רענן את השיט כדי לראות.' }; }
    catch (e) { return { reply: '😬 משהו השתבש בהוספת מרווחים: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' }; }
  }
  if (trimmed === 'בנה מחדש' || trimmed === 'rebuild') {
    try { buildHistorySheet(); return { reply: '✅ נבנה מחדש (כולל מרווחים).' }; }
    catch (e) { return { reply: '😬 משהו השתבש בבנייה מחדש: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' }; }
  }
  if (trimmed === 'מחק אחרון' || trimmed === 'undo') {
    return { reply: deleteLastTransaction() };
  }
  if (trimmed === 'מנוע' || trimmed === 'engine' || trimmed === 'status' || trimmed === 'stats') {
    return { reply: getEngineStatus() };
  }
  if (trimmed === 'מילון' || trimmed === 'dict' || trimmed === 'dictionary') {
    return { reply: getDictionaryLink(fromPhone) };
  }
  if (trimmed === 'גיליון' || trimmed === 'sheet') {
    // Resolve the link for THIS sender -- owner gets SHEET_ID, tenant
    // gets their own provisioned sheet, unknown sender gets a polite
    // "not linked yet" message instead of the owner's URL.
    var __sheetUrl = (typeof _userSheetUrl_ === 'function') ? _userSheetUrl_(fromPhone) : '';
    if (__sheetUrl) {
      return { reply: '📊 הגיליון שלך:\n' + __sheetUrl };
    }
    return { reply:
      '😬 אין לי עדיין גיליון מקושר אליך.\n' +
      '💡 כדי לקשר גיליון פרטי משלך:\n' +
      '1. גש אל https://kesefle.com/account\n' +
      '2. התחבר עם חשבון Google\n' +
      '3. אשר יצירת גיליון חדש'
    };
  }
  if (trimmed === 'מטבעות' || trimmed === 'currencies' || trimmed === 'fx') {
    return { reply: getCurrenciesMessage() };
  }
  // Bill reminders. "תזכורת 15/6 חשמל 450" / "תזכורות" / "מחק תזכורת ID"
  if (trimmed === 'תזכורות' || trimmed === 'reminders') {
    if (typeof _listReminders_ === 'function') return { reply: _listReminders_(fromPhone) };
  }
  var __remAdd = text.trim().match(/^(?:תזכורת|reminder)\s+(\S+)\s+(.+?)(?:\s+(\d+(?:[.,]\d+)?))?$/i);
  if (__remAdd && typeof _addReminder_ === 'function') {
    return { reply: _addReminder_(fromPhone, __remAdd[1], __remAdd[2].trim(), __remAdd[3] ? parseFloat(__remAdd[3].replace(',', '.')) : null) };
  }
  var __remRm = text.trim().match(/^(?:מחק\s+תזכורת|delete\s+reminder)\s+(\S+)$/i);
  if (__remRm && typeof _removeReminder_ === 'function') {
    return { reply: _removeReminder_(fromPhone, __remRm[1]) };
  }
  // ───── PERSONALIZATION QUESTIONNAIRE (survey) ─────
  // Backstop for paths that reach processExpense directly (e.g. voice
  // transcription) — the primary hook is in doPost, before the expense
  // fast-path. The survey / advanced-settings commands start Q1 (sent as a
  // side-effect via interactive List); the confirm command logs a pending.
  if (trimmed === 'שאלון' || trimmed === 'הגדרות מתקדמות') {
    if (typeof _surveyStart_ === 'function') {
      _surveyStart_(fromPhone);
      return { reply: '' };
    }
  }
  if (trimmed === 'אשר') {
    if (typeof _surveyHandleText_ === 'function') {
      var __survConfirm = _surveyHandleText_(fromPhone, 'אשר');
      return { reply: (__survConfirm && __survConfirm.replyText) || '' };
    }
  }

  // ───── VAT-DEDUCTIBLE FLAG ("מעמ" / "/מעמ" / "ניכוי מעמ") ─────
  // Israeli עוסק מורשה need to mark certain expenses as VAT-deductible so
  // they can claim back the VAT at year-end. The user logs an expense
  // normally, then sends "מעמ" (or any of the aliases below) to flip the
  // LAST row's col I (ניכוי מע״מ) to TRUE.
  //
  // Matched BEFORE the expense parser so a user typing "מעמ" alone is not
  // mis-parsed as an expense. Also matches the geresh + slash forms
  // ("מע״מ", "מע'מ", "/מעמ") because Hebrew users vary how they type מע״מ.
  if (/^\s*\/?\s*(?:מעמ|מע["׳'״]מ|ניכוי\s+מע["׳'״]?מ|ניכוי\s+מעמ|vat)\s*$/i.test(text)) {
    return { reply: _markLastExpenseAsVatDeductible_(fromPhone) };
  }

  // ───── BUDGETS ("תקציבים") ─────
  // MUST run before the expense parser below, otherwise "תקציב מזון 1500"
  // would attempt to register as a ₪1500 expense.
  //
  //   "תקציב"          -> show current budgets + MTD progress per category
  //   "תקציב <cat> <n>" -> set monthly cap of n NIS for <cat> (full label)
  //
  // Talks to Vercel /api/budgets using bot-secret + phone identification
  // (same pattern as _tenantAppendStructured_).
  if (trimmed === 'תקציב' || trimmed === 'תקציבים' || trimmed === 'budget' || trimmed === 'budgets') {
    if (typeof _budgetListAndProgress_ === 'function') return { reply: _budgetListAndProgress_(fromPhone) };
  }
  var __budSet = text.trim().match(/^(?:תקציב|budget)\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*$/i);
  if (__budSet && typeof _budgetSet_ === 'function') {
    return { reply: _budgetSet_(fromPhone, __budSet[1].trim(), parseFloat(String(__budSet[2]).replace(',', '.'))) };
  }

  // ───── PERSONAL RECURRING EXPENSES ("הוצאות קבועות") ─────
  // MUST run before the expense parser below, otherwise "קבוע 2500 שכירות"
  // would be logged as a plain ₪2500 expense. Order within this block:
  // exact-match list/sync first, then the delete/update/toggle prefixes,
  // then the broad "קבוע "/"הוצאה קבועה " add prefix LAST.
  if (trimmed === 'רשימת קבועות' || trimmed === 'קבועות' ||
      trimmed === 'list recurring' || trimmed === 'recurring') {
    if (typeof _recurringList_ === 'function') return { reply: _recurringList_(fromPhone) };
  }
  if (trimmed === 'סנכרן הוצאות קבועות' || trimmed === 'סנכרן קבועות' ||
      trimmed === 'sync recurring') {
    if (typeof _recurringSync_ === 'function') return { reply: _recurringSync_(fromPhone) };
  }
  var __recDel = text.trim().match(/^(?:מחק\s+קבוע|delete\s+recurring)\s+(.+)$/i);
  if (__recDel && typeof _recurringRemove_ === 'function') {
    return { reply: _recurringRemove_(fromPhone, __recDel[1].trim()) };
  }
  var __recUpd = text.trim().match(/^(?:עדכן\s+קבוע|update\s+recurring)\s+(.+)$/i);
  if (__recUpd && typeof _recurringUpdate_ === 'function') {
    return { reply: _recurringUpdate_(fromPhone, __recUpd[1].trim()) };
  }
  var __recPause = text.trim().match(/^(?:השהה\s+קבוע|pause\s+recurring)\s+(.+)$/i);
  if (__recPause && typeof _recurringToggle_ === 'function') {
    return { reply: _recurringToggle_(fromPhone, __recPause[1].trim(), 'paused') };
  }
  var __recResume = text.trim().match(/^(?:הפעל\s+קבוע|resume\s+recurring)\s+(.+)$/i);
  if (__recResume && typeof _recurringToggle_ === 'function') {
    return { reply: _recurringToggle_(fromPhone, __recResume[1].trim(), 'active') };
  }
  var __recFlip = text.trim().match(/^(?:החלף\s+מצב\s+קבוע|toggle\s+recurring)\s+(.+)$/i);
  if (__recFlip && typeof _recurringToggle_ === 'function') {
    return { reply: _recurringToggle_(fromPhone, __recFlip[1].trim()) };
  }
  var __recAdd = text.trim().match(/^(?:הוצאה\s+קבועה|קבוע|recurring\s+add|add\s+recurring)\s+(.+)$/i);
  if (__recAdd && typeof _recurringAdd_ === 'function') {
    return { reply: _recurringAdd_(fromPhone, __recAdd[1].trim()) };
  }
  // Examples — onboarding helper. "דוגמאות" shows how to write expenses.
  if (trimmed === 'דוגמאות' || trimmed === 'דוגמא' || trimmed === 'examples' || trimmed === 'example') {
    if (typeof _getExamplesMessage_ === 'function') return { reply: _getExamplesMessage_(fromPhone) };
  }
  // Note — "הערה: שילמתי במזומן" attaches a note to the LAST expense.
  var __noteM = text.match(/^\s*הערה\s*[:：]\s*(.+)$/i) || text.match(/^\s*note\s*[:：]\s*(.+)$/i);
  if (__noteM && typeof _addNoteToLast_ === 'function') {
    return { reply: _addNoteToLast_(__noteM[1].trim()) };
  }
  // Search — "חפש קפה" returns matching expenses + total
  var __searchM = text.trim().match(/^(?:חפש|search)\s+(.+)$/i);
  if (__searchM && typeof _searchExpenses_ === 'function') {
    return { reply: _searchExpenses_(__searchM[1].trim()) };
  }
  // Correction — "תיקון סכום 250" / "תיקון פירוט קפה ארומה" / "תיקון תאריך 12/4"
  // edits the LAST logged expense's amount / description / date.
  var __corrM = text.trim().match(/^(?:תיקון|תקן|fix|correct)\s+(סכום|פירוט|תיאור|תאריך|amount|description|date)\s+(.+)$/i);
  if (__corrM && typeof _correctLastExpense_ === 'function') {
    return { reply: _correctLastExpense_(__corrM[1], __corrM[2].trim()) };
  }
  // Settings — "הגדרות" shows/edits preferences
  if (trimmed === 'הגדרות' || trimmed === 'settings' || trimmed === 'preferences') {
    if (typeof _handleSettings_ === 'function') return { reply: _handleSettings_(fromPhone, '') };
  }
  var __setM = text.trim().match(/^(?:הגדרות|settings)\s+(.+)$/i);
  if (__setM && typeof _handleSettings_ === 'function') {
    return { reply: _handleSettings_(fromPhone, __setM[1].trim()) };
  }
  // Account deletion flow — "מחק חשבון" → confirm → "מחק חשבון כן"
  if (/^מחק\s+חשבון$/i.test(trimmed) || trimmed === 'delete account') {
    if (typeof _handleAccountDeletion_ === 'function') return { reply: _handleAccountDeletion_(fromPhone, false) };
  }
  if (/^מחק\s+חשבון\s+כן$/i.test(trimmed) || trimmed === 'delete account yes') {
    if (typeof _handleAccountDeletion_ === 'function') return { reply: _handleAccountDeletion_(fromPhone, true) };
  }
  // Referral
  if (trimmed === 'הזמן' || trimmed === 'הפניה' || trimmed === 'referral' || trimmed === 'invite') {
    if (typeof _getReferralLink_ === 'function') return { reply: _getReferralLink_(fromPhone) };
  }
  // Upgrade — direct user to the upgrade page with a special bot offer.
  if (trimmed === 'שדרוג' || trimmed === 'upgrade' || trimmed === 'פרימיום' || trimmed === 'pro') {
    return { reply:
      '🚀 *שדרוג ל-Pro / Family*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      '*Pro — ₪19/חודש:*\n' +
      '  ✓ סיווג AI אוטומטי (Claude)\n' +
      '  ✓ OCR לקבלות בתמונה\n' +
      '  ✓ קבוצות ללא הגבלה\n' +
      '  ✓ ייצוא חודשי\n\n' +
      '*Family — ₪39/חודש:*\n' +
      '  ✓ הכל ב-Pro\n' +
      '  ✓ עד 6 חברים בקבוצה\n' +
      '  ✓ דוחות משפחתיים\n' +
      '  ✓ תזכורות מתקדמות\n\n' +
      'לשדרוג: https://kesefle.com/pricing?ref=bot' };
  }
  if (trimmed === 'תובנות' || trimmed === 'תובנה' || trimmed === 'insights' || trimmed === 'insight') {
    return { reply: getInsightsMessage() };
  }
  if (trimmed === 'סטטוס' || trimmed === 'מצב' || trimmed === 'status' || trimmed === 'health') {
    if (typeof getBotStatusMessage === 'function') return { reply: getBotStatusMessage(fromPhone) };
  }
  if (trimmed === 'הד' || trimmed === 'echo' || trimmed === 'ping') {
    var __tzEcho = _getUserTz_(fromPhone);
    return { reply: '🏓 הבוט פעיל! קיבלתי את "' + text + '" ב-' + Utilities.formatDate(new Date(), __tzEcho, 'HH:mm:ss') };
  }
  // Goal tracking commands
  if (trimmed === 'מטרות' || trimmed === 'goals' || trimmed === 'יעדים') {
    if (typeof getGoalsMessage === 'function') return { reply: getGoalsMessage() };
  }
  if (text.trim().match(/^מטרה\s*[:\-]/i)) {
    if (typeof parseGoalCommand === 'function') {
      var __goalParsed = parseGoalCommand(text);
      if (__goalParsed && typeof addGoal === 'function') return { reply: addGoal(__goalParsed) };
    }
  }
  var __delGoalM = text.trim().match(/^מחק\s+מטרה\s+(.+)$/i);
  if (__delGoalM && typeof deleteGoal === 'function') return { reply: deleteGoal(__delGoalM[1].trim()) };

  // Multi-tenant account linking: "קוד 482917" / "code 482917" / "link 482917"
  // Bot's `from` phone (the sender) is provided by doPost in the calling context.
  // We accept the command anywhere in the text in case the user wrote extras.
  var codeMatch = text.match(/(?:קוד|code|link)\s*[:\-]?\s*(\d{6})\b/i);
  if (codeMatch) {
    return { reply: handleLinkCode_(codeMatch[1], (typeof __from_ !== 'undefined' ? __from_ : null) || (this && this.__from_) || '') };
  }

  // Extract an optional leading date token ("אתמול", "12/4", "1.5",
  // etc.) so users can backfill past expenses. Falls through harmlessly
  // when the message starts with an amount.
  var __dateInfo = null;
  try { __dateInfo = _extractLeadingDate_(text); } catch (_dErr) {}
  var __workingText = __dateInfo ? __dateInfo.remaining : text;

  const fx = parseForeignCurrencyHint(__workingText);
  const parsed = parseAmountAndDescription(fx ? (fx.ilsAmount + ' ' + fx.cleanedText) : __workingText);
  if (!parsed || !parsed.items || parsed.items.length === 0) {
    // FIRST: try the deterministic data-query path -- pattern-match the
    // question against the user's real sheet data via /api/sheet/bot-query.
    // This is BEFORE concierge + Gemini so questions like "how much did I
    // spend this week" get a real number, not an LLM hallucination. Only
    // fires for premium users (free tier sees an upgrade reply); falls
    // through silently when no pattern matches.
    var __bqAns = null;
    try { __bqAns = _botQueryAnswer_(fromPhone, text); } catch (_bqe) { Logger.log('bot-query err: ' + (_bqe && _bqe.message)); }
    if (__bqAns && __bqAns.ok && __bqAns.reply) {
      return { reply: __bqAns.reply };
    }
    // Not a logged expense -- try the Gemini concierge to understand + respond
    // personally before giving up with the generic line.
    var __cg = null;
    try { __cg = _botConcierge_(fromPhone, text); } catch (_cge) { Logger.log('concierge err: ' + (_cge && _cge.message)); }
    if (__cg) {
      if (__cg.action === 'summary') { try { return { reply: getMonthlySummary(fromPhone) }; } catch (_s1) {} }
      if (__cg.action === 'help') { try { return { reply: getHelpMessage() }; } catch (_s2) {} }
      if (__cg.action === 'examples') { try { return { reply: _getExamplesMessage_(fromPhone) }; } catch (_s3) {} }
      if (__cg.action === 'orders') { try { return { reply: getOrdersSummary() }; } catch (_s4) {} }
      if (__cg.reply) return { reply: __cg.reply };
    }
    // Last resort: try Gemini as a money-coach for the user's question.
    // This is the "free-form chat" feature -- the bot answers money/budgeting
    // questions in Hebrew, scoped to topics it can actually help with. Only
    // fires for messages that look like real questions (>= 3 words OR contain
    // "?"), to avoid spending an LLM call on every garbage message. Gracefully
    // falls through to the generic reply if Gemini is unavailable or returns
    // something nonsensical.
    try {
      var __isQuestion = /\?$|איך|מתי|למה|כמה|מה|איפה|why|when|how|what|where/i.test(text.trim());
      var __wordCount = String(text || '').trim().split(/\s+/).length;
      if ((typeof _geminiGenerate_ === 'function') && (__isQuestion || __wordCount >= 3)) {
        var __coachSystem =
          'אתה כספלה - בוט יועץ פיננסי חברותי בעברית. ' +
          'תענה בקצרה (עד 4 משפטים) בעברית ידידותית. ' +
          'הקפד: רק עצות פיננסיות פרקטיות (תקציב, חיסכון, ניהול הוצאות, החזרי מסים, הוצאות חוזרות). ' +
          'אל תיתן ייעוץ השקעות ספציפי, לא ייעוץ משכנתאות, לא תחזיות על מטבעות/מניות. ' +
          'אם השאלה לא קשורה לכסף - תפנה לכתיבת הוצאה, בלי להסביר למה. ' +
          'תזכיר את הפקודות הרלוונטיות (סיכום / תקציב / קבוע / מעמ) כשמתאים.';
        var __coachReply = _geminiGenerate_(__coachSystem, text);
        if (__coachReply && String(__coachReply).trim().length > 10 && String(__coachReply).trim().length < 500) {
          return { reply: '💬 ' + String(__coachReply).trim() };
        }
      }
    } catch (__chatErr) { Logger.log('free-chat err: ' + (__chatErr && __chatErr.message)); }

    return { reply: '🤔 לא הבנתי. התכוונת לרשום הוצאה?\n' +
      'אפשר לכתוב כמו שמדברים — למשל "150 סופר" או "ארנונה 500".\n' +
      'שלח *דוגמאות* לעוד רעיונות 💡\n' +
      'או שאל אותי שאלה על הכסף שלך 💬' };
  }
  // Stamp the EXACT raw user input onto every parsed item (overriding the
  // parser's view, which may be the FX-rewritten text). This is the value we
  // later persist as a cell note so the audit trail keeps the user's typed
  // currency (e.g. "50$ amazon") not the converted ILS string.
  try {
    parsed.items.forEach(function(__pi){ __pi.originalText = text; });
  } catch (_oeErr) { Logger.log('originalText stamp err: ' + (_oeErr && _oeErr.message)); }

  try {
    Logger.log('processExpense: opening sheet ' + SHEET_ID + ' tab ' + TRANSACTIONS_SHEET);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) {
      Logger.log('processExpense: sheet not found!');
      return { reply: '😬 לא נמצאה לשונית "תנועות"\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט' };
    }
    Logger.log('processExpense: sheet found, items=' + parsed.items.length);
    // Honour an explicit leading-date token if the user supplied one
    // (parsed earlier as __dateInfo); otherwise stamp with current time.
    const now = (__dateInfo && __dateInfo.date) ? __dateInfo.date : new Date();
    const monthKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM');
    const writtenLines = [];
    let runningTotal = 0;

    // === AMBIGUITY DETECTION (single-item case only — multi-item batches skip this) ===
    // Confidence tiers (TASK 3):
    //   >= 0.85  → write directly, no preliminary message
    //   0.70-0.85 → write directly + soft "💡 לא הייתי בטוח 100%" hint
    //   0.40-0.70 → interactive list with 3 options (AI top + 2 alts)
    //   < 0.40 / בלתי מזוהה → interactive list with 5+ options
    var __softHintTail = '';
    if (parsed.items.length === 1 && fromPhone) {
      var soleItem = parsed.items[0];
      var earlyCached = _learnedLookup(soleItem.description);
      var earlyKeywordMatch = earlyCached ? null : matchCategory(soleItem.description);
      var hasKeywordMatch = earlyKeywordMatch && !(earlyKeywordMatch.category === DEFAULT_CATEGORY.category &&
                                                    earlyKeywordMatch.subcategory === DEFAULT_CATEGORY.subcategory);
      var keywordOrCached = earlyCached || (hasKeywordMatch ? earlyKeywordMatch : null);

      // Audit: keyword/cached path (logged here, AI path logs further down)
      if (keywordOrCached) {
        try {
          _logMLAudit_({
            user_text: soleItem.description,
            amount: Math.abs(soleItem.amount),
            keyword_match_category: hasKeywordMatch ? earlyKeywordMatch.category : '',
            keyword_match_subcategory: hasKeywordMatch ? earlyKeywordMatch.subcategory : '',
            final_category: keywordOrCached.category,
            final_subcategory: keywordOrCached.subcategory,
            via: earlyCached ? 'cached' : 'keyword',
            from_phone: fromPhone
          });
        } catch (_auditErr) {}
      }

      if (!keywordOrCached) {
        var apiKeyAvail = !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
        var aiRich = null;
        if (apiKeyAvail) {
          try { sendWhatsAppMessage(fromPhone, '🤖 מנתח את ההוצאה...'); } catch (_pmErr) {}
          try { aiRich = _aiCategorizeRich(soleItem.description); } catch (_aiErr) { Logger.log('processExpense: AI rich error: ' + _aiErr.message); }
        }

        var aiConf = (aiRich && typeof aiRich.confidence === 'number') ? aiRich.confidence : 0;
        // "Clear" means: a real category that ISN'T the misc/default
        // bucket. If the AI lands on שונות / שונות ואחרים / בלתי מזוהה,
        // we treat it as unclear and force the user to pick — so nothing
        // gets quietly dumped into "שונות".
        var aiOK = aiRich && aiRich.category &&
                   aiRich.category !== 'בלתי מזוהה' &&
                   aiRich.category !== 'שונות' &&
                   aiRich.category !== 'שונות ואחרים';
        var TIER_DIRECT     = 0.85;
        var TIER_SOFT       = 0.70;
        var TIER_LIST_SMALL = 0.40;

        if (aiOK && aiConf >= TIER_DIRECT) {
          // Tier A: write directly, no preliminary, no soft hint.
          try { _learnedSave(soleItem.description, { category: aiRich.category, subcategory: aiRich.subcategory }, 'ai'); } catch (_lsErr) {}
          try {
            _logMLAudit_({
              user_text: soleItem.description,
              amount: Math.abs(soleItem.amount),
              ai_category: aiRich.category,
              ai_confidence: aiConf,
              final_category: aiRich.category,
              final_subcategory: aiRich.subcategory,
              via: 'ai',
              from_phone: fromPhone
            });
          } catch (_e) {}
        } else {
          // BELOW the direct-write bar (anything under 0.85) → HOLD the
          // expense and force the user to pick the category + subcategory
          // from a list. Product decision (per Steven): an unclear
          // expense/income is NEVER filed silently — the user guides the
          // bot. This merged in the old 0.70–0.85 "soft hint auto-write"
          // tier: those now ask too, rather than guessing.
          // Tier C/D: interactive list (4 options if conf>=0.4, else 6).
          var listSize = (aiOK && aiConf >= TIER_LIST_SMALL) ? 4 : 6;
          try {
            var predictions = _predictTopCategories(soleItem.description, Math.max(listSize, 5));
            if (aiRich && aiRich.category && aiRich.category !== 'בלתי מזוהה') {
              var aiPick = { category: aiRich.category, subcategory: aiRich.subcategory, isIncome: false, confidence: aiRich.confidence };
              var filtered = [aiPick];
              for (var pp = 0; pp < predictions.length && filtered.length < listSize; pp++) {
                var p = predictions[pp];
                if (p.category === aiPick.category && p.subcategory === aiPick.subcategory) continue;
                filtered.push(p);
              }
              predictions = filtered;
            } else {
              predictions = predictions.slice(0, listSize);
            }
            var sections = _buildCategoryListSections(predictions, Math.abs(soleItem.amount), soleItem.description);
            var pendingKey = 'pending:' + fromPhone;
            PropertiesService.getScriptProperties().setProperty(pendingKey, JSON.stringify({
              amount: Math.abs(soleItem.amount),
              description: soleItem.description,
              rawText: (soleItem.originalText || text || ''),
              ts: Date.now()
            }));
            var bodyText = '₪' + Math.abs(soleItem.amount) + ' • "' + soleItem.description.slice(0, 100) + '"';
            if (aiRich && aiRich.reason) {
              bodyText += '\n\n🤖 ניחוש: ' + aiRich.category + ' / ' + aiRich.subcategory +
                          ' (' + Math.round((aiRich.confidence || 0) * 100) + '%)';
            }
            bodyText += '\n\nבחר את הקטגוריה הנכונה:';
            sendWhatsAppInteractiveList(
              fromPhone,
              aiRich ? 'צריך אישור' : 'לא בטוח בקטגוריה',
              bodyText,
              'הבחירה תילמד אוטומטית',
              'בחר',
              sections
            );
            try {
              _logMLAudit_({
                user_text: soleItem.description,
                amount: Math.abs(soleItem.amount),
                ai_category: aiRich ? aiRich.category : '',
                ai_confidence: aiConf,
                via: 'ambiguity_list_sent',
                from_phone: fromPhone
              });
            } catch (_e) {}
            Logger.log('processExpense: sent interactive list (' + listSize + ' opts) for "' + soleItem.description + '" aiConf=' + aiConf);
            return { ambiguousSent: true };
          } catch (ambErr) {
            Logger.log('processExpense: ambiguity-list failed, falling through: ' + (ambErr && ambErr.stack || ambErr));
          }
        }
      }
    }

    parsed.items.forEach(function(item){
      const matched = matchCategorySmart(item.description);
      const finalAmount = Math.abs(item.amount);
      runningTotal += finalAmount;
      _coerceCategoryBySubcategory(matched);
      Logger.log('processExpense: appendRow amount=' + finalAmount + ' sub=' + matched.subcategory);
      sheet.appendRow([now, monthKey, finalAmount, sanitizeForSheet(matched.category), sanitizeForSheet(matched.subcategory), sanitizeForSheet(item.description), 'WhatsApp', true]);
      Logger.log('processExpense: appendRow DONE, lastRow=' + sheet.getLastRow());
      // ── Original-text cell note (column F = פירוט). Records the raw user
      // message + optional FX conversion line. Capture row number BEFORE the
      // sort below so the note lands on the right row even if it shifts.
      var __newRowForNote = sheet.getLastRow();
      try {
        var __noteExtras = [];
        if (fx) {
          if (fx.autoConverted) {
            __noteExtras.push('FX: ' + (fx.foreignAmount || '') + (fx.foreignSymbol || '') + ' → ₪' + fx.ilsAmount + ' (rate ' + (fx.fxRate || '') + ')');
          } else if (fx.note) {
            __noteExtras.push('FX: ' + fx.note);
          }
        }
        _kfl_setRowOriginalNote(sheet, __newRowForNote, _kfl_buildOriginalNote('Original WhatsApp', item.originalText || text || item.description, __noteExtras));
      } catch (__noteErr) { Logger.log('processExpense note err: ' + (__noteErr && __noteErr.message)); }
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
      // 📝 Mirror this expense into the matching dashboard cell as a NOTE
      // (מאזן אישי / מאזן חברה) so hovering a monthly category total shows the
      // breakdown of what made it up — same idea as the תנועות note. Note only:
      // never touches the cell value or its SUMIFS formula. FX info, when
      // present, is folded into the same line.
      try {
        var __dashDesc = String(item.description || item.originalText || text || '').trim();
        if (fx && fx.note) __dashDesc += ' (' + fx.note + ')';
        _dashboardDetailNote_(matched.category, matched.subcategory, monthKey, finalAmount, __dashDesc, now);
      } catch (eN) { Logger.log('dashboard note err: ' + (eN && eN.message)); }
      try {
        _updateBusinessDashboard_(matched.category, matched.subcategory, monthKey, finalAmount);
      } catch (_dashErr) {
        Logger.log('processExpense: dashboard update err: ' + (_dashErr && _dashErr.message));
      }
      try { _updateNoteForLastTransaction(); } catch(_e){}
      const emoji = matched.isIncome ? '💵' : '💸';
      writtenLines.push(emoji + ' ₪' + finalAmount.toLocaleString('he-IL') + ' → ' + matched.subcategory);
    });
    // 🌱 Streak bump (silent if disabled) — runs after every successful write.
    var __streakTail = '';
    try {
      var __streak = _bumpStreak_();
      var __celebration = _streakCelebrationLine_(__streak);
      if (__celebration) __streakTail = '\n\n' + __celebration;
    } catch (__streakErr) { Logger.log('streak err: ' + (__streakErr && __streakErr.message)); }

    // 🔮 Anomaly detection — runs after every successful write. Returns at most
    // ONE soft alert line per reply. Failure is silent so anomalies never block
    // the user's confirmation.
    var __anomalyTail = '';
    try {
      if (!_anomalyAlertsDisabled_()) {
        var __lastItem = parsed.items[parsed.items.length - 1];
        var __lastMatched = matchCategorySmart(__lastItem.description);
        var __anom = detectAnomalies(Math.abs(__lastItem.amount), __lastMatched.category, __lastItem.description);
        if (__anom && __anom.message) __anomalyTail = '\n\n' + __anom.message;
      }
    } catch (__anomErr) { Logger.log('anomaly err: ' + (__anomErr && __anomErr.message)); }

    // 💰 Budget alert — runs after every expense, returns at most ONE alert
    // line for the most-recent category. Throttled per (phone, category, tier)
    // for 6h via CacheService. Failure is silent.
    var __budgetTail = '';
    try {
      var __budgetLastItem = parsed.items[parsed.items.length - 1];
      var __budgetLastMatched = matchCategorySmart(__budgetLastItem.description);
      if (!__budgetLastMatched.isIncome) {
        __budgetTail = _budgetAlertTail_(__budgetLastMatched.category, fromPhone) || '';
      }
    } catch (__bgtErr) { Logger.log('budget tail err: ' + (__bgtErr && __bgtErr.message)); }

    if (parsed.items.length === 1) {
      const it = parsed.items[0];
      const matched = matchCategorySmart(it.description);
      try { _saveLastExpense_(fromPhone, sheet.getLastRow(), it, matched); } catch (_seErr) { Logger.log('saveLastExp: ' + _seErr.message); }
      // 💡 Optional month-to-date context for the category just logged.
      var __catCtx = '';
      try { __catCtx = _categoryMonthToDateLine_(matched.category, matched.isIncome); } catch (__ctxErr) {}
      var __subLabel = (matched.subcategory && matched.subcategory !== matched.category) ? '\n🏷️ ' + matched.subcategory : '';
      var __globalNote = matched.fromGlobal ? '\n📚 למדתי ממשתמשים אחרים' : '';
      // 🔁 Proactive recurring suggestion (owner sheet → direct history read).
      // If this expense has repeated at a stable amount across >=3 months we
      // OFFER to track it as recurring (deduped to once per expense). Best-effort
      // and silent on failure so it can never block the confirmation reply.
      var __recurringTail = '';
      try {
        var __histData = sheet.getDataRange().getValues();
        var __hist = [];
        for (var __hr = 1; __hr < __histData.length; __hr++) {
          __hist.push({
            description: __histData[__hr][5],
            amount: __histData[__hr][2],
            monthKey: __histData[__hr][1],
            isIncome: String(__histData[__hr][3] || '') === 'הכנסות',
          });
        }
        __recurringTail = _recurringSuggestionLine_(fromPhone, __hist, {
          description: it.description, amount: it.amount, monthKey: monthKey, isIncome: matched.isIncome,
        });
      } catch (__recErr) { Logger.log('recurring suggest err: ' + (__recErr && __recErr.message)); }
      // When FX auto-conversion happened, surface both the original and the ILS amount.
      var __fxOriginal = '';
      if (fx && fx.autoConverted && fx.foreignAmount && fx.foreignSymbol) {
        __fxOriginal = ' (' + fx.foreignAmount + fx.foreignSymbol + ')';
      }
      return { reply:
        '✅ ₪' + Math.abs(it.amount).toLocaleString('he-IL') + __fxOriginal + ' ל' + (it.description || matched.subcategory) + '. נשמר אצלך בגיליון 📊' +
        '\n📂 ' + matched.category + __subLabel + __globalNote +
        (__catCtx ? '\n💡 ' + __catCtx : '') +
        __anomalyTail +
        __budgetTail +
        __recurringTail +
        __streakTail +
        (__softHintTail || '') +
        '\n\n❓ קטגוריה לא מדויקת? שלח "קטגוריה <השם הנכון>" ואני אלמד.' +
        '\nכתוב "סיכום" לראות איפה אתה עומד החודש.' +
        _sheetLinkLine_(fromPhone)
      };
    }
    return { reply: '✅ נרשמו ' + parsed.items.length + ' פעולות (סה"כ ₪' + runningTotal.toLocaleString('he-IL') + ') 📊\n' + writtenLines.join('\n') + __anomalyTail + __budgetTail + __streakTail + _sheetLinkLine_(fromPhone) };
  } catch (err) {
    return { reply: '😬 משהו השתבש בכתיבה לגיליון: ' + (err && err.message || '') + '\n💡 ננסה שוב בעוד דקה? אם זה ממשיך — שלח "עזרה".' };
  }
}

// Rough fixed-rate conversion table — used when user writes "50$ amazon" without ILS amount.
// Rates are 2026 estimates. Bot prefers user-supplied ILS amount when present.
// Each rate can be overridden via Script Properties: FX_RATE_USD, FX_RATE_EUR,
// FX_RATE_GBP, FX_RATE_CAD, FX_RATE_AUD, FX_RATE_JPY, FX_RATE_CHF.
// installKesefleBot() surfaces the effective rates in its diagnostics report.
var KFL_FX_DEFAULTS = {
  USD: 3.65, EUR: 3.95, GBP: 4.65,
  CAD: 2.65, AUD: 2.40, JPY: 0.024, CHF: 4.10
};

function _kfl_fxRate(code) {
  if (!code) return null;
  var k = String(code).toUpperCase().trim();
  try {
    var override = PropertiesService.getScriptProperties().getProperty('FX_RATE_' + k);
    if (override) {
      var n = parseFloat(override);
      if (!isNaN(n) && n > 0) {
        Logger.log('_kfl_fxRate: override FX_RATE_' + k + '=' + n);
        return n;
      }
    }
  } catch (_e) {}
  return KFL_FX_DEFAULTS[k] || null;
}

// KFL_FX_RATES kept for legacy callers (KFL_FX_RATES.USD, KFL_FX_RATES['$']).
// Built once at script load from current Script Property overrides + defaults.
var KFL_FX_RATES = {
  USD: _kfl_fxRate('USD'), EUR: _kfl_fxRate('EUR'), GBP: _kfl_fxRate('GBP'),
  CAD: _kfl_fxRate('CAD'), AUD: _kfl_fxRate('AUD'), JPY: _kfl_fxRate('JPY'), CHF: _kfl_fxRate('CHF'),
  '$': _kfl_fxRate('USD'), '€': _kfl_fxRate('EUR'), '£': _kfl_fxRate('GBP'), '¥': _kfl_fxRate('JPY')
};

function _kfl_fxLookup(symbolOrCode) {
  if (!symbolOrCode) return null;
  var raw = String(symbolOrCode).trim();
  var k = raw.toUpperCase();
  // Always read fresh so Script Property overrides take effect without re-deploy.
  if (k === '$') return _kfl_fxRate('USD');
  if (k === '€') return _kfl_fxRate('EUR');
  if (k === '£') return _kfl_fxRate('GBP');
  if (k === '¥') return _kfl_fxRate('JPY');
  if (k === 'USD' || k === 'EUR' || k === 'GBP' || k === 'CAD' || k === 'AUD' || k === 'JPY' || k === 'CHF') {
    return _kfl_fxRate(k);
  }
  // Hebrew currency names — most specific first to avoid "אוסטרלי" matching after "דולר אוסטרלי".
  if (/דולר\s*קנדי|קנדי/i.test(raw)) return _kfl_fxRate('CAD');
  if (/דולר\s*אוסטרלי|אוסטרלי/i.test(raw)) return _kfl_fxRate('AUD');
  if (/דולר/i.test(raw)) return _kfl_fxRate('USD');
  if (/יורו|אירו/i.test(raw)) return _kfl_fxRate('EUR');
  if (/פאונד/i.test(raw)) return _kfl_fxRate('GBP');
  if (/יין/i.test(raw)) return _kfl_fxRate('JPY');
  if (/פרנק/i.test(raw)) return _kfl_fxRate('CHF');
  return null;
}

function parseForeignCurrencyHint(text) {
  if (!text) return null;
  var s = String(text);
  // Broader currency detection — symbols, ISO codes, Hebrew names.
  var foreignRe = /(\$|€|£|¥|usd|eur|gbp|cad|aud|jpy|chf|דולר|דולרים|יורו|אירו|פאונד|יין|פרנק)/i;
  if (!foreignRe.test(s)) return null;

  // Path A — user gave both amounts (e.g. "50$ amazon 180 שח")
  var ilsRe = /(\d+(?:[.,]\d+)?)\s*(?:שקל(?:ים)?|ש["״']?ח|nis|ils)/i;
  var m = s.match(ilsRe);
  if (m) {
    var ilsAmount = Number(String(m[1]).replace(/,/g, ''));
    if (!isNaN(ilsAmount) && ilsAmount > 0) {
      var note = s.trim();
      var fxBlockRe = /(\$|€|£|¥|\d)[^,\n]{0,80}?(שקל|ש["״']?ח|nis|ils)/i;
      var blockMatch = s.match(fxBlockRe);
      if (blockMatch && blockMatch[0].length < note.length) note = blockMatch[0].trim();
      var cleanedTextA = s.replace(/\d+(?:[.,]\d+)?\s*(?:\$|€|£|¥|usd|eur|gbp|cad|aud|jpy|chf|דולר(?:ים)?|יורו|אירו|פאונד|יין|פרנק|שקל(?:ים)?|ש["״']?ח|nis|ils)/gi, '').replace(/[\\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
      return { ilsAmount: ilsAmount, note: note, cleanedText: cleanedTextA, autoConverted: false };
    }
  }

  // Path B — auto-convert from foreign currency using fixed rates.
  // Patterns: "50$ amazon", "$50 amazon", "50 usd amazon", "50 דולר", "12 יורו spotify",
  // "100 cad uber", "5000 jpy sushi", "80 chf hotel"
  var foreignAmountRe = /(\d+(?:[.,]\d+)?)\s*(\$|€|£|¥|usd|eur|gbp|cad|aud|jpy|chf|דולר(?:ים)?|יורו|אירו|פאונד|יין|פרנק)/i;
  var foreignSymRe = /(\$|€|£|¥)\s*(\d+(?:[.,]\d+)?)/i;
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
  var noteB = sym + ' ' + amount + ' → ₪' + converted + ' (שער ' + rate + ')';
  var cleanedTextB = s.replace(/\d+(?:[.,]\d+)?\s*(?:\$|€|£|¥|usd|eur|gbp|cad|aud|jpy|chf|דולר(?:ים)?|יורו|אירו|פאונד|יין|פרנק)/gi, '').replace(/(\$|€|£|¥)\s*\d+(?:[.,]\d+)?/gi, '').replace(/\s+/g, ' ').trim();
  Logger.log('parseForeignCurrencyHint: ' + amount + ' ' + sym + ' * ' + rate + ' = ₪' + converted);
  return { ilsAmount: converted, note: noteB, cleanedText: cleanedTextB, autoConverted: true, fxRate: rate, foreignAmount: amount, foreignSymbol: sym };
}

function parseAmountAndDescription(text) {
  var t = String(text || '').trim();
  if (!t) return null;
  // Match Israeli-formatted numbers: optional thousand groups (1,234,567)
  // followed by an optional decimal part using period or comma. The thousand
  // groups are distinguished from a decimal-comma by length: any comma that
  // is followed by exactly three digits AND another digit/comma group is a
  // thousand separator; anything else is the decimal point.
  var numberRe = /\d{1,3}(?:[,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
  var nums = [];
  var match;
  while ((match = numberRe.exec(t)) !== null) {
    var n = _parseIsraeliNumber_(match[0]);
    if (!isNaN(n) && n > 0) nums.push(n);
  }
  if (nums.length === 0) return null;
  // Strip digits/punctuation, the ₪ symbol, and standalone currency words so
  // they don't pollute the saved description or the category match
  // (e.g. "50 שח קפה" → "קפה", "₪50 קפה" → "קפה").
  var note = t.replace(/[\d.,+₪$€]/g, ' ')
              .replace(/(^|\s)(שח|ש"ח|ש״ח|שקל|שקלים|nis|ils|usd|eur)(?=\s|$)/gi, ' ')
              .replace(/\s+/g, ' ').trim();
  if (!note) note = 'ללא פירוט';
  // originalText preserves the EXACT raw input so callers can save it as a
  // cell note in the transactions sheet. processExpense overrides this with
  // the true raw message (before FX conversion) right after calling us.
  return {
    items: nums.map(function(n){ return { amount: n, description: note, originalText: t }; })
  };
}

function _splitAmounts_(block) {
  return String(block || '').split('+').map(function(p){ return _parseIsraeliNumber_(String(p).replace(/\s+/g,'')); }).filter(function(n){ return !isNaN(n) && n > 0; });
}

// Strip a leading date token from a user message and return the date it
// represents plus the remaining text. Lets users say "אתמול 50 קפה" and
// have the row dated yesterday instead of today. Returns null if the
// message doesn't start with a recognised date token, so callers fall
// back to new Date() for the timestamp.
//
// Supported forms (must be at the very start of the trimmed input):
//   אתמול / yesterday          → today - 1
//   שלשום                       → today - 2
//   מחר / tomorrow              → today + 1
//   D/M, DD/MM, D.M, DD.MM      → that day this year (last year if future)
//   D/M/YY, DD/MM/YYYY          → exact date
//
// We deliberately do NOT match bare "DD-MM" because hyphen-separated
// digit pairs commonly appear inside size specs (e.g. "120-80") and
// amount ranges. Period and slash are unambiguous.
function _extractLeadingDate_(text) {
  if (!text) return null;
  var s = String(text).trim();
  if (!s) return null;

  function withTime(dateOnly) {
    // Preserve the current wall-clock time so "אתמול 50 קפה" at 16:42
    // produces a row dated yesterday@16:42, not yesterday@00:00. Keeps
    // sort order stable when the user logs several past-dated expenses
    // in a row.
    var n = new Date();
    dateOnly.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), 0);
    return dateOnly;
  }

  // Word tokens first (cheapest match). JS \b is a transition between a
  // word char (a-z, 0-9, _) and a non-word char — Hebrew letters are NOT
  // word chars, so \b right after "אתמול" never matches. Use an explicit
  // whitespace/end lookahead instead.
  var wordRe = /^(אתמול|שלשום|מחר|yesterday|tomorrow)(?=\s|$)\s*/i;
  var wm = s.match(wordRe);
  if (wm) {
    var offset = 0;
    var w = wm[1].toLowerCase();
    if (w === 'אתמול' || w === 'yesterday') offset = -1;
    else if (w === 'שלשום') offset = -2;
    else if (w === 'מחר' || w === 'tomorrow') offset = 1;
    var d = new Date();
    d.setDate(d.getDate() + offset);
    return { date: withTime(d), remaining: s.slice(wm[0].length).trim() };
  }

  // Numeric forms: D/M, DD/MM, D.M, DD.MM, with optional /YY or /YYYY tail.
  // Must be followed by a space or end-of-string.
  var numRe = /^(\d{1,2})([\/.])(\d{1,2})(?:[\/.](\d{2,4}))?(?=\s|$)/;
  var nm = s.match(numRe);
  if (nm) {
    var day = parseInt(nm[1], 10);
    var sep = nm[2];
    var mon = parseInt(nm[3], 10);
    var yearGroup = nm[4];
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    // CRITICAL disambiguation: "3.5 לחם" is almost always ₪3.50 for
    // bread, NOT "May 3, bread". The dot separator is ambiguous between
    // a decimal amount and a date. Only treat a DOT form as a date when
    // there's a year tail (3.5.26) OR the remaining text still starts
    // with a number (the actual amount, e.g. "3.5 80 לחם"). The slash
    // form (3/5) is unambiguous — people don't write ₪ amounts with "/".
    if (sep === '.' && !yearGroup) {
      var afterDot = s.slice(nm[0].length).trim();
      if (!/^\d/.test(afterDot)) return null; // it's a decimal amount, not a date
    }
    var now = new Date();
    var year;
    if (yearGroup) {
      year = parseInt(yearGroup, 10);
      if (year < 100) year += 2000;
    } else {
      year = now.getFullYear();
      // If the resulting date is more than 7 days in the future, assume
      // the user meant last year (e.g. typing "31.12 hot chocolate" on
      // 2 Jan picks Dec last year, not Dec this year).
      var probe = new Date(year, mon - 1, day);
      if (probe.getTime() - now.getTime() > 7 * 86400 * 1000) year--;
    }
    var dt = new Date(year, mon - 1, day);
    // Sanity check: did the date actually exist? (e.g. 31/02)
    if (dt.getMonth() !== mon - 1 || dt.getDate() !== day) return null;
    return { date: withTime(dt), remaining: s.slice(nm[0].length).trim() };
  }

  return null;
}

// Israeli/EU-formatted number parser. Disambiguates "1,200" (one thousand
// two hundred) from "12,5" (twelve point five) by looking at digit-group
// lengths around each comma. Period is always treated as decimal.
function _parseIsraeliNumber_(raw) {
  if (raw == null) return NaN;
  var s = String(raw).trim();
  if (!s) return NaN;
  // If there's a period, treat that as the decimal point and strip commas
  // (which can only be thousands separators in that case).
  if (s.indexOf('.') >= 0) {
    return parseFloat(s.replace(/,/g, ''));
  }
  // No period — the comma might be either separator. We look at every comma
  // and check the run of digits to its right: exactly 3 digits and no more
  // commas to the right means thousands grouping; anything else is decimal.
  var commaIdx = s.indexOf(',');
  if (commaIdx < 0) return parseFloat(s);
  // Count groups of 3 digits separated by commas — the canonical thousands
  // pattern (e.g. 1,200 or 12,345,678). Decimal-comma never repeats and the
  // tail group is rarely exactly 3 digits.
  var groups = s.split(',');
  var allTrailingAreThree = groups.slice(1).every(function(g){ return /^\d{3}$/.test(g); });
  if (allTrailingAreThree) return parseFloat(s.replace(/,/g, ''));
  // Otherwise treat comma as decimal separator (e.g. "12,5" → 12.5)
  return parseFloat(s.replace(',', '.'));
}

var BUSINESS_CATEGORY_MAP = {
  "עסק": {
    "עלות שיווק": ["פייסבוק", "facebook", "fb", "אינסטגרם", "instagram", "ig", "טיקטוק", "tiktok", "גוגל אדס", "google ads", "פרסום", "שיווק", "קמפיין", "facebook ads", "fb ads", "fbads", "meta ads", "meta business", "meta marketing", "meta pixel", "instagram ads", "ig ads", "igads", "tiktok ads", "google adwords", "adwords", "youtube ads", "linkedin ads", "twitter ads", "x ads", "snapchat ads", "pinterest ads", "reddit ads", "מטא", "מטא אדס", "מטא ads", "אינסטה אדס", "אינסטה ads", "אינסטה ממומן", "אינסטה'גרם", "פייסביוק", "פייסבוק'ק", "פייסבוק אדס", "פייסבוק ads", "פייסבוק קמפיין", "פייסבוק ממומן", "פייסבוק פרסום", "גוגל'ל", "גוגל ממומן", "גוגל מודעות", "יוטיוב פרסום", "יוטיוב אדס", "יוטיוב ממומן", "טיקטוק אדס", "טיקטוק ממומן", "טיקטוק פרסום", "לינקדאין אדס", "לינקדאין פרסום", "אקס פרסום", "סנאפצ'אט פרסום", "פינטרסט פרסום", "שיווק דיגיטלי", "פרסום ממומן", "קמפיין שיווק", "קמפיין ממומן", "פרומו", "ads", "advert", "advertising", "advertise", "advertisement", "sponsored", "ממומן", "מקדם מכירות", "יח\"צ", "יחצן", "יחסי ציבור", "משרד פרסום", "אינפלואנסר", "influencer", "משפיענים", "אפיליאט", "affiliate", "דיוור", "דיוור שיווקי", "mailchimp", "klaviyo", "hubspot", "seo", "sem", "ppc", "סמראש", "semrush", "ahrefs", "boost post", "boosted post", "promote post", "מודעות פייסבוק", "מנהל מודעות"],
    "הוצאות תפעוליות": ["פוטושופ", "photoshop", "תוכנת עריכה", "תוכנה", "תוכנות", "שכירות משרד", "אינטרנט", "חשמל עסק", "טלפון עסק", "ציוד משרדי", "תפעול", "אדובי", "adobe", "canva", "figma", "creative cloud", "adobe cc", "illustrator", "after effects", "premiere", "lightroom", "indesign", "sketch", "invision", "webflow", "wordpress", "squarespace", "wix", "shopify", "bigcommerce", "wp engine", "cloudflare", "siteground", "aws", "google cloud", "gcp", "azure", "digital ocean", "linode", "vultr", "netlify", "vercel", "heroku", "firebase", "supabase", "github", "github copilot", "gitlab", "bitbucket", "jira", "confluence", "trello", "asana", "monday", "clickup", "notion business", "slack pro", "slack business", "zoom pro", "loom", "calendly", "typeform", "airtable", "zapier", "make.com", "n8n", "stripe", "paypal business", "square", "tranzila", "pelecard", "icount", "green invoice", "rivhit", "priority", "quickbooks", "xero", "wave", "freshbooks", "google workspace", "gsuite", "microsoft 365", "office 365 business", "mac mini", "macbook pro", "macbook air", "imac", "monitor 4k", "logitech mx", "wacom", "cintiq", "ipad pro", "apple pencil", "מצלמה מקצועית", "מחשב לעבודה", "מחשב משרדי", "מחשב עסקי", "מסך עבודה", "מסך עסקי", "תוכנת עיצוב", "תוכנה עסקית", "שירות ענן", "אחסון אתר", "דומיין", "דומיין עסקי", "cms", "crm", "erp", "סליקה", "מייל עסקי", "הנה\"ח", "תוכנת הנהלת חשבונות", "חשבונית ירוקה", "תרנזילה", "פלאקארד", "איקאונט"],
    "משלוחים והתקנות": ["משלוח", "משלוחים", "התקנה", "התקנות", "שילוח", "shipping", "delivery", "fedex", "dhl", "ups", "usps", "tnt", "aramex", "shipping label", "fulfillment", "shipstation", "shipbob", "pirate ship", "pirateship", "doar 24", "דואר 24", "דואר ישראל", "דואר שליחים", "שליחים", "שליחויות", "דצ'ה", "דאצ'ה", "אריזה", "אריזות", "קרטון", "קרטונים", "מדבקות משלוח", "נייר אריזה", "בועות אריזה", "bubble wrap", "tape", "אריזת מתנה", "התקנת מוצר", "התקנת לקוח", "מובילים עסקיים", "הובלה עסקית"],
    "עלות חומרי גלם": ["זכוכית", "קנבס", "חומרי גלם", "ספק", "ספקים", "פלסטיק", "אלומיניום", "עץ", "מסגרת", "מדפסת", "דיו", "נייר", "צבע", "מברשת", "פריימר", "raw material", "raw materials", "wholesale", "wholesaler", "supplier", "alibaba", "1688", "taobao", "made in china", "ספק חומרי גלם", "ספק עסקי", "ספקים עסקיים", "מחסן ספקים", "נחושת", "פלדה", "מתכת", "גומי", "בד", "בדים", "חוטים", "יריעות", "דבק תעשייתי", "מוטות", "ברגים תעשייה", "אנקרים", "פינות מסגרת", "פרזול", "חומרי דפוס", "חומרי הדפסה", "דיו הדפסה", "יריעות הדפסה", "נייר אומנותי", "canvas roll", "גליל קנבס", "spray adhesive", "דבק תרסיס", "חומרים", "חומר גלם"],
    "מחזור": ["הכנסה", "מכירה", "מכירות", "תשלום מלקוח", "מקדמה", "הזמנה", "invoice paid", "payment received", "customer payment", "client payment", "תקבול לקוח", "תקבול עסקי", "הוראת קבע מלקוח", "קבלה ללקוח", "תשלום מלקוח עסקי", "מקדמה לקוח", "מקדמה עסקית", "order online", "order placed", "הזמנה אונליין", "הזמנת לקוח", "הזמנה אתר", "מכירה אונליין", "מכירה אתר", "מכירת מוצר", "מכירת שירות", "sale", "vat refund", "tax refund", "rebate", "מע\"מ החזר", "החזר מע\"מ", "החזר מס"],
    "יועצים": ["יועץ", "יועצים", "יועץ מס", "רואה חשבון", "רו\"ח", "עורך דין", "עו\"ד", "accountant", "cpa", "bookkeeper", "bookkeeping", "business consultant", "business advisor", "business coach", "מנטור עסקי", "מאמן עסקי", "consultant", "consultancy", "legal fee", "lawyer fee", "שכר טרחה", "דמי תיק", "דמי ניהול תיק", "מס תאגיד", "מע\"מ עוסק", "דוח שנתי", "דוח 1301", "דוח כספי"],
    "שונות": ["שונות עסק", "שונות עסקית", "מתנה ללקוח", "מתנת לקוח", "תרומה עסקית", "כיבוד משרד", "כיבוד עובדים", "ארוחת צוות", "team lunch", "team dinner", "team event", "team building"]
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
      if (_kflKwHit_(t, kw)) {
        return { category: entries[i].category, subcategory: entries[i].subcategory };
      }
    }
    return { category: "עסק", subcategory: "הוצאות תפעוליות" };
  }
  return _matchCategory_long(text);
}

// A char that can be part of a word (digit, Latin, or Hebrew letter).
function _kflIsWordChar_(ch) { return !!ch && /[0-9A-Za-z֐-׿]/.test(ch); }
// Keyword hit test. Long keywords (>3 chars, e.g. brand names) match as
// substrings so Hebrew prefixes still work ("בשופרסל"). SHORT keywords (<=3)
// must match as WHOLE WORDS — otherwise they false-positive inside unrelated
// words ("מים" inside "תשלומים", "קפה" inside "מקפה"). Core precision guard.
function _kflKwHit_(t, kw) {
  if (!kw) return false;
  if (kw.length > 3) return t.indexOf(kw) >= 0;
  var from = 0, idx;
  while ((idx = t.indexOf(kw, from)) >= 0) {
    var b = idx === 0 ? '' : t.charAt(idx - 1);
    var a = (idx + kw.length >= t.length) ? '' : t.charAt(idx + kw.length);
    if (!_kflIsWordChar_(b) && !_kflIsWordChar_(a)) return true;
    from = idx + 1;
  }
  return false;
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
    if (_kflKwHit_(t, kw)) {
      return { category: entries[i].category, subcategory: entries[i].subcategory };
    }
  }
  return _matchCategory_orig(text);
}

function _matchCategory_orig(description) {
  const lower = (description || '').toLowerCase();
  for (const rule of CATEGORY_MAP) {
    for (const kw of rule.keywords) {
      if (_kflKwHit_(lower, kw.toLowerCase())) {
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
function matchCategorySmart(text, fromPhone) {
  // Step 1: learned cache (user-corrected categorizations)
  var cached = _learnedLookup(text);
  if (cached) {
    Logger.log('matchCategorySmart: cache hit "' + text + '" → ' + cached.subcategory);
    return cached;
  }

  // Step 1.5: Auto Synonyms tab (LLM-expanded synonyms from cronSynonymExpansion).
  // Checked BEFORE static CATEGORY_MAP so newly-learned variations win.
  try {
    if (typeof _autoSynonymLookup_ === 'function') {
      var synHit = _autoSynonymLookup_(text);
      if (synHit) {
        Logger.log('matchCategorySmart: auto-synonym hit "' + text + '" → ' + synHit.subcategory);
        return synHit;
      }
    }
  } catch (_synErr) { Logger.log('matchCategorySmart auto-syn err: ' + _synErr.message); }

  // Step 2: keyword maps (CATEGORY_MAP + BUSINESS_CATEGORY_MAP)
  var matched = matchCategory(text);
  var isDefault = matched && matched.category === DEFAULT_CATEGORY.category &&
                  matched.subcategory === DEFAULT_CATEGORY.subcategory;

  if (!isDefault) return matched;

  // Step 2.7: cross-user global learning (privacy-safe). Before paying for an
  // LLM call, check the shared store — another user may have already corrected
  // this EXACT description. Only a SHA-256 hash is shared, never the raw text.
  // Placed here (after the dictionary, before the LLM) so known words stay
  // instant and we only spend a network hop on genuinely-unknown text.
  try {
    var globalHit = _globalLearnLookup_(text);
    if (globalHit && globalHit.category) {
      Logger.log('matchCategorySmart: global-learn hit "' + text + '" -> ' + globalHit.subcategory);
      // Cache locally (source 'global', excluded from re-publish) so we never
      // hit the endpoint again for this text within this tenant.
      try { _learnedSave(text, globalHit, 'global'); } catch (_glErr) {}
      // fromGlobal drives the "📚 למדתי ממשתמשים אחרים" note (shown once, since
      // the local cache above means the next identical message is a local hit).
      return { category: globalHit.category, subcategory: globalHit.subcategory || globalHit.category, fromGlobal: true };
    }
  } catch (_glLookErr) { Logger.log('matchCategorySmart global err: ' + _glLookErr.message); }

  // Step 3: LLM fallback for ambiguous / new vendor names (Pro+ only)
  var ai = _aiCategorize(text, fromPhone);
  if (ai) {
    Logger.log('matchCategorySmart: AI categorized "' + text + '" → ' + ai.subcategory);
    _learnedSave(text, ai); // remember for next time
    return ai;
  }

  return matched; // DEFAULT_CATEGORY
}

// Returns top-N category guesses for ambiguous text — used to populate the
// WhatsApp interactive list when the bot is unsure.
// Strategy: collect ANY entry whose keywords partially overlap with the input,
// rank by overlap length, return top N. If nothing matches, return a curated
// fallback set covering the most common categories.
function _predictTopCategories(text, n) {
  n = n || 8;
  var limit = Math.min(10, Math.max(3, n)); // WhatsApp list = max 10 rows
  var t = String(text || '').toLowerCase();
  if (!t) return _fallbackCategorySet().slice(0, limit);

  // Score every entry in CATEGORY_MAP by best keyword match length.
  var scored = [];
  var seen = {};
  function recordMatch(entry, score) {
    var key = entry.category + '|' + entry.subcategory;
    if (seen[key] !== undefined) {
      if (score > seen[key].score) seen[key].score = score;
      return;
    }
    seen[key] = { entry: entry, score: score };
    scored.push(seen[key]);
  }
  if (typeof CATEGORY_MAP !== 'undefined' && CATEGORY_MAP.length) {
    for (var i = 0; i < CATEGORY_MAP.length; i++) {
      var entry = CATEGORY_MAP[i];
      if (!entry.keywords) continue;
      var bestKw = 0;
      for (var j = 0; j < entry.keywords.length; j++) {
        var kw = String(entry.keywords[j]).toLowerCase();
        if (kw.length < 2) continue;
        if (t.indexOf(kw) !== -1 && kw.length > bestKw) bestKw = kw.length;
      }
      if (bestKw > 0) recordMatch(entry, bestKw);
    }
  }
  scored.sort(function(a, b) { return b.score - a.score; });

  var out = [];
  for (var k = 0; k < scored.length && out.length < limit; k++) {
    out.push({
      category: scored[k].entry.category,
      subcategory: scored[k].entry.subcategory,
      isIncome: !!scored[k].entry.isIncome,
      confidence: Math.min(1, scored[k].score / 8)
    });
  }

  // Pad with fallback set if we don't have enough.
  if (out.length < limit) {
    var fallback = _fallbackCategorySet();
    for (var m = 0; m < fallback.length && out.length < limit; m++) {
      var f = fallback[m];
      var fk = f.category + '|' + f.subcategory;
      if (!seen[fk]) out.push(f);
    }
  }
  return out;
}

// Curated "most common" set for users who hit a totally new term.
function _fallbackCategorySet() {
  // The 10 most common everyday categories — shown when we have no better
  // prediction. Broad spread so the user can almost always pick the right one.
  return [
    { category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0 },
    { category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0 },
    { category: 'תחבורה', subcategory: 'דלק', confidence: 0 },
    { category: 'תחבורה', subcategory: 'תחבורה ציבורית', confidence: 0 },
    { category: 'הוצאות קבועות', subcategory: 'מיסים ואגרות', confidence: 0 },
    { category: 'בידור', subcategory: 'יציאות', confidence: 0 },
    { category: 'בריאות', subcategory: 'בריאות', confidence: 0 },
    { category: 'קניות', subcategory: 'ביגוד', confidence: 0 },
    { category: 'חינוך', subcategory: 'חינוך', confidence: 0 },
    { category: 'שונות', subcategory: 'שונות', confidence: 0 }
  ];
}

// Helper: encode a category pair as an interactive-list option ID (≤ 200 chars per WA limit).
function _encodeCategoryOptionId(category, subcategory, amount, text) {
  // Format: cat|<cat>|<sub>|<amount>|<short-text-key>
  var safe = function(s) { return String(s || '').replace(/[|]/g, ' ').slice(0, 24); };
  var textKey = String(text || '').replace(/\s+/g, '_').slice(0, 32);
  return ['cat', safe(category), safe(subcategory), Number(amount) || 0, textKey].join('|');
}

function _decodeCategoryOptionId(id) {
  var parts = String(id || '').split('|');
  if (parts.length < 5 || parts[0] !== 'cat') return null;
  return {
    category: parts[1],
    subcategory: parts[2],
    amount: parseFloat(parts[3]) || 0,
    textKey: parts.slice(4).join('|')
  };
}

// Builds the section list for a WhatsApp interactive list — used when bot is unsure.
function _buildCategoryListSections(predictions, amount, text) {
  // Group: top-3 in section "מומלץ עבורך", rest in section "אפשרויות נוספות"
  var topRows = [];
  var moreRows = [];
  for (var i = 0; i < predictions.length; i++) {
    var p = predictions[i];
    var title = (p.category + ' / ' + p.subcategory).slice(0, 24);
    var description = p.confidence > 0.5 ? '✨ התאמה גבוהה' : '';
    var row = {
      id: _encodeCategoryOptionId(p.category, p.subcategory, amount, text),
      title: title,
      description: description
    };
    if (topRows.length < 3) topRows.push(row);
    else moreRows.push(row);
  }
  var sections = [];
  if (topRows.length) sections.push({ title: 'הכי סביר', rows: topRows });
  if (moreRows.length) sections.push({ title: 'אפשרויות נוספות', rows: moreRows });
  return sections;
}

// ============================================================
// 🤖 LLM Fallback — Claude Haiku via Anthropic API
// ============================================================
function _loadRecentUserCorrections(n) {
  n = n || 10;
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) return [];
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return [];
    var width = Math.max(5, sh.getLastColumn());
    var data = sh.getRange(2, 1, lastRow - 1, width).getValues();
    var picked = [];
    for (var i = data.length - 1; i >= 0 && picked.length < n; i--) {
      var src = String(data[i][3] || '').toLowerCase();
      if (src.indexOf('user') < 0) continue;
      var kw = String(data[i][0] || '').trim();
      var cat = String(data[i][1] || '').trim();
      var sub = String(data[i][2] || '').trim();
      if (!kw || !cat || !sub) continue;
      if (cat === 'שונות' || cat === 'שונות ואחרים') continue;
      picked.push({ text: kw, category: cat, subcategory: sub });
    }
    return picked;
  } catch (e) {
    Logger.log('_loadRecentUserCorrections: ' + e.message);
    return [];
  }
}

// Centralised plan check — returns true if the sender's phone has an
// active Pro/Family/Business subscription. Reads from the Vercel
// sub:<userSub> KV record via the existing /api/whatsapp/link?phone=
// endpoint (which already exposes userSub + plan). Free-by-default
// means we deny on any error, so a KV outage doesn't grant free
// users premium features.
// ─────────────────────────────────────────────────────────────────────
// Health monitor — the REAL version of a "24/7 QA agent". A time-based
// trigger pings the Vercel health endpoint every 15 min. If any
// dependency is down (KV, Sheets, Meta, Anthropic, Stripe) or the probe
// itself fails, it emails the owner — at most once per 30 min per
// distinct failure signature, so a sustained outage doesn't spam the
// inbox. This runs continuously on Google's infra without anyone present.
// ─────────────────────────────────────────────────────────────────────
function cronHealthCheck() {
  var problems = [];
  try {
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/health/detailed', {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'kesefle-healthcron/1.0' },
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      problems.push('health endpoint HTTP ' + code);
    } else {
      var j = {};
      try { j = JSON.parse(resp.getContentText()); } catch (_pe) { problems.push('health body not JSON'); }
      var deps = (j && j.dependencies) || (j && j.checks) || {};
      Object.keys(deps).forEach(function(k) {
        var d = deps[k];
        if (d && d.ok === false && d.reason !== 'no_key_configured' && d.reason !== 'skipped') {
          problems.push(k + ' down (' + (d.reason || d.status || '?') + ')');
        }
      });
    }
  } catch (e) {
    problems.push('health probe threw: ' + (e && e.message));
  }
  if (!problems.length) return; // all good — stay quiet

  // Cooldown: hash the problem set; skip if we alerted on the same set
  // in the last 30 min.
  try {
    var sig = problems.sort().join('|');
    var cache = CacheService.getScriptCache();
    var key = 'healthalert:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sig)).slice(0, 16);
    if (cache.get(key)) return; // already alerted recently
    cache.put(key, '1', 1800);
  } catch (_ce) {}

  try {
    var addr = Session.getActiveUser().getEmail();
    if (addr) {
      MailApp.sendEmail({
        to: addr,
        subject: '🚨 כספ\'לה — בעיה בבריאות המערכת',
        body: 'בדיקת הבריאות זיהתה בעיות:\n\n  • ' + problems.join('\n  • ') +
          '\n\nזמן: ' + new Date().toISOString() +
          '\nendpoint: ' + KESEFLE_API_BASE + '/api/health/detailed' +
          '\n\n(התראה זו נשלחת לכל היותר פעם ב-30 דקות לאותה תקלה.)',
      });
    }
  } catch (_me) { Logger.log('cronHealthCheck mail err: ' + (_me && _me.message)); }
}

function installHealthCheckTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronHealthCheck') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('cronHealthCheck').timeBased().everyMinutes(15).create();
  Logger.log('✅ cronHealthCheck installed: every 15 min');
}

function _hasActivePremium_(fromPhone) {
  if (!fromPhone) return false;
  try {
    var clean = String(fromPhone).replace(/[^0-9]/g, '');
    // Owner is always Pro (it's the script owner's bot).
    var owner = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || '').replace(/[^0-9]/g, '');
    if (owner && clean === owner) return true;
    // Cache the plan lookup for 10 min so we don't make a synchronous
    // HTTP round-trip to Vercel on EVERY uncategorised expense (the audit
    // flagged this as a per-message latency + quota drain — and it was
    // being fetched twice per message because _resolveTenant_ already
    // hits the same endpoint). 'P'/'F' = premium, 'N' = not.
    var cache = CacheService.getScriptCache();
    var cacheKey = 'premium:' + clean;
    var cached = cache.get(cacheKey);
    if (cached === 'P') return true;
    if (cached === 'N') return false;
    var url = KESEFLE_API_BASE + '/api/whatsapp/link?phone=' + encodeURIComponent(clean);
    // Bot secret unlocks the rich response (with plan); without it the
    // server returns only { linked } and we default to free (safe degrade).
    var __premBotSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '';
    var __premHeaders = __premBotSecret ? { 'x-kesefle-bot-secret': __premBotSecret } : {};
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: __premHeaders });
    if (resp.getResponseCode() !== 200) { cache.put(cacheKey, 'N', 120); return false; }
    var j = JSON.parse(resp.getContentText());
    if (!j || !j.ok || !j.linked) { cache.put(cacheKey, 'N', 600); return false; }
    var plan = j.plan || (j.userRecord && j.userRecord.plan) || 'free';
    var isPremium = (plan === 'pro' || plan === 'family' || plan === 'business');
    cache.put(cacheKey, isPremium ? 'P' : 'N', 600);
    return isPremium;
  } catch (e) {
    Logger.log('_hasActivePremium_ err: ' + (e && e.message));
    return false;
  }
}

function _aiCategorize(text, fromPhone) {
  // Premium gating — AI categorisation is Pro+. Free users fall back
  // to CATEGORY_MAP keyword matching + learned cache. The bot reply
  // path adds an upsell line on the way out so the upgrade prompt is
  // contextual ("we couldn't categorise this — Pro would").
  if (fromPhone && !_hasActivePremium_(fromPhone)) {
    return null;
  }
  var rich = _aiCategorizeRich(text, fromPhone);
  if (!rich) return null;
  if (rich.category === 'בלתי מזוהה') return null;
  return { category: rich.category, subcategory: rich.subcategory, confidence: rich.confidence, reason: rich.reason };
}

function _aiCategorizeRich(text, fromPhone) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) return null;

    // Behavior learning from the onboarding questionnaire: if we know how this
    // customer tracks money (trackingType from profile:{phone}), give the model
    // a gentle nudge. This ONLY breaks ties on ambiguous text — clear vendor
    // matches never reach the LLM (they're caught by CATEGORY_MAP first). Purely
    // additive: no profile → empty block → identical behavior to before.
    var profileHintBlock = '';
    try {
      var tt = fromPhone ? _profileTrackingTypeCached_(fromPhone) : '';
      if (tt && _SURVEY_TRACKING_AI_HINT_ && _SURVEY_TRACKING_AI_HINT_[tt]) {
        profileHintBlock = '\n\nUSER CONTEXT (use ONLY to break ties on ambiguous expenses, never to override a clear match):\n' + _SURVEY_TRACKING_AI_HINT_[tt] + '\n';
      }
    } catch (_ptErr) { Logger.log('profile hint err: ' + _ptErr.message); }

    // Smart few-shot: top-12 high-signal corrections, most-similar first.
    // Falls back to the original last-10 reader if the smart picker fails.
    var userExamples = null;
    try { userExamples = _buildSmartFewShot_(text); } catch (_sfsErr) { Logger.log('smart few-shot err: ' + _sfsErr.message); }
    if (!userExamples || !userExamples.length) {
      try { userExamples = _loadRecentUserCorrections(10); } catch (_lrErr) { userExamples = []; }
    }
    var userExamplesBlock = '';
    if (userExamples && userExamples.length) {
      var lines = [];
      for (var ux = 0; ux < userExamples.length; ux++) {
        var ex = userExamples[ux];
        lines.push('"' + String(ex.text).replace(/"/g, '\\"').slice(0, 80) + '" → {"category":"' + ex.category + '","subcategory":"' + ex.subcategory + '"}');
      }
      userExamplesBlock =
        '\nUSER-CORRECTED EXAMPLES (THESE PEOPLE ARE EXPERTS — copy their categorization when similar):\n' +
        lines.join('\n') + '\n';
    }

    var systemPrompt =
      'You are a Hebrew expense categorizer for an Israeli personal-finance bot.\n' +
      'Categorize the user\'s expense into ONE of the categories listed below. Be accurate and CONFIDENT.\n' +
      'Always prefer a confident answer over שונות. ONLY return "בלתי מזוהה" if the text is truly unidentifiable (gibberish, single random letter, etc).\n' +
      'NEVER return "שונות" or "שונות ואחרים" as the category — pick the closest real category instead.\n' +
      'Return STRICT JSON: {"category":"...","subcategory":"...","confidence":0.0-1.0,"reason":"<5-word Hebrew explanation>"} — no markdown, no prose, no extra keys.\n\n' +
      'VALID CATEGORIES (use exact Hebrew name):\n' +
      '  • הכנסות (משכורת, עצמאי, החזרים, בונוסים, מכירות)\n' +
      '  • אוכל (אוכל לבית, אוכל בחוץ, בית קפה, אלכוהול)\n' +
      '  • תחבורה (תחבורה ציבורית, דלק, חניה, מוסך, השכרת רכב, טיסות, מלונות)\n' +
      '  • הוצאות קבועות (בית, חשבונות, ביטוח, מים, חשמל, גז, ארנונה, וועד בית, אפליקציות, טלקום)\n' +
      '  • קניות (ביגוד, נעליים, חשמל ואלקטרוניקה, רהיטים, קוסמטיקה, ספרים, חיות מחמד, תכשיטים, קניות מקוונות)\n' +
      '  • בידור (סטרימינג, משחקים, יציאות, בילויים, אירועים, ספורט, הופעות, סרטים)\n' +
      '  • בריאות (בריאות, רופא פרטי, שיניים, תרופות, תוספים, כושר ומנויים)\n' +
      '  • חינוך (קורסים מקוונים, ספרים מקצועיים, שיעורים פרטיים, אוניברסיטה)\n' +
      '  • ילדים (גני ילדים, חוגים, בגדים לילדים, צעצועים, ספרי ילדים)\n' +
      '  • ממשלה ומיסים (מס הכנסה, ביטוח לאומי, רישוי, קנסות, דמי גמל)\n' +
      '  • פיננסים (השקעות, עמלות בנקאיות, ניהול תיקים)\n' +
      '  • שירותים (הובלות, ניקיון, שיפוצים, גינון, חשמלאי, אינסטלטור)\n' +
      '  • עסק (שיווק, יועצים, חומרי גלם, תוכנות עסק, ציוד עסקי)\n' +
      '  • בלתי מזוהה (use ONLY when text is gibberish — confidence must be < 0.3)\n\n' +
      'CONFIDENCE GUIDE:\n' +
      '  0.95-1.00 → exact match to known vendor (e.g. "shufersal", "wolt", "ארומה")\n' +
      '  0.80-0.94 → clear category from context (e.g. "מסעדה איטלקית", "ביטוח רכב")\n' +
      '  0.60-0.79 → reasonable guess, ambiguous slang or partial info\n' +
      '  0.30-0.59 → weak signal, could fit multiple categories\n' +
      '  0.00-0.29 → "בלתי מזוהה" — truly unrecognizable\n\n' +
      'RULES:\n' +
      '1. Company/product/place names take their parent category (Spotify=אפליקציות, Wolt=אוכל בחוץ, IKEA=רהיטים).\n' +
      '2. Hebrew slang is normal: סופר=שופרסל=אוכל לבית, קפה=בית קפה, מוביל=שירותים/הובלות, פיצה=אוכל בחוץ.\n' +
      '3. Israeli companies: shufersal=אוכל לבית, wolt=אוכל בחוץ, ארומה=בית קפה, סופר-פארם=תרופות, בזק=טלקום.\n' +
      '4. Output keys MUST be in Hebrew (the category and subcategory names).\n' +
      '5. NEVER use "שונות" — always pick the closest specific category.\n\n' +
      'EXAMPLES:\n' +
      '"wolt תל אביב" → {"category":"אוכל","subcategory":"אוכל בחוץ","confidence":0.98,"reason":"וולט משלוחי אוכל"}\n' +
      '"245 שופרסל" → {"category":"אוכל","subcategory":"אוכל לבית","confidence":0.99,"reason":"שופרסל סופרמרקט"}\n' +
      '"42 קפה ארומה" → {"category":"אוכל","subcategory":"בית קפה","confidence":0.97,"reason":"ארומה בית קפה"}\n' +
      '"1800 ארנונה" → {"category":"הוצאות קבועות","subcategory":"בית","confidence":0.99,"reason":"ארנונה תשלום עירייה"}\n' +
      '"חברת חשמל" → {"category":"הוצאות קבועות","subcategory":"חשמל","confidence":0.99,"reason":"חברת חשמל"}\n' +
      '"netflix" → {"category":"הוצאות קבועות","subcategory":"אפליקציות","confidence":0.97,"reason":"מנוי סטרימינג"}\n' +
      '"chatgpt plus" → {"category":"הוצאות קבועות","subcategory":"אפליקציות","confidence":0.95,"reason":"מנוי תוכנה"}\n' +
      '"בנזין סונול" → {"category":"תחבורה","subcategory":"דלק","confidence":0.99,"reason":"תדלוק רכב"}\n' +
      '"רכבת ישראל" → {"category":"תחבורה","subcategory":"תחבורה ציבורית","confidence":0.99,"reason":"רכבת"}\n' +
      '"פנגו חניה" → {"category":"תחבורה","subcategory":"חניה","confidence":0.98,"reason":"חניה פנגו"}\n' +
      '"מוביל הוצאות בית" → {"category":"שירותים","subcategory":"הובלות","confidence":0.9,"reason":"שירות הובלה"}\n' +
      '"חשמלאי דחוף" → {"category":"שירותים","subcategory":"חשמלאי","confidence":0.97,"reason":"חשמלאי בית"}\n' +
      '"שיניים מאוחדת" → {"category":"בריאות","subcategory":"שיניים","confidence":0.95,"reason":"טיפול שיניים"}\n' +
      '"super pharm" → {"category":"בריאות","subcategory":"תרופות","confidence":0.96,"reason":"בית מרקחת"}\n' +
      '"holmes place" → {"category":"בריאות","subcategory":"כושר ומנויים","confidence":0.97,"reason":"מנוי חדר כושר"}\n' +
      '"zara" → {"category":"קניות","subcategory":"ביגוד","confidence":0.97,"reason":"חנות בגדים"}\n' +
      '"IKEA" → {"category":"קניות","subcategory":"רהיטים","confidence":0.97,"reason":"חנות רהיטים"}\n' +
      '"booking" → {"category":"תחבורה","subcategory":"מלונות","confidence":0.95,"reason":"הזמנת מלון"}\n' +
      '"אל על" → {"category":"תחבורה","subcategory":"טיסות","confidence":0.99,"reason":"חברת תעופה"}\n' +
      '"קולנוע יס פלאנט" → {"category":"בידור","subcategory":"סרטים","confidence":0.98,"reason":"בית קולנוע"}\n' +
      '"חתונה רוני" → {"category":"בידור","subcategory":"אירועים","confidence":0.88,"reason":"מתנת חתונה"}\n' +
      '"גן ילדים שירה" → {"category":"ילדים","subcategory":"גני ילדים","confidence":0.96,"reason":"גן ילדים"}\n' +
      '"משכורת" → {"category":"הכנסות","subcategory":"משכורת","confidence":0.99,"reason":"משכורת חודשית"}\n' +
      '"החזר מס" → {"category":"הכנסות","subcategory":"החזר מס","confidence":0.99,"reason":"החזר ממס הכנסה"}\n' +
      '"asdfgh" → {"category":"בלתי מזוהה","subcategory":"לא ברור","confidence":0.05,"reason":"טקסט לא מובן"}' +
      userExamplesBlock + profileHintBlock;

    var userMsg = 'תיאור: "' + String(text || '').slice(0, 200) + '"\n\nReturn JSON only with confidence and reason.';

    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 140,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('_aiCategorizeRich: API error ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 200));
      return null;
    }

    var body = JSON.parse(response.getContentText());
    var reply = (body.content && body.content[0] && body.content[0].text) || '';
    var jsonMatch = String(reply).match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      Logger.log('_aiCategorizeRich: no JSON in reply: ' + reply.slice(0, 200));
      return null;
    }
    var parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (jpErr) { Logger.log('_aiCategorizeRich: JSON parse error: ' + jpErr.message); return null; }
    if (!parsed.category || !parsed.subcategory) {
      Logger.log('_aiCategorizeRich: missing keys: ' + JSON.stringify(parsed));
      return null;
    }
    var category = String(parsed.category).trim();
    var subcategory = String(parsed.subcategory).trim();
    var confidence = typeof parsed.confidence === 'number' ? parsed.confidence : parseFloat(parsed.confidence);
    if (isNaN(confidence)) confidence = 0.5;
    if (confidence > 1) confidence = confidence / 100;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;
    var reason = String(parsed.reason || '').slice(0, 80);

    if (category === 'שונות' || category === 'שונות ואחרים') {
      Logger.log('_aiCategorizeRich: model returned שונות despite instruction — treating as low-confidence בלתי מזוהה');
      return { category: 'בלתי מזוהה', subcategory: 'לא ברור', confidence: Math.min(confidence, 0.4), reason: reason || 'מודל הציע שונות' };
    }

    var validCats = ['הכנסות','אוכל','תחבורה','הוצאות קבועות','הוצאות זמניות','קניות','בריאות','עסק','שירותים','בידור','חינוך','ילדים','ממשלה ומיסים','פיננסים','בלתי מזוהה'];
    if (validCats.indexOf(category) < 0) {
      Logger.log('_aiCategorizeRich: invalid category from AI: ' + category);
      return null;
    }
    return { category: category, subcategory: subcategory, confidence: confidence, reason: reason };
  } catch (e) {
    Logger.log('_aiCategorizeRich error: ' + e.message);
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
  if (bestKw) return map[bestKw];
  // NOTE: the cross-user global store is intentionally NOT consulted here.
  // _learnedLookup must stay fast + in-memory because matchCategorySmart calls
  // it FIRST (before the local dictionary). The global (HTTP) tier runs later,
  // only after the dictionary also misses — see matchCategorySmart Step 2.7.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-USER GLOBAL LEARNING (privacy-preserving)
//
// When ANY user confirms a category correction, the bot SHA-256-hashes the
// normalized description and POSTs the HASH (never the raw text) to
// /api/learn, which stores global_learn:{hash} -> {category, subcategory,
// count} in KV. Future users who type the EXACT same description get the
// right category instantly, with no LLM call.
//
// Why the endpoint and not direct KV:
//   - Server-side VALID_CATS validation stops a junk/typo category from
//     polluting the SHARED store for everyone.
//   - Only needs KESEFLE_BOT_SECRET (always present), not raw KV creds.
//   - Rate-limited + centralized, matching every other bot->Vercel call.
//
// Privacy: SHA-256 is one-way. The original text never leaves the user's bot.
// Two users typing "מוביל הוצאות בית" produce the same hash -> same lookup.
//
// IMPORTANT: publish and lookup MUST normalize identically (via
// _globalLearnNorm_) or the hashes will never match.
// ═══════════════════════════════════════════════════════════════════════════

function _globalLearnNorm_(text) {
  // Lowercase + collapse internal whitespace + trim. Shared by publish AND
  // lookup so the hashes can never drift apart.
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ''), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    var h = b.toString(16);
    hex += (h.length === 1 ? '0' : '') + h;
  }
  return hex;
}

function _globalLearnPublish_(text, category, subcategory) {
  try {
    var normalized = _globalLearnNorm_(text);
    if (!normalized || normalized.length < 2) return;
    var secret = '';
    try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
    if (!secret) return;
    var hash = _sha256Hex_(normalized);
    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/learn', {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': secret },
      payload: JSON.stringify({ hash: hash, category: category, subcategory: subcategory || category })
    });
    var code = resp.getResponseCode();
    if (code !== 200) {
      // 400 invalid_category is EXPECTED + fine: it just means this correction
      // used a non-top-level category, so it stays local-only (not shared).
      Logger.log('_globalLearnPublish_ http=' + code + ' ' + String(resp.getContentText()).slice(0, 120));
      return;
    }
    // A fresh correction supersedes any stale cached MISS/value for this hash.
    try {
      var cache = CacheService.getScriptCache();
      if (cache) cache.remove('gl:' + hash);
    } catch (_ce) {}
  } catch (e) {
    Logger.log('_globalLearnPublish_: ' + e.message);
  }
}

function _globalLearnLookup_(text) {
  try {
    var normalized = _globalLearnNorm_(text);
    if (!normalized || normalized.length < 2) return null;
    var secret = '';
    try { secret = String(PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || ''); } catch (_se) {}
    if (!secret) return null;
    var hash = _sha256Hex_(normalized);

    // Cache hits AND misses so a repeated unknown phrase doesn't hammer the
    // endpoint. Hits live 1h; misses 5min (a correction elsewhere can fill it).
    var cache = null;
    try { cache = CacheService.getScriptCache(); } catch (_ce) {}
    var ckey = 'gl:' + hash;
    if (cache) {
      var cHit = cache.get(ckey);
      if (cHit === 'MISS') return null;
      if (cHit) { try { var pc = JSON.parse(cHit); if (pc && pc.category) return pc; } catch (_pe) {} }
    }

    var resp = UrlFetchApp.fetch(KESEFLE_API_BASE + '/api/learn?h=' + encodeURIComponent(hash), {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'x-kesefle-bot-secret': secret }
    });
    if (resp.getResponseCode() !== 200) {
      if (cache) { try { cache.put(ckey, 'MISS', 300); } catch (_pe1) {} }
      return null;
    }
    var body = {};
    try { body = JSON.parse(resp.getContentText() || '{}'); } catch (_je) { body = {}; }
    if (body && body.ok && body.found && body.category) {
      var out = { category: body.category, subcategory: body.subcategory || body.category };
      if (cache) { try { cache.put(ckey, JSON.stringify(out), 3600); } catch (_pe2) {} }
      return out;
    }
    if (cache) { try { cache.put(ckey, 'MISS', 300); } catch (_pe3) {} }
    return null;
  } catch (e) {
    Logger.log('_globalLearnLookup_: ' + e.message);
    return null;
  }
}

function _learnedSave(text, result, source) {
  try {
    var t = String(text || '').toLowerCase().trim();
    if (!t || !result || !result.category || !result.subcategory) return;
    // Only USER-CONFIRMED sources propagate to the shared store. Exclude 'ai'
    // (low-confidence fallback) and 'global' (re-import — would loop forever).
    var _shouldPublishGlobal = (source === 'user' || source === 'user-correction' ||
                                source === 'user-direct' || source === 'llm-extracted');
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
        sh.getRange(i + 1, 2).setValue(sanitizeForSheet(result.category));
        sh.getRange(i + 1, 3).setValue(sanitizeForSheet(result.subcategory));
        sh.getRange(i + 1, 4).setValue(sanitizeForSheet(source || 'ai'));
        sh.getRange(i + 1, 5).setValue(new Date());
        _learnedCacheLoadedAt = 0; // invalidate cache
        // A RE-correction must also update the shared store (count++, new value).
        if (_shouldPublishGlobal) {
          try { _globalLearnPublish_(t, result.category, result.subcategory); } catch (_gpErr0) {}
        }
        return;
      }
    }
    sh.appendRow([sanitizeForSheet(t), sanitizeForSheet(result.category), sanitizeForSheet(result.subcategory), sanitizeForSheet(source || 'ai'), new Date()]);
    _learnedCacheLoadedAt = 0; // invalidate

    // Propagate user-confirmed learnings to the global hash store so other
    // users benefit. Skip AI-fallback writes (low confidence) and global
    // re-imports (would loop).
    if (_shouldPublishGlobal) {
      try { _globalLearnPublish_(t, result.category, result.subcategory); } catch (_gpErr) {}
    }
  } catch (e) {
    Logger.log('_learnedSave error: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROACTIVE RECURRING DETECTION
//
// When a user logs the SAME expense across several months at a stable amount
// (the signature of a subscription/bill), proactively OFFER to track it as a
// recurring expense. We never auto-create it — we suggest the exact "קבוע ..."
// command so the user stays in control (propose-before-apply).
//
// _detectRecurringCandidate_ is a PURE function (no I/O) so it is fully unit-
// tested offline (tests/recurring_detect.js). The bot feeds it the user's prior
// rows; the gates below keep it from nagging on noisy categories:
//   - same normalized description (digits/currency stripped)
//   - present in >= minMonths DISTINCT calendar months (incl. the current one)
//   - amount stability: max/min ratio <= maxRatio (groceries vary -> excluded)
//   - expenses only (never income)
// ═══════════════════════════════════════════════════════════════════════════

function _normForRecurring_(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[0-9₪.,]+/g, ' ')   // strip amounts/currency so "נטפליקס 45" == "נטפליקס 50"
    .replace(/\s+/g, ' ')
    .trim();
}

function _detectRecurringCandidate_(history, current, opts) {
  opts = opts || {};
  var minMonths = opts.minMonths || 3;   // incl. current -> a true 3rd-month repeat
  var maxRatio = opts.maxRatio || 1.5;   // amount-stability gate
  if (!current || current.isIncome) return null;
  var desc = _normForRecurring_(current.description);
  if (!desc || desc.length < 2) return null;
  var curAmt = Math.abs(Number(current.amount) || 0);
  if (curAmt <= 0) return null;

  var months = {};                       // distinct monthKeys with a matching expense
  var amounts = [curAmt];
  if (current.monthKey) months[current.monthKey] = true;
  for (var i = 0; i < (history || []).length; i++) {
    var h = history[i];
    if (!h || h.isIncome) continue;
    if (_normForRecurring_(h.description) !== desc) continue;
    var a = Math.abs(Number(h.amount) || 0);
    if (a <= 0) continue;
    if (h.monthKey) months[h.monthKey] = true;
    amounts.push(a);
  }
  var distinctMonths = Object.keys(months).length;
  if (distinctMonths < minMonths) return null;

  var mn = Math.min.apply(null, amounts);
  var mx = Math.max.apply(null, amounts);
  if (mn <= 0 || (mx / mn) > maxRatio) return null;

  var avg = amounts.reduce(function (s, x) { return s + x; }, 0) / amounts.length;
  return { count: distinctMonths, desc: String(current.description || '').trim(), amount: Math.round(avg) };
}

// Builds the user-facing suggestion line (or '' if no candidate). Dedupes via a
// persistent marker so we offer each repeating expense at most once per user.
function _recurringSuggestionLine_(fromPhone, history, current) {
  try {
    var cand = _detectRecurringCandidate_(history, current);
    if (!cand) return '';
    var markerKey = 'recsug_' + _sha256Hex_((fromPhone || '') + '|' + _normForRecurring_(current.description)).slice(0, 24);
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(markerKey)) return '';   // already offered once
    props.setProperty(markerKey, '1');
    return '\n\n🔁 שמתי לב ש"' + cand.desc + '" חוזר כבר ' + cand.count +
           ' חודשים (~' + _money_(cand.amount) + '). רוצה שאוסיף אותו כהוצאה קבועה?\n' +
           '👉 שלח: קבוע ' + cand.desc + ' ' + cand.amount;
  } catch (e) {
    Logger.log('_recurringSuggestionLine_: ' + e.message);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// USER-DRIVEN CATEGORY CORRECTION FLOW
//
// User flow:
//   1. User: "450 מוביל בית"
//   2. Bot: "...נרשם...📂 שונות. ❓ קטגוריה לא מדויקת? שלח 'קטגוריה <השם>'"
//   3. User: "קטגוריה שירותים"
//   4. Bot: "🤔 לתקן את 'מוביל בית' מ-'שונות' ל-'שירותים'? ענה: כן / לא"
//   5. User: "כן"
//   6. Bot updates the row + saves the learning + calls Claude to extract
//      broader keywords so future similar expenses categorize correctly.
// ═══════════════════════════════════════════════════════════════════════════

function _saveLastExpense_(fromPhone, rowNumber, item, matched) {
  if (!fromPhone || !rowNumber) return;
  try {
    CacheService.getScriptCache().put('lastExp:' + fromPhone, JSON.stringify({
      rowNumber: rowNumber,
      originalText: item.description,
      amount: Math.abs(item.amount),
      category: matched.category,
      subcategory: matched.subcategory,
      ts: Date.now()
    }), 600);
  } catch (e) { Logger.log('_saveLastExpense_: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 📸 RECEIPT OCR — claude-haiku-4-5 reads a photo of an Israeli receipt and
// returns vendor/amount/date/description as JSON. Same write/reply flow as a
// text expense so the correction handler (`קטגוריה X`) keeps working.
// ═══════════════════════════════════════════════════════════════════════════
function _handleReceiptImage_(fromPhone, image) {
  var mediaId = image && image.id;
  if (!mediaId) {
    return { replyText: '😬 לא קיבלתי את התמונה\n💡 נסה לשלוח שוב' };
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    Logger.log('_handleReceiptImage_: missing ANTHROPIC_API_KEY');
    return { replyText: '🤖 קריאת קבלות לא זמינה כרגע\n💡 רשום את ההוצאה ידנית — סכום פירוט (למשל "85 סופר")' };
  }
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('_handleReceiptImage_: missing WHATSAPP_TOKEN');
    return { replyText: '🤖 קריאת קבלות לא זמינה כרגע\n💡 רשום את ההוצאה ידנית — סכום פירוט (למשל "85 סופר")' };
  }

  // Step 1 — Meta's media endpoint returns a short-lived signed URL.
  var mediaMetaUrl = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(mediaId);
  var metaRes = UrlFetchApp.fetch(mediaMetaUrl, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN },
    muteHttpExceptions: true
  });
  if (metaRes.getResponseCode() !== 200) {
    Logger.log('_handleReceiptImage_: media lookup failed ' + metaRes.getResponseCode() + ' ' + metaRes.getContentText().slice(0, 200));
    return { replyText: '😬 לא הצלחתי להוריד את התמונה\n💡 נסה לשלוח שוב או רשום ידנית' };
  }
  var metaBody;
  try { metaBody = JSON.parse(metaRes.getContentText()); }
  catch (_p1) { return { replyText: '😬 לא הצלחתי לקרוא את התמונה\n💡 נסה לשלוח שוב' }; }
  if (!metaBody || !metaBody.url) {
    return { replyText: '😬 לא הצלחתי להוריד את התמונה\n💡 נסה לשלוח שוב' };
  }
  // Meta returns mime in media metadata; webhook value can disagree on some clients.
  var mimeType = String(image.mime_type || metaBody.mime_type || 'image/jpeg').split(';')[0].trim();
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp' && mimeType !== 'image/gif') {
    mimeType = 'image/jpeg';
  }

  // Step 2 — Download bytes from the signed URL (same bearer token required).
  var imgRes = UrlFetchApp.fetch(metaBody.url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN },
    muteHttpExceptions: true
  });
  if (imgRes.getResponseCode() !== 200) {
    Logger.log('_handleReceiptImage_: media download failed ' + imgRes.getResponseCode());
    return { replyText: '😬 לא הצלחתי להוריד את התמונה\n💡 נסה לשלוח שוב או רשום ידנית' };
  }
  var bytes = imgRes.getBlob().getBytes();
  // Apps Script UrlFetch has a 6-minute hard cap; oversize images burn that budget on encode.
  if (bytes.length > 5 * 1024 * 1024) {
    return { replyText: '📸 התמונה גדולה מדי (מעל 5MB)\n💡 שלח תמונה קטנה יותר או רשום ידנית' };
  }
  var base64Image = Utilities.base64Encode(bytes);

  // Step 3 — Claude vision OCR. Keep prompt tight; haiku does best with explicit JSON contract.
  var ocrPrompt =
    'You are reading an Israeli receipt or invoice. Extract:\n' +
    '- vendor: the store/business name (e.g. "שופרסל", "סופר-פארם", "Wolt")\n' +
    '- amount: the FINAL TOTAL paid (the largest "סה״כ" or "סך הכל" line, NOT subtotals)\n' +
    '- date: in YYYY-MM-DD format, or empty if not legible\n' +
    '- description: a 2-4 word Hebrew summary of what was bought (e.g. "קניות שבועיות", "ארוחת ערב")\n\n' +
    'Return STRICT JSON: {"vendor":"...","amount":0,"date":"YYYY-MM-DD","description":"..."}\n' +
    'If the image is not a receipt, return {"error":"not_a_receipt"}.';

  var claudeRes = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: ocrPrompt }
        ]
      }]
    }),
    muteHttpExceptions: true
  });

  if (claudeRes.getResponseCode() !== 200) {
    Logger.log('_handleReceiptImage_: Claude API error ' + claudeRes.getResponseCode() + ': ' + claudeRes.getContentText().slice(0, 300));
    return { replyText: '😬 הבינה לא הצליחה לקרוא את הקבלה כרגע\n💡 ננסה שוב בעוד דקה? או רשום ידנית' };
  }

  var claudeBody;
  try { claudeBody = JSON.parse(claudeRes.getContentText()); }
  catch (_p2) { return { replyText: '😬 קריאת הקבלה נכשלה\n💡 רשום את ההוצאה ידנית — סכום פירוט' }; }
  var replyText = (claudeBody.content && claudeBody.content[0] && claudeBody.content[0].text) || '';
  var jsonMatch = String(replyText).match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    Logger.log('_handleReceiptImage_: no JSON in Claude reply: ' + replyText.slice(0, 200));
    return { replyText: '🤔 לא הצלחתי לזהות את פרטי הקבלה. רשום ידנית: סכום פירוט.' };
  }
  var parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (_p3) {
    Logger.log('_handleReceiptImage_: JSON parse error: ' + replyText.slice(0, 200));
    return { replyText: '🤔 לא הצלחתי לזהות את פרטי הקבלה. רשום ידנית: סכום פירוט.' };
  }
  if (parsed.error === 'not_a_receipt') {
    return { replyText: '🤔 לא נראה לי שזו קבלה. תוכל לרשום ידנית? סכום פירוט.' };
  }
  var amount = Number(parsed.amount);
  if (!isFinite(amount) || amount <= 0) {
    return { replyText: '🤔 לא הצלחתי לזהות סכום. שלח שוב או רשום ידנית.' };
  }
  var vendor = String(parsed.vendor || '').trim();
  var description = String(parsed.description || '').trim();
  // Fall back to vendor if description came back empty — both go into the
  // category matcher and only description hits the sheet's "פירוט" column.
  if (!description) description = vendor || 'קבלה';

  // Step 4 — Reuse the same category matcher as text expenses.
  var matched = (typeof matchCategorySmart === 'function')
    ? matchCategorySmart((vendor ? vendor + ' ' : '') + description)
    : { category: 'שונות ואחרים', subcategory: 'שונות' };
  if (typeof _coerceCategoryBySubcategory === 'function') {
    try { _coerceCategoryBySubcategory(matched); } catch (__) {}
  }

  // SECURITY: only the owner writes a receipt to the hardcoded SHEET_ID.
  // A non-owner's receipt must be written to THEIR OWN sheet via the tenant
  // bridge — never this one. (This path used to append every sender's
  // receipt straight into the owner's sheet.)
  if (!_isOwnerPhone_(fromPhone)) {
    var __rt = _resolveTenant_(fromPhone);
    if (__rt && !__rt.isOwner && __rt.userRecord) {
      var __rr = _tenantAppendStructured_(fromPhone, {
        amount: amount,
        category: matched.category,
        subcategory: matched.subcategory,
        rawText: (vendor ? vendor + ' — ' : '') + description,
        isIncome: false,
      });
      if (__rr.ok) {
        return { replyText: '✅ נרשם בגיליון שלך מהקבלה!\n💰 ₪' + amount + '\n📁 ' + matched.category + (matched.subcategory ? ' / ' + matched.subcategory : '') + '\n📝 ' + (vendor || description) + _celebrateIfFirstExpense_(fromPhone) };
      }
      Logger.log('_handleReceiptImage_ tenant append failed: ' + __rr.code + ' ' + String(__rr.body).slice(0, 200));
      return { replyText: '😬 לא הצלחתי לשמור את הקבלה כרגע. נסה שוב בעוד רגע.' };
    }
    return { replyText: 'היי! 👋 אני עוד לא מזהה את המספר הזה.\nהתחבר ב-https://kesefle.com/account וקשר את המספר — ואז גם קבלות יישמרו אצלך אוטומטית.' };
  }
  if (!_assertOwnerLegacyWrite_(fromPhone, 'receipt')) {
    return { replyText: '😬 משהו לא תקין בזיהוי המספר. נסה שוב.' };
  }

  // Step 5 — Write to תנועות exactly like processExpense does.
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) {
    Logger.log('_handleReceiptImage_: transactions sheet missing');
    return { replyText: '😬 לא נמצאה לשונית "תנועות"\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט' };
  }
  // Prefer the receipt's printed date over "now" so monthly totals attribute correctly.
  var rowDate = new Date();
  var dateStr = String(parsed.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    var dt = new Date(dateStr + 'T12:00:00');
    if (!isNaN(dt.getTime())) rowDate = dt;
  }
  var monthKey = Utilities.formatDate(rowDate, 'Asia/Jerusalem', 'yyyy-MM');
  var rowDescription = vendor ? (vendor + ' — ' + description) : description;
  sheet.appendRow([
    rowDate,
    monthKey,
    amount,
    sanitizeForSheet(matched.category),
    sanitizeForSheet(matched.subcategory),
    sanitizeForSheet(rowDescription),
    'WhatsApp (receipt)',
    true
  ]);
  // Original-text cell note — photo receipts have no typed text so we record
  // the OCR-extracted vendor/amount/date as the provenance string.
  try {
    var __receiptRow = sheet.getLastRow();
    var __receiptStamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'HH:mm');
    var __receiptRaw = 'Receipt photo at ' + __receiptStamp + ' — vendor: "' + (vendor || '(unknown)') +
                       '", amount: ₪' + amount +
                       (dateStr ? ', date: ' + dateStr : '') +
                       ', description: "' + description + '"';
    _kfl_setRowOriginalNote(sheet, __receiptRow, _kfl_buildOriginalNote('Original receipt photo', __receiptRaw));
  } catch (__noteErr) { Logger.log('_handleReceiptImage_ note err: ' + (__noteErr && __noteErr.message)); }
  // Match processExpense's post-append sort so the sheet stays ordered.
  try {
    var __lastRow = sheet.getLastRow();
    if (__lastRow > 2) {
      sheet.getRange(2, 1, __lastRow - 1, 8).sort({ column: 1, ascending: true });
    }
  } catch (__sortErr) {
    Logger.log('_handleReceiptImage_: sort err: ' + (__sortErr && __sortErr.message));
  }

  // Step 6 — Save for the correction flow (`קטגוריה X`).
  try {
    _saveLastExpense_(fromPhone, sheet.getLastRow(),
      { description: rowDescription, amount: amount },
      matched);
  } catch (_seErr) {
    Logger.log('_handleReceiptImage_: saveLastExp err: ' + _seErr.message);
  }

  var subLabel = (matched.subcategory && matched.subcategory !== matched.category)
    ? ' → ' + matched.subcategory
    : '';
  var dateLine = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? '\n📅 ' + dateStr
    : '';
  var vendorLine = vendor ? '\n🏪 ' + vendor : '';
  return {
    replyText:
      '📸 קבלה נקראה!\n' +
      '━━━━━━━━━━━━━━━━' +
      vendorLine +
      '\n💰 ₪' + amount.toLocaleString('he-IL') +
      dateLine +
      '\n📂 ' + matched.category + subLabel +
      '\n\n❓ קטגוריה לא מדויקת? שלח "קטגוריה <השם הנכון>" ואני אלמד.'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎙️ VOICE MESSAGE — Whisper transcribes a Hebrew voice note to text, then
// the transcript is fed into processExpense so the resulting row supports the
// same `קטגוריה X` correction flow as a typed expense. Anthropic models do
// not accept audio input in Apps Script, so we use OpenAI Whisper.
// ═══════════════════════════════════════════════════════════════════════════
function _handleVoiceMessage_(fromPhone, audio) {
  var mediaId = audio && audio.id;
  if (!mediaId) {
    return { replyText: '😬 לא קיבלתי את הקול\n💡 נסה לשלוח שוב' };
  }

  var openaiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!openaiKey) {
    Logger.log('_handleVoiceMessage_: missing OPENAI_API_KEY');
    return { replyText: '🎙️ אין תמיכה בקול עדיין\n💡 רשום בכתב — סכום פירוט (למשל "85 סופר")' };
  }
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('_handleVoiceMessage_: missing WHATSAPP_TOKEN');
    return { replyText: '🎙️ אין תמיכה בקול כרגע\n💡 רשום בכתב — סכום פירוט (למשל "85 סופר")' };
  }

  var mediaMetaUrl = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(mediaId);
  var metaRes = UrlFetchApp.fetch(mediaMetaUrl, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN },
    muteHttpExceptions: true
  });
  if (metaRes.getResponseCode() !== 200) {
    Logger.log('_handleVoiceMessage_: media lookup failed ' + metaRes.getResponseCode() + ' ' + metaRes.getContentText().slice(0, 200));
    return { replyText: '😬 לא הצלחתי להוריד את הקול\n💡 נסה לשלוח שוב' };
  }
  var metaBody;
  try { metaBody = JSON.parse(metaRes.getContentText()); }
  catch (_p1) { return { replyText: '😬 לא הצלחתי לקרוא את הקול\n💡 נסה לשלוח שוב' }; }
  if (!metaBody || !metaBody.url) {
    return { replyText: '😬 לא הצלחתי להוריד את הקול\n💡 נסה לשלוח שוב' };
  }

  var audioRes = UrlFetchApp.fetch(metaBody.url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN },
    muteHttpExceptions: true
  });
  if (audioRes.getResponseCode() !== 200) {
    Logger.log('_handleVoiceMessage_: audio download failed ' + audioRes.getResponseCode());
    return { replyText: '😬 לא הצלחתי להוריד את הקול\n💡 נסה לשלוח שוב' };
  }
  var audioBlob = audioRes.getBlob();
  var bytes = audioBlob.getBytes();
  if (bytes.length > 5 * 1024 * 1024) {
    return { replyText: '🎙️ ההקלטה גדולה מדי (מעל 5MB)\n💡 שלח הקלטה קצרה יותר או רשום בכתב' };
  }

  // Whisper expects a filename with a recognised extension; WhatsApp voice notes
  // arrive as audio/ogg (Opus). Force the extension so the multipart MIME line
  // matches what Whisper accepts.
  var mimeType = String(audio.mime_type || metaBody.mime_type || 'audio/ogg').split(';')[0].trim();
  var ext = 'ogg';
  if (mimeType.indexOf('mp3') >= 0 || mimeType.indexOf('mpeg') >= 0) ext = 'mp3';
  else if (mimeType.indexOf('mp4') >= 0 || mimeType.indexOf('m4a') >= 0) ext = 'm4a';
  else if (mimeType.indexOf('wav') >= 0) ext = 'wav';
  else if (mimeType.indexOf('webm') >= 0) ext = 'webm';
  audioBlob = audioBlob.setName('voice.' + ext).setContentType(mimeType);

  var whisperRes;
  try {
    whisperRes = UrlFetchApp.fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + openaiKey },
      payload: {
        file: audioBlob,
        model: 'whisper-1',
        language: 'he',
        response_format: 'json'
      },
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('_handleVoiceMessage_: whisper fetch err: ' + (e && e.message));
    return { replyText: '😬 בעיה בתמלול הקול\n💡 נסה לרשום בכתב במקום' };
  }

  if (whisperRes.getResponseCode() !== 200) {
    Logger.log('_handleVoiceMessage_: whisper API ' + whisperRes.getResponseCode() + ': ' + whisperRes.getContentText().slice(0, 300));
    return { replyText: '😬 התמלול נכשל\n💡 נסה לרשום בכתב או דבר ברור יותר' };
  }

  var transcribed = '';
  try {
    var body = JSON.parse(whisperRes.getContentText());
    transcribed = String(body && body.text || '').trim();
  } catch (_pw) {
    Logger.log('_handleVoiceMessage_: whisper JSON parse err');
    return { replyText: '😬 התמלול נכשל\n💡 נסה לרשום בכתב או דבר ברור יותר' };
  }

  if (!transcribed) {
    return { replyText: '😬 לא הצלחתי להבין את ההקלטה\n💡 נסה לדבר ברור יותר, סכום קודם — למשל "מאתיים שקל סופר"' };
  }

  var safeTranscribed = sanitizeForSheet(transcribed);
  var heard = '🎙️ שמעתי: "' + safeTranscribed + '"';

  var procRes;
  try {
    procRes = processExpense(transcribed, fromPhone);
  } catch (e) {
    Logger.log('_handleVoiceMessage_: processExpense err: ' + (e && e.stack || e));
    return { replyText: heard + '\n\n😬 משהו השתבש ברישום: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
  }

  var procReply = (procRes && procRes.reply) || '';
  // "שלח בפורמט" / "❌ לא זיהיתי סכום" both mean processExpense couldn't
  // pull an amount from the transcript — guide the user to dictate
  // amount-first instead of relaying the generic help message.
  var failedParse = !procReply || /^שלח בפורמט/.test(procReply) || /לא זיהיתי סכום/.test(procReply);
  if (failedParse) {
    return { replyText: '🎙️ שמעתי "' + safeTranscribed + '" — אבל זה לא נראה כמו הוצאה\n💡 דבר משהו כמו "מאתיים שקל סופר" (סכום קודם)' };
  }

  // Append a voice-source line to the row note that processExpense just wrote.
  // We can't get the row number back from processExpense directly so we use
  // sheet.getLastRow() — safe because the bot serializes one message at a time.
  // SECURITY: only annotate the OWNER's sheet. A non-owner's voice expense
  // was already written to THEIR own sheet via the tenant bridge inside
  // processExpense above — we must never touch SHEET_ID for them.
  try {
    if (_isOwnerPhone_(fromPhone)) {
      var __vSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
      if (__vSheet) {
        _kfl_appendOriginalNoteLine(__vSheet, __vSheet.getLastRow(), 'Voice transcript: "' + transcribed + '"');
      }
    }
  } catch (__vNoteErr) { Logger.log('voice note tail err: ' + (__vNoteErr && __vNoteErr.message)); }

  return { replyText: heard + '\n\n' + procReply };
}

// Turn a free-form correction string into a {category, subcategory} pair.
// Accepts:
//   "ביגוד"                       → use matchCategory to find a known cat/sub
//   "קניות / ביגוד"  / "קניות/ביגוד" → split on `/`
//   anything unknown              → put in subcategory, leave category 'אחר'
// Never returns category === subcategory.
function _resolveCorrectionPair_(raw) {
  var s = String(raw || '').trim();
  if (!s) return { category: 'אחר', subcategory: '' };
  if (s.indexOf('/') >= 0) {
    var parts = s.split('/').map(function(p){ return p.trim(); }).filter(Boolean);
    if (parts.length >= 2) return { category: parts[0], subcategory: parts.slice(1).join(' / ') };
  }
  try {
    if (typeof matchCategory === 'function') {
      var m = matchCategory(s);
      if (m && m.category) {
        var sub = (m.subcategory && m.subcategory !== m.category) ? m.subcategory : '';
        return { category: m.category, subcategory: sub };
      }
    }
  } catch (_e) { /* fall through */ }
  return { category: 'אחר', subcategory: s };
}

function _handleCategoryCorrection_(fromPhone, text) {
  if (!fromPhone || !text) return null;
  var trimmed = String(text).trim();
  var cache = CacheService.getScriptCache();

  var corMatch = trimmed.match(/^קטגוריה\s+(.+)$/i) || trimmed.match(/^category\s+(.+)$/i);
  if (corMatch) {
    var newCategory = corMatch[1].trim();
    if (!newCategory) return null;
    var lastExpStr = cache.get('lastExp:' + fromPhone);
    if (!lastExpStr) {
      return { handled: true, replyText: '🤔 אין הוצאה אחרונה לתיקון.\nאפשר לתקן רק הוצאות מ-10 הדקות האחרונות.\nשלח את ההוצאה מחדש ואז את התיקון.' };
    }
    var lastExp;
    try { lastExp = JSON.parse(lastExpStr); } catch (_) { return null; }
    cache.put('pendingCor:' + fromPhone, JSON.stringify({
      rowNumber: lastExp.rowNumber,
      originalText: lastExp.originalText,
      oldCategory: lastExp.category,
      oldSubcategory: lastExp.subcategory,
      newCategory: newCategory,
      amount: lastExp.amount
    }), 300);
    return {
      handled: true,
      replyText: '🤔 לתקן את:\n"' + lastExp.originalText + '" (₪' + lastExp.amount + ')\n\nמ-📂 ' + lastExp.category + ' ל-📂 ' + newCategory + '?\n\nענה: כן / לא'
    };
  }

  var isYes = /^(כן|yes|y|אישור|✓)$/i.test(trimmed);
  var isNo = /^(לא|no|n|ביטול|✗)$/i.test(trimmed);
  if (!isYes && !isNo) return null;

  var pendStr = cache.get('pendingCor:' + fromPhone);
  if (!pendStr) return null;
  var pend;
  try { pend = JSON.parse(pendStr); } catch (_) { return null; }
  cache.remove('pendingCor:' + fromPhone);

  if (isNo) {
    return { handled: true, replyText: '✓ ביטלתי. ההוצאה נשארה כמו שזה.' };
  }

  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return { handled: true, replyText: '😬 לא מצאתי את גיליון התנועות.' };
    // The new value the user typed may be a top-level category, a
    // sub-category, or "category/subcategory" pair. Resolve it through
    // matchCategory so we never overwrite both columns with the same
    // string (which would corrupt SUMIFS in the dashboard) and never
    // poison the learning cache with category == subcategory.
    var __resolved = _resolveCorrectionPair_(pend.newCategory);
    sheet.getRange(pend.rowNumber, 4).setValue(sanitizeForSheet(__resolved.category));
    sheet.getRange(pend.rowNumber, 5).setValue(sanitizeForSheet(__resolved.subcategory));

    // Append a correction line to the row's existing original-text note.
    try {
      var __corStamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'HH:mm');
      _kfl_appendOriginalNoteLine(sheet, pend.rowNumber,
        'Corrected from "' + (pend.oldCategory || '?') + '" to "' + pend.newCategory + '" at ' + __corStamp);
    } catch (__corNoteErr) { Logger.log('correction note err: ' + (__corNoteErr && __corNoteErr.message)); }

    _learnedSave(pend.originalText, { category: __resolved.category, subcategory: __resolved.subcategory }, 'user-correction');

    // TASK 1 + 4: audit log + anti-degradation guard
    var __needsReviewCor = false;
    try {
      var __priorCor = _countCorrectionsForText_(pend.originalText);
      if (__priorCor >= 2) __needsReviewCor = true;
      _logMLAudit_({
        user_text: pend.originalText,
        amount: pend.amount,
        final_category: pend.newCategory,
        final_subcategory: pend.newCategory,
        via: 'manual_correction',
        user_correction: pend.newCategory,
        needs_review: __needsReviewCor,
        from_phone: fromPhone
      });
      if (__needsReviewCor) {
        _adminAlertOnce_('🚨 צריך בדיקה ידנית — "' + pend.originalText + '" תוקן ' + (__priorCor + 1) + ' פעמים.', fromPhone);
      }
    } catch (_auditErr2) { Logger.log('_handleCategoryCorrection_ audit: ' + _auditErr2.message); }

    var llmTail = '';
    try {
      var extracted = _learnExpandedKeywords_(pend.originalText, pend.newCategory);
      if (extracted && extracted.length) {
        llmTail = '\n🧠 למדתי גם: ' + extracted.join(', ');
      }
    } catch (eL) { Logger.log('_learnExpandedKeywords_ failed: ' + eL.message); }

    return {
      handled: true,
      replyText: '✅ תוקן ל-📂 ' + pend.newCategory + '\n🧠 שמרתי את "' + pend.originalText + '" לזיכרון, מהפעם הבאה אזכור.' + llmTail
    };
  } catch (e) {
    Logger.log('apply correction err: ' + (e && e.stack || e));
    return { handled: true, replyText: '😬 משהו השתבש בעדכון השורה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
  }
}

function _learnExpandedKeywords_(text, category) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return [];

  var prompt = 'משתמש כתב הוצאה בעברית: "' + text + '"\n' +
    'הוא תיקן את הקטגוריה ל-"' + category + '".\n' +
    'הוצא 1-3 מילות מפתח קצרות (מילה אחת או צירוף קצר) מהטקסט שהן הליבה הסמנטית, ' +
    'ושצריכות למפות בעתיד לקטגוריה הזאת.\n' +
    'דוגמה 1: "מוביל הוצאות בית" → ["מוביל", "הובלה"]\n' +
    'דוגמה 2: "ארנונה לעירייה" → ["ארנונה"]\n' +
    'דוגמה 3: "חוגי ילדים מטרים" → ["חוג", "מטרים"]\n' +
    'אל תכלול מילות קישור (של, ל, את, וכו).\n' +
    'החזר JSON בלבד ללא הסבר: {"keywords":["..."]}';

  var response;
  try {
    response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Claude learn fetch err: ' + e.message);
    return [];
  }

  if (response.getResponseCode() !== 200) {
    Logger.log('Claude learn API ' + response.getResponseCode() + ': ' + response.getContentText());
    return [];
  }

  try {
    var data = JSON.parse(response.getContentText());
    var txt = data && data.content && data.content[0] && data.content[0].text || '';
    var m = txt.match(/\{[\s\S]*\}/);
    if (!m) return [];
    var rule = JSON.parse(m[0]);
    if (!rule.keywords || !Array.isArray(rule.keywords)) return [];

    var saved = [];
    rule.keywords.forEach(function (kw) {
      var k = String(kw || '').toLowerCase().trim();
      if (k.length < 2 || k.length > 30) return;
      _learnedSave(k, { category: category, subcategory: category }, 'llm-extracted');
      saved.push(k);
    });
    return saved;
  } catch (e) {
    Logger.log('Claude learn parse err: ' + e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LEARNING DASHBOARD + MANUAL OVERRIDE COMMANDS
//
//   לימוד                            — list last 10 learned terms
//   למד: "טקסט" = קטגוריה            — direct teach (skips confirmation flow)
//   מחק לימוד <index>                — delete entry N from the list
//   איפוס לימוד                      — clear ALL learned data (asks for כן/לא)
//
// Indices come from the most recent "לימוד" listing, so the user just numbers
// from the screen and replies "מחק לימוד 3" without thinking about row IDs.
// ═══════════════════════════════════════════════════════════════════════════

function _handleLearningCommand_(fromPhone, text) {
  if (!fromPhone || !text) return null;
  var trimmed = String(text).trim();

  if (/^(לימוד|learning)$/i.test(trimmed)) {
    return { handled: true, replyText: _learningListMessage_(fromPhone) };
  }

  var teachMatch = trimmed.match(/^(?:למד|learn)\s*:\s*["״״״”'](.+?)["״”']\s*[=:]\s*(.+)$/i)
    || trimmed.match(/^(?:למד|learn)\s+(.+?)\s*=\s*(.+)$/i);
  if (teachMatch) {
    var phrase = String(teachMatch[1] || '').trim();
    var category = String(teachMatch[2] || '').trim();
    if (!phrase || !category) {
      return { handled: true, replyText: '🤔 שימוש: למד: "מוביל" = שירותים' };
    }
    try {
      _learnedSave(phrase.toLowerCase(), { category: category, subcategory: category }, 'user-direct');
      var tail = '';
      try {
        var ext = _learnExpandedKeywords_(phrase, category);
        if (ext && ext.length) tail = '\n🧠 גם הרחבתי ל: ' + ext.join(', ');
      } catch (_e) {}
      return { handled: true, replyText: '✅ למדתי: "' + phrase + '" → 📂 ' + category + tail };
    } catch (e) {
      return { handled: true, replyText: '😬 משהו השתבש בלמידה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
    }
  }

  var delMatch = trimmed.match(/^(?:מחק\s+לימוד|delete\s+learning)\s+(\d+)$/i);
  if (delMatch) {
    var idx = parseInt(delMatch[1], 10);
    return { handled: true, replyText: _learningDelete_(fromPhone, idx) };
  }

  if (/^(איפוס\s+לימוד|reset\s+learning)$/i.test(trimmed)) {
    CacheService.getScriptCache().put('pendingReset:' + fromPhone, '1', 120);
    return { handled: true, replyText: '⚠️ למחוק את כל הזיכרון של הבוט?\nכל המילים שלמד יימחקו.\nענה: כן / לא' };
  }

  // Confirmation for reset (intercepted before general כן/לא)
  if (/^(כן|yes|y)$/i.test(trimmed)) {
    var pendingReset = CacheService.getScriptCache().get('pendingReset:' + fromPhone);
    if (pendingReset) {
      CacheService.getScriptCache().remove('pendingReset:' + fromPhone);
      return { handled: true, replyText: _learningReset_() };
    }
  }
  if (/^(לא|no|n)$/i.test(trimmed)) {
    var pendingReset2 = CacheService.getScriptCache().get('pendingReset:' + fromPhone);
    if (pendingReset2) {
      CacheService.getScriptCache().remove('pendingReset:' + fromPhone);
      return { handled: true, replyText: '✓ ביטלתי. הזיכרון נשאר.' };
    }
  }

  return null;
}

function _learningListMessage_(fromPhone) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh || sh.getLastRow() < 2) {
      return '🧠 הבוט עוד לא למד כלום.\nשלח "למד: <טקסט> = <קטגוריה>" או תקן הוצאה עם "קטגוריה <שם>".';
    }
    var n = Math.min(10, sh.getLastRow() - 1);
    var data = sh.getRange(sh.getLastRow() - n + 1, 1, n, 5).getValues();
    var lines = ['🧠 10 הדברים האחרונים שלמדתי:\n━━━━━━━━━━━━━━━━━━'];
    // Track the index→row mapping for "מחק לימוד N"
    var idxMap = {};
    for (var i = 0; i < data.length; i++) {
      var displayIdx = data.length - i;
      var actualRow = sh.getLastRow() - i;
      idxMap[displayIdx] = actualRow;
      var src = data[i][3] || '';
      var srcEmoji = src === 'user-correction' ? '👤' : src === 'user-direct' ? '🎯' : src === 'llm-extracted' ? '🧠' : src === 'global' ? '📚' : '•';
      lines.push(displayIdx + '. ' + srcEmoji + ' "' + data[i][0] + '" → ' + data[i][1]);
    }
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('🗑️ למחוק? שלח "מחק לימוד N"');
    lines.push('♻️ למחוק הכול? שלח "איפוס לימוד"');
    CacheService.getScriptCache().put('learnIdxMap:' + fromPhone, JSON.stringify(idxMap), 600);
    return lines.join('\n');
  } catch (e) {
    Logger.log('_learningListMessage_: ' + e.message);
    return '😬 לא הצלחתי לטעון את הזיכרון\n💡 ננסה שוב בעוד דקה?';
  }
}

function _learningDelete_(fromPhone, idx) {
  if (!idx || idx < 1) return '🤔 צריך מספר בין 1 ל-10\n💡 שלח "לימוד" כדי לראות את הרשימה';
  try {
    var mapStr = CacheService.getScriptCache().get('learnIdxMap:' + fromPhone);
    if (!mapStr) return '🤔 קודם שלח "לימוד" כדי לראות את הרשימה\n💡 ואז "מחק לימוד N"';
    var idxMap = JSON.parse(mapStr);
    var rowNumber = idxMap[String(idx)];
    if (!rowNumber) return '🤔 אין פריט ' + idx + ' ברשימה\n💡 שלח "לימוד" לראות את הרשימה המעודכנת';
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) return '😬 אין גיליון זיכרון\n💡 שלח "לימוד" כדי שנייצר אחד';
    var deletedTerm = sh.getRange(rowNumber, 1).getValue();
    sh.deleteRow(rowNumber);
    _learnedCacheLoadedAt = 0;
    return '✅ מחקתי: "' + deletedTerm + '"\n💡 שלח "לימוד" לרשימה מעודכנת.';
  } catch (e) {
    return '😬 משהו השתבש במחיקה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?';
  }
}

function _learningReset_() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) return '🧠 אין מה למחוק.';
    var count = Math.max(0, sh.getLastRow() - 1);
    if (count === 0) return '🧠 הזיכרון כבר ריק.';
    sh.deleteRows(2, count);
    _learnedCacheLoadedAt = 0;
    return '✅ ניקיתי ' + count + ' פריטים. הבוט מתחיל ללמוד מאפס.';
  } catch (e) {
    return '😬 משהו השתבש באיפוס: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?';
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

function getMonthlySummary(fromPhone) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return '😬 אין לשונית תנועות\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט';

  const data = sheet.getDataRange().getValues();
  var userTz = (typeof _getUserTz_ === 'function') ? _getUserTz_(fromPhone) : 'Asia/Jerusalem';
  const monthKey = Utilities.formatDate(new Date(), userTz, 'yyyy-MM');

  const totals = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    // Column B can be either a String "2026-05" or a Date depending on cell
    // formatting in the sheet. Normalize to "yyyy-MM" before comparing.
    var rowMonth = row[1];
    if (rowMonth instanceof Date) {
      rowMonth = Utilities.formatDate(rowMonth, userTz, 'yyyy-MM');
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
  if (!sheet) return '😬 אין לשונית תנועות\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט';

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '🤔 אין מה למחוק — הלשונית ריקה\n💡 שלח הוצאה ראשונה למשל "85 סופר"';

  const data = sheet.getRange(lastRow, 1, 1, 7).getValues()[0];
  sheet.deleteRow(lastRow);

  var amt = (data[2] === '' || data[2] == null) ? '—' : data[2];
  var sub = (data[4] === '' || data[4] == null) ? '—' : data[4];
  var dsc = (data[5] === '' || data[5] == null) ? '—' : data[5];
  return '🗑️ נמחק:\nסכום: ₪' + amt + '\nתת-קטגוריה: ' + sub + '\nפירוט: ' + dsc;
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
  return '🤖 *כספ\'לה — מדריך מהיר*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    '📝 *רישום הוצאה:*\n' +
    '  • "85 סופר רמי לוי"\n' +
    '  • "1200 ארנונה"\n' +
    '  • "245 wolt דאלי"\n' +
    '  • "50$ amazon" (מטבע זר → ILS)\n\n' +
    '📅 *תאריך:*\n' +
    '  • "אתמול 60 מכולת"\n' +
    '  • "שלשום 30 חניה"\n' +
    '  • "1.5 200 ביטוח" (1 במאי)\n' +
    '  • "12/4 80 דלק"\n\n' +
    '💰 *רישום הכנסה:*\n' +
    '  • "8500 משכורת"\n' +
    '  • "3000 הכנסה עסקית"\n\n' +
    '🏢 *הזמנה עסקית (לוח הזמנות):*\n' +
    '  • "עסק 880 לקוח דנה גודל 120-80 קנבס עלות ייצור 240 משלוח 45"\n' +
    '  • הבוט יחשב רווח אוטומטית ויעדכן את מאזן חברה\n\n' +
    '💳 *פיצול לתשלומים:*\n' +
    '  • "5000 ב-10 תשלומים מחשב"\n\n' +
    '🤝 *הוצאות קבוצתיות (חדש):*\n' +
    '  • "כספלה צור משפחה כהן" — צור קבוצה\n' +
    '  • "כספלה הצטרף ABC123" — הצטרף בקוד\n' +
    '  • "כספלה 245 סופר" — רישום עם פיצול שווה\n' +
    '  • "כספלה יתרות" — מי חייב למי\n' +
    '  • "כספלה עזרה" — תפריט קבוצות מלא\n\n' +
    '🔁 *הוצאות קבועות (חדש):*\n' +
    '  • "קבוע 2500 שכירות כל 1 לחודש"\n' +
    '  • "קבוע 99 נטפליקס כל 5 לחודש"\n' +
    '  • "קבוע 400 ארנונה כל 15 לחודשיים"\n' +
    '  • "רשימת קבועות" — כל ההוצאות הקבועות\n' +
    '  • "סנכרן הוצאות קבועות" — רישום למפרע מתחילת החודש\n' +
    '  • "מחק קבוע שכירות" / "השהה קבוע נטפליקס"\n' +
    '  • נרשמות אוטומטית בכל חודש — בלי לכתוב שוב 🎉\n\n' +
    '💰 *תקציבים חודשיים (חדש):*\n' +
    '  • "תקציב" — רשימת התקציבים שלך + התקדמות החודש\n' +
    '  • "תקציב מזון ופארמה 1500" — קבע תקרה חודשית\n' +
    '  • "תקציב תחבורה 800" / "תקציב דיור 4500"\n' +
    '  • אתראה אוטומטית כשעוברים 80% מהתקציב — בלי לעקוב ידנית\n\n' +
    '✨ *קטגוריות מותאמות אישית (חדש):*\n' +
    '  • "צור קטגוריה דניאל" — שורה חדשה במאזן אישי לדניאל\n' +
    '  • "צור קטגוריה ילד 1 דניאל, ילד 2 מיכל" — שורה לכל ילד\n' +
    '  • כל הוצאה שמזכירה את השם תיכנס לשורה אוטומטית\n\n' +
    '📊 *פקודות מהירות:*\n' +
    '  • "סיכום" — סיכום החודש\n' +
    '  • "הזמנות" — סיכום הזמנות החודש (לקוחות, מחזור, רווח)\n' +
    '  • "דוגמאות" — איך לכתוב הוצאות (למתחילים)\n' +
    '  • "הערה: שילמתי במזומן" — הוסף הערה להוצאה האחרונה\n' +
    '  • "חפש קפה" — חיפוש בהיסטוריית ההוצאות\n' +
    '  • "תיקון סכום 250" — תקן את ההוצאה האחרונה (סכום/פירוט/תאריך)\n' +
    '  • "הגדרות" — שפה, קטגוריית ברירת מחדל, אזור זמן\n' +
    '  • "תזכורת 15/6 חשמל 450" — תזכורת לתשלום\n' +
    '  • "תזכורות" — רשימת התזכורות הקרובות\n' +
    '  • "הזמן" — קישור להזמנת חברים (חודש Pro חינם)\n' +
    '  • "מחק אחרון" — בטל את ההוצאה האחרונה\n' +
    '  • "מחק חשבון" — מחיקת חשבון (GDPR)\n' +
    '  • "מחק הזמנה" — בטל את ההזמנה האחרונה\n' +
    '  • "סנכרן" — ריענון דשבורד\n' +
    '  • "מילון" — קישור ללשונית הלמידה\n' +
    '  • "מנוע" — מצב המנוע (AI/cache/keywords)\n' +
    '  • "אזור זמן" — הצג/שנה אזור זמן\n' +
    '  • "עזרה" — הודעה זו\n\n' +
    '🧠 *המנוע:*\n' +
    'המנוע מקטלג ב-3 שכבות — cache, אלפי מילות מפתח, ו-Claude AI לגיבוי.\n' +
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
    return '😬 לא הצלחתי לקרוא מצב מנוע: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?';
  }
}

// Multi-tenant account linking handler.
// Called when the bot sees "קוד XXXXXX" / "code XXXXXX" / "link XXXXXX" from a sender.
// Sends the code + sender phone to /api/whatsapp/link?action=confirm on Vercel.
// The Vercel side resolves the code → userSub, then permanently stores phone:<E164> → userSub
// in KV, which the webhook + every future bot message uses to route to the right sheet.
function handleLinkCode_(code, fromPhone) {
  if (!fromPhone) {
    return '😬 לא הצלחתי לזהות את המספר שלך מההודעה\n💡 נסה לשלוח שוב מאותו וואטסאפ';
  }
  // If this number is ALREADY linked, say so — no need to process a code (and
  // avoid a confusing "code expired" reply when an old code is re-sent).
  try {
    var __statusUrl = KESEFLE_API_BASE + '/api/whatsapp/link?phone=' + encodeURIComponent(String(fromPhone));
    // Anonymous response is enough here: we only need { linked }.
    var __sResp = UrlFetchApp.fetch(__statusUrl, { method: 'get', muteHttpExceptions: true });
    if (__sResp.getResponseCode() === 200) {
      var __sBody = {};
      try { __sBody = JSON.parse(__sResp.getContentText() || '{}'); } catch (_pe) {}
      if (__sBody.ok && __sBody.linked) {
        return '✅ *אתה כבר מחובר!*\n' +
          '━━━━━━━━━━━━━━━━━━\n\n' +
          'אין צורך בקוד — המספר הזה כבר מקושר לחשבון שלך.\n' +
          'פשוט שלח הוצאה — למשל "45 קפה" או "245 סופר" — ואני אכניס אותה לגיליון. 📊';
      }
    }
  } catch (_statusErr) { /* best-effort — fall through to the normal confirm */ }

  var url = KESEFLE_API_BASE + '/api/whatsapp/link?action=confirm';
  var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET') || '';
  var payload = { code: String(code), phone: String(fromPhone) };
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: botSecret ? { 'x-kesefle-bot-secret': botSecret } : {},
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var status = resp.getResponseCode();
    var body = {};
    try { body = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
    if (status === 200 && body.ok) {
      return '✅ *הקישור הושלם!*\n' +
        '━━━━━━━━━━━━━━━━━━\n\n' +
        'מהרגע הזה, כל הוצאה שתשלח תיכתב אוטומטית לגיליון שלך.\n\n' +
        '💡 *לדוגמה — נסה/י:*\n' +
        '  • "245 סופר"\n' +
        '  • "42 קפה"\n' +
        '  • "8500 משכורת"\n\n' +
        'כתוב "עזרה" לרשימת הפקודות המלאה.';
    }
    if (status === 404) {
      return '😬 הקוד פג תוקף או לא תקין\n💡 חזרי ל-https://kesefle.com/account וצרי קוד חדש (תקף ל-10 דק׳)';
    }
    if (status === 409) {
      return '⚠️ המספר הזה כבר מחובר לחשבון אחר.\n💡 אם זה החשבון שלך — התחבר לאותו חשבון Google שאיתו נרשמת.';
    }
    if (status === 401) {
      return '😬 לא הצלחתי לאמת את הבקשה (סוד בוט שגוי)\n💡 פנה לתמיכה דרך https://kesefle.com';
    }
    Logger.log('handleLinkCode_: unexpected status=' + status + ' body=' + JSON.stringify(body));
    return '😬 משהו השתבש בקישור\n💡 נסה שוב או צור קוד חדש ב-https://kesefle.com/account';
  } catch (e) {
    Logger.log('handleLinkCode_ error: ' + (e && e.stack || e));
    return '😬 שגיאת רשת\n💡 ננסה שוב בעוד רגע?';
  }
}

function getCurrenciesMessage() {
  // Read each rate fresh so Script Property overrides surface in the reply.
  return '💱 *המרות מטבע אוטומטיות*\n' +
    '━━━━━━━━━━━━━━━━━━\n\n' +
    'שערים נוכחיים:\n' +
    '  • USD ($) → ₪' + _kfl_fxRate('USD') + '\n' +
    '  • EUR (€) → ₪' + _kfl_fxRate('EUR') + '\n' +
    '  • GBP (£) → ₪' + _kfl_fxRate('GBP') + '\n' +
    '  • CAD → ₪' + _kfl_fxRate('CAD') + '\n' +
    '  • AUD → ₪' + _kfl_fxRate('AUD') + '\n' +
    '  • JPY (¥) → ₪' + _kfl_fxRate('JPY') + '\n' +
    '  • CHF → ₪' + _kfl_fxRate('CHF') + '\n\n' +
    '*דוגמאות:*\n' +
    '  • "50$ amazon"\n' +
    '  • "12 יורו spotify"\n' +
    '  • "£25 amazon uk"\n' +
    '  • "100 cad uber"\n' +
    '  • "5000 jpy סושי"\n' +
    '  • "80 chf hotel"\n\n' +
    'הבוט ירשום את הסכום ב-₪ אוטומטית ויציין במקור (גם בהערה על השורה).\n' +
    'לשינוי שערים: Script Properties → FX_RATE_USD / FX_RATE_EUR / וכו.';
}

function getDictionaryLink(fromPhone) {
  // The "מילון לימוד" tab is an admin feature on the OWNER sheet -- the
  // tenant sheets don't include it. For non-owners we explain that
  // dictionary editing is an admin feature instead of leaking the
  // owner's URL.
  var isOwner = (typeof _isOwnerPhone_ === 'function') && _isOwnerPhone_(fromPhone);
  if (!isOwner) {
    return '📖 *מילון לימוד*\n\n' +
      'עריכת מילון היא תכונת מנהל. תוכל ללמד את הבוט מילים חדשות פשוט על ידי שליחת ' +
      '"קטגוריה <השם הנכון>" אחרי הוצאה שסווגה לא נכון — אני אזכור לפעם הבאה.';
  }
  return '📖 *לשונית "מילון לימוד" בגיליון שלך:*\n' +
    'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit\n\n' +
    'שם הלשונית: *מילון לימוד*\n' +
    'מבנה: keyword | category | subcategory | source | updated_at\n\n' +
    '💡 אתה יכול לערוך ידנית כדי ללמד את הבוט מילה חדשה.';
}

// ============================================================
// 📤 שליחת הודעה ל-WhatsApp
// ============================================================

// Defensive: if a reply ever arrives as the concierge's raw JSON
// ({"action":"chat","reply":"..."}) — e.g. from a stale deploy or a future
// code path — extract the reply text so the USER never sees the JSON wrapper.
function _unwrapConciergeJson_(message) {
  var s = String(message == null ? '' : message);
  var t = s.trim();
  if (t.charAt(0) === '{' && t.indexOf('"action"') >= 0 && t.indexOf('"reply"') >= 0) {
    try {
      var m = t.match(/\{[\s\S]*\}/);
      if (m) {
        var p = JSON.parse(m[0]);
        if (p && typeof p.reply === 'string' && p.reply.trim()) return p.reply;
      }
    } catch (_e) {}
  }
  return s;
}

function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('sendWhatsAppMessage: token not configured - skipping reply');
    return { ok: false, reason: 'no_token' };
  }
  if (!to || !message) {
    Logger.log('sendWhatsAppMessage: missing to=' + to + ' messageLen=' + (message ? String(message).length : 0));
    return { ok: false, reason: 'missing_args' };
  }

  // Prefer the number the user actually messaged (set in doPost); fall back to
  // the configured default for unsolicited sends (crons, alerts).
  var _pnid = _ACTIVE_PHONE_NUMBER_ID_ || WHATSAPP_PHONE_NUMBER_ID;
  const url = 'https://graph.facebook.com/v21.0/' + _pnid + '/messages';
  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: String(_unwrapConciergeJson_(message)).slice(0, 4096) }
  };

  Logger.log('sendWhatsAppMessage: to=' + to + ' len=' + String(message).length);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  Logger.log('sendWhatsAppMessage: code=' + code + ' body=' + body.slice(0, 500));
  if (code < 200 || code >= 300) {
    Logger.log('sendWhatsAppMessage: META REJECTED to=' + to + ' code=' + code);
    return { ok: false, code: code, body: body };
  }
  return { ok: true, code: code };
}

// ============================================================
// 🎛 Interactive list message — used when bot is unsure about category.
// Sends a WhatsApp list with up to 10 category options the user can tap.
// ============================================================
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates#interactive-list-messages
//
// sections shape: [{ title: "...", rows: [{ id: "cat_food_restaurant", title: "אוכל/מסעדות", description: "" }, ...] }]
function sendWhatsAppInteractiveList(to, headerText, bodyText, footerText, buttonText, sections) {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) {
    Logger.log('WhatsApp token not configured — skipping list');
    return;
  }
  var url = 'https://graph.facebook.com/v21.0/' + (_ACTIVE_PHONE_NUMBER_ID_ || WHATSAPP_PHONE_NUMBER_ID) + '/messages';
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: {
        button: String(buttonText || 'בחר').slice(0, 20),
        sections: sections
      }
    }
  };
  if (headerText) {
    payload.interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
  }
  if (footerText) {
    payload.interactive.footer = { text: String(footerText).slice(0, 60) };
  }
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  Logger.log('WhatsApp interactive list resp: ' + resp.getContentText());
}

// Quick reply buttons (max 3) — simpler than list, great for yes/no/correction prompts.
function sendWhatsAppQuickButtons(to, bodyText, buttons) {
  if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN.indexOf('PASTE_') === 0) return;
  var url = 'https://graph.facebook.com/v21.0/' + (_ACTIVE_PHONE_NUMBER_ID_ || WHATSAPP_PHONE_NUMBER_ID) + '/messages';
  var btns = (buttons || []).slice(0, 3).map(function(b) {
    return { type: 'reply', reply: { id: String(b.id), title: String(b.title).slice(0, 20) } };
  });
  var payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: { buttons: btns }
    }
  };
  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
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
        transactions.appendRow([dt, monthKey, val, sanitizeForSheet(currentSection), sanitizeForSheet(name), 'מיגרציה אוטומטית מהדשבורד', 'Legacy']);
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
      sheet.getRange(i+1, 4).setValue(sanitizeForSheet(newCat));
      sheet.getRange(i+1, 5).setValue(sanitizeForSheet(newSubcat));
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

var _BIZ_DASH_SUBS = {
  'מחזור': 'מחזור',
  'עלות חומרי גלם': 'עלות חומרי גלם',
  'עלות שיווק': 'עלות שיווק',
  'שיווק': 'עלות שיווק',
  'משלוחים והתקנות': 'משלוחים והתקנות',
  'הוצאות תפעוליות': 'הוצאות תפעוליות',
  'יועצים': 'הוצאות תפעוליות',
  'אחר': 'הוצאות תפעוליות',
  'שונות': 'הוצאות תפעוליות',
  'שונות עסק': 'הוצאות תפעוליות'
};

function _normalizeBizSub_(subcategory) {
  var s = String(subcategory || '').trim();
  return _BIZ_DASH_SUBS[s] || null;
}

// Steven 2026-05-25: rewritten to RECOMPUTE the (sub-row x month-col) cell
// from תנועות instead of incrementing the existing value. The old
// increment-by-amount path drifted whenever:
//   (a) a write was missed (e.g. routing through a tenant path that
//       didn't call this function)
//   (b) Steven manually edited the cell (then the bot would add to his
//       new number, double-counting)
//   (c) the user re-ran a daily import / recurring catch-up
// Recompute makes it idempotent: on every write, we re-sum תנועות for
// the same (category, subcategory bucket, month) and overwrite the cell.
// Side effect: the cell ALWAYS matches תנועות -- no drift.
//
// Returns true on success, false if the dashboard row/header couldn't be
// found (logs the reason). Preserves cells that already contain a
// formula so SUMIFS-based layouts keep working.
function _updateBusinessDashboard_(category, subcategory, monthKey, amount) {
  // Default: write to the owner's main bot SHEET_ID. For multi-business
  // routing (Steven "עסק 2 ..."), callers pass a different ss directly
  // via _updateBusinessDashboardInSheet_.
  return _updateBusinessDashboardInSheet_(SpreadsheetApp.openById(SHEET_ID), category, subcategory, monthKey, amount);
}

// Parameterized form -- pass the spreadsheet you want to update. Used by
// both the legacy single-sheet path (above) and the multi-business path
// (_writeBusinessNExpense_ below) so the same recompute-from-תנועות
// logic powers every business sheet Steven owns.
function _updateBusinessDashboardInSheet_(ss, category, subcategory, monthKey, amount) {
  if (!ss) return false;
  if (category !== 'עסק') return false;
  var canonSub = _normalizeBizSub_(subcategory);
  if (!canonSub) {
    Logger.log('_updateBusinessDashboardInSheet_: no canon sub for "' + subcategory + '" - skip');
    return false;
  }
  var monthIdx = parseInt((monthKey || '').split('-')[1], 10);
  if (isNaN(monthIdx) || monthIdx < 1 || monthIdx > 12) {
    Logger.log('_updateBusinessDashboardInSheet_: bad monthKey "' + monthKey + '"');
    return false;
  }
  var year = parseInt((monthKey || '').split('-')[0], 10);
  if (!year) year = new Date().getFullYear();

  // --- Recompute the month's bucket total from תנועות. Single read of
  // the whole sheet; in-memory sum. Idempotent + drift-free.
  var fresh = _sumBusinessBucketFromTransactions_(ss, canonSub, year, monthIdx);
  if (fresh == null) {
    Logger.log('_updateBusinessDashboardInSheet_: could not read תנועות for recompute');
    return false;
  }

  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var monthLabel = hebMonths[monthIdx - 1];

  var dashNames = ['מאזן חברה ' + year, 'מאזן חברה'];
  for (var d = 0; d < dashNames.length; d++) {
    var ds = ss.getSheetByName(dashNames[d]);
    if (!ds) continue;
    var dvals = ds.getDataRange().getValues();
    // For each year-section in this tab, find the row labeled canonSub
    // whose section header (B-cell of an "X4" type row above it) === year.
    // We pick the FIRST sub-row whose nearest year header above matches.
    for (var r = 0; r < dvals.length; r++) {
      if (String(dvals[r][0] || '').trim() !== canonSub) continue;
      // Find the closest year header above this row. We look for a cell
      // whose value parses to our target year (typical sheet has a
      // "בחר שנה" + year value in row 4/16/28/40 etc).
      var sectionYear = null;
      for (var ny = r - 1; ny >= 0; ny--) {
        for (var ncol = 0; ncol < dvals[ny].length; ncol++) {
          var vAny = dvals[ny][ncol];
          var yr = parseInt(vAny, 10);
          if (yr >= 2000 && yr <= 2100) { sectionYear = yr; break; }
        }
        if (sectionYear != null) break;
      }
      // If we found a year header and it doesn't match, keep scanning
      // (there may be a 2025 / 2024 row with the same label further down).
      if (sectionYear != null && sectionYear !== year) continue;

      // Find which column hosts our month label by scanning rows above.
      for (var hr = 0; hr < r; hr++) {
        for (var hc = 0; hc < dvals[hr].length; hc++) {
          if (String(dvals[hr][hc] || '').trim() !== monthLabel) continue;
          var cell = ds.getRange(r + 1, hc + 1);
          var existingFormula = '';
          try { existingFormula = String(cell.getFormula() || ''); } catch (_fErr) {}
          if (existingFormula) {
            // Preserve LEGITIMATE formulas (e.g. clean SUMIFS pointing
            // at the תנועות tab). OVERWRITE broken ones (residue from
            // earlier manual fixes: hardcoded "+ N" tail, or SUMIFS
            // referencing local columns without a tab qualifier).
            // _isBrokenBotDashFormula_ mirrors personal_sheet_fix.gs's
            // _isBrokenDashFormula_ so manual + auto paths agree on
            // what counts as broken.
            if (_isBrokenBotDashFormula_(existingFormula)) {
              cell.setValue(fresh);
              Logger.log('_updateBusinessDashboardInSheet_: ' + dashNames[d] + '!' + cell.getA1Notation() + ' had BROKEN formula -- cleaned to ₪' + fresh);
              return true;
            }
            Logger.log('_updateBusinessDashboardInSheet_: ' + dashNames[d] + '!' + cell.getA1Notation() + ' has clean formula - preserved');
            return false;
          }
          cell.setValue(fresh);
          Logger.log('_updateBusinessDashboardInSheet_: ' + dashNames[d] + '!' + cell.getA1Notation() + ' recomputed -> ₪' + fresh + ' (sub=' + canonSub + ', month=' + monthLabel + ', year=' + year + ')');
          return true;
        }
      }
    }
  }
  Logger.log('_updateBusinessDashboardInSheet_: row "' + canonSub + '" with year section ' + year + ' not found');
  return false;
}

// ════════════════════════════════════════════════════════════════════════
// MULTI-BUSINESS routing (Steven 2026-05-25):
//
// Steven owns multiple businesses. He asked: "עסק 1 X" should go to the
// default biz sheet, "עסק 2 X" to a SECOND sheet the bot creates on
// demand, "עסק 3 X" to a third, etc.
//
// Storage:
//   KV biz:{ownerPhone}:{n} = { sheetId, sheetUrl, n, createdAt }
//   KV biz:owner:{ownerPhone}:list = [ {sheetId, sheetUrl, n, createdAt}, ... ]
//
// N=1 is special — always maps to the bot's main SHEET_ID. Backward
// compatible with single-sheet users.
//
// For N>=2 the bot CLONES the main sheet on first use (so the new biz
// sheet inherits Steven's tab structure + dashboards). Subsequent writes
// to "עסק N ..." just append to the existing sheet.
//
// Limitation: owner-only for now. Tenants going through /api/sheet/append
// still use their single provisioned sheet. Multi-tenant multi-biz is a
// future enhancement (would need extending the api/sheet provisioner).
// ════════════════════════════════════════════════════════════════════════

// Match a leading "עסק <N>" prefix and optionally a NAME for the
// business + a body. Returns {n, name, rest} on match, null otherwise.
// N must be 1-99 (sanity cap to avoid silly inputs).
//
// Supported shapes (Steven 2026-05-26):
//   "עסק 2 320 שיווק"                   -> n=2, name=null, rest="320 שיווק"
//   "עסק 2 כספלה - 52 hostinger"        -> n=2, name="כספלה", rest="52 hostinger"
//   "עסק 2 כספלה: 52 hostinger"         -> n=2, name="כספלה", rest="52 hostinger"
//   "עסק 2 כספלה"                       -> n=2, name="כספלה", rest=""  (set-name-only)
//
// The name is anything from the start up to a separator ("-", "—", ":")
// that is NOT a number. Capped at 40 chars to avoid swallowing the body.
function _parseBusinessNumberPrefix_(text) {
  if (!text) return null;
  var m = String(text).trim().match(/^עסק\s+(\d{1,2})\s+(.+)$/);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  if (n < 1 || n > 99) return null;
  var rest = String(m[2] || '').trim();
  var name = null;

  // Pattern A: "name - body" / "name — body" / "name: body"
  var sep = rest.match(/^([^\d+\-—:][^:\-—\n]{0,40}?)\s*[-—:]\s*(.+)$/);
  if (sep) {
    name = sep[1].trim();
    rest = sep[2].trim();
  } else if (!/^[+-]?\d/.test(rest)) {
    // Pattern B: no separator AND rest does not start with a number
    // -> the whole rest is the name (set-name-only command, no expense).
    name = rest;
    rest = '';
  }
  if (name && name.length > 40) name = name.slice(0, 40);
  return { n: n, name: name, rest: rest };
}

// Resolve or auto-create the spreadsheet for owner's business number N.
// Optionally persists a NAME for the business (Steven 2026-05-26): if a
// name is passed, it is stored on the biz record. Subsequent calls
// without a name return the previously-stored name. Returns
// { sheetId, sheetUrl, isNew, name } or null on failure.
function _getOrCreateBusinessSheet_(ownerPhone, n, nameOpt) {
  if (!n || n < 1) return null;
  var clean = String(ownerPhone || '').replace(/[^0-9]/g, '');
  var nameClean = nameOpt ? String(nameOpt).trim().slice(0, 40) : '';

  if (n === 1) {
    // N=1 still maps to the main bot sheet. Allow naming for consistency,
    // stored under biz:{phone}:1 just so /עסקים שלי can echo a label.
    if (nameClean && clean) {
      var k1 = 'biz:' + clean + ':1';
      var prev1 = kvGet(k1) || {};
      kvSet(k1, { sheetId: SHEET_ID, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit', n: 1, name: nameClean, createdAt: prev1.createdAt || Date.now() }, 0);
    }
    var existing1 = clean ? (kvGet('biz:' + clean + ':1') || {}) : {};
    return { sheetId: SHEET_ID, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit', isNew: false, name: existing1.name || nameClean || '' };
  }
  if (!clean) return null;

  var key = 'biz:' + clean + ':' + n;
  var existing = kvGet(key);
  if (existing && existing.sheetId) {
    // If a new name was passed, persist it on top of the existing record.
    if (nameClean && existing.name !== nameClean) {
      existing.name = nameClean;
      kvSet(key, existing, 0);
    }
    return {
      sheetId: existing.sheetId,
      sheetUrl: existing.sheetUrl || ('https://docs.google.com/spreadsheets/d/' + existing.sheetId + '/edit'),
      isNew: false,
      name: existing.name || '',
    };
  }
  // Auto-create by cloning the main bot sheet so the new biz sheet
  // inherits the same tab structure (תנועות, מאזן חברה, הזמנות, etc).
  try {
    var copyName = 'Kesefle עסק ' + n + (nameClean ? ' ' + nameClean : '') + ' — ' + clean;
    var copy = DriveApp.getFileById(SHEET_ID).makeCopy(copyName);
    var newId = copy.getId();
    var url = 'https://docs.google.com/spreadsheets/d/' + newId + '/edit';
    var rec = { sheetId: newId, sheetUrl: url, n: n, name: nameClean, createdAt: Date.now() };
    kvSet(key, rec, 0);
    // Maintain a list so "עסקים שלי" can show them all in one place.
    var listKey = 'biz:owner:' + clean + ':list';
    var list = kvGet(listKey) || [];
    var already = false;
    for (var i = 0; i < list.length; i++) { if (list[i] && list[i].n === n) { already = true; break; } }
    if (!already) {
      list.push(rec);
      kvSet(listKey, list, 0);
    }
    Logger.log('_getOrCreateBusinessSheet_: created sheet ' + newId + ' for owner=' + clean + ' biz=' + n + ' name=' + nameClean);
    return { sheetId: newId, sheetUrl: url, isNew: true, name: nameClean };
  } catch (e) {
    Logger.log('_getOrCreateBusinessSheet_ err: ' + (e && e.message));
    return null;
  }
}

// Write an expense to business N. Parses "<amount> <description>" out
// of `rest`, classifies subcategory, appends to the per-N תנועות, then
// recomputes the per-N מאזן חברה. Income syntax: "+1500 <description>".
//
// Optional `nameOpt` (Steven 2026-05-26): the business name the user
// declared in this message (e.g. "כספלה" in "עסק 2 כספלה - 52 hostinger").
// If present, it is persisted on the biz record so future replies can
// echo the name and the user does not have to re-type it.
//
// Special case: if `rest` is empty AND `nameOpt` is set, this is a
// "set the name of business N to X" command -- no expense is written.
function _writeBusinessNExpense_(fromPhone, n, nameOpt, rest) {
  var target = _getOrCreateBusinessSheet_(fromPhone, n, nameOpt || null);
  if (!target) return { handled: true, replyText: '😬 לא הצלחתי לפתוח את הגיליון של עסק ' + n };

  var effectiveName = (nameOpt && String(nameOpt).trim()) || target.name || '';
  var nameSuffix = effectiveName ? ' (' + effectiveName + ')' : '';

  // Set-name-only: rest is empty + we got a name. Confirm and stop.
  if ((!rest || !String(rest).trim()) && effectiveName) {
    var setLines = ['✅ עסק ' + n + ' = ' + effectiveName];
    if (target.isNew) {
      setLines.push('');
      setLines.push('🆕 יצרתי גיליון חדש:');
      setLines.push('📊 ' + target.sheetUrl);
    }
    setLines.push('');
    setLines.push('עכשיו תוכל לשלוח לדוגמה:');
    setLines.push('"עסק ' + n + ' 320 שיווק"');
    return { handled: true, replyText: setLines.join('\n') };
  }

  // Accept "<amount> <description>" or "+<amount> <description>" (income).
  var m = String(rest || '').trim().match(/^([+-]?\d+(?:\.\d+)?)\s+(.+)$/);
  if (!m) {
    return { handled: true, replyText:
      '😬 פורמט: "עסק ' + n + (effectiveName ? ' ' + effectiveName : '') + ' <סכום> <תיאור>"\n' +
      'לדוגמה: "עסק ' + n + ' 320 שיווק פייסבוק"\n' +
      'או הכנסה: "עסק ' + n + ' +1500 מכירת תמונה"' };
  }
  var raw = m[1];
  var amount = Math.abs(parseFloat(raw));
  var description = String(m[2] || '').trim();
  var isIncome = raw.charAt(0) === '+';
  if (!amount || isNaN(amount)) return { handled: true, replyText: '😬 סכום לא חוקי.' };

  // Classify subcategory using the existing matcher (prefix with "עסק"
  // so the business keywords fire). Fall back to first word as sub.
  var sub = '';
  try {
    var matched = (typeof matchCategory === 'function') ? matchCategory('עסק ' + description) : null;
    if (matched && matched.subcategory && matched.subcategory !== matched.category) {
      sub = matched.subcategory;
    }
  } catch (_) {}
  if (!sub) {
    // Heuristic: first word of description as the sub (Steven can re-tag later).
    sub = description.split(/\s+/)[0] || 'שונות';
  }

  try {
    var ss = SpreadsheetApp.openById(target.sheetId);
    var tx = ss.getSheetByName(TRANSACTIONS_SHEET) || ss.getSheetByName('תנועות');
    if (!tx) {
      return { handled: true, replyText:
        '😬 לא מצאתי לשונית תנועות בגיליון של עסק ' + n + nameSuffix + '.\n📊 ' + target.sheetUrl +
        '\n💡 פתח את הגיליון, ודא שיש לשונית "תנועות".' };
    }
    var now = new Date();
    var monthKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM');
    tx.appendRow([now, monthKey, amount, 'עסק', sub, description, 'WhatsApp', !isIncome]);

    // Recompute the per-N dashboard so the total reflects this write.
    try { _updateBusinessDashboardInSheet_(ss, 'עסק', sub, monthKey, amount); }
    catch (_dErr) { Logger.log('biz-N dash err: ' + (_dErr && _dErr.message)); }

    var emoji = isIncome ? '💵' : '💸';
    var lines = [emoji + ' עסק ' + n + nameSuffix + ': ₪' + amount.toLocaleString('he-IL') + ' · ' + sub];
    if (target.isNew) {
      lines.push('');
      lines.push('🆕 יצרתי גיליון חדש בשבילך לעסק ' + n + (effectiveName ? ' (' + effectiveName + ')' : '') + ':');
      lines.push('📊 ' + target.sheetUrl);
      lines.push('');
      lines.push('הוא משוכפל מהגיליון הראשי שלך עם אותו מבנה (תנועות, מאזן חברה, הזמנות).');
    } else {
      lines.push('📊 ' + target.sheetUrl);
    }
    return { handled: true, replyText: lines.join('\n') };
  } catch (e) {
    return { handled: true, replyText: '😬 שגיאה בכתיבה לגיליון של עסק ' + n + nameSuffix + ': ' + (e && e.message) };
  }
}

// "עסקים שלי" -- list all business sheets the owner has provisioned via
// the multi-business routing. Always includes #1 (the main sheet) even
// if it isn't in KV, since N=1 is implicit.
function _handleMyBusinessesCommand_(fromPhone, text) {
  var t = String(text || '').trim();
  if (!/^עסקים\s*שלי$|^my\s+businesses$|^עסקים$/i.test(t)) return { handled: false };
  var clean = String(fromPhone || '').replace(/[^0-9]/g, '');
  if (!clean) return { handled: true, replyText: '😬 לא הצלחתי לזהות את המספר שלך.' };
  var list = kvGet('biz:owner:' + clean + ':list') || [];
  var lines = ['📋 *העסקים שלך:*', ''];
  lines.push('1. *עסק 1* (הגיליון הראשי)');
  lines.push('   📊 https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit');
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !r.n || r.n === 1) continue;
    lines.push('');
    lines.push(r.n + '. *עסק ' + r.n + '*');
    lines.push('   📊 ' + (r.sheetUrl || 'https://docs.google.com/spreadsheets/d/' + r.sheetId + '/edit'));
  }
  if (list.length <= 1) {
    lines.push('');
    lines.push('💡 רוצה להוסיף עסק שני? פשוט שלח:');
    lines.push('   "עסק 2 320 שיווק"');
    lines.push('ואני אצור לך גיליון חדש אוטומטית.');
  }
  return { handled: true, replyText: lines.join('\n') };
}

// Sum תנועות col C where col D = "עסק", col E matches the bucket-regex
// for canonSub, col B starts with yyyy-mm. Returns null on any read
// failure; returns a non-negative integer otherwise.
function _sumBusinessBucketFromTransactions_(ss, canonSub, year, monthIdx) {
  try {
    var tx = ss.getSheetByName(TRANSACTIONS_SHEET || 'תנועות');
    if (!tx) tx = ss.getSheetByName('תנועות');
    if (!tx) return null;
    var lastRow = tx.getLastRow();
    if (lastRow < 2) return 0;
    var data = tx.getRange(2, 1, lastRow - 1, 6).getValues();
    var mm = monthIdx < 10 ? ('0' + monthIdx) : ('' + monthIdx);
    var prefix = year + '-' + mm;
    var bucketRegex = _bucketRegexFor_(canonSub);
    if (!bucketRegex) return null;
    var sum = 0;
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var month = String(r[1] || '').trim();
      if (month !== prefix && month !== (year + '-' + monthIdx)) continue;
      var amt = Number(r[2]) || 0;
      if (!amt) continue;
      var cat = String(r[3] || '').trim();
      if (cat !== 'עסק') continue;
      var sub = String(r[4] || '').trim();
      if (!bucketRegex.test(sub)) continue;
      sum += Math.abs(amt);
    }
    return Math.round(sum);
  } catch (e) {
    try { Logger.log('_sumBusinessBucketFromTransactions_ err: ' + (e && e.message)); } catch (_) {}
    return null;
  }
}

// Mirrors personal_sheet_fix.gs _isBrokenDashFormula_. Keep these two
// in sync or the auto-self-heal will disagree with Steven's manual
// CLEAN_BROKEN_FORMULAS run -- a cell would oscillate. Pattern 1:
// SUMIFS with hardcoded "+ N" / "- N" tail. Pattern 2: SUMIFS that
// references local A/I columns without a 'תנועות'! qualifier.
function _isBrokenBotDashFormula_(formula) {
  var f = String(formula || '').trim();
  if (!f || f.charAt(0) !== '=') return false;
  if (/SUMIFS\([^)]*\)\s*[+\-]\s*\d+(\.\d+)?\s*$/i.test(f)) return true;
  if (/SUMIFS\(\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+\s*,\s*\$?[A-Z]+\$?\d+\s*:\s*\$?[A-Z]+\$?\d+/i.test(f)
      && !/'?[֐-׿]+'?!|'תנועות'!|תנועות!|transactions!/i.test(f)) {
    return true;
  }
  return false;
}

// Mirror of personal_sheet_fix.gs _COMPANY_SUB_BUCKETS_ but for the bot.
// Maps a canonical dashboard row label -> regex matching all subcategory
// strings the bot might write for that bucket. Kept in sync manually.
function _bucketRegexFor_(canonLabel) {
  switch (canonLabel) {
    case 'מחזור':
    case 'מחזור ברוטו':
      return /^(מחזור|revenue|sale|sales|gross)\s*$|מחזור/;
    case 'עלות חומרי גלם':
      return /חומרי\s*גלם|raw\s*material/i;
    case 'עלות שיווק':
      return /שיווק|פרסום|advert|adwords|facebook|instagram|tiktok|google ads|fb ads|פייסבוק|אינסטה|טיקטוק|גוגל\s*אדס/i;
    case 'משלוחים והתקנות':
      return /משלוח|אריזה|shipping|packaging|הובלה|התקנה/i;
    case 'הוצאות תפעוליות':
      return /תפעולי|operational|יועצים|תוכנות|ציוד\s*עסקי|מיסים|operations|consulting|software|equipment|taxes/i;
    default:
      return null;
  }
}

// Appends a NOTE to the dashboard cell that aggregates this transaction —
// the (subcategory-row x month-column) intersection on מאזן אישי (personal) or
// מאזן חברה (business). NOTE ONLY: never touches the cell's value or its SUMIFS
// formula, so it cannot corrupt totals or user-typed numbers.
//
// Why the row label = subcategory: the personal dashboard cells are
// SUMIFS(תנועות!C:C, תנועות!E:E, $A{row}, ...) — i.e. they key column A (the
// row label) against תנועות col E (the subcategory the bot wrote). So the row
// that sums this expense is, by construction, the row labeled with its
// subcategory. For business we collapse to the canonical biz-sub the company
// dashboard rows use (same mapping _updateBusinessDashboard_ relies on).
function setDashboardNoteForTransaction_(category, subcategory, monthKey, noteText) {
  if (!noteText) return false;
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var isBiz = (category === 'עסק');
  var dashNames = isBiz ? ['מאזן חברה 2026', 'מאזן חברה'] : ['מאזן שנתי', 'מאזן אישי'];
  var rowLabel = String(subcategory || '').trim();
  if (isBiz && typeof _normalizeBizSub_ === 'function') {
    var canon = _normalizeBizSub_(subcategory);
    if (canon) rowLabel = canon;
  }
  if (!rowLabel) return false;
  var hebMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var monthIdx = parseInt((monthKey || '').split('-')[1], 10);
  var monthLabel = (!isNaN(monthIdx) && monthIdx >= 1 && monthIdx <= 12) ? hebMonths[monthIdx - 1] : null;
  if (!monthLabel) return false;
  for (var d = 0; d < dashNames.length; d++) {
    var ds = ss.getSheetByName(dashNames[d]);
    if (!ds) continue;
    var dvals = ds.getDataRange().getValues();
    for (var r = 0; r < dvals.length; r++) {
      for (var c = 0; c < dvals[r].length; c++) {
        if (String(dvals[r][c] || '').trim() === rowLabel) {
          for (var hr = 0; hr < r; hr++) {
            for (var hc = 0; hc < dvals[hr].length; hc++) {
              if (String(dvals[hr][hc] || '').trim() === monthLabel) {
                var cell = ds.getRange(r + 1, hc + 1);
                var existing = cell.getNote();
                var combined = existing ? (existing + '\n' + noteText) : noteText;
                cell.setNote(combined);
                Logger.log('setDashboardNoteForTransaction_: ' + dashNames[d] + '!' + cell.getA1Notation() + ' += "' + noteText + '"');
                return true;
              }
            }
          }
        }
      }
    }
  }
  Logger.log('setDashboardNoteForTransaction_: no cell for row "' + rowLabel + '" x "' + monthLabel + '"');
  return false;
}

// Builds the compact per-expense breakdown line and appends it to the matching
// dashboard cell as a note. Best-effort + silent on failure so it can never
// block expense logging. Mirrors the תנועות original-text note onto the
// dashboard so hovering a monthly category total shows what made it up.
function _dashboardDetailNote_(category, subcategory, monthKey, amount, description, when) {
  try {
    var d = (when instanceof Date) ? when : new Date();
    var line = Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM HH:mm') +
               ' · ₪' + Math.abs(Number(amount) || 0).toLocaleString('he-IL') +
               ' · ' + String(description == null ? '' : description).trim().slice(0, 50);
    return setDashboardNoteForTransaction_(category, subcategory, monthKey, line);
  } catch (e) {
    Logger.log('_dashboardDetailNote_: ' + (e && e.message));
    return false;
  }
}

// ============================================================
// 📅 WEEKLY SUMMARY CRON — push spend report to user every Sunday 9am.
// ============================================================
// Setup: in Apps Script editor → Triggers → "+ Add Trigger" →
//   - Function: cronWeeklySummary
//   - Event source: Time-driven
//   - Type: Week timer → Every Sunday → 09:00-10:00
//
// Sends to ALLOWED_PHONE (single-user mode) or — in multi-tenant — iterates
// over all linked phones via Vercel KV API.
function cronWeeklySummary() {
  try {
    var summary = _buildWeeklySummary();
    if (!summary || !summary.text) {
      Logger.log('cronWeeklySummary: no summary to send');
      return;
    }
    var to = ALLOWED_PHONE || (PropertiesService.getScriptProperties().getProperty('WEEKLY_SUMMARY_PHONE') || '');
    if (!to) {
      Logger.log('cronWeeklySummary: no recipient configured');
      return;
    }
    sendWhatsAppMessage(to, summary.text);
    Logger.log('cronWeeklySummary: sent to ' + to);
  } catch (e) {
    Logger.log('cronWeeklySummary error: ' + (e && e.stack || e));
  }
}

function _buildWeeklySummary() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { text: '📊 שבוע שעבר: אין הוצאות. כל הכבוד!' };

  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  var weekTotal = 0;
  var weekIncome = 0;
  var prevWeekTotal = 0;
  var byCategory = {};
  var byDay = {};
  var transactions = 0;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowDate = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(rowDate.getTime())) continue;
    var amount = Number(row[2]) || 0;
    var category = String(row[3] || '');
    var sub = String(row[4] || '');
    var isIncome = /הכנסות|הכנסה/i.test(category);

    if (rowDate >= weekAgo) {
      if (isIncome) weekIncome += amount;
      else {
        weekTotal += amount;
        transactions++;
        byCategory[category] = (byCategory[category] || 0) + amount;
        var dayKey = Utilities.formatDate(rowDate, 'Asia/Jerusalem', 'EEE');
        byDay[dayKey] = (byDay[dayKey] || 0) + amount;
      }
    } else if (rowDate >= twoWeeksAgo && !isIncome) {
      prevWeekTotal += amount;
    }
  }

  // Sort categories by spend descending
  var catList = Object.keys(byCategory).map(function(k) { return { name: k, amount: byCategory[k] }; });
  catList.sort(function(a, b) { return b.amount - a.amount; });

  var deltaPct = prevWeekTotal > 0 ? Math.round(((weekTotal - prevWeekTotal) / prevWeekTotal) * 100) : 0;
  var deltaIcon = deltaPct > 0 ? '📈' : deltaPct < 0 ? '📉' : '➡️';
  var deltaWord = deltaPct > 0 ? 'יותר' : deltaPct < 0 ? 'פחות' : 'כמו';

  var lines = [];
  lines.push('📊 *סיכום השבוע* (' + Utilities.formatDate(weekAgo, 'Asia/Jerusalem', 'dd/MM') + '–' + Utilities.formatDate(now, 'Asia/Jerusalem', 'dd/MM') + ')');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('💸 *הוצאות:* ₪' + weekTotal.toLocaleString() + ' (' + transactions + ' תנועות)');
  if (weekIncome > 0) lines.push('💰 *הכנסות:* ₪' + weekIncome.toLocaleString());
  if (prevWeekTotal > 0) {
    lines.push(deltaIcon + ' ' + Math.abs(deltaPct) + '% ' + deltaWord + ' מהשבוע שעבר');
  }
  lines.push('');
  lines.push('🔝 *5 קטגוריות מובילות:*');
  for (var c = 0; c < Math.min(5, catList.length); c++) {
    var emoji = ['🥇','🥈','🥉','4️⃣','5️⃣'][c];
    lines.push(emoji + ' ' + catList[c].name + ' — ₪' + catList[c].amount.toLocaleString());
  }
  lines.push('');
  lines.push('💡 *תובנה:* ' + _generateInsight(catList, weekTotal, prevWeekTotal, transactions));
  lines.push('');
  lines.push('📊 לוח מלא: כתוב "סיכום" לסיכום החודש');

  return { text: lines.join('\n'), weekTotal: weekTotal, weekIncome: weekIncome, transactions: transactions };
}

// Heuristic spending insights — picks one of several patterns to highlight.
function _generateInsight(catList, weekTotal, prevWeekTotal, txCount) {
  if (!catList.length) return 'כל הכבוד — אין הוצאות השבוע!';
  var top = catList[0];
  var topPct = Math.round((top.amount / weekTotal) * 100);
  if (topPct > 40) {
    return top.name + ' הוא ' + topPct + '% מההוצאות שלך השבוע. אולי כדאי לבחון את זה.';
  }
  if (prevWeekTotal > 0 && weekTotal > prevWeekTotal * 1.3) {
    return 'הוצאת ' + Math.round(((weekTotal - prevWeekTotal) / prevWeekTotal) * 100) + '% יותר מהשבוע שעבר. שמרי על קצב.';
  }
  if (prevWeekTotal > 0 && weekTotal < prevWeekTotal * 0.8) {
    return 'חיסכון משמעותי השבוע — ₪' + (prevWeekTotal - weekTotal).toLocaleString() + ' פחות מהשבוע הקודם. כל הכבוד!';
  }
  if (txCount > 30) {
    return 'שבוע פעיל מאוד — ' + txCount + ' תנועות. כל הכבוד על המעקב.';
  }
  return 'הוצאות מאוזנות. ' + top.name + ' מוביל עם ₪' + top.amount.toLocaleString() + '.';
}

// One-shot installer: registers the weekly trigger if not already present.
// Run once from the Apps Script editor.
function installWeeklySummaryTrigger() {
  // Remove any existing weekly triggers for this function to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronWeeklySummary') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cronWeeklySummary')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(9)
    .create();
  Logger.log('✅ Weekly summary trigger installed (Sundays 9am)');
}

// ============================================================
// 💡 SMART INSIGHTS API — callable on demand ("תובנות" / "insights")
// ============================================================
function getInsightsMessage() {
  try {
    var summary = _buildWeeklySummary();
    if (!summary) return '😬 לא הצלחתי לחשב תובנות כרגע\n💡 ננסה שוב בעוד דקה?';

    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '😬 אין לשונית תנועות\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט';
    var data = sheet.getDataRange().getValues();

    // Compute month-to-date totals
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var mtdTotal = 0;
    var topCats = {};
    for (var i = 1; i < data.length; i++) {
      var rowDate = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
      if (isNaN(rowDate.getTime()) || rowDate < monthStart) continue;
      var category = String(data[i][3] || '');
      if (/הכנסות|הכנסה/i.test(category)) continue;
      var amt = Number(data[i][2]) || 0;
      mtdTotal += amt;
      topCats[category] = (topCats[category] || 0) + amt;
    }
    var topList = Object.keys(topCats).map(function(k) { return { name: k, amount: topCats[k] }; });
    topList.sort(function(a, b) { return b.amount - a.amount; });

    var lines = [];
    lines.push('🔮 *תובנות חכמות*');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('📆 *מתחילת החודש:* ₪' + mtdTotal.toLocaleString());
    lines.push('📊 *השבוע:* ₪' + summary.weekTotal.toLocaleString() + ' (' + summary.transactions + ' תנועות)');
    lines.push('');
    if (topList.length > 0) {
      lines.push('🏆 *קטגוריה מובילה החודש:*');
      lines.push('  ' + topList[0].name + ' — ₪' + topList[0].amount.toLocaleString());
    }
    lines.push('');
    lines.push('💡 ' + _generateInsight(topList, summary.weekTotal, 0, summary.transactions));
    return lines.join('\n');
  } catch (e) {
    Logger.log('getInsightsMessage error: ' + e);
    return '😬 משהו השתבש בחישוב תובנות\n💡 ננסה שוב בעוד דקה?';
  }
}

// ============================================================
// 🔁 INACTIVITY REACTIVATION CRON — gentle nudge to users who haven't
//    sent an expense in 7+ days. Tone scales with the gap length.
// ============================================================
// Setup: in Apps Script editor → Triggers → "+ Add Trigger" →
//   - Function: cronCheckInactivity
//   - Event source: Time-driven
//   - Type: Week timer → Every Tuesday → 09:00-10:00
//
// OR call installInactivityTrigger() once to install programmatically.
function cronCheckInactivity() {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) { Logger.log('cronCheckInactivity: no sheet'); return; }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('cronCheckInactivity: empty sheet'); return; }

    // Last transaction date — column A
    var lastDate = sheet.getRange(lastRow, 1).getValue();
    if (!(lastDate instanceof Date)) lastDate = new Date(lastDate);
    if (isNaN(lastDate.getTime())) { Logger.log('cronCheckInactivity: bad date'); return; }

    var now = new Date();
    var daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));
    if (daysSince < 7) {
      Logger.log('cronCheckInactivity: only ' + daysSince + ' days, skipping');
      return;
    }

    // Throttle: don't message more than once per 7 days
    var props = PropertiesService.getScriptProperties();
    var lastNudgeIso = props.getProperty('lastInactivityNudge') || '';
    if (lastNudgeIso) {
      var lastNudge = new Date(lastNudgeIso);
      if (!isNaN(lastNudge.getTime()) && (now.getTime() - lastNudge.getTime()) < 7 * 24 * 60 * 60 * 1000) {
        Logger.log('cronCheckInactivity: nudged within 7d, skipping');
        return;
      }
    }

    var to = ALLOWED_PHONE || props.getProperty('WEEKLY_SUMMARY_PHONE') || '';
    if (!to) { Logger.log('cronCheckInactivity: no recipient'); return; }

    var msg = _generateReactivationMessage(daysSince);
    sendWhatsAppMessage(to, msg);
    props.setProperty('lastInactivityNudge', now.toISOString());
    Logger.log('cronCheckInactivity: sent nudge (gap=' + daysSince + 'd)');
  } catch (e) {
    Logger.log('cronCheckInactivity error: ' + (e && e.stack || e));
  }
}

function _generateReactivationMessage(daysSince) {
  var head;
  if (daysSince <= 13) head = '👋 היי, מזמן לא דיברנו — ' + daysSince + ' ימים בלי הוצאה חדשה.';
  else if (daysSince <= 29) head = '👀 עברו ' + daysSince + ' ימים מאז ההוצאה האחרונה. הכל בסדר?';
  else head = '🌱 כבר ' + daysSince + ' ימים שלא רשמת כלום. נחזור לסדר?';

  return head + '\n\n' +
    'אפשר לחזור עם משהו פשוט:\n' +
    '  • "32 קפה"\n' +
    '  • "180 דלק"\n' +
    '  • "סיכום" — לראות מה היה החודש\n\n' +
    'אני כאן כשתחזור. 💛';
}

function installInactivityTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronCheckInactivity') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cronCheckInactivity')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.TUESDAY)
    .atHour(9)
    .create();
  Logger.log('✅ Inactivity trigger installed (Tuesdays 9am)');
}

// ============================================================
// 🎯 Categorization confidence — used to decide whether to append
//    a "correct me if I'm wrong" hint to the success reply.
// ============================================================
// Returns: 'high' (cache hit, long-keyword match, or multiple-keyword match)
//        | 'moderate' (single short keyword matched — bot is guessing)
//        | 'low' (DEFAULT_CATEGORY — handled separately via interactive list)
function _categorizationConfidence(text, matched) {
  if (!matched || !matched.category) return 'low';
  if (matched.category === DEFAULT_CATEGORY.category &&
      matched.subcategory === DEFAULT_CATEGORY.subcategory) return 'low';

  // Cache hit always = high
  if (_learnedLookup && _learnedLookup(text)) return 'high';

  var t = String(text || '').toLowerCase();
  // Count how many keywords from the matched entry appear in the text
  var matchCount = 0;
  var longestMatch = 0;
  if (typeof CATEGORY_MAP !== 'undefined') {
    for (var i = 0; i < CATEGORY_MAP.length; i++) {
      var e = CATEGORY_MAP[i];
      if (e.category !== matched.category || e.subcategory !== matched.subcategory) continue;
      for (var j = 0; j < (e.keywords || []).length; j++) {
        var kw = String(e.keywords[j]).toLowerCase();
        if (kw.length >= 2 && t.indexOf(kw) !== -1) {
          matchCount++;
          if (kw.length > longestMatch) longestMatch = kw.length;
        }
      }
      break;
    }
  }
  if (matchCount >= 2 || longestMatch >= 6) return 'high';
  return 'moderate';
}

// ============================================================
// 🔥 STREAK TRACKER — consecutive days the user logged ANY expense.
// ============================================================
// Stored in Script Properties (single-tenant). For multi-tenant we key by
// phone: e.g. 'streak:972547760643' → { count, lastLogIsoDate }.
// _bumpStreak_ is called from processExpense on every successful write.
// _streakCelebrationLine_ returns a Hebrew tail line only on milestone days.
// Milestones: 1, 3, 7, 14, 30, 60, 100, 200, 365.

function _streakKey_(fromPhone) {
  var phone = fromPhone || ALLOWED_PHONE || '';
  return phone ? ('streak:' + phone) : 'streak:default';
}

// Returns the current streak count after bumping. Idempotent within the same
// calendar day in Israel time — if user logs 5 expenses on Sunday the streak
// only ticks once. Resets to 1 if the previous log was >1 calendar day ago.
function _bumpStreak_(fromPhone) {
  var props = PropertiesService.getScriptProperties();
  var key = _streakKey_(fromPhone);
  var todayKey = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
  var raw = props.getProperty(key);
  var state = { count: 0, lastLogDate: '' };
  if (raw) {
    try { state = JSON.parse(raw); } catch (e) { state = { count: 0, lastLogDate: '' }; }
  }
  if (state.lastLogDate === todayKey) {
    return state.count; // already counted today
  }
  // Compute calendar-day delta in Asia/Jerusalem
  var dayDelta = 999;
  if (state.lastLogDate) {
    var parts = String(state.lastLogDate).split('-');
    if (parts.length === 3) {
      var lastUtc = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      var tParts = todayKey.split('-');
      var todayUtc = Date.UTC(Number(tParts[0]), Number(tParts[1]) - 1, Number(tParts[2]));
      dayDelta = Math.round((todayUtc - lastUtc) / 86400000);
    }
  }
  state.count = (dayDelta === 1) ? (state.count + 1) : 1;
  state.lastLogDate = todayKey;
  props.setProperty(key, JSON.stringify(state));
  return state.count;
}

// Returns a celebratory Hebrew line for milestone days, or empty string.
// Stays out of the way on non-milestone days so the bot isn't noisy.
function _streakCelebrationLine_(streak) {
  if (!streak) return '';
  switch (streak) {
    case 1:   return '🌱 הוצאה ראשונה! יום 1 של מעקב — הצעד הקשה ביותר נעשה.';
    case 3:   return '🔥 3 ימים ברצף! ההרגל נבנה — אל תפסיק עכשיו.';
    case 7:   return '⭐ שבוע שלם ברצף! 80% מהמשתמשים נושרים פה. אתה לא.';
    case 14:  return '🚀 שבועיים ברצף! זה כבר לא מקרי — זה הרגל.';
    case 30:  return '🏆 חודש שלם של מעקב יומיומי! אתה רשמית בקבוצה של ה-5% המובילים.';
    case 60:  return '💎 60 ימים ברצף. בנקודה הזו אנשים שלך פשוט סומכים על המספרים בעצמם.';
    case 100: return '👑 100 ימים. זה דורש סוג מסוים של אדם. אתה הוא.';
    case 200: return '🌟 200 ימים. אם תרצה — נדפיס לך תעודה.';
    case 365: return '🎂 שנה של מעקב! הכסף שלך פתאום שקוף לחלוטין. ברכות.';
    default:  return '';
  }
}

// Returns the current streak without bumping. Useful for cron messages.
function _getStreakCount_(fromPhone) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(_streakKey_(fromPhone));
  if (!raw) return 0;
  try {
    var state = JSON.parse(raw);
    // If lastLogDate is older than yesterday (Israel time), the streak is broken.
    var todayKey = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    if (state.lastLogDate === todayKey) return state.count;
    if (state.lastLogDate) {
      var parts = state.lastLogDate.split('-');
      var tParts = todayKey.split('-');
      var lastUtc = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      var todayUtc = Date.UTC(Number(tParts[0]), Number(tParts[1]) - 1, Number(tParts[2]));
      var delta = Math.round((todayUtc - lastUtc) / 86400000);
      if (delta <= 1) return state.count;
    }
    return 0; // broken streak
  } catch (e) { return 0; }
}

// Returns "החודש הוצאת ₪X על Y — בדרך לממוצע שלך." or empty if not applicable.
// Skipped silently for income categories or when month-to-date is small.
function _categoryMonthToDateLine_(category, isIncome) {
  if (isIncome) return '';
  if (!category) return '';
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '';
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return '';
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var sum = 0;
    for (var i = 1; i < data.length; i++) {
      var d = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
      if (isNaN(d.getTime()) || d < monthStart) continue;
      if (String(data[i][3] || '') !== category) continue;
      sum += Number(data[i][2]) || 0;
    }
    if (sum < 50) return ''; // too early in month to be insightful
    return 'החודש הוצאת ₪' + sum.toLocaleString('he-IL') + ' על ' + category + '.';
  } catch (e) { return ''; }
}

// ============================================================
// 💰 PROACTIVE BUDGET ALERTS — appended as a tail to expense replies
// ============================================================
// Watches each category's pace vs last month's spend (or user-set budget).
// Three tiers, escalating in severity. Only the highest-severity matching
// tier fires per write. Throttled to once per 6h per (phone, category, tier)
// via CacheService so the user is never spammed with the same warning.
//
// Tier 1 (⚠️ gentle):  ahead-of-pace warning when we're trending 20%+ over
//                       what we'd need to match last month linearly
// Tier 2 (🚨 firm):    already 80%+ of last month's total before 2/3 of the
//                       month has elapsed
// Tier 3 (🔥 over):    blew past last month's total

// Compute month-to-date and last-month totals for a category.
// Returns { thisMonth, lastMonth, daysElapsed, daysInMonth, daysLeft, lastMonthSamePeriod }
// or null on failure / no useful data.
function _budgetStatsForCategory_(category) {
  if (!category) return null;
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    if (!data || data.length < 2) return null;

    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth(); // 0-11
    var monthStart = new Date(year, month, 1);
    var prevMonthStart = new Date(year, month - 1, 1);
    var prevMonthEnd = new Date(year, month, 0, 23, 59, 59); // last day prev month
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    // Day-of-month counts day 1 as "1 day elapsed".
    var daysElapsed = Math.min(now.getDate(), daysInMonth);
    var daysLeft = Math.max(daysInMonth - daysElapsed, 0);
    // For "same period last month" — same day count, capped to prev-month length.
    var prevMonthDays = new Date(year, month, 0).getDate();
    var sameDayPrev = Math.min(daysElapsed, prevMonthDays);
    var prevSamePeriodEnd = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), sameDayPrev, 23, 59, 59);

    var thisMonthSpent = 0;
    var lastMonthSpent = 0;
    var lastMonthSamePeriod = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rawDate = row[0];
      if (!rawDate) continue;
      var d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (isNaN(d.getTime())) continue;
      if (String(row[3] || '') !== category) continue;
      var amount = Number(row[2]) || 0;
      if (amount <= 0) continue;

      if (d >= monthStart && d <= now) {
        thisMonthSpent += amount;
      } else if (d >= prevMonthStart && d <= prevMonthEnd) {
        lastMonthSpent += amount;
        if (d <= prevSamePeriodEnd) lastMonthSamePeriod += amount;
      }
    }

    return {
      thisMonth: thisMonthSpent,
      lastMonth: lastMonthSpent,
      lastMonthSamePeriod: lastMonthSamePeriod,
      daysElapsed: daysElapsed,
      daysInMonth: daysInMonth,
      daysLeft: daysLeft
    };
  } catch (e) {
    Logger.log('_budgetStatsForCategory_ err: ' + (e && e.message));
    return null;
  }
}

// Fetch the user-set monthly budget for a category, or null. Stored in
// Vercel KV under "budget:{phone}:{category}".
function _getUserBudget_(fromPhone, category) {
  if (!fromPhone || !category) return null;
  try {
    var key = 'budget:' + fromPhone + ':' + category;
    var raw = kvGet(key);
    if (raw == null) return null;
    var num = Number(raw);
    if (!isFinite(num) || num <= 0) return null;
    return num;
  } catch (e) {
    Logger.log('_getUserBudget_ err: ' + (e && e.message));
    return null;
  }
}

// Throttle check + set. Returns true if this alert should fire (key was not
// already in CacheService); false if we should stay silent. TTL = 6h.
function _budgetAlertThrottle_(fromPhone, category, tier) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'bdgAlert:' + (fromPhone || 'anon') + ':' + category + ':' + tier;
    if (cache.get(key)) return false;
    cache.put(key, '1', 6 * 60 * 60); // 6h
    return true;
  } catch (e) {
    // If cache fails, fall through and allow the alert — better noisy than silent.
    Logger.log('_budgetAlertThrottle_ err: ' + (e && e.message));
    return true;
  }
}

// Returns a string (tail to append to reply, with leading newline) or ''.
// Silent for income categories and when there's no useful baseline.
function _budgetAlertTail_(category, fromPhone) {
  if (!category) return '';
  if (_anomalyIsIncomeCategory_(category)) return '';
  var stats = _budgetStatsForCategory_(category);
  if (!stats) return '';

  // Baseline preference: user-set budget > last-month-total.
  var userBudget = _getUserBudget_(fromPhone, category);
  var baseline = userBudget || stats.lastMonth;
  if (!baseline || baseline <= 0) return '';
  // Need enough data to be meaningful (avoid noise on a brand-new category).
  if (stats.thisMonth < 10) return '';

  var thisMonth = stats.thisMonth;
  var daysElapsed = stats.daysElapsed;
  var daysInMonth = stats.daysInMonth;
  var daysLeft = stats.daysLeft;
  var paceRatio = thisMonth / baseline; // fraction of baseline used so far

  var fmt = function(n) { return Math.round(n).toLocaleString('he-IL'); };

  // Tier 3 — already exceeded
  if (thisMonth > baseline) {
    if (!_budgetAlertThrottle_(fromPhone, category, 3)) return '';
    return '\n🔥 חצינו את הוצאת ' + category + ' של חודש שעבר (₪' +
           fmt(thisMonth) + ' מ-₪' + fmt(baseline) + ').';
  }

  // Tier 2 — already 80%+ of baseline before 2/3 of the month elapsed
  if (thisMonth > baseline * 0.8 && daysElapsed < daysInMonth * 0.66) {
    if (!_budgetAlertThrottle_(fromPhone, category, 2)) return '';
    var pct = Math.round(paceRatio * 100);
    return '\n🚨 כבר ' + pct + '% מההוצאה של ' + category +
           ' בחודש שעבר, ועדיין ' + daysLeft + ' ימים בחודש.';
  }

  // Tier 1 — ahead of linear pace by 20%+
  var expectedFraction = daysElapsed / daysInMonth;
  if (expectedFraction > 0 && paceRatio > expectedFraction * 1.2) {
    if (!_budgetAlertThrottle_(fromPhone, category, 1)) return '';
    return '\n⚠️ קצב גבוה ב-' + category + ': ₪' + fmt(thisMonth) +
           ' מ-₪' + fmt(baseline) + ' בחודש שעבר.';
  }

  return '';
}

// ----------------------------------------------------------------------
// Command handler: "תקציבים" / "budgets" / "יעד תקציב {category} = {amount}"
// ----------------------------------------------------------------------
// Lists every category's MTD vs last-month-same-period comparison, sorted by
// absolute overage, capped at top 10. Tiers map to the same alert thresholds.
//
// "יעד תקציב X = Y" / "budget X = Y" sets a user-supplied baseline that
// overrides the last-month-total used by the alert logic.
function _handleBudgetCommand_(fromPhone, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };
  var norm = raw.replace(/^\//, '').trim();
  var low = norm.toLowerCase();

  // Set/override budget for a category.
  var setM = norm.match(/^(?:יעד\s+תקציב|budget)\s+([^=]+?)\s*=\s*(\d+(?:\.\d+)?)\s*$/i);
  if (setM) {
    var cat = setM[1].trim();
    var amt = Number(setM[2]);
    if (!cat || !isFinite(amt) || amt <= 0) {
      return { handled: true, replyText: '😬 פורמט שגוי\n💡 השתמש ב-"יעד תקציב <קטגוריה> = <סכום>" — למשל: יעד תקציב אוכל = 1500' };
    }
    var key = 'budget:' + fromPhone + ':' + cat;
    var ok = kvSet(key, amt);
    if (!ok) {
      return { handled: true, replyText: '😬 לא הצלחתי לשמור את היעד\n💡 ננסה שוב בעוד דקה?' };
    }
    return { handled: true, replyText: '✅ הגדרתי תקציב חודשי ל-' + cat + ': ₪' + amt.toLocaleString('he-IL') };
  }

  // List budgets for all categories.
  if (norm === 'תקציבים' || low === 'budgets' || low === 'budget') {
    return { handled: true, replyText: _budgetsListMessage_(fromPhone) };
  }

  return { handled: false };
}

// Build the "תקציבים" report.
function _budgetsListMessage_(fromPhone) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return '😬 לא נמצאה לשונית "תנועות"\n💡 הרץ פעם אחת את setupTransactionsSheet בעורך הסקריפט';
    var data = sheet.getDataRange().getValues();
    if (!data || data.length < 2) return '📊 אין עדיין מספיק נתונים לתקציבים.';

    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var monthStart = new Date(year, month, 1);
    var prevMonthStart = new Date(year, month - 1, 1);
    var prevMonthEnd = new Date(year, month, 0, 23, 59, 59);
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var daysElapsed = Math.min(now.getDate(), daysInMonth);

    var thisByCat = {};
    var lastByCat = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rawDate = row[0];
      if (!rawDate) continue;
      var d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (isNaN(d.getTime())) continue;
      var cat = String(row[3] || '').trim();
      if (!cat) continue;
      if (_anomalyIsIncomeCategory_(cat)) continue;
      var amount = Number(row[2]) || 0;
      if (amount <= 0) continue;

      if (d >= monthStart && d <= now) {
        thisByCat[cat] = (thisByCat[cat] || 0) + amount;
      } else if (d >= prevMonthStart && d <= prevMonthEnd) {
        lastByCat[cat] = (lastByCat[cat] || 0) + amount;
      }
    }

    var entries = [];
    Object.keys(thisByCat).forEach(function(cat) {
      var thisM = thisByCat[cat] || 0;
      var lastM = lastByCat[cat] || 0;
      var userBudget = _getUserBudget_(fromPhone, cat);
      var baseline = userBudget || lastM;
      var overage = baseline > 0 ? (thisM - baseline) : 0;
      entries.push({
        category: cat,
        thisMonth: thisM,
        lastMonth: lastM,
        baseline: baseline,
        overage: overage,
        userBudget: userBudget
      });
    });
    if (entries.length === 0) return '📊 אין הוצאות החודש עדיין.';

    // Sort: categories with baseline come first, ranked by |overage| desc;
    // categories without a baseline drop to bottom, ranked by thisMonth desc.
    entries.sort(function(a, b) {
      if (a.baseline <= 0 && b.baseline <= 0) return b.thisMonth - a.thisMonth;
      if (a.baseline <= 0) return 1;
      if (b.baseline <= 0) return -1;
      return Math.abs(b.overage) - Math.abs(a.overage);
    });
    var top = entries.slice(0, 10);

    var fmt = function(n) { return Math.round(n).toLocaleString('he-IL'); };
    var lines = [];
    lines.push('📊 תקציבים — חודש נוכחי');
    lines.push('━━━━━━━━━━━━━━━━━━');
    for (var k = 0; k < top.length; k++) {
      var e = top[k];
      var icon = '✓';
      var note = '';
      if (e.baseline > 0) {
        var paceRatio = e.thisMonth / e.baseline;
        var expectedFraction = daysElapsed / daysInMonth;
        var baselineLabel = e.userBudget ? 'יעד' : 'חודש קודם';
        if (e.thisMonth > e.baseline) {
          icon = '🔥';
          note = '(מ-₪' + fmt(e.baseline) + ' ' + baselineLabel + ')';
        } else if (e.thisMonth > e.baseline * 0.8 && daysElapsed < daysInMonth * 0.66) {
          icon = '🚨';
          note = '(' + Math.round(paceRatio * 100) + '% מ-₪' + fmt(e.baseline) + ' ' + baselineLabel + ')';
        } else if (expectedFraction > 0 && paceRatio > expectedFraction * 1.2) {
          icon = '⚠️';
          note = '(קצב גבוה — בסיס ₪' + fmt(e.baseline) + ')';
        } else {
          icon = '✓';
          note = '(קצב תקין — בסיס ₪' + fmt(e.baseline) + ')';
        }
      } else {
        note = '(אין בסיס להשוואה)';
      }
      lines.push(icon + ' ' + e.category + ': ₪' + fmt(e.thisMonth) + ' ' + note);
    }
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('💡 להגדרת יעד: "יעד תקציב <קטגוריה> = <סכום>"');
    return lines.join('\n');
  } catch (err) {
    Logger.log('_budgetsListMessage_ err: ' + (err && err.stack || err));
    return '😬 משהו השתבש בבניית רשימת התקציבים: ' + (err && err.message || '') + '\n💡 ננסה שוב בעוד דקה?';
  }
}

// ============================================================
// ☀️ DAILY MOTIVATION CRON — fires once daily at 9:30 Israel time.
// ============================================================
// Setup: call installDailyMotivationTrigger() once from the editor.
// Behavior: rotates through Hebrew motivational categories, picks one,
//   blends in streak + day-of-week awareness, throttles to skip if the
//   user wrote something to the bot in the last 2 hours.
//
// Default: OFF. Trigger only fires after Steven calls the installer.

function cronDailyMotivation() {
  try {
    var to = ALLOWED_PHONE || (PropertiesService.getScriptProperties().getProperty('WEEKLY_SUMMARY_PHONE') || '');
    if (!to) { Logger.log('cronDailyMotivation: no recipient'); return; }

    // Throttle: skip if user sent us a message in the last 2 hours (don't be annoying).
    var props = PropertiesService.getScriptProperties();
    var lastUserMsgIso = props.getProperty('lastUserMessageAt') || '';
    if (lastUserMsgIso) {
      var lastUserMsg = new Date(lastUserMsgIso);
      if (!isNaN(lastUserMsg.getTime()) && (Date.now() - lastUserMsg.getTime()) < 2 * 60 * 60 * 1000) {
        Logger.log('cronDailyMotivation: user active in last 2h, skipping');
        return;
      }
    }

    // Also skip if we already sent a motivation today (defensive against double-trigger).
    var todayKey = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    if (props.getProperty('lastMotivationDate') === todayKey) {
      Logger.log('cronDailyMotivation: already sent today');
      return;
    }

    var msg = _pickDailyMotivation_();
    if (!msg) { Logger.log('cronDailyMotivation: empty message'); return; }

    sendWhatsAppMessage(to, msg);
    props.setProperty('lastMotivationDate', todayKey);
    Logger.log('cronDailyMotivation: sent');
  } catch (e) {
    Logger.log('cronDailyMotivation error: ' + (e && e.stack || e));
  }
}

// Motivational message pools — short, warm, max 2 emojis each.
// Tone: 2nd person singular, mostly gender-neutral, no toxic-positivity.
var KFL_MOTIVATION_HABIT = [
  'כל הוצאה שאתה רושם — זה צעד אחד יותר אל שליטה. תמשיך 💪',
  'אנשים שמסתכלים על הכסף שלהם אחת ליום, מרוויחים בממוצע 18% יותר. זה לא קסם, זה תשומת לב.',
  'ההרגל לא בנוי על מוטיבציה — הוא בנוי על חזרה. אתה עושה את החזרה.',
  'שתי דקות ביום. זה כל מה שצריך כדי לא להתעורר בעוד שנה ולשאול "לאן הלך הכסף?"',
  'הכל מתחיל מהמספר הראשון שאתה רושם היום. רק תכתוב משהו 🌱',
  'אתה לא צריך להיות מושלם — אתה צריך להיות עקבי. וזה אתה בדיוק עושה.'
];

var KFL_MOTIVATION_INSIGHT = [
  '💡 המשתמש הממוצע מגלה אחרי חודש ש-30% מההוצאות שלו הוא בכלל לא זוכר.',
  '💡 70% מהאנשים בודקים את חשבון הבנק רק כשהם בלחץ. אתה בודק לפני — זה השינוי.',
  '💡 מחקרים: לרשום הוצאה מפחית את הסיכוי לחזור על אותה הוצאה שוב באותו חודש ב-23%.',
  '💡 אנשים שכותבים את ההוצאות שלהם חוסכים בממוצע ₪1,200 בחודש בלי לעשות "דיאטה".',
  '💡 הרבה ממה שאנחנו קונים זה לא רצון — זה הרגל. השאלה היא רק איזה הרגל אנחנו רואים.',
  '💡 כשרואים את המספרים בעין, הם מאבדים את הכוח שלהם להפתיע אותך בסוף החודש.'
];

var KFL_MOTIVATION_FUTURE = [
  'בעוד שנה תודה לעצמך שעקבת. החודש הראשון הוא תמיד הקשה ביותר 🌅',
  'דמיין את עצמך בעוד 6 חודשים, יודע בדיוק לאן הלך כל שקל. זה נעים.',
  'הכסף שאתה חוסך עכשיו זה החופש שלך מחר. כל רישום הוא צעד.',
  'בעוד שנה — אם תמשיך — יהיה לך תמונה מלאה, ולא תצטרך לנחש על כלום.',
  'הסטטיסטיקה אומרת: מי שעוקב 90 ימים ברצף — ממשיך לכל החיים. אתה בדרך לשם.',
  'בכל פעם שאתה כותב הוצאה, אתה בעצם מדבר עם עצמך-בעתיד. הוא מאזין.'
];

var KFL_MOTIVATION_PERMISSION = [
  '👋 לא חייב לעקוב היום, אבל אם בא לך — אני כאן.',
  'יום קל היום? לפעמים גם זה חלק מהמסע 💛',
  'אין לחץ — רק תזכורת ידידותית. תכתוב משהו רק אם בא לך.',
  'אם היום הוצאת רק קפה — גם זה שווה לרשום. הכל נספר.',
  'הבוט הזה הוא לא מנהל החשבונות שלך. הוא חבר שאוהב מספרים 🤝'
];

// Picks a single motivational message based on day-of-week, streak, and random.
function _pickDailyMotivation_(fromPhone) {
  var now = new Date();
  var dow = Number(Utilities.formatDate(now, 'Asia/Jerusalem', 'u')); // 1=Mon..7=Sun
  // Sunday in Israel = first day of work week. JS getDay(): 0=Sun. We use Asia/Jerusalem-aware DOW.
  var jsDay = now.getDay(); // 0=Sun..6=Sat
  var streak = _getStreakCount_(fromPhone);

  // Streak-aware variant takes priority on milestone-adjacent days
  if (streak >= 3) {
    var streakLines = [
      streak + ' ימים ברצף 🔥 — אתה בקבוצה של ה-1% שעוקבים באמת.',
      '🔥 ' + streak + ' ימים ברצף. רוב האנשים נושרים בשבוע הראשון. לא אתה.',
      streak + ' ימים. תזכור: אתה לא מתחיל מהתחלה אם תמשיך עוד אחד היום.',
      'יום ' + streak + ' של מעקב. אתה ההוכחה שזה אפשרי.'
    ];
    // Use streak variant 50% of the time when on a streak
    if (Math.random() < 0.5) {
      return streakLines[Math.floor(Math.random() * streakLines.length)];
    }
  }

  // Day-of-week themed
  if (jsDay === 0) { // Sunday — work week start in IL
    var sundayLines = [
      '☕ שבוע חדש, התחלה נקייה. אם תרשום הוצאה אחת היום — אתה בכיוון.',
      '🌅 יום ראשון — היום הכי קל להתחיל הרגל. שתי דקות, וזהו.',
      'בוקר טוב. שבוע חדש, דף חדש. בוא נראה לאן הוא הולך 📊'
    ];
    return sundayLines[Math.floor(Math.random() * sundayLines.length)];
  }
  if (jsDay === 5) { // Friday — pre-weekend
    var fridayLines = [
      '🌇 סוף שבוע מתקרב — חלק מההוצאות יבואו עוד מעט. תשתדל לזכור לרשום אותן בזמן אמת.',
      '🛒 יום שישי. סופר, בנזין, בית קפה. אם תרשום תוך כדי — לא תצטרך לנחש במוצ"ש.',
      'נשמה של סוף שבוע. אל תזרוק את כל המעקב — דקה אחת ביום זה הכל.'
    ];
    return fridayLines[Math.floor(Math.random() * fridayLines.length)];
  }
  if (jsDay === 6) { // Saturday — Shabbat, soft tone
    var saturdayLines = [
      '🕊️ שבת שלום. אם רשמת משהו השבוע — זה אומר משהו עליך.',
      'יום מנוחה. הבוט גם נח. נתראה במוצ"ש 💛',
      'שבת שלום. תהנה — והכסף יהיה כאן בעוד יום.'
    ];
    return saturdayLines[Math.floor(Math.random() * saturdayLines.length)];
  }

  // Rotate through pools by hash of date so the user doesn't get the same category twice in a row
  var pools = [KFL_MOTIVATION_HABIT, KFL_MOTIVATION_INSIGHT, KFL_MOTIVATION_FUTURE, KFL_MOTIVATION_PERMISSION];
  var seed = Number(Utilities.formatDate(now, 'Asia/Jerusalem', 'D')); // day-of-year
  var pool = pools[seed % pools.length];
  return pool[Math.floor(Math.random() * pool.length)];
}

function installDailyMotivationTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronDailyMotivation') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 9:30am Israel — atHour(9) + nearMinute isn't a thing in Apps Script,
  // so we use atHour(9) which fires sometime in the 9:00-10:00 window.
  // Good enough — feels like a morning message either way.
  ScriptApp.newTrigger('cronDailyMotivation')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .inTimezone('Asia/Jerusalem')
    .create();
  Logger.log('✅ Daily motivation trigger installed (every day, 9-10am Asia/Jerusalem)');
}

// ============================================================
// 🎯 SMART "WHAT IF?" PROJECTION CRON — Fridays at 5pm.
// ============================================================
// Looks at top 1-2 spending categories this month, computes 10-15% cut → annual
// savings, sends a personalized actionable nudge before the weekend spending hits.
//
// Default: OFF. Run installWeeklySavingsProjectionTrigger() once to enable.

function cronWeeklySavingsProjection() {
  try {
    var to = ALLOWED_PHONE || (PropertiesService.getScriptProperties().getProperty('WEEKLY_SUMMARY_PHONE') || '');
    if (!to) { Logger.log('cronWeeklySavingsProjection: no recipient'); return; }

    var msg = _buildSavingsProjectionMessage_();
    if (!msg) { Logger.log('cronWeeklySavingsProjection: nothing to project'); return; }

    sendWhatsAppMessage(to, msg);
    Logger.log('cronWeeklySavingsProjection: sent');
  } catch (e) {
    Logger.log('cronWeeklySavingsProjection error: ' + (e && e.stack || e));
  }
}

// Returns Hebrew "if you cut X by N%, you save ₪Y/year" message, or empty
// string if the user doesn't have enough data yet (<2 weeks of transactions
// or top category < ₪400 this month).
function _buildSavingsProjectionMessage_() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return '';
  var data = sheet.getDataRange().getValues();
  if (data.length < 5) return ''; // not enough history

  var now = new Date();
  var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var dayOfMonth = now.getDate();
  if (dayOfMonth < 7) return ''; // too early in the month — skip this Friday

  var byCategory = {};
  for (var i = 1; i < data.length; i++) {
    var d = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
    if (isNaN(d.getTime()) || d < monthStart) continue;
    var category = String(data[i][3] || '');
    if (/הכנסות|הכנסה/i.test(category)) continue;
    // Skip non-discretionary categories where "cut 10%" is unrealistic advice
    if (/משכנתא|שכירות|ארנונה|מים|חשמל|ביטוח/.test(category)) continue;
    var amt = Number(data[i][2]) || 0;
    byCategory[category] = (byCategory[category] || 0) + amt;
  }
  var cats = Object.keys(byCategory).map(function(k) { return { name: k, amount: byCategory[k] }; });
  cats.sort(function(a, b) { return b.amount - a.amount; });
  if (!cats.length || cats[0].amount < 400) return '';

  var top = cats[0];
  // Cut percent scales with size — larger spend → suggest larger cut
  var cutPct = top.amount > 2000 ? 15 : (top.amount > 1000 ? 12 : 10);
  // Project the rest of the month proportionally so the annualization isn't biased
  // by partial-month spending early in the month.
  var monthProgress = dayOfMonth / 30;
  var projectedMonthly = top.amount / Math.max(0.2, monthProgress);
  var annualSavings = Math.round((projectedMonthly * (cutPct / 100)) * 12 / 10) * 10; // round to nearest 10

  var lines = [];
  lines.push('🎯 *תרגיל קטן לסוף שבוע*');
  lines.push('━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push('ראיתי שהוצאת ₪' + Math.round(top.amount).toLocaleString('he-IL') + ' על *' + top.name + '* החודש (עד עכשיו).');
  lines.push('');
  lines.push('💭 אם תקצץ ' + cutPct + '% בלבד —');
  lines.push('   חוסך ₪' + annualSavings.toLocaleString('he-IL') + ' בשנה.');
  lines.push('');

  // Add a runner-up if there is one with meaningful spend
  if (cats.length >= 2 && cats[1].amount >= 300) {
    var secondCutPct = cats[1].amount > 1500 ? 12 : 10;
    var secondAnnual = Math.round((cats[1].amount / Math.max(0.2, monthProgress)) * (secondCutPct / 100) * 12 / 10) * 10;
    lines.push('או — *' + cats[1].name + '* (₪' + Math.round(cats[1].amount).toLocaleString('he-IL') + '): קיצוץ של ' + secondCutPct + '% = ₪' + secondAnnual.toLocaleString('he-IL') + ' בשנה.');
    lines.push('');
  }
  lines.push('שווה לחשוב על זה לפני סוף השבוע 💛');
  return lines.join('\n');
}

function installWeeklySavingsProjectionTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronWeeklySavingsProjection') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cronWeeklySavingsProjection')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(17)
    .inTimezone('Asia/Jerusalem')
    .create();
  Logger.log('✅ Weekly savings projection trigger installed (Fridays 5pm Asia/Jerusalem)');
}

// ============================================================
// 🎁 ONE-LINER INSTALLERS — make Steven's life easy.
// ============================================================
// Run installAllMotivationTriggers() once from the editor to enable both
// the daily motivation and weekly savings projection at once.
function installAllMotivationTriggers() {
  installDailyMotivationTrigger();
  installWeeklySavingsProjectionTrigger();
  Logger.log('✅ All motivation triggers installed.');
}

// Uninstaller — kills all motivation/projection triggers but leaves the
// existing weekly summary + inactivity nudge alone.
function uninstallMotivationTriggers() {
  var killed = 0;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'cronDailyMotivation' || fn === 'cronWeeklySavingsProjection') {
      ScriptApp.deleteTrigger(triggers[i]);
      killed++;
    }
  }
  Logger.log('🗑️ Motivation triggers removed: ' + killed);
}

// Test helpers — run from the editor to preview messages without sending.
function _testDailyMotivation_() {
  Logger.log('--- streak: ' + _getStreakCount_());
  for (var i = 0; i < 6; i++) {
    Logger.log('--- pick ' + i + ' ---\n' + _pickDailyMotivation_());
  }
}
function _testSavingsProjection_() {
  var msg = _buildSavingsProjectionMessage_();
  Logger.log(msg || '(no projection available — not enough data)');
}

// ============================================================
// 🔮 ANOMALY DETECTION — Mercury/Brex-style "we noticed something" alerts.
// ============================================================
//
// Two surfaces:
//   1. detectAnomalies(amount, category, description) — synchronous, called
//      inline from processExpense after every successful write. Returns ONE
//      anomaly object (the most surprising one) or null.
//   2. cronMonthlyAnomalyDigest() — runs 1st of month, 11am Israel. Surfaces
//      the 3 most interesting anomalies from the prior month + 1 positive note.
//
// All thresholds are configurable via Script Properties. Inline alerts can be
// disabled entirely with ANOMALY_ALERTS_DISABLED=1 (default ON).
//
// Performance: a single sheet read (getDataRange) feeds all five checks. With
// thousands of rows this runs in <1s because we only walk the array once and
// keep all aggregates in memory.

// --- Tunable thresholds (Script Properties override defaults) ----------------
var _ANOMALY_DEFAULTS = {
  ANOMALY_X_AVG_THRESHOLD: 3,         // amount > 3x category avg
  ANOMALY_VENDOR_X_AVG: 2,            // amount > 2x vendor avg
  ANOMALY_MTD_GROWTH_PCT: 50,         // category MTD vs same period last month
  ANOMALY_NEW_VENDOR_AMOUNT: 500,     // first-ever vendor charged > X
  ANOMALY_BURST_COUNT: 5,             // N+ expenses logged today
  ANOMALY_MIN_HISTORY: 3,             // need >= N prior datapoints to compare
  ANOMALY_MIN_AMOUNT: 50              // skip alerts on tiny expenses
};

function _anomalyProp_(key) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  } catch (e) {}
  return _ANOMALY_DEFAULTS[key];
}

function _anomalyAlertsDisabled_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('ANOMALY_ALERTS_DISABLED');
    return v === '1' || v === 'true';
  } catch (e) { return false; }
}

// --- Helpers -----------------------------------------------------------------

// Normalize a free-form description into a "vendor key" so "סופר רמי לוי 5"
// and "רמי לוי" collapse to the same vendor. Lowercases, strips digits and
// common noise words, takes the first 2 meaningful tokens.
function _anomalyVendorKey_(description) {
  if (!description) return '';
  var s = String(description).toLowerCase();
  s = s.replace(/[0-9₪$€£.,]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // strip very common stopwords that don't identify a vendor
  var stop = { 'של': 1, 'את': 1, 'ב': 1, 'ל': 1, 'ה': 1, 'in': 1, 'at': 1, 'the': 1 };
  var toks = s.split(' ').filter(function(t) { return t.length > 1 && !stop[t]; });
  return toks.slice(0, 2).join(' ');
}

function _anomalyIsIncomeCategory_(category) {
  return /הכנסות|הכנסה/i.test(String(category || ''));
}

// Single pass over transaction rows. Returns a precomputed bundle used by
// detectAnomalies and the monthly digest alike. data is the raw 2D array
// from sheet.getDataRange().getValues() (header row included).
function _anomalyBuildIndex_(data, asOfDate) {
  var now = asOfDate || new Date();
  var todayKey = Utilities.formatDate(now, 'Asia/Jerusalem', 'yyyy-MM-dd');
  var currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  var prevMonthSamePeriodEnd = new Date(
    prevMonthStart.getFullYear(),
    prevMonthStart.getMonth(),
    now.getDate(),
    23, 59, 59
  );

  var idx = {
    now: now,
    todayKey: todayKey,
    currentMonthStart: currentMonthStart,
    prevMonthStart: prevMonthStart,
    prevMonthEnd: prevMonthEnd,
    prevMonthSamePeriodEnd: prevMonthSamePeriodEnd,
    // category-level aggregates (excluding today, for fair comparison)
    catSum: {},       // historical sum per category
    catCount: {},     // historical count per category
    // vendor-level aggregates
    vendorSum: {},
    vendorCount: {},
    vendorLastSeen: {},     // Date of last transaction for vendor (any)
    vendorFirstSeen: {},    // Date of first transaction for vendor
    // MTD and previous month same-period sums
    mtdByCat: {},
    prevMtdByCat: {},
    // count of transactions logged today
    todayCount: 0,
    // for monthly digest
    prevMonthRows: [],
    prevPrevMonthByCat: {}   // for month-over-month savings comparison
  };

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rd = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(rd.getTime())) continue;
    var amount = Number(row[2]) || 0;
    var category = String(row[3] || '');
    var description = String(row[5] || '');
    if (_anomalyIsIncomeCategory_(category)) continue;       // skip income
    if (amount <= 0) continue;

    var vendorKey = _anomalyVendorKey_(description);
    var rowDayKey = Utilities.formatDate(rd, 'Asia/Jerusalem', 'yyyy-MM-dd');
    var isToday = (rowDayKey === todayKey);

    // Historical category aggregates exclude today so today's write doesn't
    // skew its own comparison.
    if (!isToday) {
      idx.catSum[category] = (idx.catSum[category] || 0) + amount;
      idx.catCount[category] = (idx.catCount[category] || 0) + 1;
      if (vendorKey) {
        idx.vendorSum[vendorKey] = (idx.vendorSum[vendorKey] || 0) + amount;
        idx.vendorCount[vendorKey] = (idx.vendorCount[vendorKey] || 0) + 1;
        if (!idx.vendorFirstSeen[vendorKey] || rd < idx.vendorFirstSeen[vendorKey]) {
          idx.vendorFirstSeen[vendorKey] = rd;
        }
        if (!idx.vendorLastSeen[vendorKey] || rd > idx.vendorLastSeen[vendorKey]) {
          idx.vendorLastSeen[vendorKey] = rd;
        }
      }
    } else {
      idx.todayCount++;
    }

    // MTD bucket — current calendar month, up to and including today
    if (rd >= currentMonthStart && rd <= now) {
      idx.mtdByCat[category] = (idx.mtdByCat[category] || 0) + amount;
    }
    // Previous-month same-period bucket — month-1 from day 1 to (today's day)
    if (rd >= prevMonthStart && rd <= prevMonthSamePeriodEnd) {
      idx.prevMtdByCat[category] = (idx.prevMtdByCat[category] || 0) + amount;
    }
    // Full previous month (for the digest)
    if (rd >= prevMonthStart && rd <= prevMonthEnd) {
      idx.prevMonthRows.push({
        date: rd, amount: amount, category: category,
        description: description, vendorKey: vendorKey
      });
    }
    // Month before previous month — used for savings comparison in digest
    var prevPrevStart = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth() - 1, 1);
    var prevPrevEnd = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), 0, 23, 59, 59);
    if (rd >= prevPrevStart && rd <= prevPrevEnd) {
      idx.prevPrevMonthByCat[category] = (idx.prevPrevMonthByCat[category] || 0) + amount;
    }
  }
  return idx;
}

// --- Public API: detectAnomalies --------------------------------------------
//
// Returns the SINGLE most surprising anomaly object, or null. Shape:
//   { type, severity, message, ratio, context: {...} }
// severity is 1..5; we pick the highest-severity hit.
function detectAnomalies(newAmount, newCategory, newDescription) {
  var minAmount = _anomalyProp_('ANOMALY_MIN_AMOUNT');
  if (!newAmount || newAmount < minAmount) return null;
  if (_anomalyIsIncomeCategory_(newCategory)) return null;

  var sheet;
  try {
    sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  } catch (e) { return null; }
  if (!sheet) return null;
  var data;
  try { data = sheet.getDataRange().getValues(); } catch (e) { return null; }
  if (!data || data.length < 2) return null;

  var minHistory = _anomalyProp_('ANOMALY_MIN_HISTORY');
  var idx = _anomalyBuildIndex_(data);

  var vendorKey = _anomalyVendorKey_(newDescription || '');
  var candidates = [];

  // ----- 1. Amount > Nx category average ------------------------------------
  var xAvg = _anomalyProp_('ANOMALY_X_AVG_THRESHOLD');
  if (idx.catCount[newCategory] >= minHistory) {
    var catAvg = idx.catSum[newCategory] / idx.catCount[newCategory];
    if (catAvg > 0 && newAmount >= catAvg * xAvg) {
      var ratio = newAmount / catAvg;
      candidates.push({
        type: 'CATEGORY_X_AVG',
        severity: ratio >= xAvg * 1.5 ? 5 : 4,
        ratio: ratio,
        message: '⚠️ זה גבוה פי ' + ratio.toFixed(1) + ' מהממוצע שלך בקטגוריה ' + newCategory,
        context: { category: newCategory, avg: Math.round(catAvg), amount: newAmount }
      });
    }
  }

  // ----- 2. Amount > Nx vendor average --------------------------------------
  var vendorXAvg = _anomalyProp_('ANOMALY_VENDOR_X_AVG');
  if (vendorKey && idx.vendorCount[vendorKey] >= minHistory) {
    var vAvg = idx.vendorSum[vendorKey] / idx.vendorCount[vendorKey];
    if (vAvg > 0 && newAmount >= vAvg * vendorXAvg) {
      var vRatio = newAmount / vAvg;
      candidates.push({
        type: 'VENDOR_X_AVG',
        severity: vRatio >= vendorXAvg * 1.5 ? 5 : 3,
        ratio: vRatio,
        message: '👀 ₪' + newAmount.toLocaleString('he-IL') + ' אצל ' + vendorKey + ' זה פי ' + vRatio.toFixed(1) + ' מהממוצע שלך שם',
        context: { vendor: vendorKey, avg: Math.round(vAvg), amount: newAmount }
      });
    }
  }

  // ----- 3. Category MTD grew >X% vs same period last month -----------------
  var mtdGrowth = _anomalyProp_('ANOMALY_MTD_GROWTH_PCT');
  var mtdNow = idx.mtdByCat[newCategory] || 0;
  var mtdPrev = idx.prevMtdByCat[newCategory] || 0;
  if (mtdPrev > 100 && mtdNow > mtdPrev * (1 + mtdGrowth / 100)) {
    var pct = Math.round(((mtdNow - mtdPrev) / mtdPrev) * 100);
    candidates.push({
      type: 'MTD_GROWTH',
      severity: pct >= 100 ? 5 : 3,
      ratio: pct / 100,
      message: '📈 בקטגוריה ' + newCategory + ' הוצאת ' + pct + '% יותר החודש לעומת אותה תקופה בחודש שעבר',
      context: { category: newCategory, mtdNow: Math.round(mtdNow), mtdPrev: Math.round(mtdPrev), pct: pct }
    });
  }

  // ----- 4. New vendor > threshold (never seen before) ----------------------
  var newVendorAmount = _anomalyProp_('ANOMALY_NEW_VENDOR_AMOUNT');
  if (vendorKey && !idx.vendorLastSeen[vendorKey] && newAmount >= newVendorAmount) {
    candidates.push({
      type: 'NEW_VENDOR',
      severity: 4,
      ratio: newAmount / newVendorAmount,
      message: '🆕 פעם ראשונה אצל ' + vendorKey + ' — ₪' + newAmount.toLocaleString('he-IL') + '. נשמר.',
      context: { vendor: vendorKey, amount: newAmount }
    });
  } else if (vendorKey && idx.vendorLastSeen[vendorKey] && newAmount >= newVendorAmount) {
    // Same idea but for returning vendors after a long gap (>120 days)
    var daysSince = Math.floor((idx.now - idx.vendorLastSeen[vendorKey]) / 86400000);
    if (daysSince >= 120) {
      var months = Math.round(daysSince / 30);
      candidates.push({
        type: 'RETURNING_VENDOR',
        severity: 2,
        ratio: 1,
        message: '👋 ₪' + newAmount.toLocaleString('he-IL') + ' אצל ' + vendorKey + ' — לא היית שם ' + months + ' חודשים. חזרה לעניינים?',
        context: { vendor: vendorKey, monthsAway: months }
      });
    }
  }

  // ----- 5. Burst — N+ expenses today ---------------------------------------
  var burst = _anomalyProp_('ANOMALY_BURST_COUNT');
  // +1 to include this just-written expense (idx is built before it was committed,
  // so we don't double-count; however since this runs AFTER appendRow the row IS
  // in the sheet, and we already counted it in todayCount).
  if (idx.todayCount >= burst) {
    candidates.push({
      type: 'DAILY_BURST',
      severity: idx.todayCount >= burst * 2 ? 4 : 2,
      ratio: idx.todayCount / burst,
      message: '🔥 ' + idx.todayCount + ' הוצאות היום! יום אקטיבי במיוחד',
      context: { count: idx.todayCount }
    });
  }

  if (!candidates.length) return null;
  // Most surprising = highest severity, tiebreak by ratio.
  candidates.sort(function(a, b) {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return (b.ratio || 0) - (a.ratio || 0);
  });
  return candidates[0];
}

// --- Public API: monthly digest ---------------------------------------------
function cronMonthlyAnomalyDigest() {
  try {
    var msg = _buildMonthlyAnomalyDigest_();
    if (!msg) {
      Logger.log('cronMonthlyAnomalyDigest: nothing to send');
      return;
    }
    // Send to the linked WhatsApp user(s). Reuse the inactivity-cron pattern
    // and pull the bound phone from Script Properties if present.
    var to = '';
    try { to = PropertiesService.getScriptProperties().getProperty('DIGEST_PHONE') || ''; } catch (e) {}
    if (!to) {
      // Fall back to logging the digest; user can wire DIGEST_PHONE later.
      Logger.log(msg);
      return;
    }
    sendWhatsAppMessage(to, msg);
  } catch (err) {
    Logger.log('cronMonthlyAnomalyDigest err: ' + (err && err.message));
  }
}

function _buildMonthlyAnomalyDigest_() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;

  // Build the index as of the START of the current month — so prevMonthRows is
  // last full calendar month relative to "now".
  var idx = _anomalyBuildIndex_(data);
  if (!idx.prevMonthRows.length) return null;

  var monthLabel = Utilities.formatDate(idx.prevMonthStart, 'Asia/Jerusalem', 'MMMM yyyy');

  // Per-row scoring: compare each prior-month row vs that category's
  // long-term historical average (computed from rows BEFORE the prev-month).
  // Re-use catSum/catCount but those already exclude only "today"; we need to
  // re-aggregate while excluding the previous month for a fair baseline.
  var baselineSum = {}, baselineCount = {};
  var vendorBaseSum = {}, vendorBaseCount = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rd = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (isNaN(rd.getTime())) continue;
    if (rd >= idx.prevMonthStart && rd <= idx.prevMonthEnd) continue;
    if (rd > idx.prevMonthEnd) continue; // ignore current month
    var amt = Number(row[2]) || 0;
    var cat = String(row[3] || '');
    if (_anomalyIsIncomeCategory_(cat)) continue;
    if (amt <= 0) continue;
    var vk = _anomalyVendorKey_(String(row[5] || ''));
    baselineSum[cat] = (baselineSum[cat] || 0) + amt;
    baselineCount[cat] = (baselineCount[cat] || 0) + 1;
    if (vk) {
      vendorBaseSum[vk] = (vendorBaseSum[vk] || 0) + amt;
      vendorBaseCount[vk] = (vendorBaseCount[vk] || 0) + 1;
    }
  }

  // Score every prev-month row; collect top anomalies.
  var scored = [];
  // Also accumulate vendor counts within prev-month for the "4 expenses at X" pattern.
  var prevVendorCount = {}, prevVendorSum = {};
  idx.prevMonthRows.forEach(function(r) {
    if (r.vendorKey) {
      prevVendorCount[r.vendorKey] = (prevVendorCount[r.vendorKey] || 0) + 1;
      prevVendorSum[r.vendorKey] = (prevVendorSum[r.vendorKey] || 0) + r.amount;
    }
    var catAvg = (baselineCount[r.category] >= 3)
      ? baselineSum[r.category] / baselineCount[r.category] : 0;
    if (catAvg > 0 && r.amount >= catAvg * 2) {
      scored.push({
        ratio: r.amount / catAvg,
        text: 'PLACEHOLDER_CAT', // overwritten below
        type: 'CAT', row: r, catAvg: catAvg
      });
    }
    if (r.vendorKey && vendorBaseCount[r.vendorKey] >= 3) {
      var vavg = vendorBaseSum[r.vendorKey] / vendorBaseCount[r.vendorKey];
      if (vavg > 0 && r.amount >= vavg * 2) {
        scored.push({
          ratio: r.amount / vavg,
          type: 'VENDOR', row: r, vendorAvg: vavg
        });
      }
    }
  });
  // Add "frequent vendor in month" anomalies
  Object.keys(prevVendorCount).forEach(function(vk) {
    var cnt = prevVendorCount[vk];
    var baseCnt = vendorBaseCount[vk] || 0;
    // If vendor was visited 4+ times in this month AND that's >= 3x typical month
    // (approximate typical-month visits by averaging baseline over months we have)
    if (cnt >= 4) {
      scored.push({
        ratio: cnt,
        type: 'FREQ_VENDOR',
        vendorKey: vk,
        count: cnt,
        sum: prevVendorSum[vk]
      });
    }
  });

  scored.sort(function(a, b) { return (b.ratio || 0) - (a.ratio || 0); });
  // Dedupe so we don't double-list the same (vendor, date) twice.
  var seenKey = {};
  var top = [];
  for (var s = 0; s < scored.length && top.length < 3; s++) {
    var sc = scored[s];
    var k = sc.type + '|' + (sc.row ? (sc.row.vendorKey + sc.row.date.getTime()) : sc.vendorKey);
    if (seenKey[k]) continue;
    seenKey[k] = 1;
    top.push(sc);
  }

  // Format anomaly lines
  var lines = [];
  lines.push('🔮 סקירה חודשית — ' + monthLabel);
  lines.push('');
  if (top.length) {
    lines.push('🚨 הוצאות חריגות שזיהינו:');
    top.forEach(function(sc, n) {
      if (sc.type === 'CAT') {
        lines.push((n + 1) + '. ₪' + Math.round(sc.row.amount).toLocaleString('he-IL') + ' ב' + sc.row.vendorKey + ' (פי ' + sc.ratio.toFixed(1) + ' מהממוצע שלך בקטגוריה ' + sc.row.category + ')');
      } else if (sc.type === 'VENDOR') {
        lines.push((n + 1) + '. ₪' + Math.round(sc.row.amount).toLocaleString('he-IL') + ' ב' + sc.row.vendorKey + ' (פי ' + sc.ratio.toFixed(1) + ' מהממוצע אצלם)');
      } else if (sc.type === 'FREQ_VENDOR') {
        lines.push((n + 1) + '. ' + sc.count + ' הוצאות אצל ' + sc.vendorKey + ' (סה"כ ₪' + Math.round(sc.sum).toLocaleString('he-IL') + ')');
      }
    });
    lines.push('');
  } else {
    lines.push('✅ לא זיהינו הוצאות חריגות החודש — נקי!');
    lines.push('');
  }

  // ----- positive note ------------------------------------------------------
  // Biggest savings vs prior month, per category. Pick the largest absolute drop.
  var bestSave = null;
  var prevByCat = {};
  idx.prevMonthRows.forEach(function(r) {
    prevByCat[r.category] = (prevByCat[r.category] || 0) + r.amount;
  });
  Object.keys(prevByCat).forEach(function(cat) {
    var nowAmt = prevByCat[cat];
    var prevAmt = idx.prevPrevMonthByCat[cat] || 0;
    if (prevAmt > 100 && nowAmt < prevAmt) {
      var saved = prevAmt - nowAmt;
      if (!bestSave || saved > bestSave.saved) {
        bestSave = { category: cat, saved: saved, prev: prevAmt, now: nowAmt };
      }
    }
  });
  var prevPrevLabel = Utilities.formatDate(
    new Date(idx.prevMonthStart.getFullYear(), idx.prevMonthStart.getMonth() - 1, 1),
    'Asia/Jerusalem', 'MMMM'
  );
  lines.push('✨ הניצחון של החודש:');
  if (bestSave) {
    lines.push('חסכת ₪' + Math.round(bestSave.saved).toLocaleString('he-IL') + ' על ' + bestSave.category + ' לעומת ' + prevPrevLabel + ' 👏');
  } else {
    // fallback positive note — streak length
    var streak = 0;
    try { streak = _getStreakCount_() || 0; } catch (e) {}
    if (streak >= 3) {
      lines.push('הצלחת לרשום הוצאות ' + streak + ' ימים ברצף — מעקב עקבי! 👏');
    } else {
      lines.push('המשך לעקוב — כל רישום בונה הרגל. 👏');
    }
  }
  lines.push('');
  lines.push('(שלח "תובנות" לדשבורד המלא)');

  return lines.join('\n');
}

// --- On-demand "חריגות" command --------------------------------------------
function getAnomaliesReportMessage() {
  var msg = _buildMonthlyAnomalyDigest_();
  return msg || '🔮 עדיין אין מספיק נתונים לסקירת חריגות. המשך לרשום הוצאות ונחזור עם תובנות.';
}

// --- Installer --------------------------------------------------------------
function installAnomalyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronMonthlyAnomalyDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cronMonthlyAnomalyDigest')
    .timeBased()
    .onMonthDay(1)
    .atHour(11)
    .inTimezone('Asia/Jerusalem')
    .create();
  Logger.log('✅ Monthly anomaly digest trigger installed (1st of month, 11:00 Asia/Jerusalem)');
}

function uninstallAnomalyTrigger() {
  var killed = 0;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronMonthlyAnomalyDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
      killed++;
    }
  }
  Logger.log('🗑️ Anomaly digest triggers removed: ' + killed);
}

// --- Tests ------------------------------------------------------------------
function _testAnomalyDetection_() {
  // Probe with a hypothetical large supermarket purchase.
  var res = detectAnomalies(2500, 'אוכל', 'סופר רמי לוי');
  Logger.log('anomaly probe (2500/food/rami levy): ' + JSON.stringify(res));
  Logger.log('---');
  Logger.log(getAnomaliesReportMessage());
}

// ============================================================
// 🎯 INSTALL_KESEFLE_BOT — one-click setup + diagnostics
// ============================================================
// Run this ONCE from the Apps Script editor after pasting the code.
// It verifies all required Script Properties, installs all cron triggers,
// sends a test WhatsApp message, and logs a full status report.
//
// To run: open the Apps Script editor → select "installKesefleBot" from
// the function dropdown at the top → click ▶ Run → review the execution log.
function installKesefleBot() {
  var report = ['🔧 KESEFLE BOT SETUP REPORT', '═══════════════════════════════════════', ''];
  var ok = 0, warn = 0, err = 0;
  var props = PropertiesService.getScriptProperties();

  // 1. Required: WHATSAPP_TOKEN
  var token = props.getProperty('WHATSAPP_TOKEN');
  if (!token || token.length < 20) {
    report.push('❌ WHATSAPP_TOKEN — missing or invalid');
    report.push('   FIX: Apps Script → ⚙️ Project Settings → Script Properties → add WHATSAPP_TOKEN');
    report.push('   Get the token from: https://developers.facebook.com/apps → WhatsApp → API Setup → Generate token');
    err++;
  } else {
    report.push('✅ WHATSAPP_TOKEN — set (' + token.length + ' chars)');
    ok++;
  }

  // 2. Required: WHATSAPP_PHONE_NUMBER_ID
  var pnid = props.getProperty('WHATSAPP_PHONE_NUMBER_ID');
  if (!pnid) {
    report.push('⚠️  WHATSAPP_PHONE_NUMBER_ID — not set, using default: ' + WHATSAPP_PHONE_NUMBER_ID);
    report.push('   This is OK if the default matches your Meta API Setup page. Otherwise add it to Script Properties.');
    warn++;
  } else {
    report.push('✅ WHATSAPP_PHONE_NUMBER_ID — ' + pnid);
    ok++;
  }

  // 3. Required: SHEET_ID accessible
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    report.push('✅ SHEET_ID — accessible: "' + ss.getName() + '"');
    ok++;
    var tx = ss.getSheetByName(TRANSACTIONS_SHEET);
    if (tx) {
      report.push('✅ Sheet "תנועות" — exists with ' + (tx.getLastRow() - 1) + ' rows');
      ok++;
    } else {
      report.push('⚠️  Sheet "תנועות" — missing. Run setupTransactionsSheet() once.');
      warn++;
    }
  } catch (e) {
    report.push('❌ SHEET_ID — cannot open: ' + e.message);
    report.push('   FIX: verify SHEET_ID in line 21 of this script matches your Sheet URL');
    err++;
  }

  // 4. Optional: ANTHROPIC_API_KEY (AI fallback)
  var ai = props.getProperty('ANTHROPIC_API_KEY');
  if (!ai) {
    report.push('⚠️  ANTHROPIC_API_KEY — not set (AI fallback disabled, bot still works with 18,725 keywords)');
    warn++;
  } else {
    report.push('✅ ANTHROPIC_API_KEY — set (AI fallback enabled)');
    ok++;
  }

  // 5. Optional: KESEFLE_BOT_SECRET (for multi-tenant linking)
  var ks = props.getProperty('KESEFLE_BOT_SECRET');
  if (!ks) {
    report.push('⚠️  KESEFLE_BOT_SECRET — not set (multi-tenant phone linking disabled)');
    warn++;
  } else {
    report.push('✅ KESEFLE_BOT_SECRET — set');
    ok++;
  }

  // 5c. 🔴 CRITICAL for multi-tenant isolation: SHEET_OWNER_PHONE.
  // This is the anchor that decides who may write to YOUR hardcoded SHEET_ID.
  // If unset, the bot falls back to the hardcoded OWNER_PHONE constant — which
  // still isolates correctly, but ONLY if that constant really is your number.
  var ownerPhoneProp = String(props.getProperty('SHEET_OWNER_PHONE') || '').replace(/[^0-9]/g, '');
  if (!ownerPhoneProp) {
    report.push('⚠️  SHEET_OWNER_PHONE — NOT SET (multi-tenant isolation anchor). Falling back to OWNER_PHONE: ' + OWNER_PHONE);
    report.push('   Only this number writes to YOUR sheet; everyone else routes to their own / onboarding.');
    report.push('   FIX: add SHEET_OWNER_PHONE = your WhatsApp number (digits only, e.g. 972547760643) to Script Properties.');
    warn++;
  } else if (ownerPhoneProp === String(OWNER_PHONE).replace(/[^0-9]/g, '')) {
    report.push('✅ SHEET_OWNER_PHONE — ' + ownerPhoneProp + ' (matches OWNER_PHONE; isolation anchor confirmed)');
    ok++;
  } else {
    report.push('✅ SHEET_OWNER_PHONE — ' + ownerPhoneProp + ' (overrides OWNER_PHONE constant ' + OWNER_PHONE + ')');
    ok++;
  }

  // 5b. FX rate overrides — informational. Defaults always work; overrides are
  //     optional Script Properties (FX_RATE_USD, FX_RATE_EUR, ...).
  report.push('');
  report.push('───────────────────────────────────────');
  report.push('💱 FX CONVERSION RATES (₪ per unit)');
  report.push('───────────────────────────────────────');
  var __fxCodes = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF'];
  for (var __fxI = 0; __fxI < __fxCodes.length; __fxI++) {
    var __code = __fxCodes[__fxI];
    var __override = props.getProperty('FX_RATE_' + __code);
    var __def = KFL_FX_DEFAULTS[__code];
    if (__override) {
      report.push('✅ FX_RATE_' + __code + ' — override ' + __override + ' (default ' + __def + ')');
      ok++;
    } else {
      report.push('•  FX_RATE_' + __code + ' — using default ' + __def);
    }
  }

  report.push('');
  report.push('───────────────────────────────────────');
  report.push('📅 INSTALLING CRON TRIGGERS');
  report.push('───────────────────────────────────────');

  // 6. Install triggers
  try {
    if (typeof installWeeklySummaryTrigger === 'function') {
      installWeeklySummaryTrigger();
      report.push('✅ Weekly summary trigger (Sundays 9am)');
      ok++;
    }
  } catch (e) { report.push('❌ Weekly summary trigger: ' + e.message); err++; }

  try {
    if (typeof installInactivityTrigger === 'function') {
      installInactivityTrigger();
      report.push('✅ Inactivity nudge trigger (Tuesdays 9am)');
      ok++;
    }
  } catch (e) { report.push('❌ Inactivity trigger: ' + e.message); err++; }

  try {
    if (typeof installDailyMotivationTrigger === 'function') {
      installDailyMotivationTrigger();
      report.push('✅ Daily motivation trigger (9:30am)');
      ok++;
    }
  } catch (e) { report.push('❌ Daily motivation trigger: ' + e.message); err++; }

  try {
    if (typeof installWeeklySavingsProjectionTrigger === 'function') {
      installWeeklySavingsProjectionTrigger();
      report.push('✅ Friday savings projection trigger (Fridays 5pm)');
      ok++;
    }
  } catch (e) { report.push('❌ Savings projection trigger: ' + e.message); err++; }

  try {
    if (typeof installRecurringExpensesTrigger === 'function') {
      installRecurringExpensesTrigger();
      report.push('✅ Recurring expenses trigger (daily 8am)');
      ok++;
    }
  } catch (e) { report.push('❌ Recurring expenses trigger: ' + e.message); err++; }

  // 7. Optional: auto-install dashboard SUMIFS formulas.
  // Off by default — set Script Property AUTO_FIX_DASHBOARDS = '1' to enable.
  // Reason: the user's dashboard may have custom formulas in some cells that
  // we should preserve. The installer already preserves formulas, but we keep
  // the explicit opt-in so a first-time installer never silently rewrites
  // a sheet the user spent hours building.
  var autoFix = props.getProperty('AUTO_FIX_DASHBOARDS');
  if (autoFix === '1' || autoFix === 'true' || autoFix === 'yes') {
    report.push('');
    report.push('───────────────────────────────────────');
    report.push('📐 INSTALLING DASHBOARD FORMULAS (AUTO_FIX_DASHBOARDS=1)');
    report.push('───────────────────────────────────────');
    try {
      var cRes = installCompanyDashboardFormulas();
      report.push('✅ Company dashboard: fixed=' + cRes.fixed +
        ' preserved=' + cRes.skippedFormulas +
        ' unmapped=' + cRes.unmapped);
      ok++;
    } catch (e) { report.push('⚠️  Company dashboard: ' + e.message); warn++; }
    try {
      var pRes = installPersonalDashboardFormulas();
      report.push('✅ Personal dashboard: fixed=' + pRes.fixed +
        ' preserved=' + pRes.skippedFormulas +
        ' unmapped=' + pRes.unmapped);
      ok++;
    } catch (e) { report.push('⚠️  Personal dashboard: ' + e.message); warn++; }
  } else {
    report.push('');
    report.push('💡 דשבורד נוסחאות: לא הופעלו אוטומטית. הרץ installCompanyDashboardFormulas או installPersonalDashboardFormulas מהתפריט.');
    report.push('   (כדי להפעיל אוטומטית: Script Properties → AUTO_FIX_DASHBOARDS=1)');
  }

  report.push('');
  report.push('───────────────────────────────────────');
  report.push('📊 SUMMARY');
  report.push('───────────────────────────────────────');
  report.push('✅ OK: ' + ok);
  report.push('⚠️  WARNINGS: ' + warn);
  report.push('❌ ERRORS: ' + err);
  report.push('');

  if (err > 0) {
    report.push('🚨 ACTION REQUIRED: Fix the ❌ errors above before the bot can reply to messages.');
  } else if (warn > 0) {
    report.push('💡 Bot will work, but consider fixing the ⚠️  warnings for full functionality.');
  } else {
    report.push('🎉 All systems go! Bot is ready to receive messages.');
  }

  Logger.log(report.join('\n'));

  // Optional: send a test WhatsApp message to ALLOWED_PHONE (if it's set somewhere)
  // Skipped to avoid spamming during setup. To test manually, send a WhatsApp message
  // to +15556408123 (allow-listed recipients only) and check for a reply.

  return report.join('\n');
}

// Quick handler for "סטטוס" / "status" / "מצב" — for the user to verify the bot
// is alive via WhatsApp. Returns a short health summary.
function getBotStatusMessage(fromPhone) {
  try {
    var props = PropertiesService.getScriptProperties();
    var ai = !!props.getProperty('ANTHROPIC_API_KEY');
    var pnid = props.getProperty('WHATSAPP_PHONE_NUMBER_ID') || WHATSAPP_PHONE_NUMBER_ID;
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    var rowCount = sheet ? (sheet.getLastRow() - 1) : 0;
    var userTz = (typeof _getUserTz_ === 'function') ? _getUserTz_(fromPhone) : 'Asia/Jerusalem';
    return '🤖 *מצב הבוט*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +
      '✅ הבוט פעיל\n' +
      '📞 מספר: ' + BOT_PHONE_E164 + '\n' +
      '🆔 Phone ID: ...' + pnid.slice(-8) + '\n' +
      '📊 הוצאות בגיליון: ' + rowCount + '\n' +
      '🧠 AI fallback: ' + (ai ? '✅ פעיל' : '⚠️ לא פעיל') + '\n' +
      '🕐 ' + Utilities.formatDate(new Date(), userTz, 'dd/MM/yyyy HH:mm');
  } catch (e) {
    return '😬 שגיאה בבדיקת מצב: ' + (e && e.message || e) + '\n💡 ננסה שוב בעוד דקה?';
  }
}

// ============================================================
// 💳 SUBSCRIPTION AUTO-DETECTOR + DORMANT ALERTER
// ============================================================
// Inspired by Rocket Money's killer feature: scan the user's transactions,
// surface recurring vendors as "subscriptions", and warn when one stops
// charging (= "dormant", might be a cancelled service that nobody told
// the user about, or a charge that resumed silently).
//
// Public API:
//   detectSubscriptions()              -> [{vendor, avgAmount, cadence, ...}]
//   getActiveSubscriptionsMessage()    -> Hebrew summary string
//   cronDormantSubscriptionAlert()     -> sends WhatsApp on dormants (1st of month, 10am)
//   installDormantSubscriptionTrigger()-> wires the cron
//   _handleSubscriptionCommand_(from, text) -> command hook (called from doPost)
//
// All cron functions default OFF. Run the installer once from the editor.
// ASCII-only comments. Hebrew text only inside string literals.

// Subscription detection thresholds. Tunable.
var SUB_MIN_OCCURRENCES = 3;        // need >=3 charges to call something a subscription
var SUB_LOOKBACK_MONTHS = 6;         // scan the last N months of transactions
var SUB_AMOUNT_TOLERANCE = 0.10;     // +/- 10% on amount counts as "same"
var SUB_DORMANT_DAYS = 60;           // last charge older than this -> dormant
var SUB_CADENCE_TOLERANCE = 0.30;    // +/- 30% on inter-charge gap is "regular"

// Public: scan the תנועות sheet for recurring subscriptions.
// Returns array of { vendor, avgAmount, cadence, occurrences, firstSeen,
//                   lastSeen, nextExpected, isDormant }.
// Performance: one full-sheet read, single grouping pass, then per-vendor
// analysis. O(N) memory and O(N + V log V) time where V = distinct vendors.
// Target: under 1s wall-clock for a few thousand rows in Apps Script.
function detectSubscriptions() {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 4) return []; // need at least 3 charges + header

    // Single bulk read — fastest path in Apps Script.
    var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

    var now = new Date();
    var lookbackStart = new Date(now.getTime() - SUB_LOOKBACK_MONTHS * 30 * 86400000);

    // Group by normalized vendor name (column F, index 5 in row).
    // Income rows are filtered.
    var groups = {};   // vendorKey -> { display, charges: [{date, amount}] }
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rawDate = row[0];
      var date = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (isNaN(date.getTime())) continue;
      if (date < lookbackStart || date > now) continue;

      var amount = Number(row[2]);
      if (!amount || amount <= 0) continue;

      var category = String(row[3] || '');
      // Skip income categories — those aren't subscriptions, they're salary
      if (/הכנסות|הכנסה/.test(category)) continue;

      var rawDesc = String(row[5] || '').trim();
      if (!rawDesc) continue;

      var key = _normalizeVendorKey_(rawDesc);
      if (!key) continue;

      if (!groups[key]) {
        groups[key] = {
          display: _prettifyVendor_(rawDesc),
          charges: []
        };
      }
      groups[key].charges.push({ date: date, amount: amount });
    }

    // Analyze each group for subscription-ness.
    var subs = [];
    var keys = Object.keys(groups);
    for (var k = 0; k < keys.length; k++) {
      var g = groups[keys[k]];
      if (g.charges.length < SUB_MIN_OCCURRENCES) continue;

      // Sort charges by date ascending.
      g.charges.sort(function(a, b) { return a.date - b.date; });

      // Compute amount stats — reject if charges aren't clustered.
      var amts = g.charges.map(function(c) { return c.amount; });
      var avgAmount = _average_(amts);
      if (!_amountsAreClustered_(amts, avgAmount, SUB_AMOUNT_TOLERANCE)) continue;

      // Compute cadence from inter-charge gaps.
      var gaps = [];
      for (var j = 1; j < g.charges.length; j++) {
        gaps.push((g.charges[j].date - g.charges[j - 1].date) / 86400000);
      }
      var avgGap = _average_(gaps);
      if (!_gapsAreRegular_(gaps, avgGap, SUB_CADENCE_TOLERANCE)) continue;

      var cadence = _classifyCadence_(avgGap);
      if (!cadence) continue; // gap pattern doesn't match any standard cadence

      var firstSeen = g.charges[0].date;
      var lastSeen = g.charges[g.charges.length - 1].date;
      var nextExpected = new Date(lastSeen.getTime() + avgGap * 86400000);
      var daysSinceLast = (now - lastSeen) / 86400000;

      subs.push({
        vendor: g.display,
        avgAmount: Math.round(avgAmount * 100) / 100,
        cadence: cadence,
        cadenceDays: Math.round(avgGap),
        occurrences: g.charges.length,
        firstSeen: firstSeen,
        lastSeen: lastSeen,
        nextExpected: nextExpected,
        isDormant: daysSinceLast > SUB_DORMANT_DAYS
      });
    }

    // Sort by monthly cost descending (most expensive first).
    subs.sort(function(a, b) {
      return _monthlyCost_(b) - _monthlyCost_(a);
    });

    return subs;
  } catch (e) {
    Logger.log('detectSubscriptions error: ' + (e && e.stack || e));
    return [];
  }
}

// --- Helpers --------------------------------------------------------------

// Normalize a free-text description into a canonical vendor key for grouping.
// Strips punctuation, lowercases ASCII, collapses whitespace, removes common
// noise tokens (transaction IDs, store-branch numbers).
function _normalizeVendorKey_(desc) {
  var s = String(desc).toLowerCase();
  // strip URLs
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // strip emails
  s = s.replace(/\S+@\S+/g, ' ');
  // strip digits 3+ (transaction IDs, prices appended to vendor names)
  s = s.replace(/\d{3,}/g, ' ');
  // replace non-letter chars with spaces (keep Hebrew + ASCII letters)
  s = s.replace(/[^֐-׿a-z\s]/g, ' ');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2) return '';
  return s;
}

// Pretty-print a vendor name: trim, title-case ASCII words, keep Hebrew intact.
function _prettifyVendor_(desc) {
  var s = String(desc).trim();
  return s.split(/\s+/).map(function(w) {
    if (/^[a-z]/i.test(w)) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    return w;
  }).join(' ');
}

function _average_(arr) {
  if (!arr.length) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

// Are all amounts within +/-tolerance of the average?
function _amountsAreClustered_(amts, avg, tolerance) {
  if (avg <= 0) return false;
  for (var i = 0; i < amts.length; i++) {
    var deviation = Math.abs(amts[i] - avg) / avg;
    if (deviation > tolerance) return false;
  }
  return true;
}

// Are inter-charge gaps roughly equal (regular cadence)?
function _gapsAreRegular_(gaps, avg, tolerance) {
  if (avg <= 0) return false;
  for (var i = 0; i < gaps.length; i++) {
    var deviation = Math.abs(gaps[i] - avg) / avg;
    if (deviation > tolerance) return false;
  }
  return true;
}

// Classify an average-gap-in-days into a human cadence label, or null.
function _classifyCadence_(avgGapDays) {
  if (avgGapDays >= 6 && avgGapDays <= 9) return 'weekly';
  if (avgGapDays >= 13 && avgGapDays <= 17) return 'biweekly';
  if (avgGapDays >= 25 && avgGapDays <= 35) return 'monthly';
  if (avgGapDays >= 80 && avgGapDays <= 100) return 'quarterly';
  if (avgGapDays >= 170 && avgGapDays <= 200) return 'semiannual';
  if (avgGapDays >= 350 && avgGapDays <= 380) return 'yearly';
  return null;
}

// Project a subscription's monthly-equivalent cost (for sorting + totals).
function _monthlyCost_(sub) {
  switch (sub.cadence) {
    case 'weekly':     return sub.avgAmount * 4.33;
    case 'biweekly':   return sub.avgAmount * 2.17;
    case 'monthly':    return sub.avgAmount;
    case 'quarterly':  return sub.avgAmount / 3;
    case 'semiannual': return sub.avgAmount / 6;
    case 'yearly':     return sub.avgAmount / 12;
    default:           return sub.avgAmount;
  }
}

function _annualCost_(sub) {
  return _monthlyCost_(sub) * 12;
}

// Hebrew cadence words for messages.
function _cadenceHe_(cadence) {
  switch (cadence) {
    case 'weekly':     return 'שבוע';
    case 'biweekly':   return 'שבועיים';
    case 'monthly':    return 'חודש';
    case 'quarterly':  return 'רבעון';
    case 'semiannual': return 'חצי שנה';
    case 'yearly':     return 'שנה';
    default:           return 'חודש';
  }
}

// Pick an emoji that hints at the vendor type (keeps the message warm).
function _vendorEmoji_(vendor) {
  var v = String(vendor).toLowerCase();
  if (/netflix|hbo|disney|hulu|hot|yes vod|paramount|peacock|mubi|apple tv|youtube tv/.test(v)) return '🎬';
  if (/spotify|apple music|tidal|deezer|youtube music|soundcloud/.test(v)) return '🎵';
  if (/icloud|google drive|dropbox|onedrive|backblaze|wasabi/.test(v)) return '☁️';
  if (/chatgpt|claude|openai|gemini|anthropic|midjourney|copilot/.test(v)) return '🤖';
  if (/gym|crossfit|כושר|חדר כושר|יוגה|מכון/.test(v)) return '💪';
  if (/wolt|tenbis|ten bis|cibus|וולט|תן ביס|סיבוס/.test(v)) return '🍔';
  if (/times|wsj|economist|ynet|haaretz|הארץ|עיתון|news/.test(v)) return '📰';
  if (/microsoft|office|365|adobe|notion|figma|slack|zoom/.test(v)) return '🧰';
  if (/vpn|nord|express|surfshark|proton/.test(v)) return '🛡️';
  return '💳';
}

// Format a date as DD/MM/YYYY in Israel time.
function _fmtIsraelDate_(date) {
  return Utilities.formatDate(date, 'Asia/Jerusalem', 'dd/MM/yyyy');
}

// --- Public message builders ----------------------------------------------

// Returns the Hebrew "active subscriptions" summary message.
function getActiveSubscriptionsMessage() {
  var subs = detectSubscriptions();
  var active = subs.filter(function(s) { return !s.isDormant; });

  if (!active.length) {
    return '💳 *המנויים הפעילים שלך*\n' +
           '\n' +
           'עוד לא זיהיתי מנויים קבועים אצלך.\n' +
           'כשיהיו לפחות 3 חיובים זהים מאותו ספק — אני אתפוס אותם.';
  }

  var lines = [];
  lines.push('💳 *המנויים הפעילים שלך*');
  lines.push('');

  var totalAnnual = 0;
  for (var i = 0; i < active.length; i++) {
    var s = active[i];
    var monthly = _monthlyCost_(s);
    var annual = monthly * 12;
    totalAnnual += annual;

    var emoji = _vendorEmoji_(s.vendor);
    var cadenceHe = _cadenceHe_(s.cadence);
    var monthlyStr = '₪' + Math.round(monthly).toLocaleString('he-IL');
    var annualStr = '₪' + Math.round(annual).toLocaleString('he-IL');

    lines.push(emoji + ' ' + s.vendor + '  ' + monthlyStr + '/' + cadenceHe + '  →  ' + annualStr + '/שנה');
  }

  lines.push('');
  lines.push('📊 סה"כ: ₪' + Math.round(totalAnnual).toLocaleString('he-IL') + ' בשנה');
  lines.push('');
  lines.push('רוצה לבדוק אם משהו לא בשימוש? שלח "ניקיון מנויים".');
  return lines.join('\n');
}

// Stub for the cleanup wizard — surfaces dormants and gives next steps.
function getSubscriptionCleanupMessage() {
  var subs = detectSubscriptions();
  var dormant = subs.filter(function(s) { return s.isDormant; });
  if (!dormant.length) {
    return '🧹 *ניקיון מנויים*\n' +
           '\n' +
           'אין כרגע מנויים חשודים — הכל נראה תקין.\n' +
           'אני אבדוק שוב אחת לחודש ואעדכן אותך אם משהו ישתנה.';
  }

  var lines = [];
  lines.push('🧹 *ניקיון מנויים*');
  lines.push('');
  lines.push('זיהיתי ' + dormant.length + ' מנויים חשודים (לא חויבו לאחרונה):');
  lines.push('');

  for (var i = 0; i < dormant.length; i++) {
    var s = dormant[i];
    var annual = Math.round(_annualCost_(s));
    var emoji = _vendorEmoji_(s.vendor);
    lines.push(emoji + ' ' + s.vendor + ' — חיוב אחרון ' + _fmtIsraelDate_(s.lastSeen));
    lines.push('   חיסכון פוטנציאלי: ₪' + annual.toLocaleString('he-IL') + ' בשנה');
    lines.push('');
  }

  lines.push('💡 *מה לעשות?*');
  lines.push('1. בדוק בכרטיס האשראי אם המנוי באמת בוטל.');
  lines.push('2. אם כן — מצוין, אפשר להתעלם.');
  lines.push('3. אם לא — סביר שיש חיוב שאיבד את הקבלה. שווה לבדוק.');
  lines.push('');
  lines.push('(אשף ביטול אוטומטי בדרך)');
  return lines.join('\n');
}

// --- Cron: monthly dormant-subscription alert -----------------------------

function cronDormantSubscriptionAlert() {
  try {
    var to = ALLOWED_PHONE || (PropertiesService.getScriptProperties().getProperty('WEEKLY_SUMMARY_PHONE') || '');
    if (!to) {
      Logger.log('cronDormantSubscriptionAlert: no recipient configured');
      return;
    }

    var subs = detectSubscriptions();
    var dormant = subs.filter(function(s) { return s.isDormant; });
    if (!dormant.length) {
      Logger.log('cronDormantSubscriptionAlert: no dormants this month');
      return;
    }

    // Send one message per dormant — keeps each alert focused and easy
    // to act on. Cap at 3 per cron run to avoid spam.
    var sendCount = Math.min(dormant.length, 3);
    for (var i = 0; i < sendCount; i++) {
      var s = dormant[i];
      var annual = Math.round(_annualCost_(s));
      var msg = '🔍 *גילוי חשוב — מנוי שלא חויב לאחרונה*\n' +
                '\n' +
                'ל-' + s.vendor + ' לא היה חיוב מאז ' + _fmtIsraelDate_(s.lastSeen) + ' (60+ ימים).\n' +
                'האם ביטלת את המנוי? אם לא — שווה לבדוק.\n' +
                '\n' +
                'זה יכול לחסוך לך ₪' + annual.toLocaleString('he-IL') + ' בשנה אם המנוי באמת בוטל ושכחו לסגור.';
      sendWhatsAppMessage(to, msg);
      Logger.log('cronDormantSubscriptionAlert: sent for vendor=' + s.vendor);
    }
  } catch (e) {
    Logger.log('cronDormantSubscriptionAlert error: ' + (e && e.stack || e));
  }
}

function installDormantSubscriptionTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronDormantSubscriptionAlert') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 1st of each month, ~10am Israel time. Apps Script onMonthDay fires once
  // per month at the given day; atHour gives an hourly window.
  ScriptApp.newTrigger('cronDormantSubscriptionAlert')
    .timeBased()
    .onMonthDay(1)
    .atHour(10)
    .inTimezone('Asia/Jerusalem')
    .create();
  Logger.log('Dormant subscription trigger installed (1st of month, 10am Asia/Jerusalem)');
}

function uninstallDormantSubscriptionTrigger() {
  var killed = 0;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronDormantSubscriptionAlert') {
      ScriptApp.deleteTrigger(triggers[i]);
      killed++;
    }
  }
  Logger.log('Dormant subscription triggers removed: ' + killed);
}

// --- Command router hook (called from doPost dispatcher) ------------------

function _handleSubscriptionCommand_(from, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };
  var norm = raw.replace(/^\//, '').trim();
  var low = norm.toLowerCase();

  // Active subscriptions list
  if (norm === 'מנויים' || low === 'subscriptions' || low === 'subs') {
    return { handled: true, replyText: getActiveSubscriptionsMessage() };
  }

  // Cleanup wizard (stub for now — surfaces dormants)
  if (norm === 'ניקיון מנויים' || low === 'cleanup' || low === 'cleanup subscriptions' || low === 'sub cleanup') {
    return { handled: true, replyText: getSubscriptionCleanupMessage() };
  }

  return { handled: false };
}

// --- Test helpers (run from editor) ---------------------------------------

function _testDetectSubscriptions_() {
  var t0 = new Date().getTime();
  var subs = detectSubscriptions();
  var ms = new Date().getTime() - t0;
  Logger.log('detectSubscriptions: ' + subs.length + ' subs found in ' + ms + 'ms');
  for (var i = 0; i < subs.length; i++) {
    var s = subs[i];
    Logger.log((i + 1) + '. ' + s.vendor + ' — ' + s.cadence + ' — avg ' + s.avgAmount +
               ' — last=' + _fmtIsraelDate_(s.lastSeen) + ' — dormant=' + s.isDormant);
  }
}

function _testActiveSubscriptionsMessage_() {
  Logger.log(getActiveSubscriptionsMessage());
}

function _testCleanupMessage_() {
  Logger.log(getSubscriptionCleanupMessage());
}

// ============================================================
// 🎯 GOAL TRACKING — let users set savings/spending goals + nudge them
// ============================================================
// Examples:
//   "מטרה: חיסכון 5000 לחופשה עד אוגוסט"  → set savings goal
//   "מטרה: עד 800 שח על אוכל בחוץ בחודש"  → set spending cap
//   "מטרות"                              → list active goals + progress
//   "מחק מטרה X"                          → remove goal
//
// Goals are stored as JSON in Script Properties (key: goals:active).
// Each goal: { id, type:'save'|'cap', target, category?, deadline?, createdAt, current }
function getGoalsMessage() {
  try {
    var goals = _loadGoals_();
    if (!goals.length) {
      return '🎯 *המטרות שלך*\n' +
        '━━━━━━━━━━━━━━━━━━\n\n' +
        'עדיין אין לך מטרות פעילות.\n\n' +
        '💡 *דוגמאות להגדרת מטרה:*\n' +
        '  • "מטרה: חיסכון 5000 לחופשה עד אוגוסט"\n' +
        '  • "מטרה: עד 800 שח על אוכל בחוץ בחודש"\n' +
        '  • "מטרה: לא להוציא על קפה השבוע"';
    }
    var lines = ['🎯 *המטרות שלך*', '━━━━━━━━━━━━━━━━━━', ''];
    for (var i = 0; i < goals.length; i++) {
      var g = goals[i];
      var pct = g.target > 0 ? Math.round((g.current / g.target) * 100) : 0;
      var bar = _progressBar_(pct);
      var emoji = g.type === 'save' ? '💰' : '🎯';
      var label = g.type === 'save' ? 'חיסכון' : 'מקסימום';
      lines.push(emoji + ' *' + g.title + '*');
      lines.push('   ' + label + ': ₪' + g.target.toLocaleString());
      lines.push('   ' + bar + ' ' + pct + '%');
      lines.push('   ₪' + g.current.toLocaleString() + ' / ₪' + g.target.toLocaleString());
      if (g.deadline) lines.push('   📅 עד: ' + g.deadline);
      lines.push('');
    }
    lines.push('💡 כתוב "מחק מטרה X" כדי להסיר');
    return lines.join('\n');
  } catch (e) {
    Logger.log('getGoalsMessage error: ' + e);
    return '😬 משהו השתבש בטעינת מטרות\n💡 ננסה שוב בעוד דקה?';
  }
}

function _progressBar_(pct) {
  var filled = Math.min(10, Math.floor(pct / 10));
  var empty = 10 - filled;
  return '▰'.repeat(filled) + '▱'.repeat(empty);
}

function _loadGoals_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('goals:active');
    if (!raw) return [];
    var goals = JSON.parse(raw);
    // Recompute current values from sheet
    return goals.map(_refreshGoalProgress_);
  } catch (e) {
    return [];
  }
}

function _saveGoals_(goals) {
  PropertiesService.getScriptProperties().setProperty('goals:active', JSON.stringify(goals));
}

function _refreshGoalProgress_(goal) {
  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TRANSACTIONS_SHEET);
    if (!sheet) return goal;
    var data = sheet.getDataRange().getValues();
    var current = 0;
    var startDate = goal.startDate ? new Date(goal.startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    for (var i = 1; i < data.length; i++) {
      var d = data[i][0] instanceof Date ? data[i][0] : new Date(data[i][0]);
      if (isNaN(d.getTime()) || d < startDate) continue;
      var cat = String(data[i][3] || '');
      var sub = String(data[i][4] || '');
      if (goal.category && !cat.includes(goal.category) && !sub.includes(goal.category)) continue;
      if (goal.type === 'save' && /הכנסות|הכנסה/i.test(cat)) {
        current += Number(data[i][2]) || 0;
      } else if (goal.type === 'cap' && !/הכנסות|הכנסה/i.test(cat)) {
        current += Number(data[i][2]) || 0;
      }
    }
    goal.current = current;
    return goal;
  } catch (e) {
    return goal;
  }
}

// Parser: "מטרה: חיסכון 5000 לחופשה עד אוגוסט" or "מטרה: עד 800 שח על אוכל"
function parseGoalCommand(text) {
  var t = String(text || '').trim();
  // Match "מטרה: <anything>"
  var m = t.match(/^מטרה\s*[:\-]?\s*(.+)$/i);
  if (!m) return null;
  var body = m[1].trim();
  // Extract amount
  var amountM = body.match(/(\d+(?:[.,]\d+)?)\s*(?:שח|₪|ש"ח)?/);
  if (!amountM) return null;
  var amount = parseFloat(amountM[1].replace(',', ''));
  // Detect type
  var isCapMode = /^עד\s|מקסימום|לא יותר/i.test(body);
  var isSaveMode = /חיסכון|לחסוך/i.test(body) || !isCapMode;
  // Extract category (optional)
  var catM = body.match(/(?:על|בקטגוריה|ל)\s+([֐-׿a-zA-Z]+(?:\s+[֐-׿a-zA-Z]+){0,2})/);
  var category = catM ? catM[1].trim() : null;
  // Extract deadline (optional)
  var deadlineM = body.match(/עד\s+([֐-׿a-zA-Z\d\s\/\-\.]+?)(?:\s|$)/);
  var deadline = deadlineM ? deadlineM[1].trim() : null;
  return {
    type: isCapMode ? 'cap' : 'save',
    target: amount,
    category: category,
    deadline: deadline,
    title: body.slice(0, 60),
    id: Date.now().toString(36)
  };
}

function addGoal(parsed) {
  var goals = _loadGoals_();
  // Limit: 5 active goals
  if (goals.length >= 5) {
    return '😬 הגעת לתקרת 5 מטרות\n💡 שלח "מטרות" לראות את הרשימה ומחק אחת לפני שתוסיף חדשה';
  }
  parsed.createdAt = new Date().toISOString();
  parsed.startDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  parsed.current = 0;
  goals.push(parsed);
  _saveGoals_(goals);
  var emoji = parsed.type === 'save' ? '💰' : '🎯';
  return emoji + ' *מטרה נוספה בהצלחה!*\n\n' +
    parsed.title + '\n' +
    'יעד: ₪' + parsed.target.toLocaleString() + '\n' +
    (parsed.category ? 'קטגוריה: ' + parsed.category + '\n' : '') +
    (parsed.deadline ? 'תאריך יעד: ' + parsed.deadline + '\n' : '') +
    // HONESTY (2026-05-24): there's no cron that nudges goal progress —
    // the user has to ask. Don't promise updates we don't send.
    '\nשלח *"מטרות"* בכל עת כדי לראות התקדמות.';
}

function deleteGoal(idOrIndex) {
  var goals = _loadGoals_();
  var idx = -1;
  // Try by index (1-based for user-friendliness)
  var asNum = parseInt(idOrIndex, 10);
  if (!isNaN(asNum) && asNum >= 1 && asNum <= goals.length) {
    idx = asNum - 1;
  } else {
    // Try by ID
    for (var i = 0; i < goals.length; i++) {
      if (goals[i].id === idOrIndex) { idx = i; break; }
    }
  }
  if (idx < 0) return '😬 לא מצאתי את המטרה\n💡 שלח "מטרות" לראות את הרשימה';
  var removed = goals.splice(idx, 1)[0];
  _saveGoals_(goals);
  return '🗑️ נמחקה מטרה: "' + removed.title + '"';
}

// ============================================================
// 👨‍👩‍👧 Family / household commands (STUBS — wire to KV later).
// ============================================================
// Status: scaffolding only. The Vercel KV layer for households is not built
// yet — these handlers return informative placeholders so the user gets a
// useful reply, and so Steven can preview the conversational copy without a
// backend. See docs/family-sharing.md for the data model these stubs target.
//
// Commands handled:
//   הזמן 052-1234567 / invite 052-1234567   -> create + send invite link
//   הזמן / invite                            -> reply with a generic link
//   משפחה / family                           -> list current members + roles
//   פרישה / leave                            -> leave the household
//
// Real implementation TODOs are tagged inline. Each "TODO: KV" marks a spot
// where the Vercel /api/family/* routes need to be hooked up.

var FAMILY_API_BASE = (function () {
  try {
    return PropertiesService.getScriptProperties().getProperty('KESEFLE_API_BASE') || 'https://kesefle.com';
  } catch (e) { return 'https://kesefle.com'; }
})();

function _handleFamilyCommand_(fromPhone, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };

  // Strip leading slash so "/invite" works too.
  var norm = raw.replace(/^\//, '').trim();
  var low = norm.toLowerCase();

  // --- "הזמן <phone>" / "invite <phone>" ---------------------------------
  // Hebrew, English, with or without dashes. Accept anything that looks like
  // an Israeli mobile (05X-XXX-XXXX) or any 7+ digit number.
  var inviteMatch =
       norm.match(/^הזמן\s+(.+)$/i)
    || norm.match(/^invite\s+(.+)$/i);
  if (inviteMatch) {
    return { handled: true, replyText: _familyInviteReply_(fromPhone, inviteMatch[1]) };
  }
  if (low === 'הזמן' || low === 'invite' || low === 'הזמינה' || low === 'הזמיני') {
    return { handled: true, replyText: _familyInviteGenericReply_(fromPhone) };
  }

  // --- "משפחה" / "family" / "members" ------------------------------------
  if (low === 'משפחה' || low === 'family' || low === 'members' || low === 'בני בית' || low === 'בני הבית') {
    return { handled: true, replyText: _familyListReply_(fromPhone) };
  }

  // --- "פרישה" / "leave" --------------------------------------------------
  if (low === 'פרישה' || low === 'leave' || low === 'עזיבה' || low === 'אני עוזב' || low === 'אני עוזבת') {
    return { handled: true, replyText: _familyLeaveReply_(fromPhone) };
  }

  return { handled: false };
}

// ------------------------------------------------------------------
// "הזמן 052-1234567" — admin invites a specific phone to the household.
// ------------------------------------------------------------------
function _familyInviteReply_(fromPhone, rawTarget) {
  // HONESTY (2026-05-24 audit): the original implementation generated a fake
  // invite code and a fake invite URL. Steven explicitly asked us to stop
  // lying and only promise what the bot actually delivers. The REAL working
  // flow is /api/group (used by "כספלה צור משפחה <name>"), which actually
  // creates a shared sheet + dispenses a join code. Redirect there instead
  // of returning a fake code that does nothing.
  var cleaned = String(rawTarget || '').replace(/[^\d+]/g, '');
  if (!cleaned || cleaned.length < 7) {
    return '😬 לא הצלחתי לקרוא את המספר. נסה: "הזמן 052-1234567"';
  }
  return '👨‍👩‍👧 *פתיחת משפחה אמיתית*\n\n' +
    'הפקודה היציבה לפתיחת קבוצת משפחה היא:\n' +
    '*כספלה צור משפחה <שם>*\n' +
    '(למשל: "כספלה צור משפחה כהן")\n\n' +
    'אחר כך אקבל ממך קוד הזמנה אמיתי, ותוכל לשלוח אותו ל-' +
    _familyFormatPhone_(cleaned) + ' עם ההוראה:\n' +
    '*כספלה הצטרף <הקוד>*\n\n' +
    'או שיוכלו לסרוק QR ב-' + FAMILY_API_BASE + '/family-invite';
}

// ------------------------------------------------------------------
// "הזמן" alone — generic invite link, admin shares manually.
// ------------------------------------------------------------------
function _familyInviteGenericReply_(fromPhone) {
  // Same honest redirect — point to the real /api/group flow + the QR page.
  return '🔗 *הזמנה למשפחה (אמיתי)*\n\n' +
    'הפקודה היציבה:\n' +
    '*כספלה צור משפחה <שם>*\n\n' +
    'תקבל קוד 6 ספרות אמיתי. שלח אותו למי שתרצה להוסיף עם:\n' +
    '*כספלה הצטרף <הקוד>*\n\n' +
    'או שלח את הקישור: ' + FAMILY_API_BASE + '/family-invite';
}

// ------------------------------------------------------------------
// "משפחה" — list current members + roles + permissions.
// ------------------------------------------------------------------
function _familyListReply_(fromPhone) {
  // HONESTY (2026-05-24): the original returned a fake demo list ("👑 את/ה..."
  // with placeholder rows). Steven asked us to stop. The real working route
  // is /api/group + _groupContext_. Delegate so the user sees REAL group
  // membership, not a placeholder.
  try {
    var r = _groupContext_(fromPhone);
    if (r && r.replyText) return r.replyText;
  } catch (_e) {}
  return '👨‍👩‍👧 *משפחה*\n\n' +
    'לבדיקת קבוצות משפחה אמיתיות שאת/ה חבר/ה בהן:\n' +
    '*כספלה הקשר*\n\n' +
    'ליצירת משפחה חדשה:\n' +
    '*כספלה צור משפחה <שם>*';
}

// ------------------------------------------------------------------
// "פרישה" — leave household. Admin cannot.
// ------------------------------------------------------------------
function _familyLeaveReply_(fromPhone) {
  // TODO: KV — resolveHouseholdForPhone_(fromPhone), check role.
  // If admin: refuse, suggest transfer or subscription cancel.
  // If member: remove hhmember:<userId>, notify admin via WhatsApp DM.
  // var hh = resolveHouseholdForPhone_(fromPhone);
  // if (!hh) return _familyNotInHouseholdMsg_();
  // if (hh.member.role === 'admin') return _familyAdminCantLeaveMsg_();

  // HONESTY (2026-05-24): the real "leave a group" path is /api/group +
  // _groupLeave_. Delegate so the user actually leaves, not just sees a
  // demo confirmation message.
  try {
    var r = _groupLeave_(fromPhone);
    if (r && r.replyText) return r.replyText;
  } catch (_e) {}
  return '👋 לעזיבת קבוצה פעילה השתמש/י ב:\n*כספלה אישי* (חזרה למצב אישי)\nאו:\n*כספלה עזוב* (יציאה מהקבוצה הפעילה)';
}

// ------------------------------------------------------------------
// Helpers — kept private so they don't pollute the global namespace.
// ------------------------------------------------------------------

// Format a raw phone string for display ("0521234567" -> "052-123-4567").
function _familyFormatPhone_(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d.charAt(0) === '0') {
    return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  }
  if (d.length === 12 && d.slice(0, 3) === '972') {
    return '0' + d.slice(3, 5) + '-' + d.slice(5, 8) + '-' + d.slice(8);
  }
  return String(raw);
}

// Stand-in until the Vercel side issues real codes. 6 chars, base32-ish.
function _familyMakeFakeCode_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  var s = '';
  for (var i = 0; i < 6; i++) {
    s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return s;
}

// ====================================================================
// 👨‍👩‍👧 FAMILY / BUSINESS MULTI-USER BOT — Phase 2 Task 1
// ====================================================================
// All KV state lives in Vercel KV (Upstash Redis). The Script Properties
// VERCEL_KV_REST_URL and VERCEL_KV_REST_TOKEN hold the REST endpoint and
// bearer token. Keys:
//   family:<id>                     → JSON {sheetId, members, admin, createdAt}
//   family:of:<phone>               → familyId membership pointer
//   family:pending:<id>:<phone>     → '1' with 10 min TTL — join request
//   context:<phone>                 → 'family' | 'personal' (sticky)
// ====================================================================

// --- KV helpers --------------------------------------------------------
// Vercel KV REST API contract:
//   GET  ${url}/get/${key}   -> {result: <string-or-null>}
//   POST ${url}/set/${key}   body=<value>  optional ?EX=<ttl>
//   POST ${url}/del/${key}
// Auth: Authorization: Bearer <token>. Apps Script uses UrlFetchApp.fetch
// because the global `fetch` is not available in the V8 runtime.

function _kvCreds_() {
  var props = PropertiesService.getScriptProperties();
  var urlProp = (typeof VERCEL_KV_REST_URL_PROP !== 'undefined') ? VERCEL_KV_REST_URL_PROP : 'VERCEL_KV_REST_URL';
  var tokProp = (typeof VERCEL_KV_REST_TOKEN_PROP !== 'undefined') ? VERCEL_KV_REST_TOKEN_PROP : 'VERCEL_KV_REST_TOKEN';
  var url = props.getProperty(urlProp);
  var tok = props.getProperty(tokProp);
  if (!url || !tok) return null;
  return { url: String(url).replace(/\/+$/, ''), tok: tok };
}

function kvGet(key) {
  if (!key) return null;
  var c = _kvCreds_();
  if (!c) { Logger.log('kvGet: missing creds'); return null; }
  try {
    var res = UrlFetchApp.fetch(c.url + '/get/' + encodeURIComponent(key), {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + c.tok }
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('kvGet ' + key + ' http=' + res.getResponseCode());
      return null;
    }
    var body = JSON.parse(res.getContentText() || '{}');
    if (body.result == null) return null;
    try { return JSON.parse(body.result); }
    catch (_jpE) { return body.result; }
  } catch (e) {
    Logger.log('kvGet ' + key + ' err=' + (e && e.message));
    return null;
  }
}

function kvSet(key, value, ttlSeconds) {
  if (!key) return false;
  var c = _kvCreds_();
  if (!c) { Logger.log('kvSet: missing creds'); return false; }
  try {
    var url = c.url + '/set/' + encodeURIComponent(key);
    if (ttlSeconds && ttlSeconds > 0) url += '?EX=' + Math.floor(ttlSeconds);
    var payload = (typeof value === 'string') ? value : JSON.stringify(value);
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      payload: payload,
      headers: { Authorization: 'Bearer ' + c.tok }
    });
    return res.getResponseCode() === 200;
  } catch (e) {
    Logger.log('kvSet ' + key + ' err=' + (e && e.message));
    return false;
  }
}

function kvDel(key) {
  if (!key) return false;
  var c = _kvCreds_();
  if (!c) return false;
  try {
    var res = UrlFetchApp.fetch(c.url + '/del/' + encodeURIComponent(key), {
      method: 'post',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + c.tok }
    });
    return res.getResponseCode() === 200;
  } catch (e) {
    Logger.log('kvDel ' + key + ' err=' + (e && e.message));
    return false;
  }
}

// --- Family dispatcher -------------------------------------------------

function _handleFamilyMultiCommand_(fromPhone, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };
  var norm = raw.replace(/^\//, '').trim();
  var low = norm.toLowerCase();

  if (low === 'הקמת משפחה' || low === 'create family') {
    return _familyCreate_(fromPhone);
  }

  var joinM = norm.match(/^הצטרפות\s+למשפחה\s+([A-Z0-9]{6,8})$/i)
           || norm.match(/^join\s+family\s+([A-Z0-9]{6,8})$/i);
  if (joinM) {
    return _familyJoinRequest_(fromPhone, joinM[1].toUpperCase());
  }

  var apM = norm.match(/^אישור\s+(\d{6,})$/i)
         || norm.match(/^approve\s+(\d{6,})$/i);
  if (apM) {
    return _familyApprove_(fromPhone, apM[1]);
  }
  var dnM = norm.match(/^דחייה\s+(\d{6,})$/i)
         || norm.match(/^deny\s+(\d{6,})$/i);
  if (dnM) {
    return _familyDeny_(fromPhone, dnM[1]);
  }

  // Explicit family-prefixed expense: "משפחה 50 קפה"
  var fxM = norm.match(/^משפחה\s+(\d+(?:\.\d+)?)\s+(.+)$/i)
         || norm.match(/^family\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (fxM) {
    var memberLabel = _familyDefaultMemberLabel_(fromPhone);
    return _familyLogExpense_(fromPhone, memberLabel, parseFloat(fxM[1]), fxM[2]);
  }

  // Member-prefixed expense: "אבא 50 קפה"
  var memberPrefixM = norm.match(/^(אבא|אימא|אמא|ילד1|ילד2|ילד3|dad|mom|kid1|kid2|kid3)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (memberPrefixM) {
    return _familyLogExpense_(fromPhone, _familyNormalizeMember_(memberPrefixM[1]), parseFloat(memberPrefixM[2]), memberPrefixM[3]);
  }

  if (low === 'דו"ח משפחתי' || low === 'דו״ח משפחתי' || low === 'דוח משפחתי' || low === 'family report') {
    return _familyReport_(fromPhone);
  }

  if (low === 'מצב משפחתי' || low === 'family mode') {
    kvSet('context:' + fromPhone, 'family', 0);
    return { handled: true, replyText: '✅ מעבר למשפחתי' };
  }
  if (low === 'מצב אישי' || low === 'personal mode') {
    kvDel('context:' + fromPhone);
    return { handled: true, replyText: '✅ מעבר לאישי' };
  }

  return { handled: false };
}

// --- Per-message context router (called from doPost) -------------------
// Handles plain expense messages that should be written to a family sheet
// because the user has set context=family or used "משפחה " / "אישי " prefix.

function _routeExpenseByContext_(fromPhone, text) {
  if (!fromPhone || !text) return { handled: false };
  var t = String(text);

  var stripped = t.replace(/^\/+/, '').trim();
  var personalPrefix = stripped.match(/^(?:אישי|personal)\s+(.+)$/i);
  if (personalPrefix) {
    return { handled: false };
  }

  var familyPrefix = stripped.match(/^(?:משפחה|family)\s+(.+)$/i);
  if (familyPrefix) {
    var inner = familyPrefix[1].trim();
    // If inner is "<amount> <description>" we treat as family expense.
    // Otherwise the family dispatcher (handled earlier) takes the message.
    var amtM = inner.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (amtM) {
      return _familyLogExpense_(fromPhone, _familyDefaultMemberLabel_(fromPhone), parseFloat(amtM[1]), amtM[2]);
    }
    return { handled: false };
  }

  // No explicit prefix → fall through unless KV context says family.
  var ctx = kvGet('context:' + fromPhone);
  if (ctx !== 'family') return { handled: false };

  // Plain amount + description while in family context → log to family.
  var amtM2 = stripped.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!amtM2) return { handled: false };

  return _familyLogExpense_(fromPhone, _familyDefaultMemberLabel_(fromPhone), parseFloat(amtM2[1]), amtM2[2]);
}

// --- Family operations ------------------------------------------------

function _familyCreate_(fromPhone) {
  var templateId = (typeof FAMILY_TEMPLATE_SHEET_ID !== 'undefined') ? FAMILY_TEMPLATE_SHEET_ID : '';
  if (!templateId || templateId === 'REPLACE_WITH_FAMILY_TEMPLATE_ID') {
    return { handled: true, replyText: '😬 תבנית משפחה לא הוגדרה\n💡 צור קשר עם המנהל דרך https://kesefle.com' };
  }

  var familyId = _familyGenerateId_();
  var copyName = 'Kesefle Family — ' + familyId;
  var newSheetId;
  try {
    var copy = DriveApp.getFileById(templateId).makeCopy(copyName);
    newSheetId = copy.getId();
  } catch (e) {
    Logger.log('_familyCreate_: copy failed ' + (e && e.message));
    return { handled: true, replyText: '😬 לא הצלחתי לשכפל את התבנית: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
  }

  var rec = {
    sheetId: newSheetId,
    members: [String(fromPhone)],
    admin: String(fromPhone),
    createdAt: Date.now()
  };
  // HONESTY (2026-05-24): both KV writes are critical. If either fails
  // (KV down, quota exceeded) the sheet exists in Drive but no one can
  // join because the admin/family mapping is lost. Fail closed.
  var w1 = kvSet('family:' + familyId, rec, 0);
  var w2 = kvSet('family:of:' + fromPhone, familyId, 0);
  if (!w1 || !w2) {
    Logger.log('_familyCreate_: KV write failed (w1=' + w1 + ' w2=' + w2 + ')');
    return { handled: true, replyText:
      '😬 הקבוצה לא נשמרה במאגר (תקלת רשת זמנית). הגיליון נוצר אבל לא ניתן להזמין עדיין.\n' +
      'נסה/י שוב בעוד דקה.' };
  }

  var msg =
    '✅ המשפחה הוקמה!\n\n' +
    'קוד הצטרפות: ' + familyId + '\n\n' +
    'שלחו את הקוד הזה לבני המשפחה, ובקשו מהם לשלוח:\n' +
    'הצטרפות למשפחה ' + familyId + '\n\n' +
    'אתם תקבלו אישור על כל הצטרפות.';
  return { handled: true, replyText: msg };
}

function _familyJoinRequest_(fromPhone, familyId) {
  var rec = kvGet('family:' + familyId);
  if (!rec) {
    return { handled: true, replyText: '😬 קוד משפחה לא נמצא\n💡 ודא/י עם המנהל שהקוד נכון' };
  }
  if (rec.members && rec.members.indexOf(String(fromPhone)) >= 0) {
    return { handled: true, replyText: '✅ אתם כבר חברים במשפחה הזו.' };
  }

  if (!kvSet('family:pending:' + familyId + ':' + fromPhone, '1', 600)) {
    Logger.log('_familyJoinRequest_: KV write failed for pending');
    return { handled: true, replyText: '😬 תקלת רשת זמנית, הבקשה לא נשמרה. נסה/י שוב בעוד רגע.' };
  }

  try {
    if (typeof sendWhatsAppInteractiveList === 'function') {
      var sections = [{
        title: 'בקשת הצטרפות',
        rows: [
          { id: 'fam_approve_' + fromPhone, title: 'אישור ' + fromPhone, description: 'אשרו את ההצטרפות' },
          { id: 'fam_deny_' + fromPhone,    title: 'דחייה ' + fromPhone, description: 'דחו את הבקשה' }
        ]
      }];
      sendWhatsAppInteractiveList(
        rec.admin,
        'בקשת הצטרפות חדשה',
        'המספר ' + fromPhone + ' מבקש להצטרף למשפחה ' + familyId + '.\n\nבחרו פעולה:',
        'הבקשה תפוג בעוד 10 דקות',
        'בחרו',
        sections
      );
    } else if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(rec.admin,
        '👨‍👩‍👧 בקשת הצטרפות חדשה\n' +
        'המספר ' + fromPhone + ' מבקש להצטרף למשפחה ' + familyId + '.\n\n' +
        'לאישור: "אישור ' + fromPhone + '"\n' +
        'לדחייה: "דחייה ' + fromPhone + '"');
    }
  } catch (e) {
    Logger.log('_familyJoinRequest_: admin notify err ' + (e && e.message));
  }

  return { handled: true, replyText: '✅ בקשה נשלחה לאדמין. תקבלו תשובה תוך כמה דקות.' };
}

function _familyApprove_(adminPhone, requesterPhone) {
  var familyId = kvGet('family:of:' + adminPhone);
  if (!familyId) {
    return { handled: true, replyText: '😬 אינך מנהל משפחה\n💡 שלח "הקמת משפחה" כדי להקים אחת' };
  }
  var rec = kvGet('family:' + familyId);
  if (!rec) {
    return { handled: true, replyText: '😬 משפחה לא נמצאה\n💡 שלח "הקמת משפחה" כדי להקים אחת' };
  }
  if (String(rec.admin) !== String(adminPhone)) {
    return { handled: true, replyText: '😬 רק המנהל יכול לאשר\n💡 בקש מהמנהל לאשר את הבקשה' };
  }
  var pending = kvGet('family:pending:' + familyId + ':' + requesterPhone);
  if (!pending) {
    return { handled: true, replyText: '😬 אין בקשה ממתינה ממספר זה (או פג תוקף)\n💡 שלח את בקשת ההצטרפות מחדש' };
  }
  if (!rec.members) rec.members = [];
  if (rec.members.indexOf(String(requesterPhone)) < 0) rec.members.push(String(requesterPhone));
  // HONESTY: if either critical write fails, don't tell anyone they're in.
  var aw1 = kvSet('family:' + familyId, rec, 0);
  var aw2 = kvSet('family:of:' + requesterPhone, familyId, 0);
  if (!aw1 || !aw2) {
    Logger.log('_familyApprove_: KV write failed (aw1=' + aw1 + ' aw2=' + aw2 + ')');
    return { handled: true, replyText: '😬 לא הצלחתי לעדכן את הרישום (תקלת רשת). אשר שוב בעוד רגע.' };
  }
  kvDel('family:pending:' + familyId + ':' + requesterPhone);

  try {
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(requesterPhone, '✅ הצטרפת למשפחה. תוכלו לרשום הוצאות בקבוצה.');
    }
  } catch (e) { Logger.log('_familyApprove_: notify err ' + (e && e.message)); }

  return { handled: true, replyText: '✅ אושר' };
}

function _familyDeny_(adminPhone, requesterPhone) {
  var familyId = kvGet('family:of:' + adminPhone);
  if (!familyId) {
    return { handled: true, replyText: '😬 אינך מנהל משפחה\n💡 שלח "הקמת משפחה" כדי להקים אחת' };
  }
  kvDel('family:pending:' + familyId + ':' + requesterPhone);
  try {
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(requesterPhone, '😬 הבקשה נדחתה\n💡 פנה למנהל המשפחה לפרטים');
    }
  } catch (e) { Logger.log('_familyDeny_: notify err ' + (e && e.message)); }
  return { handled: true, replyText: '✅ נדחה' };
}

function _familyLogExpense_(fromPhone, member, amount, description) {
  var familyId = kvGet('family:of:' + fromPhone);
  if (!familyId) {
    return { handled: true, replyText: '😬 אינך חבר במשפחה\n💡 שלח "הקמת משפחה" או "הצטרפות למשפחה <קוד>"' };
  }
  var rec = kvGet('family:' + familyId);
  if (!rec || !rec.sheetId) {
    return { handled: true, replyText: '😬 גיליון המשפחה לא נמצא\n💡 צרו קשר עם המנהל' };
  }

  if (!amount || isNaN(amount) || amount <= 0) {
    return { handled: true, replyText: '😬 סכום לא תקין\n💡 תוודא שכתבת את הסכום בתחילת ההודעה' };
  }

  var matched = (typeof matchCategorySmart === 'function')
    ? matchCategorySmart(description)
    : { category: 'שונות', subcategory: 'שונות' };
  var category = (matched && matched.category) || 'שונות';

  try {
    var ss = SpreadsheetApp.openById(rec.sheetId);
    var sheet = ss.getSheetByName('Family Budget');
    if (!sheet) {
      return { handled: true, replyText: '😬 לא נמצאה לשונית "Family Budget" בגיליון המשפחה\n💡 המנהל צריך להריץ את ההתקנה הראשונית' };
    }
    var now = new Date();
    sheet.appendRow([
      now,
      sanitizeForSheet(String(member || '')),
      Math.abs(amount),
      sanitizeForSheet(category),
      sanitizeForSheet(String(description || ''))
    ]);
    // Original-text cell note — family sheet has 5 cols, description is col E (5).
    try {
      var __famRow = sheet.getLastRow();
      var __famRaw = (member || '—') + ': ' + amount + ' ' + (description || '');
      // setNote on column 5 (Description) for the family sheet.
      var __famNote = _kfl_buildOriginalNote('Original family expense', __famRaw, ['Phone: ' + fromPhone]);
      sheet.getRange(__famRow, 5).setNote(__famNote);
      Logger.log('_familyLogExpense_: note set on row ' + __famRow);
    } catch (__famNoteErr) { Logger.log('_familyLogExpense_ note err: ' + (__famNoteErr && __famNoteErr.message)); }
  } catch (e) {
    Logger.log('_familyLogExpense_: append err ' + (e && e.message));
    return { handled: true, replyText: '😬 משהו השתבש בכתיבה לגיליון המשפחה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
  }

  var memberLabel = String(member || '—');
  var categoryLabel = String(category || 'שונות');
  return { handled: true, replyText:
    '✅ נרשם למשפחה: ₪' + Math.abs(amount).toLocaleString('he-IL') +
    ' (' + memberLabel + ') — ' + categoryLabel
  };
}

function _familyReport_(fromPhone) {
  var familyId = kvGet('family:of:' + fromPhone);
  if (!familyId) {
    return { handled: true, replyText: '😬 אינך חבר במשפחה\n💡 שלח "הקמת משפחה" או "הצטרפות למשפחה <קוד>"' };
  }
  var rec = kvGet('family:' + familyId);
  if (!rec || !rec.sheetId) {
    return { handled: true, replyText: '😬 גיליון המשפחה לא נמצא\n💡 צרו קשר עם המנהל' };
  }

  var rows;
  try {
    var sheet = SpreadsheetApp.openById(rec.sheetId).getSheetByName('Family Budget');
    if (!sheet) return { handled: true, replyText: '😬 לא נמצאה לשונית "Family Budget"\n💡 המנהל צריך להריץ את ההתקנה הראשונית' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { handled: true, replyText: '📊 דו״ח משפחתי — חודש נוכחי\nאין הוצאות החודש.' };
    }
    rows = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  } catch (e) {
    return { handled: true, replyText: '😬 משהו השתבש בקריאה: ' + (e && e.message || '') + '\n💡 ננסה שוב בעוד דקה?' };
  }

  var now = new Date();
  var curY = now.getFullYear();
  var curM = now.getMonth();
  var totals = {};
  var grand = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var d = r[0];
    if (!(d instanceof Date)) {
      var pd = new Date(d);
      if (isNaN(pd.getTime())) continue;
      d = pd;
    }
    if (d.getFullYear() !== curY || d.getMonth() !== curM) continue;
    var member = String(r[1] || '—');
    var amt = parseFloat(r[2]) || 0;
    if (amt <= 0) continue;
    totals[member] = (totals[member] || 0) + amt;
    grand += amt;
  }

  var entries = [];
  for (var k in totals) if (Object.prototype.hasOwnProperty.call(totals, k)) {
    entries.push({ member: k, sum: totals[k] });
  }
  entries.sort(function (a, b) { return b.sum - a.sum; });

  var lines = ['📊 דו״ח משפחתי — חודש נוכחי', '━━━━━━━━━━━━━━━━━'];
  if (entries.length === 0) {
    lines.push('אין הוצאות החודש.');
  } else {
    for (var j = 0; j < entries.length; j++) {
      lines.push(entries[j].member + ': ₪' + entries[j].sum.toLocaleString('he-IL'));
    }
  }
  lines.push('━━━━━━━━━━━━━━━━━');
  lines.push('סה״כ: ₪' + grand.toLocaleString('he-IL'));
  return { handled: true, replyText: lines.join('\n') };
}

// --- Family helpers ----------------------------------------------------

function _familyGenerateId_() {
  // ASCII A-Z + 0-9; collision check is best-effort (KV roundtrip per try).
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (var attempt = 0; attempt < 5; attempt++) {
    var s = '';
    for (var i = 0; i < 6; i++) {
      s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    if (!kvGet('family:' + s)) return s;
  }
  // Give up on collision avoidance after 5 tries — extremely unlikely.
  return s;
}

function _familyDefaultMemberLabel_(fromPhone) {
  var p = String(fromPhone || '').replace(/\D/g, '');
  if (p.length >= 4) return p.slice(-4);
  return p || 'unknown';
}

function _familyNormalizeMember_(raw) {
  var m = String(raw || '').trim().toLowerCase();
  var map = {
    'אבא': 'אבא', 'אימא': 'אימא', 'אמא': 'אימא',
    'ילד1': 'ילד1', 'ילד2': 'ילד2', 'ילד3': 'ילד3',
    'dad': 'אבא', 'mom': 'אימא',
    'kid1': 'ילד1', 'kid2': 'ילד2', 'kid3': 'ילד3'
  };
  return map[m] || raw;
}


// ═══════════════════════════════════════════════════════════════════════════
// 🧠 ML AUDIT + SMART FEW-SHOT + SYNONYM EXPANSION (audit-driven learning)
// Added 2026-05-18. Five tasks:
//   1) _logMLAudit_         — append per-decision events to "ML Audit" tab
//   2) _buildSmartFewShot_  — pick top-12 high-signal examples by relevance
//   3) Confidence tiers     — 0.85 direct / 0.7 soft / 0.4 list-3 / <0.4 list-5
//   4) Anti-degradation     — flag >=3 corrections, ping admin
//   5) cronSynonymExpansion — daily LLM synonym expansion → "Auto Synonyms"
// All flows are best-effort: any failure is swallowed so they NEVER block the
// main expense write.
// ═══════════════════════════════════════════════════════════════════════════

var _ML_AUDIT_TAB        = 'ML Audit';
var _AUTO_SYN_TAB        = 'Auto Synonyms';
var _ML_AUDIT_HEADERS    = ['timestamp','user_text','amount','keyword_match_category','keyword_match_subcategory','ai_category','ai_confidence','final_category','final_subcategory','via','user_correction','needs_review','from_phone'];
var _AUTO_SYN_HEADERS    = ['synonym','canonical_text','category','subcategory','source','count','updated_at'];
var _AUTO_SYN_CACHE      = null;
var _AUTO_SYN_LOADED_AT  = 0;

// --- 1) ML Audit ----------------------------------------------------------

function _ensureMLAuditSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(_ML_AUDIT_TAB);
  if (!sh) {
    sh = ss.insertSheet(_ML_AUDIT_TAB);
    sh.appendRow(_ML_AUDIT_HEADERS);
    try { sh.setFrozenRows(1); } catch (_) {}
    try { sh.getRange(1, 1, 1, _ML_AUDIT_HEADERS.length).setFontWeight('bold'); } catch (_) {}
  }
  return sh;
}

/**
 * Append one learning event. eventData fields (all optional except user_text):
 *   user_text, amount, keyword_match_category, keyword_match_subcategory,
 *   ai_category, ai_confidence, final_category, final_subcategory,
 *   via ('keyword'|'ai'|'ambiguity_picked'|'manual_correction'|'cached'),
 *   user_correction (filled when user corrects), needs_review (bool),
 *   from_phone (string, may be empty)
 */
function _logMLAudit_(eventData) {
  try {
    if (!eventData || !eventData.user_text) return;
    var sh = _ensureMLAuditSheet_();
    var row = [
      new Date(),
      String(eventData.user_text || '').slice(0, 240),
      (typeof eventData.amount === 'number') ? eventData.amount : (eventData.amount || ''),
      eventData.keyword_match_category || '',
      eventData.keyword_match_subcategory || '',
      eventData.ai_category || '',
      (typeof eventData.ai_confidence === 'number') ? Math.round(eventData.ai_confidence * 1000) / 1000 : '',
      eventData.final_category || '',
      eventData.final_subcategory || '',
      eventData.via || '',
      eventData.user_correction || '',
      eventData.needs_review ? 'YES' : '',
      eventData.from_phone || ''
    ];
    sh.appendRow(row);
  } catch (e) {
    Logger.log('_logMLAudit_ err: ' + (e && e.message));
  }
}

/**
 * Count how many times this exact user_text has been corrected (final updated
 * by the user via 'manual_correction' or 'ambiguity_picked' AFTER an ai/keyword
 * decision). Used by anti-degradation guard. Returns 0 on any failure.
 */
function _countCorrectionsForText_(userText) {
  try {
    if (!userText) return 0;
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_ML_AUDIT_TAB);
    if (!sh) return 0;
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return 0;
    var width = Math.max(_ML_AUDIT_HEADERS.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, lastRow - 1, width).getValues();
    var needle = String(userText).toLowerCase().trim();
    var count = 0;
    for (var i = 0; i < data.length; i++) {
      var text = String(data[i][1] || '').toLowerCase().trim();
      if (text !== needle) continue;
      var via = String(data[i][9] || '');
      if (via === 'manual_correction' || via === 'ambiguity_picked') count++;
    }
    return count;
  } catch (e) {
    Logger.log('_countCorrectionsForText_: ' + e.message);
    return 0;
  }
}

function _adminAlertOnce_(message, fromPhone) {
  try {
    // Always alert the OWNER. Fall back to the OWNER_PHONE constant — NEVER
    // to the inbound sender (fromPhone) — so a security alert can't be
    // delivered to a stranger when SHEET_OWNER_PHONE happens to be unset.
    var admin = String(PropertiesService.getScriptProperties().getProperty('SHEET_OWNER_PHONE') || '').replace(/[^0-9]/g, '') || OWNER_PHONE;
    if (!admin) return;
    if (typeof sendWhatsAppMessage === 'function') {
      sendWhatsAppMessage(admin, message);
    }
  } catch (e) {
    Logger.log('_adminAlertOnce_ err: ' + e.message);
  }
}

// Bot-side helper: GET announcements via /api/announcements with bot-secret.
// Returns a formatted Hebrew reply with up to 3 recent feature announcements.
// Marks them as "seen" server-side so re-asking won't show the same ones.
function _fetchAnnouncements_(fromPhone) {
  try {
    var apiBase = PropertiesService.getScriptProperties().getProperty('KESEFLE_API_BASE') || 'https://kesefle.com';
    var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET');
    if (!botSecret) return null;
    var phoneClean = String(fromPhone || '').replace(/[^0-9]/g, '');
    var url = apiBase + '/api/announcements?phone=' + encodeURIComponent(phoneClean);
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'x-kesefle-bot-secret': botSecret },
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) return null;
    var j = null;
    try { j = JSON.parse(resp.getContentText()); } catch (_pe) {}
    if (!j || !j.ok || !j.announcements || !j.announcements.length) return null;
    var lines = ['📣 *מה חדש בכספ\'לה:*\n'];
    j.announcements.slice(0, 3).forEach(function (a) {
      lines.push('━━━━━━━━━━━━━━━━━━');
      lines.push('*' + (a.title || '').slice(0, 80) + '*');
      lines.push(String(a.body || '').slice(0, 400));
      if (a.ctaUrl && a.ctaLabel) {
        lines.push('👉 ' + a.ctaLabel + ': ' + a.ctaUrl);
      }
    });
    return lines.join('\n');
  } catch (e) {
    Logger.log('_fetchAnnouncements_ throw: ' + (e && e.message));
    return null;
  }
}

// Bot-side helper: POST an NPS score to /api/nps. Resolves phone->userSub
// via the same lookup pattern; uses the same bot-secret auth.
function _submitNps_(fromPhone, score, comment) {
  try {
    var apiBase = PropertiesService.getScriptProperties().getProperty('KESEFLE_API_BASE') || 'https://kesefle.com';
    var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET');
    if (!botSecret) return { ok: false, error: 'bot_secret_not_configured' };
    var userSub = null;
    try {
      if (typeof _kvLookupPhone_ === 'function') {
        var lookup = _kvLookupPhone_(fromPhone);
        if (lookup && lookup.userSub) userSub = lookup.userSub;
      }
    } catch (_lErr) {}
    if (!userSub) userSub = 'phone:' + String(fromPhone).replace(/[^0-9]/g, '');
    UrlFetchApp.fetch(apiBase + '/api/nps', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify({ userSub: userSub, score: score, comment: comment || '' }),
      muteHttpExceptions: true,
    });
    return { ok: true };
  } catch (e) {
    Logger.log('_submitNps_ throw: ' + (e && e.message));
    return { ok: false, error: 'exception' };
  }
}

// Bot-side helper: POST a testimonial to /api/testimonials. Resolves the
// phone -> userSub via the same bot-secret path that the budget/append
// helpers use, so we don't leak phone numbers into the public site.
function _submitTestimonial_(fromPhone, textBody) {
  try {
    var apiBase = PropertiesService.getScriptProperties().getProperty('KESEFLE_API_BASE') || 'https://kesefle.com';
    var botSecret = PropertiesService.getScriptProperties().getProperty('KESEFLE_BOT_SECRET');
    if (!botSecret) return { ok: false, error: 'bot_secret_not_configured' };
    // Resolve userSub via the existing _kvLookupPhone_ pattern (already used
    // elsewhere). Falls back to using the phone as a stable opaque key if the
    // user isn't fully registered yet -- still gives Steven a row to review.
    var userSub = null;
    try {
      if (typeof _kvLookupPhone_ === 'function') {
        var lookup = _kvLookupPhone_(fromPhone);
        if (lookup && lookup.userSub) userSub = lookup.userSub;
      }
    } catch (_lErr) {}
    if (!userSub) userSub = 'phone:' + String(fromPhone).replace(/[^0-9]/g, '');
    var resp = UrlFetchApp.fetch(apiBase + '/api/testimonials', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-kesefle-bot-secret': botSecret },
      payload: JSON.stringify({
        userSub: userSub,
        text: String(textBody || ''),
        name: '',
      }),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    Logger.log('_submitTestimonial_ HTTP ' + code + ': ' + String(resp.getContentText()).slice(0, 200));
    return { ok: false, status: code };
  } catch (e) {
    Logger.log('_submitTestimonial_ throw: ' + (e && e.message));
    return { ok: false, error: 'exception' };
  }
}

// First-expense celebration: returns a friendly suffix string the first time
// a particular phone successfully writes an expense, then an empty string
// every subsequent time. The flag is stored under 'fxcel:' + phone (dedup
// across the bot's whole lifetime) so we never double-celebrate.
function _celebrateIfFirstExpense_(fromPhone) {
  try {
    var p = String(fromPhone || '').replace(/[^0-9]/g, '');
    if (!p) return '';
    var props = PropertiesService.getScriptProperties();
    var key = 'fxcel:' + p;
    if (props.getProperty(key)) return '';
    props.setProperty(key, new Date().toISOString());
    return '\n\n🎉 זאת ההוצאה הראשונה שלך! מעכשיו כל הוצאה שתשלח תיכנס לגיליון אוטומטית.\n💡 טיפ: כתוב "/קבוע" כדי לסמן הוצאה חוזרת חודשית.';
  } catch (_e) { return ''; }
}

// Pre-classification check: does the user's message look like a support
// request that should go to a HUMAN, not the expense parser? If so, we skip
// LLM classification entirely and alert the owner. Conservative on purpose:
// only fires when the WHOLE message is a help phrase (10 chars or fewer)
// or when one of the strong escalation triggers shows up on its own line,
// so "אכלתי בבדיקה רפואית" doesn't accidentally escalate.
function _isSupportEscalation_(trimmedLowercaseText) {
  if (!trimmedLowercaseText || typeof trimmedLowercaseText !== 'string') return false;
  var t = trimmedLowercaseText.trim();
  if (!t) return false;
  // Strong: stand-alone short messages that are obviously a support call.
  // We allow up to 30 chars so "אני צריך נציג בבקשה" still triggers.
  var SHORT_TRIGGERS = [
    'נציג', 'אנושי', 'דבר עם בנאדם', 'מישהו', 'תמיכה', 'שירות לקוחות', 'בעיה',
    'תקלה דחופה', 'תקלה רצינית', 'help me', 'support', 'human', 'agent',
    'representative', 'איש קשר', 'איש שירות'
  ];
  if (t.length <= 30) {
    for (var i = 0; i < SHORT_TRIGGERS.length; i++) {
      if (t.indexOf(SHORT_TRIGGERS[i]) >= 0) return true;
    }
  }
  // Strong stand-alone phrases (any length, must be exact match or start-of-line).
  var EXACT = [
    'דבר איתי', 'תחזור אליי', 'תחזרו אליי', 'תחזור אלי', 'תחזרו אלי',
    'אני צריך עזרה', 'אני צריכה עזרה', 'יש לי בעיה', 'יש לי תקלה',
    'הבוט לא עובד', 'משהו לא עובד', 'שום דבר לא עובד'
  ];
  for (var j = 0; j < EXACT.length; j++) {
    if (t === EXACT[j] || t.indexOf(EXACT[j]) === 0) return true;
  }
  return false;
}

// --- 2) Smart few-shot construction --------------------------------------

/**
 * Tokenize a Hebrew/English string for overlap scoring. Strips digits, trims
 * tokens <2 chars, lowercases.
 */
function _smartTokenize_(text) {
  var t = String(text || '').toLowerCase();
  t = t.replace(/[0-9.,₪]/g, ' ').replace(/[^֐-׿a-z\s]/g, ' ');
  var parts = t.split(/\s+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p && p.length >= 2) out.push(p);
  }
  return out;
}

/**
 * Returns up to 12 high-signal few-shot examples for the current text.
 * Signal score per example = (recencyBoost + multiplicityBoost + lengthBoost
 * + overlapBoost). After scoring, dedup by lowercased text, sort by score,
 * take top 12, return ordered most-similar-first.
 */
function _buildSmartFewShot_(currentText) {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_LEARNED_TAB_NAME);
    if (!sh) return [];
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return [];
    var width = Math.max(5, sh.getLastColumn());
    var data = sh.getRange(2, 1, lastRow - 1, width).getValues();

    // 1) Walk newest→oldest, take last 20 'user*' source rows
    var rawPicked = [];
    var sevenDaysMs = 7 * 24 * 3600 * 1000;
    var nowMs = Date.now();
    for (var i = data.length - 1; i >= 0 && rawPicked.length < 20; i--) {
      var src = String(data[i][3] || '').toLowerCase();
      if (src.indexOf('user') < 0) continue;
      var kw = String(data[i][0] || '').trim();
      var cat = String(data[i][1] || '').trim();
      var sub = String(data[i][2] || '').trim();
      if (!kw || !cat || !sub) continue;
      if (cat === 'שונות' || cat === 'שונות ואחרים') continue;
      var ts = data[i][4];
      var tsMs = (ts instanceof Date) ? ts.getTime() : (ts ? new Date(ts).getTime() : nowMs);
      rawPicked.push({ text: kw, category: cat, subcategory: sub, tsMs: tsMs });
    }

    // 2) Dedup by lowercased text, keep newest record + count multiplicity
    var byText = {};
    for (var j = 0; j < rawPicked.length; j++) {
      var r = rawPicked[j];
      var key = r.text.toLowerCase();
      if (!byText[key]) {
        byText[key] = { text: r.text, category: r.category, subcategory: r.subcategory, tsMs: r.tsMs, multiplicity: 1 };
      } else {
        byText[key].multiplicity++;
        // keep newest timestamp
        if (r.tsMs > byText[key].tsMs) byText[key].tsMs = r.tsMs;
      }
    }

    // 3) Score each by signal components
    var currentTokens = _smartTokenize_(currentText);
    var currentTokenSet = {};
    for (var ct = 0; ct < currentTokens.length; ct++) currentTokenSet[currentTokens[ct]] = true;

    var scored = [];
    for (var k in byText) {
      var ex = byText[k];
      var ageMs = nowMs - ex.tsMs;
      var recencyBoost = (ageMs <= sevenDaysMs) ? 2.0 : 0.5;
      var multiplicityBoost = Math.min(3.0, ex.multiplicity);
      var lengthBoost = Math.min(1.5, ex.text.length / 30);
      var exTokens = _smartTokenize_(ex.text);
      var overlap = 0;
      for (var et = 0; et < exTokens.length; et++) if (currentTokenSet[exTokens[et]]) overlap++;
      var overlapBoost = overlap * 1.5; // strong signal — most-similar first
      var score = recencyBoost + multiplicityBoost + lengthBoost + overlapBoost;
      scored.push({ ex: ex, score: score, overlap: overlap });
    }

    // 4) Sort by overlap first (so most-similar appears first when injected),
    //    then by total score
    scored.sort(function(a, b) {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return b.score - a.score;
    });

    var top = scored.slice(0, 12).map(function(s) {
      return { text: s.ex.text, category: s.ex.category, subcategory: s.ex.subcategory };
    });
    return top;
  } catch (e) {
    Logger.log('_buildSmartFewShot_: ' + e.message);
    return [];
  }
}

// --- 5) Auto Synonyms lookup + cron --------------------------------------

function _ensureAutoSynonymsSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(_AUTO_SYN_TAB);
  if (!sh) {
    sh = ss.insertSheet(_AUTO_SYN_TAB);
    sh.appendRow(_AUTO_SYN_HEADERS);
    try { sh.setFrozenRows(1); } catch (_) {}
    try { sh.getRange(1, 1, 1, _AUTO_SYN_HEADERS.length).setFontWeight('bold'); } catch (_) {}
  }
  return sh;
}

function _autoSynonymsLoad_() {
  var now = Date.now();
  if (_AUTO_SYN_CACHE && (now - _AUTO_SYN_LOADED_AT < 60000)) return _AUTO_SYN_CACHE;
  var map = {};
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_AUTO_SYN_TAB);
    if (!sh) { _AUTO_SYN_CACHE = map; _AUTO_SYN_LOADED_AT = now; return map; }
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { _AUTO_SYN_CACHE = map; _AUTO_SYN_LOADED_AT = now; return map; }
    var width = Math.max(_AUTO_SYN_HEADERS.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < data.length; i++) {
      var syn = String(data[i][0] || '').toLowerCase().trim();
      var cat = String(data[i][2] || '').trim();
      var sub = String(data[i][3] || '').trim();
      if (!syn || !cat || !sub) continue;
      map[syn] = { category: cat, subcategory: sub };
    }
  } catch (e) {
    Logger.log('_autoSynonymsLoad_: ' + e.message);
  }
  _AUTO_SYN_CACHE = map;
  _AUTO_SYN_LOADED_AT = now;
  return map;
}

/**
 * Public lookup used by matchCategorySmart BEFORE static CATEGORY_MAP.
 * Returns {category, subcategory, fromAutoSyn:true} or null.
 */
function _autoSynonymLookup_(text) {
  var t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  var map = _autoSynonymsLoad_();
  if (map[t]) return { category: map[t].category, subcategory: map[t].subcategory, fromAutoSyn: true };
  var bestKw = null, bestLen = 0;
  for (var kw in map) {
    if (kw.length > bestLen && t.indexOf(kw) >= 0) { bestKw = kw; bestLen = kw.length; }
  }
  if (bestKw) return { category: map[bestKw].category, subcategory: map[bestKw].subcategory, fromAutoSyn: true };
  return null;
}

/**
 * Daily cron — reads top-50 most-corrected texts from ML Audit, asks Claude
 * for 5 Hebrew synonyms/misspellings each, writes to Auto Synonyms tab. Caps
 * 50 LLM calls/day (~$0.01–0.02). Skips synonyms already in Auto Synonyms or
 * exactly matching the canonical text.
 */
function cronSynonymExpansion() {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!apiKey) { Logger.log('cronSynonymExpansion: no API key'); return; }
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(_ML_AUDIT_TAB);
    if (!sh) { Logger.log('cronSynonymExpansion: no ML Audit tab yet'); return; }
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { Logger.log('cronSynonymExpansion: ML Audit empty'); return; }
    var width = Math.max(_ML_AUDIT_HEADERS.length, sh.getLastColumn());
    var data = sh.getRange(2, 1, lastRow - 1, width).getValues();

    // Aggregate: which texts were corrected most often
    var aggregate = {};
    for (var i = 0; i < data.length; i++) {
      var via = String(data[i][9] || '');
      if (via !== 'manual_correction' && via !== 'ambiguity_picked') continue;
      var text = String(data[i][1] || '').toLowerCase().trim();
      if (!text || text.length < 2) continue;
      var finalCat = String(data[i][7] || '').trim();
      var finalSub = String(data[i][8] || '').trim();
      if (!finalCat || !finalSub) continue;
      if (!aggregate[text]) aggregate[text] = { text: text, count: 0, category: finalCat, subcategory: finalSub };
      aggregate[text].count++;
      // update to the latest finalCategory mapping
      aggregate[text].category = finalCat;
      aggregate[text].subcategory = finalSub;
    }

    var list = [];
    for (var k in aggregate) list.push(aggregate[k]);
    list.sort(function(a, b) { return b.count - a.count; });
    list = list.slice(0, 50);
    if (!list.length) { Logger.log('cronSynonymExpansion: no corrections to expand'); return; }

    var synSheet = _ensureAutoSynonymsSheet_();
    var existing = _autoSynonymsLoad_();
    var addedTotal = 0;
    var llmCalls = 0;

    for (var p = 0; p < list.length; p++) {
      var item = list[p];
      var synonyms = _llmHebrewSynonyms_(item.text, apiKey);
      llmCalls++;
      if (!synonyms || !synonyms.length) continue;
      var nowDate = new Date();
      for (var s = 0; s < synonyms.length; s++) {
        var syn = String(synonyms[s] || '').toLowerCase().trim();
        if (!syn || syn.length < 2 || syn.length > 60) continue;
        if (syn === item.text) continue;
        if (existing[syn]) continue;
        synSheet.appendRow([syn, item.text, item.category, item.subcategory, 'llm', item.count, nowDate]);
        existing[syn] = { category: item.category, subcategory: item.subcategory };
        addedTotal++;
      }
      Utilities.sleep(250); // be polite to the API
    }
    _AUTO_SYN_LOADED_AT = 0; // invalidate cache
    Logger.log('cronSynonymExpansion: llmCalls=' + llmCalls + ' added=' + addedTotal + ' top=' + list.length);
  } catch (e) {
    Logger.log('cronSynonymExpansion err: ' + (e && e.stack || e));
  }
}

function _llmHebrewSynonyms_(text, apiKey) {
  try {
    var prompt = 'תן/י לי 5 מילים נרדפות, וריאציות איות או שגיאות הקלדה נפוצות בעברית של הביטוי: "' + text + '".\n' +
      'החזר/י JSON בלבד ללא הסבר: {"synonyms":["...","..."]}\n' +
      'הימנע/י ממילים גנריות מדי. ללא ניקוד. ללא הסברים.';
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return [];
    var body = JSON.parse(response.getContentText());
    var reply = (body.content && body.content[0] && body.content[0].text) || '';
    var m = String(reply).match(/\{[\s\S]*\}/);
    if (!m) return [];
    var parsed = JSON.parse(m[0]);
    if (!parsed.synonyms || !Array.isArray(parsed.synonyms)) return [];
    return parsed.synonyms;
  } catch (e) {
    Logger.log('_llmHebrewSynonyms_: ' + e.message);
    return [];
  }
}

function installSynonymExpansionTrigger() {
  // Remove existing triggers for this handler before installing a fresh one.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cronSynonymExpansion') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('cronSynonymExpansion').timeBased().everyDays(1).atHour(3).create();
  Logger.log('installSynonymExpansionTrigger: installed daily trigger @ 03:00');
  return '✅ trigger installed';
}

// ============================================================
// DASHBOARD FORMULA INSTALLERS — make every monthly cell a SUMIFS
// ============================================================
// Problem: when the user adds a row manually to תנועות (or any orders log),
// dashboard cells that were hardcoded values do NOT update. This module
// scans the company + personal dashboards and replaces HARDCODED VALUES
// (only) with SUMIFS formulas referencing the תנועות sheet. Existing
// formulas are LEFT ALONE (idempotency contract — running twice is safe).
//
// Public API:
//   installCompanyDashboardFormulas() -> { fixed, skippedFormulas, unmapped, perTab }
//   installPersonalDashboardFormulas() -> { fixed, skippedFormulas, unmapped, perTab }
//
// Both functions are listed in the Apps Script function dropdown.
//
// Safety contract per user feedback memory:
//   1. NEVER overwrite a cell that already contains a formula.
//   2. NEVER overwrite a cell with a non-numeric value (it might be a user note).
//   3. Log every write for audit (Logger.log).
//   4. Idempotent — second run is a no-op for cells already migrated.

// Internal: Hebrew month labels as they appear in dashboard headers.
var _DASH_HEB_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

// Internal: map of "row label appearing in column A" -> SUMIFS subcategory key
// used to query תנועות column E. Keys are the canonical labels Steven uses
// in מאזן חברה. Aliases collapse to the canonical sub.
var _COMPANY_ROW_SUB_MAP = {
  'מחזור': 'מחזור',
  'מחזור ברוטו': 'מחזור',
  'מחזור נטו': null,                  // derived: revenue - VAT, leave alone
  'עלות חומרי גלם': 'עלות חומרי גלם',
  'חומרי גלם': 'עלות חומרי גלם',
  'עלות שיווק': 'עלות שיווק',
  'שיווק': 'עלות שיווק',
  'משלוחים והתקנות': 'משלוחים והתקנות',
  'משלוחים': 'משלוחים והתקנות',
  'הוצאות תפעוליות': 'הוצאות תפעוליות',
  'תפעוליות': 'הוצאות תפעוליות',
  'יועצים': 'יועצים',
  'רווח גולמי': '__DERIVED_GROSS_PROFIT__',
  'רווח נטו': '__DERIVED_NET_PROFIT__'
};

// Helper: trim + normalize a cell label (strips bidi marks, NBSP, RTL/LTR
// embeds). Mirrors the cleanup _matchCategory does on user text.
function _dashNormalizeLabel_(s) {
  if (s == null) return '';
  var t = String(s).trim();
  t = t.replace(/[‎‏‪-‮ ]/g, '');
  t = t.replace(/\s+/g, ' ');
  return t;
}

// Helper: figure out the year for a dashboard tab.
//   1. tab name ends with 4-digit year (e.g. "מאזן חברה 2026") -> use it
//   2. B2 of the dashboard is a year-like number -> use it
//   3. fallback: current year
function _dashResolveYear_(sheet) {
  var name = sheet.getName();
  var m = name.match(/(20\d{2})/);
  if (m) return parseInt(m[1], 10);
  try {
    var v = sheet.getRange('B2').getValue();
    var n = parseInt(v, 10);
    if (n >= 2000 && n <= 2099) return n;
  } catch (e) {}
  return new Date().getFullYear();
}

// Helper: safely write a formula into a cell only if the cell currently
// holds a hardcoded value (not a formula). Returns 'fixed' | 'skip-formula'
// | 'skip-nonnumeric' | 'skip-already' for audit logging.
function _safeReplaceWithFormula_(cell, newFormula, ctxLabel) {
  var existingFormula = '';
  try { existingFormula = String(cell.getFormula() || ''); } catch (e) {}
  if (existingFormula && existingFormula.charAt(0) === '=') {
    if (existingFormula === newFormula) {
      Logger.log('[dashFx] ' + ctxLabel + ' ' + cell.getA1Notation() + ' already correct - skip');
      return 'skip-already';
    }
    Logger.log('[dashFx] ' + ctxLabel + ' ' + cell.getA1Notation() + ' has custom formula - preserve: ' + existingFormula);
    return 'skip-formula';
  }
  var v = null;
  try { v = cell.getValue(); } catch (e) {}
  // Allow empty cells and numeric cells. Block text cells (might be user note).
  if (v !== '' && v !== null && typeof v !== 'number') {
    Logger.log('[dashFx] ' + ctxLabel + ' ' + cell.getA1Notation() + ' has non-numeric "' + v + '" - preserve');
    return 'skip-nonnumeric';
  }
  cell.setFormula(newFormula);
  Logger.log('[dashFx] ' + ctxLabel + ' ' + cell.getA1Notation() + ' <- ' + newFormula + ' (was ' + (v === '' || v == null ? 'empty' : v) + ')');
  return 'fixed';
}

// Public: install SUMIFS formulas in the company balance dashboard(s).
// Walks every monthly column for every metric row in the canonical map.
// Returns counters + per-tab breakdown.
function installCompanyDashboardFormulas() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var dashNames = ['מאזן חברה 2026', 'מאזן חברה'];
  var summary = { fixed: 0, skippedFormulas: 0, unmapped: 0, skippedNonNumeric: 0, perTab: {} };
  var anyFound = false;

  for (var d = 0; d < dashNames.length; d++) {
    var sheet = ss.getSheetByName(dashNames[d]);
    if (!sheet) continue;
    anyFound = true;
    var tabKey = dashNames[d];
    var tabStat = { fixed: 0, skippedFormulas: 0, unmapped: 0, skippedNonNumeric: 0, derived: 0 };
    var year = _dashResolveYear_(sheet);
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 2) {
      Logger.log('[dashFx] ' + tabKey + ' empty - skip');
      summary.perTab[tabKey] = tabStat;
      continue;
    }

    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

    // Phase 1: locate the header row + the month columns.
    // The header is the row that contains the most Hebrew month names.
    var headerRow = -1;
    var monthCols = {}; // monthLabel -> 0-based col index
    var bestHits = 0;
    for (var r = 0; r < Math.min(values.length, 30); r++) {
      var hits = 0;
      var localCols = {};
      for (var c = 0; c < values[r].length; c++) {
        var label = _dashNormalizeLabel_(values[r][c]);
        for (var mi = 0; mi < _DASH_HEB_MONTHS.length; mi++) {
          if (label === _DASH_HEB_MONTHS[mi]) {
            localCols[_DASH_HEB_MONTHS[mi]] = c;
            hits++;
            break;
          }
        }
      }
      if (hits > bestHits) {
        bestHits = hits;
        headerRow = r;
        monthCols = localCols;
      }
    }
    if (headerRow < 0 || bestHits < 6) {
      Logger.log('[dashFx] ' + tabKey + ' no month-header row detected (hits=' + bestHits + ') - skip');
      summary.perTab[tabKey] = tabStat;
      continue;
    }
    Logger.log('[dashFx] ' + tabKey + ' header row=' + (headerRow + 1) + ' months=' + Object.keys(monthCols).length + ' year=' + year);

    // Phase 2: locate every metric row by scanning column A below the header.
    var metricRows = {}; // canonSub -> [rowIndex0Based, ...]
    var derivedRows = { gross: [], net: [] }; // rows for רווח גולמי / רווח נטו
    for (var rr = headerRow + 1; rr < values.length; rr++) {
      var rowLabel = _dashNormalizeLabel_(values[rr][0]);
      if (!rowLabel) continue;
      if (!_COMPANY_ROW_SUB_MAP.hasOwnProperty(rowLabel)) continue;
      var canon = _COMPANY_ROW_SUB_MAP[rowLabel];
      if (canon === null) continue; // explicit "leave alone"
      if (canon === '__DERIVED_GROSS_PROFIT__') { derivedRows.gross.push(rr); continue; }
      if (canon === '__DERIVED_NET_PROFIT__') { derivedRows.net.push(rr); continue; }
      if (!metricRows[canon]) metricRows[canon] = [];
      metricRows[canon].push(rr);
    }

    if (Object.keys(metricRows).length === 0 && derivedRows.gross.length === 0 && derivedRows.net.length === 0) {
      Logger.log('[dashFx] ' + tabKey + ' no recognized metric rows - skip');
      tabStat.unmapped = lastRow - headerRow - 1;
      summary.perTab[tabKey] = tabStat;
      continue;
    }

    // Phase 3: install SUMIFS for direct metric rows.
    for (var canonSub in metricRows) {
      var rowsForSub = metricRows[canonSub];
      for (var ri = 0; ri < rowsForSub.length; ri++) {
        var rowIdx0 = rowsForSub[ri];
        for (var monthLabel in monthCols) {
          var colIdx0 = monthCols[monthLabel];
          var monthIdx1 = _DASH_HEB_MONTHS.indexOf(monthLabel) + 1; // 1..12
          var monthKey = year + '-' + (monthIdx1 < 10 ? '0' + monthIdx1 : '' + monthIdx1);
          var cell = sheet.getRange(rowIdx0 + 1, colIdx0 + 1);
          // Use IFERROR to keep cell numeric even if no matches yet.
          var f = '=IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "' + canonSub + '", תנועות!B:B, "' + monthKey + '"), 0)';
          var res = _safeReplaceWithFormula_(cell, f, tabKey + '/' + canonSub + '/' + monthLabel);
          if (res === 'fixed') { summary.fixed++; tabStat.fixed++; }
          else if (res === 'skip-formula' || res === 'skip-already') { summary.skippedFormulas++; tabStat.skippedFormulas++; }
          else if (res === 'skip-nonnumeric') { summary.skippedNonNumeric++; tabStat.skippedNonNumeric++; }
        }
      }
    }

    // Phase 4: derived rows (רווח גולמי / רווח נטו). These depend on the
    // existence of the source metric rows we just located.
    function _colLetter_(c) {
      // c is 1-based column index. Convert to A1 letter (A..ZZ).
      var s = '';
      while (c > 0) {
        var rem = (c - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        c = Math.floor((c - 1) / 26);
      }
      return s;
    }
    function _firstRowFor_(sub) {
      var arr = metricRows[sub];
      return (arr && arr.length) ? (arr[0] + 1) : null; // 1-based
    }

    var rRev = _firstRowFor_('מחזור');
    var rRaw = _firstRowFor_('עלות חומרי גלם');
    var rMkt = _firstRowFor_('עלות שיווק');
    var rShip = _firstRowFor_('משלוחים והתקנות');
    var rOps = _firstRowFor_('הוצאות תפעוליות');

    // רווח גולמי = מחזור - עלות חומרי גלם
    for (var gi = 0; gi < derivedRows.gross.length; gi++) {
      var gRow0 = derivedRows.gross[gi];
      for (var gMonth in monthCols) {
        var gCol1 = monthCols[gMonth] + 1;
        var gCellLetter = _colLetter_(gCol1);
        if (!rRev || !rRaw) {
          summary.unmapped++; tabStat.unmapped++;
          Logger.log('[dashFx] ' + tabKey + '/רווח גולמי/' + gMonth + ' missing source rows - skip');
          continue;
        }
        var gCell = sheet.getRange(gRow0 + 1, gCol1);
        var gF = '=' + gCellLetter + rRev + '-' + gCellLetter + rRaw;
        var gRes = _safeReplaceWithFormula_(gCell, gF, tabKey + '/רווח גולמי/' + gMonth);
        if (gRes === 'fixed') { summary.fixed++; tabStat.fixed++; tabStat.derived++; }
        else if (gRes === 'skip-formula' || gRes === 'skip-already') { summary.skippedFormulas++; tabStat.skippedFormulas++; }
        else if (gRes === 'skip-nonnumeric') { summary.skippedNonNumeric++; tabStat.skippedNonNumeric++; }
      }
    }

    // רווח נטו = רווח גולמי - שיווק - משלוחים - תפעוליות
    // (We compute it from primitives, not from a possibly stale gross row,
    //  so the chain is robust even if gross row is missing.)
    for (var ni = 0; ni < derivedRows.net.length; ni++) {
      var nRow0 = derivedRows.net[ni];
      for (var nMonth in monthCols) {
        var nCol1 = monthCols[nMonth] + 1;
        var nLetter = _colLetter_(nCol1);
        if (!rRev || !rRaw) {
          summary.unmapped++; tabStat.unmapped++;
          continue;
        }
        var nParts = [nLetter + rRev, '-' + nLetter + rRaw];
        if (rMkt) nParts.push('-' + nLetter + rMkt);
        if (rShip) nParts.push('-' + nLetter + rShip);
        if (rOps) nParts.push('-' + nLetter + rOps);
        var nF = '=' + nParts.join('');
        var nCell = sheet.getRange(nRow0 + 1, nCol1);
        var nRes = _safeReplaceWithFormula_(nCell, nF, tabKey + '/רווח נטו/' + nMonth);
        if (nRes === 'fixed') { summary.fixed++; tabStat.fixed++; tabStat.derived++; }
        else if (nRes === 'skip-formula' || nRes === 'skip-already') { summary.skippedFormulas++; tabStat.skippedFormulas++; }
        else if (nRes === 'skip-nonnumeric') { summary.skippedNonNumeric++; tabStat.skippedNonNumeric++; }
      }
    }

    summary.perTab[tabKey] = tabStat;
  }

  if (!anyFound) {
    Logger.log('[dashFx] no company dashboard tab found (looked for: ' + dashNames.join(', ') + ')');
  }

  Logger.log('[dashFx] installCompanyDashboardFormulas DONE: ' +
    'fixed=' + summary.fixed +
    ' skippedFormulas=' + summary.skippedFormulas +
    ' skippedNonNumeric=' + summary.skippedNonNumeric +
    ' unmapped=' + summary.unmapped);
  return summary;
}

// Public: install SUMIFS in the personal balance dashboard(s). Layout is
// simpler: column A holds the subcategory name verbatim (e.g. "אוכל לבית"),
// and columns C..N are months Jan..Dec for the year recorded in B2.
// This is the same layout that migrateDashboardToSUMIFS() targets; we keep
// our own implementation so we can be strict about NOT overwriting custom
// formulas / non-numeric cells (the legacy migrator overwrites every cell).
function installPersonalDashboardFormulas() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var dashNames = ['מאזן שנתי', 'מאזן אישי'];
  var summary = { fixed: 0, skippedFormulas: 0, unmapped: 0, skippedNonNumeric: 0, perTab: {} };

  // Section headers / rows we must NOT touch (they are aggregates or labels,
  // not category rows). Same list migrateDashboardToSUMIFS uses, plus a few
  // safety guards.
  var SKIP_LABELS = {
    'הכנסות': 1, 'הוצאות': 1, 'הוצאות קבועות': 1, 'הוצאות זמניות': 1,
    'אוכל': 1, 'תחבורה': 1, 'תחזוקה': 1, 'תמורה': 1,
    'שונות ואחרים': 1, 'שונות': 1, 'קטגוריה': 1,
    'מאזן אישי': 1, 'מאזן שנתי': 1, 'מאזן חברה': 1,
    'סה"כ': 1, 'סה"כ הכנסות': 1, 'סה"כ הוצאות': 1, 'מאזן': 1, 'תקציב': 1
  };

  for (var d = 0; d < dashNames.length; d++) {
    var sheet = ss.getSheetByName(dashNames[d]);
    if (!sheet) continue;
    var tabKey = dashNames[d];
    var tabStat = { fixed: 0, skippedFormulas: 0, unmapped: 0, skippedNonNumeric: 0 };
    var year = _dashResolveYear_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 4) {
      summary.perTab[tabKey] = tabStat;
      continue;
    }
    var monthCols = [3,4,5,6,7,8,9,10,11,12,13,14]; // C..N
    var colA = sheet.getRange(1, 1, lastRow, 1).getValues();
    for (var r = 3; r < colA.length; r++) { // skip first 3 rows (title + year + header)
      var rowLabel = _dashNormalizeLabel_(colA[r][0]);
      if (!rowLabel) continue;
      if (rowLabel.indexOf('סה') === 0) continue; // any "סה"כ ..." aggregate row
      if (SKIP_LABELS.hasOwnProperty(rowLabel)) continue;
      var rowOneBased = r + 1;
      for (var mi = 0; mi < monthCols.length; mi++) {
        var col = monthCols[mi];
        var monthIdx1 = mi + 1;
        var monthKey = year + '-' + (monthIdx1 < 10 ? '0' + monthIdx1 : '' + monthIdx1);
        var cell = sheet.getRange(rowOneBased, col);
        var f = '=IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, $A' + rowOneBased + ', תנועות!B:B, "' + monthKey + '"), 0)';
        var res = _safeReplaceWithFormula_(cell, f, tabKey + '/' + rowLabel + '/' + _DASH_HEB_MONTHS[mi]);
        if (res === 'fixed') { summary.fixed++; tabStat.fixed++; }
        else if (res === 'skip-formula' || res === 'skip-already') { summary.skippedFormulas++; tabStat.skippedFormulas++; }
        else if (res === 'skip-nonnumeric') { summary.skippedNonNumeric++; tabStat.skippedNonNumeric++; }
      }
    }
    summary.perTab[tabKey] = tabStat;
  }

  Logger.log('[dashFx] installPersonalDashboardFormulas DONE: ' +
    'fixed=' + summary.fixed +
    ' skippedFormulas=' + summary.skippedFormulas +
    ' skippedNonNumeric=' + summary.skippedNonNumeric +
    ' unmapped=' + summary.unmapped);
  return summary;
}
