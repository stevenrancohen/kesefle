# Bot Classification Pipeline — Design Spec

**Status:** Design (DOCS ONLY). No code in this PR.
**Epic:** #271 — smarter, personalized, accurate bot.
**Scope:** the deterministic→profile→AI→ask→needs_review classification pipeline and the hard invariant that the AI must **never** silently write a low-confidence or ambiguous financial row.
**Audience:** whoever implements the follow-up code PRs. Every stage below names the exact existing function, file, line, KV key, and JSON field so the work is buildable, not aspirational.

This spec **describes what already exists** in `bot/ExpenseBot_FIXED.gs` on `origin/main`, then specifies the **gaps to close** (marked **NEW**) so STAGE 2 (per-user profile) becomes a real, first-class stage rather than the two ad-hoc sheet tabs it is today. It deliberately builds on `matchCategorySmart`, `_aiCategorizeRich`, `_normalizeAiClassifyResult_`, the 0.6 floor, and `lib/categories.js` — it does not propose a rewrite.

Companion docs: `docs/CLASSIFICATION.md` (user-facing summary, must be updated when STAGE 2 lands), `docs/PERSONALIZED_CATEGORY_PROFILES.md` (the profile data model this stage reads), `docs/AUDIT_BOT_LLM_SAFETY_2026_05_31.md` (the safety audit this invariant answers).

---

## 0. The one rule everything else serves

> **HARD INVARIANT (Steven, "never silently corrupt"):** a low-confidence or ambiguous classification MUST NOT write a financial row to `תנועות`. It is either (a) routed to STAGE 4 (ask the user) or (b) bucketed in STAGE 5 (needs_review). The AI is a *suggester*, never an *autonomous writer*, below the bar.

The bar is the **0.6 hard confidence floor**. It is implemented today and this spec freezes it:

- `_aiAskFloor_()` → returns `0.6` (`bot/ExpenseBot_FIXED.gs:9975`). This is a literal, not a property read. **It must stay a literal.**
- The effective ask threshold is `Math.max(_aiAskFloor_(), env)` where `env = _kflConfidenceAskThreshold_()` (default `0.85`, `bot/ExpenseBot_FIXED.gs:68`). Computed in `_normalizeAiClassifyResult_` (`:9989`).
- **Therefore the env knob can only RAISE the bar (make the bot ask MORE), never lower it below 0.6.** Setting `KFL_CONFIDENCE_ASK_THRESHOLD=0.3` does **not** drop the floor; the bot still asks below 0.6. This asymmetry is a deliberate safety property and a test MUST assert it (see §9, T-FLOOR).

Everything below is plumbing in service of this rule.

---

## 1. Pipeline at a glance

```
                 user message: "850 שיווק"  /  "wolt תל אביב"  /  "אבא 200"
                                     │
                                     ▼
      ┌──────────────────────── parseAmountAndDescription ────────────────────────┐
      │  amount=850, description="שיווק"     (strips ₪/$/€, שח/שקל, '+' income flag) │
      └────────────────────────────────────┬──────────────────────────────────────┘
                                            ▼
   STAGE 1  DETERMINISTIC  ─ _learnedLookup → _autoSynonymLookup_ → matchCategory(CATEGORY_MAP)
      hit → WRITE (col H from _resolveIsIncome_)                     [confidence := 1.0, deterministic]
      miss ▼
   STAGE 2  PROFILE        ─ per-user learned + onboarding categories  (NEW: unify into one resolver)
      hit → WRITE                                                    [confidence := profile-pinned 1.0]
      miss ▼
   STAGE 2.5 GLOBAL LEARN  ─ _globalLearnLookup_  (SHA-256 hash → /api/learn, cross-user, privacy-safe)
      hit → WRITE
      miss ▼
   STAGE 3  AI FALLBACK    ─ _aiCategorizeRich → _aiChatComplete_(env provider) → JSON contract
      returns {category, subcategory, confidence, should_ask_user, needs_review, reason}
      │
      ├─ confidence ≥ max(0.6, env)  AND  !should_ask_user  AND  category ∉ {שונות, בלתי מזוהה}
      │        → WRITE  + _learnedSave(source:'ai')                  [the ONLY AI auto-write path]
      │
      └─ otherwise ▼
   STAGE 4  ASK            ─ _predictTopCategories → _buildCategoryListSections → sendWhatsAppInteractiveList
      pending state saved to PropertiesService('pending:<phone>')
      user taps a row → handleInteractiveReply_ → WRITE + _learnedSave(source:'user') + _globalLearnPublish_
      │
      └─ user ignores / no AI provider / list build fails ▼
   STAGE 5  NEEDS_REVIEW   ─ contract.needs_review=true; row NOT written; logged to ML Audit;
                             queued in needs_review:<phone> (NEW) for the digest + /account review UI.
```

