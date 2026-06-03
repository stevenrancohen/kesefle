# Kesefle — Go-Live Runbook / מדריך עלייה לאוויר

A durable, owner-facing reference to take Kesefle **fully live**. Written for a
non-technical owner (Steven). Every value below was verified against the real
code on `main` and is cited `file:line`. Anything that could **not** be confirmed
in code — or that the prior audit got wrong — is called out in **⚠️ FLAG** boxes.

מדריך קבוע להעלאת כספ'לה לאוויר. כל ערך אומת מול הקוד עצמו (מצוין `קובץ:שורה`).
מה שלא הצלחתי לאמת — מסומן ב-⚠️.

> Scope of "live": (1) the WhatsApp bot is deployed with the latest code, (2) a
> real customer can **pay** by card via PayPal, (3) the bot answers a real
> (non-test) phone number. Sections 1–3 below are the three gates; section 4 is
> open decisions.

> **Already done in code (do NOT redo):** the customer-facing PayPal *Subscribe*
> button + the `/upgrade` return page are wired and live in `main` (commit
> `cf39c64` "Wire customer-facing PayPal subscribe button"; see `pricing.html:1111`,
> `account.html:581`, `upgrade.html`). The remaining PayPal work is **only**
> giving the system the live credentials + plan IDs (Section 2). The backend
> billing pipeline is complete and untouched.

---

## 1. BOT DEPLOY — fix the "קוד <6 ספרות>" linking flow + ship queued bot work

**Why:** the bot is a Google Apps Script that does **not** auto-deploy. Pushing to
GitHub changes nothing live until you paste + re-deploy by hand. The latest bot
build (`KFL_BUILD_VERSION = '2026-06-03-confirm-always-dropdown-no-sheet-url'`,
`bot/ExpenseBot_DEPLOY.gs:137`) carries the queued fixes — including the
account-linking flow where a new user sends `קוד NNNNNN` to the bot to connect
their WhatsApp to their account (`api/whatsapp/link.js:3-17`; deep link built at
`account.html:799-800`).

> ⚠️ **FLAG — the linking flow itself works in code, but it points at the Meta
> TEST number.** Deploying the bot does NOT, on its own, make `קוד NNNNNN` reach
> a real customer's phone. That needs the production WhatsApp number from
> **Section 3**. So: do Section 1 to ship the latest bot code; do Section 3 to
> make new customers actually able to link. (`api/config.js:14-18`,
> `docs/REVENUE_BLOCKER_SELF_SERVE_AUDIT_2026-06-03.md:53-59`.)

### Current deployed version to expect
- `KFL_BUILD_VERSION = '2026-06-03-confirm-always-dropdown-no-sheet-url'`
  (`bot/ExpenseBot_DEPLOY.gs:137`; identical in `bot/ExpenseBot_FIXED.gs:62` — the
  two files are in sync). After deploy, the bot's "version" line should read this
  exact string (the bot prints `'גרסה: ' + KFL_BUILD_VERSION`,
  `bot/ExpenseBot_DEPLOY.gs:8765`).

### Steps (the "2 actions": SAVE, then NEW VERSION)
Source of truth: `docs/DEPLOY_BOT_SIMPLE.md`.

1. Open the file **`bot/ExpenseBot_DEPLOY.gs`** on GitHub (latest `main`) and
   copy its **entire** contents.
2. Go to **script.google.com** → open the **Kesefle** bot project → open the main
   code file → **Select-All** (Cmd+A) → delete → **paste** the copied contents.
3. Press **Cmd+S** (Mac) / **Ctrl+S** (Win) → wait for **"Saved"**.
4. Top-right → **Deploy** → **Manage deployments**.
5. On your **existing** deployment, click the **pencil ✏️ (Edit)**.
   ⚠️ **Do NOT click "New deployment"** — that makes a brand-new URL that WhatsApp
   does not use, so nothing changes (`docs/DEPLOY_BOT_SIMPLE.md`, top warning).
6. **Version** dropdown → **"New version"** → **Deploy** → **Done**.

### Verify
- WhatsApp the bot a quick expense (e.g. `42 קפה`) — it should reply, and any
  "version" line should show `2026-06-03-confirm-always-dropdown-no-sheet-url`.

### Emergency stop (good to know)
- To instantly halt all bot writes without redeploying: in Apps Script →
  **Project Settings → Script Properties**, add `KFL_DISABLE_BOT_WRITES = 1`
  (`bot/ExpenseBot_DEPLOY.gs:1767`). Remove it to resume.

---

## 2. PAYPAL GO-LIVE — make real card payments work

**Why:** the Subscribe button is already wired (see top note). What's missing is
the **live credentials + the plan IDs** the code reads from environment variables.
Without them, clicking Subscribe returns `paypal_plan_not_configured` /
`paypal_unreachable` and the page shows a friendly Hebrew error (the page never
breaks). PayPal checkout is **web-only**, so a customer can pay and be marked
premium **even before** the WhatsApp number (Section 3) is live.

