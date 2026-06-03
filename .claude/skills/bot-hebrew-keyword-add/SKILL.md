---
name: bot-hebrew-keyword-add
description: Append N new Hebrew keywords to CATEGORY_MAP in bulk without breaking grammar or duplicates — edits ExpenseBot_FIXED.gs, runs test_classify.js + golden_set.js, prints a delta report.
---

# Bulk-add Hebrew keywords to CATEGORY_MAP

`CATEGORY_MAP` is the bot's primary classifier table (`bot/ExpenseBot_FIXED.gs:271`). Adding 5–50 keywords at once happens often (new vendor names, new slang). This skill is the safe pattern: dedupe, validate, test, report. The atomic 1-keyword version lives in `bot-add-keyword`; this is the bulk variant.

## Steps

1. Collect the new keywords as `{ keyword, category, subcategory }` rows. Hebrew-only entries should be UTF-8 NFC (precomposed). Validate:
   ```
   node -e 'const a=process.argv.slice(1);for(const s of a){const nfc=s.normalize("NFC");if(nfc!==s){console.error("not-NFC:",s);process.exit(1)}}' "מילה1" "מילה2" "..."
   ```
2. Check for duplicates against the existing map:
   ```
   for kw in "קפה" "דלק" "..." ; do
     grep -nF "'$kw'" bot/ExpenseBot_FIXED.gs | grep -E "keywords\s*:" || echo "NEW: $kw"
   done
   ```
3. Open `bot/ExpenseBot_FIXED.gs`. Find the matching `{ keywords: [...], category, subcategory }` entry. If category+subcategory already exists, append the new keywords to that entry's `keywords` array (don't create a duplicate entry). Otherwise add a new entry near similar vocab.
4. Reject anything too short or too ambiguous:
   - Length < 2 chars → reject (`בר`, `גט`).
   - A whole-word common Hebrew preposition (`של`, `על`, `את`) → reject.
5. For every keyword added, append at least one golden-set entry:
   ```
   // tests/golden_set.js — example shape; match existing
   { input: 'XXX 50', expectedCategory: 'YYY', expectedSubcategory: 'ZZZ' },
   ```
6. Run:
   ```
   node --check bot/ExpenseBot_FIXED.gs
   node bot/test_classify.js
   node tests/golden_set.js
   ```
7. Print a delta report: keyword | category | result-before | result-after. The golden-set runner already prints accuracy; eyeball it.

## Verification
- `node tests/golden_set.js` accuracy ≥ pre-change baseline.
- No "ambiguous keyword" warning printed.
- `grep -c "function matchCategorySmart\b" bot/ExpenseBot_FIXED.gs` returns 1 (you didn't accidentally duplicate the function).
- `bot/test_classify.js` exits 0.

## Common pitfalls
- Adding a keyword in TWO entries (first match wins → silent miscategorization).
- Skipping the golden-set rows → no regression guard. Always add at least 1 per keyword.
- Hebrew niqqud in the source vs niqqud-stripped user text → match fails. Use bare consonantal form in `CATEGORY_MAP`.
- Forgetting to reassemble `ExpenseBot_DEPLOY.gs` after the edit — see `bot-deploy-paste`.

## Examples
- "Add 20 new vendor names from last month's bank import" → run this, deploy.
- "Steven sent me a list of slang words for 'lunch'" → bulk-append under `אוכל / מסעדה`, deploy.