Stage numbers map 1:1 to the brief. STAGE 2.5 (global learn) is an existing optimization that sits between profile and AI; it is documented here for completeness but the five canonical stages are 1→2→3→4→5.

---

## 2. STAGE 1 — Deterministic keyword match (EXISTS)

**Where:** `matchCategorySmart(text, fromPhone)` steps 1, 1.5, 2 (`bot/ExpenseBot_FIXED.gs:9480`–`9505`).

| Sub-step | Function | Source | Notes |
|---|---|---|---|
| 1. Learned cache | `_learnedLookup(text)` (`:9482`) | sheet tab `מילון לימוד` | exact match, then longest-substring keyword. In-memory, 60 s cache. |
| 1.5 Auto-synonyms | `_autoSynonymLookup_(text)` (`:9491`) | sheet tab `Auto Synonyms` | LLM-pre-expanded synonyms from `cronSynonymExpansion` (`:16561`). Checked before the static map so fresh variants win. |
| 2. Keyword map | `matchCategory(text)` → `_matchCategory_long` (`:9501`, `:9413`) | `CATEGORY_MAP` (~320 entries / ~21k keywords) + `BUSINESS_CATEGORY_MAP` | **longest matching keyword wins** (entries sorted by `kw.length` desc, `:9451`). |

**Precision guard — `_kflKwHit_` (`:9385`):** keywords > 3 chars match as substrings (so `בשופרסל` matches `שופרסל`); keywords ≤ 3 chars must match as **whole words** (bounded by non-word chars via `_kflIsWordChar_`, `:9380`) so `מים` does not fire inside `תשלומים`. **Do not weaken this in any later stage.**

**Output of a STAGE 1 hit:** `{ category, subcategory, isIncome }`. This is a deterministic, confidence-implied-1.0 result. It is **written immediately** — STAGE 1 hits never go to the AI and never ask. `isIncome` is propagated from the map entry (BUGFIX B1, `:9432`) and finalized at the write site by `_resolveIsIncome_` (`:755`).

**STAGE 1 is `fromPhone`-independent** — the global dictionary is the same for everyone. Personalization is STAGE 2's job.

---

## 3. STAGE 2 — Per-user category profile (PARTIALLY EXISTS → unify)

This is the stage the epic most wants strengthened. Today, "the user's own categories" are scattered across three places that are consulted inconsistently:

1. **`מילון לימוד`** (learned cache) — per-tenant, but it is STAGE 1.1, not a distinct profile stage, and for non-owner tenants it is not populated by the owner's sheet.
2. **`custom_categories:<userSub>`** (KV, `api/custom-categories.js`) — premium user-defined categories. The header comment at `api/custom-categories.js:11` claims the bot's classifier "consults this list BEFORE falling back to LLM" — **but no live call site in `ExpenseBot_FIXED.gs` reads it.** This is the single biggest gap.
3. **Onboarding answers** (`profile:<phone>.onboarding` + `profileType`, `api/profile.js`) — these seed the *sheet template* (`applyTemplatePreset_`) and *bias the AI prompt* (`_profileTrackingTypeCached_`, `_profileProfessionCached_`) but are **not** consulted as a direct category lookup before the AI.

### 2.1 What STAGE 2 must become (NEW)

A single resolver, consulted **after** STAGE 1 deterministic miss and **before** STAGE 2.5/3:

```js
// bot/ExpenseBot_FIXED.gs  (NEW)
// Returns { category, subcategory, isIncome, source } or null.
// source ∈ {'profile-pinned','profile-custom','profile-onboarding'}
function _profileCategoryLookup_(text, fromPhone) { ... }
```