### 2.1 The EXACT environment variables the code reads
All read in `api/billing/paypal.js`. Set these in **Vercel** → Project →
**Settings → Environment Variables** (Production). **Names only below — paste the
real secret values from PayPal, never commit them.**

| Env var name | Read at | Notes |
|---|---|---|
| `PAYPAL_ENV` | `paypal.js:28` | Set to **`live`**. Code defaults to `live` if unset, but set it explicitly. Anything other than `sandbox` ⇒ live API. |
| `PAYPAL_CLIENT_ID` | `paypal.js:34` | From your PayPal **LIVE** app. |
| `PAYPAL_CLIENT_SECRET` | `paypal.js:35` | From your PayPal **LIVE** app. |
| `PAYPAL_PLAN_PRO` | `paypal.js:61-62, 68` | Pro **monthly** plan ID (₪19/mo). |
| `PAYPAL_PLAN_PRO_YEAR` | `paypal.js:60-61, 68` | Pro **annual** plan ID (₪190/yr). Optional — see ⚠️ below. |
| `PAYPAL_PLAN_FAMILY` | `paypal.js:57-58, 67` | Family **monthly** plan ID (₪39/mo). |
| `PAYPAL_PLAN_FAMILY_YEAR` | `paypal.js:56-57, 66` | Family **annual** plan ID (₪390/yr). Optional — see ⚠️ below. |
| `PAYPAL_WEBHOOK_ID` | `paypal.js:225` | The webhook's ID from PayPal (used to verify each event's signature). |

Annual fallback behaviour (verified `paypal.js:53-63`): if a `_YEAR` plan ID is
**not** set, an annual subscribe silently falls back to the **monthly** plan
(charges monthly). So leaving the `_YEAR` vars unset is safe but means "annual"
buyers actually get billed monthly.

**Links:**
- PayPal LIVE apps (get Client ID / Secret): <https://developer.paypal.com/dashboard/applications/live>
- Vercel env vars: <https://vercel.com>

### 2.2 Create the plans (the admin one-click bootstrap)
There is a built-in admin helper. Signed in as admin on **kesefle.com**, open the
**admin console** and click **"Create PayPal plans"** (button id
`kfl-paypal-setup-btn`, `admin.html:1458-1473`). It calls
`POST /api/billing/paypal?action=setup-plans` (`admin.html:1464`;
`api/billing/paypal.js:426-448`).

> ⚠️ **FLAG — IMPORTANT CORRECTION.** The task brief (and the prior audit
> `docs/REVENUE_BLOCKER_SELF_SERVE_AUDIT_2026-06-03.md:77`) say `setup-plans`
> "creates the 4 plans". **The code does NOT.** `setupPlansImpl`
> (`api/billing/paypal.js:432-443`) creates **only 2 plans — Pro monthly and
> Family monthly** — and returns only `PAYPAL_PLAN_PRO` + `PAYPAL_PLAN_FAMILY`
> (its own response text even says "Paste these **two** IDs", `paypal.js:442`).
> The plan-creation helper is **hard-coded to monthly** billing
> (`interval_unit: 'MONTH'`, `paypal.js:408`), so it **cannot** produce the two
> annual plans.
>
> **What this means for you:**
> 1. Click **"Create PayPal plans"** → it returns 2 IDs → paste them into Vercel
>    as `PAYPAL_PLAN_PRO` and `PAYPAL_PLAN_FAMILY` → redeploy.
> 2. For **annual** (`PAYPAL_PLAN_PRO_YEAR` ₪190/yr, `PAYPAL_PLAN_FAMILY_YEAR`
>    ₪390/yr): either (a) **create those 2 plans by hand** in the PayPal
>    dashboard (yearly billing cycle) and paste their IDs into Vercel, or
>    (b) leave them unset and accept that "annual" buyers are billed monthly
>    (the safe fallback above). There is no code button that creates the annual
>    plans today.

### 2.3 The webhook
- **Webhook URL to register in PayPal:**
  `https://kesefle.com/api/billing/paypal?action=webhook`
  (router dispatch: `api/billing/paypal.js:473`; site base `kesefle.com`,
  `paypal.js:25`).
