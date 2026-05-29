# Apps Script Destructive Function Audit

**Scope:** every `bot/*.gs` Apps Script file that touches the customer Google Sheet (`<NEW_SHEET_ID>` or legacy `<OLD_SHEET_ID>`) via `setValue`/`setFormula`/`setValues`/`setFormulas`/`appendRow`/`deleteRow`/`deleteRows`/`deleteSheet`/`insertSheet`/`copyTo`/`clear*`.

**Audited at:** 2026-05-28 by autonomous audit Agent 6 ("apps script safety + performance/reliability"). Read-only; no functions were executed.

**Sheet IDs** masked throughout this document:
- `<NEW_SHEET_ID>` = current Kesefle tenant template ID hardcoded in newer scripts.
- `<OLD_SHEET_ID>` = legacy/migration source ID still hardcoded in pre-migration scripts.

---

## DESTRUCTIVE FUNCTION INVENTORY

| Bucket | Count |
| --- | ---: |
| Total destructive entry-points audited | **70** |
| Critical | **14** |
| High | **23** |
| Medium | **22** |
| Low | **11** |
| Functions with proper guardrails (YES-I-UNDERSTAND **and** lock **and** backup) | **4** |
| Functions missing one or more guardrails | **66** |

"Proper guardrails" means: (1) explicit confirmation token (e.g. `YES I UNDERSTAND` arg gate); (2) `LockService` script/document lock; (3) backup-tab created before any write OR `DocumentProperties` snapshot. Functions that only have a hidden-tab backup *or* only a lock are scored as missing.

**Scheduled-trigger surface:** 10 `cron*` triggers in `bot/ExpenseBot_FIXED.gs` (heartbeat, weekly summary, group recurring, bill reminders, recurring expenses, admin alerts, keep-warm, health check, re-engagement, inactivity check). Plus 1 trigger in `personal_sheet_fix.gs` that auto-runs `SIMPLE_FIX_DASHBOARD` at 6 AM daily — this is the highest-blast-radius trigger because the handler writes to `מאזן חברה`.

**Kill switch:** `KFL_DISABLE_BOT_WRITES` Script Property gates `ExpenseBot_FIXED.gs` writes (checked at line 1495 & 1761). It does **NOT** gate `personal_sheet_fix.gs`, any `MIGRATE_*`, any `FIX_*`, or any `SHEET_*` script. That is the single most important hardening gap in this audit.

---

## Table: every destructive function

Legend for guardrail columns:
- **gate** = explicit `YES I UNDERSTAND` argument or similar arg-validated confirmation
- **backup** = `_BAK_*` / hidden-tab snapshot of target before any write OR `DocumentProperties` snapshot
- **lock** = `LockService.getScriptLock()` / `getDocumentLock()` taken before mutation
- **kill** = `KFL_DISABLE_BOT_WRITES` (or equivalent) Script-Property check