Insert one line in `matchCategorySmart` between step 2 (`:9505`) and step 2.7 (`:9512`):

```js
// Step 2.5 (NEW): per-user category profile (learned + onboarding + custom).
if (fromPhone) {
  var prof = _profileCategoryLookup_(text, fromPhone);
  if (prof) { _learnedSave(text, prof, 'profile'); return prof; }
}
```

`_profileCategoryLookup_` resolves in this order (first hit wins):

1. **Pinned/custom categories** — `custom_categories:<userSub>` via the existing bot read path (`GET /api/custom-categories?phone=<E164>` with `x-kesefle-bot-secret`, handled by `handleBotRead`, `api/custom-categories.js:146`). Match a custom `name` against the text using the same `_kflKwHit_` precision rule. A custom category with a `parent` maps `{category: parent, subcategory: name}`; without a parent it maps `{category: name, subcategory: name}`. **Cache the list 10 min** in `CacheService` keyed `custcat:<phone>` to avoid an HTTP hop per message (mirror the `_hasActivePremium_` caching pattern, `:9800`).
2. **Onboarding-activated categories** — the categories the user said they care about during onboarding (`profile:<phone>.onboarding.*` + `profileType`). These resolve **ambiguity ties toward what the user actually tracks** (e.g. a `business` tracker's bare "ייעוץ" → `עסק/יועצים`, a `family` tracker's "חוג" → `ילדים/חוגים`). This is a *weak* signal: it only fires when the deterministic map produced NOTHING, and only for tokens that exactly match an activated category label. It never overrides a STAGE-1 hit.
3. **Per-user learned profile** — the durable `cat_profile:<userSub>` store (the formalization of `מילון לימוד` + corrections, [build-plan PR-3]). A previously-corrected mapping for *this* user wins over the AI.

### 2.2 Why STAGE 2 is safe even though it auto-writes

A STAGE 2 hit writes without asking — same as STAGE 1. That is acceptable ONLY because every STAGE 2 source is **user-authored or user-confirmed**:

- custom categories: the user created them on the web.
- onboarding-activated: the user said "I track this" during onboarding.
- learned profile: the user corrected the bot to this mapping before.

None of these is an AI guess. The AI's output never enters STAGE 2; it stays gated by 0.6 in STAGE 3. So STAGE 2 cannot silently corrupt — it can only apply a mapping the user themselves established. A test (T-PROFILE-SOURCE) must assert no STAGE 2 entry can originate from an AI auto-write that the user never confirmed.

### 2.3 Isolation invariant (do not regress)

`custom_categories` and `cat_profile` are keyed by **`userSub`**, resolved from the phone via the existing chain `phone → user:{phone} → userSub` (the same chain `/api/sheet/append` uses). STAGE 2 MUST resolve `userSub` through that chain and MUST NOT read another tenant's profile. The 10-min cache key is the **phone** (not userSub) so a re-pointed phone cannot read a stale sub's list. This is the bot-test-isolation invariant; a test replays two phones and asserts no cross-read.

---

## 4. STAGE 2.5 — Global cross-user learning (EXISTS, privacy-safe)

**Where:** `_globalLearnLookup_` / `_globalLearnPublish_` → `/api/learn` (`api/learn.js`).

- The lookup key is a **SHA-256 hash** of the normalized description — the raw Hebrew text never leaves the tenant; only the hash + the resulting category are shared. This is the privacy property the security audit requires; **do not** change it to send raw text.
- A global-learn hit writes directly (it represents a strong cross-user consensus mapping). It sits AFTER the per-user profile so the user's own correction always beats the crowd.
- It is an optimization, not one of the five canonical stages; it is documented so an implementer does not mistake it for a missing piece.

---

## 5. STAGE 3 — AI fallback (EXISTS — this is where the 0.6 floor lives)

**Where:** `_aiCategorizeRich(text, ctx)` (`:10036`) → `_aiChatComplete_` (`:9881`) → provider resolved by `_aiProviderResolve_` (`:9864`). Output normalized by `_normalizeAiClassifyResult_` (`:9977`).

### 5.1 The JSON contract (the model MUST return exactly this)

