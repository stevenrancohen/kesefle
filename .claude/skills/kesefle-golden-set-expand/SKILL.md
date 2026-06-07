---
name: kesefle-golden-set-expand
description: Grow tests/golden_set.js with new labeled Hebrew/English examples without breaking existing entries or accuracy, keeping the benchmark deterministic and honestly labeled. Use after a misroute fix or new vocabulary.
---

# Expand the golden set

`tests/golden_set.js` is the classifier's regression bedrock: ~155 `[message, label]` pairs graded against a 0.93 threshold, loading the REAL `matchCategory` + `CATEGORY_MAP` from `bot/ExpenseBot_FIXED.gs` (no mock). Expanding it well makes the benchmark broader without making it dishonest or flaky. The hard rule from the file's HONESTY RULE preamble: labels are defensible ground truth, never rigged to whatever the code currently does.

## Steps
1. Read the docstring at the top of `tests/golden_set.js` for the three label forms: `'DEFAULT'` (the bot SHOULD ask -- ambiguous input is NOT a miss), `'sub:X'` (the meaningful signal is the subcategory), `'X'` (first segment of `category`, split on `' / '`).
2. Capture the EXACT raw message -- Hebrew, original spelling, original spacing. Real user inputs (fast mobile typos, English brand names like `wolt`) are exactly what the set should cover. Keep amounts realistic.
3. Label honestly by asking "what is the user actually buying?" If the answer is genuinely ambiguous in one word (`בר`, `גט`, `ספר`), the correct label is `'DEFAULT'` -- do not invent a category to force a pass.
4. Append near similar entries inside the `const GOLDEN = [...]` array, under the matching section comment (supermarkets, fuel, etc.). Determinism comes from these being plain literals -- never add randomness, dates, or `Date.now()`.
5. When the truthful label disagrees with a defensible map design decision, add a one-line `// ` comment explaining it, exactly as existing entries do (e.g. income tax filed as recurring fixed cost; `בקבוק יין` keyed by sub). This is how the file stays auditable.
6. If your new example only passes because of NEW vocabulary, add that keyword first via `bot-add-keyword` (a longer, specific Hebrew literal), then add the golden line -- order matters so the entry reflects shipped behavior.
7. Run `node tests/golden_set.js`. Net accuracy must not drop; your new entry should pass OR the printed miss must be justified by a comment.

## Verification
- `node tests/golden_set.js` exits 0 and prints accuracy >= 0.93 (the `THRESHOLD` the file enforces); the per-label line for your category does not regress.
- The diff is small and additive -- existing `[message, label]` pairs are byte-for-byte unchanged (no reordering, no edited labels), so prior regressions stay locked in.
- `node bot/test_classify.js` and `npm run gauntlet` (or the full `node tests/...` list in `test-run-all`) remain green; optionally confirm one tricky case with `node bot/bot-replay.js "<your message>"`.

## Common pitfalls
- Labeling something `'X'` just to make the test green when the honest label is `'DEFAULT'` -- a silent cheat that hides a real ambiguity and rots the benchmark.
- Leading/trailing spaces in a label string -- the matcher does string-equality on the top segment, so `'אוכל '` fails silently against `'אוכל'`.
- Dumping 20 near-duplicate entries for one fix -- biases the set toward a corner and inflates accuracy; spread coverage across diverse vocabulary instead.
- Editing or deleting existing rows to "clean up" -- that erases a captured regression; only append.
- Adding an entry that depends on `bot/ExpenseBot_DEPLOY.gs` rather than `ExpenseBot_FIXED.gs` -- the golden set loads FIXED; reassemble DEPLOY separately (see `bot-deploy-paste`) and never let the two drift.