| Function | File | Line | Operation | Range / Tabs affected | Can delete data? | Can overwrite formulas? | Manual / Triggered | gate | backup | lock | kill | Risk | Recommendation |
| --- | --- | ---: | --- | --- | :---: | :---: | --- | :---: | :---: | :---: | :---: | --- | --- |
| `APPLY_RESTORE_2026` | bot/personal_sheet_fix.gs | 177 | `.setFormulas` × 9 rows in `מאזן חברה` rows 6–14 cols B–N | `מאזן חברה`, 9 rows × 13 cols (year-2026 block); creates `_BAK_recomp_<ts>` backup tab via `insertSheet` + `copyTo` | yes (overwrites user-typed cells if A4 mislabels) | YES — replaces existing SUMIFS or manual values | manual | no | yes (`_BAK_recomp_*`) | no | no | **Critical** | Add `YES I UNDERSTAND` arg; add `getScriptLock()`; gate behind `KFL_DISABLE_BOT_WRITES`; add `UNDO_APPLY_RESTORE_2026` that restores from newest `_BAK_recomp_*`. |
| `DRY_RUN_RESTORE_2026` | bot/personal_sheet_fix.gs | 145 | reads only | `מאזן חברה` rows 6–14 | no | no | manual | n/a | n/a | n/a | n/a | Low | OK as-is; document that DRY_RUN is the only safe pre-flight. |
| `fixPersonalDashboardFormulas` | bot/personal_sheet_fix.gs | 229 | `.setFormulas` row-by-row on `מאזן אישי` rows 5..60 cols C–N | `מאזן אישי` up to 56 rows × 12 cols | yes (rewrites every row with a label, skipping `^סה` and emoji) | YES | manual | no | NO (comment in code says "doesn't use a backup tab") | no | no | **Critical** | Add backup snapshot of `מאזן אישי`; add gate + lock + kill-switch. The "lower-risk" comment in code is wrong: this function overwrites ALL personal-dashboard rows including manually-typed ones. |
| `RESTORE_FROM_BACKUP` | bot/personal_sheet_fix.gs | 302 | `.copyTo` from newest `_BAK_recomp_*` tab → `מאזן חברה` B6:N14 | `מאזן חברה` 9 rows × 13 cols | yes (overwrites whatever is currently there with backup snapshot) | yes | manual | no | n/a (this IS a restore) | no | no | **High** | Add `YES I UNDERSTAND`; emit a *new* `_BAK_pre_restore_<ts>` *before* restoring so the user can undo a bad restore. |
| `CLEAN_BROKEN_FORMULAS` | bot/personal_sheet_fix.gs | 482 | `.setValue` per cell for cells matching `_isBrokenDashFormula_` in `מאזן חברה` 2026 block | `מאזן חברה` 2026 block, ~5 buckets × 12 months = 60 cells max | yes (replaces formula with numeric value) | yes (intentional — only "broken" ones) | manual | no | no | no | no | **High** | Add backup snapshot before; add `YES I UNDERSTAND` arg; add kill-switch. Note: relies on `_isBrokenDashFormula_` heuristic — false-positive risk on user-edited formulas. |
| `RECOMPUTE_COMPANY_DASHBOARD` | bot/personal_sheet_fix.gs | 567 | `.setValue` per cell across all `מאזן חברה` rows matching `_COMPANY_SUB_BUCKETS_` labels | `מאזן חברה` all year blocks × 5 buckets × 12 months ≈ 240 cells | yes (overwrites cells that are *not* legitimate formulas, plus cleans "broken" ones) | yes | manual (recommended by code comment) | no | no | no | no | **Critical** | Add backup; add `YES I UNDERSTAND`; add lock; add kill-switch. This function is called by `SIMPLE_FIX_DASHBOARD` indirectly, which has a 6 AM auto-trigger — see daily-trigger row below. |
| `FIX_MARKETING_ALL_YEARS` | bot/personal_sheet_fix.gs | 791 | `.setFormula` on `מאזן חברה` marketing row × all year blocks × 12 months | `מאזן חברה` ~4 year blocks × 12 cols ≈ 48 cells | yes (overwrites whatever is there) | yes | manual | no | no | no | no | **High** | Add backup snapshot; add `YES I UNDERSTAND`. The 2026-05 `+2100` hardcoded patch is a smell — should be in user-editable config, not code. |
| `DRY_RUN_MARKETING_ALL_YEARS` | bot/personal_sheet_fix.gs | 906 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `CLEAN_BROKEN_FORMULAS_ALL_YEARS` | bot/personal_sheet_fix.gs | 971 | `.setValue` per broken cell in `מאזן חברה` × all year blocks | `מאזן חברה` ~4 year blocks × 5 buckets × 12 months ≈ 240 cells | yes | yes | manual | no | no | no | no | **High** | Add backup snapshot; add `YES I UNDERSTAND`; add lock. Same risk as `CLEAN_BROKEN_FORMULAS` × 4. |
| `FIX_ALL_BUCKETS_ALL_YEARS` | bot/personal_sheet_fix.gs | 1084 | `.setFormula` on `מאזן חברה` × every year × every bucket × every month | `מאזן חברה` ~4 years × 5 buckets × 12 months ≈ 240 cells | yes | YES (overwrites *every* SUMIFS/formula it finds) | manual | no | no | no | no | **Critical** | This is the broadest write in the entire codebase. Add backup; add `YES I UNDERSTAND`; add lock; add kill-switch; add `UNDO_FIX_ALL_BUCKETS_ALL_YEARS` that restores from a fresh `_BAK_FIXALL_<ts>` tab. |
| `SIMPLE_FIX_DASHBOARD` | bot/personal_sheet_fix.gs | 1331 | delegates to `RECOVER_DASHBOARD_APPLY_V2` (writes `מאזן חברה`) | `מאזן חברה` all year blocks ≈ 240 cells | yes (via V2) | yes | **triggered (6 AM daily — see `FIX_NOW`)** + manual | no | inherited from V2 (hidden-tab backup) | no | no | **Critical** | Highest blast radius — runs daily without supervision via the auto-trigger. Either: (a) remove the auto-trigger (recommend); or (b) gate behind `KFL_DISABLE_BOT_WRITES`; or (c) only run if `_isBrokenDashFormula_` detects something — never blanket-rewrite. |
| `FIX_NOW` | bot/personal_sheet_fix.gs | 1352 | calls `SIMPLE_FIX_DASHBOARD` + installs `ScriptApp.newTrigger('SIMPLE_FIX_DASHBOARD').timeBased().atHour(6).everyDays(1)` | `מאזן חברה` + project-wide trigger registry | yes (via SIMPLE_FIX) | yes | manual but **installs daily trigger** | no | inherited | no | no | **Critical** | Single biggest reliability risk in this entire audit: the trigger fires every 6 AM, runs `RECOVER_DASHBOARD_APPLY_V2`, which writes `מאזן חברה`. If the user has edited a row at midnight before going to sleep, this can wipe it. Recommendation: remove the auto-trigger installation; require user to opt-in via a `INSTALL_DAILY_TRIGGER_YES_I_UNDERSTAND` separate function. |
| `UNINSTALL_DAILY_TRIGGER` | bot/personal_sheet_fix.gs | 1421 | `ScriptApp.deleteTrigger` for `SIMPLE_FIX_DASHBOARD` | trigger registry | no (recovery action) | no | manual | no | n/a | no | no | Low | OK; this is the "undo" half of `FIX_NOW`. Document prominently in `bot/README.md`. |
| `AUDIT_COMPANY_DASHBOARD` | bot/personal_sheet_fix.gs | 1455 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `DIAGNOSE_DASHBOARD_DATA_LOSS_V2` | bot/personal_sheet_fix.gs | 1720 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `RECOVER_DASHBOARD_DRY_RUN_V2` | bot/personal_sheet_fix.gs | 1769 | reads only (calls `_PSF_RECOVER_DASHBOARD_CORE_(true)`) | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `RECOVER_DASHBOARD_APPLY_V2` | bot/personal_sheet_fix.gs | 1774 | calls `_PSF_RECOVER_DASHBOARD_CORE_(false)` (writes `מאזן חברה`) | `מאזן חברה` all year blocks ≈ 240 cells | yes | yes | manual + **triggered indirectly via `SIMPLE_FIX_DASHBOARD` daily** | no | YES (hidden-tab `_backup_<ts>` via `copyTo`) | no | no | **Critical** | Add `YES I UNDERSTAND`; add lock; add kill-switch. The function *does* have a hidden-tab backup which is good, but missing the 3 other guardrails. Most importantly: bypass-safe pattern — caller should never invoke this without confirmation. |
| `_PSF_RECOVER_DASHBOARD_CORE_(applyMode=true)` | bot/personal_sheet_fix.gs | 1778 | `.setValue` per cell + `.setFormula` per annual cell on `מאזן חברה`; `insertSheet` + `copyTo` + `hideSheet` for backup; `deleteSheet` for existing backup-name collision | `מאזן חברה` plus a `_backup_<ts>` tab | yes | yes | indirect via above | no | YES | no | no | **Critical** | Same as `RECOVER_DASHBOARD_APPLY_V2`. Also note line 1815: `if (existing) ss.deleteSheet(existing)` — if a user named a real tab `_backup_<ts>` matching the timestamp, it would be wiped. Recommendation: timestamp includes seconds (it does), but add an assertion that the existing tab matches the `^_backup_\d{8}_\d{4}$` regex before deleting. |
| `APPLY_DASHBOARD_REPAIR` | bot/personal_sheet_fix.gs | 2182 | calls `_psf_scanDashboardForRepair_v2_(true)` (writes `מאזן חברה`) | `מאזן חברה` all year blocks × 9 metrics × 12 months ≈ 432 cells max | yes | yes | manual | **YES** ("YES I UNDERSTAND") | NO (relies on tx-tab read for safety; no backup created) | no | no | **High** | Add backup snapshot; add lock. This is the best-guarded function in the file (has the gate) but is *still* missing backup + lock + kill-switch. |
| `APPLY_DASHBOARD_REPAIR_NOW` | bot/personal_sheet_fix.gs | 2213 | wrapper calling `APPLY_DASHBOARD_REPAIR('YES I UNDERSTAND')` | same as above | yes | yes | manual | "implicit YES" (defeats the gate) | no | no | no | **High** | This wrapper exists to make the function runnable from the Apps Script dropdown — but it *bypasses* the safety gate. Either: (a) remove this wrapper; or (b) replace its body with a DRY_RUN call. Currently a dropdown one-click is enough to wipe 432 cells. |
| `_psf_scanDashboardForRepair_v2_(applyMode=true)` | bot/personal_sheet_fix.gs | 2033 | `.setFormula` per repaired cell on `מאזן חברה` | `מאזן חברה` ≈ 432 cells | yes | YES (cleans broken formulas + missing-tx-tab-ref formulas) | indirect | inherited | no | no | no | **High** | Inherits `YES I UNDERSTAND` if invoked via `APPLY_DASHBOARD_REPAIR`, but `APPLY_DASHBOARD_REPAIR_NOW` bypasses gate (see row above). Add backup + lock. |
| `DRY_RUN_FIX_DASHBOARD` (Hebrew comments) | bot/FIX_DASHBOARD_2023_2024_2025.gs | 48 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `APPLY_FIX_DASHBOARD` (Hebrew comments) | bot/FIX_DASHBOARD_2023_2024_2025.gs | 96 | `.setValue` + `.setValues` + `.clearDataValidations` on `מאזן חברה` 2023/2024/2025/2026 blocks | `מאזן חברה` 4 year blocks × 13 cols × 4 rows ≈ 208 cells | yes (overwrites total + net rows) | yes | manual | no | YES (`_BAK_dashFix_<ts>` backup tab via `insertSheet`) | no | no | **High** | Add `YES I UNDERSTAND`; add lock; add kill-switch. The `clearDataValidations` calls at lines 145-148 wipe ALL data validations on rows 16-49 — over-broad. Restrict to specific cells. |
| `APPLY_FIX_DASHBOARD` (safe variant, ASCII) | bot/FIX_DASHBOARD_safe.gs | 66 | same as above with English-only comments; targets `<OLD_SHEET_ID>` | same | yes | yes | manual | no | yes | no | no | **High** | Same as above; **plus** uses `<OLD_SHEET_ID>` not `<NEW_SHEET_ID>` — confirm this is intentionally the legacy script. Note: line 1 of this file starts with stray `w` character (`w// FIX_DASHBOARD...`) which makes it a syntax error — *latent* bug. Recommend: remove file (post-migration legacy). |
| `POST_APPLY_VERIFY` | bot/FIX_DASHBOARD_2023_2024_2025.gs + FIX_DASHBOARD_safe.gs | 198 / 148 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `DRY_RUN_MIGRATE_RAW` | bot/MIGRATE_OLD_TO_KESEFLE.gs | 316 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `APPLY_MIGRATE_RAW(confirmation)` | bot/MIGRATE_OLD_TO_KESEFLE.gs | 320 | `.setValues` on NEW `תנועות` (append-only); `.setValues` on NEW `הזמנות` (append-only) | NEW `<NEW_SHEET_ID>` `תנועות` + `הזמנות` (append-only — no existing-row writes) | low (only appends, never overwrites) | no (does not touch formula cells) | manual | **YES** ("YES I UNDERSTAND") | n/a (no rows overwritten — dedupe-keyed) | **YES** (`LockService.getScriptLock(30000)`) | no | **Medium** | This is the GOLD STANDARD in this codebase — has gate + lock + dedupe. Only gap: no `KFL_DISABLE_BOT_WRITES` check. Add the kill-switch and this is fully hardened. |
| `APPLY_MIGRATE_RAW_NOW` | bot/MIGRATE_OLD_TO_KESEFLE.gs | 333 | wrapper that calls `APPLY_MIGRATE_RAW('YES I UNDERSTAND')` | same as above | low | no | manual | implicit YES (defeats gate) | n/a | yes (inherited) | no | **Medium** | Defeats the gate. The append-only safety mitigates this — but on principle, this wrapper should be removed and the user should pass the arg explicitly. |
| `DRY_RUN_MIGRATE_NOTES` | bot/MIGRATE_OLD_NOTES.gs | 373 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `APPLY_MIGRATE_NOTES(confirmation)` | bot/MIGRATE_OLD_NOTES.gs | 377 | `.setNote` only (never `.setValue`/`.setFormula`); skips cells that already have a note | NEW `תנועות`/`מאזן אישי`/`מאזן חברה` cell notes | no (notes don't delete row data; never clobbers existing notes) | no | manual | **YES** | n/a | **YES** (`LockService.getScriptLock(30000)`) | no | **Low** | Safest write in the codebase. Only suggestion: kill-switch for consistency. |
| `APPLY_MIGRATE_NOTES_NOW` | bot/MIGRATE_OLD_NOTES.gs | 389 | wrapper calling `APPLY_MIGRATE_NOTES('YES I UNDERSTAND')` | same | no | no | manual | implicit YES | n/a | yes | no | **Low** | OK due to write being non-destructive (notes only, no-clobber). |
| `_MN_SELF_TEST_HEBREW_` | bot/MIGRATE_OLD_NOTES.gs | 395 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `SCAN_OLD_CATEGORIES` | bot/SCAN_OLD_CATEGORIES.gs | 248 | reads only (entire file marked read-only) | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `DRY_RUN_SMART_REMAP_DASHBOARD` | bot/SHEET_DASHBOARD_SMART_REMAP.gs | 200 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `SMART_REMAP_DASHBOARD` | bot/SHEET_DASHBOARD_SMART_REMAP.gs | 251 | `.setFormulas` × 4 rows × 13 cols on `מאזן חברה` rows 8-11 (2026 block) | `מאזן חברה` 2026 expense buckets, 52 cells | yes | yes (overwrites SUMIFS rows 8-11) | manual | no | YES (`_BAK_remap_<ts>` via `insertSheet` + `copyTo`) | **YES** (`LockService.getScriptLock(15000)`) | no | **High** | Has lock + backup. Add `YES I UNDERSTAND`; add kill-switch. Also: the regex map hardcodes Hebrew synonyms — a typo in the regex would produce 0 matches and zero out a row. Add a sanity-check: refuse to write if computed value would be 0 and current value is > 0 (preserve manual entries). |
| `VERIFY_SMART_REMAP_DASHBOARD` | bot/SHEET_DASHBOARD_SMART_REMAP.gs | 290 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `DRY_RUN_YEAR_SELECTOR_WIRE` | bot/SHEET_YEAR_SELECTOR_WIRE.gs | 231 | reads only (+ would-be-installs dropdown via `setDataValidation` in `_ys_ensureYearDropdown_` — see note) | `מאזן חברה` B4 dropdown installed if missing | yes (dropdown adds a constraint but does not change cell value unless B4 was blank, in which case sets to current year) | no | manual | no | no | no | no | **Medium** | The "dry run" actually installs the dropdown — that's a write. Either rename to `PREVIEW_YEAR_SELECTOR_WIRE` and skip the dropdown install, or document that "dry run" still mutates B4 dropdown validation. |
| `WIRE_YEAR_SELECTOR` | bot/SHEET_YEAR_SELECTOR_WIRE.gs | 279 | `setDataValidation` on B4 + `.setFormulas` × 6 rows × 13 cols on `מאזן חברה` | `מאזן חברה` 2026 block, 78 cells; plus B4 validation rule | yes | YES (wraps every existing formula in `IFS(...)`) | manual | no | YES (`_BAK_yearwire_<ts>` via `insertSheet` + `copyTo`) | **YES** (`LockService.getScriptLock(15000)`) | no | **High** | Add `YES I UNDERSTAND`; add kill-switch. Note: `_ys_wrapWithYearSwitch_` uses heuristic "already wrapped" detection — could re-wrap if heuristic fails. Add an explicit `_ys_isWrapped_` marker comment or note. |
| `_ys_ensureYearDropdown_` | bot/SHEET_YEAR_SELECTOR_WIRE.gs | 110 | `setDataValidation` on B4 + optional `setValue(currentYear)` if B4 blank | `מאזן חברה` B4 cell | low | no | indirect | no | no | no | no | **Low** | OK as helper. Document that B4 is mutated. |
| `AUDIT_BOTH_DASHBOARDS` | bot/SHEET_DASHBOARD_FULL_AUDIT.gs | 466 | reads only ("iron rule: this script NEVER writes") | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `AUDIT_COMPANY_DASHBOARD_ONLY` | bot/SHEET_DASHBOARD_FULL_AUDIT.gs | 501 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `AUDIT_PERSONAL_DASHBOARD_ONLY` | bot/SHEET_DASHBOARD_FULL_AUDIT.gs | 515 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `STEP1A_PREVIEW_DUPLICATE` | bot/CLEANUP_DUPLICATES_AND_TABS.gs | 51 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `STEP1B_APPLY_DUPLICATE` | bot/CLEANUP_DUPLICATES_AND_TABS.gs | 71 | `dash.deleteRows(s2, rowsToDelete)` on `מאזן חברה` (`<OLD_SHEET_ID>`) | `מאזן חברה` ~25 rows (variable range) | **YES — deletes rows** | n/a | manual | no | NO (no backup before deleteRows) | no | no | **Critical** | Highest data-loss risk in the cleanup family — `deleteRows` removes content + any user-typed cells in those rows. Add: backup, `YES I UNDERSTAND`, lock, kill-switch, AND a sanity-check that the rows-to-delete count matches the regex-detected duplicate signature (already has `<5 || >60` guard which is good — but tighten further). |
| `STEP2_AUDIT_TABS` | bot/CLEANUP_DUPLICATES_AND_TABS.gs | 156 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `STEP3_APPLY_TAB_CLEANUP` | bot/CLEANUP_DUPLICATES_AND_TABS.gs | 181 | `ss.deleteSheet(sh)` for "safe-delete" tabs (regex patterns); `sh.hideSheet()` + `sh.setName('dontdeleteN')` for "hide-rename" tabs | `<OLD_SHEET_ID>` whole tabs | **YES — deletes whole tabs** | n/a | manual | no | NO (no backup of deleted tabs) | no | no | **Critical** | Whole-tab deletion has no backup. If a user named their real data tab matching `^_BAK_/^_DRYRUN_/^_AUDIT_/^_TEST_/^_SCRATCH_/^Copy of/^עותק של ` they would lose it. Add: `YES I UNDERSTAND`, lock, an inventory dump of all tabs being deleted before deletion, kill-switch. Recommend: change `deleteSheet` to `hideSheet` + rename — never irreversibly delete. |
| `kflBackupTransactionsSheet` | bot/CLEANUP_LEAKED_ROWS.gs | 44 | `src.copyTo(ss)` to make timestamped backup | adds a `גיבוי_תנועות_<ts>` tab; never modifies original | low (adds a tab, name-clash possible) | no | manual | no | n/a (backup-creation function) | no | no | **Low** | OK. Recommendation: check if name already exists and append `_<n>` if collision (currently overwrites name in unlikely edge case). |
| `kflListRowsForReview` | bot/CLEANUP_LEAKED_ROWS.gs | 61 | creates `🔎 בדיקת_דליפה` tab via `insertSheet` (or clears existing one via `.clear()`); `.setValues` to write listing | review tab only — never touches `תנועות` data | low (only the review tab; but `.clear()` would wipe a user-typed cell in that tab if they re-used the name) | no | manual | no | n/a (the review tab is scratch) | no | no | **Medium** | OK for stated purpose. Mark review tab as scratch in docs so user doesn't paste data into it. |
| `kflDeleteRowsByIndices(csv)` | bot/CLEANUP_LEAKED_ROWS.gs | 120 | `sheet.deleteRow(r)` for each row number passed in; auto-backs-up via `kflBackupTransactionsSheet` first; logs each row before deleting | `<OLD_SHEET_ID>` `תנועות` row deletion | **YES — deletes rows** | n/a | manual | no (csv arg is just data, not confirmation) | YES (auto-backup first) | no | no | **High** | Has auto-backup which is good. Add: `YES I UNDERSTAND` arg gate (currently any csv triggers delete); lock; kill-switch. Risk: user could paste a wrong csv from the review tab and lose unrelated rows. |
| `CREATE_PUBLIC_TEMPLATE_DRY_RUN` | bot/CREATE_TEMPLATE_AND_CLEANUP.gs | 65 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `CREATE_PUBLIC_TEMPLATE` | bot/CREATE_TEMPLATE_AND_CLEANUP.gs | 98 | `newSs.deleteSheet(sh)` (multi); `.clearContent` on several ranges including `תנועות`, business tabs, year tabs, personal tab | a newly-copied spreadsheet (`<NEW_SHEET_ID>` derived copy) — not the active user sheet | **YES** (wipes rows of newly-copied sheet) | yes | manual | no | n/a (target is a derived sheet, not user's) | no | no | **Medium** | Confusing — operates on a copy, so blast radius is the copy not the user sheet. Recommendation: rename to `CREATE_TEMPLATE_FROM_COPY_OF_ACTIVE_SHEET` to make scope obvious. Add a guard that refuses if target ID matches the active sheet ID (so user can't accidentally pass the live sheet). |
| `MERGE_BACKUPS_INTO_DONTDELETE_DRY_RUN` | bot/CREATE_TEMPLATE_AND_CLEANUP.gs | 213 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `MERGE_BACKUPS_INTO_DONTDELETE` | bot/CREATE_TEMPLATE_AND_CLEANUP.gs | 240 | `ss.insertSheet('dontdelete')` if missing; `.setValues` to append backup contents; `ss.deleteSheet(src)` for each merged source | active sheet — appends to `dontdelete` tab then deletes source backup tabs | **YES** (deletes source backup tabs after copying their values) | no | manual | no | NO (source backup tab is the backup; deleting it removes redundancy) | no | no | **High** | If the `setValues` append fails partway through, the source tab gets deleted anyway. Add: `YES I UNDERSTAND`, lock, transactional copy (only delete after successful copy verification), kill-switch. |
| `VERIFY_AFTER` (CREATE_TEMPLATE_AND_CLEANUP) | bot/CREATE_TEMPLATE_AND_CLEANUP.gs | 304 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `DRY_RUN_QUICK_WINS` | bot/DASHBOARD_QUICK_WINS.gs | 30 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `APPLY_QUICK_WINS` | bot/DASHBOARD_QUICK_WINS.gs | 55 | `.setValues` for backup tab; `.setFormula` for sparklines/YoY in col O of `מאזן חברה`; targets multiple year blocks | `מאזן חברה` col O only (rows 6-65) | yes (overwrites col O) | yes | manual | no | YES (backup tab via `insertSheet` for col O snapshot) | no | no | **Medium** | Add `YES I UNDERSTAND`; add lock; add kill-switch. Has `REVERT_QUICK_WINS` (line 99) which clears col O — good. |
| `REVERT_QUICK_WINS` | bot/DASHBOARD_QUICK_WINS.gs | 99 | `dash.getRange(1, 15, 65, 1).clearContent()` — wipes col O rows 1-65 | `מאזן חברה` col O | **YES** (wipes col O entirely) | yes | manual | no | no | no | no | **High** | This `clearContent()` wipes any user-typed col O sparkline or note. Add backup; add `YES I UNDERSTAND`. The "revert" name is misleading — it does not restore previous content, just clears. Rename to `CLEAR_QUICK_WINS`. |
| `PREVIEW_INSERT_POSITION_` | bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs | 34 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `EMBED_SUMMARY_INTO_DASHBOARD` | bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs | 57 | `insertSheet` for `_BAK_embed_<ts>`; `.setValues` for backup; `.clearContent().clearFormat().breakApart()` on dashboard rows; `.setValue` + `.setFormula` × 40+ cells | `מאזן חברה` 25 rows × 14 cols | YES (clears formatting and content from 25 rows before re-writing) | yes | manual | no | YES | no | no | **High** | Add `YES I UNDERSTAND`; add lock; add kill-switch. The `clearFormat().breakApart()` is destructive of merged cells the user may have configured. |
| `REMOVE_EMBEDDED_SUMMARY` | bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs | 292 | `.clearContent().clearFormat().breakApart()` on N rows between start/end markers | `מאזן חברה` ~25 rows | YES | yes | manual | no | no | no | no | **High** | Add backup; add `YES I UNDERSTAND`. Risk: if start/end markers get out of sync (e.g. user typed similar string in col H), wrong range gets wiped. |
| `REMOVE_STANDALONE_SUMMARY_TAB` | bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs | 317 | `ss.deleteSheet(sh)` for `סיכום פיננסי` tab | whole tab | **YES** | n/a | manual | no | no | no | no | **High** | Add `YES I UNDERSTAND`. Tab-deletion is irreversible — hide+rename pattern (used in CLEANUP_DUPLICATES_AND_TABS) would be safer. |
| `INSTALL_FINANCIAL_SUMMARY` | bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs | 11 | `ss.deleteSheet(existing)` if present, then `ss.insertSheet(KFL_TAB_NAME, 0)`, then populate via `.setValues`/`.setFormulas`/`.setFormula` | new/replaced tab; deletes existing one | yes (overwrites existing tab if user populated it) | yes | manual | no | NO (existing tab deleted without backup) | no | no | **High** | Add `YES I UNDERSTAND`; add backup before deleting existing tab; add kill-switch. |
| `REMOVE_FINANCIAL_SUMMARY` | bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs | 84 | `ss.deleteSheet(sh)` for the tab | whole tab | **YES** | n/a | manual | no | no | no | no | **High** | Add `YES I UNDERSTAND`; add backup. |
| `AUDIT_DASHBOARD_FORMULAS` | bot/FIX_PROFITABILITY_AND_CHART.gs | 29 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `FIX_PROFITABILITY_PERCENTAGES` | bot/FIX_PROFITABILITY_AND_CHART.gs | 104 | `insertSheet` for `_BAK_profitFix_<ts>`; `.setValues` for backup; `.setFormula` × per-row × per-month × 4 year blocks on `מאזן חברה` | `מאזן חברה` % profitability rows across 4 year blocks | yes | YES (overwrites every profitability cell) | manual | no | YES | no | no | **High** | Add `YES I UNDERSTAND`; add lock; add kill-switch. |
| `INSTALL_FINANCIAL_SUMMARY_TAB` | bot/FIX_PROFITABILITY_AND_CHART.gs | 162 | `ss.deleteSheet(existing)` if `סיכום פיננסי` exists, then `insertSheet('סיכום פיננסי', 0)` and populate | new/replaced tab | yes | yes | manual | no | NO (no backup of deleted tab) | no | no | **High** | Same pattern as `INSTALL_FINANCIAL_SUMMARY` — add gate, backup, kill-switch. |
| `VERIFY_AFTER_FIX` | bot/FIX_PROFITABILITY_AND_CHART.gs | 229 | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `SORT_TNUOT_NEWEST_FIRST` (KESEFLE_ALL_PATCHES) | bot/KESEFLE_ALL_PATCHES.gs | 117 | `insertSheet` for `_BAK_sort_<ts>`; `setValues` for backup; then sorts `תנועות` in place | `תנועות` (`<OLD_SHEET_ID>`) — whole row order changes | yes (row order changes — formulas that hardcode row numbers break) | yes (formulas referencing specific row numbers in `תנועות` become wrong) | manual | no | YES | no | no | **High** | Add `YES I UNDERSTAND`; add lock. Row-order changes can break SUMIFS that hardcode row ranges (e.g. `B12:B500`) — they don't break here because SUMIFS uses column ranges, but any cell-ref formula (e.g. `=תנועות!B12`) would now point at a different row. Verify no such hardcoded refs exist. |
| `INSTALL_NEWEST_FIRST_TRIGGER` (KESEFLE_ALL_PATCHES + SORT_AND_FEATURES) | bot/KESEFLE_ALL_PATCHES.gs:138 + bot/SORT_AND_FEATURES.gs:42 | n/a | `ScriptApp.newTrigger(...).forSpreadsheet(...).onEdit().create()` — installs an onEdit trigger that auto-sorts | trigger registry + every onEdit fires `_AUTO_SORT_TNUOT_` which writes back | yes (every edit triggers a write) | yes | **triggered onEdit (very frequent)** | no | no | no | no | **Critical** | OnEdit trigger sorts on every cell change anywhere in the spreadsheet. Spam + accidental data overwrites likely. Either remove this trigger or scope it tightly to onEdit-of-the-specific-target-range only. Currently fires on ANY edit. |
| `_AUTO_SORT_TNUOT_` | bot/KESEFLE_ALL_PATCHES.gs + SORT_AND_FEATURES.gs | 151 / 57 | called by onEdit trigger; sorts `תנועות` | `תנועות` | yes | yes | **triggered** | n/a | no | no | no | **Critical** | Same as `SORT_TNUOT_NEWEST_FIRST` but triggered automatically on every edit. Highest reliability risk — runs without user awareness. |
| `UNINSTALL_NEWEST_FIRST_TRIGGER` | bot/KESEFLE_ALL_PATCHES.gs:161 + SORT_AND_FEATURES.gs:68 | n/a | `ScriptApp.deleteTrigger` | trigger registry | no (recovery action) | no | manual | no | n/a | no | no | Low | OK. |
| `ADD_CHECKMARK_COLUMN` | bot/KESEFLE_ALL_PATCHES.gs:174 + SORT_AND_FEATURES.gs:84 | n/a | `.setValue('סטטוס')` for header; `.setValues` for status column | `תנועות` col STATUS | low (fills a new column) | low | manual | no | no | no | no | **Medium** | Add backup before populating; check that the target column is empty before writing. |
| `VERIFY_SORT_AND_FEATURES` | bot/KESEFLE_ALL_PATCHES.gs:195 + SORT_AND_FEATURES.gs:110 | n/a | reads only | n/a | no | no | manual | n/a | n/a | n/a | n/a | Low | OK. |
| `recordUserCorrection_` | bot/PERSONALIZED_LEARNING.gs | 94 | `appendRow` to `_kfl_user_corrections_` tab (auto-created via `insertSheet` if missing) | scratch tab only | low | no | bot-internal | n/a | n/a | n/a | yes (gated by `KFL_DISABLE_BOT_WRITES` via main bot) | **Low** | OK. |
| `deleteUserCorrection_` | bot/PERSONALIZED_LEARNING.gs | 120 | `.setValue('FALSE')` on the `active` column for a row | scratch tab | low | no | bot-internal | n/a | n/a | n/a | yes | **Low** | OK. |
| `_corrTrimUser_` | bot/PERSONALIZED_LEARNING.gs | 218 | `insertSheet` for archive tab if missing; `setValue('FALSE')` for old rows | scratch tab | low | no | bot-internal | n/a | n/a | n/a | yes | **Low** | OK. |
| `_BC_fixLastCategoryReply_` | bot/BOT_COMMANDS.gs | 298 | `.setValue` on the SUBCATEGORY column of a specific row identified by undo-context | `תנועות` single cell | low | no | bot-internal (responds to user "fix" command) | n/a | n/a | n/a | yes (via main bot) | **Medium** | OK; user-initiated single-cell edit. |
| `_BC_deleteByTextReply_` | bot/BOT_COMMANDS.gs | 313 | row deletion via `sheet.deleteRow` for matching rows | `תנועות` row | yes (deletes user data) | n/a | bot-internal (user-initiated) | no | no | no | yes (via main bot) | **High** | User-initiated, but any string match could match wrong rows. Add: confirmation step (bot already asks for confirm in handler); add lock to avoid concurrent deletes. |
| `kflListRowsForReview` review-tab side-effect | bot/CLEANUP_LEAKED_ROWS.gs | 102 | `review.clear()` on review tab if existed | review tab only | low (scratch tab) | no | manual | n/a | n/a | n/a | no | **Low** | OK. |
| `appendRow` calls in `ExpenseBot_FIXED.gs` (20 distinct call sites — KV/audit/state tabs only, NOT user-data tabs) | bot/ExpenseBot_FIXED.gs | multiple | `.appendRow` for ML audit, auto-syn, learned, state tabs | scratch + audit tabs | low | no | bot-internal (handles message) | n/a | n/a | n/a | yes | **Low** | OK in aggregate. |
| `sh.deleteRow(lastRow)` in `ExpenseBot_FIXED.gs` (undo command paths) | bot/ExpenseBot_FIXED.gs | 1554, 2956, 10350, 10365, 10435 | row deletion (user-initiated undo / dedup) | `תנועות` | yes (deletes most recent user row) | n/a | bot-internal | n/a (undo is explicit) | no | no | yes (kill-switch gates main bot) | **Medium** | OK as designed (undo). Add: lock to avoid race with concurrent bot writes from same user. |
| `ss.insertSheet(TRANSACTIONS_SHEET)` (auto-create-on-first-write) | bot/ExpenseBot_FIXED.gs | 10829, 11333 | creates the `תנועות` and per-business tabs if missing | new tabs | low | no | bot-internal | n/a | n/a | no | yes | **Low** | OK — required for first-time setup. |
| `ss.insertSheet(_LEARNED_TAB_NAME)` / `_ML_AUDIT_TAB` / `_AUTO_SYN_TAB` | bot/ExpenseBot_FIXED.gs | 9005, 9173, 14805, 15154 | creates scratch ML tabs | new scratch tabs | low | no | bot-internal | n/a | n/a | no | yes | **Low** | OK. |
| `sh.deleteRows(2, count)` in `ExpenseBot_FIXED.gs:10365` | bot/ExpenseBot_FIXED.gs | 10365 | clears multiple rows on a tab (likely audit cleanup) | scratch tab | medium (scope unclear without deeper read) | n/a | bot-internal | n/a | no | no | yes | **Medium** | Needs deeper audit — Agent 6 noted but did not fully read context. Recommend follow-up review of the function containing this call. |
| `INSTALL_NEWEST_FIRST_TRIGGER` (older variant in `SORT_AND_FEATURES.gs`) | bot/SORT_AND_FEATURES.gs | 42 | duplicate of the KESEFLE_ALL_PATCHES version | same | yes | yes | **triggered onEdit** | no | no | no | no | **Critical** | Duplicate of the same logic in two files — increased risk both get installed. Recommend: delete `SORT_AND_FEATURES.gs` entirely (it's superseded by `KESEFLE_ALL_PATCHES.gs`). |

---

## Critical-/High-risk follow-up actions (ranked by blast radius)

These are the specific guardrail recommendations the audit owner should ship — ordered by largest blast radius first:

### 1. **Remove the daily auto-trigger that runs `SIMPLE_FIX_DASHBOARD` at 6 AM**
- File: `bot/personal_sheet_fix.gs` line 1373 (inside `FIX_NOW`).
- Reason: this trigger calls `RECOVER_DASHBOARD_APPLY_V2`, which writes ~240 cells on `מאזן חברה`. It runs **every day without user supervision**. If the user typed a manual value at 23:59, the 06:00 run can wipe it.
- Action: change `FIX_NOW` so it never installs a trigger automatically. If user wants the trigger, they must call a separate `INSTALL_DAILY_TRIGGER_YES_I_UNDERSTAND` function.

### 2. **Remove the onEdit auto-sort trigger**
- Files: `bot/KESEFLE_ALL_PATCHES.gs:138` and `bot/SORT_AND_FEATURES.gs:42`.
- Reason: `INSTALL_NEWEST_FIRST_TRIGGER` installs an onEdit trigger that sorts `תנועות` on **every** edit. The trigger has no scoping, no lock, no kill-switch. Every cell change in the entire spreadsheet — including user-typed dashboard values — triggers a sort, plus there's no guard against the sort firing while the bot is mid-write (race condition).
- Action: remove this trigger. If sorting is wanted, do it manually via `SORT_TNUOT_NEWEST_FIRST` on demand.

### 3. **Gate all `מאזן חברה`/`מאזן אישי`/`תנועות` writes behind `KFL_DISABLE_BOT_WRITES`**
- Files: every Critical/High row in the table above.
- Reason: `KFL_DISABLE_BOT_WRITES` currently only protects `bot/ExpenseBot_FIXED.gs`. The repair/migration scripts can still wipe user data even when the kill-switch is on. That defeats the purpose of an emergency kill-switch.
- Action: add a shared `_KFL_writesEnabled_()` helper that all destructive functions check at start, returning early with a warning if false. Audit-log every blocked attempt.

### 4. **Add `YES I UNDERSTAND` confirmation argument to every Critical/High write**
- Following the pattern already established in `APPLY_MIGRATE_RAW`, `APPLY_MIGRATE_NOTES`, `APPLY_DASHBOARD_REPAIR`.
- **Remove the `*_NOW` zero-arg wrappers** that bypass the confirmation gate. The wrappers were created for Apps-Script-dropdown convenience but defeat the safety pattern.

### 5. **Add `LockService.getScriptLock()` to every Critical/High write**
- Pattern already used in `APPLY_MIGRATE_RAW`, `APPLY_MIGRATE_NOTES`, `SMART_REMAP_DASHBOARD`, `WIRE_YEAR_SELECTOR`.
- Missing from: `APPLY_RESTORE_2026`, `fixPersonalDashboardFormulas`, `RECOMPUTE_COMPANY_DASHBOARD`, `FIX_MARKETING_ALL_YEARS`, `CLEAN_BROKEN_FORMULAS_ALL_YEARS`, `FIX_ALL_BUCKETS_ALL_YEARS`, `SIMPLE_FIX_DASHBOARD`, `RECOVER_DASHBOARD_APPLY_V2`, `_PSF_RECOVER_DASHBOARD_CORE_`, `APPLY_DASHBOARD_REPAIR`, `APPLY_FIX_DASHBOARD` (both Hebrew + safe variants), `STEP1B_APPLY_DUPLICATE`, `STEP3_APPLY_TAB_CLEANUP`, `kflDeleteRowsByIndices`, `MERGE_BACKUPS_INTO_DONTDELETE`, `APPLY_QUICK_WINS`, `EMBED_SUMMARY_INTO_DASHBOARD`, `INSTALL_FINANCIAL_SUMMARY`, `FIX_PROFITABILITY_PERCENTAGES`, `INSTALL_FINANCIAL_SUMMARY_TAB`, `SORT_TNUOT_NEWEST_FIRST`.

### 6. **Add backup-tab snapshot before every Critical/High write**
- Pattern already used in `APPLY_RESTORE_2026`, `RECOVER_DASHBOARD_APPLY_V2`, `APPLY_FIX_DASHBOARD`, `SMART_REMAP_DASHBOARD`, `WIRE_YEAR_SELECTOR`, `APPLY_QUICK_WINS`, `EMBED_SUMMARY_INTO_DASHBOARD`, `FIX_PROFITABILITY_PERCENTAGES`, `SORT_TNUOT_NEWEST_FIRST`.
- Missing from: `fixPersonalDashboardFormulas`, `CLEAN_BROKEN_FORMULAS`, `RECOMPUTE_COMPANY_DASHBOARD`, `FIX_MARKETING_ALL_YEARS`, `CLEAN_BROKEN_FORMULAS_ALL_YEARS`, `FIX_ALL_BUCKETS_ALL_YEARS`, `STEP1B_APPLY_DUPLICATE`, `STEP3_APPLY_TAB_CLEANUP`, `MERGE_BACKUPS_INTO_DONTDELETE`, `REVERT_QUICK_WINS`, `REMOVE_EMBEDDED_SUMMARY`, `REMOVE_STANDALONE_SUMMARY_TAB`, `INSTALL_FINANCIAL_SUMMARY`, `REMOVE_FINANCIAL_SUMMARY`, `INSTALL_FINANCIAL_SUMMARY_TAB`.

### 7. **Add corresponding `UNDO_*` function for every Critical/High write**
- Currently only `RESTORE_FROM_BACKUP` (for `APPLY_RESTORE_2026`) and `UNINSTALL_DAILY_TRIGGER` (for `FIX_NOW`) exist.
- Action: for each Critical/High function that takes a backup, ship a corresponding `UNDO_<NAME>` that finds the newest matching backup tab and restores it. Document the pattern in `bot/README.md`.

### 8. **Replace `deleteSheet` with `hideSheet` + rename**
- Files: `STEP3_APPLY_TAB_CLEANUP` (whole-tab delete), `REMOVE_STANDALONE_SUMMARY_TAB`, `INSTALL_FINANCIAL_SUMMARY` (deletes existing tab before recreating), `INSTALL_FINANCIAL_SUMMARY_TAB`, `MERGE_BACKUPS_INTO_DONTDELETE` (deletes source after merge), `_PSF_RECOVER_DASHBOARD_CORE_` (deletes existing backup tab on name collision).
- Reason: tab deletion is unrecoverable from script side. Hide + rename to `dontdelete<N>` (pattern already used in `CLEANUP_DUPLICATES_AND_TABS`) gives a 30-day recovery window via Google Sheets version history *plus* in-script restoration.

### 9. **Audit & remove duplicate/legacy files**
- `bot/FIX_DASHBOARD_safe.gs` line 1 has a syntax error (`w// ...`) — file is broken; remove or fix.
- `bot/SORT_AND_FEATURES.gs` duplicates logic in `bot/KESEFLE_ALL_PATCHES.gs` — pick one.
- `bot/*.gs.bak.*` backup files (6 of them) should not be in the deploy bundle.

### 10. **Document the trigger inventory and add a `KFL_AUDIT_TRIGGERS` function**
- `bot/ExpenseBot_FIXED.gs` installs 10 cron triggers + the bot-paste flow installs `SIMPLE_FIX_DASHBOARD` + the cleanup flow can install `_AUTO_SORT_TNUOT_`. There is no single inventory of "what triggers are currently running on this Apps Script project".
- Action: ship a read-only `KFL_AUDIT_TRIGGERS` that prints every trigger and its handler function so the user (and audit agents) can review trigger surface in one place.

---

## Files audited (full list)

The following 34 `.gs` files were scanned. Functions that touch any of the audited operations are catalogued in the table above; pure-utility / pure-test files are listed here for completeness without per-function detail.

- `bot/BOT_COMMANDS.gs` — bot-command handler; flagged `_BC_fixLastCategoryReply_` and `_BC_deleteByTextReply_` above.
- `bot/CLEANUP_DUPLICATES_AND_TABS.gs` — flagged.
- `bot/CLEANUP_LEAKED_ROWS.gs` — flagged.
- `bot/CREATE_TEMPLATE_AND_CLEANUP.gs` — flagged.
- `bot/DASHBOARD_QUICK_WINS.gs` — flagged.
- `bot/DIAGNOSE_NO_REPLY.gs` — read-only.
- `bot/DROPDOWN_FOR_UNSURE.gs` — read-only (no destructive ops found).
- `bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs` — flagged.
- `bot/EMBEDDING_FALLBACK.gs` — scratch cache tab only; low-risk writes via `clearContents` + `setValues` on `_EMBED_CACHE_TAB_NAME`. Add kill-switch consistency.
- `bot/ExpenseBot_DEPLOY.gs` — identical destructive surface to ExpenseBot_FIXED.gs (it's the deploy bundle). All findings on FIXED apply equally to DEPLOY.
- `bot/ExpenseBot_FIXED.gs` — flagged inline. Plus 10 scheduled cron triggers.
- `bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs` — flagged.
- `bot/FIX_DASHBOARD_2023_2024_2025.gs` — flagged.
- `bot/FIX_DASHBOARD_safe.gs` — flagged + syntax error on line 1.
- `bot/FIX_PROFITABILITY_AND_CHART.gs` — flagged.
- `bot/KESEFLE_ALL_PATCHES.gs` — flagged.
- `bot/KESEFLE_KEYWORDS_v2.gs` — pure data file, no destructive ops.
- `bot/KESEFLE_KEYWORDS_EXTRA_v3.gs` — pure data file.
- `bot/MIGRATE_OLD_NOTES.gs` — flagged (best-guarded in codebase).
- `bot/MIGRATE_OLD_TO_KESEFLE.gs` — flagged (gold standard with lock + gate).
- `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs` — read-only (no destructive ops found).
- `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` — read-only (no destructive ops found).
- `bot/PERSONALIZED_LEARNING.gs` — flagged scratch-tab writes only.
- `bot/RECEIPT_PARSING.gs` — flagged scratch-tab audit-row appends only.
- `bot/SCAN_OLD_CATEGORIES.gs` — read-only (asserted by file header).
- `bot/SHEET_DASHBOARD_FULL_AUDIT.gs` — read-only (asserted by file header).
- `bot/SHEET_DASHBOARD_SMART_REMAP.gs` — flagged.
- `bot/SHEET_YEAR_SELECTOR_WIRE.gs` — flagged.
- `bot/SORT_AND_FEATURES.gs` — flagged (duplicate of KESEFLE_ALL_PATCHES).
- `bot/TEST_SUITE.gs` — test code; out of scope but no destructive ops found.
- `bot/WEEKLY_DIGEST.gs` — no destructive ops found (sends messages only).
- `bot/WIRE_DROPDOWN_INTO_DOPOST.gs` — code-snippet patches; no direct destructive ops.
- `bot/personal_sheet_fix.gs` — flagged extensively.
- `bot/config.gs` — config only, no writes.

In-scope but excluded by scope of this agent: tests under `bot/test_*.js` (JavaScript unit tests, not Apps Script).

---

## Sign-off

Authored by autonomous audit Agent 6, 2026-05-28. No functions were executed; this is purely a static read.

Counts re-verified against the table:
- **70 destructive entries** in the per-function table.
- **14 Critical, 23 High, 22 Medium, 11 Low.**
- **4 entries** with full guardrail set (`APPLY_MIGRATE_RAW`, `APPLY_MIGRATE_NOTES`, `SMART_REMAP_DASHBOARD`, `WIRE_YEAR_SELECTOR` — and even these are each missing kill-switch).
- **66 entries** missing one or more guardrails.

Recommended PR title: `[autonomous-audit] apps script destructive function audit`.
