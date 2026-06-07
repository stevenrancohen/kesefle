---
name: kesefle-paypal-setup-guide
description: Steven-facing numbered guide to turn on PayPal subscription billing for Kesefle - which env var NAMES to set in Vercel (Steven pastes the secret values himself), and where the subscribe flow lives in the repo.
---

# Turn on PayPal billing (Steven's steps)

Kesefle's paid plans run on PayPal subscriptions. The server code already exists in `api/billing/paypal.js`; what's missing is the live PayPal plan IDs + credentials, set as Vercel environment variables. This guide is the numbered checklist to hand Steven. The assistant prepares it; Steven enters the secret values.

## What I (the assistant) will NOT do
- I will NOT enter, type, or read back your PayPal credentials. You paste `PAYPAL_CLIENT_SECRET` (and every secret) directly into the Vercel dashboard yourself.
- I only ever reference env var NAMES. No secret VALUE is ever echoed into chat, a commit, or a log.

## Steps (for Steven)
1. In PayPal (developer.paypal.com): create the Pro and Family subscription **Plans**, note each Plan ID (starts `P-...`). For yearly tiers, create separate yearly plans too.
2. Open Vercel -> the `kesefle` project -> **Settings -> Environment Variables** (Production scope).
3. Add these NAMES (consumed by `api/billing/paypal.js` - grep it to confirm):
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` - your app credentials.
   - `PAYPAL_ENV` = `live` (or `sandbox` while testing).
   - `PAYPAL_PLAN_PRO`, `PAYPAL_PLAN_PRO_YEAR`, `PAYPAL_PLAN_FAMILY`, `PAYPAL_PLAN_FAMILY_YEAR` - the `P-...` Plan IDs from step 1.
   - `PAYPAL_WEBHOOK_ID` - from the PayPal webhook you create pointing at `/api/billing/paypal?action=webhook`.
   - `PUBLIC_SITE_URL` = `https://kesefle.com` (used to build return/cancel URLs).
4. Paste each secret VALUE yourself in the Vercel field. Do not send any value to me in chat.
5. Redeploy (env changes only take effect on the next deploy). The website auto-deploys on push; for an env-only change, trigger a redeploy from the Vercel dashboard.
6. Tell me when done - I'll run the wiring check below and confirm the subscribe button is correctly pointed.

## Where the flow lives (for the assistant)
- Server: `api/billing/paypal.js` - `?action=subscribe` creates the subscription; `?action=webhook` (verified via `PAYPAL_WEBHOOK_ID`) flips entitlement.
- Frontend: `pricing.html` (`window.kflPricingCta` -> Pro/Family CTAs) and `account.html` (`kflSubscribe` / `kflStartUpgrade`) POST to `/api/billing/paypal?action=subscribe` with `credentials: include`.
- `upgrade.html` renders the `?paypal=success` / `?paypal=cancel` return states.

## Verification
- `node tests/full_qa.js` group `5m. Revenue: PayPal subscribe wiring` is green - it asserts `pricing.html`/`account.html` POST to `/api/billing/paypal?action=subscribe`, that `kflSubscribe`/`kflPricingCta` exist, and that `upgrade.html` handles success/cancel. Run the whole gate with `npm run gauntlet`.
- After Steven sets the env in Vercel, in production: clicking Pro on `/pricing` should redirect to a real PayPal approval URL (not an error), and the PayPal dashboard should show the matching `P-...` plan.

## Common pitfalls
- Setting env in the wrong Vercel scope (Preview, not Production) - the live site won't see it. Set Production.
- Forgetting to redeploy after adding env - values are read at runtime of the new deployment only.
- Leaving `PAYPAL_ENV=sandbox` after go-live - real customers can't pay. Flip to `live`.
- Skipping `PAYPAL_WEBHOOK_ID` - subscriptions get created but entitlement never flips because the webhook can't be verified.
- Pasting a secret into chat instead of Vercel - never do this; rotate the credential immediately if it happens.
