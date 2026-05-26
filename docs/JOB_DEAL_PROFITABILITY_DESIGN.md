# Job / Deal Profitability — design doc

**Status:** design only. **Zero code in this doc.** Awaiting Steven's approval before any PR is opened.
**Author:** me, 2026-05-26.

---

## A. Current bot limitation

The bot today treats every WhatsApp message as a **single isolated transaction**:

```
"עסק הכנסה 10,000"  →  one row, cat=עסק, amount=+10000, no link
"עסק הוצאה עובד 2,500"  →  one row, cat=עסק, amount=-2500, no link
```

**What's missing:**

1. **No "job" entity.** There's no concept of *the kitchen-remodel-for-Yossi* that groups one revenue row + several cost rows.
2. **No profitability per job.** `מאזן חברה` aggregates monthly per category, not per project.
3. **No follow-up parsing.** Each message is parsed in isolation — "הוסף עוד 700 חומרים לעבודה של יוסי" has no addressable target.
4. **No structured multi-line input.** A single message with revenue + 3 costs gets split incorrectly or rejected.
5. **No profitability Q&A.** "כמה הרווחתי בעסקה של יוסי?" → bot doesn't know.
6. **Personal/business ambiguity is silent.** When a contractor writes `2500 עובדים`, the bot guesses personal-vs-business instead of asking.

**This is a real product gap for the contractor segment** (קבלן, שיפוצניק, פרילנסר עם פרויקטים). They can't answer "was this job worth it?" with Kesefle today.

---

## B. Proposed Job/Deal data model

### KV record
```
key: job:{userSub}:{jobId}
ttl: none
value: {
  jobId:           string  // 12-char nanoid, e.g. "j_a8f3k9p2m1q4"
  userSub:         string
  businessId:      string  // matches the bot's active business tab (PR #35)
  jobName:         string  // "שיפוץ אמבטיה אצל יוסי" — free text
  clientName:      string | null  // "יוסי" — optional, parsed from jobName when possible
  status:          'open' | 'closed'
  createdAt:       ISO
  updatedAt:       ISO
  closedAt:        ISO | null
  // Aggregates updated atomically on every linked-transaction write:
  revenueTotal:    number
  costTotal:       number
  costByType: {
    labor:         number   // עובדים / שכר עבודה
    materials:     number   // חומרים / חומרי גלם
    subcontractor: number   // קבלן משנה
    fuel:          number   // דלק
    equipment:     number   // ציוד / כלים
    shipping:      number   // משלוחים / הובלה
    other:         number
  }
  profit:          number   // revenueTotal - costTotal
  profitMargin:    number   // (profit / revenueTotal) * 100, 0 if revenue=0
  transactionIds:  string[] // pointer back to rows in the sheet (column J)
}
```

### Active-job KV (one per user)
```
key: active_job:{userSub}
value: { jobId: string, setAt: ISO }
ttl: 6h  // auto-clears so users don't accidentally tag tomorrow's coffee to last week's job
```

When set, expenses without explicit job context auto-attach to this job. Cleared by `סגור עבודה` command or 6h timeout.

### Index for fast lookup
```
key: job_index:{userSub}
value: [{ jobId, jobName, status, clientName, profit }, ...]  // for quick "רשימת עבודות"
```

---

## C. Proposed sheet changes

**Decision: hybrid — extend existing schema + new Jobs tab.**

Going with both safety options instead of choosing one, because each does something the other can't.

### C1. Extend transaction schema (תנועות + per-biz tabs)

**Add 2 new columns to the existing 9-column TX schema:**

| Col | Existing | After |
|-----|----------|-------|
| A | תאריך | תאריך |
| B | חודש | חודש |
| C | סכום | סכום |
| D | קטגוריה | קטגוריה |
| E | תת-קטגוריה | תת-קטגוריה |
| F | פירוט | פירוט |
| G | מקור | מקור |
| H | סטטוס (הוצאה?) | סטטוס |
| I | ניכוי מע״מ | ניכוי מע״מ |
| **J** | — | **job_id** (empty if not job-linked) |
| **K** | — | **cost_type** (labor / materials / subcontractor / fuel / equipment / shipping / other / blank for revenue rows) |

