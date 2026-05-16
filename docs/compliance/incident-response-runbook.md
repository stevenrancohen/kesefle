# Incident Response Runbook — Kesefle

Last updated: 2026-05-16
Owner: Steven Ran Cohen (srcslcollection@gmail.com)
On-call rotation: solo (Steven) until team grows
Status page: TBD — recommendation: status.kesefle.app via Vercel + Better Stack ($0–29/mo)

---

## 0. Severity scale

| SEV | Definition | Response time | Notify |
|---|---|---|---|
| SEV-1 | Data breach, active exploit, OAuth tokens leaked, sheet contents leaked | < 1h | PPA + users + insurer |
| SEV-2 | Service down for > 25% of users, WhatsApp number banned, Stripe frozen | < 4h | Users on status page |
| SEV-3 | Partial degradation (slow webhook, classifier accuracy drop) | < 24h | Status page note |
| SEV-4 | Cosmetic, single-user issue | Next business day | None |

---

## 1. DATA BREACH (SEV-1)

A "breach" = unauthorized access, disclosure, alteration, or loss of personal data.

### Examples
- Upstash KV credentials leak → attacker reads `phone:*` and `sheet:*` records
- Refresh-token leak → attacker writes to user's sheets
- Vercel build artifact contains hardcoded secrets pushed to public Git
- Compromised Google account = read of every user's sheet
- A user reports they're seeing someone else's data in their sheet

### Step 1 — Contain (first 60 minutes)
1. **Stop the bleed first.** If you suspect Upstash is compromised: rotate `KV_REST_API_TOKEN` in Upstash dashboard; redeploy Vercel.
2. If Google service-account / OAuth client compromised: revoke client at <https://console.cloud.google.com/apis/credentials>; force-revoke all user refresh tokens via `POST https://oauth2.googleapis.com/revoke?token=<refresh_token>` in a loop.
3. If Meta access token compromised: regenerate System User token in Meta Business Suite; old token auto-invalidates.
4. If Vercel deploy key leaked: revoke at Vercel dashboard → Settings → Tokens.
5. Disable signups (toggle a feature flag, or push an emergency commit replacing the OAuth button with a maintenance message).
6. Save **everything**: logs, deploy IDs, suspect commits, screenshots, timestamps. Create `/tmp/incident-YYYY-MM-DD/` and dump everything there. **Do not delete or "clean up" anything** until the incident is closed.

### Step 2 — Investigate (hours 1–24)
1. Establish facts only:
   - What data was accessed/modified/exfiltrated?
   - How many users affected?
   - When did it start? When was it discovered?
   - What's the attack vector?
2. Pull Vercel function logs for the relevant window.
3. Pull Upstash command audit (Upstash → Console → Audit Logs).
4. Check Google Cloud Audit Logs for unusual Drive/Sheets API patterns.
5. Check Meta Business Suite → Account Quality for anomalies.
6. Document a timeline. Use ISO 8601.

### Step 3 — Notify (legal deadlines)

