---
name: test-run-all
description: Run the full Kesefle test gauntlet and interpret pass/fail of every suite for a pre-merge or pre-deploy gate.
---

# Run all tests

Kesefle has nine relevant test suites; running them in the right order surfaces the highest-signal failures first.

## Steps
1. Bot syntax: `node --check bot/ExpenseBot_FIXED.gs && node --check bot/ExpenseBot_DEPLOY.gs`.
2. Bot unit tests (fast):
   ```
   node bot/test_classify.js
   node bot/test_parser.js
   node bot/test_isolation.js
   node bot/test_botloop.js
   node bot/test_broken_formula.js
   ```
3. Lib + golden set:
   ```
   node tests/test_professions.js
   node tests/test_bank_parsers.js
   node tests/golden_set.js
   ```
4. Consolidated QA (loads real handlers, runs static security assertions):
   ```
   node tests/full_qa.js
   ```
5. Inline-script parse check for changed HTML pages (see `inline-script-validate` skill).

## Verification
- Every command exits 0.
- `tests/full_qa.js` prints `0 failed`.
- `tests/golden_set.js` prints accuracy ≥ the threshold the file enforces.
- Total runtime ~ 10–20s offline.

## Interpreting failures
- `test_isolation.js` fail → routing regression. STOP. See `bot-test-isolation`.
- `test_parser.js` fail → parser change broke a known case. Bisect.
- `golden_set.js` accuracy drop → vocabulary regression. See `bot-add-keyword`.
- `test_broken_formula.js` fail → `_isBrokenDashFormula_` drift; sync the two copies.
- `full_qa.js` fail → static security guard tripped (e.g. an endpoint stopped sourcing identity from `user:{sub}`).

## Common pitfalls
- Running only changed-area tests → missing a regression in an adjacent area.
- Skipping `node --check` on `.gs` → ships syntax errors to Apps Script (where the error surface is much worse).
- Running tests against DEPLOY.gs after editing FIXED.gs without reassembling — pretending tests pass on shipped code when they don't.
