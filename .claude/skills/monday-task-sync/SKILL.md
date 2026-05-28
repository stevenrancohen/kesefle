---
name: monday-task-sync
description: Given a list of completed task names, mark them done on the Kesefle Monday board via the Monday GraphQL API. Uses MONDAY_TOKEN env. Idempotent (re-running doesn't change anything for tasks already done).
---

# Sync completed tasks to Monday

The Kesefle project has a Monday board for tracking work. When I finish multiple skills/features in one autonomous block, the Monday board lags behind. This skill batch-marks tasks done from a name list. Uses Monday's GraphQL API directly (the `mcp__8502f1d6...all_monday_api` tool is the alternative inside the harness).

## Required env
- `MONDAY_TOKEN` — Monday personal API token (kept in Steven's local env, not in the repo).
- `KESEFLE_MONDAY_BOARD_ID` — the board id (Steven sets per-shell; if absent, the script asks).

## Steps

1. Confirm env:
   ```
   test -n "$MONDAY_TOKEN" || { echo "MONDAY_TOKEN missing"; exit 1; }
   test -n "$KESEFLE_MONDAY_BOARD_ID" || { echo "KESEFLE_MONDAY_BOARD_ID missing"; exit 1; }
   ```
2. Fetch all items on the board (Monday GraphQL):
   ```
   curl -s -X POST https://api.monday.com/v2 \
     -H "Authorization: $MONDAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"query\": \"query { boards(ids: [$KESEFLE_MONDAY_BOARD_ID]) { items_page { items { id name column_values { id text } } } } }\"}" \
     | jq . > /tmp/monday-items.json
   ```
3. For each task name in your input list, find the matching item id:
   ```
   for NAME in "task one" "task two" "task three" ; do
     ID=$(jq -r --arg n "$NAME" '.data.boards[0].items_page.items[] | select(.name | ascii_downcase | contains($n | ascii_downcase)) | .id' /tmp/monday-items.json | head -1)
     echo "$NAME -> $ID"
   done
   ```
4. Identify the status-column id. On Kesefle boards it's typically named `status` or `סטטוס`:
   ```
   jq -r '.data.boards[0].items_page.items[0].column_values[] | "\(.id) \(.text)"' /tmp/monday-items.json
   ```
   Capture the id (e.g. `status` or `status_1__1`).
5. For each id, set the status to "Done" using `change_simple_column_value`:
   ```
   for ID in $IDS ; do
     curl -s -X POST https://api.monday.com/v2 \
       -H "Authorization: $MONDAY_TOKEN" \
       -H "Content-Type: application/json" \
       -d "{\"query\": \"mutation { change_simple_column_value(board_id: $KESEFLE_MONDAY_BOARD_ID, item_id: $ID, column_id: \\\"status\\\", value: \\\"Done\\\") { id } }\"}"
   done
   ```
6. Read back to confirm. The status column should now show "Done" for every targeted item.

## Verification
- Step-5 mutation returns `{ "data": { "change_simple_column_value": { "id": "<itemId>" } } }` for each task.
- Re-running step 2 shows the targeted items with `text: "Done"` in the status column.
- No task in the input list left without a matched id (unmatched = the name was misspelled or the task doesn't exist).

## Common pitfalls
- Name fuzzy-match is case-insensitive substring → can match the wrong task. For ambiguous names, pass the full task title verbatim.
- Some Kesefle boards use `סטטוס` (Hebrew) as the status column id-label; the actual column id is still alphanumeric. Confirm in step 4.
- Updating a Group-level task vs an item — the API targets items only. If a "task" is actually a group, this skill won't move it; tell Steven to expand the group manually.
- Forgetting `MONDAY_TOKEN` is a personal token tied to Steven — don't commit it; don't leak it in commit messages or PR descriptions.

## Examples
- "I finished 5 skills, mark them done on Monday" → run with the 5 skill names; expect 5 mutations OK.
- "Sync everything I shipped this week" → list the PR titles, run; report which didn't match (probably internal-only items).
