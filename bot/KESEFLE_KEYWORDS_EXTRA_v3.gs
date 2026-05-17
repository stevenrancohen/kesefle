// KESEFLE_KEYWORDS_EXTRA_v3.gs
// Extends KESEFLE_KEYWORDS (defined in KESEFLE_KEYWORDS_v2.gs) with
// additional Israeli vendors, slang, and brand-new categories.
// Do NOT replace v2 - run INSTALL_EXTRA_KEYWORDS_v3() once and the
// existing _SRC_classify_v2_ classifier will pick up all new patterns.
//
// Safety:
//  - Idempotent: re-running de-duplicates against existing pools.
//  - Never overwrites v2 entries; only appends new keywords/brands.
//  - Logs per-category add counts for audit.

// Extra keyword pools keyed by the EXISTING v2 keys in KESEFLE_KEYWORDS.
// Anything routed here is appended into the v2 entry's brands array
// (brands match identically to keywords inside _SRC_classify_v2_).
var KESEFLE_EXTRA_TO_EXISTING = {
  // 1) Coffee / cafes - extends אוכל_בחוץ
  'אוכל_בחוץ_COFFEE': {
    target_key: 'אוכל_בחוץ',
    target_pool: 'brands',
    items: [
      'cafe cafe','café café','קפה קפה','קפה הפוך','קפה שחור','קפה עם חלב','קפה קר','קפה קפוא','קפסולה','קפסולת קפה','nespresso','נספרסו','illy','אילי','lavazza','לוואצה','jacobs','elite coffee','עלית קפה','קפה עלית',
      'roladin','רולדין','greg cafe','greg café','גרג קפה','lehem erez','לחם ארז','tamara','תמרה','boutique central','בוטיק סנטרל','aroma espresso','ארומה אספרסו',
      'arcaffe','ארקפה','japanika cafe','cafelix','קפליקס','cafeneto','קפנטו','קפה ג׳ו','cafe joe','cafe bialik','beit hakafe','בית הקפה','rolladin','עוגיפלצת','ben yehuda cafe','cofizz','קופיז','cofix','קופיקס','אספרסו בר','espresso bar','קפה איטלקי','italian coffee','קפה הפוך גדול','אמריקנו','americano','מקיאטו','macchiato','flat white','מוקה','mocha','קפה טורקי','turkish coffee','קפה ערבי','arabic coffee','חליטת תה','herbal tea','מאצ׳ה','matcha','שייק','smoothie','שייק חלבון','protein shake'
    ]
  },

  // 2) Restaurants / delivery - extends אוכל_בחוץ (different bucket)
  'אוכל_בחוץ_DELIVERY': {
    target_key: 'אוכל_בחוץ',
    target_pool: 'brands',
    items: [
      'cibus','סיבוס','tenbis','10bis','תן ביס','ten-bis','pluxee','פלאקסי','פלקסי','משלוח אוכל','food delivery','wolt drive','wolt market','וולט מרקט','glovo','גלובו',
      'pizza hut','פיצה האט','pizza domino','domino pizza','dominos','דומינוס פיצה','pizza street','פיצה סטריט','פיצה רומא','pizza roma','tony vespa','טוני וספה','vaniglia','ונילה','אבו גוש','abu ghosh','אבו חסן','abu hassan','המקום של ברוטה','agadir','אגאדיר','black bar n burger','בלאק','moses','מוזס','bbb','בורגר ראנץ','burger ranch','burgerim','בורגרים','vitrina','ויטרינה','M25','שמונה ארבעים','עזה 40',
      'mcdonalds','מקדונלדס','burger king','בורגר קינג','kfc','קנטקי','popeyes','פופאיז','subway','סאבוויי','dunkin','dunkin donuts','דאנקין','israeli salad','סלט','שווארמה','שוארמה','שוורמה','אבו חסן','שיפודי','שיפוד','ag','חומוס אליהו','חומוס פול','חומוס משולם','פלאפל','falafel','פלאפל גינה','פלאפל החצב','פלאפל ברדק','גוואפה','guava','japanika','ג׳פניקה','sushi rehavia','suchi','ramen','ראמן','ראמן בר','dim sum','דים סאם','wok','dragon','דרגון','vong','קימצ׳י','kimchi','קוריאני','korean','thai','תאי','תאילנדי','indian','הודי','mexican','מקסיקני','tacos','טאקוס','tortilla','טורטיה','tacombi','quesadilla','קסדייה','ceviche','סביצה','ramen bar','udon','אודון','poke','פוקה','poke bowl','salad bar','סלטים','שופ סלט'
    ]
  },

  // 3) Groceries - extends אוכל_לבית
  'אוכל_לבית_EXTRA': {
    target_key: 'אוכל_לבית',
    target_pool: 'brands',
    items: [
      'shufersal online','שופרסל אונליין','שופרסל אקספרס','shufersal express','שופרסל דיל','shufersal deal','שופרסל שלי','שופרסל יש','yochananof','יוחננוף','יוחננוף בשכונה','rami levy','רמי לוי','rami levy online','carrefour','carrefour express','קרפור','קרפור אקספרס','am pm','am:pm','ampm','superyuda','סופריודה','סופר יודה','tiv taam','טיב טעם','mega','מגה בעיר','mega in town','victory','ויקטוריה','ויקטורי','osher ad','אושר עד','חצי חינם','hatzi hinam','קינג סטור','king store','שוק העיר','my market','my-market','קוסטקו','costco','sams club','אצל פלוס',
      'מכולת','מינימרקט','minimarket','חנות שכונתית','קונדיטוריה','confectionery','מאפיית','אנג׳ל','angel','ירקן','ירקות','פירות','greengrocer','קצב','קצביה','butcher','דגים','fish','שוק מחנה יהודה','machane yehuda','שוק הכרמל','carmel market','שוק לוינסקי','levinsky','שוק רמלה','tnuva','תנובה','שטראוס','strauss','עלית','elit','אסם','osem','telma','תלמה','sano','סנו','soglowek','סוגלובק','of tov','עוף טוב','zoglobek','זוגלובק','milky','tara','תרא','בית השיטה','בית קמא','sabra','צבר','sabra hummus','tomer','תומר','איטלקייה','italki'
    ]
  },

  // 4) Gas - extends דלק
  'דלק_EXTRA': {
    target_key: 'דלק',
    target_pool: 'brands',
    items: [
      'paz','פז','פז יסלמש','פז גולד','paz gold','דלק חברת הדלק','sonol','סונול','שטיינר','ten','טן','תן','dor alon','דור אלון','dor-alon','אלונית','alonit','yellow','ילו','מנטה','menta','מנטה מרקט','bp','בי פי','total','totalenergies','טוטאל','revadim','רבדים','קוסקו רישוי','תחנת תדלוק','gas station israel','חטיב','דלק 95','דלק 98','דלקן','דלק ישיר','דלק בקבוק','פז express','paz express','כביש 6','road 6 fuel'
    ]
  },

  // 5) Transport / taxis - extends תחבורה_ציבורית + מוניות + חניה
  'תחבורה_ציבורית_EXTRA': {
    target_key: 'תחבורה_ציבורית',
    target_pool: 'keywords',
    items: [
      'egged','אגד','אגד טבעות','dan','דן','דן צפון','דן בדרום','metropoline','מטרופולין','metropolin','superbus','סופרבוס','קווים','kavim','אפיקים','afikim','ירושלים נסיעות','jerusalem transport','קל ברק','red line','כחול לבן','מטרו תל אביב','tel aviv metro','metro tlv','קו 1','קו 4','קו 5','קו 18','קו 24','train ticket','כרטיס רכבת','חופשי חודשי','חופשי-חודשי','student rav kav','רב קו סטודנט','מקדם תחבורה','תח״צ','tachatz','israel rail','rakevet israel','רכבת ישראל','מטרו ירושלים','jlm light rail','jerusalem light rail','citipass','סיטיפס'
    ]
  },
  'מוניות_EXTRA': {
    target_key: 'מוניות',
    target_pool: 'keywords',
    items: [
      'gett','גט טקסי','gett taxi','yango','יאנגו','yandex go','onbi','אונבי','itaxi','אי טקסי','marbei','מרבי','tarif אחיד','מונית הזמנה','call taxi','קול טקסי','שירות מוניות','מונית מהירה','מונית שירות','sherut taxi','שירות תחנה','נסיעה משותפת','sharing ride'
    ]
  },
  'חניה_EXTRA': {
    target_key: 'חניה',
    target_pool: 'keywords',
    items: [
      'pango','פנגו','cellopark','סלופארק','easypark','איזיפארק','אחוזות החוף','ahuzot hahof','park24','autopark','tel aviv parking','חניון ספיר','חניון עזריאלי','חניון דיזנגוף','חניון רכבת','חניון נתב״ג','חניון ביגה','חניון עירוני','municipal parking','כחול לבן חניה','blue white parking','חניה תושב','resident parking','חניית רחוב','street parking','חניית נכים','disabled parking'
    ]
  },

  // 6) Subscriptions - extends אפליקציות
  'אפליקציות_EXTRA': {
    target_key: 'אפליקציות',
    target_pool: 'brands',
    items: [
      'netflix israel','netflix premium','spotify family','spotify premium','spotify duo','youtube music','youtube premium family','apple music family','apple one family','disney+ israel','apple tv+','apple tv plus','amazon prime video','amazon prime','paramount+','paramount plus','peacock','hbo go','starz','shudder','crunchyroll','funimation',
      'office 365 personal','microsoft 365','microsoft 365 family','adobe creative cloud all apps','adobe stock','notion plus','notion ai','chatgpt plus','chatgpt team','claude pro','claude max','claude team','cursor pro','cursor business','github copilot','github pro','linear','linear plus','figma professional','figma organization','vercel pro','vercel team','heroku','heroku dynos','cloudflare pro','cloudflare workers','digitalocean','linode','aws','aws subscription','aws billing','gcp','google cloud','azure','azure subscription',
      'duolingo','duolingo super','duolingo plus','headspace','calm','strava','strava premium','myfitnesspal','peloton','fitbit premium','garmin connect+','grammarly','grammarly premium','deepl','deepl pro','superhuman','readwise','raindrop','pocket','feedly','flipboard','medium','medium membership','substack','patreon','onlyfans','twitch subscription','discord nitro','telegram premium','slack pro','slack business'
    ]
  },

  // 7) Health - extends בריאות
  'בריאות_EXTRA': {
    target_key: 'בריאות',
    target_pool: 'keywords',
    items: [
      'קופת חולים','kupat holim','clalit mushlam','clalit platinum','כללית מושלם','כללית פלטינום','maccabi sheli','מכבי שלי','maccabi zahav','מכבי זהב','meuhedet adif','מאוחדת עדיף','leumit zahav','לאומית זהב','meuchedet','leumit',
      'רופא שיניים','dentist','שורש','root canal','כתר','crown','שתל','dental implant','מקצה לקצה','dental check-up','אופטיקה','optic','אופטיקה הלפרין','optic halperin','שלמה אופטיקה','optic shlomo','קרל אופטיקה','grand optic','optic mor','עדשות מולטיפוקל','progressive lenses','עדשות מגע','contact lens',
      'פיזיותרפיה','physical therapy','קלמנט','קלינמט','מטפל','therapist','פסיכותרפיה','psychotherapy','פסיכולוג קליני','clinical psychologist','psychiatrist','פסיכיאטר','עבודה סוציאלית','social worker','דיאטנית','דיאטנית קלינית','clinical dietitian','תזונה','nutrition','אימון בריאות','health coach',
      'תרופות','תרופה','medicine','prescription','generic','גנרי','be pharm','בי פארם','life pharma','life פארם','super pharm','סופר פארם','ניופארם','newpharm','life style','life-style','פארם הילד','pharm','בית מרקחת','farmacy','farmasi','perfectage','perfect age'
    ]
  },

  // 8) Banking - extends עמלות_בנק + חיסכון_השקעות
  'עמלות_בנק_EXTRA': {
    target_key: 'עמלות_בנק',
    target_pool: 'keywords',
    items: [
      'עמלת ניהול חשבון','account management fee','עמלת ניהול ני״ע','עמלת ני״ע','עמלת מסחר','trading fee','עמלת רכישה','עמלת מכירה','ריבית חשבון','account interest','ריבית חובה','overdraft','אוברדראפט','משיכת יתר','עמלת משיכה','withdrawal fee','עמלת הפקדה','עמלת המחאה','check fee','עמלת ביטול','cancellation fee','כרטיס אשראי','credit card fee','חיוב כרטיס','card charge','חיוב חודשי','monthly charge','הוראת קבע','standing order','הוראת חיוב','direct debit','המחאה','check','שיק','המחאות','הפקדת שיק','פקדון','deposit','פיקדון','פיקדון בנקאי','bank deposit','משכנתא','mortgage payment','החזר משכנתא','mortgage repayment','ביטוח חיים','life insurance fee','פנסיה','pension contribution','קופת גמל','provident fund','קרן השתלמות','study fund'
    ]
  },

  // 9) Communications - extends תקשורת
  'תקשורת_EXTRA': {
    target_key: 'תקשורת',
    target_pool: 'keywords',
    items: [
      'cellcom','סלקום','cellcom tv','סלקום tv','pelephone','פלאפון','partner','פרטנר','partner tv','פרטנר tv','hot mobile','הוט מובייל','hot.net','hot net','019 mobile','019 telecom','golan telecom','גולן טלקום','rami levy communications','רמי לוי תקשורת','019','019 שיחות','012 smile','012 סמייל','013 netvision','013 נטוויז'+'ן','bezeq','בזק','bezeq international','בזק בינלאומי','triple c','smile','telzar','תלזר','קווים בינלאומיים','international calls','שיחת חוץ','שיחות חוץ','ברודבאנד','broadband','fiber optic','סיב אופטי','fiber 1000','גיגה','gigabit','אופטי 1000','אינטרנט סלולרי','mobile internet','data plan','חבילת גלישה','חבילת דאטה','data package',
      'טלוויזיה','tv subscription','yes max','יס מקס','yes plus','יס פלוס','hot box','הוט בוקס','hot vod','cellcom tv box','partner tv box','כבלים','cable tv','dvb-t','israel broadcasting','כאן','kan','reshet 13','ערוץ 12','channel 12','channel 13','ערוץ 14','channel 14','my tv','sting','starlink','סטרלינק'
    ]
  },

  // 10) Utilities - extends בית
  'בית_UTILITIES': {
    target_key: 'בית',
    target_pool: 'keywords',
    items: [
      'חשבון חשמל','electricity bill','iec','israel electric','חברת חשמל','חברת החשמל','energean','אנרג׳יאן','noga electricity','נגה',
      'חשבון מים','water bill','מי אביבים','mei avivim','מי שבע','mei sheva','hagihon','הגיחון','tagidim','תאגיד מים','mei eden','מי עדן','mei carmel','מי כרמל',
      'ארנונה','arnona','property tax','arnona tel aviv','ארנונה תל אביב','ארנונה ירושלים','jerusalem property tax','ועד בית','building committee','vaad bayit','ועד בניין','vaad binyan','מנהל אחזקה','maintenance committee',
      'גז','gas bill','pazgas','פזגז','supergas','סופרגז','amisragas','אמישראגז','אמישראגז שטיינר','דורגז','dorgas','solgas','סולגז','גז ביתי','home gas','בלון גז','gas balloon','גז טבעי','natural gas'
    ]
  },

  // 11) Family / kids - extends ילדים
  'ילדים_EXTRA': {
    target_key: 'ילדים',
    target_pool: 'keywords',
    items: [
      'צהרון','tzaharon','tzaharonim','גן ילדים','gan yeladim','גן עירוני','public preschool','גנון פרטי','private preschool','מעון יום','daycare','daycare center','בייביסיטר','babysitter','שמרטף','שמרטפית','baby sitter','אומנת','nanny','מטפלת','metapelet','משחקייה','playroom','indoor playground','חוג ספורט','sports class','חוג ציור','art class','חוג מוזיקה','music class','חוג ג׳ודו','judo class','חוג שחייה','swim class','חוג בלט','ballet class','חוג רובוטיקה','robotics class','קייטנה קיץ','summer camp','קייטנת פסח','passover camp','חוג אחרי הצהריים','afternoon class',
      'טיפת חלב','tipat halav','well baby clinic','בריאות הילד','child health','חיסון תינוק','baby vaccine','mom','אמא','אמי','grandma','סבתא','grandpa','סבא','סבא וסבתא','grandparents','ילד 1','ילד 2','ילדה 1','ילדה 2','first child','second child','child 1','child 2','toy r us','toys r us','toysrus','טויס אר אס','imaginarium','ימגינריום','שעשועי הילדים','kids fun','little tikes','melissa & doug','melissa and doug','שילב','shilav baby','משחק חינוכי','educational toy','ספר ילדים','children book','גלובוס מתנפח','inflatable'
    ]
  },

  // 12) Entertainment - extends בידור
  'בידור_EXTRA': {
    target_key: 'בידור',
    target_pool: 'keywords',
    items: [
      'cinema city','סינמה סיטי','yes planet','יס פלאנט','planet cinemas','rav-hen','רב חן','globus max','גלובוס מקס','globus','glamour','לב סינמה','lev cinema','קולנוע לב','התיאטרון הלאומי','national theatre','הבימה','בית ליסין','beit lessin','גשר','gesher','הקאמרי','cameri','israel opera','אופרה ישראל','בית האופרה','tel aviv opera','המשכן לאמנויות','center for performing arts','ticketmaster','טיקטמסטר','eventim','איוונטים','tickets.co.il','כרטיסים','leaan','לאן','tmura','תמורה','barby','בארבי','zappa','זאפה','שבלול','blue note','בלו נוט','המלון','המעבדה','אבן יהודה','tel aviv museum','מוזיאון תל אביב','מוזיאון ישראל','israel museum','מוזיאון יפו','jaffa museum','מדע','science museum','בלומפילד','bloomfield','קופסת זכוכית','glass box','glass house','live show','שואו חי','פאב','pub','wine bar','בר יין','cocktail bar','בר קוקטיילים','שוט','shot','בירה בחבית','beer on tap','בית בירה','beer house','פאב אירי','irish pub','דארטס','darts','ביליארד','billiards','פוקר חי','live poker','אסקייפ רום','escape rooms','משחקי לוח','board games','escape city'
    ]
  },

  // 13) Shopping / clothing - extends ביגוד_ונעליים
  'ביגוד_EXTRA': {
    target_key: 'ביגוד_ונעליים',
    target_pool: 'brands',
    items: [
      'aliexpress','עלי אקספרס','amazon shopping','אמזון שופינג','amazon.com','shein','שיין','ebay','איביי','wish','ויש','asos','אסוס','asos.com','farfetch','net-a-porter','yoox','revolve','boohoo','pretty little thing','plt','missguided','shein plus',
      'h&m','hm','zara','זארה','zara home','massimo dutti','pull and bear','pull&bear','bershka','ברשקה','stradivarius','oysho','oysho.com','uniqlo','יוניקלו','muji','muji.com','muji israel','primark',
      'castro','קסטרו','castro women','castro men','castro kids','renuar','רנואר','fox','פוקס','fox home','fox kids','fox baby','golf','גולף','golf kids','golf & co','hagor','הגור','tommy hilfiger israel','calvin klein israel','lacoste','poiret','poiré','american eagle israel',
      'adidas','אדידס','adidas israel','nike','נייקי','nike israel','puma','פומה','reebok','ריבוק','under armour','אנדר ארמור','new balance','asics','אסיקס','converse','converse all star','vans','ואנס','fila','פילה','dr martens','דוקטור מרטינס','crocs','קרוקס','timberland','טימברלנד','geox','ecco','אקו','clarks','קלארקס','aldo','aldo shoes','steve madden','בגדים','clothes','clothing','jeans','jacket','מעיל','חולצת טי','t-shirt','sweatshirt','קפוצ׳ון','hoodie','גופייה','tank top','מכנס קצר','shorts'
    ]
  },

  // 14) Home - extends בית
  'בית_HOME': {
    target_key: 'בית',
    target_pool: 'keywords',
    items: [
      'ikea','איקאה','ikea ישראל','איקאה ישראל','bug','באג','ksp','קסף','ksp computers','כל בו','kol bo','kolbo','כלי בית','home goods','קרולינה למקה','carolina lemke','lemonade','לימונייד','lemonade home','foxhome','fox home','home center','הום סנטר','אייס','ace','ace hardware','home depot','משביר לצרכן','hamashbir','משביר','בית וגן','home and garden','גינה','garden','plants','עציץ',
      'ריהוט','furniture','שולחן','table','כיסא','chair','כורסה','armchair','ספה','sofa','מיטה','bed','מזרן','mattress','מזרני אישי','sealy','perfectsleep','aminach','עמינח','hollandia','הולנדיה','שטיח','rug','carpet','tile','אריחים','tiles','floor','ריצוף','laminate flooring','פרקט','parquet','wood floor',
      'מקלחת','shower','אסלה','toilet','אסלות','ברז','faucet','ברזים','faucets','כיור','sink','כיורים','sinks','אבזרי אמבטיה','bathroom fixtures','חדר אמבטיה','bathroom','מטבח','kitchen','כלי מטבח','kitchenware','מטבח מורכב','installed kitchen','dwa','דוואל','silverstone','שיש','marble countertop','שיש קוורץ','quartz','granite','גרניט','חדר שינה','bedroom','ארון','closet','closets','ארונות','מקרר','refrigerator','fridge','beko','בקו','samsung fridge','lg fridge','מכונת כביסה','washing machine','מייבש','dryer','מדיח','dishwasher','תנור','oven','גז כיריים','stove','כיריים','cooktop'
    ]
  },

  // 15) Education - extends לימודים
  'לימודים_EXTRA': {
    target_key: 'לימודים',
    target_pool: 'keywords',
    items: [
      'אוניברסיטה','university','אוניברסיטת תל אביב','tel aviv university','tau','האוניברסיטה העברית','hebrew university','huji','אוניברסיטת חיפה','university of haifa','בר אילן','bar ilan','biu','בן גוריון','ben gurion','bgu','האוניברסיטה הפתוחה','open university','openu','technion','טכניון','אריאל','ariel','reichman','רייכמן','idc',
      'מכללה','college','מכללת אונו','ono academic college','המכללה האקדמית','academic college','שנקר','shenkar','בצלאל','bezalel','המכללה למנהל','מנדל','mandel','beit berl','בית ברל','מכללה אזורית','regional college','seminar hakibutzim','סמינר הקיבוצים','levinsky','לוינסקי',
      'קורס','course','קורס online','online course','שיעור אונליין','online lesson','udemy','אודמי','coursera','קורסרה','edx','אדאקס','khan academy','udacity','linkedin learning','linkedin','skillshare','masterclass','codecademy','קוד קדמיה','codingdojo','flatiron','wgu','elevation academy','elevation','holberton','hack reactor','ironhack','le wagon','la coding',
      'ספרים','books','textbook','ספרי לימוד','steimatzky','סטימצקי','tzomet sfarim','צומת ספרים','book depository','amazon books',
      'שיעור פרטי','private lesson','tutor','tutoring','מורה פרטי','private teacher','שיעור מתמטיקה','math tutor','שיעור אנגלית','english tutor','שיעור פסיכומטרי','psychometric tutor','psychometry','psychotest','מבחן פסיכומטרי','psychometric test','קמפוס','campus','dorm','מעונות','student housing','אגודת הסטודנטים','student union'
    ]
  },

  // 16) Travel - extends נסיעות
  'נסיעות_EXTRA': {
    target_key: 'נסיעות',
    target_pool: 'keywords',
    items: [
      'ryanair','ריינאייר','wizz air','wizzair','ויז אייר','israir','ישראייר','el al','אל על','elal','arkia','ארקיע','sun dor','sundor','סאן דור','easyjet','איזיג׳ט','easy jet','lufthansa','לופטהנזה','swiss','סוויס','klm','aegean','aegean airlines','aegean air','turkish airlines','טורקיש איירליינס','pegasus','פגאסוס','transavia','vueling','wow air','frontier','spirit','iberia','iberia.com','tap portugal','tap','air france','airfrance','british airways','ba',
      'booking.com','בוקינג','booking','airbnb','איירבנב','trip.com','tripcom','trivago','tripadvisor','expedia','kayak','קייאק','agoda','אגודה','hotels.com','hotels com','hostelworld','hostel world','vrbo','homeaway','flixbus','blablacar','בלבל קאר',
      'טיסה','flight','flight ticket','כרטיס טיסה','חופשה','holiday','vacation','מלון','hotel','hotel booking','צימר','tzimer','tzimerim','צימרים','בית הארחה','guest house','אכסניה','hostel','airbnb stay','airbnb host',
      'השכרת רכב','rent a car','car rental','avis','sixt','hertz','budget car','europcar','enterprise rental','eldan','אלדן','shlomo sixt','שלמה sixt','thrifty','dollar rent','green motion','קאר 2 גו','car2go','autoeurope'
    ]
  },

  // 17) Charities (extends מתנות or could be new - we extend מתנות first
  // for symbolic gifts and add a NEW subcategory below).
  'מתנות_EXTRA': {
    target_key: 'מתנות',
    target_pool: 'keywords',
    items: [
      'toys r us','טויס אר אס','imaginarium','toys','צעצועים','צעצוע','כלי משחק','play set','מתנה ליום הולדת','birthday gift','מתנה לתינוק','baby gift','מתנת חתונה','wedding gift','מתנת ברית','brit gift','מתנה לבר מצווה','bar mitzvah gift','פרחים','flowers','זר פרחים','flower bouquet','hila flowers','הילה פרחים','פרחי לב','flowers from heart','שזירה','flower arrangement','שזירת פרחים','שזירת זר','silver gift','כסף לחתונה','wedding money','מתן בסתר','מעטפת חתונה','wedding envelope'
    ]
  }
};

