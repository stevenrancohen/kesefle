# Personalized Category Profiles — adaptive per-user category system

**Author:** Claude (autonomous audit Agent 2 — Category Intelligence + User Personalization + Sheet Schema)
**Date:** 2026-05-28
**Status:** DESIGN PROPOSAL — Steven to approve before any code lands.
**Companion docs:**
- [SHEET_AND_DASHBOARD_STRATEGY.md](./SHEET_AND_DASHBOARD_STRATEGY.md) — the 7-PR strategy this slots into (specifically PR-S4 sheet template variants).
- [DASHBOARD_REDESIGN_PRINCIPLES.md](./DASHBOARD_REDESIGN_PRINCIPLES.md) — Lyra-style "Category management is its own page" principle.
- [CLASSIFICATION.md](./CLASSIFICATION.md) — current bot classifier behaviour the profile layer wraps.
- (Inline references throughout to `lib/categories.js`, `bot/ExpenseBot_FIXED.gs:271` `CATEGORY_MAP`, `bot/ExpenseBot_FIXED.gs:11039` `_BIZ_DASH_SUBS`, `lib/sheet-writer.js:55-105` `PERSONAL_*_ROWS` / `COMPANY_EXPENSE_ROWS`, `bot/PERSONALIZED_LEARNING.gs`.)

**Why this doc exists:** today, EVERY user gets the same ~80-row Pa'amonim dashboard. Steven called it "overwhelming." Meanwhile his OLD sheet (1UKr…) has 23 hand-curated categories he wants preserved verbatim. We need an architecture that gives each user the categories THEY use, preserves their history, and still lets the bot route messages correctly. This doc spells that out end-to-end.

---

## 1. Problem statement — three failure modes today

The current taxonomy in `lib/categories.js` is the Pa'amonim "רשימת הסעיפים" (16 expense groups × 4-10 subs + 3 income groups). `lib/sheet-writer.js:buildTenantSheetSpec()` materialises that catalogue into 34 personal rows + 4 company rows × every new user. The bot's `CATEGORY_MAP` (`bot/ExpenseBot_FIXED.gs:271`) — currently ~1,480 keyword routes — feeds those rows.

The three observed failure modes:

### 1.1 Overwhelm (UX — onboarding)
- A first-time user opens מאזן אישי and sees 4 income rows + 12 fixed + 3 variable + 2 food + 8 transport + 5 misc = **34 rows that are all empty**. The dashboard renders as ₪0 / ₪0 / ₪0 down 34 lines.
- Steven verbally flagged this on 2026-05-26: "User overwhelmed."
- Net effect: drop-off on first session before the user can find the bucket they care about. Negative for activation, retention, NPS.
- Today's mitigation: NONE in code. Every cell renders regardless.

### 1.2 Irrelevance (taxonomy fit)
- A self-employed contractor doesn't need rows like "בייביסיטר," "אופטיקה," "תרומות." A parent of three doesn't need "ביטוח עסק" or "רואה חשבון."
- `lib/professions.js` has 119 entries with profession-specific `income_subs` / `expense_subs` lists — but the current sheet builder **ignores them**: `buildTenantSheetSpec(name, opts)` reads `opts.year` only, never `opts.profile_type` or `opts.profession_id`.
- Result: profession-aware classification (the boost keywords in `lib/profession-template.js`) lands subcategory writes in rows the sheet does not show. The user types "בטון 800," the bot writes col E="חומרי בניין," but the dashboard's rows are "אוכל לבית / דלק / חניה / …" — the row never appears, so the value vanishes from any dashboard the user looks at.

### 1.3 Lost history (Steven's specific pain)
- Steven's OLD sheet (`1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`) contains 23 categories he chose himself over years of use:
  `הוצאות בית`, `נשר + חופים` (later renamed `כושר + תוספים`), `אוכל`, `קולקציות`, `כבלים אינטרנט פלאפון`, `לימודים`, `ביטוח אישי`, `אבא`, `בדיקות`, `טיפולים`, `חברה / מס הכנסה / ביטוח לאומי`, `ביטוח חובה+ג׳+איתורן`, `טסט רכב`, `חניונים`, `מים`, `BMW`, `דלק`, `אוכל/מזון/רכבת`, `חצי אירון מן`, `אוסטריה`, `עורך דין`, `בנק הפועלים`, `חופשות`, `גיא`.
- When the migration moves him onto Kesefle's standard template, those 23 names get normalised into the Pa'amonim taxonomy. The names disappear. He loses the mental model of his own books.
- Some of these are also semantically ambiguous to the global taxonomy: "אבא" (his father — a recurring transfer he wants to see), "גיא" (a person — same), "BMW" (his specific car, not just "תחזוקת רכב"), "חצי אירון מן" (his triathlon training, not just "ספורט"). Forcing them through `findGroupForSubcategory()` in `lib/categories.js:149` collapses the personal meaning.
- Today's bot has zero hook for "remember this label as the user typed it." `PERSONALIZED_LEARNING.gs` learns text-token → category mapping after a dropdown resolution, but it does not preserve the user's display label.

**These three failure modes are why we need profiles.** Not just a different sheet template — a per-user, per-category layer that the dashboard, the bot, and the migration all read from.

---

