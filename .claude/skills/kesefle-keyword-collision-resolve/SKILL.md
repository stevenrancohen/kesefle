---
name: kesefle-keyword-collision-resolve
description: Resolve a keyword that maps to two different buckets across bot/keywords/packs/*.json — pick the winner by specificity then recorded bucket priority, never sign-flip, log the decision, and anchor it in the golden set.
---

# Resolve a cross-pack keyword collision

Keyword vocab for the Kesefle classifier lives as human-editable buckets in `bot/keywords/packs/*.json`, each a single `{category, subcategory, isIncome, keywords[]}` object ([[kesefle-keyword-pack-author]]). [[kesefle-keyword-index-build]] merges them into the generated, `\u`-escaped `bot/ExpenseBot_KEYWORDS.gs`, an ADDITIVE fallback consulted by `matchCategory` in `bot/ExpenseBot_FIXED.gs` only after `const CATEGORY_MAP = [...]` yields no hit. A collision = the SAME keyword string appears in two different packs' `keywords[]`. The merged index is sorted longest-keyword-first (specific wins), so an unresolved equal-length collision routes by accident, and the worst case is a SIGN-FLIP (an income keyword swallowed by an expense bucket, or vice versa) booking revenue as a cost on the dashboard. This skill is the standalone deep-dive that the index builder's collision step delegates to.

## When to use
- The index builder logged a collision and you must choose the winner deliberately.
- A keyword you are about to add already exists in another pack (surfaced by [[kesefle-keyword-quality-audit]] step 5).
- A user reports an expense landing in the wrong bucket and replay shows two packs both claim the token.

## Steps
1. Find every pack that owns the token. From repo root:
   ```
   node -e "const fs=require('fs'),d='bot/keywords/packs';for(const f of fs.readdirSync(d)){const p=JSON.parse(fs.readFileSync(d+'/'+f,'utf8'));if((p.keywords||[]).includes(process.argv[1]))console.log(f,'->',p.category+' / '+p.subcategory,'isIncome='+!!p.isIncome)}" "<token>"
   ```
   Two or more lines = a real cross-pack collision. One line = not a collision (it may be an intra-pack substring dup — that is [[kesefle-keyword-pack-author]] dedup, not this).
2. Classify the collision before choosing:
   - SIGN-FLIP (one pack `isIncome:true`, the other `false`) — highest severity; the wrong winner mis-signs col H on the dashboard.
   - Same-sign, different subcategory — picks which dashboard row sums it.
3. Pick the winner by the matcher's own order, in this precedence:
   - Specificity first: the index is length-sorted longest-keyword-first, so a longer disambiguated phrase already beats a bare token. Prefer NOT having the bare token in the wrong pack — replace it with the specific phrase (e.g. keep `"החזר מעמ"` in the income pack, not bare `"מעמ"`; real case PR #199/#200 booked a VAT refund as a company expense).
   - Recorded bucket priority next (the order the index builder enforces): income buckets before expense buckets; a specific subcategory before the catch-all `שונות`.
4. Apply additively in the PACKS, never in `bot/ExpenseBot_FIXED.gs`:
   - Remove the token from the LOSING pack's `keywords[]` (or replace it with a longer, unambiguous phrase that no longer collides).
   - Leave the winning pack as-is, or add the disambiguated phrase there.
   - A removal that strips genuinely useful vocab from the loser is a judgement call — flag it for Steven rather than silently deleting reach.
5. Record the decision: a one-line `// collision: <token> -> <winner pack> (<reason>)` note in the PR description, so the builder's resolution log and the human trail agree. Never resolve a sign-flip blind — toward the safe bucket or flag.
6. Anchor it: add a `tests/golden_set.js` line for the disputed message with its correct `category`/`subcategory` (or `sub:`/`DEFAULT`) label so the gauntlet guards the chosen winner.
7. Rebuild + ship: rerun [[kesefle-keyword-index-build]] so `bot/ExpenseBot_KEYWORDS.gs` regenerates with the token in exactly one bucket, then reassemble `bot/ExpenseBot_DEPLOY.gs` for the MANUAL Apps Script paste ([[bot-deploy-paste]]). Nothing is live until Steven pastes it.

## Verification
- Re-run the step-1 one-liner: the token now resolves to exactly ONE pack.
- Replay the disputed message read-only: `node bot/bot-replay.js "350 <message>"` shows the chosen `category`/`subcategory` and correct `isIncome` sign, not the old loser.
- `node tests/golden_set.js` exits 0; the new anchor passes and net accuracy does not drop (prior misses stay byte-identical).
- `npm run gauntlet` (full QA + `bot/test_*.js` + `tests/golden_set.js` via `tests/full_qa.js`) is green with zero regressions vs the prior run.

## Common pitfalls
- Resolving a sign-flip toward the higher-priority-by-accident bucket instead of the SAFE one — confirm the income/expense sign is right before anything else.
- "Fixing" a one-line result (no real collision) and weakening a correct match — confirm step 1 prints two-plus packs first.
- Editing the generated `bot/ExpenseBot_KEYWORDS.gs` or `CATEGORY_MAP` directly: packs are the source; the index is regenerated and is fallback-only, never an override of CATEGORY_MAP.
- Deleting a short token to break a tie when a longer disambiguating phrase would do — the bare token may be load-bearing elsewhere; prefer adding specificity to the winner.
- Forgetting the manual re-paste, so the resolved collision never reaches the live bot. Agents never push main; the owner phone 972547760643 and the active tenant sheet wiring stay untouched (never repoint at the retired legacy sheet). Never echo secret values in logs.