// Brand new categories not present in v2 KESEFLE_KEYWORDS.
// These will be inserted as fresh keys into KESEFLE_KEYWORDS.
var KESEFLE_NEW_CATEGORIES = {
  'אוכל_חיות_מחמד': {
    routes_to: 'personal', sheet: 'תנועות',
    category: 'הוצאות קבועות', subcategory: 'אוכל לחיות מחמד',
    keywords: [
      'אוכל לכלב','אוכל לחתול','dog food','cat food','מזון לכלב','מזון לחתול','royal canin','רויאל קנין','hills','הילס','science diet','purina','פורינה','pedigree','פדיגרי','whiskas','ויסקס','iams','אימס','natural balance','orijen','אורייז׳ן','acana','אקאנה','blue buffalo','wellness pet','wet food','dry food','שימורי חתולים','שימורי כלבים','אוכל יבש','אוכל רטוב','גלגלי אוכל','treats לחיות','עצמות לעיסה','chew bones','חטיף לכלב','חטיף לחתול','dental chew','חטיף שיניים','מולטיויטמין לחיה','אבקת ויטמינים','שמן דגים','fish oil pet','מים לחיה','קערה לכלב','קערה לחתול','בקבוק שתייה','משחק לחיה','pet toy','חפץ לעיסה','dog bed','חתולית','פטשופ','pet shop','פטמרקט','pet market','petalon','פטאלון','pet mart','petsmart','petco','dogi','דוגי','jbpet','jb pet','dogwise','קופסת חול','litter box','חול לחתול','cat litter','שעועית חתול','arnav','ארנב','rabbit','אוגר','hamster','אקווריום','aquarium','מזון לדגים','fish food','אורנמנטל','ornamental','בטא','betta','goldfish','דגי זהב'
    ]
  },
  'טיפוח_אישי': {
    routes_to: 'personal', sheet: 'תנועות',
    category: 'קניות', subcategory: 'טיפוח אישי',
    keywords: [
      'sephora','סיפורה','mac cosmetics','mac איפור','urban decay','too faced','huda beauty','fenty beauty','rare beauty','glossier','nars','nars cosmetics','dior beauty','chanel beauty','ysl beauty','tom ford beauty','marc jacobs beauty','clinique','קליניק','estee lauder','אסטה לאודר','la mer','la prairie','lancome','לנקום','clarins','קלרינס','vichy','ויצ׳י','la roche posay','לה רוש פוזה','avene','אבן','eucerin','אוקריןזיןן','cetaphil','סטאפיל','neutrogena','ניוטרוג׳ינה','olay','אולי','garnier','גרנייה','loreal','לוריאל','revlon','רבלון','maybelline','מייבלין','nyx','בית קוסמטיקה','beauty house','קוסמטיקה','cosmetics','superpharm beauty','סופר פארם בייוטי','life style cosmetics',
      'מספרה','barber','barber shop','salon','salon de coiffure','מספרה לגברים','מספרת גברים','tonibell','toni and guy','vidal sassoon','redken','wella','schwarzkopf','קוואקר','כתפיים פתוחות','blowout','blow dry','פן','manicure','מאניקור','pedicure','פדיקור','nails salon','סלון ציפורניים','jelly nails','gel nails','אקריל ציפורניים','acrylic nails','spa','ספא','עיסוי','massage','עיסוי שוודי','שוודי','swedish massage','עיסוי תאי','thai massage','עיסוי רקמות עמוקות','deep tissue','vichy shower','שעוות שעוה','wax','שעוות סוכר','sugar wax','wax brazilian','epilation','depilation','laser hair removal','הסרת שיער בלייזר','laser','איפור כלה','bridal makeup','איפור אירוע','event makeup','גבות','brows','eyebrow tattoo','קעקוע גבות','microblading','שיזוף','tanning','spray tan','שיזוף בתרסיס'
    ]
  },
  'ספורט_וכושר': {
    routes_to: 'personal', sheet: 'תנועות',
    category: 'קניות', subcategory: 'ספורט וכושר',
    keywords: [
      'decathlon','דקאתלון','sport-corp','sport corp','ספורט קורפ','intersport','אינטרסבורט','אינטרספורט','factory 54 sport','sportina','ספורטינה','adidas store','nike store','puma store','underarmour store','asics store',
      'gym membership','חברות חדר כושר','חדר כושר','crossfit gym','אימון אישי','personal trainer','personal training','אימון קבוצתי','group training','אימון פונקציונלי','functional training','פונקציונלי','spinning class','שיעור ספינינג','yoga class','שיעור יוגה','pilates reformer','reformer פילאטיס','pilates mat','barre class','שיעור בר','f45 training','orangetheory fitness','curves','קורבס','holmes place','holmes','go active','energy gym','אנרג׳י','energy fitness','my gym','מיי ג׳ים','great shape','גרייט שייפ','iron gym','olympia gym','אולימפיה',
      'protein powder','אבקת חלבון','whey protein','isolate','קזאין','casein','creatine','קריאטין','bcaa','glutamine','גלוטמין','pre workout','פרי ווקאוט','משקה אנרגיה','energy drink','redbull','רד בול','energade','isotonic','שייק חלבון','protein shake','חטיף חלבון','protein bar','quest bar','אופטימום','optimum nutrition','muscletech','dymatize','myprotein','iherb','אייהרב','vitamin shoppe','גופייה ספורט','sports bra','חזיית ספורט','מכנס ריצה','running pants','ריצה','running shoes','נעלי ריצה','marathon','מרתון','חצי מרתון','half marathon','triathlon','טריאתלון','aerobics','אירובי','step','zumba','זומבה','kickboxing','קיקבוקס','boxing','אגרוף','מתאגרף','krav maga','קרב מגע','jiu jitsu','ג׳יו ג׳יטסו','bjj','judo','ג׳ודו','karate','קראטה','taekwondo','טאקוונדו','climbing wall','קיר טיפוס','bouldering','בולדרינג','swimming','שחייה','בריכה ציבורית','אופניים','bike','bicycle','אופני הרים','mountain bike','אופני כביש','road bike'
    ]
  },
  'תרומות': {
    routes_to: 'personal', sheet: 'תנועות',
    category: 'שונות ואחרים', subcategory: 'תרומות',
    keywords: [
      'תרומה','donation','צדקה','tzedaka','tzedakah','tithe','מעשר','מעשר כספים','קופת צדקה','charity box','קרן','foundation','עמותה','non profit','npo','ngo',
      'magen david adom','מגן דוד אדום','mda','איחוד הצלה','united hatzalah','united hatzala','zaka','zaka israel','בית חולים תל השומר','tel hashomer','sheba','שיבא','בית חולים שערי צדק','shaarei tzedek','בית חולים הדסה','hadassah','rambam','רמב״ם','ichilov','איכילוב','soroka','סורוקה','wolfson','וולפסון','assaf harofeh','אסף הרופא',
      'yad sarah','יד שרה','yad eliezer','יד אליעזר','meir panim','meir panim','מאיר פנים','pitchon lev','פתחון לב','colel chabad','כולל חב״ד','chabad','חב״ד','אגודת ישראל','agudath israel','keren hayesod','קרן היסוד','jnf','keren kayemet','קרן קיימת','שלום עכשיו','peace now','beterem','בטרם','wizo','ויצו','naamat','נעמת','emunah','אמונה',
      'תפילה','prayer donation','בית כנסת','synagogue','beit knesset','שאלי בית','אכסניא לתורה','yeshiva','ישיבה','אהל אבי','ohel','kollel','כולל','tzedakah box','קופת כיס','prayer book','siddur donation','torah scroll','ספר תורה','sefer torah','מצוות','mitzvot','תרומה אנונימית','anonymous donation','recurring donation','תרומה חודשית','monthly pledge','קיק סטרטר','kickstarter','indiegogo','gofundme','go fund me','עזרה לעני','help the poor'
    ]
  },
  'השקעות': {
    routes_to: 'personal', sheet: 'תנועות',
    category: 'הוצאות קבועות', subcategory: 'השקעות',
    keywords: [
      'bank hapoalim','בנק הפועלים','hapoalim','hapoalim invest','poalim trade','mizrahi tefahot','מזרחי טפחות','mizrahi','מזרחי','מזרחי טריידר','discount bank','בנק דיסקונט','discount','דיסקונט','bank leumi','בנק לאומי','leumi','לאומי','leumi trade','מסחר לאומי','bank yahav','בנק יהב','yahav','יהב','first international','בנק הבינלאומי','beinleumi','בינלאומי','union bank','איגוד','one zero','one zero bank','וואן זירו',
      'מניות','stocks','shares','equities','אג״ח','bond','bonds','אגרת חוב','treasury','t-bill','etf israel','קרן סל ישראל','קרן מחקה','tracker fund','קרן נאמנות','mutual fund','קרן נאמנותית','קרן השתלמות','keren hishtalmut','study fund','קופת גמל','kupat gemel','provident fund','קרן פנסיה','keren pensia','pension fund','פנסיה תקציבית','budgetary pension','פנסיה צוברת','accruing pension','מנהלים','executive insurance','ביטוח מנהלים',
      'altshuler shaham','אלטשולר שחם','altshuler','אלטשולר','yelin lapidot','ילין לפידות','yelin','psagot','פסגות','meitav dash','מיטב דש','meitav','מיטב','migdal makefet','מגדל מקפת','migdal','מגדל','phoenix excellence','אקסלנס','clal pension','כלל פנסיה','clal investments','כלל השקעות','harel pension','הראל פנסיה',
      'plus500','פלוס500','etoro','איטורו','interactive brokers','ibkr','robinhood','רובינהוד','td ameritrade','schwab','vanguard','blackrock','ishares','spdr','spy','qqq','voo','vti','vxus','bnd','agg','tlt','gld','slv','arkk','reit','קרן ריט','דיבידנד מניות','דיבידנד'
    ]
  },
  'כושר_מורחב': {
    // intentionally absent; covered by ספורט_וכושר above. Kept as placeholder.
  }
};
// Remove the placeholder so it doesn't get registered
delete KESEFLE_NEW_CATEGORIES['כושר_מורחב'];

