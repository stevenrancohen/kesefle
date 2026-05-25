---
name: bot-trace-message
description: Diagnose why a specific WhatsApp message went to the wrong category, the wrong sheet, or got dropped — by replaying it through the real bot logic.
---

# Trace a bot message

When Steven (or a user) reports "I sent X and it did Y but should have done Z", reproduce locally before guessing. The real parser and classifier are loaded by the tests — use them.

## Steps
1. Quote the exact original message (Hebrew, exact spacing, exact case). Don't paraphrase.
2. Drop it into `bot/test_parser.js` as a one-off case, run `node bot/test_parser.js` — captures the parsed `{ amount, category, subcategory, isIncome, vatDeductible, rawText }`.
3. If category is wrong: open `CATEGORY_MAP` in `bot/ExpenseBot_FIXED.gs`, find the first matching keyword (the matcher is order-sensitive). Fix or reorder, then add the message to `tests/golden_set.js`.
4. If amount is wrong: look at `_parseAmount_`/`_extractAmount_` — common cause is unicode digits or a stray currency glyph.
5. If routing is wrong: run `node bot/test_isolation.js` to confirm the phone-to-sheet mapping; check KV `phone:{digits}` and `user:{sub}`.
6. If dropped: check `_BOT_ECHO_REGEXES_` (line ~1177) — the message may match a loop-defense regex.

## Verification
- New test case fails before fix, passes after.
- `node bot/test_classify.js && node bot/test_parser.js && node tests/golden_set.js`.

## Common pitfalls
- Trusting your memory of the message — get the actual screenshot, copy raw text.
- Editing CATEGORY_MAP without adding a regression test → it'll regress within a week.
- Fixing in FIXED.gs but forgetting to reassemble DEPLOY.gs.
