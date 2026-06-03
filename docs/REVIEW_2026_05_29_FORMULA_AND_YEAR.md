# Workstream 2 — Formula + Year-Selector Audit

Date: 2026-05-29
Scope: READ-ONLY audit. No writes, no APPLY, no merges.
Target sheet: `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` (Steven's NEW Kesefle sheet)
Lens: kesefle-sheet-formula-year-selector-validator discipline.

---

## TL;DR

The PR #151 SUMIFS-arithmetic-coercion fix is in place where it shipped (MIGRATE_DASHBOARD_FROM_OLD.gs uses SUMPRODUCT+LEFT with IF-empty fallback). But there are FOUR adjacent classes of formula problems still alive in the repo:

1. Two formula-installer functions in ExpenseBot_FIXED.gs (`installCompanyDashboardFormulas`, `installPersonalDashboardFormulas`) write a DYNAMIC-but-FROZEN year into each SUMIFS — the formulas don't follow the B2/B4 selector when the user changes it. Gated by `AUTO_FIX_DASHBOARDS=1`.
2. SHEET_YEAR_SELECTOR_WIRE.gs has `_YS_CURRENT_YEAR_ = 2026` hardcoded as the live/historical switch — a year-rollover bug ~7 months away.
3. New-tenant template (`lib/sheet-writer.js buildTenantSheetSpec`) provisions a year NUMBER in B1/B2/B4 but never adds DataValidation — no dropdown, no "in-list" constraint. If a user clears the cell, SUMIFS silently returns 0.
4. The existing `test_no_hardcoded_year_in_dashboard_formula.js` is too narrow — it only flags year literals that appear on the SAME line as `setFormula`/`SUMIFS`. It misses the two installers above where `monthKey` is built one line and embedded another. Test coverage gap.

Three different year-selector cells in use across three dashboards: `$B$1` (פירוט מורחב), `$B$2` (מאזן אישי), `$B$4` (מאזן חברה). Documented and intentional, but means three different DataValidation install paths are needed and only `$B$4` is currently provisioned by any tool.

---

## Files that generate dashboard formulas (inventory)

| File | Type | Year selector cell | Uses SUMPRODUCT? | Has the SUMIFS arithmetic-coercion bug from #151? | Notes |
|---|---|---|---|---|---|
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` | SUMPRODUCT writer | `$B$4` | YES (LEFT(B,4)= yearExpr) | NO — fixed (line 207-222) | The PR #151 fix. Has `IF($B$4="", YEAR(TODAY()), $B$4)` fallback. CLEAN. |
| `bot/personal_sheet_fix.gs` (`_buildBusinessRowFormulas_`) | SUMIFS writer | `$B$4` | NO (uses `$B$4&"-MM"` equality) | NO — equality, not range; benign | Line 89. Uses safe pattern. |
| `bot/personal_sheet_fix.gs` (`_psf_buildFormula_v2_`) | SUMPRODUCT writer | hardcoded year per block (per-year-block layout) | YES | N/A — per-year-block layout, not single-block selector | Lines 1974-2030. By-design for the OLD multi-year layout. |
| `bot/personal_sheet_fix.gs` (`FIX_MARKETING_ALL_YEARS`) | SUMPRODUCT writer | hardcoded year per block | YES | N/A — same as above | Lines 791-901. |
| `bot/personal_sheet_fix.gs` line 246 (`_addCompanyDashboardWildcardWrap_` equivalent) | SUMIFS writer | `$B$2` | NO | NO — uses `$B$2&"-MM"` (safe equality) | Per personal dashboard convention. CLEAN. |
| `lib/sheet-writer.js` `_personalCategoryRow` | SUMIFS writer | `$B$2` | NO | NO — uses `$B$2&"-MM"` equality (line 186) | CLEAN. |
| `lib/sheet-writer.js` `_buildCompanyDashboardTab` row 6 (revenue) | SUMIFS by date range | `$B$4` via `DATE($B$4,m,1)` | NO | NO — DATE() not concatenation, line 450 | CLEAN. |
| `lib/sheet-writer.js` `_buildCompanyDashboardTab` row 7 (orders) | COUNTIFS by date range | `$B$4` via `DATE($B$4,m,1)` | NO | NO — DATE() (line 462) | CLEAN. |
| `lib/sheet-writer.js` `_buildCompanyDashboardTab` rows 8-11 (expenses) | SUMIFS writer | `$B$4` | NO | NO — uses `$B$4&"-MM"` equality (line 485) | CLEAN. |
| `lib/sheet-writer.js` `_buildExtendedDashboardTab` (`emitSubcatRow`) | SUMIFS writer | `$B$1` | NO | NO — uses `$B$1&"-MM"` equality (line 584) | CLEAN. |
| `bot/SHEET_DASHBOARD_SMART_REMAP.gs` | SUMPRODUCT writer | `$B$4` | YES (B:B = `$B$4&"-MM"`) | NO — but no `IF($B$4="",…)` empty fallback (line 167-173) | Minor: empty-B4 returns 0 silently. |
| `bot/SHEET_YEAR_SELECTOR_WIRE.gs` | IFS-wrapper around live/historical | `$B$4` | N/A (wraps existing) | NO — but has `_YS_CURRENT_YEAR_ = 2026` hardcoded (line 71) | Year-rollover bug. |
| `bot/ExpenseBot_FIXED.gs` `installCompanyDashboardFormulas` | SUMIFS writer | reads B2 OR tab name, writes **frozen** string | NO | **YES — different flavor**: `monthKey = year + '-' + MM` baked into formula text (lines 15824-15827). User can't change year via selector. | HIGH. Gated by Script Property `AUTO_FIX_DASHBOARDS=1`. |
| `bot/ExpenseBot_FIXED.gs` `installPersonalDashboardFormulas` | SUMIFS writer | reads B2, writes **frozen** string | NO | **YES — same** (lines 15963-15965) | HIGH. Same gate. |
| `bot/ExpenseBot_FIXED.gs` `migrateDashboardToSUMIFS` | SUMIFS writer | reads B2 from `'מאזן שנתי'`, writes **frozen** | NO | **YES — same** (line 11242) | Targets OLD `מאזן שנתי` tab name; manual one-shot. |
| `bot/SHEET_DASHBOARD_FULL_AUDIT.gs` | Audit reader (no writes) | reads `$B$4` ref existence | N/A | N/A — has hardcoded `_FA_YEAR_BLOCKS_` row map (line 67-71) | Read-only audit. Hardcoded layout mapping. |
| `bot/ExpenseBot_DEPLOY.gs` | Pre-assembled paste-version of ExpenseBot_FIXED.gs | Same as FIXED | Same | Same — inherits both bugs | Mirrors FIXED. Bug surfaces wherever DEPLOY runs. |

---

## Files with hardcoded year literals in formula-building context

Validator `bot/VALIDATE_NO_HARDCODED_YEAR.js` was run and PASSES — no literal `"2026-05"` style criterion strings are present.

```
Scanned 23 .gs file(s) under bot/ (1 whitelisted, skipped).
OK: no hardcoded year references in formula-building code.
```

Additional structural hardcoded years FOUND (not caught by the existing validator because they're variables not literals):
- `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` — `var _YS_CURRENT_YEAR_ = 2026;` (controls live/historical switch year)
- `bot/SHEET_DASHBOARD_FULL_AUDIT.gs:67-71` — hardcoded `_FA_YEAR_BLOCKS_` row map for years 2023-2026 (read-only audit, low risk)

---

## SUMIFS-arithmetic-coercion bug locations (the bug from PR #151)

### Confirmed FIXED
- `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:207-222` — `_MDD_buildFormulas_` uses SUMPRODUCT+`LEFT(B2:B2000,4)=yearExpr` with `yearExpr = IF($B$4="", TEXT(YEAR(TODAY()),"0000"), TEXT($B$4,"0000"))`. The exact pattern Steven called out for PR #151.

### NOT applicable (different pattern, both files use equality `$B$4&"-MM"` which Sheets coerces to text correctly)
- `bot/personal_sheet_fix.gs:89`, `bot/personal_sheet_fix.gs:246`
- `lib/sheet-writer.js:186, 485, 584`
- `bot/SHEET_DASHBOARD_SMART_REMAP.gs:167-173`

The bug pattern that was broken is range-comparison concatenation `">="&$B$4&"-01"` (range/lexical comparison forces arithmetic on `$B$4&"-01"`). None of the surviving SUMIFS instances use that range pattern; they all use equality `$B$4&"-MM"` which is text-coerced correctly.

### Adjacent FROZEN-year bug (related but distinct)
These don't get parsed as arithmetic — they bake a static year STRING into the formula at write time, so the year selector is wired but ignored:

| File | Lines | Pattern | Severity | Triggered by |
|---|---|---|---|---|
| `bot/ExpenseBot_FIXED.gs` | 15824, 15827 | `monthKey = year + '-' + MM; f = '…!B:B, "' + monthKey + '"…'` | HIGH | `installCompanyDashboardFormulas()` — opt-in `AUTO_FIX_DASHBOARDS=1` |
| `bot/ExpenseBot_FIXED.gs` | 15963, 15965 | Same shape | HIGH | `installPersonalDashboardFormulas()` — same gate |
| `bot/ExpenseBot_FIXED.gs` | 11233, 11242 | `monthKey = year + '-' + MM` baked into formula | HIGH | `migrateDashboardToSUMIFS()` — manual one-shot, targets legacy `'מאזן שנתי'` |
| `bot/ExpenseBot_DEPLOY.gs` | 11308, 11317; 15899, 15902; 16038, 16040 | Mirror of all three above | HIGH | Same — DEPLOY is the paste-version |

Why these matter: if `AUTO_FIX_DASHBOARDS=1` is ever flipped on Steven's NEW sheet (or any other tenant's), the installer will OVERWRITE the existing year-selector-aware formulas with frozen-year formulas. Then changing B2/B4 silently returns the same number every time.

---

## Year selector wiring

Locations that READ or SET a year-selector cell:

| File:Line | Cell | Operation |
|---|---|---|
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:170-174` | B4 | Read (detect existing selector) |
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:347-385` `_MDD_ensureYearSelector_` | B4 | Sets value (if empty, to current year) + adds DataValidation list `_MDD_YEARS_` |
| `bot/MIGRATE_DASHBOARD_FROM_OLD.gs:420-423` | B4 | Restore from backup (rollback path) |
| `bot/SHEET_YEAR_SELECTOR_WIRE.gs:110-142` `_ys_ensureYearDropdown_` | B4 | Sets DataValidation list of `_YS_YEAR_RANGE_ = [2023..2027]`; defaults to `_YS_CURRENT_YEAR_ = 2026` if blank |
| `bot/personal_sheet_fix.gs:686-696` | B4 | Read-only diagnostic |
| `bot/personal_sheet_fix.gs:394-412` `_resolveDashboardYear_` | B4 | Read with fallback chain (B4 → Date → top-10 scan → today) |
| `bot/ExpenseBot_FIXED.gs:11197` | B2 | Read for `migrateDashboardToSUMIFS` (legacy `'מאזן שנתי'`) |
| `bot/ExpenseBot_FIXED.gs:15704` `_dashResolveYear_` | B2 | Read with fallback (tab-name pattern → B2 → today) |

### Cells in use across three dashboards
- **`מאזן אישי` → `$B$2`** — provisioned with a hardcoded number by `_buildPersonalDashboardTab` (line 257-260). NO DataValidation. NO dropdown.
- **`מאזן חברה` → `$B$4`** — provisioned with a hardcoded number by `_buildCompanyDashboardTab` (line 427-431). NO DataValidation in sheet-writer; `MIGRATE_DASHBOARD_FROM_OLD.gs` and `SHEET_YEAR_SELECTOR_WIRE.gs` install it post-hoc.
- **`פירוט מורחב` → `$B$1`** — provisioned with a hardcoded number by `_buildExtendedDashboardTab` (line 556-559). NO DataValidation. NO dropdown.

So out-of-the-box, a freshly provisioned tenant sheet has THREE different year cells, none of which has a dropdown — they're plain numeric cells.

---

## Empty-B4 behavior

Per pattern:

| Formula pattern | Empty selector → result |
|---|---|
| `SUMPRODUCT(...(LEFT(B:B,4) = IF($B$4="", TEXT(YEAR(TODAY()),"0000"), TEXT($B$4,"0000")))...)` (MDD) | Falls back to current year. CORRECT. |
| `SUMIFS(..., B:B, $B$4&"-MM", ...)` (sheet-writer company, personal_sheet_fix) | Criterion becomes `"-MM"`, B:B never equals it → returns 0. SILENT. |
| `SUMIFS(..., B:B, $B$2&"-MM", ...)` (sheet-writer personal) | Same — returns 0. SILENT. |
| `SUMIFS(..., B:B, $B$1&"-MM", ...)` (sheet-writer extended) | Same — returns 0. SILENT. |
| `SUMIFS(..., A:A, ">=" & DATE($B$4, m, 1), ...)` (sheet-writer revenue/orders) | `DATE(0, m, 1)` evaluates; row-A dates are unlikely to be `>=` "0001-…", so returns 0 OR error. Behavior depends on Sheets handling DATE(0,…). NEEDS LIVE TEST. |
| `IFS($B$4=2026, …live…, TRUE, …historical…)` (SHEET_YEAR_SELECTOR_WIRE) | Hits TRUE branch → historical lookup. CORRECT for now; INCORRECT once 2027 rolls in. |

Only the MDD pattern is robust to an empty selector. The sheet-writer template is the LEAST robust because it provisions a number-only cell with no validation, so an accidental Delete/Backspace silently zeroes all dashboards.

---

## Test results

`node tests/full_qa.js`:
```
OFFLINE QA: ALL 118 CHECKS PASSED
```

`for t in bot/test_*.js; do node "$t"; done`:
- 23 test files passed.
- 1 file failed: `bot/test_llm_profession_boost.js` — assertion on `KFL_BUILD_VERSION` expects `2026-05-28-…` prefix but current is `2026-05-29-…`. Stale assertion, not a formula regression.

Formula-related tests that PASSED:
- `bot/test_broken_formula.js` — 15/15 pass (both `_isBrokenBotDashFormula_` and `_isBrokenDashFormula_` agree on every case).
- `bot/test_no_hardcoded_year_in_dashboard_formula.js` — all assertions pass.
- `bot/test_marketing_formula.js` — 27/27 pass.
- `bot/test_dashboard_repair.js` — passes.
- `bot/VALIDATE_NO_HARDCODED_YEAR.js` — passes.

Syntax checks (node --check via .js copy):
- `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` — clean.
- `bot/personal_sheet_fix.gs` — clean.
- `bot/SHEET_DASHBOARD_SMART_REMAP.gs` — clean.
- `bot/SHEET_YEAR_SELECTOR_WIRE.gs` — clean.
- `lib/sheet-writer.js` — clean.

---

## Severity-tagged findings

| # | Severity | File | Finding | Impact |
|---|---|---|---|---|
| 1 | HIGH | `bot/ExpenseBot_FIXED.gs:15740-15981` (`installCompanyDashboardFormulas`, `installPersonalDashboardFormulas`) + DEPLOY twin | Bake year as STATIC string into SUMIFS criterion; year selector wired but ignored after install. | If `AUTO_FIX_DASHBOARDS=1` is set, year dropdown becomes cosmetic. Steven's NEW sheet uses `$B$4` — these installers target B2 reads. Mismatch. |
| 2 | HIGH | `bot/ExpenseBot_FIXED.gs:11189-11248` (`migrateDashboardToSUMIFS`) + DEPLOY twin | Manual one-shot for legacy `'מאזן שנתי'` writes frozen-year SUMIFS. Reachable from any developer that runs it manually. | Same shape bug. Targets a tab name (`'מאזן שנתי'`) that doesn't exist in the NEW template — but DOES exist in legacy sheets. |
| 3 | HIGH | `lib/sheet-writer.js:415-532` (`_buildCompanyDashboardTab`), `:246-396` (personal), `:552-680` (extended) | New tenants get a year NUMBER in B1/B2/B4 but NO `DataValidation` dropdown. Accidental clear → all dashboards silently return 0. | Every new user, day 1, is one Backspace away from a confusingly empty dashboard with no error message. |
| 4 | MEDIUM | `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` | `var _YS_CURRENT_YEAR_ = 2026;` hardcoded. When 2027 rolls in, sheets wired by this script will hit the TRUE/historical branch for the current year. | Year-rollover bug. ~7 months until trigger. |
| 5 | MEDIUM | `bot/SHEET_DASHBOARD_SMART_REMAP.gs:167-173` | SUMPRODUCT formulas use `$B$4&"-MM"` but have no `IF($B$4="",…)` empty-fallback. | Accidental clear of B4 → all four expense buckets silently zero. |
| 6 | MEDIUM | `bot/test_no_hardcoded_year_in_dashboard_formula.js` | Regex `SUSPECT_YEAR_RE` only fires on year literals on the SAME LINE as `setFormula`/`SUMIFS`. Misses installers where `monthKey` is built on line N and used on line N+1. | Test gap. Bugs #1 and #2 above are not caught by CI. |
| 7 | LOW | `bot/SHEET_DASHBOARD_FULL_AUDIT.gs:67-71` | Hardcoded `_FA_YEAR_BLOCKS_` row mapping for 2023-2026. | Read-only audit; only risk is silent miss when scanning years > 2026. Add row block when needed. |
| 8 | LOW | Three different year-selector cells (B1, B2, B4) across three dashboards | No single tool provisions all three with DataValidation; only `_MDD_ensureYearSelector_` and `_ys_ensureYearDropdown_` touch B4. B1 and B2 never get a dropdown installed. | Inconsistent UX; user discovers dropdown on biz dashboard, doesn't have one on personal/extended. |

---

## Safe fixes (additive, NOT applied)

Per Steven's rule: propose, do not apply. All of these are new tests or doc-only additions, plus one trivial constant change.

### (A) Tighten `test_no_hardcoded_year_in_dashboard_formula.js` to catch installer pattern (fixes finding #6)

Add a multi-line scan: when `setFormula(` appears, walk BACKWARDS up to 10 lines and check if `monthKey = ` was assigned from `year + '-'` or `<somevar> + '-'`. If found AND no `$B$4`/`$B$2`/`$B$1` reference appears in the same `setFormula` call, FAIL.

Pseudo-patch:
```js
const SUSPECT_FROZEN_YEAR_RE = /(?:monthKey|yearMonth|ym)\s*=\s*[a-zA-Z_$][\w$]*\s*\+\s*['"]-['"]/;
// ...
if (line.includes('setFormula')) {
  for (let k = Math.max(0, i-10); k <= i; k++) {
    if (SUSPECT_FROZEN_YEAR_RE.test(lines[k])) {
      // bug shape: variable year baked into formula
      problemFiles.push({ file: fname, line: i+1, snippet: trimmed, shape: 'frozen-year-var' });
      break;
    }
  }
}
```

### (B) Add `setDataValidation` to new-tenant template (fixes finding #3, finding #8)

In `lib/sheet-writer.js`, the `buildTenantSheetSpec` already returns the spec for `batchUpdate.create`. The Sheets API supports `dataValidation` inside `userEnteredFormat`/`dataValidation` per cell on creation. For each of B1 (extended), B2 (personal), B4 (company), add:

```js
dataValidation: {
  condition: {
    type: 'ONE_OF_LIST',
    values: [
      { userEnteredValue: '2023' },
      { userEnteredValue: '2024' },
      { userEnteredValue: '2025' },
      { userEnteredValue: '2026' },
      { userEnteredValue: '2027' },
      { userEnteredValue: '2028' },
    ],
  },
  inputMessage: 'בחר שנה',
  strict: true,
  showCustomUi: true,
},
```

Then add a unit test `tests/test_sheet_writer_year_selector_dropdown.js` asserting the spec includes a dataValidation on each of the three dashboard year cells.

### (C) Add an `IF(B?="",…)` fallback to every emit-formula helper

For each of `_personalCategoryRow` (B2), `_buildCompanyDashboardTab` expense formulas (B4), `_buildExtendedDashboardTab emitSubcatRow` (B1) — wrap the year reference in `IF($B$?="", TEXT(YEAR(TODAY()),"0000"), TEXT($B$?, "0000"))` exactly like `_MDD_buildFormulas_` already does.

Pattern change:
```js
// before
`…!B:B, $B$4&"-${mm}", …`

// after
`…!B:B, IF($B$4="", TEXT(YEAR(TODAY()),"0000"), TEXT($B$4,"0000"))&"-${mm}", …`
```

Add a sibling pattern to `SHEET_DASHBOARD_SMART_REMAP.gs` (finding #5).

### (D) Replace `_YS_CURRENT_YEAR_ = 2026` with a dynamic resolver (fixes finding #4)

In `bot/SHEET_YEAR_SELECTOR_WIRE.gs:71`, change to:

```js
function _ys_currentYear_() {
  return parseInt(Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy'), 10);
}
```

Then everywhere `_YS_CURRENT_YEAR_` is used, call `_ys_currentYear_()`. This is a small change but it's a real behavior change — Steven should confirm intent ("when the calendar rolls to Jan 1 2027, all 2026 rows should freeze and become historical, not live") before applying.

### (E) Add a regression test asserting installer functions reference the selector cell

Add `bot/test_installer_uses_year_selector.js` that extracts `installCompanyDashboardFormulas` and `installPersonalDashboardFormulas` source bodies and asserts each contains a `$B$4` or `$B$2` reference INSIDE the `setFormula` argument string — not just in a variable name. Fails today; passing once finding #1 is fixed.

### (F) (Optional) Mark or archive the legacy `migrateDashboardToSUMIFS` (fixes finding #2)

The function targets `'מאזן שנתי'` which doesn't exist in the new template. Either:
- Delete it from `ExpenseBot_FIXED.gs` and `ExpenseBot_DEPLOY.gs` (and run the deploy paste workflow), OR
- Add a one-line guard at the top: `if (!ss.getSheetByName('מאזן שנתי')) { Logger.log('legacy tab not found - migrateDashboardToSUMIFS is for the OLD layout. abort.'); return; }`

### Out of scope (this audit window) but flagged for follow-up
- Audit `ExpenseBot_DEPLOY.gs` to confirm it's a faithful mirror of `ExpenseBot_FIXED.gs` for the formula-installer functions (line numbers shift). The bot-deploy-paste skill workflow handles this — confirm the next deploy includes the fix.
- Live `kesefle-sheet-formula-year-selector-validator` sweep on Steven's actual sheet `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` — requires sheet access. Recommend cycling B4 through 2023→2024→2025→2026 and confirming numbers change per the skill spec.

---

## 5-bullet executive summary

1. **PR #151 fix is in place** in `MIGRATE_DASHBOARD_FROM_OLD.gs` (SUMPRODUCT+LEFT pattern with `IF($B$4="",…)` fallback). The exact arithmetic-coercion bug Steven described (`">="&$B$4&"-01"`) is NOT present anywhere else in the repo.
2. **TWO formula-installer functions in `ExpenseBot_FIXED.gs` (`installCompanyDashboardFormulas` and `installPersonalDashboardFormulas`) bake a STATIC year STRING into every SUMIFS at write time** — the year selector becomes cosmetic after they run. Gated by `AUTO_FIX_DASHBOARDS=1` Script Property, so opt-in, but if ever flipped on Steven's NEW sheet, dashboards stop responding to the B4 dropdown.
3. **New-tenant template (`lib/sheet-writer.js buildTenantSheetSpec`) does NOT provision a year-dropdown DataValidation** on any of the three dashboard year cells (B1 פירוט מורחב, B2 מאזן אישי, B4 מאזן חברה). Every new user starts with three plain numeric cells, one Backspace away from silently-zeroed dashboards.
4. **`bot/SHEET_YEAR_SELECTOR_WIRE.gs:71` has `_YS_CURRENT_YEAR_ = 2026` hardcoded** — when Jan 1 2027 rolls in, every sheet wired by this script will treat 2026 as historical and current-year reads will hit the wrong branch. ~7 months to the rollover.
5. **The existing `test_no_hardcoded_year_in_dashboard_formula.js` is too narrow** — it only flags single-line literal-year matches. It misses the multi-line frozen-year-variable pattern in the installers above. Add a backward-walk scan over `setFormula` callers to close the gap.

All `node tests/full_qa.js` (118 checks), `node bot/VALIDATE_NO_HARDCODED_YEAR.js`, and `node bot/test_no_hardcoded_year_in_dashboard_formula.js` PASS. The 1 failing bot test (`test_llm_profession_boost.js`) is a stale `KFL_BUILD_VERSION` prefix assertion, unrelated to formulas.
