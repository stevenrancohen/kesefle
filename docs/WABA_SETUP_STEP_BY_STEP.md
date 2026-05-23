# How to get your real WhatsApp Business number — step by step

**Why this matters:** the current bot number `+1 555 640 8123` is a Meta TEST number.
- It can only message **5 phone numbers per day** that you manually allow-list.
- It cannot scale to 1,000 customers — ever.
- Real WhatsApp users see "this number isn't on WhatsApp" if they're not allow-listed.

You need a **WABA-approved phone number**. Here are the 3 options, ranked by speed.

---

## Option 1 (FASTEST, recommended): Use a Business Solution Provider (BSP)

A BSP handles the WABA application paperwork FOR you. You get a number same-day in most cases.

**Recommended BSPs for Israel:**

### A. 360dialog (best for Israel, English support, no monthly minimum)

1. Go to **https://hub.360dialog.com/signup**
2. Sign up with your email (`info@kesefle.com`).
3. Click **"Connect a number"** → choose **"I want a NEW number"** (if you don't already own one) OR **"I have an existing number"** (if you have a SIM card you can dedicate).
4. Pick a number — they offer Israeli, US, UK, German numbers. Israeli costs around €15/month.
5. Submit the business verification form:
   - Business name: **Kesefle**
   - Business email: `info@kesefle.com`
   - Business website: `https://kesefle.com`
   - Display name: **כספ'לה** (this is what users will see)
6. Wait 24-48 hours for Meta to approve. They sometimes approve in 30 minutes.
7. Once approved, 360dialog gives you:
   - `D360-API-KEY` (your API key)
   - `PHONE_NUMBER_ID` (your number's internal ID)
   - `WABA_ID` (your business account ID)
8. **Paste those 3 values to me here in chat** — one message, one per line:
   ```
   D360-API-KEY: <paste>
   PHONE_NUMBER_ID: <paste>
   WABA_ID: <paste>
   ```
9. I'll swap them into the bot + Vercel within 5 minutes, run `scripts/swap-bot-number.sh`, and push.

**Total time**: 30 min of your work + 24-48h waiting for Meta.

### B. Twilio (US-friendly, more expensive)

Same idea, but their UI: **https://console.twilio.com/us1/develop/sms/services/whatsapp-senders**. Costs ~$5/month + per-message fees. Skip unless you already use Twilio.

### C. Vonage / MessageBird / Infobip

Similar to 360dialog. Pick whichever has the best price for Israeli numbers (~€10-20/month).

---

## Option 2 (FREE but slow): Apply directly to Meta yourself

This avoids the BSP monthly fee but takes 1-3 days and requires you to handle the verification yourself.

1. Go to **https://business.facebook.com**. Sign in with the Facebook account that owns Kesefle's Business Manager.
2. Left menu → **Business Settings** → **WhatsApp Accounts** → **Add**.
3. Click **"Create a WhatsApp Business Account"** if you don't have one. Fill in:
   - Display name: **כספ'לה**
   - Business category: **Financial Services**
   - Time zone: **Asia/Jerusalem**
4. Once the WhatsApp Business Account is created → click **"Add phone number"**.
5. Choose:
   - **Option A**: Bring your own SIM (you'll get an SMS code to verify). Use a SIM you don't use for personal WhatsApp.
   - **Option B**: Buy a Meta-provided number (~$1/mo, but only available in some countries — Israel is hit-or-miss).
6. Enter the phone number, choose **SMS** for verification, receive code, enter code.
7. Meta starts the verification. You'll see status: **"Restricted"** at first (can message 50 unique users/day) → after Meta approves your business (1-3 days), status becomes **"Verified"** (1,000 users/day → 10,000 → 100,000 as you tier up).
8. Once Verified, go to **WhatsApp Manager** → click your phone → **"API Setup"** → copy the values:
   - **Permanent Access Token** (this is your bot's `WHATSAPP_TOKEN`)
   - **Phone Number ID**
   - **WhatsApp Business Account ID**
9. **Paste them to me here** (same format as Option 1 step 8).

**Total time**: 1 hour of your work + 1-3 days waiting.

---

## Option 3 (RISKY): Use the Numero number you already had

You mentioned earlier you have `+1 774 544 8053` from Numero. We never finished activating it. If you still have the Numero account:

1. Log into **https://www.numero.com**.
2. Confirm the number `+1 774 544 8053` is still active in your account.
3. Go to **business.facebook.com** → Business Settings → WhatsApp Accounts → Add → Add phone number → enter `+1 774 544 8053`.
4. Meta sends a verification SMS to that number. Receive it on your Numero app, enter the code.
5. Continue from Option 2 step 7.

**Total time**: same as Option 2 (1-3 days for Meta verification). The Numero number isn't really faster than getting a new SIM.

---

## My recommendation

**Pick Option 1.A (360dialog)** unless cost is critical. It's the fastest reliable path.

If you go with Option 2, **start the application NOW** while we work on everything else — Meta's review queue is the actual bottleneck.

---

## What I'm doing in parallel (no action needed from you)

While you handle the WABA application, I'm:
1. ✅ Centralizing the bot number into one config key so the eventual swap is a 1-line change (`scripts/swap-bot-number.sh` already exists).
2. Building a **KV usage watchdog** that warns you at 80% of the Upstash free tier (since you chose not to upgrade — we need to see it coming).
3. Building **/admin/launch-monitor** — a real-time dashboard with: signups in last hour, success/failure rate, top error reasons, bot reachability, KV health.
4. Hardening the retry flow for paid-traffic users (every drop-off = wasted ad money).
5. Writing the observability setup guide (next doc).

**Tell me which option you picked and I'll prep the exact config snippet you'll paste back when you have the values.**
