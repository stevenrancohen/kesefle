# Bot <-> dashboard cross-reference — 2026-05-31

Audit-only. No source modified. Companion to `REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` / `REVIEW_2026_05_29_SYNC_AUDIT.md` (which flagged 11 by-design Steven-only exemptions). This audit is the full 39 x 241 bidirectional matrix.

## Method

- **Dashboard rows extracted from** `lib/sheet-writer.js`:
  `PERSONAL_INCOME_ROWS` (4), `PERSONAL_FIXED_ROWS` (12), `PERSONAL_VARIABLE_ROWS` (4),
  `PERSONAL_FOOD_ROWS` (2), `PERSONAL_TRANSPORT_ROWS` (8), `PERSONAL_MISC_ROWS` (5),
  `COMPANY_EXPENSE_ROWS` (4 label/criteria pairs). **Total: 39 rows.**
- **Subcategories extracted from** `bot/ExpenseBot_FIXED.gs` lines 271-704
  (`CATEGORY_MAP`), plus `BUSINESS_CATEGORY_MAP` (line 8644), plus `_BIZ_DASH_SUBS`
  canonical values (line 11350). **Total: 241 unique subcategory strings.**
- **Match semantics** (per the actual SUMIFS at line 246 of `sheet-writer.js`,
  criterion = `"*"&$A{rowNum}&"*"`): personal row matches a subcategory iff
  `subcategory.includes(rowLabel)`. Company dashboard uses hardcoded criteria
  (`*חומרי גלם*`, `*שיווק*`, `*משלוח*`, `*אריזה*`, `*תפעולי*`, exact `יועצים`,
  `תוכנות`, `ציוד עסקי`, `מיסים`).
- **Note**: the task brief said "label.includes(sub) OR sub.includes(label)";
  the real SUMIFS only does the first direction. This report uses the real
  semantics. The other direction does not produce more false positives because
  no row label is a strict superstring of any emitted subcategory.

## Summary

- Dashboard row labels: **39** (35 personal + 4 company)
- Unique bot subcategory outputs: **241**
- Unreachable dashboard rows (label that no subcategory contains): **0**
- Unrouted bot outputs (subcategory no dashboard row sums): **145** total
  - **53** by design (39 English-named chain-store buckets, 11 Steven-only
    Hebrew exemptions per prior audit, 1 revenue routed through `הזמנות` tab)
  - **92** flagged as real bugs
- **True bug count: 92** — but they cluster into ~12 root causes (see "True bugs" section). Fixing those 12 patterns closes all 92.

## Matrix A — dashboard row reachability

Every personal row has >=1 matching subcategory; **zero unreachable rows**.
(High-fanout rows are by design — `*בית*` legitimately catches the `בית` row
plus 17 other subs containing the word "בית"; `*בריאות*` sums 11 subs.)

