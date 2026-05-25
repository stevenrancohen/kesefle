---
name: backfill-pattern
description: Write a safe one-shot backfill script under scripts/ to fix historical KV or Sheets data in bulk — idempotent, dry-run first, progress-logged.
---

# Backfill pattern

Backfills touch every record. Every one is a potential data-loss event if done wrong. Follow the strict ritual.

## Steps
1. Place script in `scripts/backfill-<name>.mjs` (ESM for top-level await against Upstash REST).
2. Boilerplate:
   ```js
   const DRY = process.env.DRY !== '0';  // default: dry-run
   const LIMIT = Number(process.env.LIMIT || 0);
   let scanned = 0, changed = 0, skipped = 0;
   // ... iterate (Upstash SCAN or a known key prefix) ...
   for (const key of keys) {
     scanned++;
     const rec = await kvGet(key);
     if (!needsBackfill(rec)) { skipped++; continue; }
     const next = transform(rec);
     if (DRY) console.log('would update', key, summary(rec), '->', summary(next));
     else { await kvSet(key, next); console.log('updated', key); }
     changed++;
     if (LIMIT && changed >= LIMIT) break;
   }
   console.log({ scanned, changed, skipped, DRY });
   ```
3. **Idempotent**: `needsBackfill(rec)` must return false on already-migrated records. Re-running must be a no-op.
4. **Dry-run first** (`DRY=1`, default). Eyeball the proposed changes. Sanity-check a few records by hand.
5. **Pilot with LIMIT** (`LIMIT=10 DRY=0`). Verify those 10 records look right in production.
6. **Full run** (`DRY=0`). Capture the summary.
7. **Rerun in DRY**. Should report `changed: 0`.

## Verification
- `changed > 0` only on the real run. Re-runs report 0.
- Sample 10 random migrated records; structure matches expected.
- Affected user flows still work end-to-end.

## Common pitfalls
- No `needsBackfill` guard → on rerun you mutate already-migrated records, sometimes corrupting them.
- Looping `SCAN` without cursor handling → only first page processed, silent partial backfill.
- Logging full records → PII in CI/log storage. Log keys + summaries only.
- Running without saving a KV snapshot first → no rollback if anything goes wrong. Trigger `/api/cron/kv-backup` manually first.
