---
name: branch-from-main
description: Start a clean branch from an up-to-date main for new Kesefle work — fetch, checkout, pull, branch — so you never accidentally branch from stale code or a stranded branch.
---

# Branch from main (clean start)

Always start new work from an up-to-date `main`. Branching off a stale local main, or off another feature branch, is how you get merge conflicts and accidental file reverts.

## Steps
1. Save any uncommitted work: `git status`. If dirty, commit, stash, or discard explicitly — never start a branch on top of unrelated changes.
2. `git fetch origin`.
3. `git checkout main`.
4. `git pull --ff-only origin main`. If this errors (non-fast-forward), main and your local diverge — investigate before continuing.
5. `git checkout -b <new-branch-name>`. Naming: `feat/<short>`, `fix/<short>`, `chore/<short>`. ASCII-kebab.
6. Confirm clean start: `git log --oneline -1` matches origin/main's tip.

## Verification
- `git branch -vv` shows the new branch tracking nothing yet (you'll set it on first push with `-u`).
- `git status` shows clean working tree.
- `git log main..HEAD` is empty (no commits ahead yet).

## Common pitfalls
- Skipping `fetch` → main pull pulls nothing because your remote ref is stale.
- Using `git pull --rebase` on main → fine, but never on a feature branch others use.
- Branching off another feature branch "to build on it" → both feature branches become entangled; cherry-pick or wait for the first to merge first.
- Starting work without committing existing changes → they ride along into the new branch's first commit accidentally.
