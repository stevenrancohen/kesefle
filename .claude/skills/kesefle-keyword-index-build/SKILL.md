---
name: kesefle-keyword-index-build
description: Build/refresh the embedded keyword index bot/ExpenseBot_KEYWORDS.gs (ASCII \u-escaped) from bot/keywords/packs/*.json: merge, dedup, collision-resolve, then wire the additive fallback after CATEGORY_MAP.
---

# Build the embedded keyword index from packs

Turns the human-editable `bot/keywords/packs/*.json` buckets ([[kesefle-keyword-pack-author]]) into one generated, paste-safe `bot/ExpenseBot_KEYWORDS.gs` whose Hebrew is fully `\u`-escaped so clipboard/browser-bidi/chat-paste cannot corrupt it before it reaches the Apps Script editor. The index is an ADDITIVE fallback: `matchCategory` in `bot/ExpenseBot_FIXED.gs` keeps `const CATEGORY_MAP = [...]` as the primary table and consults this index only when CATEGORY_MAP yields no hit — so the build never weakens an existing correct match.

## Steps
1. Read every `bot/keywords/packs/*.json`. Validate each is a single `{category,subcategory,isIncome,keywords[]}` bucket; a malformed pack aborts the build (do not emit a half index).
2. Merge into one in-memory list of `{keyword, category, subcategory, isIncome}` rows, one row per keyword. Carry `isIncome` verbatim — it decides col H sign downstream.
3. Dedup: drop exact-duplicate keyword strings. For a string that is a substring of a longer keyword in the SAME bucket, keep only the longer (it already matches).
4. Collision-resolve across buckets (same keyword, different bucket): resolve by an explicit, recorded bucket priority (income buckets before expense buckets; specific subcategory before catch-all `שונות`). Never silently keep both — log each resolved collision and its winner. A collision that would SIGN-FLIP (income vs expense) must be resolved toward the safe bucket or flagged for Steven, never auto-dropped blind.
5. Sort the final rows longest-keyword-first so the emitted index honors the same specific-wins order as CATEGORY_MAP's length-sort.
6. Emit `bot/ExpenseBot_KEYWORDS.gs`: a single `var KESEFLE_KEYWORD_INDEX = [...]` (or `{...}`) where EVERY Hebrew character is a `\uXXXX` escape and the file is otherwise ASCII-only — mirror the encoding discipline in [[sheet-hebrew-encoding-safe-script]]. Header comment: GENERATED, do-not-hand-edit, edit packs + rerun.
7. Wire the fallback once: in `bot/ExpenseBot_FIXED.gs`, after the CATEGORY_MAP lookup returns nothing, consult `KESEFLE_KEYWORD_INDEX` and return its `{category,subcategory,isIncome}`. Keep it additive — do not remove or reorder CATEGORY_MAP rows. This is a `bot/ExpenseBot_FIXED.gs` change, so it ships via manual paste ([[bot-deploy-paste]]); reassemble `bot/ExpenseBot_DEPLOY.gs` after.
8. Add/refresh `tests/golden_set.js` anchors for any routing now served by the index so the gauntlet guards it.

## Collision-resolution example
Two packs both claim `מכירה`: the income pack (`מחזור`, `isIncome:true`) and a granularity expense pack. Income priority wins, the loser row is dropped, and the event is logged so the decision is auditable:
```
COLLISION  keyword="מכירה"
  income:עסק/מחזור  vs  expense:עסק/שונות
  -> kept income (sign-flip guard), dropped expense
```
The emitted file is ASCII-only — every Hebrew char is a `\uXXXX` escape (e.g. `מכירה` -> `מכירה`):
```js
// GENERATED from bot/keywords/packs/*.json -- do not hand-edit; edit packs + rerun.
var KESEFLE_KEYWORD_INDEX = [
  {"keyword":"מכירה","category":"עסק",
   "subcategory":"מחזור","isIncome":true}
];
```

## Verification
- `node -e "JSON.parse(require('fs').readFileSync('bot/keywords/packs/<f>.json','utf8'))"` on each pack, then confirm `bot/ExpenseBot_KEYWORDS.gs` parses: `node -e "require('vm').runInNewContext(require('fs').readFileSync('bot/ExpenseBot_KEYWORDS.gs','utf8'))"`.
- ASCII-only gate on the generated file: `node -e "const s=require('fs').readFileSync('bot/ExpenseBot_KEYWORDS.gs','utf8'); if(/[^\x00-\x7F]/.test(s)) throw new Error('non-ASCII leaked — escaping incomplete')"`.
- Replay a pack-only keyword (one absent from CATEGORY_MAP) through the real logic: `node bot/bot-replay.js "350 <keyword>"` resolves via the index to the right bucket and sign.
- `npm run gauntlet` (full QA + bot/test_*.js + `tests/golden_set.js` via `tests/full_qa.js`) is green; accuracy goes UP with zero regressions vs the prior run.

## Common pitfalls
- Leaving any raw Hebrew in `bot/ExpenseBot_KEYWORDS.gs` — bidi/clipboard will mangle it on paste; the ASCII gate above must pass.
- Letting the index OVERRIDE CATEGORY_MAP instead of falling back — that can flip a previously-correct route; it is fallback-only.
- Dropping a sign-flip collision silently (income keyword swallowed by an expense bucket) — resolve toward the safe bucket or flag, never blind-drop.
- Hand-editing the generated file — the next build overwrites it; edit the packs and rerun.
- Forgetting the manual re-paste: regenerating the file changes nothing live until `bot/ExpenseBot_DEPLOY.gs` is reassembled and pasted into Apps Script. Agents never push main; the owner phone 972547760643 and the active tenant sheet wiring stay untouched (never repoint at the retired legacy sheet). Never echo secret values in build logs.