// Idempotent installer.
function INSTALL_EXTRA_KEYWORDS_v3() {
  if (typeof KESEFLE_KEYWORDS === 'undefined') {
    Logger.log('KESEFLE_KEYWORDS not found - load KESEFLE_KEYWORDS_v2.gs first.');
    return { ok: false, error: 'v2 not loaded' };
  }
  var perCategoryAdds = {};
  var totalAdded = 0;
  var totalSkipped = 0;

  // Step 1 - append to EXISTING v2 categories.
  Object.keys(KESEFLE_EXTRA_TO_EXISTING).forEach(function(bundleKey) {
    var bundle = KESEFLE_EXTRA_TO_EXISTING[bundleKey];
    var target = KESEFLE_KEYWORDS[bundle.target_key];
    if (!target) {
      Logger.log('SKIP bundle ' + bundleKey + ' - target ' + bundle.target_key + ' missing in v2.');
      return;
    }
    var poolName = bundle.target_pool || 'keywords';
    if (!Array.isArray(target[poolName])) target[poolName] = [];
    var existing = {};
    target[poolName].forEach(function(w) { existing[String(w).toLowerCase()] = true; });
    var added = 0;
    var skipped = 0;
    bundle.items.forEach(function(w) {
      var key = String(w).toLowerCase();
      if (existing[key]) { skipped++; return; }
      existing[key] = true;
      target[poolName].push(w);
      added++;
    });
    perCategoryAdds[bundleKey] = { added: added, skipped: skipped, target: bundle.target_key, pool: poolName };
    totalAdded += added;
    totalSkipped += skipped;
  });

  // Step 2 - register brand-new v3 categories.
  Object.keys(KESEFLE_NEW_CATEGORIES).forEach(function(newKey) {
    var def = KESEFLE_NEW_CATEGORIES[newKey];
    if (!def || !def.keywords) return;
    if (!KESEFLE_KEYWORDS[newKey]) {
      KESEFLE_KEYWORDS[newKey] = {
        routes_to: def.routes_to,
        sheet: def.sheet,
        category: def.category,
        subcategory: def.subcategory,
        keywords: []
      };
    }
    var target = KESEFLE_KEYWORDS[newKey];
    if (!Array.isArray(target.keywords)) target.keywords = [];
    var existing = {};
    target.keywords.forEach(function(w) { existing[String(w).toLowerCase()] = true; });
    var added = 0;
    var skipped = 0;
    def.keywords.forEach(function(w) {
      var key = String(w).toLowerCase();
      if (existing[key]) { skipped++; return; }
      existing[key] = true;
      target.keywords.push(w);
      added++;
    });
    perCategoryAdds['NEW_' + newKey] = { added: added, skipped: skipped, target: newKey, pool: 'keywords' };
    totalAdded += added;
    totalSkipped += skipped;
  });

  // Step 3 - report.
  Logger.log('========== KESEFLE EXTRA v3 INSTALL ==========');
  Object.keys(perCategoryAdds).forEach(function(k) {
    var r = perCategoryAdds[k];
    Logger.log(k + ' -> ' + r.target + '.' + r.pool + ' +' + r.added + ' (skipped ' + r.skipped + ')');
  });
  Logger.log('---------------------------------------------');
  Logger.log('TOTAL added: ' + totalAdded);
  Logger.log('TOTAL skipped (already present): ' + totalSkipped);
  Logger.log('Categories touched: ' + Object.keys(perCategoryAdds).length);
  Logger.log('==============================================');

  return {
    ok: true,
    totalAdded: totalAdded,
    totalSkipped: totalSkipped,
    perCategory: perCategoryAdds,
    categoryCount: Object.keys(perCategoryAdds).length
  };
}

