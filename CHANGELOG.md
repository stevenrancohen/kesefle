# Changelog

All notable changes to Kesefle. Internal log — for user-facing version, see [/changelog](https://kesefle.vercel.app/changelog).

Format: feature batches grouped by date, sorted newest-first.

---

## 2026-05-18 — Autonomous burst (voice, budgets, admin monitor)

### Bot
- 🎙️ **Voice messages → expense** — send a WhatsApp voice note ("מאתיים שמונים שקל סופר"), bot transcribes via OpenAI Whisper and logs the expense. Same correction + learning flow works on voice. Optional — needs `OPENAI_API_KEY` Script Property.
- 💰 **Proactive budget alerts** — 3 tiers (pace warning / firm warning / exceeded). Triggers automatically after each expense, throttled 6h per category to avoid noise. Commands: `תקציבים`, `יעד תקציב X = Y`.

### Admin
- 📊 **Live monitoring dashboard** at `/admin/monitor` — 4 stat cards (users / families / premium / global learnings), bot health, conversion %. Auto-refresh every 30s. Password-gated.
- 🔌 **`/api/admin/stats`** — KV SCAN aggregation endpoint, Bearer-token auth.

### Web
- 🚀 **`/start` page** — pre-signup landing for users who want to try the bot before OAuth. Giant QR code + click-through WhatsApp button + 4 example messages.
- 🟢 **Homepage hero CTA** — added "פתח את הבוט עכשיו" green button → opens WhatsApp directly with bot.
- 🗺️ **Sitemap** — added 7 missing URLs (family + 5 blog posts + /start), lastmod bumped.
- 🏷️ **`account.html`** — added missing OG tags + description.
- ⚡ **Performance** — preconnect/dns-prefetch for Tailwind CDN on index.
- ♿ **Accessibility** — aria-labels on icon buttons, decorative SVGs marked `aria-hidden`.

---

## 2026-05-18 — Phase 2 continued (precision + learning)

### Bot
- 🧠 **User-driven category correction** — reply `קטגוריה X` after any expense to fix mis-categorization. Two-step confirmation (`כן`/`לא`) commits the change.
- 📚 **LLM-extracted keyword expansion** — when a user confirms a correction, Claude Haiku extracts 1-3 semantic keywords and saves them to the Learning tab. "מוביל הוצאות בית → שירותים" generalizes so future "...מוביל..." messages route correctly.
- 🎓 **Learning dashboard commands**:
  - `לימוד` — list last 10 learned terms with indexes
  - `למד: "X" = Y` — direct teach (skip confirmation)
  - `מחק לימוד N` — remove entry N
  - `איפוס לימוד` — wipe all learning (asks confirmation)
- 🌐 **Cross-user global learning** — SHA-256 hash store in Vercel KV. When user A corrects "מוביל" → שירותים, user B sending the same text auto-routes correctly. Privacy: only hashes shared. Reply includes "📚 למדתי ממשתמשים אחרים" when global match is used.
- 🎯 **Tightened AI prompt** — Anthropic `system` parameter + strict JSON output. Switched to `claude-haiku-4-5-20251001`. Added "שירותים" category. 28 in-context examples.

---

## 2026-05-18 — Phase 2 (multi-user)

### Bot
- 👨‍👩‍👧 **Family/business multi-user mode** — `הקמת משפחה`, `הצטרפות למשפחה <id>`, `אישור/דחייה <phone>`, `משפחה X amount`, `(אבא|אימא|ילד1-3) X amount`, `דו"ח משפחתי`, `מצב משפחתי`/`מצב אישי`.
- `bot/config.gs` — family template ID + one-time setup steps for Steven.

### Web
- 🎨 **Family.html refresh** — hero rewritten "תקציב משפחתי בוואטסאפ. בלי אפליקציה, בלי כאב ראש". Added how-to-join section with WhatsApp commands + QR code + command reference card. Premium curtain + parallax + magnetic CTAs.

### API + Auth
- 🔐 **`/api/_lib/session.js`** — HMAC-signed JWT cookie helpers (no dependency). Requires `SESSION_SECRET`.
- 📈 **`/api/sheet/getExpenses`** — auth-gated Sheet fetch for dashboard. Never exposes tokens.
- 🔄 **OAuth callback** — sets session cookie + stores tokens in KV.
- 🪙 **Coinbase Commerce crypto payments** — `crypto-create`, `crypto-webhook` (HMAC-verified), `crypto-webhook-test` (dev-only). Pricing.html has "תשלום בקריפטו" button.
- 🖥️ **Live dashboard.html** — table + 3 summary cards (total / top category / vs last month). Premium design system.

### Files
- `bot/ExpenseBot_DEPLOY.gs` — single-paste deployment file with bilingual 5-step header + required Script Properties checklist.

---

## 2026-05-17 — Backend security + subpage polish + SEO

### Security (DeepSeek sprint Area 1)
- 🛡️ **`api/_lib/rateLimit.js`** — per-IP guard, 30 req/60s, Vercel KV-backed, fails open.
- 🛡️ **`vercel.json`** — global CSP, HSTS, X-Frame-Options, Permissions-Policy.
- 🛡️ **`sanitizeForSheet`** in bot — blocks formula injection on 6 user-typed write sites.
- 📄 **`docs/security.md`** — KV scope + rate-limit + CSP + injection docs.

### Web (DeepSeek Area 3)
- 💎 **Pricing.html, help.html, about.html** — full premium design system applied (curtain, parallax blobs, staggered hero stages, scroll reveals, kfl-lift, magnetic CTAs).

### SEO (DeepSeek Area 2)
- 📝 5 Hebrew blog posts total — family budget, saving thousands, vs apps comparison, freelancers, Google Sheets ownership.
- 🔍 JSON-LD on index.html (SoftwareApplication + FAQPage), with real 3-tier offers (no fake aggregateRating).
- 🇬🇧 `en.html` — full LTR English rewrite, Inter font, premium design parity.

### Homepage rewrite
- Replaced "SECURITY • Zero-Trust" section with "מה אתם מקבלים" value cards.
- Replaced "THE ENGINE" tier card with clean 3-step "what happens" panel.
- Enlarged hero WhatsApp mockup, added "לראות איך זה עובד בלייב" CTA.
- Nav: removed "אבטחה" + "המנוע", added "מה מקבלים" + "משפחות".

---

## Earlier (2026-05-15 to 2026-05-17)

- Premium redesign stages 1-7: curtain + cinematic reveal, parallax blobs (CSS-var preserves blob-drift), magnetic CTAs, kfl-lift cards, Inter font + tabular nums, scroll fade-ins.
- Bot: goal tracking, subscription detection, anomaly detection.
- Bot: 18,725 keyword expansion (12.7x).
- Family/couples landing page.
- Bot debug guide.
- OAuth verification documentation package.
- Self-service /admin/diagnostics health page.

---

## Required environment variables

### Vercel (set in dashboard)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash Redis (KV)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — OAuth
- `SESSION_SECRET` — required for dashboard cookie auth
- `COINBASE_COMMERCE_API_KEY`, `COINBASE_WEBHOOK_SECRET` — required for crypto payments
- `ADMIN_TOKEN` — optional (defaults to "kesefle2026")
- `TEST_USER_ID` — optional, dev only

### Apps Script (set in Project Settings → Script Properties)
- `WHATSAPP_TOKEN` — Meta WhatsApp Business API token
- `WHATSAPP_PHONE_NUMBER_ID` — `1090404180828069`
- `SHEET_ID` — master template Sheet ID
- `ANTHROPIC_API_KEY` — Claude Haiku (categorization + receipt OCR + learning)
- `OPENAI_API_KEY` — optional, voice messages only
- `KESEFLE_BOT_SECRET` — multi-tenant phone linking
- `FAMILY_TEMPLATE_SHEET_ID` — after Steven duplicates master + adds Member column
- `VERCEL_KV_REST_URL` + `VERCEL_KV_REST_TOKEN` — Upstash REST (family + global learning)

---

## What requires Steven manually

1. **Re-paste `bot/ExpenseBot_DEPLOY.gs`** into Apps Script editor → Deploy → New version. Activates the entire current batch.
2. **Family template setup** — duplicate master Sheet, add Member column after Date, rename tab to "Family Budget", share publicly, paste ID into `bot/config.gs`.
3. **Coinbase Commerce setup** — create account, register webhook, set 2 env vars.
4. **Meta Business Verification OR add Expense Bot app to verified SRC collection** — see [docs/META_BUSINESS_VERIFICATION.md](docs/META_BUSINESS_VERIFICATION.md).
5. **Email service** — pick SendGrid / Resend / ConvertKit, paste templates from `/emails/`.
6. **Before launch** — delete `api/billing/crypto-webhook-test.js`.
