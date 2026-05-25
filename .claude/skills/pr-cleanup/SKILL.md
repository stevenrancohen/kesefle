---
name: pr-cleanup
description: Pre-merge polish checklist for a Kesefle PR — squash noise, write the description right, attach screenshots, confirm tests.
---

# PR cleanup (pre-merge)

Run this last, after the work is done but before merging. Most of Kesefle's PRs are solo-authored; the audience is future-you reading the changelog three months later. Make it greppable.

## Steps
1. **Squash noisy commits** if helpful: `git rebase -i main` then mark `fixup` or `squash` on WIP commits. Keep meaningful boundaries; don't squash unrelated changes together.
2. **Description**:
   - First line: what changed, in the active voice (matches `commit-message-style`).
   - Body: WHY (the bug, the customer ask, the design decision). 1–3 bullets max.
   - "Test plan" section: list the suites you ran + any manual checks.
   - Note any new env var, manual deploy step, or DB / KV migration.
3. **Screenshots** for UI changes. Mobile width + desktop. Before / after side-by-side if it's a visual change.
4. **Tests green**: run `test-run-all` skill output, paste pass count if it's a significant PR.
5. **Pre-merge sweep**:
   - `git --no-pager diff main` → no debug logs, no commented-out blocks, no `console.log` of PII.
   - Run `pr-review` and `security-scan` skills.
6. **Merge**: squash-merge to `main` (Vercel auto-deploys).
7. **Post-merge**: delete the branch locally and on origin so you don't re-push to it later (see `multi-pr-trap`).

## Verification
- Vercel build succeeds within 2 min.
- Live URL reflects the change.
- For bot PRs: paste-deploy actually happened (see `bot-deploy-paste`).

## Common pitfalls
- Description says "various improvements" — useless. Be specific.
- Forgot to add new env var to the description → next deploy on a fresh env breaks.
- Screenshots only at desktop width → mobile regressions ship.
- Merged without deleting the branch → you push to it again later, see `multi-pr-trap`.
