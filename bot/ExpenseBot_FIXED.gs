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

  { keywords: ['אוכל לבית', 'אוכל בבית', 'סופר', 'רמי לוי', 'שופרסל', 'יוחננוף', 'ויקטורי', 'אושר עד', 'מחסני השוק', 'יינות ביתן', 'מגה', 'קרפור'],
    category: 'אוכל', subcategory: 'אוכל לבית' },
  { keywords: ['אוכל בחוץ', 'אוכל חוץ', 'מסעדה', 'מסעדות', 'wolt', 'וולט', 'ten bis', 'תן ביס', 'משלוח אוכל', 'קפה', 'בית קפה', 'פיצה', 'בורגר', 'המבורגר', 'שווארמה', 'סושי', 'מקדונלדס', 'starbucks', 'cofix'],
    category: 'אוכל', subcategory: 'אוכל בחוץ' },

  { keywords: ['דלק', 'תדלוק', 'פז ', 'סונול', 'דור אלון'], category: 'תחבורה', subcategory: 'דלק' },
  { keywords: ['ליים', 'lime'], category: 'תחבורה', subcategory: 'ליים' },
  { keywords: ['רוביקון', 'גיפ רוביקון', "ג'יפ רוביקון", 'jeep'], category: 'תחבורה', subcategory: 'רוביקון' },
  { keywords: ['חניה', 'חנייה', 'חניון', 'pango', 'פנגו', 'cellopark', 'סלו פארק'], category: 'תחבורה', subcategory: 'חניה' },
  { keywords: ['מונית', 'gett', 'גט ', 'uber', 'אובר', 'אוטובוס', 'רכבת', 'רב קו', 'רב-קו'], category: 'תחבורה', subcategory: 'מונית' },
  { keywords: ['bmw', 'ב.מ.וו', 'אופנוע', 's1000'], category: 'תחבורה', subcategory: 'BMW s1000' },
  { keywords: ['ביטוח חובה', 'ביטוח רכב', 'איתוראן'], category: 'תחבורה', subcategory: 'ביטוח רכב' },
  { keywords: ['קורקינט'], category: 'תחבורה', subcategory: 'קורקינט' },

  { keywords: ['אבא', 'להעביר לאבא'], category: 'הוצאות זמניות', subcategory: 'אבא' },
  { keywords: ['מכון כושר', 'חדר כושר', 'אימון', 'כושר '], category: 'הוצאות קבועות', subcategory: 'מכון כושר' },
  { keywords: ['ביגוד', 'בגדים', 'נעליים', 'zara', 'h&m', 'fox', "לויס"], category: 'קניות', subcategory: 'ביגוד' },
  { keywords: ['טיפוח', 'בושם', 'קרם', 'מספרה', 'ספרית', 'מאניקור', 'פדיקור'], category: 'קניות', subcategory: 'טיפוח' },
  { keywords: ['אפליקציה', 'אפליקציות', 'netflix', 'נטפליקס', 'spotify', 'ספוטיפיי', 'youtube', 'יוטיוב', 'icloud'], category: 'הוצאות קבועות', subcategory: 'אפליקציות' },
  { keywords: ['פלייסטיישן', 'פלייסטישן', 'playstation', 'ps5', 'ps plus'], category: 'הוצאות קבועות', subcategory: 'פלייסטיישן' },
  { keywords: ['לוטו', 'פיס', 'חיש גד'], category: 'שונות ואחרים', subcategory: 'לוטו' },
  { keywords: ['אפולו'], category: 'הוצאות קבועות', subcategory: 'אפולו' },
  { keywords: ['לימודים', 'קורס', 'אוניברסיטה', 'מכללה'], category: 'הוצאות קבועות', subcategory: 'לימודים' },
  { keywords: ['אישי'], category: 'שונות ואחרים', subcategory: 'אישי' },

  { keywords: ['חשמל', 'חברת חשמל'], category: 'הוצאות קבועות', subcategory: 'חשמל' },
  { keywords: ['ארנונה', 'ועד ', 'שכירות', 'שכר דירה'], category: 'הוצאות קבועות', subcategory: 'בית' },
  { keywords: ['מים', 'תאגיד מים'], category: 'הוצאות קבועות', subcategory: 'מים' },
  { keywords: ['תקשורת', 'סלולר', 'פלאפון', 'פרטנר', 'סלקום', 'יס ', 'הוט ', 'בזק', 'אינטרנט'], category: 'הוצאות קבועות', subcategory: 'תקשורת' },

  { keywords: ['רופא', 'תרופה', 'תרופות', 'קופת חולים', 'בית מרקחת', 'סופר פארם', 'super pharm', 'פיזיותרפיה', 'פיסיותרפיה'], category: 'בריאות', subcategory: 'בריאות' },

  { keywords: ['עסק פייסבוק', 'עסק facebook', 'עסק שיווק', 'עסק פרסום', 'שיווק פייסבוק', 'שיווק פייסביוק', 'שיווק facebook', 'פייסבוק עסק', 'שיווק עסק'], category: 'עסק', subcategory: 'שיווק' },
  { keywords: ['עסק רואה חשבון', 'עסק יועץ מס'], category: 'עסק', subcategory: 'יועצים' },
  { keywords: ['עסק '], category: 'עסק', subcategory: 'אחר' },

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

function parseForeignCurrencyHint(text) {
  if (!text) return null;
  var s = String(text);
  var foreignRe = /(\$|€|£|usd|eur|gbp|דולר|דולרים|יורו|אירו|פאונד)/i;
  if (!foreignRe.test(s)) return null;
  var ilsRe = /(\d+(?:[.,]\d+)?)\s*(?:שקל(?:ים)?|ש["״']?ח|nis|ils)/i;
  var m = s.match(ilsRe);
  var ilsAmount = m ? Number(String(m[1]).replace(/,/g, '')) : null;
  if (!ilsAmount || isNaN(ilsAmount)) return null;
  var note = s.trim();
  var fxBlockRe = /(\$|€|£|\d)[^,\n]{0,80}?(שקל|ש["״']?ח|nis|ils)/i;
  var blockMatch = s.match(fxBlockRe);
  if (blockMatch && blockMatch[0].length < note.length) note = blockMatch[0].trim();
  var cleanedText = s.replace(/\d+(?:[.,]\d+)?\s*(?:\$|€|£|usd|eur|gbp|דולר(?:ים)?|יורו|אירו|פאונד|שקל(?:ים)?|ש["״']?ח|nis|ils)/gi, '').replace(/[\\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { ilsAmount: ilsAmount, note: note, cleanedText: cleanedText };
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
function matchCategorySmart(text) {
  return matchCategory(text);
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

function getHelpMessage() {
  return '🤖 בוט הוצאות - איך להשתמש:\n\n' +
    '📝 רישום הוצאה:\n' +
    '   "85 סופר רמי לוי"\n' +
    '   "1200 ארנונה"\n' +
    '   "סופר 250"\n\n' +
    '📊 פקודות:\n' +
    '   "סיכום" - סיכום החודש\n' +
    '   "מחק אחרון" - מחיקת הרישום האחרון\n' +
    '   "עזרה" - הודעה זו\n\n' +
    '💡 הבוט מזהה אוטומטית קטגוריות לפי מילות מפתח. ערוך את CATEGORY_MAP בסקריפט להוספת מילים.';
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
