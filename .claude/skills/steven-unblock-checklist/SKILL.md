# steven-unblock-checklist

When Steven asks "what do you need from me?" or "what's next?" — give him a clear, tiered checklist of every action that requires his hands, separated by urgency. Never make him guess what's blocking vs nice-to-have.

## When to use

Steven asks any variant of:
- "מה צריך ממני"
- "what do you need from me"
- "what now"
- "give me instructions"
- "what's blocking"

OR: when ending a multi-PR batch where 1+ items genuinely require him (paste, hard refresh, env var, connector install).

## The 3-tier output format

ALWAYS structure as 3 sections, in this order:

### 🔴 BLOCKING — work doesn't move forward without you

Things that prevent the next autonomous block from making real progress. Be honest — only include true blockers.

Each item:
- **What** — one sentence
- **Why** — what breaks/regresses without it
- **How** — numbered click-by-click steps with exact buttons / URLs / file paths
- **Time** — realistic ("90 seconds", "5 minutes")
- **Verify** — what success looks like

### 🟡 RECOMMENDED — improves quality but not blocking

Things I can keep going without, but Steven's input would improve the next batch. Examples:
- Approve a deferred PR (S3/S4 admin auth)
- Verify a UI change actually shipped (hard refresh + screenshot)
- Install a missing connector (Figma/Canva)
- Answer 1 ambiguity I'm working around

Same format as blocking. Include a one-line "Can defer because..." that names how I'd autonomously work around it.

### 🟢 WHAT I'M DOING WHILE YOU DO (OR DON'T DO) THOSE

Concrete list of the next 3-5 autonomous tasks I'll start. From Monday's "To-Do" group, in priority order. Each with:
- Monday item id or PR-to-be number
- ETA
- Whether it touches a file Steven also has open (potential merge conflict)

This section makes it CLEAR that I'm not idle waiting — I'm moving in parallel.

## Anti-patterns

- **Don't bury blockers in a wall of text.** 🔴 is the first thing he reads. If a true blocker exists, it gets the top.
- **Don't fake-blockers** ("you should review my code" is NOT blocking — I should not call it that). Only call something blocking if I literally cannot ship the next useful work without it.
- **Don't list every Monday item.** Cap to 3-5 next-autonomous. He has the full board.
- **Don't say "thanks!"/"appreciate it!"/etc.** Skip pleasantries. He paid for this attention.
- **Don't restate the merged-PR list.** That belongs in the Monday-sync section that precedes this skill, not here.
- **Don't ask multiple questions.** Each ambiguity goes in the 🟡 RECOMMENDED tier with a "Can defer because..." fallback so I keep moving.
- **Don't add an emoji explosion.** 3 tier-emojis (🔴🟡🟢) plus 1 link-icon per item. That's it.

## Tone

- Imperative voice in the "How" steps ("Open Apps Script. Paste DEPLOY.gs. Click Deploy.")
- Past tense in verify ("Bot replies with new copy when user sends 'יעד חדש'.")
- Plain Hebrew or English depending on Steven's last message language. He's bilingual; mirror what he wrote.

## Examples

End-of-turn 2026-05-27 after PRs #91/#103/#104/#105 merged. Output had:
- 🔴 1 blocker: paste bot/ExpenseBot_DEPLOY.gs after #103 merge
- 🟡 2 recommended: hard-refresh /admin + /dashboard, decide on PR-S3/PR-S4 (deferred admin auth)
- 🟢 3 autonomous-next: broken יעד flow fix, 2 no-confirm deletes fix, webhook.js wrong layout fix

## Related skills

- `honest-scope-report` — the broader end-of-turn message format this slots into
- `monday-sync-at-turn-end` — runs BEFORE this skill in every end-of-turn message
- `bot-deploy-paste` — produces the exact paste instructions cited in the BLOCKING tier
