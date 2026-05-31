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
Create the **Layer-1 master** as a versioned JS seed (doc 2 §3), and make the sheet builder *render preset rows from it* instead of from the hard-coded `PERSONAL_*_ROWS`. This is the foundational data PR: it introduces `category_id` as a first-class concept the bot/profile/dashboard can all key on. **Default behavior is unchanged** — a tenant created with no `opts.profileType` gets byte-identical output to today.

Why a JS seed, not a `קטגוריות` sheet tab in v1: doc 2 §3 wants both an in-sheet tab AND a KV mirror. Shipping the **tab** touches every tenant's sheet (a migration with backup/dry-run/approval per `kesefle-financial-data-integrity-guard`) — too heavy for PR-1 and not reversible by `git revert`. PR-1 ships the **seed module only** (the single source the bot, the profile store, and a *future* tab-writer all read). The in-sheet `קטגוריות` tab is deferred to the doc-2 migration track (Phase B) and is explicitly **out of scope here**.

### Files
- `lib/category-registry.js` **(new, ~250 data rows + 3 helpers)** — exports `CATEGORY_REGISTRY` (array of the doc-2 §3 21-column rows, trimmed to the columns the renderer + bot actually consume in v1: `category_id`, `normalized_name`, `display_name_he`, `group`, `dashboard_section`, `default_active`, `activation_rule`, `source`), plus `byId(id)`, `forPreset(presetId, flags)`, `REGISTRY_VERSION`.
  - Seeded **deterministically** from the three existing sources so it cannot drift: `lib/categories.js` `EXPENSE_GROUPS`/`INCOME_GROUPS` (Pa'amonim baseline), the 10 `_TEMPLATE_PRESETS_.extraRows` labels (so every preset row has a registry id), and the doc-2 §8 Steven-23 table (the `historical_personal` rows).
- `lib/sheet-writer.js` — `buildTenantSheetSpec(name, opts)` (`:814`) gains `opts.profileType` (one of the 10) + `opts.flags` (`has_*`). `_buildPersonalDashboardTab` reads `forPreset(opts.profileType, opts.flags)` to choose which rows to render. **Guard:** when `opts.profileType` is absent → fall back to the exact current `PERSONAL_*_ROWS` constant path. (`sheet-spec-modify` skill: do not break the hard-coded row positions that SUMIFS/INDIRECT depend on — the renderer must emit the same *relative* layout.)
- `lib/categories.js` — unchanged in code; gains a one-line comment pointing to the registry as the canonical id map.

### The ONE risk
`buildTenantSheetSpec` feeds **every new tenant's** sheet. A row-order or SUMIFS-criterion regression silently breaks dashboards for all new signups. **Mitigation:** the `opts.profileType`-absent path returns the existing spec unchanged (proven by a golden snapshot, below); the new path is exercised only by a test fixture until PR-3 actually passes `profileType` at provision time. Nothing in production calls the new branch in PR-1.

### Tests to add
- `tests/test_category_registry.js` — every row has the required columns; `category_id` unique + snake_case ASCII ≤40; every `activation_rule` in the doc-2 §6 enum; every `_TEMPLATE_PRESETS_.extraRows` label resolves to a registry `category_id` (cross-check against the live bot constant via the balanced-brace loader, per `test-add-suite`); every `dashboard_section='business_expense'` row's `normalized_name` exists in `_BIZ_DASH_SUBS`.
- `tests/test_sheet_spec_default_unchanged.js` — **golden snapshot:** `buildTenantSheetSpec('x', { year: 2026 })` deep-equals the committed baseline (locks the no-op default).
- `tests/test_sheet_spec_preset.js` — `buildTenantSheetSpec('x', { profileType:'business', flags:{has_business:true} })` includes the business rows; `basic_personal` does not.

### Re-paste?
**No.** `lib/*` deploys with the website via Vercel push. The bot `.gs` is untouched.

---

## 3. PR-2 — Onboarding state machine: goal + income questions

### Scope
Doc 1 §2 rated onboarding **6/10**: it asks tracking-type, kids/pets/car, recurring, autolog, profession — but **never asks WHY** the user is here or their **income**. Doc 1 improvements #2 and #3 are exactly these. Add two steps to the **existing** machine and persist them into the **existing** `profile.onboarding` blocks. Nothing about the machine's plumbing changes — these are two more `q*` steps after the current last text step.

### Files
- `bot/ExpenseBot_FIXED.gs`:
  - Add step `q4_goal` — interactive list: `מעקב` / `חיסכון` / `הפחתת הוצאות` / `הכנה לרו״ח` (track / save / reduce / accountant-prep). Insert in the step router alongside the existing `q1_*/q2_*/q3_*` keys (the router region near `:2399`).
  - Add step `q5_income` — one-tap list: `עד 5,000` / `5,000–12,000` / `12,000–25,000` / `25,000+` (ranges, never a free-text salary — avoids storing a precise income figure).
  - Persist via the existing profile POST helper (`:4259`): `onboarding.G = { goal }`, `onboarding.H = { income_band }` (G/H are already-accepted section letters in `api/profile.js` `ONBOARDING_SECTIONS`). No endpoint change needed.
  - Hebrew copy per `bot-reply-style` + `hebrew-copy-check`; ASCII-only `.gs` comments per `feedback_chat_paste_hebrew_bidi`.

### The ONE risk
Adding steps to a live state machine can **strand mid-onboarding users** whose stored step pointer no longer matches the new sequence. **Mitigation:** append the new steps **after** the current terminal step (preset pick), and make the router treat an unknown/old step pointer as "onboarding complete" (fall through to normal expense processing) rather than erroring — additive, forward-compatible, mirrors how `_normalizeAiClassifyResult_` defaults unknown rules to the safe branch.

### Tests to add
- `tests/test_onboarding_goal_income.js` (per `kesefle-bot-conversation-audit`) — replay a synthetic onboarding through the real step router (no live writes): assert `q4_goal` then `q5_income` fire in order, each persists the right `onboarding.G/H` block, and that a stale step pointer falls through cleanly.
- Golden-set untouched — these questions don't change classification.

### Re-paste?
**Yes** — bot `.gs` change. Follow `bot-deploy-paste` + `bot-version-bump` (bump `KFL_BUILD_VERSION`).

---

## 4. PR-3 — Per-user category profile store (KV + read API)

### Scope
Build doc 2's **Layer 2** (`User_Category_Profile`) as a **KV-first store** keyed by `userSub`, reusing the exact tenant-resolution + bot-secret pattern that `api/sheet/add-category-row.js` and `api/profile.js` already use. Nothing reads it for routing yet (PR-4 does) — PR-3 just stands up the store, seeds it at provision time from PR-1's registry + the chosen preset, and exposes get/set so the dashboard and bot can use it later. This lets us **observe KV cost** (doc 2 §11.3: ~1 KB/user) before any behavior depends on it.

KV-first, sheet-tab-later (same rationale as PR-1): the `User_Category_Profile` *sheet tab* is a per-tenant migration (Phase B). v1 ships the KV record only; the reconciliation cron and in-sheet tab are deferred to the doc-2 migration track.

### Files
- `lib/category-profile.js` **(new, shared shape)** — the record contract + pure helpers: `emptyProfile()`, `seedFromPreset(presetId, flags)` (reads `lib/category-registry.js` `forPreset` + the doc-2 §6 `shouldActivate(rule, flags)`), `activate(profile, categoryId, {via})`, `bumpUsage(profile, categoryId, amount)`. No I/O — pure, unit-testable.
- `api/category-profile.js` **(new endpoint)** — `POST {action:'get'|'set'|'activate', phone, ...}`, bot-secret via `x-kesefle-bot-secret` (constant-time compare, exactly like `api/profile.js:87`), `withRateLimit`. Resolves `phone → userSub` (the canonical chain; **never** the owner sheet), reads/writes `cat_profile:{userSub}`. Tenant-isolation invariant identical to `add-category-row` — review with `api-tenant-isolated` + `kesefle-category-profile-audit`.
- Provision hook: where a new tenant sheet is created and presets are seeded (`applyTemplatePreset_` path), also call `category-profile set` with `seedFromPreset(profileType, flags)`. Idempotent (`SETNX`-style: only seed if `cat_profile:{userSub}` absent).

### KV key shapes (concrete)
```
cat_profile:{userSub} = {
  "v": 1,
  "preset": "business",
  "updated_at": "2026-06-01T09:00:00Z",
  "categories": {
    "food_groceries":   { "active": true,  "pinned": false, "order": 1, "count": 0,  "last_used": null,                  "via": "preset" },
    "business_marketing":{ "active": true,  "pinned": false, "order": 12,"count": 0,  "last_used": null,                  "via": "preset" },
    "pets_vet":         { "active": false, "pinned": false, "order": 0, "count": 0,  "last_used": null,                  "via": "registry_default" }
  }
}
```
Map (not array) keyed by `category_id` → O(1) bump on the hot write path. `via` ∈ `preset|registry_default|bot_auto_activated|user_added|migration`.

### The ONE risk
A new **unauthenticated** write surface is the classic tenant-isolation hole. **Mitigation:** copy `api/profile.js`'s auth verbatim (bot-secret, constant-time, 503-if-unconfigured) and resolve identity through `phone → userSub` only — **never** read/write by sheet id or owner fallback. Gate the PR behind `security-scan` + `api-tenant-isolated` + a `test_category_profile_isolation.js` that asserts phone A can't touch phone B's `cat_profile`.

### Tests to add
- `tests/test_category_profile_shape.js` — `seedFromPreset('family', {has_children:true})` activates the kid rows + always-on baseline; `bumpUsage` increments count + sets `last_used`; `activate` flips `active` + records `via`.
- `tests/test_category_profile_isolation.js` (mock KV per `test-mock-kv`) — cross-tenant read/write denied; missing-phone → `no_user_for_phone`; idempotent seed (second seed is a no-op).

### Re-paste?
**No.** API + lib only (Vercel auto-deploy). The provision hook lives server-side. (If the seed call is added on the **bot** side instead of the API provision path, then yes — prefer the API path to keep this re-paste-free.)

---

## 5. PR-4 — AI pipeline stages 3–5: profile tier + durable needs_review queue + the never-corrupt gate

### Scope
This is the **brain** of #271's "AI-classifier fallback pipeline (deterministic → profile → AI → ask → needs_review)" with the hard invariant that **AI must NEVER silently write a low-confidence/ambiguous financial row.** The good news from the audit: **stages 1–4 and the 0.6 gate already exist** (`matchCategorySmart` `:9480`, `_normalizeAiClassifyResult_` `:9977`). PR-4 adds the **two missing stages**:

1. **Stage "profile" (between keyword and LLM).** Insert a tier into `matchCategorySmart` *after* step 2 (`CATEGORY_MAP`, `:9501`) and *before* step 2.7/3 (global-learn/LLM): if the keyword match is `DEFAULT` but the user's `cat_profile` (PR-3) has an active category whose registry `normalized_name`/keywords match the text, resolve to that **user's** category. This is what makes the bot *personalized* — Steven's "BMW" → `transport_bmw_steven`, a contractor's "בטון" → their active `construction_concrete` — without an LLM call. Read via a cached `cat_profile` fetch (same caching shape as `_profileTrackingTypeCached_`).
2. **Stage "needs_review" (durable queue).** Today, a `should_ask_user` result fires the **interactive dropdown** — excellent UX, but **ephemeral**: if the user ignores it, the expense is held in `pending:{phone}` and can age out. Add a **durable** `needs_review:{userSub}` queue: every time the contract says `should_ask_user`, also enqueue `{ts, text, amount, guess:{cat,sub,conf}, reason}`. The dropdown stays the fast path; the queue is the *system-of-record* that the Review Inbox (doc 3 PR-S6) and the dashboard read. This is stage 5 — the thing that guarantees a low-confidence row is **parked, never silently filed**.

**The gate is NOT re-derived.** PR-4 calls the existing `_normalizeAiClassifyResult_` / `_aiAskFloor_()=0.6` and the existing inline check at `:9546`. It only *adds* the enqueue side-effect and the profile tier. The invariant comment block (`:9963`) is preserved verbatim.

### Files
- `bot/ExpenseBot_FIXED.gs`:
  - `matchCategorySmart` (`:9480`) — insert `_resolveFromProfile_(text, fromPhone)` between step 2 and step 2.7. Returns a `{category, subcategory, categoryId, fromProfile:true}` or null. If it returns a hit, **skip the LLM** (cheaper + already user-confirmed shape).
  - New `_resolveCategoryId_(category, subcategory)` — maps a classifier `(category, subcategory)` string pair to a registry `category_id` (extends the existing `_normalizeBizSub_` `:11077` idea to all groups). Used so the queue + profile speak in `category_id`.
  - New `_enqueueNeedsReview_(fromPhone, payload)` → `POST /api/needs-review` (bot-secret). Called at **every** `should_ask_user` site (the dropdown path `:7239`, the multi-item withhold `:9553`).
- `api/needs-review.js` **(new endpoint)** — `POST {action:'enqueue'|'list'|'resolve', phone, ...}`, bot-secret + tenant-resolved `userSub`, list-pushes/reads `needs_review:{userSub}` (capped, e.g. last 200). Mirrors `api/profile.js` auth.

### The ONE risk
Touching `matchCategorySmart` — the **hot write path every message flows through** — risks regressing classification accuracy or, worse, the never-corrupt invariant. **Mitigation:** (a) the profile tier is **purely additive** — it only fires when the keyword match was already `DEFAULT` (so it can only *improve* a would-be-misc result, never override a confident keyword hit); (b) the 0.6 gate code is **unchanged** — `git diff` on the gate lines must be empty; (c) the golden-set (`tests/golden_set.js`, 155 msgs, threshold 93%) must still pass at ≥94.8%; (d) a new test asserts a `should_ask_user` result **enqueues AND does not write a confident category**.

### Tests to add
- `tests/test_profile_tier_routing.js` (per `kesefle-bot-replay`) — with a mock `cat_profile:steven`, "BMW 850" resolves to `transport_bmw_steven` via the profile tier with **no** LLM call; a non-default keyword hit ("סופר 200") is **unaffected** by the profile tier.
- `tests/test_needs_review_gate.js` — a low-confidence AI result (`{אוכל, 0.45}`) still returns the DEFAULT/withheld category (gate intact) **and** pushes one `needs_review` item; a high-confidence result writes and enqueues nothing.
- `tests/golden_set.js` — re-run, must stay ≥93% (target: unchanged 94.8%).
- `tests/test_needs_review_isolation.js` — cross-tenant queue access denied.

### Re-paste?
**Yes** (bot `.gs`) **and** API (`needs-review.js` auto-deploys). Deploy order: ship the **API first** (so the enqueue endpoint exists), then paste the bot. `bot-version-bump` + `kill-switch` awareness (`KFL_DISABLE_BOT_WRITES` still halts everything).

---

## 6. PR-5 — Correction → profile learning

### Scope
Close the loop. Today a correction (`קטגוריה X`, a dropdown pick, or — after PR-4 — resolving a queue item) calls `_learnedSave` and updates the **text cache** (and cross-user global-learn). PR-5 makes that same correction also update the user's **category profile**: activate the corrected `category_id` if it was inactive, bump `usage_count`/`last_used`, and record `via:'user_correction'`. This is what turns a one-off fix into a durable personalization — the corrected category now *renders on the dashboard* (via PR-3's store) and *wins the profile tier* next time (via PR-4), not just the exact-text cache.

