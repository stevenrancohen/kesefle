---
name: kesefle-adaptive-category-profile-builder
description: Build and maintain personalized category profiles per Kesefle user. Steven gets his historical categories (רוביקון, אבא, גיא, חצי אירון מן). New users get a clean default template. The bot, dashboard, formulas, and admin all read from the same `קטגוריות` master + `User_Category_Profile` join. Use when migrating old categories, when onboarding a new user, when the bot encounters an unknown category, when the dashboard is missing rows that historical totals exist for, or when a user asks to add/hide/pin a category.
---

# Kesefle Adaptive Category Profile Builder

The root cause of "expenses disappeared from the new dashboard" is category drift: the bot writes a label the dashboard doesn't sum, OR the user's old categories never made it into the new sheet's row list. This skill is the canonical solution: a master category library + a per-user profile that activates the subset that user actually uses.

## The data model

### Tab: `קטגוריות` (master library — append-only)

One row per canonical category, shared by every Kesefle user.

| Column | Type    | Example                              | Notes |
|--------|---------|--------------------------------------|-------|
| `category_id`             | string | `cat_rubicon_2026_06_v1`             | Stable ID; never reused |
| `original_category_name`  | string | `רוביקון`                            | As it appears historically |
| `normalized_category_name`| string | `rubicon`                            | lowercase Latin slug, for code |
| `display_name`            | string | `רוביקון`                            | Hebrew label shown to user |
| `group`                   | string | `רכב / תחבורה`                       | Top bucket (must match `מאזן חברה` section header) |
| `section`                 | string | `רכב`                                | Sub-bucket within group |
| `subcategory`             | string | `רוביקון`                            | Granular leaf |
| `source_sheet`            | string | `OLD`                                | `OLD` / `NEW` / `BOT_LEARNED` / `USER_CREATED` |
| `source_cell`             | string | `מאזן אישי!A48`                      | Original location (for traceability) |
| `first_seen_year`         | int    | 2024                                 | First year this category was used |
| `last_seen_year`          | int    | 2026                                 | Latest year this category was used |
| `historical_total`        | number | 3564                                 | Sum across all years in OLD |
| `transaction_count`       | int    | 12                                   | Row count contributing to total |
| `active_for_steven`       | bool   | TRUE                                 | Show by default in Steven's dashboard |
| `default_for_new_users`   | bool   | FALSE                                | Pre-activated for fresh signups |
| `show_in_dashboard`       | bool   | TRUE                                 | Eligible to render on dashboard |
| `show_if_used`            | bool   | TRUE                                 | Auto-activate once user has a transaction in this category |
| `dashboard_order`         | int    | 48                                   | Sort order within section |
| `keywords`                | string | `רוביקון, Rubicon, ג'יפ, Jeep, אוטו` | Comma-separated, used for matching |
| `bot_keywords`            | string | (same as keywords typically)         | Bot-specific matcher (may include slang) |
| `formula_group`           | string | `vehicle`                            | Tag for dashboard SUMIFS criterion grouping |
| `needs_review`            | bool   | FALSE                                | True = ambiguous mapping, requires Steven |
| `notes`                   | string | `Steven's primary vehicle since 2024`| Free text |

### Tab: `User_Category_Profile` (per-user join — append-and-update)

One row per (user, category) pair. Drives which categories show up in that user's dashboard and how the bot routes their messages.

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| `user_id`           | string | `user_sub_xxx`     | KV key suffix |
| `category_id`       | string | `cat_rubicon_v1`   | FK to `קטגוריות` |
| `active`            | bool   | TRUE               | Show in this user's dashboard |
| `hidden`            | bool   | FALSE              | User explicitly hid this category |
| `pinned`            | bool   | TRUE               | Pin to top of section |
| `display_order`     | int    | 1                  | Within section, lower = top |
| `monthly_budget`    | number | 1500               | If set, triggers overspend alert |
| `yearly_budget`     | number | 18000              | If set, drives end-of-year tracking |
| `created_from`      | string | `OLD_MIGRATION`    | `OLD_MIGRATION` / `BOT_LEARNED` / `USER_REQUEST` |
| `source_sheet`      | string | `1UKrX...`         | Origin sheet ID |
| `usage_count`       | int    | 12                 | Number of transactions in this user's sheet |
| `historical_total`  | number | 3564               | Sum in this user's data |
| `last_used`         | string | `2026-05-28`       | ISO date of most recent transaction |
| `notes`             | string |                    | Free text |

### KV mirror (for hot-path bot reads)

To avoid hitting Sheets API on every bot message:

- `categories:master` → JSON snapshot of `קטגוריות`, refreshed nightly + on write
- `categories:user:{sub}` → JSON snapshot of that user's active categories, refreshed on write

Bot reads `categories:user:{sub}` first, falls back to `categories:master`.

## When to invoke

