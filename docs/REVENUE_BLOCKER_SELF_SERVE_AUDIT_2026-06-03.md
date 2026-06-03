# Revenue-Blocker Audit: New-Customer Self-Serve Paid Signup

Date: 2026-06-03
Branch audited: `main` @ `ed3e34c` (read directly, READ-ONLY).
Author: code-level trace agent. Every claim below is cited `file:line` against the actual code on `main`. Prior-audit claims were re-verified, not trusted.

---

## (a) Verdict

**No. A brand-new customer cannot self-serve a *paid* signup today, and separately cannot reach a working bot.**

A new visitor CAN: click a CTA, sign in with Google, and get a private Google Sheet provisioned (`account.html` -> `/api/auth/google-exchange` -> `/api/sheet/provision` all work). They are auto-enrolled in a 14-day Pro trial (`api/auth/google-exchange.js:200-204` + `lib/subscription.js:135-142`), so the *product entitlement* is unlocked without paying.

But the self-serve path **stops dead at two independent walls**:

1. **PAYMENT WALL (CODE-FIXABLE, the literal revenue blocker):** Every pricing CTA is a plain `<a href="/account?plan=pro">` (`pricing.html:450,474,843`). `/account` stores the chosen plan in `sessionStorage` (`account.html:1023,1026`) but **nothing ever reads it back** (verified: zero `getItem('kesefle_selected_plan')` anywhere). The working PayPal subscribe endpoint `POST /api/billing/paypal?action=subscribe` (`api/billing/paypal.js:168-214,460`) is **never called by any customer-facing page** — its only frontend caller is the admin console's `setup-plans` bootstrap (`admin.html:1377`). There is **no "Subscribe / Pay" button on pricing.html or account.html** at all. A trial user therefore has no in-product way to ever become a paying user; the trial simply lapses to free after 14 days.

2. **WHATSAPP WALL (BLOCKED-ON-STEVEN):** The number a new user is told to message — on `/account`, `/welcome`, every blog/landing CTA, ~58 places — is hardcoded to `15556408123`, which `api/config.js:14-18` itself labels the **Meta TEST number** (`DEFAULT_BOT_NUMBER`). A real new customer's phone is not on the test allowlist, so their "send first expense" message never reaches the bot and they get no reply. No production WhatsApp Business number exists yet.

So: the backend billing pipeline is built and correct, but it is orphaned from the UI; and first-value over WhatsApp is gated on a production number Steven hasn't provisioned. **The single thing that unblocks revenue fastest is wiring a customer-facing PayPal subscribe button to the already-working endpoint** (a sale can complete by card via PayPal even before the WhatsApp number is live, since PayPal checkout is web-only).

---

## (b) Step-by-step trace (with file:line evidence)

### Step 1 — Landing -> signup / pricing  [ALREADY-WORKING]
- Hero primary CTA scrolls to `#signup` (`index.html:677`); nav "הרשמה" -> `/account?mode=signup` (`index.html:616,633`); a "1-click" row calls `kesefleStartGoogle` (`index.html:691`).
- Pricing CTAs:
  - Free: `<a href="/account?plan=free">` (`pricing.html:424,847`).
  - Pro: `<a href="/account?plan=pro">` "התחל ניסיון 14 ימים" (`pricing.html:450,843`).
  - Family: `<a href="/account?plan=family">` (`pricing.html:474`).
- `kesefleSelectPlan(plan)` (`pricing.html:897+`) only rewrites the href to append `&period=year` when the year toggle is on (`pricing.html:1048-1049`). It does **not** start any checkout.
- All paths converge on `/account`. **There is no PayPal/checkout button on the pricing page** (confirmed: the only `paypal` references in `pricing.html` are FAQ prose at lines 77, 451, 702, 819).

### Step 2 — Account creation / Google sign-in  [ALREADY-WORKING]
- `kesefleStartGoogle` uses a PKCE redirect (`index.html:1933`; `account.html:1313-1372`), then `/api/auth/google-exchange` exchanges the code, stores the encrypted refresh token, and sets an HttpOnly session cookie (`account.html:1393-1430` calling `/api/auth/google-exchange`).
- First-signup side effect: a 14-day Pro trial is stamped exactly once — `if (isNewUser && !record.trialEndsAt && !record.stripeSubscriptionId) Object.assign(record, newUserTrialFields(...))` (`api/auth/google-exchange.js:200-204`); fields are `plan:'free', trialPlan:'pro', trialStartedAt, trialEndsAt = now+14d` (`lib/subscription.js:135-142`).
- Entitlement during trial: `computeEntitlement` returns `premium=true` while inside the trial window even though stored `plan==='free'` (`lib/subscription.js:79-122`). So the product is usable without paying — by design.

