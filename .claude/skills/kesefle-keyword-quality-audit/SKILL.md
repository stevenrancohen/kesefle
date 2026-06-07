---
name: kesefle-keyword-quality-audit
description: Audit a bot/keywords/packs/*.json pack before merge - reject off-bucket, generic, or garbage keywords, enforce the Hebrew vs Latin script split, dedup, and flag cross-pack collisions, so accuracy rises with no regression.
---

# Audit a keyword pack before merge

Keyword packs (`bot/keywords/packs/*.json`, one `{category, subcategory, isIncome, keywords[]}` bucket each, [[kesefle-keyword-pack-author]]) are the human-editable source that [[kesefle-keyword-index-build]] merges into the generated `bot/ExpenseBot_KEYWORDS.gs` fallback after `CATEGORY_MAP`. The matcher does a length-sorted substring scan, so a single bad keyword — a bare 2-3 char word, a token that belongs in another `subcategory`, or junk — silently misroutes real Hebrew expenses into the wrong dashboard bucket, sometimes sign-flipping income vs expense. This audit is the gate that runs BEFORE a pack merges: it rejects filler and proves the change is additive. Run it on every new or edited pack.

## When to use
- Reviewing a new `bot/keywords/packs/*.json` file or a diff that adds keywords to an existing pack.
- Before invoking [[kesefle-keyword-index-build]] (a clean pack in, a clean index out).
- After someone hands Steven "a list of new words" and you are bulk-adding them.

## Steps
1. Validate + diff. Each pack must be one valid bucket object:
   ```
   node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));['category','subcategory','keywords'].forEach(k=>{if(!(k in p))throw new Error('missing '+k)});if(!Array.isArray(p.keywords))throw new Error('keywords not array')" bot/keywords/packs/<file>.json
   ```
   Then `git diff -- bot/keywords/packs/` and list every ADDED keyword against the pack's `subcategory`/`isIncome`.
2. Off-bucket check — for each added keyword ask "does its meaning match THIS bucket's subcategory?" Real traps to mirror: an ad-spend phrase like `בוסט לפוסט` must NOT sit in a restaurant pack (it would be caught by `פוסט`); `מגדל ביטוח` belongs in insurance, not a PC-tower `מגדל`. Reject or relocate every mismatch.
3. Generic / garbage check — reject any keyword that is:
   - An irreducibly ambiguous bare word (`בר`, `גט`, `פז`, `גז`, `ספר`): these must stay UNMATCHED so the bot ASKS — adding them breaks the never-corrupt floor. The real fix for a near-miss is the disambiguated phrase (`"החזר מעמ"` in an income pack, never bare `"מעמ"` — PR #199/#200).
   - Too short to be safe: a 2-3 char Hebrew fragment bleeds across messages; flag every one.
   - Non-vocabulary junk: stray punctuation, single letters, accidental duplicates.
4. Hebrew-vs-Latin split check — confirm the pack carries BOTH scripts wherever a brand/word exists in both (`פייסבוק`+`facebook`, `קפה`+`coffee`, `מע"מ`+`vat`). Mixed-script tokens like `meta ads` are fine; a brand present in only one script is a coverage hole — note it. And confirm no Latin-only token sits where the user only ever types Hebrew.
5. Sign check — if the pack is `isIncome:true` (revenue), every keyword must denote money IN; an expense-looking word in an income pack (or vice versa) is a silent col-H sign-flip on the dashboard. This is the single most damaging defect — verify it explicitly.
6. Dedup + collision check:
   - Intra-pack: no repeated strings, and drop any string that is a substring of a longer keyword in the SAME pack (the longer already covers it).
   - Cross-pack: confirm each new keyword does not already live in a DIFFERENT pack; if it does, hand off to [[kesefle-keyword-collision-resolve]] before merge.
7. Reject filler explicitly: strip the bad keywords from the diff, leave a `// rejected: <keyword> (<reason>)` note in the PR description, keep only vocab that survives steps 2-6. Add a `tests/golden_set.js` anchor for each genuinely new routing claim (granularity-only adds that sum to the same dashboard row need none).

## Verification
- The JSON validator in step 1 passes on the audited pack.
- Replay a representative KEPT keyword read-only: `node bot/bot-replay.js "350 <keyword>"` lands in the intended bucket with the right `isIncome`, not the `שונות` fallback.
- `node tests/golden_set.js` exits 0; accuracy is UP or equal with zero regression (prior misses byte-identical), and ambiguous bare words still resolve `DEFAULT`.
- `npm run gauntlet` (full QA + `bot/test_*.js` + `tests/golden_set.js` via `tests/full_qa.js`) is green.

## Common pitfalls
- Approving a keyword because it "could match" without checking it does not ALSO match a higher-priority pack first — that is a cross-pack collision, resolve it.
- Padding a pack with 20 weak synonyms to look thorough — it biases the matcher and inflates the diff; keep only what a real Israeli user actually types.
- Missing a sign-flip: an expense word in an `isIncome:true` pack mis-signs the dashboard; step 5 is not optional.
- Editing the generated `bot/ExpenseBot_KEYWORDS.gs` or `CATEGORY_MAP` to "fix" a pack — packs are the source; rerun [[kesefle-keyword-index-build]] instead.
- Reporting a pack fix as done off a green local run alone: nothing ships until [[kesefle-keyword-index-build]] regenerates and `bot/ExpenseBot_DEPLOY.gs` is reassembled and pasted ([[bot-deploy-paste]]). Agents never push main; never touch the owner phone 972547760643, the active tenant sheet wiring, or the retired legacy sheet; never echo secret values.
