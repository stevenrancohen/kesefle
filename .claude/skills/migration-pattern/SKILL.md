---
name: migration-pattern
description: Safely change a KV record schema (e.g. add a profile field, rename a key, restructure user/phone records) without breaking existing users or the bot.
---

# KV schema migration

Kesefle's user data lives in Upstash KV: `user:{sub}`, `phone:{digits}`, `sheet:{sub}`, plus various app-specific keys. Schema changes are tricky because there's no DB migration tool — every record is JSON, and old code reads new records (and vice versa) during the rollout window.

## Pattern: additive first
1. **PR 1 — write the new field, fall back on read**:
   - Write path adds the new field on every new/updated record.
   - Read path: `const v = rec.newField ?? deriveFromOldField(rec)`. Old records keep working.
2. **PR 2 — backfill** (see `backfill-pattern` skill): one-shot script reads every record, computes `newField`, writes it back. Idempotent.
3. **PR 3 — remove the fallback**: once backfill is complete and verified, simplify read path to only use `newField`. Old records that slipped through (rare) self-heal on next write.

## Steps
1. Inventory which code paths read the key. Grep: `grep -rn "user:" api/ lib/ bot/ scripts/ tests/`.
2. Write a one-line `// schema-version` comment near the record's primary creator so the new shape is searchable.
3. Implement PR 1. Test with both old-shape and new-shape records in `tests/`.
4. Run backfill in dry-run on the prod KV. Inspect the diff.
5. Run backfill for real. Capture before/after counts.
6. PR 3 cleanup after at least a week of green.

## Verification
- `node tests/full_qa.js` passes with both old and new record shapes mocked.
- Backfill script's dry-run shows the expected number of records and the expected transform.
- Read path returns the same answer pre- and post-migration on a sample record.

## Common pitfalls
- Renaming a key directly without the additive pattern → mid-deploy, half the app reads the old key, half writes the new → split-brain.
- Backfill that isn't idempotent → re-running it after a crash corrupts data.
- Skipping the schema-version comment → future-you can't tell which records are migrated.
- Removing the fallback in the same PR that adds the new field → guaranteed broken users.
