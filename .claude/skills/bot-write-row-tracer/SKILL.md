---
name: bot-write-row-tracer
description: Given a Steven-reported bot message like "850 שיווק", predict every column of the תנועות row the bot will write — so dashboard taxonomy mismatches can be caught before the live write.
---

# Trace a bot expense to its 8-column תנועות row

When Steven says "I sent `850 שיווק` and the dashboard didn't catch it", do not guess what the bot wrote. The 9 columns of the תנועות row (`lib/sheet-writer.js:1066` `buildExpenseRow`) are load-bearing for every SUMIFS in `מאזן חברה` and `מאזן אישי`. Predict the row's exact contents, then either confirm it matches the dashboard criteria or pick the right fix (data side via `bot-add-keyword` or formula side via `sheet-bot-taxonomy-reconcile`).

## The 9 columns the bot writes

`buildExpenseRow` returns `[A..I]` where:

| Col | Name           | Source                                                          | Dashboard uses |
|-----|----------------|-----------------------------------------------------------------|----------------|
| A   | תאריך          | `new Date().toISOString()`                                      | `הזמנות` formulas only — not תנועות SUMIFS |
| B   | חודש (YYYY-MM) | `${yyyy}-${mm}` from the date                                   | SUMIFS month criterion `$B$4&"-MM"` |
| C   | סכום           | parsed amount (number)                                          | SUMIFS sum range |
| D   | קטגוריה (top)  | `CATEGORY_MAP[i].category` matched by keyword                   | SUMIFS `D:D, "עסק"` filter |
| E   | תת-קטגוריה     | `CATEGORY_MAP[i].subcategory` matched by keyword                | SUMIFS `E:E, "<criterion>"` filter |
| F   | פירוט          | raw user text (sanitized)                                       | display only |
| G   | מקור           | `'whatsapp'`                                                    | display only |
| H   | סטטוס          | `!isIncome` boolean                                             | not used today |
| I   | ניכוי מע״מ     | `!!vatDeductible` boolean                                       | tax-report endpoint |

Columns D + E are the ones that determine whether the row lands in the right dashboard bucket. Get those wrong, dashboard zeros out.

## Steps

1. Quote the exact message Steven sent — Hebrew, exact spacing, exact emojis. Don't paraphrase.
2. Predict col C (amount):
   ```
   node -e "const t='850 שיווק'; const m=t.match(/(\d+(?:[\.,]\d+)?)/); console.log(m && parseFloat(m[1].replace(',','.')));"
   ```
   `_extractAmount_` strips currency glyphs (`₪`, `$`, `USD`, `שקל`) before parsing.
3. Predict col D + E by checking which `CATEGORY_MAP` row matches FIRST (matcher is order-sensitive — first hit wins, top of list = highest priority):
   ```
   grep -n "category.*עסק" /Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs | head -10
   ```
   Then for the specific keyword (e.g. "שיווק"):
   ```
   awk '/^const CATEGORY_MAP = \[/,/^];/' /Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/ExpenseBot_FIXED.gs | grep -n '"שיווק"' | head -5
   ```
   The first row whose `keywords` array contains the user's term — that's `{category, subcategory}` for cols D + E.
4. Predict B (month) from "today" — typically `YYYY-MM` of the local date. If Steven sent the message yesterday in Israel timezone but the bot processed it today UTC, B may be off by one day → a row that lands in the wrong month bucket. Check the bot's tz handling if dates look weird.
5. Cross-reference predicted (D, E) against `_buildCompanyDashboardTab` criteria (`lib/sheet-writer.js:485`) — does the wildcard catch the predicted col E? If not, you've located the mismatch BEFORE the live write.
6. For end-to-end verification, run `bot/test_parser.js` with the exact message:
   ```
   cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle && node bot/test_parser.js
   ```
   Add a one-off case with the message; confirm the parsed `{amount, category, subcategory}` matches your prediction.

## Three decisions after the trace

- **Trace matches dashboard** — bot+dashboard agree, the issue is elsewhere (cache, timezone, sheet not refreshed). Try `service-worker-bust` or check the live sheet.
- **Trace matches bot but NOT dashboard** — dashboard criteria are too narrow. Add the missing criterion to `COMPANY_EXPENSE_ROWS` in `lib/sheet-writer.js` + recompute existing tenants. See `sheet-bot-taxonomy-reconcile`.
- **Bot misclassified** — `CATEGORY_MAP` ordering or keyword set is wrong. Reorder or add keyword via `bot-add-keyword`, anchor with `golden-set-update`.

## Verification

- `node bot/test_parser.js` — your one-off case parses to your predicted row.
- `node bot/test_classify.js` — taxonomy test still green.
- `node tests/golden_set.js` — no regression.
- After fix: send the same message in WhatsApp to the test bot phone (`SHEET_OWNER_PHONE`); verify the actual row in תנועות matches the predicted row column-for-column.

## Examples

- **"850 שיווק"** — `_extractAmount_` → 850. `CATEGORY_MAP` row at line 275 has `"שיווק"` in keywords → `{category:"עסק", subcategory:"שיווק"}`. Dashboard row 9 `*שיווק*` catches `"שיווק"`. ✅ Match. Row lands in `מאזן חברה` row 9 (שיווק) for current month.
- **"₪300 לאריזה"** (Steven 2026-05-28) — amount 300. `CATEGORY_MAP` line 278 matches `"אריזה"` → `{category:"עסק", subcategory:"משלוח"}`. Dashboard row 10 uses `*משלוח*` + `*אריזה*` criteria. ✅ Match. Lands in row 10 (משלוח).
- **"850 דמי ניהול"** — amount 850. NO CATEGORY_MAP row has `"דמי ניהול"` keyword today. Falls through to default `שונות` / `אישי`. Dashboard `מאזן חברה` doesn't even check D="אישי" → row is invisible to the company dashboard. Fix: add "דמי ניהול" / "management fee" to the `תפעוליות` row in `CATEGORY_MAP`, add golden test, deploy bot. Then `*תפעולי*` catches `"תפעוליות"`.

## Common pitfalls

- Predicting from memory of the keywords — open `CATEGORY_MAP` and grep, the order changed last week.
- Forgetting CATEGORY_MAP is order-sensitive: `"שיווק שטוקיי"` matches the שיווק row first; `"אריזה ומשלוח"` matches משלוח first.
- Predicting col B as today's UTC date when the bot uses Asia/Jerusalem — off-by-one near midnight.
- Tracing on `bot/ExpenseBot_FIXED.gs` but Steven runs `bot/ExpenseBot_DEPLOY.gs` (the reassembled deploy artifact). Confirm they match: `diff <(tail -n +21 bot/ExpenseBot_FIXED.gs) <(tail -n +96 bot/ExpenseBot_DEPLOY.gs) | head`.

## Related skills

- [[bot-trace-message]] — broader diagnostic (wrong category, wrong sheet, dropped). This skill is narrower: the 9-col row prediction.
- [[bot-add-keyword]] — the canonical fix when prediction shows the bot misses a term.
- [[golden-set-update]] — anchor the test after a keyword fix.
- [[sheet-bot-taxonomy-reconcile]] — the dashboard-side counterpart, when the dashboard criteria are too narrow.
- [[sheet-tenant-write]] — what happens AFTER `buildExpenseRow` returns: phone resolution + tenant write.
