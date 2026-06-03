---
name: kesefle-bot-replay
description: Replay a specific bot input through the real parsing + classification logic (no live writes) and print the predicted target sheet/tab/category/subcategory/col-H. Use to debug "why did the bot do X with my message?" without sending the message live.
---

# kesefle-bot-replay

When invoked: run `node bot/bot-replay.js "<message>"` and interpret the output.

## When to use
- A customer reports "I sent X and it ended up in the wrong category"
- Before deploying a bot fix, replay the 9-message audit corpus to confirm no regression
- Investigating a SPECIFIC message you're about to send to verify the prediction matches expectation

## Inputs
- The exact Hebrew message to test (with full punctuation, no edits)

## Behavior
1. `node bot/bot-replay.js --json "<message>"` returns a JSON object with:
   ```json
   {
     "input": "<message>",
     "predicted_target": { "tab", "category", "subcategory", "isIncome", "col_H_expected" },
     "decisions": { "amountMatch", "parseBusinessOrder", "businessN", "matchCategory" },
     "risk_notes": [ ... ]
   }
   ```
2. Cross-reference predicted target against what the customer expected
3. Report ANY of these as a finding:
   - `parseBusinessOrder.matched=false` but message starts with `עסק`/`עסקה`/`עסקת`
   - `matchCategory.subcategory='שונות'` (default fallback — bot should ask)
   - `isIncome=true` but expected expense (or vice versa)
   - Decision functions returning `_not_loaded:true` (source-load issue, separate bug)

## Pass criteria for a fix
- The replay matches expected target before deploy
- The 9-message audit corpus (per `kesefle-bot-conversation-audit`) all pass

## Hard NO
- The tool itself is read-only — do NOT modify it to send real messages
- Do NOT use replay output as proof the bot wrote correctly — only proof of what it WOULD write
- Do NOT replay with real customer phone numbers in the message text (PII)
