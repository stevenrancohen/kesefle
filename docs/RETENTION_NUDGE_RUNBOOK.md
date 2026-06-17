# Retention nudge — runbook

**Goal (the council's #1):** test whether a proactive WhatsApp nudge brings quiet users back, using the channel Israelis already live in. We send each user their **end-of-month spending projection** ("at your pace you'll finish the month around ₪X — want to see where it's going?") with a button to the app.

This is the cheapest possible test of the real hypothesis: *is Kesefle's problem retention, or just a quiet-channel problem?* If a nudge moves nothing, no App Store listing ever would.

---

## The latent bug this surfaced (important)

`/api/whatsapp/send` only ever sent **freeform text**. Meta delivers a freeform business message **only inside the 24-hour window after the user's last message**. So every existing proactive cron — `budget-check`, `reminders`, `lifecycle`, `morning-nudge` — **silently fails to reach any user who's been quiet >24h** (Meta drops it; we log a soft warning). For a *re-engagement* nudge, whose whole point is reaching quiet users, freeform is useless. **Re-engagement requires an approved Meta template.** That's what we built.

---

## What's already shipped (code, live, but INERT)

- `api/whatsapp/send.js` now also accepts `{ template: { name, language, params } }` and sends a real WhatsApp **template** (backward-compatible — existing `{ text }` callers unchanged).
- `api/cron/projection-nudge.js` — monthly cron (24th, 10:00 IL). For each linked user it reads their sheet, computes the end-of-month **expense** projection (income excluded), and sends the template. Dedups one nudge per user per month. Excludes negligible spend and early-month noise.
- **It is INERT until you create the template** (below): with the env var unset it scans nothing and sends nothing (`{ ok:true, inert:true }`). Safe to have live.

So the only things left are **yours** — they need Meta + Vercel access I don't have.

---

## YOUR STEPS

### 1. Create the WhatsApp template in Meta
Go to **business.facebook.com → WhatsApp Manager → Message templates → Create template**.

- **Name:** `projection_nudge`  (lowercase + underscores — Meta requires this exact format)
- **Category:** **Utility**  *(it's an update about the user's own account activity. If Meta forces it to "Marketing", accept it — still works, slightly higher per-message cost.)*
- **Language:** **Hebrew**
- **Body:**
  ```
  היי 👋 לפי הקצב שלך החודש, אתה צפוי לסיים את החודש עם הוצאות של כ-{{1}}. רוצה לראות לאן הכסף הולך ולתכנן את שאר החודש?
  ```
- **Body sample for {{1}}:** `₪3,200`
- **Button → type "Visit website":** button text `פתיחת כספ'לה`, URL `https://kesefle.com/app`
- Submit. Approval is usually minutes, sometimes up to 24h.

### 2. Turn it on in Vercel
In the Vercel project → **Settings → Environment Variables** (Production), add **two** vars:

- **`KESEFLE_PROJECTION_TEMPLATE`** = `projection_nudge`  (the approved template name)
- **`CRON_SECRET`** = a long random string (e.g. run `openssl rand -hex 32` and paste the output)

Then **redeploy**.

> ⚠️ **Why CRON_SECRET matters — and a thing to check.** Production currently reports `cron_secret_not_configured`. Every scheduled job (this nudge **and** `budget-check`, `reminders`, `recurring`, the daily digests) authenticates with `CRON_SECRET`; with it unset, Vercel's scheduled calls are rejected — which strongly suggests **none of your crons have been running**. Setting `CRON_SECRET` once fixes the whole batch. Worth a look at Vercel → your project → **Cron Jobs** to see each job's last run/status and confirm.

After both vars are set + a redeploy, the nudge fires on the **24th** and reaches everyone with real spending this month.

### 3. (Optional) Run the test on demand instead of waiting for the 24th
Tell me "run the nudge" and I'll trigger it for you, or from a terminal:
```
curl -s -H "Authorization: Bearer <CRON_SECRET>" https://kesefle.com/api/cron/projection-nudge
```
Before the template is approved it returns `{"ok":true,"inert":true}`. After, it returns `{"ok":true,"sent":N,...}`.

---

## How we measure it

Each nudge writes a KV key `projection_nudged:{user}:{YYYY-MM}` with the projected amount and timestamp. After a send, we watch — over the next 3–5 days — whether nudged users **re-open /app or message the bot**. If a meaningful share come back, retention is reachable and we double down (weekly digests, smarter nudges). If nobody moves, the problem is the product's value, not the channel — and we stop building and go talk to users. I can build a small admin readout that joins the nudge keys against subsequent activity once the first batch has fired.

---

## Guardrails baked in
- Inert until the template env is set (no accidental sends).
- One nudge per user per month (dedup, 35-day TTL).
- Skips users with <₪50 spend or before day 8 (no meaningless projections).
- Income excluded from the projection (col-H aware) — a wrong number in a money message is a trust breach.
- Per-recipient 100/hour rate limit (in `/api/whatsapp/send`).
- Contract-tested: `tests/test_projection_nudge.js` locks the inert-gate, template send, and income-exclusion so they can't silently regress.
