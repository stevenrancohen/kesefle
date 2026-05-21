# Google OAuth Verification — Kesefle Readiness Pack

Last updated: 2026-05-16
Owner: Steven Ran Cohen (srcslcollection@gmail.com)
App: Kesefle (kesefle.app)
Scope class: **Restricted** (drive.file is restricted; spreadsheets is sensitive)
Estimated review time: 4–8 weeks (restricted scope + CASA Tier 2 assessment likely required)

---

## 1. What Google requires for our scope mix

We request three scopes:

| Scope | Class | Verification path |
|---|---|---|
| `openid`, `email`, `profile` | None (default) | Not in scope for verification |
| `https://www.googleapis.com/auth/drive.file` | Restricted | OAuth review **+** annual CASA Tier 2 security assessment |
| `https://www.googleapis.com/auth/spreadsheets` | Sensitive | OAuth review (no CASA required if standalone, but bundled with drive.file pushes us to CASA Tier 2) |

Because we touch `drive.file`, the entire app is treated as restricted. Plan for CASA Tier 2 (~$1.5–4k via approved labs like Bishop Fox, Leviathan, Securitas — quote 4–6 weeks lead time).

The 100-user cap on unverified apps applies to **lifetime distinct grant count**, not concurrent. Test users must be added in the OAuth consent screen test-users list (max 100).

---

## 2. Privacy policy audit — gaps to close

Current privacy.html (reviewed): sections 3א and 3ב cover OAuth scopes and retention. Status against Google's Limited Use checklist:

