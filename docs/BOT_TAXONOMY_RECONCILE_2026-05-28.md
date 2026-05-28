# Bot Write-Taxonomy Reconcile — 2026-05-28

> Why `מאזן חברה` rows 8-11 show ₪0 even though `תנועות` has 615 rows, and what to do about it.

---

## TL;DR for the impatient

The bot's classifier (in `bot/ExpenseBot_FIXED.gs`) emits **dozens of different sub-category strings** for what Steven's `מאזן חברה` dashboard expects to be **just 4 canonical buckets**. The dashboard SUMIFS literally compares `תנועות!E:E` (col E = sub-category) against the strings `"עלות חומרי גלם"`, `"עלות שיווק"`, `"משלוחים והתקנות"`, `"הוצאות תפעוליות"` — but the bot writes `"חומרי גלם"`, `"שיווק"`, `"משלוח"`, `"תפעוליות"` (no prefix) **at best**, and `"לימים"`, `"אפליקציות"`, `"בנקאות"`, `"בית"`, `"אפולו"` for the bulk of business-relevant rows. Hence ₪0.

There is already a soft-match layer in code (`_bucketRegexFor_` at line 11602, `_COMPANY_SUB_BUCKETS_` at line 361 of `personal_sheet_fix.gs`) that knows the canonical buckets — but it is only used by the *value-write path* (the bot pushes pre-computed numbers into dashboard cells), not by the *SUMIFS formulas* that the user sees.

**Recommended fix: path C — fix the bot's emitter + run a one-shot back-migration.** See section 5.

---

## 1. What goes into `תנועות` col D + col E

### 1.1 The standard 8-column row

Every transaction the bot writes follows this schema (see `bot/ExpenseBot_FIXED.gs:38` and lines around `:7855`, `:11408`):

| Col | Field | Example |
|-----|-------|---------|
| A | timestamp `new Date()` | `2026-05-28 14:32:11` |
| B | month key `yyyy-MM` | `2026-05` |
| C | amount (absolute, positive) | `320` |
| **D** | **category** (top-level) | `עסק` / `אוכל` / `תחבורה` … |
| **E** | **subcategory** (free text from CATEGORY_MAP) | `שיווק` / `אפליקציות` / … |
| F | description (raw user text after amount strip) | `פייסבוק ads קמפיין` |
| G | source | `WhatsApp` |
| H | isExpense boolean | `true` (false = income) |

### 1.2 The five write entry points

All five paths write the same 8-column shape. They differ only in **how D and E are computed**.

| Entry point | File:line | D source | E source |
|-------------|-----------|----------|----------|
| `processExpense` (default WhatsApp text) | `ExpenseBot_FIXED.gs:7855` | `matched.category` from `matchCategorySmart` | `matched.subcategory` |
| `_writeBusinessNExpense_` (`עסק N <amt> <desc>`) | `ExpenseBot_FIXED.gs:11408` | hardcoded `'עסק'` | `matchCategory('עסק ' + description).subcategory` — forces business-prefix path |
| `_writeOrderRow_` (canvas-print order schema) | `ExpenseBot_FIXED.gs:2839` | n/a — writes to `הזמנות` tab (12 cols, different schema) | n/a |
| Interactive dropdown picker | `ExpenseBot_FIXED.gs:2369`, `:7068` | from chosen picker label | from chosen picker label |
| Voice / receipt | wraps `processExpense` after transcript | same as default | same as default |

### 1.3 The classifier waterfall (`matchCategorySmart`, line 8393)

For every default-path write, the bot resolves `(category, subcategory)` through these layers, **in order**, first hit wins:

1. **Learned cache** (`_learnedLookup`, line 8395) — user-corrected categorizations from the `Learned` tab. Stored as `keyword → {category, subcategory}`.
2. **Auto-synonyms tab** (`_autoSynonymLookup_`, line 8404) — LLM-expanded variations populated by the nightly `cronSynonymExpansion` cron.
3. **`matchCategory`** — the static keyword tables:
   - If text contains the word `עסק`, scan `BUSINESS_CATEGORY_MAP` first (line 8260) — keyword-length-sorted, longest wins.
   - Otherwise scan `CATEGORY_MAP` (line 271) — same length-sorted scan.
4. **LLM fallback** (Claude Haiku) for the long tail.
5. **`DEFAULT_CATEGORY`** — `שונות / שונות`.

The matched `category` is then run through `_coerceCategoryBySubcategory` (line 8325) which forces `category = 'אוכל'` for the food subs.

### 1.4 The two competing category maps

`CATEGORY_MAP` and `BUSINESS_CATEGORY_MAP` **do not agree** on the subcategory names for business expenses. This is the root of the problem.

#### `CATEGORY_MAP` (entries 0-8, lines 271-283) — business rows

