---
name: sheet-permission-check
description: Verify SHEET_OWNER_PHONE (Apps Script Property) matches the SHEET_ID const and the tenant routing config — runs against /api/admin/config-drift to surface any divergence.
---

# Sheet permission + ownership drift check

The owner gate uses `_isOwnerPhone_(fromPhone)` (`bot/ExpenseBot_FIXED.gs:5424`), which reads `SHEET_OWNER_PHONE` from Script Properties and falls back to a hardcoded const in the file (see lines 28–35). If those drift — e.g. Steven moves to a new phone but forgets to update the Property — the bot's owner-only writes flow to the wrong sheet OR refuse the owner. `/api/admin/config-drift` (`api/admin/config-drift.js`) is the existing endpoint for the env-var side; this skill ties it to the Script Property side.

## Steps

1. Read the repo's owner-fallback const:
   ```
   grep -nE "SHEET_OWNER_PHONE|fallback.*owner phone" bot/ExpenseBot_FIXED.gs | head -5
   ```
2. Read the active SHEET_ID:
   ```
   grep -nE "^const SHEET_ID" bot/ExpenseBot_FIXED.gs
   ```
3. Hit the admin config-drift endpoint (Steven must be signed in):
   ```
   open "https://kesefle.com/api/admin/config-drift"
   ```
   This compares `KESEFLE_BOT_NUMBER` env var against hardcoded `wa.me/<digits>` anchors in HTML.
4. For the Script Property side — Steven must check manually in Apps Script: Project Settings → Script Properties → `SHEET_OWNER_PHONE`. Have him paste the value. Then:
   - Confirm digits match the fallback const in the file (or are an authorized override).
   - Confirm the phone is in the canonical international format the bot's normalizer expects (`+972...`).
5. Cross-check the tenant routing — read a fresh KV record for that phone:
   ```
   curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" \
     "$KV_REST_API_URL/get/phone:$(echo $OWNER_PHONE | tr -d '+')" | jq .
   ```
   If a `phone:` record exists for the owner, the owner is also routable as a tenant — confirm that's intentional. (Owner gate fires first; tenant path is only reached if `_isOwnerPhone_` is false.)
6. Persist a drift-check audit log entry (per `audit-log-add`).

## Verification
- Script Property `SHEET_OWNER_PHONE` matches the file's fallback OR is a known-good override.
- `SHEET_ID` const is the sheet the owner actually owns (open it in Drive — confirm Steven is owner, not just editor).
- `/api/admin/config-drift` shows no drift on BOT_NUMBER.
- `node bot/test_isolation.js` still passes.

## Common pitfalls
- Phone format mismatch — `+972...` vs `972...` vs `0...`. The normalizer (`_isOwnerPhone_`) strips non-digits; confirm both sides agree once stripped.
- Sheet ownership in Drive differs from the SHEET_ID const — e.g. Steven owns sheet A but const points to sheet B. The bot writes to B; Steven sees A and panics.
- Forgetting that `SHEET_OWNER_PHONE` Script Property is OVERRIDING the const — checking only the const misses the actual runtime value.

## Examples
- "Pre-launch sanity check" → run this, confirm everything aligned.
- "Steven says his messages are landing in the wrong place" → run this, almost certainly find a Property/const drift.
