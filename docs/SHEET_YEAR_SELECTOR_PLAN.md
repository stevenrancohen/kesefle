# Sheet Year Selector — Final Plan + Validator

Author: Formula QA Agent (Agent 3), autonomous audit block
Date: 2026-05-28
Branch: `audit-year-selector-plan`
Scope: company dashboard `מאזן חברה`, personal dashboard `מאזן אישי`, single `תנועות` tab post-migration.

## 0. Why this doc exists

PR #122 Phase 3 originally tried to add a year selector by populating a separate `סיכום היסטורי` snapshot tab and wrapping every dashboard cell in `=IFS($B$4=2026, <live>, TRUE, <snapshot VLOOKUP>)`. That approach is implemented in `bot/SHEET_YEAR_SELECTOR_WIRE.gs`.

**Steven REJECTED this approach** after we migrated all historical years (2023, 2024, 2025) into the single `תנועות` tab. After migration there are 614 rows across 2023/24/25/26 in one log, all stamped with col B `"YYYY-MM"`. There is no longer a reason to read from a snapshot — the live data is right there.

The right architecture is:

1. `מאזן אישי!B4` is the canonical year selector (dropdown 2023..future).
2. `מאזן חברה!B4` is a **formula link** to `=מאזן אישי!B4` so the two dashboards stay in lockstep.
3. Every dashboard SUMIFS / SUMPRODUCT reads `$B$4&"-MM"` against `'תנועות'!B:B` directly.
4. `Settings!active_year` is mirrored by an `onEdit` trigger for any code path that wants to read the active year without depending on a specific cell.
5. The `סיכום היסטורי` snapshot tab and `SHEET_YEAR_SELECTOR_WIRE.gs` IFS-wrapping are deprecated — kept in the repo for archeology only.

Steven's live verification through `bot/LINK_YEAR_SELECTOR.gs` (in the importjason Apps Script project, not in this repo) already confirmed: **0 hardcoded year refs in either dashboard** after the migration.

This doc:

- Locks down the architecture (section 1-3).
- Specifies the exact formula pattern per dashboard row (section 4-6).
- Plans chart updates (section 7) and historical preservation (section 8).
- Defines the validator that gates future regressions (section 9).
- Lists per-year test cases (section 10) and edge cases (section 11).

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│      ┌─────────────────────┐         ┌─────────────────────┐            │
│      │   מאזן אישי B4      │ ◄────── │   מאזן חברה B4      │            │
│      │   (year dropdown)   │         │   (=מאזן אישי!B4)   │            │
│      │   2023..future      │         │   formula link      │            │
│      └──────────┬──────────┘         └──────────┬──────────┘            │
│                 │                               │                       │
│                 ▼                               ▼                       │
│      ┌─────────────────────┐         ┌─────────────────────┐            │
│      │   Personal SUMIFS   │         │   Company SUMIFS    │            │
│      │ key = $B$4&"-MM"    │         │ key = $B$4&"-MM"    │            │
│      └──────────┬──────────┘         └──────────┬──────────┘            │
│                 │                               │                       │
│                 └──────────────┬────────────────┘                       │
│                                │                                        │
│                                ▼                                        │
│                  ┌──────────────────────────────┐                       │
│                  │           תנועות             │                       │
│                  │  col A: dt (Date)            │                       │
│                  │  col B: monthKey "YYYY-MM"   │                       │
│                  │  col C: amount               │                       │
│                  │  col D: category (עסק / *)   │                       │
│                  │  col E: subcategory          │                       │
│                  │  col F: description          │                       │
│                  │  col H: isExpense (TRUE/F)   │                       │
│                  │  col I: VAT-deductible       │                       │
│                  └──────────────────────────────┘                       │
│                                                                         │
│                  ┌──────────────────────────────┐                       │
│                  │     Settings.active_year     │  (mirror via onEdit)  │
│                  └──────────────────────────────┘                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

Three concrete state holders:

