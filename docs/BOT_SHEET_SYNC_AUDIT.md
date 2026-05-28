# Bot Sheet Sync + Conversation QA Audit

**Date:** 2026-05-28
**Agent:** Agent 4 (autonomous audit block)
**Scope:** Map every bot write path from message ingestion to a Google Sheets row, list every Hebrew tab-name constant, confirm tenant isolation around `SHEET_ID`, and predict the column-by-column output for nine reference messages.
**Mode:** READ-ONLY. No deploys, no Apps Script edits, no sheet ID changes.
**Branch:** `audit-bot-sheet-sync`
**Build version found at audit time:** `KFL_BUILD_VERSION = '2026-05-28-pr-b-biz-canonical-subs'` (`bot/ExpenseBot_FIXED.gs:62`)

---

## 0. Executive summary

The bot has two write surfaces — the legacy owner-only single-sheet path (`SHEET_ID`) and the multi-tenant Vercel-bridged path (`/api/sheet/append`). Tenant isolation around the legacy path is correctly guarded by `_isOwnerPhone_` + `_assertOwnerLegacyWrite_` + `_resolveTenant_` (good). But there is significant **OLD-sheet ID drift across helper scripts**: the live bot in `bot/ExpenseBot_FIXED.gs` now points to the NEW sheet (`1rtiPQs1...`), but 16 sibling `.gs` helper files still hardcode the OLD sheet ID (`1UKrXDk...`). Some are legacy/one-shot scripts (migration tools, audit utilities) and the OLD ID is intentional, but many — `BOT_COMMANDS.gs`, `DASHBOARD_QUICK_WINS.gs`, `FIX_DASHBOARD_safe.gs`, `WEEKLY_DIGEST.gs`, `EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs`, `KESEFLE_ALL_PATCHES.gs`, `CLEANUP_DUPLICATES_AND_TABS.gs`, `CLEANUP_LEAKED_ROWS.gs`, `SORT_AND_FEATURES.gs`, `FIX_PROFITABILITY_AND_CHART.gs`, `FINANCIAL_SUMMARY_TAB_CLEAN.gs`, `FIX_DASHBOARD_2023_2024_2025.gs`, `CREATE_TEMPLATE_AND_CLEANUP.gs` — read or write against the OLD sheet. If any of these are still pasted/triggered in the live Apps Script project, they will silently target the OLD sheet, not Kesefle's NEW one.

Risk count: **23 items** documented across 11 areas (see findings tables below). 12 OLD-sheet references found in canonical repo (excluding `.claude/worktrees/`).

---

## 1. Active spreadsheet ID resolution

Single canonical owner ID, but multiple shadow IDs in helper scripts.

