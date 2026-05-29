---
name: kesefle-apps-script-safety-audit
description: Scan every bot/*.gs file for destructive functions (clear, delete, setValues against user data, overwrite formulas, reset, rebuild) — risk-rate, propose guardrails.
---

# kesefle-apps-script-safety-audit

When invoked: produce the destructive-function catalog.

## Scope
All `bot/*.gs` files plus any one-off scripts in the importjason Apps Script project.

## Flag operations
```
.clear() .clearContent() .clearFormat() .clearDataValidations()
.deleteRows() .deleteColumns() .deleteSheet() .deleteCell() .removeRange()
.insertSheet() .copyTo() (overwrite)
.setValues() against user-data ranges
.setFormulas() against existing formulas
Any function matching: reset|rebuild|repair|restore|fix dashboard|SIMPLE_FIX_DASHBOARD|RECOVER_DASHBOARD_V2|APPLY_RESTORE_2026|APPLY_DASHBOARD_REPAIR_NOW|APPLY_MIGRATE
Any function with a time-driven or onEdit trigger
Any function touching מאזן חברה / מאזן אישי / תנועות / הזמנות
```

## Per-function fields
- Name
- File:line
- Operation
- Range/Tabs affected
- Can delete data? (Y/N)
- Can overwrite formulas? (Y/N)
- Manual / Triggered
- Has `YES I UNDERSTAND` arg gate? (Y/N)
- Has `DocumentProperties` backup before write? (Y/N)
- Has `LockService.getDocumentLock()` ? (Y/N)
- Has corresponding UNDO_* function? (Y/N)
- Respects `KFL_DISABLE_BOT_WRITES` kill switch? (Y/N)
- **Risk** (Critical / High / Medium / Low)
- **Recommendation**

## Inventory summary at top
- Total functions audited
- Critical: N
- High: N
- Medium: N
- Low: N
- Functions with proper guardrails: N
- Functions MISSING guardrails: N

## Outputs
- `docs/APPS_SCRIPT_DESTRUCTIVE_FUNCTION_AUDIT.md` (or `-YYYY-MM-DD.md` for follow-up runs)

## Hard NO
- Don't run any function during the audit
- Don't modify any of the functions
- Mask sheet IDs (use `<NEW_SHEET_ID>` / `<OLD_SHEET_ID>`)
