# Kesefle Bot — Command Reference

Every WhatsApp message the bot understands. Updated 2026-05-18.

Hebrew is primary. English aliases are listed in parens.

---

## Expenses (the core flow)

### Text expense
Format: `<amount> <description>`

```
245 סופר
42 קפה ארומה
1800 ארנונה
50$ amazon
```

→ Bot replies with:
```
✅ ₪245 לסופר. נשמר אצלך בגיליון 📊
📂 אוכל
🏷️ אוכל לבית
💡 החודש הוצאת ₪X על אוכל.

❓ קטגוריה לא מדויקת? שלח "קטגוריה <השם הנכון>" ואני אלמד.
```

### Receipt photo (📸)
Just send a photo of any Israeli receipt. The bot reads it via Claude Vision, extracts vendor + amount + date, categorizes, and logs.

### Voice message (🎙️)
Send a WhatsApp voice note like "מאתיים שמונים שקל בסופר". Bot transcribes via OpenAI Whisper and processes as a text expense.

→ Requires `OPENAI_API_KEY` in Script Properties.

---

## Correction + learning

| Command | Effect |
|---|---|
| `קטגוריה <שם>` (`category <name>`) | Correct the LAST logged expense to a new category. Bot asks `כן`/`לא` to confirm. |
| `כן` / `לא` | Confirm or reject pending correction (or pending reset). |
| `לימוד` (`learning`) | List the last 10 things the bot has learned. |
| `למד: "טקסט" = קטגוריה` (`learn: "text" = category`) | Directly teach without correction. Also LLM-extracts core keywords. |
| `מחק לימוד <N>` (`delete learning N`) | Remove entry N from the learning list. |
| `איפוס לימוד` (`reset learning`) | Wipe ALL learning (asks `כן`/`לא`). |

### How learning compounds
1. **Your local learning** — every correction is saved to a "Learning" tab in YOUR Sheet.
2. **LLM keyword extraction** — Claude Haiku extracts 1-3 semantic keywords (e.g. "מוביל הוצאות בית" → ["מוביל", "הובלה"]) and saves those too.
3. **Cross-user global store** — SHA-256 hashes of corrected phrases are shared anonymously across all Kesefle users. When user B sends a phrase user A already corrected, bot replies `📚 למדתי ממשתמשים אחרים`.

Privacy: only hashes shared, never the original text.

---

## Insights + reports

| Command | Effect |
|---|---|
| `סיכום` (`summary`) | Current-month spending breakdown by category. |
| `סטטוס` (`status`) / `health` / `ping` | Bot health check. Returns version, sheet status, AI status. |
| `עזרה` (`help`) | Show available commands. |
| `מנויים` (`subscriptions`) | Detected recurring subscriptions (Netflix, Spotify, gym, etc.). |
| `חריגות` (`anomalies`) | Spending that's >2σ above your personal baseline. |

---

## Budget alerts (proactive)

The bot automatically warns when you cross spending thresholds. Throttled 6h per category to avoid noise.

| Command | Effect |
|---|---|
| `תקציבים` (`budgets`) | Top 10 categories with pace status (✓ / ⚠️ / 🚨 / 🔥) vs last month. |
| `יעד תקציב <קטגוריה> = <סכום>` (`budget X = Y`) | Set custom monthly target for a category. Overrides last-month baseline. |

### Alert tiers (auto-triggered after each expense)
- ⚠️ Pace warning — you're 20% above the pace you'd need to match last month
- 🚨 Firm warning — already 80% of last month's category spend with >1/3 of the month remaining
- 🔥 Exceeded — crossed last month's category total

---

## Goals (savings + spending caps)

| Command | Effect |
|---|---|
| `מטרות` / `יעדים` (`goals`) | List active goals with progress bars. |
| `מטרה: חיסכון 5000 לחופשה עד אוגוסט` | Set a savings goal. |
| `מטרה: עד 800 שח על אוכל בחוץ בחודש` | Set a spending cap. |
| `מטרה: לא להוציא על קפה השבוע` | Set a temporal cap. |
| `מחק מטרה <N>` | Remove goal N from the list. |

---

## Family / business multi-user

| Command | Effect |
|---|---|
| `הקמת משפחה` (`create family`) | Become an admin. Bot creates a shared family Sheet and gives you a 6-character invite code. |
| `הצטרפות למשפחה <ID>` (`join family <ID>`) | Request to join an existing family. Admin gets a notification with approve/deny buttons. |
| `אישור <phone>` (`approve <phone>`) | Admin only — approve a join request. |
| `דחייה <phone>` (`deny <phone>`) | Admin only — reject a request. |
| `משפחה <amount> <desc>` (`family X Y`) | Log expense to the family Sheet (instead of your personal). |
| `אבא X Y` / `אימא X Y` / `ילד1-3 X Y` | Log on behalf of a specific family member. |
| `דו"ח משפחתי` (`family report`) | Current-month breakdown by family member. |
| `מצב משפחתי` (`family mode`) | Switch default — all subsequent expenses go to family Sheet. |
| `מצב אישי` (`personal mode`) | Switch back — default to personal Sheet. |
| `אישי <amount> <desc>` (`personal X Y`) | One-shot — log to personal Sheet regardless of mode. |
| `משפחה <amount> <desc>` while in personal mode | Same — one-shot family override. |

---

## Settings

| Command | Effect |
|---|---|
| `אזור זמן` (`timezone`) | Show your current timezone. |
| `אזור זמן <IANA>` (`timezone <IANA>`) | Set timezone manually (e.g. `אזור זמן America/Los_Angeles`). |

Default: auto-detected from your phone's country code on first message.

---

## Behind-the-scenes commands (rarely needed)

| Command | Effect |
|---|---|
| `מחק אחרון` (`delete last`) | Delete the most recently logged expense. |
| `סטטיסטיקה` | Detailed monthly stats. |

---

## What the bot does NOT do (by design)

- Does NOT connect to your bank account — no Open Banking integration
- Does NOT store your data on Kesefle servers — only in YOUR Google Sheet
- Does NOT read your other WhatsApp chats — only messages addressed to the bot
- Does NOT send marketing messages — every reply is a response to your message OR a scheduled digest

---

## Required Apps Script Properties

- `WHATSAPP_TOKEN` — Meta access token (required for replies)
- `WHATSAPP_PHONE_NUMBER_ID` — `1090404180828069`
- `SHEET_ID` — master template Sheet ID
- `ANTHROPIC_API_KEY` — Claude (categorization + correction + receipt OCR)
- `OPENAI_API_KEY` — optional (voice messages only)
- `VERCEL_KV_REST_URL` + `VERCEL_KV_REST_TOKEN` — required for family + global learning + timezone storage
- `KESEFLE_BOT_SECRET` — multi-tenant phone linking
- `FAMILY_TEMPLATE_SHEET_ID` — required for `הקמת משפחה` command
- `ALLOWED_PHONES` — optional, comma-separated whitelist (leave empty for production)

---

## Quick test sequence after each deploy

1. `סטטוס` → should reply with bot version + sheet status
2. `42 קפה` → should log expense + reply with correction hint
3. `קטגוריה אוכל בחוץ` → should ask to confirm
4. `כן` → should reply "תוקן" + LLM-extracted keywords
5. `לימוד` → should show "קפה" in the list
6. `מנויים` → should show detected subscriptions (or empty list)
7. `מטרות` → should show empty goals list or active ones
8. `תקציבים` → should show category pace status

If any of these fail, check the Apps Script Execution log for stack traces.
