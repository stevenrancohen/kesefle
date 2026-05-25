---
name: bot-loop-defense
description: When to add a new pattern to _BOT_ECHO_REGEXES_ in the bot so the bot's own replies, forwarded by WhatsApp metadata oddities, don't loop back as new expenses.
---

# Bot loop defense (`_BOT_ECHO_REGEXES_`)

`_BOT_ECHO_REGEXES_` (in `bot/ExpenseBot_FIXED.gs` line ~1177) is a list of regexes that mark a message as "this looks like my own reply — ignore it". Without this guard, an upstream quirk where the bot's outgoing message gets re-delivered as inbound (Twilio sandbox, WhatsApp Business broadcast group, a user forwarding the reply back) creates infinite cost loops.

## When to add a pattern
- You ship a new bot reply that starts with a distinctive prefix (e.g. "✅ נרשם", "📊 דשבורד שלך", "🛑 שגיאה").
- You see in logs: same phone, same message repeated >3x within seconds, ALL matching a recent reply template.

## Steps
1. Identify the EXACT prefix the bot uses. Make it specific enough not to match real user input.
2. Add a regex to the array. Anchor with `/^/`; prefer prefix matching over substring.
   Example: `/^✅ נרשם בהצלחה/u`
3. Add a quick test case to `bot/test_botloop.js` — paste the bot's reply text and assert `_isLikelyBotEcho_` returns `true`.
4. Run `node bot/test_botloop.js`.

## Verification
- The regex matches the bot's reply (test passes).
- The regex does NOT match a plausible real user message that starts similarly (think: a user might literally type "נרשם" — make the prefix tighter, like include the emoji + space + word).

## Common pitfalls
- Too-broad regex (e.g. `/נרשם/`) blocks legit user inputs.
- Adding the pattern but not bumping `KFL_BUILD_VERSION` → fix doesn't ship.
- Loop happens in a fresh reply you added but you forgot to also add a regex for it — symptom: WhatsApp bill spike.
