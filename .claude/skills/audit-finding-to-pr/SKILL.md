# audit-finding-to-pr

Convert a single audit finding (from `docs/QA_*.md` or `docs/SECURITY_*.md`) into a single focused PR with a regression test. The pattern I used for PR-S, PR-S2, PR-S5, PR-S6.

## Input

One finding from an audit report. Shape:
- Severity (Critical / High / Medium / Low)
- Where (file:line)
- What's wrong (1-2 sentences)
- Suggested fix (1 sentence)

## Decision tree (do this BEFORE writing code)

1. **Is the finding actually a bug?** Re-read the code. Sometimes audits misread context (e.g. the "+1-555 placeholder" finding — that was a documented WABA test number, not a leak).
   - If misreading: write a short docs-only PR that adds an explanatory inline comment so the next audit doesn't re-flag it.

2. **Is the fix risky?** Check:
   - Does it change auth shape? (could break external callers — DEFER to Steven)
   - Does it change a public response shape? (could break the bot or frontend — DEFER)
   - Does it change a payment flow? (DEFER unless trivial)
   - Otherwise: ship.

3. **Can the fix be one focused PR?** If it touches > 5 files OR mixes concerns, split via `pr-incremental-plan`.

## Steps

1. **Branch** via `ship-small-pr` skill.

2. **Fix the immediate bug** in the smallest possible diff. Add an inline comment with:
   - `// PR-S<N> (DATE audit ref): <one-line what was wrong>`
   - `// <what the fix does>`

3. **Write the regression test** via `regression-test-no-eval` skill. The test MUST:
   - Match the structural shape (not the exact line) so cosmetic edits don't break it
   - Assert "old bad pattern is gone" AND "new good pattern is here"
   - Strip comments before regex

4. **Run** the test + `node tests/full_qa.js`.

5. **Open PR** with body sections:
   - **What** — quote the audit finding verbatim
   - **The bug** — what the buggy line was doing
   - **Exploitability today** — be honest. "Low" / "Medium" / "High" + why.
   - **The fix** — diff summary
   - **Regression test** — what it asserts
   - **Verification** — checkmarks for what you ran
   - **Sprint context** — link the parent audit PR and any related shipped PRs

## Examples

- Backend Bug #7 (winback token forgery) → PR #93
- Security H1 (sheet ownership x5) → PR #94
- Backend Bug #1 (rate-limit no-op) → PR #95
- Backend Bug #2 (phone enumeration) → PR #96

## Anti-patterns

- Don't bundle 3 audit findings into one PR. One finding = one PR.
- Don't ship without the regression test. The test is the durability.
- Don't gold-plate. If the audit said fix X, fix X. Refactoring while there is "scope creep we shouldn't do mid-audit".
- Don't claim "Critical" if you downgraded the finding's severity in the PR body. Be consistent.
