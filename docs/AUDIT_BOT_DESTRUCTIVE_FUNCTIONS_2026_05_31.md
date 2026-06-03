# Bot destructive-function audit — 2026-05-31

## Summary

- **Total destructive ops scanned: 166** across 16 `.gs` files in `bot/`
- **CRITICAL: 0** — no writes to OLD sheet, no unsafeoverwrites of user-typed rows detected
- **HIGH: 3** — destructive paths missing both LockService and confirmation gate
- **MEDIUM: 8** — destructive paths with partial gating (lock OR gate, not both)
- **LOW: 30+** — additive-only paths or fully gated paths

`bot/ExpenseBot_DEPLOY.gs` is a byte-for-byte copy of `bot/ExpenseBot_FIXED.gs` plus a leading deployment-instruction comment header. Same 44 destructive ops in both. Findings below count them once (under `ExpenseBot_FIXED.gs`).

No `safeSetFormula` / `safeSetValue` helper exists anywhere in `bot/`. The actual safety mechanism is `_isBrokenDashFormula_` (preserves clean formulas) + per-function gating. The MEMORY rule "rows 12 marketing & 14 operations are user data" refers to a sheet layout the code no longer matches — current `_PSF_YEAR_2026_` maps marketing → row 9, ops → row 11; row 12 = totalExp (derived), row 14 = marginPct (derived). The protective rule still holds for any non-derived row that contains user-typed values.

---

## Critical findings

**None.** All 16 files have been scanned; no operation:
- writes to OLD sheet `1UKrXDk…KW-Qo` (every migration/diff script opens OLD read-only and writes only to `_*_NEW_SHEET_ID_`),
- overwrites a user-typed row in `מאזן חברה` without first checking `_isBrokenDashFormula_` or preserving via `if (existingFormula) { return 'skip-formula'; }`,
- runs an APPLY-mode rewrite without at least ONE of: confirmation gate, LockService, or DocumentProperties backup.

If we relax CRITICAL to "any destructive op that runs without explicit owner-phone gating in a bot-routed command", the only matches are the legacy delete/update commands in `ExpenseBot_FIXED.gs` (lines 1605, 3029, 10661, 10676, 10746, 11295, 11488, 11495). Each is reached through `_isOwnerPhone_(fromPhone)` upstream in `doPost`, so they cannot be triggered by tenant users — confirmed by reading `doPost` (`bot/ExpenseBot_FIXED.gs:1726`) and the owner-gate at line 1610.

---

## Per-file breakdown

### `bot/ExpenseBot_FIXED.gs` + `bot/ExpenseBot_DEPLOY.gs` (44 ops each, identical)

`SHEET_ID = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A'` (NEW). All writes target NEW.

