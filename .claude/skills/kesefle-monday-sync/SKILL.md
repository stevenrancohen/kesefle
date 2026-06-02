---
name: kesefle-monday-sync
description: Sync findings from any Kesefle audit/skill into Monday.com tasks — create new tasks for new findings, update status on resolved items, never close tasks without proof.
---

# kesefle-monday-sync

When invoked: take a findings JSON/markdown and reconcile with Monday tasks.

## Inputs
- `findings` — JSON array of `{id, title, severity, evidence, recommendation, status}`
- `board_id` — Monday board (defaults to the Kesefle ops board)

## Behavior
1. For each finding with status=open:
   - If a Monday task with matching `external_id` exists → update title/severity/evidence
   - Else → create new task with the finding fields
2. For each Monday task tagged `kesefle-audit`:
   - If finding with matching `external_id` has status=resolved AND evidence link present → set Monday status to Done
   - Else → leave as-is
3. Never auto-close a task without:
   - PR URL evidence, OR
   - Test pass evidence, OR
   - Explicit Steven approval comment

## Required fields per task
- title
- status (To Do / In Progress / Done / Stuck)
- priority (Critical / High / Medium / Low)
- owner (Steven / agent / unassigned)
- acceptance criteria
- linked PRs/docs
- blockers

## Outputs
- Sync report `monday-sync-{YYYY-MM-DD-HHMM}.md` — created N, updated M, closed K
- Per-task action log

## Hard NO
- Don't delete Monday tasks
- Don't close without proof
- Don't create duplicates (always check external_id first)
