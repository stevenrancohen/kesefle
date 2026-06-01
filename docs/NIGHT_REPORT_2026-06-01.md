# Night Report — Autonomous Kesefle Work, 2026-06-01

Generated for Steven, first thing in the morning. Hebrew terms inline; everything else ASCII.

---

## 1. TL;DR (one screen)

Tonight I opened **8 PRs** (including this report PR #197 and the classifier PR #199). All are
**gate-green** (full QA + bot suites + security on the night diffs). **NOTHING was merged, and NOTHING was applied to your live sheet** — every
deploy, every sheet write, and every config change is left for you. That is deliberate: your
standing rule is backup-first, propose-before-apply, and never touch the live financial sheet
while you can't approve it.

QA status: **full_qa 122/122, 32/32 bot suites, golden set 95.3%, security clean** on every
night diff. Every bot branch reassembles byte-identical with exactly one `doPost`.

**The 7 things you must do in the morning, in order:**

1. **Merge the web PRs** — #191 (+ #188 webhook). They auto-deploy on Vercel. Do these first.
2. **Merge the bot PRs** — #187 + #189 + #199 — then do **ONE** re-paste of
   `bot/ExpenseBot_DEPLOY.gs` -> Deploy -> New Version (the single re-paste bundles all three
   bot PRs).
3. **Add KV creds + reclaim Script-Property slots** — add `VERCEL_KV_REST_URL` +
   `VERCEL_KV_REST_TOKEN` to the bot Script Properties if missing, run `KV_SELFTEST` (expect
   `KV OK`), then run `MIGRATE_BOT_STATE_TO_KV` (dry, then real).
4. **Finish the SHEET migration you started** — run `MOE_MIGRATE_OLD_OPEX` (dry->APPLY) +
   `MIGRATE_OLD_PERSONAL` (dry->APPLY) + `FIX_ORDERS_HEADERS`. **This is the step that drops
   historical company net from gross to real** (e.g. 2023: from ₪113,631 gross to ₪24,472).
5. **Add the new tools file** `bot/MAAZAN_SRC_TOOLS.gs` (PR #190) to the tools project and run
   `FOM_` -> `ES2_` -> `FMC_` (each: DRY_RUN -> set `CONFIRM_<NAME>='YES I UNDERSTAND'` ->
   APPLY). Fixes the cross-year leak, wires עסק-2 (SRC) income, and the orphan marketing row.
6. **Optional config:** set `STRICT_WEBHOOK_VERIFY=1` on the bot.
7. **Review the safe open PRs** to merge: #172, #166, #123, #107, #106, #85 — plus the design
   specs PR #196.

---

## 2. The morning run-sheet (numbered, exact)

Do these in order. Steps (a)-(b) are deploys; (c)-(e) are the sheet/KV migrations; (f)-(g) are
optional/cleanup.

### (a) Merge the web PRs first (auto-deploy)
1. Merge **#191** (admin light-first + FAQ JSON-LD brand typo + welcome toast contrast +
   pricing footer).
2. Merge **#188** (webhook: canonicalize the dead corrupt-column write in
   `api/whatsapp/webhook.js`).
3. Both auto-deploy via Vercel on push to main. No manual deploy needed.

### (b) Merge the bot PRs, then ONE re-paste
1. Merge **#187** (per-user state -> KV; completes #186; adds gated `MIGRATE_BOT_STATE_TO_KV`
   + `KV_SELFTEST`).
2. Merge **#189** (`יעד חדש` -> ₪1 hijack fix + `ביטוח אישי` mis-route fix + safe keywords).
3. Merge **#199** (classifier accuracy: 9 Hebrew mis-routes fixed, incl. the `החזר מעמ`
   VAT-refund P&L sign-flip).
4. After **all three** are merged, reassemble `bot/ExpenseBot_DEPLOY.gs` from main **once** and
   do a **single** re-paste into Apps Script -> **Deploy -> New Version**. One paste covers
   #187 + #189 + #199.

### (c) KV creds + reclaim Script-Property slots
1. In the **bot** Script Properties, add `VERCEL_KV_REST_URL` + `VERCEL_KV_REST_TOKEN` if they
   are missing. Pull the values from Vercel's `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
2. Run `KV_SELFTEST` -> expect `KV OK`.
3. Run `MIGRATE_BOT_STATE_TO_KV` in **dry** mode first, confirm the plan, then run it for real.
   This moves `welcomed` / `surveyed` / `fxcel` / `leadNotified` per-user state out of Script
   Properties into KV and frees the Script-Property slots.