```js
{keywords:[...marketing...], category:"עסק", subcategory:"שיווק"},          // line 275
{keywords:[...operations...], category:"עסק", subcategory:"תפעוליות"},      // 276
{keywords:[...raw materials...], category:"עסק", subcategory:"חומרי גלם"}, // 277
{keywords:[...shipping...], category:"עסק", subcategory:"משלוח"},          // 278
{keywords:[...consultants...], category:"עסק", subcategory:"יועצים"},       // 279
{keywords:[...software...], category:"עסק", subcategory:"תוכנות"},          // 280
{keywords:[...equipment...], category:"עסק", subcategory:"ציוד עסקי"},     // 281
{keywords:[...biz tax...], category:"עסק", subcategory:"מיסים"},            // 282
{keywords:[...revenue...], category:"עסק", subcategory:"מחזור", isIncome:true}, // 283
```

#### `BUSINESS_CATEGORY_MAP` (lines 8260-8269) — what `_writeBusinessNExpense_` uses

```js
"עסק": {
  "עלות שיווק":        [פייסבוק, facebook, instagram, tiktok, google ads, …],
  "הוצאות תפעוליות":   [photoshop, adobe, canva, figma, aws, …, תוכנות, …],
  "משלוחים והתקנות":   [משלוח, shipping, fedex, dhl, fulfillment, …, אריזה, …],
  "עלות חומרי גלם":    [זכוכית, קנבס, raw materials, supplier, alibaba, …],
  "מחזור":             [הכנסה, מכירה, sale, payment received, …],
  "יועצים":            [יועץ, רואה חשבון, lawyer, cpa, …],
  "שונות":             [כיבוד, team lunch, מתנה ללקוח, …]
}
```

**The same expense classified through path A produces `"שיווק"`. The same expense through path B produces `"עלות שיווק"`. Same `category=עסק`, different `subcategory`.** The dashboard SUMIFS is exact-match, so only path B's output hits.

### 1.5 What the dashboard literally expects

The canonical mapping (`_COMPANY_ROW_SUB_MAP`, `bot/ExpenseBot_FIXED.gs:15281`) — these are what `מאזן חברה` rows 8-11 look up:

```js
'מחזור':              'מחזור',
'מחזור ברוטו':        'מחזור',
'עלות חומרי גלם':     'עלות חומרי גלם',   ← exact match in col E
'חומרי גלם':          'עלות חומרי גלם',   ← row also accepts short label
'עלות שיווק':         'עלות שיווק',
'שיווק':              'עלות שיווק',
'משלוחים והתקנות':    'משלוחים והתקנות',
'משלוחים':            'משלוחים והתקנות',
'הוצאות תפעוליות':    'הוצאות תפעוליות',
'תפעוליות':           'הוצאות תפעוליות',
'יועצים':             'יועצים',
'רווח גולמי':         (derived)
'רווח נטו':           (derived)
```

And the actual installed SUMIFS formula (`installCompanyDashboardFormulas`, line 15440):

```
=IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "עלות חומרי גלם", תנועות!B:B, "2026-05"), 0)
```

So col E must literally equal `"עלות חומרי גלם"`. Anything else — `"חומרי גלם"`, `"חומרים"`, `"רכש"`, `"קנבס"` — silently sums to 0.

---

## 2. The actual taxonomy the bot can emit

Below: every distinct `(category, subcategory)` tuple the bot's `CATEGORY_MAP` + `BUSINESS_CATEGORY_MAP` + `_writeOrderRow_` paths can produce, with example keywords and which dashboard bucket each *should* land in.

### 2.1 Business-prefixed (`עסק <amount> <desc>` → `BUSINESS_CATEGORY_MAP`)

These are the ONLY tuples that hit the dashboard out-of-the-box today (when emitted via `_writeBusinessNExpense_`):

| Category | Subcategory (col E) | Trigger keywords (sample) | Dashboard hit? |
|----------|---------------------|---------------------------|----------------|
| עסק | מחזור | הכנסה, מכירה, sale, payment received, מקדמה | YES — מחזור row |
| עסק | עלות חומרי גלם | זכוכית, קנבס, ספק, alibaba, raw material | YES — עלות חומרי גלם row |
| עסק | עלות שיווק | פייסבוק, facebook, instagram, tiktok, google ads, מטא | YES — עלות שיווק row |
| עסק | משלוחים והתקנות | משלוח, fedex, dhl, fulfillment, אריזה, התקנה | YES — משלוחים והתקנות row |
| עסק | הוצאות תפעוליות | photoshop, adobe, canva, aws, github, slack pro, תוכנה, תוכנות | YES — הוצאות תפעוליות row |
| עסק | יועצים | יועץ, רואה חשבון, lawyer, cpa, bookkeeper | YES — יועצים row |
| עסק | שונות | כיבוד, team lunch, מתנה ללקוח, תרומה עסקית | NO (no dashboard row) |

### 2.2 NON-prefixed writes — `CATEGORY_MAP` business rows

If the user does NOT prefix with `עסק`, the path through `CATEGORY_MAP` writes business-ish rows with **the short subcategory names**, which the dashboard rejects:

