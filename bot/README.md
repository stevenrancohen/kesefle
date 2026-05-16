# Kesef'le Bot — Apps Script Files

These files belong to the deployed bot at Apps Script project `1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo`.

## Files in this folder (in suggested paste order)

| File | Purpose | Status |
|------|---------|--------|
| **`WHEN_YOU_ARE_BACK.md`** | Step-by-step handoff doc for the next paste session | start here |
| **`KESEFLE_ALL_PATCHES.gs`** | Combined: keywords + classifier + TEST_CLASSIFIER + sort + checkmark (213 lines) | **paste #1** |
| **`DROPDOWN_FOR_UNSURE.gs`** | WhatsApp interactive list for unsure classifications (631 lines) | **paste #2** |
| **`DROPDOWN_README.md`** | Integration snippet + test plan for the dropdown feature | reference |
| `FIX_DASHBOARD_2023_2024_2025.gs` | Net-profit + משלוחים repair (already shipped, kept for history) | shipped |
| `FIX_DASHBOARD_safe.gs` | ASCII-only-comments backup variant of the dashboard fix | shipped (alt) |
| `DASHBOARD_QUICK_WINS.gs` | Sparklines + YoY chip for `מאזן חברה` (optional R&D) | optional |
| `SORT_AND_FEATURES.gs` | Standalone sort + checkmark (now folded into ALL_PATCHES) | superseded |
| `KESEFLE_KEYWORDS_v2.gs` | Standalone keywords + classifier (now folded into ALL_PATCHES) | superseded |

## What classifier v2 does

`_SRC_classify_v2_(text)` returns:
```js
{ category, subcategory, routes_to, sheet, is_income, confidence, matched_keyword, amount, is_biz_prefixed, needs_question }
```

Confidence rubric:
- 95 — explicit business prefix + matching biz keyword
- 90 — long (≥5 char) keyword match
- 85 — short keyword or vertical-force-biz match
- 50 — conflict (biz keyword on personal msg OR personal keyword on biz msg) → `needs_question: true`
- 0 — no match

Categories: 4 income + 24 personal + 9 business = 37 total, ~700 keywords + brand names.

The `VERTICAL_FORCE_BIZ` list overrides classification for canvas/glass/print materials → always business regardless of prefix (specific to SRC's custom-print vertical).

## Wire-up status

After pasting `KESEFLE_ALL_PATCHES.gs`:
- `_SRC_classify_v2_` is callable but the live bot doesn't use it yet.
- The previous V2_OBSERVE patch (observe-only logging) was never persisted to server.

After pasting `DROPDOWN_FOR_UNSURE.gs` + adding the integration snippet to `doPost`:
- New flow: v2 classifies → if unsure, send WhatsApp interactive list → user picks → bot writes row
- The legacy router stays for installment/recurring parsing — only the classification step is replaced

## Test the classifier (after paste)

Run `TEST_CLASSIFIER` from the function dropdown. Expect:
```
"245 סופר"            → אוכל לבית, personal, conf 90
"60 וולט"             → אוכל בחוץ, personal, conf 90
"42 קפה"              → אוכל בחוץ, personal, conf 90
"עסק 300 פייסבוק"     → עלות שיווק, business, conf 90
"15000 משכורת"        → הכנסה 1 משכורת, personal, conf 90
"מכרתי אייפון 1500"   → הכנסה 3 טלפוניה, personal, conf 90
```

## Existing bot architecture (unchanged)

- Installments parser (`X תשלומים Y`)
- Standing orders parser (`הוראת קבע`)
- Multi-month writer routing to `מאזן חברה` (hidden raw AB-AM) or `תנועות`
- Cell notes (every routed message saved as a note on col A)
- Router with `INSTALLMENT_GUARD_` catching installment/recurring first

The new classifier supersedes only the category-detection step.

## Sheet repair history (already shipped)

- 2026-05-16: `FIX_DASHBOARD_2023_2024_2025` ran successfully. Backup tab `_BAK_dashFix_<ts>` in the spreadsheet. 9 pass / 0 fail on `POST_APPLY_VERIFY`. Restored 2023/2024/2025 `רווח נטו` rows (were stored as `revenue − raw materials only`, now `revenue − total expenses`). 2023 `משלוחים והתקנות` spread monthly from year-tab order log.