### (d) Finish the SHEET migration you started
Run these in the tools project (each gated DRY_RUN first, then APPLY):
1. `MOE_MIGRATE_OLD_OPEX` — dry -> APPLY.
2. `MIGRATE_OLD_PERSONAL` — dry -> APPLY.
3. `FIX_ORDERS_HEADERS` — relabels the stale הזמנות header row (cosmetic; dashboards already
   read the right columns).

**Why this matters:** right now there are **zero** `col-D='עסק'` opex rows for 2023/2024/2025
in תנועות (all 24 עסק rows are 2026). So the live historical company net is still
**revenue minus COGS = GROSS**: 2023 ₪113,631 / 2024 ₪119,041 / 2025 ₪58,816. Running `MOE`
adds the historical opex and drops net to the **real** numbers (2023 ₪24,472 / 2024 ₪65,658 /
2025 ₪7,350). The "verified" figures you saw earlier were the post-MOE simulation, not the
live sheet.

### (e) Add the new tools file + wire the multi-business fixes (PR #190)
1. Add the **new** file `bot/MAAZAN_SRC_TOOLS.gs` to the tools project. (It is a separate
   standalone tools project — do not paste it into the bot project, or you will duplicate
   functions and break the bot's compile.)
2. Run, in this order, each DRY_RUN -> set `CONFIRM_<NAME>='YES I UNDERSTAND'` -> APPLY:
   - `FOM_` — fixes the orphan 2026 marketing row (תנועות r545: col-D=`עסק` but col-E literal
     `עסק`, so the ~₪1,514 of Facebook marketing matches no R9 keyword and is undercounted).
   - `ES2_` — wires עסק-2 (SRC) realized net P&L into the empty הכנסה-3 row in מאזן אישי (reads
     תנועות col E `הכנסה 2 — עסק SRC` by `$B$2`; no row insert).
   - `FMC_` — fixes the cross-year leak: rewires מאזן אישי company-income to compute company net
     by `$B$2` directly, decoupling it from עסק תמונות's own `$B$4`.

### (f) Optional config
- Set `STRICT_WEBHOOK_VERIFY=1` on the bot (webhook hardening; config-only, no redeploy).

### (g) Review the safe open PRs to merge
- **#172** (DIAGNOSE_BALANCES), **#166** (bot tests), **#123 / #107 / #106 / #85** (.md
  skills/docs) — all safe.
- **#196** — design specs for the Bot-Intelligence epic (docs only; review at your pace).

---

## 3. What each PR does (one line each)

- **#187** — bot: per-user state -> KV (completes #186) + gated `MIGRATE_BOT_STATE_TO_KV` +
  `KV_SELFTEST`. Needs a bot re-paste.
  https://github.com/stevenrancohen/kesefle/pull/187
- **#188** — webhook: canonicalize the dead corrupt-column write in `api/whatsapp/webhook.js`.
  Auto-deploys.
  https://github.com/stevenrancohen/kesefle/pull/188
- **#189** — bot: `יעד חדש` -> ₪1 hijack fix + `ביטוח אישי` mis-route fix + safe keywords.
  Needs a bot re-paste (bundled with #187).
  https://github.com/stevenrancohen/kesefle/pull/189
- **#190** — tools: NEW file `bot/MAAZAN_SRC_TOOLS.gs` (`FMC_` cross-year leak + `$B$2` company
  net, `ES2_` SRC P&L wiring, `FOM_` orphan marketing row). 3/3 financial + safety + blast
  gates. You add the file and run DRY_RUN -> APPLY.
  https://github.com/stevenrancohen/kesefle/pull/190
- **#191** — web: admin light-first + FAQ JSON-LD brand typo + welcome toast contrast + pricing
  footer. Auto-deploys.
  https://github.com/stevenrancohen/kesefle/pull/191
- **#196** — docs: design specs for the Bot-Intelligence epic. Docs only, no code.
  https://github.com/stevenrancohen/kesefle/pull/196
