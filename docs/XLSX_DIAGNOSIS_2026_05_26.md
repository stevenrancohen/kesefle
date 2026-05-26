# Diagnosis: "מאזן אישי (14).xlsx — כל המאזן חברה לא נכון ומוטעה"

**Reporter:** Steven, 2026-05-26
**File:** `/Users/stevenrancohen/Downloads/מאזן אישי (14).xlsx` (4.3 MB)
**Diagnosis:** 2026-05-26 by Claude
**Status:** Diagnosed — awaiting Steven's choice between three fix options

---

## What I found

Steven's workbook has SIX tabs whose name contains "חברה". Two of them are dashboards, and they disagree.

| # | Tab | Rows × Cols | What it is | Status |
|---|---|---|---|---|
| 1 | `📊 מאזן חברה` | 60 × 30 | Consolidated dashboard, emoji-prefixed labels | ✅ **CORRECT** — 2023=195K, 2024=162K, 2025=76K, 2026=35K (with May שיווק 1,914 picked up correctly) |
| 2 | `מאזן חברה` | 1000 × 40 | Legacy consolidated dashboard, non-emoji labels | ❌ **BROKEN** — revenue ALL ZEROS in every month in every year; only the manual-fix 2,100₪ May 2026 marketing row was written by hand |
| 3 | `מאזן חברה 2025` | 998 × 43 | Per-year order log (date / customer / product / amounts) | ✅ Source data, fine |
| 4 | `מאזן חברה 2024` | 997 × 42 | Per-year order log | ✅ Source data, fine |
| 5 | `מאזן חברה 2023` | 191 × 30 | Per-year order log | ✅ Source data, fine |
| 6 | `חברה 2026 לא רלוונטי` | 264 × 30 | Marked-irrelevant by Steven | – |

Steven was looking at tab #2 (`מאזן חברה`), saw all-zeros, and reported it as broken. **It IS broken.** Tab #1 (`📊 מאזן חברה`) is the working replacement.

## Why tab #2 is broken

The SUMIFS formulas in `מאזן חברה` look up category names like `"עלות שיווק"`, but the bot's writes to `תנועות` use emoji-prefixed labels like `"📣 עלות שיווק"` (this was the root cause fixed in PR #42 earlier today — the bot now writes the emoji-prefixed labels because that's what the new dashboard expects).

So:
- Bot writes `📣 עלות שיווק 1,914₪` → row appears in `תנועות`
- Tab #1 (`📊 מאזן חברה`) has SUMIFS `=SUMIFS(תנועות!C:C, תנועות!D:D, "*עלות שיווק*", …)` → matches, total = 1,914 ✅
- Tab #2 (`מאזן חברה`) has SUMIFS `=SUMIFS(תנועות!C:C, תנועות!D:D, "עלות שיווק", …)` (exact match) → MISSES every emoji row, total = 0 ❌

## Three fix options (Steven picks)

### Option A — Just use the new tab (zero effort)
1. Open `📊 מאזן חברה` in Sheets.
2. Right-click → "Move to first position" so it's the default landing tab.
3. Leave `מאזן חברה` alone (still works for historical reference if you ever need it — though as noted, its revenue is zero).
4. **Pro:** zero risk, zero file change.
5. **Con:** the old tab is still confusing and may be picked up by next year's audit.

### Option B — Archive the old tab
1. Run an Apps Script function that renames `מאזן חברה` → `_OLD_מאזן_חברה_archived_20260526`.
2. Keep it in the file (so its formulas can be restored if needed) but rename it so it's clearly off to the side.
3. **Pro:** clean UI, no data loss.
4. **Con:** one Apps Script command needs to be run.

### Option C — Rebuild the old tab's formulas
1. Replace every exact-match SUMIFS in `מאזן חברה` with a wildcard SUMIFS that matches both old and new labels.
2. Both dashboards now show the same correct numbers.
3. **Pro:** two working dashboards, fully redundant.
4. **Con:** medium effort, 40 columns × ~15 categories = ~600 cells to rewrite. More moving parts to maintain.

## Recommendation

**Option A** — Steven just needs to use `📊 מאזן חברה` and ignore the broken one. We've already invested today in PR #42, #50, #52 to make sure `📊 מאזן חברה` is the source of truth. Option B is a follow-up cleanup that's nice-to-have but not blocking.

## What I did NOT do

Per Steven's "backup-first + propose-before-apply" rule:
- Did not open the file in Sheets
- Did not run any Apps Script script
- Did not modify the local file
- Just read it via openpyxl (`data_only=True`) and produced this diagnosis

## How to verify yourself

1. Open `/Users/stevenrancohen/Downloads/מאזן אישי (14).xlsx` in Google Sheets or Excel
2. Click the `📊 מאזן חברה` tab — see real 2023-2026 numbers
3. Click the `מאזן חברה` tab — see all-zeros revenue, only the manual 2,100₪ marketing entry
4. Both are looking at the same underlying `תנועות` — only the emoji-vs-not lookup differs
