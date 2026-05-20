# Setting the WhatsApp Display Name to "כספ'לה" — Foolproof Guide

**Goal:** make the name users see when the bot messages them say **כספ'לה** (or **Kesefle**) instead of the raw phone number, plus set a profile photo.

**Where this applies:** the Numero production number (`+1 774 544 8053`). Test numbers can't have a custom display name.

**Time:** 10 min to submit · 1–3 business days for Meta to approve.

---

## Before you start
You need: Numero registered for Cloud API (the consumer-app deletion + `registerForCloudAPI` must have succeeded), and access to Meta Business Manager / WhatsApp Manager with the account that owns the Kesefle WABA (`986476207210292`).

---

## Step 1 — Open WhatsApp Manager
1. Go to **https://business.facebook.com/wa/manage/phone-numbers/**
   (or: business.facebook.com → All tools → WhatsApp Manager → Phone numbers)
2. Make sure the top-left business selector shows the portfolio that owns the Kesefle WABA.
3. Find the row for **+1 774 544 8053**.

## Step 2 — Edit the display name
1. Click the **⋯** (three dots) or **Settings / ⚙️** next to the number → **"Edit"** / **"Profile"**.
2. Find **"Display name"** (שם תצוגה).
3. Enter exactly: **`Kesefle`**
   - ⚠️ **Submit the English "Kesefle" first, not the Hebrew "כספ'לה".** English names clear Meta's automated review far more often on the first try. You can switch to Hebrew later once approved.
4. Click **Submit for review**.

## Step 3 — Set the profile photo + business details (while name is in review)
1. Same number → **Profile** tab.
2. **Profile picture**: upload `icon-1024.png` from the repo (the 3D shekel logo). Meta accepts square PNG/JPG.
3. **Category**: **Finance**
4. **Description**: `מעקב הוצאות חכם בוואטסאפ` (or English: `Smart expense tracking on WhatsApp`)
5. **Business website**: `https://kesefle.com`
6. **Email**: `info@kesefle.com`
7. Save. (Profile details don't need the same review as the display name.)

## Step 4 — Wait for the email
Meta emails the result to the account admin in 1–3 business days. Status also shows in WhatsApp Manager next to the number:
- **Approved** ✅ → the name goes live; users now see "Kesefle".
- **Rejected** ❌ → see the recovery section below.

---

## If the display name is REJECTED — recovery

Meta's display-name policy is strict. Common rejection reasons and fixes:

| Rejection reason | Fix |
|---|---|
| **"Doesn't match the business"** | The name must relate to your verified business. Since the business is "SRC collection / Kesefle", `Kesefle` should pass. If not, try `Kesefle Finance` or `Kesefle App`. |
| **Generic word** ("Bot", "WhatsApp", "Expenses") | Never use generic/platform words. Use the brand `Kesefle`. |
| **Trademark / impersonation** | Don't include other brands. `Kesefle` is your own — fine. |
| **Too many rejections** | After 2 rejections Meta may lock resubmission for a few days. Wait, then resubmit with the cleanest form: `Kesefle`. |
| **Hebrew name rejected** | Resubmit in English (`Kesefle`). Once approved in English, you can later request the Hebrew `כספ'לה` as an update — it reviews more leniently when the number already has an approved name + history. |

### How to resubmit
1. WhatsApp Manager → the number → **Edit display name**
2. Change to the new candidate (e.g. `Kesefle`)
3. **Submit for review** again
4. Each submission is independent — a previous rejection doesn't blacklist the number, it just resets the review.

### If you're truly stuck after 3 tries
File a support case: **business.facebook.com/business/help** → "Contact support" → topic "WhatsApp Business display name" → explain "Display name 'Kesefle' matches my verified business 'SRC collection / Kesefle' and keeps getting auto-rejected; please review manually." Manual review takes ~3–5 business days but usually resolves it.

---

## After approval — verify
1. Have someone NOT in your contacts message the bot.
2. They should see **"Kesefle"** (with a verified-business indicator if your messaging tier is high enough) instead of the bare number.
3. The profile photo (the green ₪ logo) appears on the chat header.

---

## Switching to the Hebrew name later (optional)
Once `Kesefle` is approved and the number has some message history (a week+), you can request `כספ'לה`:
1. WhatsApp Manager → number → Edit display name → `כספ'לה`
2. Submit. Hebrew reviews more leniently for an already-established number.
3. If it's rejected, just keep `Kesefle` — it's perfectly fine for an Israeli audience and many local apps use Latin brand names.

---

## Quick reference
- **Display name to submit:** `Kesefle` (English first)
- **Profile photo:** `icon-1024.png` (repo root)
- **Category:** Finance
- **WhatsApp Manager:** https://business.facebook.com/wa/manage/phone-numbers/
- **Review time:** 1–3 business days
- **On rejection:** resubmit cleaner; after 3, file a support case
