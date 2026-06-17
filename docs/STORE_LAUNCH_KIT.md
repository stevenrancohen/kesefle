# Kesefle — App Store Launch Kit (PARKED)

> Status: **PARKED** 2026-06-17. Steven chose to test retention first (the council #1) before any store launch. Ready-to-use research + listings for when we revisit. Trigger: ~50 users who would miss Kesefle, or a real user asks for an App Store presence. We built docs/RETENTION_NUDGE_RUNBOOK.md instead.

---

## Current store requirements (web-researched, June 2026)

I now have all six areas verified with primary sources. This is a critical finding for Kesefle's OAuth architecture. Let me compile the structured brief.

---

# Mobile-Release Compliance Brief — Kesefle Finance PWA-Wrapper (current as of June 2026)

**Kesefle context assumed:** mobile-first PWA at kesefle.com/app; Google sign-in; per-user data stored in the user's own Google Sheet via Sheets/Drive scopes; personal expense tracking (no payments, no lending, no crypto). Wrapping plan: Android TWA (Bubblewrap/PWABuilder) + iOS Capacitor/WKWebView.

---

## 1. Google Play closed-testing requirement (NEW personal accounts) — the #1 schedule risk

**Current rule (verified):** For personal developer accounts created **after Nov 13, 2023**, before you can apply for production access you must run a **closed test with at least 12 opted-in testers, continuously opted-in for 14 days**. The number was **reduced from 20 to 12 on Dec 11, 2024** — so the "~20 testers" framing in the task is now stale; it's **12**. The 14 days must be **consecutive** — Google does not count a tester who opts in, tests <14 days, then opts out (even if they return). After the 14 days you then *apply* for production and Google reviews the application (additional days). Source: [Play Console Help — App testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en); reduction confirmed by [Play Developer Community 12-testers guide](https://support.google.com/googleplay/android-developer/community-guide/255621488/everything-about-the-12-testers-requirement?hl=en).
- **Impact on Kesefle:** Budget **~3 weeks minimum** before Android production is even possible (recruit + 14 continuous days + production-access review). This gate applies only if the Play account is personal and post-2023 — **an Organization (company) developer account is exempt** from the 12-tester gate, which is the single biggest lever to compress the timeline. Decide account type before doing anything else.

## 2. Target API level, Data safety form, in-app Account Deletion

- **Target API level (verified):** New apps and updates must currently target **Android 15 (API 35) or higher**. Note a rolling deadline: from **Aug 31, 2026** new submissions are expected to require **Android 16 (API 36)** once it ships. Source: [Play Console Help — Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en); [Android Developers — target SDK](https://developer.android.com/google/play/requirements/target-sdk). **Impact:** Build the TWA against compileSdk/targetSdk 35 now; expect to re-target 36 within months. Trivial for a TWA shell.
- **Data safety form (verified):** Mandatory; must declare all data collected/shared, including by any third-party SDK, plus the new **Data deletion** questions. Source: [Play Developer Community — Data Safety & Account Deletion](https://support.google.com/googleplay/android-developer/community-guide/246344978/about-the-data-safety-form-and-account-deletion?hl=en). **Impact:** Kesefle must honestly disclose: Google account identifiers, financial/expense data, and that data lives in the user's Sheet; declare whether anything is "shared."
- **In-app + web Account Deletion (verified):** If users can create an account in-app, you must provide **both** (a) an **in-app** deletion path **and** (b) a **web URL** for account+data deletion reachable without reinstalling the app, listed in the Data safety form. You must actually delete the account **and all data collected about the user** — freezing/disabling is not allowed. Source: [Play Console Help — Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en). **Impact on Kesefle: YES, this applies.** Google sign-in that provisions a Kesefle record = account creation. You must ship a delete flow that (1) purges all Kesefle-side records keyed to the user (KV: `user:{sub}`, `phone:`, pending/recurring keys, audit attribution), (2) **revokes the stored Google OAuth tokens**, and (3) hands back or deletes the user's Sheet data Kesefle controls. The repo already has a `gdpr-data-delete` skill — wire it to a public web endpoint + an in-app button. The Sheet itself is the user's own Drive file, but anything Kesefle *collected/cached* must be deleted.

## 3. Google Play Financial Services declaration

**Current rule (verified):** Play asks at submission "Does your app include any financial features?" Financial features = products/services for **managing or investing money/crypto, including personalized advice** (loans, banking, crypto exchange, investments, payments, etc.). If yes, you must complete the **Financial features declaration** form. Source: [Play Console Help — Financial features declaration](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en); [Financial Services policy](https://support.google.com/googleplay/android-developer/answer/9876821?hl=en).
- **Impact on Kesefle:** **Low risk but verify by region.** A pure **personal expense tracker with no payments, no lending, no investing, no crypto** generally is *not* a regulated "financial product/service" and the heavy country-specific declaration sub-forms (loans, crypto, etc.) don't apply. **However**, the gating question "does your app include any financial features?" is broad and you'll likely answer YES (it manages money information) — then most sub-categories will be "not applicable." Flag: this is the **one item I could only partially verify** — Google's docs don't give a crisp "expense trackers are exempt" statement, so answer the questionnaire conservatively and keep a one-line description ready ("read-only personal expense tracking, no transactions"). No license/registration is required for tracking-only.

## 4. Google OAuth — restricted scope / CASA for Sheets+Drive

**This is the second-biggest blocker and an architecture decision, not just paperwork.**
- **Verified classifications:** `auth/spreadsheets` (full Sheets) and `auth/spreadsheets.readonly` are **Sensitive** (require OAuth verification + justification, but **not** CASA). The broad Drive scopes `auth/drive` and `auth/drive.readonly` are **Restricted** → trigger a **mandatory CASA Tier-2 security assessment** (paid third-party audit, annual re-validation every 12 months from LOA date). `auth/drive.file` (per-file access to only files the app creates/opens) is **non-sensitive / not restricted → no CASA, often no verification**. Sources: [Google Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes) (spreadsheets = Sensitive); [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification); [drive.file avoids CASA](https://github.com/Jose-cd/React-google-drive-picker/issues/79); [CASA 2025 overview](https://deepstrike.io/blog/google-casa-security-assessment-2025).
- **Impact on Kesefle — CHECK YOUR CURRENT SCOPES NOW.** If Kesefle requests **any broad Drive scope** (`drive` or `drive.readonly`, e.g. to find/list the user's Sheet), it is in **restricted-scope territory → CASA Tier-2 required** (cost typically hundreds–low-thousands USD/yr + weeks of remediation) before public OAuth. If Kesefle uses **`spreadsheets` + `drive.file` only**, you avoid CASA — you still need standard OAuth verification (Sensitive) but no security audit. **De-risk path: migrate any `drive`/`drive.readonly` usage to `drive.file` (app creates/owns the user's Sheet so it always has file access).** **Wrapping in a TWA/Capacitor app does NOT change this** — OAuth verification keys off the OAuth client/project and scopes, regardless of whether the front-end is a browser or a store app. The store wrapper is irrelevant to Google's scope review.

## 5. Apple Guideline 4.2 (min functionality) + 5.1.1(v) + privacy labels + Sign in with Apple

- **4.2 minimum functionality (verified, 2025–26 reality):** Thin WebView wrappers that "feel like a web clipping" / a browser are routinely rejected; even Capacitor apps with *some* native bits (Core Location, Share) have been rejected as **"not sufficiently differentiated from web browsing."** Source: [MobiLoud — 4.2 webview wrappers](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper); [Apple Developer Forums — Capacitor 4.2 rejection](https://developer.apple.com/forums/thread/812889). **Impact on Kesefle: real iOS risk.** To pass, the iOS build needs genuine native value beyond the website: e.g. **push notifications, biometric (Face ID) lock, offline cache, native share-sheet expense capture, home-screen widget, App Tracking handled natively** — and avoid showing browser chrome/URL bars. Plan native differentiation before submitting; this is the most subjective gate.
- **5.1.1(v) account deletion (verified):** Apps supporting account creation must offer **in-app account deletion** (live since June 30, 2022). If you also offer Sign in with Apple you must call the **Sign in with Apple REST API to revoke tokens** on delete. Source: [Apple Developer — account deletion](https://developer.apple.com/news/?id=12m75xbj). **Impact:** same delete flow as Play, plus Apple-token revocation if SIWA is used.
- **Privacy nutrition labels (verified):** Required on the product page; must declare data types **including everything third-party SDKs collect**; finance category includes a **Financial Info** type; since May 2024 commonly-used SDKs also need **privacy manifests + required-reason API declarations**. Sources: [Apple — App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/); [Apple — User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/). **Impact:** declare Google identifiers + financial/usage data; audit any analytics SDK in the Capacitor build for a privacy manifest.
- **Sign in with Apple (verified — important):** Guideline **4.8**: any app that uses a third-party/social login (**Google Sign-In counts**) to set up the user's **primary account must ALSO offer Sign in with Apple as an equivalent option** (unless it's your own first-party account system, or an enterprise/education app). Source: [Apple Forums — 4.8 login services](https://developer.apple.com/forums/thread/760302); [Appraysal 4.8 summary](https://appraysal.com/rules/4.8_sign_in_with_apple). **Impact on Kesefle: YES — because Kesefle's primary login is Google, the iOS app must add Sign in with Apple.** This is non-trivial: SIWA gives you an Apple identity (and Hide-My-Email relay), which you must map to a Kesefle user and still provision a Google Sheet — design this before iOS submission. (Android/Play has no equivalent requirement.)

## 6. Digital Asset Links (assetlinks.json) for Android TWA

**Verified exact spec:**
- **Path:** `https://kesefle.com/.well-known/assetlinks.json` — served over **HTTPS, no redirects**, exact filename/location (any other name/location is invalid).
- **Format:** JSON array of statements, e.g. `relation: ["delegate_permission/common.handle_all_urls"]`, `target.namespace: "android_app"`, `target.package_name: "<your.twa.package>"`, `target.sha256_cert_fingerprints: ["AB:CD:..."]` (uppercase, colon-separated).
- **Where the SHA-256 comes from:** Because Play re-signs your app, use the **Play App Signing key fingerprint**, found in **Play Console → Release → Setup → App signing**. That same page generates the **exact assetlinks.json snippet** to paste. Sources: [Android Developers — configure assetlinks](https://developer.android.com/training/app-links/configure-assetlinks); [PWABuilder asset-links guide](https://github.com/pwa-builder/pwabuilder-google-play/blob/main/Asset-links.md); [Digital Asset Links getting started](https://developers.google.com/digital-asset-links/v1/getting-started).
- **Impact on Kesefle:** Easy but **a common silent launch failure**: if you publish assetlinks.json with only your **local/upload** key fingerprint and forget the **Play-App-Signing** fingerprint, the TWA shows the browser URL bar (fails the "full-screen app" feel and can drag in the 4.2-style complaints on Android too). Add **both** fingerprints (upload + Play signing). The repo already has an `add-html-page` pattern — serving a static `/.well-known/assetlinks.json` from kesefle.com is straightforward.

---

## TOP 3 BLOCKERS / SURPRISES (ranked by launch delay)

1. **Google OAuth restricted-scope / CASA trap (Item 4).** If Kesefle currently requests `drive` or `drive.readonly`, you face a **mandatory paid CASA Tier-2 audit + annual re-cert** — weeks of remediation and recurring cost — before public OAuth verification clears. **Fix before anything else: confirm scopes and migrate to `spreadsheets` + `drive.file` to avoid CASA entirely.** Wrapping in a store app does **not** help. This can gate *both* platforms because OAuth is shared. *(Single most expensive surprise; partially an architecture change.)*

2. **Google Play 12-tester / 14-consecutive-day closed test (Item 1) — only on a personal post-2023 account.** Adds **~3 weeks** of forced delay before Android production. **The surprise / lever:** it's now **12 testers, not 20**, and an **Organization developer account is exempt** — so the fix is to use a company account and skip the gate.

3. **Apple forces Sign in with Apple + a "real app" (Items 5 / 4.8 + 4.2).** Because Kesefle's primary login is Google, **iOS must add Sign in with Apple** (new auth path to build + Sheet provisioning), **and** the Capacitor WebView must show genuine native value or eat repeated 4.2 rejections. This is the gate most likely to bounce iOS multiple times. *(Android has neither of these.)*

**Could not fully verify / flag:**
- The Financial Services declaration's exact treatment of a *tracking-only* expense app (Item 3) — Google has no explicit "expense trackers exempt" statement; answer conservatively per target country.
- Exact future API-36 enforcement date (Aug 31, 2026 is sourced but contingent on Android 16's release).
- WebSearch is US-region; Israel-specific local-law disclosures (Amendment 13 / privacy) for the Play financial declaration weren't covered here and should be checked separately.

---

## Google Play listing (Hebrew + English)

The skill confirms the canonical spelling is **כספ'לה** (medial פ + geresh, not final ף). The prompt's romanization guidance ("medial pe + geresh") matches this. I'll use כספ'לה throughout, with number/currency islands kept LTR-safe in the copy.

Here is the complete listing.

---

# Kesefle — Google Play Store Listing (Hebrew primary / English secondary)

## 1. App name (≤30 chars)

**Hebrew (primary):**
```
כספ'לה - ניהול הוצאות
```
(20 chars incl. spaces)

**English (secondary):**
```
Kesefle - Expense Tracker
```
(25 chars)

---

## 2. Short description (≤80 chars)

**Hebrew:**
```
רושמים הוצאה בוואטסאפ - והיא נכנסת לגיליון שלך. תקציב, מאזן ותחזית בלי מאמץ.
```
(74 chars)

**English:**
```
Log an expense on WhatsApp - it lands in your own Google Sheet. Budgets too.
```
(75 chars)

---

## 3. Full description (≤4000 chars, Hebrew + English mirror)

```
כספ'לה הופך מעקב הוצאות לדבר הכי פשוט ביום שלך. שולחים הודעת וואטסאפ אחת - "85 סופר" - וההוצאה כבר רשומה, מסווגת ומחושבת בגיליון Google Sheets הפרטי שלך. בלי טפסים, בלי אפליקציה מסורבלת, בלי לחבר חשבון בנק.

נבנה לישראלים: בעברית מלאה, בשקלים, ומבין איך אתה כותב באמת.

== למה כספ'לה ==
רוב אנשים מפסיקים לעקוב אחרי הכסף כי זה מעייף. כאן אתה רק כותב הודעה כמו לכל חבר בוואטסאפ, וכספ'לה עושה את כל השאר - מסווג לקטגוריה, סוכם לחודש, ומראה לך תמונה ברורה של ההוצאות, ההכנסות והרווח. מתאים גם למשק בית וגם לעסק קטן או עצמאי.

== מה אפשר לעשות ==
- רישום הוצאה בוואטסאפ תוך שניות, בשפה חופשית
- סיווג אוטומטי לקטגוריות (סופר, דלק, מסעדות, שיווק ועוד)
- מסך בית: נטו חודשי, הוצאות והכנסות במבט אחד
- היסטוריית תנועות מלאה עם חיפוש מהיר
- תובנות: תחזית הוצאה לסוף החודש לפי הקצב הנוכחי
- השוואה חודש מול חודש ומגמת 6 חודשים
- ניהול תקציב לכל קטגוריה והתראה כשמתקרבים לגבול
- תמיכה בעסק עצמאי: הכנסות, הוצאות ורווח נקי
- אפליקציה מתקינה (PWA) שעובדת מהיר גם בלי חיבור מתמיד

== הנתונים שלך נשארים שלך ==
המידע נשמר בגיליון Google Sheets הפרטי שלך - לא במאגר שלנו. אתה הבעלים, אתה רואה הכל, אתה יכול לייצא או למחוק בכל רגע. ההתחברות דרך חשבון Google שלך (הרשאת Sheets/Drive בלבד). אין חיבור לבנק, אין סריקת חשבונות, אין מכירת מידע.

== חינם להתחיל ==
רוב היכולות חינמיות לגמרי. למי שרוצה יותר יש מסלול Pro עם תכונות מתקדמות.

== מילים שאנשים מחפשים ==
ניהול הוצאות, מעקב הוצאות, ניהול תקציב, אפליקציית הוצאות, רישום הוצאות בוואטסאפ, גיליון גוגל הוצאות, ניהול כספים אישי, תקציב חודשי, מעקב תקציב, הוצאות לעסק קטן, ניהול הוצאות לעצמאי, מאזן חודשי, חיסכון, ניהול כסף.

תתחיל היום: הורד את כספ'לה, התחבר עם Google, ושלח את ההוצאה הראשונה בוואטסאפ.

-------------------------------------------------

ENGLISH

Kesefle makes expense tracking effortless. Send one WhatsApp message - "85 groceries" - and the expense is instantly logged, categorized, and totaled in your own private Google Sheet. No forms, no clunky app, no bank connection.

Built for everyday money: clear monthly net, expenses, and income at a glance, full searchable transaction history, end-of-month spending projection, month-over-month comparison, a 6-month trend, and per-category budgets with alerts. Works for households and for solo business owners tracking income, expenses, and net profit.

Your data stays yours. Everything is saved in your own Google Sheet - not on our servers. Sign in with Google (Sheets/Drive permission only). No bank linking, no account scraping, no selling your data.

Free to start, with an optional Pro tier for advanced features.

Download Kesefle, sign in with Google, and send your first expense on WhatsApp today.
```
(Character count: ~2,180 — well under the 4,000 limit.)

---

## 4. Category + tags

- **Primary category:** Finance
- **Secondary / alternate:** Productivity
- **Tags (Play Console suggested tags, pick up to 5):** Expense tracker, Budget planner, Personal finance, Money manager, Bookkeeping
- **Store-listing "App tags" to select:** Finance, Budgeting, Money Management, Expense Tracking, Small Business

---

## 5. Suggested keywords (ranked)

Play does not index a keyword field the way iOS does — these belong in the title, short description, and full description (already woven in above). Ranked by Israeli search value × relevance.

**Hebrew (ranked):**
1. ניהול הוצאות
2. מעקב הוצאות
3. ניהול תקציב
4. אפליקציית הוצאות
5. רישום הוצאות וואטסאפ
6. גיליון גוגל הוצאות
7. ניהול כספים אישי
8. תקציב חודשי
9. הוצאות לעסק קטן
10. ניהול הוצאות לעצמאי
11. מאזן חודשי
12. מעקב תקציב

**English (ranked):**
1. expense tracker
2. budget planner
3. personal finance
4. money manager
5. expense manager
6. spending tracker
7. WhatsApp expense
8. Google Sheets budget
9. small business expenses
10. monthly budget app

---

## 6. Content-rating questionnaire answers (Google Play / IARC)

Expected result: **Everyone / PEGI 3 / USK 0.** Answer each as follows:

| Question | Answer |
|---|---|
| App category | Utility, Productivity, Communication, or Other (select **Finance / Reference / Utility**) |
| Violence (cartoon, fantasy, realistic) | No |
| Sexuality / nudity | No |
| Profanity or crude humor | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| Gambling — real or simulated | No |
| User-generated content shared with others | No |
| Users can interact / communicate with each other | No |
| Shares user's current physical location | No |
| Digital purchases | **Yes** (in-app purchase of optional Pro subscription) |
| Collects/shares personal info | Personal data handled per the Data Safety form (see below); app does **not** broker it to third parties |
| Hateful, discriminatory, or extremist content | No |
| Horror / fear themes | No |
| References to real money / financial transactions | App helps users **track** their own spending; it does not move money, trade, or process payments between users |

**Data Safety form (companion, required separately):**
- Data collected: email address (account/sign-in), app activity (expenses the user logs). Financial expense data is stored in the user's own Google Sheet, not retained on Kesefle servers.
- Data sharing with third parties: No.
- Data encrypted in transit: Yes.
- Users can request deletion: Yes.
- Account required: Yes (Google sign-in).

---

## 7. Screenshot plan (6 phone screenshots)

Format: 1080×1920 (9:16) portrait, RTL layout. Each caption overlays the top third in Rubik 900 heavy weight, dark text on a light brand panel; the app screenshot fills the rest. Numbers/currency rendered LTR-isolated so ₪ and digits don't reorder.

| # | Screen shown | Hebrew caption to overlay |
|---|---|---|
| 1 | **Home** — monthly net, expenses, income cards | רואים את התמונה המלאה במבט אחד |
| 2 | **Transactions** — full history + search bar | כל הוצאה שרשמת, עם חיפוש מהיר |
| 3 | **Insights — projection** — end-of-month spend forecast | יודעים כמה תוציא עד סוף החודש |
| 4 | **Budgets** — per-category budget bars with an alert | תקציב לכל קטגוריה - והתראה בזמן |
| 5 | **WhatsApp logging** — a chat showing "85 סופר" → confirmation | רושמים הוצאה בהודעת וואטסאפ אחת |
| 6 | **Install / privacy** — install prompt + "הנתונים בגיליון שלך" badge | מתקינים בחינם. הנתונים נשארים שלך |

**Optional feature graphic (1024×500) caption:** כספ'לה - ההוצאות שלך, בהודעת וואטסאפ אחת

---

**Notes for whoever uploads this:**
- Brand spelling is locked as **כספ'לה** (medial פ + geresh). Do not let any tool autocorrect it to כסף'לה (final ף).
- The app name field uses the hyphen form; if Play rejects the apostrophe/geresh in any short field, keep it in the Hebrew name (it renders fine) and use plain "Kesefle" only in English fields.
- "WhatsApp" is a third-party trademark — describing integration ("log via WhatsApp") is fine; do not imply endorsement or use WhatsApp's logo in icon/feature graphic.

---

## Apple App Store listing (drafted for when iOS ships via Capacitor)

I'll write this listing directly — no tools needed, since this is a content deliverable and I have everything I need from the brief. Brand spelling locked as "Kesefle" / "כספלה".

# Kesefle — Apple App Store Listing (iOS, draft for future Capacitor ship)

## App Name (≤30 chars)
**Hebrew primary:** `כספלה — ניהול הוצאות` *(20 chars)*
**English alt:** `Kesefle: Expense Tracker` *(24 chars)*

> Use the Hebrew name as the primary localized name (Hebrew storefront), English as the en-US localization.

---

## Subtitle (≤30 chars)
**Hebrew:** `מעקב הוצאות בוואטסאפ בשניות` *(26 chars)*
**English:** `Track expenses via WhatsApp` *(27 chars)*

---

## Promotional Text (≤170 chars)
**Hebrew:**
`שולחים הוצאה בוואטסאפ — והיא נרשמת אצלכם בשניות. דוחות חודשיים, תחזית הוצאות ותובנות חכמות, הכול בעברית. הנתונים בגיליון Google הפרטי שלכם.` *(133 chars)*

**English:**
`Send an expense on WhatsApp — it's logged in seconds. Monthly reports, spend forecasts and smart insights, in Hebrew. Your data, your private Google Sheet.` *(154 chars)*

---

## Keywords Field (≤100 chars, no spaces after commas)
```
הוצאות,תקציב,כספים,חשבונות,עוסק,וואטסאפ,מעקב,ניהולכספים,budget,expenses,finance,money,whatsapp,biz
```
*(99 chars including Hebrew. Note: do NOT repeat words already in App Name/Subtitle here — "הוצאות" deliberately re-anchors as the head term; trim if Apple's byte-count on Hebrew pushes over 100. Hebrew is heavily front-loaded for the IL storefront; English tail captures expats/bilingual search.)*

**Counting caveat:** Apple counts Hebrew characters as single chars in the 100-char field (not bytes), so the above is safe. Verify in App Store Connect before submit.

---

## Description

### Hebrew (primary, benefit-led)

```
כספלה הופך מעקב הוצאות מדבר שמתחמקים ממנו — למשהו שקורה לבד.

שולחים הודעה בוואטסאפ: "85 סופר" — וזהו. ההוצאה נרשמת, מסווגת לקטגוריה ומחושבת בגיליון שלכם בתוך שניות. בלי טפסים, בלי אפליקציה כבדה, בלי להזין ידנית בסוף החודש.

למה משקי בית ובעלי עסקים קטנים בוחרים בכספלה:

• רישום בשנייה — דרך וואטסאפ, מאיפה שאתם כבר נמצאים
• בעברית, באמת — מבין שפה חופשית, סכומים ומטבעות
• מסך בית נקי — נטו, הוצאות והכנסות החודש במבט אחד
• תנועות — כל ההיסטוריה, עם חיפוש מהיר
• תובנות — תחזית הוצאה לסוף החודש, השוואה חודש-מול-חודש, מגמת 6 חודשים ותקציבים
• מתאים גם לעצמאים ועסקים קטנים — הפרדת הוצאות עסק

הפרטיות שלכם, בשליטה שלכם:
הנתונים נשמרים בגיליון Google הפרטי שלכם — לא במאגר שלנו. מתחברים עם חשבון Google (הרשאת Sheets/Drive). אין חיבור לבנק, אין שאיבת נתונים, אין מכירת מידע.

חינמי לרוב השימושים, עם מסלול Pro להרחבות.

מתחילים בלי כאב ראש — ורואים לאן הכסף הולך.
```

### English (mirror)

```
Kesefle turns expense tracking from a chore you avoid into something that just happens.

Send a WhatsApp message: "85 groceries" — done. The expense is logged, categorized and totaled in your own sheet within seconds. No forms, no heavy app, no manual end-of-month data entry.

Why households and small-business owners choose Kesefle:

• One-second logging — over WhatsApp, where you already are
• Real Hebrew — understands free text, amounts and currencies
• A clean home screen — net, expenses and income this month at a glance
• Transactions — full history with fast search
• Insights — end-of-month spend forecast, month-over-month, 6-month trend and budgets
• Built for freelancers and small businesses too — separate business expenses

Your privacy, your control:
Your data lives in your own private Google Sheet — not on our servers. Sign in with Google (Sheets/Drive permission). No bank connection, no scraping, no selling your data.

Free for most use, with a Pro plan for more.

Start with zero hassle — and finally see where your money goes.
```

---

## Category
- **Primary:** Finance
- **Secondary:** Productivity

---

## App Privacy — "Nutrition Label" Answers

Configure in App Store Connect → App Privacy. Answer per data type:

| Data type | Collected? | Purpose | Linked to user? | Used for tracking? |
|---|---|---|---|---|
| **Email Address** (Google account) | Yes | App Functionality (authentication) | **Linked** | **No** |
| **Name** (Google account) | Yes | App Functionality (identify the account) | **Linked** | **No** |
| **Other Financial Info** (expense amounts/categories the user enters) | Yes | App Functionality (the core service) | **Linked** | **No** |
| **User Content** (free-text notes in expense messages) | Yes | App Functionality | **Linked** | **No** |
| **Identifiers / Device ID** | No | — | — | — |
| **Usage Data / Analytics** | No (only minimal crash/operational logs, not for ads) | App Functionality / Diagnostics | Not Linked | **No** |
| **Location, Contacts, Browsing, Health, Photos** | No | — | — | — |

Key declarations:
- **"Data Used to Track You": NONE.** No data is used to track across other companies' apps/sites; no third-party ad SDKs.
- **"Data Linked to You":** email, name, financial info, user content (all tied to the user's account for the service to work).
- **"Data Not Linked to You":** none required; keep diagnostics minimal and either undeclared-if-truly-none or as Not Linked.
- **Financial data is stored in the user's OWN Google Sheet,** not retained server-side as a profile dataset — disclose accurately; do not over-claim retention you don't perform.

---

## App Privacy / Data-Use Summary Line (for the reviewer / App Review Notes)

> Kesefle collects the user's Google account email and name (OAuth, for sign-in only) and the financial entries the user types. All financial data is written to the user's **own private Google Sheet** via the Google Sheets/Drive scope and is not aggregated, sold, or used for advertising or cross-app tracking. No bank connections, no scraping. Demo Google account credentials and a 30-second walkthrough are provided below for review.

---

## Guideline 4.2 (Minimum Functionality) — positioning note for webview-wrapped finance utility

1. **Ship a native shell, not a bookmark:** wrap in Capacitor with genuine native capabilities (push notifications for spend alerts/budget warnings, Face ID/biometric app lock, native share-sheet "log this expense", offline cache of recent transactions) so the app does things Safari can't — and show those in the first two screenshots.
2. **Lead the listing with the WhatsApp-logging + on-device insights utility**, not "open kesefle.com" — never imply it's a website viewer; the app must launch into the dashboard, work without browser chrome, and handle its own auth/state natively.
3. **Arm App Review:** in App Review Notes, give a working demo Google account, a 30-sec flow, and explicitly state the native features above — Apple rejects 4.2 wrappers, so prove the standalone utility on first contact.

---

**Notes for submission:** Brand name is exactly **Kesefle** / **כספלה** everywhere (never "Kesple"). No statistics, ratings, or user counts are claimed anywhere in this copy — all benefit claims are factual product capabilities. Character counts above are approximate for Hebrew; re-verify in App Store Connect, which is the source of truth for the limits.

---

## TWA / PWABuilder technical scaffold

I'll produce all four sections with the exact real values you specified.

# Kesefle Android TWA / PWA Packaging Kit

## 1. `twa-manifest.json` (Bubblewrap config)

```json
{
  "packageId": "com.kesefle.app",
  "host": "kesefle.com",
  "name": "כספלה — האפליקציה",
  "launcherName": "כספלה",
  "display": "standalone",
  "themeColor": "#2563eb",
  "themeColorDark": "#070b16",
  "navigationColor": "#2563eb",
  "navigationColorDark": "#070b16",
  "navigationDividerColor": "#2563eb",
  "navigationDividerColorDark": "#070b16",
  "backgroundColor": "#070b16",
  "enableNotifications": true,
  "startUrl": "/app",
  "iconUrl": "https://kesefle.com/icon-512-maskable.png",
  "maskableIconUrl": "https://kesefle.com/icon-512-maskable.png",
  "monochromeIconUrl": "https://kesefle.com/icon-512.png",
  "splashScreenFadeOutDuration": 300,
  "signingKey": {
    "path": "./android.keystore",
    "alias": "kesefle"
  },
  "appVersionName": "1.0.0",
  "appVersionCode": 1,
  "shortcuts": [],
  "generatorApp": "bubblewrap-cli",
  "webManifestUrl": "https://kesefle.com/app.webmanifest",
  "fallbackType": "customtabs",
  "features": {},
  "alphaDependencies": {
    "enabled": false
  },
  "enableSiteSettingsShortcut": true,
  "isChromeOSOnly": false,
  "isMetaQuest": false,
  "fullScopeUrl": "https://kesefle.com/",
  "minSdkVersion": 21,
  "orientation": "portrait",
  "fingerprints": [],
  "additionalTrustedOrigins": [],
  "retainedBundles": [],
  "appVersion": "1.0.0"
}
```

> Notes: the maskable 512 PNG is set as both `iconUrl` and `maskableIconUrl` (it becomes the launcher icon). The non-maskable 512 is used as the monochrome/notification icon. `signingKey.alias` is the placeholder `kesefle` — change it if you generate the key with a different alias. `fullScopeUrl` reflects the manifest `scope: "/"`.

## 2. `.well-known/assetlinks.json`

Serve this at `https://kesefle.com/.well-known/assetlinks.json` (must return `200` with `Content-Type: application/json`, no redirect).

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.kesefle.app",
      "sha256_cert_fingerprints": [
        "REPLACE_WITH_PLAY_APP_SIGNING_SHA256"
      ]
    }
  }
]
```

> The fingerprint must be the colon-separated uppercase hex SHA-256, e.g. `AB:CD:EF:01:...` (32 byte pairs). Use the **Play App Signing** key fingerprint from Play Console once you upload, NOT your local upload key — otherwise links open in a browser tab with a URL bar instead of fullscreen. You can list **both** the upload key and the Play App Signing key in the array during transition.

**Vercel:** put the file at `/public/.well-known/assetlinks.json`. Confirm Vercel doesn't rewrite `/.well-known/*`. If needed, force the content type in `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/.well-known/assetlinks.json",
      "headers": [{ "key": "Content-Type", "value": "application/json" }]
    }
  ]
}
```

## 3. PWABuilder.com walkthrough (browser-based, no local Java/JDK)

1. Go to **https://www.pwabuilder.com**.
2. In the URL box enter `https://kesefle.com/app` (the `start_url`) and click **Start**.
3. Wait for the report card to load. Confirm Manifest / Service Worker / Security are detected. Click **Package For Stores** (top right).
4. On the store selection screen, choose the **Android** tile → click **Generate Package**.
5. In the Android options dialog, set:
   - **Package ID**: `com.kesefle.app`
   - **App name**: `כספלה — האפליקציה`
   - **Launcher name / Short name**: `כספלה`
   - **App version**: `1.0.0`  •  **App version code**: `1`
   - **Signing key**: select **"Create New"** (PWABuilder generates the keystore for you). Fill out Alias `kesefle`, plus the key/keystore passwords and the cert subject fields (org / country) — **save these passwords; they are not recoverable**.
   - **Display mode**: **Standalone** (use Fullscreen only if you want to hide the status bar).
   - **Status bar color**: `#2563eb`  •  **Nav bar / background color**: `#070b16`
   - Under advanced/Splash: **Start URL** `/app`, host `kesefle.com`. Leave **Include source code** on if you want to inspect/rebuild later.
6. Click **Download** → you get **`com.kesefle.app.zip`**.
7. **Inside the zip:**
   - **`app-release-signed.aab`** — the Android App Bundle you upload to Play Console (Production → Create release).
   - `app-release-signed.apk` — a sideloadable APK for direct device testing.
   - **`signing.keystore`** (or `android.keystore`) — your signing key. **Back this up; losing it blocks future updates.**
   - **`signing-key-info.txt`** — contains alias, passwords, and the **SHA-256 fingerprint** of the key you just created.
   - **`assetlinks.json`** — pre-filled Digital Asset Links file.
   - `next-steps.md` / `README` — deployment instructions.
8. **Where the SHA-256 fingerprint is:**
   - The generated key's fingerprint is in **`signing-key-info.txt`** inside the zip — use it to populate `sha256_cert_fingerprints` in `assetlinks.json` for immediate testing.
   - **For production, the authoritative fingerprint comes from Play App Signing**: Play Console → your app → **Setup → App integrity → App signing** → copy the **"SHA-256 certificate fingerprint"** under *App signing key certificate*. That is the value that replaces `REPLACE_WITH_PLAY_APP_SIGNING_SHA256`.
9. Deploy the updated `assetlinks.json` to `https://kesefle.com/.well-known/assetlinks.json` **before** rolling out, so the TWA launches without a browser address bar.

## 4. Bubblewrap CLI alternative (reference)

Requires **JDK 17** and the **Android SDK / command-line tools** installed locally (Bubblewrap can also auto-download the JDK and Android tools on first init if you let it).

```bash
# Install the CLI
npm install -g @bubblewrap/cli

# Initialize from the live manifest (generates twa-manifest.json + Android project)
npx @bubblewrap/cli init --manifest=https://kesefle.com/app.webmanifest

# Or, if you already have the twa-manifest.json above, drop it in an empty dir and run:
npx @bubblewrap/cli build

# Subsequent rebuilds after editing twa-manifest.json
npx @bubblewrap/cli update
npx @bubblewrap/cli build

# (Optional) print the SHA-256 fingerprint of your local signing key
npx @bubblewrap/cli fingerprint
# or directly via the JDK:
keytool -list -v -keystore ./android.keystore -alias kesefle
```

- `init` prompts for package ID (`com.kesefle.app`), app name, launcher name, colors, display mode, and signing key — accept/override to match the `twa-manifest.json` in §1.
- `build` outputs **`app-release-signed.aab`** (upload to Play) and **`app-release-signed.apk`** (sideload test), and writes/refreshes **`assetlinks.json`**.
- Use `bubblewrap doctor` to verify the JDK 17 + Android SDK paths if `build` fails.
- Same caveat as PWABuilder: with **Play App Signing** enabled, the production `assetlinks.json` fingerprint must be Play's signing-key SHA-256, not the local key's.

---

Relevant repo paths for follow-up:
- Manifest source: `https://kesefle.com/app.webmanifest`
- Asset links target on Vercel: `/public/.well-known/assetlinks.json`
- Bubblewrap config (if committed): `/twa-manifest.json` at repo root