| Category | Subcategory (col E) | Trigger keywords (sample) | Dashboard hit? |
|----------|---------------------|---------------------------|----------------|
| עסק | שיווק | marketing, advertising, ads, פרסום, קמפיין, יחסי ציבור | **NO** — needs to be `עלות שיווק` |
| עסק | תפעוליות | operations, ops, admin, overhead, תפעולי | **NO** — needs `הוצאות תפעוליות` |
| עסק | חומרי גלם | raw materials, materials, supplies, סחורה, מלאי, רכש | **NO** — needs `עלות חומרי גלם` |
| עסק | משלוח | shipping, delivery, courier, freight, אריזה ומשלוח | **NO** — needs `משלוחים והתקנות` |
| עסק | יועצים | consultant, attorney, accountant, cpa | YES (lucky — name matches) |
| עסק | תוכנות | software, saas, license, אופיס, תוכנה | **NO** — should bucket into תפעוליות |
| עסק | ציוד עסקי | business equipment, printer, monitor, ציוד למשרד | **NO** — should bucket into תפעוליות |
| עסק | מיסים | vat, מע"מ, מס הכנסה עסקי, ביטוח לאומי עצמאי | **NO** — should bucket into תפעוליות |

### 2.3 Personal subcategory tree

The personal side is much cleaner because the dashboard rows for `מאזן אישי` use the **subcategory name as row label**, so SUMIFS-on-col-E with `$A{row}` works directly (line 10932). Personal subs in `CATEGORY_MAP`:

**FAMILY / KIDS / BABY (line 286-297)**
- חינוך וילדים / חיתולים ותינוקות
- חינוך וילדים / מזון תינוקות ופעוטות
- חינוך וילדים / ציוד וטיפוח לתינוק
- חינוך וילדים / עגלות תינוק
- חינוך וילדים / מנשאי תינוק
- חינוך וילדים / רהיטי תינוק
- חינוך וילדים / ביגוד והנעלה לילדים
- חינוך וילדים / חינוך וטיפול
- חינוך וילדים / ספרים וציוד לבית ספר
- בריאות / בריאות ילדים
- תחבורה / כסאות בטיחות לילדים

**ADULT HOBBIES / LIFESTYLE (line 299-307)**
- תחבורה / אחזקת רכב
- טיפוח / מוצרי טיפוח ויופי
- בריאות / ספורט ותוספים
- בידור / בילוי ויציאה
- בידור / מנויים דיגיטליים
- בידור / משחקי מחשב וקונסולה
- בידור / סטרימינג
- קניות / ביגוד
- קניות / אלקטרוניקה (massive keyword list — laptops/phones/TVs)
- קניות / רהיטים
- קניות / קניות מקוונות
- קניות / טיפוח

**FOOD (line 346-347, 374-375, 420-429)**
- אוכל / אוכל בחוץ
- אוכל / אוכל לבית
- אוכל / אוכל לבית — סופרמרקטים ארציים
- אוכל / אוכל לבית — שופרסל וריאציות
- אוכל / אוכל לבית — שווקים פתוחים
- אוכל / אוכל לבית — קצביות
- אוכל / אוכל לבית — דגים
- אוכל / אוכל לבית — מאפיות ולחם
- אוכל / אוכל לבית — אורגני ובריאות
- אוכל / אוכל לבית — יין ואלכוהול
- אוכל / אוכל לבית — גבינות ומעדנים
- אוכל / אוכל לבית — קמחנים ודברי מאפה

