# honest-scope-report

The reporting pattern Steven explicitly requested: "Don't fake done. Don't say 'tested' if not tested. Don't auto-deploy. Don't push to main." Use this when wrapping up an autonomous block to give Steven a clean, honest status.

## When to use

End of every autonomous work block (multi-PR sprint, audit sprint, etc.) before handing back to Steven.

## Required sections

### 1. What I shipped
For each PR opened in this block:
- PR # + URL (full GitHub link, not just number)
- One-line description
- Source (which audit/brief drove it)
- Test status (PASS/FAIL/N/A, specific test name)

### 2. Honest scope notes
Things Steven needs to know that the PR titles don't reveal:
- If you DOWNGRADED an audit's severity (e.g. "Critical" → "minor cosmetic"), explain why
- If you DEFERRED a finding (e.g. PR-S3/S4 admin auth changes), say what you deferred and why
- If the audit was WRONG (e.g. "broken dropdown" that's actually working), say so
- If a PR is COSMETIC (no behaviour change), flag it so Steven doesn't review with high scrutiny

### 3. What I DID NOT do (flagged honestly)
Use ❌ for hard-not-done, ⏸️ for deferred, ⚠️ for partial:
- ❌ Favicon PNG regeneration — needs binary image authoring
- ⏸️ PR-S3/PR-S4 — admin auth shape change, defer to Steven
- ⚠️ Bot QA agent still running — finding will land later

### 4. Test results
The actual command + result, not a summary:
```
node tests/full_qa.js → 118/118 pass
node tests/test_winback_token_exact_match.js → 8/8 pass
```
Don't say "all tests passed" without naming them.

### 5. Open PRs summary
Table of all open PRs (not just ones from this block):
| # | Type | Risk | Needs paste? |
|---|---|---|---|
| 100 | chore | LOW | no |
| 87  | feat-bot | LOW | YES |

### 6. Bulk-merge instructions
Per `pr-merge-order` skill: ordered list of PR URLs with click-to-merge guidance. Each PR gets its OWN line (Steven asked).

### 7. What needs Steven's input (if any)
Specific questions. Yes/No format if possible.

### 8. What I'm doing next (autonomous)
What I'll keep shipping while Steven sleeps.

## Tone

- Plain English. No "I successfully implemented".
- Acknowledge limits. "Adobe can recolor an existing logo but can't generate from scratch in this env" is honest.
- No emoji-heavy celebration. PR #100 milestone got ONE 🎉 — that's the cap.
- Quote audit findings verbatim when relevant. No paraphrasing that softens severity.

## Anti-patterns

- "All tests passed" without listing which. Steven will assume you ran tests you didn't.
- "Shipped 10 PRs" without separate links. Steven asked for separate links per his rules.
- Burying a "I didn't actually finish X" in paragraph 5. Surface it in section 3.
- Padding the report with future-looking claims. Past tense only for what shipped.

## Examples

The end-of-block report at 2026-05-27 evening that included:
- 14 open PR table with separate links
- Honest "this audit finding was actually wrong" downgrade for PR #97
- Deferred-with-reason for PR-S3/S4
- "Generative AI not available in Adobe env" honesty
