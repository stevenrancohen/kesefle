---
name: kesefle-migration-dry-run-validator
description: Verify any MIGRATE_*.gs script has DRY_RUN + APPLY + UNDO + YES I UNDERSTAND gate + LockService + DocumentProperties backup before allowing it to ship.
---

# kesefle-migration-dry-run-validator

When invoked: validate a migration script meets Kesefle's hard discipline.

## Required structure (every MIGRATE_*.gs)
```
function DRY_RUN_<NAME>() { return _impl_(false); }
function APPLY_<NAME>(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') return 'gate failed';
  return _impl_(true);
}
function UNDO_<NAME>() {
  // restore from DocumentProperties
}
function _impl_(write) {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('locked');
  try {
    if (write) {
      // backup BEFORE write
      var dp = PropertiesService.getDocumentProperties();
      dp.setProperty('<scriptname>_backup_<ts>', JSON.stringify(current));
    }
    // logic — same code path for dry-run + apply, gated by `write`
    if (write) SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}
```

## Validation checks
1. DRY_RUN exists and calls `_impl_(false)`
2. APPLY exists and accepts `confirmation` arg
3. APPLY rejects if confirmation ≠ `'YES I UNDERSTAND'`
4. APPLY acquires `LockService.getDocumentLock()` with timeout
5. APPLY writes backup to `DocumentProperties` BEFORE any write
6. UNDO exists and restores from the same `DocumentProperties` key
7. Dry-run and apply share the SAME code path (single `_impl_(write)` function, no copy-paste)
8. Hebrew strings use `\u05XX` escapes (no raw Hebrew bytes)
9. `node --check bot/MIGRATE_<NAME>.gs` passes
10. No reference to OLD sheet ID for write operations

## Pass criteria
- All 10 checks pass

## Outputs
- Console output with per-check PASS/FAIL
- Exit 0/1
- Optional `validation-{script}-{YYYY-MM-DD}.md` report

## Hard NO
- Don't run the migration during validation
- Don't apply YOLO migrations (those that bypass the structure)
- Don't allow a script to ship if any check fails
