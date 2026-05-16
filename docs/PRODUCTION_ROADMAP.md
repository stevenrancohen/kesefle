# Kesefle Production Roadmap

**Source of truth for what's built, what's blocking launch, and what to build next.**

Generated 2026-05-16 after 3-agent strategic review (Product / Tech / Risk).

---

## What's built and live (commits up to `f4b4178`)

### Public-facing
- ✅ Landing page (Hebrew RTL, 3-tier pricing, testimonials, FAQ, dark mode)
- ✅ /privacy + /terms with Israeli OAuth disclosure + Limited Use clause
- ✅ /test — 31 automated regression checks
- ✅ /dashboard — user dashboard with summary cards + recent transactions + top categories (placeholder data until summary API has user data)
- ✅ /account — Google sign-in + sheet provisioning onboarding
- ✅ SEO: robots.txt, sitemap.xml, JSON-LD SoftwareApplication schema, canonical
- ✅ Social: og-image.png 1200×630, og:url, og:site_name, twitter:card

### API endpoints
- ✅ `/api/waitlist` (rate-limited, KV-backed)
- ✅ `/api/auth/google-exchange` (OAuth authorization-code + PKCE → refresh token)
- ✅ `/api/sheet/provision` (copy template → user's Drive, store mapping)
- ✅ `/api/sheet/summary` (refresh-token → Sheets API → dashboard JSON)
- ✅ `/api/whatsapp/webhook` (raw-body HMAC, STOP/START, opt-out, idempotency, writer)
- ✅ `/api/account/delete` (self-serve deletion, Israeli Amendment 13 compliant)
- ✅ `/api/billing/checkout` (Stripe Checkout Session, 14-day trial)
- ✅ `/api/billing/webhook` (Stripe webhook with HMAC verification)
- ✅ `/api/health` (uptime + dependency probe)

### Bot (Apps Script project `1znN…kvUgrHTo`)
- ✅ Pasted by user: KESEFLE_ALL_PATCHES.gs (keywords v2 + classifier + sort + checkmark + auto-sort trigger). Verified working: 569 rows, newest at top, ✅ markers.
- ✅ Pasted by user: DROPDOWN_FOR_UNSURE.gs (interactive list message + state cache). All 3 unit tests passed.
- ✅ Sheet repair shipped (FIX_DASHBOARD_2023_2024_2025 — net profit + משלוחים monthly spread).

### Security
- ✅ HSTS (max-age=2y, preload-ready)
- ✅ CSP locking script/style/img/font/connect sources
- ✅ X-Frame-Options DENY, X-Content-Type-Options nosniff
- ✅ Permissions-Policy: camera/mic/geolocation all denied
- ✅ Rate limit on waitlist
- ✅ Meta HMAC raw-body verification (was bug — re-stringified body would fail)
- ✅ Stripe HMAC raw-body verification + timestamp tolerance

### Strategic docs
- ✅ `docs/architecture/` — db-schema, api-routes, billing-stripe, jobs-cron, observability, security-hardening
- ✅ `docs/compliance/` — google-oauth-verification, privacy-law-compliance, whatsapp-policy-compliance, incident-response-runbook, disclaimers-and-boundaries

---

## What's blocking public launch (must-fix in order)

| # | Blocker | Effort | Owner action required | Source |
|---|---------|--------|-----------------------|--------|
| 1 | **Front-end OAuth flow not yet switched to PKCE code flow** | 4 hr | Update `account.html` to redirect to Google with `response_type=code&access_type=offline&prompt=consent`, handle the callback, POST to `/api/auth/google-exchange`. Backend is ready. | required for refresh tokens (currently GIS-only = 1hr tokens = bot can't write) |
| 2 | **Vercel + Upstash regions in US, not EU** | 1 hr | Change Vercel region to `cdg1` or `arn1`; create Upstash KV in `eu-west-1`. Israeli law (PPA Amendment 13) prohibits transfer to non-whitelisted countries without explicit consent. | risk agent |
| 3 | **Refresh tokens stored plaintext in KV** | 3 hr | Implement AES-256-GCM encryption in `lib/crypto.js` (no npm). Add `KESEFLE_DB_KEY` env. Wrap KV reads/writes that touch `refreshToken`. | risk agent (sensitive financial data) |
| 4 | **Dedicated WhatsApp business number** | 2 weeks | Procure separate phone number (`+972-xx-xxx-xxxx`), register with Meta Business, submit display-name approval. Personal `+972547760643` will fail Meta business verification. | risk agent |
| 5 | **Google OAuth verification (CASA Tier 2)** | 6-12 weeks | Submit OAuth verification (drive.file is restricted scope = mandatory). Record demo video (3 min, script in `docs/compliance/google-oauth-verification.md`). Pay CASA Tier 2 audit ~$1.5-4k. | risk agent |
| 6 | **Stripe products + prices not created** | 30 min | In Stripe Dashboard: create Product "Kesefle Pro" ₪19/mo + "Kesefle Family" ₪39/mo. Copy price IDs to `STRIPE_PRICE_PRO` + `STRIPE_PRICE_FAMILY` env vars in Vercel. | billing |
| 7 | **Env vars not set in Vercel** | 30 min | Add: `GOOGLE_CLIENT_SECRET`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `KESEFLE_TEMPLATE_SHEET_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_FAMILY`. | deployment |

---

## Phase plan from here

### Phase 2A (Week 1) — Make it actually work end-to-end
- [ ] **Blocker #1**: account.html → server-side OAuth → refresh token in KV → first WhatsApp message writes to user's sheet
- [ ] **Blocker #7**: Vercel env vars
- [ ] Frontend: phone-to-userSub binding via `START <token>` handshake on first WhatsApp message (per Product agent recommendation)
- [ ] Dashboard polls /api/sheet/summary every 5s — "wow moment" of first row appearing
- [ ] Bot replies with confirmation including a short tutorial: "✅ נרשם. נסה גם: 'היום?' / 'מחק אחרון'"
- [ ] **Acceptance**: a stranger signs up, sends 3 WhatsApp messages, sees them on the dashboard, can ask "היום?" for summary

### Phase 2B (Week 2) — Magic + retention
- [ ] WhatsApp commands: `היום?` `השבוע?` `החודש?` `מחק אחרון` `תקן ל: <category>` `כמה הוצאתי על <X>?`
- [ ] Sunday 08:00 morning auto-digest (Apps Script time-driven trigger)
- [ ] Anomaly alert: expense > 2σ above category mean
- [ ] Dashboard: monthly budget progress bar (Pro-locked), category drill-down on click

### Phase 2C (Week 3-4) — Launch readiness
- [ ] **Blocker #2**: move to EU regions
- [ ] **Blocker #3**: encrypt refresh tokens at rest
- [ ] **Blocker #4**: dedicated WhatsApp number procurement (parallel)
- [ ] **Blocker #5**: submit Google OAuth verification (4-6 week clock starts; can launch limited to 100 test users in parallel)
- [ ] **Blocker #6**: Stripe products created + prices wired
- [ ] Admin dashboard skeleton (user lookup, support notes)
- [ ] Sentry + Better Stack integration
- [ ] Soft launch to 100 hand-picked test users (within Google's pre-verification 100-user cap)

### Phase 3 (Month 2+) — Scale + features
- [ ] Migrate KV → Supabase Postgres (tech agent recommendation; cleaner queries, audit trail)
- [ ] Vercel Cron jobs (token refresh, dunning, weekly reports)
- [ ] Family plan: multi-phone binding to one sheet
- [ ] Email digests
- [ ] Referral loop
- [ ] Multi-currency (USD, EUR for travel)
- [ ] CSV/PDF export (Pro feature)
- [ ] Custom categories (Pro feature)

---

## Risk register (top 5)

1. **Google OAuth verification rejection** — `drive.file` is restricted, requires CASA Tier 2. Mitigation: scope justification doc + demo video ready. Backup: downgrade to `drive.readonly` (lose provisioning), or distribute as Apps Script add-on (different review path).
2. **Meta business verification failure** — using personal number will fail. Mitigation: procure dedicated number BEFORE submitting. Backup: BSP partnership (Twilio, MessageBird) as fallback.
3. **Hebrew classification accuracy ~85% on edge cases** — Mitigation: dropdown fallback (already built). Optional: Claude Haiku fallback at $0.001/msg for Pro users → ~97% accuracy.
4. **Refresh-token revocation** — when user revokes Google grant, all writes fail silently. Mitigation: dashboard banner "Reconnect Google" + WhatsApp reminder, triggered on 401 from Sheets API.
5. **Israeli database registration at 10k users** — must register with רשם מאגרי מידע. Mitigation: 8k-user alert + pre-prepared registration packet.

---

## Definition of Done (per user's spec)

The product is launch-ready when ALL of these are true:

- [x] User can register → currently via Google sign-in
- [ ] User can connect Google → **needs server-side OAuth flow update**
- [ ] User can connect WhatsApp → **needs dedicated business number + onboarding template**
- [ ] User can send income/expense messages → **needs blocker #1 (OAuth flow) + #4 (number)**
- [x] Bot correctly parses and confirms transactions → classifier v2 done, dropdown fallback done
- [ ] Transactions saved internally → **needs Supabase migration (currently sheet-only)**
- [x] Transactions written to Google Sheet → writer is real, just needs refresh token from blocker #1
- [ ] Failed writes are retried → 401 retry done; durable queue still needed
- [ ] User can ask summaries by WhatsApp → **need command parser for היום?/השבוע?/החודש?**
- [x] User can view dashboard → built, awaiting real data via blocker #1
- [ ] User can edit/delete transactions → dashboard has hooks, endpoint not built
- [x] User can subscribe and pay → Stripe checkout + webhook built, needs blocker #6 (price IDs)
- [ ] Subscription status controls access → plan-gating UI logic not yet wired to dashboard
- [ ] Admin can support users → admin dashboard not built
- [x] Sensitive data is protected → CSP, HSTS, raw-body HMAC, KV access-controlled
- [ ] Logs do not expose unnecessary financial data → audit pass needed before launch
- [x] Terms and privacy policy exist → both with OAuth scope disclosure
- [ ] Monitoring exists → /api/health built, Sentry not wired
- [ ] Backups exist → user's own Sheet is the DR; nightly KV backup not yet automated
- [ ] Tests pass → 31 frontend regression tests live; backend has no test suite yet
- [ ] Deployment works in staging and production → only production, no staging environment

**Current completion: 11 of 21 = 52%.**

---

## Commit log highlights

| Commit | Pass | Description |
|--------|------|-------------|
| `f4b4178` | autonomous 2 | Compliance hardening + billing endpoints + STOP handler |
| `b0e73a4` | autonomous 2 | Production wiring + 3-agent strategic review |
| `66da0e2` | autonomous 1 | bot/README + WHEN_YOU_ARE_BACK handoff |
| `ac5753a` | autonomous 1 | Vercel routing bug fix (public/ folder) |
| `1bcb040` | autonomous 1 | og-image, lazy-load SDKs, OAuth disclosure, SEO basics |
| `9591537` | guided | KESEFLE_ALL_PATCHES.gs combined file |
| `888fbed` | guided | Launch-day polish (dark mode, WhatsApp btn, voice cleanup, footer) |
