# How to set up real-user analytics & error monitoring — step by step

**Why you might want this:** with paid Facebook/Google Ads bringing in 1,000 customers, every drop-off costs you real money. Right now I can only see what Vercel logs tell me. With PostHog (free) I can see:
- Exactly which step of signup users drop at
- Session replays — actually watch what a confused user did before bouncing
- Which ad creative brought the user who succeeded vs failed

**You can skip all of this if you want.** The launch will work without it. But for paid traffic, the ROI of adding PostHog is roughly: spend 15 minutes of your time → save €100s of wasted ad spend in week 1.

Here's how, step by step. Pick ONE to start; you can add the others later.

---

## Recommended: PostHog (free, 1 million events/month)

**What it does:** captures every page view, button click, signup attempt, and failure across kesefle.com. Lets us see funnels ("of 1,000 people who landed on /, how many clicked Sign Up, how many completed?").

### Steps:

1. Open **https://us.posthog.com/signup** (NOT the EU one — has more free quota).
2. Sign up with `info@kesefle.com`. Skip the demo project, create a new one called **"Kesefle Production"**.
3. After signup, you'll land on a "Send us your first event" page. **DON'T** install anything. Just click **Skip → "I'll do it later"**.
4. Top-right corner → click your avatar → **Settings** → **Project** → scroll to **"Project ID"** section.
5. Copy two values:
   - **Project API Key** — starts with `phc_`, ~50 characters. This is the one we need.
   - **Project ID** — short number like `12345`. (Optional.)
6. Paste BOTH to me in the next message, like this:

```
POSTHOG_API_KEY: phc_abcd1234efgh5678ijkl9012mnop3456
POSTHOG_PROJECT_ID: 12345
```

7. I'll add the PostHog snippet to every page, wire signup_started / signup_succeeded / signup_failed events, and within 1 hour you'll see real-time funnels in your PostHog dashboard.

**Total time**: 5 minutes of your work. Free tier covers 1 million events/month — that's plenty for 1,000 users.

---

## Optional: AppSignal (free trial, server-side errors)

**What it does:** when an API call crashes server-side (e.g. KV times out, Google rejects a token), AppSignal sends you a Slack/email alert with the stack trace, the user's email, and what request triggered it.

### Steps:

1. Open **https://appsignal.com**. Sign up with `info@kesefle.com`. They give a 30-day free trial, then $19/month for the basic tier.
2. After signup, create a new **App** → name it **"Kesefle Vercel"** → platform: **"Node.js"**.
3. They'll show you a `PUSH_API_KEY` — looks like `abcd1234-efgh-5678-ijkl-9012mnop3456`. Copy it.
4. Paste to me:

```
APPSIGNAL_PUSH_API_KEY: abcd1234-efgh-5678-ijkl-9012mnop3456
APPSIGNAL_APP_NAME: Kesefle Vercel
```

5. I'll add the AppSignal middleware to every `/api/*` handler. Within 10 minutes you'll get a Slack/email alert the first time something crashes server-side.

**Total time**: 5 minutes. Costs $19/mo after the 30-day trial. **Skip this for week 1**; we can rely on Vercel's built-in error pages and the fallback monitor I'm building.

---

## Optional: Leiga (free, auto-generated bug tickets)

**What it does:** every time a real error happens, Leiga auto-creates a ticket so you have a TODO list of "fix these for next sprint" instead of forgetting them. Useful only if you have time to triage bugs daily.

### Steps:

1. Open **https://www.leiga.com/signup**.
2. Sign up with `info@kesefle.com`. Create a project called **"Kesefle Bugs"**.
3. Top-right → **Settings → API → "Create new token"**. Name it **"Vercel auto-create"**. Copy the token.
4. Paste to me:

```
LEIGA_API_TOKEN: <paste>
LEIGA_PROJECT_ID: <copy from URL bar when you're in the project>
```

5. I'll wire automated ticket creation for every uncaught exception.

**Total time**: 5 minutes. Free forever. **Skip this for launch day** unless you really want auto-tickets.

---

## My recommendation for launch day

**Just give me PostHog.** That's it. The other two are nice-to-have polish.

- PostHog tells you "where users are dropping" → highest signal-to-noise.
- AppSignal duplicates what I'll build in `/admin/launch-monitor` (which I'm building now, free).
- Leiga is overkill for launch week.

---

## The fallback (if you don't give me anything)

I'm building `/admin/launch-monitor` right now. It uses the existing KV + Vercel logs to give you:
- Signups in the last hour / 24 hours
- Success vs failure rate
- Top 5 error reasons with counts
- Bot reachability (last successful write timestamp)
- KV health (% of free tier used today)
- In-app browser misses (UAs that slipped past detection)

This will be live on `https://kesefle.com/admin/launch-monitor` within 30 min. You'll be able to refresh it during the launch to see real-time health.

---

## TL;DR

If you have 5 minutes RIGHT NOW: do the **PostHog** steps above and paste me the key. The rest can wait until next week.

If you have 0 minutes: skip everything, I'll build the fallback monitor and you'll be OK.

Either way, **tell me which option you picked** so I know whether to proceed with the integration or just build the fallback.
