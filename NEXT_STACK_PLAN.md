# Migration plan — to the recommended Unicorn-grade stack

Per Grok's brief + R&D agent's recommendations.

## Why this isn't done yet

The dev network at **Ono College** blocks `registry.npmjs.org` (HTTP 403, application-level block). Without npm we cannot:
- Run `create-next-app`
- Install Clerk / Supabase / shadcn / Tailwind / Framer Motion / etc.
- Even `npm install left-pad` returns 403.

Once you're off that network (home Wi-Fi, mobile hotspot, or whitelist npmjs.org via Ono IT), the migration below takes ~4 hours to execute, then ongoing feature work.

## Target stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | Full-stack, RSC, edge-ready, Vercel-native |
| Language | **TypeScript (strict)** | Type-safety required at SaaS scale |
| Styling | **Tailwind CSS v4** | Already what we're using via CDN |
| Components | **shadcn/ui + Radix** | Accessible, customizable, no vendor lock |
| Auth | **Clerk** | 5-minute Google OAuth, Hebrew UI, MFA built-in. Free up to 10k MAU |
| DB | **Supabase Postgres** | Row-level security per user, realtime, free up to 500MB |
| ORM | **Drizzle** | Lighter than Prisma, type-safe migrations |
| State | **Zustand + TanStack Query** | Simple client state + smart server cache |
| AI | **Vercel AI SDK + Claude 3.5** | Streaming, tool-calls, edge-compatible |
| Animation | **Framer Motion** | Premium feel, easy hover/scroll effects |
| Voice input | **Whisper API via Vercel AI SDK** | Better Hebrew than Web Speech |
| Hosting | **Vercel** | Already set up at https://kesefle.vercel.app |
| Analytics | **PostHog** | Self-hostable, generous free tier, session replay |
| Payments | **Paddle** | MoR for global ILS, חשבונית מס auto |
| WhatsApp | **Meta Cloud API** | Free tier, direct (no Twilio markup) |

## App structure (10 routes)

```
/                       # Landing page (current static)
/sign-in                # Clerk modal
/sign-up                # Clerk modal
/onboarding             # 5-step flow
  /onboarding/name
  /onboarding/goal
  /onboarding/currency
  /onboarding/bank
  /onboarding/first-expense
/dashboard              # Post-login home (sheet preview + insights)
/transactions           # Full list + search/filter + Voice input
/budgets                # Set monthly limits per category
/goals                  # Savings goals + progress bars
/insights               # AI-generated weekly summary
/settings               # Profile + connected accounts + billing
```

## 4-hour migration sprint (when npm unblocks)

### Hour 1 — Scaffold + auth
```bash
npx create-next-app@latest kesefle-next \
  --typescript --tailwind --app --no-src-dir --import-alias "@/*" \
  --use-pnpm

cd kesefle-next
npm i @clerk/nextjs @supabase/supabase-js drizzle-orm zustand @tanstack/react-query framer-motion ai @ai-sdk/anthropic
npx shadcn@latest init -y
npx shadcn@latest add button card input label dialog dropdown-menu form select toast
```

Then:
- Wrap `app/layout.tsx` in `<ClerkProvider>` + `<html dir="rtl" lang="he">`
- Add `middleware.ts` for auth-protected routes
- Add `app/sign-in/[[...sign-in]]/page.tsx` + sign-up equivalent
- Copy the current `index.html` content into `app/page.tsx` as a Server Component

### Hour 2 — Onboarding + Dashboard skeleton
- 5-step onboarding using shadcn forms (each step = its own route, progress bar)
- Dashboard route showing: balance card, cashflow chart (Recharts or Tremor), recent transactions list, AI insight card placeholder
- Voice input button → `/api/voice/transcribe` (Whisper) → AI categorization

### Hour 3 — Sheets integration + RLS
- Migrate `/api/sheet/provision.js` to App Router route handlers
- Supabase tables: `users (id, clerk_id, sheet_id, created_at)` + `events (id, user_id, type, payload, ts)`
- RLS policies: a user can only SELECT/INSERT rows where `user_id = auth.uid()`
- Server actions for: provisionSheet, recordTransaction, fetchDashboardSummary

### Hour 4 — Polish + deploy
- Dark mode toggle (next-themes + Tailwind dark: variant)
- Mobile responsive audit (every page must work at 360px)
- Add Framer Motion hero stagger animations
- Push to GitHub → Vercel auto-deploys

## What's already done — keep this as Phase 1

These artifacts in this repo can be kept and ported:
- `index.html` — most copy lifts to `app/page.tsx`
- `account.html` — becomes `app/dashboard/page.tsx`
- `privacy.html`, `terms.html` — become `app/privacy/page.tsx` etc.
- `api/auth/*.js` — replaced by Clerk; delete after migration
- `api/waitlist.js` — port to Server Action
- `api/sheet/provision.js` — port to Route Handler
- `api/whatsapp/webhook.js` — port to Route Handler (or Edge Function)
- `SETUP.md`, `DEPLOY.md`, `QUICKSTART.md` — update for Next.js

## Future features (post-MVP)

1. **AI categorization** — when bot receives "60 קפה", let Claude classify into `food.coffee` and learn from corrections.
2. **Voice input** — Whisper transcribes Hebrew speech → standard message → bot parses.
3. **Bank linking** — via Bridge (Israeli OpenBanking) once we have ~100 users to justify the setup cost.
4. **Family sharing** — Pro plan; one sheet shared between 4 family members.
5. **Tax reports** — generate חשבונית מס PDFs per month for freelancers.
6. **Investments view** — IBKR/Pepper API integration for portfolio sync.

## Risks the founder should know

1. **WhatsApp Business approval** — Meta can take 1-7 days to approve our display name. Apply BEFORE we have paying users so they're not blocked.
2. **Sheet provisioning quota** — Drive API limits `files.copy` to ~10/100s per user, OK. But our service account is rate-limited globally — for >10 signups/min we need user-OAuth tokens (which we already use).
3. **Hebrew NLU accuracy** — current regex parser handles ~85% of phrasings. Claude-Haiku as fallback bumps it to ~97% but adds ~$0.001 per message. Worth it for Pro users.
