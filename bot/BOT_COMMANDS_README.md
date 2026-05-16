# BOT_COMMANDS.gs — Conversational commands for the Kesef'le bot

Apps Script module that handles quick text intents before the classifier runs.
When the user sends a recognized command, the router replies immediately and
short-circuits the expense-classification pipeline.

## Features

- **Summary queries** — `היום?`, `אתמול?`, `השבוע?`, `החודש?`, `החודש שעבר?`,
  `שנה?` (plus English aliases `today?`, `month?`, `year?`, etc.). Returns
  total + transaction count, and a top-category breakdown for week/month/year.
- **Category-specific queries** — `כמה הוצאתי על וולט?`, `כמה על קפה?`,
  `how much on coffee?`. Substring-matches both the raw text and the
  subcategory columns, prints the total + 3 most recent examples.
- **UNDO / corrections**
  - `מחק אחרון` / `UNDO` — deletes the most-recent row in `תנועות`.
  - `תקן ל: <קטגוריה>` — overwrites the subcategory of the last row.
  - `מחק את <טקסט>` — deletes the most-recent row whose raw text or
    subcategory contains `<טקסט>`.
- **Help** — `עזרה` / `help` / `?` returns the Hebrew command cheat sheet.
- **Stats** — `סטטיסטיקות` / `stats` returns total entries, this-month count,
  daily average, busiest category.

All replies are Hebrew-first with emoji decorations (`💰 🧾 📊 🏆 🗑 ✅`).

## Wire-up snippet for SRC_ROUTER_handle

Add these three lines at the very top of `SRC_ROUTER_handle(from, text)`, before
any classification or installment parsing:

```javascript
var __bc = handleBotCommand_(from, text);
if (__bc && __bc.handled) { sendWhatsAppReply(from, __bc.replyText); return; }
// ... existing classifier / installment / dropdown logic stays as-is below
```

That's it — if the message matched a command, the bot replies and stops; if
not, control falls through to the legacy router unchanged.

## Public API

- `handleBotCommand_(from, text)` — returns `{ handled: true, replyText }` on
  match, `{ handled: false }` otherwise. Pure read-only for summary/category
  queries; mutates the sheet only for UNDO / fix / delete commands.
- `sendWhatsAppReply(toPhone, text)` — wraps the Meta Graph API call. Reads
  `WA_TOKEN`, `WA_PHONE_ID`, `WA_GRAPH_VERSION` from Script Properties.
- `TEST_BOT_COMMANDS()` — non-destructive harness; logs each sample reply via
  `Logger.log`. Safe to run from the Apps Script editor.

Internal helpers (all underscored): `_formatShekel`, `_dateRangeFilter`,
`_groupByCategory`, `_BC_searchByText_`, `_BC_findLastRow_`, `_BC_summaryReply_`,
`_BC_categoryQueryReply_`, etc.

## Sheet schema (תנועות)

| Col | Field        |
|-----|--------------|
| A   | timestamp    |
| B   | amount       |
| C   | currency     |
| D   | type         |
| E   | category     |
| F   | subcategory  |
| G   | raw_text     |
| H   | source       |
| I   | message_id   |

Spreadsheet ID is hard-coded to `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`.

## 10 example messages with expected replies

| User says | Bot replies (shape) |
|-----------|---------------------|
| `עזרה` | Help cheat sheet listing every command in Hebrew. |
| `היום?` | `📊 היום (16/05) · 💰 סה"כ: ₪247 · 🧾 תנועות: 4` |
| `אתמול?` | `📊 אתמול (15/05) · 💰 סה"כ: ₪0 · 🧾 תנועות: 0` (or numbers if data exists) |
| `השבוע?` | `📊 7 הימים האחרונים · 💰 סה"כ: ₪1,840 · 🏆 מובילה: אוכל בחוץ (₪620)` |
| `החודש?` | `📊 החודש (5/2026) · 💰 סה"כ: ₪4,210 · 🏆 מובילה: בית (₪2,300)` |
| `שנה?` | YTD total + top 5 categories ranked. |
| `כמה הוצאתי על וולט?` | `🧾 חיפוש: "וולט" · 💰 סה"כ: ₪380 · 3 דוגמאות אחרונות` |
| `כמה על קפה?` | `🧾 חיפוש: "קפה" · 💰 סה"כ: ₪82 · 2 תנועות` |
| `מחק אחרון` | `✅ נמחק: ₪45 · אוכל בחוץ` |
| `תקן ל: דלק` | `✅ עודכן: ₪220 -> דלק` |
| `סטטיסטיקות` | Total entries + this-month count + ₪/day avg + busiest cat. |

## File stats

- Path: `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/BOT_COMMANDS.gs`
- Lines: 586 (well under the 600 budget)
- Syntax verified with `node -c /tmp/check.js` → OK
- ASCII-only comments; Hebrew strings only in user-visible literals