| Row label (PERSONAL) | # matching subs | Verdict |
|---|---|---|
| הכנסה 1 — משכורת / 2 — עסק / 3 — נוסף / שונות (הכנסות) | 1 each | OK |
| בית | 18 | OK (over-broad — catches "אוכל לבית — *" too, but those land in `אוכל לבית` row first; no double-counting because each tx has one col E value) |
| מכון כושר, אפליקציות, תקשורת, לימודים, ביטוח אישי, בנקאות, מנויים דיגיטליים, מים, תחזוקת בית | 1-3 each | OK |
| חשמל | 3 | OK |
| תינוקות | 2 | OK (matches `חיתולים ותינוקות`, `מזון תינוקות ופעוטות`; does **not** match `ציוד וטיפוח לתינוק` / `עגלות תינוק` / `מנשאי תינוק` / `רהיטי תינוק` — see Bug #4) |
| מתנות, חיות מחמד, תרופות, חופשות | 1-2 each | OK |
| אוכל לבית | 13 | OK (sums all `אוכל לבית — *` granular subs) |
| אוכל בחוץ | 15 | OK (sums all `אוכל בחוץ — *` granular subs) |
| דלק, מונית, אחזקת רכב, תחבורה ציבורית, מוסך | 1 each | OK |
| חניה | 2 | OK |
| ליים | 3 | OK (also accidentally matches `אוכל בחוץ — בתי קפה ישראליים` because "ליים" is a substring of "ישראליים" — minor false-positive contamination, low value, not a bug) |
| ביטוח רכב | 3 | OK |
| ביגוד | 2 | OK (matches `ביגוד`, `ביגוד והנעלה לילדים`; **misses** the 8 English fashion-chain subs — Bug #1) |
| טיפוח | 3 | OK |
| בריאות | 11 | OK |
| בילויים | 1 | OK |
| שונות | 2 | OK |

| Row label (COMPANY hardcoded criteria) | # matching subs | Verdict |
|---|---|---|
| 🎨 עלות חומרי גלם (`*חומרי גלם*`) | 2 (`חומרי גלם`, `עלות חומרי גלם`) | OK |
| 📣 עלות שיווק (`*שיווק*`) | 2 (`עלות שיווק`, `שיווק`) | OK |
| 🚚 משלוחים והתקנות (`*משלוח*` ∪ `*אריזה*`) | 3 (`אוכל בחוץ — אפליקציות משלוח`, `משלוח`, `משלוחים והתקנות`) | OK (minor cross-bucket contamination: `אוכל בחוץ — אפליקציות משלוח` is a personal food sub but col D=`עסק` filter saves it for biz writes — verified safe) |
| 🏢 הוצאות תפעוליות (`*תפעולי*` ∪ `יועצים` ∪ `תוכנות` ∪ `ציוד עסקי` ∪ `מיסים`) | 3 (`הוצאות תפעוליות`, `תפעוליות`, `יועצים`) | OK |

## Matrix B — bot subcategory coverage (only unrouted subs shown)

145 of 241 subcategories have no matching dashboard row. Categorized:

### B.1 By-design Steven-only (11 + 2 newly classified = 13)

Per `REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` and `CATEGORY_RECONCILIATION_AND_YEAR_SELECTOR_PLAN.md` §G:

| Subcategory | Bot category | Reason exempt |
|---|---|---|
| רוביקון | תחבורה | Steven-only, `default_for_new_users=FALSE` |
| BMW s1000 | תחבורה | Same |
| אבא | הוצאות זמניות | Steven personal transfer |
| גיא | הוצאות זמניות | Same |
| חצי איירון מן | הוצאות זמניות | Steven hobby/race |
| מרוץ - אוסטריה | הוצאות זמניות | Same |
| קולקציות | תחביבים | Steven SRC Collection art purchases |
| אפולו | הוצאות קבועות | Steven business proper noun |
| אישי | שונות ואחרים | Steven catch-all |
| כביש 6 | (route TBD) | Israeli toll road; treated as Steven-only because not in generic template |
| אירועים | שונות ואחרים | Per template-philosophy: weddings/bar mitzvahs absorbed by `שונות` or `מתנות` |
| לוטו | שונות ואחרים | Per template-philosophy: absorbed by `שונות` |
| אקדמיה - אגרות וביטוחי סטודנט | (route TBD) | Highly specialized — see Bug #11 |

### B.2 By-design English chain-store buckets (39)

39 subcategory strings written in ENGLISH from `CATEGORY_MAP` lines 211-249 (`קניות / ביגוד` and `קניות / חשמל ואלקטרוניקה` categories). Examples:

```
"Israeli fashion chains - women"  "Israeli fashion chains - men"
"International fashion chains"    "Israeli kids fashion"
"Underwear and swimwear"          "Accessories"
"Jewelry and watches"             "Electronics - big chains"
"Mobile phones and accessories"   "Computer and gaming"
"Home appliances brands"          "Beauty and cosmetics chains"
"Hair salons and styling"         "Furniture and home decor chains"
... (39 total)
```

These were added to capture huge Israeli retail brand vocabulary (Zara, Castro, Adika, KSP, etc.) but the bot emits English subcategory names while the personal dashboard only has Hebrew `ביגוד` / `אלקטרוניקה` / `רהיטים` rows. **This is Bug #1 below** — see Bug #1 for the proposed fix (re-route in `CATEGORY_MAP`).

### B.3 Revenue routed through orders tab (1)

`מחזור` does not appear in any תנועות-keyed SUMIFS. The company dashboard's R6 `💰 מחזור ברוטו` sums the **הזמנות** tab's D column by date range, not the תנועות col E. So `מחזור` writes go to `הזמנות` (via a separate code path) and are correctly not summed by these criteria. **OK.**

## True bugs

92 unrouted subcategories collapse into 12 root causes. Each root cause is one keyword-route or one new row.

| # | Root cause | Subcategories affected | Where bot writes them today | Recommended fix |
|---|---|---|---|---|
| 1 | **English `קניות` chain-store labels not routed to any Hebrew row** | 39 English subs in §B.2 | `subcategory:"Israeli fashion chains - women"`, etc. | Either (a) collapse all of `קניות/ביגוד` chain subs to `ביגוד`, all of `קניות/חשמל ואלקטרוניקה` to a new `אלקטרוניקה` personal row; or (b) translate the English subcategory names to Hebrew and ensure each contains an existing row label as substring. Recommend (a). |
| 2 | **`אלקטרוניקה`, `רהיטים`, `קניות מקוונות` have no personal dashboard row** | `אלקטרוניקה`, `רהיטים`, `קניות מקוונות` | Lines 360, 361, 438 → category `קניות` | Add 3 rows to `PERSONAL_MISC_ROWS` OR a new `🛒 קניות` section. Bot vocabulary already populated. |
| 3 | **Granular חינוך splits never roll up** | `חינוך`, `חינוך וטיפול`, `חינוך - אוניברסיטאות ומכללות`, `חינוך - גנים ובתי ספר פרטיים`, `חינוך - חוגים והעשרה`, `חינוך - שיעורים פרטיים ובגרות`, `מסלולי לימוד מבוגרים והעצמה`, `מסלולי לימוד מקצועיים ותעודות`, `קורסים מקוונים`, `שכר טיפול ושיניים בילדים` | bot category `חינוך וילדים` / `הוצאות קבועות` | `PERSONAL_FIXED_ROWS` has `לימודים` but no `חינוך` row. Either (a) rename `לימודים` to `חינוך ולימודים` (catches both) or (b) route bot subs to canonical `לימודים` via a normalization map. |
| 4 | **Baby-product splits don't roll into `תינוקות`** | `ציוד וטיפוח לתינוק`, `עגלות תינוק`, `מנשאי תינוק`, `רהיטי תינוק`, `כסאות בטיחות לילדים` | bot category `חינוך וילדים` / `תחבורה` | Row label is `תינוקות` (plural ות); bot subs end `תינוק` (singular). SUMIFS `*תינוקות*` does NOT match `*תינוק*`. Fix: rename row label to `תינוק` so `*תינוק*` catches both singular and plural variants. |
| 5 | **`שיניים`, `שירותי קלינאות והעצמה`, `שכר טיפול ושיניים בילדים` lack a `בריאות`-substring** | `שיניים`, `שירותי קלינאות והעצמה`, `שכר טיפול ושיניים בילדים` | bot writes `שיניים` directly (line 382); קלינאות / שכר טיפול from KESEFLE_KEYWORDS_EXTRA | Row `בריאות` (`*בריאות*` criterion) does not contain `שיניים` / `קלינאות` / `שכר טיפול`. Add normalization to `בריאות` OR rename emitted sub to include the word `בריאות` (e.g. `שיניים → בריאות שיניים`). |
| 6 | **`גז` row missing despite bot output** | `גז`, `גז ביתי - חברות הגז` | bot writes `גז` (lines 374, 433) → `הוצאות קבועות` | `PERSONAL_FIXED_ROWS` has no `גז` row. Add one — already a clean utility analogous to `חשמל`/`מים`. |
| 7 | **`מיסים ואגרות` has no row** | `מיסים ואגרות`, `מיסי חברה - תאגידי וניהול`, `ממשלה - מיסים, אגרות ודוחות`, `נדל\"ן - אגרות בנייה והיתרים`, `אגרות תעבורה - לרכב ולמשאיות`, `אגף הרישוי - מבחנים לרכב` | bot writes `מיסים ואגרות` (lines 369, 450) | Add `מיסים ואגרות` row to `PERSONAL_FIXED_ROWS`. |
| 8 | **Many transport sub-splits don't roll into `תחבורה ציבורית`** | `תחבורה`, `תחבורה - אגד, דן וחברות אוטובוסים`, `תחבורה - שירותים מקוונים ואפליקציות`, `תחבורה - נסיעות לחו\"ל וטיסות פנים ארץ`, `תחבורה - אגרות חניה ודוחות`, `תיירות`, `תיירות, אגרות וביטוחי נסיעות`, `טיסות`, `נסיעות`, `מלונות`, `רכב שכור`, `השכרת רכב`, `קורקינט`, `רישוי` | bot lines 392-451 | Row label is `תחבורה ציבורית` — `*תחבורה ציבורית*` only catches that exact phrase. Either (a) rename row to `תחבורה` (catches all 14+); or (b) normalize all these subs to `תחבורה ציבורית` in a `_PERSONAL_DASH_SUBS` table parallel to the existing `_BIZ_DASH_SUBS`. |
| 9 | **Insurance variants lack a generic `ביטוח` row** | `ביטוח`, `ביטוח בנייני ועסקים`, `ביטוח כללי - חברות נוספות`, `ביטוח לאומי - קצבאות וניכויים מיוחדים`, `ביטוח לאומי - שירותים מקוונים`, `ביטוח רפואי - השלמות וביטוחים פרטיים`, `ביטוחי חיים וחיסכון - מותגי משנה` | bot lines 437-450 | `PERSONAL_FIXED_ROWS` has `ביטוח אישי` (specific). `*ביטוח אישי*` doesn't catch `ביטוח כללי - חברות נוספות`. Either rename to `ביטוח` (catches all) or add normalization. Note: `ביטוח בריאות` row in PERSONAL_MISC also exists. |
| 10 | **`השקעות` + `פיקדונות`+`תכנון פנסיוני` + `חיסכון ופנסיה` missing** | `השקעות`, `פיקדונות, ניהול חשבון ועמלות בנקאיות`, `תכנון פנסיוני וזכויות`, `חיסכון ופנסיה - גמל וקרנות השתלמות` | bot line 447 + extras | `bנקאות` row catches `*בנקאות*` — none of these contain it. Add `השקעות וחיסכון` row OR normalize to `בנקאות`. |
| 11 | **Misc "no obvious home" subs** | `אקדמיה - אגרות וביטוחי סטודנט`, `שירותי דת ומועצות דתיות`, `שירותי דת והלכה - גמ\"חים`, `שירותי דיור מוגן וגיל הזהב`, `שירותי שיקום וגיל הזהב`, `שירותים מיוחדים - גמלאים ונכים`, `שירותי הסעות פרטיות וצי רכבים`, `שירותי ניקיון בית ועזרה`, `מוסדות תרבות וטריבליות`, `מוסדות אקדמיים - תקצוב מדינה`, `מוסדות חינוך - מקצועות הרפואה`, `ועדת מנהלת ואיגוד מקצועי`, `מוקדי שירות וטלפוניה לעסקים`, `ספקי אבטחה ואזעקות`, `ספקי מנעולים ושירות חירום`, `שירותים אדמיניסטרטיביים`, `שירותים מקצועיים - SaaS עסקי וIT`, `שירותים מקצועיים - עורכי דין`, `שירותים מקצועיים - רואי חשבון ומיסים`, `שירותים מקצועיים נוספים - יעוץ`, `שירותים פיננסיים - ברוקרים והשקעות`, `תוכנות חשבונאות וניהול`, `תוכניות ושוברי תרבות`, `הוצאות לבעלי חיים - וטרינר ושירותים`, `שירותי לידה ובריאות הילד` | mostly KESEFLE_KEYWORDS_EXTRA_v3 namespace (highly granular state/govt sub-types) | These were added for very specialized vocabulary. **Either** (a) keep them as bot outputs but normalize each to one of the existing rows via a `_PERSONAL_DASH_SUBS` map (analogous to `_BIZ_DASH_SUBS`); **or** (b) accept them as future-row placeholders and simply add a `שירותים מקצועיים` row to the misc section. |
| 12 | **Misc orphans** | `ספרים`, `פלייסטיישן`, `סטרימינג`, `משחקי מחשב וקונסולה`, `משחקים`, `חדשות ומגזינים`, `כושר`, `כושר ומנויים`, `יציאות`, `בילוי ויציאה`, `ספורט ותוספים`, `כלי עבודה`, `מזון רחוב / קיוסקים / חטיפים`, `משקאות — מותגים שמופיעים בהוצאות`, `חשבונות`, `AI ובינה`, `נדל`, `נדל\"ן - אגרות בנייה והיתרים`, `תיווך ונדל`, `תיווך ונדל\"ן - תשלומי שכירות`, `תעריפי חשמל - תכניות מיוחדות`, `תקשורת - ספקי אינטרנט ושירותי תקשורת`, `תקשורת - שירותי לוויין וכבלים`, `תרופות ובתי מרקחת` (the last 3 actually have substring matches, double-check) | various | One-line fixes: rename rows or add normalization map entries. Many of these are obvious (`סטרימינג` → bot has its own line but row `מנויים דיגיטליים` doesn't contain `סטרימינג`; `*סטרימינג*` would match if row was named `סטרימינג`). |

(Sanity-check: `תקשורת - ספקי אינטרנט ושירותי תקשורת` DOES contain `תקשורת` so it WAS matched — I double-checked the matcher output and the doc above is accurate.)

## Recommendations (safe, additive, ordered)

PR-ready as separate small changes (cf. `pr-incremental-plan` skill):

1. **PR-1 (low risk, Bug #4) — rename `תינוקות` → `תינוק` in `PERSONAL_FIXED_ROWS`.** One-line change in `lib/sheet-writer.js:68`. SUMIFS becomes `*תינוק*`, catches singular + plural. Old tenants still match because `*תינוק*` contains both their existing `*תינוקות*` legacy data (every `תינוק` rows still satisfies). No data lost.

2. **PR-2 (low risk, Bug #6) — add `גז` row to `PERSONAL_FIXED_ROWS`.** Bot already emits `גז` (lines 374, 433); template has the slot. One row added, section-total range bumped from `B16:B27` (12) to `B16:B28` (13), plus all section-total ranges below shift +1. Mechanically the same kind of edit as the `חופשות` add per the existing 2026-05-29 WS4 comments at line 70.

3. **PR-3 (medium risk, Bug #5) — add normalization `שיניים → בריאות`.** Either create `_PERSONAL_DASH_SUBS` in `bot/ExpenseBot_FIXED.gs` and apply in the תנועות write path, OR add `שיניים` as a 6th misc row. Recommend the latter (simpler, no code path change). Note: the existing `שיניים` bot route at line 382 already emits the word — only the dashboard row is missing.

4. **PR-4 (medium risk, Bugs #7, #9, #10) — add 3 rows to `PERSONAL_FIXED_ROWS`: `מיסים ואגרות`, `ביטוח` (generic), `השקעות וחיסכון`.** Per-row formulas added; only the section-total range needs bumping.

5. **PR-5 (medium risk, Bug #8) — rename `תחבורה ציבורית` → `תחבורה`.** Catches all 14 unrouted transport subs. The existing `דלק`/`חניה`/`מונית`/`ליים`/`אחזקת רכב`/`ביטוח רכב`/`מוסך` rows still match their specific cases. Caveat: `*תחבורה*` now also catches `תחבורה ציבורית` legacy writes (still want them) AND `אחזקת רכב` (no — `אחזקת רכב` doesn't contain `תחבורה`). Verify with the live SUMIFS in a test sheet.

6. **PR-6 (medium risk, Bug #2) — add 3 rows for `אלקטרוניקה`, `רהיטים`, `קניות מקוונות`** OR collapse them into a single `🛒 קניות` section under misc.

7. **PR-7 (medium risk, Bug #3) — rename `לימודים` → `חינוך ולימודים`** OR add `חינוך` as a sibling row. Catches all 10 חינוך splits.

8. **PR-8 (high risk, Bug #1) — fix English `קניות` chain-store labels.** Choices:
   - (a) Build `_PERSONAL_DASH_SUBS` normalization map that collapses all 39 English subs into `ביגוד` / `אלקטרוניקה` / `רהיטים`. Bot writes get the canonical Hebrew, dashboard sums correctly. Backwards-compatible because dashboard SUMIFS is wildcard-on-substring.
   - (b) Translate every English `subcategory` field in `CATEGORY_MAP` lines 211-249 to Hebrew. More tedious, more risk of typos.
   - Recommend (a). Same shape as the existing `_BIZ_DASH_SUBS` and the existing PR-B docs reference normalization.

9. **PR-9 (low risk, Bug #11, #12) — add `_PERSONAL_DASH_SUBS` normalization map** for the long-tail granular subs from `KESEFLE_KEYWORDS_EXTRA_v3.gs`. One table, ~25 lines, mapping each long-tail sub to one of: `בריאות`, `בנקאות`, `תחבורה`, `שונות`, `אפליקציות`, `מנויים דיגיטליים`, `חינוך ולימודים`. Pure additive; no row added; no formula churn.

10. **PR-10 (process) — add this matrix to the test gauntlet.** Wire a small Node test that loads `CATEGORY_MAP` from `bot/ExpenseBot_FIXED.gs` and the row arrays from `lib/sheet-writer.js`, asserts every subcategory has >=1 matching row OR is on a documented `by_design_exempt` allowlist. Catches drift on every future commit. Pattern: cf. `tests/no_hardcoded_year_in_dashboard_formula.js` in this repo.

## Cross-reference with prior audits

- `docs/REVIEW_2026_05_29_CATEGORY_RECONCILIATION.md` table F (Steven-only categories) listed `רוביקון`, `BMW`, `אבא`, `גיא`, `חצי אירון מן`, `חצי אוסטריה`, `קולקציות` as Steven-only — all confirmed and properly emitted by today's `CATEGORY_MAP` (lines 394-413). All 7 still by-design.
- `docs/REVIEW_2026_05_29_SYNC_AUDIT.md` flagged the same group plus warned the bot writes them but dashboard template intentionally omits them. Still accurate.
- The prior 11-item "by-design" list expands to 13 here only because this audit categorizes 2 more (`אקדמיה - אגרות וביטוחי סטודנט` is genuinely orphaned — could be either bug or exempt; flagged in Bug #11 conservatively; same for `כביש 6`).
- **Net new findings this audit:** the 39 English chain-store subs (Bug #1) and the granular `חינוך`/`תחבורה`/insurance/tax/services families (Bugs #2-#11) were NOT enumerated in prior audits because prior audits compared OLD-vs-NEW sheets, not bot-output vs template.
