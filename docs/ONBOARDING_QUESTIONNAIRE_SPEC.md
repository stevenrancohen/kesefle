# Onboarding Questionnaire Spec (sections A–H)

**Status:** Design. DOCS ONLY — no code in this PR.
**Epic:** #271 — smarter, personalized bot.
**Owns:** the WhatsApp interactive-button questionnaire a new user walks through right after the welcome message.
**Builds on (already shipped, do NOT re-invent):**

- The live survey state machine in `bot/ExpenseBot_FIXED.gs` — `_surveyStart_`, `_surveySendQ0_`…`_surveySendQ4_`, `_surveyHandleInteractive_`, `_surveyHandleText_`, `_surveyFinish_`.
- The #184 gender + need work — `_setGender_`/`_getGender_`, `_setNeed_`/`_getNeed_`, `_addr_`, `_kudosTail_`.
- The A–H section block — `_onboardingSectionPlan_`, `_onboardingNextSection_`, `_onboardingPickPreset_`, `_onboardingStoreSection_`, `_onboardingSendSection_`, `_onboardingHandleInteractive_`, `_onboardingFinishSections_`.
- The profile store — `api/profile.js` (`profile:<phone>` KV; `onboarding:{A..H}`; `PROFILE_TYPES`; `ONBOARDING_SECTIONS`).
- The 10 template presets — `_TEMPLATE_PRESETS_` + `applyTemplatePreset_` in the bot, mirrored by `PROFILE_TYPES` in `api/profile.js`.
- The classifier feed — `matchCategorySmart`, `getProfessionBoostKeywords`, the never-corrupt **0.6** floor (`_aiAskFloor_`, `_normalizeAiClassifyResult_`).

**Companion docs:**

- Doc 1 — *Adaptive Sheet Templates* (the 10 presets, `lib/category-presets.js`, the `applyTemplatePreset_` → sheet feed). Referenced here as **[doc 1]**.
- Doc 4 — *AI-Classifier Fallback Pipeline* (deterministic → profile → AI → ask → needs_review). Referenced here as **[doc 4]**.
- `docs/PERSONALIZED_CATEGORY_PROFILES.md` §7 (presets), §4 (`User_Category_Profile`).

---

## 0. The one-paragraph summary (read this first)

A new WhatsApp user gets a short, **tappable** questionnaire — eight sections, **A→H**, mostly one button-tap each. It is **DEAD SIMPLE**: the user almost never types; they tap. Every answer is stored in ONE place per user (`profile:<phone>` in KV, under `onboarding.{A..H}`), plus two tiny bot-local flags for gender and need. When the user finishes (or abandons and comes back), we (a) pick ONE of the 10 sheet templates **[doc 1]** and seed its extra rows, and (b) prime the per-user category profile so the classifier **[doc 4]** is smarter for this exact person from message #1. If the user walks away mid-way, the next message they send picks up exactly where they left off, because the step is remembered for an hour.

**Hard rule preserved end-to-end:** nothing the questionnaire collects is ever allowed to make the bot *silently* write a wrong financial row. Onboarding only ever *raises* classifier caution (profession hints, business names) — it can never lower the 0.6 floor. See §8.

---

## 1. Section map — the human flow vs. the storage keys

