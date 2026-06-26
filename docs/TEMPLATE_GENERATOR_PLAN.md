# Per-type sheet templates — council verdict + build plan (2026-06-25)

> Verdict: ONE config-driven dashboard GENERATOR over the universal תנועות ledger (type = a VIEW). NOT N templates. Minimal-now = extract the generator with 1 config (current default), parity-test-gated, then add the free-text switch + 1 more config on real-user request.

## Gating answers (verified in code)
- תנועות (ledger) and the dashboard are SEPARATE TABS (provision.js / sheet-writer.js: 4 tabs). A type switch regenerates the dashboard tab ONLY; the ledger is never touched -> structurally lossless.
- Dashboard SUMIFS criterion = each row's OWN col-A label ("*"&{row}&"*"), data-driven -> a per-type dashboard is just a different ROW SET; buildTenantSheetSpec() already builds this with a FIXED set, so the generator = parameterize it by profileType config.
- profileType already computed at onboarding (_onboardingPickPreset_) + stored (api/profile.js PROFILE_TYPES, 10 presets) + design doc exists (docs/PERSONALIZED_CATEGORY_PROFILES.md 3-layer + docs/TEMPLATES_10_SPEC.md). Generator should CONSUME the existing User_Category_Profile/קטגוריות join, not create a 2nd source of truth.

## Full council verdict

## Where the Council Agrees

Five-for-five, with unusual conviction:

- **Architecture (a):** Reject N physical templates and reject hide/show. Both multiply the load-bearing-formula surface that is already this product's #1 "money disappeared" bug. The answer is a **single canonical sheet whose dashboard is GENERATED in code from a per-type CONFIG** — one formula-builder, many cheap config entries. A bug fixed once propagates everywhere.
- **Switch-flow + data-safety (b):** The תנועות **ledger is the immutable spine**. A type switch *only* regenerates the dashboard tab; it never reads, moves, or deletes a ledger row. Because nothing in the ledger is keyed to type, family→single is structurally lossless. Wrap every regenerate in snapshot-backup → DRY_RUN diff → integrity-guard → validate-totals.
- **Timing (c):** **Do NOT build 9 variants.** "Demand, not infrastructure" holds — a handful of users don't churn for lack of a "couple" layout. Extract the generator now (it's a bug-fix in disguise) with a tiny number of configs; add more only when a real user asks.

The First Principles framing is the load-bearing one and every reviewer ratified it: *the ledger is universal; "type" is purely a VIEW.* Once you accept that, every other answer falls out mechanically.

## Where it Clashes

