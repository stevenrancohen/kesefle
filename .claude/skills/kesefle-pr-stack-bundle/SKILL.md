---
name: kesefle-pr-stack-bundle
description: Bundle N green agent branches into ONE integration PR, union-resolving the recurring tests/full_qa.js merge cascade so the gauntlet stays green; steer agents to add standalone tests/*.js instead of editing full_qa.js.
---

# Bundle a stack of agent branches into one PR

When a wave of parallel agents each opens a branch, they pass the gauntlet individually but collide on merge - almost always inside `tests/full_qa.js` (everyone appends an `ok(...)`) and `bot/ExpenseBot_FIXED.gs`. Rather than hand Steven N conflicting PRs, consolidate into ONE union-resolved integration PR that's green, so his morning is a single merge (+ one re-paste if the bot changed). Agents never push main; the integration branch goes up as a PR for Steven to merge.

## Steps
1. Start clean from up-to-date main ([[branch-from-main]]): `git fetch origin && git checkout -b integ/wave-<N> origin/main`.
2. Merge each green agent branch in turn: `git merge --no-ff agent/<branch>`. Resolve conflicts as you go (don't batch all then resolve).
3. **The full_qa.js cascade**: the conflict is competing appended `ok(...)` blocks. Resolve by UNION - keep every agent's assertions, in a stable order, deleting only literal duplicates. Never drop an agent's assertion to make the merge clean (that silently removes their guard).
4. **The bot-file cascade**: `bot/ExpenseBot_FIXED.gs` conflicts are usually additive (new handler / new CATEGORY_MAP row). Union them; preserve `OWNER_PHONE = '972547760643'`, the active tenant-sheet wiring (never the retired legacy sheet id), and the echo-loop regexes. If two agents edited the same function body, hand-merge semantically.
5. If the bot file changed at all, reassemble `bot/ExpenseBot_DEPLOY.gs` from FIXED ([[bot-deploy-paste]]) so the deploy artifact matches - and the PR description tells Steven a re-paste is needed.
6. Run `npm run gauntlet`. Fix any real regression ([[kesefle-gauntlet-triage]]) - never by weakening a check.
7. Open ONE PR `integ/wave-<N>` against main, body listing each folded-in branch + whether a bot re-paste is required.

## Prevent the cascade next time
- Tell producer agents: add NEW standalone suites under `tests/*.js` (auto-discovered by the gauntlet's group 2) instead of editing `tests/full_qa.js`. Two new files never conflict; two appends to one file always do.
- Reserve `tests/full_qa.js` edits for changes to an existing shared contract; new coverage = new file.
- Same rule for the bot: prefer a new `bot/test_*.js` over appending to a shared one, so two keyword/handler waves don't collide there either.

## Merge order within the wave
- Merge the smallest / least-conflicting branch first, the bot-file-touching branch last - fewer rebases of the big `bot/ExpenseBot_FIXED.gs` diff.
- If an agent's branch is stale vs main, rebase it onto `origin/main` before merging into the integration branch, so the only conflicts you resolve are real cross-agent ones, not main drift.

## Verification
- `npm run gauntlet` exits 0 on `integ/wave-<N>` - `tests/full_qa.js` plus every standalone suite pass together.
- Assertion accounting: total `ok(...)`/suite count on the integration branch >= the sum across the source branches (union kept everything). `grep -c "ok(" tests/full_qa.js` is not less than any single source branch.
- If the bot changed: `node bot/test_isolation.js` passes and `bot/ExpenseBot_DEPLOY.gs` was regenerated (its body matches FIXED).
- The PR body lists every folded-in branch and flags whether a re-paste is required, so Steven's one merge + at-most-one re-paste covers the whole wave.

## Common pitfalls
- "Take theirs" / "take ours" on a full_qa conflict - silently deletes one side's guard. Always union.
- Folding in a branch that wasn't independently green - fix it on its own branch first, then bundle.
- Forgetting the DEPLOY.gs reassembly after a FIXED.gs union - the PR looks done but the live bot would run old code on paste.
- Pushing more commits to an already-merged source branch instead of the integration branch ([[multi-pr-trap]]).
- Letting a merge silently reintroduce the legacy sheet id or swap the owner/public number - re-run [[kesefle-bot-number-config-check]] after the union.
- Squashing away an agent's authorship/intent in the integration commit - keep `--no-ff` merge boundaries so each folded-in wave stays traceable in the PR.
