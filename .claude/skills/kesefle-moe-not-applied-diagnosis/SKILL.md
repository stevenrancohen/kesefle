---
name: kesefle-moe-not-applied-diagnosis
description: When עסק תמונות shows ₪0 for marketing/shipping/operating (and a too-high "net") for a past year, the cause is almost always that the MOE opex migration was never APPLIED — not a code/formula bug. Verify via תנועות, then have Steven run MOE. Use on any "company dashboard costs are missing / net is wrong" report.
---

# "Company costs show ₪0" = MOE not applied (usually)

The `עסק תמונות` dashboard rows R9/R10/R11 (marketing / shipping / operating) sum `תנועות` rows where **col D == `עסק`** and the subcategory matches the bucket regex (MFB wired this with an anchored `^עסק$` filter). The bot only writes `עסק` rows for the CURRENT year; **historical (2023-2025) opex exists only in the OLD sheet** until the one-time `MOE_MIGRATE_OLD_OPEX_APPLY` is run. So if MOE wasn't applied, those rows are genuinely **0 — correct, not a bug**, and net shows GROSS (revenue − COGS only).

## Confirm before telling Steven anything (don't guess)
Export the live NEW sheet ([[kesefle-live-sheet-read-via-drive]], [[kesefle-drive-export-large-file]]) and count `תנועות` rows with `col D == 'עסק'` per year:
```python
# per year: rows where col4=='עסק'; bucket by col5 regex (mkt/ship/ops)
```
- All-zero `עסק` rows for 2023/2024/2025 → **MOE not applied** → the fix is running MOE (a Steven Apps Script step), NOT a formula change.
- Non-zero but dashboard still 0 → a real bug (check the `^עסק$` filter / the year `$B$4`).

## The fix (Steven runs it; you can't — it's a live financial write)
`MOE_MIGRATE_OLD_OPEX_DRY_RUN` → set `CONFIRM_MIGRATE_OLD_OPEX='YES I UNDERSTAND'` → `MOE_MIGRATE_OLD_OPEX_APPLY`. Verified post-MOE net: 2023 ₪24,472 · 2024 ₪65,658 · 2025 ₪7,350 (2025 opex: mkt ₪44,237 / ship ₪3,425 / ops ₪3,804). Reassure: the sheet is working; the data just isn't imported yet. See [[expenses_business_dashboard_personal_leak]], [[kesefle-reconcile-live-before-building]].