### Step 3 — Choose paid plan -> PayPal subscribe  [**BROKEN — the revenue blocker**]
- `/account` captures the plan/period from the URL into sessionStorage: `sessionStorage.setItem('kesefle_selected_plan', plan)` / `'kesefle_selected_period'` (`account.html:1013-1028`). The in-code comment admits the consumer doesn't exist yet: *"the PayPal subscribe call (whenever the upgrade flow gets a single button) reads these"* (`account.html:1015-1016`).
- **Nothing reads those keys.** Grep for `getItem('kesefle_selected_plan')` / `kesefle_selected_plan` (read side) across all HTML+JS returns **zero** hits beyond the two `setItem` writes.
- The subscribe endpoint is fully implemented and correct:
  - Router: `action==='subscribe' -> subscribeHandler` (`api/billing/paypal.js:459-463`), `requireAuth`-gated + rate-limited (`api/billing/paypal.js:442-444`).
  - `subscribeImpl` reads `{plan,period}` from the **POST body** (not query), resolves the PayPal `plan_id` from env (`PAYPAL_PLAN_PRO` / `PAYPAL_PLAN_FAMILY` / `_YEAR` variants), creates a PayPal subscription bound to the verified user via `custom_id: req.user.sub`, and returns the approval `url` (`api/billing/paypal.js:168-213`). `return_url`/`cancel_url` point at `/upgrade?paypal=success|cancel` (`api/billing/paypal.js:197-198`), and `/upgrade` 301-redirects to `/pricing` (`vercel.json:33`) — there is **no `/upgrade` success page** (`upgrade.html` does not exist), so even a manually-triggered subscribe returns the buyer to the generic pricing page with no confirmation.
  - Webhook activates the user as paid: `BILLING.SUBSCRIPTION.ACTIVATED -> activatePremium(userSub, {...})` (`api/billing/paypal.js:261-271`), and `activatePremium` flips KV: `rec.plan = pro|family; rec.subscriptionStatus='active'; rec.accessUntil` extended; persisted to `user:{sub}` (`lib/billing.js:115-141`). Webhook is verified via PayPal's `verify-webhook-signature` API and is idempotent on `paypal_event:{id}` (`api/billing/paypal.js:217-260`).
- **Conclusion:** payment marking in KV works *if* a subscription is ever created — but **no customer UI ever creates one.** The endpoint is orphaned. This is the #1 RED blocker, and it is CODE-FIXABLE.
- Crypto + manual rails have the same shape: `/api/billing/crypto-create` and `/api/billing/manual` exist server-side, but the only frontend caller of `billing/manual` is `admin.html:1321,1360`. No customer-facing crypto/manual purchase button exists either (the matches in `help.html`/`about.html`/`docs.html`/one blog page are documentation/FAQ prose, e.g. the API-doc `<code>` sample at `docs.html:1023`, not buttons).

### Step 4 — Connect WhatsApp / provision the sheet
- **Provisioning [ALREADY-WORKING]:** `/api/sheet/provision` verifies the Google access token, creates the per-user sheet via `createUserSheetWithToken`, and writes the canonical `sheet:{userSub}` mapping to KV with a read-back check (`api/sheet/provision.js:17,167-228`). Re-provision/archival is handled (`api/sheet/provision.js:131-167`). Frontend calls it with retry right after sign-in (`account.html:1445-1456`).
- **WhatsApp linking [CODE WORKS, but points at the TEST number — BLOCKED-ON-STEVEN]:** `/api/whatsapp/link` mints a 6-digit code -> stored `code->userSub` (10-min TTL) -> user sends `קוד NNNNNN` to the bot -> webhook calls `?action=confirm` -> `phone:{E164} -> userSub` persisted (`api/whatsapp/link.js:3-17`). The UI flow (`account.html:691-810`) builds the deep link as `https://wa.me/' + KESEFLE_BOT_NUMBER + '?text=' + 'קוד '+code` (`account.html:799-800`).
- **The number is the Meta TEST number and is NOT centralized:**
  - `account.html:643`: `var KESEFLE_BOT_NUMBER = '15556408123';` (hardcoded; comment claims "registered with Meta 2026-05-18" — **this conflicts with** `api/config.js:14-18` which calls the identical number the *test* number / `DEFAULT_BOT_NUMBER`. Treat config.js as authoritative; flag the comment as stale/misleading.).
  - `welcome.html:231` and `dashboard.html:4229`: same hardcoded `'15556408123'` with a "see /api/config for runtime override" comment — but **neither page actually overwrites the constant** from `/api/config`. `dashboard.html` does fetch `/api/config` (`dashboard.html:3818`) yet only consumes `vapid_public_key` (`dashboard.html:3822`), not `BOT_NUMBER`.
  - Static `wa.me/15556408123` anchors: 58 occurrences across HTML (e.g. `index.html:1613,1665`; `account.html:371` "send first expense" CTA; all blog/landing pages). 9 dynamic `wa.me/` anchors exist (e.g. `account.html:796-830`, `dashboard.html:4245,4257`) that *do* read a runtime `BOT_NUMBER` JS var — but that var is itself the hardcoded test number on those pages, so they resolve to the test number anyway.
  - `api/config.js` *does* expose `BOT_NUMBER` from `process.env.KESEFLE_BOT_NUMBER` (`api/config.js:26,34`), so the server side is env-driven — but the HTML largely ignores it.
  - A cutover tool already exists: `scripts/swap-bot-number.sh <new_number>` does a global `15556408123 -> NEW` sed across all `*.html/js/gs/md` (`scripts/swap-bot-number.sh:28,70-85`), covering `account.html:643`, `welcome.html:231`, `dashboard.html:4229`, and all 58 anchors in one shot.

