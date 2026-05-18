# Kesefle Launch Status — 2026-05-18

A milestone-by-milestone record of where the project stands at end of this work session. Use as a reference for next-session planning.

---

## 🎉 Wins shipped today

### Domain + Email infrastructure
- ✅ **kesefle.com purchased** at Hostinger
- ✅ **Google Workspace verification COMPLETE** — TXT record `google-site-verification=gm5FnFA98Yz_85NdfW_FHYV54p88V0Fait5GwwWS5VY` validated by Google
- ✅ **Gmail MX records LIVE** — `MX @ 1 smtp.google.com TTL 3600` — Google confirmed activation
- ✅ **info@kesefle.com is now a functional Gmail address** — emails sent there land in the Workspace inbox
- ⏳ **Email routing propagation** — up to 24h for global email systems to fully recognize the MX records (most mail will work immediately, a few stragglers may bounce in the first 6-12 hours)

### Bot upgrades (Apps Script)
- ✅ **Meta WhatsApp webhook signature verification** (best-effort under Apps Script limitations) — HMAC-SHA256 check + WABA ID match + STRICT_WEBHOOK_VERIFY toggle
- ✅ **Per-phone rate limiting** — 30 messages / 60s, CacheService-backed, silent drop
- ✅ **Real-time category correction flow** working end-to-end
- ✅ **LLM-extracted keyword expansion** via Claude Haiku
- ✅ **Cross-user global learning** via SHA-256 hash store in Vercel KV
- ✅ **Voice messages** via OpenAI Whisper
- ✅ **Receipt OCR** via Claude Vision
- ✅ **Per-user timezone** (auto-detected from phone country code, 42 country codes supported)
- ✅ **Budget alerts** (3 tiers, 6h throttle)
- ✅ **Family multi-user mode**
- ✅ **Friendlier error messages** with two-line recovery hint format

### Web + content
- ✅ Premium design system across index, family, pricing, help, about, dashboard
- ✅ `/start` page (post-signup QR + WhatsApp deep link)
- ✅ `/admin/monitor` live stats dashboard
- ✅ `/admin/diagnostics` self-service health page
- ✅ 8+ Hebrew blog posts
- ✅ JSON-LD structured data (SoftwareApplication, FAQPage, BreadcrumbList, Article)
- ✅ Sitemap with 25+ URLs
- ✅ 5 Hebrew onboarding email templates ready for any email service

### Security + ops
- ✅ Vercel rate limiter on `/api/auth/*` + `/api/events`
- ✅ CSP + HSTS + X-Frame-Options headers
- ✅ Formula injection prevention in bot (sanitizeForSheet on 6 write sites)
- ✅ GitHub Actions CI (syntax + JSON + sitemap + secrets check)
- ✅ Session middleware (HMAC-signed JWT cookies)

---

## ⏳ In flight / partially done

### What needs Steven's action to complete

1. **Re-paste `bot/ExpenseBot_DEPLOY.gs`** into Apps Script + Deploy → New Version
   - Currently deployed version: ~5,300 lines (from earlier today)
   - Latest: ~6,062 lines (includes webhook security, all the above)
   - **The bot is live and working**, but the new security features aren't active until next paste+deploy
   - Time: 5 min

2. **Connect kesefle.com to Vercel** (the web app)
   - kesefle.com currently has DNS pointing at `2.57.91.91` (Hostinger parking IP) for the A record at `@`
   - To point at Vercel: change A record to `76.76.21.21` AND add CNAME `www → cname.vercel-dns.com`
   - Then add `kesefle.com` as a custom domain in the Vercel project
   - **WARNING**: This will replace the parking page with the actual Kesefle web app. Coordinate with email DNS so MX records stay intact.
   - See `docs/DOMAIN_SWITCHOVER.md` (created today) for step-by-step

3. **SPF/DKIM/DMARC records** for kesefle.com outgoing email
   - Without these, emails from `*@kesefle.com` may land in recipients' spam folders
   - See `docs/EMAIL_AUTHENTICATION.md` for the 3 records to add
   - Time: 5 min

4. **Apps Script Properties** for new bot security features (optional but recommended)
   - `META_APP_SECRET` — from Meta Developer Console (Settings → Basic → App Secret)
   - `WHATSAPP_BUSINESS_ACCOUNT_ID` — `986476207210292` (already known)
   - `STRICT_WEBHOOK_VERIFY` — leave unset for now (set to `1` after proxy is built)
   - All optional — bot works without them but with less security

### What's queued but not yet built

- **Vercel-side webhook proxy** to enable full HMAC signature verification (~1 hour to build when ready)
- **Stripe payments live** (code exists but no env vars on Vercel; crypto via Coinbase is also ready but not configured)
- **Meta Business Verification** — Steven was planning to attach Kesefle to verified SRC collection — gives 100→unlimited users for WhatsApp
- **Email service connection** — 5 onboarding email templates exist; need to pick SendGrid/Resend/etc. and wire up
- **OAuth scope verification with Google** — to allow unlimited Google sign-ins beyond 100 test users

---

## 📊 Bot deployment status

