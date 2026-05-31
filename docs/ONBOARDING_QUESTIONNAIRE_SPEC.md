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

> Tab-completion answer, never-stuck rule: a stale `survey_state` simply expires after an hour. A user who vanishes mid-survey and returns the next day is treated as a normal user (no zombie state). See §3 for the resume path that *does* fire within the hour.

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

Gender + need live in **Script Properties** (not KV) on purpose: they must survive past the 1-hour survey cache, they are read on *every* expense confirmation (`_addr_`/`_kudosTail_`), and `api/profile.js` whitelists fields and would silently drop a `gender` field. This is the #184 design — keep it.

> **Mirror, don't fork.** Sections B/C also write a copy into `onboarding.B`/`onboarding.C` so the *durable* KV record is self-contained (admin tooling, the `User_Category_Profile` build, and exports read one record). The Script-Property copies remain the hot-path source for tone. On any disagreement, `gender:{digits}`/`need:{digits}` win for the bot's runtime; `onboarding.*` is the audit/export copy.

---

## 3. Resume — what happens when a user abandons and comes back

Two windows:

**Within 1 hour (cache still warm):** `survey_state` is present. The very next inbound message is routed by the existing dispatch order:

1. An **interactive tap** (button/list reply) → `handleInteractiveReply_` → `_surveyHandleInteractive_(fromPhone, picked)`; if the id starts with `sec_` it is consumed by `_onboardingHandleInteractive_`. The picked id is matched to the step regardless of how long the user waited — taps are stateless w.r.t. the pointer.
2. **Free text** while `survey_state ∈ {await_kids_freeform, await_profession_freetext, await_recurring_freeform, await_biz_names}` → `_surveyHandleText_` consumes it for that step, advances, sends the next question.
3. Free text while `survey_state ∈ {q0}` → typed gender is parsed (`בן`/`בת` regex); unrecognised re-asks **once** (does not advance, does not loop forever — the user can also just tap).

