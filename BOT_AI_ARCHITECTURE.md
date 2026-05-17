# Kesefle Bot — Smart Categorization Architecture

How the bot decides which category an incoming expense belongs to.

## Three-tier intelligence (in order)

When the bot receives a message like `"245 wolt דאלי"`, it tries
three sources in order. The first one that returns a confident answer
wins; the rest are skipped.

### Tier 1 — Learned cache (`מילון לימוד` tab)

A sheet tab in your Google Sheet. Schema:
```
keyword | category | subcategory | source | updated_at
```

- The bot auto-creates this tab the first time it needs it.
- Every successful LLM call writes its result here so the next time
  the same vendor appears, the bot skips the API call entirely.
- You can also write rows manually to teach the bot
  custom mappings — e.g. `"גלידריה של אבי" | אוכל | אוכל בחוץ | user | 2026-05-17`.
- Lookup is **substring-based**: if any learned keyword appears
  inside the message, the longest match wins.
- The bot caches the tab in memory for 60s within a single execution
  to avoid re-reading the sheet on every message.

**Cost:** free. Latency: ~50ms.

### Tier 2 — Keyword map (`CATEGORY_MAP` constant)

A static list of 1,480 keywords across 77 category/subcategory groups.

Coverage (as of v35):
- **~30 Israeli supermarket chains** (Shufersal, Rami Levy, Yochananof,
  Tiv Taam, AM:PM, Hatzi Hinam, etc.)
- **~50 restaurants/cafes** (Wolt, Cibus, Aroma, Greg, Cofix, McDonald's,
  KFC, BBB, Roladin, Pizza Hut, Domino's, Japanika, Wasabi, etc.)
- **~15 Israeli banks + credit cards + fintech** (Hapoalim, Leumi,
  Mizrahi, Discount, FIBI, Isracard, Cal, Max, Amex, PayPal, Bit,
  Paybox, eToro, Plus500, One Zero)
- **~25 insurance providers** (Harel, Clal, Migdal, Phoenix, Menorah,
  Ayalon, AIG, Shirbit, Shomera, Hachshara, etc.)
- **All 4 HMOs + 25+ hospitals** (Clalit, Maccabi, Meuhedet, Leumit,
  Sheba, Ichilov, Hadassah, Rambam, Soroka, etc.)
- **All ~50 water utilities** by city (Mei Avivim, Hagihon, Mei Carmel,
  Mei Modi'in, etc.) + gas (Pazgas, Amisragas, Supergas, Dorgas)
- **All major telecom** (Partner, Cellcom, Pelephone, Hot Mobile,
  Golan, We4G, 012, 014, 015, Bezeq, Yes, Sting TV, etc.)
- **Transit**: Egged, Dan, Metropolin, Kavim, Israel Railways, Light
  Rail, Carmelit + Israeli + global airlines (El Al, Israir, Arkia,
  Ryanair, EasyJet, Wizz, Turkish, Lufthansa, etc.)
- **200+ subscription services**: Netflix, Spotify, Apple Music, Disney+,
  HBO Max, Audible, ChatGPT, Claude, Cursor, GitHub Copilot, Figma,
  Notion, MasterClass, NordVPN, Vercel, AWS, etc.
- **Government**: Bituach Leumi, Mas Hachnasa, MDA, Mishrad HaRishuy,
  Israel Post, Police, all major municipalities by name
- **Online retail**: Amazon, AliExpress, SHEIN, eBay, Booking, Airbnb,
  Expedia, Kayak, Hostelworld, all major platforms

Match is **substring-based and longest-first**: if a message contains
multiple keywords, the longest one wins (so "פיצה הוט" beats "פיצה"
alone).

**Cost:** free. Latency: ~5ms.

### Tier 3 — LLM fallback (Claude Haiku 3.5)

Triggered only when tiers 1+2 return `שונות / שונות` (the "I don't
know" answer). Sends a tightly-scoped prompt to
`api.anthropic.com/v1/messages`:

```
תקטלג את תיאור ההוצאה הישראלית הבא לקטגוריה.
תיאור: "<message>"
החזר אך ורק שורה אחת בפורמט "קטגוריה / תת-קטגוריה" — בלי הסבר.
קטגוריות חוקיות: הכנסות, אוכל, תחבורה, הוצאות קבועות, ...
דוגמאות:
"wolt" → אוכל / אוכל בחוץ
"ארנונה" → הוצאות קבועות / בית
"netflix" → הוצאות קבועות / אפליקציות
...
```

The model returns a single line, the bot parses it, validates the
category against the whitelist, and writes the result back to the
learning cache so future calls are instant + free.

**Cost:** ~$0.0001 per call (`claude-3-5-haiku-20241022`, 30 input
tokens + 10 output). Latency: ~800ms.

**Failure mode:** if the API is down, the key is missing, or the
response is malformed, the bot returns `null` and falls through to
the default category gracefully. The bot never blocks on AI.

## Setup

### Required (already done if v34+ is deployed)
- `WHATSAPP_TOKEN` in Apps Script properties — for replies to user
- Drive + Sheets APIs enabled in Google Cloud project 191938738571

### Optional — to enable AI fallback
1. Get an Anthropic API key: https://console.anthropic.com/settings/keys
2. Apps Script → ⚙️ Project Settings → Script Properties → Add:
   - Property: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-api03-...`
3. Save.

Without the key, the bot still works — it just falls back to
`שונות` for vendors not in CATEGORY_MAP (which should be rare given
the 1,480 keywords).

## How to teach the bot a new word

Two ways:

1. **Manually edit the `מילון לימוד` tab** in your Google Sheet:
   Add a row with `keyword | category | subcategory | user | <today's date>`.
   
2. **Wait for AI fallback** to handle it automatically. After one
   successful AI call, the answer is cached forever in the same tab.
   Future occurrences of the same vendor will be instant + free.

## Pricing per 1,000 messages (worst case)

| Tier | Hit rate (estimate) | Cost |
|---|---|---|
| Cache | 30% (returning vendors) | $0.00 |
| Keywords | 65% (known vendors) | $0.00 |
| LLM | 5% (truly novel) | $0.005 ≈ **₪0.02** |

Bot is essentially free to run at scale.

## Files

- `bot/ExpenseBot_FIXED.gs` — main bot code (1670 lines, including
  the 1480-keyword CATEGORY_MAP at the top)
- `_aiCategorize()` — defined ~line 690, the Claude API call
- `_learnedLoad / _learnedLookup / _learnedSave` — defined ~line 770,
  the cache logic
- `teachCategory(text, cat, sub)` — public API for future
  WhatsApp commands like `/לימוד`