- **#199** — bot: classifier accuracy — golden 95.3% -> 95.7%, 9 real Hebrew mis-routes fixed
  (most important: VAT-refund `החזר מעמ` was booked as a company EXPENSE instead of revenue — a
  P&L sign-flip — now revenue; plus מגדל insurance, בוסט לפוסט -> marketing, משפיען, בית ספר ->
  חינוך, דמי טיפול רפואי -> בריאות, בקבוק יין -> food). Never-corrupt floor untouched.
  **BOT** — bundles into the same re-paste as #187/#189.
  https://github.com/stevenrancohen/kesefle/pull/199

---

## 4. Live-sheet truth (what is actually on the sheet right now)

- **MOE not yet applied -> net still shows GROSS.** There are zero `col-D='עסק'` opex rows for
  2023/2024/2025 in תנועות (all 24 עסק rows are 2026, totaling ₪10,978). Live historical net =
  revenue minus COGS only: 2023 ₪113,631 / 2024 ₪119,041 / 2025 ₪58,816. Running `MOE` in step
  (d) drops these to the real 2023 ₪24,472 / 2024 ₪65,658 / 2025 ₪7,350.
- **Cross-year leak (real bug, #272).** מאזן אישי `B2`=2026, but its company-income row R6 =
  `='עסק תמונות'!C13:N13`, which reflects עסק תמונות's **own** `B4` (currently 2023). So the
  2026 personal balance is mixing in ₪113,631 of 2023 company net. Fixed by `FMC_` in step (e).
- **Orphan ₪1,514 2026 marketing row.** תנועות r545 has col-D=`עסק` but col-E literally `עסק`
  (detail `עסק - שיווק פייסבוק`); it matches no R9 keyword, so 2026 marketing is undercounted
  (~₪8,833 true vs ₪7,319 shown). Fixed by `FOM_` in step (e).
- **What already LANDED earlier (for context):** orders migration (הזמנות 31 -> 369 rows,
  +338) and the dashboard COGS/de-leak formulas (MFB) are already live and confirmed in the
  live formulas. Revenue reads col G, COGS reads col F; the header labels are stale but the
  formulas read the right columns.
- **עסק-2 (SRC) decisive finding:** SRC is a **crypto-arbitrage trading** business, not an
  orders business. Its only live footprint is monthly realized **net** P&L in תנועות
  (col D=`הכנסות`, col E=`הכנסה 2 — עסק SRC`, em-dash), 23 months 2024-02..2026-02 (2024
  ₪50,516 / 2025 ₪15,158 / 2026 ₪9,300; can be negative). No dashboard or orders log needed —
  just the income row `ES2_` wires in step (e).

---

## 5. Deferred / needs your decision

These are NOT done and are waiting on a call from you:

- **#193** — weekly proactive cron (a scheduled "here's your week" message). Product decision.
- **#194** — Sonnet tier + per-user context for the bot (smarter LLM). Cost/quality decision.
- **The 11 dashboard-routing row renames** — would touch your hand-built sheet directly. Either
  do them through gated tools or call it yourself; I did not auto-apply.
- **Tab cleanup** — consolidating/removing legacy tabs. Deferred (future).
- **10x visual P&L dashboard** — the bigger redesign of the dashboard visuals. Deferred (future).
- **#187 convenience wrapper** — a `MIGRATE_BOT_STATE_TO_KV_APPLY` one-call wrapper is still a
  TODO; for now use dry-then-real on `MIGRATE_BOT_STATE_TO_KV`.
- **Per-user keys still in Script Properties** — gender / need / settings per-user keys are not
  yet migrated to KV (only welcomed/surveyed/fxcel/leadNotified are, via #187). Follow-up.
- **Classifier residuals (PR #199 audit)** — bare `מגדל` (sits in both the electronics PC-tower
  row AND the insurance row) and bare `ksp` (home-maintenance AND electronics) mis-route on the
  bare word; the correct fix is REMOVING the polluting token from the wrong row (not additive),
  so it is left for your approval.

---

## 6. QA / Security sign-off

GREEN across `origin/main` and all 4 night branches:

- **full_qa: 122/122**
- **bot suites: 32/32**
- **golden set: 95.3%**
- **test suites: 14/14**
- **Security: clean on the night diffs** (secrets, tenant isolation, auth, CORS, rate limits —
  no reds).
- Every bot branch node-checks, has exactly **one `doPost`**, has `KFL_BUILD_VERSION` bumped,
  and `bot/ExpenseBot_DEPLOY.gs` **reassembles byte-identical** from `ExpenseBot_FIXED.gs`.

No reds anywhere. Nothing in this report has been applied or merged — it is all yours to
execute in the morning.
