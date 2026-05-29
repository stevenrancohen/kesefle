---
name: kesefle-autonomous-deep-audit-runner
description: Run a structured, time-boxed autonomous work block (60 / 90 / 120 / 180 minutes) when Steven is away. Spawns parallel sub-agents, runs audits, ships safe fixes, drafts PRs, updates Monday tasks, produces an executive summary. Hard rules: no destructive actions, no apply without DRY_RUN, no merging of Steven-only PRs, no secrets in commits. Always returns a single-screen summary at the end with the 5 actions Steven needs to take when he's back.
---

# Kesefle Autonomous Deep Audit Runner

When Steven says "I'm going away, work without me" — or just "do everything you can while I'm gone" — this skill is the discipline that keeps the work productive without being reckless. It enforces a structured plan, parallel execution, safety-first defaults, and a tight executive summary at the end.

## When to invoke

- Steven explicitly says: "I'm away", "do whatever you can", "use cowork", "autonomous block", "work for X minutes/hours".
- Steven's tone implies it: long task list, multiple "do tasks that you can", and explicit standing approvals.
- A natural reset point: end of a feature, after a deploy, at the start of a new session day.

Do NOT invoke this skill mid-task — it's for the start of a meaningful block.

## Block sizes

Pick the smallest size that fits the work + Steven's available time:

| Size       | Use for                                      | Sub-agent fan-out |
|------------|----------------------------------------------|-------------------|
| 60 min     | Quick audit + 1-2 small PRs                 | 2-3 parallel      |
| 90 min     | Audit block + 3-5 small PRs                 | 3-4 parallel      |
| 120 min    | Deep audit + 5-8 PRs + Monday sync           | 4-6 parallel      |
| 180 min    | Multi-feature autonomous block               | 4-8 parallel      |

## Hard rules (never break)

1. **No destructive actions.** No `git push --force` to main, no `gh pr merge` on Steven-only PRs, no `rm -rf`, no Apps Script `APPLY_*` runs without prior approval.
2. **No apply without dry-run.** Every sheet-mutating change goes DRY_RUN first; APPLY waits for Steven's return.
3. **No secrets in commits.** Run the secrets scan before every commit. If a literal token is in the diff, abort.
4. **No merging Steven-only PRs.** I open them; Steven approves and merges.
5. **No deletes from history.** No `git rebase -i` with `drop` lines, no `git push --force-with-lease` on main.
6. **Bot deploy stays manual.** I assemble `bot/ExpenseBot_DEPLOY.gs` + bump version + open PR; Steven re-pastes into Apps Script.
7. **Bypass-safe execution.** If the harness/permissions hit a wall, log the error to the summary, never silent-fail.
8. **Standing approval scope only.** Use Steven's standing-approval list (delete byte-identical duplicates, archive legacy one-shots, update stale config IDs, run audits, plan-only on data work).

## The 7-phase structure (every block follows this)

### Phase 0 — Inventory (5 min, always)

Read in parallel:
- `git status`, `git log --oneline -10`, `gh pr list --state open --json number,title,mergeable`
- Steven's most recent message (catch open requests)
- Recent task list items (catch in-flight work)

Output: the "what's in flight" map. Decide what to pick up, what to defer.

### Phase 1 — Plan (5-10 min)