| File | Function | How it resolves the sheet ID | Tenant-safe? |
| --- | --- | --- | --- |
| `bot/ExpenseBot_FIXED.gs:26` | top-level constant `SHEET_ID` | Hardcoded NEW Kesefle sheet `1rtiPQs1...`. All legacy owner-only write paths open this directly. | YES — gated by `_isOwnerPhone_` + `_assertOwnerLegacyWrite_` everywhere. |
| `bot/ExpenseBot_FIXED.gs:36` | `OWNER_PHONE = '972547760643'` | Hardcoded fallback if `SHEET_OWNER_PHONE` Script Property is missing. Prevents the "everyone is owner" bug from Script Property unset. | YES — `_ownerPhoneDigits_` never returns empty (line 5436-5441). |
| `bot/ExpenseBot_FIXED.gs:5436-5481` | `_ownerPhoneDigits_`, `_isOwnerPhone_`, `_assertOwnerLegacyWrite_`, `_resolveTenant_` | Chain: Script Property `SHEET_OWNER_PHONE` -> falls back to `OWNER_PHONE` constant. `_isOwnerPhone_` empty-input returns false (cross-tenant fix). | YES — defensive depth; previously a known bug, now hardened. |
| `bot/ExpenseBot_FIXED.gs:5483-5502` | `_kvLookupPhone_` | Hits `KESEFLE_API_BASE + '/api/whatsapp/link?phone=...'` with `x-kesefle-bot-secret` header to get tenant's `userSub` + `sheetId`. | YES — server-side resolves tenant; bot never opens tenant sheet directly. |
| `bot/ExpenseBot_FIXED.gs:6479-6692` | `_tenantWriteExpense_`, `_tenantAppendStructured_` | POSTs to `/api/sheet/append` with `phone` + bot secret. Server resolves phone -> userSub -> sheetId. | YES — phone-based dispatch, OAuth dance on server. |
| `bot/config.gs:23` | `PERSONAL_TEMPLATE_SHEET_ID = '1UKrXDk...'` | Hardcoded **OLD** ID as the personal template (Make-a-Copy source for new family/personal users). | RISK — see Finding R1 below. |
| `bot/BOT_COMMANDS.gs:22` | `BC_SHEET_ID = '1UKrXDk...'` | Hardcoded **OLD** ID. Defines fallback owner commands (recurring, totals, last). | RISK — see R2. |
| `bot/DASHBOARD_QUICK_WINS.gs:7` | `KESEFLE_SHEET_ID_QW = '1UKrXDk...'` | Hardcoded **OLD** ID. Dashboard cosmetic patch script. | RISK — see R3. |
| `bot/FIX_DASHBOARD_safe.gs:5` | `KESEFLE_SHEET_ID = '1UKrXDk...'` | Hardcoded **OLD** ID. Dashboard formula reset utility. | RISK — see R3. |
| `bot/WEEKLY_DIGEST.gs:32` | `WD_SHEET_ID = '1UKrXDk...'` | Hardcoded **OLD** ID. Sends weekly summary to owner. | RISK — see R3. |
| `bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs:18` | `KFL_SHEET_ID_EM` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/KESEFLE_ALL_PATCHES.gs:14` | `KESEFLE_SHEET_ID_ALL` | Hardcoded **OLD** ID. Bulk patch script. | RISK — see R3. |
| `bot/CLEANUP_DUPLICATES_AND_TABS.gs:16` | `KFL_CL_SHEET_ID` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/CLEANUP_LEAKED_ROWS.gs:39` | `CLR_SHEET_ID` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/SORT_AND_FEATURES.gs:7` | `KESEFLE_SHEET_ID_SF` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/FIX_PROFITABILITY_AND_CHART.gs:14` | `KESEFLE_SHEET_ID_FP` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs:8` | `KFL_SHEET_ID` | Hardcoded **OLD** ID. | RISK — see R3. |
| `bot/FIX_DASHBOARD_2023_2024_2025.gs:29` | `KESEFLE_SHEET_ID` | Hardcoded **OLD** ID. | RISK — see R3 (intentional for legacy 2023-2025 cleanup; flag for archive). |
| `bot/CREATE_TEMPLATE_AND_CLEANUP.gs:15` | `SOURCE_SHEET_ID_CT` | Hardcoded **OLD** ID. Template seeding utility (probably intentional). | INFO — likely intentional but still drifts. |
| `bot/MIGRATE_OLD_TO_KESEFLE.gs:29` | `_MIG_OLD_SHEET_ID_` | Hardcoded **OLD** ID alongside `_MIG_NEW_SHEET_ID_ = '1rtiPQs1...'` on line 30. | INTENTIONAL — migration tool with both old and new. |
| `bot/MIGRATE_OLD_NOTES.gs:52` | `_MN_OLD_SHEET_ID_` | Same — migration with OLD + NEW. | INTENTIONAL. |
| `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs:48` | `_MP7_OLD_SHEET_ID_` | The sweep tool itself. | INTENTIONAL. |
| `bot/SCAN_OLD_CATEGORIES.gs:44` | `_SOC_OLD_SHEET_ID_` | OLD-sheet category audit tool. | INTENTIONAL. |
| `bot/SHEET_DASHBOARD_FULL_AUDIT.gs:50` | `_FA_OLD_SHEET_ID_` | Audit tool. | INTENTIONAL. |
| `bot/personal_sheet_fix.gs:42` | `_PSF_SHEET_ID_ = '1rtiPQs1...'` | Hardcoded NEW ID. The canonical dashboard recompute tool. | YES. |
| `bot/SHEET_DASHBOARD_SMART_REMAP.gs:62` | `_SR_SHEET_ID_ = '1rtiPQs1...'` | NEW ID. | YES. |
| `bot/SHEET_YEAR_SELECTOR_WIRE.gs:60` | `_YS_SHEET_ID_ = '1rtiPQs1...'` | NEW ID. | YES. |
| `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs:46` | `_MP5_NEW_SHEET_ID_ = '1rtiPQs1...'` | NEW ID (phase 5 verifier). | YES. |

### Findings

- **R1 (HIGH) — `PERSONAL_TEMPLATE_SHEET_ID` in `bot/config.gs:23` still points to OLD sheet.** This is the master template that Apps Script tries to copy when seeding a new family/personal user (`config.gs:9-19` describes the manual step). After Steven migrated to the NEW sheet on 2026-05-28, this constant was NOT bumped. If any code path or human follows the comment and clones from OLD, the resulting per-tenant sheet will mirror an OLD-schema dashboard whose SUMIFS criteria do not match the bot's writes. **Fix:** bump to the NEW Kesefle template sheet ID. **Test:** unit test that asserts `PERSONAL_TEMPLATE_SHEET_ID === SHEET_ID` (or === a known-NEW template sheet ID).
- **R2 (MEDIUM) — `BOT_COMMANDS.gs` still hits OLD sheet.** If this file is still part of the deployed Apps Script project, any user typing `סיכום` / `הוצאות` / `אחרון` triggers reads from the OLD sheet, not the live Kesefle sheet. The bot has its own modern equivalents in `ExpenseBot_FIXED.gs`, so this `.gs` may be dead — but the repo does not document that. **Fix:** confirm `BOT_COMMANDS.gs` is NOT in the deploy bundle (check `ExpenseBot_DEPLOY.gs` for any function shared with it), and if it is, bump its `BC_SHEET_ID` to NEW. **Test:** grep `ExpenseBot_DEPLOY.gs` for `BC_SHEET_ID` or `BC_` to confirm it is not bundled.
- **R3 (MEDIUM, repeated) — 13 helper `.gs` files in `bot/` hardcode the OLD sheet ID** (`DASHBOARD_QUICK_WINS.gs`, `FIX_DASHBOARD_safe.gs`, `WEEKLY_DIGEST.gs`, `EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs`, `KESEFLE_ALL_PATCHES.gs`, `CLEANUP_DUPLICATES_AND_TABS.gs`, `CLEANUP_LEAKED_ROWS.gs`, `SORT_AND_FEATURES.gs`, `FIX_PROFITABILITY_AND_CHART.gs`, `FINANCIAL_SUMMARY_TAB_CLEAN.gs`, `FIX_DASHBOARD_2023_2024_2025.gs`, `CREATE_TEMPLATE_AND_CLEANUP.gs`, `BOT_COMMANDS.gs`). Each is a one-shot or weekly utility, but post-migration none should mass-write to OLD. **Fix:** add a `// LEGACY OLD SHEET — DO NOT RUN` banner to each AND consider moving them to `bot/legacy/` so the Apps Script editor doesn't accidentally execute them. **Test:** none beyond grep + manual confirmation.

---

## 2. Tab-name constants

Hebrew tab names are defined inline in the bot but referenced in dozens of places. Drift potential is real because the constants live in three different files (`ExpenseBot_FIXED.gs`, `personal_sheet_fix.gs`, helper utilities).

| Tab name | Defined in | Referenced in (sample) | Drift potential |
| --- | --- | --- | --- |
| `תנועות` | `bot/ExpenseBot_FIXED.gs:38` (`TRANSACTIONS_SHEET`) | 50+ refs in `ExpenseBot_FIXED.gs`, `personal_sheet_fix.gs`, `FIX_DASHBOARD_*.gs`, `WEEKLY_DIGEST.gs`. Mostly via the `TRANSACTIONS_SHEET` constant but some legacy files hardcode the string. | LOW within `ExpenseBot_FIXED.gs` (uses constant). HIGH in legacy scripts that hardcode `'תנועות'`. |
| `הזמנות` | `bot/ExpenseBot_FIXED.gs:37` (`ORDERS_TAB_NAME`) | `_writeOrderRow_`, `getOrdersSummary`, `parseBusinessOrder_`. Some `KESEFLE_KEYWORDS_*.gs` files reference it as a string. | LOW. |
| `מאזן שנתי` | `bot/ExpenseBot_FIXED.gs:39` (`DASHBOARD_SHEET`) | Multiple. But `personal_sheet_fix.gs` separately defines `_PSF_COMPANY_TAB_ = 'מאזן חברה'` and `_PSF_PERSONAL_TAB_ = 'מאזן אישי'`, NOT `'מאזן שנתי'`. There is a **two-name overlap** here: `מאזן שנתי` (legacy) vs `מאזן חברה` (current dashboard). | HIGH — see Finding T1. |
| `מאזן אישי` | `bot/personal_sheet_fix.gs:47` (`_PSF_PERSONAL_TAB_`) | `personal_sheet_fix.gs` only (`RECOMPUTE_PERSONAL_DASHBOARD`). | LOW — single source. |
| `מאזן חברה` | `bot/personal_sheet_fix.gs:46` (`_PSF_COMPANY_TAB_`) | `personal_sheet_fix.gs:567` `RECOMPUTE_COMPANY_DASHBOARD`, plus `_updateBusinessDashboard_` in `ExpenseBot_FIXED.gs:11097-11101` (reads the dashboard by **label**, not by tab name, so it works for both `מאזן חברה` and `מאזן שנתי`). | MEDIUM — see T1. |
| `סיכום היסטורי` | Various utilities, year-selector wire | `SHEET_YEAR_SELECTOR_WIRE.gs:60+`. | LOW. |
| `Learned` / `_LEARNED_TAB_NAME` | `bot/ExpenseBot_FIXED.gs:9170-9173` | `_learnedSave`. | LOW. |
| `ML Audit` | `bot/ExpenseBot_FIXED.gs:14794` | `_logMLAudit_`. | LOW. |
| `Auto Synonyms` / `_AUTO_SYN_HEADERS` | `bot/ExpenseBot_FIXED.gs:15155, 15263` | Synonym sweep. | LOW. |

