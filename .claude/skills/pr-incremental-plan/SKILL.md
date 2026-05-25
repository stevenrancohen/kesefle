---
name: pr-incremental-plan
description: Break a large feature or refactor into a 3-PR sequence so each lands reviewable, deployable, and reversible — instead of one monster PR.
---

# Incremental PR plan (3-PR pattern)

Kesefle is solo-maintained. Big PRs are unreviewable AND unrevertable AND ship multiple risks at once. Default to splitting into three.

## Pattern
1. **PR 1 — Foundation (no user-visible change)**: introduce the new helper / table / endpoint / migration in a way the old code path keeps working. Add tests. Ship.
2. **PR 2 — Switch (user-visible change)**: route the user-facing flow through the new path. Old code path still present as fallback or behind a flag. Ship + observe.
3. **PR 3 — Cleanup**: remove the old code path. Update docs. Ship.

## Steps
1. Draft each PR's diff in your head before writing code. Each PR must compile, pass tests, and deploy cleanly on its own.
2. Order them by risk: foundation = lowest, switch = highest, cleanup = lowest. Pause between switch and cleanup to confirm production health.
3. Title each PR with its phase: `[1/3 foundation] ...`, `[2/3 switch] ...`, `[3/3 cleanup] ...`.
4. Reference the others in the body: `part of <task>; previous: #N`.
5. NEVER skip cleanup — dead code rots and accumulates.

## Verification
- Each PR's `git --no-pager diff --stat` on `main` produces a sensible deployable change set.
- Foundation PR adds tests; switch PR's tests now exercise the new path; cleanup PR removes the old path's tests.
- Production stays healthy after PR 2 for at least 24h before PR 3 ships.

## Common pitfalls
- Foundation PR includes a "tiny" user-visible change — now the rollback unit is wrong.
- Switch PR keeps the old path "just in case" forever → never gets cleaned up.
- All three PRs in flight simultaneously → merge order becomes a puzzle. Land them serially.
- Skipping the test add in PR 1 → no safety net for the actual flip in PR 2.
