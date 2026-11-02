# צ'קליסט חיבור מספר WhatsApp חדש — כספ'לה

> מטרה: להחליף את מספר הבדיקה (+1 555 640-8123, Phone ID 1086749664527399) במספר SIM/eSIM חדש ונקי, בלי לשנות קוד — רק משתני סביבה ו-Script Properties.
> ⚠️ לא למחוק אף חשבון/מספר קיים. לא לנסות שוב עם שני המספרים הקיימים.

## מצב נוכחי (ביקורת Meta, 02/11/2026)
- Callback URL = פריסת Apps Script: `https://script.google.com/macros/s/AKfycbx5keAUUFhhFeXKF5vaA6gn3vDaWpqtdR0IkCUUx_3Waruj5KIcepIim8MHSBSo6Y_1bQ/exec` (ה-webhook של Meta מגיע ל-Apps Script, **לא** ל-`/api/whatsapp/webhook` ב-Vercel).
- Verify token מוגדר; רק השדה `messages` מנוי, ב-Graph v25.0 (הקוד שולח ב-v21.0 כברירת מחדל — אפשר ליישר עם `WA_GRAPH_VERSION`).
- ❗ האפליקציה **לא מפורסמת** (Development mode) → webhooks של production לא נשלחים. חובה לפרסם.
- ❗ Business portfolio 1052373695596923 **לא מאומת** → מגבלה של 250 שיחות ביום.
- אין מספר מחובר לאפליקציה; מספר הבדיקה לא מקושר; אין לנו גישה ל-WABA הבדיקה 2099640690612821.
- WABA אמיתי 1359061932987272 — 0 תבניות (templates).
- Data deletion URL ו-App domains ריקים (privacy=https://kesefle.com/privacy, terms מוגדר).
- System user `kesefle-bot` (Admin, 10 נכסים כולל WABAs כספ'לה / srcwa / Kesefle). לא ידוע אם קיים טוקן קבוע.
- הערה: בקוד הבוט כתוב בהערה WABA 986476207210292 — לא תואם ל-WABA שבשימוש. לבדוק ולתקן את `WHATSAPP_BUSINESS_ACCOUNT_ID`.

## אפשר לעשות כבר עכשיו (לא תלוי במספר)
- [ ] להשלים ב-App Settings → Basic: App domains = `kesefle.com`, Data deletion URL (למשל `https://kesefle.com/privacy#delete` או endpoint ייעודי), אייקון וקטגוריה.
- [ ] להתחיל אימות עסק (Business Verification) ל-portfolio 1052373695596923.
- [ ] להכין תבניות ב-WABA 1359061932987272 (welcome / link-confirm / תזכורות) ולשלוח לאישור.
- [ ] לוודא שהמשתמש `kesefle-bot` משויך ל-WABA 1359061932987272 עם Full control, ולאפליקציה.
- [ ] למזג את ה-PR של החלפת המספר דרך config (draft) אחרי סקירה — ההתנהגות לא משתנה עד שמגדירים משתנים.
- [ ] להדביק `ZZ_KFL_WA_CONFIG.gs` ב-Apps Script והרץ `kflWaConfigReport()` — צריך להציג את הערכים הנוכחיים.

## ביום שה-SIM מגיע
1. **הכנת ה-SIM**: להכניס לטלפון, לוודא שמקבל SMS/שיחות. **לא** להתקין עליו WhatsApp רגיל/Business (מספר שרשום באפליקציה לא יכול להירשם ל-Cloud API בלי מחיקה).
2. **הוספת המספר ב-Meta**: WhatsApp Manager → WABA 1359061932987272 → Phone numbers → Add phone number. שם תצוגה: "כספ'לה" / "Kesefle" (תואם למותג ולאתר).
3. **אימות SMS**: לבחור SMS (או שיחה קולית), להזין את הקוד בן 6 הספרות.
4. **2FA PIN**: להגדיר PIN בן 6 ספרות ולשמור בכספת (Vault). נדרש ל-register ולכל העברה עתידית.
5. **Register**: מתוך Meta (או בקריאה אחת `POST /{PHONE_NUMBER_ID}/register` עם `messaging_product=whatsapp` ו-`pin`). לרשום את ה-**Phone Number ID** החדש. סטטוס צריך להיות CONNECTED.
6. **מנוי webhook על ה-WABA**: `POST /{WABA_ID}/subscribed_apps` (או דרך App Dashboard → WhatsApp → Configuration). לוודא Callback URL = כתובת ה-Apps Script exec, השדה `messages` מסומן.
7. **פרסום האפליקציה**: App Dashboard → Publish (Live mode). בלי זה לא יגיעו הודעות אמיתיות.
8. **טוקן קבוע**: Business Settings → System users → `kesefle-bot` → Generate token, Expiration = Never, הרשאות `whatsapp_business_messaging` + `whatsapp_business_management`, נכסים: האפליקציה + WABA 1359061932987272. לשמור בכספת.
9. **Vercel env (Production)** — Project Settings → Environment Variables:
   - `WA_PHONE_E164` = `+972XXXXXXXXX` (המספר החדש)
   - `WA_PHONE_NUMBER_ID` = ה-ID החדש
   - `WA_WABA_ID` = `1359061932987272`
   - `WA_ACCESS_TOKEN` = הטוקן הקבוע
   - `WA_VERIFY_TOKEN` = אותו verify token כמו ב-Meta
   - `WA_GRAPH_VERSION` = `v21.0` (או `v25.0` אחרי בדיקה)
   - (המשתנים הישנים META_* / WHATSAPP_* / KESEFLE_BOT_NUMBER עדיין נקראים כגיבוי — להשאיר עד שהכול עובד, ואז לנקות.)
   - Redeploy ל-production.
10. **Script Properties ב-Apps Script** (importjason → Project Settings):
    - `WHATSAPP_PHONE_NUMBER_ID` = ה-ID החדש
    - `WHATSAPP_TOKEN` = הטוקן הקבוע
    - `WHATSAPP_BUSINESS_ACCOUNT_ID` = `1359061932987272`
    - `BOT_PHONE_E164` = `+972XXXXXXXXX`
    - `WA_VERIFY_TOKEN` = ה-verify token (רק אחרי ששינית שורות ה-const לפי ההוראות בקובץ ZZ)
    - `WA_GRAPH_VERSION` = `v21.0`
    - `META_APP_SECRET` — לוודא שקיים (בדיקת HMAC).
11. **גרסת פריסה חדשה**: Deploy → Manage deployments → עריכת הפריסה הקיימת → New version (כדי שה-URL של ה-exec לא ישתנה!). להריץ `kflWaConfigReport()` ולוודא שהערכים החדשים מופיעים.
12. **קישורי האתר**: לפתוח `https://kesefle.com/api/config` → `BOT_NUMBER` = המספר החדש. לבדוק ב-index/dashboard שקישורי wa.me הוחלפו (js/wa-links.js). לעמודים בלי הסקריפט (blog/ar/fr/it/ru/emails) — להריץ `scripts/swap-bot-number.sh` (לעדכן את OLD לפני) ב-branch ולפתוח PR.
13. **Smoke test** (רק מהטלפון שלך, למספר החדש):
    - לשלוח "שלום" → תשובה מגיעה מהמספר החדש.
    - "45 קפה" → נרשם בגיליון שלך בלבד.
    - קוד חיבור מהאתר ("קוד 123456") → חיבור מצליח + הודעת ברוכים הבאים.
    - תמונה של קבלה / הודעה קולית (Media API עם הגרסה החדשה).
    - `GET /api/health` → meta_* = true.
    - Meta → WhatsApp Manager: Quality rating ירוק, אין שגיאות webhook.
14. **אחרי שעובד**: לעדכן `bot/full_qa.js`/בדיקות שמצמידות את מספר הבדיקה, לנקות משתנים ישנים, לעדכן תיעוד.
