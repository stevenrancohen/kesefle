# Kesefle growth backlog — 55 tasks (fleet-synthesized 2026-06-27)

> 8-lens growth-analysis fleet (activation, CRO, onboarding, pricing, retention, multilingual distribution, Israeli acquisition, PWA). Each task names a real drop-off/lever. `OWNER` = needs Steven (payments / identity / real reviews); everything else is buildable autonomously.

## Executive summary
The funnel leaks hardest at three confirmed, buildable points BEFORE any payment/trust lever matters. (1) ACTIVATION PLUMBING still has live bugs: /welcome's link-poll freezes silently on a single 429, every wa.me link hardcodes the bot number (972547760643 in welcome/index/dashboard) instead of fetching /api/config, desktop/no-WhatsApp users dead-end, and bot Q0/Q2 surveys trap or silently swallow input. (2) FIRST->SECOND EXPENSE has no instant ack and no day-2 nudge — the projection nudge template is even unset in env, so quiet users get zero pull. (3) The multilingual funnel is a facade: /ar /ru /fr /it pages send users into a Hebrew-only OAuth + dashboard + bot, and UTM is dropped at the OAuth boundary so Steven has zero attribution to justify any spend. Fix the plumbing and instrumentation first (mostly autonomous), wire WhatsApp-channel retention loops second, and gate only the genuinely owner-bound levers (Israeli card/Bit rail visibility, founder identity, real reviews, the personal-invite send) to Steven. Note: the trial-length contradiction flagged in pricing is already fixed (index + pricing both say 14 days), so that is de-prioritized.

## P0 (15)

- **Catch 429 in /welcome link poll with exponential backoff + 'still waiting, retrying' state** `activation/S`
  - _Why:_ welcome.html lines 319-330 poll GET /api/whatsapp/link every 4s; a single 429 freezes the spinner with no error, user assumes code never sent and abandons at the highest-intent moment
- **Fetch BOT_NUMBER from /api/config on page load and rewrite every wa.me link dynamically** `activation/S`
  - _Why:_ welcome.html:233, index.html:77/1576, dashboard.html:4894 hardcode 972547760643 instead of using the existing /api/config BOT_NUMBER; any number change silently sends first-expense traffic to a dead chat
- **Add desktop/no-WhatsApp fallback on /welcome: detect non-mobile UA, show copy-code + manual-paste instructions** `activation/S`
  - _Why:_ welcome.html:205 wa.me deeplink lands desktop users on a blank error; report estimates this alone recovers 5-10% of attempts
- **Add 'דלג' (skip) path + 5-message auto-skip to bot survey Q0 gender gate** `onboarding/M`
  - _Why:_ ExpenseBot Q0 (lines 5193-5256) loops forever on 'עדיף לא לומר'/unrecognized answers; only binary gendered words advance, trapping ~15% of new users before their first expense
- **Tighten the Q0 gender-swallow regex to word-boundary + gender-only-message** `activation/S`
  - _Why:_ The /(?:^|\s)בן(?:\s|$)/ failsafe swallows real expenses containing בן (e.g. '50 בן הגן'); make it \b(בן|בת)\b and require the message be only gender words, with a P0 regression test
- **Validate family-tracker kids-naming step: reject pure-numeric input, confirm 'created X rows'** `onboarding/M`
  - _Why:_ Bot lines 6119-6131/6259-6280: typing '3' instead of names calls _addCategoryRows_('3'), silently fails in try-catch, user sees 'בסדר ממשיכים' and never gets their dashboard rows
- **Send an instant '✓ ₪12 רשום' WhatsApp ack on parse, before the Sheet write completes** `retention/M`
  - _Why:_ Sheet write is async (5-30s); users send an expense, see no feedback, close WhatsApp, and never learn it worked — the single biggest habit-confidence killer in the core loop
- **Add a day-1 re-engagement WhatsApp nudge for users where expensesCount==1 and signup was 1 day ago** `retention/M`
  - _Why:_ lifecycle.js fires day_1 email but there's no warm WhatsApp pull on the fragile day-2 habit gap; 40%+ of day-1 users never send a second expense
- **Set KESEFLE_PROJECTION_TEMPLATE in Vercel env and verify the 24th-of-month nudge fires** `retention/S`
  - _Why:_ projection-nudge.js is inert because the template env var is unset — the ONLY proactive pull for quiet week-1+ users currently never sends