**Why backwards-compatible:** existing 9-col writes still work; new code reads col J/K when present, treats blank as "general business / not job-linked". No existing user breaks.

### C2. New tab: עבודות (Jobs)

One row per job. Auto-maintained by the bot — users don't edit this directly (it's a denormalized cache of KV aggregates for human readability in the sheet).

| Col | Header | Example |
|-----|--------|---------|
| A | job_id | j_a8f3k9p2m1q4 |
| B | שם עבודה | שיפוץ אמבטיה אצל יוסי |
| C | לקוח | יוסי |
| D | סטטוס | פתוחה |
| E | מחזור | 10,000 |
| F | עובדים | 2,500 |
| G | חומרים | 1,200 |
| H | קבלן משנה | 0 |
| I | דלק | 300 |
| J | ציוד | 0 |
| K | משלוחים | 0 |
| L | אחר | 0 |
| M | סה״כ עלות | 4,000 |
| N | רווח נטו | 6,000 |
| O | רווחיות | 60% |
| P | תאריך פתיחה | 2026-05-26 |
| Q | תאריך עדכון | 2026-05-26 |

The Jobs tab gets one bucket-summary row per job + a sticky header. Users can sort/filter natively in Sheets. The רווח and רווחיות columns recompute on every transaction write.

### C3. New tab: סיכום עבודות לפי לקוח (optional, PR-5)

Pivot view: revenue/profit by client across all jobs. Useful for "מי הלקוח הכי רווחי שלי".

---

## D. Proposed conversation flow

### D1. Detection logic (priority order)

1. **Explicit job command** (`פתח עבודה חדשה X`, `סגור עבודה`, `הוסף לעבודה Y`) → handled deterministically
2. **Active job in KV** (`active_job:{userSub}` exists) → tag transaction to that job automatically, confirm in reply
3. **Job inferred from text** (regex matches `לעבודה של <X>`, `לעסקה של <X>`, `לפרויקט <X>`) → tag if exact match in user's open jobs; otherwise ask
4. **Business prefix + structured one-shot** (`עסקה: <name> הכנסה X עובדים Y חומרים Z`) → parse fully, create job, write all rows
5. **Business prefix without job context** (`עסק הכנסה 10000`) → ask the disambiguation question
6. **Personal/business ambiguity** (user has both profiles, message has none of the above signals) → ask

### D2. Disambiguation prompts (Hebrew, with interactive buttons)

**When business + no job context:**
```
מצאתי שמדובר בעסק, אבל חסר לי לאיזו עבודה לשייך את זה.

[פתח עבודה חדשה]
[בחר עבודה קיימת]
[שמור כהוצאה כללית לעסק]
```

**When personal/business ambiguous:**
```
יש לך מעקב אישי וגם עסקי. לאן לשייך את הפעולה?

[אישי]
[עסק כללי]
[עבודה ספציפית]
```

**When "בחר עבודה קיימת" tapped:**
```
לאיזו עבודה?

1. שיפוץ אמבטיה אצל יוסי (פתוחה, רווח: 6,000)
2. דלתות אצל משה (פתוחה, רווח: 5,400)
3. שיפוץ מטבח אצל דנה (פתוחה, רווח: 2,200)

(שלח מספר או שם)
```

### D3. Structured one-shot parser

Message format:
```
עסקה: <name>
הכנסה: X
עובדים: Y
חומרים: Z
דלק: W
```

Also supports inline:
```
עבודה חדשה דלתות ללקוח משה הכנסה 8500 חומרים 2200 עובד 900
```

Parser steps:
1. Detect intent (`עסקה`/`עבודה`/`פרויקט` keyword)
2. Extract name + client (regex: `אצל (X)`, `ללקוח (X)`)
3. Find all `<keyword>: <number>` OR `<keyword> <number>` pairs
4. Map keywords to cost types via the existing classifier
5. Create job + write N rows + reply with profitability summary

### D4. Profitability Q&A patterns

