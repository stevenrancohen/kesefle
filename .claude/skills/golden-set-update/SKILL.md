---
name: golden-set-update
description: Add a labeled expense to tests/golden_set.js to anchor classifier accuracy after fixing a misclassification or adding new vocabulary.
---

# Update the golden set

`tests/golden_set.js` is ~155 hand-labeled Hebrew expense messages. Each time we fix a misclassification, we add it here so the same regression can't slip back in. Treat it as the regression bedrock — honest labels only.

## Label forms (per the file's docstring at line ~1)
- `'DEFAULT'` — the correct behavior is for the bot to ASK (ambiguous one-word input like `בר`, `גט`, `ספר`).
- `'sub:X'` — the meaningful signal is the subcategory (used when the map's top-level is a catch-all like pets, investments).
- `'X'` — first-segment of `category` (split on `' / '`) must equal X.

## Steps
1. Get the EXACT user message (raw, Hebrew, including spacing).
2. Decide the label honestly — what is the user actually buying? If you're not sure, use `DEFAULT` (the bot asking is the right behavior).
3. Add a line to the array in `tests/golden_set.js` near similar entries.
4. Document irreducible ambiguity in a `// ` comment when needed (the file follows this convention).
5. Run `node tests/golden_set.js`. Net accuracy must not drop. New entry must pass OR the file's printout must show a justified miss.

## Verification
- `node tests/golden_set.js` exits 0, total accuracy ≥ threshold.
- The new entry's expected label matches the matcher's actual output (or is justified in a comment).
- The file's HONESTY RULE preamble still holds: labels aren't rigged to fit the code.

## Common pitfalls
- Labeling something `'X'` to make a test pass when the truthful label is `DEFAULT` → silent cheat.
- Adding a duplicate of an existing entry → noisy diff, no value.
- Labels with leading/trailing spaces → string-equals fails silently.
- Adding 20 entries in one PR for one fix → bias the set toward a corner; spread across diverse vocabulary.
