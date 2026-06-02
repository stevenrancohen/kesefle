# pr-merge-order

Given a list of open PRs, output a dependency-safe merge order. Used when Steven asks "which order do I merge these?".

## Inputs

`gh pr list --state open --limit 30` output.

## Decision rules (apply in order)

1. **Docs-only PRs first.** Zero risk, no behaviour change. Examples: PR-92 audit reports, PR-100 nav comment renumber.

2. **CSS additions that aren't consumed yet.** Adding `.kfl-chip-*` to brand.css without applying them anywhere = zero blast radius. Merge before any PR that consumes the new utility.

3. **Security fixes** before feature PRs. Reason: features may need re-test if a security PR changes auth flow shape. Order: PR-S, PR-S2, PR-S5, PR-S6.

4. **Independent feature PRs** in any order — but check for file overlap. Two PRs both touching `dashboard.html` need careful order.

5. **Feature PRs that build on a foundation PR** — foundation first. Example: PR-D4 (MoM + top-cat) references the same payload as PR-D3 (hero strip), but D4 doesn't strictly depend on D3 — both can ship independently.

6. **Bot PRs last.** Reason: every bot PR requires Steven to paste `bot/ExpenseBot_DEPLOY.gs` into Apps Script. Batch them so he pastes once.

## Output format

```markdown
### Merge order (safest first → highest blast radius last)

1. [#100 nav comment renumber](URL) — comment-only, zero risk
2. [#92 audit reports](URL) — docs only
3. [#99 PR-W3 chip palette](URL) — additive CSS, no consumers yet
4. [#93 PR-S winback fix](URL) — security, single file
5. [#94 PR-S2 sheet ownership x5](URL) — security
... etc

### After all merge: ONE bot paste for PR #87
```

## File-overlap check

For each pair of open PRs, run:
```bash
gh pr view <A> --json files --jq '.files[].path' | sort > /tmp/a.txt
gh pr view <B> --json files --jq '.files[].path' | sort > /tmp/b.txt
comm -12 /tmp/a.txt /tmp/b.txt
```
If output is non-empty → those PRs touch the same file → merge order matters → rebase the second one after the first.

## Anti-patterns

- Don't suggest a merge order without checking file overlap.
- Don't say "all independent" if 3 PRs touch `dashboard.html`.
- Don't put a bot PR mid-list — always last, so the paste is one-shot.
- Don't auto-merge. Output the order; let Steven click merge.

## Examples

See the session summary report from 2026-05-27 evening for an example of a 14-PR merge order with separate links.