- **Simplify first-expense celebration to 3 examples + 'עזרה', hide advanced features** `onboarding/S`
  - _Why:_ Bot lines 1671-1692 dump 5 examples + currencies/receipts/notes/summaries; a user who sent '150 סופר' is overwhelmed and doesn't send a second
- **Preserve utm_* through the Google OAuth redirect (append window.location.search to redirectUri)** `analytics/S`
  - _Why:_ Multilingual report: ?utm_source=tiktok_ar is dropped at the PKCE boundary, so no non-Hebrew (or any) campaign can ever be tied to a signup — blocks all acquisition ROI measurement
- **Store signupSource {utm_*, referer, langAtSignup, signupAt} on the user:{sub} KV record at google-exchange** `analytics/M`
  - _Why:_ Steven has zero visibility into which channel/language drives paying users; capture at signup and expose in /api/admin/analytics
- **Run /api/admin/activation-summary daily via cron and alert founder if healthy activation drops below 35% or verdict flips** `analytics/M`
  - _Why:_ activation-summary.js is built+tested but never invoked; without a daily gate, a regression to PLUMBING/VALUE_PROBLEM goes unnoticed for weeks
- **Make 'Bit / בנק' a visible payment button on every pricing tier card and on /account upgrade** `monetization/S/OWNER`
  - _Why:_ api/billing/manual.js Bit/bank flow exists but is invisible; tier cards show PayPal only, so Israelis assume PayPal-only (3.4% fee) and abandon — Bit is the dominant IL consumer rail
- **Steven sends 15-20 personal WhatsApp invites (script 1a) + day-7 referral follow-up (script 1b)** `acquisition/S/OWNER`
  - _Why:_ acquisition-playbook Channel 1 (highest-conversion, zero code) was never executed; the referral loop is dormant because no warm invites have ever been sent

## P1 (21)

- **Add contextual in-bot upgrade prompt when a free user uploads a receipt or sends a voice note** `monetization/M`
  - _Why:_ Upgrade is hidden until the day-14 email; surface 'Pro: OCR/voice instant' at the exact moment of desire (Splitwise pattern) to convert intent->action
- **Add renewal-reminder cron for paid + !recurring (Bit/bank) subs 3 days before accessUntil** `monetization/M`
  - _Why:_ PayPal renews via webhook but manual Bit/bank subs (recurring=false in billing.js) lapse silently with no reminder; lapsed users forget and never re-subscribe
- **Build manual-payment verification loop: emailed code, user texts 'VERIFY 12345', bot confirms in KV + sends activation** `monetization/M`
  - _Why:_ Bit transfers have no confirmation; users see nothing, assume payment was ignored, double-pay via PayPal, then angrily cancel both
- **Append second WhatsApp message after Sheet write: '📊 סה"כ החודש: ₪240' to show running progress** `retention/S`
  - _Why:_ Closing the loop with a month-to-date total keeps the thread warm and gives the day-2..7 reason to return (payoff made tangible in-channel)
- **Localize morning-nudge + lifecycle messages via i18n/nudge-messages.json with he/ar/ru/fr variants** `multilingual/M`
  - _Why:_ morning-nudge.js sends a hardcoded Hebrew SHORT_TIPS array; Arabic/Russian/French cohorts get Hebrew text = instant churn
- **Language-aware post-OAuth routing: carry lang from /ar /ru into /account and dashboard UI** `multilingual/L`
  - _Why:_ Users signing up via /ar or /ru land in a Hebrew-only account+dashboard; estimated 40% bounce from non-Hebrew readers forced to switch mid-flow
- **Make the bot reply in the user's signup language (Arabic/Russian/French), not just Hebrew/English** `multilingual/L`
  - _Why:_ User signs up in Arabic, bot confirms in Hebrew — cognitive dissonance reads as 'broken'; align confirmations to stored language preference
- **Add a 2-line value recap above the OAuth buttons on /account ('Your private Sheet + WhatsApp bot, no bank access')** `conversion/S`
  - _Why:_ Users land on a blank Google/Facebook/Apple button page after 'בוא נתחיל' with no why-now context; large early-funnel leak