- **`מאזן אישי!B4`** — canonical. Apps Script `DataValidation.requireValueInList([2023..currentYear+1])`. Default value: current calendar year. Personal SUMIFS reference `$B$4`. The dashboard reads `$B$4&"-MM"` for every monthly cell.
- **`מאזן חברה!B4`** — `=מאזן אישי!B4`. Single formula link, written once at provisioning. Company SUMIFS also reference `$B$4` (which transitively reads from the personal cell). No second dropdown — single source of truth.
- **`Settings!active_year`** — mirror. Updated by an `onEdit(e)` trigger whose target range is `מאזן אישי!B4`. Any future code (admin dashboard tile, monthly digest, exports) that wants to know "what year is the user looking at right now" reads this cell.

### Why the formula link instead of two dropdowns

A second dropdown on the company sheet would silently drift — Steven would toggle one tab, look at the other, and see stale numbers. A formula link is unbreakable: company always shows whatever year personal shows. The cost (one cell that can't be manually overridden on the company tab) is zero in practice; Steven always changes the year on the personal tab.

### Why mirror to `Settings.active_year`

The `Settings` tab already holds tenant config (timezone, currency, profession preset, feature flags). Adding `active_year` there gives:

- Apps Script code paths (heartbeat, weekly digest, etc.) one stable read API: `Settings!active_year`.
- A read-only fallback for the admin dashboard so future tools don't poke `מאזן אישי!B4` directly.
- A natural audit trail: the `onEdit` writes a timestamp to `Settings!active_year_updated_at`.

The mirror is one-way: `מאזן אישי!B4` → `Settings`. The Settings cell is never edited manually.

---

## 2. Where `active_year` lives

| Location | Type | Writer | Reader | Purpose |
|---|---|---|---|---|
| `מאזן אישי!B4` | Data-validation dropdown | User | All personal-dashboard SUMIFS via `$B$4` | Canonical year selector |
| `מאזן חברה!B4` | Formula `=מאזן אישי!B4` | Sheet engine (formula recompute) | All company-dashboard SUMIFS via `$B$4` | Live mirror — guarantees company tab year == personal tab year |
| `Settings!active_year` | Plain number | `onEdit(e)` trigger watching `מאזן אישי!B4` | Apps Script (digest, exports, admin) | Programmatic read |
| `Settings!active_year_updated_at` | Datetime | Same `onEdit` trigger | Admin dashboard, audit log | When the user last switched years |

The `Settings.active_year` mirror update is idempotent — the trigger reads the current value of `מאזן אישי!B4`, and if `Settings.active_year` already equals that, it skips the write. This avoids trigger thrash on no-op cell edits.

### Provisioning sequence (new tenant or existing-tenant repair)

1. Create `מאזן אישי` tab with B4 dropdown (years 2023 through current+1, default current).
2. Create `מאזן חברה` tab with B4 set to `=מאזן אישי!B4`.
3. Create `Settings` tab if not present; write `active_year = <current calendar year>`.
4. Install `onEdit` trigger if not present (one per script project, idempotent).
5. Backfill every monthly cell in both dashboards with the canonical SUMIFS formulas (sections 4-6).

For existing tenants the migration is reversible — `_BAK_yearselector_<ts>` snapshot tab is written first per Steven's hard rule (backup-first, propose-before-apply, never overwrite user-typed values).

---

## 3. Dropdown vs Apps Script menu — recommendation

**Recommendation: Native sheet dropdown, NOT a custom Apps Script menu.**

| Criterion | Native dropdown (B4) | Apps Script menu |
|---|---|---|
| User discoverability | Visible right at the top of the dashboard | Hidden in "extensions / כספלה" menu |
| Mobile (Sheets app on iPhone) | Works | Menus often hidden / unreliable on mobile |
| Latency | Instant — formula recompute | Custom menu picks → script execution → setValue → recompute (1-3 sec) |
| Failure modes | Cell-validation refuses bad year (e.g. "two thousand") | Script can throw, leave UI in limbo |
| Onboarding instructions | "Click cell B4" — universal | Requires explaining where the custom menu lives |
| Code-side complexity | Zero ongoing — just provision validation rule once | Apps Script menu registration, handler, error path |
| Cross-tab consistency | Linked formula keeps tabs in sync automatically | Menu writes to one tab; other tab needs separate listener |
| Steven's actual workflow | He's been editing B4 directly for months — muscle memory | Would require retraining |

The only thing an Apps Script menu buys is the ability to pre-validate or pre-warn ("You're switching to 2024 — January has no data"). That's a nice-to-have we can layer on later as a sidebar (rendered HTML) if the user requests it, but the year selector itself stays in the sheet.

For tenants who want one-click "show me this year vs last year" comparisons we can add a small explicit UI tile on the `כספלה Web` dashboard that mirrors `Settings!active_year` — but the source of truth stays the B4 cell.

---

## 4. Formula pattern for `מאזן אישי` (personal)

All personal monthly cells follow this canonical shape (see `lib/sheet-writer.js` `_personalCategoryRow`, line 179):

```
=IFERROR(
  SUMIFS(
    'תנועות'!C:C,
    'תנועות'!B:B, $B$2 & "-MM",
    'תנועות'!E:E, "*" & $A<row> & "*"
  ),
  0
)
```

Where:

- `$B$2` is the personal year cell (the personal dashboard top header has the year in `B2`, not `B4` — see `lib/sheet-writer.js` line 217 `R2: "📅 שנה:" | <year>`).
- `MM` is the literal padded month index (01..12), the only literal value in the formula.
- `$A<row>` is the row's category label (e.g. `דלק`, `מתנות`) — wildcards allow the SUMIFS to match subcategory variants the bot writes (e.g. `אוכל בחוץ — מסעדה` matches `*אוכל בחוץ*`).
- `IFERROR(..., 0)` prevents `#N/A` when a month has no rows for that subcategory.

### Cross-check with code

The shipped builder at `lib/sheet-writer.js` line 186 already emits exactly this shape:

```js
`=IFERROR(SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$2&"-${mm}", '${TX_TAB}'!E:E, "*"&$A${rowNum}&"*"), 0)`
```

