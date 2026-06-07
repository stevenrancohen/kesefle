---
name: kesefle-worktree-parallel-setup
description: Set up isolated git worktrees so parallel file-editing Kesefle agents don't stomp each other's index - one branch per wave (git worktree add /tmp/wt-X -b agent/wave-X origin/main), integrate via PR, clean up after.
---

# Isolated worktrees for parallel agents

Multiple file-editing agents in the SAME working copy corrupt each other's git index and overwrite each other's edits - the classic Kesefle parallel-agent failure. The fix is one git worktree per agent/wave: each gets its own directory + branch + index off a shared `.git`, so edits never collide. They integrate back via PRs (agents never push main).

## Steps
1. Always branch each worktree off up-to-date main: `git fetch origin` first.
2. Create one worktree per wave/agent, each on its own branch from `origin/main`:
   ```
   git worktree add /tmp/wt-qa      -b agent/wave-qa       origin/main
   git worktree add /tmp/wt-keywords -b agent/wave-keywords origin/main
   git worktree add /tmp/wt-skills   -b agent/wave-skills   origin/main
   ```
   Use a meaningful slug per wave (qa / keywords / skills / audit) - it becomes the branch name and the chip/PR title.
3. Point each agent at its OWN absolute worktree path as its working directory. Agents must use absolute paths (the agent shell resets cwd between bash calls).
4. Each agent commits only inside its worktree/branch. No agent touches another's directory; no agent checks out main.
5. Integrate: open a PR per branch, or fold a wave into one integration PR ([[kesefle-pr-stack-bundle]]) when branches collide in `tests/full_qa.js` / `bot/ExpenseBot_FIXED.gs`. Gauntlet-gate before handing to Steven.
6. Clean up when merged: `git worktree remove /tmp/wt-<slug>` (add `--force` only if it refuses on a dirty tree you've already captured). Then `git branch -d agent/wave-<slug>` once the PR is merged. `git worktree prune` clears stale metadata.

## Naming convention
- Directory and branch slug match the wave's job: `/tmp/wt-qa` + `agent/wave-qa`, `/tmp/wt-keywords` + `agent/wave-keywords`, `/tmp/wt-skills` + `agent/wave-skills`. The slug becomes the PR title and the spawn-task chip label, so keep it a short, ASCII, verb-or-noun phrase.
- One wave can host several agents only if they edit DISJOINT files; the moment two agents would touch `tests/full_qa.js` or `bot/ExpenseBot_FIXED.gs`, give them separate worktrees.

## Verification
- `git worktree list` shows each active worktree on its distinct `agent/wave-*` branch; none on `main`.
- In each worktree, `git status` is independent - a change in one does not appear in another.
- After `git worktree remove`, `git worktree list` no longer shows it and the directory is gone.
- Each branch passes `npm run gauntlet` on its own before integration.

## Common pitfalls
- Spawning two agents in the same checkout (or two worktrees on the SAME branch) - index stomping returns; one branch per worktree.
- Branching a worktree off a stale local main instead of `origin/main` - fetch first ([[branch-from-main]]).
- `rm -rf /tmp/wt-X` instead of `git worktree remove` - leaves dangling worktree metadata; use the git command (or `git worktree prune` to repair).
- Letting a bot-file edit in a worktree go live without re-paste - `bot/ExpenseBot_FIXED.gs` ships by manual paste; reassemble DEPLOY.gs at integration ([[bot-deploy-paste]]).
- Forgetting agents never push main - every worktree's output reaches main only through a PR Steven merges.
- Creating a worktree under a path another tool/session already owns - pick a fresh `/tmp/wt-<slug>`; `git worktree add` refuses an existing non-empty dir.
