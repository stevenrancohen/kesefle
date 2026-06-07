---
name: kesefle-expense-message-fuzzer
description: Generate fuzzed Hebrew/English expense messages (typos, spacing, emoji, mixed scripts, many numbers) and replay them through the REAL parser+classifier to surface crashes and mis-routes, without sending anything live.
---

# Fuzz the parser + classifier (read-only)

Stress `parseAmountAndDescription` -> `matchCategory`/`_matchCategory_long` -> `parseBusinessOrder_` in `bot/ExpenseBot_FIXED.gs` with messy real-world input. The oracle is `bot/bot-replay.js` (`--json`), which loads the REAL source via the same balanced-brace extraction `bot/test_*.js` use — no mocks, no live writes, no LLM, no sheet touched. A "crash" is a thrown error or a `_not_loaded:true` decision; a "mis-route" is a confident wrong bucket (especially an income/expense sign-flip). An ambiguous one-word input resolving to DEFAULT/ask is CORRECT behavior, not a failure.

## Steps
1. Build a fuzz corpus (plain text, one message per line) covering: typos (`קפהה`, `שיוווק`, `amazn`), spacing (`50קפה`, `50   שח   קפה`, `$ 50 amazon`), emoji (`50 קפה ☕️`, `🍔 80`), mixed scripts (`50 ils uber`, `12 יורו spotify`), multiple numbers (`850 שיווק 2 קפה`, `החזר מעמ 1200`), and business prefixes (`עסק 35 שיווק`, `עסקה יוסי הכנסה 10000 חומרים 1200`). Seed from the `bot/bot-replay.js` usage banner and `tests/golden_set.js` (~155 labeled lines) so cases are realistic, not random noise.
2. Replay each line read-only: `while IFS= read -r m; do node bot/bot-replay.js --json "$m"; done < corpus.txt > out.jsonl`. Stays local; never hits `/api/sheet/append` or Apps Script.
3. Parse `out.jsonl` for CRASHES: any non-JSON line, any thrown stack, or any `decisions.*._not_loaded === true` (that is a source-extraction bug in the bot or replay loader, distinct from a routing issue — see `kesefle-classifier-misroute-hunt`, which notes `bot/bot-replay.js` can miss helpers like `_matchCategory_long`; if you hit that, load via the golden-set extraction instead).
4. Parse for MIS-ROUTES from each `predicted_target`: flag `subcategory === 'שונות'` on input that clearly should match; flag `isIncome:true` where an expense was meant (or vice-versa) — the sign-flip is the worst outcome (real case: `החזר מעמ` booked as a company expense instead of revenue); flag an `עסק`-prefixed message whose `decisions.parseBusinessOrder.matched=false` and that fell through to a personal tab.
5. Triage honestly: a bare ambiguous token (`גז`, `ספר`, `בר`) landing on DEFAULT/ask is the never-corrupt floor working — leave it. Only genuine wrong-bucket or crash cases are findings.
6. Fix ADDITIVELY only: new length-sorted keyword(s) in the bot taxonomy (see `bot-add-keyword`), never weakening an existing correct match. A bare token polluting the wrong row needs a REMOVAL -> not additive -> flag for Steven, do not auto-apply. Every fix gets a `tests/golden_set.js` anchor (`golden-set-update`). Then reassemble `bot/ExpenseBot_DEPLOY.gs` for the manual paste (`bot-deploy-paste`).

## Verification
- Re-run the failing lines through `node bot/bot-replay.js --json "<msg>"` and confirm each now lands in the expected `predicted_target` (tab/category/subcategory/`col_H_expected`).
- `node tests/golden_set.js` still reports 95%+ aggregate accuracy with ZERO regressions (prior passes stay byte-identical; accuracy only goes up).
- Run the gauntlet to prove no collateral damage: `node tests/full_qa.js`, then `node bot/test_classify.js`, `node bot/test_parser.js`, `node bot/test_bot_robustness.js`, `node bot/test_category_picker.js` (mirrors the `kesefle-regression-runner` / `test-run-all` order). All PASS.
- Syntax gate before any paste: `node --check bot/ExpenseBot_FIXED.gs && node --check bot/ExpenseBot_DEPLOY.gs`.

## Common pitfalls
- Counting DEFAULT/ask as a crash. It is the correct, safe outcome for ambiguous input — forcing a keyword that could be wrong breaks the never-corrupt invariant.
- Trusting `bot/bot-replay.js` for keyword-helper cases: it extracts `matchCategory` but can miss `_matchCategory_long`/`_orig` helpers, yielding `_not_loaded`. For deep matcher fuzzing, load the classifier via the golden-set balanced-brace extraction instead.
- Putting real customer phone numbers (or 972547760643) in fuzz strings — that is PII in logs. Use synthetic names only.
- Concluding "the bot wrote X" from replay output. Replay proves only what the bot WOULD do; it never writes. Live behavior ships only after Steven manually re-pastes the Apps Script bot (agents never push main, never auto-deploy).
