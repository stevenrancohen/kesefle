# Dashboard redesign — design principles (NOT a Lyra clone)

**Author:** Claude
**Date:** 2026-05-26
**Status:** Design proposal — implementation rolls out across PR-1 / PR-2 / PR-3
**Input:** 4 Lyra screenshots Steven sent. Principles distilled, NOT copied.

---

## What Steven said

> "תיקח דוגמא לאיך המערכת דשבורד אמורה להיות, אל תעשה אחד לאחד אבל תבין את העיקרון ותבנה מערכת כזאת"

Translation: "Take this as an example of how the dashboard should be — don't do 1:1, but understand the principle and build such a system."

So the goal here is **principles, not pixels**. The Lyra screenshots showed us:

1. A **sidebar** that's the spine of the app (Overview / Transactions / Budgets / Goals / Management)
2. A **tabbed create-modal** for income / expense / transfer — single entry point
3. **Quick-amount chips** at the top of the expense form (your last 4 expenses become 1-tap repeats)
4. **Recurring cashflow** as a first-class concept (salary, rent, mortgage, loan, subscription) — bubbles to click
5. **Empty states with a CTA** — every empty section explains what would appear AND lets you start
6. **Category management** as its own page (cards with icon + delete)
7. **Goals page** with tabs (active / achieved / archived)

The bones are right. The brand and the privacy story are ours — Lyra holds your data, we don't.

---

## Today's dashboard.html — what's there, what's wrong

Current shape (as of main today): a long vertical scroll with sections piled top to bottom. Each section is good individually (Year-over-Year stat, Funnel card, Activity feed, etc.), but together they're a *firehose*. A first-time user can't tell what's actionable vs informational vs admin-only.

**Specific friction:**
- No persistent way to "go to my goals" — you have to scroll to find them
- The "log a new expense" path lives in WhatsApp, not in the dashboard — but for desktop-first users that's wrong; they want to type it on the page
- Categories management is buried — Lyra-style card UI is much nicer
- No clear separation between "data I look at" and "settings I change"

---

## The 7 principles (what we adopt, what we don't)

### 1. Sidebar as the spine
**Adopt.** A vertical nav on the right (RTL) with 5-6 top-level sections. Always visible on desktop, collapsible on mobile to a hamburger.

Sections (Hebrew, with target route):
- 📊 **סקירה כללית** (`/dashboard`) — landing, the at-a-glance
- 💸 **עסקאות** (`/dashboard/transactions`) — the full transaction list, searchable
- 🎯 **תקציבים ויעדים** (`/dashboard/budgets`) — both monthly caps AND long-horizon objectives in one place (per the goals design doc)
- 🔁 **תזרים קבוע** (`/dashboard/recurring`) — salary, rent, subscriptions, loans
- ⚙️ **ניהול** (`/dashboard/manage`) — categories, payment methods, connected accounts, profile
- ❓ **עזרה** (`/help` — opens existing help center)

Each route is a HASH-routed view inside one SPA-style `dashboard.html` — no extra page loads, no SEO concern (the dashboard is auth-gated).

### 2. Single "+ עסקה חדשה" button — not three
**Adopt with adjustment.** Lyra has 3 tabs (income / expense / transfer) in a modal. We adopt the modal + tabs but **default to "expense"** since 80% of writes are expenses. The transfer tab is *Pro-only* — it depends on having multiple accounts wired in `ניהול → חשבונות`.

### 3. Quick-amount chips
**Adopt.** At the top of the expense form, show the **last 4 distinct expenses** as chips: `קפה ₪14` `סופר ₪247` `דלק ₪280` `ביט ₪100`. One tap = one new row. This is the killer UX feature Lyra has and we don't.

Source: existing תנועות sheet, last 4 rows where amount is distinct.

### 4. Recurring cashflow as first-class
**Adopt — already half-built.** We have `קבוע` recurring support in the bot. The dashboard never surfaced it as a *concept*; it's hidden in the cron. New `/dashboard/recurring` route shows:
- A row per recurring (משכורת ₪14,200 בכל 1 לחודש, שכירות ₪3,800 בכל 5 לחודש, ...)
- Pause / skip-this-month / delete buttons
- "+ הוסף תזרים קבוע" → modal asking name / amount / frequency / next-fire-date

This puts the "I have ₪X coming in / out predictably" front and center, which is the foundation of any financial plan.

