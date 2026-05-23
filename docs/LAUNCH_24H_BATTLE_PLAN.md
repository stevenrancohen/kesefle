# Launch — 24h battle plan (1,000 new customers tomorrow)

**Status as of 2026-05-23 PM**: P0 unblock fix shipped (commit `4a9127b`).
WhatsApp Business users can now actually complete sign-up.

---

## The honest blockers list (what could still kill us)

| # | Risk | Severity | Where it bites | Owner | ETA fix |
|---|---|---|---|---|---|
| 1 | **Bot is on Meta test number +1 555 640 8123** — 250 msg/day, 5 allow-listed recipients only. Hits the ceiling at the 6th user. | **CATASTROPHIC** | Within minutes of launch | **Steven** (Meta WABA application) | 1–3 days (Meta review) |
| 2 | **Google OAuth app not yet "Verified"** — beyond 100 users Google shows a scary "App not verified" warning that converts terribly. | **HIGH** | At user #100 | **Steven** (Google Cloud Console) | 1–4 weeks |
| 3 | **/api/sheet/provision rate-limit 5/hr per IP** — Israeli mobile carrier NAT shares IPs across thousands of users. | **HIGH** | First spike | Claude (lift limit, key by sub not IP) | 15 min |
| 4 | **Upstash KV free tier** — 10k commands/day. 1,000 signups × ~5 writes each = 5k just for signup, more for bot writes. | **MEDIUM** | Mid-day | **Steven** (Upstash paid plan, $10/mo) | 5 min |
| 5 | **Apps Script bot quota** — UrlFetchApp 20k calls/day for free Google accounts. | **MEDIUM** | At ~500 users actively messaging | **Steven** (Google Workspace plan) | external |
| 6 | **No real-user signup smoke test** — we tested code paths offline but haven't verified an end-to-end signup on a real WA Business phone. | **HIGH** | Could be hiding a fresh blocker | **Steven** (5 min test) | now |
| 7 | **Bot version `2026-05-23-bot-secret-on-lookup` not deployed** — premium users will see free-tier limits until Steven pastes ExpenseBot_DEPLOY.gs. | **MEDIUM** | UX regression for paying users | **Steven** (paste + deploy) | 2 min |
| 8 | **Admin dashboard color redesign** — being done in background; doesn't block launch but Steven asked for it. | **LOW** | Owner confidence | Claude (running in background) | ~5 min after agent returns |

---

## T-minus 24h plan

### T+0 (now, just shipped)
- ✅ Blank-screen fix (commit `4a9127b`) — WA Business detection extended, OAuth-return guarded, `credentials: 'include'` everywhere, SW v12 force-refresh.
- ⏳ Admin dashboard redesign (background agent, ~5 min).

### T+10 min — **STEVEN: real-device test**
1. Open WhatsApp Business on your phone.
2. Tap any link to `https://kesefle.com/account`.
3. Confirm you see the "פתח/י בדפדפן כדי להתחבר" help card (not a blank screen).
4. Long-press the URL → "Open in Safari" → confirm OAuth works in Safari.
5. Send `שלום` to `+1 555 640 8123` → confirm welcome message arrives.
6. Reply `42 קפה` → confirm row appears in your new sheet.
7. Tell me the result. If ANY step fails, that's the next P0.

### T+30 min — engineering hardening (Claude, while Steven tests)
- Rate-limit `/api/sheet/provision` by `userSub` instead of IP (NAT-safe). Raise limit to 50/hr per user.
- Add a per-tenant "first-message" tracking row so the bot can detect "user has account but never messaged" and auto-resend the welcome.
- Add `/api/admin/inapp-misses` so Steven can see exactly which UAs are still missing detection.

### T+1 hour — **STEVEN: external dependencies (these are NOT things I can do)**
1. **Meta WABA application** (THE critical path):
   - business.facebook.com → Business Settings → WhatsApp Accounts → "Add Phone Number"
   - Use the Numero number `+1 774 544 8053` OR get an Israeli number from a BSP (360dialog, Twilio).
   - Submit for verification with your `info@kesefle.com` email.
   - Until approved, **you cannot launch to more than 5 phone numbers per day**.
2. **Upstash plan**: console.upstash.com → upgrade to Pay-as-you-go ($0.20 per 100k commands). Card-on-file only.
3. **Google OAuth verification**: console.cloud.google.com → APIs & Services → OAuth consent screen → "Submit for verification". Provide a 30-second screencast of the OAuth flow ending at a successful sheet creation.

