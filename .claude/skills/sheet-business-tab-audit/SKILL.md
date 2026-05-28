---
name: sheet-business-tab-audit
description: For every "עסק N" tab in the owner sheet, validate the schema (header row + 8 expected columns) and report mismatches. Catches drift when a new business gets added by hand.
---

# Business-tab schema audit

Multi-business owners get one `עסק N` tab per business (see `sheet-multi-business` skill). The bot's `BUSINESS_CATEGORY_MAP` (`bot/ExpenseBot_FIXED.gs:8260`) and `_parseBusinessNumberPrefix_` assume a specific column layout: A=date, B=amount, C=description, D=category, E=subcategory, F=vendor, G=notes, H=businessId. If a user adds a tab by hand with different columns, the bot's writes corrupt that tab silently.

## Steps

1. Apps Script function:
   ```js
   function AUDIT_BUSINESS_TABS() {
     var SHEET_ID = 'PUT_OWNER_SHEET_ID_HERE';
     var EXPECTED = ['תאריך','סכום','תיאור','קטגוריה','תת-קטגוריה','ספק','הערות','עסק'];
     var ss = SpreadsheetApp.openById(SHEET_ID);
     var bad = [];
     ss.getSheets().forEach(function(sh) {
       var name = sh.getName();
       if (!/^עסק\s+\d+$/.test(name)) return;
       var header = sh.getRange(1, 1, 1, EXPECTED.length).getValues()[0];
       for (var i = 0; i < EXPECTED.length; i++) {
         if (String(header[i] || '').trim() !== EXPECTED[i]) {
           bad.push({ tab: name, col: i + 1, expected: EXPECTED[i], got: header[i] });
         }
       }
       // Width check
       if (sh.getLastColumn() < EXPECTED.length) {
         bad.push({ tab: name, col: 'width', expected: EXPECTED.length, got: sh.getLastColumn() });
       }
     });
     Logger.log(bad.length ? JSON.stringify(bad, null, 2) : 'OK all עסק tabs valid');
   }
   ```
2. Run it. Read the log.
3. For each mismatch:
   - `expected: 'סכום', got: ''` → user deleted the header. Restore via the snippet at the top of `lib/sheet-writer.js:138`.
   - `expected: 'עסק', got: 'business'` → English header from old template. Rename.
   - `width < 8` → user truncated cols. Re-add the missing cols at the right index — DON'T just append; the bot uses column positions.
4. If anything was changed, re-run `sheet-formula-audit` and `sheet-dashboard-row-validate` to confirm no downstream breakage.

## Verification
- After fix: `AUDIT_BUSINESS_TABS` prints `OK all עסק tabs valid`.
- Send a test `עסק 1 קפה 12` message in the bot — row lands in the right column positions.
- `bot/test_multibiz_naming.js` passes.

## Common pitfalls
- User renamed `עסק 1` to `עסק שלי` → audit skips it because the regex requires a number. Audit the rename too.
- Adding a 9th column (e.g. for tax) at the end vs in the middle — the latter shifts H businessId, breaks `_addCategoryRows_`. New columns must go AFTER col H.
- Owner sheet only — tenant sheets don't have עסק tabs (no multi-business support yet).

## Examples
- "Audit before the next bot deploy" → run, confirm OK.
- "User says business 3 expenses are missing" → run, find the tab's header is messed up, restore.
