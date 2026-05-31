---
name: bot-pending-state-cleanup
description: Wipe stale KV pending:* and recurring_pending:* keys older than 15 min via Upstash REST so dropped or aborted conversations don't trap users in a half-state.
---

# Pending state cleanup

The bot stashes mid-conversation context under KV keys like `pending:{phone}`, `recurring_pending:{phone}`, `nps_pending:{phone}` and similar. Each has a TTL set at write time, but TTL can fail in rare Upstash cases, or a stale state can wedge a user (`bot/ExpenseBot_FIXED.gs:2314, 7342, 7809`). This skill scans + clears anything older than 15 min that didn't auto-expire.

## Required env
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

## Steps

1. Confirm env vars are set:
   ```
   test -n "$KV_REST_API_URL" && test -n "$KV_REST_API_TOKEN" && echo OK
   ```
2. Scan for pending keys (Upstash supports SCAN via REST):
   ```
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/scan/0/MATCH/pending:*/COUNT/1000" | jq .
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/scan/0/MATCH/recurring_pending:*/COUNT/1000" | jq .
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/scan/0/MATCH/nps_pending:*/COUNT/1000" | jq .
   ```
3. For each key, fetch the TTL. Negative TTL = no expiry set (stale candidate):
   ```
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/ttl/$KEY" | jq .
   ```
4. If TTL < 0 OR (TTL > 0 but value's `ts` field shows >15 min old), DRY_RUN log it. Build a delete list.
5. APPLY: delete the keys:
   ```
   for K in $KEYS; do
     curl -s -X POST -H "Authorization: Bearer $KV_REST_API_TOKEN" \
       "$KV_REST_API_URL/del/$K"
   done
   ```
6. Persist an audit log row via `lib/audit.js` pattern (see `audit-log-add`):
   ```
   curl -s -X POST -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/lpush/audit:pending_cleanup" \
     -d "{\"ts\":\"$(date -u +%FT%TZ)\",\"deleted\":$N}"
   ```

## Verification
- After cleanup, re-scan: zero matches older than 15 min.
- Spot-check: pick one user whose pending was wiped, ask Steven to confirm they're no longer in a stuck flow.
- `node bot/test_pending_state_hijack.js` still passes (this skill must not change behavior for actively-pending users).

## Common pitfalls
- Wiping a fresh key while the user is mid-flow — re-check `ts` before delete.
- Hitting the wrong KV (staging vs prod) — confirm `$KV_REST_API_URL` matches Vercel prod env.
- Deleting `family:pending:*` keys (those have their own 10-min TTL and a join-flow contract — leave them; see `bot/ExpenseBot_FIXED.gs:14401`).

## Examples
- "User says nothing happens when they send expenses" → run, find their stale pending, clear it.
- "Weekly housekeeping" → run, target only keys > 1 hour old.
