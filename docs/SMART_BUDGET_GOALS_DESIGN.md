# Smart Budget Goals — Design v1

**Author:** Claude (designed from first principles, not from a Steven-supplied spec)
**Date:** 2026-05-26
**Status:** Design proposal — awaits Steven's review before any PR is opened

---

## Why this exists

Today the bot does only one budget-like thing: a per-category **threshold alert** ("חצינו את שיווק חודש שעבר"). That's a one-dimensional reaction, not a goal. CEOs and households both want the opposite: **set a target in advance, and have the bot help me hit it.**

Competitors that do it (RiseUp, MyFinanda, Mint, YNAB) tie budgets to behavior:
- Pre-monthly: "set ₪3,000 for אוכל this month"
- Mid-month: nudge when on-pace to break (not just after)
- End-of-month: ✓ או ✗, learn for next month

This design adds that loop without bloating the bot — built on the **same expense rows we already write**, with one new KV record per goal.

---

## User stories (3 concrete)

### Story 1 — household budget
> אישה (אורית, 35, אם-של-שניים): "אני רוצה להוציא לא יותר מ-3,000 לאוכל החודש."

Conversation:
```
היא:   קבע יעד אוכל 3000
בוט:   ✅ יעד חדש — אוכל ₪3,000 לחודש.
       אזכיר אם תעברי 50% / 80% / 100% מהיעד.

[10 ימים אחרי, אחרי עוד כמה הוצאות]
היא:   200 רמי לוי
בוט:   ✅ נרשם: ₪200 · אוכל
       📊 ₪1,520 מ-₪3,000 (51%) · נשאר ₪1,480 ב-20 ימים
       ➜ ₪74/יום זה בקצב, ✓ את במסלול
```

### Story 2 — solo entrepreneur cash-flow guardrail
> סטיבן (גבר, 35, בעל עסק): "אני רוצה לא לעבור ₪10,000 שיווק החודש. ואני רוצה שהבוט יעצור אותי לפני שאני כותב הוצאה שתחצה."

Conversation:
```
הוא:   קבע יעד שיווק 10000
בוט:   ✅ יעד חדש — שיווק ₪10,000 לחודש.

[ביום 25, מצטבר 9,200₪]
הוא:   1500 פייסבוק
בוט:   ⚠ עצור — ההוצאה הזו תחצה את היעד.
       יעד שיווק: ₪10,000
       מצטבר: ₪9,200
       ההוצאה הזו: ₪1,500
       לאחר רישום: ₪10,700 (עברת ב-₪700)

       מה לעשות?
       • לרשום בכל זאת? שלח: כן
       • לבטל? שלח: לא
       • להעלות יעד ל-₪11,000? שלח: יעד שיווק 11000
```

### Story 3 — household savings goal (positive, not just spending cap)
> "אני רוצה לחסוך ₪2,000 כל חודש."

Conversation:
```
הוא:   יעד חיסכון 2000
בוט:   ✅ יעד חיסכון — ₪2,000 לחודש (מחושב כ-הכנסות פחות הוצאות).

[ביום 28]
הוא:   סיכום
בוט:   📊 מאי 2026:
       הכנסות: ₪14,200
       הוצאות: ₪12,800
       חיסכון נטו: ₪1,400 מתוך ₪2,000 (70%)
       ➜ עוד יומיים. אם תיזהר/י עם הוצאות מיותרות תגיע לזה.
```

---

## Data model

### KV record per goal

Key: `goal:{userSub}:{goalId}`
Value:
```json
{
  "id": "g_5f8c…",
  "userSub": "117…",
  "type": "spend_cap" | "savings",
  "category": "אוכל",          // null for savings goals
  "amountILS": 3000,
  "period": "monthly",           // only monthly for v1
  "createdAt": 1748259600000,
  "updatedAt": 1748259600000,
  "thresholds": [0.5, 0.8, 1.0], // alert at these % progress
  "alertedAt": {                  // dedup map per period+threshold
    "2026-05:0.5": 1748400000000,
    "2026-05:0.8": null,
    "2026-05:1.0": null
  },
  "active": true
}
```

Index: `goals:{userSub}` → list of goalIds (so we can enumerate "all my goals").

### No new sheet rows

Goals are NOT stored in the user's Google Sheet — they're KV-only. The reason: goals are config, not data. Existing sheet schema (8-column TX) stays untouched.

The bot computes "progress" by SUMming the user's existing תנועות rows for the current month + category. This piggybacks on `api/sheet/bot-query` (already premium-gated, already cached 60s).