### 5. Empty states with a CTA (not just text)
**Adopt.** Every section that has nothing yet gets:
- A friendly icon (~48px circle)
- One Hebrew sentence explaining what *would* be here
- A primary button: "צור את הראשון שלך"

We already started this in PR #63 (admin empty states). Apply the same pattern to the dashboard.

### 6. Categories management as its own page
**Adopt.** Move category management out of the bot-only flow (`צור קטגוריה X`) and into `/dashboard/manage/categories`. Lyra's card grid is the right pattern: icon + name + delete. Free users see only the system categories; Pro users can add/remove.

This unblocks people who want to manage from desktop and reduces bot noise.

### 7. Goals tabs (active / achieved / archived)
**Adopt.** Per the `SMART_BUDGET_GOALS_DESIGN.md` v2 we already have on main. The Lyra screenshot confirms the pattern: tabs at the top, empty state with CTA when no goals exist, list of cards otherwise.

---

## What we deliberately do NOT adopt from Lyra

| Lyra has | We won't | Why |
|---|---|---|
| Their data on their servers | n/a | Whole privacy story is the opposite |
| Mandatory account creation before any value | Reject | WhatsApp-first onboarding means a user can be valuable in 30 seconds without ever opening the dashboard |
| Mobile-app default | Reject | We're WhatsApp + responsive web. Adding a native app right now is wrong leverage |
| Bank-connection as core | Skip in this redesign | We have it as a Pro feature; not a header-bar element |
| Their purple/violet palette | Reject | We use cyan/teal per PR #65 (the rebrand to brand-* cyan) |

---

## Rollout — 3 incremental PRs

We do NOT redesign the whole dashboard in one big PR. Three smaller, reviewable, deployable, reversible PRs:

### PR-D1 — Sidebar shell + routing (this is next)
- Sidebar component with the 6 sections
- Hash-router (`#/transactions`, `#/budgets`, etc.) inside dashboard.html
- Each section pane: empty by default, just "this is where X will live"
- Old long-scroll dashboard becomes the "סקירה כללית" pane
- **No behavior change** — same data, same APIs, just reorganized

### PR-D2 — Quick-create transaction modal
- Floating "+" button bottom-left (RTL: bottom-right)
- Modal with 3 tabs (expense default, income, transfer)
- Quick-amount chips at top of expense tab
- POSTs to existing `/api/sheet/web-append` — no new API surface

### PR-D3 — Recurring cashflow page + categories page
- `/dashboard/recurring` reads from existing recurring storage, displays + manages
- `/dashboard/manage/categories` card UI for category CRUD
- Plus 2 small new endpoints (or reuse): `api/recurring/list`, `api/categories/list`

PR-D4+ as needed once Steven sees PR-D1 land.

---

## Risks + how we mitigate

| Risk | Mitigation |
|---|---|
| Hash routing breaks existing deep links | Backward compat: any path without `#` lands on `סקירה כללית` (same as old behavior) |
| Heavy redesign disrupts existing users mid-flow | Each PR ships one self-contained change. Old sections keep working until they're moved |
| Mobile sidebar collapses badly on small screens | Use Tailwind responsive prefixes; sidebar becomes a top hamburger ≤ md |
| RTL alignment slips on quick-amount chips | The chips are flex-row-reverse so first chip is rightmost (matches Lyra screenshot) |
| Performance regression from more DOM | All section panes are LAZY — only the active one is mounted |

---

## Privacy must show up on the dashboard too

This is the link back to PR #75 (privacy-first hero). The dashboard isn't exempt — somewhere in the sidebar footer, a small line:

> 🔒 הגיליון שלך · אצלך · בדרייב · [פתח גיליון](https://sheets.google.com/...)

One-tap to open *your* sheet. Reinforces that we never had it.

---

## Open questions for Steven (PR-D1 doesn't depend on these)

1. **Right-side sidebar (RTL native) or left-side (matches Lyra screenshot literally)?** Hebrew SaaS convention is right-side; recommend right.
2. **Section labels** — keep my 6 (סקירה כללית / עסקאות / תקציבים ויעדים / תזרים קבוע / ניהול / עזרה) or add/remove any?
3. **"+ עסקה חדשה" placement** — floating action button (mobile-first) or top-right of every section?
4. **Quick-amount chip count** — 4 (Lyra), 6, 8?
5. **Recurring page UX for the "pause this month" action** — confirmation prompt or one-click toggle?

Once you answer, PR-D1 ships. If you want me to just pick the defaults and ship — I'll pick the recommended option for each and you can adjust in PR-D2.