- **Add a 'try the bot, 0 signup' wa.me card above the fold on the homepage hero** `conversion/S`
  - _Why:_ Homepage forces OAuth->phone->code (3 screens) before any bot interaction; a direct wa.me lo-commitment path lets testers feel the core loop with zero gates
- **Replace the 'waitlist' email form in the signup section with a 'send a test message' wa.me deep-link** `conversion/S`
  - _Why:_ Kesefle has product-PMF risk not demand-scarcity; a waitlist signals the wrong thing — the CTA should be 'prove it works' not 'join the line'
- **Reframe Pro positioning from features (Gemini/OCR jargon) to time saved + concrete scenarios** `conversion/M`
  - _Why:_ Pricing copy 'סיווג AI (Gemini)' means nothing to an Israeli parent; reframe to 'תצלום קבלה -> קטגוריה בשנייה' and outcome language to lift upgrade comprehension
- **Add a 3-step progress spinner + 30s timeout + retry to account.html sheet-provisioning (Step 2)** `onboarding/M`
  - _Why:_ launch-monitor funnel shows 34% drop at sheet provisioning; 8-12s creation on slow networks reads as a hang with no progress, no ETA, no retry button
- **Add a manual code text-input fallback + explicit 'code expired at HH:MM' state to phone linking** `onboarding/M`
  - _Why:_ Android in-app browsers block wa.me:// links and stale codes show no expiry message until manual refresh; users sit on a dead 'waiting' screen
- **Move bot survey state from CacheService (8h TTL) to KV keyed by phone+session, 15min TTL, resume-aware** `onboarding/M`
  - _Why:_ Cache eviction mid-survey resets users to Q0; Android/3G users re-answer all 4 questions or quit (~20-30% per onboarding report)
- **Add a default rotating-tips set to customer-weekly-digest so Sunday sends content even when Steven sets no message** `retention/S`
  - _Why:_ If the KV custom message is empty the Sunday cron sends nothing; week-1 users expect regular content and silence reads as abandonment
- **Re-surface the app onboarding/quickstart card after 7 quiet days, not only when month_count==0** `retention/S`
  - _Why:_ app.html onboarding card only shows at month_count==0; a user who logs once then goes quiet never sees a re-prompt and silently churns
- **Don't silently downgrade at trial end — email day-14 with a 30-day history PDF + 'upgrade to keep'** `retention/M`
  - _Why:_ Auto-downgrade makes history vanish (free = current month only); user thinks 'I lost my data' and quits — make the loss tangible to drive the upgrade
- **Add an in-app 'received ✓' toast + animate the new row in when a WhatsApp expense lands while app is open** `app/M`
  - _Why:_ App has no indicator an expense was received until manual refresh; users refresh 5+ times, perceive the app as unreliable, and stop
- **Add a 'how did you hear about us' source tag to bot onboarding (friend/FB group/accountant/forum/university)** `acquisition/S`
  - _Why:_ No channel attribution exists in-product; a 1-question source tag stored in profile:{phone} lets the admin cohort card show activation % by channel and kill guesswork
- **Add 2-3 real founder/archetype testimonials (freelancer, parent, small-business) below the hero** `trust/M/OWNER`
  - _Why:_ Homepage and pricing have zero social proof; Israeli competitors (Riseup, Salt) have review presence — real named quotes counter the 'yet another tracking app' default
- **Publish founder identity + business/tax id + privacy/terms trust block on the site** `trust/S/OWNER`
  - _Why:_ Funnel asks for Google OAuth and money with no visible human/company behind it; an Israeli founder identity + tax id is a known conversion lever for paid signups

## P2 (19)

- **Localize linking-error + code-expired bot messages for AR/RU/FR speakers** `multilingual/M`
  - _Why:_ After QR scan, a wrong/expired code returns a curt Hebrew/English-only error; ~10-15% of non-Hebrew speakers lost at this recovery point
- **Add localized currency framing (19₪ / 19 شيكل / 19 шекелей) on /ar/pricing and /ru/pricing** `multilingual/S`
  - _Why:_ Non-Hebrew pricing pages show Hebrew payment copy ('PayPal קריפטו ביט'); currency/method mismatch kills intent at billing for diaspora users
- **Localize the 5 onboarding email templates into welcome_ar.html / welcome_ru.html (RTL block for Arabic)** `multilingual/M`
  - _Why:_ All 5 lifecycle email templates are Hebrew-only; AR/RU signups get Hebrew welcome emails and disengage
