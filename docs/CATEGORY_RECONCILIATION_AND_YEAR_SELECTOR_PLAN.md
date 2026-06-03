# Plan — Category Reconciliation + Year Selector Migration

**Status:** PLAN ONLY. No code, no formulas, no apply.
**Owner:** `kesefle-migration-and-sheet-formula-agent`
**Reviewed by:** `kesefle-cto-product-architect`
**Gate before any APPLY:** Steven's explicit `אשר` / `apply` / `go`.
**Date:** 2026-05-29
**Sheets:**
- OLD: `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (read-only)
- NEW: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` (target)

This document answers the planning questions Steven asked verbatim. Currency rates, EUR/USD, MSTR pricing — all deferred until categories + year selector are correct.

---

## Part A — Category Reconciliation (sections A through P)

### A. Understanding of the issue

Steven's OLD sheet was the source of truth from ~2023 through ~2026-05. PR #120 migrated **614 transactions + 28 orders** into the NEW sheet as a one-time snapshot. Three problems followed:

1. The migration moved **rows** (raw transactions) but did NOT also move **dashboard structure** — the new sheet's `מאזן חברה` / `מאזן אישי` were built from `lib/sheet-writer.js` `buildTenantSheetSpec`, which doesn't know about Steven's historical category list.
2. The bot's `CATEGORY_MAP` (in `bot/ExpenseBot_FIXED.gs`) was tuned over time for the OLD sheet's row labels. After migration, mismatches between bot output and NEW dashboard SUMIFS criteria silently zero out totals.
3. Anything Steven typed in OLD **after** the migration date stayed there. The diff between OLD and NEW is partly expected (snapshot vs live drift) and partly a real category gap.

The user-visible effect is "expenses disappeared from the new dashboard" — but the rows are present in `תנועות`, just not summed by any formula that recognizes their `subcategory`.

### B. Why expenses are missing in the new sheet

For each missing expense, one of these is true (in decreasing order of likelihood):

1. **Bot wrote a subcategory string the dashboard SUMIFS doesn't match exactly.** Example: bot wrote `שיווק`, dashboard sums `שיווק/קידום`. The bot wrote successfully; the formula returns 0.
2. **The dashboard has no row for that category at all.** Example: `רוביקון` was a row in OLD `מאזן אישי` but never made it into the NEW `מאזן חברה` template. Bot may even be writing `שונות` for these.
3. **The year selector is hardcoded to 2026 in some formula.** Example: a SUMIFS criterion `"2026-MM"` instead of `$B$4&"-MM"`. Changing the year doesn't update the total.
4. **The category exists but is mapped to the wrong dashboard section.** Example: `חופשות` should be in `הוצאות זמניות` but ended up under `שונות`.
5. **The migration didn't bring some historical years.** Example: 2023 dashboard values existed only as manually-entered cell values in OLD, not in OLD `תנועות`. They didn't migrate.

I cannot quantify which percentage of "missing" expenses fall into each bucket until the SHEET_DIFF_OLD_VS_NEW tool runs against live data. That's the next concrete action.

### C. Old category extraction plan