### Files
- `bot/ExpenseBot_FIXED.gs`:
  - At the three correction sites that already call `_learnedSave(..., 'user-correction')` — the `קטגוריה X` handler (`:6732`), the single-pick (`:7239`), the tenant-pick (`:7065` region) — add a sibling call `_profileLearn_(fromPhone, categoryId, {via:'user_correction', amount})` that POSTs `category-profile {action:'activate'}` (PR-3 endpoint).
  - New `_profileLearn_(fromPhone, categoryId, opts)` — thin wrapper over the PR-3 endpoint; best-effort (never blocks the reply, mirrors `_addCategoryRows_`'s try/catch logging at `:4349`).
  - When PR-4's `needs_review` item is resolved, the same `_profileLearn_` fires (the queue resolution IS a correction).
- No new endpoint — reuses PR-3's `api/category-profile.js` `activate` action.

### The ONE risk
A correction firing **two** write side-effects (text cache + profile) can **double-count** usage or, if the profile write fails, leave cache and profile **inconsistent**. **Mitigation:** the profile write is **best-effort and idempotent** — `activate` is set-not-increment for the active flag; `bumpUsage` is the only increment and is keyed to the *write*, not the *correction* (a correction that doesn't write a new row only flips `active`, it does not bump count). Cache remains the source of truth for routing; profile is advisory for *display + tie-break* (exactly the doc 2 §4 "eventual consistency is acceptable; last_used/usage_count are advisory, not financial" stance). A failed profile write logs and is reconciled by the (deferred) nightly cron — it never corrupts a financial row.

### Tests to add
- `tests/test_correction_profile_learn.js` — a `קטגוריה X` correction on an **inactive** category flips it `active:true` in `cat_profile` with `via:'user_correction'`; a dropdown pick does the same; resolving a `needs_review` item does the same; the text cache (`_learnedSave`) still updates in parallel (no regression).
- `tests/test_correction_idempotent.js` — the same correction twice does not double the active flag; `bumpUsage` only fires on an actual row write.

### Re-paste?
**Yes** (bot `.gs`). API unchanged (reuses PR-3). `bot-version-bump`.

---

## 7. Cross-cutting invariants every PR must honor

These are non-negotiable and re-checked in each PR's `pr-review`:

1. **Never silently write a low-confidence/ambiguous row.** The `_aiAskFloor_()=0.6` + `should_ask_user`/`needs_review` contract is preserved verbatim. PR-4's `git diff` on the gate lines (`:9546`, `:9994`) must be empty. (`kesefle-bot-llm-safety` / `AUDIT_BOT_LLM_SAFETY`.)
2. **Tenant isolation.** Every new endpoint (`category-profile`, `needs-review`) resolves `phone → userSub` and **never** falls through to the owner sheet. (`api-tenant-isolated`, `kesefle-kv-tenant-isolation`.)
3. **Never overwrite user-typed values.** No PR here writes to `תנועות` / `מאזן אישי` / `מאזן חברה` row values; the profile/queue are *new* KV records + (later) *new* tabs. The category-row seeding stays on the idempotent, dedup-by-label `add-category-row` path. (`feedback_never_overwrite`, `kesefle-financial-data-integrity-guard`.)
4. **Backup → dry-run → approve before any sheet write.** The in-sheet `קטגוריות` + `User_Category_Profile` tabs (doc 2 Phase B) are **explicitly deferred** out of this track precisely because they are per-tenant sheet migrations that need the backup/dry-run/approval pipeline. This track is KV-only + the no-op-default sheet renderer. (`feedback_backup_propose_apply`.)
5. **No Hebrew bidi corruption in `.gs`.** All new bot comments ASCII-only; Hebrew literals copied from file, not chat. (`feedback_chat_paste_hebrew_bidi`, `sheet-hebrew-encoding-safe-script`.)
6. **Golden set stays green.** `tests/golden_set.js` ≥93% after every PR that touches classification (PR-4). (`golden-set-update`, `kesefle-regression-runner`.)

---

## 8. Dependency graph + parallelism

```
PR-1 (registry + renderer, no-op default)
   │
   ├──────────────► PR-2 (onboarding goal/income)        [independent; only soft-needs PR-1 so answers map to presets]
   │
   └──► PR-3 (cat_profile store, KV-first)
            │
            └──► PR-4 (profile tier + needs_review queue + gate)
                     │
                     └──► PR-5 (correction → profile learning)
```

- **PR-1 and PR-2 can land in parallel** (different files; PR-2 only references PR-1's preset ids in copy, not code).
- **PR-3 must precede PR-4** (store before reader).
- **PR-4 must precede PR-5** (queue + profile tier before the correction loop that feeds them).
- Doc 3's **PR-S4** (Contractor sheet variant) and **PR-S6** (Review Inbox UI) **consume** this track: PR-S4 reads PR-1's registry for its rows; PR-S6 reads PR-4's `needs_review:{userSub}` queue. Sequence doc-3's UI PRs *after* the data PRs they depend on.

---

## 9. Explicit non-goals for this track (deferred, named)

So scope doesn't creep mid-sequence:
- **No in-sheet `קטגוריות` / `User_Category_Profile` tabs in v1.** Deferred to the doc-2 Phase-B per-tenant migration (backup/dry-run/approval). This track is KV + no-op-default renderer.
- **No reconciliation cron** (`api/cron/reconcile-profiles.js`, doc 2 §4). Lands with the sheet-tab migration, not here. KV is authoritative until then.
- **No existing-user backfill.** PR-1…PR-5 change *new* signups' provisioning + *all* users' write path (additively). Migrating existing users onto profiles is doc-2 Phase B.
- **No dashboard view-modes** (Compact/Full/Review/Historical, doc 2 §9) or **dashboard cards/charts** (doc 3 PR-S5). Those are the dashboard track.
- **No receipt-OCR / voice / multi-tenant-multi-business changes** (doc 1 §6/§7/§9 items). Separate backlog.
- **No Layer-1 row creation from free-text.** Registry is admin/seed-only; unknown text routes to `misc` + `needs_review`, never auto-creates a master row (doc 2 "Out of scope").

---

## 10. Per-PR LOC + re-paste summary (the reviewer's cheat sheet)

| PR | Est. LOC | New files | Touches bot `.gs`? | Re-paste? | Lands deployable alone? |
|---|---|---|---|---|---|
| PR-1 | ~280 (mostly data) | `lib/category-registry.js` | No | **No** | Yes — no-op default |
| PR-2 | ~120 | — | Yes | **Yes** | Yes — additive questions |
| PR-3 | ~220 | `lib/category-profile.js`, `api/category-profile.js` | No (API provision hook) | **No** | Yes — store unread until PR-4 |
| PR-4 | ~260 | `api/needs-review.js` | Yes | **Yes** (API first, then bot) | Yes — gate unchanged, worst case = today |
| PR-5 | ~110 | — | Yes | **Yes** | Yes — text-cache learning untouched |

Each ≤~300 LOC, each independently revertible, each leaves the bot coherent. Open PRs one at a time, in graph order, never merge ahead of Steven's review.

---

*End of build plan. This is the route; docs 1–3 are the destination.*