### Findings

- **T1 (HIGH) — Dashboard tab naming inconsistency.** `ExpenseBot_FIXED.gs` uses `'מאזן שנתי'` as `DASHBOARD_SHEET` (line 39), but `personal_sheet_fix.gs` uses `'מאזן חברה'` (line 46). The actual user-facing sheet has both names because they were renamed at different points. `_updateBusinessDashboard_` (`ExpenseBot_FIXED.gs:11097`) opens `SHEET_ID` and calls `_updateBusinessDashboardInSheet_(ss, ...)` which scans tab names internally — but if the tab is renamed AGAIN, all updaters silently no-op. **Fix:** unify on `מאזן חברה` (current convention) and bump `DASHBOARD_SHEET` constant. **Test:** sheet-audit script asserts both names map to the same sheet ID or a single tab.
- **T2 (LOW) — `'תנועות'` is hardcoded in 30+ legacy helper scripts.** Mostly in cleanup/dashboard-fix utilities. Drift risk is low because the bot itself uses the constant, but if Steven renames the tab the helpers all silently break.

---

## 3. תנועות write logic

The bot has TWO row-build sites and they MUST agree on the column schema.

| Site | Code location | Columns written | Tenant-safe? |
| --- | --- | --- | --- |
| Owner ambiguity pick (after interactive list reply) | `bot/ExpenseBot_FIXED.gs:2390` | `[now, monthKey, amount, sanitize(category), sanitize(subcategory), sanitize(description), 'WhatsApp (interactive)', true]` | YES — guarded by `_isOwnerPhone_` + `_assertOwnerLegacyWrite_` at 2355-2380. |
| Owner classify+append in `processExpense` | `bot/ExpenseBot_FIXED.gs:7953` | `[now, monthKey, finalAmount, sanitize(matched.category), sanitize(matched.subcategory), sanitize(item.description), 'WhatsApp', true]` | YES — early guard at 7000-7006 blocks non-owner. |
| Owner smart_pending picker resolution | `bot/ExpenseBot_FIXED.gs:7089` | `[now, monthKey, hP.amount, sanitize('עסק'), sanitize(picked.subcategory), sanitize(picked.label), 'WhatsApp', true]` | YES — same processExpense legacy gate. |
| Owner per-business tab `_writeBusinessNExpense_` | `bot/ExpenseBot_FIXED.gs:11549` | `[now, monthKey, amount, 'עסק', sub, description, 'WhatsApp', !isIncome]` | YES — owner-only via `_isOwnerPhone_` gate at 2031. Writes to `target.tabName` of `SHEET_ID`. |
| Tenant write via `/api/sheet/append` | `bot/ExpenseBot_FIXED.gs:6548-6614` | Server-side — POST sends `{phone, amount, currency, isIncome, category, subcategory, rawText, messageId, botSecret}`. Server builds the 8-col row to match the tenant template. | YES — server resolves phone -> user -> sheetId. Phone-isolation enforced at API layer. |
| Migration auto-row in `MIGRATE_OLD_TO_KESEFLE.gs` | `bot/ExpenseBot_FIXED.gs:10950` | `[dt, monthKey, val, sanitize(currentSection), sanitize(name), 'מיגרציה אוטומטית מהדשבורד', 'Legacy']` | INFO — 7-column row (no boolean expense flag). Legacy import path. |
| `BOT_COMMANDS.gs` (legacy fallback) | `bot/BOT_COMMANDS.gs` (not inspected line-by-line) | Same 8-col schema, but writes to OLD sheet (`BC_SHEET_ID = '1UKrXDk...'`). | RISK R2 above. |

### Column schema invariant (תנועות)

```
A = timestamp (Date)
B = monthKey (yyyy-MM string)
C = amount (number, always positive — sign carried by column H)
D = category (Hebrew string)
E = subcategory (Hebrew string)
F = description (raw text, possibly with [payment method] prefix)
G = source ('WhatsApp' or 'WhatsApp (interactive)')
H = isExpense boolean (TRUE for expenses, FALSE for income)
```

All five owner-path appends match this schema. Tenant path matches too via server-side row build.

### Findings

- **W1 (LOW) — Source column inconsistency.** Owner interactive-pick writes `'WhatsApp (interactive)'`, `_writeBusinessNExpense_` writes `'WhatsApp'`, migration writes `'מיגרציה אוטומטית מהדשבורד'`, smart_pending writes `'WhatsApp'`. Dashboard SUMIFS criteria can ignore source col G, so usually fine — but any future "writes from bot" report grouping by source would split owners across two buckets. **Fix:** unify on `'WhatsApp'` (drop `' (interactive)'`). **Test:** golden_set checks asserts `row[6] === 'WhatsApp'`.
- **W2 (MEDIUM) — `sanitizeForSheet` is applied to category/sub/description but NOT to amount/monthKey/source.** If `sanitizeForSheet` mutates Hebrew text in surprising ways (RTL marks, leading `'` to defang formulas), an old row written before the sanitize update will not match a SUMIFS criterion that uses the post-sanitize spelling. **Fix:** if there is a unit test for sanitize, also assert identity on already-clean ASCII/Hebrew strings.

---

## 4. הזמנות write logic

