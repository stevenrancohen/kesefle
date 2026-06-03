# Bot menu-first policy (Kesefle WhatsApp bot)

**Author:** Steven (product rule), Claude (formalization)
**Date:** 2026-05-26
**Status:** Permanent product rule

This document is the permanent product rule for the Kesefle WhatsApp bot. Future bot changes must comply with these constraints.

---

## The rule

> **When the user starts a structured action, the bot must guide them through menus, buttons, lists, and step-by-step selection. Do not rely only on free text for important flows.**

Free text remains *available* as an input. Menus must always be the *primary* path.

---

## Why this rule exists

A user wrote `"היעד החדש הוא לרדת בהוצאות של האוכל ל 2000 שח כל חודש גם"`. The bot:

1. Did not recognize this as a budget-set intent (only matched the structured `"יעד חדש"` command).
2. Fell through to the expense parser.
3. Extracted `"2"` as the amount instead of `"2000"`.
4. Wrote a ₪2 row to the user's sheet with category "אוכל" and a "low confidence" note.

The structural fix is **never let a structured action depend solely on natural-language parsing**. The bot must always provide a menu/button path that is *cheap*, *fast*, and *reliable*. Free-text input is best-effort, never authoritative.

---

## Flows that REQUIRE a menu

| Flow | Menu requirement |
|---|---|
| Setting a budget / monthly cap | Multi-step: type → category → amount → alerts → confirm |
| Setting a long-horizon objective (`יעד חדש`) | Multi-step: horizon → description → confirm |
| Choosing a category for an ambiguous expense | Picker list with ≥ 20 options, grouped |
| Choosing personal vs business profile | 2-option picker, never inferred from text |
| Choosing which business / project / job | List from the user's actual businesses |
| Changing the category of the last expense | Picker, plus "save as rule" follow-up |
| Adding an income vs expense | Tab/button choice |
| Setting a recurring payment | Multi-step: amount → category → frequency → first date |
| Setting goal alerts | Multi-option picker |
| Choosing VAT/tax relevance | 2-option toggle |
| Choosing payment method | Picker: cash / card / Bit / transfer |
| Correcting the last transaction | Picker of the last 3 transactions + edit form |
| Deleting the last transaction | Confirmation dialog (yes / no) |
| Importing data | Step-by-step wizard |
| Subscription / payment | Multi-step with confirmation before charge |
| Support escalation | Menu: technical / billing / data / other |

---

## Flows where free text is ENOUGH (no menu required)

| Flow | Why |
|---|---|
| Logging a clear single expense (`"50 קפה"`) | Single-shot parse is reliable for short numeric + noun phrases |
| Asking a question (`"כמה הוצאתי השבוע?"`) | Conversational query, bot answers and waits |
| Saying hello / casual chat | LLM concierge handles |
| One-word command (`"סיכום"` / `"עזרה"`) | Already structured |

---

## Confidence-aware default behaviour

Every parser must return a confidence score, even if implicit. Use these thresholds:

- **High confidence (≥ 0.85)** — process normally, no extra confirmation.
- **Medium confidence (0.60–0.84)** — show the result + a "🔁 שנה" button. User can fix in one tap.
- **Low confidence (< 0.60)** — DO NOT WRITE. Show the menu of likely intents and ask the user to pick.

Free-text guesses that fall in the low band must never silently write a row to the sheet.

---

## Confirmation-before-save rule

For every structured save (budget, objective, recurring, transfer, account change), the bot must:

1. Show a "rak מאשר" summary card with the exact values it parsed.
2. Wait for one of: `אישור` / `אישור` / `כן` / `1` / `אוקיי`.
3. Treat any other reply (or no reply within the session) as cancel.
4. Never save silently from an ambiguous natural-language sentence.

---

## Suspicious-low-amount guard

When the parser extracts an amount AND the surrounding text contains budget words (`יעד`, `תקציב`, `לא לעבור`, `לרדת ל`, `להפחית ל`, `cap`, `budget`, `limit`):

- If `amount < 50` ILS: ASK `"האם התכוונת ל-₪{amount} או ₪{amount * 1000}?"` — never auto-save.
- If `amount ≥ 50`: process normally with the confirmation dialog above.

Implementation: shipped in PR #83 inside `_handleObjectiveCommand_`.

---

## Minimum category picker

When the picker is shown:

- **At least 20 options visible** (across grouped sections if the platform limits a single section).
- WhatsApp Interactive Lists allow up to **10 sections × 10 rows = 100 rows**. Use this fully.
- Sections must use the canonical grouping below.
- Each section title ≤ 24 chars (WhatsApp limit).
- Each row title ≤ 24 chars; row description ≤ 72 chars.
- Always include `"קטגוריה חדשה"` (free-text fallback) and `"לא בטוח / פתח רשימה מלאה"` (escape).

### Canonical category groups (Hebrew)

```
🍞 אוכל             אוכל לבית · אוכל בחוץ · סופר · מסעדות · קפה · משלוחים · שתייה · חטיפים
🏠 בית              שכירות · משכנתא · חשמל · מים · ארנונה · גז · אינטרנט · תחזוקה
🚗 תחבורה            דלק · רכב · ביטוח רכב · חניה · כבישי אגרה · טיפול לרכב · תח״צ · מוניות
💼 עסק              הכנסה מעסק · שיווק · פרסום · עובדים · חומרי גלם · קבלן משנה · ציוד · תוכנות · משרד · רואה חשבון · מיסים · משלוחים עסקיים
🧍 אישי              בריאות · תרופות · בגדים · בילויים · מתנות · ילדים · חיות מחמד · לימודים · חופשות · ספורט
💰 פיננסי            הלוואות · החזר חוב · חיסכון · השקעות · עמלות בנק · ביטוחים · אשראי
✨ אחר               שונות · לא בטוח · קטגוריה חדשה
```

When the user types a free-text custom category, the bot **must** ask:

```
לשמור את "{custom}" כקטגוריה קבועה לפעם הבאה?
1. כן
2. לא
3. רק החודש
```

---

## "Stateful menu" pattern (cache-backed)

Multi-step menu flows store transient state in Apps Script CacheService:

```
Cache key:   pendingFlow:{E164phone}
Cache value: { flow: 'objective-create' | 'budget-set' | 'transfer' | ...,
               step: 1,
               collected: { horizon: 'month', ... },
               startedAt: ts }
TTL:         600 seconds (10 minutes)
```

Every doPost iteration must check `pendingFlow:{clean}` BEFORE the normal command routers. If set, dispatch to the matching state machine. If the user replies `"בטל"` / `"cancel"` / `"חזור"` at any point, clear the cache key and resume normal routing.

State machines must never depend on the LLM concierge to interpret a step reply — the step reply must be either:
- A digit from the menu (e.g. `"1"` / `"2"`)
- A canonical keyword (e.g. `"חודש"` / `"מחיקה"`)
- A free-text value with bounded shape (e.g. an integer for "amount" step)
- An explicit `"בטל"` / `"דלג"` / `"חזור"` token

---

## Avoid these anti-patterns

1. ❌ Parsing free-text where a button would do.
2. ❌ Silently writing a row when confidence < 0.60.
3. ❌ Picking the first number in a sentence (use `max(amounts)` or context).
4. ❌ Treating `"2000"` and `"2"` as interchangeable when context suggests a budget.
5. ❌ Showing a 4-option category picker when there are obviously more.
6. ❌ Letting the user "drop into" a flow mid-step without seeing a menu.
7. ❌ Saving a new state without confirmation.
8. ❌ Relying on the LLM concierge to be the primary parser for structured actions.
9. ❌ Mixing English placeholders into a Hebrew menu.
10. ❌ Showing a `"רק כתוב X"` instruction when the bot could show a button labeled X instead.

---

## Implementation checklist for every new bot flow

Before merging any bot PR that adds or modifies a user-facing flow, the author must confirm:

- [ ] Has a menu path (or this flow is on the "free text is enough" list above).
- [ ] Has a confirmation step before any write.
- [ ] Handles `"בטל"` to abort and clear cache.
- [ ] Has tests in `bot/test_*.js` for the 3 most likely user mistakes.
- [ ] Updates `KFL_BUILD_VERSION` so the admin freshness badge flips red until paste.
- [ ] Regenerates `bot/ExpenseBot_DEPLOY.gs` (`head -95 DEPLOY > /tmp/x && tail -n +21 FIXED >> /tmp/x`).
- [ ] Lists the paste step explicitly in the PR body.

---

## Reference implementations

- **PR #83** — NL budget-intent guard. First implementation of the suspicious-low-amount guard (rule §"Suspicious-low-amount guard").
- **PR-2 of menu-first (next)** — Multi-step stateful `pendingFlow:` for the `יעד חדש` flow. First implementation of the "Stateful menu" pattern.
- **PR-3 of menu-first (next)** — Expanded category picker with the canonical groups (rule §"Minimum category picker").

When in doubt about an edge case, default to the **safer** behaviour — show a menu, ask for confirmation, never silently write.
