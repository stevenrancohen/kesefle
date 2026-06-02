# MIGRATION_READINESS — OLD `מאזן אישי` → NEW `כסף'לה`

Audit date: 2026-05-28
Author: Autonomous audit Agent 1 (block: audit-migration-readiness)
Status: read-only audit; no code or sheet changes proposed in this PR.

This document is the consolidated migration plan for moving Steven's
historical financial spreadsheet from the **OLD** Google Sheet
(`1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`, file name "מאזן אישי")
to the **NEW** Kesefle sheet
(`1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A`, file name "כסף'לה").

It supersedes the scattered phase notes that lived as comments inside
the migration scripts. Every section cites the file:line that actually
implements (or will implement) the step, so future agents can audit
without re-discovering.

The plan respects Steven's iron rules (auto-memory):
- **backup-first** — every APPLY writes a `_BAK_*` tab or DocumentProperties
  entry before any setValue/setFormula.
- **propose-before-apply** — every script has a DRY_RUN companion that
  logs the exact write plan and modifies nothing.
- **never overwrite** — writers (notes, year-wrap formulas) skip any
  destination cell that already has user content.
- **stop-and-rebuild when tangled** — Phases 2/5/7 split intentionally so
  no single APPLY tries to do more than one mutation class.
- **"YES I UNDERSTAND" gate** — every APPLY refuses without the literal
  confirmation string passed as an argument; zero-arg `*_NOW` wrappers
  exist only so the Apps Script function dropdown can drive them.