**TRANSPORT (line 360-384)**
- תחבורה / דלק (huge keyword list, 200+ vendors)
- תחבורה / מונית
- תחבורה / חניה (huge, 100+ parking-app + lot names)
- תחבורה / תחבורה ציבורית
- תחבורה / ביטוח רכב
- תחבורה / רישוי
- תחבורה / ליים (e-scooter)
- תחבורה / רוביקון (Steven's Jeep)
- תחבורה / BMW s1000 (Steven's motorcycle)
- תחבורה / קורקינט
- תחבורה / רכב שכור

**FIXED COSTS (line 386, 389-403, 413, 415, 417)**
- הוצאות קבועות / מכון כושר
- הוצאות קבועות / אפליקציות (largest single bucket — 1300+ keywords)
- הוצאות קבועות / פלייסטיישן
- הוצאות קבועות / אפולו
- הוצאות קבועות / לימודים
- הוצאות קבועות / חשמל
- הוצאות קבועות / בית (mortgage, ארנונה, ועד בית, rent)
- הוצאות קבועות / מים
- הוצאות קבועות / גז
- הוצאות קבועות / תקשורת
- הוצאות קבועות / תחזוקת בית
- הוצאות קבועות / בנקאות
- הוצאות קבועות / ביטוח אישי
- הוצאות קבועות / מיסים ואגרות

**HEALTH (line 403-404)**
- בריאות / בריאות
- בריאות / ביטוח בריאות

**MISC (line 391-395, 406-408, 414, 418-419)**
- שונות ואחרים / לוטו
- שונות ואחרים / אישי
- שונות ואחרים / מתנות
- שונות ואחרים / אירועים
- שונות ואחרים / בילויים
- שונות ואחרים / ספרים
- שונות ואחרים / חיות מחמד
- שונות ואחרים / השקעות
- שונות ואחרים / נסיעות
- שונות ואחרים / שונות

**INCOME (line 370-373)**
- הכנסות / הכנסה 1 — משכורת (isIncome:true)
- הכנסות / הכנסה 2 — עסק (isIncome:true)
- הכנסות / הכנסה 3 — נוסף (isIncome:true)
- הכנסות / שונות (הכנסות) (isIncome:true)

**TEMP (line 385)**
- הוצאות זמניות / אבא

### 2.4 Per-order schema (`_writeOrderRow_`, `הזמנות` tab)

Separate schema, separate tab. Steven's canvas-print orders:

| Col | Field |
|-----|-------|
| A | timestamp |
| B | month |
| C | customer name |
| D | size |
| E | material (canvas, glass, …) |
| F | productionCost |
| G | salePrice |
| H | shipping |
| I | profit |
| J | source |
| K | rawText |
| L | status |

Side effect (`ExpenseBot_FIXED.gs:2844`): every order push ALSO calls `_updateBusinessDashboard_('עסק', 'מחזור', month, salePrice)` so the dashboard's `מחזור` row is updated immediately, bypassing the SUMIFS+col-E exact match (this works because the function writes a VALUE, not a formula).

---

## 3. The expectation vs reality gap

### 3.1 What the dashboard expects (literal SUMIFS targets)

From `installCompanyDashboardFormulas` (line 15353) the formulas written into `מאזן חברה` rows 8-11 are:

```
Row "עלות חומרי גלם":   =IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "עלות חומרי גלם", תנועות!B:B, "2026-05"), 0)
Row "עלות שיווק":        =IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "עלות שיווק",      תנועות!B:B, "2026-05"), 0)
Row "משלוחים והתקנות":  =IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "משלוחים והתקנות", תנועות!B:B, "2026-05"), 0)
Row "הוצאות תפעוליות":  =IFERROR(SUMIFS(תנועות!C:C, תנועות!E:E, "הוצאות תפעוליות", תנועות!B:B, "2026-05"), 0)
```

### 3.2 What Steven's `תנועות` col E top-20 actually contains (sampled live)

```
לימים, אפליקציות, שונות, אפולו, בית, "הכנסה 1 - משכורת",
בנקאות, מכון כושר, "הכנסה 2 - עסק 2 - SRC"
```

**Not a single one matches any dashboard SUMIFS target.** Hence rows 8-11 = ₪0.

### 3.3 Why this happened

Two compounding causes:

1. **The bot's classifier had three generations of taxonomy** layered on top of each other:
   - Early version: short names (`שיווק`, `חומרי גלם`, `משלוח`) — still in `CATEGORY_MAP` lines 275-278.
   - Middle version: prefixed names (`עלות שיווק`, `עלות חומרי גלם`, `משלוחים והתקנות`) — in `BUSINESS_CATEGORY_MAP` lines 8261-8269.
   - The default `processExpense` path (no `עסק` prefix) hits `CATEGORY_MAP` and produces short names. The `עסק 1 …` path hits `BUSINESS_CATEGORY_MAP` and produces prefixed names.

2. **Steven's historical 615 rows include rows from BOTH paths plus pre-bot manual entries** with their own ad-hoc subs (`בית` for mortgage, `אפליקציות` for subscriptions, `לימים` likely a typo of `לימודים`). The dashboard SUMIFS was written for the *new* canonical names. Old rows don't match.

The bot **does** have a soft-match safety net for the *value-write* path: `_updateBusinessDashboard_` calls `_normalizeBizSub_` (line 11013) which maps `'שיווק' → 'עלות שיווק'` then `_sumBusinessBucketFromTransactions_` (line 11551) uses `_bucketRegexFor_` (line 11602) to sum ANY row whose col E matches a tolerant regex. This is why the dashboard *partially* updates when a new business row is written today — but only the freshly-touched bucket-month cell gets recomputed, and the formula stays SUMIFS-exact-match so any user-triggered refresh / re-run reverts to ₪0.

---

## 4. The proposed mapping table

Below: every distinct subcategory the bot has *ever* written, mapped to the right one of 4 business dashboard buckets. Justification per row.

### 4.1 The 4 canonical buckets (target col E values)

| Bucket | Canonical col E value | Steven's commerce-business rationale |
|--------|----------------------|---------------------------------------|
| Raw materials | `עלות חומרי גלם` | Canvas, glass, ink, frames, wood — the physical inputs of a print order |
| Marketing | `עלות שיווק` | All paid traffic and brand spend that drives orders |
| Shipping & install | `משלוחים והתקנות` | Outbound logistics + customer-site mounting work |
| Operations | `הוצאות תפעוליות` | Everything else that keeps the business running — software, advisors, taxes, equipment, office, bank fees |

`מחזור` (revenue) is a separate, parallel bucket — income lines only.

### 4.2 Full reconciliation map

| Bot-emitted col E value | Source map / path | Target bucket | Justification |
|--------------------------|-------------------|---------------|---------------|
| `מחזור` | BUSINESS_CATEGORY_MAP, `_writeOrderRow_` | `מחזור` | Already canonical |
| `עלות חומרי גלם` | BUSINESS_CATEGORY_MAP | `עלות חומרי גלם` | Already canonical |
| `חומרי גלם` | CATEGORY_MAP line 277 | `עלות חומרי גלם` | Short form of same concept |
| `חומרים` | CATEGORY_MAP keyword captured as sub | `עלות חומרי גלם` | Generic "materials" → inputs |
| `רכש` | CATEGORY_MAP keyword | `עלות חומרי גלם` | "Procurement" = buying inputs |
| `מלאי` | CATEGORY_MAP keyword | `עלות חומרי גלם` | "Inventory" |
| `סחורה` | CATEGORY_MAP keyword | `עלות חומרי גלם` | "Merchandise" / wholesale |
| `קנבס` | BUSINESS_CATEGORY_MAP keyword | `עלות חומרי גלם` | Canvas — Steven's primary print substrate |
| `זכוכית` | BUSINESS_CATEGORY_MAP keyword | `עלות חומרי גלם` | Glass — frames |
| `מסגרת`, `פינות מסגרת` | BUSINESS_CATEGORY_MAP | `עלות חומרי גלם` | Frame parts |
| `עלות שיווק` | BUSINESS_CATEGORY_MAP | `עלות שיווק` | Already canonical |
| `שיווק` | CATEGORY_MAP line 275 | `עלות שיווק` | Short form |
| `פרסום` | CATEGORY_MAP keyword | `עלות שיווק` | Advertising |
| `קמפיין` | CATEGORY_MAP keyword | `עלות שיווק` | Campaign |
| `יחסי ציבור`, `יחצן` | CATEGORY_MAP keyword | `עלות שיווק` | PR — promotion spend |
| `אינפלואנסר`, `משפיענים` | BUSINESS_CATEGORY_MAP | `עלות שיווק` | Influencer marketing |
| `seo`, `sem`, `ppc` | CATEGORY_MAP keyword | `עלות שיווק` | Search marketing |
| `משלוחים והתקנות` | BUSINESS_CATEGORY_MAP | `משלוחים והתקנות` | Already canonical |
| `משלוח` | CATEGORY_MAP line 278 | `משלוחים והתקנות` | Short form |
| `משלוחים` | variant | `משלוחים והתקנות` | Plural form |
| `אריזה`, `אריזה ומשלוח` | CATEGORY_MAP / keyword | `משלוחים והתקנות` | Packing materials part of fulfillment |
| `הובלה` | CATEGORY_MAP keyword | `משלוחים והתקנות` | Hauling/shipping |
| `התקנה`, `התקנות` | BUSINESS_CATEGORY_MAP | `משלוחים והתקנות` | On-site canvas install |
| `הוצאות תפעוליות` | BUSINESS_CATEGORY_MAP | `הוצאות תפעוליות` | Already canonical |
| `תפעוליות` | CATEGORY_MAP line 276 | `הוצאות תפעוליות` | Short form |
| `תפעול` | keyword | `הוצאות תפעוליות` | Operations |
| `תוכנות` | CATEGORY_MAP line 280 | `הוצאות תפעוליות` | SaaS subs are overhead in this taxonomy |
| `ציוד עסקי` | CATEGORY_MAP line 281 | `הוצאות תפעוליות` | Office hardware = overhead |
| `מיסים` | CATEGORY_MAP line 282 | `הוצאות תפעוליות` | Business taxes are operational cost |
| `יועצים` | CATEGORY_MAP line 279, BUSINESS_CATEGORY_MAP | `יועצים` (separate row) OR roll into `הוצאות תפעוליות` | Dashboard has a dedicated `יועצים` row — keep separate |
| `שונות` (under עסק) | BUSINESS_CATEGORY_MAP | `הוצאות תפעוליות` | Misc biz expense → falls to ops |
| `אפולו` | CATEGORY_MAP line 392 | n/a — personal, not business | Steven's gym chain; should not hit `מאזן חברה` at all (category should be `הוצאות קבועות`, not `עסק`) |
| `אפליקציות` | CATEGORY_MAP line 389 | n/a — `הוצאות קבועות` personal | But if user-corrects to `עסק`, bucket → `הוצאות תפעוליות` |
| `בית` | CATEGORY_MAP line 398 | n/a — personal (mortgage/rent) | |
| `בנקאות` | CATEGORY_MAP line 413 | n/a — personal | If business banking, user must correct |
| `מכון כושר` | CATEGORY_MAP line 386 | n/a — personal | |
| `לימים` | likely typo of `לימודים` | n/a — personal `הוצאות קבועות / לימודים` | Worth a one-shot normalize pass to fix the typo |

### 4.3 The single source-of-truth dictionary

The `_BIZ_DASH_SUBS` object already in `bot/ExpenseBot_FIXED.gs:11000` is **the right place** to land the canonical map. It currently has:

```js
var _BIZ_DASH_SUBS = {
  'מחזור': 'מחזור',
  'עלות חומרי גלם': 'עלות חומרי גלם',
  'עלות שיווק': 'עלות שיווק',
  'שיווק': 'עלות שיווק',
  'משלוחים והתקנות': 'משלוחים והתקנות',
  'הוצאות תפעוליות': 'הוצאות תפעוליות',
  'יועצים': 'הוצאות תפעוליות',     ← debatable: dashboard has a יועצים row, should be 'יועצים'
  'אחר': 'הוצאות תפעוליות',
  'שונות': 'הוצאות תפעוליות',
  'שונות עסק': 'הוצאות תפעוליות'
};
```

It is **missing** the following keys that exist in `CATEGORY_MAP`'s business rows and the historical data:

```js
'חומרי גלם': 'עלות חומרי גלם',
'חומרים': 'עלות חומרי גלם',
'רכש': 'עלות חומרי גלם',
'מלאי': 'עלות חומרי גלם',
'סחורה': 'עלות חומרי גלם',
'משלוח': 'משלוחים והתקנות',
'משלוחים': 'משלוחים והתקנות',
'אריזה': 'משלוחים והתקנות',
'אריזה ומשלוח': 'משלוחים והתקנות',
'תפעוליות': 'הוצאות תפעוליות',
'תפעול': 'הוצאות תפעוליות',
'תוכנות': 'הוצאות תפעוליות',
'ציוד עסקי': 'הוצאות תפעוליות',
'מיסים': 'הוצאות תפעוליות',
'יועצים': 'יועצים',                  ← OVERRIDE: dashboard has dedicated row
```

---

## 5. Three fix paths

### Path A — recategorize the 615 existing rows in-place

**What:** Apps Script function `RECATEGORIZE_BUSINESS_SUBS_2026_05_28` that:
1. Reads all rows from `תנועות`.
2. For each row where col D = `עסק` OR description matches a business-keyword pattern, looks up col E in the expanded `_BIZ_DASH_SUBS` map.
3. If a canonical mapping exists, rewrites col E (and col D if D was wrong, e.g. `הוצאות קבועות / תוכנות` should become `עסק / הוצאות תפעוליות` for business software).
4. Writes a backup tab `תנועות_backup_2026-05-28` first (per Steven's `backup-first` rule).
5. Outputs a dry-run report to a `מיגרציה תאריך` tab BEFORE applying.

**Pros**
- Once-and-done: dashboards immediately light up with real numbers.
- Preserves all historical data structure.
- No bot code change needed; existing SUMIFS formulas just work.
- Dashboard formulas stay simple (`SUMIFS(..., "עלות שיווק", ...)`).

**Cons**
- Touches user data — non-trivial blast radius if mapping is wrong. Must dry-run + Steven-review (per `feedback_backup_propose_apply` rule).
- Doesn't prevent future drift — bot will keep writing short names on the non-`עסק`-prefix path.
- Personal vs business judgement calls (e.g. `אפליקציות` row: is it Adobe-for-the-canvas-business or Netflix?) require LLM or user resolution.

**Risk:** Medium. Mitigated by mandatory dry-run + backup tab.

### Path B — change dashboard formulas to SUMPRODUCT-with-regex

**What:** Run `FIX_ALL_BUCKETS_ALL_YEARS` from `bot/personal_sheet_fix.gs:1077`. This already exists, writes the SUMPRODUCT shape documented in `docs/SHEET_FORMULAS.md`:

```
=IFERROR(SUMPRODUCT(
  ('תנועות'!C2:C5000)
  * ('תנועות'!B2:B5000 = "2026-05")
  * ('תנועות'!D2:D5000 = "עסק")
  * ((IFERROR(REGEXMATCH('תנועות'!E2:E5000, "(?i)<bucket pattern>"), FALSE)
    + IFERROR(REGEXMATCH('תנועות'!F2:F5000, "(?i)<bucket pattern>"), FALSE)) > 0)
), 0)
```

The pattern lives in `_COMPANY_SUB_BUCKETS_[].regex` (line 361) and `_PSF_MARKETING_PATTERN_` (line 782). E.g. marketing matches any of:

`שיווק|פרסום|קמפיין|מודעות|לידים|משפיענים|advert|adwords|marketing|facebook|instagram|tiktok|google ads|פייסבוק|אינסטה|seo|ppc|...`

Across both col E AND col F (so even an uncategorized row whose description mentions "Facebook ad" gets summed in marketing).

**Pros**
- Zero touches to user data — formulas-only change.
- Catches non-`עסק`-prefixed historical rows whose description contains a bucket keyword.
- Already implemented + tested (`bot/test_marketing_formula.js`, 27/27 pass per `SHEET_FORMULAS.md`).
- Tolerates future bot drift: any new short / long synonym matches the regex.

**Cons**
- Formulas are 10× longer and harder for Steven to read in the sheet.
- Cell speed: SUMPRODUCT scans 5000 rows × 3 columns × 5 buckets × 12 months × N years on every open. Acceptable today, will get slow > 50k rows.
- Regex is fragile to spelling variations the pattern doesn't anticipate.
- Doesn't help dashboards on other tabs (e.g. `מאזן חברה 2024`) unless re-run for each year.
- Does NOT fix the col D mis-categorization (e.g. Adobe software written as `הוצאות קבועות / תוכנות` instead of `עסק / הוצאות תפעוליות`).

**Risk:** Low. Read-only on data side. Reversible with `CLEAN_BROKEN_FORMULAS_ALL_YEARS`.

### Path C — fix the bot emitter + migrate

**What:** Two-step.

1. **Bot code change:** in `bot/ExpenseBot_FIXED.gs`:
   - Expand `_BIZ_DASH_SUBS` with all the variants from section 4.3.
   - Add a single normalization step at the **write point** in `processExpense` (line 7855) and `_writeBusinessNExpense_` (line 11408): before `appendRow`, if `matched.category === 'עסק'`, run `matched.subcategory = _normalizeBizSub_(matched.subcategory) || matched.subcategory`. Guarantees every future business row uses canonical col E.
   - Also update the `BUSINESS_CATEGORY_MAP` keyword groupings in `CATEGORY_MAP` lines 275-282 to emit the prefixed names directly, so even the non-`עסק`-prefix path produces canonical output.
   - Bump `KFL_BUILD_VERSION` (per `bot-version-bump` skill).

2. **One-shot migration (`scripts/migrate-business-subs-2026-05-28.js`):** runs once over `תנועות` to normalize historical 615 rows using the same `_BIZ_DASH_SUBS` table — exactly Path A but as a script you can re-run on any tenant sheet.

**Pros**
- Permanent fix. Both old data and new data converge on the same vocabulary.
- Dashboard formulas stay simple SUMIFS — fast, readable, debuggable.
- Bot tests in `bot/test_classify.js` extend naturally.
- Sets up a single source of truth (`_BIZ_DASH_SUBS`) referenced by every classification site.
- Future-proof: when Steven adds business #2 (`SRC Collection` etc.), the same canonical vocabulary lands automatically.

**Cons**
- Largest scope — touches bot code AND data.
- Requires bot redeploy via Apps Script paste (`bot-deploy-paste` skill).
- Migration script needs backup + dry-run.
- Risk of mis-categorizing personal-but-looks-business rows in the historical data (e.g. `אפליקציות` row — is it Adobe-business or Netflix-personal?).

**Risk:** Medium-high. Two moving parts. Mitigated by Path A's backup-tab discipline plus a test in `bot/test_classify.js` asserting every business keyword routes to one of the 4 canonical subs.

---

## 5b. Recommendation: Path C, in three reviewable PRs

Steven's `feedback_step_by_step_instructions` + `pr-incremental-plan` skills both push toward small, reversible PRs. Sequence:

**PR 1 — `feat-biz-sub-canonicalize-emitter`** (bot only, no data touch)
- Expand `_BIZ_DASH_SUBS`.
- Add the single normalize-on-write line in both `processExpense` and `_writeBusinessNExpense_`.
- Update `CATEGORY_MAP` business rows (lines 275-282) to emit canonical sub names directly.
- Add unit tests in `bot/test_classify.js` asserting `marketing` → `עלות שיווק`, `canvas roll` → `עלות חומרי גלם`, etc.
- Bump `KFL_BUILD_VERSION`.
- New rows starting from deploy land in the dashboard correctly.

**PR 2 — `feat-bucket-regex-belt-and-suspenders`** (formula safety net)
- Run `FIX_ALL_BUCKETS_ALL_YEARS` to install SUMPRODUCT-with-regex on all `מאזן חברה` year blocks.
- This catches any short-form rows missed by PR 1's normalization (e.g. user types something weird the keyword list doesn't cover).
- Zero data touch.

**PR 3 — `chore-migrate-historical-biz-subs-2026-05-28`** (one-shot)
- Backup `תנועות` → `תנועות_backup_2026-05-28`.
- Dry-run normalize.
- Apply normalization.
- After this, all 615 historical rows + all future rows use canonical vocabulary.
- Dashboard formulas in PR 2 keep working as the safety net for anything missed.

After all three: dashboard rows 8-11 reflect real numbers, both for current month and historical months.

---

## 6. Concrete artifacts to land in PR 1

### 6.1 Code edits (single file: `bot/ExpenseBot_FIXED.gs`)

**(a)** Replace the `_BIZ_DASH_SUBS` block at line 11000 with the expanded map (section 4.3 above).

**(b)** Update `CATEGORY_MAP` business rows so they emit canonical names directly:

```js
// line 275 → change subcategory to "עלות שיווק"
{"keywords":[...marketing...],"category":"עסק","subcategory":"עלות שיווק"},
// line 276 → change to "הוצאות תפעוליות"
{"keywords":[...operations...],"category":"עסק","subcategory":"הוצאות תפעוליות"},
// line 277 → change to "עלות חומרי גלם"
{"keywords":[...raw materials...],"category":"עסק","subcategory":"עלות חומרי גלם"},
// line 278 → change to "משלוחים והתקנות"
{"keywords":[...shipping...],"category":"עסק","subcategory":"משלוחים והתקנות"},
// line 280 → fold into operations
{"keywords":[...software...],"category":"עסק","subcategory":"הוצאות תפעוליות"},
// line 281 → fold into operations
{"keywords":[...equipment...],"category":"עסק","subcategory":"הוצאות תפעוליות"},
// line 282 → fold into operations
{"keywords":[...biz tax...],"category":"עסק","subcategory":"הוצאות תפעוליות"},
// line 279 → stays "יועצים" (dashboard has its own row)
// line 283 → stays "מחזור"
// lines 409-411 → also update עסק facebook/etc to emit canonical
```

**(c)** Insert a single safety net at every `appendRow` for business rows. Search for `'עסק'` writes (line 7855 + 11408 + 7068 + 2369) and wrap col E:

```js
var __finalSub = matched.subcategory;
if (matched.category === 'עסק' && typeof _normalizeBizSub_ === 'function') {
  __finalSub = _normalizeBizSub_(__finalSub) || __finalSub;
}
sheet.appendRow([now, monthKey, finalAmount, sanitizeForSheet(matched.category), sanitizeForSheet(__finalSub), ...]);
```

**(d)** Bump `KFL_BUILD_VERSION` per the `bot-version-bump` skill.

### 6.2 Test (`bot/test_classify.js` — extend existing)

```js
const cases = [
  // Business — every keyword must route to one of 4 canonical sub names
  { text: 'facebook ads 320',         expect: { cat:'עסק', sub:'עלות שיווק' } },
  { text: 'google ads 500',           expect: { cat:'עסק', sub:'עלות שיווק' } },
  { text: 'אינסטגרם 200',              expect: { cat:'עסק', sub:'עלות שיווק' } },
  { text: 'קנבס 1200',                 expect: { cat:'עסק', sub:'עלות חומרי גלם' } },
  { text: 'דיו הדפסה 80',              expect: { cat:'עסק', sub:'עלות חומרי גלם' } },
  { text: 'fedex 150',                expect: { cat:'עסק', sub:'משלוחים והתקנות' } },
  { text: 'אריזה ומשלוח 90',           expect: { cat:'עסק', sub:'משלוחים והתקנות' } },
  { text: 'photoshop monthly 150',    expect: { cat:'עסק', sub:'הוצאות תפעוליות' } },
  { text: 'github copilot 20',        expect: { cat:'עסק', sub:'הוצאות תפעוליות' } },
  { text: 'מע"מ רבעון 4500',           expect: { cat:'עסק', sub:'הוצאות תפעוליות' } },
  { text: 'רואה חשבון 800',            expect: { cat:'עסק', sub:'יועצים' } },
  { text: 'invoice paid 3200',        expect: { cat:'עסק', sub:'מחזור' } },
];
```

### 6.3 No data touch in PR 1

Steven's existing 615 rows are untouched until PR 3. The SUMIFS formulas already in place will start picking up new rows immediately. Historical rows continue to read ₪0 until PR 2 (regex backstop) or PR 3 (data migration) lands.

---

## Appendix — file:line cross-reference

| Concern | Reference |
|---------|-----------|
| `CATEGORY_MAP` definition | `bot/ExpenseBot_FIXED.gs:271` |
| `BUSINESS_CATEGORY_MAP` definition | `bot/ExpenseBot_FIXED.gs:8260` |
| Default-path write | `bot/ExpenseBot_FIXED.gs:7855` |
| Business-N write | `bot/ExpenseBot_FIXED.gs:11408` |
| Canvas-order write | `bot/ExpenseBot_FIXED.gs:2839` |
| `processExpense` main entry | `bot/ExpenseBot_FIXED.gs:6886` |
| `matchCategory` (business prefix branch) | `bot/ExpenseBot_FIXED.gs:8272` |
| `matchCategorySmart` (waterfall) | `bot/ExpenseBot_FIXED.gs:8393` |
| `_BIZ_DASH_SUBS` (canonical map — incomplete) | `bot/ExpenseBot_FIXED.gs:11000` |
| `_normalizeBizSub_` | `bot/ExpenseBot_FIXED.gs:11013` |
| `_updateBusinessDashboard_` (value path) | `bot/ExpenseBot_FIXED.gs:11033` |
| `_sumBusinessBucketFromTransactions_` | `bot/ExpenseBot_FIXED.gs:11551` |
| `_bucketRegexFor_` (soft match) | `bot/ExpenseBot_FIXED.gs:11602` |
| `_COMPANY_ROW_SUB_MAP` | `bot/ExpenseBot_FIXED.gs:15281` |
| `installCompanyDashboardFormulas` (writes SUMIFS) | `bot/ExpenseBot_FIXED.gs:15353` |
| `_COMPANY_SUB_BUCKETS_` (regex buckets) | `bot/personal_sheet_fix.gs:361` |
| `_PSF_MARKETING_PATTERN_` | `bot/personal_sheet_fix.gs:782` |
| `_isBrokenDashFormula_` | `bot/personal_sheet_fix.gs:460` |
| `FIX_MARKETING_ALL_YEARS` | `bot/personal_sheet_fix.gs:791` |
| `FIX_ALL_BUCKETS_ALL_YEARS` | `bot/personal_sheet_fix.gs:1077` |
| `RECOMPUTE_COMPANY_DASHBOARD` | `bot/personal_sheet_fix.gs` (see SHEET_FORMULAS.md table) |
| Pa'amonim taxonomy (personal side) | `lib/categories.js:20` |
| Sheet schema (template) | `lib/sheet-writer.js` |
| Dashboard formula architecture | `docs/SHEET_FORMULAS.md` |
