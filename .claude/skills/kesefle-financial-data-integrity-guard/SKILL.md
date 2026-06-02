---
name: kesefle-financial-data-integrity-guard
description: Hard gate before ANY operation that writes, modifies, or migrates financial data in a Kesefle sheet (תנועות, הזמנות, מאזן אישי, מאזן חברה, year tabs). Enforces backup-first → dry-run → approval → apply → validate pipeline. Returns a risk level + a Pass/Fail. Use before any Apps Script function that calls setValue/setFormula/clearContents/deleteRow, any migration step, any formula repair, any category reconciliation, and any sheet ID switch.
---

# Kesefle Financial Data Integrity Guard

Steven trusts Kesefle with real money. A wrong row, a missing transaction, or a silently-overwritten cell is not "a bug" — it's a trust breach. This skill is the discipline layer that makes sure every financial-data write is intentional, reversible, and proven correct.

## When to invoke

Any of:
- About to write to `תנועות`, `הזמנות`, `מאזן אישי`, `מאזן חברה`, `מאזן חברה 2026`, or any year tab.
- About to run an Apps Script function whose name contains `APPLY_`, `FIX_`, `MIGRATE_`, `REPAIR_`, `RECOMPUTE_`, `CLEAN_`, `RESET_`, or any verb that suggests mutation.
- About to call `setValues`, `setFormula`, `clearContents`, `deleteRow`, `deleteRows`, `clear`, `insertRowsAfter`, or `appendRow` on a financial tab.
- About to change a SUMIFS / SUMPRODUCT / IF / VLOOKUP formula on any dashboard.
- About to switch `SHEET_ID`, `PERSONAL_TEMPLATE_SHEET_ID`, or any Apps Script `SCRIPT_PROPERTIES` value related to sheet identity.
- About to merge a PR that touches `lib/sheet-writer.js`, `api/append.js`, `api/recurring.js`, or any `.gs` file with `dashboard` / `formula` / `migration` in the name.

## The 7 gates (in order)

Run them sequentially. If any gate fails, STOP and surface the failure. Do not proceed to the next gate until the previous one passes.

### Gate 1 — Classify the operation
What kind of write is this?
- **Append** (new row in `תנועות` from a bot expense) — lowest risk
- **Update** (formula change on dashboard, value change on `User_Category_Profile`) — medium
- **Migrate** (move data from OLD to NEW, or backfill historical year) — high
- **Delete / clear** — critical
- **Schema change** (new column, new tab, renamed tab) — critical

Output: `OPERATION_TYPE: <append|update|migrate|delete|schema>`

### Gate 2 — Identify the data at risk
List every cell range / row range that could be touched. Be specific. `"all of מאזן חברה"` is not specific enough.

```
DATA_AT_RISK:
  - מאזן חברה!A1:Z100  — full dashboard (read-only? formulas only?)
  - תנועות!A615:I650   — last 36 rows (will be appended)
  - DocumentProperties.backup_<timestamp> — will be created
```

### Gate 3 — Backup
Required for everything except pure appends to `תנועות`. For everything else:

```javascript
// Backup snapshot before mutating
var ss = SpreadsheetApp.openById(SHEET_ID);
var props = PropertiesService.getDocumentProperties();
var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
var key = 'backup_' + TASK_NAME + '_' + stamp;
var ranges = [
  // exact A1 notations of every cell you might write to
  'מאזן חברה!A1:Z100',
  'מאזן אישי!A1:Z100'
];
var snapshot = {};
ranges.forEach(function(r) {
  snapshot[r] = ss.getRange(r).getValues();
});
props.setProperty(key, JSON.stringify(snapshot));
Logger.log('BACKUP saved as ' + key);
```

Without this line in the Apps Script: **block the operation**.

### Gate 4 — DRY_RUN
Run the change in proposal mode. Write nothing. Log:
- Every cell that would change (from / to).
- Every formula that would be replaced.
- Every row that would be added / deleted.
- Expected effect on dashboard totals (per category, per year).

Steven (or the calling agent) reads the DRY_RUN output. Without an explicit approval signal (`YES I UNDERSTAND` in the next gate or a Steven message that contains `אשר` / `אפליי` / `apply` / `go`), do not proceed.

### Gate 5 — Approval gate
Apps Script functions that mutate must read a Script Property gate:

```javascript
var gate = PropertiesService.getScriptProperties().getProperty('CONFIRM_' + TASK_NAME);
if (gate !== 'YES I UNDERSTAND') {
  throw new Error('Refusing to apply ' + TASK_NAME + ' — set Script Property CONFIRM_' + TASK_NAME + ' = YES I UNDERSTAND first.');
}
```

For Vercel / Node-side migrations, the equivalent is a CLI flag (`--apply --confirm "YES I UNDERSTAND"`) or an env var.

### Gate 6 — Apply
Only now write. Use `safeSetValue` / `safeSetFormula` (preserves user-typed cells). Log every write with cell address + before/after values.

```javascript
function safeSetFormula(range, formula) {
  var current = range.getValue();
  if (typeof current === 'string' && current.length > 0 && current.charAt(0) !== '=') {
    Logger.log('SKIP ' + range.getA1Notation() + ' — has user-typed value: ' + current);
    return false;
  }
  range.setFormula(formula);
  return true;
}
```

### Gate 7 — Validate
After apply, verify:
- Row counts: `expected` vs `actual` per tab.
- Category totals: `expected` vs `actual` per category, per year.
- Formula health: no `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?` in any dashboard cell.
- Year selector: changing `$B$4` from 2023 → 2024 → 2025 → 2026 still produces non-zero, plausible totals.
- The original "why this change" is satisfied (the bug it fixed is no longer present).

Output:

```
VALIDATE_<TASK_NAME>:
  Row counts:         <expected vs actual table>
  Category totals:    <per-category per-year table>
  Formula errors:     <count by type, target = 0>
  Year selector test: <4 rows, one per year>
  Original bug:       <FIXED | STILL_PRESENT>

Final: PASS | FAIL
```

## Rollback (required as part of every plan)

Every operation must declare its rollback up front:

```
ROLLBACK_PLAN:
  - Source of truth: DocumentProperty backup_<TASK_NAME>_<stamp>
  - Restore function: ROLLBACK_<TASK_NAME>()  (paste-once Apps Script)
  - Steven action: run ROLLBACK_<TASK_NAME>() and confirm row counts match pre-apply
```

## Anti-patterns this skill forbids

- `range.clearContents()` without a backup
- `sheet.deleteRow(n)` ever — append-only on `תנועות` / `הזמנות`
- `sheet.setValues(...)` over a range that contains user-typed cells (rows 12 marketing & 14 operations are Steven's per memory)
- Replacing a formula with a static value
- Hardcoding `2026` in any SUMIFS criterion (must use `$B$4`)
- Apply functions that don't read the `CONFIRM_<TASK>` gate
- Mutating the OLD sheet (`1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`) — read-only forever
- Silent rollback (if you have to roll back, log it explicitly)

## Output format when this skill is the gate

If the calling code violates any gate, this skill returns:

```
[FINANCIAL_DATA_INTEGRITY_GUARD]
Gate failed: <gate number + name>
Specific violation: <what was missing>
Required to proceed: <exact action>
Status: BLOCKED
```

If all gates pass:

```
[FINANCIAL_DATA_INTEGRITY_GUARD]
Operation: <type>
Data at risk: <ranges>
Backup: <key>
DRY_RUN: <OK / output ref>
Approval: <gate value>
Apply: <writes logged>
Validate: <PASS>
Rollback plan: <function ref>
Status: CLEARED
```

## How to use programmatically

In an Apps Script file:

```javascript
// At the top of any mutating function
function APPLY_RECONCILE_CATEGORIES() {
  _kfl_data_guard_({
    operation: 'migrate',
    rangesAtRisk: ['קטגוריות!A:Z', 'User_Category_Profile!A:Z', 'מאזן חברה!A1:Z200'],
    taskName: 'RECONCILE_CATEGORIES',
    requiresApproval: true
  });
  // ... only proceeds if guard returns CLEARED ...
}
```

In a Node-side migration script:

```javascript
const { dataIntegrityGuard } = require('./lib/integrity-guard');
await dataIntegrityGuard({
  operation: 'migrate',
  source: OLD_SHEET_ID,
  target: NEW_SHEET_ID,
  taskName: 'MIGRATE_2024_HISTORICAL',
  approvalFlag: process.env.APPLY_CONFIRM
});
```

If the guard helper doesn't exist yet, this skill's invocation should propose adding it before any further mutation work.
