---
name: multi-pr-trap
description: Avoid the recurring Kesefle trap of pushing new commits to a branch that was already merged — leading to a dead-but-not-buried PR with unmerged work.
---

# The merged-branch push trap

The most common Kesefle workflow accident: you ship a feature, the PR merges, you keep working on the same local branch, push, and confusingly nothing happens — the merged PR doesn't reopen, the new commits sit on a dead branch, and the work seems to "vanish" until you notice.

## Why it happens
- Local branch name is `feat/x`; PR was merged with squash, which deleted the remote branch. Local still points at the pre-merge SHA.
- You commit, push — origin accepts the push (new branch), but no PR exists.
- Vercel doesn't deploy (only `main` deploys).
- Time passes; you forget the work is on a branch.

## Steps to avoid it
1. **After every merge**: `git checkout main && git pull && git branch -D <merged-branch>`. Now you physically cannot push to it.
2. Before starting follow-up work, ALWAYS run `branch-from-main` skill: `git checkout main && git pull && git checkout -b <new-branch>`.
3. If your editor / IDE caches the old branch, close + reopen.
4. If you suspect you're on a stale branch, run `git log --oneline -5 main..HEAD` and `git log --oneline -5 HEAD..main`. If `HEAD..main` is non-empty, main moved past you — you're stale.

## Recovery if you're already in the trap
1. `git fetch origin`. Identify what's on your branch but not on `main`: `git log --oneline main..HEAD`.
2. `git checkout main && git pull`.
3. `git checkout -b <new-fresh-branch>`.
4. `git cherry-pick <sha>...<sha>` — bring the stranded commits over.
5. Push the new branch; open a fresh PR.
6. Delete the dead branch.

## Verification
- After `git branch -a`, no merged branches show as still tracking origin.
- Every active local branch has a corresponding open PR or fresh work.

## Common pitfalls
- "I'll just reuse the branch name" → still trips the same trap because the old remote branch is gone but local thinks it knows where to push.
- Force-pushing onto a deleted remote branch — origin happily accepts, still no PR.
- Doing two follow-up tweaks before noticing — the longer you wait, the more confusing the cherry-pick gets.