```json
{
  "category":        "string (must be a known top category or 'בלתי מזוהה')",
  "subcategory":     "string",
  "confidence":      0.0,
  "should_ask_user": false,
  "needs_review":    false,
  "reason":          "short string, for the ML Audit log only"
}
```

`_normalizeAiClassifyResult_` coerces/clamps every field, then applies the gate:

```
effectiveThreshold = max(_aiAskFloor_()=0.6, env=_kflConfidenceAskThreshold_())   // :9989/:9994
ask = should_ask_user
   || confidence < effectiveThreshold
   || category in { 'שונות', 'בלתי מזוהה', '' }
   || subcategory missing
```

- `ask === false` → **AI auto-write** (the ONLY path where an AI guess writes). On write, `_learnedSave(text, result, 'ai')` records it so the SAME text is deterministic next time (it graduates to STAGE 1's learned cache).
- `ask === true` → STAGE 4.

### 5.2 Profile context feeds the PROMPT, not the gate

The user's `trackingType` / `profession` are injected into the AI prompt (`_profileTrackingTypeCached_`, `_profileProfessionCached_`) so the model disambiguates better (a contractor's "מלט" → materials). This **improves the suggestion** but **does not relax the gate** — a profession-informed guess at confidence 0.55 still asks. Context sharpens; it never lowers 0.6.

### 5.3 No provider / provider error

If `_aiProviderResolve_` returns none, or the call throws/times out, there is **no AI guess** → fall straight to STAGE 4 (ask) if interactive is possible, else STAGE 5 (needs_review). The bot NEVER writes a default/guessed category when the AI is unavailable. (Failing to STAGE 4/5 instead of writing שונות is the safety choice.)

---

## 6. STAGE 4 — Ask the user (EXISTS — the best-designed part)

**Where:** `_predictTopCategories` → `_buildCategoryListSections` → `sendWhatsAppInteractiveList`; reply handled by `handleInteractiveReply_`.