### Step 5 — First value: working dashboard + a bot that replies
- **Dashboard [ALREADY-WORKING]:** after provisioning, `account.html` reloads to the linked-success state and offers `/welcome` (commands guide) and the open-sheet/dashboard links; the sheet exists in the user's own Drive. Web read endpoints (`/api/sheet/summary`, `/stats`, `/getExpenses`) are present.
- **Bot reply [BLOCKED-ON-STEVEN]:** Two independent bot implementations exist:
  1. Vercel `api/whatsapp/webhook.js` — a full parse-and-reply handler that needs `META_VERIFY_TOKEN` (`:97`), a webhook/app secret for HMAC (`:148`), and `META_PHONE_NUMBER_ID` + `META_ACCESS_TOKEN` to send (`api/whatsapp/webhook.js:62-67`); it `log.warn`s and silently no-ops the reply when those are unset.
  2. The live Apps Script bot `bot/ExpenseBot_FIXED.gs` (manual paste-deploy, per project memory), which per a prior audit *"has its own independent Meta webhook URL"* and the Vercel webhook *"does NOT proxy to Apps Script"* (`docs/AUDIT_WHATSAPP_WEBHOOK_2026_05_31.md:14`).
  - **Only one URL can be registered in Meta as the WABA webhook.** Which one is live is a Meta-console fact not in this repo (note the unresolved conflict: `scripts/swap-bot-number.sh:100` tells Steven to confirm Meta points at `/api/whatsapp/webhook`, while the audit doc says Apps Script owns the URL). Regardless of which, a new customer's message only reaches a replying bot once (i) Meta points at the correct live URL and (ii) the WABA is approved with a real number that allows non-test recipients. Both are Steven/Meta-side. **The code path to reply exists; the gating is config + the production number.**

---

## (c) Prioritized fix list

### BLOCKED-ON-STEVEN (decisions / secrets only Steven can provide)

| # | Blocker | Exactly what is needed from Steven |
|---|---------|-------------------------------------|
| S1 | **Production WhatsApp Business number** | Provision a real WABA phone number (Meta Business -> WhatsApp -> add production number) and give the agent the E.164 (e.g. `9725XXXXXXXX`). Until this exists, every "message the bot" CTA points at the test number and new customers get no first-value. After it exists, the agent runs `scripts/swap-bot-number.sh <number>` + sets `KESEFLE_BOT_NUMBER` env. |
| S2 | **PayPal LIVE credentials + plan IDs** | Set in Vercel: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=live`, `PAYPAL_WEBHOOK_ID`, and the four plan IDs `PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_FAMILY`, `PAYPAL_PLAN_PRO_YEAR`, `PAYPAL_PLAN_FAMILY_YEAR`. The plan IDs can be generated by the admin `?action=setup-plans` bootstrap (`api/billing/paypal.js:368-431`, exposed at `admin.html:1377`) — Steven runs it once and pastes the IDs into Vercel. Without these, even a wired button returns `paypal_plan_not_configured` (`api/billing/paypal.js:175-176`). |
| S3 | **Meta app verification + webhook URL + secrets** | Confirm in Meta which webhook URL is live (`/api/whatsapp/webhook` vs the Apps Script exec URL) and set the matching secrets: `META_VERIFY_TOKEN`, the app/webhook secret, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` (Vercel) and/or `WHATSAPP_PHONE_NUMBER_ID` + `BOT_PHONE_E164` (Apps Script Script Properties, per `scripts/swap-bot-number.sh:99`). Complete Meta Business verification so the WABA can message non-test numbers. |
| S4 | **Decision: which bot is canonical** | Resolve the Vercel-webhook-vs-Apps-Script ambiguity so we stop maintaining two reply paths. (Not blocking revenue, but blocking confidence that "the bot replies".) |

