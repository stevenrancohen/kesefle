# Progress digest

Rolling catch-up log of autonomous work. (KV `agent_digest:{ts}` isn't writable
from the dev environment without KV creds, so this repo doc + the git log are
the persistent record. Newest first.)

---

## 2026-05-22 (later) — brand consistency + phase reality-check

**Standing rule recorded:** the brand name is **always כספ'לה**. Fixed every
*display* occurrence: logo `alt` site-wide (38), the compare-page H3 heading,
meta descriptions (admin/offline/index/test), the admin activity feed, and the
bot's user-facing greetings/group-help/persona. **Intentionally NOT changed:**
command keywords like "כספלה צור משפחה" (users type them without the geresh) and
SEO alternate-name lists. Build stamped `2026-05-22-brand-3`.

**Phase reality-check vs the latest plan:**
- Recurring expenses (Phase 1): **already built + hardened** — not rebuilt.
- Timeline page (Phase 6): **already exists** (`timeline.html`).
- Voice transcription / Receipt OCR / Gmail parsing / Stripe portal / Resend
  emails / Pinecone AI (Phases 4-5,8): **need Steven's API keys/accounts** —
  cannot build without them (won't create accounts on his behalf).
- 20 location pages + "3 blog posts/day" (Phase 2): **declining the mass-gen
  version** — Google's 2024 spam policy penalizes doorway/near-duplicate pages.
  Building a few genuinely-unique pages instead is fine.
- New free tool shipped: `/tools/subscription-calculator`.

### Action for Steven
**Steven: redeploy the bot** (Gemini fix + brand display): paste
`bot/ExpenseBot_DEPLOY.gs` → Save → Deploy → New Version → message `בדיקה`
(should show `גרסה: 2026-05-22-brand-3`).

## 2026-05-22 — autonomous session (security audit + growth)

**Build state:** green throughout — 143 checks pass (68 classify + 23 parser +
18 isolation + 34 QA). All commits pushed; Vercel auto-deploys.

**Security / GDPR (verified against real code before fixing):**
- Account deletion now revokes the Google grant for **encrypted-token** users
  (was plaintext-only) and purges leftover `token:{sub}` / `profile:` /
  `recurring:` keys.
- Stopped logging the 6-digit WhatsApp link code.
- `admin/stats.js`: constant-time token compare + fail-closed.
- Recurring cron logs loudly if the canonical-sheet leak-guard ever drops a write.
- Per-phone write rate-limit on `/api/sheet/append`.
- QA regression guards added so none of the above can silently revert.

**Accessibility (WCAG 2.1 AA):** account.html `<h1>` + input aria-labels;
`prefers-reduced-motion` across account/welcome + all 6 tool pages; 100% of
`target="_blank"` links now carry `rel="noopener"`.

**Performance / SEO:** font preconnect site-wide; fixed a sitemap↔robots
conflict (`/automations`); **new tool: `/tools/subscription-calculator`**
(מחשבון מנויים) — interactive, schema'd, wired into sitemap + tools index.

**Bot:** Gemini multi-model fallback + `בדיקה` self-check that reports the exact
error. **Waiting on Steven to redeploy the bot** to activate the concierge.

**Verified NOT live bugs (do not "fix" blindly):** cookie-auth name mismatch
(frontend uses Bearer — works), `api/whatsapp/webhook.js` write path (dead
fail-closed scaffolding). See `docs/AUDIT_2026-05-21.md`.

**Deferred (needs human/visual):** color-contrast pass on light-gray body text.

### Action for Steven
1. **Redeploy the bot** to turn on the Gemini brain: paste `bot/ExpenseBot_DEPLOY.gs`
   → Save → Deploy → New Version → message `בדיקה`.
2. Decide if `/automations` should be indexed (currently hidden in robots.txt).
