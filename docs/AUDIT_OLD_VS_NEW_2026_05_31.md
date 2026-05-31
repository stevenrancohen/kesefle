# OLD vs NEW audit — 2026-05-31

OLD: `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (read-only forever)
NEW: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` (Steven's primary)
Bot version in repo: `2026-05-29-kolektziot-route-added` (`bot/ExpenseBot_DEPLOY.gs:137`)

## Summary

NEW is mostly intact and safe — 100% raw-row parity (615 tx + 30 orders), 14/23 of Steven's historical personal categories are routable, and the canonical template formulas are correct. **3 real gaps remain:** (1) PR #160 REWIRE not yet APPLIED so Steven's existing dashboard still has frozen-year cells, (2) the new-tenant template is missing 5+ of Steven's personal categories as canonical rows, and (3) cell-notes migration from OLD has never been run.

## Findings

### 1. Tab parity

**Verdict: NEW has every load-bearing tab. 4 OLD reference tabs intentionally NOT migrated (decision pending).**

| Class | OLD tabs | NEW tabs | Notes |
|---|---|---|---|
| Active data | `תנועות`, `הזמנות` | `תנועות` (619 rows), `הזמנות` (31 rows) | 100% parity verified by `AAA_WS3` live read |
| Active dashboards | `מאזן אישי`, `מאזן חברה` | `מאזן אישי` (85 rows), `מאזן חברה` (16 rows) | Present; rows extended via MIGRATE_DASHBOARD_FROM_OLD APPLY |
| New in NEW | — | `פירוט מורחב`, `ML Audit`, `מילון לימוד`, `_DIFF_REPORT_` (hidden) | Pa'amonim extended dashboard + ML/dict + audit leftover |
| OLD only (NOT migrated) | `מאזן אישי 2023/2024/2025`, `מאזן שנתי — לא לגעת`, `תיק השקעות` x2, `חברה 2026 לא לגעת`, `לא לגעת — אופציות`, `אתחים`, `Auto Synonyms` | — | Per-year snapshot tabs + investments + options; raw data already in `תנועות`. Decision pending. |
| OLD backups | `_BACKUPS_`, `QA_DUPLICATES`, `_QA_REPORT_`, `backup 20260528_0607`, `dontdelete` | — | Intentionally left in OLD; no migration needed. |

**Missing-but-reference (Steven decision needed):** `תיק השקעות` (investment portfolio) is the only OLD tab that may hold data not in `תנועות`. Recommend a `SCAN_INVESTMENT_PORTFOLIO.gs` read-only diagnostic before deciding. Per-year snapshot tabs (`מאזן אישי 2023/2024/2025`) are dashboards-as-of-year-end built from the same raw data that's now in NEW `תנועות` — same-tab year selector renders them on demand.

### 2. Category parity

**Verdict: 14/23 of Steven's OLD personal categories route correctly; 5 are routable but lack a canonical template row; 4 are now routable per recent fixes.**

Cross-reference against `docs/PERSONALIZED_CATEGORY_PROFILES.md` §8 (Steven's 23 historical categories) and `lib/sheet-writer.js:55-126`:

| Steven OLD category | Bot CATEGORY_MAP route? | sheet-writer template row? | Effect for Steven on NEW |
|---|---|---|---|
| `הוצאות בית` | YES (via `בית` keyword paths) | YES `PERSONAL_FIXED_ROWS[0]='בית'` | OK |
| `נשר + חופים` / `כושר + תוספים` | YES (`מכון כושר`) | YES `PERSONAL_FIXED_ROWS[1]='מכון כושר'` | OK |
| `אוכל` | YES (split into `אוכל לבית`/`אוכל בחוץ`) | YES `PERSONAL_FOOD_ROWS` | OK |
| `קולקציות` | YES (PR #156, added 2026-05-30) | NO template row | Steven-only (appended row exists post-MDD APPLY) |
| `כבלים אינטרנט פלאפון` | YES | YES `PERSONAL_FIXED_ROWS[3]='תקשורת'` | OK |
| `לימודים` | YES (incl. `לימים` typo per PR #129) | YES `PERSONAL_FIXED_ROWS[4]` | OK |
| `ביטוח אישי` | YES | YES `PERSONAL_FIXED_ROWS[5]` | OK |
| `אבא` | YES (`להעביר לאבא`, line 401) | NO template row | Steven-only (appended row exists post-MDD APPLY) |
| `בדיקות` | Bundled into `בריאות` | Rolls into `PERSONAL_MISC_ROWS[2]='בריאות'` | OK (rollup) |
| `טיפולים` | Bundled into `בריאות`/`טיפוח` | Rolls into `PERSONAL_MISC_ROWS` | OK (rollup) |
| `חברה / מס הכנסה / ביטוח לאומי` | YES → `הוצאות תפעוליות` | YES `COMPANY_EXPENSE_ROWS` row 11 | OK (biz dashboard) |
| `ביטוח חובה+ג׳+איתורן` | YES → `ביטוח רכב` | YES `PERSONAL_TRANSPORT_ROWS[6]` | OK |
| `טסט רכב` | YES → `אחזקת רכב` (PR #155 fix) | YES `PERSONAL_TRANSPORT_ROWS[4]` (now `אחזקת רכב`) | OK |
| `חניונים` | YES → `חניה` | YES `PERSONAL_TRANSPORT_ROWS[1]` | OK |
| `מים` | YES | YES `PERSONAL_FIXED_ROWS[9]` | OK |
| `BMW` | YES (`bmw`, `s1000`, `אופנוע`) | NO template row | Steven-only (appended row exists post-MDD APPLY) |
| `דלק` | YES | YES `PERSONAL_TRANSPORT_ROWS[0]` | OK |
| `אוכל/מזון/רכבת` | Split (`אוכל לבית`/`תחבורה ציבורית`) | Split into 2 rows | OK (intentional split) |
| `חצי אירון מן` | YES (PR #153, added 2026-05-29) | NO template row | Steven-only (post-MDD APPLY) |
| `אוסטריה` / `חצי אוסטריה` | YES (PR #153, added 2026-05-29) | NO template row | Steven-only (post-MDD APPLY) |
| `עורך דין` | YES via `יועצים` (biz path) | Personal: NO template row | **Mismatch** — Steven's personal legal lands in biz `הוצאות תפעוליות`. Decision needed. |
| `בנק הפועלים` | YES → `בנקאות` (rollup) | YES `PERSONAL_FIXED_ROWS[6]='בנקאות'` | OK (rollup) |
| `חופשות` | YES (PR #155, own subcategory) | YES `PERSONAL_VARIABLE_ROWS[3]` (added 2026-05-29) | OK |
| `גיא` | YES (PR #153, added 2026-05-29) | NO template row | Steven-only (post-MDD APPLY) |

**Gaps still open:** 5 of Steven's categories live on his sheet only because MIGRATE_DASHBOARD_FROM_OLD APPLY appended them under the `🏷️ מהגיליון הקודם` banner — they have no canonical template row. New tenants will not see them. Per `PERSONALIZED_CATEGORY_PROFILES.md` §7.6 "Advanced Imported" preset, these are intentional Steven-only customs (`is_custom=TRUE`, `default_for_new_users=FALSE`) so this is BY DESIGN — but it is not yet implemented as a real preset system.

**One real bug** (per WS1 finding): `ארנונה` writes to col E as either `ארנונה - ערים נוספות` (line 515) or `חשבונות` (line 395). Neither matches a `*ארנונה*` row — bot rolls them up into `*בית*` wildcard. This is fine for Steven (he uses `בית` as the catch-all) but new-user templates lose ארנונה granularity.

### 3. Formula parity

**Verdict: CANONICAL template formulas are correct. STEVEN'S LIVE dashboard still has frozen-year cells until he runs PR #160 REWIRE.**

| Pattern | Where | Year-aware? | Verdict |
|---|---|---|---|
| `SUMIFS(...!B:B, $B$2&"-MM", ...)` | `lib/sheet-writer.js:246, 485, 663` | YES (equality on `$B$2/$B$4/$B$1`) | CLEAN — Sheets text-coerces `$B$?&"-MM"` correctly. No range-comparison bug. |
| `SUMIFS(...!A:A, ">="&DATE($B$4,m,1), ...)` | `lib/sheet-writer.js:525, 537` | YES (uses `DATE()` not concat) | CLEAN — `DATE()` returns a real date, no `"2025-01"` arithmetic coercion. |
| `SUMPRODUCT((LEFT(B,4)=year)*(E=label)*C)` | `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:207-222`, `bot/REWIRE_DASHBOARD_TO_B4.gs:152-178` | YES (with `IF($B$4="",TEXT(YEAR(TODAY()),"0000"),TEXT($B$4,"0000"))` fallback) | CLEAN — PR #151 canonical fix; bypasses Sheets' arithmetic parsing of `"2025-01"`. |
| `monthKey = year + '-' + MM` baked into formula string | `bot/ExpenseBot_FIXED.gs:11242, 15824, 15963` (and DEPLOY mirrors) | NO — frozen at install time | **LATENT BUG** (gated by `AUTO_FIX_DASHBOARDS=1` Script Property — opt-in only). If ever flipped on, year selector becomes cosmetic. PR #158 added a multi-line validator to catch this in CI. |
| Steven's existing live dashboard cells | Live sheet `1rti...!מאזן חברה!B5:N14` | NO — installed earlier with frozen year | **OPEN — PR #160 REWIRE_DASHBOARD_TO_B4 ready but NOT APPLIED.** Steven needs to run DRY_RUN → APPLY. |

**No occurrence of `">=" & ... & "-MM"`** (the broken range-comparison pattern) anywhere in active formula generators. Only present in an explanatory comment in `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:184`. PR #151 + PR #157 + PR #160 collectively close this class of bug.

**New-tenant template year selectors** (B1/B2/B4) now have strict `ONE_OF_LIST` dataValidation per PR #155 (`lib/sheet-writer.js:164-189`). Accidental Backspace no longer silently zeroes dashboards.

### 4. Historical-data integrity

**Verdict: 100% parity, live-verified.**

Per `docs/review-2026-05-29/WS3_HISTORICAL_NOTES.md` live audit via Apps Script `AAA_WS3`:

| Year | OLD תנועות | NEW תנועות | Parity |
|---|---|---|---|
| 2023 | 2 | 2 | 100% |
| 2024 | 221 | 221 | 100% |
| 2025 | 218 | 218 | 100% |
| 2026 | 174 | 174 (+ growing) | 100% + organic appends |
| **Total** | **615** | **615** | **100%** |

Orders: NEW `הזמנות` has 30 rows (OLD had 29 + 1 organic since migration).

Sample row-level verifications (live-confirmed 2026-05-29):
- `רוביקון` 2025 = ₪171,326 (sums via `*רוביקון*` SUMIFS on appended row)
- `ביגוד` 2025 = ₪12,539
- `מכון כושר` 2026 = ₪1,744

**Phase 2 dedup key + LockService guards in place** (`bot/MIGRATE_OLD_TO_KESEFLE.gs:94-102`) — re-running APPLY is idempotent and additive (only new rows in OLD since cutover would be appended).

**Gap: cell notes never migrated.** `bot/MIGRATE_OLD_NOTES.gs` exists and has DRY_RUN + APPLY + LockService but there is no evidence Steven ran APPLY. Open PR #130 (per `docs/MIGRATION_READINESS_OLD_BALANCE_TO_KESEFLE.md` §3.2). Impact: hover-to-explain history on individual rows is lost.

### 5. Steven-typed-row protection

**Verdict: Protected by design — the bot writes to `תנועות` (transactions log), NOT to the dashboards.**

The cited rows in user memory (`feedback_never_overwrite.md`: "rows 12 marketing & 14 operations are user data") refer to the OLD sheet's structure where Steven hand-typed totals into the dashboard. In the NEW architecture:

| Mechanism | Where | Protection |
|---|---|---|
| Bot writes ONLY to `תנועות` (append-only) | `bot/ExpenseBot_FIXED.gs:26` `SHEET_ID = '1rti...'` + `appendRow` calls only | Cannot overwrite a dashboard cell — different tab. |
| Dashboard cells are FORMULAS, not values | `lib/sheet-writer.js:246, 485, 525, 537, 549, 560, 663` — all dashboard cells are `_sw_formula(...)` | Formulas SUMIFS over the raw log; user-typed overrides ARE allowed but bot never touches them. |
| `_isBrokenDashFormula_` skips clean formulas | `bot/personal_sheet_fix.gs:460, 541, 649, 1051, 2130` | Self-heal only rewrites formulas matching the "broken" pattern; clean SUMIFS + user-typed values are left alone. |
| Manual marketing override preserved | `bot/personal_sheet_fix.gs:1171, 1840, 2112` | Special-cases the `2026-05 +2100` Steven adjustment for marketing — formula gets `+2100` appended. |
| REWIRE_DASHBOARD_TO_B4 skips non-formula cells | `bot/REWIRE_DASHBOARD_TO_B4.gs:278-282` | Reads `getFormula()` first; if empty (user-typed value), skip. |

**No `setValue` against rows 12 / 14 of any tab in bot/.** Personal dashboard rows 12+14 in the NEW template are `📊 אחוז חיסכון` (formula) and `🏠 הוצאות קבועות` (section header). Company dashboard rows 12+14 are `🧮 סה״כ הוצאות עסקיות` (formula) and `📊 אחוז רווחיות` (formula). All are formulas, not user-typed values.

**Edge case (OLD only):** if Steven still uses any OLD-sheet dashboard manually, that's outside the audit scope — OLD is read-only forever per the iron rule.

## Recommendations

Numbered list of safe additive PRs that should ship next.

1. **[Steven must do] Run PR #160 REWIRE_DASHBOARD_TO_B4 against the live sheet.**
   Sequence: `RWD_SELF_TEST_HEBREW` → `DRY_RUN_REWIRE_DASHBOARD` → review log → set `CONFIRM_REWIRE_DASHBOARD=YES I UNDERSTAND` → `APPLY_REWIRE_DASHBOARD` → cycle B4 through 2023/2024/2025/2026 → verify totals change. ROLLBACK available.
   Why: this is the only remaining live-data fix between Steven's current dashboard and a fully year-aware view.

2. **[Steven must do] Run `MIGRATE_OLD_NOTES.gs` DRY_RUN to inventory cell notes from OLD.**
   PR #130 is open; never-overwrite guard at `bot/MIGRATE_OLD_NOTES.gs:178-186` means it's safe to re-run. If the DRY_RUN log shows >0 notes worth migrating, then `APPLY_MIGRATE_NOTES_NOW`.

3. **[Steven decision needed] Decide fate of OLD `תיק השקעות` tabs.**
   Investment portfolio data isn't in `תנועות`. Options: (a) leave as historical reference in OLD, (b) build a one-shot read-only inventory script to dump into a NEW `תיק השקעות` tab, (c) abandon — Steven tracks investments elsewhere.

4. **[Claude can do] Tighten `bot/test_no_hardcoded_year_in_dashboard_formula.js` (per WS2 finding #6, partially done in PR #158).**
   Add a regression test that asserts each formula installer in `bot/ExpenseBot_FIXED.gs` (`installCompanyDashboardFormulas`, `installPersonalDashboardFormulas`, `migrateDashboardToSUMIFS`) references `$B$?` inside the `setFormula` argument string — not just in a variable. This catches the latent frozen-year bug class fully.

5. **[Claude can do] Add `ארנונה` as its own row in `PERSONAL_FIXED_ROWS`** (per WS1 finding line 73).
   Bot already writes `"ארנונה - ערים נוספות"`. Add `'ארנונה'` to `PERSONAL_FIXED_ROWS` so `*ארנונה*` wildcard SUMIFS sweeps it up. Pure additive — does not affect Steven's existing sheet (his appended `בית` row already catches it via wildcard).

6. **[Claude can do] Implement `PERSONALIZED_CATEGORY_PROFILES.md` Layer 1 + Layer 2 (Phase A only, server-side).**
   The 5 Steven-only categories (`רוביקון`, `BMW`, `אבא`, `גיא`, `קולקציות`, `חצי אירון מן`, `אוסטריה`) currently live on Steven's sheet via MDD-appended rows but have no canonical Layer 1 entry. Phase A is the safest first step — KV-side master library only, no per-user template change. ~250 LOC, idempotent.

7. **[Claude can do] Replace `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71 _YS_CURRENT_YEAR_ = 2026` with `YEAR(TODAY())` function** (WS2 finding #4).
   Year-rollover bug, ~7 months runway. One-line behavior change; Steven should confirm intent ("2026 freezes to historical on Jan 1 2027").

8. **[Claude can do] Roll `YEAR_SELECTOR_VALUES` to a computed 9-year window** (security re-sweep finding L1).
   Currently hardcoded `['2023'..'2030']` (`lib/sheet-writer.js:164`). Replace with `(function(){var y=new Date().getFullYear(); var out=[]; for(var i=-3;i<=5;i++) out.push(String(y+i)); return out;})()`. Same shape, no static end date.

9. **[Claude can do] Delete the hidden `_DIFF_REPORT_` tab (221 rows) from NEW sheet.**
   Leftover from `bot/SHEET_DIFF_OLD_VS_NEW.gs` APPLY. Pure hygiene. Or just leave hidden — harmless.