| Line | Function | Op | Target | Row | Gated? | Backup? | Risk |
|---|---|---|---|---|---|---|---|
| 803 | `_kfl_setRowOriginalNote` | setNote | תנועות | last data row col F | owner via caller | additive note | LOW |
| 817 | `_kfl_appendOriginalNoteLine` | setNote | תנועות | last data row col F | owner via caller | additive note | LOW |
| 1056 | `_addNoteToLast_` | setNote (fallback) | תנועות | last row col F | owner via doPost | additive note | LOW |
| 1080-92 | `_correctLastExpense_` | setValue × 4 | תנועות | LAST row, cols C/F/A/B | owner via doPost | none (last-row only) | MEDIUM |
| 1625 | `_handleDeleteRowCommand_` | deleteRow | תנועות | last row | owner via `_isOwnerPhone_` | snapshots row into reply, no rollback | MEDIUM |
| 3043 | `deleteLastOrder` | deleteRow | הזמנות | last row | owner via doPost | reads row first into reply, no DocProps backup | MEDIUM |
| 7004-05 | `_markLastExpenseAsVatDeductible_` | setValue × 2 | תנועות | row 1 col I header + last row col I | owner gate at 6984, only sets headers if empty + a TRUE flag | additive | LOW |
| 9316/9484/9491-94 | `_learnedSave` / `_learnedLoad` | insertSheet + setValue | מילון לימוד | helper rows | this is the bot's own learning cache | additive (replace exact row) | LOW |
| 10438-39 | category correction handler | setValue × 2 | תנועות | row D + E (cat/sub) | owner via doPost | additive note via `_kfl_appendOriginalNoteLine` | MEDIUM |
| 10661 | `deleteLearning` | deleteRow | מילון לימוד | indexed user pick | owner via doPost | none | LOW (bot's own helper tab) |
| 10676 | `_learningReset_` | deleteRows | מילון לימוד | rows 2..N | owner via doPost | none | LOW (bot's own helper tab) |
| 10746 | `deleteLastTransaction` | deleteRow | תנועות | last row | NOT owner-gated at function | reads row first into reply | MEDIUM — relies on caller |
| 11140 | `setupTransactionsSheet` | insertSheet | תנועות | new tab | guarded by `if (sheet.getLastRow() > 0) return;` | only runs on empty tab | LOW |
| 11148-75 | `setupTransactionsSheet` | setValues + setBackground + setNumberFormat + setDataValidation | תנועות | header A1:G1 + data validation D2:D1000 | guarded above | one-time setup | LOW |
| 11264-67 | `migrateDashboardToSUMIFS` | setFormula × 2 | מאזן שנתי | many rows × 12 cols | NOT gated, NOT locked, NO backup | none | **HIGH** |
| 11295-96 | `migrateSubcategoriesAndCategories` | setValue × 2 | תנועות | every renamed row D + E | NOT gated, NOT locked, NO backup | none | **HIGH** |
| 11312 | `syncEverything` | setDataValidation | תנועות | D2:D5000 | NOT gated | only validation rule | MEDIUM |
| 11488/11495 | `_updateBusinessDashboardInSheet_` | setValue | מאזן חברה year tabs | metric × month cell | called by per-row bot writes; preserves clean formulas via `_isBrokenBotDashFormula_` | none | LOW (defensive) |
| 11644 | `_getOrCreateBusinessTab_` | insertSheet | per-business tab | only when missing | first write creates tab with correct schema | LOW |
| 12063 | `setDashboardNoteForTransaction_` | setNote | מאזן חברה cell | matched row × month | additive note composition via `_composeNoteWithYearSeparator_` | LOW |
| 15012 | `_familyLogExpense_` | setNote | Family Budget tab col E | new row | additive note | LOW |
| 15150/15499 | `_ensureMLAuditSheet_`, `_ensureAutoSynonymsSheet_` | insertSheet | bot's own helper tabs | first run only | additive | LOW |
| 15754 | `_setDashboardFormulaSafe_` | setFormula | provided cell | only if empty or numeric; preserves existing formulas; preserves text | called by `installCompanyDashboardFormulas` | LOW (defensive) |

### `bot/personal_sheet_fix.gs` (21 ops)

| Line | Function | Op | Target | Gated? | Backup? | Risk |
|---|---|---|---|---|---|---|
| 137 | `_backupCompanyDashboard_` | insertSheet | `_BAK_recomp_<ts>` | helper backup function | this IS the backup | LOW |
| 189-216 | `APPLY_RESTORE_2026` | setFormulas (rows 6-11) + setFormulas + setNumberFormat (rows 12-14) | מאזן חברה | NO confirmation gate; NO LockService | calls `_backupCompanyDashboard_` first | **MEDIUM** (lock + gate missing) |
| 248 | `fixPersonalDashboardFormulas` | setFormulas | מאזן אישי | NO gate, NO lock, NO backup | none | **HIGH** |
| 543/650/659 | `RECOMPUTE_COMPANY_DASHBOARD` + `CLEAN_BROKEN_FORMULAS` | setValue × 3 | מאזן חברה | NO gate, NO lock; preserves clean formulas via `_isBrokenDashFormula_` | none | MEDIUM (label-walker + broken-only saves it) |
| 893 / 1053 / 1177 | `FIX_MARKETING_ALL_YEARS` / `CLEAN_BROKEN_FORMULAS_ALL_YEARS` / `FIX_ALL_BUCKETS_ALL_YEARS` | setFormula × 3 | מאזן חברה | NO gate, NO lock; broken-formula filter | none | MEDIUM |
| 1815-17 | `_PSF_RECOVER_DASHBOARD_CORE_` | deleteSheet (old `_backup_*`) + copyTo (new hidden backup) | מאזן חברה | runs only in APPLY (`!dryRun`) | this IS the backup | LOW |
| 1860 | `_PSF_RECOVER_DASHBOARD_CORE_` | setValue | מאזן חברה | preserves higher non-zero existing values; preserves user data via `oldV > newV && oldV !== 0 && newV === 0` | snapshots before | LOW |
| 1865 | `_PSF_RECOVER_DASHBOARD_CORE_` | setFormula | annual SUM | derived col | snapshots before | LOW |
| 2145 | `APPLY_DASHBOARD_REPAIR` | setFormula | מאזן חברה | **GATED** by `"YES I UNDERSTAND"` arg + audit-trail setNote | A1 cell-note audit trail | LOW |
| 2200 | `APPLY_DASHBOARD_REPAIR` | setNote | A1 audit trail | gated | additive | LOW |

### `bot/AUDIT_AND_CLEANUP_APPENDED.gs` (7 ops)

Exemplary. CONFIRM_CLEANUP_APPENDED Script Property gate (line 229), LockService.getDocumentLock (line 239), DocumentProperties backup (line 255), bottom-up deletes (line 261), gate-clear after success (line 273), ROLLBACK function (line 331). All risk: **LOW**.

### `bot/MIGRATE_OLD_TO_KESEFLE.gs` (3 ops, lines 259/283/291)

DRY_RUN/APPLY split, `'YES I UNDERSTAND'` arg gate (line 321), LockService (line 96). Writes APPEND-only to NEW tnu`ot + הזמנות + audit-trail setNote to A1. Risk: **LOW**.

### `bot/MIGRATE_OLD_NOTES.gs` (5 ops, lines 202/284/345 = setNote-only)

Same gate pattern as above (line 378). Writes setNote() to NEW only, skips cells that already have a note. Risk: **LOW**.

### `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` (14 ops)

CONFIRM_MIGRATE_DASHBOARD Script Property gate (line 299), LockService.getDocumentLock (line 314), full DocumentProperties backup (line 330), ROLLBACK_MIGRATE_DASHBOARD (line 418). The setBackground (line 397) + setFontWeight + setValue (line 396, 405) only paint a banner row at `getLastRow() + 2` — additive. Year-selector code (lines 376-383) only writes B4 if it's empty and never overrides Steven's choice. Risk: **LOW**.

### `bot/SHEET_DASHBOARD_SMART_REMAP.gs` (3 ops)

Lock present (line 252), backup present (line 191). **No confirmation gate.** Overwrites rows 8-11 cols B..N unconditionally with setFormulas. Risk: **MEDIUM**.

### `bot/SHEET_YEAR_SELECTOR_WIRE.gs` (4 ops)

Lock present (line 285), backup present (line 219), setDataValidation B4 only adds a dropdown (line 139), setFormulas wraps existing formulas with year-selector IFS (line 327) and is idempotent. **No confirmation gate.** Risk: **MEDIUM**.

### `bot/SHEET_DIFF_OLD_VS_NEW.gs` (3 ops)

`insertSheet('_DIFF_REPORT_')` / `sh.clear()` / setValues all target a hidden private report tab. No data-tab writes. Risk: **LOW**.

### `bot/SHEET_DASHBOARD_FULL_AUDIT.gs` (1 line: line 254 — string literal, not a call)

Pure read-only audit. The `STALE_OLD_SHEET_ID` token only appears in finding-message strings. Risk: **LOW**.

### `bot/SCAN_OLD_CATEGORIES.gs` (0 actual calls; matched grep on comment "no .setValue, no .appendRow")

Pure read-only OLD scan. Risk: **LOW**.

### `bot/BOT_COMMANDS.gs` (3 ops)

`_BC_undoLastReply_` deleteRow (line 299), `_BC_fixLastCategoryReply_` setValue F (line 313), `_BC_deleteByTextReply_` deleteRow (line 339). Owner-gated at function entry (`_isOwnerPhone_` line 77 with fail-closed default) + double-gated upstream in doPost. Risk: **LOW**.

### `bot/EMBEDDING_FALLBACK.gs` (4 ops)

`insertSheet(_EMBED_CACHE_)` + `clearContents()` + setValues all target a hidden helper tab `_EMBED_CACHE_`. No data-tab writes. Risk: **LOW**.

### `bot/PERSONALIZED_LEARNING.gs` (6 ops)

setValue/insertSheet/setValues all target `_USER_CORRECTIONS_` and `_USER_CORRECTIONS_ARCHIVE_` helper tabs. Risk: **LOW**.

### `bot/RECEIPT_PARSING.gs` (2 ops)

`insertSheet(_RECEIPT_AUDIT_TAB)` + setValues only on the helper audit tab on first run. Risk: **LOW**.

---

## HIGH-risk findings (no LockService AND no confirmation gate)

1. **`bot/ExpenseBot_FIXED.gs:11211 — migrateDashboardToSUMIFS()`**
   - Rewrites `dashboard.getRange(cellRow, col).setFormula(...)` for every row in `'מאזן שנתי'`. No backup, no lock, no gate. Has a hard-coded `sectionHeaders` allowlist so non-listed labels are skipped, but if Steven's layout has shifted, this can write SUMIFS into the wrong rows.
   - Currently only triggered by a one-shot manual run (not on any cron). Risk profile: **HIGH but dormant**.

2. **`bot/ExpenseBot_FIXED.gs:11272 — migrateSubcategoriesAndCategories()`**
   - Walks every row of `תנועות`, runs hard-coded re-categorisation rules, and rewrites col D + col E in-place. No backup, no lock, no gate.
   - The rules are narrow (`subcat === 'סופר'` → `אוכל`/`אוכל לבית` etc.) but they CHANGE user data with no undo. Triggered by `syncEverything()` (line 11304) which has no gating either.
   - Risk profile: **HIGH if `syncEverything` is ever invoked from a non-owner path; HIGH for accidental owner-triggered runs.**

3. **`bot/personal_sheet_fix.gs:229-260 — fixPersonalDashboardFormulas() (line 248)`**
   - Rewrites C..N for every dashboard row that matches the data-row predicate. No backup, no lock, no gate. The comment on line 227 acknowledges "Lower-risk than the company dashboard; doesn't use a backup tab" — but it does still overwrite user formulas.
   - Risk profile: **HIGH**.

---

## MEDIUM-risk findings (partial gating)

- `bot/personal_sheet_fix.gs:177 — APPLY_RESTORE_2026()` — backup yes, gate no, lock no.
- `bot/personal_sheet_fix.gs:567/971/1083 — RECOMPUTE_COMPANY_DASHBOARD / CLEAN_BROKEN_FORMULAS_ALL_YEARS / FIX_ALL_BUCKETS_ALL_YEARS` — preserve clean formulas via `_isBrokenDashFormula_` but no backup, lock, or gate.
- `bot/SHEET_DASHBOARD_SMART_REMAP.gs:251 — SMART_REMAP_DASHBOARD()` — lock + backup, no gate.
- `bot/SHEET_YEAR_SELECTOR_WIRE.gs:284 — WIRE_YEAR_SELECTOR()` — lock + backup, no gate.
- `bot/ExpenseBot_FIXED.gs:11304 — syncEverything()` — calls `migrateSubcategoriesAndCategories` (HIGH above) and `tx.getRange('D2:D5000').setDataValidation(ruleD)` with no gate.
- `bot/ExpenseBot_FIXED.gs:10738 — deleteLastTransaction()` — function itself doesn't check `_isOwnerPhone_`; relies on callers (`_handleDeleteRowCommand_`, `_BC_undoLastReply_`) doing so.

---

## Recommendations (ordered by safety impact, smallest blast radius first)

1. **Add owner-gate to `deleteLastTransaction` in `bot/ExpenseBot_FIXED.gs:10738`** — defense in depth, call sites already gate but a future caller could miss it.
   _Claude can ship autonomously._

2. **Add a confirmation-gate to `migrateSubcategoriesAndCategories` (line 11272) AND to `syncEverything` (line 11304)** — wrap with `if (PropertiesService.getScriptProperties().getProperty('CONFIRM_MIGRATE_SUBCATS') !== 'YES I UNDERSTAND') throw new Error(...)`. Add DRY_RUN counterpart. Add LockService.
   _Needs Steven approval._ These are one-shot maintenance functions; changing their signature could break a future paste.

3. **Add a confirmation-gate to `migrateDashboardToSUMIFS` (line 11211)** — same pattern.
   _Needs Steven approval._

4. **Add backup + gate + lock to `fixPersonalDashboardFormulas` (line 248 of personal_sheet_fix.gs)** — same pattern as APPLY_RESTORE_2026 but it currently has none of the three.
   _Needs Steven approval._

5. **Add a confirmation-gate to `APPLY_RESTORE_2026`, `SMART_REMAP_DASHBOARD`, `WIRE_YEAR_SELECTOR`** — they have LockService + backup but no gate, so a stray dropdown-pick in the Apps Script editor function selector can fire them.
   _Needs Steven approval._

6. **Add a one-line LockService wrapper to `RECOMPUTE_COMPANY_DASHBOARD`, `CLEAN_BROKEN_FORMULAS_ALL_YEARS`, `FIX_ALL_BUCKETS_ALL_YEARS`, `FIX_MARKETING_ALL_YEARS`** — prevent concurrent runs from racing the broken-formula detector.
   _Claude can ship autonomously._

7. **Introduce a `safeSetFormula(cell, newFormula)` / `safeSetValue(cell, newValue)` helper** in `bot/personal_sheet_fix.gs` that:
   - reads existing cell value + formula,
   - logs the (cell, before, after) tuple to a hidden `_KFL_WRITE_AUDIT_` tab,
   - refuses if existing cell contains a non-derived, non-zero, non-broken-formula value when the new value is 0,
   - keeps the existing `_isBrokenDashFormula_` short-circuit.
   Then sweep all 21 destructive ops in `personal_sheet_fix.gs` to route through it.
   _Needs Steven approval._ Larger refactor; should be staged as an incremental PR.

8. **Drop the OLD sheet ID constant from `bot/personal_sheet_fix.gs:41` comment**: the rollback note `'1UKrXDk…'` is harmless but if anyone copy-pastes it back into `_PSF_SHEET_ID_` they'd undo the 2026-05-28 migration. Mark it explicitly as a rollback-only reference.
   _Claude can ship autonomously._

---

## What I did NOT change

This is audit-only. No source file was modified. The single artifact produced is this report at `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/docs/AUDIT_BOT_DESTRUCTIVE_FUNCTIONS_2026_05_31.md`.