---

## Bot commands

| Command | Action |
|---|---|
| `קבע יעד <category> <amount>` | Create or replace spending cap |
| `קבע יעד <amount>` (no category) | Create monthly savings goal (income − expenses) |
| `יעדים` | List active goals + current progress |
| `מחק יעד <category>` | Soft-delete (sets `active: false`) |
| `יעדים כבוי` | Mute all goal alerts for THIS month (re-enabled automatically next month) |

All commands honor the existing bot-secret + tenant-isolation invariants. No new write-path.

---

## Alert logic (the "smart" part)

After every expense write, AND on the daily cron at 09:00 IL, run `_evaluateGoals_(userSub)`:

```
for each active spend_cap goal:
  spent = SUM(תנועות where category matches goal.category and month = current)
  pct   = spent / goal.amountILS

  for each threshold in [0.5, 0.8, 1.0]:
    if pct >= threshold AND not already alerted this month:
      send a nudge message (severity varies — see below)
      mark alertedAt[currentMonth + ':' + threshold]
```

Nudge severity:
- **50%**: friendly heads-up. "💡 חצית חצי מיעד אוכל — נשאר ₪1,500 ב-15 ימים."
- **80%**: warning. "⚠ 80% מיעד אוכל. בקצב הזה תעבור ב-₪400 עד סוף החודש."
- **100%**: hard stop. "🔥 עברת את היעד. עוד הוצאה תוסיף לזה ₪. רוצה להעלות יעד?"

The **pre-write block** (Story 2) is a separate code path — runs inline during the expense parse, BEFORE the row is written. If the goal would be exceeded, ask before writing. Steven explicitly wants this for his business marketing budget.

---

## Math: "in pace" vs "off pace"

For a friendlier UX than just "X / Y", compute pace:

```
day_in_month   = today's day (1..30)
days_in_month  = 30 (or actual)
expected_pct   = day_in_month / days_in_month
actual_pct     = spent / goal

if actual_pct < expected_pct:           → "במסלול ✓"
if expected_pct < actual_pct < +10pp:   → "מהיר קצת"
if actual_pct > expected_pct + 10pp:    → "מואץ — שים/י לב"
```

Bot reply line: `📊 ₪1,520 מ-₪3,000 (51%) · נשאר ₪1,480 ב-20 ימים · במסלול ✓`

---

## Where in the code

Mostly net-new, very few touchpoints:

| File | Change |
|---|---|
| `bot/ExpenseBot_FIXED.gs` | + `_handleGoalCommand_(fromPhone, text)` — matches the 5 commands above. + `_evaluateGoals_(fromPhone)` — called from inside `_enrichExpenseReply_`. + `_preWriteGoalGuard_(fromPhone, parsedExpense)` — called BEFORE the row write in `_tenantWriteExpense_` and the owner write path. |
| `api/goals/list.js` (new) | GET — returns the user's goals. Premium-gated (so admin can also use it). |
| `api/goals/upsert.js` (new) | POST — create / update a goal. Validates category against the user's sheet category list. Rate-limited 10/min per user. |
| `api/goals/delete.js` (new) | POST — soft-delete (sets `active: false`). |
| `api/cron/daily-goal-check.js` (new) | wired into `vercel.json` crons block at `0 7 * * *` (09:00 IL = 07:00 UTC summer). Walks all active goals across users, evaluates, alerts via bot DM. |
| `dashboard.html` | + "🎯 יעדים" section with a small horizontal-bar visual per goal. Inline form to add / edit / delete. |
| `lib/goals.js` (new) | Pure logic: `evaluateGoal()`, `formatPaceLine()`. Used by both the bot and the cron. |

KV impact: 1 record per goal + 1 list per user. For 1000 users × avg 3 goals = ~4K records. Within free Upstash tier.

---

## Risks + how we mitigate

| Risk | Mitigation |
|---|---|
| Goal alerts spam users with every micro-expense | Per-threshold dedup via `alertedAt` map. Max 3 alerts per goal per month. |
| Pre-write block annoys power users | Only active for spending caps that have `block: true` set on them (default false for v1). Steven opt-in. |
| Sheet category name drift (`אוכל` vs `אוכל בחוץ` vs `📂 אוכל`) | Use the same wildcard SUMIFS logic the 📊 מאזן חברה uses — match by `*<name>*` not exact. |
| Goal still alerts after the user already corrected the category | Re-run `_evaluateGoals_` on category correction so the prev-cat goal "unfires" and the new-cat goal re-evaluates. |
| User changes goal mid-month → which threshold to alert from? | When goal amount goes UP: clear all "alertedAt" for this month. When goal goes DOWN: don't re-fire 50%/80% if they were already crossed. |

