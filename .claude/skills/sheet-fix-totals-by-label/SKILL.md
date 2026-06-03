---
name: sheet-fix-totals-by-label
description: When a tenant dashboard's `סה״כ X` total rows sum the wrong cell range (template drift / inserted rows), use this label-walker pattern that finds constituent rows by reading labels — never hardcoded row numbers.
---

# Fix `סה״כ X` totals by walking labels, not row numbers

The personal dashboard (`מאזן אישי`) layout in `lib/sheet-writer.js:213-300` has section totals like `סה״כ הוצאות קבועות` (R28 = SUM(B16:B27)), `סה״כ הוצאות זמניות` (R34 = SUM(B31:B33)), `סה״כ אוכל` (R39 = SUM(B37:B38)), `סה״כ תחבורה` (R50 = SUM(B42:B49)), `סה״כ שונות` (R58 = SUM(B53:B57)). When a tenant has a sheet provisioned from an older template, or someone inserted/deleted a row, the `סה״כ` formula stays pointing at the OLD range — so `סה״כ אוכל` ends up summing rows 34-35 instead of 37-38, and the user sees nonsense in their dashboard.

Hardcoding new row numbers makes it worse the next time a row shifts. The fix walks the column-A label list and rewrites each `סה״כ` row's formula based on the labels it finds above it — robust to row inserts.

## When to use

- `tests/full_qa.js` flagged a `_personalSectionTotal('סה״כ X', a, b)` mismatch.
- A tenant says "the total for אוכל / קבועות / שונות is wrong" and the individual category rows look right.
- After a row insert/delete (manual edit or template migration) on a personal dashboard.

## When NOT to use

- The constituent rows themselves are wrong — fix those first (see `sheet-broken-formula`).
- The dashboard is the company `מאזן חברה` — that uses a different fixed-shape layout. See `sheet-recompute-dashboard` instead.
- The user customized their dashboard with their own section structure — the walker assumes the canonical 5-section layout.

## Steps

1. Open the bot's Apps Script project (the same one Steven pastes deploys into).
2. Backup first — copy the dashboard tab via `_backupCompanyDashboard_(ss)` from `bot/personal_sheet_fix.gs`.
3. Paste `FIX_TOTALS_PERSONAL` into a new file and run it. It walks col A from row 1, when it hits a `סה״כ` label it walks BACKWARDS until it finds another `סה״כ` row, a sub-section header (rows starting with an emoji + space), or an empty label — that's the upper bound of the range. The lower bound is the row just before the `סה״כ` row.
   ```js
   var _FT_SHEET_ID_ = '<TENANT_SPREADSHEET_ID>';
   var _FT_PERSONAL_TAB_ = 'מאזן אישי'; // מאזן אישי
   var _FT_TOTAL_PREFIX_ = 'סה״כ';                          // סה״כ

   function FIX_TOTALS_PERSONAL() {
     var ss = SpreadsheetApp.openById(_FT_SHEET_ID_);
     var dash = ss.getSheetByName(_FT_PERSONAL_TAB_);
     if (!dash) { Logger.log('FAIL: no ' + _FT_PERSONAL_TAB_); return; }
     var n = dash.getLastRow();
     var labels = dash.getRange(1, 1, n, 1).getValues(); // col A
     var fixed = 0;
     for (var r = 1; r <= n; r++) {
       var label = String(labels[r - 1][0] || '');
       if (label.indexOf(_FT_TOTAL_PREFIX_) !== 0) continue; // only סה״כ rows
       // Walk upward from r-1 to find first row whose label starts with סה״כ,
       // is empty, or is a section header (matches /^[\p{Emoji}\p{So}]\s/u).
       var top = r - 1;
       while (top >= 1) {
         var u = String(labels[top - 1][0] || '');
         if (!u) break;
         if (u.indexOf(_FT_TOTAL_PREFIX_) === 0) { top++; break; }
         // Section sub-header (emoji-led label, e.g. "🍽️ אוכל"). Treat as a divider.
         if (/^[\p{Emoji}\p{So}\p{Extended_Pictographic}]\s/u.test(u) && top !== r - 1) { top++; break; }
         top--;
       }
       if (top < 1) top = 1;
       var bottom = r - 1;
       if (bottom < top) { Logger.log('skip ' + r + ' (' + label + ') — empty span'); continue; }
       // Annual col B + monthly C..N — all use the same range, only column letter changes.
       var cols = ['B','C','D','E','F','G','H','I','J','K','L','M','N'];
       var newFormulas = cols.map(function (c) {
         return '=SUM(' + c + top + ':' + c + bottom + ')';
       });
       dash.getRange(r, 2, 1, 13).setFormulas([newFormulas]);
       Logger.log('Fixed row ' + r + ' "' + label + '": SUM(B' + top + ':B' + bottom + ')');
       fixed++;
     }
     Logger.log('Done. Rewrote ' + fixed + ' total rows.');
   }
   ```
4. Read the log. Each rewritten row prints its label + the new `SUM(top:bottom)` range. Eyeball: do the ranges look right? If `סה״כ אוכל` rewrote to `B37:B38` you're done; if it rewrote to `B34:B35` something else is wrong (labels in col A drifted too — investigate before re-running).
5. Open the dashboard. Pick one row, sum the constituent rows by hand, compare.

## Verification

- `node tests/full_qa.js` — should still pass (the test reads `lib/sheet-writer.js` source, not the live sheet — but the live sheet now matches the source).
- For the live sheet: `dash.getRange('B39').getFormula()` should be `=SUM(B37:B38)` after running.
- Re-run `FIX_TOTALS_PERSONAL` — should print "Rewrote 0 total rows" (idempotent).

## Examples

- **2026-05-28** — Steven's `מאזן אישי` had `סה״כ אוכל` on row 39 summing `B34:B35` (old xlsx range from a 2024 template), not `B37:B38` (current `lib/sheet-writer.js:237` shape). `FIX_TOTALS_PERSONAL` walked, found the `🍽️ אוכל` sub-header on row 36 + the 2 food category rows on 37-38, rewrote R39B to `=SUM(B37:B38)`. Same fix applied to `סה״כ תחבורה` (50), `סה״כ שונות` (58), etc.

## Common pitfalls

- Running before backup. Always backup first — the walker is heuristic, not formally proven.
- The walker uses `/^[\p{Emoji}…]\s/u` to detect sub-headers. If a tenant renamed `🍽️ אוכל` to plain `אוכל` (no emoji), the walker keeps going past it. Add the emoji back or set the row to bold + treat bold as a divider.
- Pasting Hebrew tab names from chat — bidi marks corrupt the string. ALWAYS use the `\u05XX` escapes (see the snippet) — `_FT_PERSONAL_TAB_` and `_FT_TOTAL_PREFIX_` in this skill are pre-encoded for safe paste. See `sheet-hebrew-encoding-safe-script`.
- Mismatch between `סה״כ` (with gershayim `״` = U+05F4) and `סה"כ` (plain ASCII `"`). Steven's older sheets use both. The walker checks `indexOf(_FT_TOTAL_PREFIX_) === 0` — extend the check if you find both variants in the same sheet.

## Related skills

- [[sheet-broken-formula]] — for `#REF!` / `#N/A` / empty-criteria SUMIFS detection on the same dashboard.
- [[sheet-recompute-dashboard]] — for the `מאזן חברה` (company) dashboard, NOT this one.
- [[sheet-hebrew-encoding-safe-script]] — for safely embedding Hebrew tab names + labels in an Apps Script paste.
- [[verify-data-sources-before-formula-repair]] — the broader pre-flight.