**Israeli PPA (Privacy Protection Authority):**
- Threshold: "severe security incident" — concretely, anything affecting > 100 subjects OR exposing sensitive data (financial qualifies).
- Deadline: "as soon as possible" — interpret as **within 72 hours of discovery**.
- Channel: email to `mb@justice.gov.il` (or via the PPA's incident form when published).
- Template at end of this doc.

**EU users (GDPR):**
- Deadline: **72 hours** to notify lead supervisory authority (likely Ireland DPC if Kesefle establishes EU presence, otherwise user's home authority).
- High risk to users → notify users directly without undue delay.

**Affected users:**
- Channel: email (primary), WhatsApp message if WhatsApp data was breached, banner on /account.html.
- Plain Hebrew, no jargon, no "we take security seriously" filler.
- What happened, what data, what we're doing, what they should do (e.g. revoke OAuth, change passwords on related accounts).
- Template at end of this doc.

**Insurer:** if professional indemnity / cyber policy is in place, notify per policy terms (typically 48h).

**Google:** if the breach involves Google user data accessed via OAuth, file at <https://support.google.com/cloud/contact/cloud_platform_report>.

**Meta:** if WhatsApp message content was breached, report via Meta Business Support.

### Step 4 — Remediate
- Patch the vulnerability.
- Force re-consent for all affected users.
- Rotate all secrets even if not directly involved.
- Add a regression test or monitor that would have caught this.
- Conduct post-mortem within 1 week; share a redacted version on /status.

### Step 5 — Post-mortem template
```
INCIDENT POST-MORTEM — YYYY-MM-DD

SUMMARY (3 sentences):
TIMELINE (UTC):
ROOT CAUSE:
IMPACT:
  - Users affected: N
  - Data exposed: …
  - Duration: from T1 to T2
DETECTION:
RESPONSE:
WHAT WENT WELL:
WHAT DID NOT:
ACTION ITEMS (owner, due date):
  1. ...
  2. ...
```

---

## 2. WHATSAPP NUMBER BANNED (SEV-2)

### Symptoms
- Outbound `messages` API returns `131056` (number not registered) or `131009` (account restricted)
- Meta Business Suite shows "RESTRICTED" or "FLAGGED"
- Quality rating turns red

### Immediate response
1. Stop all outbound sends immediately (set `WHATSAPP_OUTBOUND_DISABLED=true` env var → webhook checks this flag before sending).
2. Post on status.kesefle.app: "WhatsApp temporarily unavailable — we're investigating. Your data is safe in your Google Sheet."
3. Send email to all opted-in users (we have their email from Google sign-in): "WhatsApp is offline. You can still view your sheet at [link]. We'll notify you when it's back."

### Diagnose
1. Open Meta Business Suite → WhatsApp Account → Quality and check the reason.
2. If "high block rate": likely sent unsolicited messages. Pause campaigns, never resume to those numbers.
3. If "policy violation": review last 7 days of templates and message content for prohibited content.

### Recovery options
1. **Appeal** within Business Suite (response in 1–7 days).
2. **Activate backup number.** Pre-provisioned dedicated backup phone (see whatsapp-policy-compliance.md §9). Steps:
   a. Switch the number in Meta Business → WhatsApp → Phone Numbers.
   b. Update Meta webhook subscription to the new phone number ID.
   c. Update `META_PHONE_NUMBER_ID` env var in Vercel; redeploy.
   d. Send all users an in-app notification: "המספר שלנו השתנה — שמור [new number] ולחץ פה כדי לקבל הודעה ראשונה."
3. **Hard worst case:** entire Meta Business account banned. Then need a new business entity (or appeal at the business level). Have backup BM ready or use a BSP (e.g. 360dialog, Twilio) which provides a layer of abstraction.

### Prevention
- Quality rating monitor: poll Meta API daily for `quality_rating`. Alert if not green.
- Pre-approve every template before sending.
- Never send a message > 24h after last user message unless via approved template.

---

## 3. GOOGLE OAUTH VERIFICATION REJECTED (SEV-2 → blocks launch)

### Symptoms
- Email from Google saying "verification request denied" with reasons.
- App is blocked from getting new users beyond 100 test users.

### Common rejection reasons + responses

| Reason | Response |
|---|---|
| Privacy policy missing Limited Use disclosure | Update privacy.html and resubmit |
| Demo video unclear | Re-shoot per `google-oauth-verification.md` §4 |
| Scope justification not specific enough | Use the more detailed text in `google-oauth-verification.md` §3 |
| Domain not verified | Verify in Search Console under the SAME Google account that owns the Cloud project |
| App name conflicts with Google's brand | Rename if needed |
| CASA Tier 2 not completed | Book and complete |

### If denied permanently
- Worst case: redesign to use only `drive.readonly` and ask users to manually create a sheet from a public template, then paste the URL. Less smooth but doesn't need restricted scope.
- Alternative: ship as an **Apps Script add-on** (different review track, often easier).

### Backup plan
While Google verification is pending, run the test-user cap (100 active). Curate that list as paying customers. Use those 100 to generate the case studies + revenue for any contested re-review.

---

## 4. STRIPE ACCOUNT FROZEN (SEV-2)

Not yet relevant (no Stripe integration shipped), but plan now.

### Common triggers
- Chargeback rate > 1%
- Sudden volume spike that triggers risk model
- Unverified business profile
- Refunds processed manually outside Stripe

### Response
1. Stripe Dashboard → Account → review the alert. Often Stripe wants documentation: business registration, recent bank statements, sample customer agreement.
2. Reply within Stripe's stated window (often 48h).
3. Meanwhile: pause new signups requiring payment. Existing free users unaffected. Existing paid users: their billing cycle continues if the account is held, not closed.

### Backup
- Have a secondary payment processor pre-integrated but inactive (Paddle or Lemon Squeezy — both handle EU VAT for us, reducing tax compliance burden). Document the switch-over runbook.
- Issue refunds via the secondary processor if Stripe is frozen and customers demand.

---

## 5. SERVICE OUTAGE (SEV-2 or SEV-3 depending on scope)

### Components and their failure modes
| Component | Failure | Mitigation |
|---|---|---|
| Vercel functions | Region outage | Vercel auto-fails over; check status.vercel.com |
| Upstash KV | Region outage | Switch to backup region (Upstash global replication on paid plans) |
| Google Sheets API | Rate limit / outage | Exponential backoff in code; queue writes in KV |
| Meta WhatsApp API | Outage | Queue outbound; drop replies > 23h to avoid window violation |

### Communication
- **Status page (status.kesefle.app)** — primary channel. Use Better Stack or Statuspage.
- **Banner on kesefle.app** — for any SEV-2+.
- **WhatsApp template `service_status_he`** — pre-approve a UTILITY template for proactive notification: "תקלה זמנית — אנחנו על זה. הנתונים שלך בטוחים בגיליון."
- **Email** — for sustained outages > 4h.

### Reporting template
> "[STATUS] Kesefle בעיה ב-{component} מאז {start_time}. הסיבה: {cause}. {אם משפיע על נתונים}: הנתונים שלך בגיליון בטוחים. עדכון הבא ב-{next_update_time}."

Post initial within 15 min of detection, update every 30 min until resolved, post resolution + post-mortem link within 24h.

---

## 6. SECRETS LEAKED IN PUBLIC GIT (SEV-1)

### Detection
- GitHub secret scanning (enable on the repo)
- Periodic `git log -p | grep -iE 'sk_|api[_-]?key|bearer|secret'`
- TruffleHog or gitleaks in CI

### Response
1. **Rotate every leaked secret immediately**. Do not assume "no one saw it."
2. Force-push history rewrite **only after** all secrets are rotated (an attacker may already have the old SHA).
3. Notify per the data-breach playbook if the secret enabled data access.
4. Add gitleaks to CI to prevent recurrence.

---

## 7. CONTACTS & TEMPLATES

### Primary contacts
- DPO: `dpo@kesefle.app` (Steven, until DPO appointed externally)
- Founder: `srcslcollection@gmail.com`
- Status page: `status.kesefle.app` (TBD)
- Insurance: TBD — see compliance/insurance section in main response

### Regulator contacts
- Israeli PPA (רשם מאגרי מידע): <https://www.gov.il/he/departments/the_privacy_protection_authority/govil-landing-page>
- Ireland DPC (likely EU lead): <https://www.dataprotection.ie/en/contact/contact-us>
- ENISA (EU breach reporting tool): <https://www.enisa.europa.eu>

### PPA breach notification email template (Hebrew)

Subject: דיווח על אירוע אבטחת מידע — כסף'לה / SRC Solutions

```
לכבוד הרשם למאגרי מידע,
שמי {NAME}, ממונה הגנת הפרטיות של {COMPANY}, ח״פ/ע.מ. {ID}.

הננו מדווחים בזאת על אירוע אבטחת מידע במאגר המידע של השירות
"כסף'לה" (kesefle.app), בהתאם לתקנה 11 לתקנות הגנת הפרטיות
(אבטחת מידע), התשע"ז-2017.

תיאור האירוע: {3–5 משפטים — מה, מתי, איך}
מועד גילוי: {ISO 8601 timestamp Israel time}
מספר משתמשים מושפעים: {N}
סוגי מידע שנחשפו: {שם, אימייל, טלפון, תוכן הוצאות וכו'}
פעולות מיידיות שננקטו: {1–3 פעולות}
פעולות מתוכננות: {1–3 פעולות}

נמשיך לדווח על התקדמות החקירה. ניתן ליצור קשר ב-dpo@kesefle.app
או בטלפון {PHONE}.

בברכה,
{NAME}
ממונה הגנת הפרטיות, SRC Solutions
```

### User breach notification email template (Hebrew)

Subject: עדכון חשוב על אבטחת חשבון "כסף'לה" שלך

```
שלום,

ב-{תאריך}, גילינו אירוע אבטחה בשירות "כסף'לה" שעשוי להיות נוגע
לחשבון שלך. אנחנו מאמינים בשקיפות מלאה ולכן רוצים לעדכן אותך.

מה קרה: {2 משפטים, ללא ז'רגון}
איזה מידע נוגע: {רשימה ברורה}
מה אנחנו עושים: {2–3 שלבים}
מה אנחנו ממליצים שתעשה: {1–3 פעולות מעשיות}

מצטערים על אי הנוחות. בכל שאלה — dpo@kesefle.app.

בכבוד רב,
SRC Solutions, מפעילי שירות "כסף'לה"
```

---

## 8. Tabletop exercises

Run a tabletop incident drill **quarterly**:
- Q1: Data breach scenario
- Q2: WhatsApp ban scenario
- Q3: Google verification rejection
- Q4: Multi-system outage (Vercel + Upstash combined)

Document each: scenario → response → time-to-resolve → gaps. File at `docs/compliance/drills/YYYY-QX.md`.