### T+2 hours — Claude builds while Steven completes admin tasks
- Centralize the bot phone number into `KESEFLE_CONFIG.BOT_NUMBER` (so when Meta approves the new number, the swap is 1 env var, not 45 file edits).
- Build a simple "what's broken right now" page at `/admin/health` that polls the bot, KV, Sheets API, and Google OAuth and shows green/red dots.
- Add a one-button "resend welcome" in the admin panel for any user whose first-message-after-signup never came through.

### T+6 hours — load simulation
- Run a synthetic load script that mimics 100 concurrent signups against the production endpoints (Vercel won't get angry but Upstash will).
- Measure the p95 of `/api/auth/google-exchange` + `/api/sheet/provision`. Anything over 3s is a launch risk.

### T+12 hours — monitoring & observability
- Steven mentioned PostHog, AppSignal, Leiga in his message. **I don't have those API keys**. If Steven provides them, integrate at:
  - PostHog: `posthog.capture('signup_started')` / `'signup_completed'` / `'signup_failed'` / `'bot_first_message_sent'` events in account.html + the bot.
  - AppSignal: server-side error tracking in each /api/* handler.
  - Leiga: auto-create issues from `inapp_misses` and from `admin.denied` events.
- Without those, fall back to: Vercel logs + the existing `write_log:` KV records + the `inapp_misses` list.

### T+18 hours — final pre-launch check
- Smoke test the full signup flow on 3 devices:
  - iPhone Safari (normal)
  - WhatsApp Business in-app browser → must show help card, not blank.
  - Android Chrome
- Confirm bot version is `2026-05-23-bot-secret-on-lookup` via `בדיקה`.
- Confirm at least 1 paid plan upgrade works end-to-end (PayPal or bank transfer manual).

### T+24 hours — launch
- Post the launch URL where the first 5 users can hit it (Meta test number limit).
- Watch `/admin/health` + Vercel logs in real-time.
- If WABA approval comes in, swap the number with `scripts/swap-bot-number.sh <new_number>` and push.

---

## Realistic outcome at T+24h

**If the WABA approval has not come through** (likely — Meta usually takes 1-3 days):
- Soft launch to 5 allow-listed phones for testing.
- Build the waiting list mechanic so the next 995 sign up and get queued + an SMS when the bot is ready.

**If the WABA approval IS through**:
- 1,000 users IS achievable, but expect:
  - ~50–100 to fail signup due to edge cases we haven't caught (real-user testing is the only way to find them)
  - ~5–10 to need manual support (recovered via the new `/api/auth/logout` + retry flows)
  - ~10–20 to get stuck on the bot side (we have `_resolveTenant_` recovery logging but no auto-recovery yet)

---

## Diagnostic questions for Steven (answer when you have a sec)

These determine the next 12 hours of work — please answer concisely:

1. **WABA**: Have you submitted the WhatsApp Business API application to Meta yet, or is it still pending? What number are you targeting (Numero +1 774 544 8053, or a fresh Israeli WABA number)?
2. **Upstash**: Are you OK upgrading to the paid tier ($10/mo minimum) before launch? Without it the 1,000-user spike will hit free-tier limits.
3. **Acquisition source**: Where are these 1,000 users coming from? Paid ads? Existing email list? Friends/family network? (Determines how forgiving they'll be of edge-case bugs.)
4. **Tolerance for failures**: Are you OK if 5-10% of users hit a bug their first time and need to retry? Or do we need a "perfect or delay" bar?
5. **PostHog/AppSignal/Leiga API keys**: If you want those integrated, paste the keys to me (one at a time, in chat). Without them I'll wire fallback observability.
6. **Admin panel redesign**: I have an agent finishing the redesign per your exact spec right now. Do you want me to deploy it immediately when ready, or hold for your visual review first?

---

## What I'm doing right now while you read this

- Building the per-userSub rate-limit fix for /api/sheet/provision (eliminates the NAT-IP problem).
- Centralizing the bot number to one config so the WABA swap is a 1-line change.
- Reviewing the admin agent's output when it returns and verifying it didn't break any IDs.
- Wiring `/api/log/missed-inapp` into the admin panel so you can see UA misses in real-time.

I'll post short status updates as each lands. **You focus on the WABA application and Upstash upgrade — those are the only true blockers I can't help with.**
