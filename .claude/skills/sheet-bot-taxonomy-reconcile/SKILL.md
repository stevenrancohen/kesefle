---
name: sheet-bot-taxonomy-reconcile
description: Reconcile a tenant company dashboard whose business-expense rows show 0 despite revenue showing real numbers — by comparing actual תנועות col E values to the dashboard's SUMIFS criteria before changing anything.
---

# Reconcile bot-written taxonomy vs dashboard SUMIFS

When `מאזן חברה` rows 8-11 (חומרי גלם / שיווק / משלוח / תפעוליות) on a tenant sheet sit at ₪0 but row 6 (מחזור) shows real revenue, the formulas are fine — the bot wrote rows the SUMIFS criteria do not match. Never "fix the formula" before you've proven the data isn't the problem. This is the exact failure mode that produced PR #114 (the dashboard wipe that Steven had to restore from backup).

The 4 SUMIFS criteria currently emitted by `lib/sheet-writer.js` line 485 are exact-string-match on col E (`*חומרי גלם*`, `*שיווק*`, `*משלוח*` / `*אריזה*`, then `*תפעולי*` / `יועצים` / `תוכנות` / `ציוד עסקי` / `מיסים`). The bot's `CATEGORY_MAP` in `bot/ExpenseBot_FIXED.gs:271-283` writes the short forms (`שיווק`, `תפעוליות`, `חומרי גלם`, `משלוח`). If a user said "שיווק שטוקיי" and the bot stored `subcategory='שיווק שטוקיי'`, the `*שיווק*` wildcard catches it. If the bot's classifier picked a NEW subcategory (e.g. `'פרסום'`, `'אריזה ומשלוח'`, `'דמי ניהול'`), the dashboard misses it. Diagnose before you "repair".

## When to use

- Tenant reports "my dashboard is zero but the data is there."
- After a bot keyword merge (see `bot-add-keyword`) — verify the new subcategory string still matches dashboard SUMIFS.
- Before opening a PR that touches `_buildCompanyDashboardTab` or `COMPANY_EXPENSE_ROWS` in `lib/sheet-writer.js`.

## Steps

1. Run `DIAG_DATA` in the tenant's bot Apps Script project — read-only, dumps top-20 col E values from `תנועות`:
   ```js
   function DIAG_DATA() {
     var ss = SpreadsheetApp.openById('<SPREADSHEET_ID>'); // tenant ID
     var tx = ss.getSheetByName('תנועות'); // תנועות
     if (!tx) { Logger.log('FAIL: no תנועות'); return; }
     var n = tx.getLastRow();
     if (n < 2) { Logger.log('No data rows.'); return; }
     var vals = tx.getRange(2, 4, n - 1, 2).getValues(); // cols D + E
     var counts = {};
     for (var i = 0; i < vals.length; i++) {
       var key = vals[i][0] + ' | ' + vals[i][1];
       counts[key] = (counts[key] || 0) + 1;
     }
     var arr = Object.keys(counts).map(function (k) { return [k, counts[k]]; });
     arr.sort(function (a, b) { return b[1] - a[1]; });
     Logger.log('Top 20 (D | E) values in תנועות:');
     for (var j = 0; j < Math.min(20, arr.length); j++) {
       Logger.log('  ' + arr[j][1] + 'x  ' + arr[j][0]);
     }
   }
   ```
2. Open `lib/sheet-writer.js` and list every criterion at line 485 + `COMPANY_EXPENSE_ROWS`. Write them down.
3. Cross-reference. For each top row in DIAG_DATA where `D == "עסק"`, ask: does the col E value match ANY criterion (including `*…*` wildcard)? Mark hits + misses.
4. Decide ONE of three remedies (do not combine):
   - **Data remap** — the bot's classifier needs a keyword added so it writes the canonical short form. Best long-term fix. Use `bot-add-keyword` + `golden-set-update`.
   - **Formula remap** — the canonical taxonomy genuinely expanded. Add the new criterion to `COMPANY_EXPENSE_ROWS[i].criteria` in `lib/sheet-writer.js`. Backfill existing tenants via `RECOMPUTE_COMPANY_DASHBOARD` (see `sheet-recompute-dashboard`). Use `SUMPRODUCT(...REGEXMATCH(...))` ONLY if literal `*foo*` wildcards aren't expressive enough — overkill in 95% of cases.
   - **Bot-source fix** — the bot misclassified; correct `CATEGORY_MAP` and re-run `golden-set-update`. Backfill historical rows ONLY if Steven asks for it.
5. After the chosen fix, re-run `DIAG_DATA` and confirm every "עסק" row's col E now matches a dashboard criterion.

## Verification

- `node tests/full_qa.js` — must still pass (it asserts COMPANY_EXPENSE_ROWS shape).
- Re-run `DIAG_DATA` post-fix; every top-20 "עסק" entry maps to a criterion.
- Open the live `מאזן חברה` tab; rows 8-11 should show non-zero values matching the DIAG_DATA counts × prices.
- For a Hebrew label sanity check before commit, see `sheet-hebrew-encoding-safe-script`.

## Examples

- **2026-05-28 live trace** — Steven's tenant showed 6 expense rows in תנועות with col E = `'שיווק שטוקיי'` / `'אריזה ומשלוח'` / `'דמי ניהול'`. Dashboard SUMIFS used `*שיווק*` + `*משלוח*` + `*תפעולי*`. `*שיווק*` caught the first, `*משלוח*` caught the second, but `דמי ניהול` missed `*תפעולי*`. Fix path = data remap: add "דמי ניהול"/"management fee" to the `תפעוליות` keyword row in `CATEGORY_MAP`, add golden test.
- **Anti-pattern (PR #114)** — assumed a single source-of-truth tab and rewrote 9 metrics' SUMIFS to point at `תנועות` alone. Zeroed 4 years of revenue (which actually lived in `הזמנות`). See `verify-data-sources-before-formula-repair`.

## Common pitfalls

- Skipping DIAG_DATA and rewriting a formula based on the user's description — that's how PR #114 happened.
- "Repair" via SUMPRODUCT+REGEXMATCH when a 2-character wildcard tweak would do — adds a 4× slower formula to every tenant.
- Forgetting that `*foo*` in SUMIFS matches anywhere in the cell, but COUNTIFS treats `*` literally for some legacy locales — always test on the actual tenant.
- Editing `_buildCompanyDashboardTab` without re-running `RECOMPUTE_COMPANY_DASHBOARD` for already-provisioned tenants. New users get the fix; existing users still see zeros.

## Related skills

- [[verify-data-sources-before-formula-repair]] — the 3-step pre-flight that should ALWAYS run before any formula repair.
- [[sheet-recompute-dashboard]] — to backfill existing tenants after a `COMPANY_EXPENSE_ROWS` schema change.
- [[bot-add-keyword]] — the canonical way to expand `CATEGORY_MAP` so the data side, not the formula side, carries the new term.
- [[bot-trace-message]] — to replay a specific misclassified message before guessing.
