# Workstream 1 — Category Reconciliation

**Date:** 2026-05-29
**Workstream owner:** kesefle-migration-and-sheet-formula-agent (read-only audit)
**OLD sheet:** `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo` (Steven's pre-migration sheet, read-only)
**NEW sheet:** `1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A` (current Kesefle sheet)

**Scope:** READ-ONLY audit of category migration gaps between OLD and NEW, synthesised from repo evidence. No writes, no APPLY, no commit to main.

**Evidence sources used:**
- `bot/SHEET_DIFF_OLD_VS_NEW.gs` (read-only diff tool, lines 22-224)
- `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` (DRY_RUN+APPLY+ROLLBACK migration tool, lines 1-456)
- `bot/AUDIT_AND_CLEANUP_APPENDED.gs` (post-APPLY audit tool, lines 1-376)
- `docs/SHEET_DIFF_RUNBOOK.md`, `docs/CATEGORY_RECONCILIATION_AND_YEAR_SELECTOR_PLAN.md`, `docs/MIGRATE_DASHBOARD_RUNBOOK.md`, `docs/PERSONALIZED_CATEGORY_PROFILES.md`
- `bot/ExpenseBot_FIXED.gs` `CATEGORY_MAP` (lines 271-412, 348 keyword entries; ~249 unique subcategory strings)
- `lib/categories.js` (16 expense groups + 3 income groups, Pa'amonim taxonomy)
- `lib/sheet-writer.js` `buildTenantSheetSpec` (template, lines 55-105 list constants, 213-396 personal builder, 398+ company builder)
- The live audit log from `AUDIT_APPENDED_ROWS` run earlier today (top תנועות col E labels, מאזן אישי appended rows, the 4 deleted business duplicates)

---

## 1. Categories migrated cleanly

These are categories where (a) the OLD sheet uses them, (b) the bot's `CATEGORY_MAP` writes them with matching keywords, (c) `lib/sheet-writer.js` has a template row for them, AND (d) NEW `מאזן אישי` / `מאזן חברה` has a SUMIFS row that exact-matches them.

| Category | OLD evidence | Bot CATEGORY_MAP | sheet-writer template | NEW dashboard row | Verdict |
|---|---|---|---|---|---|
| `אוכל בחוץ` | 67 rows in NEW col E (top label) | line 92, 100, 387, 392 | `PERSONAL_FOOD_ROWS` row 38 | yes | OK |
| `אוכל לבית` | 41 rows in NEW col E | line 93, 386, 388, 391 | `PERSONAL_FOOD_ROWS` row 37 | yes | OK |
| `אפליקציות` | 32 rows in NEW col E | many rows (incl. 49) | `PERSONAL_FIXED_ROWS` row 18 | yes | OK |
| `בית` | 26 rows in NEW col E | (writes via "בית"-keyword paths) | `PERSONAL_FIXED_ROWS` row 16 | yes | OK |
| `הכנסה 1 — משכורת` | 25 rows | line 386 (keyword: משכורת) | `PERSONAL_INCOME_ROWS` row 5 | yes | OK |
| `הכנסה 2 — עסק` | 23 rows (writes as "עסק") | line 387 (keyword: הכנסה 2) | `PERSONAL_INCOME_ROWS` row 6 | yes, but label mismatch — see Section 3 below | PARTIAL — see WARN |
| `מכון כושר` | 23 rows | line 402 | `PERSONAL_FIXED_ROWS` row 17 | yes | OK |
| `תקשורת` | 23 rows | covered via "תקשורת"-keyword many rows | `PERSONAL_FIXED_ROWS` row 19 | yes | OK |
| `בנקאות` | 23 rows | line 434 | `PERSONAL_FIXED_ROWS` row 22 | yes | OK |
| `דלק` | 23 rows | many keyword paths (line 45, 393) | `PERSONAL_TRANSPORT_ROWS` row 42 | yes | OK |
| `ביגוד` | 22 rows | line 53, 381, 400 | `PERSONAL_MISC_ROWS` row 53 | yes | OK |
| `לימודים` | 20 rows | (covered via חינוך/לימוד paths) | `PERSONAL_FIXED_ROWS` row 20 | yes | OK |
| `מונית` | 16 rows | covered via תחבורה keywords (line 393) | `PERSONAL_TRANSPORT_ROWS` row 44 | yes | OK |
| `ביטוח רכב` | 13 rows | line 96, 396 | `PERSONAL_TRANSPORT_ROWS` row 48 | yes | OK |
| `ביטוח אישי` | 12 rows | line 436 | `PERSONAL_FIXED_ROWS` row 21 | yes | OK |
| `בנק הפועלים` | 12 rows (writes col E="בנקאות") | line 434 (subcategory→"בנקאות") | `PERSONAL_FIXED_ROWS` row 22 (label = "בנקאות") | yes — rolls up to "בנקאות" | OK (intentional rollup) |
| `שיווק` | 11 rows in col E (writes as "עלות שיווק") | line 15 (canonical "עלות שיווק") | `COMPANY_EXPENSE_ROWS` row 9 (wildcard `*שיווק*`) | yes | OK |
| `אבא` | 10 rows | line 401 | NO — see Section 2 | PARTIAL — has bot+col E, no dashboard | WARN |
| `BMW s1000` | 10 rows | line 397 | NO — see Section 2 | PARTIAL — has bot+col E, no dashboard until migration APPLIED | WARN |
| `שונות (הכנסות)` | 10 rows | line 389 | `PERSONAL_INCOME_ROWS` row 8 | yes | OK |
| `חניה` | 10 rows | line 394 | `PERSONAL_TRANSPORT_ROWS` row 43 | yes | OK |
| `רוביקון` | 9 rows | line 394 (line 394 in /tmp dump, actual file line ~394) | NO — see Section 2 | PARTIAL — has bot+col E+מאזן אישי row 78 (manually added), no template/Steven sheet row only | WARN |

**Total bot subcategory strings:** 249 unique in CATEGORY_MAP (from `bot/ExpenseBot_FIXED.gs`).
**Total NEW dashboard rows in template:** 4 income + 12 fixed + 3 variable + 2 food + 8 transport + 5 misc = 34 personal + 4 company = 38.
**Gap by raw count:** ≈211 subcategories the bot can write that have NO matching template row. The migration's "append OLD-only labels under banner" approach is the only patch shipped so far.

---

## 2. Categories MISSING in NEW (Steven's OLD that no system tracks)

These are the categories Steven listed verbatim in his prompt that have NO row in `lib/sheet-writer.js` `PERSONAL_*_ROWS` / `COMPANY_EXPENSE_ROWS` (so a fresh tenant template would NOT have a sum row for them). For Steven specifically, the MIGRATE_DASHBOARD_FROM_OLD APPLY appended them under the "🏷️ מהגיליון הקודם" banner on his NEW sheet, but they remain absent from the canonical template.

| Steven OLD category | In bot CATEGORY_MAP? | In `lib/sheet-writer.js`? | In `lib/categories.js`? | In NEW `מאזן אישי` (post-APPLY)? | Severity | Type | Recommended fix |
|---|---|---|---|---|---|---|---|
| `רוביקון` | YES (line 394 of CATEGORY_MAP) | NO | NO | YES (row 78 — Steven only, post-APPLY append) | High | Steven-only | Section G of plan: add as canonical row in `קטגוריות` master with `default_for_new_users=FALSE`, group=`רכב/תחבורה`. Leave template alone. |
| `BMW` / `BMW s1000` | YES (line 397) | NO | NO | YES (post-APPLY) | High | Steven-only | Same as רוביקון — Steven-only canonical row. Keep `default_for_new_users=FALSE`. |
| `אבא` | YES (line 401, subcategory="אבא", category="הוצאות זמניות") | NO | NO | YES (post-APPLY) | High | Steven-only | Steven-only canonical row; semantically a personal transfer not a Pa'amonim category. `default_for_new_users=FALSE`. |
| `גיא` | NO — bot has no `גיא` subcategory route at all | NO | NO | UNCLEAR — needs confirmation it was appended | Critical | Steven-only | Add bot keyword (`["גיא","להעביר לגיא"]→subcategory:"גיא"`). Add to `קטגוריות` master, `default_for_new_users=FALSE`. |
| `חצי אירון מן` | NO — bot has no entry | NO | NO | UNCLEAR — needs confirmation | Critical | Steven-only | Add bot keyword `["חצי אירון","אירון מן","triathlon","אופניים תחרות"]→"חצי אירון מן"`. Group=`ספורט/תחביבים`. |
| `חצי אוסטריה` | NO — bot has no entry | NO | NO | UNCLEAR — needs confirmation | High | Steven-only | Bot keyword TBD. Likely group=`חופשות`. `default_for_new_users=FALSE`. |
| `עורך דין` | YES (via `יועצים` subcategory, line 19 — biz; "עורך דין"/"עורכי דין" in keywords) | NO (rolls into `הוצאות תפעוליות` for biz dashboard) | NO | YES — sums into biz `הוצאות תפעוליות` | Medium | Mapped | OK on biz side. For PERSONAL legal expenses (Steven's "עורך דין" — divorce/personal lawyer), need a personal row OR confirm intent that legal=biz. **Steven decision needed.** |
| `חופשות` | YES (via "חופשות" → "נסיעות"; bot line for חופשות→נסיעות exists indirectly via picker line 5896) | NO | NO | UNCLEAR | High | Mapped to wrong row | Add `חופשות` as own subcategory; today the bot routes vacation strings through travel + נסיעות. The OLD sheet had a dedicated `חופשות` row. **Add to PERSONAL_VARIABLE_ROWS or new "חופשות" row.** |
| `נשר + חופים` | NO — neither word in bot CATEGORY_MAP as subcategory | NO | NO | UNCLEAR | High | Renamed by Steven to `כושר + תוספים` per `PERSONALIZED_CATEGORY_PROFILES.md` | Renamed to `כושר + תוספים` already (per Steven note) — bot routes via `מכון כושר`. Confirm intent. |
| `קולקציות` | NO — no bot route | NO | NO | UNCLEAR | High | Steven-only / business | Steven's category for SRC Collection commerce. Map to biz `מחזור` OR own `קולקציות` row. **Needs decision.** |
| `ארנונה` | YES via line 515 `subcategory:"ארנונה - ערים נוספות"` and line 395 `subcategory:"חשבונות"` | NO direct `ארנונה` row — bundled into `בית` | NO `ארנונה` as own item | UNCLEAR | High | Mapped to wrong row | The bot writes `"ארנונה - ערים נוספות"` for arnona. Dashboard has `בית` row only. **Add `ארנונה` to PERSONAL_FIXED_ROWS** (per `categories.js` line 97 it's a Pa'amonim sub but not yet in template). |
| `חשמל` | YES (line 51, line 553) | YES (`PERSONAL_FIXED_ROWS` row 24) | YES (line 49) | YES | OK | Migrated | OK |
| `מים` | YES (line 51) | YES (`PERSONAL_FIXED_ROWS` row 25) | YES (line 49 — "מים וביוב") | YES | OK | Migrated | OK |
| `אוכל` (umbrella) | YES (many) | YES — split into `אוכל לבית` + `אוכל בחוץ` | YES | YES | OK | Migrated | OK |
| `כבלים + אינטרנט + פלאפון` | YES (many tקשורת-routes) | YES (`תקשורת` row 19) | YES (line 91 "טלפון נייד ונייח" etc.) | YES | OK | Migrated | OK |
| `לימודים` | YES (no exact route — `חינוך וילדים` covers it; line 40 keyword "חינוך") | YES (`PERSONAL_FIXED_ROWS` row 20) | YES (line 61) | YES | OK | Migrated | OK |
| `בדיקות` | YES (line 397 "בדיקה רפואית" → `בריאות/בריאות`) | NO direct `בדיקות` row — bundled into `בריאות` | NO | (rolls into `בריאות`) | Medium | Mapped to `בריאות` | OK — `בריאות` row sums tests. **No action.** |
| `טיפולים` | YES (line 47 "אימון אישי" / line 401 "טיפול פנים" → `טיפוח`/`בריאות`) | YES (`טיפוח` and `בריאות` rows) | YES | YES (rolls into one of those) | Medium | Ambiguous | Decision: Steven's "טיפולים" historically = medical+aesthetic mix. Bot bifurcates. Probably OK — but a single `טיפולים` row in OLD = harder to compare. Document. |
| `חברה / מס הכנסה / ביטוח לאומי` | YES (line 28 `subcategory:"הוצאות תפעוליות"`) | YES (`הוצאות תפעוליות` company row 11) | NO | YES (biz dashboard) | OK | Migrated to biz dashboard | OK |
| `ביטוח חובה+ג׳+איתורן` | YES (line 396 → `ביטוח רכב`) | YES (`PERSONAL_TRANSPORT_ROWS` row 48 `ביטוח רכב`) | YES (line 79 `ביטוח רכב`) | YES | OK | Migrated | OK |
| `טסט רכב` | YES (line 411 `subcategory:"מיסים ואגרות"` for `טסט שנתי`) + line 45 `אחזקת רכב` | YES (`תחזוקת רכב` row 46) | YES (line 79 `תחזוקת רכב`) | YES (rolls into `תחזוקת רכב`) | OK | Migrated | OK |
| `חניונים` | YES (line 394 `subcategory:"חניה"`) | YES (`PERSONAL_TRANSPORT_ROWS` row 43) | YES (line 79 `חניה`) | YES | OK | Migrated | OK |
| `אוכל/מזון/רכבת` | YES (לא בדיוק — "רכבת" routes to תחבורה ציבורית; "אוכל/מזון" → אוכל) | YES — split | YES — split | YES — split into 2 rows | OK | Split | OK — semantic split is intentional |

---

## 3. Categories MAPPED but wrong (typed by user, no bot keywords)

These are categories the bot writes to NEW `תנועות` col E that the dashboard row label doesn't exactly match — historically Steven typed them in OLD by hand, the bot now writes a different string:

| User typed (OLD) | Bot writes (NEW col E) | Dashboard expects | Net result |
|---|---|---|---|
| `הכנסה 2` (free text in OLD) | `הכנסה 2 — עסק` (line 387) | `הכנסה 2 — עסק` (`PERSONAL_INCOME_ROWS` row 6) | OK — label-mismatch was deliberately fixed in 2026-05-25 sheet-writer refresh |
| `שיווק` (free text in OLD) | `עלות שיווק` (line 15, PR-B canonical) | Company row uses wildcard `*שיווק*` | OK due to wildcard SUMIFS — but if any legacy SUMIFS expected literal `שיווק`, it'd miss. **Per AUDIT_AND_CLEANUP — the 4 business duplicates appended were the strict-literal versions** (`עלות חומרי גלם`, `עלות שיווק`, `משלוחים והתקנות`, `הוצאות תפעוליות`) — they showed 0 vs the existing wildcard rows showing real numbers. **CLEANUP_APPENDED rightly removes them.** |
| `הוצאות תפעוליות` (free text) | Many writes — bot canonical | Company row `*תפעולי*` wildcard + 4 literal alts | OK |
| `שיווק וקידום` (variant) | bot writes `שיווק` or `עלות שיווק` | Wildcard matches | OK |
| `Rubicon` / `ג'יפ` | bot writes `רוביקון` | row 78 manual append in personal (per audit) | OK ONLY because Steven's sheet got APPLY |
| `ארנונה` (Steven types) | bot writes `ארנונה - ערים נוספות` OR `חשבונות` depending on path | Dashboard has `בית` row only | **MISS** — net effect: ארנונה values land in col E as either of two strings, neither matches a template row. **High-severity bug for new users.** |
| `חופשות` (Steven types) | bot routes to `נסיעות` | No `חופשות` row, no `נסיעות` row in template | **MISS** — vacation expenses vanish unless user manually adds a `חופשות` row. **High-severity bug for new users.** |
| `קולקציות` (Steven types) | bot has no route → falls to `שונות` | `שונות` (`PERSONAL_MISC_ROWS` row 57) | OK as fallback, but loses Steven's category meaning |

---

## 4. Bot CATEGORY_MAP gaps

For each of Steven's old categories, grep verdict (bot `CATEGORY_MAP` keyword presence and matching subcategory):

| Steven category | Bot can classify it? | Evidence |
|---|---|---|
| `ארנונה` | YES → writes `ארנונה - ערים נוספות` or `חשבונות` | line 515, line 395 |
| `נשר + חופים` | NO (no `נשר`, no `חופים` as keyword) | grep returned 0 for `חופים` |
| `חשמל` | YES | line 51, 395, 553 |
| `מים` | YES | line 51, 395 |
| `אוכל` | YES (split into 2) | many |
| `קולקציות` | NO — falls through to `שונות` | grep: 0 |
| `כבלים+אינטרנט+פלאפון` | YES | line 49, 91, line 395 |
| `לימודים` | YES | line 40 (`חינוך וילדים`), line 402 |
| `ביטוח אישי` | YES | line 436 |
| `אבא` | YES | line 401 (keyword: `להעביר לאבא`) |
| `בדיקות` | YES → `בריאות` | line 397 |
| `טיפולים` | YES → split (`טיפוח` / `בריאות`) | many |
| `חברה / מס / ביטוח לאומי` | YES → `הוצאות תפעוליות` | line 28 |
| `ביטוח חובה+ג׳+איתוראן` | YES → `ביטוח רכב` | line 96, 396 |
| `טסט רכב` | YES → `מיסים ואגרות` or `תחזוקת רכב` | line 411, line 45 |
| `חניונים` | YES → `חניה` | line 394 |
| `BMW` | YES | line 397 |
| `דלק` | YES | line 45, 393 |
| `אוכל/מזון/רכבת` | YES (split) | many |
| `רוביקון` | YES | line 394 |
| `חצי אירון מן` | NO — no keyword | grep: 0 |
| `חצי אוסטריה` | NO — no keyword | grep: 0 |
| `עורך דין` | YES → biz `יועצים` (rolls to `הוצאות תפעוליות`) | line 19 |
| `בנק הפועלים` | YES → `בנקאות` | line 434 |
| `חופשות` | YES → `נסיעות` (not own row) | line 405 |
| `גיא` | NO — no keyword | grep: 0 |

**Gap summary:** 4 of Steven's 25 listed categories have NO bot route at all:
- `נשר + חופים` (probably renamed to `כושר + תוספים` already per `PERSONALIZED_CATEGORY_PROFILES.md` ¶3 — confirm)
- `קולקציות` (silent fallback to `שונות`)
- `חצי אירון מן`
- `חצי אוסטריה`
- `גיא`

That's a 4-keyword addition to `CATEGORY_MAP` — purely additive, no removal, low risk. The fix is the `bot-add-keyword` skill flow.

---

## 5. Rubicon status

**Verdict: PARTIAL — bot CATEGORY_MAP is wired, but `lib/categories.js` and `lib/sheet-writer.js` template are NOT. The dashboard row exists ONLY in Steven's personal sheet via the post-APPLY `מאזן אישי` row 78 manual append.**

| File | רוביקון present? | Evidence | Verdict |
|---|---|---|---|
| `bot/ExpenseBot_FIXED.gs` `CATEGORY_MAP` | YES | line 394 (in /tmp dump, actual file line ~394): `{"keywords":["גיפ רוביקון","רוביקון"],"category":"תחבורה","subcategory":"רוביקון"}` | OK — `category="תחבורה"` matches plan §G `group=רכב/תחבורה` |
| `lib/categories.js` | NO | grep returned 0 | **MISSING** — should be added as item under `transport` group OR (per plan §G) as Steven-only `default_for_new_users=FALSE` |
| `lib/sheet-writer.js` template (`PERSONAL_TRANSPORT_ROWS`) | NO | grep returned 0 | **MISSING from template** — but should remain missing per plan §G (`default_for_new_users=FALSE` means new users do NOT get a `רוביקון` row) |
| Steven's NEW `מאזן אישי` | YES (row 78, post-APPLY append) | per Steven's audit-log confirmation in prompt | OK |
| NEW `תנועות` col E historic count | 9 rows match exactly `רוביקון` | per AUDIT log in prompt | OK — SUMPRODUCT on row 78 will return non-zero for current year |

**Plan §G compliance check:**

| Plan §G hard rule | Status |
|---|---|
| `רוביקון` group=`רכב / תחבורה` | YES — bot uses `category="תחבורה"` (the plan calls it `רכב/תחבורה`; the bot uses the simpler `תחבורה` — semantically same group, but **wording drift** — note for future) |
| Never becomes a tab | YES — never created as tab |
| Never lands in `שונות` | YES — bot route is explicit |
| Never lands in personal sheet's `רכב` row labeled `BMW` | YES — `BMW s1000` is its own subcategory (line 397), distinct from `רוביקון` |
| Always its own row under `רכב / תחבורה` | YES (post-APPLY in Steven's sheet) |

**Remaining work for Rubicon:**
1. Wording reconcile: bot says `category:"תחבורה"`, plan says `group:"רכב / תחבורה"`. Choose one canonical group name and propagate to `קטגוריות` master when it ships.
2. Add `רוביקון` to `קטגוריות` master (when that tab ships) with `default_for_new_users=FALSE`, `active_for_steven=TRUE`.
3. Confirm row 78 SUMPRODUCT in `מאזן אישי` returns the expected total when B4 sweeps 2023→2026.

---

## 6. Severity-tagged findings table

| # | Finding | Severity | Type | Files / sheets touched | Recommended SAFE fix |
|---|---|---|---|---|---|
| F-01 | `גיא` has no bot CATEGORY_MAP entry; bot can't classify Steven's transfers to גיא | Critical | Bot gap | `bot/ExpenseBot_FIXED.gs` | Add keyword line `{"keywords":["גיא","להעביר לגיא","העברה לגיא"],"category":"הוצאות זמניות","subcategory":"גיא"}` (matches `אבא` pattern). Additive only. |
| F-02 | `חצי אירון מן` no bot route | Critical | Bot gap | `bot/ExpenseBot_FIXED.gs` | Add `{"keywords":["חצי אירון","אירון מן","ironman","triathlon"],"category":"בריאות","subcategory":"חצי אירון מן"}`. Additive. |
| F-03 | `חצי אוסטריה` no bot route | High | Bot gap | `bot/ExpenseBot_FIXED.gs` | Add `{"keywords":["חצי אוסטריה","אוסטריה חופשה"],"category":"נסיעות","subcategory":"חצי אוסטריה"}`. Additive. |
| F-04 | `קולקציות` silently falls through to `שונות` | High | Bot gap + decision | `bot/ExpenseBot_FIXED.gs` | Decide: is it biz `מחזור` or personal `קולקציות`? Steven decision needed. |
| F-05 | `ארנונה` bot writes `ארנונה - ערים נוספות` or `חשבונות`, no template row for either; `בית` row exists but doesn't exact-match | High | Template mismatch | `lib/sheet-writer.js` `PERSONAL_FIXED_ROWS` | Add `ארנונה` to PERSONAL_FIXED_ROWS (or change row count). Coordinate with section-total formula `SUM(B16:B27)` — adding rows shifts indices. **Use sheet-spec-modify skill flow.** |
| F-06 | `חופשות` routes to `נסיעות`, no dashboard row for either, expense vanishes silently | High | Template mismatch | `lib/sheet-writer.js` | Add `חופשות` to `PERSONAL_VARIABLE_ROWS` OR change bot route to write `חופשות` directly. |
| F-07 | `רוביקון` bot category is `תחבורה`; plan §G says `רכב / תחבורה`. Wording drift between bot and plan. | Medium | Wording drift | `bot/ExpenseBot_FIXED.gs` + plan doc | Choose canonical name. Update plan to match bot OR rename bot field (the latter requires care — group is metadata not used by SUMIFS today). |
| F-08 | `רוביקון`, `BMW s1000`, `אבא` are absent from `lib/categories.js` and `lib/sheet-writer.js` template. They live ONLY in Steven's APPLY-appended rows. | High | Steven-only persistence gap | `lib/categories.js`, `lib/sheet-writer.js` (only after `קטגוריות` master tab ships) | Plan §E + §F: add `קטגוריות` master tab with these rows flagged `default_for_new_users=FALSE`. Until then, do NOT add to template (would scare new users). |
| F-09 | Bot routes `עורך דין` through biz `יועצים` only — no personal route. Steven's OLD sheet had a `עורך דין` row that probably mixed personal+biz legal. | Medium | Ambiguous mapping | `bot/ExpenseBot_FIXED.gs` | Steven decision: is personal lawyer ever an expense? If yes, add second route `{"keywords":["עורך דין אישי","עו\"ד אישי"],"category":"שונות ואחרים","subcategory":"עורך דין"}`. |
| F-10 | The 4 appended business duplicates (`עלות חומרי גלם`, `עלות שיווק`, `משלוחים והתקנות`, `הוצאות תפעוליות`) are noise — duplicates of existing wildcard rows | Low | Already detected | NEW `מאזן חברה` | **Already fixed in this session** — Steven ran CLEANUP_APPENDED → 4 business duplicates deleted per the prompt summary. **Verify with one fresh AUDIT run.** |
| F-11 | Bot has 348 keyword entries → 249 unique subcategories. Template has 38. ≈211 subcategories the bot can write that have no dashboard row at all → silent data loss for any tenant who triggers them. | High | Architectural | `lib/sheet-writer.js`, `bot/ExpenseBot_FIXED.gs` | This is exactly the problem `PERSONALIZED_CATEGORY_PROFILES.md` solves (3-layer architecture). Ship that, OR until then, run the migration's "append under banner" pattern per-user as new categories fire. |
| F-12 | `_DIFF_REPORT_` hidden tab — only created via `APPLY_DIFF_TO_TAB` (not the default DRY_RUN path). Diff text only exists in Apps Script log unless Steven explicitly runs APPLY. | Low | Tooling UX | n/a | Document in runbook. No code change. |
| F-13 | Migration tool uses SUMPRODUCT, not SUMIFS, to bypass Sheets' "2025-01" arithmetic parsing bug. Existing wildcard rows on company dashboard use SUMIFS. **Mixed formula styles in same dashboard.** | Medium | Formula heterogeneity | NEW `מאזן חברה` / `מאזן אישי` | Acceptable for now — SUMPRODUCT pattern is correct for the strict-text criterion case. Document the mixture so future audits don't try to "normalise" it. Plan §H Phase 2 dynamic formula generation will resolve. |
| F-14 | `_MDD_collectLabels_` skips rows with `סה`-prefix and `===` banners — correct. But it does NOT skip the migration's own `🏷️ מהגיליון הקודם` banner (would be re-collected if re-run). | Low | Re-run safety | `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` line 94-161 | Add `_MDD_BANNER_` to the skip set in `_MDD_collectLabels_`. One-line fix. |
| F-15 | `_MDD_ensureYearSelector_` sets default value to `YEAR(TODAY())` Jerusalem-local. If Steven manually picked 2024 then re-ran APPLY, the rerun would NOT change his value (correct). But the data validation list is `[2023..2030]` — if a future user wants 2031, it'll reject. | Low | Year selector range | `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` line 68 | Extend `_MDD_YEARS_` array to include further years OR make it dynamic. Phase 2. |

---

## 7. Recommended SAFE fixes (no APPLY)

All proposals here are READ-ONLY review artifacts. None modify OLD, none run APPLY scripts, none commit to main.

### 7.1 Fix list — purely additive bot keyword additions (low risk)

A single PR that adds 4 missing bot routes:

**File:** `bot/ExpenseBot_FIXED.gs` (CATEGORY_MAP, near line 401 where `אבא` lives)

Proposed additions (using the `bot-add-keyword` skill):

```javascript
{"keywords":["גיא","להעביר לגיא","העברה לגיא","דמי לגיא"],"category":"הוצאות זמניות","subcategory":"גיא"},
{"keywords":["חצי אירון","אירון מן","ironman","half ironman","triathlon","טריאתלון","אופניים תחרות"],"category":"בריאות","subcategory":"חצי אירון מן"},
{"keywords":["חצי אוסטריה","אוסטריה חופשה","austria trip","trip austria"],"category":"נסיעות","subcategory":"חצי אוסטריה"},
{"keywords":["קולקציות","src collection","srccollection","קולקציה חדשה"],"category":"עסק","subcategory":"קולקציות"},
```

Plus matching golden-set test rows (per `bot-add-keyword` skill).

### 7.2 New dry-run script — `bot/CATEGORY_GAP_AUDIT_DRY_RUN.gs`

A read-only Apps Script that, for each subcategory in `CATEGORY_MAP`, checks whether the NEW `מאזן אישי` + `מאזן חברה` have any row whose col-A label equals OR contains it. Logs misses. Same hard rules as `MIGRATE_DASHBOARD_FROM_OLD` (no writes, gated).

This is the natural sibling of `AUDIT_AND_CLEANUP_APPENDED.gs` but bot-oriented (vs sheet-oriented). Catches F-11 architectural drift earlier.

### 7.3 New docs — `docs/REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` (this file)

This document. Tracks the workstream output, severity-tagged, ready for inclusion in the executive report.

### 7.4 One-line bug fix — `_MDD_collectLabels_` should skip the migration banner

**File:** `bot/MIGRATE_DASHBOARD_FROM_OLD.gs` line ~108 area:

Current code (line 108):
```javascript
if (a.indexOf('שנת ') === 0) continue;       // "שנת 2024" banner
```

Proposed addition:
```javascript
if (a === _MDD_BANNER_) continue;                          // self-banner skip
if (a.indexOf('🏷️') === 0) continue;                        // emoji banner skip
```

Prevents the migration from re-collecting its own appended banner on re-run.

### 7.5 Confirm CLEANUP ran cleanly — one fresh AUDIT_APPENDED_ROWS

User's prompt says 4 business duplicates were deleted. Recommend Steven runs `AUDIT_APPENDED_ROWS` one more time and pastes the output to confirm:
- Personal banner: present, no duplicates
- Business banner: present, 4 business rows gone, only `מחזור` / `נטו` / non-duplicate biz rows remain
- No NO_MATCH rows left in personal block (or document which are intentionally kept for future bot writes)

### 7.6 Steven decision queue — to unblock APPLY of next phase

| Question | Recommendation |
|---|---|
| Is `קולקציות` biz or personal? | Biz — it's SRC Collection revenue line. Map to `category:"עסק", subcategory:"קולקציות"`, dashboard row in `מאזן חברה`. |
| Is `חופשות` standalone or under `נסיעות`? | Standalone — Steven's OLD sheet had it as own row, and it's a Pa'amonim category (`leisure` items list line 31). Add to `PERSONAL_VARIABLE_ROWS`. |
| Is `ארנונה` a row or rolled into `בית`? | Own row — Pa'amonim says so (line 97 in `categories.js`). Add to `PERSONAL_FIXED_ROWS`. |
| `רוביקון` group: `תחבורה` (bot) or `רכב/תחבורה` (plan §G)? | `תחבורה` — simpler, matches bot today, dashboard SUMIFS doesn't care about group, only subcategory string. Update plan to match. |
| `נשר + חופים` renamed to `כושר + תוספים`? | Confirmed in `PERSONALIZED_CATEGORY_PROFILES.md` ¶3 — already maps to `מכון כושר`. **No action.** |

---

## Executive summary (5 bullets to paste into the parent agent's report)

1. **Bot CATEGORY_MAP gaps for 4 Steven-only categories: `גיא`, `חצי אירון מן`, `חצי אוסטריה`, `קולקציות`.** Today the bot silently falls back to `שונות` for these. Critical for `גיא` and `חצי אירון מן` because Steven's audit log shows zero matches on those labels in NEW `תנועות` col E even though OLD history should have them. Recommended fix: 4 additive `CATEGORY_MAP` entries, no removals — purely safe.

2. **`רוביקון` is correctly mapped in the bot CATEGORY_MAP (line 394, `תחבורה/רוביקון`) and exists in Steven's `מאזן אישי` row 78 post-APPLY**, but is absent from `lib/categories.js` and `lib/sheet-writer.js` template — this is INTENTIONAL per plan §G (`default_for_new_users=FALSE`) until the `קטגוריות` master tab ships. **One wording drift to note:** bot says `category="תחבורה"`, plan §G says `group="רכב / תחבורה"` — choose one and propagate.

3. **Three Steven categories the bot routes incorrectly: `ארנונה` writes `"ארנונה - ערים נוספות"` (no template row), `חופשות` writes `נסיעות` (no template row), `קולקציות` writes `שונות`.** These are template-side gaps, not bot-side — addressable by adding 2 rows to `PERSONAL_FIXED_ROWS` + 1 to `PERSONAL_VARIABLE_ROWS` (`ארנונה`, `חופשות`) and deciding `קולקציות` placement. **Coordinate section-total formula updates (e.g. `SUM(B16:B27)` would shift).**

4. **The architectural gap is large but contained:** 249 unique bot subcategories vs 38 template rows = ~211 subcategories that can be written but never summed in a fresh tenant's dashboard. For Steven specifically, `MIGRATE_DASHBOARD_FROM_OLD` APPLY already patched this by appending OLD-only labels under the "🏷️ מהגיליון הקודם" banner. The 4 business duplicates were rightly identified and removed by `CLEANUP_APPENDED` (per prompt summary). For new users, the long-term solution is the `PERSONALIZED_CATEGORY_PROFILES.md` 3-layer architecture — until that ships, the same migration tooling needs to fire per-tenant on demand.

5. **Recommended next ship — single PR, purely additive, no APPLY needed:** (a) Add the 4 missing `CATEGORY_MAP` keyword entries above. (b) Fix the one-line re-run safety bug in `_MDD_collectLabels_` to skip the migration's own banner. (c) Commit this workstream report to a new branch as a draft PR — no merge until Steven approves the 5 decision-queue questions above. **No writes to OLD. No APPLY runs. No main commits.**