- **Make the Free tier copy a positive product, not a crippled demo ('מדויק ל-90% מהמשתמשים')** `conversion/S`
  - _Why:_ Free is the homepage default but no copy explains why it's a real product; users perceive 'free is bait' and never trust the upgrade
- **Loosen Q2 recurring-expenses parser: accept abbreviations, description-first order, and partial-success feedback** `onboarding/M`
  - _Why:_ _parseRecurringCommand_ is strict (~30% success); '2500 שכירות' or trailing whitespace fails silently and users skip a high-value retention feature
- **Skip web-completed survey steps on first bot message via an onboarded_web:{sub} KV flag** `onboarding/M`
  - _Why:_ Users who did OAuth+profile on web then get re-asked Q0-Q1 by the bot (split-brain: api/profile.js vs Script Properties); unify to KV and skip duplicates
- **Build a parallel payment-failed dunning sequence for Bit/manual subs (PayPal already has one)** `monetization/M`
  - _Why:_ PayPal payment_failed fires dunning emails day 3/7 but Bit transfers have no dunning record at all; lapsed manual subs get zero recovery touch
- **60-day re-engagement email to opted-out users offering a low-frequency 'one tip a week' digest** `retention/S`
  - _Why:_ optout:{phone} is permanent; a single 60-day win-back ('weekly digest, no hard sells') reactivates 15-30% on comparable products
- **Add a 'last synced Xs ago' timestamp + refresh-button spinner so async sheet writes feel live** `app/S`
  - _Why:_ getExpenses+summary cold latency (2-5s) shows month_expenses:0 then jumps; users think data reset — show sync state and only stamp time after fresh data
- **Precompile critical Tailwind classes into an inline <style> in app.html to kill cold-start layout thrash** `app/M`
  - _Why:_ app.html loads Tailwind from CDN (3-4s on 3G common outside Tel Aviv); JIT arrival thrashes layout and users bounce thinking the page is broken
- **Add a one-tap 'Download my expenses as CSV' export in the app Account tab** `app/S`
  - _Why:_ Users fear losing data on uninstall; a backend getExpenses->CSV export reduces uninstall fear and creates a win-back checkpoint
- **Add a self-serve '+ הוסף קטגוריה' modal in Insights writing to custom_categories:{sub}** `retention/M`
  - _Why:_ Custom categories currently require bot-secret auth (Steven only); advanced users want ROAS/VAT/freelance buckets — self-serve feels like product growth and deepens lock-in
- **Build a referral-tracking admin card (referrer -> referred -> referred_linked breakdown)** `acquisition/M`
  - _Why:_ /referral works but Steven can't see which of his invites converted; visibility lets him thank advocates and decide whether to make referral the default ask
- **Surface the referral 'month free for both' card on /pricing and /about (currently logged-in only)** `acquisition/S`
  - _Why:_ The referral program is invisible to non-users; a copy-paste link on public pages drives word-of-mouth at zero CAC
- **Fix lifecycle day-1 email timing to fire same calendar day in Israel timezone** `retention/S`
  - _Why:_ day_1 triggers on days===1 (exact 24h); 11pm signups get the email only 11h later and the cadence skews 13-18h per user, weakening the warm-up
- **Build an at-risk re-engagement gate (lastActive>4d AND expensesCount>1) sending once per 30d** `retention/M`
  - _Why:_ Inactivity email fires only in an exact 7-8 day window and misses users by hours; a daysInactiveFloor metric catches at-risk engaged users reliably
- **Add a 'Last 30 days' rolling view to the app home/insights alongside calendar-month** `app/S`
  - _Why:_ App shows only this-month; on day 1 of a new month users see zero (reset psychology) and feel the app lost their data
- **Expose existing budgets/goals in the app home with a progress bar + 90%-reached nudge** `retention/M`
  - _Why:_ api/budgets.js and api/goals exist but are invisible in the app; a 'Food ₪650/₪800 (81%)' card plus a 90% alert turns Pro features into a daily reason to open
- **Add recent-category quick-tap chips to the app transactions search (תזונה/תחבורה/דלק)** `app/S`
  - _Why:_ Power users with 100+ rows can't narrow by date/category and give up finding a receipt; RTL users tap faster than they type, so chips beat free-text search

