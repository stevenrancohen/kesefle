# Meta Business Verification + WhatsApp App Publication — Step-by-Step

**Goal:** unlock the Numero number (`+1 774 544 8053`) so real users can message it. Right now Meta blocks it because the "Expense Bot" app is in Development mode.

**Timeline:** Business verification typically takes 1-3 business days after submission. App publishing is instant once verification is approved.

**What you'll need before starting** (gather these now, in one place):
- ID document — your Israeli תעודת זהות, passport, OR if you have an עוסק פטור / עוסק מורשה, the registration document
- A utility bill, bank statement, or business license that shows your name + address (used to prove identity)
- The privacy policy URL: `https://kesefle.com/privacy` (already live ✅)
- The terms URL: `https://kesefle.com/terms` (already live ✅)
- A 1024×1024 PNG of your logo (you have `/icon-512.png` — needs to be upscaled. I'll handle this if needed)

---

## PHASE 1 — Business Verification (the hard part)

This part proves to Meta you're a real person/business. It's a one-time process.

### Step 1.1 — Open Meta Business Manager

1. Go to https://business.facebook.com/settings
2. Sign in with the same Facebook account you used to create the "Expense Bot" app
3. If you see "Create your business" — click that. Else go to step 1.2.
4. Enter:
   - **Business name**: `Kesefle` (or whatever you want users to see)
   - **Your name**: Steven Ran Cohen
   - **Business email**: srcslcollection@gmail.com
5. Click **Create**

### Step 1.2 — Add Business Info

Once inside Business Manager:

1. Left sidebar → **Business settings** (gear icon)
2. Left sidebar → **Business info**
3. Click **Edit**
4. Fill out **all** fields:
   - Legal business name: **must match your ID document exactly**. If you're using your personal ID, type your full name. If you have an עוסק פטור registration, use the business name on that certificate.
   - Business address: your actual home or office address in Israel
   - Phone number: your Israeli phone (not the Numero one — your real personal phone)
   - Website: `https://kesefle.com`
   - Business email: srcslcollection@gmail.com
5. **Save**

### Step 1.3 — Submit for Verification

1. Still in Business settings → **Security Center** (left sidebar)
2. Find the box that says **"Business verification"** (or "Verify your business")
3. Click **Start verification**
4. Choose **Verify with documents** (the other option is phone verification — only available for certain countries)
5. Upload TWO documents:
   - **Document 1**: Your ID — תעודת זהות (both sides as one PDF/image) OR passport
   - **Document 2**: A utility bill OR bank statement OR עוסק registration certificate. Must show your name + same address as in Business Info.
6. Click **Submit**

You'll see status: **"Pending review"**. Meta usually responds in 1-3 business days. You'll get an email at srcslcollection@gmail.com.

**If you get rejected:** the rejection email tells you exactly which field/document failed. Most common reasons:
- Document name doesn't match Business Info name → retype Business Info to match the document exactly
- Document is blurry / cropped → re-scan with phone, hold steady, good lighting
- Address mismatch → make sure utility bill address matches Business Info address letter-for-letter

---

## PHASE 2 — Approve WhatsApp Business Account

While Phase 1 is pending, you can prep Phase 2.

### Step 2.1 — Link the WhatsApp Account to the Business

1. Meta Business Manager → **Accounts** → **WhatsApp accounts**
2. You should see a row for the Numero phone number under "Kesefle" (or whatever you named the WhatsApp Business Account during initial setup)
3. If you don't see it: click **Add → WhatsApp account** → follow the wizard with your existing phone number
4. Once visible, click the account → **Settings**
5. Verify:
   - Display name: `כסף'לה` or `Kesefle` (this is what users see when the bot messages them — they may need to approve it)
   - Category: **Business services** or **Finance**
   - Description: `מעקב הוצאות חכם בוואטסאפ` (or English version)
   - Profile photo: upload the 1024×1024 logo

### Step 2.2 — Request Display Name Approval

This is the gotcha. Even if your business is verified, WhatsApp requires display name approval separately.

1. Still in WhatsApp Account settings → **Phone numbers**
2. Click the Numero number (`+1 774 544 8053`)
3. Find **Display name** → click **Edit**
4. Type `כסף'לה` (or whatever)
5. **Submit for approval** — also 1-3 business days

You CAN submit Phase 1 and Phase 2 in parallel — they review independently.

---

## PHASE 3 — Publish the Meta App

Once Business Verification is **approved** (you'll get the email), do this:

### Step 3.1 — Open the Expense Bot app

1. https://developers.facebook.com/apps
2. Click **Expense Bot**

### Step 3.2 — Switch App Mode to Live

1. Top of the dashboard, find the **"App Mode"** toggle (currently says "Development")
2. Click → switch to **Live**
3. Meta will check that you have:
   - ✅ Privacy Policy URL set (paste `https://kesefle.com/privacy` in App Settings → Basic if not already)
   - ✅ Terms of Service URL set (paste `https://kesefle.com/terms`)
   - ✅ App icon uploaded (1024×1024 PNG)
   - ✅ Business verification approved
   - ✅ Category selected (Finance)

If any of these are missing, Meta blocks the switch and tells you which one. Fix that field and try again.

### Step 3.3 — Confirm webhooks still work

1. WhatsApp → Configuration → Webhooks
2. Should still show your `/exec` URL and `messages` subscribed (from earlier setup)
3. No action needed unless Meta cleared it during publish (rare)

### Step 3.4 — Test

Send `סטטוס` from a phone OTHER than your own test devices (e.g. a friend's phone) to `+1 774 544 8053`. Should reply within 2 seconds.

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| "Business verification failed" email | Document name ≠ Business info name | Edit Business Info to match document exactly (incl. middle names) |
| "Cannot upgrade app mode" | Privacy URL not set | Settings → Basic → add `https://kesefle.com/privacy` |
| Webhook stops receiving messages after going Live | `messages` subscription cleared | Re-subscribe in Configuration |
| "Display name rejected" | Used a generic word like "Bot" or "WhatsApp" in display name | Use the brand name `Kesefle` or `כסף'לה` |
| Submission stuck on "Pending" >5 days | Meta queue backlog | Email `developers-support@fb.com` with case number in subject line |

---

## After approval — what changes

- ✅ Numero number (`+1 774 544 8053`) starts receiving real production messages
- ✅ Any phone number worldwide can message it (no more 5-recipient limit)
- ✅ The yellow "Apps will only receive test webhooks" warning in Meta Developer Console disappears
- ✅ You can keep using the Test Number (`+1 555 640 8123`) as a sandbox — both work simultaneously
- ✅ Pricing: Meta charges per "conversation" — Israel rate is roughly $0.005-$0.024 per 24-hour conversation depending on category (utility vs marketing). Real users having normal conversations cost cents per month per user

---

## My recommendation: do Phase 1 NOW

Even if you're not ready to launch publicly, kick off Business Verification today. The 1-3 day review clock starts the moment you submit. While it's pending, you and I keep building features. By the time approval lands, the product will be much more complete.

Steps to do RIGHT NOW (15 minutes):
1. Scan your תעודת זהות (both sides)
2. Find a utility bill or bank statement
3. Open https://business.facebook.com/settings → start the verification flow
4. Submit
5. Tell me when submitted so I can update our timeline

Don't wait for everything to be perfect — submit imperfect, iterate on rejections. That's the fastest path.
