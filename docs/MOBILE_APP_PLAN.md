# Mobile App Build Plan

> Steven 2026-05-26: "אני רוצה להתחיל לבנות את האפליקציה לעסק.
> תתחיל לרשום לעצמך מטלות משלב האפס עד לשלב הביצוע המלא ותתחיל
> לבנות את האפליקציה או לקחת טמפלט מוכן ולשפר אותו."

Inspiration: RiseUp (cute yellow grid of category icons, donut chart, percentage breakdown).

## Decision: build from scratch vs template

### Option A — From scratch (React Native + Expo)
- Pros: full control, modern stack, easy iteration, large community
- Cons: 4-6 weeks to MVP, design from zero
- Best if: you want a unique brand feel + long-term ownership

### Option B — Template (e.g. NativeBase / Tamagui starter)
- Pros: 2-3 weeks to MVP, professional design out of the box, fewer decisions
- Cons: harder to make it feel uniquely "Kesefle", template baggage in code
- Best if: speed-to-market matters more than design polish

### Option C — PWA only (no app store)
- Pros: 1-2 weeks, no Apple/Google review, instant updates
- Cons: no push notifications on iOS (limited), no app store discovery
- Best if: you want to test the concept before committing to a native build

**My recommendation: Option A with Expo + React Native.** Reasons:
1. The existing site (Tailwind + RTL Hebrew) gives a strong design language to translate
2. Expo handles iOS + Android + web from one codebase
3. Push notifications work properly on both platforms
4. App Store + Google Play presence builds trust
5. Pure-RN code is portable to a future web view if needed

## Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | React Native + Expo SDK 51+ | Cross-platform, fast dev cycle, OTA updates |
| Language | TypeScript | Catches bugs early; same DNA as existing JS |
| Navigation | expo-router v3 (file-based) | Modern, RTL-aware, deep-linking built in |
| Styling | NativeWind (Tailwind for RN) | Reuse Tailwind classes from the web |
| State | Zustand | Simpler than Redux, perfect for this scope |
| API client | TanStack Query | Caching, retries, background refetch |
| Auth | expo-auth-session (Google OAuth) | Reuse existing /api/auth/google-exchange |
| Charts | victory-native | Donut charts, bar charts, RTL support |
| Icons | @expo/vector-icons + custom RiseUp-style SVG | Match the yellow icon-grid aesthetic |
| Push | expo-notifications | Bot can push: "סיכום חודשי מוכן" |
| Storage | expo-secure-store | Refresh tokens encrypted on device |
| Analytics | PostHog or just /api/log/funnel-event | Track screen views, conversion |
| Testing | Jest + React Native Testing Library + Detox (e2e) | Same patterns as existing JS tests |

## MVP scope (v1.0)

**4 screens, ~2-3 week build:**

1. **Splash + Login** — Google sign-in (reuse existing OAuth), saves refresh token
2. **Home** — Today's spend, this month's total, top 3 categories, "+" floating button to add expense
3. **Add Expense** — Category picker (icon grid like RiseUp), amount, optional note, save
4. **Dashboard** — Donut chart by category, month picker, transactions list, search

## Future scope (v2.0+)

- Receipt photo OCR (already exists in bot)
- Voice memo (record → transcribe → add)
- Budget tracking with alerts
- Multi-currency (already exists in bot)
- Household sharing view (PR for partner sharing)
- Year-over-year comparison
- Export to PDF
- Dark mode
- iPad layout
- Apple Watch complication

## Task list — from zero to App Store

### Phase 0 — Decisions (1 day)
- [ ] **Decide: from-scratch vs template** ← Steven decision
- [ ] **Decide: app name** (probably "כספ'לה" with English fallback "Kesefle")
- [ ] **Decide: icon design** (port the existing logo.png)
- [ ] **Decide: launch markets** (Israel only? IL + US?)

### Phase 1 — Setup (1-2 days)
- [ ] Create new Expo project: `npx create-expo-app kesefle-mobile`
- [ ] Initialize git repo (separate from main `kesefle` repo OR monorepo subfolder)
- [ ] Add ESLint + Prettier with existing project's config
- [ ] Set up TypeScript strict mode
- [ ] Install NativeWind + configure Tailwind config with brand colors (indigo + cyan)
- [ ] Configure RTL: `import { I18nManager } from 'react-native'; I18nManager.forceRTL(true);`
- [ ] Add Heebo + Rubik fonts via `expo-font`
- [ ] Set up expo-router with `/app` directory

### Phase 2 — Design system (2-3 days)
- [ ] Port color palette from web (ink, brand, accent)
- [ ] Build atomic components: Button, Card, Input, IconBadge, Skeleton
- [ ] Build category-icon grid matching RiseUp aesthetic (38 category SVGs)
- [ ] Build donut-chart component (`victory-native`)
- [ ] Build skeleton loaders for each screen
- [ ] Build empty states (אין הוצאות החודש)
- [ ] Storybook OR Expo dev menu route to preview all components

### Phase 3 — Auth flow (2 days)
- [ ] Splash screen with logo
- [ ] Google sign-in via expo-auth-session
- [ ] Hit existing `/api/auth/google-exchange` endpoint
- [ ] Store refresh token in expo-secure-store
- [ ] Auto-refresh access token before expiry
- [ ] Sign-out flow (clear token, navigate to splash)

