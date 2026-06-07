---
name: kesefle-recurring-detect-test
description: Use when changing recurring logic or adding a recurring case; proves the detector OFFERS קבוע on a 3x-stable expense yet stays silent on one-offs, noisy amounts, income, and same-month dupes, via the real detector.
---

# Test recurring detection (suggest קבוע, never on one-offs)

The proactive detector lives in `bot/ExpenseBot_FIXED.gs` as `_normForRecurring_` + `_detectRecurringCandidate_`, with the thin PropertiesService shell `_recurringSuggestionLine_` on top. The pure logic is already covered by `tests/recurring_detect.js`, which loads the two functions out of the real `.gs` via balanced-brace `eval` (no mock). This skill runs and extends that gate; it does NOT touch the manual `קבוע <amount> <name>` add command (`_recurringAdd_`, body regex at line ~3556).

## Steps
1. Run the existing gate first: `node tests/recurring_detect.js`. It must exit 0. This is the source of truth for the SUGGEST vs SILENT gates; read it before changing anything.
2. Confirm the two SUGGEST anchors hold: 3 distinct months at a stable amount (`נטפליקס` 45 x3 -> `r.count === 3`), and 4 months with small variation (45..50, ratio < 1.5) still suggests. These are the "same expense 3x -> offer קבוע" guarantee.
3. Confirm the SILENT gates hold: only 2 months -> null; 3 hits in the SAME `monthKey` -> null (distinct months required); income rows (`isIncome:true`, e.g. `משכורת`) -> null; noisy amounts (`סופר` 120/340/600, ratio > 1.5) -> null; zero/empty amount -> null; price-doubled (45->90) -> null. A one-off never triggers.
4. When you add a new case, append an `ok(label, cond)` line in the SUGGEST or NOT-suggest block of `tests/recurring_detect.js`, building rows with the `R(description, amount, monthKey, isIncome)` helper. Keep the existing assertions byte-identical.
5. Do NOT widen the gate by editing `_detectRecurringCandidate_` to chase a single case. If a real miss needs a threshold change (minMonths, the 1.5 stability ratio), flag it for Steven and add the failing case first so the change is test-driven.
6. If you also want to see the human-facing offer wording (the line that teaches `קבוע <amount> <name>`), read `_recurringSuggestionLine_` / line ~3399 in `bot/ExpenseBot_FIXED.gs` — but do not invoke it in a test: it does PropertiesService I/O. Assert on `_detectRecurringCandidate_`'s return object only.
7. Bot is deployed by manual paste only — `bot/ExpenseBot_DEPLOY.gs` is reassembled from `bot/ExpenseBot_FIXED.gs`; never edit DEPLOY directly and never push to main from an agent.

## Worked example (the exact shape to add)
The detector takes prior rows + the current row and returns a candidate or `null`. Mirror the `R(...)` helper and `ok(...)` assertion already in `tests/recurring_detect.js`:

```js
// SUGGEST: same merchant, 3 distinct months, stable amount -> offer קבוע
let r = _detectRecurringCandidate_(
  [R('נטפליקס', 45, '2026-01'), R('נטפליקס', 45, '2026-02')],
  R('נטפליקס', 45, '2026-03'));
ok('3 distinct months, stable -> suggests', !!r && r.count === 3);

// SILENT: a one-off (only the current row, no history) -> null
ok('single occurrence -> no', _detectRecurringCandidate_(
  [], R('איקאה', 1200, '2026-03')) === null);
```

A returned candidate is an object roughly `{ count, amount, normalizedDesc }`; assert on `r.count` / `r.amount`, never `r === true`.

## Verification
- `node tests/recurring_detect.js` prints `ALL <n> RECURRING-DETECT CHECKS PASSED` and exits 0; a regression prints the failing label(s) and exits 1.
- Spot-check routing is unaffected: `node bot/bot-replay.js "45 נטפליקס"` still predicts tab `תנועות`, category `הוצאות קבועות` (the detector only adds a follow-up offer; it must not change the row that gets written).
- The suite is part of the house gauntlet (see `.claude/skills/kesefle-regression-runner`); a green `node tests/recurring_detect.js` line there is the merge gate.

## Common pitfalls
- Asserting the SUGGEST anchor as `=== true` — `_detectRecurringCandidate_` returns the candidate OBJECT (`{count, amount, ...}`) or `null`. Use `!!r && r.count === 3`, like the existing cases.
- Forgetting distinct months: three rows all in `2026-03` must return null. A test that reuses one `monthKey` will wrongly look like it fires.
- Treating income as recurring: a stable salary repeats monthly but `isIncome:true` must stay SILENT (you do not nag a user to mark salary as a fixed expense). Never strip that guard to make a case pass.
- Calling `_recurringSuggestionLine_` (or any PropertiesService path) inside the Node test — it is not stubbed and will throw; the test deliberately exercises only the pure detector.
