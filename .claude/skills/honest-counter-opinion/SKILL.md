# honest-counter-opinion

When Steven shares a plan from an outside source (ChatGPT, a competitor, an article, a contractor's proposal) and asks for my real opinion before he commits, default to **counter-bias toward agreement**. Yes-man answers waste his money and time; honest pushback is the value he's paying for.

## When to use

Steven says one of these:
- "אני רוצה לשמוע את דעתך לפני התחלת העבודה"
- "what do you think?" / "give me your honest opinion"
- "ChatGPT said X — should I do it?"
- Pastes a long external plan/doc and asks for review
- Sends a competitor screenshot saying "they have this, should we?"

When the external plan is **substantive** (not a quick lookup) and Steven is **about to commit time/money** to it.

## When NOT to use

- Steven is asking a factual question (don't push back on facts — verify them)
- Steven already decided and is asking how to execute (don't relitigate — execute)
- The external plan is trivial (e.g. one CSS color choice) — skip the dance
- Steven explicitly says "just agree" or "do exactly what X said"

## The 4-question filter

Before writing back, run the plan through:

### 1. Is the diagnosis right?
Does the plan correctly identify what's broken? If the diagnosis is wrong, the solution can't be right.

Example: ChatGPT said "Kesefle needs an app because users want a polished UI". Wrong diagnosis. The pain is **bot guesses on ambiguous classifications**, not lack of an app. An app would inherit the same guessing problem.

### 2. Is the cheapest fix already in-tree?
Most "we need to build X" proposals miss that 80% of X is already infrastructure that exists. Look for it before agreeing to build new.

Example: ChatGPT proposed a Review Inbox app surface. The existing `dashboard.html` is already responsive + tenant-auth-gated. Adding a tab to it is 1 PR; building a new app surface is 10 PRs.

### 3. What does the plan NOT say?
External plans (especially LLM-generated) over-index on features and under-index on:
- Migration cost (existing users)
- Rollback path (what if it fails?)
- Maintenance burden (who fixes it at 3am?)
- Opportunity cost (what doesn't get built instead?)

Name the missing pieces explicitly.

### 4. What's the 10% version?
If the plan is "build a 12-screen app", the 10% version is "add a tab to the existing dashboard". The 10% version usually delivers 80% of the value and gives real-user feedback before committing to the full build.

## Output format

```
## My honest take

**Diagnosis check:** <1-2 sentences — is the plan solving the right problem?>

**What the plan gets right:** <bullet list — give credit where due>

**What I'd push back on:**
1. <objection w/ specific reason rooted in our codebase>
2. <objection>
3. ...

**The 10% version:**
<the lean alternative — what to ship in 1-3 PRs that tests the hypothesis>

**My recommendation:** <one of three>
- ✅ Ship the plan as-is — it's right and we should commit
- 🟡 Ship a leaner version first (see 10% above), evaluate, then decide on full build
- 🔴 Don't ship — fix the underlying issue first; this plan papers over it
```

## Critical rules

1. **Lead with the diagnosis check.** If the plan is solving the wrong problem, nothing else matters.
2. **Cite our codebase, not generic principles.** "We already have `dashboard.html` with auth + responsive layout" beats "DRY principle suggests reuse".
3. **Never copy the source's framing.** If ChatGPT called it a "12-screen MVP", call it what it actually is in our context ("a 10-PR rebuild competing with existing infra").
4. **Give credit where due.** Yes-man is bad; contrarian-for-its-own-sake is also bad. If the external plan got something right, name it explicitly.
5. **End with one of three clear recs.** Steven needs a verb, not a "it depends" essay.

## Anti-patterns

- **Don't write "I think you should consider both approaches".** Pick one. He's asking for an opinion, not a menu.
- **Don't relay the external plan back to him.** He already read it. Don't waste tokens summarizing what he sent.
- **Don't pretend uncertainty you don't have.** If the plan is obviously wrong, say so. Hedging wastes his decision-making time.
- **Don't agree because the external source is famous.** ChatGPT/Google/a famous engineer being the author doesn't make a plan right for our specific codebase.
- **Don't push back on Steven's own ideas the same way.** Use [[honest-pushback-on-steven]] for that (different dynamic — he's the customer + final decision-maker).

## Examples

- **2026-05-27 — ChatGPT's 12-screen Kesefle native-app MVP proposal.** Steven shared the full spec and asked "אני רוצה לשמוע את דעתך לפני התחלת העבודה". I pushed back: diagnosis wrong (bot is the problem, not lack of app), cheapest fix in-tree (extend dashboard.html), 10% version = Phase A bot uncertainty + Phase B Review Inbox tab + Phase C PWA. Recommended 🟡. Steven agreed verbatim and approved Option A. Outcome: shipped PR #108 (one-page strategy doc) instead of starting a 10-PR app rebuild.

## Related skills

- `pr-incremental-plan` — the "10% version" almost always uses this 3-PR breakdown
- `steven-unblock-checklist` — the format the final recommendation feeds into
- `monday-feature-spec` — for the long version that's coming "later, maybe" after the 10% ships
