# 🤖 Bot Not Replying — Step-by-Step Debug

Steven, when you wake up: follow this in order. The bot can fail in 5 specific places — we'll check each.

## TL;DR — most likely cause

You pasted the new bot code into Apps Script, but you didn't **Deploy → New Version**. Just saving the code isn't enough. Apps Script only uses the deployed version when responding to webhooks.

**Quick fix:** Apps Script editor → top right → **Deploy** → **Manage Deployments** → click ✏️ on the existing deployment → **Version: New version** → **Deploy**. Done.

If that doesn't fix it, follow the full checklist below.

---

## Full debug checklist

### Step 1 — Is the new code actually deployed?

1. Open https://script.google.com → find the Kesefle/Expenses Bot project
2. Top right: **Deploy** → **Manage Deployments**
3. Look at the deployment URL and the **Version number** next to it
4. If the version number didn't increase since you pasted the code → you didn't deploy a new version. Click ✏️ → "New version" → Deploy.

The deployment URL should look like:
```
https://script.google.com/macros/s/AKfycb.../exec
```
Copy it. We'll use it in Step 3.

### Step 2 — Run installKesefleBot() once

I added a master diagnostic function. Run it once to verify the bot is healthy:

1. In Apps Script editor, in the **function dropdown** at the top (it shows function names), select `installKesefleBot`
2. Click the **▶ Run** button
3. If asked for permissions → Allow
4. Click **View → Execution log** (or Cmd+Enter)
5. Read the report — it shows ✅ / ⚠️ / ❌ for each requirement:
   - `WHATSAPP_TOKEN` — must be set (your Meta access token)
   - `WHATSAPP_PHONE_NUMBER_ID` — should be `1090404180828069` (the new bot number)
   - `SHEET_ID` — must be accessible
   - Triggers — all 4 should be installed

If ANY ❌ appears, fix that first. The most common issue is missing `WHATSAPP_TOKEN`.

### Step 3 — Verify Meta webhook URL points at your Apps Script

1. Go to https://developers.facebook.com/apps
2. Find your Kesefle/Expenses Bot app → **WhatsApp → Configuration → Webhooks**
3. Verify the **Callback URL** is your Apps Script deployment URL (from Step 1)
4. Verify the **Verify Token** matches `expense_bot_verify_2026` (line 27 of the bot code)
5. Click **"Verify and Save"** — should say "Successfully verified"
6. Make sure the **`messages` webhook field** is **subscribed** (toggle on, green)

### Step 4 — Run "echo" command from WhatsApp

I added an "echo/ping" command for testing. Send to your bot from WhatsApp:
```
ping
```

If the bot is alive, it'll reply within 2 seconds:
```
🏓 הבוט פעיל! קיבלתי את "ping" ב-HH:MM:SS
```

If you get no reply:
- Apps Script isn't being called (Meta webhook config issue) — go back to Step 3
- OR the WHATSAPP_TOKEN is invalid — re-generate at Meta and update Script Properties

### Step 5 — Send "סטטוס" command

Once echo works, send:
```
סטטוס
```

The bot replies with full status:
```
🤖 מצב הבוט
━━━━━━━━━━━━━━━━━━

✅ הבוט פעיל
📞 מספר: +17745448053
🆔 Phone ID: ...80828069
📊 הוצאות בגיליון: 47
🧠 AI fallback: ✅ פעיל
🕐 18/05/2026 14:23
```

If `Phone ID` doesn't end in `80828069` → the bot is using the wrong phone number ID. Set the Script Property `WHATSAPP_PHONE_NUMBER_ID` to `1090404180828069`.

If `AI fallback: ⚠️ לא פעיל` → set `ANTHROPIC_API_KEY` in Script Properties (or leave it — the bot works without AI thanks to 18,725 keywords).

### Step 6 — Try a real expense

```
245 סופר
```

You should get within 2 seconds:
```
✅ ₪245 לסופר. נשמר אצלך בגיליון 📊
📂 אוכל
🏷️ אוכל לבית
💡 החודש הוצאת ₪X על אוכל.
🌱 הוצאה ראשונה! יום 1 של מעקב.

כתוב "סיכום" לראות איפה אתה עומד החודש.
```

If you got this — **the bot is working**. 🎉

### Step 7 — Check Apps Script execution log

If you sent a message but got no reply, check what Apps Script did:

1. Apps Script editor → left sidebar → **Executions**
2. Look at the most recent `doPost` execution
3. Click to expand
4. Look at the log output:
   - Did `doPost: from=...` appear? → Meta successfully called your webhook
   - Did `sendWhatsAppMessage done` appear? → Bot tried to reply
   - Did an error appear? → Read the error message

The most common errors:
- `"Cannot read property 'from' of undefined"` → Meta sent a status update (not a message). Ignore this.
- `"WhatsApp token not configured"` → Set `WHATSAPP_TOKEN` in Script Properties
- `"DEADLINE_EXCEEDED"` → Apps Script timed out. Should auto-recover.
- `"Authorization failed"` → Re-authorize Apps Script (run any function manually once)

---

## If Vercel deploy was failing

You showed me the screenshot earlier — "No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan."

You upgraded to Pro, which allows 24+ functions. To trigger a fresh build:
1. Open https://vercel.com/dashboard → kesefle project
2. **Deployments** tab → click the **⋯** menu on the latest failed deployment
3. Click **Redeploy** → uncheck "Use existing Build Cache" → Redeploy

OR just push any commit (I'll do this after writing this doc to force a rebuild).

---

## Where to find `installAllMotivationTriggers()`

You asked about this. **Specific steps:**

1. Open https://script.google.com → Kesefle bot project
2. At the top of the editor, you'll see a **function dropdown** (says "select function" or shows the name of a function)
3. Click that dropdown → scroll through the list → find:
   - `installAllMotivationTriggers` — installs ALL 4 cron triggers at once (recommended)
   - OR pick individual ones:
     - `installWeeklySummaryTrigger` — Sundays 9am summary
     - `installDailyMotivationTrigger` — Daily 9:30am motivation
     - `installWeeklySavingsProjectionTrigger` — Friday 5pm savings projection
     - `installInactivityTrigger` — Tuesday 9am reactivation
4. Once selected, click the **▶ Run** button (top of editor)
5. Authorize if asked (Google's "App not verified" warning is normal — click "Advanced → Go to Kesefle (unsafe)" since you ARE Kesefle)
6. Check the **Execution log** → should say `✅ ... trigger installed`

To verify the triggers are set up:
- **Apps Script left sidebar → Triggers** (clock icon)
- You should see 4 entries for your cron functions

To remove them: run `uninstallMotivationTriggers()`.

---

## TL;DR action list for tomorrow

1. Run `installKesefleBot` in Apps Script
2. Read the report — fix any ❌ errors
3. Send `ping` from WhatsApp — verify the bot replies
4. Send `245 סופר` — verify it writes to the sheet
5. Run `installAllMotivationTriggers` to enable daily/weekly cron messages
6. Done — bot is production-ready