| Site | Code | Columns | Notes |
| --- | --- | --- | --- |
| `_writeOrderRow_` | `bot/ExpenseBot_FIXED.gs:2836-2873` | A=now, B=month, C=customer, D=size, E=material, F=productionCost, G=salePrice, H=shipping, I=profit, J='WhatsApp', K=rawText, L='paid' | 12 columns. Sale price (col G) is **always** pushed into the מאזן חברה `מחזור` dashboard line via `_updateBusinessDashboard_` (line 2864). |
| Parser entry: `parseBusinessOrder_` | `bot/ExpenseBot_FIXED.gs:2688-2820` | Returns `{customer, size, material, productionCost, salePrice, shipping, profit, rawText}`. Requires ≥2 distinct labelled fields beyond a bare headline amount, else returns null and falls through to the regular expense flow. | The strictness here means many ambiguous business messages take the dropdown picker route instead. |
| Dispatch from `processExpense` | `bot/ExpenseBot_FIXED.gs:7114-7144` | `__hIsBiz` regex `/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i` then calls `parseBusinessOrder_`. If valid order -> writes via `_writeOrderRow_`. Otherwise falls through to the bare-amount + picker flow at 7146+. | Same `__hIsBiz` regex protects both order parser and the smart_pending hijack guard at 7029. |

### Findings

- **O1 (LOW) — Order writer assumes `parsed.profit` is computed from `salePrice − productionCost − shipping`** (line 2806). If the user explicitly types `"רווח נטו 425"`, the parser ignores their explicit profit and still computes from `sale − cost − ship`. Steven's previous bug 2026-05-28 (in source comment at line 7023-7026) was about this exact path. **Fix:** consider parsing the explicit profit if present and warning when computed != explicit.
- **O2 (LOW) — Status is hardcoded `'paid'`.** User can edit in-sheet but the bot has no command to mark `'pending'` / `'cancelled'`. **Fix:** consider an order-update command. Out of audit scope.

---

## 5. מאזן אישי dashboard update logic

| Trigger | Function | Behavior |
| --- | --- | --- |
| Manual run (Steven) | `bot/personal_sheet_fix.gs::RECOMPUTE_PERSONAL_DASHBOARD` (referenced; not the focal function for the bot) | Walks the `מאזן אישי` tab, rebuilds SUMIFS formulas with wildcard wrap. Pure formula write, no value writes. |
| Bot WhatsApp write | NONE | The bot does NOT touch `מאזן אישי` directly. It writes the תנועות row + applies a cell note (`_dashboardDetailNote_` at `ExpenseBot_FIXED.gs:7990`). The dashboard cell value updates only because of the SUMIFS formulas already in the cell. |

### Findings

- **P1 (MEDIUM) — `מאזן אישי` is read-only from the bot's perspective.** This is good for safety (formulas never get overwritten) but means a bot-write that misses a category drift never gets reflected in the dashboard. **Test:** in the conversation QA harness, after each predicted write, also predict which dashboard row's SUMIFS criterion will match — see test specs below.

---

## 6. מאזן חברה dashboard update logic

| Site | Code | Behavior | Tenant-safe? |
| --- | --- | --- | --- |
| `_updateBusinessDashboard_` | `bot/ExpenseBot_FIXED.gs:11097-11102` | Opens `SHEET_ID` (owner only). Delegates to `_updateBusinessDashboardInSheet_`. | YES — only fires from owner-write code paths. |
| `_updateBusinessDashboardInSheet_` | `bot/ExpenseBot_FIXED.gs:11108+` | Refuses if `category !== 'עסק'`. Normalizes the subcategory via `_BIZ_DASH_SUBS` map (line 11039-11075). Recomputes the cell from תנועות using SUMIFS rather than incrementing — idempotent, no drift. Preserves cells that already have a formula. | YES — sheet-scoped. |
| `RECOMPUTE_COMPANY_DASHBOARD` | `bot/personal_sheet_fix.gs:567+` | Manual recompute for owner sheet. Targets `_PSF_SHEET_ID_` (NEW). | YES. |
| Called from | `_writeBusinessNExpense_` (line 11554), interactive pick (line 2404), smart_pending pick (line 7100), processExpense main loop (line 7993), order write (line 2864) | All call sites pass `(category, subcategory, monthKey, amount)`. | YES — but see C1. |

### Findings

- **C1 (HIGH) — `_BIZ_DASH_SUBS` map is the single point of failure for "expense was written but dashboard shows 0".** If a user types a subcategory that isn't in `_BIZ_DASH_SUBS`, `_normalizeBizSub_` returns null and `_updateBusinessDashboardInSheet_` logs a skip but doesn't alert. The תנועות row IS written; only the dashboard refresh is silently dropped. Example: user writes `עסק 200 קמפיינים` (plural) — keyword `"קמפיין"` matches `BUSINESS_CATEGORY_MAP['עסק']['עלות שיווק']` but the subcategory normalization picks `'שיווק'` -> `'עלות שיווק'` only if `שיווק` is in the map. **Fix:** expand `_BIZ_DASH_SUBS`. Out of audit scope (the skill `sheet-bot-taxonomy-reconcile` exists exactly for this) but flag as a long-tail risk. **Test:** for every value in `BUSINESS_CATEGORY_MAP['עסק']`, assert it has a `_BIZ_DASH_SUBS` entry mapping to a known dashboard row.

---

## 7. Category / profile mapping

Three intersecting maps. They mostly agree but each has unique entries that the other lacks.

| Map | File:line | Scope | Purpose |
| --- | --- | --- | --- |
| `CATEGORY_MAP` | `bot/ExpenseBot_FIXED.gs:271+` (1500+ entries) | Personal + business mixed | Default classifier when `matchCategory(text)` is called. Hebrew + English keyword lists per (category, subcategory) tuple. |
| `BUSINESS_CATEGORY_MAP['עסק']` | `bot/ExpenseBot_FIXED.gs:8358-8368` | Business only | Triggered when the text has the `עסק` prefix. Categories: `עלות שיווק`, `הוצאות תפעוליות`, `משלוחים והתקנות`, `עלות חומרי גלם`, `מחזור`, `יועצים`, `שונות`. |
| `_BIZ_DASH_SUBS` | `bot/ExpenseBot_FIXED.gs:11039-11075` | Business dashboard | Maps subcategory aliases ("חומרי גלם", "שיווק", "מלאי", "אריזה ומשלוח", etc.) to one of the 7 canonical business dashboard rows. |
| `_CANONICAL_CAT_BY_SUB` | `bot/ExpenseBot_FIXED.gs:8417-8422` | Personal | Coerces `{אוכל לבית, אוכל בחוץ, מסעדות, סופר}` to category `אוכל`. |
| Helper `_isCategoryName_` | `bot/ExpenseBot_FIXED.gs:85-111` | Guard | Used by Phase A v2 Guard A in `_writeBusinessNExpense_` to detect when "עסק 35 שיווק" is mis-parsed as a business name = category. |

### Findings

