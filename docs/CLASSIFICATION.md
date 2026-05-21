# Kesefle — How Expense Classification Works (and how to extend it)

Goal: **minimum misclassification.** When the bot isn't sure, it asks rather
than guessing wrong.

## The pipeline (for a message like "50 קפה")

1. **Parse** amount + description (`parseAmountAndDescription`). Strips digits,
   the ₪/$/€ symbols and currency words (שח, שקל, …) so "50 שח קפה" → "קפה".
2. **Learned cache** (`_learnedLookup`) — if the user already corrected this
   text, reuse their choice.
3. **Auto-synonyms** (`_autoSynonymLookup_`) — LLM-expanded synonyms.
4. **Keyword map** (`matchCategory` → `CATEGORY_MAP`, ~320 entries / ~21k
   keywords). **Longest matching keyword wins.**
5. **LLM fallback** (`_aiCategorize`, Pro) for unknown vendors.
6. **Ask** — if still unsure, send an interactive list of likely categories
   ("בחר/י את הקטגוריה הנכונה"); the pick is saved via `_learnedSave` so it's
   automatic next time. The user can also type **"תקן ל: <category>"** to fix
   the last row.

## The precision guard (why misclassification dropped)

Matching is **substring**-based (so "בשופרסל" still matches "שופרסל"). But short
keywords used to false-positive *inside* unrelated words — e.g. `רי` matched
חב**רי**ם → bakeries; `מים` matched תשלו**מים** → water. Fix (`_kflKwHit_`):

- **Keywords ≥ 4 chars:** substring match (brand names, prefixes work).
- **Keywords ≤ 3 chars:** must match as a **whole word** (bounded by space/
  start/end/punctuation). So "מים 120" → water, but "תשלומים" does **not**.

We also removed ~180 junk keywords (1–2 char + corrupted fragments + common
words like עוד/חבר/תשלום) and added ~180 curated phrase mappings.

## How to add more keywords SAFELY

1. Open `bot/ExpenseBot_FIXED.gs`, find `const CATEGORY_MAP = [`. The curated
   block is at the top.
2. Add an entry mapping to an **existing** `category` / `subcategory`
   (see the taxonomy — run the snippet in the commit history, or grep
   `subcategory:` in the file). Use **specific, ≥4-char phrases** when possible:
   ```js
   { "keywords": ["יוחננוף","טיב טעם","אושר עד"], "category": "אוכל", "subcategory": "אוכל לבית" },
   ```
3. Avoid 1–2 char keywords unless they're unambiguous whole words — they only
   match as whole words now, but still prefer longer.
4. **Add a test case** to `bot/test_classify.js`, then run it:
   ```
   node bot/test_classify.js
   ```
5. Re-assemble the deployable file and re-check:
   ```
   head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js && tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js && node --check /tmp/x.js && cp /tmp/x.js bot/ExpenseBot_DEPLOY.gs
   ```
6. Commit, push, then re-paste `ExpenseBot_DEPLOY.gs` into Apps Script (Deploy →
   New version).

## Tests (regression guards)
- `node bot/test_classify.js` — 68 realistic message → category checks.
- `node bot/test_parser.js` — amount/description parsing (incl. currency).
- `node tests/full_qa.js` — runs all of the above + isolation + sanitizer.

## Known next step
Per-tenant **daily learning** (read each user's sheet, detect manual category
edits, learn for them) is not built yet — it needs live multi-user data and
the tenant write bridge to support reads/updates. Tracked as a task. Today,
learning works in-chat (pick from the list / "תקן ל:") for the owner.
