# Kesefle UX Improvement Roadmap

Tracking polish items NOT included in the initial "Apple-grade polish" pass. Sorted by ROI within each surface.

Last updated: 2026-05-16

---

## Already Shipped (this pass)

| # | File | What |
|---|------|------|
| 1 | `dashboard.html` | New empty-state: 2-column layout with compelling Hebrew copy + a live "this is the row you'll get" sheet preview, ping-dot animation on the target row, copy-to-clipboard helper for the demo message |
| 2 | `dashboard.html` | Summary cards: count-up animation on load, color-coded balance (green/red/amber), icon badges per card, SVG sparklines behind expenses & income, daily mini-bars behind transaction count, balance-vs-income progress bar |
| 3 | `dashboard.html` | Recent transactions: category icons (🍔 food, 🚗 transport, ☕ coffee, 💡 electricity, etc.) with tinted color chips, row-in stagger animation, larger amount typography |
| 4 | `dashboard.html` | Top categories donut chart with center total, color-matched legend (icon + dot + name + % + ₪) |
| 5 | `account.html` | Onboarding banner transforms from amber "in-progress" to emerald "all-done" with confetti burst, progress bar (X/3), sheet structure preview under step 2, "waiting for your message…" pulsing indicator after WhatsApp CTA |

---

## Dashboard — Not Yet Implemented

### High ROI
- **Daily / weekly / monthly toggle** at the top of the dashboard. Currently everything is "this month" — power users will want to slice.
- **Sticky "Add via WhatsApp" floating action button** (bottom-left, RTL): one-tap deep link, always accessible without scrolling.
- **Trend annotation on sparkline hover**: tooltip with date + amount on hover/focus.
- **Empty state for each card individually** when total is 0 (e.g., income card says "אין הכנסות החודש — שלח 'משכורת 8500'" instead of just ₪0).
- **Settings panel hierarchy**: group into "Account", "Data", "Danger zone" sections with separator headings and a subtle plan-badge in the header (Free/Pro/Family).

### Medium ROI
- **Recent transactions: swipe-to-delete** on mobile (touch gestures) + "מחק אחרון" button that sends `מחק אחרון` to WhatsApp.
- **Recent transactions: search/filter input** when list > 10 rows.
- **Per-category drilldown**: clicking a donut segment expands a modal with all transactions in that category for the month.
- **Anomaly highlight**: if a single transaction is > 3σ of the user's typical amount, flag with `⚠️` and "?זה נראה גבוה" tooltip.
- **Forecast card**: 5th summary card "תחזית חודש" using simple linear extrapolation from days-elapsed.

### Polish
- **Skeleton loaders** instead of "טוען…" plain text — gives perceived performance boost.
- **Dark mode toggle in nav** (already supported by Tailwind classes but no UI to flip).
- **Print stylesheet** so users can `Cmd+P` and get a clean monthly report.
- **Number tabular-nums everywhere** for cleaner alignment in the recent-transactions list (partly done — extend to all `.num` spans).

---

## Account / Onboarding — Not Yet Implemented

### High ROI
- **Step 2 — Sheet preview is static**. Should animate: rows appear top-down, as if the bot is filling them in, when the step is the current focus. Reinforces "this is what'll happen".
- **Real WhatsApp polling**: replace the `focus` heuristic with an actual `GET /api/whatsapp/linked?userSub=...` poll every 3s, with exponential backoff. When the bot receives the first message, the backend sets the flag and the UI flips.
- **Inline QR code** for desktop users: instead of just a `wa.me` link, show the QR so they can scan from their phone without needing wa.me's redirect.
- **"Skip for now" link** under step 2 — pessimistic users want to see the dashboard skeleton before granting Drive access. (Currently the dashboard redirects them back if no sheet.)

### Medium ROI
- **3-card row below banner** ("החודש", "קטגוריה מובילה", "סטטוס") is duplicated from dashboard. Either remove from account.html or make it dynamic.
- **OAuth scope explainer**: small "ℹ️ למה אנחנו מבקשים drive.file?" link that opens an inline expandable panel explaining the *minimal* scope (only files the app creates).
- **Email-confirmation step** (step 0 above step 1): "We sent a confirmation link to X@gmail.com — click it to enable summary emails."

---

## Landing (index.html) — Not Yet Implemented

### High ROI
- **Hero chat-bubble loop**: bubbles currently animate once on load (delays 0.7s/1.4s/2.1s). Add `animation-iteration-count: infinite` with a `pause` keyframe in the middle to create a 10s loop showing message → reply → fade → repeat.
- **Social-proof bar at the very top** (above the existing nav): "⭐ 4.9 על TrustPilot · 1,200+ משפחות ישראליות משתמשות בכספ'לה · נכון ל-מאי 2026". Sticky, dismissible.
- **3 testimonials all use the same template** (rounded card, gradient avatar, italics, 5 stars). Vary:
  - Card 1: keep current "professional" treatment.
  - Card 2: WhatsApp-screenshot style — quote inside a green message bubble, simulating user posting the testimonial to the bot itself.
  - Card 3: "spreadsheet row" style — quote as a cell in a fake Google Sheets row to reinforce the product metaphor.
- **Live "מי השתמש עכשיו?" ticker**: rotating fake/seeded names + cities ("אסף מתל אביב רק רשם 240₪ סופר · לפני 3 שניות"). Builds urgency.

### Medium ROI
- **Interactive demo**: replace the static chat bubbles with a real input field where the user can type "245 סופר" and see the bot's parsed response — pure JS, no API call.
- **Comparison table** ("כספ'לה vs YNAB vs Mint vs Excel"): row per feature, checkmarks. Powerful for Hebrew-speakers who tried English tools.
- **FAQ accordion needs `<details>` markup** for SEO + a11y instead of JS-driven open/close.
- **Sticky bottom CTA on mobile** after the user scrolls past the hero.

### Polish
- **Hero stat bar** (`₪479,000 / 368 / 2s`) needs animated count-up on viewport intersection.
- **Pricing toggle**: monthly ↔ annual (with "save 20%" badge).
- **Footer**: add status page link, changelog, "made in Israel 🇮🇱" badge.

---

## Cross-cutting

- **Hebrew typography**: `Heebo` is fine, but pair with `Rubik` for headings to give more weight/personality (Linear-style).
- **Reduced-motion respect**: wrap all `@keyframes` animations in `@media (prefers-reduced-motion: no-preference)`.
- **Touch targets**: all CTAs ≥ 44×44px on mobile (Apple HIG). Audit needed.
- **Color tokens**: define `--surface`, `--surface-elevated`, `--border`, `--text-primary`, `--text-muted` CSS custom properties; current Tailwind palette is good but mixing `ink-*` and `slate-*` (account.html uses slate, dashboard uses ink) — pick one.
- **A11y audit**: every interactive element needs `aria-label` in Hebrew; sparkline SVGs need `<title>`.
- **Confetti on first transaction landing in dashboard**: when the first row appears (transitioning from empty-state to populated), reuse the celebration burst from account.html.
- **Page-load LCP optimization**: preconnect to `accounts.google.com` and `cdn.tailwindcss.com`, inline critical CSS for the hero.

---

## Wins to Ship Next (priority order)

1. Real WhatsApp linking poll (replaces `focus` heuristic in account.html — solid UX → real funnel data).
2. Hero chat-bubble loop on index.html (5-line CSS change, big perceived liveliness boost).
3. Daily/weekly/monthly toggle on dashboard (high info density gain).
4. Testimonial visual variation on index.html (+ social-proof bar).
5. Settings panel reorganization (Group / Account / Data / Danger).
