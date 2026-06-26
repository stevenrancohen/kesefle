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
