# Kesefle — Project Status & Architecture for External Review

**Date:** 2026-05-18
**Owner:** Steven Ran Cohen (srcslcollection@gmail.com)
**Repo:** https://github.com/stevenrancohen/kesefle
**Live:** https://kesefle.vercel.app
**Reviewer:** This document is written to be read cold by DeepSeek for an outside review and next-step recommendations.

---

## 1. What Kesefle Is

Kesefle (כספ'לה — Hebrew diminutive for "money") is a Hebrew-first, WhatsApp-native personal expense tracker. The product is built around a single insight: in Israel, every adult uses WhatsApp daily. Asking them to install another app, learn another UI, or open another tab is friction they will not absorb. So Kesefle has no app.

**The user experience:**
1. User signs up on the website with Google OAuth.
2. Kesefle copies a Google Sheet template into the user's own Drive (user owns their data forever).
3. User adds Kesefle's WhatsApp number as a contact.
4. User sends `245 סופר` ("245 [shekels at the] supermarket") in WhatsApp.
5. Within 2 seconds: the expense is parsed, categorized (food / supermarket), written to the user's Google Sheet, and the bot replies with a Hebrew confirmation + cumulative monthly insight.

There is no app, no dashboard the user has to visit. The Google Sheet IS the dashboard. Users already know how to use Sheets. The WhatsApp interface is conversational and bilingual (Hebrew primary, English supported).

**Target market:** Hebrew-speaking users in Israel. ~9M people, ~5M digitally active. Direct competitors (Toshen, Riseup) are either expensive (₪40-80/month), bank-integrated (Open Banking friction in Israel), or English-first.

**Vision (per memory):** Steven is aiming at a $100B business — i.e. not a niche tool but a category-defining product. The thesis is that ambient chat-first personal finance, owned by the user, can be that category.

---

## 2. Architecture — Components

The system has 4 main components:

### 2.1 Web frontend — Vercel static site

Hosted at `https://kesefle.vercel.app`. Pages (all in `/`):

- `index.html` — landing page (Hebrew RTL, ~2,350 lines)
- `account.html` — signed-in user dashboard
- `dashboard.html` — main app dashboard (post-signup)
- `admin.html` — Kesefle internal admin panel (password-gated)
- `pricing.html`, `help.html`, `about.html`, `automations.html`, `blog.html`, `changelog.html`, `demo.html`, `docs.html`, `en.html` (English mirror), `family.html` (couples/family sharing)
- `seo.html` — Wix-style GEO panel (one-page SEO summary)
- `/admin/diagnostics.html` — self-service health page (password gate `kesefle2026`)

**Stack:** Plain HTML + Tailwind via CDN (no build step). Google Fonts (Heebo for Hebrew, Inter for English numerals). Hebrew is RTL by default; English mirror at `/en.html`.

**Recent UI polish (this week):**
- Removed "childish" green LED visual clutter (animate-ping, blinking dots) → muted static dots
- Replaced "LIVE METRICS" stat band + Israeli vendor marquee → cleaner hero
- Refined Security FAQ pill phrasings to professional monochrome (TLS 1.3, PCI-DSS, etc.)
- Added cinematic page-load curtain (₪ logo fades, then staggered hero stages reveal)
- Magnetic CTA buttons on desktop (subtle 8% transform toward cursor)
- Parallax hero blobs on scroll (CSS variable so they coexist with `animate-blob` idle drift)
- Inter font added, tabular numerals, kerning/ligatures enabled
- Scroll-triggered fade-ins via IntersectionObserver
- Hover lift on feature/pricing cards

### 2.2 Vercel serverless functions — `/api/*`

The Vercel backend is the auth + routing layer. Each function is a Node serverless handler.

```
/api/
├── account.js          - GET/PUT user account info
├── admin.js            - internal admin operations
├── events.js           - usage/analytics event sink
├── health.js           - readiness probe
├── referral.js         - referral code system
├── auth/               - Google OAuth callback handlers
├── billing/            - Stripe webhook + checkout (not yet active)
├── sheet/
│   └── provision.js    - copies template Sheet into user's Drive on signup
└── whatsapp/           - WhatsApp identity verification + routing
```

**Vercel function limit:** Hobby plan = 12 functions. Project was hitting that limit. Steven upgraded to Vercel Pro on 2026-05-17. Long-term we should consolidate functions (multiple HTTP methods per file), but Pro tier covers us for now.

**Storage:** Vercel KV (Upstash Redis) for phone-number → user-id multi-tenant routing. The bot needs to know "this WhatsApp message came from +972-XXX, which Kesefle account does that map to?" — Vercel KV holds that mapping.

### 2.3 WhatsApp bot — Google Apps Script

**File:** `bot/ExpenseBot_FIXED.gs` (~3,900 lines)

This is where the actual conversation happens. Hosted on Google Apps Script (not Vercel) because Apps Script has direct, native access to Google Sheets API — no auth juggling. The trade-off is that Apps Script timeouts at 6 minutes per execution and has a less-flexible deployment story than a real server.

**Webhook flow:**
1. Meta WhatsApp Cloud API receives an incoming message.
2. Meta calls our Apps Script webhook URL (`doPost` handler).
3. The bot parses the message (Hebrew NLP-lite via 18,725-keyword `CATEGORY_MAP` lookup, fallback to Claude API for ambiguous cases).
4. Bot writes the expense to the user's Google Sheet.
5. Bot replies via Meta Graph API v21.0 with confirmation + insight.

**Bot phone:** Numero US eSIM, +1-774-544-8053. Meta Phone Number ID `1090404180828069`. We switched to a US number because Israeli Bezeq numbers had verification friction with Meta.

**Categorization engine:**
- `CATEGORY_MAP` — 18,725 keywords across 205 entries (12.7x expansion from the original 1,480). This is a giant Hebrew dictionary mapping store names, item types, vendor slang, etc. → (category, sub-category).
- For ambiguous input: WhatsApp interactive list message ("did you mean...?")
- Last-resort fallback: Claude API call (uses `ANTHROPIC_API_KEY` Script Property)

**Features in the bot (commands users can send):**
- `245 סופר` → log expense
- `סיכום` → monthly summary
- `סטטוס` / `status` / `ping` → bot health check
- `מטרות` / `goals` → see savings goals
- `מטרה: X שח לחודש לחיסכון` → add goal
- `מחק מטרה X` → delete goal
- `מנויים` → detected recurring subscriptions
- `חריגות` → spending anomalies (vs personal baseline)
- Plus weekly digest, daily motivation, inactivity reactivation crons

**Master diagnostic:** `installKesefleBot()` — runs once after pasting code, verifies all Script Properties + Triggers, prints a ✅/⚠️/❌ report.

### 2.4 User's Google Sheet — the "database"

Each user has their own copy of the Kesefle template Sheet. The template has:
- A main dashboard tab (Hebrew labels, monthly cohort matrix)
- Per-year tabs with A-L column expense logs
- Embedded charts and financial summary
- Goal tracking, subscription detector, anomaly tabs

**Master template Sheet ID:** `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`

The architectural decision to give every user their own Sheet (rather than centralized DB) is core to Kesefle's positioning: **the user owns their data**. Even if Kesefle goes bankrupt tomorrow, users still have their full expense history in Drive. This is the privacy + trust pitch.

---

## 3. Authentication & Permissions

### Google OAuth scopes requested
- `openid email profile` — basic sign-in
- `https://www.googleapis.com/auth/spreadsheets` — read/write the user's Kesefle Sheet
- `https://www.googleapis.com/auth/drive.file` — create new Sheet in user's Drive
- `https://www.googleapis.com/auth/drive.readonly` — **sensitive scope** — needed to read the template Sheet ID before copying it

`drive.readonly` is the scope that requires Google's OAuth verification process. Until verified, the app is limited to 100 test users.

### OAuth verification status
**Not yet submitted.** Documentation prepared in `docs/oauth-verification/`:
- `README.md` — overview
- `scope-justifications.md` — exact wording for each scope
- `demo-video-storyboard.md` — 90-second screencast plan
- `privacy-summary.md` — what data we collect/don't collect
- `denial-recovery.md` — fallback paths if Google rejects (Service Account architecture as Option B)

**Expected timeline once submitted:** 2-4 weeks. Brand verification step requires us to own the domain — currently using `kesefle.vercel.app` (vercel.app is owned by Vercel, not us). Realistic path: buy `kesefle.com` ($12/yr) for clean DNS-based brand verification.

### WhatsApp identity verification
A user has to prove ownership of the WhatsApp number they sign up with. Current flow:
1. User enters their phone in `account.html`.
2. Vercel generates a 6-digit code, stores in KV with 10-min TTL.
3. User opens WhatsApp on their phone, sends "code 123456" to the Kesefle bot.
4. Bot validates the code via Vercel KV, links phone → user-id.

This is multi-tenant ready (commit `3c16fba`).

---

## 4. Current Status — What's Shipped

### Web — production
- Homepage live, RTL Hebrew, premium polish complete
- `/account`, `/dashboard`, `/admin`, `/help`, `/pricing`, `/blog`, etc. all live
- Self-service `/admin/diagnostics` health page
- Family sharing landing page `/family`
- SEO meta tags, sitemap, `humans.txt`, OG image
- PWA manifest + icons

### Bot — code complete, deployment-pending
- 3,900-line `ExpenseBot_FIXED.gs` ready in repo
- 18,725-keyword categorization
- Goal tracking, subscription detection, anomaly detection
- Weekly digest + daily motivation + inactivity reactivation crons
- Status / ping / health commands
- **Blocker:** Steven needs to paste the code into Apps Script editor and click Deploy → New Version. Just saving doesn't deploy. Doc at `docs/BOT_NOT_REPLYING_DEBUG.md` walks through this.

### Vercel — pipeline healthy
- Pro tier active (12-function limit lifted)
- Most recent deploys succeeding
- Domain still `kesefle.vercel.app` (no custom domain yet)

### OAuth — pre-submission
- Docs ready
- Live app still in "Testing" status — only 100 test users allowed
- Real public launch requires verification

---

## 5. What's NOT Done — Open Items

### Critical path to public launch (P0)
1. **Bot deployment** — Steven must paste code + Deploy → New Version in Apps Script. Cannot be done remotely; only Steven has access to that Google account.
2. **OAuth verification** — submit to Google. Will take 2-4 weeks.
3. **Custom domain** — buy `kesefle.com`, point at Vercel. Required for clean brand verification.
4. **Stripe** — `/api/billing/*` scaffolded but checkout flow not wired end-to-end.

### Bot improvements (P1)
- Sheet template needs to be marked "publicly viewable" so the `drive.readonly` copy works
- Receipt OCR (we have `RECEIPT_PARSING.gs` skeleton — needs Claude Vision API integration)
- Per-user timezone handling (currently assumes Israel time)

### Web (P1)
- Apply premium polish to non-homepage pages (pricing, trust, help still have old visual style)
- English version `/en.html` exists but is stale — needs parity update
- Blog has placeholder posts

### Internal (P2)
- Consolidate Vercel API functions to <12 to allow downgrade back to Hobby if Pro overkill
- Dedupe bot helper files (many one-off `.gs` files in `/bot/` that were used during development but are now folded into `ExpenseBot_FIXED.gs`)
- Address `admin.html.bak.20260517-222542` (backup file should be in `.gitignore` and removed from repo)

---

## 6. Tech Choices Worth Calling Out

**Why no app?** WhatsApp is the universal Israeli interface. Building an app would 10x the cost and 10x the friction.

**Why Apps Script for the bot?** Free, no infra to manage, native Sheets access. The 6-min execution limit is fine for per-message handling. The deployment-versioning UX is the worst part — every code change requires a manual "Deploy → New Version" click in the editor.

**Why per-user Sheets instead of a real DB?** Trust + portability. Users own their data. If we shut down, they keep their Sheet. This is the differentiator vs every other expense tracker.

**Why Vercel KV instead of Postgres?** KV is sufficient for the only stateful thing we need: phone → user lookup. Adding Postgres would be premature.

**Why Tailwind via CDN instead of build step?** Speed of iteration. Steven is non-technical and ships via chat-driven Claude sessions. A build step adds friction.

**Why no React/Next?** Static HTML loads faster. Every page is content-first. Interactivity is minimal (signup form, contact form, scroll animations). React would add ~150KB to the bundle for no user benefit.

---

## 7. Codebase Map

```
/Users/stevenrancohen/Documents/Claude/Projects/kesefle/
├── index.html                  - homepage (RTL Hebrew, ~2,350 lines)
├── account.html, dashboard.html, admin.html, pricing.html ...
├── api/                        - Vercel serverless functions
│   ├── account.js, admin.js, events.js, health.js, referral.js
│   ├── auth/                   - Google OAuth callbacks
│   ├── billing/                - Stripe (incomplete)
│   ├── sheet/provision.js      - template copy on signup
│   └── whatsapp/               - phone verification
├── bot/
│   ├── ExpenseBot_FIXED.gs     - THE bot (3,900 lines)
│   ├── (~25 helper .gs files)  - older or one-off scripts, some still referenced
│   ├── README.md               - bot setup guide
│   └── WHEN_YOU_ARE_BACK.md    - resumption notes
├── docs/
│   ├── BOT_NOT_REPLYING_DEBUG.md   - 7-step bot debug
│   ├── PRODUCTION_ROADMAP.md       - high-level plan
│   ├── architecture/, compliance/, design/, security/
│   ├── family-sharing.md           - couples feature spec
│   └── oauth-verification/         - 5 files for Google submission
├── admin/
│   └── diagnostics.html        - self-service health page
├── assets/                     - images, fonts (mostly empty)
├── blog/                       - blog post markdown
└── .vercel/, .git/, etc.
```

**Files I'd flag as cleanup candidates:**
- `admin.html.bak.20260517-222542` — backup checked into repo, should be removed
- `bot/ExpenseBot_FIXED.gs.bak.before_keyword_merge` — same
- Many `*_README.md` files in `bot/` that documented one-off changes — some can be folded into `bot/README.md`

---

## 8. Recent Commit History

```
0479b12  Stages 5-7: premium polish — lift hover, cinematic reveal, parallax blobs
7087957  Stages 2-4: calm visuals + premium typography + scroll-triggered motion
cf61fc7  Stage 1: strip noise — premium cleanup of homepage
2844234  Bot goal tracking + family sharing + Hebrew copy polish — final agent batch
4324afe  Bot: subscription detector + /admin/diagnostics self-service health page
1a7412b  Bot: anomaly detector + installKesefleBot + status/ping + debug guide
6335864  World-class polish round 2 — 5 parallel agents shipped together
c0e99fd  Add email sequence strategy doc
295aee7  Final: 18,725 keywords (12.7x) + 5 onboarding emails + bot autonomy
2ef812d  CATEGORY_MAP: 1,480 → 14,834 keywords (10x expansion)
ce196c7  Add interactive ROI calculator section to homepage
4be890d  Bot ambiguity dropdown + smart insights + LLM prompt 4x richer
8911393  Homepage overhaul + site cleanup per user feedback
3c16fba  Multi-tenant phone linking — full end-to-end flow
b2f5162  Swap bot phone: 972547760643 → 17745448053 (Numero US, multi-tenant ready)
```

---

## 9. What I'm Asking DeepSeek to Evaluate

The owner (Steven) wants you (DeepSeek) to look at this project critically and give me (Claude, the assistant) instructions on what to focus on next. Specific questions:

1. **Is the architecture sound?** Per-user Google Sheets + Apps Script bot + Vercel front-end + Vercel KV for phone routing. Anything broken about that as the foundation for a $100M+ product, not just a side project?

2. **What is the single biggest risk to public launch?** OAuth verification? Bot reliability? Vercel function limits? Hebrew language model quality? Something else?

3. **Is the homepage doing its job?** The visual style was just polished from "childish neon" to "premium cinematic." Does it match the positioning of a serious financial tool that Hebrew-speaking adults will trust with their money data?

4. **What features are missing for product-market fit in Israel?** Bank import (we deliberately skip — Open Banking is friction)? Bill-splitting? Couple/family sharing (we just shipped `/family`)? Receipt scanning?

5. **Monetization model.** Currently no paid tier active. Free during beta. The plan is ~₪29/mo (~$8) for premium (multi-account, family sharing, advanced insights). Is that the right price? Should we be considering a freemium tier vs free-trial?

6. **Where to focus the next 10 hours of build time** to get from "private beta with 100 testers" to "public Hebrew launch?"

7. **Anything that looks like a category mistake** — e.g. should we drop the Apps Script bot and rebuild on a real server? Should we abandon the per-user-Sheet thing and use a normal DB? Should we kill English support and laser-focus on Hebrew?

Direct, opinionated answers are most useful. Don't hedge. If something is broken, say it.

---

## 10. Contact

- Owner: Steven Ran Cohen — srcslcollection@gmail.com
- Repo: https://github.com/stevenrancohen/kesefle
- Live: https://kesefle.vercel.app
- Bot WhatsApp number: +1-774-544-8053

Reply with concrete, prioritized instructions for the next phase of work. Thanks.