| User text pattern | Action |
|-------------------|--------|
| `כמה הרווחתי בעסקה של (X)` | Find job by clientName=X, return revenue/cost/profit/margin |
| `מה הרווחיות בפרויקט (X)` | Find job by jobName contains X, return margin |
| `סכם לי את העבודה האחרונה` | Get user's most-recently-updated job, full summary |
| `איזה עבודות פתוחות יש לי` | List all jobs where status=open, sorted by profit DESC |
| `מה העסקה הכי רווחית שלי` | List top 3 by profitMargin |
| `כמה הוצאתי על חומרים החודש` | Sum costByType.materials across all jobs this month |

### D5. Confirmation replies (Hebrew)

**Job created:**
```
פתחתי עבודה חדשה ✅
שם: שיפוץ אמבטיה אצל יוסי
מזהה: j_a8f3k9p2m1q4

מעכשיו כל הוצאה/הכנסה שתשלח תשויך לעבודה הזו אוטומטית.
(שלח "סגור עבודה" לסיום)
```

**Transaction added to job:**
```
נרשם ✅
עבודה: שיפוץ אמבטיה אצל יוסי
חומרים: 700 ₪

עדכון רווח: הרווח ירד מ-6,000 ₪ ל-5,300 ₪ (-12%)
```

**One-shot success:**
```
נרשם ✅

עסקה: שיפוץ אמבטיה אצל יוסי
הכנסה: 10,000 ₪

הוצאות:
• עובדים:  2,500 ₪
• חומרים:  1,200 ₪
• דלק:       300 ₪

סה״כ הוצאות: 4,000 ₪
רווח משוער: 6,000 ₪
רווחיות:    60%

נשמר בגיליון העסקי תחת העבודה הזו.
```

---

## E. Files to change

| File | Change | Lines (est) |
|------|--------|-------------|
| `bot/ExpenseBot_FIXED.gs` | Job-aware parser, `_handleJobCommand_`, `_writeBusinessJobExpense_`, disambig prompts | +600 |
| `bot/personal_sheet_fix.gs` | New `RECOMPUTE_JOBS_TAB` function (read תנועות col J/K, rebuild Jobs tab) | +180 |
| `lib/sheet-writer.js` | Add `JOBS_TAB`, extend `TX_HEADERS` to 11 cols, add `buildJobRow`, `appendJobRow`, `updateJobRow` | +200 |
| `lib/categories.js` | Add cost-type taxonomy (labor / materials / subcontractor / fuel / equipment / shipping / other) | +60 |
| `lib/job-parser.js` (NEW) | One-shot multi-line parser, Hebrew + English keyword maps, regex helpers | +250 |
| `lib/job-store.js` (NEW) | KV CRUD for `job:{sub}:{id}`, `active_job:{sub}`, `job_index:{sub}` | +180 |
| `api/admin/jobs-health.js` (NEW) | Admin endpoint listing "messages where bot couldn't assign a job" | +120 |
| `admin.html` | New "עבודות" section in admin dashboard (PR-4) | +100 |
| `tests/test_job_parser.js` (NEW) | 30+ test cases for one-shot, follow-up, ambiguity | +400 |
| `tests/test_job_store.js` (NEW) | KV CRUD round-trip, atomic aggregate updates | +150 |
| `tests/test_job_isolation.js` (NEW) | Tenant isolation — userA's jobs invisible to userB | +120 |
| `tests/golden_set.js` | Add 20 contractor-style labeled messages | +40 |
| `docs/SHEET_FORMULAS.md` | Document the new Jobs tab + col J/K semantics | +80 |
| `docs/JOB_DEAL_PROFITABILITY_DESIGN.md` | This doc | (shipped) |

**Total new code estimated: ~2,400 lines across 5 PRs. Average 480 LOC per PR.**

---

## F. Tests to add

### F1. Parser tests (`tests/test_job_parser.js`)

Each test = (input string, expected parsed output).

