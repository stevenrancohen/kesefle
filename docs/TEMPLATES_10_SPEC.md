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
 *                                    The builder to invoke. Maps 1:1 to a `_build*Tab` function
 *                                    in lib/sheet-writer.js. Adding a NEW kind is the only thing
 *                                    that requires code; reusing an existing kind is pure data.
 * @property {string}   [titleHe]     Optional override for the tab's Hebrew name. Defaults to
 *                                    the builder's canonical name (e.g. 'תנועות', 'מאזן אישי').
 * @property {Object}   [opts]        kind-specific options (e.g. { businessCount: 2 } for
 *                                    company_dashboard, { columns: [...] } for projects).
 */

/**
 * @typedef {Object} BusinessTabSpec   (only used by business / contractor / mixed)
 * @property {string}   slug          ASCII id of the business tab, e.g. 'biz_1'.
 * @property {string}   titleHe       Hebrew tab name; defaults to the user's business name
 *                                    captured in onboarding section F (ONBOARDING §1).
 * @property {string[]} revenueRows   CategoryRow ids that roll into this business's revenue.
 * @property {string[]} expenseRows   CategoryRow ids that roll into this business's COGS/opex.
 * @property {boolean}  [vat]         Whether to render the VAT (מע"מ) helper block.
 *                                    Default from getProfessionVat(professionId).
 */

/**
 * @typedef {Object} TemplateEntry
 * @property {string}   id            One of the 10 fixed ids (§3). MUST equal a PROFILE_TYPES id.
 * @property {string}   labelHe       Hebrew name shown in onboarding confirmation.
 * @property {string}   summary       One-line ASCII description (for admin + tests).
 * @property {TabSpec[]}        tabs           Ordered tabs the sheet is built from.
 * @property {CategoryRow[]}    incomeRows     Income-side rows (col H). May be empty.
 * @property {CategoryRow[]}    categoryRows   Expense-side rows (personal sections).
 * @property {BusinessTabSpec[]} businessTabs  Company tabs; [] for purely-personal templates.
 * @property {string[]}        professionMerge  Which profession ids' getProfessionRows() merge
 *                                              in at build time (§6). Usually [] — the merge is
 *                                              driven by the user's actual profession, this field
 *                                              only PINS profession rows a template always wants.
 * @property {string}   supersedes    'basic_personal' for every non-basic template — declares the
 *                                    base it extends, so a diff test can assert "template X = basic
 *                                    + its delta" (the invariant that today's bot violates).
 */
```

### 2.2 How `buildTenantSheetSpec` consumes it (the only code change in the core builder)

```
buildTenantSheetSpec(name, opts):
  1. id   = resolveTemplateId(opts.templateId || opts.profileType || 'basic_personal')
  2. tpl  = getTemplate(id)                          // throws if unknown id (fail loud)
  3. flags = opts.flags || {}                        // has_kids/has_car/... from Settings
  4. rows = [...tpl.incomeRows, ...tpl.categoryRows]
            .concat(mergeProfessionRows(tpl, opts.professionId))   // §6
            .filter(r => isRowActive(r, flags))                    // §6 activation gate
  5. for each tab in tpl.tabs: invoke the matching _build*Tab(rows, businessTabs, opts.year)
  6. assemble spec exactly as today (same year selector, same INDIRECT/SUMIFS machinery)