---

## 3-PR rollout (per `pr-incremental-plan` skill)

### PR-1: Data + commands (no alerts yet)
- New: `lib/goals.js`, `api/goals/{list,upsert,delete}.js`
- New: bot commands `קבע יעד`, `יעדים`, `מחק יעד`
- Bot just SAVES and DISPLAYS goals — no alerts, no pre-write blocks
- Tests: `bot/test_goals_parse.js` (5 assertions on command parsing)
- **Mergeable, deployable, reversible.** Steven can play with creating goals via bot, view them via `יעדים`, without any side-effects.

### PR-2: Post-write threshold alerts
- Add `_evaluateGoals_()` call inside `_enrichExpenseReply_`
- Add the 50/80/100 nudge logic with dedup
- New: `api/cron/daily-goal-check.js` + vercel.json wire
- Tests: `bot/test_goal_thresholds.js`
- After this PR, alerts fire naturally as expenses come in.

### PR-3: Pre-write block (opt-in) + dashboard widget
- Add `_preWriteGoalGuard_()` for goals marked `block: true`
- Dashboard UI: "🎯 יעדים" section
- Tests: `bot/test_goal_preblock.js`
- This is the "stop me before I spend" feature Steven specifically asked for.

---

## Open questions for Steven

1. **Should the bot's nudge text be soft-voiced ("אולי שווה לבדוק") or directive ("עצור")?** I drafted directive — easier to dial down.
2. **For savings goals, what defines "savings"?** I used `income − expenses` for the month. Alternative: only count what's marked as `חיסכון` category. Which?
3. **Pre-write block: opt-in (`block: true` flag) or opt-out (always on)?** I drafted opt-in to avoid annoying users. You wanted it for marketing — confirm.
4. **Goal visibility — do you want goals on the public dashboard or only in WhatsApp + admin?** I drafted dashboard widget. Easy to skip if you'd rather keep dashboard read-only.
5. **Goal renaming after creation — allow or force delete+recreate?** I drafted "replace by re-issuing the קבע יעד command" — simpler.

Once you answer these, I open PR-1.

---

# v2 ADDITION — Onboarding question + recurring reminders (added 2026-05-26 by Steven)

Original v1 (above) treated goals as something the user *opts into* by typing
`קבע יעד אוכל 3000`. Steven asked for the OPPOSITE: the bot **proactively asks**
during onboarding, and once a horizon is chosen, **proactively reminds** the user
2-3× per week so the goal stays top of mind.

