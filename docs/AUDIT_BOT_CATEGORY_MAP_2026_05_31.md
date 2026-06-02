# Bot CATEGORY_MAP completeness — 2026-05-31

Audit-only. Cross-references `bot/ExpenseBot_FIXED.gs` `CATEGORY_MAP` (line 271, ~353 routes) against Steven's 23 historical categories from `docs/PERSONALIZED_CATEGORY_PROFILES.md` §8 and the default NEW dashboard template in `lib/sheet-writer.js` (`PERSONAL_*_ROWS` + `COMPANY_EXPENSE_ROWS`, lines 55-126).

Dashboard SUMIFS pattern (`lib/sheet-writer.js:246`):
```
=SUMIFS(תנועות!C:C, B:B, $B$2&"-MM", E:E, "*"&$A{row}&"*")
```
Substring match — the dashboard row label must be CONTAINED in (or contain) what the bot writes to col E (subcategory).

## Summary

- **23 Steven categories audited.**
- **Routing gaps: 1** — `נשר + חופים` legacy keyword not in bot (Steven renamed to `כושר + תוספים`, only the renamed form is routed via `מכון כושר` keyword bundle).
- **Dashboard gaps: 9** — Steven-specific subcategories the bot WRITES (`אבא`, `גיא`, `BMW s1000`, `רוביקון`, `קולקציות`, `חצי איירון מן`, `מרוץ - אוסטריה`, `אישי`, `קורקינט`) have no matching default dashboard row. By design new users don't get these; for Steven, the migration script under `docs/PERSONALIZED_CATEGORY_PROFILES.md` §11.1 Phase C must seed them in the `advanced_imported` preset.
- **Privacy leaks: 0** — no Steven-personal strings (אבא, גיא, BMW, רוביקון, קולקציות, חצי איירון, אוסטריה, בנק הפועלים, תוספי תזונה) found in `lib/sheet-writer.js` default template.
- **Composite gap: 1** — bot's "אישי" subcategory route at line 427 (`{"keywords":["אישי"]…}`) is dangerously broad — every Hebrew message containing "אישי" anywhere (e.g. "אימון אישי", "ביטוח אישי") risks misroute. Already mitigated by ordering (more specific routes win first), but worth flagging.

## Matrix

| # | Steven category | Bot CATEGORY_MAP route | NEW default dashboard row | Gap | Severity |
|---|---|---|---|---|---|
| 1 | הוצאות בית | yes — keyword `ארנונה` → cat `הוצאות קבועות` sub `בית` (line 431, 527) | yes — `'בית'` in `PERSONAL_FIXED_ROWS` | none | — |
| 2 | נשר + חופים (→ כושר + תוספים) | partial — renamed form via `מכון כושר` keyword (line 414) maps to sub `מכון כושר`; legacy `נשר`/`חופים` only present as עיר/חוף keywords | yes — `'מכון כושר'` in `PERSONAL_FIXED_ROWS` | bot lacks `נשר + חופים` literal as historical alias | low |
| 3 | אוכל | yes — sub `אוכל לבית` / `אוכל בחוץ` (lines 362-363, 390-391) | yes — `'אוכל לבית'`, `'אוכל בחוץ'` in `PERSONAL_FOOD_ROWS` | none | — |
| 4 | קולקציות | yes — sub `קולקציות` cat `תחביבים` (line 410) | NO — no `'קולקציות'` row, no `'תחביבים'` section in default template | dashboard | high (for Steven) |
| 5 | כבלים אינטרנט פלאפון | yes — sub `תקשורת` (line 434) | yes — `'תקשורת'` in `PERSONAL_FIXED_ROWS` | none | — |
| 6 | לימודים | yes — sub `לימודים` (line 426) | yes — `'לימודים'` in `PERSONAL_FIXED_ROWS` | none | — |
| 7 | ביטוח אישי | yes — sub `ביטוח אישי` (line 448) | yes — `'ביטוח אישי'` in `PERSONAL_FIXED_ROWS` | none | — |
| 8 | אבא | yes — keyword `להעביר לאבא` → sub `אבא` (line 401) | NO — no `'אבא'` row in default template (correctly so) | dashboard for Steven | high (for Steven) |
| 9 | בדיקות | partial — `בדיקת דם`, `בדיקה רפואית` → sub `בריאות` (line 364, 436) | yes — `'בריאות'` in `PERSONAL_MISC_ROWS` | none (rolls into `בריאות`) | — |
| 10 | טיפולים | yes — sub `טיפוח` via various keywords (line 365, 416) | yes — `'טיפוח'` in `PERSONAL_MISC_ROWS` | none | — |
| 11 | חברה / מ"ה / ב"ל | yes — sub `הוצאות תפעוליות` (lines 286, 296-298), all business taxes routed via business map | yes — `'🏢 הוצאות תפעוליות'` in `COMPANY_EXPENSE_ROWS` | none | — |
| 12 | ביטוח חובה+ג׳+איתורן | yes — sub `ביטוח רכב` (line 398, 366) | yes — `'ביטוח רכב'` in `PERSONAL_TRANSPORT_ROWS` | none | — |
| 13 | טסט רכב | yes — sub `רישוי` (line 400) | NO — no `'רישוי'` row in `PERSONAL_TRANSPORT_ROWS` (only `'אחזקת רכב'`, `'מוסך'`) | dashboard | medium |
| 14 | חניונים | yes — sub `חניה` (line 395) | yes — `'חניה'` in `PERSONAL_TRANSPORT_ROWS` | none | — |
| 15 | מים | yes — sub `מים` (lines 321, 432) | yes — `'מים'` in `PERSONAL_FIXED_ROWS` | none | — |
| 16 | BMW | yes — sub `BMW s1000` (line 397) | NO — no `'BMW'` row in default template | dashboard for Steven | high (for Steven) |
| 17 | דלק | yes — sub `דלק` (line 392) | yes — `'דלק'` in `PERSONAL_TRANSPORT_ROWS` | none | — |
| 18 | אוכל/מזון/רכבת | yes — generic food + תחבורה routes work; no special bundle | yes — splits across `אוכל` + `תחבורה ציבורית` | none (already split) | — |
| 19 | חצי אירון מן | yes — sub `חצי איירון מן` cat `הוצאות זמניות` (line 412) | NO — no `'חצי איירון מן'` row | dashboard for Steven | high (for Steven) |
| 20 | אוסטריה | yes — sub `מרוץ - אוסטריה` (line 413); also `נסיעות` (line 451) | NO — no `'אוסטריה'` row; `'חופשות'` in `PERSONAL_VARIABLE_ROWS` won't substring-match `מרוץ - אוסטריה` | dashboard for Steven | high (for Steven) |
| 21 | עורך דין | yes — sub `יועצים` (line 289); also sub `מיסים ואגרות` (line 450) | partial — business `יועצים` rolls into `'🏢 הוצאות תפעוליות'` company row; personal עו"ד rolls into `'שונות'` | dashboard | low (rolls up acceptably) |
| 22 | בנק הפועלים | yes — sub `בנקאות` (line 446) | yes — `'בנקאות'` in `PERSONAL_FIXED_ROWS` | none | — |
| 23 | גיא | yes — sub `גיא` cat `הוצאות זמניות` (line 411) | NO — no `'גיא'` row in default template (correctly so) | dashboard for Steven | high (for Steven) |