The user experiences **eight sections A→H** (this doc's contract). The code already stores answers under the same eight section letters in `profile.onboarding`, but historically the *conditional* block (`_onboarding*`) only materialised letters E–H, because A–D were collected by the older Q0–Q4 survey. **This spec makes all eight explicit and gives each a stable storage key**, so the questionnaire is one coherent A→H thing instead of "Q0–Q4 plus E–H".

| Sec | Question (what the user feels) | Asked? | Existing collector today | Stored at | Drives |
|-----|--------------------------------|--------|--------------------------|-----------|--------|
| **A** | Intro + capabilities (no question — a card + "let's go") | Always | `_maybeSendWelcome_` text | `onboarding.A = {welcomedAt}` | — (sets expectations) |
| **B** | Gender — "אתה או את?" | Always | `_surveySendQ0_` (`q0_*`) | `gender:{digits}` (Script Prop) **+** `onboarding.B = {gender}` | `_addr_`, `_kudosTail_` (gendered tone) |
| **C** | Need — personal / business / both | Always | `_surveySendQ1_` (`q1_*`) | `need:{digits}` (Script Prop) **+** `profile.trackingType` **+** `onboarding.C = {need, trackingType}` | template gate, tab provisioning |
| **D** | Household — kids' names, pets, car | If C∈{family, group, both} else skipped | `await_kids_freeform` → pets → car | `onboarding.D = {kids:[…], pets:[…], car:bool}` | per-kid/pet/car rows (real rows) |
| **E** | Profession — "מה המקצוע שלך?" | Always | `_surveySendQ4_` (`q4_*`) | `profile.profession` **+** `onboarding.E = {professionId}` | classifier boost keywords, contractor gate |
| **F** | Businesses — one or many, their names | If C∈{business, both} else skipped | (NEW — extends `sec_*`) | `onboarding.F = {osekType, multi:bool, names:[…], tracksProjects:bool}` | business/contractor preset, business-name routing |
| **G** | Fixed monthly expenses prompt + website link | Always | `_surveySendQ2_`/`Q3` + `_surveyFinish_` link | `profile.hasRecurring`, `profile.autoLogPref`, `onboarding.G = {hasRecurring, autoLog, wantsBudget}` | recurring engine, budget alerts |
| **H** | First expense — "מה הוצאת היום?" | Always | `_surveyFinish_` hand-off line | `onboarding.H = {firstLogged:bool}` (set when the first real row is written) | hands control to everyday logging |

> **Implementation note for the builder (not the user):** the *internal* section gates that already exist (`_onboardingSectionPlan_` returns E/F/G/H conditionally) stay valid. This doc renumbers the **user-facing** questionnaire so B=gender, C=need, D=household, E=profession, F=businesses, G=fixed, H=first-expense. When the eventual code change lands, the existing `sec_e_*`/`sec_f_*` osek + project taps move under **F** (businesses), and a new always-on profession step becomes **E**. Until then, the questionnaire still *works* — this doc is the target shape, and §9 lists the exact rename.

---

## 2. State machine — the ONE source of "where is this user?"

There are **three** persisted things. Keep them separate; they have different lifetimes on purpose.

### 2.1 Step pointer (short-lived, self-cleaning)

```
KEY:   survey_state:{digits}          // digits = phone, [^0-9] stripped
STORE: CacheService.getScriptCache()  // Apps Script script cache
TTL:   _SURVEY_TTL_SEC_ = 3600        // 1 hour
VALUE: one of the STEP strings below (a plain string, not JSON)
```

STEP strings (current + the two this spec adds):

```
'q0'                     B  gender (await tap/typed בן|בת)
'q1'                     C  need/tracking (await tap)
'await_kids_freeform'    D  kids names (await free text or דלג)
'await_pets_yesno'       D  pets (await tap)
'await_car_button'       D  car (await tap)
'q4'                     E  profession picker (await tap)
'await_profession_freetext'  E  typed profession (await free text)
'sec_F_await'            F  business: osek type (await tap)        [today: 'sec_E_await']
'await_biz_names'        F  business names (await free text)        [NEW]
'sec_F_proj_await'       F  per-project tracking (await tap)        [today: 'sec_F_await']
'q2'                     G  has recurring? (await tap)
'await_recurring_freeform'  G  recurring list (await free text)
'q3'                     G  auto-log vs remind (await tap)
'sec_G_await'            G  monthly budget cap (await tap)
'sec_H_await'            H  (legacy import question — folds into [doc 1] migration)
```

There is **no explicit step** for A (intro) or for the final H (first expense) — A is fire-and-forget, and H is "the survey is over, normal message handling resumes". When `survey_state` is **absent**, the user is NOT in onboarding; their next message is a normal expense.

> Never-stuck rule: a stale `survey_state` simply expires after an hour. A user who vanishes mid-survey and returns the next day is treated as a normal user (no zombie state). See §3 for the resume path that *does* fire within the hour.

### 2.2 Auto-log preference carry (short-lived)

```
KEY:   survey_autolog:{digits}
STORE: CacheService script cache, TTL 3600
VALUE: 'auto' | 'remind'   (so recurring items typed in G inherit the choice)
```

### 2.3 Durable answers (long-lived — the real record)

```
KEY:   profile:<phone>                // <phone> = E.164 digits, normalized by api/profile.js
STORE: Upstash KV (via POST /api/profile { action:'set', fields:{ onboarding:{...} } })
SHAPE: { trackingType, hasRecurring, autoLogPref, profession, profileType,
         onboarding:{ A?,B?,C?,D?,E?,F?,G?,H? }, updatedAt, ... }
```

`onboarding` is **merged** server-side (read-modify-write) and each section value is bounded (≤12 primitive fields, strings ≤200 chars) — see `api/profile.js` lines 176–205. The bot ALWAYS read-modify-writes the whole `onboarding` object via `_onboardingStoreSection_` so it never clobbers an earlier section.

```
KEY:   gender:{digits}   VALUE: 'm' | 'f'                  Script Properties (persists past the 1h cache)
KEY:   need:{digits}     VALUE: 'personal'|'business'|'both' Script Properties
```

Gender + need live in **Script Properties** (not KV) on purpose: they must survive past the 1-hour survey cache, they are read on *every* expense confirmation (`_addr_`/`_kudosTail_`), and `api/profile.js` whitelists fields — these two are bot-local presentation state, not financial data, so they stay on the bot side and are *mirrored* into `onboarding.B/.C` for the profile record. The KV copy is the durable truth; the Script Property is the hot cache the reply path reads without a network hop.

---

## 3. Resume + abandon — the "never stuck, never nags" behavior

Two timelines, both already partly implemented; this spec makes the contract explicit.

**Within the hour (warm resume):** user answers B and C, then goes quiet for 20 minutes, then sends a message. `survey_state` is still `'q1'`-after-or-whatever-step. The router sees a live `survey_state`, so it does NOT treat the message as an expense — it re-sends the CURRENT step's prompt (idempotent re-ask, not advance). A user can therefore put the phone down mid-survey and pick up where they left off just by texting anything.

**After the hour (cold return):** `survey_state` has expired. The user's next message is treated as a normal expense (because durable `onboarding` already has A–C, the welcome is not re-sent — `welcomed:{digits}` flag, #186). We do NOT restart the questionnaire from scratch and we do NOT block their expense. Instead: the expense is logged, and a single soft nudge ("רוצה שנשלים את ההגדרות? זה לוקח דקה") is offered **once** (guarded by a `nudged:{digits}` flag so it never repeats). If they tap yes, we resume at `_onboardingNextSection_(profile)` — the next UNANSWERED section computed from the durable record, never re-asking A–C.

**Hard guarantees:**
- The questionnaire never blocks a real expense after the warm window.
- No section is ever asked twice (durable `onboarding.{letter}` presence is the guard).
- No nag loop (`nudged:` is one-shot).

---

## 4. Per-section spec

Every section below gives: the exact user-facing copy intent (Hebrew tone per bot-reply-style — short, warm, gendered via `_addr_`), the interactive payload, the stored shape, and the skip rule. **All Hebrew is authored in the `.gs` file, not pasted from chat** (memory: chat-paste corrupts Hebrew with bidi marks) — this doc describes intent in ASCII.

### A — Intro card (always, no question)

- Trigger: first inbound message from an unknown phone, after `_maybeSendWelcome_`.
- Content: one short card — what the bot does ("שלח לי הוצאה ואני ארשום אותה"), one example, and a "יאללה נתחיל" button that fires B.
- Stored: `onboarding.A = { welcomedAt: <iso> }`. Sets `welcomed:{digits}` so it never re-sends.
- Skip: never (but only once per phone).

### B — Gender (always, one tap)

- Buttons: `אתה` (m) / `את` (f). Also accept typed `בן`/`בת`/`גבר`/`אישה`.
- Stored: `gender:{digits}` Script Prop **and** `onboarding.B = { gender:'m'|'f' }`.
- Why first: every later reply is gendered, so we need it before any kudos line.
- Skip: never.

### C — Need (always, one tap)

- Buttons: `אישי` (personal) / `עסקי` (business) / `שניהם` (both).
- Stored: `need:{digits}` Script Prop, `profile.trackingType`, `onboarding.C = { need, trackingType }`.
- This is the **master gate**: it decides whether D (household) and F (businesses) are asked, and seeds the template family **[doc 1]**.
- Skip: never.

### D — Household (asked only if it can produce real rows)

- Asked when C ∈ {personal, both} AND the user is likely a household (we ask; cheap). Three micro-steps, each one tap or a short free-text:
  1. Kids: "יש ילדים? כתוב שמות מופרדים בפסיק, או דלג" → free text → `kids:['…','…']` (each name becomes a real per-kid row candidate in the family/divorced template). `דלג` → `kids:[]`.
  2. Pets: `כן`/`לא` → `pets:true|false`.
  3. Car: `כן`/`לא` → `car:true|false`.
- Stored: `onboarding.D = { kids:[…], pets:bool, car:bool }`.
- Drives: family/divorced preset rows; `has_car`/`has_pets`/`has_kids` Settings flags that gate template rows **[doc 1 §6]**.
- Skip: when C === business only.

### E — Profession (always, one tap or type)

- A short button list of the top professions (from `lib/professions.js` ranked), + a "אחר — כתוב" escape to `await_profession_freetext`.
- Stored: `profile.profession`, `onboarding.E = { professionId }`.
- Drives: `getProfessionBoostKeywords` (classifier accuracy for this person), the contractor/inventory branch of the template selector, and profession VAT defaults.
- Skip: never (profession sharpens classification even for personal-only users — e.g. a nurse's "משמרת" is income, not an expense).

### F — Businesses (asked only if C ∈ {business, both})

- Steps:
  1. Osek type: `עוסק פטור` / `עוסק מורשה` / `חברה בע"מ` / `קבלן` → `osekType`.
  2. How many: `עסק אחד` / `כמה עסקים` → `multi:false|true`.
  3. Names: "כתוב שמות העסקים מופרדים בפסיק" → `names:['…']` (these become business-tab titles **[doc 1 §F]** AND business-name routing keys so "קניתי במנדי" can resolve to the right business).
  4. Projects: `כן עוקב לפי פרויקטים` / `לא` → `tracksProjects` (gates the contractor `projects` tab).
- Stored: `onboarding.F = { osekType, multi, names:[…], tracksProjects }`.
- Skip: when C === personal.

### G — Fixed monthly + preferences (always)

- Steps:
  1. Has recurring? `כן יש לי הוצאות קבועות` / `לא` → `hasRecurring`.
  2. (if yes) list them free-text → seeds the recurring engine; each item inherits the auto-log choice from `survey_autolog`.
  3. Auto-log vs remind: `תרשום אוטומטית` / `רק תזכיר לי` → `autoLog`, also written to `survey_autolog:{digits}`.
  4. Budget cap: `כן רוצה תקציב חודשי` / `לא צריך` → `wantsBudget`.
  5. Website link: the `_surveyFinish_` line pointing to the web account, so they can refine on the dashboard.
- Stored: `profile.hasRecurring`, `profile.autoLogPref`, `onboarding.G = { hasRecurring, autoLog, wantsBudget }`.
- Skip: never.

### H — First expense (always, the graduation)

- No question. A single hand-off line: "מעולה, הכל מוכן. מה הוצאת היום?" — and the survey ends (`survey_state` cleared).
- The NEXT message is processed as a normal expense by the full pipeline **[doc 4]**.
- `onboarding.H = { firstLogged:true }` is set the moment that first real row is written (so analytics can measure activation), not when H's prompt is sent.
- Skip: never.

---

## 5. The finish step — template + profile priming

When the last required section is answered, `_onboardingFinishSections_` does exactly two things, in this order, both idempotent:

1. **Pick + apply a template [doc 1].** `_onboardingPickPreset_(profile)` maps the durable `onboarding` record to ONE of the 10 `PROFILE_TYPES` (the same decision tree relocated to `templateIdFromOnboarding` in [doc 1 §8]). `applyTemplatePreset_` then seeds that preset's extra rows via `_addCategoryRows_` — already idempotent, so re-running on resume cannot double-seed.
2. **Prime the per-user category profile [doc 4 STAGE 2].** Seed `cat_profile:{userSub}` (the durable per-user category store) from: the chosen template's rows, the profession's boost subs, the kids'/pets'/businesses' names as activated categories. This is what makes the classifier personalized from message #1 — a `family` user's bare "חוג" resolves toward `ילדים/חוגים` because onboarding activated it.

Neither step writes a transaction. Neither step can be reached twice (the durable `surveyed:{digits}` flag + idempotent seeders).

---

## 6. Routing — where the questionnaire intercepts an inbound message

The dispatch order in the bot's message handler (existing, made explicit here):

```
inbound message →
  1. echo/loop defense (_BOT_ECHO_REGEXES_)                 [unchanged]
  2. if survey_state:{digits} present  → survey/onboarding handler  [INTERCEPT]
       - interactive reply → _surveyHandleInteractive_ / _onboardingHandleInteractive_
       - free text        → _surveyHandleText_ (kids/biz-names/recurring/profession)
       - re-send current step on any other text (warm resume, §3)
  3. else if unknown phone → _maybeSendWelcome_ → start at A
  4. else → normal expense pipeline [doc 4]
```

The intercept at step 2 is the ONLY thing the questionnaire adds to the hot path. When there is no `survey_state`, the cost is a single cache miss and the message flows straight to [doc 4].

---

## 7. Interactive payload conventions (so taps round-trip safely)

- Every button/list-row `id` is **ASCII** (`q0_m`, `q1_business`, `sec_F_osek_morsheh`, …). Never put Hebrew in an interactive `id` — Hebrew lives only in the `title` the user sees. This avoids the bidi-in-id corruption class entirely.
- The handler switches on the ASCII `id`, never on the visible Hebrew title (titles can change with copy edits; ids are stable).
- Free-text steps (`await_*`) accept a typed answer AND a `דלג`/skip button so a user who hates typing is never trapped.
- List sections (profession picker) cap at WhatsApp's row limit; overflow goes to the "אחר — כתוב" free-text escape.

---

## 8. Safety: onboarding can sharpen, never silently corrupt

This is the load-bearing invariant (Steven: "never overwrite / never silently wrong").

- Onboarding answers feed the classifier as **bias/boost only**: profession boost keywords, business-name routing hints, activated categories. They are inputs to STAGE 2 (profile) in [doc 4], consulted *before* the AI but *after* deterministic keyword matching.
- **They can only RAISE caution.** Nothing collected here is allowed to lower the **0.6** ask floor (`_aiAskFloor_` returns a literal `0.6`; the effective threshold is `max(0.6, env)` — [doc 4 §0]). A profession hint that makes the bot *more* sure still must clear 0.6 to auto-write; otherwise it asks. A hint can make the bot ask MORE, never auto-write below the bar.
- Business names captured in F are **routing aids**, not auto-writers: "קניתי במנדי 200" with "מנדי" a known supplier still goes through the normal confidence gate; if ambiguous, it asks which business.
- No onboarding answer ever triggers a sheet write to `תנועות`. The only writes onboarding causes are: idempotent **category-row** seeding (template) and **profile** seeding — both structure, never a transaction.

A test (mirrors [doc 4] T-FLOOR) must assert: with a fully-primed business profile, a low-confidence message still routes to ASK, not WRITE.

---

## 9. The exact rename when code lands (so this doc maps to a real diff)

This is DOCS ONLY; when the implementing PR lands (per pr-incremental-plan, ≤300 LOC, bot re-paste required), it makes these precise changes — no behavior is removed, two questions are added:

1. **Add an always-on profession step as E.** New `_surveySendProfession_` + `q4`/`await_profession_freetext` handling, stored to `onboarding.E`. (The bot already has profession plumbing for boost keywords; this surfaces it in the questionnaire.)
2. **Rename the osek/project steps to F.** `'sec_E_await'` → `'sec_F_await'` (osek type), add `'await_biz_names'` (business names free-text, NEW), `'sec_F_await'` → `'sec_F_proj_await'` (projects). Update `_onboardingHandleInteractive_` id switch accordingly.
3. **Make all eight `onboarding.{A..H}` writes explicit** in `_onboardingStoreSection_`, so A–D are persisted to KV (today A–D live mostly in Script Properties). Gender/need stay ALSO in Script Properties as the hot cache (§2.3).
4. **One-shot resume nudge** (`nudged:{digits}`) for cold returns (§3).
5. **Finish step** calls both the template apply AND the profile prime (§5).

Each is additive and revertible; skipping the new steps leaves the existing flow working, so the PR can ship behind the existing survey without a flag.

---

## 10. Tests

New `bot/test_onboarding.js` (Node, real source via balanced-brace extraction, no mock framework — test-add-suite + test-mock-kv for the profile calls):

1. **T-LINEAR** — a personal-only user taps A→B(f)→C(personal)→D(no kids)→E(prof)→G→H and ends with exactly the `basic_personal`/`family` preset and a primed profile; no business steps asked.
2. **T-BUSINESS** — C(business) skips D, asks F, captures two business names, lands `mixed` or `business` per [doc 1 §8].
3. **T-RESUME-WARM** — set `survey_state` mid-flow, send arbitrary text, assert the SAME step re-sends (no advance, no expense write).
4. **T-RESUME-COLD** — expire `survey_state`, send an expense, assert it logs AND the one-shot nudge fires exactly once (second message: no nudge).
5. **T-NO-DOUBLE-ASK** — pre-seed `onboarding.A..C`, run `_onboardingNextSection_`, assert it returns D/E (next unanswered), never A–C.
6. **T-IDS-ASCII** — every interactive `id` emitted is ASCII-only (no Hebrew in ids).
7. **T-HEBREW-CLEAN** — every Hebrew title passes test-hebrew-text (no bidi corruption, correct brand spelling).
8. **T-SAFETY-FLOOR** — with a fully primed business profile, a deliberately ambiguous message routes to ASK, not WRITE (the §8 invariant).
9. **T-MERGE-PROFILE** — storing section F does not clobber section C (read-modify-write of `onboarding` preserves earlier letters).

All pass with mocked KV; none touch a live sheet or a real number.

---

## 11. Open questions for Steven

1. **D scope.** Ask household (D) for `both` users too, or only `personal`/`family`? (Default in §4: ask for personal+both, skip for business-only.)
2. **E placement.** Profession before or after need? This doc puts need (C) first because it gates the most; profession (E) after household. Acceptable?
3. **F project step.** Always ask "track by projects?", or only when osekType === קבלן? (Default: ask only for קבלן + חברה.)
4. **Nudge copy + cap.** One soft nudge on cold return — is one enough, or also a day-3 follow-up? (Default: strictly one, `nudged:` guarded.)

None block the docs; they finalize copy + skip rules before the implementing PR.