Pick a target set of changes that fit the block size. Bias toward:
- Safe cleanups (Steven's standing approval)
- Fixing build / test / CI breakage
- Closing in-flight PR conflicts
- Documentation / runbook updates
- Audits that produce reports (DRY_RUN only)

Avoid:
- New schema changes
- Migration apply steps
- Anything that requires Steven's "yes" mid-flight

Output: a numbered checklist with estimated time per item.

### Phase 2 — Fan out (parallel)

Spawn 2-6 sub-agents in parallel for independent work streams. Each sub-agent:
- Has a self-contained prompt (no shared context)
- Runs read-mostly tasks (audit, scan, dry-run)
- Returns a structured report

Common fan-out roles:
1. **Audit agent** — runs `tests/full_qa.js`, all `bot/test_*.js`, `security-scan` skill
2. **Migration DRY_RUN agent** — reads OLD + NEW sheets, produces diff report (no writes)
3. **Bot-engineer agent** — small bot fix (single function, regression test)
4. **Docs agent** — updates `PROGRESS_DIGEST.md`, fixes broken links, syncs Monday tasks
5. **PR-conflict resolver** — rebases / fixes conflicts on open PRs
6. **Skills-builder** — adds new skills based on patterns observed in recent commits

### Phase 3 — Foreground work (the bits agents can't do)

Some things the parent must do itself:
- Reassembling `bot/ExpenseBot_DEPLOY.gs`
- Running `node --check` on assembled bot
- Running `tests/full_qa.js` (because the verdict is consolidated)
- Opening PRs (because the description needs synthesis of all agent reports)

### Phase 4 — Verify (10-15 min)

For every change made:
- `node --check` on `.js` and `.gs` files
- `tests/full_qa.js` → 118 checks
- Every `bot/test_*.js` → all pass
- `security-scan` skill → no secrets
- For HTML changes: `inline-script-validate`

If anything fails, fix it before moving to Phase 5. If can't fix, surface as a blocker in the summary.

### Phase 5 — Ship (5-10 min per PR)

For each shippable change:
- Branch from main
- Commit with `commit-message-style` skill conventions
- Push
- Open PR with structured body
- Add Test Plan checklist

Never merge. Steven merges.

### Phase 6 — Monday sync (5 min)

For findings discovered in audits, either:
- Create a new Monday task (urgent finding)
- Update an existing task with the audit's verdict
- Close completed tasks with proof

Use `kesefle-monday-sync` skill.

### Phase 7 — Executive summary (single screen, mandatory)

Format:

```
[AUTONOMOUS_BLOCK_SUMMARY]
Time worked:         <X minutes>
Sub-agents spawned:  <N>
PRs opened:          <list of #s with one-line titles>
PRs Steven should merge first: <ordered list>
Tests run + status:  <list>
Documents created:   <list>
Findings (sev-tagged):
  Critical: <count>  <one-liner each>
  High:     <count>
  Medium:   <count>
  Low:      <count>

What Steven needs to do (top 5, ordered):
  1. <specific action, ETA, link to PR/doc>
  2. ...
  3. ...
  4. ...
  5. ...

What I did NOT do (and why):
  - <list of deliberately-not-shipped items, with the gate that blocked>

Block status: COMPLETED | BLOCKED_ON_STEVEN | PARTIAL
```

## Example: 120-min block on a Friday morning

```
[BLOCK_TARGET: 120 min, Steven offline]

Phase 0 (5 min):  3 open PRs (#139 conflict, #143 awaiting merge, #144 awaiting merge).
                  Recent: cell-note year-separator just shipped, sheet-diff tool just shipped.
                  Steven's standing: cleanup safe, plan-don't-apply on data.

Phase 1 (5 min):  Plan
  - Resolve #139 conflict
  - Spawn audit agent + Monday-sync agent + docs agent (parallel)
  - Plan category-reconciliation (DRY_RUN only)
  - Build 3 new skills based on patterns from this session
  - Ship 1-2 small PRs for safe cleanups
  - Write executive summary

Phase 2 (40 min, parallel):
  Agent 1 → Full QA + secrets scan + bot tests + diff vs prior run
  Agent 2 → Read OLD + NEW sheet (via sheet-diff tool DRY_RUN), produce comparison doc
  Agent 3 → Update PROGRESS_DIGEST.md with last 8 commits, sync to Monday

Phase 3 (30 min, foreground):
  - Rebase #139, run tests, force-push
  - Reassemble bot DEPLOY.gs
  - Open PR for category-reconciliation PLAN (no apply)
  - Add 3 new skills under .claude/skills/

Phase 4 (10 min): verify
Phase 5 (15 min): ship PRs
Phase 6 (5 min): Monday sync
Phase 7 (10 min): summary

→ Steven sees a single screen on return, knows exactly what to merge in what order.
```

## Failure modes to handle gracefully

| Failure | Response |
|---------|----------|
| Background agent worktree fails | Note in summary, do the work in foreground if time allows |
| `tests/full_qa.js` fails on main (not my fault) | Note in summary as a pre-existing condition; don't ship more changes until Steven decides |
| Merge conflict I can't safely resolve | Close my own PR with a comment, open a fresh one with only the safe parts |
| Secret found in a draft commit | Abort the commit, remove the secret, log the source path |
| Time runs out mid-task | Stop at the next safe checkpoint, ship what's complete, defer the rest to the summary |
| Steven returns mid-block | Wrap up the active phase, hand him the partial summary |

## The 5-Steven-actions rule

Every block's summary ends with exactly 5 actions Steven should take. Not 8. Not 3. Five. Ordered by priority.

If you have fewer than 5 real actions, the block was too short. If you have more than 5, you're not prioritizing — pick the top 5 and put the rest in "additional findings".

## Anti-patterns this skill forbids

- "I worked for 2 hours" without a structured summary at the end.
- "I shipped 12 PRs" without saying which 5 are P0 to merge.
- Apply steps run autonomously on Steven's sheet.
- Schema changes without DRY_RUN.
- "Probably safe" judgement on financial data.
- Closing a PR without a comment explaining why.
- Saying "done" when the bot deploy step is still pending.
- Burying the most important finding under noise.

## How this skill interacts with the agents

- `kesefle-cto-product-architect` reviews any non-trivial plan before fan-out.
- `kesefle-qa-security-data-integrity-officer` reviews every shipped PR.
- `kesefle-migration-and-sheet-formula-agent` handles any sheet-touching DRY_RUN.

## Output for the parent agent

At the end of every block, this skill emits:

```
[AUTONOMOUS_DEEP_AUDIT_RUNNER]
Block size:          <X min>
Phases completed:    <0-7 list>
PRs opened:          <list>
Tests passing:       <yes/no>
Steven actions:      <5-item ordered list>
Block status:        COMPLETED | BLOCKED | PARTIAL
```
