# Ten Adaptive Tenant-Sheet Templates — registry spec

**Author:** Claude (epic #271 — smarter, personalized bot)
**Date:** 2026-06-01
**Status:** DESIGN PROPOSAL — DOCS ONLY. No code in this PR. Steven to approve before any code lands.
**Scope:** the ~10 adaptive sheet templates (epic #271 deliverable 3) and the
data structure `buildTenantSheetSpec` consumes so that **adding a template is data,
not code**.

**Companion docs (read alongside):**
- [PERSONALIZED_CATEGORY_PROFILES.md](./PERSONALIZED_CATEGORY_PROFILES.md) — the 3-layer
  master-library / user-profile / renderer architecture this slots into. §7 of that doc
  defined the *original* 6 presets; this doc supersedes it with the **full 10** and gives
  the concrete registry shape.
- [SHEET_AND_DASHBOARD_STRATEGY.md](./SHEET_AND_DASHBOARD_STRATEGY.md) — the PR-S4 contractor
  variant. That doc proposed `buildTenantSheetSpec(profileType)` *branching* on
  `profileType === 'contractor'`. This doc replaces the branch with a **registry lookup**.

**Live code this spec is built on (exact anchors):**
- `lib/sheet-writer.js` — `buildTenantSheetSpec(name, opts)` (currently reads only `opts.year`;
  hardcoded `PERSONAL_INCOME_ROWS` / `PERSONAL_FIXED_ROWS` / `PERSONAL_VARIABLE_ROWS` /
  `PERSONAL_FOOD_ROWS` / `PERSONAL_TRANSPORT_ROWS` / `PERSONAL_MISC_ROWS` at lines 55-111,
  `COMPANY_EXPENSE_ROWS` at 128-135). Tab builders `_buildPersonalDashboardTab` (319),
  `_buildTxTab` (208), `_buildOrdersTab` (225), `_buildCompanyDashboardTab` (495),
  `_buildExtendedDashboardTab` (636). Year selector `_sw_yearSelector` (185),
  `YEAR_SELECTOR_VALUES` (173).
- `lib/categories.js` — `EXPENSE_GROUPS` (16 groups), `INCOME_GROUPS` (3 groups),
  `findGroupForSubcategory`, `isIncomeGroup`.
- `api/profile.js` — `PROFILE_TYPES` (the 10 ids, line 72), `profile:<phone>` KV record shape.
- `bot/ExpenseBot_FIXED.gs` — `_TEMPLATE_PRESETS_` (5966), `_ONBOARDING_PRESETS_` (5694),
  `_onboardingPickPreset_` (5752), `applyTemplatePreset_` (6082), `_SURVEY_TRACKING_` (4715),
  `_SURVEY_NEED_` (4721), the 0.6 floor `_aiAskFloor_` (9975), `matchCategorySmart` (9480).
- `lib/profession-template.js` — `getProfessionRows`, `getProfessionVat`, `getProfessionTemplateExtras`.

---

## 0. TL;DR — what this doc decides

1. **One registry, one source of truth.** A new `lib/sheet-templates.js` exports
   `TEMPLATE_REGISTRY` — a plain data array of 10 template objects. `buildTenantSheetSpec`
   takes `opts.templateId` (or `opts.profileType`), looks the entry up, and assembles the
   sheet from that entry's `tabs[] / incomeRows[] / categoryRows[] / businessTabs[]`. No
   `if (profileType === 'contractor')` branches anywhere.
2. **The 10 ids are already fixed** by `api/profile.js PROFILE_TYPES` and the bot's
   `_TEMPLATE_PRESETS_`: `basic_personal, couple, family, divorced, employee, freelancer,
   business, contractor, mixed, advanced_imported`. This doc does NOT invent new ids — it
   gives each one a complete `tabs/rows/businessTabs` body.
3. **Backwards compatible.** The current hardcoded `basic_personal` shape (34 personal rows +
   4 company rows + extended Pa'amonim tab) becomes the `basic_personal` registry entry,
   byte-for-byte. Every existing tenant sheet keeps working; an old caller that passes no
   `templateId` resolves to `basic_personal` and gets exactly today's sheet.
4. **The bot's `applyTemplatePreset_` extraRows stop being a parallel list.** Today the bot
   seeds extra rows *after* sheet creation via `_addCategoryRows_`. Once the registry exists,
   those `extraRows` are *derived from* the registry entry (single source), so the post-create
   seed and the at-create build can never drift. (Migration of that call is staged — see §9.)
5. **The year-selector + SUMIFS architecture is inherited, not reinvented.** Every dashboard
   tab a template emits uses the exact `$B$N` strict-validated year cell + the
   `SUMIFS('תנועות'!C:C, 'תנועות'!B:B, $B$N&"-MM", 'תנועות'!E:E, "*"&$A{row}&"*")` pattern
   that ships today. The registry decides *which rows exist*; the row-formula machinery is
   unchanged.

---

## 1. Why a registry (the problem with the status quo)

Today there are **three disconnected places** that each encode "what categories a user gets":

| Place | What it encodes | Shape |
|---|---|---|
| `lib/sheet-writer.js:55-135` | The 34 personal rows + 4 company rows every sheet is born with | hardcoded `const` arrays, baked into tab-builder functions |
| `bot/ExpenseBot_FIXED.gs:5966 _TEMPLATE_PRESETS_` | The EXTRA rows each of 10 presets adds AFTER creation | a 10-key object of `{ label, sections[], extraRows[] }` |
| `lib/professions.js` (119 entries) | Per-profession income/expense subs + boost keywords | data, but `buildTenantSheetSpec` ignores it entirely |

The failure this produces (documented in PERSONALIZED_CATEGORY_PROFILES.md §1.2): a
contractor's sheet is *built* with the Basic-Personal 34 rows, then the bot *bolts on* a few
business rows post-hoc. The two lists are maintained by hand in different files and languages
(JS vs Apps Script). When they disagree — e.g. the bot seeds `'עלות חומרי גלם'` but the
company dashboard's `COMPANY_EXPENSE_ROWS` criterion is `'*חומרי גלם*'` — a row can exist with
no formula summing it, or a formula can sum a row that does not exist.

**The fix: one registry both sides read.** `buildTenantSheetSpec` builds from it at creation.
`applyTemplatePreset_` (or its successor) reads the SAME entry to know what to top-up for an
existing sheet. `lib/professions.js` rows are *merged into* the relevant entries at build time
via a documented merge rule (§6), not ignored.

**Design principle (inherited from PERSONALIZED_CATEGORY_PROFILES.md §2):** the registry is the
*render plan*, never the classifier. It says "this template shows these rows." It never decides
how text maps to a category — that stays in `CATEGORY_MAP` + `matchCategorySmart` + the AI
fallback, all gated by the 0.6 floor.

---

## 2. The TEMPLATE REGISTRY shape

New file: **`lib/sheet-templates.js`** (ESM, pure data + 3 tiny pure helpers, zero I/O — same
posture as `lib/categories.js`). Exports `TEMPLATE_REGISTRY` (array of 10) plus
`getTemplate(id)`, `resolveTemplateId(profileTypeOrId)`, `templateIdFromOnboarding(profile)`.

### 2.1 The `TemplateEntry` object (the contract the task asked for)

```js
/**
 * @typedef {Object} CategoryRow
 * @property {string}   id            ASCII snake_case stable id. FK target for the
 *                                    Layer-2 user profile (PERSONALIZED_CATEGORY_PROFILES §4).
 *                                    NEVER renamed — renaming breaks tenant SUMIFS history.
 * @property {string}   label         Hebrew display label written into dashboard col A.
 *                                    Also the SUMIFS criterion seed: the row formula matches
 *                                    תנועות col E against "*"+label+"*" (the live pattern in
 *                                    _personalCategoryRow, sheet-writer.js:255).
 * @property {string[]} [criteria]    OPTIONAL. Explicit SUMIFS criteria when the label alone
 *                                    is not the right match key (e.g. business rows that roll
 *                                    several classifier outputs into one row). Each becomes one
 *                                    SUMIFS; they are summed. Mirrors COMPANY_EXPENSE_ROWS
 *                                    (sheet-writer.js:128). When omitted, criteria = ["*"+label+"*"].
 * @property {('income'|'fixed'|'variable'|'food'|'transport'|'misc'|'business_revenue'|'business_expense'|'historical_personal')} section
 *                                    Which dashboard section/total the row rolls into. Drives
 *                                    section grouping + the section-total SUM range.
 * @property {string}   [group]       lib/categories.js group key (EXPENSE_GROUPS[].key /
 *                                    INCOME_GROUPS[].key). Provenance + pie-chart grouping.
 * @property {string}   activation    One of the §6 rules: 'always' | 'on_keyword' | 'on_business'
 *                                    | 'on_kids' | 'on_car' | 'on_pets' | 'on_rent' | 'on_mortgage'
 *                                    | 'on_employees' | 'on_studies' | 'on_subscriptions'.
 *                                    'always' rows render unconditionally; the rest are gated by
 *                                    the user's has_* Settings (PERSONALIZED_CATEGORY_PROFILES §6).
 * @property {boolean}  [income]      true ⇒ this is an income row (col H side). Default false.
 *                                    Convenience mirror of (section === 'income' || isIncomeGroup(group)).
 */

/**
 * @typedef {Object} TabSpec
 * @property {('personal_dashboard'|'transactions'|'orders'|'company_dashboard'|'extended_dashboard'|'projects'|'clients'|'historical'|'crypto_holdings'|'settings'|'categories'|'user_profile')} kind
 *                                    The builder to invoke. Maps 1:1 to a _buildXTab() function.
 * @property {string}   title        Hebrew (or ASCII for control tabs) tab title, e.g. 'מאזן אישי'.
 * @property {number}   index        Display order in the Sheets UI (existing convention:
 *                                    sheet-writer.js sets מאזן אישי index 0, תנועות 1, …).
 * @property {('B1'|'B2'|'B4')} [yearCell] Which cell holds the strict ONE_OF_LIST year selector
 *                                    that this tab's SUMIFS reference. Inherited verbatim from
 *                                    _sw_yearSelector + YEAR_SELECTOR_VALUES. Dashboard tabs only.
 * @property {boolean}  [hidden]     Hidden by default (Settings / קטגוריות / User_Category_Profile).
 */

/**
 * @typedef {Object} TemplateEntry
 * @property {string}   id           One of PROFILE_TYPES (api/profile.js:72). PK.
 * @property {string}   label        Hebrew display label (matches _ONBOARDING_PRESETS_).
 * @property {string}   summary      One-line Hebrew description for the onboarding summary card.
 * @property {TabSpec[]} tabs        Ordered tabs this template materialises. ALWAYS includes
 *                                    transactions + personal_dashboard (the invariant base).
 * @property {CategoryRow[]} incomeRows     Income rows for the personal dashboard income section.
 * @property {CategoryRow[]} categoryRows   Expense rows for the personal dashboard (all non-income
 *                                          sections: fixed/variable/food/transport/misc + any
 *                                          historical_personal rows).
 * @property {CategoryRow[]} businessRows   Rows for the COMPANY dashboard (business_revenue /
 *                                          business_expense). Empty for personal-only templates.
 * @property {TabSpec[]} businessTabs       The business-side tabs (company_dashboard, projects,
 *                                          clients). Empty for personal-only templates. These are
 *                                          a SUBSET of `tabs` surfaced separately so the renderer +
 *                                          the admin user-template audit can answer "does this
 *                                          template light up the business block?" without parsing tabs.
 * @property {Object}   settingsDefaults    The has_* flags this template seeds into the Settings tab
 *                                          (PERSONALIZED_CATEGORY_PROFILES §5). e.g.
 *                                          { has_family:true, has_children:true, has_business:false }.
 * @property {Object}   [professionMerge]   Merge policy for lib/professions.js rows (see §6):
 *                                          { enabled:boolean, into:'business_expense'|'business_revenue',
 *                                            cap:number }.
 */
```

### 2.2 Why these exact fields

- The task asked for `id, label, tabs[], categoryRows[], incomeRows[], businessTabs[]`. All
  present. `businessRows` + `settingsDefaults` + `professionMerge` are added because they are
  load-bearing for a *buildable* spec (you cannot emit a contractor sheet from
  `tabs/incomeRows/categoryRows` alone — you need the business rows and the has_* seed).
- `CategoryRow.id` is the FK that ties the registry to PERSONALIZED_CATEGORY_PROFILES.md's
  Layer-2 `User_Category_Profile`. The registry is the *default* set; per-user activation lives
  in Layer 2. Same id space, so the two never need a translation table.
- `CategoryRow.label` doubling as the SUMIFS-criterion seed is **not new** — it is exactly how
  `_personalCategoryRow` works today (`"*"&$A{row}&"*"`). The registry just makes the list of
  labels data instead of a `const` array.
- `criteria[]` exists for the business rows because `COMPANY_EXPENSE_ROWS` already needs
  multi-criterion rows (e.g. `{ label:'🏢 הוצאות תפעוליות', criteria:['*תפעולי*','יועצים','תוכנות','ציוד עסקי','מיסים'] }`).

### 2.3 The pure helpers

```js
export function getTemplate(id) {
  return TEMPLATE_REGISTRY.find(t => t.id === id) || TEMPLATE_REGISTRY.find(t => t.id === 'basic_personal');
}

// Tolerant of casing/whitespace, mirrors bot _resolveTemplatePresetId_ (6058).
export function resolveTemplateId(profileTypeOrId) {
  const id = String(profileTypeOrId == null ? '' : profileTypeOrId).toLowerCase().trim();
  return TEMPLATE_REGISTRY.some(t => t.id === id) ? id : 'basic_personal';
}

// PURE port of the bot's _onboardingPickPreset_ (5752) so the WEB path and the BOT path
// derive the SAME id from the SAME profile object. Single source for the mapping.
export function templateIdFromOnboarding(profile) { /* §7 truth table */ }
```

---

## 3. How `buildTenantSheetSpec` consumes the registry

The signature gains one optional field; the existing `opts.year` is untouched. **No behaviour
change when `templateId` is absent.**

```js
// lib/sheet-writer.js  (proposed)
import { getTemplate, resolveTemplateId } from './sheet-templates.js';

export function buildTenantSheetSpec(name, opts) {
  const o = opts || {};
  const defaultYear = (typeof o.year === 'number' && o.year >= 2000 && o.year < 3000)
    ? o.year : new Date().getFullYear();

  // NEW: resolve the template. Absent / unknown -> basic_personal (today's exact sheet).
  const tpl = getTemplate(resolveTemplateId(o.templateId || o.profileType));

  // Build each tab the template lists, in its declared index order.
  const sheets = tpl.tabs.map(tab => buildTabFromSpec(tab, tpl, defaultYear));

  return {
    properties: { title: String(name || "כספ'לה").slice(0, 200), locale: 'iw_IL', timeZone: 'Asia/Jerusalem' },
    sheets,
  };
}
```

`buildTabFromSpec(tab, tpl, year)` is a thin dispatcher over the *existing* tab builders —
they are refactored to take their row list as a parameter instead of reading the module-level
`const`s:

| `tab.kind` | Builder (today → proposed) | Row source |
|---|---|---|
| `personal_dashboard` | `_buildPersonalDashboardTab(year)` → `_buildPersonalDashboardTab(year, tpl.incomeRows, tpl.categoryRows)` | registry |
| `transactions` | `_buildTxTab()` (unchanged) | n/a (fixed header) |
| `orders` | `_buildOrdersTab()` (unchanged) | n/a (fixed header) |
| `company_dashboard` | `_buildCompanyDashboardTab(year)` → `_buildCompanyDashboardTab(year, tpl.businessRows)` | registry |
| `extended_dashboard` | `_buildExtendedDashboardTab(year)` (unchanged — still full Pa'amonim) | `lib/categories.js` |
| `projects` | `_buildProjectsTab(year)` **NEW** | template-fixed (§5.8) |
| `clients` | `_buildClientsTab()` **NEW** | template-fixed |
| `historical` | `_buildHistoricalTab(year, tpl.categoryRows.filter(historical_personal))` **NEW** | registry |
| `crypto_holdings` | `_buildCryptoTab(year)` **NEW** | template-fixed (§5.9) |
| `settings` | `_buildSettingsTab(tpl.settingsDefaults)` **NEW** | registry |
| `categories` | `_buildCategoriesMasterTab()` **NEW (hidden)** | `cat_master` (PERSONALIZED_CATEGORY_PROFILES §3) |
| `user_profile` | `_buildUserProfileTab(tpl)` **NEW (hidden)** | registry seeds Layer-2 |

**The critical refactor (position-safety):** the personal-dashboard section-total rows today use
**hardcoded** ranges (`=SUM(B16:B27)`, `=B28+B35+B40+B51+B59`) that assume fixed row counts
(fixed=12, variable=4, …). When the row list becomes variable per template, those ranges MUST be
**computed from the emitted rows**, exactly as `_buildExtendedDashboardTab` already does (it
tracks `currentRow` and builds `SUM(B${firstRow}:B${lastRow})` dynamically, sheet-writer.js:680).
So the personal-dashboard builder adopts the extended builder's dynamic-range technique. This is
the single highest-risk change and is called out as its own PR (§9, PR-2) with a golden-snapshot
test that asserts `basic_personal` emits byte-identical formulas to today.

---

## 4. The inherited year-selector + SUMIFS architecture (unchanged, stated for completeness)

Every dashboard tab a template emits inherits **exactly** what ships today. A template author
never re-specifies any of this; it is implied by `tab.kind` + `tab.yearCell`.

1. **Year cell.** A strict `ONE_OF_LIST` dropdown (`_sw_yearSelector`, values
   `2023..2030`) on the tab's `yearCell`. Personal/extended → `$B$2`/`$B$1`; company → `$B$4`.
   Strict validation means the cell can never blank out and silently zero every formula
   (the bug `_sw_yearSelector` was created to prevent, sheet-writer.js:167-198).
2. **Monthly SUMIFS (expense/income rows).** Per the live `_personalCategoryRow` (255):
   ```
   =IFERROR(SUMIFS('תנועות'!C:C, 'תנועות'!B:B, $B$2&"-MM", 'תנועות'!E:E, "*"&$A{row}&"*"), 0)
   ```
   where col B is the `YYYY-MM` key `buildExpenseRow` writes (sheet-writer.js:1252) and col E is
   the subcategory. The `"*"&$A{row}&"*"` wildcard is why renaming a row label in col A
   auto-rebinds the formula. A `CategoryRow.criteria[]` overrides the `"*"&label&"*"` default.
3. **Annual column (B).** `=SUM(C{row}:N{row})`.
4. **Section totals.** `=SUM(B{first}:B{last})` over the section's rows — **computed**, not
   hardcoded (see §3 critical refactor).
5. **Company revenue/orders (company_dashboard).** Date-range SUMIFS/COUNTIFS over the הזמנות
   tab keyed on `$B$4`, per `_buildCompanyDashboardTab` (534):
   ```
   =IFERROR(SUMIFS('הזמנות'!D:D, 'הזמנות'!A:A, ">="&DATE($B$4,M,1), 'הזמנות'!A:A, "<"&DATE($B$4,M+1,1)), 0)
   ```
6. **Company expense rows.** Per-criterion SUMIFS filtered to `col D = "עסק"`, summed
   (`_buildCompanyDashboardTab` 569). This is what `businessRows[].criteria` feeds.
7. **Pie charts + column widths.** Emitted post-create by `buildPieChartRequests` (855) +
   `buildColumnWidthRequests` (927), driven off tab titles in the create response — unchanged;
   they already key on `EXTENDED_DASHBOARD_TAB` / tab titles, so any template that includes those
   tabs gets the charts for free.

**The bot write side is already compatible.** `buildExpenseRow` writes col D=category (top),
col E=subcategory, col B=`YYYY-MM`. Every template's rows match on col E via wildcard, and the
business rows match `col D="עסק"`. No template needs a bot change to be *summed correctly* — the
bot change (§9) is only to *pick the right template id at signup*.

---

## 5. The 10 templates — concrete bodies

Notation per template: **Tabs** (which `tab.kind`s, in index order) · **Income rows** ·
**Expense category rows** (with `section`) · **Business rows** · **Settings defaults** ·
**Inherits** (year-selector cells). Row labels are the live Hebrew the classifier already
writes (so SUMIFS sweeps real transactions); ids are the stable ASCII FKs.

The **shared base** (every template) is the current `basic_personal` skeleton:
- Tabs always present: `personal_dashboard` (B2), `transactions`, `extended_dashboard` (B1),
  plus the hidden control tabs `settings`, `categories`, `user_profile`.
- Base income rows (4): `income_salary`(הכנסה 1 — משכורת), `income_business`(הכנסה 2 — עסק),
  `income_extra`(הכנסה 3 — נוסף), `income_misc`(שונות (הכנסות)). All `section:'income'`,
  `activation:'always'`. (These mirror `PERSONAL_INCOME_ROWS`, sheet-writer.js:55.)
- Base expense rows = today's `PERSONAL_FIXED_ROWS` (12) + `PERSONAL_VARIABLE_ROWS` (4) +
  `PERSONAL_FOOD_ROWS` (2) + `PERSONAL_TRANSPORT_ROWS` (8) + `PERSONAL_MISC_ROWS` (5) = 31 rows,
  with `activation` assigned per §6 (`always` for housing/food/utilities; `on_car` for the
  transport.car rows; `on_kids` for תינוק; etc.).

Below, each template lists only its **delta** from the shared base (what it ADDS / FLIPS),
plus the full business block where relevant. This matches how the bot's `_TEMPLATE_PRESETS_`
already models it (extraRows = delta).

### 5.1 `basic_personal` — אישי בסיסי (default)
- **Tabs:** base only (`personal_dashboard`, `transactions`, `extended_dashboard`, +control). No `orders`, no `company_dashboard`.
- **Income/Expense rows:** the shared base exactly (4 income + 31 expense). **Byte-identical to today.**
- **Business:** none.
- **Settings defaults:** `{ has_family:true, has_car:true, has_subscriptions:true, has_business:false, has_children:false }`.
- **professionMerge:** `{ enabled:false }`.
- **Inherits:** B2 (personal), B1 (extended).
- **Maps from onboarding:** `q1_personal`, or any answer that doesn't trigger a more specific id (the safe fallback).

### 5.2 `couple` — זוג
- **Delta income (+1):** `income_partner`(הכנסת בן/בת זוג, always).
- **Delta expense (+2, section:'misc'):** `shared_expenses`(הוצאות משותפות), `couple_gifts`(מתנות וזוגיות).
- **Tabs / business / inherits:** same as basic_personal.
- **Settings:** base + `has_family:true`.
- **Maps from onboarding:** not auto-derived by the current questionnaire (no "are you a couple?" question). Selectable. `templateIdFromOnboarding` returns `basic_personal` until a question exists (documented gap, §7). Mirrors bot `_onboardingPickPreset_` note (5748).

### 5.3 `family` — משפחתי (ילדים)
- **Delta expense (+6):** `kids_education`(חינוך וגן, on_kids), `kids_classes`(חוגים, on_kids), `kids_clothing`(ביגוד ילדים, on_kids), `kids_toys`(צעצועים, on_kids), `kids_pediatrician`(רופא ילדים, on_kids), `baby`(תינוק, on_kids — note base already has תינוק in fixed; family promotes the kids bundle). All `section:'variable'` except `kids_education` (`section:'fixed'`).
- **Tabs / business:** same as basic_personal.
- **Settings:** base + `has_children:true`.
- **Maps from onboarding:** `q1_family` **or** `q1_group` (`_SURVEY_TRACKING_` maps both to family/group → `_onboardingPickPreset_` returns `family`, bot line 5768).

### 5.4 `divorced` — גרוש/ה
- **Delta expense (+4):** `child_support_paid`(מזונות ילדים, always, section:'fixed'), `alimony`(דמי מזונות, always, section:'fixed'), `kids_education`(חינוך וגן, on_kids), `second_household`(משק בית שני, always, section:'fixed').
- **Delta income (+1, optional):** `child_support_received`(קבלת מזונות, on_keyword, income) — gated so a payer doesn't see a receiver row.
- **Settings:** base + `has_children:true`.
- **Maps from onboarding:** not auto-derived (no divorce question). Selectable; falls back to `family`/`basic_personal`.

### 5.5 `employee` — שכיר/ה
- **Delta expense (+4, section:'fixed'):** `pension`(פנסיה, always), `keren_hishtalmut`(קרן השתלמות, always), `commute`(נסיעות לעבודה, always), `health_insurance`(ביטוח בריאות, always).
- **Settings:** base (no business).
- **Maps from onboarding:** not auto-derived (the questionnaire has no "salaried vs self-employed" toggle that maps here; a salaried profession on a personal tracker currently routes to `mixed`, see §7 + bot `_PROFESSION_IS_SELF_EMPLOYED_`). Selectable.

### 5.6 `freelancer` — עצמאי/ת (פרילנס) [עוסק פטור]
- **Tabs:** base **+ `orders` + `company_dashboard` (B4)**.
- **Delta income (+1):** `business_income`(הכנסה מעסק, on_business, income).
- **Business rows (company_dashboard, section:'business_expense'):**
  `business_marketing`(📣 עלות שיווק, `criteria:['*שיווק*']`), `business_software`(🧩 תוכנות ומנויים, `criteria:['תוכנות','*מנוי*']`), `business_equipment`(🛠 ציוד עסקי, `criteria:['ציוד עסקי']`), `business_consultants`(🤝 יועצים ושירותים, `criteria:['יועצים']`).
  (Light set — NO raw-materials / shipping / employees / VAT-morsheh ledger.)
- **businessTabs:** `[company_dashboard]`.
- **Settings:** base + `has_business:true` (osek=patur).
- **professionMerge:** `{ enabled:true, into:'business_expense', cap:6 }`.
- **Maps from onboarding:** `q1_business`/`q1_both` **AND** section E `osekType==='patur'` **AND** not a construction trade → `freelancer` (bot line 5766).

### 5.7 `business` — בעל עסק [עוסק מורשה, full ledger]
- **Tabs:** base **+ `orders` + `company_dashboard` (B4)**.
- **Delta income (+1):** `business_income`(הכנסה מעסק, on_business, income).
- **Business rows (the 4 canonical COMPANY_EXPENSE_ROWS + tax/admin), section:'business_expense':**
  `business_raw_mat`(🎨 עלות חומרי גלם, `['*חומרי גלם*']`), `business_marketing`(📣 עלות שיווק, `['*שיווק*']`), `business_shipping`(🚚 משלוחים והתקנות, `['*משלוח*','*אריזה*']`), `business_ops`(🏢 הוצאות תפעוליות, `['*תפעולי*','יועצים','תוכנות','ציוד עסקי','מיסים']`), `business_software`(🧩 תוכנות ומנויים), `business_equipment`(🛠 ציוד עסקי), `business_taxes`(🧾 מיסים, `['מיסים','מע"מ','מקדמות']`), `business_salaries`(👥 שכר עובדים, on_employees).
  **The first four MUST match `COMPANY_EXPENSE_ROWS` (sheet-writer.js:128) verbatim** so the live company dashboard keeps summing.
- **businessTabs:** `[company_dashboard]`.
- **Settings:** base + `has_business:true` (osek=morsheh), `has_employees:false`.
- **professionMerge:** `{ enabled:true, into:'business_expense', cap:8 }`.
- **Maps from onboarding:** `q1_business`/`q1_both` AND section E `osekType ∈ {morsheh, company}` AND not contractor → `business` (bot line 5767).

### 5.8 `contractor` — קבלן / פרויקטים
- **Tabs:** base **+ `orders` + `company_dashboard` (B4) + `projects` (B4) + `clients`**.
- **Delta income (+2):** `project_income`(הכנסה מפרויקט, on_business, income), `retainer_income`(הכנסה מריטיינר, on_business, income).
- **Business rows (section:'business_expense'):** `business_raw_mat`(🎨 עלות חומרי גלם, `['*חומרי גלם*','*חומרי בניין*']`), `subcontractors`(👷 קבלני משנה, `['קבלני משנה','*קבלן משנה*']`), `business_marketing`(📣 עלות שיווק), `tools_equipment`(🧰 ציוד וכלים, `['ציוד וכלים','*כלי עבודה*']`), `business_consultants`(🤝 יועצים ושירותים), `business_taxes`(🧾 מיסים).
- **`projects` tab (NEW, §5.8a):** one row per project: cols `שם פרויקט | לקוח | תקציב | הכנסות בפועל | עלויות בפועל | רווח | % רווחיות`. Revenue pulls from הזמנות by a project tag; costs pull from תנועות where col F (free-text) or a future col contains the project name. Year-gated on `$B$4`. (Aligns with SHEET_AND_DASHBOARD_STRATEGY PR-S4 "רווחיות פרויקט".)
- **`clients` tab (NEW):** `שם לקוח | סה"כ הכנסות | מס' הזמנות | הזמנה אחרונה` — SUMIFS/COUNTIFS over הזמנות col B (שם לקוח).
- **businessTabs:** `[company_dashboard, projects, clients]`.
- **Settings:** base + `has_business:true`, `has_projects:true`.
- **professionMerge:** `{ enabled:true, into:'business_expense', cap:8 }` (general_contractor / electrician / plumber rows from `lib/professions.js`).
- **Maps from onboarding:** `q1_business`/`q1_both` AND (construction profession via `_ONBOARDING_CONTRACTOR_PROFESSIONS_` OR section F `tracksProjects===true`) → `contractor` (bot line 5763). Highest precedence.

### 5.9 `mixed` — משולב (אישי + עסק) [employee + side hustle; Steven's everyday]
- **Tabs:** base **+ `orders` + `company_dashboard` (B4)**.
- **Delta income (+1):** `side_business_income`(הכנסה מעסק צדדי, on_business, income).
- **Business rows (compact side-business block, section:'business_expense'):** `business_marketing`(📣 עלות שיווק), `business_software`(🧩 תוכנות ומנויים), `business_equipment`(🛠 ציוד עסקי), `business_consultants`(🤝 יועצים ושירותים), `business_ops`(🏢 הוצאות תפעוליות, `['*תפעולי*','מיסים']`).
- **businessTabs:** `[company_dashboard]`.
- **Settings:** base + `has_business:true` (osek=patur by default).
- **professionMerge:** `{ enabled:true, into:'business_expense', cap:6 }`.
- **Maps from onboarding:** personal tracker (`q1_personal`) with a self-employed profession (`_PROFESSION_IS_SELF_EMPLOYED_` true) and no import wish → `mixed` (bot line 5771).

### 5.10 `advanced_imported` — מתקדם (ייבוא היסטוריה) [power-user / migrant]
- **Tabs:** base **+ `orders` + `company_dashboard` (B4) + `historical` (B2)**.
- **Income:** base + `business_income`(הכנסה מעסק, on_business).
- **Expense rows:** base **+ the user's imported `historical_personal` rows** (for Steven: the 23 from PERSONALIZED_CATEGORY_PROFILES §8 — e.g. `transport_bmw_steven`/🚗 BMW, `personal_dad_steven`/👨 אבא, `src_collection_business`/💼 קולקציות, `sport_triathlon_steven`/🏊 חצי אירון מן). These land with `section:'historical_personal'` and preserve the user's literal `label` while normalizing the SUMIFS criterion via `criteria[]`).
- **Business rows:** the §5.7 baseline (so the company dashboard is non-empty on day one) — real rows then arrive from the importer.
- **`historical` tab (NEW):** renders `section:'historical_personal'` rows + view-mode "Historical" from PERSONALIZED_CATEGORY_PROFILES §9.4.
- **businessTabs:** `[company_dashboard]`.
- **Settings:** read from the OLD sheet's tab inventory at migration time (e.g. a `מאזן חברה` tab present ⇒ `has_business:true`).
- **professionMerge:** `{ enabled:true, into:'business_expense', cap:10 }`.
- **Maps from onboarding:** any personal tracker with section H `wantsImport===true` → `advanced_imported` (bot line 5769). Also the preset Steven self-selects.

### 5.11 Two templates the task listed that the 10 ids already cover

The task's example list named *Student* and *Crypto/Trading* as candidate templates. The frozen
10-id space (api/profile.js) does not have dedicated `student` / `crypto` ids. Two honest options
— flagged for Steven's decision, **not silently invented**:

- **Student** → today maps to `basic_personal` + Settings `has_studies:true` (which activates the
  `education_*` rows via the `on_studies` rule, PERSONALIZED_CATEGORY_PROFILES §6). No new id
  needed; it is a has_* flavor of basic_personal. If Steven wants a first-class `student` id, it
  is a one-line add to `PROFILE_TYPES` + one registry entry (delta: `tuition`, `student_rent`,
  `student_loans`, `part_time_income`).
- **Crypto/Trading** → needs a real new tab (`crypto_holdings`, §5.9-builder) and is **not**
  representable as a has_* flavor. Recommendation: add a `crypto` id when Steven greenlights the
  feature. The registry already reserves `tab.kind:'crypto_holdings'` so the builder slot exists.
  Until then, crypto users select `mixed` and log trades as business income/expense.

**Net:** all 10 frozen ids get a complete body above. Student is a documented has_* recipe;
Crypto is a documented future 11th id with its builder slot pre-reserved. This keeps "adding a
template is data" true (Student = data today; Crypto = data + one new builder).

---

## 6. Activation rules & profession merge (how rows light up)

Inherited verbatim from PERSONALIZED_CATEGORY_PROFILES.md §6. Each `CategoryRow.activation`
is evaluated against the Settings tab to decide whether the row seeds `active=TRUE` in the
Layer-2 `User_Category_Profile`:

| Rule | Active when | Used by (examples above) |
|---|---|---|
| `always` | unconditionally | income rows, housing/food/utilities |
| `on_business` | `Settings.has_business` | every business row |
| `on_kids` | `Settings.has_children` | family/divorced kids rows |
| `on_car` | `Settings.has_car` (default true) | transport.car rows |
| `on_employees` | `Settings.has_employees` | `business_salaries` |
| `on_studies` | `Settings.has_studies` | `education_*` (Student recipe) |
| `on_subscriptions` | `Settings.has_subscriptions` (default true) | `comm_*` subs |
| `on_keyword` | lazily, on first matching bot write | `child_support_received` |

**Profession merge (§5 `professionMerge`).** When `enabled` and the user has a `profession`
(api/profile.js stores it), the builder pulls `getProfessionRows(id).expense` from
`lib/profession-template.js` and appends up to `cap` rows into the `into` section, de-duped by
label against the template's `businessRows`. Example: a `general_contractor` on the `contractor`
template gets `חומרי בניין / קבלני משנה / ציוד וכלים / שכירת מנוף` merged into business_expense.
This is the documented fix for PERSONALIZED_CATEGORY_PROFILES §1.2 ("buildTenantSheetSpec ignores
professions"). The merge is **build-time only** and capped, so it can never explode the row count.

---

## 7. Onboarding answer → template id (the truth table)

`templateIdFromOnboarding(profile)` in `lib/sheet-templates.js` is a **pure port** of the bot's
`_onboardingPickPreset_` (ExpenseBot_FIXED.gs:5752) so the web signup path and the WhatsApp path
derive the identical id from the identical `profile` object. The inputs are the existing
`profile:<phone>` fields:

- `profile.trackingType` ← Q1 (`_SURVEY_TRACKING_`, 4715): `q1_personal→personal`,
  `q1_family→family`, `q1_group→group`, `q1_business→business`, `q1_both→business`.
- `profile.profession` ← Q4 (a `lib/professions.js` id).
- `profile.onboarding.E.osekType` ← section E (`patur`|`morsheh`|`company`).
- `profile.onboarding.F.tracksProjects` ← section F (boolean).
- `profile.onboarding.H.wantsImport` ← section H (boolean).

**Precedence (first match wins) — exactly the bot's order:**

| # | Condition | → templateId |
|---|---|---|
| 1 | `trackingType==='business'` AND (profession ∈ `_ONBOARDING_CONTRACTOR_PROFESSIONS_` OR `F.tracksProjects`) | `contractor` |
| 2 | `trackingType==='business'` AND `E.osekType==='patur'` AND not a construction trade | `freelancer` |
| 3 | `trackingType==='business'` (any other עוסק/חברה) | `business` |
| 4 | `trackingType ∈ {family, group}` | `family` |
| 5 | `H.wantsImport===true` (personal tracker) | `advanced_imported` |
| 6 | `profession` is self-employed (`_PROFESSION_IS_SELF_EMPLOYED_`) on a personal tracker | `mixed` |
| 7 | (else) | `basic_personal` |

**Documented gaps (intentional, not bugs):** `couple`, `divorced`, `employee` have no auto-deriving
question in the current Q1–Q4 + E–H flow, so they are **selectable only** (the user picks them, or a
future question routes to them) — exactly the note at ExpenseBot_FIXED.gs:5748. They are still
fully built (§5.2/5.4/5.5) and seedable. To auto-derive them later: add a Q1 option for couple, a
"single parent?" gate for divorced, and a "salaried only?" gate for employee — each is a one-row
add to this truth table, no registry change.

**Where the id is stored & read:**
- Web/bot writes it to `profile.profileType` via `POST /api/profile {action:'set', fields:{profileType}}`
  (validated against `PROFILE_TYPES`, api/profile.js:210).
- `buildTenantSheetSpec` reads it as `opts.templateId` (preferred) or `opts.profileType` at
  signup-provision time (the caller in the provision path passes the resolved profile).

---

## 8. Worked examples (end-to-end, using live data)

**(a) Plumber, עוסק מורשה, tracks per-project.**
Onboarding: Q1=`q1_business` → trackingType=business; Q4=`plumber`; F=`tracksProjects:true`.
→ Rule #1 (plumber ∈ contractor professions) → `contractor`.
`buildTenantSheetSpec(name, { templateId:'contractor', year:2026 })` emits: personal_dashboard(B2)
+ transactions + orders + company_dashboard(B4) + projects(B4) + clients + extended(B1) + 3 control
tabs. Business rows include `subcontractors`/קבלני משנה + the merged `plumber` profession rows
(capped 8). Company dashboard's חומרי גלם/שיווק rows still match `COMPANY_EXPENSE_ROWS` criteria, so
the existing live formulas sum correctly.

**(b) Salaried + Etsy side shop.**
Q1=`q1_personal` → personal; Q4=`software_developer_freelance` (self-employed). No import.
→ Rule #6 → `mixed`. Sheet = base personal + orders + compact side-business company_dashboard.
A "Canva 60" message: bot classifies subcat `תוכנות`, col D=`עסק`; the `mixed` business row
`business_software`(תוכנות ומנויים) with `criteria:['תוכנות','*מנוי*']` sums it on the company tab.

**(c) First-timer, household, two kids.**
Q1=`q1_family` → family. → Rule #4 → `family`. Sheet = base + the 6 kids rows (on_kids, active
because Settings `has_children:true`). No business tabs. Extended Pa'amonim tab still present for
power use.

---

## 9. Build plan — 4 reviewable PRs (data-first, reversible)

Staged so the highest-risk refactor is isolated and every step is independently revertible.
Each PR is small per `pr-incremental-plan`.

| PR | Title | Lands | Risk | Guard |
|---|---|---|---|---|
| **PR-1** | `lib/sheet-templates.js` registry + helpers | `TEMPLATE_REGISTRY` (10 entries) + `getTemplate`/`resolveTemplateId`/`templateIdFromOnboarding`. **No call sites changed.** Pure data + unit test asserting all 10 ids match `PROFILE_TYPES`, every `CategoryRow.id` is unique, every business row's first-4 criteria equal `COMPANY_EXPENSE_ROWS`. | none (dead code until wired) | `tests/sheet_templates.test.js` |
| **PR-2** | Make personal+company builders row-list-driven, **section totals computed not hardcoded** | Refactor `_buildPersonalDashboardTab` / `_buildCompanyDashboardTab` to take rows as params and compute `SUM(B{first}:B{last})` dynamically (port the extended-tab technique). `buildTenantSheetSpec` resolves `basic_personal` from the registry. | **HIGH** (formula position-safety) | Golden-snapshot test: `basic_personal` spec is byte-identical to the pre-PR spec (frozen JSON fixture). `sheet-spec-modify` skill checklist. |
| **PR-3** | New builders + new tabs | `_buildProjectsTab` / `_buildClientsTab` / `_buildHistoricalTab` / `_buildSettingsTab` / `_buildCategoriesMasterTab` / `_buildUserProfileTab` (+ reserve `_buildCryptoTab`). Wire `tab.kind` dispatch. | medium | per-builder snapshot tests |
| **PR-4** | Wire signup + retire the parallel list | Provision path passes `opts.templateId` from `profile.profileType`. `applyTemplatePreset_` reads `extraRows` *derived from* the registry entry (single source) instead of its own `_TEMPLATE_PRESETS_` literal — the bot keeps post-create top-up for EXISTING sheets but from the same data. | medium | `kesefle-user-template-audit` skill verifies provisioned shape per id |

**Hard invariants across all PRs (from the project's standing rules):**
- `basic_personal` output never changes (golden snapshot). Existing tenants are untouched.
- No template ever emits a write path that bypasses the 0.6 confidence floor — the registry is
  render-only; classification stays in `matchCategorySmart` + `_normalizeAiClassifyResult_`.
- New control tabs (`categories`, `user_profile`, `settings`) are hidden + read-only to the user,
  exactly as PERSONALIZED_CATEGORY_PROFILES.md §3–§5 specify.
- Backup-first / dry-run / user-gated apply for any migration of an EXISTING sheet (PR-4 only
  adds tabs for NEW signups; retrofitting existing sheets is a separate opt-in migration per
  PERSONALIZED_CATEGORY_PROFILES.md §11).

---

## 10. Open questions for Steven

1. **Student / Crypto (§5.11):** add `student` + `crypto` as ids #11/#12 now, or keep Student as a
   has_studies recipe and defer Crypto until the feature is built? (My recommendation: Student =
   recipe now; Crypto = reserve the id + builder slot, build when prioritized.)
2. **Auto-derive couple/divorced/employee (§7 gaps):** worth adding the 3 onboarding questions, or
   leave them selectable-only for now?
3. **professionMerge cap (§6):** is 6–10 rows the right ceiling, or should a contractor be allowed
   the full profession pack (some `lib/professions.js` entries have 12+ expense_subs)?
4. **PR-4 retrofit:** once the registry ships, do you want a one-click "rebuild my dashboard from my
   template" for your own sheet (advanced_imported), behind the usual backup→dry-run→confirm gate?