This is the difference between a *budget tool* (user remembers to set caps) and
a *coach* (the coach won't let you forget your goal).

## New onboarding question

Add a new step to the existing signup questionnaire (the one that already asks
profession, tracking type, etc.). Placement: **last question in the questionnaire**,
because by then the user is invested and won't drop off.

Question text (Hebrew):
```
🎯 שאלה אחרונה — מה היעד הפיננסי שלך?
נדלוק עליו ביחד.

1️⃣ לחודש הקרוב   — קצר, ממוקד (חיסכון, לחתוך הוצאה, להגדיל הכנסה)
2️⃣ ל-6 חודשים   — בינוני (סגירת חוב, קרן חירום, הקמת עסק)
3️⃣ לשנה הקרובה  — גדול (משכנתא, השקעה, מטרת חיים)
4️⃣ אין לי יעד   — נדבר בהמשך
```

The user replies with 1/2/3/4. We then ask the FREE-TEXT specifics:

```
מצוין. במשפט אחד — מה היעד?
לדוגמה: "לחסוך 5,000 ש"ח לטיול ביוני" / "להוריד הוצאות אוכל ב-1000 לחודש" /
"להחזיר את ההלוואה של 12,000 עד סוף השנה"
```

The user replies in free text → we save it.

## Data model — extends the existing `goal:` schema

NEW record type — `objective` (the long-horizon goal), separate from `goal`
(the monthly cap/savings). One per user, replaced on re-issue.

KV: `objective:{userSub}`
```json
{
  "userSub": "117...",
  "horizon": "month" | "six_months" | "year",
  "horizonChosenAt": 1748259600000,
  "horizonEndsAt": 1750851600000,         // computed: now + horizon
  "description": "לחסוך 5000 ש\"ח לטיול ביוני",
  "createdAt": 1748259600000,
  "lastReminderAt": null,                  // managed by the reminder cron
  "reminderCount": 0,
  "muted": false,                          // user can mute via "השתק יעד"
  "achieved": false                        // set true by user via "השגתי יעד" or by goal achievement
}
```

## Reminder cron — 3× per week, smart content

NEW cron: `api/cron/objective-reminders.js`, wired to `vercel.json` at
`0 18 * * 0,2,4` (Sunday + Tuesday + Thursday, 20:00 IL = 18:00 UTC summer).

For each active objective (not muted, not achieved, not past `horizonEndsAt`):
1. Skip if `lastReminderAt` < 36h ago (anti-spam)
2. Compute progress proxy from existing data:
   - "month" horizon: this-month net cashflow vs implied target
   - "six_months": last-6-months trend toward the description's keywords
   - "year": last-12-months trend
3. Pick one of 4 message templates based on progress band:
   - **Behind** → encouragement: "💪 חצי חודש עבר ועדיין רחוק מ-X. מה תוכל לשנות השבוע?"
   - **On track** → positive reinforcement: "🔥 אתה במסלול ל-X. עוד 18 ימים."
   - **Ahead** → celebration: "✨ עברת חצי דרך ל-X באמצע החודש. כל הכבוד."
   - **No data yet** → check-in: "🎯 רק תזכורת: היעד שלך הוא X. נדבר על איך להגיע."
4. Send via WhatsApp DM
5. Update `lastReminderAt`, increment `reminderCount`

## New bot commands (on top of v1)

| Command | Effect |
|---|---|
| `יעד שלי` | Show current objective + progress |
| `השגתי יעד` | Mark `achieved: true`, congratulate, ask if they want a new horizon |
| `השתק יעד` | Set `muted: true` for the current horizon period (auto-unmutes at next horizon) |
| `שנה יעד <description>` | Update description without resetting horizon |
| `יעד חדש` | Re-run the onboarding question + free-text capture |

All routed through `_handleObjectiveCommand_` (new), wired BEFORE
`_handleGoalCommand_` in doPost so "יעד" tokens are caught by the right handler.

## Why this matters (the principle Steven gave)

Per Steven's note: "The customer has to remember the financial goal — we won't
let them forget." The whole feature is built around that contract:
1. **Ask explicitly** at onboarding so the goal is named, not inferred
2. **Remind regularly** so the goal stays present, not fade-away
3. **Make achievement visible** so the user has a moment of "I did it"
4. **Make re-entry easy** so when one goal ends, the next starts immediately

This is what turns Kesefle from "expense tracker" into "financial coach."

## Implementation order (extends the v1 3-PR rollout)

### PR-1 (already merged as #72)
- Manual goal commands: קבע יעד / יעדים / מחק יעד
- Data layer + API endpoints + bot dispatcher

### PR-2 — Objective onboarding + reminder cron (NEW from this v2)
- New `objective:` KV record
- 4 new bot commands (יעד שלי / השגתי יעד / השתק יעד / שנה יעד / יעד חדש)
- New cron: `api/cron/objective-reminders.js` (Sun/Tue/Thu 20:00 IL)
- Onboarding question added to the signup questionnaire (after profession step)
- 4 reminder templates with progress-aware selection
- 5+ regression tests in `bot/test_objective_reminders.js`

### PR-3 — Post-write threshold alerts (from v1 PR-2)
- 50/80/100% alerts on `spend_cap` goals
- Daily 09:00 cron
- (unchanged from v1 design)

### PR-4 — Pre-write block + dashboard widget (from v1 PR-3)
- `block: true` flag wiring
- Dashboard "🎯 יעדים" section
- (unchanged from v1 design)

## Open questions added in v2

6. **Onboarding placement** — last question of the questionnaire (my draft) OR
   first question right after the welcome message?
7. **Reminder cadence** — Sun/Tue/Thu evenings (3×/week, my draft) OR every
   weekday morning OR just Sun+Wed?
8. **"No data" gracefulness** — for a brand-new account with no expenses yet,
   should the cron still fire reminders, or wait until there are ≥10 expenses?
9. **Free-text validation** — the description is unstructured. Should we try to
   parse it (amount + date + category) and create a `spend_cap`/`savings` goal
   automatically, or keep it as text-only motivation?
10. **Mute escape hatch** — should a single "stop" / "די" / "אל תזכיר" auto-mute,
    or only the explicit `השתק יעד` command? I prefer the explicit command for
    clarity but Steven may want the natural-language exit.

Once Steven answers Q6-Q10 + Q1-Q5 from v1, I open PR-2 of the goals feature.
