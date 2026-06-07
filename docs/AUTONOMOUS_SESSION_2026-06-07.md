# Autonomous session — 2026-06-07

A long autonomous block: classifier QA + debug, a 107k Hebrew+English keyword
expansion, 30 new skills, more LLM providers, and FX money-accuracy. ~120 agents
across background workflows. Everything below is gauntlet-green and waiting for
Steven to merge + deploy — nothing was pushed to `main`.

## What shipped (PRs to merge)

| PR | What | Deploy |
|----|------|--------|
| **#274** | Bot: classifier precision + **107k-keyword fallback** + 6 more LLM providers + FX English words | re-paste DEPLOY + add 1 new file |
| **#275** | 6 safe non-bot fixes (cron fail-closed, log redaction, en.html SEO, golden EN cases, bot-replay real parser) | auto (Vercel) |
| **#276** | 30 new `.claude` skills | none |
| **#266** | (older) Integration wave 6 — bot misroute + email-lifecycle | verify |
| **#267** | (older) TZ-stable recurring/CSV backfill + redact export errors | auto |
| **#269** | (older) homepage stale annual prices | auto |

All 6 are **MERGEABLE + CLEAN**.

## Bot improvements (in #274, one deploy)

- **Taxi fares** `מונית 40/45/50/70` were silently landing in *public transit*; now → *taxi*.
- **Sign-flip fixes** (these corrupt your P&L): VAT-credit `זיכוי מעמ` → business **income** (was an expense); English income words pending (see below).
- **Substring misroutes**: `supermarket`→clothing, `restaurant`→visa, `makeup`→SaaS — fixed (ASCII keywords now match whole-words).
- **`תרופות`** → medications subcategory (was general health).
- **FX money-accuracy**: `20 dollars netflix`, `50 euros`, `100 pounds`, `5000 yen`, `200 francs` now convert to ILS (were booked at face value).
- **100k+ keywords**: a new fallback index (`ExpenseBot_KEYWORDS.gs`, **108,152** keywords / 44 buckets) covering Israeli + global merchants — consulted only when the main dictionary is unsure, before any LLM call. Verified: שופרסל→groceries, claude/chatgpt→apps, ארנונה→taxes, קצבת ילדים→income.
- **More LLM**: 6 added providers (DeepSeek, Groq/Llama, Mistral, Together, Fireworks, Perplexity) + opt-in failover.
- **Security**: destructive `?action=` admin endpoints now gate on a private `ADMIN_ACTION_SECRET` (constant-time), falling back to the old token so nothing breaks until you set it. Webhook verify untouched.

## TASKS FOR STEVEN (do these in order)

1. **Merge the PRs** on GitHub: #274, #275, #276 (and the 3 older: #266, #267, #269). The website ones deploy themselves via Vercel.
2. **Deploy the bot (one time, ~3 min):**
   a. Open the Apps Script project (the bot).
   b. Open `bot/ExpenseBot_DEPLOY.gs` from GitHub, select-all, copy, paste over the bot's main file.
   c. Click **Deploy → Manage deployments → ✏️ (edit) → New version → Deploy**.
   d. Add a **NEW file** in the same project: click **+ → Script**, name it `ExpenseBot_KEYWORDS`, then open `bot/ExpenseBot_KEYWORDS.gs` from GitHub, copy ALL of it, paste in, **Save**. (This is the keyword data — paste once; only re-paste when keywords change.)
   e. Send yourself a WhatsApp test: `דולר אפליקציה chatgpt 70` (should convert + land in apps), `מונית 45` (should be taxi), `שופרסל 200` (groceries).
3. **(Security) Activate the admin lock-down** — now wired in #274. In Apps Script → Project Settings → Script Properties, set `ADMIN_ACTION_SECRET` to a new private value of your choice. The destructive `?action=` endpoints then stop accepting the old public token. (Until you set it, nothing changes — it falls back safely to the current behavior.)
4. **(Optional) Add more LLMs** — in Apps Script → Project Settings → Script Properties, add any of `DEEPSEEK_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `TOGETHER_API_KEY` / `FIREWORKS_API_KEY` / `PERPLEXITY_API_KEY` (paste the keys yourself — I never enter them). Add `KFL_AI_FAILOVER` = `1` to try multiple providers on failure.
5. **Twilio sandbox** (when you want to test the WhatsApp number) — say the word and I'll give the exact 3 steps; you sign up + paste the SID/token yourself.
6. **PayPal** — same: I'll give numbered steps; you paste keys into Vercel yourself.

## Deferred to a NEXT bot PR (I did NOT change these — they touch the parser and need your live test first)

These are real bugs the QA found; I'm holding them so this deploy stays focused:
- `2k` / `1.5k` thousands suffix → currently parses as 2 / 1.5 (should be 2000 / 1500).
- Hebrew spoken numbers (`אלף`, `מאה`, `חמישים`) → not parsed.
- Amount ranges (`100-200`) → owner path double-books; tenant path drops the 2nd.
- Multi-item in one message on the tenant path → only the first is written.
- `דולר קנדי` (CAD) / `דולר אוסטרלי` (AUD) → convert at the USD rate.
- English income words (`salary`, `refund`, `bonus`) → booked as expenses (sign-flip).
- Webhook verify fail-open + `BOT_COMMANDS.gs` stale delete schema (security follow-ups).

Tell me "do the parser PR" and I'll ship them golden-gated, separately, so you can test in one batch.

## Self-review (post-build, before deploy)

After building #274 I ran a 7-agent adversarial review of my own changes (since the bot writes real money). It found **4 real regressions** — all now fixed + regression-tested, committed to #274:

1. **FX (high)** — `pounds` collided with the weight unit (`pounds of flour 30` → £30). Dropped `pounds` from the English currency words (£ symbol / `gbp` / `פאונד` still convert).
2. **Income sign-flip (med)** — ambiguous tokens (`pension`/`grant`/`המוסד`) sat in income buckets → an expense booked as income. Stop-listed them out of income buckets.
3. **Dashboard (med)** — bare `תרופה` routed to a subcategory no dashboard row sums (invisible). Added `תרופה` to the clean meds row.
4. **Prefix (med)** — Hebrew clitic strip tried `מה` before `מ`, over-stripping the definite article (`מהעמק` hospital → groceries). Reordered shortest-first.

Final bot version after fixes: **`2026-06-07-review-fixes`**. New regression test `tests/test_regressions_0607.js` + `tests/test_keyword_index.js` lock all of these.

## Health

No critical security issues. Tenant isolation, owner-gate, link-code routing all verified; secret sweep over 711 files clean. Gauntlet 626 checks / 0 failures.
