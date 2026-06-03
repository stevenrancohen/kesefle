---
name: bot-loop-detect
description: Grep ExpenseBot_FIXED.gs for new bot-reply prefixes that aren't yet in _BOT_ECHO_REGEXES_, then propose additions so Hermes/WhatsApp echoes don't loop back as new expenses.
---

# Detect missing loop-defense patterns

`_BOT_ECHO_REGEXES_` (`bot/ExpenseBot_FIXED.gs:1379`) is the swallow-list for the bot's own reply text bouncing back as inbound. Every time a new reply template ships, we must add a regex or risk a billing-spike loop. This skill audits for gaps.

## Steps

1. List every regex currently in the swallow-list:
   ```
   awk '/^var _BOT_ECHO_REGEXES_ = \[/,/^\];/' bot/ExpenseBot_FIXED.gs
   ```
2. List every distinctive reply prefix the bot emits. Common prefixes use emojis as anchors:
   ```
   grep -nE "sendWhatsAppMessage|sendReply|reply\(.*'[✅📊🛑📈💰⚠️📝🎉]" bot/ExpenseBot_FIXED.gs | head -40
   grep -nE "reply\s*=\s*['\"]([✅📊🛑📈💰⚠️📝🎉])" bot/ExpenseBot_FIXED.gs | head -40
   ```
3. Extract the unique prefixes (first 12 chars of each reply literal):
   ```
   grep -oE "['\"]([✅📊🛑📈💰⚠️📝🎉][^'\"]{1,20})" bot/ExpenseBot_FIXED.gs | sort -u | head -50
   ```
4. Cross-reference: for every distinct emoji-prefix that does NOT have a matching regex in step 1, propose a new regex.
   - Format: `/^✅ נרשם בהצלחה/u` (anchored, unicode flag).
5. Add proposed regexes to the array. Add the literal reply text as a test case in `bot/test_botloop.js`. Run:
   ```
   node bot/test_botloop.js
   ```
6. Bump `KFL_BUILD_VERSION` and run `deploy-checklist`.

## Verification
- `node bot/test_botloop.js` passes for every new prefix.
- The added regex matches the bot reply but NOT a plausible user message (e.g. `/^✅/` alone is too broad — anchor at least one Hebrew word).
- `grep -c "_BOT_ECHO_REGEXES_" bot/ExpenseBot_FIXED.gs` shows both the definition and the matcher loop.

## Common pitfalls
- Over-broad regex (`/^✅/u`) — kills legit user messages that start with an emoji.
- Under-broad regex matching only one variant — Hebrew niqqud and zero-width chars sneak in; use `\s*` and the `u` flag.
- Adding a regex but forgetting to ship — `deploy-checklist` step. The loop continues paying Twilio until the deploy.

## Examples
- "I added the goal-achievement reply '🎉 כל הכבוד! עמדת ביעד' — did I cover loop defense?" → run, find no matching regex, propose `/^🎉 כל הכבוד/u`.
- "Steven says he's seeing weird repeats" → run, diff stale prefixes from prod logs against the regex list, find gap.