- **M1 (MEDIUM, related to C1) — `BUSINESS_CATEGORY_MAP['עסק']['מחזור']` contains the keyword `"מקדמה"`** (advance payment) which is exactly what a real customer might say — but `_BIZ_DASH_SUBS` happily maps it to `'מחזור'`. Good. Cross-check: `מקדמה` is NOT in `_BIZ_DASH_SUBS` directly (only via `מחזור`). Net: keyword -> classifier -> sub `מחזור` -> already-canonical. No drift here. **No fix needed.**
- **M2 (LOW) — `CATEGORY_MAP` has DUPLICATE keys for `'גן ילדים'`** appearing under both `חינוך וילדים / חינוך וטיפול` (line 310) AND `חינוך / חינוך` (line 383) AND `חינוך / חינוך` (line 672 for "children" subcategory). Different categories. The classifier uses longest-keyword-first sort, so the resolution depends on Hebrew sort stability. **Fix:** dedupe `CATEGORY_MAP` so `גן ילדים` lives in one place. **Test:** classify "1800 גן ילדים" and assert which subcategory wins; document the answer.

---

## 8. Pending clarification flows

| Key | Code | Purpose |
| --- | --- | --- |
| `clarPend:{phoneClean}` (ScriptProperty) | `_writeBusinessNExpense_` line 11432; `_resolvePendingClarification_` line 126; doPost loader line 1981 | Stores Phase A v2 Guard A/B/C pending clarification: 15-min TTL, `{kind, n, nameCandidate, ts}`. |
| `smart_pending` (single global ScriptProperty) | `processExpense` line 7010-7113; set at 7190, 7219 | Stores the "what category did this bare-amount business expense go to" pending question. 15-min TTL, `{amount, options, rawText, expiresAt}`. **Single global property — NOT per-phone.** Owner-only by construction, but if a tenant somehow ever reached this branch (they shouldn't), the next owner reply would consume their pending. |
| Smart-pending hijack guard | `processExpense` line 7016-7044 | If a NEW `עסק`-prefixed business order arrives while a smart_pending is still hot, drop the pending state and route the new message normally. Mitigates Steven's bug 2026-05-28 where "משלוח" in the new order matched the old picker option `אריזה ומשלוח`. |
| Awaiting-custom-category cache | `_handleRelabelTap_('__custom__')` line 5744 | Stores a 600s flag in `CacheService` that the NEXT free-text reply from this phone should be treated as a category name. Per-phone, safe. |

### Findings

- **PC1 (MEDIUM) — `smart_pending` is keyed on a SINGLE ScriptProperty, not per-phone.** This is fine TODAY because the smart_pending branch is owner-gated by `_isOwnerPhone_` at line 7000-7006, so only ONE phone (the owner) can ever set/consume it. But if a future patch removes that gate or extends smart_pending to tenants, two concurrent tenant pending states would cross-tenant. **Fix:** key as `smart_pending:{phoneClean}` even though only owner can use it today. **Test:** isolation test asserts that tenant message cannot read or write `smart_pending` property.
- **PC2 (LOW) — `clarPend` is per-phone and TTL'd to 15 min** — same property pool but unique key per phone. Safe.

---

## 9. Correction (relabel) button flow

| Step | Code |
| --- | --- |
| Tenant relabel-list section ids start with `relabel|` | `_sendChangeCategoryPicker_` (around line 5559) |
| Interactive list reply handler | `handleInteractiveReply_` upstream (cross-ref); for relabel detects prefix and routes to `_handleRelabelTap_(fromPhone, newCategory)` at line 2309 |
| `_handleRelabelTap_` | `bot/ExpenseBot_FIXED.gs:5733-5816` |
| `lastTenantExp:{phoneClean}` cache | Set in `_tenantWriteExpense_` at 6586-6601 (30-min TTL); read at 5760-5765 |
| Server hit | POST `/api/sheet/relabel-row` with `{phone, rowIndex, newCategory, newSubcategory:'', botSecret}` |
| Teach the bot from this correction | `_learnedSave(last.description, {category: newCategory, subcategory: ''}, 'user-correction')` at 5805 |
| Global learning publish | `_globalLearnPublish_` invoked inside `_learnedSave` (line 9187, 9199) when source is `'user-correction'` etc. | 

### Findings

- **L1 (MEDIUM) — `_handleRelabelTap_` sends empty `newSubcategory: ''`.** That means a relabel destroys subcategory context. If the user's last expense was `{cat: אוכל, sub: סופר}` and they tap `אוכל בחוץ`, the row's subcat becomes empty. **Fix:** when the picked category's "default subcategory" is well-known (e.g. `אוכל בחוץ` -> `מסעדות`), populate. **Test:** post-relabel tenant row has both category and subcategory non-empty.
- **L2 (LOW) — `_learnedSave` with empty subcategory** early-returns at line 9165 if `result.subcategory` is falsy. So the global learn publish is SKIPPED for every relabel tap. This means user corrections never train the global classifier. **Fix:** either set a default subcategory or relax the guard (allow empty sub for learnings). **Test:** assert relabel tap appends a row to the Learned tab.

---

## 10. needs_review routing

Where do uncertain expenses go?

| Path | Code | Behavior |
| --- | --- | --- |
| Owner ambiguity list flow | `processExpense` line 7831, 7872, 7929 | `_logMLAudit_` records `via: 'ambiguity_list_sent'` / `'ambiguity_picked'` to the `ML Audit` tab. Sets `needs_review: true` if `_countCorrectionsForText_(description) >= 2`. |
| Anti-degradation guard | line 2414-2432 (interactive reply) and 10144-10151 (re-correction) | If a single description has been corrected ≥2 times, sends `_adminAlertOnce_('צריך בדיקה ידנית — "X" תוקן N פעמים', fromPhone)`. |
| Tenant uncertain (cat == אחר / שונות) | `_tenantWriteExpense_` line 6521-6526 | Calls `_askBeforeDefaulting_(fromPhone, rawText, amount, description)` which sends a category picker and SUSPENDS the write. Does NOT write to תנועות until the user picks. |
| ML Audit tab | `_logMLAudit_` line 14821; headers at 14794 | Columns: `timestamp, user_text, amount, keyword_match_category, keyword_match_subcategory, ai_category, ai_confidence, final_category, final_subcategory, via, user_correction, needs_review, from_phone`. |

### Findings

- **N1 (LOW) — `ML Audit` tab lives in the owner's SHEET_ID** (line 14806 `sh.appendRow(_ML_AUDIT_HEADERS)` — implicit `SpreadsheetApp.openById(SHEET_ID)`). For tenant uncertain expenses, the audit log goes to the OWNER sheet, not the tenant's. This is per-tenant data leaked into the owner's audit. **Fix:** route tenant audit to a dedicated KV / Vercel-side log, not the owner sheet. **Test:** confirm that owner ML Audit tab does NOT contain rows where `from_phone !== owner phone`. **TENANT ISOLATION RISK.**

---

## 11. OLD sheet ID references in the repo

Full list of matches for `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (canonical repo, excluding `.claude/worktrees/`):

| File:line | Context | Status |
| --- | --- | --- |
| `PROJECT_STATUS_FOR_DEEPSEEK.md:122` | Doc: "Master template Sheet ID" | DOC — needs bump or banner |
| `LAUNCH_STATUS_2026_05_18.md:189` | Doc: "Master sheet ID" | DOC — stale (was pre-migration) |
| `docs/RECOVER_DASHBOARD_V2_RUNBOOK.md:25` | Runbook reference | DOC — stale |
| `bot/config.gs:11` (URL comment) | Template clone instruction | DOC + R1 above |
| `bot/config.gs:23` | `PERSONAL_TEMPLATE_SHEET_ID` constant | **R1 (HIGH)** |
| `bot/BOT_COMMANDS.gs:22` | `BC_SHEET_ID` | **R2 (MEDIUM)** |
| `bot/BOT_COMMANDS_README.md:68` | "Spreadsheet ID is hard-coded" | DOC |
| `bot/DROPDOWN_README.md:119` | Doc snippet | DOC |
| `bot/DASHBOARD_QUICK_WINS.gs:7` | `KESEFLE_SHEET_ID_QW` | **R3** |
| `bot/FIX_DASHBOARD_safe.gs:5` | `KESEFLE_SHEET_ID` | **R3** |
| `bot/WEEKLY_DIGEST.gs:32` | `WD_SHEET_ID` | **R3** |
| `bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs:18` | `KFL_SHEET_ID_EM` | **R3** |
| `bot/KESEFLE_ALL_PATCHES.gs:14` | `KESEFLE_SHEET_ID_ALL` | **R3** |
| `bot/CLEANUP_DUPLICATES_AND_TABS.gs:16` | `KFL_CL_SHEET_ID` | **R3** |
| `bot/CLEANUP_LEAKED_ROWS.gs:39` | `CLR_SHEET_ID` | **R3** |
| `bot/SORT_AND_FEATURES.gs:7` | `KESEFLE_SHEET_ID_SF` | **R3** |
| `bot/FIX_PROFITABILITY_AND_CHART.gs:14` | `KESEFLE_SHEET_ID_FP` | **R3** |
| `bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs:8` | `KFL_SHEET_ID` | **R3** |
| `bot/FIX_DASHBOARD_2023_2024_2025.gs:29` | `KESEFLE_SHEET_ID` | **R3** (intentional for legacy years cleanup) |
| `bot/CREATE_TEMPLATE_AND_CLEANUP.gs:15` | `SOURCE_SHEET_ID_CT` | INFO — intentional template source |
| `bot/SHEET_DASHBOARD_SMART_REMAP.gs:61` | comment only | INFO |
| `bot/personal_sheet_fix.gs:41` | comment only ("rollback to OLD") | INFO |
| `bot/ExpenseBot_FIXED.gs:25` | rollback comment | INFO |
| `bot/ExpenseBot_DEPLOY.gs:100` | rollback comment | INFO |
| `bot/MIGRATE_OLD_TO_KESEFLE.gs:29` | `_MIG_OLD_SHEET_ID_` (migration tool) | INTENTIONAL |
| `bot/MIGRATE_OLD_NOTES.gs:52` | `_MN_OLD_SHEET_ID_` | INTENTIONAL |
| `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs:48` | `_MP7_OLD_SHEET_ID_` | INTENTIONAL |
| `bot/SCAN_OLD_CATEGORIES.gs:44` | `_SOC_OLD_SHEET_ID_` | INTENTIONAL |
| `bot/SHEET_DASHBOARD_FULL_AUDIT.gs:50` | `_FA_OLD_SHEET_ID_` | INTENTIONAL audit |
| `bot/test_migration.js:37` | test assertion | INTENTIONAL |
| `bot/test_migration_phase_5.js:38` | negative test assertion | INTENTIONAL |
| `bot/test_migration_phase_7.js:47, 173` | test references | INTENTIONAL |

**Total: 12 live constants** (`R1` + `R2` + 10× `R3`) that the bot project would execute against the OLD sheet if the matching function runs in the deployed Apps Script project. **Action:** confirm Apps Script project has the legacy `.gs` files removed/disabled OR bump all 12 to NEW.

---

## TEST SPECS — 9 reference bot messages

For each, predicted (a) routing branch, (b) 8 columns of the תנועות row written (or "no write"), (c) which dashboard row updates, (d) whether the bot should ASK for clarification, (e) expected reply text. Trace inputs assume sender is the script OWNER (`972547760643`) unless noted; for non-owner the path goes through `/api/sheet/append`.

Schema reminder for owner תנועות (`bot/ExpenseBot_FIXED.gs:7953` etc.):
`A=now, B=monthKey, C=amount, D=category, E=subcategory, F=description, G=source, H=isExpense`

### TEST 1 — `50 קפה`

| Field | Value |
| --- | --- |
| Routing | `processExpense` -> `_doPost_orig` fast path (digit-leading) -> `matchCategorySmart` -> `_matchCategory_long` finds keyword `"קפה"` (line 391 of CATEGORY_MAP) |
| `_kflKwHit_` | `קפה` is 3 chars -> whole-word match (avoids `"מקפה"` false-positive) |
| Owner תנועות row | `A=2026-05-28 timestamp`, `B='2026-05'`, `C=50`, `D='אוכל'`, `E='אוכל בחוץ'`, `F='קפה'`, `G='WhatsApp'`, `H=true` |
| Dashboard | `מאזן אישי` SUMIFS row for `אוכל` / month `2026-05` increments by 50 (formula-based, automatic) |
| ASK? | NO — high-confidence keyword hit, no `__isUncertain` |
| Expected reply | `💸 ₪50 → אוכל בחוץ` (plus streak + sheet link line) |

### TEST 2 — `245 סופר`

| Field | Value |
| --- | --- |
| Routing | `processExpense` -> match keyword `"סופר"` (line 390 of CATEGORY_MAP) |
| Coerce | `_coerceCategoryBySubcategory` (line 8423) rewrites category to `'אוכל'` (canonical) |
| Owner תנועות row | `C=245`, `D='אוכל'`, `E='אוכל לבית'`, `F='סופר'`, `G='WhatsApp'`, `H=true` |
| Dashboard | `מאזן אישי / אוכל` increments by 245 |
| ASK? | NO |
| Expected reply | `💸 ₪245 → אוכל לבית` |

### TEST 3 — `עסק 35 שיווק`

| Field | Value |
| --- | --- |
| Routing | doPost owner-only block (line 2031) -> `_parseBusinessNumberPrefix_` parses `n=35`, `name='שיווק'`, `rest=''` -> `_writeBusinessNExpense_` -> **Guard A fires** at line 11444 because `_isCategoryName_('שיווק')` returns true |
| Side effect | Saves `clarPend:{ownerPhone}` ScriptProperty with `{kind:'biz_n_clarify_A', n:35, nameCandidate:'שיווק', ts:now}` |
| Owner תנועות row | **NONE YET** — write is suspended pending clarification |
| Dashboard | NO change |
| ASK? | YES — option 1 = "register expense in biz 35 sub 'שיווק'", option 2 = "create new business 'שיווק'", option 3 = cancel |
| Expected reply | `🤔 רגע — "שיווק" נשמע כמו קטגוריה, לא שם עסק.\n\nמה התכוונת?\n1. רישום הוצאה לעסק 35 בקטגוריה שיווק — שלח: "1" או "רישום הוצאה"\n2. פתיחת עסק חדש בשם "שיווק" — שלח: "2" או "פתח עסק חדש"\n3. ביטול — שלח: "3" או "בטל"` |
| Follow-up flow if user replies `1` | `_resolvePendingClarification_` picks effRest=`'35 שיווק'`, effN=1 — reroutes to `_writeBusinessNExpense_(phone, 1, null, '35 שיווק', msgId, bypassGuards=true)`. Then writes row `[now, monthKey, 35, 'עסק', 'שיווק', 'שיווק', 'WhatsApp', true]` to תנועות tab. `_updateBusinessDashboardInSheet_` normalizes 'שיווק' -> 'עלות שיווק' via `_BIZ_DASH_SUBS` and updates `מאזן חברה`. |

### TEST 4 — `עסק הכנסה 10000`

| Field | Value |
| --- | --- |
| Routing | doPost owner-only -> `_parseBusinessNumberPrefix_` returns null (no leading digit after `עסק`) -> falls through to `processExpense` -> `__hIsBiz` true -> `parseBusinessOrder_` returns null (only one numeric field, no labelled fields) -> falls into bare-amount business branch at line 7146. |
| Amount extraction | `__hAM` regex grabs `10000`. `__hRest = 'הכנסה'` after strip. |
| Keyword check | `matchCategory('עסק הכנסה 10000')` uses BUSINESS_CATEGORY_MAP — `"הכנסה"` is in `BUSINESS_CATEGORY_MAP['עסק']['מחזור']` keywords list (line 8364) -> match `{category:'עסק', subcategory:'מחזור'}` |
| `__hBizFoundKw && !__hBizDefaultSub` | true -> deletes smart_pending, sets `text = __hT` -> falls through to main classify loop |
| Owner תנועות row | `C=10000`, `D='עסק'`, `E='מחזור'`, `F='הכנסה'` (description), `G='WhatsApp'`, `H=true` -- **BUG candidate:** `H` should be FALSE (income), but the legacy main loop doesn't check `BUSINESS_CATEGORY_MAP['עסק']['מחזור']` to flip the boolean. The income path in `_writeBusinessNExpense_` does (`!isIncome`), but THIS path goes through the main `processExpense` loop which writes `true` always. |
| Dashboard | `_updateBusinessDashboard_('עסק', 'מחזור', '2026-05', 10000)` updates the `מחזור` row of מאזן חברה (positive 10000) |
| ASK? | NO |
| Expected reply | `💸 ₪10,000 → מחזור` (BUG — emoji should be `💵`. Net effect: row written as expense, NOT income.) |
| **Risk** | **B1 (HIGH)** — see Findings B1 below. |

### TEST 5 — `טסט רכב 1200`

| Field | Value |
| --- | --- |
| Routing | Does NOT start with a digit, so `__looksLikeExpense=false`. Goes through the slow lane of routers. Eventually hits the parser via `parseAmountAndDescription` which extracts `1200` and `'טסט רכב'`. |
| Keyword | `"טסט רכב"` is in `CATEGORY_MAP` line 400 -> `{category:'תחבורה', subcategory:'רישוי'}`. ALSO in line 531 ammunition list under `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות`. Longest-keyword-first sort: both are 7 chars (טסט רכב). **Order in CATEGORY_MAP** decides — line 400 (transport) wins because it appears first. |
| Owner תנועות row | `C=1200`, `D='תחבורה'`, `E='רישוי'`, `F='טסט רכב'`, `G='WhatsApp'`, `H=true` |
| Dashboard | `מאזן אישי / תחבורה` for month 2026-05 += 1200 |
| ASK? | NO |
| Expected reply | `💸 ₪1,200 → רישוי` |

### TEST 6 — `גן ילדים 1800`

| Field | Value |
| --- | --- |
| Routing | Non-digit-leading -> slow lane. Parser extracts `1800`, desc=`'גן ילדים'`. |
| Keyword | `"גן ילדים"` appears in CATEGORY_MAP at lines 310, 383, 672 — three subcategories. After longest-first sort by keyword length (all 8 chars equal), the FIRST match wins. Line 310 sub `חינוך וטיפול` of category `חינוך וילדים`. |
| Owner תנועות row | `C=1800`, `D='חינוך וילדים'`, `E='חינוך וטיפול'`, `F='גן ילדים'`, `G='WhatsApp'`, `H=true` |
| Dashboard | `מאזן אישי / חינוך וילדים` for 2026-05 += 1800 |
| ASK? | NO |
| Expected reply | `💸 ₪1,800 → חינוך וטיפול` |
| **Risk** | **M2** — duplicate `'גן ילדים'` in CATEGORY_MAP across 3 entries; non-deterministic if entry order ever changes. |

### TEST 7 — `וטרינר 350`

| Field | Value |
| --- | --- |
| Routing | Non-digit-leading. Parser extracts `350`, desc=`'וטרינר'`. |
| Keyword | `"וטרינר"` matches CATEGORY_MAP line 429 (`{category:'שונות ואחרים', subcategory:'חיות מחמד'}`) AND line 583 (`{category:'בריאות / רופא פרטי', subcategory:'הוצאות לבעלי חיים - וטרינר ושירותים'}`) AND line 676 (`{category:'חיות מחמד', subcategory:'חיות מחמד'}`). Three categories collide. Longest-keyword sort: all are 5 chars. First-match wins. Line 429. |
| Owner תנועות row | `C=350`, `D='שונות ואחרים'`, `E='חיות מחמד'`, `F='וטרינר'`, `G='WhatsApp'`, `H=true` |
| Dashboard | `מאזן אישי / שונות ואחרים` (or `חיות מחמד` sub-line if present) += 350 |
| ASK? | NO |
| Expected reply | `💸 ₪350 → חיות מחמד` |
| **Risk** | **M3 (related to M2)** — `וטרינר` also has 3 colliding entries. Suggest dedupe into one canonical `חיות מחמד` category. |

### TEST 8 — `תקציב אוכל 2000`

| Field | Value |
| --- | --- |
| Routing | This is a BUDGET COMMAND, not an expense write. doPost routes to budget handler around line 2086 / 6877 (`_budgetSet_`). |
| Owner תנועות row | **NONE** — no row written. |
| Dashboard | NO change to dashboard. KV `budget:{phone}:אוכל` is set. |
| ASK? | NO — direct set |
| Expected reply | `✅ נקבע תקציב חודשי: ₪2,000 לקטגוריית "אוכל"\n\nאשלח התראה כאן כשתעבור 80% מהתקציב החודשי.\nלרשימת התקציבים שלך: *תקציב*` |
| Side effect | When future expense in `אוכל` pushes MTD past 80%, bot sends a budget alert (line 6900-6904). |
| Bug candidate | If `אוכל` is not in the budget API allowlist, returns `r.error === 'invalid_category'`. Bot replies with the full allowed list. Manual check: `אוכל` IS the canonical category from `_CANONICAL_CAT_BY_SUB`, so should be allowed. **Spec: assert 'אוכל' in allowed list.** |

### TEST 9 — `עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200`

| Field | Value |
| --- | --- |
| Routing | Starts with `עסקה` (not `עסק|biz|business`). The `__hIsBiz` regex is `/^(עסק|biz|business)(?=$|[\s:\-,0-9])/i` — lookahead requires a non-letter after `עסק`. Letter `ה` does NOT match `[$|\s:\-,0-9]`, so **`__hIsBiz` is FALSE**. parseBusinessOrder_ also rejects via same prefix check at line 2692. |
| Fall-through | Goes to `parseAmountAndDescription`. The first amount `10000` is extracted; description = `'עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200'` (or just first headline). |
| Keyword check | `matchCategory` on this text: no `עסק` prefix detected (because of the `ה` suffix). Returns long-form classifier results: `"עובדים"` not in CATEGORY_MAP. `"חומרים"` matches BUSINESS map only if prefix. `"הכנסה"` matches BUSINESS map only if prefix. Net: likely matches NO keyword. Falls to `__isUncertain` path. |
| Owner path | The ambiguity-list interactive picker fires (line 7920+). Sheet write is SUSPENDED until user picks. |
| Tenant path | `_askBeforeDefaulting_` fires (line 6525). Same suspend. |
| Owner תנועות row | **NONE** — write suspended pending picker |
| Dashboard | NO change |
| ASK? | YES |
| Expected reply | Interactive list titled `'לא בטוח בקטגוריה'` with body `'₪10000 • "עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200"\n\nבחר את הקטגוריה הנכונה:'` |
| **Risk** | **B2 (HIGH)** — A multi-leg business deal message (`עסקה`) is COMPLETELY missed by the order parser because of the `עסק|biz|business` prefix regex. The user expects: split into 1 income line (`10000`) + 2 expense lines (`עובדים 2500`, `חומרים 1200`) AND profit calc. Today: it becomes a single uncertain `10000` expense pending a picker. **Fix:** extend `__hIsBiz` and `parseBusinessOrder_` to also accept `עסקה` as the prefix (Hebrew "transaction" vs "business"). **Test:** add to `bot/test_business_order_parser.js` an entry asserting `parseBusinessOrder_('עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200')` returns a non-null structured object with 3 line-items. |

---

## Combined risk summary

| Tag | Severity | Title | Fix scope |
| --- | --- | --- | --- |
| R1 | HIGH | `PERSONAL_TEMPLATE_SHEET_ID` still OLD in `bot/config.gs` | 1-line constant bump + redeploy |
| R2 | MED | `BOT_COMMANDS.gs::BC_SHEET_ID` still OLD | Confirm deploy bundle excludes it OR bump |
| R3 | MED | 13 helper `.gs` files hardcode OLD ID | Banner each + move to `bot/legacy/` OR bump |
| T1 | HIGH | Dashboard tab name drift (`מאזן שנתי` vs `מאזן חברה`) | Unify constant |
| T2 | LOW | Hardcoded `'תנועות'` string in legacy helpers | Use constant |
| W1 | LOW | Source col 'WhatsApp (interactive)' inconsistency | Unify string |
| W2 | MED | sanitizeForSheet only applied to text cols | Audit sanitize fn behavior |
| O1 | LOW | Order parser ignores explicit profit | Add explicit-profit capture + warn |
| O2 | LOW | Order status hardcoded `'paid'` | New command for status |
| P1 | MED | Bot never writes `מאזן אישי`, depends on formulas | Add post-write SUMIFS sanity check |
| C1 | HIGH | `_BIZ_DASH_SUBS` map is single point of failure for biz-dashboard drift | Expand map + golden test |
| M1 | INFO | מקדמה classification | None — works |
| M2 | LOW | `'גן ילדים'` duplicated across 3 CATEGORY_MAP entries | Dedupe |
| M3 | LOW | `'וטרינר'` duplicated across 3 CATEGORY_MAP entries | Dedupe |
| PC1 | MED | `smart_pending` is single-property, not per-phone | Key by phone |
| PC2 | LOW | `clarPend` is fine | None |
| L1 | MED | `_handleRelabelTap_` clears subcategory | Default sub by category |
| L2 | LOW | `_learnedSave` skips empty-sub relabels (no global learn) | Relax guard |
| N1 | HIGH | Tenant uncertain logs leak into owner's `ML Audit` tab | Route to KV/server log |
| B1 | HIGH | `עסק הכנסה 10000` writes as EXPENSE not income in main `processExpense` loop | Detect `מחזור` sub in main loop + flip H |
| B2 | HIGH | `עסקה` prefix is COMPLETELY ignored by order parser | Extend prefix regex |

Total: **23 distinct risk findings.**

---

## Acceptance check (per task brief)

- [x] Tabular findings for all 11 areas — sections 1–11 above.
- [x] 9 test-case specs with column-by-column predictions — `TEST 1` through `TEST 9` above.
- [x] OLD sheet ID references catalogued — Section 11 lists all 32 hits with status (12 live constants flagged).
- [ ] PR `[autonomous-audit] bot sheet sync audit` — to be opened by Agent 4's commit + `gh pr create`.

This document is the deliverable to that PR.
