---
name: kesefle-bot-number-config-check
description: Verify the PUBLIC bot number 972547766361 and the OWNER number 972547760643 are each used only in their correct places and never swapped - public number drives wa.me/config, owner number drives owner-gating and skills.
---

# Bot vs owner number config check

Kesefle has TWO phone numbers that look alike and must NEVER be swapped:
- **PUBLIC bot number `972547766361`** - the WhatsApp number customers message. Belongs in the frontend config (`api/config.js` `DEFAULT_BOT_NUMBER` / the `KESEFLE_BOT_NUMBER` env override) and the ~45 `wa.me/` anchors across the HTML.
- **OWNER number `972547760643`** - Steven's personal phone, used only to recognize the owner. Belongs in the bot's `OWNER_PHONE` constant + owner-gating, and in `.claude` skills that trace Steven's own messages.

Swap them and either (a) customers message Steven's personal line, or (b) every user is treated as the owner and tenant isolation collapses. This check proves each number is in the right place and nowhere it shouldn't be.

## Steps
1. Confirm the owner constant in the bot is exactly the owner number:
   `grep -n "OWNER_PHONE = '972547760643'" bot/ExpenseBot_FIXED.gs bot/ExpenseBot_DEPLOY.gs` -> one match each.
2. Confirm the public-facing config carries the PUBLIC number, NOT the owner number. The frontend number is `api/config.js` `DEFAULT_BOT_NUMBER` (overridden in production by the `KESEFLE_BOT_NUMBER` env var to `972547766361`). The owner number `760643` must never appear in `api/config.js` or in any `wa.me/` anchor.
3. Grep the whole repo for cross-contamination (each must be empty):
   - Owner number leaking into public surfaces: `grep -rn "760643" --include="*.html" api/config.js` -> empty.
   - Public number used as an owner gate: `grep -rn "766361" bot/ExpenseBot_FIXED.gs` near `_isOwnerPhone_` / `OWNER_PHONE` -> empty (owner gating must use `760643`).
4. Confirm the public number is consistent across the `wa.me/` anchors (use `scripts/swap-bot-number.sh` for any cutover so HTML and the `KESEFLE_BOT_NUMBER` env move together - never hand-edit one anchor).
5. Confirm `.claude` skills that reference Steven's phone use the OWNER number `972547760643` (e.g. trace/isolation skills), never the public one.
6. If a future cutover changes the public WABA number, update `DEFAULT_BOT_NUMBER` in `api/config.js` AND run `scripts/swap-bot-number.sh` AND set `KESEFLE_BOT_NUMBER` in Vercel together - never the owner number, never just one surface.

## What each should be
- `OWNER_PHONE` (bot) and owner-gating + trace/isolation skills -> `972547760643`.
- `api/config.js` `BOT_NUMBER` / `KESEFLE_BOT_NUMBER` env + `wa.me/` anchors -> `972547766361`.

## Verification
- `node tests/full_qa.js` group `5d. WhatsApp number routing` asserts `OWNER_PHONE = 972547760643` (full_qa line ~115) and that the 6 command routers + the receipt path are owner-gated on it. Run the full gate: `npm run gauntlet`.
- `node bot/test_isolation.js` passes - owner phone routes to the master sheet; any non-owner phone routes to its own tenant sheet (never the owner's).
- The two cross-contamination greps in step 3 return nothing.

## Common pitfalls
- Pasting the public number into `OWNER_PHONE` "to test from the bot's own line" -> every message is treated as owner; isolation breaks and full_qa 5d fails.
- Editing one `wa.me/` anchor by hand to the owner number -> customers DM Steven. Use `scripts/swap-bot-number.sh` so all anchors + env move atomically.
- Setting `KESEFLE_BOT_NUMBER` in Vercel to `760643` -> the public site advertises Steven's personal phone. It must be `972547766361`.
- Changing `OWNER_PHONE` and forgetting the bot ships by manual paste -> reassemble `bot/ExpenseBot_DEPLOY.gs` and re-paste ([[bot-deploy-paste]]); agents never push main.
- Reading either number as a sheet/secret value to "log it" - these are public-routing identifiers, but never echo Steven's owner number into a user-facing reply or commit beyond the `OWNER_PHONE` const.
- Trusting a doc/memo over the code - the bot's `OWNER_PHONE` const and `api/config.js` are the source of truth; re-grep them, don't assume a prior note is still accurate.