| Limited Use requirement | Current state | Action |
|---|---|---|
| Only use data to provide/improve user-facing features | Covered in 3א bullet 1 | OK |
| No transfer to third parties except to provide/improve user-facing features | Covered 3א bullet 2 | OK |
| No advertising use | Covered 3א bullet 3 | OK |
| No human reading except with explicit consent / security / legal / aggregated | Covered 3א bullet 4 | OK |
| Display "How does this app handle your Google data?" link prominently | Missing | **ADD**: in-app footer + index.html links to privacy.html#oauth-scopes |
| Explicit list of every restricted scope with one-sentence justification | Partial (scope is listed but justification is generic) | **ADD**: a per-scope "Why do we need this?" justification — see template below |
| Data deletion path | 3ב says "30 days after unsubscribe" | **ADD**: self-serve "delete my account" button in `/account.html` that revokes refresh tokens, deletes KV records, and emails confirmation |
| Subprocessor list | Missing | **ADD** section: Google (OAuth + Sheets), Meta (WhatsApp), Vercel (hosting), Upstash (KV). Link each to their DPA. |
| Data export | Implicit (the data IS in the user's Sheet) | **ADD** explicit statement: "Your data is already exportable — File > Download in Google Sheets" |
| Children's policy | Section 8 says 16+ | OK |
| EU/UK transfers | Missing | **ADD** SCC reference + Vercel/Upstash region note — see privacy-law-compliance.md |
| Contact for privacy requests | Section 10 has email | OK, but add a dedicated `privacy@kesefle.app` alias |

### Per-scope justification text to add to privacy.html section 3א

```
drive.file: כדי ליצור עבורך עותק של תבנית הגיליון "כספ'לה" ב-Drive שלך
   ולגשת רק לקובץ הזה. אנחנו לא רואים שום קובץ אחר ב-Drive שלך.

spreadsheets: כדי לכתוב את ההוצאות וההכנסות שאתה שולח דרך הוואטסאפ
   לתוך הגיליון שלך, ולקרוא ממנו כדי להראות לך סיכומים.
```

English equivalents are required on the verification form even though the app UI is Hebrew.

---

## 3. OAuth consent screen — required fields

In Google Cloud Console → APIs & Services → OAuth consent screen → External, fill in every field below. Items in **bold** are common rejection causes.

| Field | Value |
|---|---|
| App name | Kesefle |
| User support email | srcslcollection@gmail.com (must be a Google account you can receive mail at) |
| App logo | **Required**: 120×120 PNG, no transparency, matches public site logo |
| Application home page | https://kesefle.app |
| Application privacy policy link | https://kesefle.app/privacy |
| Application terms of service link | https://kesefle.app/terms |
| **Authorized domains** | kesefle.app (must be verified in Search Console under same Google account as the OAuth project) |
| Developer contact info | srcslcollection@gmail.com |
| Scopes | openid, email, profile, drive.file, spreadsheets |
| **Scope justifications** | One per restricted/sensitive scope, 100–500 chars, English |
| Test users | Up to 100 emails for pre-verification testing |
| App domain verified | Yes (TXT record or HTML file in /.well-known) |

### Scope justification copy (English, for the form)

**drive.file:**
> Kesefle creates a single Google Sheet from a built-in template inside the user's Drive when they sign up. The app reads and writes only that file. drive.file is the narrowest scope that supports template-copy + ongoing edits. We do not list, read, or modify any other file in the user's Drive.

**spreadsheets:**
> Kesefle appends one row per WhatsApp expense message (date, amount, category, raw text) to the user's Kesefle sheet, and reads summary cells to show monthly totals back to the user via WhatsApp. The spreadsheets scope is required to read+write cells in the file created via drive.file.

---

## 4. Demo video — 3-minute script

Google wants to see (a) consent flow, (b) what each scope does, (c) data flow end-to-end. Record at 1080p, English voice-over, no music, no cuts that hide screens. Upload unlisted to YouTube; link in the OAuth form.

### Title card (0:00–0:05)
On-screen text: "Kesefle — Google OAuth scope demo. Domain: kesefle.app"

### Scene 1: Landing + consent (0:05–0:45)
Voice-over (VO):
> "Kesefle is a Hebrew WhatsApp expense tracker. Users sign up at kesefle.app and connect Google to store their expenses in a Google Sheet they own. I'll demonstrate the OAuth flow now."

Actions on screen:
1. Open kesefle.app in Incognito Chrome.
2. Click "התחבר עם Google" (Sign in with Google).
3. Google consent screen appears. Pause. VO: "Note the three scopes requested — email/profile for identity, drive.file for creating one file, and spreadsheets for reading and writing that file. The user can deny any of these."
4. Click Allow.
5. Land on /account.html showing the user's name + email.

### Scene 2: drive.file in action (0:45–1:30)
VO:
> "Kesefle now copies the master template into the user's Drive. This is the only Drive call we make."

Actions:
1. Open Chrome DevTools → Network tab.
2. Click "צור גיליון" (Provision sheet).
3. Highlight the single `POST /api/sheet/provision` request, then the `drive.files.copy` call it makes server-side (show the server log in a split-screen terminal).
4. Open the new sheet in a new tab — show it lives in the user's My Drive.
5. Switch back to user's Drive root, show no other files were created or modified.

### Scene 3: spreadsheets scope in action (1:30–2:15)
VO:
> "Now I send an expense via WhatsApp. The Kesefle webhook parses it and appends one row to the user's sheet using the spreadsheets scope. No other sheet, no other tab, no other user."

Actions:
1. Send WhatsApp message "245 סופר" to the Kesefle bot phone number.
2. Show the WhatsApp reply: "✅ נרשם: ₪245 · סופר".
3. Open the sheet — show the new row appended in the orders log.
4. Show the server log of the `spreadsheets.values.append` API call.

### Scene 4: Limited Use + revocation (2:15–2:50)
VO:
> "Kesefle complies with Google's Limited Use policy. We never share user data with third parties, never use it for ads, and no human at Kesefle reads it. To revoke access, the user goes to their account page or directly to Google's permissions screen."

Actions:
1. Open /account.html → click "Delete my account".
2. Show confirmation: refresh token revoked at oauth2.googleapis.com/revoke, KV records deleted.
3. Open https://myaccount.google.com/permissions, show Kesefle is gone.

### Scene 5: Privacy policy + Limited Use disclosure (2:50–3:00)
Actions:
1. Open https://kesefle.app/privacy.
2. Scroll to section 3א with cursor highlighting the Limited Use bullets.
3. End card: "Questions: srcslcollection@gmail.com"

---

## 5. Pre-submission checklist (do not submit before all are green)

- [ ] Domain kesefle.app verified in Google Search Console under the same Google account that owns the Cloud project
- [ ] OAuth consent screen: every field above filled, logo uploaded
- [ ] Privacy policy live at https://kesefle.app/privacy, linked from index.html footer
- [ ] Terms live at https://kesefle.app/terms
- [ ] privacy.html updated with per-scope justification, subprocessor list, deletion path, EU transfer clause
- [ ] /account.html has a working "Delete my account" button that hits `POST /api/account/delete` (revokes refresh token + purges KV)
- [ ] Demo video recorded, uploaded unlisted to YouTube, link tested in incognito
- [ ] CASA Tier 2 lab booked (lead time 4–6 weeks)
- [ ] Source-code repo access ready for CASA lab (private GitHub invite, time-boxed)
- [ ] All third-party deps in /api have current security advisories checked (`npm audit`)
- [ ] Refresh tokens stored encrypted (currently plaintext in KV — see incident-response-runbook.md gap #3)
- [ ] HSTS header added to vercel.json (currently missing — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`)
- [ ] CSP header added (currently missing — needed for CASA)

---

## 6. CASA Tier 2 — what the lab will look for

CASA Tier 2 checklist (SAQ + verification). Common findings to pre-empt:

1. **Secrets in code** — grep the repo for `sk_`, `Bearer `, hardcoded tokens. Must be 100% env-var.
2. **Token storage at rest** — Upstash KV is encrypted at rest (Redis encryption-at-rest is on by default on Vercel KV plans). Document this; provide the Vercel/Upstash DPA.
3. **TLS only** — already enforced by Vercel, but document it.
4. **HMAC verification on webhooks** — `webhook.js` already does this for Meta. Good.
5. **Rate limiting** — `/api/waitlist.js` has none. **Block-fix before CASA.** Add IP-based throttle.
6. **Input validation** — `provision.js` validates accessToken length only. Add `userSub` format check (Google sub is 21 digits).
7. **Logging** — currently `console.log` only. CASA wants structured logs with no PII in body. Mask emails.
8. **Dependency management** — pin versions in package.json, enable Dependabot.
9. **Incident response plan** — see incident-response-runbook.md.
10. **Penetration test report** — CASA Tier 2 includes external pen test; budget for it.

---

## 7. Timeline (realistic)

| Week | Task |
|---|---|
| W1 | Fix privacy.html gaps, add HSTS+CSP, add rate limiting, encrypt refresh tokens |
| W2 | Build /api/account/delete; add /account.html delete button |
| W3 | Record demo video, internal review |
| W4 | Submit OAuth verification (initial review takes 1–2 weeks for first response) |
| W5–W6 | Book CASA lab; respond to Google's first round of questions |
| W7–W10 | CASA Tier 2 assessment |
| W11–W12 | Address findings, re-submit |
| W13 | Approval (best case) |

Do NOT promise customers a launch date inside 12 weeks of starting this process.