| # | Input | Expected |
|---|-------|----------|
| 1 | `עסק הכנסה 10000` | intent=business_income, jobContext=null, askForJob=true |
| 2 | `עסק הוצאה עובד יומים עבודה 2500` | intent=business_expense, costType=labor, amount=2500, askForJob=true |
| 3 | `עסקה: יוסי הכנסה 10000 עובדים 2500 חומרים 1200` | intent=create_job_oneshot, jobName="יוסי", revenue=10000, costs={labor:2500,materials:1200} |
| 4 | `עבודה חדשה דלתות ללקוח משה הכנסה 8500 חומרים 2200 עובד 900` | intent=create_job_oneshot, jobName="דלתות", clientName="משה", revenue=8500, costs={materials:2200,labor:900} |
| 5 | `הוסף לעסקה של יוסי 700 חומרים` | intent=add_to_job, jobMatch="יוסי", costType=materials, amount=700 |
| 6 | `קיבלתי עוד 2000 על העבודה של יוסי` | intent=add_to_job, jobMatch="יוסי", role=revenue, amount=2000 |
| 7 | `2500 עובדים` (user has both profiles) | intent=ambiguous, askPersonalOrBusiness=true |
| 8 | `2500 עובדים` (user is business-only) | intent=business_expense, costType=labor, askForJob=true |
| 9 | `כמה הרווחתי בעסקה של יוסי` | intent=job_query, query=profit, jobMatch="יוסי" |
| 10 | `איזה עבודות פתוחות יש לי` | intent=job_query, query=list_open |
| 11 | `פתח עבודה חדשה שיפוץ אמבטיה אצל יוסי` | intent=create_job, jobName="שיפוץ אמבטיה אצל יוסי", clientName="יוסי" |
| 12 | `סגור עבודה` | intent=close_active_job |
| 13 | `עבור לעבודה של יוסי` | intent=switch_active_job, jobMatch="יוסי" |
| 14-30 | edge cases (mixed Hebrew/English, ambiguous, multi-job, typos) | various |

### F2. Store tests (`tests/test_job_store.js`)

- Create job → read back → fields match
- Add transaction → aggregates update atomically (no torn writes)
- Two concurrent transactions → both land (use KV CAS or batched read-modify-write)
- Close job → status flips, aggregates frozen
- Reopen closed job → status flips back
- Active-job TTL respected (6h)
- `job_index:{sub}` stays in sync with individual `job:*` keys

### F3. Isolation tests (`tests/test_job_isolation.js`)

- userA creates job → userB cannot read it via any code path
- userA's active_job key not visible to userB
- Job aggregates never leak across tenants
- The Jobs tab in userA's sheet never includes userB's jobs

### F4. Sheet integration test

- Write one job via one-shot → check 4 rows appear in תנועות (1 revenue + 3 costs) with same job_id in col J
- Check Jobs tab has 1 row with correct totals
- Run `RECOMPUTE_JOBS_TAB` → Jobs tab values match KV aggregates exactly

### F5. Golden-set additions (`tests/golden_set.js`)

20 contractor-style labeled messages so classifier accuracy is tracked:
```
{ text: "עובד יום אצל יוסי 800", expected: { category: "עסק", subcategory: "עובדים", cost_type: "labor" } },
{ text: "300 דלק לפרויקט", expected: { category: "עסק", subcategory: "דלק", cost_type: "fuel" } },
... 18 more
```

---

## G. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **TX schema change breaks existing dashboards** (`מאזן חברה` reads cols A-I, ignores J/K — safe; but `SIMPLE_FIX_DASHBOARD` and `RECOVER_DASHBOARD_APPLY_V2` read by column index) | HIGH | Audit every `getRange(2,1,N,X)` call → bump width parameter from 8 to 11. Backward-compat with old 9-col sheets via `if (row[9] !== undefined)` checks |
| 2 | **Existing user sheets without col J/K** | MEDIUM | Detect on first job-write: if header row has 9 cols, write new header row to extend to 11. Idempotent. |
| 3 | **Race condition on concurrent transactions** updating same job aggregates | MEDIUM | Use Upstash KV `EVAL` (Lua) for atomic read-modify-write on `job:{sub}:{id}` |
| 4 | **Ambiguity disambig prompts spam users** | MEDIUM | After 3 same-disambig in a row, ask once "I'll remember your choice for this conversation" → set `active_job` for 6h |
| 5 | **Bot mis-parses job name from free text** ("הוסף לעבודה של יוסי" matches multiple Yossi jobs) | LOW | Show numbered list when >1 match, never auto-pick |
| 6 | **One-shot parser drops a line if format is off** | LOW | Show what was parsed, ask user to confirm; never silently drop |
| 7 | **Jobs tab grows large** (1000 jobs × 17 cols = small) | LOW | Sheet handles this trivially; archive closed jobs >12mo to a Jobs Archive tab |
| 8 | **Steven's own sheet doesn't have col J/K** | HIGH | Detect on first run, prompt Steven to confirm header extension, then write |
| 9 | **Existing `_writeBusinessNExpense_` path** doesn't know about jobs | MEDIUM | Wrap call site: if job context present, call new `_writeBusinessJobExpense_` else fall through to existing path |
| 10 | **Personal/business detection** mis-fires for users who never opted into multi-profile | LOW | Only ask the ambiguity question if user has BOTH `profile:{sub}.hasPersonal=true` AND `profile:{sub}.hasBusiness=true` |