The year reference (`$B$2`) is dynamic. The only hardcoded thing per cell is the month index — which is correct (column C = January = `01`, etc.).

### Important: there are TWO personal dashboard variants

- The legacy `_buildPersonalDashboardTab` uses `$B$2` as the year cell (R2).
- The newer `_buildExtendedDashboardTab` (Pa'amonim-style) uses `$B$1` as the year cell (R1).

Both share the same SUMIFS shape — only the year-cell anchor differs. The validator (section 9) handles both.

### What about Steven's spec saying B4?

Steven's task brief asserts `מאזן אישי!B4 = canonical year`. There's a real-world discrepancy here:

- The `lib/sheet-writer.js` template emits the personal year cell at **R2C2 = B2**.
- The deployed `מאזן חברה` template emits it at **R4C2 = B4**.
- Steven's brief consolidated them as `B4`.

**Recommendation for implementation:** keep the existing per-template anchors (`B2` for personal `_buildPersonalDashboardTab`, `B1` for `_buildExtendedDashboardTab`, `B4` for company `_buildCompanyDashboardTab`). The cross-tab link becomes:

```
מאזן חברה!B4 = מאזן אישי!B2
```

OR migrate the personal `_buildPersonalDashboardTab` to put the year at B4 instead of B2 (would require a one-time `_BAK_*` backup + setFormula sweep on every existing tenant — Phase A v2.2-style — and a regen of every personal SUMIFS to reference `$B$4` instead of `$B$2`).

The doc treats `$B$4` as the canonical anchor (per Steven's brief), and the migration to align both templates on `B4` is **Phase B** — out of scope for this plan but logged as a follow-up.

---

## 5. Formula pattern for `מאזן חברה` (company)

Three groups of formulas:

### 5.1 Revenue + order count (rows 6-7)

Live SUMIFS against `הזמנות` (orders log) by date range — the canonical builder in `lib/sheet-writer.js` line 449:

```
=IFERROR(
  SUMIFS(
    'הזמנות'!D:D,
    'הזמנות'!A:A, ">=" & DATE($B$4, M, 1),
    'הזמנות'!A:A, "<"  & DATE($B$4, M+1, 1)
  ),
  0
)
```

The `DATE($B$4, M, 1)` reads the year from `B4` and stitches it with the month literal. M is 1..12, the only literal in the formula.

### 5.2 Business expense buckets (rows 8-11 — materials / marketing / shipping / ops)

From `lib/sheet-writer.js` line 485:

```
=IFERROR(
  SUMIFS('תנועות'!C:C,
    'תנועות'!B:B, $B$4 & "-MM",
    'תנועות'!D:D, "עסק",
    'תנועות'!E:E, "<bucket criterion>"
  ),
  0
)
```

Each row may sum multiple SUMIFS (one per `criteria[]` entry) and join them with `+`. The bucket criteria are wildcard strings the bot writes into col E (`*שיווק*`, `*חומרי גלם*`, etc.) — see `COMPANY_EXPENSE_ROWS` at line 98.

### 5.3 Totals / net / margin (rows 12-14)

Pure cell math, no תנועות reference — built from `lib/sheet-writer.js` line 497-521:

- `B12 = SUM(B8:B11)` (total business expenses)
- `B13 = B6 - B12` (net profit)
- `B14 = IFERROR(B13/B6, 0)` (margin %)

These propagate the year implicitly via B6/B12 — no `$B$4` needed in the formula.

### Cross-tab link

```
מאזן חברה!B4 = '=מאזן אישי!B2  (or B4 once Phase B aligns templates)
```

Written once during provisioning. Apps Script writes `cell.setFormula("=" + "'" + PERSONAL_TAB + "'!B2")` so the cell becomes a live formula link, not a copied value.

---

## 6. Special-case formulas

### 6.1 Personal row "עסק 2 הכנסה" cross-tab pull

Steven's brief calls out: *"Personal row 6 'עסק 2 הכנסה' — pulls from `'מאזן חברה'!C13:N13` — must propagate year via linked B4"*.

Concretely: the personal income section has a row (currently `'הכנסה 2 — עסק'` per `lib/sheet-writer.js` line 57) that should reflect the company's monthly net profit (`'מאזן חברה'!C13:N13` = row 13 = `📈 רווח נטו חודשי`).

**Pattern:**

```
=IFERROR('מאזן חברה'!<col><row13>, 0)
```

Where `<col>` is the same column letter as the personal monthly cell (C..N) and `<row13>` is the net-profit row in `מאזן חברה` (currently row 13).

Year propagates automatically because:

1. Personal `B4` changes → personal SUMIFS pick up new monthKey, recompute.
2. `מאזן חברה!B4` formula-links to personal B4 → company `B4` changes too.
3. Company SUMIFS for revenue (`'הזמנות'` by date range) and expenses (`'תנועות'` by `$B$4&"-MM"`) recompute.
4. Company `B13` = `B6 - B12` recomputes per column.
5. Personal `B6` references company `B13` → it picks up the new net profit per month.

**Validator implication:** the personal "עסק 2 הכנסה" row formula must NEVER hardcode a year. It MUST only reference cells in `מאזן חברה`. The validator's pattern A (`"YYYY-MM"` hardcoded month key) and D (`YYYY&"-MM"` concat) cover this automatically — any cross-tab reference like `'מאזן חברה'!C13` reads a cell, not a year string, so it's clean.

### 6.2 Total rows (`סה״כ X`) — label-walker pattern

The "fix totals by label" skill warns against hardcoded ranges like `=SUM(B16:B27)` because tenant templates can drift (rows inserted/deleted). The recommended pattern is the label-walker: at provisioning, the totals formula walks col A of the tab, finds the first `קטגוריה` rows belonging to the section, and emits `=SUM(B<first>:B<last>)` literally — but the **source rows** are identified by label match, not row number.

Already shipped: `FIX_TOTALS_PERSONAL` in `bot/personal_sheet_fix.gs` uses `_bucketLabelMatch_` + dashData scan to locate the right row regardless of layout drift. Year does NOT enter into the formula — the SUM cell references only intra-tab cells in the same column, all of which already propagate year correctly.

**Validator implication:** total rows never reference `תנועות` or `הזמנות` directly. The validator's formula-context co-occurrence filter (FORMULA_HINTS) is satisfied only when a year pattern AND a SUMIFS / SUMPRODUCT / sheet-ref appears within ±3 lines, so pure `=SUM(B8:B11)` totals don't trigger.

### 6.3 Net profit row 13 in `מאזן חברה`

```
B13 = B6 - B12
C13 = C6 - C12
...
N13 = N6 - N12
```

No year reference. Year propagates from B6/B12.

The downstream impact on personal row 6 cross-tab pull (section 6.1) makes this row the load-bearing one for "switch year, see what your business earned." The validator can't catch a logic bug here (e.g. someone changing `B6 - B12` to `B6 - B11`) — that's a unit-test concern, not a hardcoded-year concern. See section 10 for the per-year test that verifies `revenue - totalExpenses == netProfit` per (year × month).

---

## 7. Charts plan

Today's `מאזן חברה` template (per `lib/sheet-writer.js` `_buildCompanyDashboardTab`) doesn't include embedded charts. The `_buildExtendedDashboardTab` does ship pie + bar charts via the Sheets API `charts` field.

When `B4` changes:

- **Pie charts** that read `=SUM(income section)` vs `=SUM(expense section)`: auto-recompute because the underlying cells recompute. No chart-level change needed.
- **Bar charts** that read `B<row>:N<row>` per metric: auto-recompute for the same reason. The chart axis labels (Jan..Dec) stay constant.
- **Sparklines** in cells (`SPARKLINE(B11:E11, ...)` in `bot/FIX_PROFITABILITY_AND_CHART.gs`): inline-cell sparkline data is a cell range, so they pick up new values automatically.
- **Trend chart "year vs prev year"** (NOT YET BUILT — would compare current B4 against B4-1): when added, must source both years via SUMIFS keyed off `$B$4` and `$B$4-1`. Validator must accept `$B$4-1` (formula arithmetic) but reject any literal year embedded in the prev-year half. This is logged as an out-of-scope follow-up for a later sprint.

### Action items

- No chart changes required in this PR. Existing charts inherit year switching for free.
- Validator can stay narrow (no special chart-formula whitelist).

---

## 8. Historical preservation

**Hard invariant: rows in `תנועות` are NEVER overwritten or deleted.**

- Col A: date (Date object).
- Col B: monthKey `"YYYY-MM"` (string). Stamped at write-time by the bot or backfill script — permanent.
- Cols C-I: amount, category, sub, description, source, isExpense, VAT-flag — all immutable after write.

Migration history:

- Pre-2026-05-28: each year (2023/24/25) had its own log tab (e.g. `2024 — תנועות`).
- 2026-05-28 onward: a single `תנועות` tab holds all 614 rows across the four years. The migration (`bot/MIGRATE_OLD_TO_KESEFLE.gs` Phase 5) copied historical rows over, preserving the original `monthKey` stamp.

Consequence for the year selector:

- Switching B4 to 2023 doesn't pull from a separate tab. It re-evaluates the same SUMIFS against the same single תנועות tab, with criterion `"2023-MM"` instead of `"2026-MM"`.
- Frozen 2023 numbers visible today on `מאזן חברה` rows 18-49 are *redundant snapshots* — they should be archived/deleted in **Phase C** once the year-switch view is verified.
- Until Phase C, the snapshot rows act as a checksum: if the live SUMIFS produces a different number than the snapshot, something is wrong with the migration (a row missing, a wrong monthKey).

### Recovery procedure

If a tenant reports "I switched to 2024 and my numbers all changed to wrong values" — see `bot/personal_sheet_fix.gs` `AUDIT_COMPANY_DASHBOARD` for the read-only checker. It scans `תנועות`, computes expected totals from raw rows for every year, and compares against what `מאזן חברה` cells currently show. Run before any write to confirm direction of the error.

`תנועות` is never the failure mode — if `AUDIT_COMPANY_DASHBOARD` shows the expected total per (year × bucket) is correct but the dashboard cell shows zero, the formula is broken (not the data). Apply `RECOMPUTE_COMPANY_DASHBOARD` (in `bot/personal_sheet_fix.gs`) to rebuild formulas. Backup-first per Steven's hard rule.

---

## 9. Validation script — `bot/VALIDATE_NO_HARDCODED_YEAR.js`

### Purpose

Static analysis. Walks every `bot/*.gs` file, flags any line that:

1. Looks like formula-building code (FORMULA_HINTS within ±3 lines: `SUMIFS`, `SUMPRODUCT`, `COUNTIFS`, `'תנועות'!`, `'הזמנות'!`, `$B$4`, `setFormula`, etc.).
2. Contains a hardcoded year pattern (matched by one of four regexes).
3. Is NOT in a pure comment, NOT a `Logger.log` / `console.log` / `.setNote` argument, NOT in the whitelist.

### Patterns (in code)

```js
RE_HARDCODED_YEAR_STRING    = /\\?["']2(0[2-9][0-9])-\d{2}\\?["']/;
RE_HARDCODED_DATE_YEAR      = /DATE\s*\(\s*2(0[2-9][0-9])\s*,/;
RE_HARDCODED_YEAR_COMPARE   = /YEAR\s*\([^)]*\)\s*[=<>!]+\s*2(0[2-9][0-9])/;
RE_HARDCODED_YEAR_AMPERSAND = /\b2(0[2-9][0-9])\s*&\s*\\?["']-\d{2}/;
```

Each pattern catches a real-world regression mode:

| Regex | Catches | Real-world example |
|---|---|---|
| `RE_HARDCODED_YEAR_STRING` | `"2026-05"` as SUMIFS criterion | `SUMIFS(..., B:B, "2026-05")` |
| `RE_HARDCODED_DATE_YEAR` | `DATE(2026, ...)` literal | `SUMIFS(..., A:A, ">=" & DATE(2026,1,1))` |
| `RE_HARDCODED_YEAR_COMPARE` | `YEAR(...) == 2026` | `SUMPRODUCT((YEAR(A:A)=2026)*(C:C))` |
| `RE_HARDCODED_YEAR_AMPERSAND` | `2026 & "-05"` literal year concat | `SUMIFS(..., B:B, 2026 & "-05")` |

### Whitelist

`bot/SHEET_YEAR_SELECTOR_WIRE.gs` (rejected architecture, kept for archeology) and `bot/FIX_DASHBOARD_2023_2024_2025.gs` (one-shot historical migration script) are **file-level** whitelisted. The `WHITELISTED_FILES` Set at the top of the script lists them with comments explaining why.

The **line-level** whitelist covers:

- The 2026-05 `+2100` marketing manual override (Steven's documented cash adjustment, deliberately encoded as `blk.year === 2026 && mi === 5`).

### Pass criteria

```
filesScanned   >= 30  (all bot/*.gs except whitelisted)
violations     == 0
scanErrors     == 0
exit code      == 0
```

### Failure output

When violations exist, the script prints:

```
Violations (N):
  bot/<file>.gs:<lineNo>  [<reason>]
    <snippet>

FAIL: hardcoded year refs in formula-building code.
Year selector requires every dashboard SUMIFS to read $B$4, not a literal year.
Fix: replace the literal year with the $B$4 cell reference (or DATE($B$4,...)).
Whitelist exceptions live in WHITELISTED_FILES / isWhitelistedLine at top of this file.
```

…and exits with code 1.

### Usage

```sh
node bot/VALIDATE_NO_HARDCODED_YEAR.js            # human-readable, exit 0/1
node bot/VALIDATE_NO_HARDCODED_YEAR.js --verbose  # per-file breakdown
node bot/VALIDATE_NO_HARDCODED_YEAR.js --json     # machine-readable
```

### Integration with CI

Add to the `tests/full_qa.js` offline gauntlet so any PR that introduces a hardcoded year SUMIFS fails the QA suite. There's no `package.json` in the repo (everything runs via direct `node <path>`), so the integration is by reference from full_qa.js, not by an npm script.

### Verified runs (this PR)

- **Baseline** (current main, post-migration): scans 32 .gs files, skips 2 whitelisted, **0 violations**, exits 0.
- **Synthetic negative test** (temp file with 5 bug patterns: raw `"2026-05"`, escaped `\"2026-05\"`, `DATE(2026,1,1)`, `2026&"-05"`, `YEAR()=2026`): all 5 caught, exits 1.

---

## 10. Test cases — per year

For each year ∈ {2023, 2024, 2025, 2026}:

### 10.1 Personal expense category sum

```
Setup:  set מאזן אישי!B4 = <year>
Cells:  מאזן אישי!C<row_of_'דלק'> .. N<row_of_'דלק'>
Expect: each cell = SUM of תנועות col C where
          col B == "<year>-MM" AND col E contains "דלק"
        AND personal!B<row>_annual = SUM(C..N)
```

Run for at least three categories per year: one frequent (`דלק`), one rare (`מתנות`), one likely-empty (`חיות מחמד` for 2023).

### 10.2 Business revenue

```
Setup:  set מאזן אישי!B4 = <year>  (→ propagates to מאזן חברה!B4 via formula link)
Cells:  מאזן חברה!C6 .. N6
Expect: each = SUMIFS of הזמנות col D where
          הזמנות col A ∈ [DATE(year,M,1), DATE(year,M+1,1))
        AND B6_annual = SUM(C6:N6)
```

### 10.3 Business expense by sub-bucket

```
Setup:  B4 = <year>
Cells:  C8..N8 (raw materials), C9..N9 (marketing), C10..N10 (shipping), C11..N11 (ops)
Expect: each = SUMIFS of תנועות col C where
          col B == "<year>-MM"
          AND col D == "עסק"
          AND col E matches the bucket's wildcard criteria
```

### 10.4 Net profit propagation to personal row 6

```
Setup:  B4 = <year>
Cells:  מאזן אישי!C<row_of_'הכנסה 2 — עסק'> .. N<row_of_'הכנסה 2 — עסק'>
Expect: each = 'מאזן חברה'!C13 .. N13 respectively
        AND those מאזן חברה!*13 cells = revenue(year,M) - totalExpenses(year,M)
```

### 10.5 Sum-row recalc (label-walker)

```
Setup:  B4 = <year>
Cells:  מאזן אישי!B9 (סה״כ הכנסות), B10 (סה״כ הוצאות)
Expect: B9 = SUM(B5:B8)
        B10 = B28+B34+B39+B50+B58 (sum of section totals — see lib/sheet-writer.js line 288)
        B11 = B9 - B10 (חיסכון)
```

The years 2023/24/25/26 all use the same row layout — the label-walker stays a guard, not an active recompute.

### 10.6 Pass criteria

Tolerance ±0.5 ₪ for rounding (matches `AUDIT_COMPANY_DASHBOARD` `TOL = 0.5`).

A test run against a real tenant sheet should print: `<year>: ok N / total M (mismatch 0, missing 0)`. Any mismatch flags either:

a) a broken formula in the sheet (apply `RECOMPUTE_COMPANY_DASHBOARD`), or
b) a missing/corrupted row in `תנועות` (apply `_BAK_*` recovery).

These tests run against Steven's live sheet (1rtiPQs1...). They are sheet-side validation — the unit-test-side equivalent is the existing `bot/test_dashboard_repair.js` which asserts the formula-builder code emits the right shape.

---

## 11. Edge cases

### 11.1 Empty year

```
Setup:  B4 = 2030  (no תנועות rows yet)
Expect: every monthly cell = 0
        every section-total cell = 0
        net profit = 0
        margin = IFERROR(0/0, 0) = 0
        NO #DIV/0!, NO #REF!, NO blank cells
```

Validator implication: `IFERROR(..., 0)` wrapping is mandatory on every SUMIFS. Existing builder already does this (`lib/sheet-writer.js` line 186, 449, 489).

### 11.2 Partial year (March-only)

```
Setup:  B4 = 2026, תנועות contains rows for monthKey "2026-03" only
Expect: C..E (Jan-Feb-Mar) — Jan=0, Feb=0, Mar=<sum>
        F..N (Apr-Dec) — all zero
        annual cell B = Mar value
```

No special-case needed — SUMIFS over an empty month range returns 0 naturally. The dashboard handles this correctly today.

### 11.3 Future year (no data yet)

```
Setup:  B4 = current_year + 1
Expect: same as empty year (11.1) — all zeros, no errors
```

Dropdown validation rule in `מאזן אישי!B4` should permit `current_year + 1` so users can start entering future-year budgets. The provisioning script computes `_YS_YEAR_RANGE_ = [oldest_data_year, current+1]` at provision time, NOT a hardcoded list (the rejected `SHEET_YEAR_SELECTOR_WIRE.gs` hardcoded `[2023..2027]` which is one of the reasons that script is whitelisted out).

### 11.4 Year-boundary edits

```
Setup:  User edits a row in תנועות changing col B from "2026-01" to "2025-12"
        (e.g. classifier originally got the year wrong)
Expect: dashboard auto-recomputes on the next cell evaluation
        Settings.active_year UNCHANGED (only user changes to מאזן אישי!B4 trigger that)
        Audit log entry written (NOT in scope for this PR — Phase C)
```

### 11.5 Multi-business owner ("עסק 2 X" rows)

```
Setup:  תנועות contains rows with col D ∈ {"עסק", "עסק 1", "עסק 2", "עסק כספלה - <name>"}
Expect: company dashboard counts only "עסק" rows (per current SUMIFS criterion col D = "עסק")
        Per-business breakdown sits on a SEPARATE tab (per skill `sheet-multi-business`)
        Year selector applies to ALL business tabs (each reads its own $B$4 with its own dropdown OR all read מאזן אישי!B4 via formula link)
```

The single-`תנועות`-tab decision in this PR doesn't change multi-business routing — that logic still keys off col D. The year selector remains a per-cell `$B$4` ref everywhere.

### 11.6 Charts that span multiple years

Out of scope for this PR. Logged as Phase D: "YoY comparison panel" — would require a second year selector cell (e.g. `מאזן חברה!B5 = previous year`), formulas that read `$B$4` and `$B$5` simultaneously, and a small bar chart showing both. None of which requires changing the validator.

---

## Implementation order (out-of-scope summary)

For the team that picks up the actual sheet-side migration:

1. **PR 1 (this PR):** plan doc + validator only. No sheet changes, no formula rewrites. Land for review.
2. **PR 2 (Phase A):** provision the `מאזן חברה!B4 = =מאזן אישי!B4` formula link on existing tenants. Backup-first. DRY_RUN_LINK_B4 + APPLY_LINK_B4("YES I UNDERSTAND"). No formula rewrites.
3. **PR 3 (Phase B):** align personal year cell on `B4` (currently `B2`). Sweep all personal SUMIFS to reference `$B$4` instead of `$B$2`. DRY_RUN + APPLY pattern. Backup-first.
4. **PR 4 (Phase C):** archive `סיכום היסטורי` snapshot tab + frozen `מאזן חברה` rows 18-49 once year-switch is verified for a week against real data.
5. **PR 5 (Phase D):** YoY comparison panel, sidebar UI, audit log integration.

Each phase has its own validator regression test added to `tests/full_qa.js`.

---

## Files this PR ships

- `docs/SHEET_YEAR_SELECTOR_PLAN.md` (this file).
- `bot/VALIDATE_NO_HARDCODED_YEAR.js` (validator, executable via `node bot/VALIDATE_NO_HARDCODED_YEAR.js`).

No `.gs` files are modified. No sheet writes. No live changes. PR is review-only.