// Quick smoke test against the v2 classifier with new keywords.
function TEST_EXTRA_KEYWORDS_v3() {
  INSTALL_EXTRA_KEYWORDS_v3();
  var tests = [
    '120 ארומה',
    'עסק 400 cursor pro',
    '85 רולדין',
    '50 מקדונלדס',
    '320 פז',
    '15 רב קו',
    '40 פנגו',
    '450 קופת חולים',
    '60 סופר פארם',
    '120 חשבון חשמל',
    '650 ארנונה',
    '180 ועד בית',
    '90 ועד בניין',
    '1200 צהרון',
    '60 ביבסיטר',
    '60 בייביסיטר',
    '120 סינמה סיטי',
    '250 ticketmaster',
    '300 zara',
    '150 ikea',
    '700 קורס udemy',
    '4500 wizz air',
    '900 booking.com',
    '50 פרחים',
    '120 royal canin',
    '350 sephora',
    '250 מספרה',
    '199 חדר כושר',
    '180 תרומה מגן דוד אדום',
    '5000 אלטשולר',
    '90 spotify family',
    '180 חברת חשמל'
  ];
  tests.forEach(function(t) {
    var r = _SRC_classify_v2_(t);
    Logger.log(t + ' -> ' + (r.subcategory || '?') + ' [' + (r.routes_to || '?') + '] conf=' + r.confidence + ' kw=' + (r.matched_keyword || '-'));
  });
}

// Optional: count total keywords across all categories after install.
function COUNT_KESEFLE_KEYWORDS_v3() {
  var total = 0;
  Object.keys(KESEFLE_KEYWORDS).forEach(function(k) {
    var d = KESEFLE_KEYWORDS[k];
    var n = (d.keywords ? d.keywords.length : 0) + (d.brands ? d.brands.length : 0);
    total += n;
    Logger.log(k + ': ' + n);
  });
  Logger.log('GRAND TOTAL: ' + total);
  return total;
}
