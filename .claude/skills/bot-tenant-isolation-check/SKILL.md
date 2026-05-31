---
name: bot-tenant-isolation-check
description: Static check that every appendRowToUserSheet caller sources its token from user:{sub}, not from phone:{phone} — the same invariant tests/full_qa.js asserts, but quicker for code-review.
---

# Quick tenant-isolation static check

The invariant: every Sheets write must resolve phone -> `user:{sub}` (canonical record holding the encrypted refresh token), then derive `sheet_id` from that record. Reading `phone:{digits}` for anything beyond a sub-pointer is a bug — phone records can be stale or wrong-tenant. `tests/full_qa.js` enforces this on `api/sheet/append.js` and `api/recurring.js`. This skill is the 30-second pre-commit version.

## Steps

1. List every caller in `api/`:
   ```
   grep -rnE "appendRowToUserSheet\(|appendRowToTab\(" api/ | grep -v "^\s*//\|^\s*\*"
   ```
2. For each caller's file, confirm the token used by `appendRowToUserSheet({ userRecord, ... })` came from `kvGet('user:' + sub)` or a `resolveUser*` helper that returns a `user:{sub}` record. Forbidden patterns:
   ```
   grep -nE "kvGet\(\s*['\"]phone:" api/ -r
   grep -nE "userRecord\s*=\s*await kvGet\(['\"]phone:" api/ -r
   ```
3. The bot's twin: `bot/ExpenseBot_FIXED.gs` should NOT use `phone:` as a token source for tenant writes; the owner path uses the hardcoded `SHEET_ID` const and is allowed only on `_isOwnerPhone_` gates (see `bot-owner-gate-audit`).
4. Confirm the QA guard catches your file:
   ```
   grep -n "appendRowToUserSheet\|appendRowToTab" tests/full_qa.js
   ```
   If you added a new caller, also add its filename to the guard's allowlist + check, so future regressions fail the suite.
5. Run:
   ```
   node tests/full_qa.js
   node bot/test_isolation.js
   ```

## Verification
- Zero hits from `grep -rnE "kvGet\(\s*['\"]phone:" api/` (or only inside a clearly-marked phone->sub lookup helper).
- `tests/full_qa.js` passes including the isolation assertion block.
- `bot/test_isolation.js` passes.

## Common pitfalls
- Loading `kvGet('phone:' + phone)` to get a sheet id directly — wrong; phone record should ONLY tell you the `sub`.
- Trusting body params (`req.body.sheet_id`, `req.body.sub`) — derive from the authenticated identity.
- Adding the new write path but skipping the full_qa guard update → future regression goes silent.

## Examples
- "I added api/sheet/web-append.js — is it isolated?" → run this, check the new file is referenced from full_qa guard.
- "Quick check before pushing PR-touching-sheet-writes" → run this in under a minute, before `pr-review`.
