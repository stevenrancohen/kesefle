---
name: kesefle-sheet-formula-year-selector-validator
description: End-to-end validator for the Kesefle year-selector architecture (`$B$4` on every dashboard tab). Confirms every SUMIFS / SUMPRODUCT / criterion-driven formula references `$B$4` and never hardcodes `2026`. Tests the selector by sweeping 2023 → 2024 → 2025 → 2026 and asserting per-category totals match `תנועות` row-level sums. Use after any formula edit, after migration apply, before any dashboard ships to a user, and as part of the nightly self-heal cron.
---

# Kesefle Year-Selector Formula Validator

The dashboard's year selector is `$B$4`. Every SUMIFS month criterion is `$B$4&"-MM"`. A single formula that hardcodes `2026` silently breaks the year switch and produces wrong totals when Steven (or a user) changes the dropdown. This skill catches every such drift.

## Scope of validation

For each of these tabs:
- `מאזן אישי` (personal dashboard)
- `מאזן חברה` (multi-year business dashboard)
- `מאזן חברה 2026` (single-year snapshot — should reference fixed 2026, that's its job)
- Any year-specific tab the user created

The validator checks:
1. `$B$4` exists and contains a 4-digit year (2023, 2024, 2025, 2026, ...).
2. Every dashboard formula that uses a month criterion references `$B$4` — not a literal `"2026-..."`.
3. Every formula returns a number (no `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`).
4. Sweep: setting `$B$4 = 2023`, `2024`, `2025`, `2026` produces totals that match the row-level `תנועות` sums for that year.
5. No formula references a tab that no longer exists.
6. Section headers (`אוכל`, `תחבורה`, ...) match the master `קטגוריות` group/section names.

## When to invoke

- After any edit to a SUMIFS / SUMPRODUCT / criterion formula on a dashboard.
- After any migration apply that touches dashboard structure.
- After any `RECOMPUTE_*` Apps Script function runs.
- Before merging a PR that changes `bot/personal_sheet_fix.gs`, `bot/ExpenseBot_FIXED.gs` dashboard helpers, `lib/sheet-writer.js` `buildTenantSheetSpec`, or any `.gs` file with "dashboard" or "formula" in the name.
- Nightly via the self-heal cron (`bot/SELF_HEAL_DASHBOARD.gs` if it exists).
- Whenever Steven says "the dashboard shows zero" or "the year switch doesn't work" or "expenses are missing".

## Validation phases

### Phase 1 — Static formula audit (paste-once Apps Script)

```javascript
function VALIDATE_YEAR_SELECTOR_DRY_RUN() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var dashboards = ['מאזן אישי', 'מאזן חברה'];
  var findings = [];
  
  dashboards.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    
    // Check $B$4
    var b4 = sh.getRange('B4');
    var b4val = b4.getValue();
    var b4formula = b4.getFormula();
    findings.push({
      tab: name, cell: 'B4',
      kind: 'selector',
      value: b4val,
      formula: b4formula,
      ok: typeof b4val === 'number' && b4val >= 2023 && b4val <= 2099
    });
    
    // Scan every formula in the tab
    var formulas = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getFormulas();
    for (var r = 0; r < formulas.length; r++) {
      for (var c = 0; c < formulas[r].length; c++) {
        var f = formulas[r][c];
        if (!f) continue;
        
        var hardcodedYear = /["']20\d{2}-/.test(f) || /["']20\d{2}["']/.test(f);
        var usesB4 = /\$B\$4|B\$4|\$B4|B4/.test(f);
        var usesSumifsOrLike = /SUMIFS|SUMPRODUCT|COUNTIFS|AVERAGEIFS/i.test(f);
        var hasMonthCriterion = /"-(\d{2})"|&"-/.test(f);
        
        if (usesSumifsOrLike && hasMonthCriterion && !usesB4) {
          findings.push({
            tab: name, cell: sh.getRange(r + 1, c + 1).getA1Notation(),
            kind: 'formula',
            formula: f,
            ok: false,
            reason: 'SUMIFS/criterion without $B$4 reference'
          });
        } else if (hardcodedYear && usesSumifsOrLike) {
          findings.push({
            tab: name, cell: sh.getRange(r + 1, c + 1).getA1Notation(),
            kind: 'formula',
            formula: f,
            ok: false,
            reason: 'hardcoded year in criterion'
          });
        }
        
        // Check formula errors
        var v = sh.getRange(r + 1, c + 1).getValue();
        if (typeof v === 'string' && /^#(REF|DIV\/0|VALUE|NAME|N\/A)/.test(v)) {
          findings.push({
            tab: name, cell: sh.getRange(r + 1, c + 1).getA1Notation(),
            kind: 'error',
            formula: f,
            value: v,
            ok: false,
            reason: 'formula returns error'
          });
        }
      }
    }
  });
  
  Logger.log(JSON.stringify(findings, null, 2));
  return findings;
}
```

Output a structured findings table. Anything with `ok: false` is a blocker.

### Phase 2 — Year sweep test

For each year in `[2023, 2024, 2025, 2026]`:
1. Set `$B$4` to the year.
2. `SpreadsheetApp.flush()`.
3. Read every category-total cell on `מאזן חברה` and `מאזן אישי`.
4. Compute the equivalent sum from `תנועות` (read row-level, filter by year).
5. Assert: dashboard total === תנועות sum (within ₪1 rounding).

Restore `$B$4` to the original value when done.

```javascript
function VALIDATE_YEAR_SELECTOR_SWEEP() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var dash = ss.getSheetByName('מאזן חברה');
  var origYear = dash.getRange('B4').getValue();
  var txTab = ss.getSheetByName('תנועות');
  var txVals = txTab.getDataRange().getValues();
  
  var results = [];
  [2023, 2024, 2025, 2026].forEach(function(year) {
    dash.getRange('B4').setValue(year);
    SpreadsheetApp.flush();
    
    // For each known category section, read the year total cell
    var categoriesToCheck = [
      { row: 42, label: 'דלק' },
      { row: 48, label: 'ביטוח רכב' },
      // ... etc, populated from קטגוריות master
    ];
    
    categoriesToCheck.forEach(function(c) {
      var dashTotal = dash.getRange(c.row, 2).getValue() || 0;  // col B = יתרה שנתית
      
      // Compute from תנועות: sum col C where col E = label AND col B starts with "<year>-"
      var txSum = 0;
      for (var i = 1; i < txVals.length; i++) {
        var row = txVals[i];
        var monthKey = String(row[1] || '');
        var subCat = String(row[4] || '').trim();
        var amount = Number(row[2]) || 0;
        if (subCat === c.label && monthKey.indexOf(year + '-') === 0) {
          txSum += amount;
        }
      }
      
      var diff = Math.abs(dashTotal - txSum);
      results.push({
        year: year,
        category: c.label,
        dashboard_total: dashTotal,
        tnu_sum: txSum,
        diff: diff,
        ok: diff < 1
      });
    });
  });
  
  // Restore
  dash.getRange('B4').setValue(origYear);
  SpreadsheetApp.flush();
  
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
```

### Phase 3 — Cross-reference to `קטגוריות` master

Every dashboard row label (col A) must exist as a category in the `קטגוריות` master (with `active_for_steven=TRUE` for Steven's sheet). Any orphan row → flagged as `needs_review`. Any active category with no dashboard row → flagged as `missing_dashboard_row`.

## Output format

```
[YEAR_SELECTOR_VALIDATOR]
Sheet ID:       <id>
Tabs scanned:   <list>

Phase 1 — static audit:
  Cells with $B$4 in selector: <count>
  Cells with valid year value:  <count>
  Formulas using SUMIFS+month:  <count>
  Formulas missing $B$4:        <count>  (BLOCKERS)
  Formulas with hardcoded year: <count>  (BLOCKERS)
  Formula errors:                <count by type, target = 0>

Phase 2 — year sweep:
  Year | Categories checked | All match? | Discrepancies
  2023 | 28                  | YES         | 0
  2024 | 28                  | NO          | 2  (אבא: dash=₪1200, tx=₪1450, diff=₪250 ; דלק: ...)
  ...

Phase 3 — קטגוריות cross-ref:
  Orphan dashboard rows:        <list>
  Missing dashboard rows:       <list>

Final status: PASS | FAIL | NEEDS_REVIEW
Next action: <specific fix, or "ready to ship">
```

## Common findings + fixes

| Finding | Fix |
|---------|-----|
| `="2026-01"` in criterion | Replace with `=$B$4&"-01"` |
| `SUMIFS(...)` with no `$B$4` and no month criterion | Probably a year-total — add `$B$4` filter on col B |
| Dashboard cell shows `0` for a category Steven uses | Check if `מאזן חברה` row label exactly matches `תנועות` col E values. If not, fix the row label, not the formula. |
| `#REF!` | A tab was renamed or deleted. Restore from backup or repoint the formula. |
| Year sweep mismatch for 2024 | Either OLD migration didn't bring 2024 data, OR bot wrote 2024 rows with a different category label than the dashboard expects. Use `kesefle-adaptive-category-profile-builder` to reconcile. |

## Hand-off

- PASS → ready to ship; pass to `kesefle-qa-security-data-integrity-officer` for final sign-off.
- FAIL → block the change; surface findings to `kesefle-migration-and-sheet-formula-agent` for the specific fix.
- NEEDS_REVIEW → surface to Steven with a 1-sentence question per discrepancy.

## Relationship to existing skills

- Complements `kesefle-formula-validator` (which is general) by being year-selector-specific.
- Complements `sheet-year-selector-add` (which CREATES the selector) by VALIDATING it once in place.
- Feeds findings to `kesefle-dashboard-financial-audit` for the cross-check against `תנועות`.