## Additional bot-write categories that have no default dashboard row

These are CATEGORY_MAP routes the bot may emit but have no matching `PERSONAL_*_ROWS` label, so the dashboard renders ₪0 even when the bot writes the row correctly to `תנועות`:

| Bot subcategory written | Source line | Closest default row | Routing OK? | Dashboard captures it? |
|---|---|---|---|---|
| `רוביקון` | 394 | `'אחזקת רכב'` | yes | NO |
| `BMW s1000` | 397 | `'אחזקת רכב'` | yes | NO (substring "BMW" not in row label) |
| `רישוי` | 400 | none | yes | NO |
| `קורקינט` | 399 | none | yes | NO |
| `רכב שכור` | 445 | none | yes | NO |
| `אבא` | 401 | none | yes | NO |
| `גיא` | 411 | none | yes | NO |
| `קולקציות` | 410 | none (no `תחביבים` section) | yes | NO |
| `חצי איירון מן` | 412 | none | yes | NO |
| `מרוץ - אוסטריה` | 413 | none (`'חופשות'` is exact-substring, won't match) | yes | NO |
| `אישי` | 427 | none | yes (but dangerously broad keyword) | NO |
| `פלייסטיישן` | 418 | none | yes | NO (probably rolls into `'אפליקציות'` if subcategory contained "אפליקציות") |
| `אפולו` | 420 | none | yes | NO |
| `לוטו` | 419 | none | yes | NO |

## Gaps

### Routing gaps (bot lacks the keyword route)

Only one real routing gap — the legacy name Steven used pre-2024:

- **Category `נשר + חופים`**: today only the renamed form `כושר + תוספים` routes (via `מכון כושר` keyword bundle at line 414). If Steven types a HISTORICAL string like `נשר חופים` describing past entries, it falls through to `שונות`.
  - Suggested CATEGORY_MAP line (insert after line 414):
    ```json
    {"keywords":["נשר","נשר חופים","חופים","נשר + חופים","נשר וחופים"],"category":"הוצאות קבועות","subcategory":"מכון כושר"}
    ```
  - Severity: low — only relevant if Steven imports old free-text from his memory; new writes use the renamed form.

### Dashboard gaps (sheet template lacks row)

For the **default** template that ships to new users, NONE of these gaps should be filled — the design (`docs/PERSONALIZED_CATEGORY_PROFILES.md` §7) deliberately keeps the default lean (Basic Personal = 15 rows).

For **Steven's** `advanced_imported` migration (§7.6), the migration script must seed these rows into his Layer 2 `User_Category_Profile` (not into `lib/sheet-writer.js` constants). Phase C — `api/admin/migrate-steven.js` per §11.1 — is the right place:

- **Section `🚗 תחבורה`** add rows: `BMW s1000`, `רוביקון`, `רישוי`, `קורקינט`, `רכב שכור`
- **Section `⚡ הוצאות זמניות`** add rows: `אבא`, `גיא`, `חצי איירון מן`, `מרוץ - אוסטריה`, `אישי`
- **NEW section `🎨 תחביבים`** add: `קולקציות`
- **Section `🎁 שונות ואחרים`** add: `אפולו`, `לוטו`, `פלייסטיישן` (or roll into `'אפליקציות'`)

Severity ranking for Steven's sheet:
- **high**: `BMW s1000`, `רוביקון`, `אבא`, `גיא`, `קולקציות`, `חצי איירון מן`, `מרוץ - אוסטריה` — these are HIS named categories Steven explicitly listed; bot already writes them, dashboard silently swallows.
- **medium**: `רישוי`, `אישי`, `אפולו`, `לוטו` — present in bot routes, rare frequency in Steven's history.
- **low**: `קורקינט`, `רכב שכור`, `פלייסטיישן` — bot routes exist, near-zero historical usage for Steven.

### Privacy leaks (Steven-personal strings in default template)

NONE FOUND. Grepped `lib/sheet-writer.js` for: `אבא`, `גיא`, `BMW`, `רוביקון`, `קולקציות`, `חצי איירון`, `אוסטריה`, `בנק הפועלים`, `תוספי תזונה`, `נשר חופים`. Zero matches outside of generic words.

The only overlap is `'מכון כושר'` in `PERSONAL_FIXED_ROWS` line 66 — but this is a Pa'amonim-standard category, not Steven-personal. Safe.

The only overlap is `'חופשות'` in `PERSONAL_VARIABLE_ROWS` line 81 — but this was a 2026-05-29 deliberate addition (per the comment block at lines 70-79), universal not personal. Safe.

### Bonus finding — broad-keyword risk

Bot line 427: `{"keywords":["אישי"],"category":"שונות ואחרים","subcategory":"אישי"}` is dangerously generic.

Hebrew text frequently contains "אישי" as part of compound words: `אימון אישי`, `ביטוח אישי`, `מאמן אישי`, `מטפלת אישית`. Today this is mitigated by ordering — more specific routes (e.g. `ביטוח אישי` line 448 — actually no, line 448 doesn't have it as a keyword!) win at the regex level. Verified manually:
- "מאמן אישי" → matches `אימון אישי` keyword in line 317 (`בריאות / ספורט ותוספים`), which appears BEFORE line 427 (`אישי`). OK.
- "ביטוח אישי" → keyword "ביטוח" alone is NOT in line 448's keywords; relies on positional ordering. Risk: if a user types just "ביטוח אישי 500" with no insurer brand, may fall through to "אישי".

Recommendation: replace `"אישי"` with anchored variants like `"הוצאה אישית"`, `"קניה אישית"` — but verify no regression in golden_set first.

## Recommendations

Numbered list of safe PRs to ship:

1. **PR-A (low risk, ship now)**: add legacy `נשר + חופים` keyword route to CATEGORY_MAP for Steven's historical free-text. Add matching `golden_set.js` entry. Run `tests/full_qa.js` to confirm no regression.

2. **PR-B (audit-only, no code)**: confirm with Steven that the 11 "dashboard gap" subcategories the bot writes are intentionally **invisible** on new-user dashboards (per `advanced_imported` preset isolation). No code change — just a one-line confirmation in `docs/PERSONALIZED_CATEGORY_PROFILES.md` §8 footnote.

3. **PR-C (Steven-only, medium risk)**: implement `api/admin/migrate-steven.js` per `PERSONALIZED_CATEGORY_PROFILES.md` §11.1 Phase C, seeding the 12 missing Steven dashboard rows into his Layer 2 profile + a new `🎨 תחביבים` section header. Backup first, dry-run first, then apply. Use `bot-self-heal` cron to re-verify post-apply.

4. **PR-D (defensive)**: replace bot line 427's bare `"אישי"` keyword with anchored variants `"הוצאה אישית"`, `"קניה אישית"`, `"אישית פרטית"`. Add golden_set entries for each. Verify no regression in 1,480 existing routes.

5. **PR-E (forward-looking)**: when the Layer 1 `קטגוריות` master tab lands (per §3), add a unit test `tests/test_bot_subcat_to_dashboard_row.js` that asserts EVERY subcategory the bot can emit has either (a) a matching default dashboard row label as substring, or (b) `dashboard_section='historical_personal'` in the master library (i.e. intentionally Steven-only). This makes future bot/dashboard drift impossible to ship silently.

---

*End of audit. Report path: `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/docs/AUDIT_BOT_CATEGORY_MAP_2026_05_31.md`*
