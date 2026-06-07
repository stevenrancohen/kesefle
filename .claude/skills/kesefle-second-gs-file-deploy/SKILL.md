---
name: kesefle-second-gs-file-deploy
description: Use when shipping a SECOND Apps Script data file (ExpenseBot_KEYWORDS.gs) into the same bot project beside ExpenseBot_DEPLOY.gs as a paste-once data-only file, without duplicate top-level symbols breaking the bot.
---

# Deploy a second .gs data file into the bot project

The bot is one Apps Script project pasted from `bot/ExpenseBot_DEPLOY.gs` (~1.38 MB). When keyword/taxonomy data outgrows that single file, you split a DATA-ONLY companion `bot/ExpenseBot_KEYWORDS.gs` that Steven pastes ONCE as a second file in the same project. Apps Script concatenates all `.gs` files into one global scope before running, so a duplicate top-level `function` or `var` in the second file silently shadows or fatally re-declares the one in `ExpenseBot_DEPLOY.gs` and kills the live bot. This skill keeps the second file additive and paste-safe. Precedent: `bot/KESEFLE_KEYWORDS_v2.gs`, `bot/KESEFLE_KEYWORDS_EXTRA_v3.gs`.

## Steps
1. Confirm the data belongs in a companion, not the main file.
   - A second file is right ONLY for pure data plus one accessor, e.g. a `KEYWORDS_PACK_2` object and a `function _kflKeywordsPack2_(){ return KEYWORDS_PACK_2; }`.
   - Anything touching routing, tenant resolution, or sheet writes stays in `bot/ExpenseBot_FIXED.gs`.
2. Author `bot/ExpenseBot_KEYWORDS.gs` as ASCII-escaped Hebrew per the `sheet-hebrew-encoding-safe-script` skill.
   - Every Hebrew keyword as `\uXXXX` so chat-paste / browser bidi never corrupts it before it reaches the editor.
3. Guarantee zero symbol collision with the main file. For every top-level name in the new file run:
   ```
   grep -oE '^(function |var |const |let )[A-Za-z0-9_]+' bot/ExpenseBot_KEYWORDS.gs \
     | awk '{print $2}' \
     | while read s; do echo -n "$s: "; grep -c "\b$s\b" bot/ExpenseBot_DEPLOY.gs; done
   ```
   - Any count `>0` means a clash - rename the new symbol (prefix `_kfl...Pack2_`) before going further.
   - This is THE trap that has broken the bot before (duplicate `FPT_/AYD_/WEN_/DB_` re-declared from old files).
4. Syntax-check: `node --check bot/ExpenseBot_KEYWORDS.gs` (catches gross errors; Apps Script is ~ES5).
5. Wire the consumer in `bot/ExpenseBot_FIXED.gs` behind a `typeof` guard so the bot still boots if file 2 isn't pasted yet:
   ```
   if (typeof _kflKeywordsPack2_ === 'function') { /* merge pack into the matcher */ }
   ```
   - Never call the pack accessor unguarded.
6. Reassemble `bot/ExpenseBot_DEPLOY.gs` from `bot/ExpenseBot_FIXED.gs` per the `bot-deploy-paste` skill.
   - The companion file is NOT folded into DEPLOY.gs - it ships as its own separate paste.
7. Bump `KFL_BUILD_VERSION` (`bot-version-bump`) so the heartbeat proves file 2 landed.
8. Run the gate: `node tests/full_qa.js && node tests/golden_set.js && node bot/test_classify.js && node bot/test_isolation.js`.
   - Add golden-set rows for any new keyword so accuracy is anchored (`golden-set-update`).
9. Send Steven the two-file paste, in order, as numbered steps (he is non-technical):
   1) Apps Script editor -> open the existing `ExpenseBot_DEPLOY` file -> paste the updated `bot/ExpenseBot_DEPLOY.gs`.
   2) Click `+` (new file) -> name it `ExpenseBot_KEYWORDS` -> paste `bot/ExpenseBot_KEYWORDS.gs`.
   3) Deploy -> New Version.
   4) Send `בדיקה` ("diag") from 972547760643 to confirm the new build is live.

## Verification
- `node bot/bot-replay.js --json "<a message that needs a pack-2 keyword>"` predicts the new category - proves the merge is reachable in the real classify path (no live write).
- After paste, Steven sends `בדיקה` from 972547760643; the self-check reply shows the bumped `KFL_BUILD_VERSION` (handler near line 8853 of `bot/ExpenseBot_FIXED.gs`).
- Full gauntlet green: `node tests/full_qa.js && node tests/golden_set.js`.

## Common pitfalls
- Duplicate top-level symbol across the two files -> Apps Script re-declaration error takes the WHOLE bot offline. Step 3's grep is mandatory, not optional.
- Folding the keyword pack into `ExpenseBot_DEPLOY.gs` AND shipping it as file 2 -> defined twice, same crash. Pick one home; the companion stays separate.
- Calling `_kflKeywordsPack2_()` without the `typeof` guard -> bot dies for everyone the moment it deploys ahead of Steven pasting file 2.
- Raw Hebrew literals in the new file -> bidi/clipboard corruption silently mis-spells keywords; always `\uXXXX`-escape.
- Pasting the file into the standalone tools project instead of the bot project (or vice-versa) - these are SEPARATE Apps Script projects; the companion belongs only in the bot project. Never touch the old sheet 1UKrXDk... and never echo the secret VALUES of KESEFLE_BOT_SECRET / API keys when instructing Steven.
