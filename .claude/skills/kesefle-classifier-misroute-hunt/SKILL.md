---
name: kesefle-classifier-misroute-hunt
description: Find GENUINE bot classifier mis-routes (a real Hebrew expense that lands in the wrong dashboard bucket — especially sign-flips like a VAT refund booked as an expense) by replaying a realistic corpus through the real classifier, then fix additively + golden-gate. Use to improve bot accuracy without regressions.
---

# Hunt genuine classifier mis-routes (not granularity nits)

Replay ~150-200 realistic Hebrew expense messages (brands, slang, typos, business + personal + income + edge) through the REAL classifier — load it via the golden_set's balanced-brace extraction (NOT `bot/bot-replay.js`, which is broken: it extracts `matchCategory` but not the `_matchCategory_long/_orig` helpers it calls). No mocks, no live writes.

## What counts as a mis-route (fix it)
A message routed to a category/subcategory that the **dashboard SUMIFS would mis-sum** or that misleads — and worst of all a **sign-flip**: income booked as expense or vice-versa.
- Real example (2026-06-01, PR #199/#200): `החזר מעמ` (VAT refund, no geresh) hit the 3-char `מעמ` keyword on the business-opex row → booked as a company EXPENSE instead of revenue. Fixed by adding `החזר מעמ` to the `מחזור` income row (`isIncome:true`); the longer phrase length-sorts ahead of bare `מעמ`.
- Others: `בוסט לפוסט` (boost a post = ad spend) caught by the restaurant `פוסט`; `מגדל ביטוח` lost a len-4 tie to the PC-tower `מגדל`.

## What does NOT count (leave it)
- Same-top-category granularity (`מקרר`→רהיטים vs appliances) — dashboard sums the same top row.
- The DEFAULT/ask outcome on a genuinely ambiguous bare word (`גז`, `ספר`, `פז`) — that's the **never-corrupt floor working**; do NOT force a keyword that could be wrong.

## Fix discipline
- ADDITIVE keywords only (length-sorted, specific-wins; among equal lengths the EARLIER CATEGORY_MAP row wins via stable sort). Never weaken/remove an existing correct match. A bare token polluting the wrong row (e.g. `מגדל`/`ksp` in electronics) needs a REMOVAL → that's not additive → flag for Steven, don't auto-apply.
- Every fix gets a `tests/golden_set.js` anchor + a guard entry. Accuracy must go UP with zero regression (the prior misses stay byte-identical). Keep the 0.6 AI floor + the never-corrupt invariant untouched ([[kesefle-ai-never-corrupt-guard]], [[bot-write-row-tracer]], [[golden-set-update]]).
