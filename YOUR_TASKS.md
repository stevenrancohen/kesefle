# 📋 Your remaining tasks (Steven)

Bilingual step-by-step. Estimated total: ~35 minutes (you can do them in any order, but #1 → #2 → #3 builds confidence quickly; #4 + #5 are external service setups).

---

## ✅ TASK 1: Paste `WEEKLY_DIGEST.gs` (5 min)

**Why:** This activates the Sunday-morning auto-digest. Every Sunday at 08:00 (Israel time), the bot sends each registered user a beautiful summary of their last 7 days with spike alerts.

### English
1. Open Apps Script editor: https://script.google.com/d/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit
2. Click **`+`** (top-left, next to "קבצים") → **"סקריפט"** (Script).
3. Type filename: `WEEKLY_DIGEST` → press Enter.
4. Open Finder → `Cmd+Shift+G` → paste `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/` → Enter.
5. Right-click `WEEKLY_DIGEST.gs` → **Open With → TextEdit**. If asked, accept "convert to plain text".
6. In TextEdit: `Cmd+A` → `Cmd+C`.
7. Back in Apps Script (new file open) → click in the editor → `Cmd+A` → **Delete** → `Cmd+V` → **`Cmd+S`**.
8. Add your phone to the subscriber list:
   - Bottom-left gear ⚙️ → **Project Settings** → scroll to **Script Properties** → **Edit script properties** → Add property:
     - Key: `SUBSCRIBERS`
     - Value: `["17745448053"]` (your phone in international format inside a JSON array, with quotes and brackets)
   - Save.
9. Test it: in the editor, function dropdown at top → select **`RUN_WEEKLY_DIGEST_NOW`** → **"הפעלה"**.
10. Open WhatsApp — within ~20 seconds you should receive a digest message.
11. If that works, install the cron trigger: function dropdown → **`INSTALL_WEEKLY_DIGEST_TRIGGER`** → **"הפעלה"**. Confirm in the popup that the trigger is scheduled.

### עברית
1. פתח את עורך Apps Script: https://script.google.com/d/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit
2. לחץ על **`+`** (משמאל למעלה, ליד "קבצים") → **"סקריפט"**.
3. שם הקובץ: `WEEKLY_DIGEST` → Enter.
4. Finder → `Cmd+Shift+G` → הדבק `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/` → Enter.
5. קליק ימני על `WEEKLY_DIGEST.gs` → **פתח באמצעות → TextEdit**.
6. TextEdit: `Cmd+A` → `Cmd+C`.
7. חזור ל-Apps Script (קובץ חדש פתוח) → לחץ בעורך → `Cmd+A` → Delete → `Cmd+V` → **`Cmd+S`**.
8. הוסף את מספר הטלפון שלך לרשימת המנויים:
   - הגדרות (⚙️) → **Project Settings** → **Script Properties** → **Edit script properties** → הוסף:
     - Key: `SUBSCRIBERS`
     - Value: `["17745448053"]` (המספר שלך בפורמט בינלאומי בתוך מערך JSON)
   - שמור.
9. בדיקה: בעורך, תפריט פונקציות למעלה → בחר **`RUN_WEEKLY_DIGEST_NOW`** → **"הפעלה"**.
10. פתח WhatsApp — בתוך ~20 שניות אמורה להגיע הודעת סיכום.
11. אם זה עובד, הפעל את הטריגר השבועי: תפריט פונקציות → **`INSTALL_WEEKLY_DIGEST_TRIGGER`** → **"הפעלה"**.

---

## 🔧 TASK 2: Fix the bot wire-up placement (3 min)

**Why:** Your earlier paste of the bot-commands snippet (`handleBotCommand_`) landed in the wrong place — before the message variables exist. This means `היום?`, `מחק אחרון`, etc. don't work yet.

### English
1. In Apps Script editor, open **`ExpenseBot.gs`**.
2. `Cmd+F` → type `doPost` → Enter → cursor jumps to `function doPost(e) {`.
3. You'll see something like (around line 144-146):
   ```js
   try { var __bc = handleBotCommand_(from, text);
   if (__bc && __bc.handled) { sendWhatsAppReply(from, __bc.replyText); return; }
   ```
   **Delete these two lines.** (`from` and `text` are undefined at that point — that's why it doesn't work.)
4. Scroll down ~10 lines until you see `if (__text_) {` (around line 156).
5. **Right after that line's opening `{`**, paste these two lines (use the underscored variable names `__from_` and `__text_`):
   ```js
   var __bc = handleBotCommand_(__from_, __text_);
   if (__bc && __bc.handled) { sendWhatsAppReply(__from_, __bc.replyText); return ContentService.createTextOutput("ok"); }
   ```
6. **`Cmd+S`** to save.
7. Test: WhatsApp the bot `היום?` → expect a Hebrew summary reply within 3 seconds. Try `מחק אחרון`, `כמה הוצאתי על קפה?`, `עזרה`.

### עברית
1. ב-Apps Script פתח את **`ExpenseBot.gs`**.
2. `Cmd+F` → הקלד `doPost` → Enter.
3. תראה משהו כזה (בערך שורה 144-146):
   ```js
   try { var __bc = handleBotCommand_(from, text);
   if (__bc && __bc.handled) { sendWhatsAppReply(from, __bc.replyText); return; }
   ```
   **מחק את שתי השורות האלה.**
4. גלול ~10 שורות עד `if (__text_) {` (בערך שורה 156).
5. **מיד אחרי ה-`{` הזה**, הדבק את שתי השורות (עם משתנים עם קווים תחתונים):
   ```js
   var __bc = handleBotCommand_(__from_, __text_);
   if (__bc && __bc.handled) { sendWhatsAppReply(__from_, __bc.replyText); return ContentService.createTextOutput("ok"); }
   ```
6. **`Cmd+S`** לשמירה.
7. בדיקה: שלח לבוט `היום?` → תקבל תגובה.

---

## ✅ TASK 3: Retest `/account` onboarding (2 min)

**Why:** Confirm the `missing_auth` fix works — first user-facing milestone.

### English
1. Open https://kesefle.vercel.app/account
2. **Hard-refresh**: `Cmd+Shift+R` to bypass cache.
3. If you've already created a sheet before, click **"התנתק"** → start over.
4. Click **"התחל"** → Google → consent → return to /account.
5. Click **"צור גיליון"** → should succeed with "✓ הגיליון מוכן! מעביר אותך למסך ההכרות…"
6. 1.5 seconds later you should auto-redirect to `/welcome`.
7. On `/welcome` — confetti, 5 click-to-copy commands. Click the WhatsApp CTA.

### עברית
1. פתח https://kesefle.vercel.app/account
2. **רענון קשה**: `Cmd+Shift+R`.
3. אם כבר יצרת גיליון קודם, לחץ **"התנתק"** ותתחיל מחדש.
4. לחץ **"התחל"** → Google → אשר → חזור ל-/account.
5. לחץ **"צור גיליון"** → אמור להצליח ולהעביר ל-/welcome אוטומטית.

---

## 💼 TASK 4: Set up Meta WhatsApp Business (~30-60 min — external)

**Why:** Real users need to send WhatsApp messages to a verified business number, not your personal one. This is a one-time setup.

### Steps:
1. Go to https://business.facebook.com → create a Meta Business account (use your existing Facebook if you have).
2. https://developers.facebook.com → Create App → choose **"Business"** → name: `Kesefle`.
3. Add the **WhatsApp Business Platform** product.
4. Get/buy a phone number through Meta (₪50-100 setup; the number itself is free for new ones).
5. Verify the number via the Meta dashboard (they send an SMS code).
6. Set up the webhook:
   - Callback URL: `https://kesefle.vercel.app/api/whatsapp/webhook`
   - Verify Token: choose any random string (save it).
   - Subscribe to `messages` field.
7. From the Meta dashboard, copy these values:
   - **App Secret** (from App Settings → Basic)
   - **Phone Number ID** (WhatsApp → API Setup)
   - **Access Token** — generate a System User permanent token (Business Settings → System Users → Generate Token)
8. Add to Vercel env vars (Vercel dashboard → kesefle → Settings → Environment Variables):
   - `META_VERIFY_TOKEN` = the string from step 6
   - `META_APP_SECRET` = from step 7
   - `META_PHONE_NUMBER_ID` = from step 7
   - `META_ACCESS_TOKEN` = from step 7
9. Redeploy.
10. Send a WhatsApp message to the new number — should work.

Full guide: I recommend Meta's official docs at https://developers.facebook.com/docs/whatsapp/cloud-api/get-started

---

## 💳 TASK 5: Set up Stripe (~20 min — external)

**Why:** Activate Pro + Family subscriptions.

### Steps:
1. https://stripe.com → create account (or sign in).
2. Once verified, go to https://dashboard.stripe.com/products → **Add product**:
   - Name: **Kesefle Pro**
   - Pricing: ₪19 / month
   - Click **Save product** → copy the **Price ID** (looks like `price_1Abc...`).
3. Repeat for **Kesefle Family** at ₪39/month.
4. Get webhook signing secret:
   - https://dashboard.stripe.com/webhooks → Add endpoint
   - URL: `https://kesefle.vercel.app/api/billing/webhook`
   - Events: select `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`, `invoice.paid`
   - Copy the **Signing secret** (`whsec_...`).
5. Get your API key:
   - https://dashboard.stripe.com/apikeys → copy **Secret key** (`sk_live_...` for production, `sk_test_...` for testing).
6. Add to Vercel env vars:
   - `STRIPE_SECRET_KEY` = the sk_live_... or sk_test_...
   - `STRIPE_WEBHOOK_SECRET` = whsec_...
   - `STRIPE_PRICE_PRO` = price_... (from step 2)
   - `STRIPE_PRICE_FAMILY` = price_... (from step 3)
7. Redeploy.
8. Test the flow: visit https://kesefle.vercel.app/pricing → click "התחל ניסיון Pro" → should redirect to Stripe Checkout.

---

## 🔐 TASK 6 (BONUS — recommended): Generate the encryption key (1 min)

**Why:** Without this, refresh-token encryption can't work. Right now we're in legacy plaintext fallback mode.

### Steps:
1. Open Terminal on your Mac.
2. Run:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
3. Copy the output (it's a 44-character base64 string ending with `=`).
4. Vercel env vars → add:
   - `KESEFLE_DB_KEY` = the base64 string from step 3
   - `KESEFLE_DB_KEY_ACTIVE_KID` = `v1`
5. Redeploy.

After redeploy, all new user signups will encrypt their refresh tokens at rest.

---

## After all tasks done

The product is ready for real customers. The remaining blockers are:
- Google OAuth verification (4-6 week external review for `drive.file` restricted scope)
- Vercel region → EU (1-line config change in Vercel dashboard, Israeli law)
- Dedicated WhatsApp business number procurement (covered in Task 4)

Run https://kesefle.vercel.app/test to verify all 31 automated checks pass after each major change.