- **same-tab year filter (revised)** — Steven explicitly REJECTED a
  separate snapshot tab approach during the audit cycle; all years now
  stay in the same `תנועות` tab and the dashboards filter by year via
  `$B$4`. The historical-summary detour (PR #122, PR #131) is preserved
  as an optional fast-path only.

---

## 1. Source / target map (tab-by-tab matrix)

Tab names are stored as `\uXXXX` escape sequences in every script that
references them, per the `sheet-hebrew-encoding-safe-script` skill.

| OLD tab | NEW tab | Disposition | Migration mechanism | Reference |
|---------|---------|-------------|---------------------|-----------|
| `תנועות` | `תנועות` | **MIGRATED** (raw rows copied) | Phase 2 row-by-row append via `_mig_scanAndOptionallyApply_` | `bot/MIGRATE_OLD_TO_KESEFLE.gs:142-173` |
| `מאזן חברה` (cols Q-AN, embedded orders) | `הזמנות` | **MIGRATED** (28 orders copied) | Phase 2 cols Q-AN scan, re-shaped to 12-col format | `bot/MIGRATE_OLD_TO_KESEFLE.gs:175-251`, write at `:263-285` |
| `מאזן אישי` (personal dashboard) | `מאזן אישי` | REBUILT from scratch via `lib/sheet-writer.js:_buildPersonalDashboardTab` (NEW); notes migrated label-keyed | `bot/MIGRATE_OLD_NOTES.gs:218-292` (`_mn_migrateDashboardNotes_`) |
| `מאזן חברה` (company dashboard, cols A-N year block) | `מאזן חברה` | REBUILT from scratch via `lib/sheet-writer.js:_buildCompanyDashboardTab`; notes migrated label-keyed | `bot/MIGRATE_OLD_NOTES.gs:218-292`; spec at `lib/sheet-writer.js:415-532` |
| `מאזן חברה 2025` / `מאזן חברה 2024` / `מאזן חברה 2023` (year tabs) | (none — same-tab year filter) | Subsumed by `$B$4` year selector on `מאזן חברה` | Plan: same-tab approach per section 5 |
| `סיכום היסטורי` (not present on OLD) | `סיכום היסטורי` (hidden, optional) | Built fresh as a snapshot fast-path; **status: open in PR #131** | `bot/BACKFILL_HISTORICAL_YEARS.gs` (origin/feat-year-history-backfill), see section 5 |
| `פירוט מורחב` (not present on OLD) | `פירוט מורחב` | New Pa'amonim extended dashboard; no OLD source | `lib/sheet-writer.js:552-723` (`_buildExtendedDashboardTab`) |
| Per-year `_BAK_*` tabs (manual backups Steven made) | (none) | Stay on OLD, frozen | n/a |

**Steady-state target:** NEW has 5 tabs in this order (`lib/sheet-writer.js:747-753`):
`מאזן אישי`, `תנועות`, `הזמנות`, `מאזן חברה`, `פירוט מורחב`. If PR #131
ships, a hidden `סיכום היסטורי` tab joins as tab 6.

---

## 2. Tab audit checklist (active / archive / backup / duplicate per tab)

Run this checklist on NEW once before final cutover. Each row is
verifiable by eyeball + a one-liner Apps Script log.

| NEW tab | Classification | Source of truth | Audit query |
|---------|----------------|------------------|-------------|
| `מאזן אישי` | active dashboard | derived from `תנועות` via SUMIFS on $B$4 | confirm B4 has dropdown 2023-2027 |
| `תנועות` | active raw log | bot writes + Phase 2 migration | row count >= 614, plus organic bot rows since |
| `הזמנות` | active raw log | bot writes + Phase 2 migration | row count >= 28, plus organic since |
| `מאזן חברה` | active dashboard | derived from `תנועות` + `הזמנות` via SUMIFS on $B$4 | section 9 formula-shape check |
| `פירוט מורחב` | active extended dashboard | derived from `תנועות`, $B$1 year input | row count = ~125 (Pa'amonim taxonomy) |
| `סיכום היסטורי` | hidden snapshot (optional, PR #131) | OLD `תנועות` 2023-2025 aggregates | row count = months×categories×3 years |
| `_BAK_yearwire_*` | snapshot backup (auto) | written by `_ys_backupCompanyDashboard_` | leave; one per `WIRE_YEAR_SELECTOR` apply |
| `_BAK_*` (other) | manual backups | Steven | leave; audit name; never delete in APPLY |
| (duplicates of dashboards) | **MUST NOT EXIST** | n/a | block via `lib/sheet-writer.js:buildTenantSheetSpec` (single-instance tabs) |

A small audit script can be added that walks every tab and refuses to
proceed if it finds `מאזן חברה (2)` / `Copy of *` shapes — these are
common artefacts of Sheets UI "Duplicate" actions. This is a NICE-TO-HAVE
follow-up, not a blocker.

---

## 3. Raw migration plan (already done vs remaining)

### 3.1 Already done

| Phase | Description | Status | Reference |
|-------|-------------|--------|-----------|
| 1 | Bot owner-write target switched OLD→NEW | merged PR #119 | `bot/ExpenseBot_FIXED.gs:26` (`SHEET_ID = '1rti...'`) |
| 2 | Raw תנועות + orders migrated (614 + 28 rows) | merged PR #120 | `bot/MIGRATE_OLD_TO_KESEFLE.gs:80-312` |
| 2.A | LockService.getScriptLock guard added | merged in PR #120 hardening pass | `bot/MIGRATE_OLD_TO_KESEFLE.gs:94-102` |
| 2.B | Dedupe-key shape disambiguated (`'new'` vs `'source'`) | merged in PR #120 hardening pass | `bot/MIGRATE_OLD_TO_KESEFLE.gs:63-77` |
| 5 | Phase 5 dashboard verifier (READ-ONLY) | merged PR #125 | `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs:315+` |
| 7 | Phase 7 file-classification audit | merged PR #125 | `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs:50-86` |
| 8 | Category-keyword expansion for OLD vocabulary | merged PR #129 | `bot/ExpenseBot_FIXED.gs:271-419` |

### 3.2 Remaining

| Phase | Description | Blocker | Reference |
|-------|-------------|---------|-----------|
| 8 (notes) | Cell-notes migration | PR #130 open, awaiting Steven's APPLY | `bot/MIGRATE_OLD_NOTES.gs:1-401` |
| 9 (historical) | Same-tab year selector for past years | needs decision per section 5 | `bot/SHEET_YEAR_SELECTOR_WIRE.gs:1-334`, PR #131 |
| Phase 7 file rewrites | Update category-(a) files to NEW (10 files) | manual edit per `_MP7_FILE_CLASSIFICATIONS_` | `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs:58-79` |

Phase 7 file rewrites are a code-hygiene task. The bot's owner-write path
already uses NEW (`bot/ExpenseBot_FIXED.gs:26`); the remaining files in
class (a) are utility scripts Steven runs manually and they still write
to OLD. Rewriting them is safe but should be done one-by-one with a
diff review (which is what `MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` logs).

---

## 4. Category migration plan (cross-ref PR #129)

PR #129 already expanded `CATEGORY_MAP` and `BUSINESS_CATEGORY_MAP` with
the keywords found by `bot/SCAN_OLD_CATEGORIES.gs`. Specifically:

- Every business `CATEGORY_MAP` row now emits the canonical subcategory
  string that the company dashboard's SUMIFS literally expects
  (`bot/ExpenseBot_FIXED.gs:283-299`). The dashboard rows are
  `עלות שיווק`, `הוצאות תפעוליות`, `עלות חומרי גלם`, `משלוחים והתקנות`,
  `יועצים`, `מחזור`.
- `BUSINESS_CATEGORY_MAP` (`bot/ExpenseBot_FIXED.gs:8358-8368`) now
  carries the full expanded keyword set for each canonical sub.
- The typo `לימים` (for `לימודים`) is now a first-class keyword routed
  to `הוצאות קבועות > לימודים` (`bot/ExpenseBot_FIXED.gs:414`).

### 4.1 What's still required for category migration

1. **Re-run `SCAN_OLD_CATEGORIES`** against OLD on the day of cutover.
   The OLD sheet is still receiving zero new writes (bot owner path is
   on NEW since Phase 1), but if Steven manually typed anything in the
   intervening days, that vocabulary will not have made it into PR #129.
   The DRY-RUN log is the source of truth — see
   `bot/SCAN_OLD_CATEGORIES.gs:77-152`.

2. **Diff the dump against the bot's current `CATEGORY_MAP` +
   `BUSINESS_CATEGORY_MAP`.** Any (D, E) tuple in OLD with count >= 2
   that does not appear in either map should land in a PR-B follow-up.
   The threshold-of-2 filters typos and one-offs (per
   `bot/SCAN_OLD_CATEGORIES.gs:113-129` doc).

3. **Re-classify the migrated transactions** with the expanded map.
   The Phase 2 migration copied OLD rows verbatim, preserving whatever
   category Steven (or his wife) wrote in cols D + E at write time. If
   the expanded keyword map would now classify any of those rows
   differently, those rows still carry the OLD classification. This is
   an INTENTIONAL choice — overwriting historical user-typed categories
   violates the "never overwrite" rule. The new keywords only affect
   FUTURE bot writes.

4. **No category overwrite script is in scope.** If a future need
   surfaces (e.g. a misclassified bucket is consistently summed wrong
   in 2024), the fix is to add a label override row in the dashboard,
   NOT to mutate historical raw rows.

---

## 5. Historical summary plan (revised: same-tab year filter)

### 5.1 Original plan (rejected)

PR #122 (Phase 3+4) introduced a separate `סיכום היסטורי` snapshot tab
that pre-aggregates 2023-2025 monthly totals so the dashboard can read
historical years without re-aggregating raw rows
(`bot/SHEET_YEAR_SELECTOR_WIRE.gs:64`). PR #131 builds on this with
`BACKFILL_HISTORICAL_YEARS.gs` and a corresponding `WIRE_YEAR_HISTORY_LOOKUP.gs`
that wraps every SUMIFS in `מאזן אישי` + `מאזן חברה` with an
`IFS($B$4=YEAR(TODAY()), <live>, TRUE, <snapshot>)` switch.

**Steven rejected this approach** per the prompt: "Steven REJECTED
separate snapshot tab — all years stay in same תנועות."

### 5.2 Revised plan (same-tab year filter)

The 614 Phase 2 + organic bot rows already live in NEW `תנועות` with
col B = `"YYYY-MM"`. Confirmed shape per `bot/MIGRATE_OLD_TO_KESEFLE.gs:152`
(`getRange(2, 1, ..., 8)` — 8 cols, schema:
`[date, monthKey, amount, category, subcategory, detail, source, isExpense]`).

Live row counts (from the prompt header):
- 2023: 2 rows
- 2024: 221 rows
- 2025: 218 rows
- 2026: 174 rows (and growing)

The dashboards' existing SUMIFS already filter on
`'תנועות'!B:B = $B$4 & "-MM"` (`lib/sheet-writer.js:485`), so changing
$B$4 from 2026 to 2024 (etc.) makes the dashboard naturally show the
correct historical year — *as long as the historical rows are in NEW
`תנועות`*. Phase 2 ensured exactly that.

Therefore: **no snapshot tab is needed**. The dashboard works for
2023/2024/2025/2026 out of the box once Phase 2 has run.

### 5.3 What changes vs the SHEET_YEAR_SELECTOR_WIRE.gs design

`bot/SHEET_YEAR_SELECTOR_WIRE.gs` (in main, not the rejected variant)
currently wraps formulas with the snapshot-fallback pattern. With the
revised same-tab approach:

- **STEP 1** (year dropdown ensure on B4): KEEP unchanged
  (`bot/SHEET_YEAR_SELECTOR_WIRE.gs:110-142`).
- **STEP 2** (formula wrap with IFS to snapshot): REMOVE the snapshot
  fallback branch. The live SUMIFS already binds to $B$4 via
  `lib/sheet-writer.js:485-486` — no wrap needed.

In other words, the year-selector becomes a one-script intervention:
just install the dropdown on B4. The dashboards already update.

This sidesteps the entire `סיכום היסטורי` plumbing, simplifies the
data path, and avoids the row-12-net / row-13-percent recomputation
loop that the snapshot fallback would have to also include.

### 5.4 PR #131 disposition

PR #131 is open and codifies the rejected approach. Recommendation:
**close PR #131 without merge** OR repurpose it as a "read-only
historical export" that writes the snapshot tab as a CSV-equivalent but
does NOT wire the dashboard wrap. The CSV-style snapshot is useful for
external analytics but should not be load-bearing for the dashboards.

The sister `WIRE_YEAR_HISTORY_LOOKUP.gs` (`origin/feat-year-history-backfill`)
should NOT be applied. Its `UNDO_WIRE_YEAR_HISTORY` is the kill switch
if it was already applied by mistake.

### 5.5 Sibling reference

A separate doc `docs/SHEET_YEAR_SELECTOR_PLAN.md` is intended to hold
the year-dropdown UI plan in isolation. It does not exist in main as of
this audit; this section serves as its inline shadow.

---

## 6. Notes / comments migration plan (cross-ref PR #130)

PR #130 (`bot/MIGRATE_OLD_NOTES.gs`) is the dedicated mechanism. Key
design points already in code:

- **Transactions notes** (`bot/MIGRATE_OLD_NOTES.gs:120-210`):
  match OLD row to NEW row by the SAME deterministic key Phase 2 used
  (`_mn_txKey_`, `:73-83`). Copy the note to the SAME column in NEW.

- **Dashboard notes** (`bot/MIGRATE_OLD_NOTES.gs:218-292`):
  label-walker. Read OLD col A on the noted row to get the label, then
  find the row in NEW with the same label. Copy the note to the same
  column. Handles row-drift between OLD and NEW templates.

- **Never overwrite** (`bot/MIGRATE_OLD_NOTES.gs:178-186`): pre-flight
  reads `newCell.getNote()`; if non-empty, skip. The "skipped:
  new_already_has_note" counter in the dry-run log surfaces these.

- **Idempotent**: re-running APPLY is safe — the existing-note check
  blocks the second write. The audit-trail note on `תנועות!A1` APPENDS
  each run rather than overwriting (`bot/MIGRATE_OLD_NOTES.gs:336-345`).

- **Lock**: `LockService.getScriptLock()` on APPLY
  (`bot/MIGRATE_OLD_NOTES.gs:306-313`).

Open action: Steven runs `DRY_RUN_MIGRATE_NOTES()` and reviews the log
to confirm the "would copy" count looks right, then runs
`APPLY_MIGRATE_NOTES_NOW()`.

---

## 7. Duplicate detection plan

### 7.1 Dedup keys in use

| Domain | Key shape | Reference |
|--------|-----------|-----------|
| `תנועות` rows (Phase 2 migration) | `[yyyy-MM-dd HH:mm \| amount \| category \| subcategory \| desc[:60]]` | `bot/MIGRATE_OLD_TO_KESEFLE.gs:38-48` |
| `הזמנות` rows — NEW shape (`'new'`) | `[yyyy-MM-dd \| customer@[2] \| salePrice@[6]]` | `bot/MIGRATE_OLD_TO_KESEFLE.gs:63-77` (shape=`'new'`) |
| `הזמנות` rows — OLD source shape (`'source'`) | `[yyyy-MM-dd \| customer@[1] \| salePrice@[3]]` | `bot/MIGRATE_OLD_TO_KESEFLE.gs:63-77` (shape=`'source'`) |
| Notes — transaction-level | SAME `_mn_txKey_` shape as Phase 2 | `bot/MIGRATE_OLD_NOTES.gs:73-83` |
| Notes — dashboard-level | `col A label` (first-occurrence wins) | `bot/MIGRATE_OLD_NOTES.gs:232-238` |

### 7.2 Idempotency rules

- **Phase 2** populates `existingTxKeys` from NEW before scanning OLD
  (`bot/MIGRATE_OLD_TO_KESEFLE.gs:115-125`). Re-running APPLY is safe;
  rows already in NEW are skipped via the `txSkipped.duplicate` counter.
- **Notes** pre-flight `getNote()` on every destination
  (`bot/MIGRATE_OLD_NOTES.gs:178-186`).
- **Lock** in APPLY mode prevents concurrent runs from both reading
  "not yet in NEW" simultaneously and double-writing
  (`bot/MIGRATE_OLD_TO_KESEFLE.gs:94-102`).

### 7.3 Known dedup-key risks

- **Shape ambiguity**: the orders dedup-key takes a `shape` arg
  explicitly. A `row[1] || row[2]` fallback would silently misread,
  causing duplicates on re-run. The current code is correct
  (`bot/MIGRATE_OLD_TO_KESEFLE.gs:53-77`); guard test
  `bot/test_migration.js` should assert both shapes round-trip.
- **Date precision**: `formatDate(..., 'yyyy-MM-dd HH:mm')` for
  transactions, `'yyyy-MM-dd'` for orders. If a future migration
  changes precision, all keys become non-matching and every row will be
  considered new (duplicates). Mitigation: never change the formatter
  without bumping `_MIG_VERSION_` and clearing `'תנועות'!A1` audit note.

---

## 8. Year-selector plan (point to sibling doc)

High-level summary: install a data-validation dropdown on `B4` of
`מאזן חברה` (and `מאזן אישי`) with the values `2023, 2024, 2025, 2026,
2027`. The existing SUMIFS already bind to `$B$4 & "-MM"`, so the
dashboards update on change.

Reference implementation: `bot/SHEET_YEAR_SELECTOR_WIRE.gs:110-142`
(`_ys_ensureYearDropdown_`). The "step 2 wrap" in the same file is the
rejected snapshot approach (section 5) and should NOT be applied.

Sibling doc: `docs/SHEET_YEAR_SELECTOR_PLAN.md` (does not exist yet;
this section is its inline shadow until that doc is written).

### 8.1 Year dropdown defaults

- Default value when blank: current year (`new Date().getFullYear()`)
  via `lib/sheet-writer.js:728-730`.
- `lib/sheet-writer.js:430` writes `_sw_bold(_sw_num(defaultYear))`
  into B4 at sheet-creation time. The dropdown is then bolted on by
  `_ys_ensureYearDropdown_` post-create.

### 8.2 Year dropdown safety

- The dropdown's `requireValueInList` enforces validity
  (`bot/SHEET_YEAR_SELECTOR_WIRE.gs:128-133`). The user cannot type a
  free-form year that misses the SUMIFS pattern.
- `setAllowInvalid(false)` (`bot/SHEET_YEAR_SELECTOR_WIRE.gs:130`)
  blocks legacy free-form values.
- If B4 was previously a literal `2026` typed in by the sheet template,
  the dropdown install does NOT overwrite the value
  (`bot/SHEET_YEAR_SELECTOR_WIRE.gs:137-140`).

---

## 9. Formula rebuild plan (no hardcoded 2026, all $B$4-bound)

### 9.1 Current state of company dashboard formulas

Per `lib/sheet-writer.js:443-491`:
- R6 (revenue) cells C-N: `SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, ">="&DATE($B$4,${m},1), 'הזמנות'!A:A, "<"&DATE($B$4,${m+1},1))`.
- R7 (orders count) cells C-N: `COUNTIFS(..., $B$4, ...)`.
- R8-R11 (expense rows) cells C-N: `SUMIFS('תנועות'!C:C, 'תנועות'!B:B, $B$4&"-${mm}", 'תנועות'!D:D, "עסק", 'תנועות'!E:E, "${safe}")`.
- R12 (total): `SUM(B8:B11)` per column.
- R13 (net): `B6-B12` per column.
- R14 (profitability %): `B13/B6` per column with IFERROR.

Every formula already references `$B$4` (year) and a month index. There
are NO hardcoded 2026 literals in `lib/sheet-writer.js`.

### 9.2 Risk: row-shift dependency

The R12 / R13 / R14 formulas reference `B8:B11` and `B6-B12` literally.
If a user inserts a row above R6 in the UI, R12 keeps referencing the
old (wrong) row numbers. This is a known fragility of the template, not
something the migration introduces.

Mitigation: `bot/SHEET_DASHBOARD_SMART_REMAP.gs` (already merged in PR #127)
is the label-walker that rewires these references if row positions
shift. Run it after any manual row insertion. See also
`.claude/skills/sheet-fix-totals-by-label/SKILL.md`.

### 9.3 Verify after migration

Run `VERIFY_PHASE5_DASHBOARDS()` (`bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs:315+`)
to confirm:
1. Revenue row pulls from `'הזמנות'!`.
2. Material/marketing/shipping/operational rows pull from `'תנועות'!`.
3. Total row = SUM of category rows in same column.
4. Net row = revenue - total.

The verifier is READ-ONLY; safe to run as many times as you like.

### 9.4 Personal dashboard

Same SUMIFS pattern via `_buildPersonalDashboardTab` (referenced at
`lib/sheet-writer.js:748`), binding to `$B$4` in the personal-tab
header. Formula audit is identical to section 9.1.

### 9.5 Extended dashboard

`_buildExtendedDashboardTab` (`lib/sheet-writer.js:552-723`) binds
SUMIFS to `$B$1` (not $B$4). This is intentional — the extended
dashboard has its own year input in row 1 because the layout is
denser. The same SUMIFS-on-month pattern applies
(`lib/sheet-writer.js:582-585`). No hardcoded year.

---

## 10. Bot sync plan (after migration, bot writes still go to NEW)

### 10.1 Owner-path writes

Already on NEW since Phase 1 (PR #119):
- `bot/ExpenseBot_FIXED.gs:26` — `const SHEET_ID = '1rti...'`
- `bot/ExpenseBot_FIXED.gs:27` — `COMPANY_SHEET_ID = SHEET_ID`

Rollback comment at `bot/ExpenseBot_FIXED.gs:25` documents the OLD ID
for emergency revert.

### 10.2 Tenant writes (multi-tenant users)

Route unchanged through `/api/sheet/append`
(`api/sheet/append.js:1-30`). Each user's sheet ID is stored in KV
under their phone/email; the migration does NOT touch this path.
Tenant isolation invariants from
`.claude/skills/api-tenant-isolated/SKILL.md` still hold.

### 10.3 Build version

`bot/ExpenseBot_FIXED.gs:62` — `KFL_BUILD_VERSION = '2026-05-28-pr-b-biz-canonical-subs'`.
Bump on every deploy per
`.claude/skills/bot-version-bump/SKILL.md`. The version string is
returned by the bot's `בדיקה` self-check and posted in the daily
heartbeat (`bot/ExpenseBot_FIXED.gs:3700-3710`).

### 10.4 Echo regexes

`_BOT_ECHO_REGEXES_` at `bot/ExpenseBot_FIXED.gs:1400-1428` already
protects against the bot's own replies being re-classified as new
expenses. No migration-specific echoes need to be added — the
"Migration_Phase_2_v1" tag in col J of migrated orders is never
echoed back via WhatsApp, so no echo regex change is required.

### 10.5 Owner-phone safety

`OWNER_PHONE = '972547760643'` (`bot/ExpenseBot_FIXED.gs:36`) is the
fallback when `SHEET_OWNER_PHONE` Script Property is unset. The Script
Property, when set, overrides. Without this fallback, an unset property
made `_resolveTenant_` treat every sender as the owner, leaking other
users' expenses into Steven's sheet. The fallback must remain.

---

## 11. Dashboard / admin / website sync plan (no references to OLD)

### 11.1 Repo-wide scan for OLD references

Files matching `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` in the
main branch (excluding worktrees):

- `bot/MIGRATE_OLD_TO_KESEFLE.gs` — intentional (source pointer).
- `bot/MIGRATE_OLD_NOTES.gs` — intentional (source pointer).
- `bot/SCAN_OLD_CATEGORIES.gs` — intentional (diagnostic).
- `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs` — NEW-only, OLD reference
  via Phase-5 docstring lineage.
- `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` — intentional (audit constant).
- `bot/CLEANUP_LEAKED_ROWS.gs` — intentional (class `c` in
  `_MP7_FILE_CLASSIFICATIONS_`).
- `bot/test_migration*.js` — test assertions on constants.
- `bot/ExpenseBot_FIXED.gs`, `bot/personal_sheet_fix.gs`,
  `bot/ExpenseBot_DEPLOY.gs` — OLD ID only in rollback comments (class
  `d`).
- `bot/SHEET_DASHBOARD_FULL_AUDIT.gs`, `bot/SHEET_DASHBOARD_SMART_REMAP.gs`
  — read OLD as historical reference; should rewire per Phase 7.
- `bot/config.gs` — `PERSONAL_TEMPLATE_SHEET_ID` still OLD; class `a`
  per `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs:66`. Should rewire.
- 9 other utility scripts (`KESEFLE_ALL_PATCHES`, `DASHBOARD_QUICK_WINS`,
  `WEEKLY_DIGEST`, etc.) — class `a`; rewire per Phase 7.
- `docs/RECOVER_DASHBOARD_V2_RUNBOOK.md` — narrative reference to OLD.
  Either rewrite or annotate as historical.

### 11.2 admin / public / api references

`grep -rln "1UKr\|1rti" admin/ public/ api/` — **zero hits**. The admin
dashboard and public site are tenant-multi (each user picks their own
sheet ID from KV); they never hard-reference the owner's sheet. No
migration-induced changes needed.

### 11.3 Action

For each class-(a) file, follow the rewire plan in
`bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` — `DRY_RUN_PHASE_7_SWEEP()`
logs a markdown table of what would change. Apply via repo edit
(Apps Script does not let `.gs` source self-modify); diff-review the
change, then push.

---

## 12. Dry-run checklist (what each DRY_RUN script verifies)

| Script | DRY_RUN entry point | What it verifies |
|--------|---------------------|-------------------|
| `bot/MIGRATE_OLD_TO_KESEFLE.gs` | `DRY_RUN_MIGRATE_RAW()` | Total OLD rows, candidates to migrate, dedupe skips, header-row skips, sample of first 5 rows (`:152-173`). Also dumps first 3 raw rows of OLD `מאזן חברה` Q-AN for layout sanity (`:197-200`). |
| `bot/MIGRATE_OLD_NOTES.gs` | `DRY_RUN_MIGRATE_NOTES()` | Per-tab "to copy" / "skipped" counts; sample of first proposed note (`:188-195`). Includes a "first 3 unmatched" trace (`:158-164`) for debugging mismatched dedupe keys. |
| `bot/SCAN_OLD_CATEGORIES.gs` | `SCAN_OLD_CATEGORIES()` | Top 50 (D >> E) tuples, all distinct col D + col E values with counts, dashboard row labels, every cell note (`:77-225`). |
| `bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs` | `VERIFY_PHASE5_DASHBOARDS()` | Per-year-block PASS/FAIL on formula source (orders vs transactions) + numeric sanity. |
| `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` | `DRY_RUN_PHASE_7_SWEEP()` | Markdown classification table of every file referencing OLD. |
| `bot/SHEET_YEAR_SELECTOR_WIRE.gs` | `DRY_RUN_YEAR_SELECTOR_WIRE()` | Dropdown-present check; sample wrap proposal for row 6-11 col B + col G. (REVISED: the wrap proposal is rejected per section 5; only the dropdown check matters.) |

Steven's read order for the dry-run logs:
1. `SCAN_OLD_CATEGORIES()` — to confirm OLD vocabulary is captured.
2. `DRY_RUN_MIGRATE_RAW()` — to confirm row count, dedupe shape.
3. `DRY_RUN_MIGRATE_NOTES()` — to confirm note "to copy" matches expectations.
4. `VERIFY_PHASE5_DASHBOARDS()` — to confirm NEW formulas still produce sane numbers.
5. `DRY_RUN_PHASE_7_SWEEP()` — to confirm Phase 7 audit table.

---

## 13. Apply checklist

### 13.1 Common safety pattern

Every APPLY follows this template:

1. `LockService.getScriptLock()` with 30s timeout
   (`bot/MIGRATE_OLD_TO_KESEFLE.gs:94-102`).
2. `'YES I UNDERSTAND'` literal-string arg gate
   (`bot/MIGRATE_OLD_TO_KESEFLE.gs:320-327`; same in
   `MIGRATE_OLD_NOTES.gs:377-384`).
3. Zero-arg `*_NOW` wrapper so the function dropdown can drive it
   (`bot/MIGRATE_OLD_TO_KESEFLE.gs:333-335`; same pattern in notes).
4. Audit-trail note on `תנועות!A1` recording timestamp + counts.
5. Release lock in `finally` even if an exception interrupts the body.

### 13.2 Apply order (post-DRY_RUN review)

1. **`APPLY_MIGRATE_RAW_NOW()`** — copies OLD `תנועות` + orders to NEW.
   Done in PR #120 already; do NOT re-run unless OLD has had new rows
   typed in (in which case re-run is idempotent and only writes the
   new rows).

2. **`APPLY_MIGRATE_NOTES_NOW()`** — copies cell notes OLD→NEW.
   READY (PR #130). Steven runs this once; idempotent.

3. **`WIRE_YEAR_SELECTOR()`** — installs B4 dropdown on `מאזן חברה`.
   Required for year-selector UX. With revised plan (section 5), only
   the dropdown-install step runs; the formula-wrap step is skipped.
   Steven must read the script to confirm before running.

4. **`VERIFY_PHASE5_DASHBOARDS()`** — final read-only sanity.

5. **Phase 7 file rewrites** — repo PR per file, not a single script.

### 13.3 What NOT to apply

- `APPLY_WIRE_YEAR_HISTORY_NOW()` from
  `bot/WIRE_YEAR_HISTORY_LOOKUP.gs` (origin/feat-year-history-backfill).
  Snapshot-fallback approach rejected per section 5.
- `APPLY_BACKFILL_HISTORICAL_YEARS_NOW()` from
  `bot/BACKFILL_HISTORICAL_YEARS.gs` (same branch). Only safe if the
  hidden snapshot tab is wanted for analytics (it's invisible to the
  dashboards under the revised plan).

---

## 14. Rollback plan

### 14.1 Rollback levels

| Level | Mechanism | Where |
|-------|-----------|-------|
| Phase 1 owner-path | Edit `bot/ExpenseBot_FIXED.gs:26` back to OLD ID | rollback comment at `:25` |
| Phase 2 row migration | Filter NEW `תנועות` col J on `'Migration_Phase_2_v1'` and delete those rows | `bot/MIGRATE_OLD_TO_KESEFLE.gs:25-26` documents the filter; **no UNDO script exists** |
| Phase 5 verifier | n/a — read-only |  |
| Phase 7 file sweep | git revert PR for the rewrite | n/a |
| Phase 8 notes | re-paste OLD notes (they were never deleted from OLD); no UNDO script |  |
| Year selector wrap (if mistakenly applied) | `UNDO_WIRE_YEAR_HISTORY()` (origin/feat-year-history-backfill) | `bot/WIRE_YEAR_HISTORY_LOOKUP.gs` UNDO restores from DocumentProperties |
| Dashboard formula rebuild | `_BAK_yearwire_<ts>` tab written by `_ys_backupCompanyDashboard_` | `bot/SHEET_YEAR_SELECTOR_WIRE.gs:214-227` |
| Catastrophic | Drive version history | Google Drive UI -> "File" -> "Version history" |

### 14.2 DocumentProperties backups

`WIRE_YEAR_HISTORY_LOOKUP.gs` writes one DocumentProperty per cell it
changes, keyed `yearhist_backup_{tabSlug}_{row}_{col}` with the original
formula. The UNDO script reads these back. DocumentProperties has a
~9000-entry cap, plenty for a single dashboard sweep.

For `WIRE_YEAR_SELECTOR()`, the rollback artefact is a full
`_BAK_yearwire_<ts>` sheet copy, which any user can hand-restore
via copy-paste in the Sheets UI.

### 14.3 The "no UNDO for Phase 2 rows" gap

Phase 2 deliberately did not implement an APPLY-undo. The mitigation
is the `'Migration_Phase_2_v1'` source tag in col J (cols A-H for
transactions; col J for orders per `_writeOrderRow_`). To undo:

1. Open NEW `תנועות`. Filter col J for `Migration_Phase_2_v1`.
2. Manually delete those rows.

For orders, same pattern: filter NEW `הזמנות` col J on the version tag.

For a future migration phase, a `UNDO_MIGRATE_RAW(confirmation)` that
re-filters and deletes by tag is a nice-to-have but not load-bearing
(Steven can always restore via Drive version history if a Phase 2 APPLY
goes badly).

### 14.4 Drive version history caveat

Drive keeps versions for ~30 days. Steven should snapshot a full
spreadsheet copy ("File -> Make a copy") before any high-stakes APPLY
so that a rollback path exists beyond 30 days.

---

## 15. Risks and mitigations

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Two concurrent APPLY runs both write the same OLD rows to NEW (dedup race). | `LockService.getScriptLock()` in every APPLY (`bot/MIGRATE_OLD_TO_KESEFLE.gs:94-102`). 30s timeout. |
| 2 | Dedup key shape ambiguity for orders causes silent duplicates on re-run. | Explicit `shape='new'` vs `shape='source'` arg (`bot/MIGRATE_OLD_TO_KESEFLE.gs:63-77`). Round-trip test recommended. |
| 3 | OLD has new rows typed in after Phase 2 ran (between PR #120 merge and final cutover). | Phase 2 is idempotent — re-running APPLY only writes the gap. Trigger DRY-RUN first to verify the new row count. |
| 4 | Note migration mis-matches because OLD-rowkey not found in NEW (Phase 2 didn't migrate that row). | `_mn_migrateTxNotes_` logs first 3 unmatched OLD rows with the key (`bot/MIGRATE_OLD_NOTES.gs:158-164`) so Steven can see what's missing. |
| 5 | Note overwrites a user-typed note in NEW. | Pre-flight `getNote()` check skips occupied cells (`bot/MIGRATE_OLD_NOTES.gs:178-186`). Counter `new_already_has_note` in dry-run log. |
| 6 | Year-selector dropdown overwrites a user value in B4. | `_ys_ensureYearDropdown_` only writes value if B4 is blank (`bot/SHEET_YEAR_SELECTOR_WIRE.gs:137-140`). |
| 7 | Row insertion in dashboard breaks R12/R13/R14 `SUM(B8:B11)` / `B6-B12` literal references. | `bot/SHEET_DASHBOARD_SMART_REMAP.gs` (PR #127, merged) walks labels not row numbers. Run after any insertion. |
| 8 | OLD ID still hardcoded in 10+ utility scripts (`config.gs`, `WEEKLY_DIGEST.gs`, etc.) — silently writes to OLD next time someone runs them. | `bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` lists all of them; class-(a) files must be rewired one-by-one with diff review. |
| 9 | `CLEANUP_LEAKED_ROWS.gs` accidentally rewired to NEW and deletes wanted rows. | Phase 7 classifies it as class `c` (INTENTIONAL-OLD) and the sweep script refuses to rewrite class-(c) files (`bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs` docstring rules). Code review must enforce. |
| 10 | Hebrew tab name corruption via clipboard / Chrome MCP paste. | Every script uses `\u05XX` escapes (per `sheet-hebrew-encoding-safe-script` skill). `_*_SELF_TEST_HEBREW_` confirms round-trip after paste. |
| 11 | User opens dashboard in 2024 mode, sees `0` everywhere because Phase 2 missed historical rows. | Verify with DRY_RUN_MIGRATE_RAW that the 614 / 28 rows include 2023-2025 dates (per memory: `expenses_year_tabs_real_structure.md` — OLD personal rows for all years live in `תנועות`; business rows live in per-year `מאזן חברה` tabs). If business years are missing, run a per-year scan + migrate. |
| 12 | Year selector installed but the historical years' bot rows have category names that the dashboard SUMIFS doesn't match (e.g. "שיווק" vs canonical "עלות שיווק"). | Dashboard SUMIFS uses wildcard `*שיווק*` for some rows per `bot/ExpenseBot_FIXED.gs:280` doc; legacy rows still match. PR #129 (merged) canonicalized new writes. Confirm with `VERIFY_PHASE5_DASHBOARDS()`. |
| 13 | Net-profit formula bug (the 2026-05-16 incident) recurs. | `_buildCompanyDashboardTab` writes `B13 = B6-B12` literally (`lib/sheet-writer.js:507`); R12 is the SUM of category rows. Net = revenue − total. Don't conflate with the historical "net = revenue − raw materials only" view. The verifier reports both (`bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs:10-21`). |
| 14 | A 31st row in `תנועות` with col B = `"2024-10"` but col E = unmapped string falls through to `שונות`. | `bot/ExpenseBot_FIXED.gs` matching falls through to the `_matchCategory_orig` fallback if `CATEGORY_MAP` doesn't hit. Result is `שונות` row in dashboard, NOT an error. Steven can fix by adding a keyword and the next bot write categorizes correctly (PR #129 pattern). Historical row is not retroactively reclassified — see section 4.4. |
| 15 | DocumentProperties 9000-entry cap exceeded on a large dashboard wrap. | The wrap touches ~13 rows × 13 cols = ~169 cells per dashboard, well under cap. The personal + company + extended together = ~500. Safe. |
| 16 | `_resolveTenant_` regression treats Steven's owner phone as a tenant after Phase 1 rewrite. | `OWNER_PHONE` fallback (`bot/ExpenseBot_FIXED.gs:36`) + Script Property `SHEET_OWNER_PHONE` override. Bot owner-path tests in `bot/test_isolation.js` cover this. |
| 17 | Drive version history rolls off in 30 days; rollback window closes. | Steven should "File -> Make a copy" NEW before any major APPLY. Snapshot is the long-term rollback. |
| 18 | Re-running PR #131's snapshot APPLY creates a hidden tab the dashboards do NOT consult under the revised plan — silent waste of writes. | Recommended action: close PR #131 without merge (see section 5.4). If kept, document the snapshot tab as read-only/analytics-only. |

---

## Appendix A — files referenced

Absolute paths in the kesefle repo:

- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/MIGRATE_OLD_TO_KESEFLE.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/MIGRATE_OLD_NOTES.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/SCAN_OLD_CATEGORIES.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/MIGRATE_PHASE_5_VERIFY_FORMULAS.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/SHEET_YEAR_SELECTOR_WIRE.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/lib/sheet-writer.js`
- `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/api/sheet/append.js`

Branches referenced (not in main):
- `origin/feat-year-history-backfill` — `bot/BACKFILL_HISTORICAL_YEARS.gs` + `bot/WIRE_YEAR_HISTORY_LOOKUP.gs` (PR #131 open; recommend close).

PRs referenced:
- #119 (merged): Phase 1 — bot owner write target swap.
- #120 (merged): Phase 2 — DRY_RUN + APPLY raw-data migration.
- #122 (merged): Phase 3+4 — historical snapshot + categories/notes preservation.
- #125 (merged): Phase 5 verifier + Phase 7 file-sweep audit.
- #127 (merged): smart-remap + year-selector helper (PR #127 produced
  `bot/SHEET_DASHBOARD_SMART_REMAP.gs` + `bot/SHEET_DASHBOARD_FULL_AUDIT.gs` +
  `bot/SHEET_YEAR_SELECTOR_WIRE.gs`).
- #128 (merged): `SCAN_OLD_CATEGORIES.gs` diagnostic.
- #129 (merged): bot CATEGORY_MAP expansion + canonical biz subs.
- #130 (open): `MIGRATE_OLD_NOTES.gs` — ready to APPLY.
- #131 (open): `BACKFILL_HISTORICAL_YEARS.gs` + `WIRE_YEAR_HISTORY_LOOKUP.gs`
  — superseded by revised same-tab plan; recommend close.

---

## Appendix B — quick reference: the iron-rule gates

Every APPLY in this migration epic must pass these gates. If any is
missing, do not run the APPLY:

1. `LockService.getScriptLock()` with `.tryLock(30000)` and an early
   return if the lock cannot be acquired.
2. A literal-string-arg confirmation gate (`if (arg !== 'YES I UNDERSTAND') refused`).
3. A `_NOW()` zero-arg wrapper that internally passes the confirmation
   string. The wrapper exists so the Apps Script function dropdown can
   drive the APPLY without typing the arg.
4. An audit trail — either an A1 note on the touched tab, or a
   DocumentProperties entry with timestamp + counts.
5. A backup, either:
   - a `_BAK_*` tab containing the pre-write state of the touched range, or
   - DocumentProperties keyed per (tab, row, col) holding the original
     cell content.
6. An UNDO companion (`UNDO_*`) if the APPLY writes formulas or values.
   Notes/labels do not require an UNDO because they don't destroy
   existing data (the never-overwrite check guarantees this).

A migration script that lacks any of (1)-(5) should be flagged in
code review and brought to par before running.