- **How many configs in the "minimal" build:** Expansionist/First-Principles say 1–2 (or just today's default); Executor says 3 (single/couple/freelancer). The fact that they disagree *is itself a finding*: nobody actually knows whether "couple" differs from "single" enough to warrant a distinct dashboard. That's an empirical question, not an architecture one.
- **The Contrarian's self-contradiction:** It correctly condemns hide/show in (a), then recommends hide/show as its "minimal-now" in (c). Four reviewers flagged this. Hiding rows leaves the hand-maintained template as the canonical source and adds conditional state on top of the fragility — the opposite of the goal. Discard that minimal; the correct minimal is "extract the generator with one config."
- **Channels:** Contrarian wants bot-onboarding-only (free-text parsers = more fragility). Everyone else wants free-text + web + onboarding. The founder *explicitly asked for* "אקסל לזוג," so a free-text command is a requirement, not a nice-to-have — but it's a thin keyword→profileType mapping, not a new surface.
- **Honesty about cost:** Expansionist oversells "generated is SAFER than today" as if the end-state were free. Contrarian's counter is the true one: *the generator doesn't exist yet, and writing it IS the exact load-bearing-formula surgery that has burned this product.* The end-state is safer; the road there is the single most dangerous money-code you'll write this quarter.

## Blind Spots

All five reviewers converged on the same omission, and it's the real one:

1. **The migration of already-provisioned sheets is the actual risk and work — and nobody specced it.** Every advisor treats generation as greenfield. But existing users have *live dashboards over real money*. Pointing an untested generator at them is how you automate the money bug at scale. **You need a golden parity test: generated SUMIFS must reconcile to the current template's totals, per profileType, before any cutover** — and a non-destructive rollout (generate alongside in a shadow tab, compare, then swap; never in-place rewrite).
2. **Multi-year tabs make "regenerate the dashboard tab" ambiguous** (Review 5). Prior-year dashboards are embedded per year. "The dashboard" is not one tab. The generator must know which tabs it owns.
3. **Nobody verified the actual code.** Whether "regenerate the dashboard tab" is even safe depends on whether תנועות and the dashboard are *separate tabs* today and whether formulas reference the dashboard by **named range**. This is checkable in `provision.js` and the template in an hour — and it gates the whole plan.
4. **The config arguably already half-exists.** The `kesefle-adaptive-category-profile-builder` skill + `User_Category_Profile` join + `קטגוריות` master already drive per-user category rows. The generator may be a *consumer* of that existing join, not a new system. Config-drift between the bot taxonomy and the generator config is a known recurring Kesefle bug class — don't create a second source of truth.

## The Recommendation

**(a) Architecture — config-driven generator, single canonical sheet. Unanimous, adopt it.** One `PROFILE_CONFIGS[profileType]` map (category rows, signs, which sub-dashboards render) feeding ONE dashboard-builder code path, golden-gated. The ledger schema is identical across all types. Crucially: make this generator a **consumer of the existing `User_Category_Profile` / `קטגוריות` master**, not a parallel config — one source of truth, or you've recreated the taxonomy-drift bug.

**(b) Switch-flow + data-safety — ledger is read-only; regenerate dashboard only.** Channels: onboarding pick (exists) + a thin free-text map ("אקסל לזוג"/"תבנית משפחה" → profileType) + web Account screen, all calling ONE idempotent endpoint. That endpoint, mandatorily, routes through the existing **`kesefle-financial-data-integrity-guard`**: snapshot-backup → DRY_RUN diff → validate totals before/after match → apply. Categories that vanish from a new config keep their ledger rows and simply stop showing a summary row (re-appear on switch-back). **Non-negotiable gate: a golden reconcile test proving generated totals == current-template totals per profileType, run against real provisioned sheets in a shadow tab, before a single live cutover.**

**(c) Build-now vs defer — MINIMAL-NOW, sequenced as a bug-fix, not a feature.**
- **Now:** Extract the generator from today's template with **exactly ONE config = the current default**, behind the integrity-guard, proven by the parity test. This ships *zero new user-facing behavior* — it's a de-risking refactor that finally kills the recurring money-bug by collapsing N hand-maintained formula copies to one tested path. This is the part that pays for itself regardless of whether tailoring ever matters.
- **Then, cheaply:** add the free-text switch command + ONE second config (couple **or** family — pick the one a real user has actually asked for; if none has, ship none yet).
- **Defer:** the remaining 6–7 variants until a real user requests one. The architecture is precisely what lets you say "yes" in an afternoon when they do.

Resolve the config-count clash empirically: **build the spine for N, ship for 1, expand on request.**

## The One Thing to Do First

**Before writing any generator, spend one hour reading `api/sheet/provision.js` and the live template to answer three gating questions:**

1. Are תנועות and the dashboard **separate tabs**, and do formulas reference the dashboard by **named range** (so a regenerate is safe) or by raw cell (so it isn't)?
2. How are **multi-year dashboards** laid out — which tabs would the generator own?
3. Does the existing **`User_Category_Profile` / `קטגוריות`** join already supply the per-type row config, so the generator consumes it instead of duplicating it?

The entire plan — its safety, its cost, whether the config already half-exists — hinges on those answers. Everyone debated the architecture; **nobody read the code.** Read it first. Then build the generator with one config and a golden parity test, and let real user requests, not the enum's nine values, decide how many configs ever ship.

---

## Build progress

### ✅ Step 1 (DONE 2026-06-26, commit pending) — config layer + parity gate (additive, NOT wired)
- `lib/profile-configs.js`: PROFILE_CONFIGS (per-type hideRows, EXCLUSIONS only — never invents a row), `selectRows(type, fullRows)` (default/unknown -> identity), `parseProfileTypeFromText` ("אקסל לזוג"->couple, "תבנית משפחה"->family, ...).
- `tests/test_profile_configs.js` (28 checks, gauntlet-gated): PARITY (basic_personal/family reproduce the EXACT current rows -> zero change for existing sheets), SUBSET-ONLY (every hideRows label exists in PERSONAL_*_ROWS), free-text router.

### ▶ Step 2 (NEXT — the gated surgery) — wire selectRows into buildTenantSheetSpec
- In `lib/sheet-writer.js`, `buildTenantSheetSpec(name, opts)` builds the dashboard from PERSONAL_*_ROWS. Thread an `opts.profileType`; replace each `PERSONAL_X_ROWS.forEach` with `selectRows(profileType, PERSONAL_X_ROWS).forEach`.
- CRITICAL: the section-total SUM ranges (line 53-55: "Counts are load-bearing... income=4, fixed=12...") MUST be recomputed from the SELECTED row counts, not hardcoded. Audit every hardcoded range/offset in buildTenantSheetSpec first.
- GATE before any live use: a golden reconcile test — provision a sheet with profileType=basic_personal and assert the generated spec == the pre-refactor spec byte-for-byte (parity), then assert a `single` sheet has exactly one fewer fixed row and correct section totals. Shadow-tab compare on a real provisioned sheet before any in-place change. Route the switch endpoint through kesefle-financial-data-integrity-guard.

### ▶ Step 3 — surface it
- Provision: pass the onboarding-picked profileType (already stored) into provision.
- Switch: a bot hook calling parseProfileTypeFromText -> one idempotent /api/sheet/reprofile endpoint (regenerates dashboard tab only; ledger untouched) + the web Account screen.

---

## Step 2 — Read-only RANGE AUDIT (2026-06-26, task B-G)

Goal: before wiring `selectRows()` into the dashboard builder, enumerate every
row-count-dependent hardcode in `lib/sheet-writer.js` so the wiring can recompute
them instead of shifting silently. **No code changed in this audit.**

### Blast radius is ONE function (good news)
`grep` confirms NOTHING outside `lib/sheet-writer.js` reads the personal dashboard
by hardcoded row (B9/B10/B28/...). The bot writes to `תנועות`; the dashboard
SUMIFS pull from there keyed by each row's own **label** (`"*"&$A{row}&"*"`), not
its position. `_PERSONAL_DASH_ROWS` routes a category to a dashboard row by NAME,
not row number. So hiding a row corrupts only the dashboard TAB layout — never the
ledger, never label-routing.

### The hardcodes that WILL break if a row is hidden (`_buildPersonalDashboardTab`)
Current layout assumes income=4, fixed=12, variable=4, food=2, transport=8, misc=5.

| What | Current hardcode | Depends on |
|---|---|---|
| Income category rows | `5 + i` (R5–R8) | income count = 4 |
| Income total | `_personalSectionTotal(.,5,8)` -> R9 `SUM(B5:B8)` | income count |
| Grand total expenses | R10 `=B28+B35+B40+B51+B59` (+ C..N) | ALL 5 expense total-row numbers |
| Net / savings | R11 `=B9-B10`, R12 `=B11/B9` | income-total + grand-total row #s |
| Fixed rows + total | R16–R27, R28 `SUM(B16:B27)` | fixed count = 12 |
| Variable rows + total | R31–R34, R35 `SUM(B31:B34)` | shifts if fixed count changes |
| Food rows + total | R38–R39, R40 `SUM(B38:B39)` | shifts if any prior count changes |
| Transport rows + total | R43–R50, R51 `SUM(B43:B50)` | cascades |
| Misc rows + total | R54–R58, R59 `SUM(B54:B58)` | cascades |
| Sub-headers / blanks | R13,R14,R15,R29,R30,R36,R37,R41,R42,R52,R53 | all cascade |

Cascade rule: every section after a hidden row shifts up by the number hidden, so
a single `hideRows:['תינוק']` (fixed 12->11) breaks R28 and EVERY total below it,
plus the R10 grand-total references and the R11/R12 net references.

### Already parameterized (no change needed)
`buildPieChartRequests` takes `incomeSectionTotalRows` / `expenseSectionTotalRows`
from `extendedMeta` — NOT hardcoded. If the builder computes those dynamically and
passes them through, the pie charts follow automatically.

### Required Step-2 refactor (bounded, gated)
Rewrite `_buildPersonalDashboardTab` to carry a running `rowNum` cursor:
1. For each section: emit sub-header, emit `selectRows(type, GROUP)` category rows
   while tracking `firstDataRow..lastDataRow`, then emit total `=SUM(B{first}:B{last})`
   at the next row and RECORD that total-row number.
2. Build R10 grand-total + R11/R12 net from the RECORDED total-row numbers.
3. Put the recorded income/expense total rows into `extendedMeta` (pie charts already
   consume them).

### Safety gate (already half-built)
`tests/test_profile_configs.js` proves the PARITY invariant: for `basic_personal`
and `family` (hide nothing) `selectRows` is identity. Extend it so that, for those
types, the COMPUTED layout is byte-identical to today's hardcoded rows
(R9/R28/R35/R40/R51/R59 + the R10 grand-total string). Plus a golden-reconcile of a
single-hide case (e.g. `single`: fixed total must become `SUM(B16:B26)` at R27 and
every downstream total must shift up exactly 1). Only ship behind that gate.

**Verdict:** feasible, single-function blast radius, the riskiest consumer (charts)
is already parameterized. Still a money-formula generator change -> keep it gated
behind the parity + golden-reconcile tests, NOT shipped opportunistically.