```

`opts.year` keeps its current meaning. When `opts` is entirely absent (legacy caller),
`resolveTemplateId(undefined) === 'basic_personal'` and `flags = {}` ⇒ every `activation:'always'`
basic row renders and nothing else ⇒ **byte-identical to today's output** (the §0.3 guarantee;
asserted by a snapshot test in §10).

---

## 3. The 10 templates — id, who, tabs, row deltas

All ids are the EXISTING `PROFILE_TYPES`. Each "delta" is **relative to `basic_personal`** (the
`supersedes` base). "Base personal" = today's 34 rows: income (salary/business/other/misc),
fixed (rent/mortgage/arnona/electric/water/gas/internet/phone/insurance/loans), variable
(health/clothing/home/gifts/leisure), food (groceries/restaurants), transport (fuel/public/
parking/car-maintenance), misc.

| # | id | Who | Tabs (beyond personal dashboard + תנועות) | Row delta vs basic | businessTabs |
|---|----|-----|------|------|------|
| 1 | `basic_personal` | Single person, personal only | extended (Pa'amonim) | — (the base) | [] |
| 2 | `couple` | Two partners, shared budget | extended | +income `salary_partner`; +fixed `shared_savings`; split-hint note row | [] |
| 3 | `family` | Household with kids | extended | +`on_kids` rows: childcare/education/activities/allowance; +`on_pets` vet/food | [] |
| 4 | `divorced` | Single parent, support flows | extended | +income `child_support_in`; +fixed `child_support_out`, `legal`; `on_kids` rows | [] |
| 5 | `employee` | Salaried, light tracking | extended | +income `bonus`, `reimbursements`; +fixed `pension_keren`; trims business income row | [] |
| 6 | `freelancer` | Solo עוסק פטור/מורשה, no inventory | company_dashboard(1), orders | +business_revenue `services`; +business_expense `tools`,`subscriptions`,`accountant`,`vat`; profession merge | 1 (services P&L, vat from profession) |
| 7 | `business` | עוסק מורשה / חברה with COGS | company_dashboard(1), orders, clients | +business_revenue `product_sales`,`services`; +business_expense `cogs`,`salaries`,`rent_biz`,`marketing`,`vat` | 1 (full P&L) |
| 8 | `contractor` | Project-based (the PR-S4 variant) | company_dashboard(1), projects, orders, clients | +business_revenue `project_income`; +business_expense `materials`,`subcontractors`,`equipment`,`permits`,`vat`; projects tab keyed by project name | 1 (project P&L) |
| 9 | `mixed` | Personal + one or more businesses | company_dashboard(N), orders, projects | basic personal rows KEPT in full **+** N business tabs from §F names; net profit of each biz flows to personal income (the מאזן אישי←מאזן חברה link) | N (one per onboarding-F name) |
| 10 | `advanced_imported` | Migrating user with history | historical, crypto_holdings (opt), extended | basic + `historical_personal` rows reconstructed from import; rows are activation:'on_keyword' so only imported categories show | 0–N (mirrors source) |

**Notes that matter for the builder:**
- Templates 6–9 emit a **company_dashboard** tab; that builder already exists
  (`_buildCompanyDashboardTab`, sheet-writer.js:495) and already uses the `$B$N` year selector +
  the multi-criteria `COMPANY_EXPENSE_ROWS` pattern. The registry just supplies *which*
  `business_expense` rows and their criteria instead of the hardcoded 4.
- Template 9 (`mixed`) is the **only** one with `businessTabs.length > 1`. Its net-profit-to-
  personal link reuses the live cross-tab reference (memory: B4 zero-bug fix, company net
  profit ₪24,997 flows to personal) — the registry does not reinvent the link, it declares
  `businessTabs[i]` and the builder wires `מאזן אישי` income row `net_profit_biz_i` to that tab.
- Template 10 keeps `historical_personal` rows OFF unless the import actually produced data for
  them (activation `on_keyword`), so a migrated user is not shown 40 empty rows.

---

## 4. Worked example — the `contractor` entry (full body)

This is the entry that replaces the `profileType === 'contractor'` branch
SHEET_AND_DASHBOARD_STRATEGY.md proposed. It is deliberately spelled out in full so the data-vs-
code split is concrete.

```js
{
  id: 'contractor',
  labelHe: 'קבלן / עצמאי לפי פרויקטים',
  summary: 'Project-based self-employed: personal budget + one project P&L tab + projects ledger.',
  supersedes: 'basic_personal',
  professionMerge: [],                 // driven by the user's real profession at build time
  incomeRows: [
    // inherits all basic_personal income rows by reference (the builder concats base first);
    // contractor adds the company net-profit feed into personal income:
    { id: 'net_profit_contracting', label: 'רווח מקבלנות', section: 'income',
      group: 'income_business', activation: 'on_business', income: true,
      criteria: ["=מאזן חברה!<net_profit_cell>"] },   // cross-tab, not a SUMIFS
  ],
  categoryRows: [
    // business-expense rows live on the company tab, declared here so the registry is the
    // single list; the company_dashboard builder reads section==='business_expense':
    { id: 'materials',      label: 'חומרים',        section: 'business_expense', group: 'business_cogs',   activation: 'on_business',
      criteria: ['*חומר*','*חומרי גלם*','*חומרים*'] },
    { id: 'subcontractors', label: 'קבלני משנה',     section: 'business_expense', group: 'business_cogs',   activation: 'on_business',
      criteria: ['*קבלן משנה*','*קבלני משנה*','*פועלים*'] },
    { id: 'equipment',      label: 'ציוד וכלים',     section: 'business_expense', group: 'business_opex',   activation: 'on_business',
      criteria: ['*ציוד*','*כלי עבודה*','*השכרת ציוד*'] },
    { id: 'permits',        label: 'אגרות והיתרים',  section: 'business_expense', group: 'business_opex',   activation: 'on_business',
      criteria: ['*היתר*','*אגרה*','*רישוי*'] },
    { id: 'vat_contractor', label: 'מע"מ',           section: 'business_expense', group: 'business_tax',    activation: 'on_business',
      criteria: ['*מעמ*','*מע"מ*','*מס ערך מוסף*'] },
  ],
  businessTabs: [
    { slug: 'biz_1', titleHe: '<business name from onboarding F, fallback "העסק שלי">',
      revenueRows: ['project_income'],
      expenseRows: ['materials','subcontractors','equipment','permits','vat_contractor'],
      vat: true /* default getProfessionVat(professionId) */ },
  ],
  tabs: [
    { kind: 'personal_dashboard' },
    { kind: 'transactions' },                       // 'תנועות'
    { kind: 'company_dashboard', opts: { businessCount: 1 } },   // 'מאזן חברה'
    { kind: 'projects', titleHe: 'פרויקטים',
      opts: { columns: ['שם פרויקט','לקוח','הכנסות','הוצאות','רווח','סטטוס'] } },
    { kind: 'orders', titleHe: 'הזמנות' },
    { kind: 'clients', titleHe: 'לקוחות' },
    { kind: 'extended_dashboard' },                 // Pa'amonim, kept
  ],
}
```

Adding the `mixed` template later is *exactly* this shape with `businessTabs.length === N` and the
`personal_dashboard` rows left at their full basic set — **no new code**, because every `kind`
above already has a builder.

---

## 5. Backward-compat: `basic_personal` is today's sheet, frozen

The `basic_personal` entry is mechanically derived from the CURRENT constants so the snapshot
test (§10) passes on day one:

- `incomeRows`  ← `PERSONAL_INCOME_ROWS` (sheet-writer.js:55), each `activation:'always'`.
- `categoryRows` ← `PERSONAL_FIXED_ROWS` + `PERSONAL_VARIABLE_ROWS` + `PERSONAL_FOOD_ROWS` +
  `PERSONAL_TRANSPORT_ROWS` + `PERSONAL_MISC_ROWS`, in that order, sections assigned to match
  the existing section blocks, each `activation:'always'`.
- `businessTabs` ← `[]`.
- `tabs` ← `[ personal_dashboard, transactions, extended_dashboard ]` (the three the basic sheet
  builds today; the basic sheet does NOT get company_dashboard).
- Row ids are assigned ASCII snake_case once and frozen. (The labels are the existing Hebrew
  strings; ids are new but internal, so this is non-breaking.)

Because the builder concats base-first and basic has no gated rows, `buildTenantSheetSpec(name)`
(no opts) walks the identical code path and emits the identical spec. The diff test asserts
zero delta.

---

## 6. Activation rules + profession merge (where personalization actually happens)

Two orthogonal mechanisms decide the final row set; both are pure functions over the entry +
the user's stored flags, so they are fully testable with no I/O.

### 6.1 `isRowActive(row, flags)`

| activation | renders when |
|---|---|
| `always` | unconditionally |
| `on_business` | flags.has_business (need ∈ {business, both}, ONBOARDING §C) |
| `on_kids` | flags.has_kids (onboarding §D kids[] non-empty) |
| `on_car` | flags.has_car |
| `on_pets` | flags.has_pets |
| `on_rent` | flags.has_rent (and NOT has_mortgage, to avoid showing both) |
| `on_mortgage` | flags.has_mortgage |
| `on_employees` | flags.has_employees |
| `on_studies` | flags.has_studies |
| `on_subscriptions` | flags.has_subscriptions |
| `on_keyword` | the import/history actually produced a row with this id (template 10) |

`flags` come from the Settings tab (PERSONALIZED_CATEGORY_PROFILES §6) which is itself seeded
from onboarding answers. Unknown activation ⇒ treated as `always` (fail open to *showing* a row,
never to hiding one — a visible empty row is harmless; a hidden row with data is a silent loss).

### 6.2 `mergeProfessionRows(tpl, professionId)`

The 119-entry `lib/professions.js` is finally consumed. Rule:

1. `extra = getProfessionRows(professionId)` (income + expense subs for that profession).
2. For each extra sub, if a registry row with the same `label` (or overlapping `criteria`)
   already exists, **skip** (registry wins — no duplicates).
3. Otherwise append it as a CategoryRow with `activation:'on_business'`, `group` from
   `findGroupForSubcategory`, `section` inferred (income vs business_expense).
4. VAT defaults: `businessTabs[*].vat ??= getProfessionVat(professionId)`.

This is the one place the profession library affects the *sheet*. It does NOT affect
classification (that is the bot's `getProfessionBoostKeywords`, untouched).

---

## 7. What the registry deliberately does NOT do

- **It does not classify.** No keyword→category logic lives here. `criteria` are SUMIFS match
  patterns for *summing already-classified rows*, not for deciding a transaction's category.
  The 0.6 floor and `matchCategorySmart` own classification, unchanged.
- **It does not write to sheets.** `lib/sheet-templates.js` is pure data + pure helpers. The
  actual `setValues/setFormula` stays in the existing builders, behind the existing
  backup→dry-run→apply guard (financial-integrity skill).
- **It does not rename anything live.** Existing tenant sheets are not rebuilt. The registry
  governs *new* sheets and *top-ups* (§9); a migration to re-render an existing sheet is a
  separate, opt-in, backed-up operation out of scope here.
- **It does not lower any safety bar.** Nothing in template selection can reduce the ask
  threshold below 0.6.

---

## 8. Selection: how a user lands on a template

`templateIdFromOnboarding(profile)` (pure function) maps the onboarding record to one id:

```
need = profile.onboarding.C.need            // 'personal' | 'business' | 'both'
prof = profile.onboarding.E.professionId
F    = profile.onboarding.F                 // { multi, names[], osekType }
D    = profile.onboarding.D                 // { kids[], pets, car }

