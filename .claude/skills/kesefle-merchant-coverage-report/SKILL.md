---
name: kesefle-merchant-coverage-report
description: Use to find classifier vocabulary gaps; measures what fraction of a known Israeli + global merchant list the bot routes confidently and lists every merchant that falls through to the שונות catch-all, before a user hits it.
---

# Merchant coverage report (which merchants fall to שונות)

The classifier is `matchCategory` + `CATEGORY_MAP` + `BUSINESS_CATEGORY_MAP` in `bot/ExpenseBot_FIXED.gs`; its catch-all is `DEFAULT_CATEGORY = { category: 'שונות ואחרים', subcategory: 'שונות', ... }` (line ~713). A merchant that lands there is unrecognized vocabulary, not a real "misc" expense. This skill replays a merchant list through the REAL classifier (no mock, no live writes) and reports coverage + the שונות fall-through list, so gaps are fixed additively and golden-gated.

## Steps
1. Load the real classifier the way `tests/golden_set.js` and `bot/bot-replay.js` do: balanced-brace-extract `CATEGORY_MAP`, `BUSINESS_CATEGORY_MAP`, `DEFAULT_CATEGORY`, then `eval` the helper chain `_kflIsWordChar_`, `_kflKwHit_`, `_matchCategory_orig`, `_matchCategory_long`, `_coerceCategoryBySubcategory`, `matchCategory`. Do NOT classify via `bot/bot-replay.js`'s `matchCategory` path for a bulk audit — the misroute-hunt skill documents it as broken for that helper chain; copy `golden_set.js`'s loader instead.
2. Assemble the merchant probe list: Israeli (e.g. `רמי לוי`, `שופרסל`, `יוחננוף`, `אושר עד`, `פנגו`, `סלקום`, `בזק`, `סופר פארם`, `אייס`, `מקס סטוק`) and global (e.g. `wolt`, `netflix`, `amazon`, `spotify`, `ikea`, `aliexpress`, `booking`). Pull seeds straight from the `GOLDEN` array in `tests/golden_set.js` so labels already exist, plus a fresh batch you expect to be missing.
3. For each merchant, call `matchCategory(name + ' 100')` (a bare amount avoids the empty-string path) and compare the returned `category` to `DEFAULT_CATEGORY.category`. Bucket each as COVERED or FELL-TO-שונות.
4. Emit the report inline (do not write a .md file): coverage `%` = covered / total, then the explicit FELL-TO-שונות list. That list is the actionable output.
5. Fix gaps ADDITIVELY only, via [[bot-add-keyword]]: append the merchant token to the correct `CATEGORY_MAP` row's `keywords` (length-sorted, specific-wins). Never weaken or remove an existing token to force a match; a bare token polluting the wrong row is a REMOVAL -> not additive -> flag for Steven.
6. For every merchant you add, anchor it in `tests/golden_set.js` (see [[golden-set-update]]) so coverage cannot silently regress. A genuinely ambiguous one-word merchant (`בר`, `ספר`, `גט`) should stay labeled `DEFAULT` — falling to שונות there is the never-corrupt floor working, not a bug to paper over.
7. Bot deploy is manual paste from `bot/ExpenseBot_FIXED.gs` into Apps Script (via `bot/ExpenseBot_DEPLOY.gs`); agents never push main and never edit DEPLOY by hand.

## Verification
- `node tests/golden_set.js` still passes its accuracy threshold (95%+) AFTER your additions — the prior labeled set must not regress.
- Each newly covered merchant: `matchCategory('<merchant> 100').category !== 'שונות ואחרים'`, and a spot replay `node bot/bot-replay.js "<merchant> 100"` shows the expected `category` / `subcategory` with no `שונות` risk note.
- Re-run your coverage report: the FELL-TO-שונות count drops by exactly the merchants you added, and coverage `%` rises. Run inside the house gauntlet (`.claude/skills/kesefle-regression-runner`) as the merge gate.

## Common pitfalls
- Counting the ambiguous-by-design tokens as failures: `DEFAULT` for `בר`/`ספר`/`גט` is correct behavior (ask, don't mis-file). Excluding them from the denominator is fine; "fixing" them by forcing a keyword is a regression.
- Probing with the bare merchant name and no amount — that can hit the empty/short-input path; always append ` 100`, matching how golden_set probes.
- Business-only vendors (accountant, ad spend) classify via `BUSINESS_CATEGORY_MAP`, which personal `matchCategory` does not consult — a "miss" there may be a context issue, not a vocabulary gap. Check the right map before adding.
- Editing the giant inline `אפליקציות` subscriptions row by hand to slot one merchant — it is hundreds of tokens and bidi-fragile; add to the correct domain row instead and let length-sort resolve precedence.
