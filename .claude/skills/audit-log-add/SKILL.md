---
name: audit-log-add
description: Add an audit log entry for a new admin-visible event (config change, manual recovery, GDPR action, kill-switch flip) so the admin dashboard and forensic trail stay complete.
---

# Add an audit log event

Audit events live in KV under `audit:{kind}:{sub-or-system}:{ts}` and are surfaced via `/api/admin/*` views. Add one for any action a human took that mutated user data, config, or production state. They're how you reconstruct "who did what when" when something breaks weeks later.

## When to add an entry
- Manual sheet recovery (see `sheet-recover-data`).
- GDPR export / delete (see those skills).
- Bot kill-switch flip (see `bot-kill-switch`).
- Manual KV record edit via admin UI.
- Schema migration / backfill execution.
- Privileged config change (admin email list, rate-limit override, deploy version bump).

## Steps
1. Pick a stable `kind` (snake_case, ASCII). Reuse existing kinds (`recovery`, `gdpr`, `killswitch`, `backfill`, `config_change`). Add new kinds sparingly.
2. Construct the key: `audit:{kind}:{sub-or-system}:{epoch-ms}`. Use `system` when no specific user is involved (e.g. kill-switch).
3. Construct the payload:
   ```json
   {
     "kind": "recovery",
     "actor": "srcslcollection@gmail.com",
     "subject": "{sub}",
     "summary": "Restored 12 rows from Sheets version history",
     "details": { "rows": 12, "date": "2026-05-26" },
     "ts": 1748275200000
   }
   ```
4. Write via KV directly OR via a small `lib/audit.js` helper if you find yourself adding more than once.
5. Surface in admin: `/api/admin/*` view for that kind should list recent entries; `admin.html` table should render them.

## Verification
- `kvGet(<the-key>)` returns the payload after the action.
- Admin UI shows the entry within one refresh cycle.
- Re-running the same action (idempotent ops) writes a NEW entry — every action is a separate record.

## Common pitfalls
- Logging PII in `details` (e.g. raw expense rows, refresh tokens) → audit log becomes a PII hotspot. Summarize, don't dump.
- No `actor` → useless audit. Always identify who triggered the action.
- Mutating an existing audit entry instead of appending a new one → destroys the audit trail.
- Forgetting to wire the admin view → entries exist but nobody sees them; you only find them when grepping KV after the incident.