## 2. Three-layer architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│   Layer 1: MASTER LIBRARY  (Sheet tab: קטגוריות, server-side)            │
│   ────────────────────────────────────────────────────────────────────  │
│   ~250 catalogued categories. Each row = canonical category id,        │
│   normalized name, group, default_active flag, activation rule,        │
│   default keyword bundle, plus metadata for provenance + reporting.    │
│   Seeded from:                                                          │
│     - lib/categories.js EXPENSE_GROUPS + INCOME_GROUPS  (Pa'amonim)    │
│     - lib/professions.js 119 profession packs                          │
│     - bot/ExpenseBot_FIXED.gs CATEGORY_MAP (1,480 keyword rows)        │
│     - Steven's OLD sheet 23-category set                               │
│   Single source of truth. Shipped in every tenant sheet (read-only      │
│   tab) AND mirrored in KV as `cat_master:vN` for the API to query.     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   Layer 2: USER PROFILE  (Sheet tab: User_Category_Profile + KV)        │
│   ────────────────────────────────────────────────────────────────────  │
│   Per-user filter / order / budget layer. One row per category_id      │
│   the user has EVER seen or activated. Columns: active, hidden,        │
│   pinned, monthly_budget, yearly_budget, display_order, created_from,  │
│   last_used, usage_count.                                              │
│   Default state on signup: ~15 rows active (one of the 6 presets).      │
│   Bot writes here when a new category fires. Dashboard reads here to    │
│   decide WHICH rows to render. Mirrored to KV `user_profile:{sub}`     │
│   for fast read in the bot path.                                       │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   Layer 3: DASHBOARD RENDERER  (lib/sheet-writer.js + dashboard.html)   │
│   ────────────────────────────────────────────────────────────────────  │
│   Materialises Layer 1 ∩ Layer 2 into actual sheet rows + dashboard    │
│   cards. 4 view modes (Compact / Full / Review / Historical). Knows    │
│   nothing about keywords; only about category_id + display_name +      │
│   active.                                                              │
│   On signup, builds initial rows from preset + profession_id +         │
│   has_* answers in Settings tab. On bot write, calls                   │
│   _activateOrCreateRow_(category_id) which adds a new row if absent    │
│   and respects display_order.                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why three layers (not one big catalogue):**

- **Layer 1 changes globally** — when we add a new profession or a keyword pack, every user's bot benefits, no per-user migration.
- **Layer 2 changes per user** — when a user pins or hides a category, only their dashboard reflects it.
- **Layer 3 is the render** — never the source of truth. Today's `PERSONAL_*_ROWS` constants in `lib/sheet-writer.js:55-81` are the BUG — they are render AND source of truth, mixing concerns. New design: those constants become DEFAULTS for the Basic Personal preset only; the live row list comes from Layer 2.

**Boundary invariants:**
- Layer 1 is READ-ONLY for users. Only an admin migration can append.
- Layer 2 is READ/WRITE for users and bot. Layer 1 is the FK target — every Layer 2 row has a `category_id` that exists in Layer 1.
- Layer 3 NEVER hard-codes a category label or row number. It always reads `category_id → display_name_he` from Layer 1 + `active / order` from Layer 2.

---

## 3. `קטגוריות` master library — schema (21 columns)

Tab name (Hebrew, paste-safe): `קטגוריות`. Created as the LAST tab in every tenant sheet (after `פירוט מורחב`), hidden by default, `gridProperties.hideGridlines = true`. The tab is read-only for the user; admin migration scripts append rows via the same OAuth pattern as `lib/sheet-writer.js:createUserSheetWithToken`.

| # | Column | Type | Example | Notes |
|---|---|---|---|---|
| 1 | `category_id` | string (ASCII, snake_case) | `food_groceries` | PK. Stable forever. NEVER renamed (renaming breaks tenant SUMIFS). |
| 2 | `original_name` | string (Hebrew or English) | `מזון` | Source name as the catalogue saw it. From `lib/categories.js` items. |
| 3 | `normalized_name` | string (Hebrew, canonical) | `מזון לבית` | Result of `_normalizeBizSub_`-style normalisation (`bot/ExpenseBot_FIXED.gs:11077`). Used as SUMIFS col E criterion. |
| 4 | `display_name_he` | string (Hebrew) | `🛒 מזון לבית` | What the user sees in dashboard col A. Includes emoji prefix per `lib/categories.js` `icon` field. |
| 5 | `display_name_en` | string (English) | `Groceries` | For English-locale users + admin tooling. Same surface as Layer 1 EN. |
| 6 | `group` | enum | `food_pharma` | Layer-1 group key. Maps to `EXPENSE_GROUPS[].key` in `lib/categories.js:25`. |
| 7 | `dashboard_section` | enum | `food` | Which section of the personal dashboard this row lives in. One of: `income`, `fixed`, `variable`, `food`, `transport`, `housing`, `health`, `family`, `business_revenue`, `business_expense`, `historical_personal` (Steven's 23). |
| 8 | `default_active` | boolean | `TRUE` | Whether to seed this row in the user's profile on signup (subject to preset filter — see §7). |
| 9 | `activation_rule` | string | `always` | Rule expression — see §6. One of: `always`, `on_keyword`, `on_business`, `on_kids`, `on_car`, `on_pets`, `on_rent`, `on_mortgage`, `on_employees`, `on_studies`, `on_subscriptions`, `on_pet_count>=1`. |
| 10 | `keywords` | string (CSV) | `מזון,סופר,קניות,supermarket,grocery,supermart` | Lowercased, comma-separated. Mirrors the `keywords` array in `bot/ExpenseBot_FIXED.gs:271 CATEGORY_MAP`. |
| 11 | `source_sheet` | enum | `paamonim` | One of: `paamonim` (from `lib/categories.js`), `profession:<id>` (from `lib/professions.js`), `category_map` (from bot CATEGORY_MAP), `old_steven_personal` (Steven's OLD 23), `old_steven_business` (his business 4), `user_custom` (created at runtime). |
| 12 | `source_cell_range` | string | `1UKr…!מאזן אישי!A12:A12` | For migrated rows: the EXACT cell coords this category was found in. Lets us reverse-trace history. Optional for non-migrated rows. |
| 13 | `first_seen_year` | number | `2018` | Earliest year this category has a transaction. From the OLD-sheet scan. Default: current year for new categories. |
| 14 | `last_seen_year` | number | `2026` | Most recent year. Updated on every bot write. |
| 15 | `transaction_count` | number | `347` | Lifetime tx count. Updated by the bot post-write (debounced — see §10). |
| 16 | `historical_total` | number | `41,260.50` | Lifetime spend in ILS. Same update path. |
| 17 | `is_custom` | boolean | `FALSE` | TRUE if the user created this category via the dashboard "+ קטגוריה חדשה" button (Layer 3 UI). |
| 18 | `is_system` | boolean | `TRUE` | TRUE for any row sourced from Pa'amonim or professions catalogue. FALSE for user-custom. System rows cannot be deleted, only hidden. |
| 19 | `confidence` | number (0-100) | `95` | Classifier confidence for the keyword bundle. Surfaces in the Review Inbox so the user can prioritise low-confidence categories for review. |
| 20 | `needs_review` | boolean | `FALSE` | TRUE if migrated from OLD with ambiguous normalisation. Forces dropdown on first bot write. |
| 21 | `notes` | string (free text) | `Steven's BMW maintenance — keep separate from generic תחזוקת רכב` | Migration notes + admin comments. Hidden from the user. |

**Example rows (10 representative):**

```
| category_id           | original_name | normalized_name | display_name_he | group       | dashboard_section | default_active | activation_rule  | source_sheet                | is_custom | is_system |
|-----------------------|---------------|-----------------|-----------------|-------------|-------------------|----------------|------------------|-----------------------------|-----------|-----------|
| food_groceries        | מזון          | מזון לבית       | 🛒 מזון לבית     | food_pharma | food              | TRUE           | always           | paamonim                    | FALSE     | TRUE      |
| food_dining_out       | אוכל בחוץ     | אוכל בחוץ       | 🍔 אוכל בחוץ    | leisure     | food              | TRUE           | always           | paamonim                    | FALSE     | TRUE      |
| transport_fuel        | דלק           | דלק              | ⛽ דלק           | transport   | transport         | TRUE           | on_car           | paamonim                    | FALSE     | TRUE      |
| transport_car_maint   | תחזוקת רכב    | תחזוקת רכב      | 🔧 תחזוקת רכב   | transport   | transport         | TRUE           | on_car           | paamonim                    | FALSE     | TRUE      |
| transport_bmw_steven  | BMW           | תחזוקת רכב      | 🚗 BMW           | transport   | historical_personal| TRUE          | always           | old_steven_personal         | FALSE     | TRUE      |
| business_marketing    | עלות שיווק    | עלות שיווק      | 📣 עלות שיווק   | business    | business_expense  | FALSE          | on_business      | category_map                | FALSE     | TRUE      |
| business_raw_mat      | עלות חומרי גלם| עלות חומרי גלם  | 🎨 עלות חומרי גלם| business    | business_expense  | FALSE          | on_business      | category_map                | FALSE     | TRUE      |
| construction_concrete | חומרי בניין   | חומרי בניין     | 🧱 חומרי בניין  | construction| business_expense  | FALSE          | on_business      | profession:general_contractor| FALSE    | TRUE      |
| personal_dad_steven   | אבא            | העברה למשפחה    | 👨 אבא           | family      | historical_personal| FALSE         | always           | old_steven_personal         | TRUE      | TRUE      |
| pets_food             | מזון לחיות    | חיות מחמד       | 🐶 מזון לחיות   | leisure     | family            | FALSE          | on_pets          | paamonim                    | FALSE     | TRUE      |
```

**Why 21 columns:**
- Cols 1-9 are CONTROL — what is this and how do we route to it.
- Cols 10-11 are CLASSIFIER — how the bot matches text to this id.
- Cols 12-16 are PROVENANCE — where it came from, what its history says.
- Cols 17-20 are POLICY — who can edit it, when it gets reviewed.
- Col 21 is HUMAN — free-text for admin overrides.

This shape is what makes the migration + dashboard renderer + bot all able to share one table without colliding.

---

## 4. `User_Category_Profile` — schema (10 columns)

Tab name: `User_Category_Profile` (ASCII — never displayed to user, so RTL-safety not a concern). Created in every tenant sheet AFTER the `קטגוריות` master tab. Visible to the user but in an "Advanced" section of the sidebar — power users CAN edit `monthly_budget` here directly; for the rest the dashboard's UI is the front door.

| # | Column | Type | Example | Notes |
|---|---|---|---|---|
| 1 | `category_id` | string (FK to קטגוריות.category_id) | `food_groceries` | PK in this tab. UNIQUE per sheet. |
| 2 | `active` | boolean | `TRUE` | Whether to render a row for this category in the personal/business dashboard. |
| 3 | `hidden` | boolean | `FALSE` | If `TRUE`: row renders ONLY in Historical view mode (§9). Used for categories the user once had but no longer cares about — e.g. "טיטולים" after the youngest kid grew out of diapers. |
| 4 | `pinned` | boolean | `FALSE` | If `TRUE`: row floats to the top of its section, before sort by `display_order`. |
| 5 | `monthly_budget` | number (ILS) | `2500` | Optional. NULL means "no budget set." Wired to the existing `lib/goals.js` infrastructure (budget alerts when 80% reached). |
| 6 | `yearly_budget` | number (ILS) | `30000` | Optional. Same wiring. Default: `monthly_budget * 12` if monthly set. |
| 7 | `display_order` | number | `15` | Within-section sort. 1-based. Tied categories sort alphabetically. |
| 8 | `created_from` | enum | `preset:basic_personal` | One of: `preset:<name>`, `profession:<id>`, `migration:old_personal`, `migration:old_business`, `user_added`, `bot_auto_activated`. Provenance for "why is this category here." |
| 9 | `last_used` | timestamp (ISO) | `2026-05-28T11:42:17+03:00` | Last bot write that landed on this row. Drives "stale category" auto-hide rule (see §9). |
| 10 | `usage_count` | number | `347` | Per-user lifetime tx count (Layer 1 col 15 is GLOBAL; this is per-user). |

**KV mirror** at `user_profile:{sub}` (where `sub` is the Google OAuth sub from `api/_lib/auth.js`):

```json
{
  "v": 1,
  "updated_at": "2026-05-28T11:42:17Z",
  "categories": [
    { "id": "food_groceries",  "active": true,  "pinned": false, "order": 1,
      "monthly_budget": 2500, "last_used": "2026-05-28T11:42:17Z", "count": 347 },
    { "id": "transport_fuel",  "active": true,  "pinned": true,  "order": 2,
      "monthly_budget": 1200, "last_used": "2026-05-28T08:11:02Z", "count": 89 },
    { "id": "transport_bmw_steven", "active": true, "pinned": false, "order": 8,
      "monthly_budget": null, "last_used": "2026-05-27T15:33:42Z", "count": 12 }
  ]
}
```

**Why both Sheet AND KV:**
- Sheet = user-editable source of truth. Power user opens the tab, manually toggles `active=FALSE` on a row, done. The dashboard reads it on next refresh.
- KV = bot read path. The bot processes ~1 message every few seconds in steady-state; reading the sheet on every classify is too slow (~300-800ms per round-trip). KV read is ~5-15ms via Upstash.
- Write path: dashboard UI writes BOTH (sheet via OAuth, KV via API). Bot writes BOTH (sheet via Apps Script, KV via webhook to Vercel API). Eventual consistency is acceptable — the bot's last_used / usage_count are advisory, not financial; if KV and sheet drift by a few writes nothing breaks.
- Reconciliation: a Vercel cron at 04:00 IL (`api/cron/reconcile-profiles.js`, NEW) reads each user's sheet and rewrites KV. Bounded run-time per user (<200ms) — fan-out across users via `batch_size=50`.

**Sheet row example:**

```
| category_id           | active | hidden | pinned | monthly_budget | yearly_budget | display_order | created_from         | last_used                | usage_count |
|-----------------------|--------|--------|--------|----------------|---------------|---------------|----------------------|--------------------------|-------------|
| food_groceries        | TRUE   | FALSE  | FALSE  | 2500           | 30000         | 1             | preset:basic_personal| 2026-05-28T11:42:17+03:00| 347         |
| transport_bmw_steven  | TRUE   | FALSE  | FALSE  | NULL           | NULL          | 8             | migration:old_personal| 2026-05-27T15:33:42+03:00| 12          |
| business_marketing    | FALSE  | FALSE  | FALSE  | NULL           | NULL          | 0             | bot_auto_activated   | NULL                     | 0           |
```

(Row 3: `active=FALSE` because user is on Basic Personal preset, `business_marketing` is `default_active=FALSE` for that preset. If they later send a message classifying as business marketing, the bot flips it to TRUE via the `_activateOrCreateRow_` path described in §10.)

---

## 5. `Settings` tab — schema

Tab name: `Settings` (ASCII). First tab in every tenant sheet (becomes `index: 0`, displacing `מאזן אישי` to `index: 1`). Hidden by default — accessed via the dashboard sidebar `⚙️ ניהול → הגדרות`.

Single row (the schema below describes ONE row of cell pairs `key | value`; flat key-value model, not a multi-row table). Implementation note: store as two columns A=key, B=value, with `frozenRowCount=1`. This is the same pattern the bot uses for `Properties` storage in Apps Script (intuitive to power users).

| Key | Type | Default | Notes |
|---|---|---|---|
| `template_type` | enum | `basic_personal` | One of: `basic_personal`, `family`, `business`, `contractor`, `mixed`, `advanced_imported`. Drives the §7 preset. |
| `active_year` | number | current year | The year `$B$2` cell of `מאזן אישי` references. User changes via dashboard year selector. |
| `active_month` | number (1-12) | current month | For monthly-view default. |
| `has_business` | boolean | FALSE | Steven's "are you also tracking a business?" Set TRUE on signup if user picked a profession with `vat=osek_morshe`. |
| `has_family` | boolean | TRUE | Drives whether family-related rows are seeded. |
| `has_children` | boolean | FALSE | If TRUE, kids-related categories (חיתולים, צהרון, etc.) seed active. |
| `has_car` | boolean | TRUE | Default TRUE for IL — most users have ≥1 car. Hides transport_fuel/maint when FALSE. |
| `number_of_cars` | number | 1 | If >1, dashboard renders per-car rows: `דלק רכב 1`, `דלק רכב 2`. |
| `has_motorcycle` | boolean | FALSE | Adds `אופנוע` rows. |
| `has_pets` | boolean | FALSE | Adds `חיות מחמד` rows + `pet_food`. |
| `has_rent` | boolean | FALSE | Activates `שכר דירה` row. Mutually exclusive with `has_mortgage` (UX guard, NOT a hard constraint). |
| `has_mortgage` | boolean | FALSE | Activates `משכנתא` row. |
| `has_loans` | boolean | FALSE | Activates the entire `התחייבויות` group. |
| `has_employees` | boolean | FALSE | For business users: activates `שכר עובדים`, `ביטוח לאומי עובדים`. |
| `has_projects` | boolean | FALSE | For contractor users: enables the `פרויקטים` tab from the SHEET_AND_DASHBOARD_STRATEGY PR-S4. |
| `has_travel` | boolean | FALSE | Activates `חופשות` + `טיסות` rows. |
| `has_studies` | boolean | FALSE | Activates `לימודים` row + tuition-related keywords. |
| `has_subscriptions` | boolean | TRUE | Default TRUE (everyone has Netflix). Activates `מנויים דיגיטליים`. |
| `dashboard_view_mode` | enum | `compact` | One of: `compact`, `full`, `review`, `historical`. See §9. |
| `bot_connected` | boolean | FALSE | TRUE after the WhatsApp number is verified. Surfaces in `🔁 חיבור בוט` indicator. |
| `last_bot_write` | timestamp | NULL | Heartbeat — last successful bot row write. Stale > 7d triggers "is the bot alive?" banner. |
| `last_validation_status` | enum | `unknown` | One of: `ok`, `warnings`, `errors`, `unknown`. From `bot/personal_sheet_fix.gs:_isBrokenDashFormula_` nightly run. |
| `last_formula_check` | timestamp | NULL | Last time the nightly broken-formula scanner touched this sheet. |
| `last_import_date` | timestamp | NULL | Last time a bulk import (CSV / OLD-sheet migration) ran. |

**Why a flat key-value table instead of a JSON blob:** the bot's Apps Script reads this tab via `getRange().getValues()` and looks up keys. JSON would require an Apps Script JSON.parse on every write — slower and brittle. Flat KV is also easier for the user to skim.

**Example tab contents (literal):**

```
| Key (col A)           | Value (col B)                |
|-----------------------|------------------------------|
| template_type         | basic_personal               |
| active_year           | 2026                         |
| active_month          | 5                            |
| has_business          | FALSE                        |
| has_family            | TRUE                         |
| has_children          | TRUE                         |
| has_car               | TRUE                         |
| number_of_cars        | 2                            |
| has_motorcycle        | FALSE                        |
| has_pets              | TRUE                         |
| has_rent              | FALSE                        |
| has_mortgage          | TRUE                         |
| has_loans             | FALSE                        |
| has_employees         | FALSE                        |
| has_projects          | FALSE                        |
| has_travel            | TRUE                         |
| has_studies           | TRUE                         |
| has_subscriptions     | TRUE                         |
| dashboard_view_mode   | compact                      |
| bot_connected         | TRUE                         |
| last_bot_write        | 2026-05-28T11:42:17+03:00    |
| last_validation_status| ok                           |
| last_formula_check    | 2026-05-28T04:01:33+03:00    |
| last_import_date      | 2026-05-15T18:22:09+03:00    |
```

---

## 6. Activation rules — concrete table

Every Layer 1 category has an `activation_rule` (col 9). The rule is evaluated at:
1. **Signup time** — once, against the Settings tab + selected preset, to seed the initial Layer 2 rows.
2. **Bot write time** — when a bot message classifies into a category whose Layer 2 row is `active=FALSE`. The bot calls `_evaluateActivationRule_(category_id, user_settings)` to decide: silently activate, prompt user, or hard-reject.
3. **Settings change time** — when the user flips a `has_*` flag in Settings, the dashboard re-evaluates all rules and offers a "shall we add/remove these rows" diff.

The rules:

| Rule | Semantics | Example category | Activation behaviour |
|---|---|---|---|
| `always` | Active on every preset, every user, every signup. | `food_groceries`, `housing_electric`, `housing_water` | Seeded TRUE in Layer 2 unconditionally. Never auto-deactivated. |
| `on_keyword` | Active only when a bot message matches one of its keywords. Until that happens the row is `active=FALSE` and hidden from dashboard. First match: auto-flip to TRUE + write the row, then prompt the user "האם להציג את הקטגוריה הזו בלוח?" with `[כן] [רק הפעם] [לא]`. | `pets_vet_visit`, `business_legal` | Lazy. Avoids overwhelming users with categories they may never use. |
| `on_business` | Active iff `Settings.has_business = TRUE`. | `business_marketing`, `business_raw_mat`, `business_shipping`, `business_ops`, all 119 `profession:*` rows | On signup: skipped unless user picked a profession with `vat∈{osek_morshe,osek_patur,employer}`. Flipping `has_business=TRUE` later prompts: "האם להוסיף קטגוריות עסקיות?" |
| `on_kids` | Active iff `Settings.has_children = TRUE`. | `kids_diapers`, `kids_clothing`, `kids_school`, `kids_pediatrician` | Onboarding question: "האם יש לך ילדים בבית?" |
| `on_car` | Active iff `Settings.has_car = TRUE` (defaults TRUE). | `transport_fuel`, `transport_car_maint`, `transport_car_insurance`, `transport_parking`, `transport_test`, `transport_car_seats` (special: `on_car AND on_kids`) | If user says `has_car=FALSE`, the entire transport.car-group goes inactive; bot still classifies but writes into a hidden row that the dashboard hides in compact view (visible in Historical). |
| `on_pets` | Active iff `Settings.has_pets = TRUE`. | `pets_food`, `pets_vet`, `pets_grooming`, `pets_boarding` | Auto-flipped if bot classifies anything as `category=חיות מחמד` for the first time, with the same prompt as `on_keyword`. |
| `on_rent` | Active iff `Settings.has_rent = TRUE`. | `housing_rent` | Mutually exclusive with `on_mortgage` (UX warning, not hard fail). |
| `on_mortgage` | Active iff `Settings.has_mortgage = TRUE`. | `housing_mortgage` | Same. |
| `on_employees` | Active iff `Settings.has_employees = TRUE`. | `business_salaries`, `business_bituach_leumi_employees`, `business_employee_benefits` | Business-only flag. |
| `on_studies` | Active iff `Settings.has_studies = TRUE`. | `education_university`, `education_courses`, `education_textbooks` | |
| `on_subscriptions` | Active iff `Settings.has_subscriptions = TRUE`. | `comm_streaming`, `comm_software_subs`, `comm_news_subs` | Defaults TRUE (assumed everyone has Netflix or similar). |
| `on_pet_count>=1` | Same as `on_pets`, but explicit count threshold. Reserved for future (per-pet rows). | NONE today | Documented so the rule grammar is extensible. |

**Activation rule evaluator pseudocode** (lives in NEW `lib/category-activation.js`):

```js
export function shouldActivate(category, settings) {
  const rule = category.activation_rule;
  if (rule === 'always') return true;
  if (rule === 'on_keyword') return false; // wait for the first bot match
  // settings.has_* keys map 1:1 to rule names
  const key = 'has_' + rule.replace(/^on_/, '');
  if (settings[key] === true) return true;
  // Composite rules:
  if (rule === 'on_car AND on_kids') return settings.has_car && settings.has_children;
  // Default: skip unknown rules (forward-compat — new rule added in Layer 1 but old code shipping)
  return false;
}
```

---

## 7. Six template presets

Each preset is a named bundle of `category_id`s + `has_*` defaults. Stored in NEW `lib/category-presets.js`. The user picks a preset during onboarding (single step in the existing `start.html` flow); the dashboard renderer materialises the Layer 2 rows from `preset.active_ids ∪ (rules evaluated against has_*)`.

### 7.1 Basic Personal (default, lowest friction)

Targets the first-time user who just wants to track money in/out for their household. ~15 active rows.

- **has_*** defaults: `has_family=TRUE`, `has_car=TRUE`, `has_subscriptions=TRUE`, everything else FALSE.
- **pre_active_category_ids** (15):
  - `income_salary`, `income_misc`
  - `food_groceries`, `food_dining_out`
  - `housing_electric`, `housing_water`, `housing_gas`, `housing_arnona`, `housing_internet_phone`
  - `transport_fuel`, `transport_car_maint`, `transport_public`
  - `personal_clothing`, `personal_grooming`, `personal_health`

### 7.2 Family (parents with kids at home)

~22 active rows. Adds kid-specific buckets.

- **has_*** defaults: Basic Personal + `has_children=TRUE`.
- **pre_active_category_ids** = Basic Personal + 7:
  - `kids_diapers` (auto-hides when last child >2y; replaced by `kids_clothing`)
  - `kids_school_tuition`, `kids_afterschool`, `kids_clothing`, `kids_toys`, `kids_pediatrician`
  - `family_gifts`

### 7.3 Business (עוסק מורשה — full ledger)

~28 active rows. The 4 canonical business expense buckets plus the personal Basic Personal rows.

- **has_*** defaults: Basic Personal + `has_business=TRUE`.
- **pre_active_category_ids** = Basic Personal + 13:
  - Business: `business_revenue`, `business_marketing`, `business_raw_mat`, `business_shipping`, `business_ops`, `business_consultants`
  - Business tax: `business_vat`, `business_income_tax`, `business_bituach_leumi`
  - Business admin: `business_software`, `business_equipment`, `business_office_rent`, `business_legal`

### 7.4 Contractor (single-project freelancer)

~25 active rows. Aligns with the SHEET_AND_DASHBOARD_STRATEGY PR-S4 contractor template variant. Heavy on per-project / per-client.

- **has_*** defaults: Basic Personal + `has_business=TRUE`, `has_projects=TRUE`.
- **pre_active_category_ids** = Basic Personal + 10:
  - `business_revenue_project`, `business_revenue_retainer`, `business_revenue_extras`
  - `business_marketing`, `business_consultants`, `business_software`
  - `business_equipment_per_project`, `business_office_rent`
  - `business_vat`, `business_income_tax`

### 7.5 Mixed (personal + side business)

~30 active rows. For employees with a side hustle that doesn't yet justify full עוסק status.

- **has_*** defaults: Basic Personal + `has_business=TRUE` (sets `vat=osek_patur` automatically).
- **pre_active_category_ids** = Basic Personal + 8:
  - `business_revenue_side`, `business_consultants`, `business_software`, `business_marketing`
  - `business_equipment_personal_use`, `business_ops`
  - `business_vat_optional` (greyed out if VAT status changes)

### 7.6 Advanced Imported (Steven + power-user migrants)

For users with an OLD sheet. Imports the full historical category set verbatim + Pa'amonim baseline + business 4. The "everything" preset.

- **has_*** defaults: read from the OLD sheet's tab inventory at migration time (e.g. if the OLD sheet had a `מאזן חברה` tab with rows, `has_business=TRUE`).
- **pre_active_category_ids**: imported per migration discovery (every `(category, subcategory)` tuple seen in OLD `תנועות` col D+E gets a Layer 1 row + Layer 2 active=TRUE).
- This is the preset Steven himself selects. His 23 historical categories (§8) land here as `dashboard_section=historical_personal`, preserving his original labels.

---

## 8. Steven's 23-category normalisation table

The OLD sheet (`1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`) has 23 categories Steven wants preserved EXACTLY as he typed them, while still being routable by the bot. The mapping below shows for each:

- `original_category_name`: the literal label Steven used in OLD `מאזן אישי` col A.
- `category_id`: the canonical id we assign in Layer 1 (snake_case, ASCII).
- `normalized_name`: the SUMIFS-criterion-safe label written in col E of `תנועות`.
- `display_name_he`: what the dashboard shows.
- `group`: Layer 1 group key.
- `dashboard_section`: where the row sits in the personal/business dashboard.
- `notes`: migration intent + any classifier guidance.

| # | original_category_name      | category_id              | normalized_name        | display_name_he         | group              | dashboard_section   | notes |
|---|-----------------------------|--------------------------|------------------------|-------------------------|--------------------|---------------------|-------|
| 1 | הוצאות בית                  | home_general             | אחזקת בית              | 🏠 הוצאות בית           | home_maintenance   | historical_personal | Catch-all for chimney/repair/handyman; bot continues to write fine-grained subs (`חשמל`, `מים`) into their own rows; this row sums via wildcard `*בית*` over E. |
| 2 | נשר + חופים (→ כושר + תוספים)| fitness_supplements      | ספורט ותוספים          | 🏋️ כושר + תוספים        | grooming           | historical_personal | Steven renamed "נשר + חופים" → "כושר + תוספים" mid-2024. We preserve BOTH names: `original_name` keeps "נשר + חופים", `display_name_he` shows current "כושר + תוספים". `last_seen_year` cutoff splits history. |
| 3 | אוכל                        | food_general             | מזון לבית              | 🍞 אוכל                 | food_pharma        | historical_personal | Aggregates `מזון`/`סופר`/`קניות`. Distinct from #18 below (which is broader). |
| 4 | קולקציות                    | hobby_collections        | תחביבים                | 🎨 קולקציות             | leisure            | historical_personal | Steven's art-canvas/glass collection purchases. Custom — NOT in Pa'amonim. `is_custom=TRUE`. |
| 5 | כבלים אינטרנט פלאפון         | comm_internet_phone_cable| תקשורת                 | 📡 כבלים אינטרנט פלאפון | communication      | historical_personal | Single line that sums HOT/Bezeq/cellphone all together; matches Steven's OLD bundling. |
| 6 | לימודים                     | education_general        | לימודים                | 🎓 לימודים              | education          | historical_personal | Layer 2 default_active is dictated by `has_studies` rule; for Steven it's TRUE because his OLD has 4y of history. |
| 7 | ביטוח אישי                  | insurance_personal       | ביטוח חיים             | 🛡️ ביטוח אישי           | financial          | historical_personal | Distinct from #12 (car insurance). |
| 8 | אבא                         | personal_dad_steven      | העברה למשפחה           | 👨 אבא                  | family             | historical_personal | Recurring monthly transfer to father. Custom — bot needs special routing: keyword "אבא" + amount ≥1000 → this id, not `family_general`. |
| 9 | בדיקות                      | health_tests             | בדיקות רפואיות         | 🩺 בדיקות               | health             | historical_personal | Lab tests, imaging. Distinct from #10. |
| 10| טיפולים                     | health_treatments        | טיפולים פרטיים         | 💆 טיפולים              | health             | historical_personal | Massage/physio/private clinics. |
| 11| חברה / מס הכנסה / ביטוח לאומי| business_taxes_bundle    | הוצאות תפעוליות        | 🏛️ חברה / מ"ה / ב"ל     | business           | business_expense   | This is the Steven-side bundle of all corporate taxes. Mapped to `הוצאות תפעוליות` for SUMIFS compat with the company dashboard (matches `_BIZ_DASH_SUBS` row "תפעוליות" → "הוצאות תפעוליות" in `bot/ExpenseBot_FIXED.gs:11067`). |
| 12| ביטוח חובה+ג׳+איתורן         | transport_car_insurance  | ביטוח רכב              | 🚙 ביטוח חובה+ג׳+איתורן | transport          | historical_personal | Compulsory + 3rd party + Itoran tracker, all annual. Display label is literal. |
| 13| טסט רכב                     | transport_car_test       | רישוי רכב              | 🔍 טסט רכב              | transport          | historical_personal | Annual roadworthiness. Maps to `רישוי רכב` for normalisation. |
| 14| חניונים                     | transport_parking        | חניה                   | 🅿️ חניונים              | transport          | historical_personal | Plural form intentional — Steven uses paid lots, not street parking. |
| 15| מים                         | housing_water            | מים וביוב              | 💧 מים                  | home_maintenance   | historical_personal | Water bill. Pa'amonim has a parallel `housing_water` (`always` rule) — these MERGE on migration: same `category_id`, Steven's display label overrides default. |
| 16| BMW                         | transport_bmw_steven     | תחזוקת רכב             | 🚗 BMW                  | transport          | historical_personal | Steven-specific car. Custom — keep separate from generic `transport_car_maint` so he can see his car's TCO in isolation. `is_custom=TRUE`. |
| 17| דלק                         | transport_fuel           | דלק                    | ⛽ דלק                  | transport          | historical_personal | Same id as Pa'amonim default — merged. |
| 18| אוכל/מזון/רכבת              | food_transit_combo       | מזון ותחבורה ציבורית   | 🍱 אוכל/מזון/רכבת       | food_pharma        | historical_personal | Steven's bizarre OLD bundling: food bought at train stations/highway. Custom — preserved. `is_custom=TRUE`. Display name literal. |
| 19| חצי אירון מן                | sport_triathlon_steven   | ספורט                  | 🏊 חצי אירון מן         | grooming           | historical_personal | Half-Ironman training (gear + race fees). Custom. `is_custom=TRUE`. |
| 20| אוסטריה                     | travel_austria_steven    | חופשות                 | 🇦🇹 אוסטריה             | leisure            | historical_personal | Steven's recurring Austria ski trips. Custom — preserved as separate row so he can see lifetime Austria spend. `is_custom=TRUE`. |
| 21| עורך דין                    | legal_attorney           | עורך דין               | ⚖️ עורך דין             | financial          | historical_personal | Personal legal fees (NOT business — business gets `business_consultants` w/ `יועצים`). |
| 22| בנק הפועלים                 | bank_hapoalim_steven     | עמלות                  | 🏦 בנק הפועלים          | financial          | historical_personal | Steven's main bank's fees. Custom. `is_custom=TRUE`. Display name literal. |
| 23| גיא                         | personal_gia_steven      | העברה אישית            | 👤 גיא                  | family             | historical_personal | Recurring transfer to a person named Gia. Custom. Same special routing as #8 ("אבא"): keyword "גיא" routes to this id. `is_custom=TRUE`. |

**Normalisation observations:**

- 14 of the 23 map to existing Pa'amonim or business categories (`category_id` is shared with a default Layer 1 row). For these the migration MERGES: the Layer 1 row already exists; we add `source_sheet='old_steven_personal'` to its provenance + override `display_name_he` for Steven only via Layer 2's `display_order=NULL, override_label='<his label>'` (NEW Layer 2 col TBD if we want per-user label override — see §11 migration notes).
- 9 of the 23 are CUSTOM (#4, #8, #11, #16, #18, #19, #20, #22, #23). For these we INSERT a new Layer 1 row with `is_custom=TRUE`, `source_sheet='old_steven_personal'`. They are visible only on Steven's sheet by default. If another user later opts in to see them via the dashboard's "category marketplace" (long-term v3), the Layer 1 row is reused.
- The 2 person-name categories (אבא #8, גיא #23) need bot-side special handling: a keyword routes to the right id ONLY for Steven's phone. Implementation: when migration creates these rows, it ALSO appends to a NEW KV key `user_custom_keywords:{sub}` like `{ "אבא": "personal_dad_steven", "גיא": "personal_gia_steven" }` that the classifier reads BEFORE the global `CATEGORY_MAP`. This is the same pattern `PERSONALIZED_LEARNING.gs:classifyWithPersonalLearning_` uses today — extends it from "remember after correction" to "seed at migration."
- "ביטוח חובה+ג׳+איתורן" (#12) has special characters (+). When written to col E of תנועות it must NOT be a SUMIFS criterion (the `+` would be literal). Solution: `normalized_name='ביטוח רכב'` (the canonical Pa'amonim label), so SUMIFS sums via `*ביטוח רכב*` — that catches `ביטוח רכב` + `ביטוח חובה+ג׳+איתורן` (since the latter doesn't contain "ביטוח רכב"…). UPDATE: normalize to `'ביטוח רכב'` only at col E; display label keeps the original `'ביטוח חובה+ג׳+איתורן'` from `קטגוריות.display_name_he`. The dashboard renderer uses `display_name_he` for col A, not col E.

---

## 9. Display logic — 4 view modes

The dashboard's sidebar gets a new `🪞 תצוגה` switcher:

### 9.1 Compact (default)
- Renders ONLY Layer 2 rows where `active=TRUE` AND `hidden=FALSE` AND `usage_count > 0`.
- Plus pinned rows regardless of `usage_count`.
- Pa'amonim 34-row "everyone gets everything" mode is dead in this view.
- Empty section (e.g. user has no Health rows yet)? Section header is HIDDEN.
- Targets first-time users + Steven's overwhelm complaint.

### 9.2 Full
- Renders Layer 2 rows where `active=TRUE`. Hidden=FALSE filter still applies.
- Includes `usage_count=0` rows (good for "show me the categories I have set up but haven't used").
- Empty sections render with empty state + "+ הוסף קטגוריה" CTA.
- Power-user mode.

### 9.3 Review
- Renders Layer 2 rows where (`needs_review=TRUE`) OR (the matching Layer 1 row has `confidence < 70`) OR (the row's `usage_count > 0` AND `created_from='bot_auto_activated'` AND the user hasn't confirmed since auto-activation).
- Pairs with the Review Inbox from SHEET_AND_DASHBOARD_STRATEGY PR-S6.
- For each row: "✅ אישור" / "❌ לא מתאים — שייך מחדש" buttons.
- After review, sets `needs_review=FALSE` + writes a `user_confirmed_at` timestamp.

### 9.4 Historical
- Renders Layer 2 rows where `hidden=TRUE` OR `last_used < (now - 12 months)`.
- For users like Steven who want to see "everything I've ever tracked" — useful for tax season, year-end review, GDPR export.
- Read-only by default (a "📦 לארכיון" tag on each row); user can toggle `hidden=FALSE` to bring a row back to Compact view.

**Rendering rules (common to all modes):**

1. **Order within section:** pinned first (alphabetical tiebreak); then `display_order` ascending; then `last_used` desc; then `display_name_he` alphabetical.
2. **Empty value rendering:** a row with `usage_count=0` still renders ₪0.00 across all 12 months. Compact view excludes these (rule §9.1 line 1); Full view includes them.
3. **Color coding (compact + full):** rows with `usage_count > 0 AND last_used > now-30d` get the brand-50 background tint (matches `lib/sheet-writer.js:133 RGB_BRAND_50`). Rows with `last_used > now-7d` get a small "•" indicator next to the label. Rows with `last_used > now-12mo AND usage_count > 0` but stale (>30d) stay neutral. Older stale rows fade to 70% opacity in Full mode (`opacity: 0.7` CSS).
4. **Section totals:** generated by Layer 3 renderer based on which rows are visible in this mode. Total row formula sums ONLY the rows currently rendered (no orphaned hardcoded `SUM(B16:B27)` — instead `SUM(<row of cat_a>:<row of cat_n>)` computed at render time). This breaks the brittle hardcoded-row pattern noted in `lib/sheet-writer.js:228`.
5. **Mobile (≤430px):** in any mode, render only top-N most-used rows per section (N=5 default, settable in Settings). The "show all" link expands to the full section.

---

## 10. Bot interaction flow — message → profile match → activation prompt → write

The bot's current flow (per `bot/ExpenseBot_FIXED.gs` `doPost → processExpense`) is:
```
incoming WhatsApp text
  ↓
classifyWithPersonalLearning_ (PERSONALIZED_LEARNING.gs)   — token cache hit?
  ↓ (if no hit)
_SRC_classify_v2_ (CATEGORY_MAP regex + LLM fallback)
  ↓
build expense row (cat, subcat, amount, …)
  ↓
appendRow to תנועות
  ↓
_updateBusinessDashboard_ (recompute company dash)
  ↓
WhatsApp reply
```

**Proposed flow with profiles**, NEW steps marked `*`:

```
incoming WhatsApp text
  ↓
classifyWithPersonalLearning_         ← reads user's _CORRECTIONS_ tab + new user_custom_keywords:{sub}
  ↓ (cache miss)
_SRC_classify_v2_                     ← unchanged
  ↓
* _resolveCategoryId_(category, subcategory, user_settings)
*       — Maps the classifier's raw (category, subcategory) string to a Layer 1 `category_id`.
*       — Uses the same normalisation table _BIZ_DASH_SUBS extended to all 16 Pa'amonim groups.
*       — Returns the Layer 1 row + Layer 2 row (creating the Layer 2 row if absent).
  ↓
* _checkAndPromptActivation_(layer1_row, layer2_row, user_settings)
*       — If layer2_row.active=FALSE AND layer1_row.activation_rule≠'always':
*           - if 'on_keyword' rule: silently flip active=TRUE, append to dashboard, send WhatsApp confirmation
*               "✓ הוספתי קטגוריה חדשה: <display_name>. אם אינך רוצה לראות אותה — הקלד 'הסתר <name>'"
*           - if 'on_business' / 'on_kids' / etc.: respond with interactive button prompt
*               "זה נראה כמו <category>. האם להוסיף קטגוריה <display_name_he> ללוח?  [כן] [כן+הפעל הגדרה X] [לא]"
*               where 'X' is the parent has_* setting that would activate the whole bundle.
  ↓
build expense row (col D=category, col E=normalized_name, …)
  ↓
appendRow to תנועות                    ← unchanged
  ↓
* _updateLayer2Stats_(category_id, amount)
*       — usage_count += 1
*       — last_used = now
*       — Debounced: write Sheet every 10 rows or 60s, write KV every row (cheap).
  ↓
_updateBusinessDashboard_              ← unchanged path; the Layer 1 normalized_name is what col E holds, so existing SUMIFS keeps working
  ↓
WhatsApp reply                          ← includes the new layer1 display_name_he, not the classifier's raw subcat
```

**Concrete walkthroughs:**

*Steven types "BMW 850":*
1. `classifyWithPersonalLearning_` hits `user_custom_keywords:steven_sub` → `category_id=transport_bmw_steven`. Skip CATEGORY_MAP.
2. `_resolveCategoryId_` returns Layer 1 row for `transport_bmw_steven` (display="🚗 BMW") + Layer 2 row (already active, since `created_from=migration:old_personal`).
3. `_checkAndPromptActivation_` no-op (already active).
4. Row written: col D="עסק"=NO (it's transport), so the (default `קטגוריה`) ends up being whatever Layer 1 says (e.g. "תחבורה"); col E=`normalized_name`="תחזוקת רכב". The dashboard's existing `*BMW*` row in Steven's sheet renders ₪850 (Layer 2 has `display_name_he`="🚗 BMW", col A in dashboard).
5. WhatsApp reply: "✓ ₪850 → 🚗 BMW (תחזוקת רכב)".

*A new family-preset user types "טיטולים 89":*
1. Personal learning cache empty.
2. CATEGORY_MAP keyword "טיטולים" → cat="חינוך וילדים" subcat="חיתולים ותינוקות" (per current bot lines 302).
3. `_resolveCategoryId_` → Layer 1 row `kids_diapers` (activation_rule='on_kids').
4. Layer 2 row: not present yet, OR present with `active=FALSE`.
5. `_checkAndPromptActivation_` checks settings: `has_children=TRUE` (Family preset). Rule satisfied. Silently flip `active=TRUE`, send "✓ ₪89 → 🍼 חיתולים ותינוקות. הוספתי את הקטגוריה ללוח."

*A first-time user (Basic Personal preset) types "בטון 800":*
1. Personal learning cache empty.
2. CATEGORY_MAP doesn't match (no civil-engineering keywords in baseline).
3. LLM fallback classifies as "שונות" with low confidence (50).
4. `_resolveCategoryId_` → Layer 1 `misc_other` (default safety net).
5. NEW: `_checkAndPromptActivation_` sees low confidence + bot's profession-hint engine notices "בטון" is in profession `general_contractor.keywords_boost`. Replies: "✓ ₪800 הוקלט. שים לב — נראה שזה חומרי בניין. האם אתה קבלן בניין? אם כן — הקלד 'אני קבלן' ואני אעדכן את הקטגוריות שלך." (No row added beyond the misc_other write.)

**Race condition: bot vs dashboard UI flipping `active`:**
- Both write to Layer 2 (sheet + KV).
- Sheet writes use `getRange().setValue()` on a single row — atomic per row.
- KV writes are last-write-wins.
- The reconciliation cron (§4) makes sheet authoritative every night at 04:00 IL.
- In the rare case of mid-write contention (user toggles in UI while bot is writing), the bot's last_used wins (it's a monotonic clock); the user's active flip wins (it's an explicit user action). Both are independent fields, so no conflict.

---

## 11. Migration path for EXISTING users — idempotent, opt-in

Existing tenant sheets predate this design. We migrate per the rules in `feedback_backup_propose_apply.md` (backup → dry-run → user-gated apply) and `feedback_never_overwrite.md` (never overwrite user-typed values).

### 11.1 Migration phases

**Phase A — backfill the Master Library globally (no per-user touch).**
- One Vercel cron run (manual trigger first; promote to cron after verification): `api/admin/seed-cat-master.js`.
- Reads `lib/categories.js`, `lib/professions.js`, `bot/ExpenseBot_FIXED.gs:CATEGORY_MAP` (parsed via the same balanced-brace extraction the `tests/load_bot_source.js` pattern uses).
- Writes ~250 Layer 1 rows to KV `cat_master:v1` AND a hidden gold-template sheet (master copy that future tenant sheets copy from).
- Idempotent: every row has a deterministic `category_id`; re-run skips existing.

**Phase B — opt-in per-user backfill.**
- Surfaced in the admin dashboard + (later) the user's dashboard as a one-click "💡 שדרג את הלוח שלי" button.
- On click, runs `api/admin/migrate-user-to-profiles.js?phone=<>`.
- The migration script:
  1. **Backup first.** Snapshots the user's sheet to a new spreadsheet `Backup before profile migration YYYY-MM-DD` in their Drive. Logs the spreadsheetId to KV `migration_backup:{sub}:v1`.
  2. **Dry-run report.** Reads their existing `מאזן אישי` row labels + their last 90 days of `תנועות` writes. Diffs against the Master Library. Produces a markdown plan: "Will add קטגוריות tab (read-only), User_Category_Profile tab (X rows, Y active), Settings tab. Will NOT modify any existing tab. Will NOT delete any row."
  3. **User reviews the report.** Hidden behind `?confirm=YES_I_UNDERSTAND` query param (same pattern as `bot/MIGRATE_OLD_TO_KESEFLE.gs`).
  4. **Apply.** Creates the 3 new tabs. For Layer 2 row creation:
     - Every Layer 1 `default_active=TRUE` row gets `active=TRUE` in Layer 2.
     - Every Layer 1 row whose `keywords` substring appears in the user's last 90d of `תנועות` col F gets `active=TRUE` (auto-detect what they've been tracking).
     - Their existing dashboard rows (from `מאזן אישי` col A) get their `original_name` preserved as a Layer 1 override + Layer 2 row.
  5. **Verify.** Re-reads each new tab. Runs the formula-broken scanner (`bot/personal_sheet_fix.gs:_isBrokenDashFormula_`). Sets `Settings.last_validation_status` accordingly.
- Idempotent: re-running detects all 3 new tabs already present and exits with "already migrated" (no-op).
- Reversible: the backup spreadsheet stays in the user's Drive for ≥90 days. They can request a restore via `bot-add-command` "שחזר". The restore wipes the 3 new tabs and replaces them from the backup.

**Phase C — Steven's special case.**
- Steven gets a CUSTOM migration script `api/admin/migrate-steven.js` that runs in OLD-import mode:
  - All 23 categories from §8 are written as Layer 1 rows with `source_sheet='old_steven_personal'` + `is_custom=TRUE` where applicable.
  - The 2 person-name keywords ("אבא" #8 + "גיא" #23) seed `user_custom_keywords:steven_sub` for the bot to read at classify time.
  - Layer 2 has 23 + ~15 Basic Personal rows active.
  - Settings.template_type = `advanced_imported`.
  - Steven's existing `מאזן חברה` rows merge with Layer 1 business rows: the 4 canonical dashboard categories preserve their existing SUMIFS criteria; new Layer 2 rows attach to those.

### 11.2 What we DO NOT change in the migration

- `תנועות` tab: untouched. Every existing row keeps its col D + col E values verbatim.
- `מאזן אישי` / `מאזן חברה` tabs: untouched in v1. The new design's renderer writes to NEW tabs `מאזן אישי v2` (hidden until the user opts to switch). Once the user confirms the new dashboard looks right, they can rename or hide the old tab.
- The bot's KFL_BUILD_VERSION still ships the old CATEGORY_MAP. No bot redeploy is needed for Phase A or B. Phase C requires a bot version bump to read `user_custom_keywords:{sub}` — sequenced separately.

### 11.3 KV cost of migration

- ~250 Layer 1 reads (cached after first), 1 KV write to `cat_master:v1`.
- Per user: 1 read of `user_profile:{sub}` (or write if absent), 1 read of `user_custom_keywords:{sub}` for special-keyword users.
- Backfill cron: 1 KV write per user (`user_profile:{sub}`). For 10k users at 1 KB each = 10 MB of KV storage. Within Upstash free tier.

---

## 12. Test plan

The Kesefle test gauntlet (`tests/`, `bot/test_*.js`) already loads real source via balanced-brace extraction (no mocks). New suites follow the same pattern.

### 12.1 Schema tests (`tests/test_category_master_schema.js`)

- Loads `lib/category-master-seed.js` (NEW — exports `MASTER_CATEGORIES` array of 250 rows).
- Asserts every row has all 21 columns.
- Asserts `category_id` is unique, snake_case ASCII, no length>40.
- Asserts every `activation_rule` is in the §6 enum.
- Asserts every `source_sheet` is in the §3 enum.
- Asserts `keywords` is comma-separated, lowercased, no empty entries.
- Asserts `display_name_he` contains at least one Hebrew codepoint (Steven's `BMW` is the explicit exception — `is_custom=TRUE` rows are exempt).
- Asserts every row whose `dashboard_section='business_expense'` has a `normalized_name` in `_BIZ_DASH_SUBS` (cross-check with `bot/ExpenseBot_FIXED.gs:11039`).

### 12.2 Migration tests (`tests/test_migrate_user_to_profiles.js`)

- Mocks Upstash KV (per `test-mock-kv` skill).
- Mocks the Sheets API client.
- Runs the migration on a synthetic user fixture (90d of `תנועות` rows in 3 categories: food_groceries, transport_fuel, business_marketing).
- Asserts:
  - 3 new tabs created.
  - Layer 2 has the 3 categories + the always-on baseline (~15 rows total for basic_personal preset).
  - Settings.template_type defaults to `basic_personal`.
  - Original `מאזן אישי` untouched (cell-by-cell compare).
  - Re-running the migration is a no-op (idempotent).
  - Restoring from the backup wipes the 3 new tabs.

### 12.3 Steven-specific migration test (`tests/test_migrate_steven_old23.js`)

- Synthetic fixture: a sheet with the 23 categories in §8.
- Runs the Steven-specific migration script.
- Asserts:
  - All 23 Layer 1 rows present, with correct `category_id` per §8.
  - 9 custom rows have `is_custom=TRUE`, the other 14 have `is_custom=FALSE`.
  - `user_custom_keywords:steven_sub` KV has "אבא"→`personal_dad_steven` and "גיא"→`personal_gia_steven`.
  - "ביטוח חובה+ג׳+איתורן" has `normalized_name='ביטוח רכב'` (NOT the literal label — the + would break SUMIFS).
  - The 2 person-name rows route to family section, not misc.

### 12.4 Bot tests (`tests/test_bot_profile_routing.js`)

- Loads `bot/ExpenseBot_FIXED.gs` source via balanced-brace extraction.
- Mocks KV with synthetic `user_profile:steven_sub` + `user_custom_keywords:steven_sub`.
- Walks the 4 concrete walkthroughs from §10:
  - "BMW 850" → `category_id=transport_bmw_steven`, col D="תחבורה", col E="תחזוקת רכב", display_name_he="🚗 BMW" in the reply.
  - "טיטולים 89" (Family preset) → `category_id=kids_diapers`, auto-activates Layer 2 row.
  - "בטון 800" (Basic Personal preset) → routes to `misc_other`, prompts profession upgrade.
  - "פייסבוק מודעות 1200" (Business preset, business_marketing already active) → col D="עסק", col E="עלות שיווק". No prompt.
- Asserts `_BIZ_DASH_SUBS` keys all map to a valid Layer 1 `category_id` whose `dashboard_section='business_expense'`.

### 12.5 Activation rule tests (`tests/test_activation_rules.js`)

- 12 test cases (1 per rule in §6 + the composite `on_car AND on_kids`).
- For each: synthetic Settings + Layer 1 row → call `shouldActivate(layer1_row, settings)` → assert expected boolean.
- Forward-compat test: a Layer 1 row with `activation_rule='on_future_unknown'` returns FALSE (safe default).

### 12.6 Formula tests (`tests/test_dashboard_formula_no_hardcoded_rows.js`)

- Reads the rendered Layer 3 output for a 23-row sheet (simulate Steven's post-migration state).
- Asserts no formula in cols B..N matches the regex `=SUM\(B[0-9]+:B[0-9]+\)` UNLESS the constituent rows match the rendered row count for that section.
- Targets the bug class noted in §1.1 and `expenses_sheet_structure.md` (label-not-index principle).
- Also asserts: changing `display_order` on a Layer 2 row + re-rendering produces formulas that still sum the right rows.

### 12.7 KV reconciliation cron test (`tests/test_cron_reconcile_profiles.js`)

- Synthetic users with KV `user_profile:{sub}` desync'd from sheet.
- Run `api/cron/reconcile-profiles.js` → asserts sheet is authoritative post-run.
- Bounded-time: 50 users in <2s.

### 12.8 Manual QA checklist (Steven-driven, post-migration)

- [ ] Open his sheet. Verify all 23 category labels render exactly as he typed them (no normalisation drift in display).
- [ ] Open his `מאזן אישי` v1 — still intact, untouched.
- [ ] Send a WhatsApp "אבא 1500" — reply names "אבא" not "משפחה".
- [ ] Send "BMW 200 דלק" — routes to BMW (not generic דלק) because Steven's category_id `transport_bmw_steven` has higher priority via custom keyword.
- [ ] Toggle `Settings.has_motorcycle=TRUE` → dashboard offers to add motorcycle rows. Accept → rows render.
- [ ] Toggle to Compact view → rows with `usage_count=0` disappear.
- [ ] Toggle to Historical view → all 23 historical rows visible even if unused for 12mo+.
- [ ] Add ₪0 monthly budget on a row → no false-positive budget alert.

---

## Out of scope (explicit non-goals)

- **No cross-user category sharing in v1.** "Category marketplace" (clone Steven's BMW row to another car owner) is a v3 idea, not built here.
- **No automatic Layer 1 row creation from free-text user messages.** A user typing a brand-new word doesn't add a Layer 1 row; it adds a Layer 2 row via `bot_auto_activated` against `misc_other`. Layer 1 admin-only.
- **No deletion of system rows.** `is_system=TRUE` rows are hide-only. (Auditability + classifier stability.)
- **No per-user keyword overrides in v1 dashboard UI.** Only via admin or via the existing PERSONALIZED_LEARNING `_CORRECTIONS_` flow.
- **No translation engine.** `display_name_en` is hand-curated in Layer 1; we do NOT auto-translate per user.

---

## Open questions for Steven

1. **Steven's category #2** ("נשר + חופים → כושר + תוספים"): want to preserve BOTH names as separate rows (one for pre-rename history, one for current), or merge into one row whose label shows the current "כושר + תוספים"? Default proposed: MERGE into one row with current label; the OLD name lives in `original_name` for provenance only.
2. **Steven's category #11** ("חברה / מס הכנסה / ביטוח לאומי"): this bundles 3 expense categories. Do you want it as ONE Layer 2 row (current proposal) or 3 separate rows (`business_company_tax`, `business_income_tax`, `business_bituach_leumi`)? The 3-row version is more granular for tax season; the 1-row version preserves your existing mental model.
3. **Person-name routing** ("אבא", "גיא"): is the keyword `אבא` enough, or does it need amount > N threshold to avoid catching messages like "אבא הביא לי קפה"? Default proposed: keyword + amount ≥ 500 ILS routes to `personal_dad_steven`; below that falls through to misc / classifier.
4. **Mobile compact view top-N**: default N=5 per section. Is that right? (Could be 3 for tighter view, 8 for richer.)
5. **Migration timing**: should Phase B (existing users) be opt-in only, or do we auto-migrate everyone after 30 days of stable Phase A + your sign-off?

---

## Cross-references (file:line)

- `lib/categories.js:20` — current Pa'amonim `EXPENSE_GROUPS`. Becomes the seed for Layer 1 `paamonim` rows.
- `lib/categories.js:149` — `findGroupForSubcategory` — kept for backwards compat; new code uses Layer 1 `group` column directly.
- `lib/sheet-writer.js:55-81` — current hardcoded `PERSONAL_*_ROWS`. Layer 3 renderer replaces this with a Layer 2 query.
- `lib/sheet-writer.js:98-105` — current `COMPANY_EXPENSE_ROWS` with wildcards. The wildcards are KEPT because Layer 1 `normalized_name` is the criterion; user-typed historical variants still match via wildcard.
- `lib/sheet-writer.js:726` — `buildTenantSheetSpec(name, opts)` — gains `opts.profile_type` + `opts.has_*` to choose preset.
- `lib/profession-template.js:32` — `getProfessionRows(id)` — Layer 1 seeding now consumes this for every `profession:*` row.
- `lib/professions.js:59` — `PROFESSIONS[]` — 119 entries, ~7 categories each → ~830 Layer 1 rows from professions (deduped against Pa'amonim).
- `bot/ExpenseBot_FIXED.gs:271` — `CATEGORY_MAP[]` — 1,480 keyword rows. Layer 1 absorbs the `category`+`subcategory` strings as `normalized_name`s + the `keywords` arrays as Layer 1 col 10.
- `bot/ExpenseBot_FIXED.gs:11039` — `_BIZ_DASH_SUBS` + `bot/ExpenseBot_FIXED.gs:11077` `_normalizeBizSub_`. The 6-bucket business normalisation is the model for the broader Layer 1 `normalized_name` column.
- `bot/PERSONALIZED_LEARNING.gs:54` — `classifyWithPersonalLearning_` — the existing per-user learning layer becomes the SAME mechanism used to seed `user_custom_keywords:{sub}`.
- `bot/SCAN_OLD_CATEGORIES.gs:1` — read-only diagnostic that produces the migration input for Steven's Phase C run.
- `bot/MIGRATE_OLD_TO_KESEFLE.gs:1` — historical migration pattern (backup → dry-run → apply). New per-user profile migration follows the same shape.
- `docs/SHEET_AND_DASHBOARD_STRATEGY.md:88-97` — the 7-PR plan this design slots into (specifically PR-S4 contractor variant + PR-S6 review inbox).

---

*End of design.*
