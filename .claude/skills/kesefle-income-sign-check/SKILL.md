---
name: kesefle-income-sign-check
description: Verify the income-vs-expense sign in col H of תנועות — income must set isIncome and land FALSE, never be booked as an expense. Use after a classifier/keyword edit or a "my income shows as an expense" report.
---

# kesefle-income-sign-check

The single most damaging bot bug class in Kesefle is a sign-flip: a real Hebrew income (משכורת, מחזור, החזר מעמ) booked as an expense, which the dashboard SUMIFS then subtracts instead of adds. Col H of תנועות is the source of truth — `TRUE` = expense, `FALSE` = income. This skill traces that one boolean from the classifier all the way to the written row, with no live writes.

## Steps

1. **Read the col-H contract first.** `tests/full_qa.js` (~lines 71-80) asserts the invariant directly:
   - `buildExpenseRow({ isIncome: false, ... })[7] === true` (expense -> col H TRUE)
   - `buildExpenseRow({ isIncome: true, ... })[7] === false` (income -> col H FALSE)
   The inversion lives in `lib/sheet-writer.js` `buildExpenseRow` (~line 1527: `row[7] = !isIncome`). Both write paths (Vercel API and the Apps Script bot) must agree on it.

2. **Trace the bot write path.** In `bot/ExpenseBot_FIXED.gs` the income decision flows through `resolveIsIncome(...)`, and the live `appendRow` writes `!resolveIsIncome(...)` into col H (see the comment block ~line 719-755). Confirm the path you touched still feeds `matched.isIncome` downstream. BUGFIX B1 (2026-05-28, ~line 9526) fixed a hardcoded `TRUE` that flipped income to expense even when `matched.isIncome` was set — do not regress it.

3. **Replay suspect messages.** Run, reading `predicted_target.isIncome` and `predicted_target.col_H_expected` (the replay prints `'FALSE (income)'` or `'TRUE (expense)'`):
   - `node bot/bot-replay.js --json "8500 משכורת"` -> income, FALSE
   - `node bot/bot-replay.js --json "מחזור 10000"` -> income, FALSE
   - `node bot/bot-replay.js --json "החזר מעמ 500"` -> income, FALSE
   - `node bot/bot-replay.js --json "245 סופר"` -> expense, TRUE (negative control)

4. **Confirm the income group set.** Income groups resolve via `lib/categories.js` (`isIncomeGroup`, `EXPENSE_GROUPS`) and the income subcategory rows in the bot CATEGORY_MAP; additive income keywords belong in the `bot/keywords/` packs (the `KESEFLE_KEYWORDS_*.gs` files). A new income keyword MUST set `isIncome:true` on its row, not merely point at a category name.

5. **Anchor every fix.** Add the labeled message to `tests/golden_set.js` — income rows map to the `הכנסות` group (see ~line 150) — so the sign is regression-gated. Use the `golden-set-update` skill for the entry shape. Accuracy must not drop and prior misses stay byte-identical.

6. **Ship by manual paste only.** Bot fixes deploy by Apps Script paste, never by push. Reassemble `bot/ExpenseBot_DEPLOY.gs` from `bot/ExpenseBot_FIXED.gs` (via `bot-deploy-paste`) and hand Steven the paste instructions. Agents never push main and never auto-deploy the bot.

## Verification

- `node tests/full_qa.js` passes — specifically the unit-suite checks "expense flag in col H (true=expense)" and "income flag in col H (false=income)". This file IS the gauntlet's entry point; the bot suites run inside its loop.
- `node bot/bot-replay.js --json "8500 משכורת"` shows `isIncome: true` and `col_H_expected: "FALSE (income)"`; `node bot/bot-replay.js --json "245 סופר"` shows `"TRUE (expense)"`.
- `node tests/golden_set.js` reports accuracy >= the prior run with your new income anchor present.

## Common pitfalls

- **Reading col H as "is it an expense?" and writing `isIncome` directly.** The column is inverted (`!isIncome`); writing `TRUE` for income is the exact B1 sign-flip that subtracts revenue in the dashboard.
- **Adding an income keyword without `isIncome:true`.** The classifier picks the category but the row still books as an expense. Real case: `החזר מעמ` hit the bare 3-char `מעמ` opex keyword and booked as a company expense until the longer phrase was added to the `מחזור` income row (length-sort wins).
- **Forcing a sign onto a genuinely ambiguous bare token** to "fix" a miss — that breaks the never-corrupt floor. If the honest outcome is the bot asking, leave it; only add a specific, unambiguous income phrase.
- **Trusting replay as proof the bot wrote income correctly.** Replay only proves what it WOULD write; the actual col-H value in תנועות is the truth.
