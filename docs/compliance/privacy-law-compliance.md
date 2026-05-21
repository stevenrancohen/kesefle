# Privacy Law Compliance — Israeli PPL + GDPR

Last updated: 2026-05-16
Owner: Steven Ran Cohen (srcslcollection@gmail.com)
Jurisdictions: Israel (primary), EU/UK (if EU users sign up)

---

## 1. Israeli Privacy Protection Law 1981 (חוק הגנת הפרטיות) — what applies

### 1.1 Database registration with the רשם מאגרי מידע (PPA / Privacy Protection Authority)

Under the **Privacy Protection (Amendment 13)** law that took effect August 2025, the registration regime was overhauled. Current rules (post-Amendment 13):

| Trigger | Registration required? |
|---|---|
| Database contains data on > 10,000 people **and** processes data of "high sensitivity" | YES |
| Database contains > 100,000 people regardless of sensitivity | YES |
| Database is operated for "direct marketing services" purpose | YES |
| Database sold or licensed to others | YES |
| Database operated by a public body | YES |

**Kesefle status:** at launch we will be under 10,000 users and our data is financial (which counts as **sensitive personal data** — `מידע פיננסי / מצב כלכלי` is enumerated in the "סוגי מידע" definition in section 7 of the law).

**Decision:**
- Pre-10k users: no registration required, but **must** keep an internal register (פנקס פנימי) under Amendment 13.
- At 10k users: register within 30 days. Application is online at <https://www.gov.il/he/service/registration_of_databases>. Fee is ~120₪. Approval is by silence after 90 days.

**Action item:** add a user-count monitor that alerts at 8,000 active users so we have lead time to register before crossing 10k.

### 1.2 Data Protection Officer (ממונה על הגנת הפרטיות)

Amendment 13 mandates a DPO when **any** of the following are true:
- Public body
- Processing of data on > 10,000 people for purposes other than internal admin
- Core activity is monitoring of individuals on a large scale
- Core activity is processing of sensitive data on a large scale

**Kesefle:** below 10k = not strictly mandatory, but financial data is sensitive. **Recommendation:** appoint a part-time DPO from day 1 (can be Steven Ran Cohen wearing the hat, but document the appointment in writing and publish the contact email — `dpo@kesefle.app`). When we cross 10k or hire a second person, formalize.

DPO duties to document:
- Maintain the internal register
- Train staff on data handling
- Be the contact point for data subject requests
- Liaise with the PPA on incidents
- Conduct annual privacy reviews

### 1.3 Data Security Regulations 2017 (תקנות הגנת הפרטיות — אבטחת מידע 2017)

These regulations classify databases by risk level and impose security requirements. Kesefle's database is **בינוני (medium)** level:
- Contains sensitive data (financial)
- Under 100k subjects
- Not accessed by > 10 employees

Medium-level requirements:
- [ ] Define the database in writing (purpose, types of data, who has access) — **TODO: write `docs/compliance/database-definition.md`**
- [ ] Maintain an access log retained for 24 months — **GAP: currently only `console.log`, not retained**
- [ ] Annual security review documented in writing
- [ ] Periodic penetration test (every 18 months)
- [ ] Encrypted backups
- [ ] Documented incident response procedure — see incident-response-runbook.md
- [ ] Background checks for employees with access (just Steven for now — self-attestation)
- [ ] Two-factor authentication on admin accounts — **VERIFY: Vercel, Upstash, Google Cloud, Meta Business all have 2FA on**

### 1.4 Required user disclosures (Section 11 of the law)

Beyond a privacy policy, Section 11 requires that **before** collecting personal data, the user is told:
- Whether providing the data is a legal obligation or voluntary
- Purpose for which data is requested
- To whom data will be transferred and for what purpose

**Current state:** the consent screens during Google OAuth signup do not show this. **Action:** add a pre-OAuth modal (`he-IL`) that displays:

