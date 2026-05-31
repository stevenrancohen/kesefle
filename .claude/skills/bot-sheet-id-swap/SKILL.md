---
name: bot-sheet-id-swap
description: Validate a SHEET_ID swap PR for the owner-only bot does not break tenant isolation — the swap must touch only bot/ExpenseBot_FIXED.gs (+ DEPLOY.gs), not any api/* or test files.
---

# Validate a SHEET_ID swap

`SHEET_ID` (`bot/ExpenseBot_FIXED.gs:26`) is the OWNER-ONLY hardcoded sheet the bot writes to when the sender matches `_isOwnerPhone_`. Swapping it (e.g. Steven moves his personal accounting to a new sheet) is a one-line change BUT prone to two failure modes: (a) the swap leaks into tenant code paths, (b) the swap leaves DEPLOY.gs stale. This skill validates both.

## Steps

1. Confirm the diff touches ONLY the bot:
   ```
   git diff --name-only origin/main...HEAD | grep -v "^bot/" && echo "WARN: non-bot files changed"
   ```
   Any non-bot file in the diff (especially `api/`, `lib/`, `tests/`) → STOP, investigate. The swap should never need to touch them.
2. Confirm the SHEET_ID literal changes are confined:
   ```
   git diff origin/main...HEAD bot/ExpenseBot_FIXED.gs | grep -E "^[+-]const SHEET_ID"
   git diff origin/main...HEAD bot/ExpenseBot_FIXED.gs | grep -E "^[+-]const COMPANY_SHEET_ID"
   ```
   Both should change in lockstep (`COMPANY_SHEET_ID = SHEET_ID`).
3. Reassemble DEPLOY.gs (see `bot-deploy-paste`) and confirm the new ID lands:
   ```
   grep -E "^const SHEET_ID" bot/ExpenseBot_DEPLOY.gs
   ```
4. Confirm tenant code paths haven't quietly started using the new ID:
   ```
   git grep -nE "['\"]1[A-Za-z0-9_-]{30,}['\"]" -- api/ lib/ tests/
   ```
   No tenant file should hardcode any sheet ID. Template ID lives in env (`KESEFLE_TEMPLATE_SHEET_ID`).
5. Confirm the owner gate is intact:
   ```
   grep -nE "openById\(SHEET_ID\)" bot/ExpenseBot_FIXED.gs | wc -l
   ```
   Compare against the count on `origin/main` — should be the same (you didn't add or remove call sites; only the literal changed).
6. Update `SHEET_OWNER_PHONE` Script Property if the new sheet is owned by a different phone. Document in commit message (per `commit-message-style`).
7. Run:
   ```
   node bot/test_isolation.js
   node tests/full_qa.js
   ```

## Verification
- `git diff --name-only origin/main...HEAD` shows ONLY `bot/ExpenseBot_FIXED.gs` and `bot/ExpenseBot_DEPLOY.gs`.
- `bot/test_isolation.js` passes — confirms the owner gate still routes non-owners to tenant code.
- The new SHEET_ID is present in DEPLOY.gs after reassemble.

## Common pitfalls
- Bumping SHEET_ID but forgetting to bump SHEET_OWNER_PHONE if the owner phone of the new sheet differs.
- Search-replacing the literal across the whole repo and accidentally hitting test fixtures or comments in `api/`.
- Forgetting to reassemble DEPLOY.gs — paste-deploy carries the old ID; bot writes to the old sheet for hours/days.
- Not updating Steven's local memory note about the sheet ID — see MEMORY.md for the structure note.

## Examples
- "Steven moved to a new sheet ID 1xyz..." → run this, confirm clean isolation, deploy.
- "Pre-merge gate on SHEET_ID-changing PR" → run this as the only review step.
