---
name: kesefle-installments-parser-test
description: Test the bot installments parser — "ספה 1000 5 תשלומים" splits into 5 x 200 as a recurring monthly plan, with the first-charge-day prompt. Use after editing _detectInstallments_ in bot/ExpenseBot_FIXED.gs.
---

# kesefle-installments-parser-test

When a user writes a purchase with a payment count (Hebrew "תשלומים", English "payments of"), the bot turns it into a recurring monthly plan instead of one lump expense. The pure parser is `_detectInstallments_(rawText, totalAmount)` in `bot/ExpenseBot_FIXED.gs` (~line 7169); it returns `{ count, perPayment, productName }`. There is currently no dedicated suite for it — `tests/recurring_detect.js` covers `_detectRecurringCandidate_`, a different function — so this skill adds one and locks the math.

## Steps

1. **Read the parser so your asserts match reality.** `_detectInstallments_` has three patterns, all gated to `count` in 2..60:
   - A: `"5 תשלומים של 200"` -> perPayment is the stated 200
   - B: `"5 תשלומים"` / `"ב-10 תשלומים"` / singular `"10 תשלום"` -> perPayment = `round(total/N*100)/100`
   - C (English): `"5 payments of 200"`
   The B-pattern boundary is the Hebrew-safe `(?=\s|$|[^א-ת])`. The F3 fix (2026-05-31) replaced a JS `\b` that never closes on a Hebrew letter, so `"ספה 1000 שקל 5 תשלומים"` had silently matched nothing.

2. **Add a Node suite under `tests/`** (e.g. `tests/test_installments_parser.js`) using the repo's balanced-brace extraction — NOT a mock framework. Copy the `fn(name)` + `(0, eval)(fn('_detectInstallments_'))` loader from `tests/recurring_detect.js`. Also extract `_extractProductName_` (~line 7216), which `_detectInstallments_` calls to strip the amount/currency/phrase tokens.

3. **Assert the canonical split and the edges:**
   - `_detectInstallments_('ספה 1000 5 תשלומים', 1000)` -> `count:5`, `perPayment:200`, `productName:'ספה'`
   - the `ב-10 תשלומים` prefix and singular `10 תשלום` both parse
   - pattern A explicit per-payment and pattern C `5 payments of 200`
   - `round(total/N)` math: `1000/3` -> `333.33`, not `333`
   - rejections return `null`: `count` < 2, `count` > 60, and a plain `'245 סופר'` (no false positive)

4. **Cover the flow side structurally — no live writes.** `_setupInstallmentsRecurring_` (~line 7230) posts the plan to `/api/recurring` (action=add) so the daily cron writes one row per due month; `_handleInstallmentsDayPick_` (~line 7378) and the free-text first-charge handler (~line 8876) capture the "חיוב ראשון" answer from the list buttons (`installday|today`, etc.); the `תשלומים` command (~line 8889) lists active plans. Assert the reply text contains the `count x perPayment` line and the first-charge prompt — never call the live KV or cron.

5. **Wire the suite into the gauntlet.** Append a `node` invocation of your file to the bot/API loop in `tests/full_qa.js` (see `test-add-suite` / `regression-test-no-eval`) so it runs on every regression pass, not just by hand.

6. **Ship by manual paste only.** The bot deploys by Apps Script paste, never by push. Reassemble `bot/ExpenseBot_DEPLOY.gs` from `bot/ExpenseBot_FIXED.gs` and hand Steven the instructions (`bot-deploy-paste`). Agents never push main.

## Verification

- `node tests/test_installments_parser.js` exits 0 with the 5 x 200 split, the perPayment rounding, the Hebrew-boundary cases, and the `null` non-matches all green.
- `node bot/bot-replay.js --json "ספה 1000 5 תשלומים"` confirms the message parses and routes (replay proves parse/classification without writing); the installments reply path is exercised by your suite, not by a live send.
- `node tests/full_qa.js` passes with the new suite included in the loop, and `node tests/golden_set.js` accuracy is unchanged (installments inputs must not perturb single-expense classification).

## Common pitfalls

- **Asserting `\b`-style boundaries.** JS word boundaries do NOT close on Hebrew letters. `'... 5 תשלומים'` only matches via the `[^א-ת]`/end-of-string lookahead; a test that "fixes" the regex back to `\b` reintroduces the F3 bug.
- **Hardcoding perPayment for pattern B.** It is `round(total/N*100)/100` — `1000/3` is `333.33`. Match the rounding exactly or the assert is wrong, not the parser.
- **Forgetting the singular `תשלום`** (final mem). `'10 תשלום'` is valid input; the token is `תשלו(?:ם|מים)`.
- **Calling `_setupInstallmentsRecurring_` for real in a test.** It hits `/api/recurring` and CacheService. Assert the parsed plan / reply text only; never let a test write to KV or fire the cron.