### Phase 4 — Home screen (2 days)
- [ ] Header with user avatar + month picker
- [ ] "סה״כ החודש" big number with delta vs last month
- [ ] Top 3 categories with mini-bars
- [ ] Last 5 transactions list
- [ ] Floating "+" button (FAB) → opens Add Expense
- [ ] Pull-to-refresh: re-fetch from `/api/sheet/getExpenses`

### Phase 5 — Add Expense screen (2-3 days)
- [ ] Category icon grid (38 icons, like RiseUp)
- [ ] Tab switcher: הוצאה / הכנסה / העברה
- [ ] Number pad with big buttons + ₪ display
- [ ] Optional note field
- [ ] Date picker (default = today)
- [ ] Save button → POST to `/api/sheet/append`
- [ ] Success toast + navigate back to Home
- [ ] Offline support: queue saves when no internet, sync when back

### Phase 6 — Dashboard screen (2-3 days)
- [ ] Month picker (swipe or arrows)
- [ ] Donut chart (category breakdown)
- [ ] Percentage list under donut
- [ ] Toggle: month vs year view
- [ ] Toggle: expenses vs income
- [ ] Tap a category → drill into transactions filtered by that category

### Phase 7 — API integration polish (1-2 days)
- [ ] Wire all screens to TanStack Query with proper cache invalidation
- [ ] Add error boundaries
- [ ] Handle 401 (token expired) → re-auth flow
- [ ] Handle 503 (server down) → "אנחנו חזרים בקרוב" screen
- [ ] Add request timeout (10s default)
- [ ] Add retry on transient network errors

### Phase 8 — Push notifications (1-2 days)
- [ ] expo-notifications setup
- [ ] Register device token with `/api/push/subscribe`
- [ ] Bot sends push on: weekly summary ready, recurring expense reminder, budget exceeded
- [ ] In-app handler: tap notification → navigate to relevant screen

### Phase 9 — Testing (2-3 days)
- [ ] Unit tests for state stores
- [ ] Component tests for atoms (Button, Input, Card)
- [ ] Integration tests for screens (Home loads + renders)
- [ ] e2e tests with Detox: full add-expense flow on iOS simulator + Android emulator
- [ ] Manual QA on:
  - [ ] iPhone 15 Pro
  - [ ] iPhone SE (small screen)
  - [ ] Pixel 8
  - [ ] Galaxy S20
  - [ ] iPad (basic responsive layout)

### Phase 10 — Store submission (2-3 days)
- [ ] Create Apple Developer account ($99/year) — Steven action
- [ ] Create Google Play Console account ($25 one-time) — Steven action
- [ ] App icon (1024x1024 + adaptive icons for Android)
- [ ] Screenshots (6.5" iPhone, 6.7" iPhone, iPad, Android phone, Android tablet)
- [ ] App Store description (Hebrew + English)
- [ ] Privacy policy URL (already exists at kesefle.com/privacy)
- [ ] Support URL (info@kesefle.com)
- [ ] Build production binary: `eas build --platform all`
- [ ] Submit for review (Apple ~1-3 days, Google ~few hours)
- [ ] Respond to any reviewer feedback

### Phase 11 — Launch (1 day)
- [ ] Update website to show "Download on App Store" + "Get it on Google Play" badges
- [ ] Update bot welcome message to mention the app
- [ ] Announce on Steven's WhatsApp status + LinkedIn
- [ ] Set up app analytics dashboard

## Estimated total: 3-4 weeks of focused work

| Phase | Days | Cumulative |
|-------|------|------------|
| 0-1: Decisions + Setup | 2-3 | 3 |
| 2: Design system | 2-3 | 6 |
| 3: Auth | 2 | 8 |
| 4: Home | 2 | 10 |
| 5: Add Expense | 2-3 | 13 |
| 6: Dashboard | 2-3 | 16 |
| 7: API polish | 1-2 | 18 |
| 8: Push | 1-2 | 20 |
| 9: Testing | 2-3 | 23 |
| 10: Store submission | 2-3 | 26 |
| 11: Launch | 1 | 27 |

**Buffer: +30% for unknowns → 35 working days → ~7 weeks calendar time.**

## Open questions for Steven

1. **Repo structure**: separate `kesefle-mobile` repo, or monorepo `kesefle/mobile/`?
2. **App name in stores**: "כספ'לה" or "Kesefle" or both?
3. **Launch geography**: Israel only first, then global? Or both immediately?
4. **Pricing**: free with same Pro upsell as web, or different mobile-only tier?
5. **Branding**: keep current indigo+cyan, or rebrand for mobile (more yellow like RiseUp)?

## What I can start RIGHT NOW (no Steven approval needed)

1. Create the Monday subtasks (already done)
2. Scaffold the Expo project locally
3. Build the design system components (atomic, reusable)
4. Document the API contract the app will consume
5. Set up the CI pipeline (EAS Build, fastlane)

Once Steven answers the open questions, I can ship Phase 1+2 in the first week.
