# monday-feature-spec

Pattern for writing a Monday item that's a **deferred feature spec** — not a bug fix, not a PR record, but a future-work item Steven wants to act on later. The item needs to be self-contained enough that a future me (or a contractor) can pick it up cold and ship the right thing.

## When to use

Steven says one of these:
- "תוסיף את זה לעבודה בהמשך"
- "future work"
- "not now, just track it"
- "build this later"
- Sends a screenshot of a competitor's feature and says "add this"

When the request is a NEW capability (not a fix), and explicitly deferred. Always include reference UI links if a screenshot was provided.

## When NOT to use

- Bug fix → use `audit-finding-to-pr` instead (it's a fix-now item with regression test)
- PR record → use `monday-sync-at-turn-end` (one of its sub-steps)
- Vague aspirational goal ("we should support 1M users someday") → don't create the item; ask Steven what concrete next step he means

## Required sections in the Notes column

The Monday item's `text` (Notes) field MUST include all 7:

### 1. Source quote + date
```
FUTURE WORK per Steven YYYY-MM-DD. <translated quote of his ask>.
```

### 2. Reference UI (if applicable)
```
Reference UI: <competitor>.com <feature>, see Steven's screenshot.
```
Naming the competitor + the panel is enough — no need to attach images to Monday.

### 3. Why it matters
Why does this exist? Connect it to a current pain point or measured gap.

```
Why it matters: <1-sentence what changes for the user / business>.
Today: <current state>. With this: <future state>.
```

### 4. User stories (numbered, 3-5)
```
USER STORIES:
  1. <user> opens <surface>, sees <thing>
  2. <user> clicks <element> → <outcome>
  3. ...
```

Cap at 5 stories. If the feature needs more, it's too big — split into 2 items.

### 5. Dependencies
```
DEPS:
  - Already have <X> from task #N (link if helpful)
  - Needs <new endpoint / table / KV record>
  - Bot needs <change>
```

### 6. Scope estimate (PR series)
```
SCOPE: <N>-PR series (~<duration>)
  - PR-XX1: <smallest first slice>
  - PR-XX2: <middle>
  - PR-XX3: <final>
```

Always break to 3 PRs minimum (per `pr-incremental-plan` skill). One mega-PR for a new feature is a red flag.

### 7. Risk + "NOT TOUCHING NOW" guard
```
RISK: <one-line warning about the riskiest part>.
NOT TOUCHING NOW per Steven's '<his deferred phrase>' instruction.
```

The "NOT TOUCHING NOW" line is non-negotiable. Without it, the next autonomous block might pick up the item and start building before Steven approves.

## Monday columns

```js
{
  boardId: 5097200701,
  groupId: 'new_group29179',          // 'To-Do', never 'Completed'
  name: '<Feature name> — <one-line value>',
  columnValues: JSON.stringify({
    priority: { label: 'בהמתנה' },    // ALWAYS בהמתנה for deferred features
    text: '<the 7-section block above>',
    date: { date: '<estimated start date, ≥ 1 week out>' },
  }),
}
```

Priority is ALWAYS `בהמתנה` (waiting). Never `עדיפות גבוהה` for a deferred feature — that conflicts with Steven's "future work" intent.

## Anti-patterns

- **Don't write a vague 1-paragraph description.** A future me will ship the wrong thing. The 7 sections are minimum scaffolding.
- **Don't pad with marketing fluff.** Item is internal — speak engineering.
- **Don't omit the "NOT TOUCHING NOW" line.** That's the trip-wire that prevents auto-building before Steven's review.
- **Don't estimate < 3 PRs** for a new feature. Multi-PR rollout is the default per `pr-incremental-plan`.
- **Don't create deferred features without Steven explicitly deferring.** If he didn't say "future"/"later"/"בהמשך", confirm before deferring.
- **Don't auto-start the next session** by reading the item and assuming green-light. Wait for explicit Steven approval.

## Examples

- 2026-05-27 — "Admin Conversation Console — view + edit + resend bot replies" (FastBots-style). Steven sent FastBots.ai screenshot, said "כרגע שים את זה לעבודה בהמשך". Created Monday item with 7-section spec, 3-PR breakdown, NOT TOUCHING NOW guard.

## Related skills

- `monday-sync-at-turn-end` — the broader workflow this is a sub-pattern of
- `pr-incremental-plan` — the 3-PR rule that defines the SCOPE section
- `audit-finding-to-pr` — the OPPOSITE pattern (fix-now with regression test)