```
לפני שתחבר את Google:

• המידע שתספק (שם, אימייל, הוצאות שתשלח לבוט) ייאסף לצורך הפעלת
  שירות "כספ'לה" — רישום הוצאות בגיליון Google Sheets שלך.
• מסירת המידע היא וולונטרית. אם לא תספק אותו, לא נוכל לספק את השירות.
• המידע יועבר לספקי שירות: Google (אחסון הגיליון), Meta (וואטסאפ),
  Vercel ו-Upstash (תשתית). הוא לא יועבר לאף גורם אחר.
• זכותך לעיין, לתקן ולמחוק כל מידע — דרך הגיליון שלך או בכתובת dpo@kesefle.app

[המשך] [ביטול]
```

This must be shown **before** clicking Sign in with Google, not after.

### 1.5 Direct mailing (דיוור ישיר) — Section 17ו

If Kesefle ever sends marketing emails or WhatsApp messages, opt-in checkbox required with the precise wording:
> "אני מאשר/ת לקבל דברי פרסומת בדואר אלקטרוני / מסרון / וואטסאפ. ידוע לי שאוכל לבטל את הסכמתי בכל עת."

Default unchecked. Maintain unsubscribe within 3 business days.

### 1.6 Cross-border transfers (Regulation 2001)

Israeli law restricts transfer of personal data outside Israel to countries with "adequate" data protection. The PPA whitelist includes the EEA, UK, Canada, Switzerland, Japan, and Israel. The US is **not** on the whitelist by default.

**Kesefle stack:**
- Vercel: serves from US (and global edge). Vercel signs the EU SCCs and has a BCR. **Action**: sign Vercel's DPA, set the function region to `cdg1` (Paris) or `arn1` (Stockholm) for `/api/*` so user data sits in the EEA.
- Upstash KV: region selectable. **Action**: set to `eu-west-1` (Ireland).
- Google: data location follows the user's Google account; for Israeli users, Google holds the sheet in either Europe or Asia per Google's policies. Acceptable.
- Meta: WhatsApp messages transit Meta's global infra (US). This requires user consent.

The user-disclosure modal above must mention transfer outside Israel. Add this line:

> "חלק מספקי השירות שלנו (Meta) עשויים לעבד את המידע גם בארצות הברית. בלחיצה על 'התחבר' אתה מסכים להעברה זו."

### 1.7 Data subject rights — current flow audit

| Right | Israeli law (section) | GDPR Art. | Current Kesefle support | Gap |
|---|---|---|---|---|
| Access | 13 | 15 | User has the Sheet — full access | OK |
| Correction | 14 | 16 | User edits the Sheet directly | OK |
| Deletion | (Amendment 13) | 17 | "Email us to delete" — no self-serve | **Build self-serve delete in /account.html** |
| Portability | (n/a directly, but PPA encourages) | 20 | Sheet → File > Download | OK |
| Objection to direct marketing | 17ו | 21 | No marketing yet | Will add when we add marketing |
| Restriction of processing | (n/a) | 18 | Not supported | Build "pause my account" button |
| Automated decision-making | (n/a) | 22 | The classifier categorizes expenses but no significant effect on user | Document in privacy.html that classification is non-binding and user can override |

### 1.8 Breach notification — Section 17ד + Reg. 11

Mandatory:
- Notify the PPA "as soon as possible" (best practice: 72h) for a "severe security incident" — defined as one likely to result in significant harm.
- For Kesefle: any breach affecting > 100 users or any exposure of refresh tokens / financial data triggers PPA notification.
- Notify affected users when there is significant risk.

See incident-response-runbook.md for the full procedure.

---

## 2. GDPR — if/when EU users sign up

The first EU user signing up triggers full GDPR applicability. **Recommendation:** treat GDPR as the operating baseline because it's stricter than Israeli law and complying with both costs ~0 extra.

### 2.1 Lawful basis

| Activity | Lawful basis |
|---|---|
| Account creation | Contract (Art. 6(1)(b)) |
| Sending WhatsApp expense replies | Contract |
| Bot training / classifier improvement on user data | **Consent** (Art. 6(1)(a)) — must be opt-in, not pre-checked |
| Marketing emails | Consent |
| Security logging | Legitimate interest (Art. 6(1)(f)) — document the LIA |
| Sharing with subprocessors | Contract performance (Art. 28 DPA with each) |