1. Read OLD `מאזן אישי`, OLD `מאזן חברה`, OLD year tabs (2023/2024/2025), and OLD `תנועות`.
2. From each dashboard tab, collect every col-A label that has at least one non-zero value in its row → 80-120 distinct categories.
3. From OLD `תנועות`, collect every distinct col-E value → another 30-50 distinct categories.
4. Group near-duplicates (spacing variants, ה'/יו"ד variants, plural/singular).
5. Compute per-category: `historical_total`, `first_seen_year`, `last_seen_year`, `transaction_count`.
6. Tag the section/group from the OLD section header above each row.
7. Output as a CSV-ish table inside `bot/SHEET_DIFF_OLD_VS_NEW.gs`'s DRY_RUN report (already partially does this in § 3, § 4).
8. **Output:** a flat list of ~60-80 canonical OLD categories, each with full provenance.

This is read-only on OLD. No writes.

### D. New category mapping plan

For each canonical OLD category, decide its NEW location:

| Decision | Action |
|---------|--------|
| Maps cleanly to an existing NEW dashboard row | Use that row. No structural change. |
| Should be a NEW dashboard row but doesn't exist yet | Add the row to `מאזן חברה` / `מאזן אישי` (append to the relevant section, not the middle). |
| Should be a sub-row under an existing parent (e.g. `דלק רוביקון` under `דלק`) | Phase 2 work — Phase 1 just creates the leaf row. |
| Ambiguous (e.g. `חברה / מס הכנסה / ביטוח לאומי` — business or personal?) | Mark `needs_review` in `קטגוריות`, do not auto-place. |

Categories should be tagged with a `group` (top bucket) and `section` (sub-bucket) that already exists in the NEW dashboard. The most common targets:

- `הוצאות בית` (housing)
- `אוכל` (food)
- `רכב / תחבורה` (transport, where `רוביקון` lives)
- `בריאות`
- `הוצאות זמניות / מיוחדות`
- `עסק` (business, only for owner)

### E. Steven-specific category profile plan

A new join table, `User_Category_Profile`, holds (user_id, category_id) pairs that are active for that user.

For Steven specifically:
- All ~60-80 OLD categories with `historical_total > 0` get `active=TRUE`, `created_from='OLD_MIGRATION'`.
- His Steven-only categories (`אבא`, `גיא`, `חצי אירון מן`, `חצי אוסטריה`, `עורך דין`, `בנק הפועלים`, `BMW`, `רוביקון`) are explicitly `default_for_new_users=FALSE` in `קטגוריות`.

### F. Generic new-client template plan

For a new signup, `buildTenantSheetSpec` should:
- Read the `קטגוריות` master (or its KV mirror) filtered by `default_for_new_users=TRUE`.
- Insert those ~20 categories into the new user's `מאזן חברה` / `מאזן אישי`.
- Insert one row per category in `User_Category_Profile` with `active=TRUE`, `created_from='NEW_USER_DEFAULT'`.
- Do NOT include Steven-specific categories.
- Do NOT include 80 historical categories that would scare a new user with an empty dashboard.

Default-for-new-users categories (proposed):
```
אוכל, אוכל לבית, אוכל בחוץ, דלק, ביטוח רכב, חניה, ארנונה, חשמל, מים,
אינטרנט/פלאפון, ביטוח אישי, בריאות, ספורט, חופשות, מתנות, ביגוד,
שונות, חיסכון, השקעות, הכנסה
```

### G. Rubicon vehicle category plan

`רוביקון` is a row in `קטגוריות` with:
- `group = רכב / תחבורה`
- `section = רכב`
- `subcategory = רוביקון`
- `keywords = רוביקון, Rubicon, ג'יפ, Jeep, רכב, אוטו`
- `active_for_steven = TRUE`
- `default_for_new_users = FALSE`

Sub-leaves (`דלק`, `ביטוח`, `טסט`, `טיפולים`, `חניה`, `כביש 6`, `שטיפה`, `תיקונים`, `אביזרים`) live under `רוביקון` in a future phase. Phase 1: a single `רוביקון` row gets the entire vehicle expense bucket.

Bot routing examples:
- `רוביקון 500 טיפול` → category `רוביקון`, subcategory `טיפולים`, group `רכב/תחבורה`
- `דלק רוביקון 400` → category `דלק`, vehicle tag `רוביקון`
- `ביטוח רוביקון 2500` → category `ביטוח רכב`, vehicle tag `רוביקון`

**Hard rule:** `רוביקון` never becomes a tab. Never lands in `שונות`. Never lands in a personal sheet's `רכב` row that says `BMW`. Always its own row under `רכב / תחבורה`.

### H. Dashboard formula update plan

Phase 1 (this PR-series):
- For each category in `קטגוריות` with `active_for_steven=TRUE`, ensure a row exists on `מאזן חברה` (and `מאזן אישי` for personal categories).
- Each new row gets a label = `display_name` and a SUMIFS formula:
  - Year filter: `$B$4&"-MM"` against col B of `תנועות`
  - Subcategory filter: `display_name` against col E of `תנועות`
  - Sum range: col C of `תנועות`
- Existing formulas are read but never overwritten unless the validator (`kesefle-sheet-formula-year-selector-validator`) explicitly flags them as broken AND a backup exists.

Phase 2 (future, not in this plan):
- A `_DASHBOARD_DRIVER_` tab dynamically builds the formula list from `User_Category_Profile`. Removes the hardcoded row lists entirely.

### I. Year selector plan

See Part B below.

### J. Bot / category sync plan

1. Update `bot/ExpenseBot_FIXED.gs` `CATEGORY_MAP` so every entry's `subcategory` value matches a `display_name` in `קטגוריות`. Any drift is a bug.
2. Add `lib/categories.js` exports for the `קטגוריות` master so admin pages + dashboard can read the same vocabulary.
3. Bot's `_resolveCategory_` consults `קטגוריות` keywords field first, then falls back to its hardcoded heuristics. Unknown → `needs_review`, never `שונות` silently.
4. KV mirror: `categories:master` (refreshed nightly + on write), `categories:user:{sub}` (refreshed on `User_Category_Profile` change).
5. Bot adds a regression test: `bot/test_category_master_sync.js` asserts every `CATEGORY_MAP` `subcategory` value exists in `קטגוריות`.

### K. Dry-run design

`bot/CATEGORY_RECONCILIATION_DRY_RUN.gs` — paste-once Apps Script.

Reads OLD + NEW. Writes nothing.

Output sections (logged to Apps Script execution log + optionally to a hidden `_RECON_DRY_RUN_REPORT_` tab):

1. **OLD category inventory**: ~80 rows with full provenance.
2. **NEW dashboard row inventory**: ~30 rows of current dashboard labels.
3. **Bot CATEGORY_MAP inventory**: ~40 rows.
4. **Mapping table**: OLD category → proposed NEW category → action.
5. **Categories that would land in `קטגוריות`** (NEW master rows to insert).
6. **Categories that would land in Steven's `User_Category_Profile`** (active=TRUE).
7. **Dashboard rows that would be added** (with the proposed SUMIFS formula).
8. **Bot CATEGORY_MAP entries that would change** (with before/after).
9. **needs_review categories** (require Steven's call before apply).
10. **Risk list**.

### L. Apply design

`bot/CATEGORY_RECONCILIATION_APPLY.gs` — paste-once Apps Script.

Gated by:
```javascript
var gate = PropertiesService.getScriptProperties().getProperty('CONFIRM_CATEGORY_RECON');
if (gate !== 'YES I UNDERSTAND') {
  throw new Error('Refusing to apply. Set CONFIRM_CATEGORY_RECON = YES I UNDERSTAND first.');
}
```

Steps:
1. Backup: snapshot every range it will write into `DocumentProperties.backup_CATEGORY_RECON_<stamp>`.
2. Create the `קטגוריות` tab if missing. Insert rows (append-only).
3. Create the `User_Category_Profile` tab if missing. Insert rows for Steven.
4. Append new rows to `מאזן חברה` / `מאזן אישי` at the bottom of their respective sections. Set the SUMIFS formula. **Never** overwrite an existing user-typed cell.
5. Log every write with cell address + before/after.
6. Do NOT touch OLD sheet.
7. Do NOT touch `תנועות` or `הזמנות` raw rows.

### M. Validation design

`bot/CATEGORY_RECONCILIATION_VALIDATE.gs` — paste-once Apps Script.

For every migrated category, prove:
- Row exists in `קטגוריות`.
- Row exists in Steven's `User_Category_Profile` with `active=TRUE`.
- Row exists in the appropriate dashboard tab with the right SUMIFS formula.
- The SUMIFS returns a non-zero result if `historical_total > 0` and the corresponding `תנועות` rows exist.
- Year sweep: changing `$B$4` from 2023 → 2024 → 2025 → 2026 changes the total in a plausible way.

Output a single-screen `PASS / FAIL / NEEDS_REVIEW` verdict.

### N. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Apply overwrites a Steven-typed value (rows 12, 14) | Medium | High | `safeSetFormula` skips cells with non-formula values |
| New rows shift dashboard layout (charts misalign) | Medium | Low | Append to bottom of sections, not middle |
| KV blow-up (master + per-user mirror grow with categories) | Low | Low | Cache TTL 24h, refresh on write |
| Bot regression — old expense types stop classifying | Low | High | Regression test in Phase J step 5 |
| `needs_review` categories left unresolved | High | Medium | Surface in Admin inbox |
| OLD sheet is mutated by mistake | Very low | Critical | Tool is read-only on OLD; tested with `_SDOLD_SELF_TEST_HEBREW_` |

### O. Exact files / sheets / functions that will change

**Repo:**
- New: `bot/CATEGORY_RECONCILIATION_DRY_RUN.gs`
- New: `bot/CATEGORY_RECONCILIATION_APPLY.gs`
- New: `bot/CATEGORY_RECONCILIATION_VALIDATE.gs`
- New: `bot/test_category_master_sync.js`
- Edit: `bot/ExpenseBot_FIXED.gs` — `CATEGORY_MAP` adjustments, `_resolveCategory_` consults the master
- Edit: `lib/categories.js` — re-export `קטגוריות` master
- Edit: `lib/sheet-writer.js` `buildTenantSheetSpec` — for new users only, use `default_for_new_users=TRUE` filter
- New: `docs/CATEGORY_RECONCILIATION_RUNBOOK.md` — Steven's step-by-step
- New: `api/admin/categories.js` — admin view of `קטגוריות` + `needs_review` queue (Pro polish)

**Steven's NEW sheet:**
- New tab: `קטגוריות`
- New tab: `User_Category_Profile`
- Append rows: `מאזן חברה`, `מאזן אישי` (per `active_for_steven`)
- No deletes, no overwrites of existing rows

### P. Recommendation

I recommend Steven's proposed structure **with one architectural improvement**:

- **Original**: Categories live in `קטגוריות` + `User_Category_Profile`, dashboard formulas reference fixed row labels.
- **Improved**: Same data model, but the dashboard formula generator reads `User_Category_Profile` at write time, so adding/removing a category doesn't require dashboard edits. (Phase 2 — not blocking.)

Phase 1 (this plan) implements the data model + manual dashboard row insertion. Phase 2 (later) makes the dashboard fully dynamic. Splitting reduces risk and lets us ship value sooner.

---

## Part B — Year Selector + Historical Migration (sections A through M)

### A. How the old year-switch behavior likely worked

Most likely one of:
1. A dropdown cell (e.g. `מאזן אישי!B4`) bound to a `=YEAR(TODAY())` or hardcoded value, referenced by every SUMIFS as `$B$4&"-MM"`. This is the cleanest pattern and is already used in the NEW `מאזן חברה`.
2. A custom Apps Script menu (`טפסים > בחר שנה`) that wrote a new value into `Settings!active_year`.
3. Separate year tabs (one per year) that the user navigated between manually.

The SHEET_DIFF tool's § 1 (tab inventory) will tell us which OLD tabs exist. If `2023` / `2024` / `2025` tabs exist, pattern 3 was in play; otherwise probably pattern 1.

### B. Best recommended year-selector design for the new sheet

A single source of truth: `מאזן חברה!B4` (and `מאזן אישי!B4` mirrored from it via `=מאזן חברה!B4`). Implemented as:
- Data validation = list of [2023, 2024, 2025, 2026, 2027].
- Default value = current Jerusalem year on first load (set once, then user-controlled).
- All dashboard SUMIFS use `$B$4&"-MM"` against col B of `תנועות`.

This is **already partially in place** on `מאזן חברה`. The plan is to:
1. Validate every formula uses `$B$4` (skill: `kesefle-sheet-formula-year-selector-validator`).
2. Add `מאזן אישי!B4` referencing `=מאזן חברה!B4` so personal dashboard switches in sync.
3. Migrate any hardcoded `"2026-..."` strings to `$B$4&"-..."`.

### C. Where active_year will be stored

`מאזן חברה!B4`. The NEW sheet already has a year-selector cell — confirmed by Steven's screenshot (top of conversation, showing `שנה: 2026` with dropdown `2023 / 2024 / 2025 / 2026`).

A Script Property `KFL_DEFAULT_YEAR` can override default-on-load behavior if needed (low priority).

### D. Which formulas will depend on active_year

Every SUMIFS / SUMPRODUCT on `מאזן חברה`, `מאזן אישי` with a month criterion. That's the entire monthly grid (~12 cols × ~30 rows × 2 dashboards = ~720 formulas, of which probably ~600 use `$B$4` correctly and ~120 may have legacy hardcoded years).

The validator will produce the exact count.

### E. How historical data from 2023/2024/2025 will be preserved

Two-layer approach:
1. **Raw rows in `תנועות`** — already present where the migration brought them. Use SHEET_DIFF tool to confirm row counts per year. If 2023 rows are missing, that data lived only in OLD dashboard cells (not `תנועות`) and must be reconstructed.
2. **Preserved historical summaries** — for years where raw `תנועות` rows do NOT exist but OLD dashboard cells had real values, copy those values into a new tab `סיכום היסטורי` with one column per year. Dashboard formulas fall back to this tab when `תנועות` has no rows for the selected year.

`סיכום היסטורי` is **read-only** to the user, populated only by the migration apply step, and never written to by the bot.

### F. How notes/comments will be migrated

This is the honest part: Google Sheets cell notes / comments don't migrate via raw row copies. The migration tool would need to call `getNotes()` on each OLD cell and `setNotes()` on the equivalent NEW cell.

Plan:
1. SHEET_DIFF tool extends to read OLD cell notes for `תנועות` + `מאזן אישי` + `מאזן חברה`.
2. Map OLD note location → NEW note location (transactions by `B+C+E` signature; dashboard by `(row_label, year, month)`).
3. Where mapping is unambiguous, copy the note.
4. Where unambiguous mapping isn't possible (e.g. orphan dashboard cells), **report explicitly** in the validation output. Do NOT silently drop. Steven sees the list of dropped notes and decides whether they matter.

### G. How category totals by year will be validated

For each `(category, year)` pair in OLD:
- Read OLD's value (from dashboard or computed from `תנועות`).
- Read NEW's value (after apply).
- Diff.

Pass if `|diff| < ₪1`. Fail otherwise.

This is the Phase 7 validation matrix in `kesefle-financial-data-integrity-guard`.

### H. How Rubicon will be added under רכב / תחבורה

See Part A, section G. Same plan applies here.

### I. Dry-run design (year selector)

A second paste-once script `bot/YEAR_SELECTOR_DRY_RUN.gs`:
1. Scans every formula on `מאזן חברה` + `מאזן אישי`.
2. Reports every formula with a hardcoded year, with proposed replacement.
3. Reports every formula missing `$B$4` reference.
4. Sweeps `$B$4` from 2023 → 2024 → 2025 → 2026 and logs per-category totals (does NOT change `$B$4` permanently — restores on exit).
5. Reports per-year `תנועות` row counts vs dashboard totals.

### J. Apply design (year selector)

`bot/YEAR_SELECTOR_APPLY.gs`:
- Gated by `CONFIRM_YEAR_SELECTOR=YES I UNDERSTAND`.
- Backup snapshot of every formula it will rewrite.
- Replace hardcoded years with `$B$4&"-MM"` using `safeSetFormula`.
- Add data validation list to `B4` (2023..2030) if not present.
- Add `מאזן אישי!B4 = =מאזן חברה!B4` if not present.

### K. Validation plan (year selector)

`bot/YEAR_SELECTOR_VALIDATE.gs`:
- Run the skill `kesefle-sheet-formula-year-selector-validator` — see its SKILL.md.
- Sweep test produces a pass/fail per (year, category).
- Single PASS/FAIL verdict.

### L. Risks (year selector)

| Risk | Mitigation |
|------|-----------|
| Replacing a formula breaks a chart bound to that cell | Backup first; chart updates re-bind to the same cell |
| `B4` data validation triggers re-render of every formula at once | Sheets handles this; if slow, do it once after-hours |
| User pre-fills a year value Sheets parses as text not number | Validation enforces number type |

### M. Exact sheets / functions / files (year selector)

**Repo:**
- New: `bot/YEAR_SELECTOR_DRY_RUN.gs`
- New: `bot/YEAR_SELECTOR_APPLY.gs`
- New: `bot/YEAR_SELECTOR_VALIDATE.gs`
- Edit: `bot/personal_sheet_fix.gs` — `RECOMPUTE_*` functions audit themselves with the validator
- New: `docs/YEAR_SELECTOR_RUNBOOK.md`

**Steven's NEW sheet:**
- Edit cell: `מאזן חברה!B4` (data validation list)
- Edit cell: `מאזן אישי!B4` (set to `=מאזן חברה!B4`)
- Edit formulas: any hardcoded-year formula → `$B$4`-based
- New tab: `סיכום היסטורי` (only if historical reconstruction is needed)

---

## Sequence

These three should ship as a sequence of PRs, not at once:

1. **PR-A**: SHEET_DIFF_OLD_VS_NEW report (already shipped — PR #143). Steven runs it. Output drives PR-B/C/D.
2. **PR-B**: Year-selector validator + DRY_RUN. No writes. Identifies hardcoded-year formulas. Outputs a fix list.
3. **PR-C**: Year-selector APPLY + VALIDATE. Gated by `CONFIRM_YEAR_SELECTOR`. Steven runs it.
4. **PR-D**: Category-reconciliation DRY_RUN. No writes. Outputs the `קטגוריות` + `User_Category_Profile` proposal.
5. **PR-E**: Category-reconciliation APPLY + VALIDATE. Gated by `CONFIRM_CATEGORY_RECON`. Steven runs it.
6. **PR-F**: Bot `CATEGORY_MAP` sync to `קטגוריות` master + regression test.
7. **PR-G**: `lib/sheet-writer.js` `buildTenantSheetSpec` uses `default_for_new_users` filter (affects only new signups, not Steven).

Currency / EUR / USD / MSTR — wait until PR-G is shipped and stable.

---

## What I need from Steven before any APPLY runs

1. Run the SHEET_DIFF tool (PR #143). Share the `_DIFF_REPORT_` markdown with me.
2. Approve Part A § P (the "Phase 1 + Phase 2" split).
3. Approve Part B § B (the single `$B$4` source of truth).
4. Confirm the Rubicon mapping (Part A § G).
5. Confirm I should treat his Steven-only categories as `default_for_new_users=FALSE`.

Once those 5 confirmations are in: PR-B through PR-G can ship as a structured sequence with Steven approving each apply gate.

---

## Hard rules carried through all phases

- OLD sheet `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` is read-only forever.
- No row in `תנועות` or `הזמנות` is deleted, ever.
- No formula is replaced without a backup.
- Steven-typed rows (12 marketing, 14 operations) are protected by `safeSetFormula`.
- `רוביקון` goes under `רכב / תחבורה`, never `שונות`, never its own tab.
- `אבא` / `גיא` / `חצי אירון מן` are Steven-only, never default for new users.
- No formula hardcodes `2026`. `$B$4` everywhere.
- DRY_RUN before APPLY before VALIDATE. Always all three. Always in that order.
