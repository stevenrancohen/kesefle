---
name: gdpr-data-delete
description: Handle a user's data deletion request — purge all KV records, optionally hand back / archive their Sheet, revoke OAuth tokens, log the action.
---

# GDPR data delete

The user wants to be erased. Do it fully and prove it. Failing here is a regulatory and trust problem.

## Steps
1. Authenticate the requester (same gate as `gdpr-data-export` skill). Confirm via reply: "This will permanently delete X, Y, Z. Reply CONFIRM to proceed."
2. Resolve `sub` from email. Locate every keyed record (inventory listed in `gdpr-data-export`).
3. **Sheet decision** — ask the user:
   - **Hand back**: transfer ownership to their personal Google account (they keep it). Default for paying users.
   - **Delete**: move to trash on our service-account-owned copy (we never owned it if OAuth flow gave them ownership — then we just unshare).
   - Document the choice in the audit log.
4. Revoke OAuth: hit Google's revoke endpoint with the user's refresh token before deleting the KV record. Otherwise the token lingers in Google's grants page.
5. Purge KV: delete every per-user key. Use `kvDel` not `kvSet({deleted:true})` — the user wants the data gone, not soft-deleted.
6. Audit log: `audit:gdpr:{sub}:{ts}` `{ kind: 'delete', actor, deletedKeys: [...], sheetAction: 'returned' | 'trashed', ts }`. Keep the audit log forever — it's the record that you complied.
7. Reply to the user confirming completion + linking the audit ID.

## Verification
- `kvGet('user:' + sub)` → null. Same for every key in the inventory.
- Token revoked: hit Google's tokeninfo endpoint with the old token → returns error.
- Sheet either no longer in our Drive or transferred per user's choice.
- Audit log entry exists.

## Common pitfalls
- Soft-delete only → user comes back angry; regulator agrees.
- Forgetting to revoke OAuth → token still grants Sheets access until expiry; you can still read their data, which violates the delete.
- Deleting before user confirmation → no way to undo.
- Skipping the audit log → can't prove compliance.
- Not deleting `phone:{digits}` → orphan record points to a non-existent `sub`, causes errors elsewhere.
