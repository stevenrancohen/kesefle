---
name: kesefle-fx-currency-battery
description: Use when changing Kesefle FX rates/parsing or before a money-touching bot deploy. Runs a USD/EUR/GBP/symbol/Hebrew-word conversion battery through the real bot logic, asserting ILS amount, FX note, and category routing.
---

# Multi-currency conversion battery (ILS amount + FX note + routing)

FX lives in `bot/ExpenseBot_FIXED.gs`: `parseForeignCurrencyHint(text)` (~line 9736) auto-converts foreign amounts to ILS using `KFL_FX_DEFAULTS` (USD 3.65, EUR 3.95, GBP 4.65, CAD, AUD, JPY, CHF; ~line 9684), resolved per-call by `_kfl_fxLookup` (~line 9713) for symbols (`$ € £ ¥`), ISO codes, and Hebrew names (`דולר/יורו/אירו/פאונד/יין/פרנק`). Each rate is overridable via Script Property `FX_RATE_<CODE>`. On auto-convert it returns `{ ilsAmount, note, fxRate, autoConverted:true }` with a note like `$ 50 → ₪182.5 (שער 3.65)`. The bot then categorizes the CLEANED text (currency stripped) via `matchCategory`. This skill batteries all of that offline, no live writes, no LLM.

## When to use
- You edited `KFL_FX_DEFAULTS`, `parseForeignCurrencyHint`, or `_kfl_fxLookup`, or added a currency/symbol/Hebrew name.
- Before a manual paste-deploy of `bot/ExpenseBot_DEPLOY.gs` whose diff touches amount parsing or the FX note.
- A user reports "I sent 50 דולר and the shekel amount / category was wrong."

## Steps
1. Know the replay gap FIRST: `bot/bot-replay.js` does NOT load `parseForeignCurrencyHint` (it only extracts `parseLabeledOrder_/parseBusinessOrder_/matchCategory/_classifyBareBusinessExpense_`), so `node bot/bot-replay.js --json "$50 amazon"` shows amount 50 with NO FX note. Do not use raw replay to prove FX. Either (a) add `parseForeignCurrencyHint` + `_kfl_fxLookup` + `_kfl_fxRate` + `KFL_FX_DEFAULTS` to the replay's `extractFn`/`extractDecl` list, or (b) write a standalone battery that loads them directly.
2. Write the battery at `bot/test_fx_currency_battery.js`, loading REAL source via balanced-brace extraction (same pattern as `tests/golden_set.js` and `bot/bot-replay.js` - no mocks). Pull in `KFL_FX_DEFAULTS`, `_kfl_fxRate`, `_kfl_fxLookup`, `parseForeignCurrencyHint`, and `matchCategory` (+ its `CATEGORY_MAP`/`_matchCategory_*` chain).
3. Drive each case through the real path: `parseForeignCurrencyHint(msg)` for the ILS amount + note, then `matchCategory(hint.cleanedText)` for routing. Assert all three: `ilsAmount` equals `round(amount * rate * 100)/100`, `note` contains `שער ` + the rate and the `→ ₪` marker, and the category's first segment matches the expected dashboard bucket.
4. Cover the matrix (each currency at its DEFAULT rate so expected ILS is deterministic):
   - Symbols: `$50 amazon` → ₪182.5 (USD 3.65); `12€ spotify` → ₪47.4; `£30 asos` → ₪139.5; `¥5000 sushi` → ₪120.
   - ISO codes: `100 usd uber`, `80 eur hotel`, `40 gbp books`, `100 cad uber`, `5000 jpy sushi`, `80 chf hotel`.
   - Hebrew words: `50 דולר אמזון`, `12 יורו ספוטיפיי`, `30 פאונד`, `דולר אוסטרלי` vs `דולר קנדי` (most-specific-first ordering at lines 9726-9728 - אוסטרלי/קנדי must NOT collapse to plain USD).
   - Path A (user gave BOTH): `50$ amazon 180 שח` → uses the user's 180 ILS, `autoConverted:false` - assert NO synthetic שער note is forced over their number.
   - Routing sanity: after currency strip, `$50 amazon` still routes shopping, `12€ spotify`/`מנוי` still routes הוצאות קבועות/אפליקציות.
   - Negative case: a plain `50 קפה` (no currency token) returns `null` from `parseForeignCurrencyHint` and is left to the normal ILS parser - assert the FX path does NOT fire on shekel-only input.
5. For overrides, set the rate inline (stub `PropertiesService.getScriptProperties().getProperty` to return `FX_RATE_USD=4.00`) and assert `_kfl_fxLookup('$')` reflects it - proving deploys can re-rate without code change.
6. Wire the new suite into `tests/full_qa.js` (append to the Bot-tests `execFileSync` loop, same as the other `bot/test_*.js`).

## Verification
- `node bot/test_fx_currency_battery.js` prints PASS for every matrix row (ILS amount + שער note + routing).
- `node tests/full_qa.js` stays green end-to-end (the gauntlet) - see [[kesefle-regression-runner]] / [[test-run-all]].
- Reconcile against [[kesefle-bot-conversation-audit]] / [[bot-write-row-tracer]]: the predicted תנועות row for `$50 amazon` shows amount ₪182.5 with the original-text note preserved.
- HONESTY CHECK: `tests/test_currency_hardcoded_ils_contract.js` still passes only because it greps for the names `getExchangeRate|fxConvert|convertCurrency` - which do NOT match the real `parseForeignCurrencyHint`/`_kfl_fxLookup`. Flag this contradiction (the contract claims "no FX" while FX exists); do not silently "fix" it - decide with Steven whether to update that contract pin.

## Common pitfalls
- Asserting FX from raw `bot/bot-replay.js` output - it never calls the FX function, so it will look like FX is broken when it is not.
- Hardcoding expected ILS while also exercising a `FX_RATE_*` override in the same case - pick default-rate cases for the deterministic assertions, override cases separately.
- Decimal/locale: amounts use `.` or `,` (`replace(',', '.')`) and JPY (0.024) yields non-round ILS - compute the expected value, never eyeball it.
- Specificity ordering: a test that lets `דולר אוסטרלי` match plain `דולר` hides the real bug the lines-9726-9728 ordering prevents. Assert AUD/CAD explicitly.
- Live FX/secrets: this battery is offline. Do NOT call a rates API, do NOT echo any `FX_RATE_*` secret VALUE, and remember the bot deploy is a manual paste of `bot/ExpenseBot_DEPLOY.gs` - agents never push main.
