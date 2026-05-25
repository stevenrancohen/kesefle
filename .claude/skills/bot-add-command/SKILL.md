---
name: bot-add-command
description: Pattern for adding a new bot command (handler + routing + help text) in bot/ExpenseBot_FIXED.gs without breaking existing commands or tenant isolation.
---

# Add a bot command

Commands are triggered by exact Hebrew/English keywords matched inside `doPost`. There's no router class — it's a chain of `if (typeof handleX_ === 'function' && _isOwnerPhone_(__from_)) { ... }` blocks (see lines ~1795–1913 in `bot/ExpenseBot_FIXED.gs`).

## Steps
1. Decide ownership: owner-only (most admin/config commands) or open (read-only or per-user safe).
2. Write the handler near the bottom of the file:
   ```
   function _handleXyzCommand_(fromPhone, text) {
     // Returns { reply: 'string' } if handled, or null/undefined to skip.
   }
   ```
3. Wire into `doPost` BEFORE the categorize-and-write block. Always gate with `_isOwnerPhone_(__from_)` unless it must be available to all users — document the why in a comment.
4. Add trigger keywords to the help text in the `עזרה` / help command block (search for `KFL_BUILD_VERSION` near line ~6419 — that section is the canonical help screen).
5. Echo-loop defense: if your handler echoes the user's text in its reply, add a regex to `_BOT_ECHO_REGEXES_` (line ~1177) so a bounced WhatsApp message can't trigger an infinite loop.

## Verification
- `node --check bot/ExpenseBot_FIXED.gs`.
- `node bot/test_isolation.js` — owner-only commands must not fire for non-owners.
- Send the new keyword as a non-owner: expect normal expense flow, not the new command.

## Common pitfalls
- Forgetting `_isOwnerPhone_` gate → leak admin power to users.
- Putting the handler block AFTER the categorize-and-write → the message gets booked as an expense first.
- Adding the trigger to the bot's own reply → infinite loop (see `bot-loop-defense`).
