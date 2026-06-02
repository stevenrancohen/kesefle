---
name: kesefle-bot-pr-bundle-before-merge
description: When multiple PRs each edit the same large file (bot/ExpenseBot_FIXED.gs), they pass "MERGEABLE" individually but mutually conflict once the first merges. Consolidate them into ONE union-resolved bundle PR before handing to Steven, so his morning is a single merge + single re-paste. Use whenever 2+ open PRs touch the bot file.
---

# Bundle bot PRs before handoff (don't make Steven resolve conflicts)

GitHub reports each PR "MERGEABLE" against *current* main — but three PRs that each branched from main and edited the same 16k-line `bot/ExpenseBot_FIXED.gs` will **conflict on the 2nd and 3rd merge**. Steven is non-technical and can't hand-resolve a 16k-line conflict. So consolidate first.

## Detect
After opening multiple PRs, check file overlap:
```
gh pr list --state open --json number,files | \
 python3 -c "import json,sys,collections;o=collections.defaultdict(list);[o[f['path']].append(p['number']) for p in json.load(sys.stdin) for f in p['files']];[print(f,n) for f,n in o.items() if len(n)>1]"
```
Any shared `bot/ExpenseBot_FIXED.gs` / `tests/golden_set.js` across PRs ⇒ bundle them.

## Bundle (worktree, union-resolve)
1. `git worktree add -B feat/bot-night-bundle /tmp/b origin/<biggest-branch>` (start from the one with the most/foundational change).
2. `git merge --no-edit origin/<branch2>` then `<branch3>`. Conflicts are almost always: (a) the `KFL_BUILD_VERSION` line → collapse to ONE final value; (b) adjacent CATEGORY_MAP keyword rows → **keep the union of both sides' added keywords** (verify against the 3-way base blob, don't guess). golden_set.js usually auto-merges.
3. Ignore any conflicted `ExpenseBot_DEPLOY.gs` — **regenerate it fresh** (`head -95 DEPLOY + tail -n +21 FIXED`), then `node --check` (.js copy), one `doPost`, byte-identical to the reassembly.
4. Re-run the gauntlet (golden ≥ prior, full_qa, bot suites, isolation). Confirm ALL feature-sets survived the merge (grep each PR's signature function/keyword).
5. Open ONE bundle PR titled "supersedes #A/#B/#C"; tell Steven: merge the bundle, ONE re-paste, then close the originals. See [[kesefle-bot-deploy-bundling-and-merge-order]], [[multi-pr-trap]], [[bot-deploy-paste]].