- **Subscribe to exactly these event types** (these are the only ones the handler
  acts on — verified `api/billing/paypal.js`):

  | Event type | Effect in code | Line |
  |---|---|---|
  | `BILLING.SUBSCRIPTION.ACTIVATED` | marks user **paid** (activatePremium) | `paypal.js:273` |
  | `PAYMENT.SALE.COMPLETED` | renewal/first payment → extends access + issues VAT invoice | `paypal.js:288` |
  | `BILLING.SUBSCRIPTION.CANCELLED` | deactivates premium | `paypal.js:321` |
  | `BILLING.SUBSCRIPTION.EXPIRED` | deactivates premium | `paypal.js:322` |
  | `BILLING.SUBSCRIPTION.SUSPENDED` | deactivates premium | `paypal.js:323` |
  | `PAYMENT.SALE.DENIED` | dunning: marks payment-failed + Day-0 email | `paypal.js:330` |
  | `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | dunning: marks payment-failed + Day-0 email | `paypal.js:331` |

  After creating the webhook in PayPal, copy its **Webhook ID** into Vercel as
  `PAYPAL_WEBHOOK_ID` (used to verify signatures, `paypal.js:225-237`; an unset or
  wrong ID makes every event fail verification and return `401`).

### 2.4 Canonical prices (the single source of truth)
From `lib/billing.js:11-14` (`const PRICES`):

| Plan | Monthly | Annual |
|---|---|---|
| **Pro** | **₪19** | **₪190** |
| **Family** | **₪39** | **₪390** |

(`lib/billing.js:11` comment: "Yearly ≈ 10 months (2 free)".) The
`setup-plans` helper prices the monthly plans straight from this file
(`priceILS('pro','month')`=19, `priceILS('family','month')`=39,
`paypal.js:434-435`). If you create the annual plans by hand, price them **₪190**
and **₪390**.

### 2.5 PayPal go-live checklist
- [ ] Vercel: `PAYPAL_ENV=live`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` set.
- [ ] Admin → **Create PayPal plans** → paste returned `PAYPAL_PLAN_PRO` +
      `PAYPAL_PLAN_FAMILY` into Vercel.
- [ ] (Optional) Create annual plans by hand → set `PAYPAL_PLAN_PRO_YEAR` (190) +
      `PAYPAL_PLAN_FAMILY_YEAR` (390). If skipped, annual buyers bill monthly.
- [ ] PayPal: create webhook at `https://kesefle.com/api/billing/paypal?action=webhook`
      subscribed to the 7 events above → paste its **Webhook ID** into Vercel as
      `PAYPAL_WEBHOOK_ID`.
- [ ] Redeploy on Vercel (env-var changes need a redeploy to take effect).
- [ ] Test: sign in → Subscribe → complete a real PayPal payment → confirm the
      account flips to premium.

---

## 3. WHATSAPP PRODUCTION NUMBER — replace the Meta TEST number

> ⚠️ **FLAG — needs the owner's real number.** This step CANNOT be completed by
> the agent. It requires a **production WhatsApp Business API phone number** that
> only you (Steven) can provision in Meta Business. Until it exists, every "message
> the bot" link on the site points at the Meta **TEST** number, and a real
> customer's phone is not on the test allowlist, so they get **no reply**.

### What is true today (verified)
- `api/config.js:18`: `const DEFAULT_BOT_NUMBER = '15556408123';` — the code's own
  comment (`api/config.js:14`) labels this **the Meta test number**, used "until
  Steven configures `KESEFLE_BOT_NUMBER`".
- `api/config.js:26`: the runtime config endpoint returns
  `process.env.KESEFLE_BOT_NUMBER || DEFAULT_BOT_NUMBER` — i.e. **set the
  `KESEFLE_BOT_NUMBER` env var and it overrides the test number** for the
  server-driven parts.
- The same test number is **also hardcoded** in ~58 places across HTML
  (`wa.me/15556408123` anchors, plus `account.html:643`, `welcome.html:231`,
  `dashboard.html:4229`) — these do NOT read the env var, so they must be
  text-swapped (`docs/REVENUE_BLOCKER_SELF_SERVE_AUDIT_2026-06-03.md:54-59`).

### Does the swap script exist? — YES
**`scripts/swap-bot-number.sh` exists** (verified). It does a global find-replace
of the old test number `15556408123` → your new number across all
`*.html / *.js / *.gs / *.md` (`scripts/swap-bot-number.sh:28, 70-85`).

> ⚠️ **FLAG — naming nuance.** The brief asks "what env/Script-Property does the
> swap script set (e.g. `KESEFLE_BOT_NUMBER`)?" The script does **not** set the
> Vercel env var. It edits the hardcoded number in source files (including the
> `KESEFLE_BOT_NUMBER` *constant* in `account.html`). You must set the
> `KESEFLE_BOT_NUMBER` **env var in Vercel separately**, and the Apps Script
> properties separately (the script explicitly says it "can't touch those",
> `scripts/swap-bot-number.sh:23-24`).

### Cutover procedure (after you have the real E.164 number)
1. **You provide** the production number in E.164 without `+`
   (e.g. `9725XXXXXXXX`).
2. Run the swap (agent does this on a branch, you review the diff):
   `scripts/swap-bot-number.sh 9725XXXXXXXX` — reports how many references it
   changed (`scripts/swap-bot-number.sh:60, 91-93`).
