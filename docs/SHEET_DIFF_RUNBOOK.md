# OLD vs NEW Sheet Diff — Runbook

Paste-once Apps Script to investigate the differences between Steven's OLD `מאזן אישי` sheet and the NEW Kesefle sheet.

## What it does (read-only)
- Lists every tab in OLD + NEW (✓/✓ side-by-side)
- Counts rows per common tab + computes parity %
- Shows top-15 categories (col E values) in `תנועות` for both sheets
- Lists every dashboard row label (col A) in OLD that is MISSING from NEW (and vice versa)
- Counts `תנועות` rows per year (2023/24/25/26) for both sheets

## Hard NO
- Tool reads OLD + NEW. Never writes to OLD.
- The only thing it writes to NEW is one hidden tab `_DIFF_REPORT_` (and only via `APPLY_DIFF_TO_TAB()` — `DRY_RUN_DIFF_SHEETS()` writes nothing).
- No existing tab in NEW is modified.

## Steps (Steven)

1. Open the bot Apps Script project: https://script.google.com/home/projects/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit
2. Click `+` next to **קבצים** → **סקריפט**
3. Name it: `SHEET_DIFF_OLD_VS_NEW`
4. Open the raw file: https://raw.githubusercontent.com/stevenrancohen/kesefle/main/bot/SHEET_DIFF_OLD_VS_NEW.gs
5. Press `Cmd+A` → `Cmd+C` to copy everything
6. Back in Apps Script: click in the editor, `Cmd+V` to paste, `Cmd+S` to save
7. From the function dropdown at top, pick **`_SDOLD_SELF_TEST_HEBREW_`** → click **Run**
   - Confirms the Hebrew tab names decode correctly. You should see `תנועות`, `הזמנות`, `מאזן אישי`, `מאזן חברה` in the log.
8. From the dropdown, pick **`DRY_RUN_DIFF_SHEETS`** → click **Run**
   - Wait ~30 seconds. The full report appears in the execution log.
   - Read it. No tab is created yet.
9. If happy with the report: pick **`APPLY_DIFF_TO_TAB`** → click **Run**
   - Creates/updates a HIDDEN tab `_DIFF_REPORT_` in the NEW sheet with the report.
   - To view: open the NEW sheet → menu **View** → **Hidden sheets** → click `_DIFF_REPORT_`.

## What to look for in the report

| Section | Tells you |
|---|---|
| § 1 Tab Inventory | Which tabs only exist in OLD (untouched by migration) |
| § 2 Row Counts | Parity % per tab. < 100% = data missing in NEW. |
| § 3 Top Categories | Whether the bot's classification matches OLD's history |
| § 4 Row Labels | **Most important** — categories Steven typed in OLD that never made it to NEW. These are fix-up candidates. |
| § 5 Per-Year | Pre-2026 rows in OLD that didn't migrate = "historical gap" |

## Read this first

> The migration in PR #120 (~2026-05) brought 614 transactions + 28 orders.
> Anything typed in OLD AFTER that date stayed there.
> The differences are EXPECTED — they're a snapshot vs live data gap.
> The fix-up work is in § 4 of the report: add the missing labels to the bot's CATEGORY_MAP (or to lib/sheet-writer.js template) so future writes route correctly.

## After running

Send me a screenshot of the report (or the markdown content) and I'll prioritize the fix-ups.
