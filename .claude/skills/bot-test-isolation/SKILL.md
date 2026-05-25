---
name: bot-test-isolation
description: Run and interpret bot/test_isolation.js to verify the multi-tenant phone-to-sheet routing in the bot still respects per-user sheet isolation.
---

# Bot isolation test

`bot/test_isolation.js` is the primary defense against a regression where the bot accidentally writes one user's expense into another user's sheet (or worse — the owner's master sheet). It loads the REAL functions from `bot/ExpenseBot_FIXED.gs` and walks three phones through routing.

## Steps
1. Run: `node bot/test_isolation.js`.
2. Expected: every case prints PASS and exits 0.
3. If a case fails, the line tells you which phone routed where. Compare against:
   - Owner phone (`OWNER_PHONE = 972547760643`) → writes to `SHEET_ID` (master).
   - Linked non-owner phone (has `user:{sub}` in KV) → goes through `/api/sheet/append` → writes to `sheet:{sub}`.
   - Unknown phone → must NOT write anywhere; gets onboarding reply.

## Verification
- Read the failed assertion's expected vs actual.
- Cross-check `_isOwnerPhone_` (line ~4855) and the routing block in `doPost` (around line 1740-1913).
- If the test is testing the wrong shape because you changed the routing surface, update the test too — but only after confirming the new routing still preserves the invariant.

## Common pitfalls
- Adding a new owner-only command without gating it with `_isOwnerPhone_(__from_)` — the test won't catch every command, but the invariant should hold by construction.
- Mutating `_kvLookupPhone_` shape — test mocks it; if you change the contract, both the bot and the test mock must update.
- Running against DEPLOY.gs instead of FIXED.gs: pass it explicitly with `node bot/test_isolation.js bot/ExpenseBot_DEPLOY.gs` before any paste.
