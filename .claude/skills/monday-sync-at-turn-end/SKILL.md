# monday-sync-at-turn-end

Permanent end-of-turn workflow Steven requested 2026-05-27: **before ending any user-facing message, sync Monday + create next-stage tasks + embed one new skill**. This is not a per-task ritual — it runs every turn that involves real work.

## When to use

EVERY message that:
- Ships a PR
- Lands a meaningful fix
- Closes an audit finding
- Completes a phase of work

Skip ONLY for:
- Pure clarification turns ("ok will do" / "no, do X instead")
- Information lookups with no code change

## The 3-step workflow

### Step 1 — Mirror this turn's shipped PRs onto Monday

For every PR opened or merged this turn, ensure there's a matching item on the Kesefle Monday board (ID `5097200701`, in workspace `6546547`).

Pattern:
```
mcp__8502f1d6-...__create_item({
  boardId: 5097200701,
  groupId: 'new_group43041',         // 'Completed' if merged
  // OR 'new_group29179'              // 'To-Do' if still open
  name: 'PR #<N> — <one-line title>',
  columnValues: JSON.stringify({
    priority: { label: 'בוצע' },     // OR 'בתהליך' / 'עדיפות גבוהה' / 'בהמתנה'
    text: 'https://github.com/stevenrancohen/kesefle/pull/<N> — <status>. <what changed>. <test pass>.',
    date: { date: 'YYYY-MM-DD' },
  }),
})
```

**Priority labels** (from `get_board_info`):
| Label | Color | When to use |
|---|---|---|
| `בוצע` | green | PR merged + deployed |
| `בתהליך` | blue | PR open / awaiting paste |
| `עדיפות גבוהה` | red | Critical bug not yet fixed |
| `בהמתנה` | brown | Queued, needs review |
| `עדיפות נמוכה` | yellow | Nice-to-have |
| `בוצע חלקית` | purple | Started but not finished |

**Notes column** (`text`): Always include the GitHub PR URL + 1-line status + test result. Steven scans this column when triaging.

### Step 2 — Create next-stage tasks

For each PR shipped this turn, add 1-3 Monday items for the **follow-up work** the audit / brief implied:

- If shipped a security fix → next-stage = the related findings that didn't fit this PR
- If shipped a docs/audit → next-stage = each Critical/High finding as a PR-able item
- If shipped a UI change → next-stage = the responsive/dark-mode/cross-browser checks
- If shipped a bot change → next-stage = the regression test that proves the next 3 user flows still work

Plus **always** add a comprehensive-regression task (per `test-run-all` skill) after a batch of merges.

### Step 3 — Embed one new skill into `.claude/skills/<name>/SKILL.md`

Steven's rule: each turn embeds one new useful pattern. Pick the pattern you USED most this turn and didn't already have a skill for. Add it.

**Naming conventions:**
- `<verb>-<noun>` (e.g. `monday-sync-at-turn-end`, `regression-test-no-eval`)
- All lowercase + hyphens
- Under 40 chars

**Skill body checklist:**
1. **Heading + 1-line purpose**
2. **When to use** + **When NOT to use**
3. **Pattern** (code blocks if relevant)
4. **Critical rules** (numbered)
5. **Anti-patterns** (numbered, what NOT to do)
6. **Examples** (link to specific PRs / commits / files)

Then commit the skill in its own focused PR using `ship-small-pr`. NEVER mix a new skill with code changes.

## What the end-of-turn message MUST include

A short closing block:

```
### Monday sync
- Added X new items (PR #<N>, PR #<N>...)
- Marked Y as בוצע
- Created Z next-stage tasks

### New skill this turn
- `<skill-name>` — <one-line what it codifies>
- Shipped in PR #<N>
```

## Anti-patterns

- **Don't claim "synced Monday" without actually creating the items.** Steven verifies in the board UI.
- **Don't create duplicate items.** Read the board first via `get_board_items_page` if uncertain whether a PR is already there.
- **Don't ship a new skill in the same PR as functional code.** Skills get their own focused PR for review clarity (see PR #101 for the 12-skill batch as the gold standard — or a single-skill follow-up PR).
- **Don't skip Step 1 because "it was a small turn".** Even a 1-line fix gets a Monday item — Steven uses the board for accountability, not just bug-tracking.
- **Don't recycle skill names.** Each turn = a NEW name. Repeats indicate you're not learning new patterns.
- **Don't write skills for one-off scenarios.** If you'll use the pattern again ≥ 3 times in the next month, it earns a skill. Otherwise it's a comment in the relevant existing skill.

## Examples

- Turn 2026-05-27 evening — Steven asked for this workflow. Created `monday-sync-at-turn-end` skill (this file), synced PRs #87-103 to board, added 7 next-stage items.

## Related skills

- `honest-scope-report` — what the end-of-turn message itself should look like
- `pr-merge-order` — used when generating the bulk-merge instructions section
- `audit-finding-to-pr` — used when Step 2 next-stage tasks come from audits
