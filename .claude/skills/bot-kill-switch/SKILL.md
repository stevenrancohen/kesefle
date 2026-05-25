---
name: bot-kill-switch
description: Flip KFL_DISABLE_BOT_WRITES in Apps Script Properties to instantly halt all bot writes (Sheets + KV) in an emergency, without redeploying.
---

# Bot kill switch

Two switches exist (line ~1253–1263 in `bot/ExpenseBot_FIXED.gs`):

- `KFL_DISABLE_BOT_WRITES` (Script Property, value `true`) — halts ALL writes. Reads + replies still work. Use this for "the bot is corrupting data, stop NOW".
- The global guard in `doPost` (line ~1529) reads the same property each request — no redeploy needed.

## When to use
- User reports data corruption / wrong-sheet writes happening live.
- A keyword change just shipped and is mis-categorizing in production.
- A WhatsApp loop is in progress (cost spike).

## Steps
1. Open Apps Script editor for the bot project (Steven has the link).
2. ⚙️ Project Settings → Script Properties.
3. Add or set: key `KFL_DISABLE_BOT_WRITES` value `true`. Save.
4. Next inbound message returns the safety reply without writing — verify by sending a test from your phone.
5. Fix the root cause in code + deploy.
6. Set property to `false` (or delete it). Send a test write to confirm normal operation.

## Verification
- `kfl_disabled` log line appears in Apps Script execution log for any inbound message.
- A test expense message returns a "writes paused" reply and Sheets does NOT change.

## Common pitfalls
- Forgetting to flip back to `false` after fix → silent outage.
- Editing the constant in code instead of setting the property → has to be deployed, not instant.
- Assuming KV writes are also halted — confirm in code; if a path bypasses the guard, fix it.
- No Slack/email alert wired to the kill-switch state — consider adding one before the next emergency.