if need === 'personal':
    if D.kids?.length and profile.maritalStatus==='divorced' -> 'divorced'
    elif D.kids?.length                                       -> 'family'
    elif profile.partner                                      -> 'couple'
    elif profile.employmentType==='employee'                 -> 'employee'
    else                                                      -> 'basic_personal'
if need === 'business':
    if F.osekType==='contractor' or isContractorProfession(prof) -> 'contractor'
    elif hasInventory(prof)                                       -> 'business'
    else                                                         -> 'freelancer'
if need === 'both':
    if F.multi or F.names.length > 1 -> 'mixed'
    else                             -> 'contractor' or 'business' (by inventory) + personal tabs
if profile.importedHistory           -> 'advanced_imported'   (overrides, keeps detected biz tabs)
```

This mirrors the bot's existing `_onboardingPickPreset_` (5752) decision tree — the function is
the **same logic relocated to a pure, testable lib** so both `buildTenantSheetSpec` (at create)
and the bot (for the confirmation message) call ONE selector.

---

## 9. Migration: collapsing the parallel `_TEMPLATE_PRESETS_` list (staged, safe)

The bot's `_TEMPLATE_PRESETS_.extraRows` and `applyTemplatePreset_` must converge on the registry
WITHOUT a risky big-bang. Stages, each independently revertible (pr-incremental-plan):

- **Stage A (this PR — docs only):** specify the registry. No code.
- **Stage B:** add `lib/sheet-templates.js` with all 10 entries + helpers + the snapshot test
  proving `basic_personal` == today. `buildTenantSheetSpec` gains `opts.templateId/flags/
  professionId` but **defaults make it a no-op** for every existing caller. Ship; observe.
- **Stage C:** point NEW-sheet provisioning (`api/sheet/*` create path) at the registry via
  `templateIdFromOnboarding`. Old sheets untouched. The bot's post-create `applyTemplatePreset_`
  is made a **no-op when the sheet was already built from the registry** (it detects the rows
  already exist — it is already idempotent per the build plan §0). New users now get the right
  sheet in one shot; the parallel seed stops firing for them.
- **Stage D:** regenerate `_TEMPLATE_PRESETS_.extraRows` *from* the registry (a build step or a
  generated `.gs` constant) so the bot's top-up for *legacy* sheets reads the same source. The
  hand-maintained list is deleted. After this, drift is structurally impossible.

Each stage is ≤~300 LOC and leaves the bot in a shippable state.

---

## 10. Tests (the registry is data ⇒ it is cheaply, exhaustively testable)

New `tests/sheet_templates.test.js` (Node, no mocking framework, load real source via
balanced-brace extraction per test-add-suite):

1. **T-IDS** — `TEMPLATE_REGISTRY.map(t=>t.id)` deep-equals `PROFILE_TYPES` (same 10, same order).
   Guards against the bot and lib drifting on the id set.
2. **T-BASIC-SNAPSHOT** — `buildTenantSheetSpec('X')` (no opts) deep-equals a checked-in golden
   spec captured from `origin/main` HEAD. The hard backward-compat gate.
3. **T-SUPERSEDES** — for every non-basic template, its rendered `always`-rows are a SUPERSET of
   `basic_personal`'s (every template = basic + delta; the invariant the bot violates today).
4. **T-ROW-IDS-UNIQUE** — within each entry, row `id`s are unique and ASCII snake_case; no two
   entries reuse an id for a *different* label.
5. **T-CRITERIA-NONEMPTY** — every CategoryRow resolves to ≥1 SUMIFS criterion (label-derived or
   explicit), so no row is rendered without a summing formula (the COMPANY_EXPENSE_ROWS drift bug).
6. **T-ACTIVATION-CLOSED** — every `activation` value is in the §6.1 enum; unknown ⇒ test fails
   (forces a deliberate decision, not a silent fail-open in prod).
7. **T-SELECT** — `templateIdFromOnboarding` returns a valid id for a matrix of representative
   onboarding records (personal/business/both × kids/no-kids × multi/single biz).
8. **T-PROFESSION-MERGE** — merging a known profession (e.g. a contractor trade) adds its rows
   without duplicating any registry row by label.
9. **T-NO-HEBREW-CORRUPTION** — every Hebrew `label` passes the bidi/RTL check (test-hebrew-text):
   no stray bidi control chars, correct brand spelling.

All nine are pure (no network, no Sheets). CI runs them in the existing gauntlet (test-run-all).

---

## 11. Open questions for Steven (decide before Stage B)

1. **Template 9 `mixed` business-tab cap.** Hard-cap at N=3 business tabs (matches the
   2–3-business decision in memory)? Or allow more and warn?
2. **Template 10 `advanced_imported` crypto tab.** Include the `crypto_holdings` tab by default,
   or only when the import detects crypto rows?
3. **`couple` split-hint row.** Render an informational "split 50/50?" note row, or keep it out
   of the sheet and surface it only in the bot/web onboarding copy?
4. **Profession VAT default.** Trust `getProfessionVat(professionId)` unconditionally, or always
   render the VAT block for any business template and let the user hide it via Settings?

None of these block the docs; they are the four data choices that finalize the 10 bodies.
