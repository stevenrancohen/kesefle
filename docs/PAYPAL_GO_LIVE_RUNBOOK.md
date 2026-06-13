# PayPal Go-Live Runbook (for Steven)

Turn on real PayPal payments for kesefle.com, step by step. No coding needed.
You only ever paste secret VALUES into Vercel yourself — never into chat, never
into a file in the repo.

**Safety default:** the code ships pointing at PayPal **sandbox** (fake money).
Nothing can charge a real customer until you complete step 10 (`PAYPAL_ENV=live`).

Pricing is fixed in code (`lib/billing.js`) and is NOT an env var:
Pro **19 ILS/month** or **190 ILS/year**, Family **39 ILS/month** or **390 ILS/year**.

---

## Part 1 — Create the PayPal app (one time)

1. Go to https://developer.paypal.com and log in with the business PayPal account
   (the account that should RECEIVE the money).
2. Click **Apps & Credentials**.
3. At the top, switch the toggle to **Live** (not Sandbox).
4. Click **Create App**. Name it `Kesefle`. Type: **Merchant**. Click **Create App**.
5. The app page now shows two values. You will paste them into Vercel in Part 2:
   - **Client ID**
   - **Secret** (click "Show" to reveal it)

## Part 2 — Paste the env vars in Vercel

6. Open https://vercel.com → the `kesefle` project → **Settings → Environment Variables**.
7. Add these TWO variables (scope: **Production**), pasting the values from step 5:
   - Name: `PAYPAL_CLIENT_ID` → value: the Client ID
   - Name: `PAYPAL_CLIENT_SECRET` → value: the Secret
8. Add a third variable:
   - Name: `PAYPAL_ENV` → value: `sandbox` (yes, sandbox first — we test before real money)
9. Redeploy so the new env takes effect: Vercel → **Deployments** → latest → **⋯ → Redeploy**.
   (Code changes auto-deploy on merge to main, but env-only changes need this manual redeploy.)

> Step 10 comes LAST, after the sandbox test in Part 5: change `PAYPAL_ENV` to `live`
> and redeploy. That is the only switch between fake and real money.

## Part 3 — Create the subscription plans (one click)

11. Open the kesefle admin and run **"צור תכניות ב-PayPal"** (the setup-plans action —
    it calls `POST /api/billing/paypal?action=setup-plans`). Click it **once**.
    - It creates one product + 4 plans (Pro/Family × monthly/annual, in ILS:
      19 / 190 / 39 / 390) and shows 4 plan IDs that look like `P-...`.
    - It is safe to click again: it remembers the IDs and returns the SAME ones
      (it will say `reused: true`) instead of creating duplicates.
12. In Vercel → Environment Variables, add the 4 IDs exactly as named in the response:
    - `PAYPAL_PLAN_PRO`
    - `PAYPAL_PLAN_PRO_YEAR`
    - `PAYPAL_PLAN_FAMILY`
    - `PAYPAL_PLAN_FAMILY_YEAR`
13. Redeploy again (same as step 9).

> **Never swap these 4 IDs to new ones once people have subscribed** — existing
> subscriptions are recognized by these IDs. If you ever must, ask Claude first.

## Part 4 — Register the webhook in PayPal

14. Back on https://developer.paypal.com → your `Kesefle` app page → scroll to
    **Webhooks** → **Add Webhook**.
15. Webhook URL (paste exactly):
    ```
    https://kesefle.com/api/billing/paypal?action=webhook
    ```
16. Tick these event types (6 total):
    - `BILLING.SUBSCRIPTION.ACTIVATED`
    - `BILLING.SUBSCRIPTION.CANCELLED`
    - `BILLING.SUBSCRIPTION.EXPIRED`
    - `BILLING.SUBSCRIPTION.SUSPENDED`
    - `BILLING.SUBSCRIPTION.PAYMENT.FAILED`
    - `PAYMENT.SALE.COMPLETED`
17. Save. PayPal shows a **Webhook ID** — copy it.
18. In Vercel, add: Name `PAYPAL_WEBHOOK_ID` → value: that ID. Redeploy (step 9).

> Note: even if a webhook is delayed, the customer is still upgraded the moment
> they land back on kesefle.com/upgrade (the site confirms the subscription
> directly with PayPal). The webhook keeps renewals/cancellations in sync.

## Part 5 — ONE sandbox test before real money

19. While `PAYPAL_ENV` is still `sandbox`: on developer.paypal.com switch the
    toggle to **Sandbox**, create a Sandbox app the same way (steps 4–5), and use
    ITS Client ID/Secret + a sandbox webhook (steps 14–18, same URL) in a Vercel
    **Preview** scope — or temporarily in Production if no real users are paying yet.
20. developer.paypal.com → **Testing Tools → Sandbox Accounts** has a fake "personal"
    buyer account (email + password shown there).
21. On the site: sign in → /pricing → click Pro → you should land on a PayPal
    SANDBOX approval page → log in with the fake buyer → approve.
22. Verify the test worked (Part 6 checks). No real money moved.

## Part 6 — Verify end-to-end (sandbox first, then again after go-live)

23. You land back on `kesefle.com/upgrade?paypal=success` and the page should
    switch to "המנוי שלך אושר ופעיל!" within a few seconds.
24. Admin → revenue card (`/api/admin/revenue`): paid count +1 and MRR includes
    the new subscription (19/39 monthly; annual counts as price÷12).
25. Bot premium check: from the linked WhatsApp number, ask the bot a data
    question (e.g. "כמה הוצאתי על אוכל?"). A premium answer (not an upgrade
    nudge) = the entitlement reached the bot. (Allow up to 10 minutes — the bot
    caches premium status.)
26. PayPal dashboard → Webhooks → **Webhook events** shows the events delivered
    with HTTP 200 responses.

## Part 7 — Go live

27. (Step 10) In Vercel set `PAYPAL_ENV` = `live`, make sure the LIVE app's
    `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` are the
    ones in Production scope, redeploy.
28. Run setup-plans once on live too (step 11) — sandbox and live keep separate
    plan IDs — and paste the live IDs (step 12), redeploy.
29. Make ONE real payment yourself (you can cancel + refund it from PayPal
    afterwards) and repeat the Part 6 checks.

## Rollback (instant off-switch)

- In Vercel, change `PAYPAL_ENV` back to `sandbox` (or delete the
  `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` variables) and redeploy.
- The upgrade buttons then show the friendly "התשלום עדיין לא פעיל" message —
  the site keeps working normally, nobody can be charged.
- Existing live subscribers: cancel/refund individual subscriptions from the
  PayPal business dashboard if needed.

## Env var names used (values live ONLY in Vercel)

| Name | What it is |
|---|---|
| `PAYPAL_CLIENT_ID` | PayPal app Client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal app Secret |
| `PAYPAL_ENV` | `sandbox` (default, fake money) or `live` |
| `PAYPAL_PLAN_PRO` | Plan ID, Pro monthly (19 ILS) |
| `PAYPAL_PLAN_PRO_YEAR` | Plan ID, Pro annual (190 ILS) |
| `PAYPAL_PLAN_FAMILY` | Plan ID, Family monthly (39 ILS) |
| `PAYPAL_PLAN_FAMILY_YEAR` | Plan ID, Family annual (390 ILS) |
| `PAYPAL_WEBHOOK_ID` | Webhook ID for signature verification |
| `PUBLIC_SITE_URL` | `https://kesefle.com` (return/cancel URLs) |
