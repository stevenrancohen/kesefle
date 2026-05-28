---
name: kv-orphan-sweep
description: List Upstash KV keys older than 90 days with no recent reads — candidates for deletion to keep KV size and cost in check. DRY_RUN only.
---

# KV orphan sweep (low-priority housekeeping)

Upstash KV charges by storage size + ops. Over time, expired-but-not-deleted records, leftover migration scratch keys, and dead `user:{sub}` records (users who signed up and never wrote a row) accumulate. This skill lists candidates older than 90 days; it never deletes — Steven decides which.

## Required env
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

## Steps

1. Confirm env:
   ```
   test -n "$KV_REST_API_URL" && test -n "$KV_REST_API_TOKEN" && echo OK
   ```
2. Scan each key prefix you care about. Upstash SCAN paginates with a cursor:
   ```
   CURSOR=0
   while : ; do
     RESP=$(curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
       "$KV_REST_API_URL/scan/$CURSOR/MATCH/user:*/COUNT/500")
     echo "$RESP" | jq -r '.result[1][]?'
     CURSOR=$(echo "$RESP" | jq -r '.result[0]')
     [ "$CURSOR" = "0" ] && break
   done > /tmp/kv-user-keys.txt
   wc -l /tmp/kv-user-keys.txt
   ```
   Repeat for `phone:*`, `sheet:*`, `recurring:*`, `audit:*` (audit is intentional-keep, but compute its size for awareness).
3. For each key, fetch the record + check the `created_at` / `updated_at` / `last_seen_at` field — these are the Kesefle convention. Records without ANY timestamp are oldest candidates:
   ```
   for K in $(head -100 /tmp/kv-user-keys.txt); do
     V=$(curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/$K")
     TS=$(echo "$V" | jq -r '.result | fromjson? | .updated_at // .created_at // .last_seen_at // empty' 2>/dev/null)
     echo "$K $TS"
   done > /tmp/kv-user-ages.txt
   ```
4. Filter to `> 90 days old` AND no `sheet_id` set AND no `provisioned_at`:
   ```
   node -e '
     const fs=require("fs");
     const cutoff=Date.now() - 90*86400e3;
     const lines=fs.readFileSync("/tmp/kv-user-ages.txt","utf8").split("\n").filter(Boolean);
     const old=lines.filter(l => {
       const [, ts]=l.split(" ");
       if(!ts) return true; // no timestamp = oldest
       return new Date(ts).getTime() < cutoff;
     });
     console.log("candidates:", old.length);
     console.log(old.slice(0,20).join("\n"));
   '
   ```
5. Produce a CSV under `snapshots/{date}/kv-orphan-sweep.csv` with: key | last_ts | reason.
6. Hand the CSV to Steven. He decides which to delete; this skill DOES NOT delete.

## Verification
- CSV exists and is non-empty (if it's empty, KV is clean — no action needed).
- For at least 5 candidates, manually `GET` and verify they have no `sheet_id` (truly orphaned, not just inactive).
- No `audit:*` keys in the deletion list (audit log is keep-forever).

## Common pitfalls
- Deleting active records that just happen to have an old `created_at` — always check for `sheet_id` and `provisioned_at` first.
- Running SCAN against the WRONG KV (staging) and reporting candidates that don't exist in prod.
- Deleting `phone:` records but leaving their `user:` mate (or vice versa) → inconsistent state. Pair them by sub before delete.

## Examples
- "Quarterly KV cleanup" → run, hand Steven a CSV of 200 candidate keys.
- "We're at 80% of the KV plan limit" → run, identify what's bulking up storage, decide.
