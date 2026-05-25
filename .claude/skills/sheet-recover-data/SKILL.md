---
name: sheet-recover-data
description: Recovery procedure when a customer reports "my data is gone" — Google Sheets version history first, then KV backups, then manual reconstruction.
---

# "My data is gone" — recovery

99% of the time the data is not gone — it's a hidden row, a wrong tab, a deleted formula, a date filter, or the user looking at a different sheet. Run this checklist before any destructive action.

## Steps
1. Get the user's phone or email. Resolve to `user:{sub}` via KV.
2. Open their `sheet_id` directly (admin tool: `/admin` → user lookup). Verify it's the same sheet they see.
3. Check Google Sheets **File → Version history → See version history**. Most accidental deletes are 1 click away. If found: restore.
4. If version history doesn't go back far enough, check KV daily backup: `kv-backup:{date}` (written by `/api/cron/kv-backup` daily at 03:00 UTC). Look for the user's record snapshot.
5. Check the תנועות tab for the affected date range. Common cause: a filter view is hiding rows. Clear all filters.
6. If rows truly are gone: run `RECOMPUTE_COMPANY_DASHBOARD` (see `sheet-recompute-dashboard`) — only the dashboard cells are restorable from the row data; the row data itself must come from history.
7. If irrecoverable: notify the user honestly, offer credit/refund per `lib/billing.js`, log the incident.

## Verification
- User confirms they see their data again.
- Open `tests/full_qa.js` — does it still pass after any code changes you made during recovery?

## Common pitfalls
- Restoring an old version of the WRONG sheet — confirm the sheet_id matches the user.
- Editing rows live during a session with the user — write changes ONLY after the user signs off.
- Not capturing what caused the loss → it will happen again. Add an audit log entry (see `audit-log-add` skill).