- The bot sends a WhatsApp interactive **list** of the most likely categories (ranked by the predictor, seeded by STAGE 2 profile so the user's own categories surface first), plus an "אחר" escape.
- Pending state is stored at `PropertiesService('pending:<phone>')` with the parsed amount + description + candidate list, TTL-bounded, so the tap resolves the right row even minutes later.
- On tap: WRITE the row, `_learnedSave(text, picked, 'user')` (graduates to STAGE 1 for this tenant), and `_globalLearnPublish_(hash, picked)` (contributes the consensus, privacy-safe). **A user tap is the strongest possible signal** — it updates per-user profile AND the global cache.
- **[NEW, build-plan PR-5]** the same tap also bumps the per-user `cat_profile` (`usage_count`, `last_used`, activates the category) so STAGE 2 gets smarter, not just the text cache.

The interactive list is unchanged by this spec except that its candidate ordering now consults STAGE 2 first (so a user sees their own categories at the top).

---

## 7. STAGE 5 — needs_review (EXISTS as a flag → make it a durable queue)

Today `needs_review:true` from the contract means: do not write, log to the ML Audit tab. That is the floor of safety (nothing wrong is written) but the recovery is weak — the row is effectively dropped and only visible in an audit log.

**[NEW]** Add a durable per-user queue so nothing is silently lost:

```
KEY:   needs_review:<userSub>          // KV list (append), bounded length
ITEM:  { ts, amount, rawText, aiGuess:{category,subcategory,confidence}, reason, source }
```

- Written whenever a message would otherwise be dropped: AI says `needs_review`, OR the user ignored a STAGE-4 ask for N hours, OR no provider was available and interactive failed.
- Surfaced two ways: (a) the daily/periodic digest message ("יש לך 3 הוצאות לבדיקה"), (b) a **Review Inbox** in `/account` (sheet-and-dashboard-strategy PR-S6) where the user assigns each in one tap — which then writes the row and feeds STAGE 2/2.5 learning.
- Bounded length + TTL so the queue cannot grow unbounded (KV cost guard).

This closes the loop: an ambiguous expense is never written wrong AND never lost — it waits for one user tap.

---

## 8. The write site — single chokepoint for col H + isolation

Every stage that "WRITEs" funnels through **one** append path (`/api/sheet/append` via the bot), and col H (income vs expense) is finalized by `_resolveIsIncome_` (`:755`) at that chokepoint, regardless of which stage produced the classification. This matters because:

- It guarantees the income/expense decision is applied uniformly (a STAGE-1 income keyword, a STAGE-2 profile income category, and a STAGE-3 AI `isIncome` all get the same final treatment).
- It is the single place the tenant-isolation invariant (phone→userSub→sheet) is enforced. No stage writes to a sheet directly; they all return a classification and let the chokepoint write. A test asserts every write path resolves the sheet via the chain (bot-test-isolation).

---

## 9. Tests the implementation MUST add (CI gauntlet, no live writes)

Run via the existing harness (test-add-suite — load real source by balanced-brace extraction; test-mock-kv for the KV reads). All are pure / mocked; none send a real WhatsApp message or write a real number.

| id | Asserts |
|---|---|
| **T-FLOOR** | `KFL_CONFIDENCE_ASK_THRESHOLD=0.3` does NOT drop the floor: a 0.55-confidence AI result still routes to ASK, never WRITE. (The §0 asymmetry.) |
| **T-FLOOR-RAISE** | `KFL_CONFIDENCE_ASK_THRESHOLD=0.9` DOES raise it: a 0.7 result asks. (Knob can tighten.) |
| **T-STAGE-ORDER** | A text that matches both CATEGORY_MAP and a custom category resolves via STAGE 1 (deterministic wins); the profile lookup is not even consulted. |
| **T-PROFILE-HIT** | A custom category name resolves via STAGE 2 with `source:'profile-custom'` and writes without asking. |
| **T-PROFILE-SOURCE** | No STAGE 2 entry can originate from an unconfirmed AI auto-write (every profile source is user-authored/confirmed). |
| **T-ISOLATION** | Two phones with different `userSub`s never read each other's `custom_categories`/`cat_profile`; the cache key is the phone. |
| **T-AI-CONTRACT** | A malformed AI JSON (missing `subcategory`, NaN confidence, unknown category) is coerced by `_normalizeAiClassifyResult_` to ASK, never to a bad WRITE. |
| **T-NO-PROVIDER** | With no AI provider, an unmatched message goes to ASK (or needs_review), never writes שונות. |
| **T-NEEDS-REVIEW-QUEUE** | A `needs_review` result appends exactly one bounded item to `needs_review:<userSub>` and writes NO row. |
| **T-PRECISION** | `_kflKwHit_` short-keyword whole-word rule holds across all stages (`מים` does not fire inside `תשלומים`). |
| **T-GOLDEN** | The existing golden set (`tests/golden_set.js`) accuracy does not regress; new STAGE 2 entries are added to the golden set when they fix a misclassification (golden-set-update). |

---

## 10. What this spec does NOT change (guardrails)

- **The 0.6 literal floor** — frozen. Never a property, never lowered, enforced in BOTH `matchCategorySmart` and `_normalizeAiClassifyResult_`.
- **The longest-keyword-wins + short-keyword-whole-word precision** — unchanged in every stage.
- **The privacy hash in global learn** — raw Hebrew never leaves the tenant.
- **The single append chokepoint + `_resolveIsIncome_`** — every write still goes through it; isolation unchanged.
- **No new auto-write path for AI** — STAGE 3's gated path stays the ONLY one; STAGE 2 auto-writes are user-authored mappings only.
- **No sheet structure change** — this is the classifier pipeline; rows/tabs are [doc 1]'s job, behind the backup→dry-run→apply guard.

---

## 11. Build order (matches BOT_INTELLIGENCE_BUILD_PLAN.md)

1. **PR-3** — durable `cat_profile:<userSub>` store + read API (nothing reads it yet).
2. **PR-4** — insert `_profileCategoryLookup_` as STAGE 2 between keyword and AI; add the durable `needs_review:<userSub>` queue (STAGE 5); preserve the 0.6 gate verbatim.
3. **PR-5** — corrections (STAGE 4 taps + `קטגוריה X` + Review-Inbox assigns) also bump the profile, not just the text cache.

Each lands deployable and revertible; the worst case of any revert is "today's behavior", because the 0.6 gate is never touched.
