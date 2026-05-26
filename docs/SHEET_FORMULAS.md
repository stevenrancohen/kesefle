# מאזן חברה — Formula Architecture

How the company-balance dashboard sheet aggregates business transactions, what can go wrong, and how to fix it.

## Source of truth

- **תנועות tab** — every business transaction row, 8 columns:
  | A תאריך | B חודש (YYYY-MM) | C סכום | D קטגוריה | E תת-קטגוריה | F תיאור | G מקור | H הוצאה? |
- A row is a "business" row when D = `עסק`.
- The bucket (marketing / raw materials / shipping / operational / revenue) is decided by matching E (subcategory) or F (description) against the per-bucket regex in `_COMPANY_SUB_BUCKETS_` (in `bot/personal_sheet_fix.gs`).

## מאזן חברה layout

Repeated year blocks, one per year:
```
שנת 2026
                   ינואר  פברואר  מרץ  ...
מחזור ברוטו         X       X      X
עלות חומרי גלם      X       X      X
עלות שיווק          X       X      X     <- bucket 3
משלוחים והתקנות     X       X      X
הוצאות תפעוליות     X       X      X
רווח נטו חודשי      = formula
אחוז רווחיות        = formula
```

## Canonical cell formula (per bucket, per month)

```
=IFERROR(SUMPRODUCT(
  ('תנועות'!C2:C5000)                                     -- amounts
  * ('תנועות'!B2:B5000 = "YYYY-MM")                       -- month
  * ('תנועות'!D2:D5000 = "עסק")                           -- business rows only
  * ((IFERROR(REGEXMATCH('תנועות'!E2:E5000, "(?i)<pattern>"), FALSE)
    + IFERROR(REGEXMATCH('תנועות'!F2:F5000, "(?i)<pattern>"), FALSE)) > 0)
), 0)
```

`<pattern>` per bucket: see `_COMPANY_SUB_BUCKETS_[].regex`. Marketing pattern includes שיווק, פרסום, קמפיין, מודעות, facebook, instagram, google ads, meta ads, seo, ppc, לידים, משפיענים, קריאייטיב, דף נחיתה — see `_PSF_MARKETING_PATTERN_`.

## What goes wrong

### Bug class 1 — "local-column SUMIFS"
Cell ends up with a formula like:
```
=SUMIFS($I$20:$I$500, $A$20:$A$500, "יוני")
```
That sums columns of the dashboard tab itself (where `$I$20` is empty), not תנועות. Always returns 0 or random adjacent numbers. `_isBrokenDashFormula_` Pattern 2 catches this.

### Bug class 2 — "hardcoded +N suffix"
```
=SUMIFS('תנועות'!C:C, 'תנועות'!B:B, "2026-05") + 2100
```
The `+ 2100` is a leftover manual override. `_isBrokenDashFormula_` Pattern 1 catches it. The ONLY legitimate `+ N` suffix is the May 2026 marketing override (₪2100 cash payment).

### Bug class 3 — "stale value"
Cell shows a hard number with no formula (someone typed a value manually). Preserved by the cleaners, replaced by `RECOMPUTE_COMPANY_DASHBOARD` when it has a fresh computed total.

## Repair functions (run from Apps Script editor)

| Function | Scope | What it does |
|---|---|---|
| `DRY_RUN_MARKETING_ALL_YEARS` | Marketing row, all years | Read-only diagnostic |
| `FIX_MARKETING_ALL_YEARS` | Marketing row, all years | Writes canonical SUMPRODUCT |
| `FIX_ALL_BUCKETS_ALL_YEARS` | All 5 buckets, all years | Same but for every bucket |
| `CLEAN_BROKEN_FORMULAS` | All buckets, B4 year only | Replaces only broken formulas with values |
| `CLEAN_BROKEN_FORMULAS_ALL_YEARS` | All buckets, all years | Same as above, every year block |
| `RECOMPUTE_COMPANY_DASHBOARD` | All buckets, B4 year only | Source-of-truth recompute, writes values |
| `DEEP_DIAGNOSE` | Single cell | Inspects what's actually in a cell |
| `SCAN_BUSINESS_TABS` | All tabs | Lists tabs with the תנועות schema (multi-biz audit) |

## Recommended order when the marketing row looks wrong

1. `DRY_RUN_MARKETING_ALL_YEARS` — see current state
2. `FIX_ALL_BUCKETS_ALL_YEARS` — write canonical SUMPRODUCT formulas everywhere
3. Refresh sheet (Cmd+R)
4. If anything still looks wrong, `DEEP_DIAGNOSE` the specific cell

## Multi-business tabs (PR #35) — known limitation

After PR #35, the bot can create per-business TABS in the same spreadsheet (e.g. `כספלה`, `הרמס`). Each tab follows the same 8-col schema.

**Currently the dashboard only sums `תנועות`.** Transactions written to other biz tabs are NOT yet included in מאזן חברה totals.

Run `SCAN_BUSINESS_TABS` to see which tabs the dashboard is missing. Next iteration (separate PR) will extend the formulas to union across all biz tabs.

## Test coverage

`bot/test_marketing_formula.js` exercises:
- `_isBrokenDashFormula_` against the exact bug shapes (incl. Steven's 2026-05-26 screenshot)
- `_bucketForBizSub_` against 22 inputs covering marketing (8), other buckets (6), and non-business categories (5 — must return null)

Run: `node bot/test_marketing_formula.js`. Today: 27/27 pass.