**Resume nudge (the gap case):** if `survey_state` is present AND the inbound message is *not* a valid answer for the current step (e.g. user typed "מה?" while we're waiting on a button), the bot **re-sends the current step's question** exactly once (idempotent — re-calling `_surveySend*_` just posts the same interactive message again) instead of silently dropping the message or treating it as an expense. This is the single most important "a child can follow it" guarantee: the question is always back on screen.

**After 1 hour (cache expired):** `survey_state` is gone, but `profile:<phone>` persists. The user's next message is handled as a **normal expense**. We do NOT drag them back into the survey. If they want to finish/redo, the command **`שאלון`** (or `הגדרות מתקדמות`) restarts cleanly at section B — see `_surveyHandleText_` line 5509. Because each completed section already wrote to `profile.onboarding`, a restart that re-answers a section just overwrites that letter; nothing is double-counted.

**Re-entry guard:** the welcome + first survey kickoff are fired **once** via `_onboardSeen_('surveyed', clean)` / `_onboardMark_` (KV-backed, Script-Property fallback). A re-welcome can never re-trigger the survey on a user who is mid-flow.

---

## 4. The sections — exact copy, buttons, ids, storage

> Hebrew is short, warm, second-person, gender-aware where the gender is known. All option titles are ≤20 chars (WhatsApp button cap) / ≤24 chars (list-row cap). Reuse the existing senders: `sendWhatsAppQuickButtons(to, body, [{id,title}])` for ≤3 options, `_surveySendList_(to, body, buttonText, rows, header)` for 4–10 options.

### A — Intro & capabilities (no question)

**Trigger:** first inbound message from an unknown phone → `_maybeSendWelcome_`.
**Send:** the existing welcome card (`_maybeSendWelcome_`, lines 1385–1406). It already lists the capabilities (free-text logging, dates, currency, receipt photo, notes, summary, help) with live examples, the user's sheet link, and the referral link. **No change to the copy.** Immediately after, `_surveyStart_` fires section B.
**Store:** `onboarding.A = { welcomedAt: <ISO> }` (set by `_onboardMark_('surveyed', …)` time; optional — purely informational).

### B — Gender ("so I address you right")

```
state: 'q0'
body:  רגע לפני שמתחילים — אתה או את? ככה אדבר אליך נכון 😊
type:  quick buttons (2)
  { id:'q0_male',   title:'אני בן' }
  { id:'q0_female', title:'אני בת' }
typed fallback: בן|זכר|גבר|בחור|m  → m ;  בת|נקבה|אישה|בחורה|f → f ; else re-ask once
```

**On answer:** `_setGender_(phone, 'm'|'f')`, also write `onboarding.B = { gender }`. Reply a one-liner warm ack (`'מעולה ' + _addr_ + '! 👊'`), then send **C**.

### C — Need (personal / business / both / family / group)

```
state: 'q1'
header: שאלון התאמה אישית
body:   על מה תרצה לעקוב?
button: בחר סוג
type:   interactive list (5 rows)
  { id:'q1_personal', title:'אישי בלבד',     description:'ההוצאות הפרטיות שלך' }
  { id:'q1_business', title:'עסק בלבד',       description:'הכנסות והוצאות עסקיות' }
  { id:'q1_both',     title:'אישי + עסק',      description:'גם פרטי וגם עסקי' }
  { id:'q1_family',   title:'משפחתי',          description:'הוצאות משק הבית' }
  { id:'q1_group',    title:'שותפים/קבוצה',    description:'חלוקת הוצאות בקבוצה' }
```

**Mapping (already in `_SURVEY_TRACKING_` / `_SURVEY_NEED_`):**

| picked | `trackingType` | `need` |
|--------|----------------|--------|
| q1_personal | personal | personal |
| q1_business | business | business |
| q1_both | business | both |
| q1_family | family | personal |
| q1_group | group | personal |

**On answer:** `_profileAPI_('set',{fields:{trackingType}})`; `_setNeed_(phone, need)`; write `onboarding.C = { need, trackingType }`. Then branch:

- `family` or `group` → go to **D** (kids first).
- everything else → skip D; go to **E** (profession). *(Note: today the code goes straight to G/Q2; this spec moves profession up to E so it is always asked before the conditional business block. See §9.)*

### D — Household (kids, pets, car) — only for family/group/both

Three micro-steps, each one tap or one short free-text. All create **real** dashboard rows via `_addCategoryRows_(phone, text)` (idempotent; dedups by label).

**D1 kids:**
```
state: 'await_kids_freeform'
body:  נחמד! 👨‍👩‍👧 יש לך ילדים? אם כן — מה השמות שלהם?
       לדוגמה: דניאל, מיכל, יואב
       אצור לכל ילד שורה משלו בגיליון *מאזן אישי*.
       אם אין — כתוב *דלג*.
input: free text (comma-separated names) | דלג/לא/אין to skip
```
On names → one row per child; on skip → "בסדר, ממשיכים. 👍". Then D2.

**D2 pets:**
```
state: 'await_pets_yesno'
body:  🐶 יש בבית חיית מחמד? (אוסיף שורה למזון/וטרינר)
type:  quick buttons (3)
  { id:'q_pets_dog', title:'כלב' } { id:'q_pets_cat', title:'חתול' } { id:'q_pets_no', title:'אין' }
```
Dog/cat → `_addCategoryRows_(phone,'כלב'|'חתול')`. Then D3.

**D3 car:**
```
state: 'await_car_button'
body:  🚗 יש לך רכב? (אם כן אוסיף שורה לדלק/חניה/אחזקה)
type:  quick buttons (2)
  { id:'q_car_yes', title:'כן' } { id:'q_car_no', title:'אין' }
```
Yes → `_addCategoryRows_(phone,'רכב')`.

**Store (accumulate as you go):** `onboarding.D = { kids:[…], pets:['כלב'|'חתול'…], car:true|false }`. Then go to **E**.

### E — Profession (always)

```
state: 'q4'
header: שאלה אחרונה: המקצוע שלך
body:   מה המקצוע שלך? אתאים את הקטגוריות בגיליון.
button: בחר מקצוע
type:   interactive list, 9 popular + "other" = 10 rows (= WhatsApp cap)
  rows from _KESEFLE_POPULAR_PROFESSIONS_  (id 'q4_<professionId>')
  + { id:'q4_other', title:'אחר / לא ברשימה', description:'נכתוב את המקצוע ביד' }
```

**"other" path:** `state='await_profession_freetext'`; user types; `_matchProfessionFromText_` fuzzy-maps to a `lib/professions.js` id, else saves an ASCII slug so `/api/profile` keeps a record and the LLM-boost path degrades gracefully (no boost, never a mis-boost).

**On answer:** `_profileAPI_('set',{fields:{profession:<id>}})`; write `onboarding.E = { professionId }`. The profession id feeds `getProfessionBoostKeywords(id)` → classifier weighting **[doc 4]** and the contractor gate for F.

**Then branch on need (from C):** if need ∈ {business, both} → **F**; else skip F → **G**.

### F — Businesses (osek type, one-or-many, names) — only for business/both

**F1 osek type** *(today this is the `sec_e_*` step → rename ids to `sec_f_*`, see §9):*
```
state: 'sec_F_await'
body:  איזה סוג עסק? אתאים את הקטגוריות.
type:  quick buttons (3)
  { id:'sec_f_patur',   title:'עוסק פטור' }
  { id:'sec_f_morsheh', title:'עוסק מורשה' }
  { id:'sec_f_company', title:'חברה בע״מ' }
```
→ `osekType ∈ {patur, morsheh, company}`. Then F2.

**F2 one or many businesses (NEW):**
```
state: (set by F1 handler) then 'await_biz_names'
body:  כמה עסקים יש לך? אם יש שמות — כתוב אותם מופרדים בפסיק.
       לדוגמה: צילום אירועים, חנות אונליין
       אם עסק אחד בלי שם — כתוב *אחד* או *דלג*.
input: free text (comma-separated names) | אחד/דלג → single unnamed business
```
Parse: split on comma, trim, drop empties, cap at **5** names (sanity). `multi = names.length > 1`. Each named business becomes a routing key the classifier/sheet can attribute rows to (matches the `business_name` field already in the classify contract — see `_normalizeAiClassifyResult_`). Multi-business names also feed the multi-business sheet sections (see `sheet-multi-business` skill + memory `expenses_maazan_ishi_multibusiness`).

**F3 per-project tracking** *(today the `sec_f_*` yes/no → rename to `sec_f_proj_*`):*
```
state: 'sec_F_proj_await'
body:  לעקוב אחרי רווח לכל פרויקט/לקוח בנפרד?
type:  quick buttons (2)
  { id:'sec_f_proj_yes', title:'כן, לפי פרויקט' }
  { id:'sec_f_proj_no',  title:'לא צריך' }
```
→ `tracksProjects:bool`.

**Store:** `onboarding.F = { osekType, multi, names:[…], tracksProjects }`. Then **G**.

### G — Fixed monthly expenses + website link (always)

Three micro-steps (the existing Q2 → recurring-list → Q3 → budget), ending with the website hand-off.

**G1 has recurring?**
```
state: 'q2'
body:  האם יש לך הוצאות קבועות בכל חודש?
type:  quick buttons (2)  { id:'q2_yes', title:'כן' } { id:'q2_no', title:'לא' }
```
`yes` → `hasRecurring:true`, ask G2. `no` → `hasRecurring:false`, skip to G3.

**G2 recurring list (free text):**
```
state: 'await_recurring_freeform'
prompt: אילו הוצאות קבועות יש לך? (לדוגמה: 2500 שכירות, 400 ארנונה, 99 נטפליקס)
parse:  split on comma → _parseRecurringCommand_ each → POST /api/recurring add
        autoLog inherited from survey_autolog (default true unless G3 already chose remind)
```

**G3 auto-log vs remind:**
```
state: 'q3'
body:  האם הבוט ירשום אוטומטית, או רק יתזכר?
type:  quick buttons (2)
  { id:'q3_auto',   title:'רישום אוטומטי' }
  { id:'q3_remind', title:'תזכורת בלבד' }
```
→ `autoLogPref ∈ {auto, remind}` (also cached in `survey_autolog`).

**G4 budget cap** *(existing `sec_g_*`):*
```
state: 'sec_G_await'
body:  רוצה תקרת תקציב חודשית עם התראה כשמתקרבים?
type:  quick buttons (2)  { id:'sec_g_yes', title:'כן, תזכיר לי' } { id:'sec_g_no', title:'בלי תקציב' }
```
→ `wantsBudget:bool`.

**G5 website hand-off (the link):** sent inside `_surveyFinish_` (lines 5375–5379). Fixed expenses are entered ONCE on the website and auto-post monthly:
```
💡 הוצאות קבועות (שכירות, ארנונה, מנויים) — תזין פעם אחת באתר והן יירשמו לבד בכל חודש:
https://kesefle.com/dashboard#/recurring
```
> Use the canonical `https://kesefle.com/...` link (mobile-safe, working). Do **not** use a relative path or a non-https link in a WhatsApp message.

**Store:** `onboarding.G = { hasRecurring, autoLog, wantsBudget }` (in addition to `profile.hasRecurring`/`profile.autoLogPref`, which the recurring engine reads).

### H — First expense (the hand-off to everyday use)

No buttons. `_surveyFinish_` prints the profile summary, the G5 link, then:
```
ועכשיו <אחי/אחותי> — מה הוצאת היום או השבוע?
שלח לי הוצאה אחת בכל הודעה, לדוגמה: *45 קפה* ☕
```
`survey_state` and `survey_autolog` are cleared (`_surveyClearState_`). The user is now a normal user.
**Store:** when the user's **first real expense row** is written, set `onboarding.H = { firstLogged:true, at:<ISO> }`. This is the only signal that onboarding fully converted (useful for the funnel — see `kesefle-admin-health-check`). It is set by the expense-write path, not the survey, because H = "they actually logged something".

---

## 5. How the answers feed (a) the template pick — **[doc 1]**

At the end of the A–H block, `_onboardingFinishSections_` calls `_onboardingPickPreset_(profile)` → ONE of the 10 ids in `PROFILE_TYPES`, persists it as `profile.profileType`, and seeds that preset's extra rows via `applyTemplatePreset_(preset, phone)` (idempotent add-category-row path — server dedups by label).

**The decision table (PURE, already implemented + unit-tested in `test_onboarding_flow`):**

| Inputs (from A–H) | → preset (`profileType`) | Sheet shape **[doc 1]** |
|---|---|---|
| C=business **and** (profession is a trade **or** F.tracksProjects) | `contractor` | personal + business + projects |
| C=business **and** F.osekType=`patur` (and not a trade) | `freelancer` | personal + business (light) |
| C=business (any other) | `business` | personal + business (full ledger) |
| C∈{family, group} | `family` | personal + kid buckets |
| C=personal **and** H/import wanted | `advanced_imported` | personal + business + historical |
| C=personal **and** profession is self-employed | `mixed` | personal + side-business block |
| otherwise | `basic_personal` | personal only (safe default) |

Source: `_onboardingPickPreset_` (lines 5752–5773), `_TEMPLATE_PRESETS_` (lines 5966–6053), precedence order as documented there. The four finer presets the *current* questions can't yet disambiguate (`couple`, `divorced`, `employee`) are **defined and seedable** but not auto-derived until the questionnaire grows a dedicated signal — see §7 for the proposed additions that would light them up.

> **Contract with [doc 1]:** this questionnaire's only output to the template layer is the single string `profile.profileType ∈ PROFILE_TYPES`, plus the already-seeded extra rows. [doc 1] owns *what each preset materialises*; this doc owns *which preset is chosen*. The shared invariant: the ten ids must stay byte-identical across `PROFILE_TYPES` (`api/profile.js`), `_ONBOARDING_PRESETS_`, `_TEMPLATE_PRESETS_`, and `buildTenantSheetSpec(opts.profile_type)` once [doc 1] wires it.

---

## 6. How the answers feed (b) the per-user category profile — **[doc 4]**

The questionnaire primes three classifier inputs. None of them can *lower* the 0.6 floor (§8).

1. **Profession boost (E):** `profile.profession` → `getProfessionBoostKeywords(id)` (10–20 diagnostic Hebrew/English terms). When the deterministic keyword maps miss and the AI fallback runs, these terms are injected so e.g. a contractor's "בטון 800" lands in construction materials, not שונות. This is a *bias on the prompt*, evaluated **before** the AI call; it raises precision, and the AI's own confidence + the 0.6 floor still gate the write.

2. **Need + template (C, F, preset):** the seeded preset rows (`applyTemplatePreset_`) become the `User_Category_Profile` "active" set (`docs/PERSONALIZED_CATEGORY_PROFILES.md` §4). The classifier prefers a user's *active* categories when scores tie — a business user's "שיווק 850" resolves to the company marketing row, a personal user's doesn't even have it.

3. **Business names (F):** `onboarding.F.names[]` are candidate `business_name` values. When a logged row mentions one, it can be attributed to that business's section (matches the contract field `business_name` in `_normalizeAiClassifyResult_`; routing per `sheet-multi-business`).

**Pipeline position (the [doc 4] order):**
```
deterministic (CATEGORY_MAP / learned / auto-synonym / global-learn)
   → profile (active categories + profession boost from THIS questionnaire)
   → AI (matchCategorySmart → _aiCategorizeRich → _normalizeAiClassifyResult_)
   → ask the user           (should_ask_user=true)
   → needs_review bucket    (conf < 0.6 OR ambiguous category)
```
The questionnaire feeds the **profile** stage. It never short-circuits the AI/ask/needs_review stages.

---

## 7. Proposed (future) questions that unlock the unused presets

Not in scope to *build* here, but called out so the contract is complete. Each is one extra tap, slotted without reordering A–H:

- **C-followup for personal users → couple vs single:** after C=personal, a 2-button "לבד / זוג" → `onboarding.C.household='couple'` lights `couple`.
- **C-followup → divorced/single-parent:** add a row "הורה גרוש/ה" to C's list → `divorced`.
- **E-followup → employee vs self-employed already inferred:** a salaried profession on a personal tracker today yields `mixed`; an explicit "שכיר/ה בלבד, בלי עסק צד" tap would yield `employee`.

When added, update the decision table in §5 and `_onboardingPickPreset_` together (same PR), and add a `test_onboarding_flow` case per new branch.

---

## 8. Safety invariant — onboarding can only make the bot MORE careful

This is the non-negotiable from #271. Spelled out so no future edit erodes it:

- **The 0.6 floor is absolute.** `_aiAskFloor_()` returns `0.6`; `_normalizeAiClassifyResult_` sets `should_ask_user = isAmbiguous || conf < max(0.6, envThreshold)`. Onboarding answers are inputs to the *prompt/profile*, never to the *threshold*. There is no questionnaire answer — not profession, not template, not business name — that may pass a number into the ask-threshold computation.
- **A confident-looking profession must not fabricate confidence.** Profession boost changes *which category the model is nudged toward*, not the model's reported `confidence`. A contractor's ambiguous "תשלום 500" still returns low confidence → asks the user.
- **Unknown profession degrades to no-boost, never mis-boost.** The "other" free-text path saves a slug with no keyword set; the boost is empty; classification proceeds exactly as for a user with no profession.
- **Seeding is idempotent and additive only.** `applyTemplatePreset_` only *adds* category rows (dedup by label); it never edits or deletes a user's existing rows or values. This honours the standing "never overwrite user-typed values" rule (memory `feedback_never_overwrite`).
- **Onboarding never wedges.** Every persistence call (`_onboardingStoreSection_`, `_profileAPI_`, seeding) is best-effort and swallowed on error so a transient KV/network blip can't trap a user in the survey. A failed store just means that section re-asks on the next `שאלון`.

---

## 9. Concrete build delta (for the implementation PR that follows this doc)

This doc is the target. The minimal, reversible code change to reach it (each line below is the actual symbol to touch in `bot/ExpenseBot_FIXED.gs`):

1. **Move profession (E) ahead of the business block.** In `_surveyHandleInteractive_`, after C (tracking) resolves for a **non-family** user, call `_surveySendQ4_` instead of `_surveySendQ2_`; after Q4 resolves, call `_onboardingStartSections_`. (Family/group already detours through D, then should also land on E.)
2. **Rename the osek step ids E→F.** `_onboardingSendSection_('E', …)` button ids `sec_e_patur|morsheh|company` → `sec_f_patur|morsheh|company`; storage letter stays a real letter but the *user* section is F. Update `_onboardingHandleInteractive_` branches to match. Rename the project step `sec_f_yes|no` → `sec_f_proj_yes|no` to free the `sec_f_*` namespace for osek.
3. **Add F2 business-names step.** New state `await_biz_names`, new branch in `_surveyHandleText_` that parses comma names (cap 5), stores `onboarding.F.names`, sets `multi`, then continues to F3 (project tracking).
4. **Write the mirror copies.** In the B and C handlers, also `_onboardingStoreSection_(phone,'B',{gender})` / `'C',{need,trackingType}`. In D steps accumulate `onboarding.D`. In E `'E',{professionId}`.
5. **Set H on first real expense.** In the expense-write success path, if `onboarding.H` is unset, set `{firstLogged:true,at}` (one KV write, guarded so it runs once).
6. **Tests:** extend `test_onboarding_flow` to replay B→C→(D)→E→(F)→G→H for: personal-single, family-with-kids, osek-patur-freelancer, contractor, multi-business. Assert the resulting `profileType` matches §5 and that `applyTemplatePreset_` seeded the expected rows.
7. **Regenerate `ExpenseBot_DEPLOY.gs`** from `ExpenseBot_FIXED.gs` (skill `bot-deploy-paste`) and bump `KFL_BUILD_VERSION` (skill `bot-version-bump`).

No change to `api/profile.js` is required — its `onboarding:{A..H}` merge + `PROFILE_TYPES` already accept everything above.

---

## 10. Worked example (the "a child can follow it" walkthrough)

New user texts "היי":

```
A  bot:  [welcome card with capabilities + sheet link + referral]
B  bot:  רגע לפני שמתחילים — אתה או את?        user: [tap] אני בת
        → gender:f ; onboarding.B={gender:'f'} ; "מעולה אחותי! 👊"
C  bot:  על מה תרצה לעקוב?                      user: [tap] עסק בלבד
        → trackingType=business ; need=business ; onboarding.C={need:'business',trackingType:'business'}
E  bot:  מה המקצוע שלך?                         user: [tap] מספרה / קוסמטיקה
        → profession='hairstylist' ; onboarding.E={professionId:'hairstylist'}
F1 bot:  איזה סוג עסק?                          user: [tap] עוסק פטור
F2 bot:  כמה עסקים יש לך? ...                   user: דלג
        → onboarding.F={osekType:'patur',multi:false,names:[],...}
F3 bot:  לעקוב אחרי רווח לכל פרויקט?            user: [tap] לא צריך
        → tracksProjects:false
G1 bot:  הוצאות קבועות בכל חודש?                user: [tap] כן
G2 bot:  אילו? ...                              user: 99 חומרים, 200 שכירות עמדה
        → 2 recurring items added
G3 bot:  אוטומטי או תזכורת?                     user: [tap] רישום אוטומטי
G4 bot:  תקרת תקציב חודשית?                     user: [tap] בלי תקציב
finish:  → preset = freelancer (business + osek=patur + not a trade)
         → applyTemplatePreset_('freelancer', phone) seeds: הכנסה מעסק, עלות שיווק,
           תוכנות ומנויים, ציוד עסקי, יועצים ושירותים
         bot:  ✅ סיימנו אחותי! זה הפרופיל שלך: ...
         G5 bot:  💡 הוצאות קבועות — תזין באתר: https://kesefle.com/dashboard#/recurring
         H  bot:  ועכשיו אחותי — מה הוצאת היום? ... *45 קפה* ☕
                                               user: 250 צבע לשיער
        → first real expense; onboarding.H={firstLogged:true}; survey_state cleared.
```

If the user vanishes after C and returns 20 minutes later by typing "?", the bot re-sends section E's profession picker (resume nudge, §3) rather than treating "?" as an expense. If they return the next day, "?" is handled normally and `שאלון` restarts the questionnaire at B.