| Component | Status |
|---|---|
| Apps Script code (`bot/ExpenseBot_DEPLOY.gs`) | ✅ Ready (5,967 lines) |
| Deployed version | ⚠️ Older — needs re-paste |
| Script Properties: `WHATSAPP_TOKEN` | ✅ Set (per Steven's earlier confirm) |
| Script Properties: `WHATSAPP_PHONE_NUMBER_ID` | ✅ Set (1090404180828069) |
| Script Properties: `SHEET_ID` | ✅ Set |
| Script Properties: `ANTHROPIC_API_KEY` | ⚠️ Unknown (probably set) |
| Script Properties: `OPENAI_API_KEY` | ⚠️ Not set — voice messages won't work until set |
| Script Properties: `VERCEL_KV_REST_URL` + `_TOKEN` | ⚠️ Not set — family + global learn won't work |
| Script Properties: `FAMILY_TEMPLATE_SHEET_ID` | ⚠️ Not set — family commands won't work until template is created |
| Script Properties: `META_APP_SECRET` | ⚠️ Not set — webhook HMAC verification skipped |

### Vercel env vars

| Var | Status | Required for |
|---|---|---|
| `KV_REST_API_URL` + `_TOKEN` | ✅ Set | Rate limiter, KV-based features |
| `GOOGLE_CLIENT_ID` + `_SECRET` | ✅ Set | OAuth sign-in |
| `SESSION_SECRET` | ⚠️ Status unknown | Dashboard cookie auth |
| `COINBASE_COMMERCE_API_KEY` | ❌ Not set | Crypto payments |
| `COINBASE_WEBHOOK_SECRET` | ❌ Not set | Crypto payments |
| `ADMIN_TOKEN` | ❌ Not set (defaults to "kesefle2026") | Admin API |
| `TEST_USER_ID` | ❌ Not set | Dev-only crypto test |

---

## 🚀 Next 10-step launch plan

Recommended order for Steven to bring Kesefle to first 10 real users:

1. **Re-paste DEPLOY.gs** in Apps Script + Deploy New Version (5 min)
2. **Connect kesefle.com to Vercel** per `docs/DOMAIN_SWITCHOVER.md` (10 min, mostly DNS waiting)
3. **Add SPF/DKIM/DMARC** per `docs/EMAIL_AUTHENTICATION.md` (5 min)
4. **Set OPENAI_API_KEY** in Apps Script Properties (2 min) — unlocks voice messages
5. **Set VERCEL_KV credentials** in Apps Script Properties (2 min) — unlocks family + global learn
6. **Duplicate master Sheet for family template** + paste ID into `bot/config.gs` (15 min)
7. **Attach Expense Bot to SRC collection verified business** in Meta Business Manager (10 min) — unlocks unlimited WhatsApp users
8. **Quick smoke test** — send `סטטוס`, `42 קפה`, `מטרות`, `לימוד` from a real phone (5 min)
9. **First 5 real users** — Steven onboards friends/family who agree to be early testers
10. **Watch admin monitor** — check `/admin/monitor` daily, fix anything that breaks

Total time from "today's wins" to "10 real users": ~1.5 hours of Steven's time + a day of DNS propagation.

---

## 🔭 Big-picture roadmap

### Phase 1 (next 7 days) — public beta with manual onboarding
- Domain switchover complete
- Email auth complete
- First 10-20 real users via personal network
- Monitor daily, fix bugs as they emerge

### Phase 2 (next 30 days) — open beta + paid tier
- Stripe live for ₪19/mo Pro tier
- Email service connected (SendGrid or Resend) for onboarding sequence
- Israeli SEO content push (we have 10+ posts ready)
- Goal: 100 active users

### Phase 3 (next 90 days) — growth
- Affiliate / referral program
- Mobile app shortcuts (PWA install promotion)
- More features based on user feedback
- Goal: 500-1000 active users

### Big bets to consider later
- **Voice-first onboarding** — record a voice message to walk-through setup
- **WhatsApp Channels** — Kesefle broadcasts (savings tips, news) to subscribers
- **B2B mode** — small businesses use shared family-style sheets for petty cash
- **Banking integration** — careful, has friction, but huge moat

---

## 🧠 Lessons from this session

1. **Character ambiguity bit us** — `V0` (digit zero) vs `VO` (letter O) caused the verification stall. Future automation should COPY directly from clipboard via DOM rather than typing.
2. **DNS negative caching** — once Google's resolver sees a wrong value, it caches that. Even after the fix, takes 5-30 min for cache to expire. Patience > retry-spam.
3. **Apps Script doesn't expose webhook headers** — major limitation for security work. The Vercel-proxy pattern is the only real fix.
4. **Hostinger's parking nameservers DO serve DNS records** — initial concern about needing to change nameservers was unfounded.

---

## File index — created today

- `LAUNCH_STATUS_2026_05_18.md` (this file)
- `docs/DOMAIN_SWITCHOVER.md` — step-by-step for connecting kesefle.com to Vercel
- `docs/EMAIL_AUTHENTICATION.md` — SPF/DKIM/DMARC setup
- `docs/META_BUSINESS_VERIFICATION.md` — Meta Business Manager verification path (from earlier today)
- `bot/COMMANDS.md` — every bot command documented (from earlier)
- 5 new blog posts (agent in flight)
- `bot/TEST_SUITE.gs` (agent in flight)
- `/press.html`, `/team.html`, `/tools/email-signature.html`, `/blog/feed.xml` (agent in flight)
- Updated bot security in `bot/ExpenseBot_FIXED.gs` (agent done)

---

## Quick reference

- **Production WhatsApp number**: +1 (774) 544-8053 (Numero US, Meta Phone ID `1090404180828069`)
- **Test WhatsApp number**: +1 (555) 640-8123 (Meta free test number, limited to 5 recipients)
- **Master sheet ID**: `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`
- **Workspace admin email**: info@kesefle.com
- **Live site**: https://kesefle.vercel.app (custom domain switchover pending)
- **GitHub repo**: https://github.com/stevenrancohen/kesefle
- **Vercel project**: kesefle (Pro tier)
- **Hostinger account**: owner of kesefle.com
- **Latest commit**: see `git log -1`

When unsure, read `bot/COMMANDS.md` for bot capabilities and `docs/META_BUSINESS_VERIFICATION.md` for launch unlocks.