3. Set the Vercel env var **`KESEFLE_BOT_NUMBER`** = your number
   (`api/config.js:26`). Optional related env vars on the same endpoint:
   `KESEFLE_BOT_NAME` (`api/config.js:27`) and `WABA_APPROVED=1` once Meta
   approves you (`api/config.js:43`).
4. In **Apps Script → Project Settings → Script Properties**, set
   **`WHATSAPP_PHONE_NUMBER_ID`** (your WABA phone-number ID) and
   **`BOT_PHONE_E164`** (`scripts/swap-bot-number.sh:23-24, 99`; both confirmed in
   `bot/ExpenseBot_DEPLOY.gs:129, 16078` and the script-property name
   `WHATSAPP_PHONE_NUMBER_ID` is read by the bot).
5. Commit + push (auto-deploys the website via Vercel) and re-deploy the bot
   (Section 1) so the new number is live everywhere.
6. In **Meta Business**, confirm the WhatsApp webhook still points at the live URL
   (`scripts/swap-bot-number.sh:100` says `https://kesefle.com/api/whatsapp/webhook`).

> ⚠️ **FLAG — which webhook URL / which bot is canonical is NOT decidable from the
> repo.** There are two reply paths: the Vercel `api/whatsapp/webhook.js` and the
> live Apps Script bot. `scripts/swap-bot-number.sh:100` tells you to point Meta at
> `/api/whatsapp/webhook`, but `docs/AUDIT_WHATSAPP_WEBHOOK_2026_05_31.md:14` says
> the Apps Script bot owns its own Meta webhook URL and Vercel does **not** proxy to
> it. **Only one URL can be registered in Meta.** Which one is currently live is a
> Meta-console fact, not in the code — you must confirm/decide it in Meta. (Project
> memory indicates the **Apps Script** bot is the live one — treat that as the
> working assumption, but verify in Meta.)

---

## 4. OPEN DECISIONS

### 4.1 "Family" size = a marketing number (no hard cap in code)
- The site advertises Family as **"עד 4 משתמשים"** (up to 4 users)
  (`index.html:1459`).
- ⚠️ **FLAG — there is NO code that enforces a 4-member (or any) limit.** Verified:
  no `lib/family*.js` / `api/family*` file exists, and no member-cap check exists in
  `lib/` or `api/` (`lib/subscription.js` only lists `family` as a premium plan,
  `lib/subscription.js:15`). So "4" is purely a marketing figure you can change in
  copy without touching code — and nothing currently stops a Family account from
  adding more than 4. Decide whether that's intended; if you want a real cap, it
  has to be built.

### 4.2 Homepage annual prices are STALE (180 / 348) vs canonical (190 / 390)
- Canonical (authoritative): Pro annual **₪190**, Family annual **₪390**
  (`lib/billing.js:11-14`).
- `pricing.html` is **correct**: `data-year="190"` (`pricing.html:435`),
  `data-year="390"` (`pricing.html:461`), and copy "190 ש"ח לשנה"
  (`pricing.html:1162`).
- **`index.html` (homepage) is STALE:**
  - Pro: shows **"או 180₪ לשנה (חוסכים 21%)"** (`index.html:1435`) — should be **190**.
  - Family: shows **"או 348₪ לשנה (חוסכים 26%)"** (`index.html:1456`) — should be **390**.
  - (Monthly figures on the homepage, ₪19 / ₪39, are correct: `index.html:1431, 1452`.)
- ⚠️ **FLAG — decision for the owner:** confirm 190/390 is the intended annual
  pricing, then the homepage copy at `index.html:1435` and `index.html:1456` (and
  the savings-% if you want them recalculated) should be corrected to match
  canonical. This runbook only documents the mismatch; no code/HTML was changed.

---

## Quick reference — env vars to set in Vercel (NAMES ONLY)
PayPal: `PAYPAL_ENV` (=live), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_FAMILY`, `PAYPAL_PLAN_PRO_YEAR` (opt),
`PAYPAL_PLAN_FAMILY_YEAR` (opt), `PAYPAL_WEBHOOK_ID`.
WhatsApp/site: `KESEFLE_BOT_NUMBER`, optional `KESEFLE_BOT_NAME`, `WABA_APPROVED`.

## Quick reference — Apps Script Script Properties to set (NAMES ONLY)
`WHATSAPP_PHONE_NUMBER_ID`, `BOT_PHONE_E164` (cutover), and the existing
`GEMINI_API_KEY` (bot AI). Emergency: `KFL_DISABLE_BOT_WRITES=1` to halt writes.

---
*Last verified against `main` on 2026-06-03. Re-verify `KFL_BUILD_VERSION`,
`lib/billing.js` PRICES, and `api/billing/paypal.js` env reads if the code
changes.*
