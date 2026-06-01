# Bot Intelligence — Incremental Build Plan (Design Doc 4)

**Author:** Claude (design synthesis — turns docs 1–3 into a buildable PR sequence)
**Date:** 2026-06-01
**Status:** DESIGN PROPOSAL — DOCS ONLY. No code in this PR. Steven approves the sequence before any PR-1 lands.
**Epic:** #271 — smarter, accurate, personalized bot.

## What this doc is

Docs 1–3 describe the *target*. This doc is the *route*: an ordered set of small PRs where each one lands deployable, reviewable, and reversible on its own (per the `pr-incremental-plan` skill — ≤~300 LOC, independently shippable, revert-safe). It is grounded in the **live code on `origin/main`**, not the design's idealized version, so the scopes cite real function names, real line anchors, and real KV key shapes.

**Source docs synthesized:**
- **Doc 1** — `docs/AUDIT_BOT_INTELLIGENCE.md` (classifier accuracy 94.8% golden-set; onboarding 6/10; the "I'm unsure" dropdown is already the best-designed part; ranked top-15 improvements).
- **Doc 2** — `docs/PERSONALIZED_CATEGORY_PROFILES.md` (the 3-layer master/profile/render architecture; `קטגוריות` + `User_Category_Profile` + `Settings` schemas; 6→10 presets; Steven's 23-category table; activation rules; migration phases A–C).
- **Doc 3** — `docs/SHEET_AND_DASHBOARD_STRATEGY.md` (the 7-PR PR-S1…S7 sheet/dashboard strategy; Contractor template variant; Review Inbox = PR-S6; `?v2=1` dashboard A/B).

This plan **does not renumber** doc 3's PR-S* series — those are the sheet/dashboard track and can proceed in parallel. The PR-1…PR-5 here are the **bot-intelligence track** (category data model + onboarding + AI pipeline + learning). Where they touch the same file (`lib/sheet-writer.js`, `public/dashboard.html`) the dependency is called out.

---

## 0. What is ALREADY done today — do NOT rebuild

Read this first. A large share of doc 2 / doc 1 is **already live**. The plan below is the *delta*, not a from-scratch build. Anything in this table is shipped on `origin/main` and must be **extended, not reimplemented**.

| Capability | Where it lives (live) | PRs that shipped it | Implication for this plan |
|---|---|---|---|
| Onboarding conversation + state machine | `bot/ExpenseBot_FIXED.gs` — step keys `q0_*` (gender), `q1_*/q2_*/q3_*` (tracking/recurring/autolog); `_onboardSeen_`/`_onboardMark_` (`:1356`/`:1363`) | #184, #185 | PR-2 **adds 2 questions to an existing machine**; it does not build the machine. |
| `welcomed:`/`surveyed:` flags in **KV** (not Script Properties) | `_onboardSeen_('welcomed'/'surveyed', clean)` reading KV | #186 | Re-use this KV-flag pattern for new onboarding gates. No Script-Property regressions. |
| Gender + need (`personal`/`business`/`both`) capture | `_genderKey_` (`:4412`), stored in Script Properties, gendered Hebrew replies | #184 (the "#184 gender/need work") | Done. PR-2 only adds goal + income. Do **not** touch gender storage. |
| 10 template presets (data + seeding) | `_TEMPLATE_PRESETS_` (`:5966`), `_resolveTemplatePresetId_` (`:6058`), `applyTemplatePreset_` seeding via `_addCategoryRows_` (`:4297`) → `POST /api/sheet/add-category-row` | #179 (`8645b42`), `f9d740c` | **Presets already exist** and seed rows idempotently. PR-1 does NOT recreate presets; it gives them a *master/profile data model* to write against. |
| `api/profile.js` stores A–H onboarding + 10 `profileType` | `PROFILE_TYPES` + `ONBOARDING_SECTIONS` in `api/profile.js` (`:72`/`:77`); merges onboarding by section letter | `f9d740c`, `ac848fd` | PR-2 writes goal/income into the **existing** `onboarding` section blocks — the endpoint already accepts them. |
| Recurring / fixed-expenses (bot + web CRUD) | `_recurring*_` family (`:3967`–`:4252`) → `/api/recurring`; web UI in `account` | #183, `20895f2`, `cdae86f` | Out of scope for this track. Don't touch. |
| AI provider resolver + chat + classify contract | `_aiProviderResolve_` (`:9864`), `_aiChatComplete_` (`:9881`), `_aiCategorizeRich` (`:10036`), `_normalizeAiClassifyResult_` (`:9977`) | #179 (`ac848fd`) | **AI stages 3–4 exist.** PR-4 closes stage 5 (the review queue), it does not build the LLM call. |
| The never-corrupt 0.6 hard floor | `_aiAskFloor_()=0.6` (`:9975`); enforced inline in `matchCategorySmart` (`:9546`) AND `_normalizeAiClassifyResult_` (`:9994`); dead `_aiCategorize` wrapper retired to `null` (`:10031`) | #179, `e91d82b` | **The invariant is already enforced** in BOTH code paths. PR-4 must *preserve* it verbatim, never re-derive it. |
| `matchCategorySmart` 5-tier pipeline | `:9480` — (1) learned cache → (1.5) auto-synonyms → (2) `CATEGORY_MAP` → (2.7) global-learn → (3) LLM gated by contract | shipped pre-epic + `ac848fd` | This **IS** the deterministic→AI pipeline. PR-4 inserts a **profile tier between (2) and (3)**, it does not replace the pipeline. |
| Correction → learning (text cache) | `_learnedSave(desc, {cat,sub}, 'user-correction')` from the dropdown pick (`:7239`) and `קטגוריה X` (`:6732`); cross-user `global_learn` | shipped pre-epic | PR-5 makes corrections also update the **per-user category profile**, on top of this existing text-cache learning. |
| Tenant resolution chain | `phone → userSub → user:{sub}` + `sheet:{sub}`; per-user customs at `custom_categories:{userSub}` (`api/sheet/add-category-row.js:303`) | shipped | The **profile store reuses `custom_categories:{userSub}`-style keying** — same isolation invariant, no new auth surface. |

**Net:** the onboarding machine, the 10 presets, the AI LLM call, the 0.6 gate, the dropdown UX, and the text-cache learning are DONE. The *missing* spine is the **category master/profile data model** (doc 2 §2–4) that the presets, dashboard, bot, and learning should all read/write through — plus two onboarding questions and a durable **needs_review queue** to close the AI loop. That is what PR-1…PR-5 build.

---

## 1. The 5-PR sequence at a glance

| PR | Title | One-line scope | Bot re-paste? | Reversible by |
|---|---|---|---|---|
| **PR-1** | Category master registry (data) + `buildTenantSheetSpec` consumes it | New `lib/category-registry.js` (the seed) + `buildTenantSheetSpec` gains `opts.profileType`/`opts.flags` and renders preset rows from the registry. No new tenants harmed (default path identical). | **No** (lib auto-deploys via Vercel) | `git revert` — default-spec output byte-identical when `opts` absent |
| **PR-2** | Onboarding state-machine: goal + income questions | Two new steps (`q4_goal`, `q5_income`) in the existing machine; store into `profile.onboarding` (endpoint already accepts). | **Yes** (bot `.gs`) | Revert + prior `DEPLOY.gs` paste; questions are additive — skipping them leaves old flow intact |
| **PR-3** | Per-user category profile store (KV + read API) | New `api/category-profile.js` (get/set, bot-secret) writing `cat_profile:{userSub}`; `lib/category-profile.js` shared shape; seeded from PR-1 registry + preset at provision time. | **No** (API auto-deploys) | `git revert` — key is new, nothing reads it yet until PR-4 |
| **PR-4** | AI pipeline stages 3–5: profile tier + durable needs_review queue + the never-corrupt gate | Insert a **profile-resolve tier** into `matchCategorySmart` between keyword and LLM; route every `should_ask_user` result into a durable `needs_review:{userSub}` queue (the existing dropdown stays as the *fast* path; the queue is the *durable* one). | **Yes** (bot `.gs`) + **API** (queue endpoint) | Revert bot + endpoint; gate is unchanged so worst case = today's behavior |
| **PR-5** | Correction → profile learning | When a user resolves a dropdown / `קטגוריה X` / a queue item, also bump the **profile** (`usage_count`, `last_used`, activate the category) — not just the text cache. | **Yes** (bot `.gs`) | Revert; `_learnedSave` text-cache path untouched, so learning still works at the old fidelity |

**Ordering rationale (each lands deployable):**
- PR-1 ships **data + renderer** with a no-op default — zero runtime risk, gives every later PR a registry to reference.
- PR-2 is **independent** (pure onboarding) and can land anytime after PR-1's registry exists (so the income/goal answers have somewhere meaningful to map); it does not depend on PR-3/4.
- PR-3 ships the **store** but nothing reads it yet — safe to land and observe KV cost before wiring the bot.
- PR-4 is the **first behavior change to the write path**; it lands only after PR-3's store exists and PR-1's registry gives it `category_id`s to resolve to.
- PR-5 closes the loop and is **last** because it depends on both the store (PR-3) and the resolve/queue (PR-4).

A reviewer can stop after **any** PR and the bot is in a coherent, shippable state.

---

## 2. PR-1 — Category master registry (data) + `buildTenantSheetSpec` consumes it

### Scope
Create the **Layer-1 master** as a versioned JS seed (doc 2 §3), and make the sheet builder *render preset rows from it* instead of from the hard-coded `PERSONAL_*_ROWS`. This is the foundational data PR: it introduces `category_id` as a first-class concept the bot, dashboard, profile store, and learning all key on. It changes **zero behavior by default** — the only new inputs are `opts.profileType` / `opts.flags`, and when they are absent the builder walks the identical path and emits the identical spec.

This PR is the code realization of **doc 1 (`TEMPLATES_10_SPEC.md`)** — `lib/category-registry.js` here is that doc's `lib/sheet-templates.js` registry, and the 10 entries are exactly its 10 `TemplateEntry` bodies. (The two names are reconciled at implementation time to a single file; this plan uses `category-registry.js` for the master + `sheet-templates.js` for the 10 render plans if they end up split, but a single `lib/category-registry.js` is preferred.)

### Files
- **NEW** `lib/category-registry.js` — pure data + pure helpers, zero I/O (posture of `lib/categories.js`). Exports:
  - `CATEGORY_MASTER` — versioned array of master category rows: `{ category_id, label_he, group, side:'income'|'expense', default_active:bool, criteria?[] }`. `category_id` is ASCII snake_case, frozen forever (FK target for the profile store).
  - `TEMPLATE_REGISTRY` — the 10 render plans (doc 1 §3), each referencing `category_id`s from the master.
  - `getTemplate(id)`, `resolveTemplateId(profileTypeOrId)`, `templateIdFromOnboarding(profile)`, `isRowActive(row, flags)`, `mergeProfessionRows(tpl, professionId)` (doc 1 §6/§8).
- **EDIT** `lib/sheet-writer.js` — `buildTenantSheetSpec(name, opts)` consumes the registry (doc 1 §2.2). The hard-coded `PERSONAL_*_ROWS`/`COMPANY_EXPENSE_ROWS` are *derived into* the `basic_personal` entry so the snapshot test passes; the builder reads rows from the resolved template, not the constants.
- **NEW** `tests/category_registry.test.js` + `tests/sheet_templates.test.js` (doc 1 §10).

### The default-is-a-no-op guarantee (the whole safety of PR-1)
`resolveTemplateId(undefined) === 'basic_personal'`, `flags = {}` ⇒ every `activation:'always'` basic row renders, nothing gated ⇒ `buildTenantSheetSpec(name)` is **byte-identical** to today. The gate test:

- **T-BASIC-SNAPSHOT** — `buildTenantSheetSpec('Test')` (no opts) deep-equals a golden spec captured from `origin/main` HEAD. CI fails on any drift. This is the hard backward-compat gate; no existing tenant sheet can change.

### Out of scope for PR-1 (explicitly)
- No new-sheet provisioning is *re-pointed* yet (that is doc 1 Stage C). PR-1 only makes the builder *capable* of consuming `opts`; callers still pass nothing, so nothing changes in production until a later, deliberate PR flips provisioning.
- No bot re-paste. `lib/*` auto-deploys via Vercel.

### Reversible by
`git revert` of the single commit. Because the default output is byte-identical, reverting is a no-op for live sheets.

---

## 3. PR-2 — Onboarding state-machine: goal + income questions

### Scope
Add the two missing always-on questions to the **existing** survey machine so onboarding goes from 6/10 (doc 1 audit) toward complete, and so the template selector + profile prime have the inputs doc 2 §7 wants. This realizes the **A→H questionnaire of `ONBOARDING_QUESTIONNAIRE_SPEC.md`** — specifically its section **E (profession)** and the financial-goal facet of **G**.

### Files
- **EDIT** `bot/ExpenseBot_FIXED.gs` — two new steps wired into the existing `_survey*` machine:
  - `q4_goal` — "מה המטרה? לחסוך / לעקוב / לתקצב" (one tap) → `onboarding.G.wantsBudget` + a `goal` facet.
  - `q5_income` (a.k.a. the profession/income step) — the always-on profession picker (`ONBOARDING §E`) → `profile.profession` + `onboarding.E.professionId`, feeding `getProfessionBoostKeywords`.
  - Both use ASCII interactive `id`s (no Hebrew in ids — `ONBOARDING §7`); titles authored in the `.gs` file, never chat-pasted (Hebrew bidi rule).
- **EDIT** `api/profile.js` — no schema change needed (`onboarding` already merges by letter; `PROFILE_TYPES`/`ONBOARDING_SECTIONS` already present). At most, whitelist a `goal` field if added.
- **NEW** `bot/test_onboarding.js` (the `ONBOARDING §10` suite) — at minimum T-LINEAR, T-NO-DOUBLE-ASK, T-IDS-ASCII, T-HEBREW-CLEAN.

### Additive-safety guarantee
The two steps are inserted such that **skipping them leaves the old flow intact** — a user who somehow does not see them still reaches `_surveyFinish_`. The new questions can therefore ship without a feature flag: worst case, they are a no-op. Durable `onboarding.{letter}` presence remains the never-ask-twice guard (`ONBOARDING §3`).

### Bot re-paste
**Yes.** This edits the bot `.gs`, so the deploy is the manual Apps Script paste: reassemble `bot/ExpenseBot_DEPLOY.gs` from `bot/ExpenseBot_FIXED.gs` (bot-deploy-paste) and bump `KFL_BUILD_VERSION` (bot-version-bump) so the heartbeat/admin reflect it.

### Reversible by
Revert the commit + re-paste the prior `DEPLOY.gs`. Additive questions, so no data migration to unwind.

---

## 4. PR-3 — Per-user category profile store (KV + read API)

### Scope
Stand up the **Layer-2 store** (doc 2 §4) as a durable KV record keyed by `userSub`, plus a bot-secret read/write API — but wire **nothing** to read it yet. This is the safe "build the warehouse, observe the cost, then connect the pipes" PR. It is the store `BOT_CLASSIFICATION_PIPELINE_SPEC §3` (STAGE 2) and §7 (needs_review) will consume in PR-4.

### Files
- **NEW** `api/category-profile.js` — Vercel serverless endpoint (api-add-endpoint pattern), `x-kesefle-bot-secret` auth (api-auth-pattern), withRateLimit (api-rate-limit), tenant-isolated (api-tenant-isolated):
  - `GET ?phone=<E164>` → resolve `phone → userSub` via the existing chain, return `cat_profile:{userSub}`.
  - `POST { phone, action:'seed'|'bump'|'activate', ... }` → read-modify-write `cat_profile:{userSub}`.
- **NEW** `lib/category-profile.js` — shared record shape + pure helpers (so the endpoint and any later web UI agree):
  ```
  cat_profile:{userSub} = {
    v: 1,
    categories: {
      <category_id>: { active:bool, pinned:bool, usage_count:int, last_used:iso, source }
    },
    updatedAt: iso
  }
  ```
  `category_id` is the FK into `CATEGORY_MASTER` (PR-1). `source ∈ {'preset','onboarding','correction','custom'}` — and per `PIPELINE §2.2`, **never `'ai-autowrite'`** (no unconfirmed AI guess may seed the profile).
- **EDIT** new-sheet provisioning (the `api/sheet/*` create path) to **seed** `cat_profile:{userSub}` at the moment a sheet is created, from the chosen template's rows + the profession's subs (doc 1 §8, `ONBOARDING §5`). Seeding is idempotent.
- **NEW** `tests/category_profile.test.js` (test-mock-kv) — shape validation, isolation (two subs never cross-read), idempotent seed.

### Nothing-reads-it-yet guarantee
PR-3 only *writes* the store at provisioning and *exposes* a read API. `matchCategorySmart` does NOT consult it until PR-4. So PR-3 can land, run in production, and be observed (KV size, write latency) with **zero classification-behavior change**. If KV cost is a concern, PR-3 is where it surfaces, before any user-facing change depends on it.

### Reversible by
`git revert`. The key `cat_profile:{userSub}` is brand new; nothing reads it, so reverting strands harmless records (which TTL/cleanup can sweep) and removes the endpoint.

---

## 5. PR-4 — AI pipeline stages 3–5: profile tier + durable needs_review queue

### Scope
The first behavior change to the **write path**. Two additions, both from `BOT_CLASSIFICATION_PIPELINE_SPEC`:

1. **STAGE 2 profile tier** — insert `_profileCategoryLookup_(text, fromPhone)` into `matchCategorySmart` **between** the keyword map (step 2, `:9505`) and global-learn/AI (step 2.7, `:9512`) — the one-line insert in `PIPELINE §3.1`. It consults `custom_categories:{userSub}` (the existing-but-unread endpoint — `PIPELINE §3`'s "single biggest gap") + onboarding-activated categories + `cat_profile` (PR-3). A hit writes without asking **because every source is user-authored/confirmed** (`PIPELINE §2.2`).
2. **STAGE 5 durable queue** — every result that would otherwise be *dropped* (`needs_review:true`, an ignored ask, or no-provider+interactive-failed) appends ONE bounded item to `needs_review:{userSub}` (`PIPELINE §7`) instead of vanishing into the audit log.

### Files
- **EDIT** `bot/ExpenseBot_FIXED.gs`:
  - Add `_profileCategoryLookup_` + the one-line insert in `matchCategorySmart`.
  - Add the `needs_review:{userSub}` append at the drop sites.
  - 10-min `CacheService` cache keyed by **phone** for the custom-category list (`PIPELINE §2.1`/§2.3 — phone key so a re-pointed phone can't read a stale sub).
- **NEW/EDIT** `api/category-profile.js` (or a small `api/needs-review.js`) — append + list the queue.
- **EDIT** `public/account` (or PR-S6's Review Inbox) — surface the queue for one-tap assignment. (May be deferred to the doc-3 PR-S6; PR-4 only needs the *write* side of the queue.)

### The 0.6 gate is preserved VERBATIM (non-negotiable)
PR-4 **must not** re-derive or relocate the floor. `_aiAskFloor_()=0.6` (`:9975`) stays a literal; the effective threshold stays `max(0.6, env)` enforced in BOTH `matchCategorySmart` (`:9546`) and `_normalizeAiClassifyResult_` (`:9994`). The new STAGE 2 tier sits **before** the AI and only applies user-authored mappings, so it cannot lower the bar. Tests `T-FLOOR` / `T-FLOOR-RAISE` / `T-PROFILE-SOURCE` (`PIPELINE §9`) gate the PR.

### Isolation preserved
`_profileCategoryLookup_` resolves `userSub` through the existing `phone → userSub` chain and reads only that tenant's records; the cache key is the phone (`PIPELINE §2.3`). `T-ISOLATION` replays two phones and asserts no cross-read (bot-test-isolation).

### Bot re-paste
**Yes** (bot `.gs`) **plus** an API deploy for the queue endpoint. Deploy order: ship the API first (additive, harmless), then paste the bot (bot-deploy-paste + version bump).

### Reversible by
Revert the bot commit + the endpoint. Because the gate is untouched and STAGE 2 only adds user-authored hits, the **worst case of a revert is exactly today's behavior** — no tenant ends up worse than `origin/main`.

---

## 6. PR-5 — Correction → profile learning

### Scope
Close the learning loop. Today a correction (dropdown pick `:7239`, `קטגוריה X` `:6732`, or — new — a Review-Inbox assignment) updates the **text cache** (`_learnedSave(..., 'user-correction')`) and the cross-user `global_learn`. PR-5 makes the same correction **also** bump the per-user `cat_profile` (`usage_count++`, `last_used=now`, `active=true`, `source:'correction'`) so STAGE 2 (PR-4) gets durably smarter for this user — not just the per-text cache. This is `PIPELINE §6`'s `[NEW, build-plan PR-5]`.

### Files
- **EDIT** `bot/ExpenseBot_FIXED.gs` — at the three correction sites, after the existing `_learnedSave`, add one `POST /api/category-profile { action:'bump', phone, category_id }` (best-effort, non-blocking — a failed bump never blocks the user's correction or the row write).
- **EDIT** `api/category-profile.js` — the `bump`/`activate` actions (may already exist from PR-3; PR-5 just calls them).
- **EDIT** `tests/category_profile.test.js` + a bot replay test — assert a correction bumps the profile AND still writes the text cache (old fidelity preserved).

### Additive-safety guarantee
The profile bump is **strictly additive** to the existing learning. If the bump call fails or is reverted, `_learnedSave`'s text-cache learning is untouched — corrections still work at exactly today's fidelity. So PR-5 can only *improve* personalization; it cannot regress learning.

### Bot re-paste
**Yes** (bot `.gs`). bot-deploy-paste + version bump.

### Reversible by
Revert the commit. The text-cache + global-learn paths are unchanged, so reverting drops only the *extra* profile bump.

---

## 7. Cross-track dependencies (this track ↔ doc-3 PR-S*)

| Touch point | This track | Doc-3 track | Resolution |
|---|---|---|---|
| `lib/sheet-writer.js` `buildTenantSheetSpec` | PR-1 adds `opts.profileType/flags` + registry consumption | PR-S4 adds the contractor variant | **PR-1 lands first**; PR-S4 becomes a registry *entry* (doc 1 §4), not a branch. Sequence PR-1 → PR-S4. |
| Review Inbox UI | PR-4 writes `needs_review:{userSub}` (the data) | PR-S6 builds the `/account` inbox (the UI) | PR-4 ships the write side; PR-S6 reads it. Either order works; if PR-S6 lands first it shows an empty inbox until PR-4. |
| `cat_profile` ↔ dashboard rows | PR-3 store keyed on `category_id` | doc-3 dashboard reads the same `category_id`s | Both key on PR-1's `CATEGORY_MASTER.category_id` — single FK, no drift. |
| `public/dashboard.html` `?v2=1` A/B | not touched by this track | doc-3 owns it | No conflict. |

The two tracks share exactly two files (`lib/sheet-writer.js`, the Review-Inbox UI) and one concept (`category_id`). Both are resolved by **landing PR-1 first** so `category_id` and the registry exist before either track builds on them. Parallel agents working the two tracks MUST use worktree isolation (memory: file-editing agents need `isolation:worktree`) to avoid stomping each other's git state.

---

## 8. The invariants every PR in this plan must preserve

These are the non-negotiables carried from the audit + Steven's standing feedback. A PR that violates any of them is not mergeable.

1. **The 0.6 floor stays a literal, never lowered** (`_aiAskFloor_`), enforced in both code paths. Env can only *raise* it. (PR-4 is the one most at risk; `T-FLOOR` gates it.)
2. **No AI guess auto-writes below the bar.** STAGE 3's gated path stays the only AI auto-write; STAGE 2 auto-writes are user-authored mappings only (`PIPELINE §2.2`, `T-PROFILE-SOURCE`).
3. **Tenant isolation** — every new read/write keys on `userSub` via the existing chain; caches key on phone; no cross-tenant read (`T-ISOLATION`, api-tenant-isolated).
4. **Backward compatibility of existing sheets** — `buildTenantSheetSpec` default output is byte-identical (`T-BASIC-SNAPSHOT`). No live tenant sheet is rebuilt by this track; any re-render is a separate, backed-up, opt-in op (financial-data-integrity-guard).
5. **Backup → dry-run → approve → apply** for anything that touches financial data; never overwrite user-typed values (memory: safeSetFormula/safeSetValue). This track adds *structure* and *classification*, never edits a user's numbers.
6. **Hebrew safety** — interactive ids are ASCII; Hebrew labels/titles authored in the `.gs`/lib files, never chat-pasted; every Hebrew string passes test-hebrew-text (no bidi corruption, correct brand spelling).
7. **The bot stays in its OWN Apps Script project** for any standalone tools; pasting tool code into the bot project duplicates symbols and kills the bot (memory: tools_separate_appsscript_project). This track edits the bot itself (PR-2/4/5), which is fine; it does not bolt standalone tools into it.
8. **Each PR is ≤~300 LOC, independently deployable, and revertible to exactly today's behavior** (pr-incremental-plan). A reviewer can stop after any PR.

---

## 9. Deploy + verification checklist (per PR)

For every PR (deploy-checklist + test-run-all):

1. Branch from an up-to-date `main` (branch-from-main); never push to an already-merged branch (multi-pr-trap).
2. Run the full gauntlet (test-run-all / kesefle-regression-runner) — `tests/full_qa.js`, every `bot/test_*.js`, `tests/*.js`, `golden_set.js` — PASS with no regression vs the prior run.
3. For bot PRs (2/4/5): reassemble `ExpenseBot_DEPLOY.gs` (bot-deploy-paste), bump `KFL_BUILD_VERSION` (bot-version-bump), hand Steven numbered paste steps (feedback: step-by-step), confirm the heartbeat shows the new version after paste.
4. For API/lib PRs (1/3): confirm Vercel preview deploy is green; api-debug-prod spot-check the new endpoint.
5. Golden set: any misclassification fixed by a PR gets a new labeled entry (golden-set-update) so accuracy is anchored and regressions are caught.
6. PR description: what + why, screenshots where UI changes, the env vars / manual paste steps called out (commit-message-style, pr-cleanup).

---

## 10. What this plan deliberately leaves OUT (scope discipline)

- **No rewrite of `matchCategorySmart`.** It is a working 5-tier pipeline at 94.8% golden accuracy; PR-4 *inserts one tier*, it does not rebuild.
- **No new LLM provider / no prompt overhaul.** The AI call (`_aiChatComplete_`) and contract are done; this track only adds the profile tier before it and the queue after it.
- **No recurring-engine changes** (`_recurring*_` is #183's, out of scope).
- **No dashboard A/B or `public/dashboard.html` work** — that is doc-3's PR-S* track.
- **No live re-render of existing tenant sheets.** The registry governs new sheets + top-ups; migrating an existing sheet is a separate, backed-up, opt-in operation (doc 1 §9 Stage C/D), not part of PR-1…PR-5.
- **No lowering of any safety bar, ever.** If a future "smarter" idea requires relaxing the 0.6 floor to ship, it does not ship — the floor is the product's trust.

This plan is the minimum buildable delta from `origin/main` to the docs-1/2/3 target, sequenced so Steven can approve, ship, and stop at any green step.
