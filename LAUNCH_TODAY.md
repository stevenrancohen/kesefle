# LAUNCH_TODAY — צ'קליסט מהיר לעלייה לאוויר

עדכון אחרון: 2026-05-17 ~16:50

## ✅ מה כבר בוצע

- [x] בוט וואטסאפ מקליט הוצאות לגיליון (FAST PATH)
- [x] גיליון תנועות ממוין ישן→חדש
- [x] קוד בוט: הוסר ה-sort שעשה לולאה
- [x] אתר ב-dark-mode בלבד, נראות שודרגה (aurora, tilt-3D, shimmer, floating chips)
- [x] הסרת נתונים מזויפים (479k/368 הוצאות) → פתק כנה מהיוצר
- [x] תיקון SW שגרם לאתר להיראות "שבור" (Tailwind כבר לא נכנס לקאש)
- [x] תבנית גיליון נקייה: `/Users/stevenrancohen/Downloads/מאזן - תבנית נקייה.xlsx`
  - 4 לשוניות, רק תוויות + נוסחאות, אפס נתונים אישיים

---

## 🔴 חוסמים שדורשים פעולה ידנית (לפני השקה)

### 1. WHATSAPP_TOKEN ב-Apps Script (10 דק) — לאישור ✅ מהבוט

**למה**: הבוט רושם הוצאות אבל לא שולח חזרה הודעת אישור — כי הטוקן לא מוגדר.

**מה לעשות**:
1. https://developers.facebook.com/apps → Kesefle App → WhatsApp → API Setup
2. העתיקי את ה-**User Token** (הארוך שמתחיל ב-`EAF9...`)
3. בעורך Apps Script → ⚙️ Project Settings → Script Properties → Add:
   - Property: `WHATSAPP_TOKEN`
   - Value: (הטוקן המלא)
4. Save Script Properties
5. שלחי "100 סופר" לבוט — מצופה לקבל "✅ נרשם בהצלחה!"

**טוקן זמני בלבד**: User Token תקף 24 שעות. ליציבות יש ליצור System User עם Permanent Token.

---

### 2. KESEFLE_TEMPLATE_SHEET_ID ב-Vercel (10 דק) — לפתרון "drive copy failed"

**למה**: ה-API `/api/sheet/provision` קורא ל-env var זה. הוא לא מוגדר → השגיאה בשלב 2 של ה-onboarding.

**מה לעשות**:
1. העלי `/Users/stevenrancohen/Downloads/מאזן - תבנית נקייה.xlsx` ל-Google Drive
   - **חשוב**: Open with → Google Sheets (כדי שיהפוך לגיליון Google, לא xlsx)
2. שתפי: Share → "Anyone with the link" → Viewer
3. העתיקי את ה-Sheet ID מה-URL (`/spreadsheets/d/{הID}/edit`)
4. Vercel Dashboard → kesefle → Settings → Environment Variables → Add:
   - Key: `KESEFLE_TEMPLATE_SHEET_ID`
   - Value: (ה-ID שהעתקת)
   - Environments: ✅ Production + ✅ Preview
5. Settings → Deployments → ⋮ → Redeploy

---

### 3. עדכון בוט לגרסה האחרונה (5 דק)

**למה**: הקוד הפרוס עדיין מכיל את ה-sort שמיין הפוך. הגרסה החדשה מקלידה רק `appendRow` + מסמנת `✅` בעמודה H.

**מה לעשות**:
```
open /Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs
```
- Cmd+A → Cmd+C
- Apps Script → ExpenseBot.gs → Cmd+A → Cmd+V → Cmd+S
- לפריסה → נהל פריסות → ✏️ → גרסה חדשה → תיאור: `v31 simple appendRow` → פריסה

---

## 🟠 שיפורים שיכולים לחכות (אחרי launch)

### 4. Vercel Region → fra1 (5 דק)

Vercel → Settings → Functions → Function Region → Frankfurt (fra1) → Save → Redeploy.

יפחית latency מ-~150ms ל-~40ms עבור משתמשים בישראל.

---

### 5. Stripe Test Keys (20 דק)

- Stripe Dashboard → Developers → API keys → Test mode
- Add to Vercel env vars:
  - `STRIPE_SECRET_KEY` = `sk_test_...`
  - `STRIPE_WEBHOOK_SECRET` = `whsec_...` (אחרי הקמת webhook)
  - `STRIPE_PRICE_PRO` = (Product → Pricing → Copy ID)
  - `STRIPE_PRICE_FAMILY` = (Product → Pricing → Copy ID)

לבטא — אפשר לדחות.

---

### 6. Meta Webhook Subscription (10 דק) — אם הבוט לא מקבל הודעות

Meta App → WhatsApp → Configuration → Webhook → Subscribe → Fields: `messages`.
Verify Token: `expense_bot_verify_2026` (כבר בקוד ה-Apps Script).

אם בודקים "55 סופר" וזה מגיע לגיליון → הכל מחובר. שלב זה לא נדרש.

---

## 🧪 Smoke test לפני השקה

לאחר שלבים 1+2+3 הושלמו:

1. **בדפדפן אינקוגניטו**: לכי ל-https://kesefle.vercel.app/
2. לחצי "התחל חינם"
3. התחברי עם Google
4. אישור scopes (Drive + Spreadsheets)
5. אמורה לראות "צור את הגיליון שלך" → ✅ הצלחה (לא drive copy failed)
6. עברי ל-WhatsApp → שלחי "100 סופר" לבוט
7. ✅ אמורה לקבל אישור מהבוט
8. פתחי את הגיליון החדש → לשונית תנועות → השורה האחרונה: ₪100 סופר עם ✅

אם כל זה עובד → **מוכן להשקה**.

---

## 📂 קבצים שעלולים לעניין

- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs` — קוד הבוט (924 שורות)
- `/Users/stevenrancohen/Downloads/מאזן - תבנית נקייה.xlsx` — התבנית הסופית הנקייה
- `https://kesefle.vercel.app/` — האתר החי
- `https://script.google.com/d/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit` — Apps Script project
