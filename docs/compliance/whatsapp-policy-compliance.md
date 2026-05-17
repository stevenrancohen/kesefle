# WhatsApp / Meta Policy Compliance — Kesefle

Last updated: 2026-05-16
Owner: Steven Ran Cohen
Surface: WhatsApp Business Cloud API via Meta Business Platform

---

## 1. Is "expense tracking" allowed under Meta's policies?

Meta's policies that govern Kesefle:
1. **WhatsApp Business Messaging Policy** (the day-to-day rulebook for sending)
2. **WhatsApp Business Solution Terms** (commercial terms)
3. **WhatsApp Commerce Policy** (only applies if you sell goods/services *inside* WhatsApp via catalogs — we don't)
4. **Meta Platform Terms** (umbrella)

**Verdict:** expense tracking is **allowed** — it falls under "personal productivity / utility" use cases. It is **not** a regulated financial service under Meta's policy (we do not move money, hold deposits, or give regulated advice).

Risk flags to keep clear of:
- **No deceptive financial claims.** Saying "Kesefle will save you 30% on expenses" without basis = violation.
- **No facilitating crypto/forex/CFD trading.** Forbidden category.
- **No lending or credit products.** If we ever add "buy now pay later" suggestions = restricted.
- **No tax-prep services without disclosure.** See disclaimers-and-boundaries.md.
- **No sharing user data with third parties** other than what's needed to deliver the service.

---

## 2. Opt-in requirements

Meta requires **explicit, demonstrable opt-in** before you can send a WhatsApp message to a phone number. "Demonstrable" means you can produce evidence at audit:
- The exact phrasing the user saw
- Timestamp of acceptance
- Source (web form, IVR, paper, etc.)
- The user's phone number

Kesefle's opt-in flow:
1. User signs up on kesefle.app, completes Google OAuth.
2. On /account.html, user is asked: "Enter your WhatsApp number to connect the bot."
3. Below the input, a clearly-visible checkbox (**default unchecked**) labeled with the exact text below.
4. On submit, Kesefle stores `optIn: { ts, ip, ua, phone, text }` in KV.

### Required opt-in text (Hebrew + English)

Hebrew:
```
☐ אני מסכים/ה לקבל הודעות וואטסאפ משירות "כסף'לה" לצורך
   רישום ההוצאות שלי, אישורים, ותשובות לפניות שלי. ידוע לי שאוכל
   להפסיק את ההתכתבות בכל עת על ידי שליחת המילה "עצור" לבוט.
```

English (for international users):
```
☐ I consent to receive WhatsApp messages from Kesefle for expense
   logging, confirmations, and replies to my queries. I understand
   I can stop messaging at any time by sending "STOP" to the bot.
```

**Critical:** the box must be **unchecked by default**. Pre-checking violates Meta policy and Israeli direct-mailing law.

### After opt-in: confirmation message

Kesefle sends a single welcome message that confirms the opt-in and reaffirms the stop word:

```
שלום! 👋 חברנו את המספר שלך לחשבון "כסף'לה" שלך.
כדי לרשום הוצאה, שלח לי הודעה כמו: "245 סופר" או "60 אובר".
כדי לעצור — שלח "עצור". כדי לקבל עזרה — שלח "עזרה".
```

---

## 3. Template messages vs. session/free-form messages

WhatsApp distinguishes two types of outbound messages:

| Type | When usable | Cost | Approval |
|---|---|---|---|
| **Session/free-form** | Within 24h of the user's last message to you | Cheap (~$0.005) | None needed |
| **Template** | Anytime, including > 24h after last user message | Per-template | Each template requires Meta review (~minutes-hours) |

Kesefle's pattern:
- **Expense confirmations** (`✅ נרשם: ₪245 · סופר`) — always within 24h of the user's incoming message → session messages, no template.
- **Weekly summary** (e.g. "השבוע הוצאת ₪1,247") — sent on a schedule, often > 24h → **must be a template**.
- **Bill-due reminders** (planned) — proactive → **template**.
- **Onboarding welcome** — sent within seconds of opt-in → session message (the opt-in counts as user-initiated when paired with a webhook event).

### Templates to register with Meta (Hebrew, UTILITY category)

1. `weekly_summary_he` — "השבוע הוצאת ₪{{1}} ב-{{2}} קטגוריות. הקטגוריה המובילה: {{3}}."
2. `monthly_summary_he` — "סיכום {{1}}: סה״כ ₪{{2}}. הנה הפירוט: {{3}}"
3. `bill_reminder_he` — "תזכורת: הוצאה חוזרת ל-{{1}} בסך ₪{{2}} צפויה ב-{{3}}."
4. `onboarding_he` — "ברוך הבא ל-כסף'לה, {{1}}! התחל ב: '{{2}}'"
5. `account_change_he` — "המנוי שלך {{1}}: {{2}}. שאלות? {{3}}"

All under category **UTILITY** (not MARKETING) — utility templates aren't subject to the per-conversation marketing fee and have lower rejection rates.

Avoid these template no-nos that get rejected:
- All-caps subject lines
- Excessive emojis (more than 1 per sentence)
- URLs in template body unless registered in template variables
- Promotional language ("buy now", "discount") — those force MARKETING category

---

## 4. Phone number business verification

Required steps with Meta:
1. **Create a Meta Business Account** at business.facebook.com using a verified business email (use a corporate email, not gmail.com — gmail addresses get extra scrutiny).
2. **Add the WhatsApp Business Cloud API product** in Meta Business Suite.
3. **Verify the business** — upload incorporation certificate of SRC Solutions (תעודת התאגדות / עוסק מורשה). For Israeli sole proprietor: תעודת עוסק מורשה + תעודת זהות. For ח״פ: תדפיס רשם החברות.
4. **Register the phone number** — must be a number NOT currently used in personal WhatsApp. The current `+1-774-544-8053` listed in privacy.html appears to be Steven's personal WhatsApp — **DO NOT use this for the API**. Procure a dedicated number (Twilio, MessageBird, or an Israeli SIM never used for WhatsApp).
5. **Set the display name** — "Kesefle" or "כסף'לה". Meta reviews this in 1–3 days. Display name **cannot** contain "Bot", "Official", or generic words like "Service".
6. **Choose messaging tier** — start at Tier 1 (1,000 conversations/24h). Auto-upgrade to Tier 2 at 50% quality + 2k unique users in 7d.

---

## 5. Risks of getting the business number banned

Top causes of bans + mitigations:

| Risk | Cause | Mitigation |
|---|---|---|
| **Mass-sent unsolicited messages** | Sending to numbers that didn't opt in | Strict opt-in (above). Never import contacts. |
| **High block rate** | Users block the bot | Monitor `messages.blocked` webhook; if > 2% in 24h, throttle. |
| **High report-as-spam rate** | Users tap "Report" in WhatsApp | Track Meta's "Quality Rating" in Business Manager. Green = OK, Yellow = warning, Red = throttled/banned. |
| **Sending templates outside category** | Marketing content in UTILITY template | Review every template before submitting. |
| **24-hour window violations** | Sending free-form > 24h after last user message | Server-side guard: before sending free-form, check `last_user_message_ts` in KV; if > 24h, force template or skip. |
| **Phone number recycling** | Using a number that previously violated | Use a fresh number with no WhatsApp history. |
| **Geographic concentration anomalies** | All messages to one country at unusual hours | Naturally fine for an Israel-focused bot, but if we scale internationally, distribute. |
| **Forbidden content** | Crypto, escort, weapons, illegal drugs | N/A for expense tracking, but moderate user-generated content if we ever surface it. |

### Server-side guard (recommended code addition to `api/whatsapp/webhook.js`)

```js
// Before any sendReply that's NOT an immediate response to a user message:
async function canSendFreeform(userPhone) {
  const last = await kvGet(`last_inbound:${userPhone}`);
  if (!last) return false;
  const ageMs = Date.now() - last.ts;
  return ageMs < 24 * 3600 * 1000;
}

// On every inbound message:
await kvSet(`last_inbound:${fromPhone}`, { ts: Date.now() }, { EX: 90000 });
```

Currently `webhook.js` does not record `last_inbound`. **Add this.**

---

## 6. Stop / pause / help commands (required behavior)

Meta strongly recommends supporting:
- `STOP` / `עצור` / `הפסק` — immediately opt out, no further messages until re-opt-in
- `START` / `התחל` — re-opt-in (require a fresh checkbox confirmation on the web app to be safe)
- `HELP` / `עזרה` — return a short help message + link to /account.html
- `MENU` / `תפריט` — list of commands

Implementation:
```js
const STOP_WORDS = ['stop', 'עצור', 'הפסק', 'unsubscribe', 'בטל'];
if (STOP_WORDS.includes(text.trim().toLowerCase())) {
  await kvSet(`optin:${fromPhone}`, { active: false, stoppedAt: Date.now() });
  await sendReply(fromPhone, 'הופסקה ההתכתבות. כדי לחדש — היכנס ל-https://kesefle.app');
  return res.status(200).json({ ok: true, stopped: true });
}
```

**This must be added to `webhook.js` BEFORE any classification logic.** Currently absent.

---

## 7. Data minimization in WhatsApp logs

Section 3ב of privacy.html says we keep message logs 90 days. Audit what we log:

| Field | Necessary? | Recommended retention |
|---|---|---|
| Message text | Yes (for support + classifier improvement) | 90 days, then aggregate stats only |
| Phone number | Yes (to route) | Indefinite while account active |
| Meta `message.id` | Yes (idempotency) | 24h is enough |
| User profile (name from WhatsApp) | Optional | Don't store unless needed |
| Media (images, voice notes) | We don't support yet | When added: 30 days, encrypted at rest |

Action: add a daily cron (Vercel Cron) that purges `wa_log:*` entries older than 90 days from KV.

---

## 8. Meta-specific incident scenarios

See incident-response-runbook.md sections 2 + 3 for full playbook. Specifically:
- Phone number tier downgrade
- Display name rejection
- Account quality red status
- Business verification revoked

---

## 9. Pre-launch WhatsApp checklist

- [ ] Dedicated business phone number procured (not Steven's personal)
- [ ] Meta Business verified (business docs uploaded)
- [ ] Display name "Kesefle" / "כסף'לה" approved
- [ ] 5 utility templates submitted + approved
- [ ] Opt-in checkbox in /account.html with unchecked default + opt-in record stored
- [ ] `STOP`/`עצור` handler in webhook.js
- [ ] `last_inbound` timestamp recorded per user
- [ ] 24h-window guard before any non-response message
- [ ] Quality monitoring dashboard (Meta Business Suite → WhatsApp → Insights)
- [ ] Backup business number obtained but not activated (for rapid failover)
- [ ] Webhook HMAC verification confirmed working (`META_APP_SECRET` set on Vercel)
- [ ] Rate limit on inbound webhook to prevent webhook flooding