- **Old → new migration** (Steven's 2026-05-29 fire): build `קטגוריות` from OLD `מאזן אישי` + `מאזן חברה`, then build Steven's `User_Category_Profile` with `active_for_steven=TRUE` for every category with `historical_total > 0`.
- **New user onboarding**: build their `User_Category_Profile` with the subset of `קטגוריות` where `default_for_new_users=TRUE` (small, ~20 categories: housing, food, transport, etc.).
- **Bot encounters unknown category**: insert into `קטגוריות` with `source_sheet=BOT_LEARNED`, `needs_review=TRUE`, surface to admin Review Inbox.
- **User asks "create category X"**: insert into `קטגוריות` with `source_sheet=USER_CREATED` + flip their `User_Category_Profile.active=TRUE`.
- **Dashboard missing rows for historical totals**: rebuild user's profile from `historical_total > 0` filter.

## Steps for the "OLD → NEW migration" use case (Steven's current fire)

### Step 1 — Extract every category from OLD

Read OLD `מאזן אישי` + `מאזן חברה` + every year tab. For each row label (col A), record:
- original_category_name (verbatim)
- group / section (from the section header above the row)
- historical_total per year
- transaction_count

Output: a flat list of ~80-120 distinct historical categories.

### Step 2 — Normalize + dedupe

Group near-duplicates:
- `ביטוח חובה + ג׳ + איתוראן` and `ביטוח חובה+ג׳+איתוראן` → same `category_id`
- `אוכל לבית` and `אוכל`+`לבית` → keep both (Steven uses them differently)
- Spelling variants (with/without ה' / יו"ד) → one canonical

Output: ~60-80 canonical categories.

### Step 3 — Map to dashboard groups

Each category gets a `group` and `section` that EXISTS in the NEW dashboard:
- `רוביקון` → group `רכב / תחבורה`, section `רכב`
- `חצי אירון מן`, `חצי אוסטריה` → group `הוצאות זמניות`, section `ספורט/חופשות`
- `אבא`, `גיא` → group `הוצאות מיוחדות`, section `משפחה`
- `חברה / מס הכנסה / ביטוח לאומי` → group `עסק`, section `מסים`, `needs_review=TRUE`

If a category doesn't fit any existing group, propose a new one in the DRY_RUN — do not invent a tab.

### Step 4 — Tag for Steven vs new users

- Categories with `historical_total > 0` and `source_sheet=OLD` → `active_for_steven=TRUE`, `default_for_new_users=FALSE`
- Generic categories (food, transport, utilities, rent) → `default_for_new_users=TRUE`
- Steven-specific (אבא, גיא, רוביקון, חצי אירון מן) → `active_for_steven=TRUE`, `default_for_new_users=FALSE`

### Step 5 — Write `קטגוריות` (paste-once Apps Script)

Append-only. Never overwrite. If a row with the same `category_id` exists, skip.

### Step 6 — Write Steven's `User_Category_Profile`

For each row in `קטגוריות` where `source_sheet=OLD` and `historical_total > 0`, insert a row in `User_Category_Profile` with `user_id=<Steven's sub>`, `active=TRUE`, `created_from=OLD_MIGRATION`.

### Step 7 — Update bot's lookup

Refresh `categories:user:{steven_sub}` in KV. Bot now classifies `רוביקון` correctly.

### Step 8 — Update dashboard formulas

Each section in `מאזן חברה` should pull from the user's active categories, not from a hardcoded row list. Two options:

- **Phase 1 (faster)**: For each `category_id` with `active_for_steven=TRUE`, ensure a row exists in `מאזן חברה` with label = `display_name`, and a SUMIFS formula filtering `תנועות!E:E = display_name` and `תנועות!B:B = $B$4&"-MM"`.
- **Phase 2 (cleaner)**: A helper tab `_DASHBOARD_DRIVER_` reads `User_Category_Profile` for the current user and dynamically builds the formulas. (Long-term.)

Start with Phase 1.

### Step 9 — Validate

For each migrated category, prove the new dashboard shows the same year-total as the old sheet. Use the VALIDATE format from the `kesefle-financial-data-integrity-guard` skill.

## Steven's must-preserve categories (2026-05-29)

These MUST land in `קטגוריות` AND in Steven's `User_Category_Profile.active=TRUE`. None may default to new users.

```
הוצאות קבועות / בית:
  ארנונה, נשר + חופים, חשמל, אוכל, קולקציות,
  כבלים-אינטרנט-פלאפון, לימודים, ביטוח אישי,
  אבא, בדיקות, טיפולים, חברה/מס הכנסה/ביטוח לאומי

רכב / תחבורה:
  ביטוח חובה + ג׳ + איתוראן, טסט רכב, חניונים, מים,
  BMW, דלק, אוכל/מזון/רכבת, רוביקון

הוצאות זמניות / מיוחדות:
  חצי אירון מן, חצי אוסטריה, עורך דין, בנק הפועלים,
  חופשות, גיא
```

## The Rubicon rule (special, explicit)

`רוביקון` is Steven's car. It belongs under `רכב / תחבורה`. Never `שונות`. Never its own tab.

Sub-leaves under `רוביקון`:
- דלק
- ביטוח
- טסט
- טיפולים
- חניה
- כביש 6
- שטיפה
- תיקונים
- אביזרים

Bot keywords for the parent: `רוביקון`, `Rubicon`, `ג'יפ`, `Jeep`, `רכב`, `אוטו`.

## Anti-patterns this skill forbids

- Creating a tab named after a category (no `רוביקון` tab — it's a row).
- Routing unknown categories to `שונות` silently — they go to `קטגוריות` with `needs_review=TRUE`.
- Forcing Steven's `אבא` / `גיא` / `חצי אירון מן` onto a new user's default profile.
- Writing to OLD sheet during migration (read-only forever).
- Renaming `קטגוריות` row labels without also fixing every SUMIFS that references them.
- Letting bot, dashboard, and admin disagree on the spelling of a category.

## Output format when this skill builds a profile

```
[ADAPTIVE_CATEGORY_PROFILE_BUILDER]
User:               <user_sub or 'master'>
Categories examined: <N>
Already in קטגוריות: <N>
Inserted in קטגוריות: <N>  (source_sheet breakdown: OLD <n>, BOT_LEARNED <n>, USER_CREATED <n>)
User_Category_Profile rows inserted/updated: <N>
KV mirror refreshed: <yes/no, key>
Bot keyword sync needed: <yes/no, which categories>
Dashboard rows to add: <N>  (handoff to sheet-formula-year-selector-validator)
needs_review categories: <N>  (handoff to admin Review Inbox)
Status: PROFILE_BUILT | NEEDS_REVIEW | BLOCKED
```