---

## H. Smallest safe PR plan (5 PRs)

### PR-1: Parser + conversation design + tests **ONLY** (no sheet writes, no KV writes)

**Scope:**
- New file `lib/job-parser.js` (~250 LOC)
- 30 test cases in `tests/test_job_parser.js`
- 20 golden-set additions
- Bot: detect job intent, log to console only, no actual writes
- Hebrew/English keyword maps for cost types

**Risk:** LOW. Pure parsing logic, no production behavior change. Bot users won't notice anything.

**Approval criteria:** all 30 parser tests pass; Steven reads 10 sample inputs + outputs.

### PR-2: KV job store + sheet column extension (no UX yet)

**Scope:**
- New file `lib/job-store.js` (~180 LOC)
- `tests/test_job_store.js` + `test_job_isolation.js`
- `lib/sheet-writer.js`: extend `TX_HEADERS` to 11 cols, add Jobs tab spec, header self-heal for existing sheets
- New `buildJobRow`, `appendJobRow`, `updateJobRow` helpers
- Bot still doesn't act on jobs (parser detects, store can save, but no end-to-end wire)

**Risk:** MED — sheet schema change. Mitigation: thorough backward-compat tests on existing user sheets.

**Approval criteria:** new tests pass, existing tests pass, Steven runs a manual check on his sheet (no rows added, header extension works).

### PR-3: Wire bot → store → sheet (end-to-end happy path)

**Scope:**
- Bot handles `פתח עבודה חדשה X` → creates job in KV + Jobs tab
- Bot handles one-shot `עסקה: ...` → creates job + writes N rows + Jobs tab update + sends summary reply
- Bot handles `סגור עבודה` → status flip
- Bot handles `הוסף לעבודה של X Y חומרים` → existing job update + recompute reply
- Disambiguation prompts (when no active_job + no inline job ref)

**Risk:** HIGH — first user-facing change. Mitigation: feature flag `KFL_ENABLE_JOBS=true` per-user via KV (`profile:{sub}.jobsEnabled`); roll out to Steven first, then 3 testers, then everyone.

**Approval criteria:** Steven runs the full happy-path manually + smoke tests pass.

### PR-4: Profitability Q&A + admin visibility

