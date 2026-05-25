---
name: bot-add-keyword
description: Pattern for adding new categorizer keywords to the bot taxonomy plus the matching golden-set test entry, so accuracy is tracked and regressions are caught.
---

# Add a categorizer keyword

Categories live in `CATEGORY_MAP` inside `bot/ExpenseBot_FIXED.gs` (search for the `CATEGORY_MAP` definition, ~line 200). Each entry is `{ keywords: [...], category: '...', subcategory: '...' }`. The matcher walks them in order.

## Steps
1. Find the right cluster first — search for an existing close keyword to land near similar vocab.
2. Append to the existing entry's `keywords` array if it shares cat+sub. Otherwise add a new entry.
3. Keywords are ALL Hebrew/English LITERALS the matcher will look for as substrings of the normalized user text. Include common misspellings (the bot's audience often types fast on mobile).
4. Add at least 1–2 lines to `tests/golden_set.js` covering the new keyword with the expected category label.
5. Run `node tests/golden_set.js` — accuracy must not drop below the threshold the file enforces.

## Verification
- `node bot/test_classify.js && node tests/golden_set.js`.
- Manually test one message in `bot/test_parser.js` if the new keyword overlaps with a tricky token.
- Diff the golden-set report before/after — net misclassifications should be ≤ before.

## Common pitfalls
- A short keyword like `בר` or `גט` is irreducibly ambiguous — DO NOT add it; the matcher should default to ASK.
- Adding the same keyword in two entries — first match wins, you'll confuse yourself.
- Skipping the golden-set entry → no regression guard for the new vocab.
- Forgetting that the bot is shipped via DEPLOY.gs — reassemble after the edit (see `bot-deploy-paste`).
