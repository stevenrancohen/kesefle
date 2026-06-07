---
name: kesefle-classifier-confusion-matrix
description: Build a predicted-vs-labeled confusion matrix from tests/golden_set.js to surface the worst-confused category pairs, so you fix the costliest misroutes first instead of guessing. Read-only, no live writes.
---

# Classifier confusion matrix

`tests/golden_set.js` already grades the bot classifier against ~155 hand-labeled Hebrew messages, but it only prints per-label accuracy and a flat miss list. This skill turns those same labels into a confusion matrix (labeled category x predicted top-level category) so you can see WHICH bucket steals from WHICH -- e.g. how often a real `בריאות` expense lands in `בנקאות`. It loads the REAL `matchCategory` + `CATEGORY_MAP` from `bot/ExpenseBot_FIXED.gs` via the same balanced-brace extraction the golden set uses; it never opens a sheet or hits the bot endpoint.

## Steps
1. Read the label semantics first in `tests/golden_set.js` (the docstring at the top): `'DEFAULT'` = the bot SHOULD ask, `'sub:X'` = the signal is the subcategory, `'X'` = top-level of `category` split on `' / '`. The matrix must respect these -- a `DEFAULT` label is a real cell, not "wrong".
2. Reuse the golden set's own extraction. Do NOT re-implement the parser. In a scratch script under `tests/` (e.g. `tests/_confusion_scratch.js`), `require` is not enough because the file runs on import; instead copy its loader block (the `balanced()` / `fn()` helpers that pull `CATEGORY_MAP`, `BUSINESS_CATEGORY_MAP`, `DEFAULT_CATEGORY`, and `matchCategory` from `bot/ExpenseBot_FIXED.gs`).
3. For each `[msg, want]` in the GOLDEN array, compute `got` exactly as the file does: `const top = c => String(c||'').split('/')[0].trim();` and map a default result (category+subcategory both equal `DEFAULT_CATEGORY`) to the literal `'DEFAULT'`.
4. Derive the predicted label in the SAME space as `want`: if `want` starts with `sub:`, predict via subcategory substring; if `want === 'DEFAULT'`, predict `'DEFAULT'` when the result is the default; else predict `top(got.category)`. This keeps rows and columns comparable.
5. Accumulate `matrix[want][predicted]++`, then print: (a) the full grid, (b) a ranked "worst-confused pairs" list = off-diagonal cells sorted by count desc, each line `<labeled> -> <predicted>  N  e.g. "<one sample msg>"`.
6. Use the worst pair to drive a fix via `bot-add-keyword` (add a longer, more specific Hebrew literal so the right cluster wins) and re-run. Confusion is almost always a SHORT keyword in one cluster swallowing a longer phrase that belongs elsewhere (see the golden set's notes on `ספר`, `יין`, `דמי טיפול`).

## Verification
- The matrix diagonal sum equals the golden set's own `correct` count and the printed accuracy matches `node tests/golden_set.js` (>= 0.93). If they disagree, your loader or label-space mapping drifted from the file.
- `node tests/golden_set.js` still exits 0 after any keyword fix; the targeted off-diagonal cell shrinks and no diagonal cell loses count (no new regressions).
- `node bot/test_classify.js` and `npm run gauntlet` (or the `node tests/...` list in `test-run-all`) stay green.

## Common pitfalls
- Re-implementing `matchCategory` or hardcoding the taxonomy instead of extracting it from `bot/ExpenseBot_FIXED.gs` -- your matrix then describes a classifier users never run.
- Splitting category on the wrong delimiter: the file uses `split('/')[0].trim()` for the matrix axis even though labels are written with `' / '`. Mismatch silently scatters rows.
- Treating `DEFAULT` cells as errors and "fixing" an ambiguous one-word input (`בר`, `גט`, `ספר`) into a category -- that REMOVES the correct ask-behavior and will regress the golden set.
- Editing the scratch matrix script INTO the shipped bot, or leaving `tests/_confusion_scratch.js` committed as if it were a gate -- it is a diagnostic; the gate stays `tests/golden_set.js`.
- Quoting a matrix produced against `bot/ExpenseBot_DEPLOY.gs` after editing `ExpenseBot_FIXED.gs` without reassembling -- the deploy file is stale until rebuilt (see `bot-deploy-paste`).