### CODE-FIXABLE (a follow-up agent can do without Steven)

| # | Fix | File:line + precise change |
|---|-----|-----------------------------|
| **C1 (HIGHEST LEVERAGE)** | **Wire a customer-facing PayPal subscribe button to the existing endpoint.** This is the literal revenue unblock. | Add an upgrade trigger that does `fetch('/api/billing/paypal?action=subscribe', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ plan, period }) })` then `window.location = json.url`. `plan`/`period` come from the already-stored `sessionStorage` keys written at `account.html:1023,1026`. Two concrete options: **(a)** convert the pricing Pro/Family CTAs (`pricing.html:450,474,843`) from `<a href="/account?plan=...">` into a handler that, for a signed-in user, POSTs subscribe directly; for a signed-out user, routes through `/account` sign-in and then auto-resumes the subscribe using the stored plan. **(b)** Add an "Upgrade to Pro" button on `account.html` (in the trial/free state) that reads `sessionStorage.kesefle_selected_plan` (falling back to a plan picker) and POSTs subscribe. Endpoint contract is `api/billing/paypal.js:168-213` (body `{plan,period}` -> `{ok,url}`). |
| C2 | **Add the `/upgrade` PayPal return page** (success + cancel states) so post-checkout buyers land somewhere that confirms activation, instead of being 301'd to generic `/pricing`. | The subscribe flow returns to `/upgrade?paypal=success|cancel` (`api/billing/paypal.js:197-198`) but `vercel.json:33` redirects `/upgrade -> /pricing` and no `upgrade.html` exists. Either create `upgrade.html` (reads `?paypal=`, polls `/api/me` for `plan`, shows success + link to `/dashboard`) and **remove the `/upgrade` redirect at `vercel.json:33`**, or repoint `return_url`/`cancel_url` to an existing page like `/thanks` / `/cancel`. |
| C3 | **Centralize the bot number so the swap is real.** | After S1, the swap script covers the static copies, but the architecture should not depend on a sed. Make `account.html:643`, `welcome.html:231`, `dashboard.html:4229` hydrate `BOT_NUMBER` from `/api/config` (`dashboard.html` already fetches it at `:3818` — just also read `results[0].BOT_NUMBER`). Lowest-effort immediate fix for the cutover: run `scripts/swap-bot-number.sh <S1-number>` and set `KESEFLE_BOT_NUMBER` env; longer-term, do the `/api/config` hydration so there is one source of truth (`api/config.js:26`). |
| C4 | **Delete the stale/misleading comment** at `account.html:643` ("registered with Meta 2026-05-18") which contradicts `api/config.js:14-18` (test number). Minor, but it has already caused confusion. | `account.html:643` — fix the comment to "Meta TEST number; overridden by KESEFLE_BOT_NUMBER env / swap-bot-number.sh at cutover." |

> Note: C1 alone makes the product *sellable* even before S1/S3 — PayPal checkout is web-only, so a customer can pay and be marked premium in KV (`lib/billing.js:115-141`) without a working WhatsApp number. They just can't get WhatsApp value until S1+S3. That ordering is what makes C1 the highest-leverage action.

---

## (d) Single highest-leverage next action

**Do C1: add a customer-facing "Subscribe with PayPal" button that POSTs `{plan,period}` to the already-working `/api/billing/paypal?action=subscribe` and redirects to the returned approval URL** — wired to the plan already captured in `sessionStorage` at `account.html:1023-1026`. This is a small, self-contained frontend change (no backend work — the subscribe endpoint, webhook, and KV activation in `api/billing/paypal.js` + `lib/billing.js` are all built and correct) that converts the #1 RED revenue blocker from "impossible to pay" to "one-click checkout." It depends only on Steven setting the PayPal LIVE env vars (S2), which he can do in parallel via the existing `setup-plans` admin bootstrap. Pair it with C2 (the `/upgrade` return page) so the buyer sees a confirmation. WhatsApp first-value (S1/S3) can follow without blocking the first dollar.