**Scope:**
- Bot handles `כמה הרווחתי בעסקה של X`, `איזה עבודות פתוחות`, `מה העסקה הכי רווחית` etc
- Admin: new endpoint `api/admin/jobs-health.js` + section in admin.html: "Jobs needing attention" (messages bot couldn't auto-assign)
- "Business message missing job", "Profit calculation missing costs" surfaced

**Risk:** MED — admin UI change. Read-only data.

**Approval criteria:** Q&A tests pass; admin shows 0 issues for a test user with 1 clean job.

### PR-5: Polish + documentation + closed-job archive

**Scope:**
- Closed jobs >12mo move to Jobs Archive tab (cron, idempotent)
- `סיכום עבודות לפי לקוח` pivot tab
- `docs/SHEET_FORMULAS.md` updates
- User-facing docs page: `kesefle.com/docs/jobs` with examples
- Help-screen command: `עזרה עבודות` lists all job commands

**Risk:** LOW — additive polish.

**Approval criteria:** docs reviewed, archive cron runs cleanly on test data.

### Total timeline (suggested)

| PR | Effort | Cumulative |
|----|--------|------------|
| PR-1 (parser + tests) | 4 hours | half day |
| PR-2 (store + sheet schema) | 6 hours | 1.5 days |
| PR-3 (wire end-to-end, feature-flagged) | 8 hours | 2.5 days |
| PR-4 (Q&A + admin) | 5 hours | 3 days |
| PR-5 (polish + docs) | 3 hours | 3.5 days |

**~3.5 days of focused work, 5 PRs, each independently reviewable + reversible via feature flag.**

---

## I. Approval needed

**Don't ship anything until Steven approves the following:**

| # | Decision | Steven's choice |
|---|----------|-----------------|
| 1 | Hybrid schema (extend cols + new Jobs tab) vs single approach (cols only OR Jobs tab only) | TBD |
| 2 | 6h active-job TTL — or longer/shorter? | TBD |
| 3 | Feature-flag `KFL_ENABLE_JOBS` per-user, OR ship to everyone? | TBD |
| 4 | 5-PR breakdown — OK or merge any of them? | TBD |
| 5 | Hebrew terminology: "עסקה" vs "עבודה" vs "פרויקט" — pick primary? Or support all three as aliases? | TBD |
| 6 | Cost types — confirmed list: labor / materials / subcontractor / fuel / equipment / shipping / other. Add/remove any? | TBD |
| 7 | One-shot format — should the parser require `עסקה:` prefix or also accept "עבודה חדשה X הכנסה Y..."? | TBD (currently designed for both) |
| 8 | When user closes a job, freeze the aggregates or allow late additions? | TBD |

**Reply with answers to any/all of these and I'll start PR-1 (parser-only, lowest risk).**

---

## Appendix — sample bot conversations (full transcripts)

### Scenario 1: contractor user creates first job in one shot

```
USER: עסקה: שיפוץ אמבטיה אצל יוסי
      הכנסה: 10,000
      עובדים: 2,500
      חומרים: 1,200
      דלק: 300

BOT:  נרשם ✅

      עסקה: שיפוץ אמבטיה אצל יוסי
      הכנסה: 10,000 ₪

      הוצאות:
      • עובדים:  2,500 ₪
      • חומרים:  1,200 ₪
      • דלק:       300 ₪

      סה״כ הוצאות: 4,000 ₪
      רווח משוער: 6,000 ₪
      רווחיות:    60%

      נשמר בגיליון העסקי תחת העבודה הזו.
      (העבודה כעת פעילה — הוצאות הבאות יתווספו אליה אוטומטית)
```

### Scenario 2: follow-up cost added to active job

```
USER: הוסף 700 חומרים

BOT:  נרשם ✅
      עבודה: שיפוץ אמבטיה אצל יוסי
      חומרים: +700 ₪

      עדכון רווח: 6,000 ₪ → 5,300 ₪ (-12%)
      רווחיות: 60% → 53%
```

### Scenario 3: profitability question

```
USER: כמה הרווחתי בעסקה של יוסי?

BOT:  עסקה: שיפוץ אמבטיה אצל יוסי
      סטטוס: פתוחה
      
      הכנסה:        10,000 ₪
      סה״כ הוצאות:   4,700 ₪
        • עובדים:    2,500 ₪
        • חומרים:    1,900 ₪
        • דלק:         300 ₪
      
      רווח נטו:     5,300 ₪
      רווחיות:        53%
      
      קישור לעבודה בגיליון: [פתח]
```

### Scenario 4: ambiguous message

```
USER: 2500 עובדים

BOT:  יש לך גם מעקב אישי וגם עסקי. לאן לשייך את ההוצאה?

      [אישי — שכר עזרה בבית]
      [עסק — הוצאת שכר כללית]
      [עבודה ספציפית: שיפוץ אמבטיה אצל יוסי]
```

### Scenario 5: list open jobs

```
USER: איזה עבודות פתוחות יש לי

BOT:  3 עבודות פתוחות:
      
      1. שיפוץ אמבטיה אצל יוסי
         רווח: 5,300 ₪ (53%)
      
      2. דלתות אצל משה
         רווח: 5,400 ₪ (64%)
      
      3. שיפוץ מטבח אצל דנה
         רווח: 2,200 ₪ (28%)
      
      סה״כ רווח פתוח: 12,900 ₪
```

---

*Plan-only doc. No code shipped. Awaiting Steven's approval on the 8 decisions in §I before opening PR-1.*