**Action:** add a separate checkbox during onboarding for "allow Kesefle to use my anonymized message patterns to improve the classifier" — default off. Must be revocable.

### 2.2 DPIA (Data Protection Impact Assessment)

Required when processing is "likely to result in a high risk." Kesefle processes financial data — **DPIA recommended even if not strictly mandatory**.

Template to fill (save as `docs/compliance/dpia.md` when ready):
1. Systematic description of processing
2. Necessity and proportionality assessment
3. Risk assessment to data subjects
4. Mitigation measures
5. Sign-off by DPO

### 2.3 Subprocessor list — to publish at /privacy#subprocessors

| Vendor | Purpose | Data | Location | DPA status |
|---|---|---|---|---|
| Google LLC | OAuth identity, Sheets API hosting | Email, name, sheet contents | User-tied | Sign Google Cloud DPA |
| Meta Platforms | WhatsApp Business API | Phone number, message text | US/global | Sign WhatsApp Business Terms (includes DPA) |
| Vercel Inc. | App hosting, serverless functions | Logs, ephemeral request data | EU regions (cdg1/arn1) | Sign Vercel DPA |
| Upstash Inc. | Redis KV for sessions + sheet IDs | UserSub, sheet ID, refresh token | eu-west-1 (Ireland) | Sign Upstash DPA |
| Stripe Inc. (when added) | Payment processing | Card details (tokenized), email | EU + US | Sign Stripe DPA |

Publish this table at /privacy#subprocessors and notify users 30 days before adding any new subprocessor.

### 2.4 International transfers under GDPR

- Vercel EU regions for `/api`: data stays in EEA (no transfer).
- Upstash Ireland: EEA (no transfer).
- Meta WhatsApp: transfers to US. Meta uses SCCs + supplementary measures. Document in subprocessor list.
- Google Sheets: user's Google account location governs. Document.

### 2.5 GDPR-specific user rights to add to privacy.html

Add a section 11 to privacy.html titled "זכויות נוספות למשתמשי האיחוד האירופי":
- Right to lodge a complaint with a supervisory authority (list: Ireland DPC or user's home authority)
- Right to withdraw consent at any time without affecting prior processing
- Identity of the controller: SRC Solutions, srcslcollection@gmail.com, dpo@kesefle.app
- Retention periods (already in 3ב, but cross-link)

---

## 3. Cookies / ePrivacy

Section 7 of privacy.html says "essential cookies only — no marketing cookies." Confirm by audit:

```bash
grep -r "gtag\|analytics\|pixel\|fbq\|hotjar\|hubspot" /Users/stevenrancohen/Documents/Claude/Projects/kesefle/*.html /Users/stevenrancohen/Documents/Claude/Projects/kesefle/api
```

If any are found, either remove them or add a cookie banner with opt-in (required under ePrivacy / Israeli amendment).

---

## 4. Action list — prioritized

| # | Task | Owner | Deadline |
|---|---|---|---|
| 1 | Move Vercel functions + Upstash KV to EU regions | Steven | Pre-launch |
| 2 | Encrypt refresh tokens in KV (AES-256 with KMS-managed key) | Steven | Pre-launch |
| 3 | Build /api/account/delete | Steven | Pre-launch |
| 4 | Add pre-OAuth Section 11 disclosure modal | Steven | Pre-launch |
| 5 | Publish subprocessor list at /privacy#subprocessors | Steven | Pre-launch |
| 6 | Sign DPAs with Google, Vercel, Upstash, Meta | Steven | Pre-launch |
| 7 | Add Strict-Transport-Security and CSP headers to vercel.json | Steven | Pre-launch |
| 8 | Stand up dpo@kesefle.app email + publish on /privacy | Steven | Pre-launch |
| 9 | User-count alarm at 8,000 signups (PPA registration prep) | Steven | Before scale |
| 10 | Write internal database register (פנקס פנימי) | Steven | Pre-launch |
| 11 | Write DPIA | Steven | Before EU launch |
| 12 | Add restriction-of-processing button ("השהה חשבון") | Steven | Within 6 months |
