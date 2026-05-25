---
name: commit-message-style
description: Kesefle commit message conventions — what + why, no marketing fluff, present-tense imperative, ASCII-only, with a note for new env vars or manual steps.
---

# Commit message style

Steven reads `git log` to understand what shipped. Marketing copy belongs in the changelog, not commits. Be terse; be precise; future-you needs to grep.

## Rules
1. **Title** (first line, ≤ 70 chars):
   - Present-tense imperative: `fix isolation regression in append.js`, NOT "fixed" or "fixes".
   - Lowercase first word unless proper noun.
   - No period.
   - Optional prefix tag if useful: `bot:`, `api:`, `web:`, `docs:`, `test:`. Pick a stable set; don't invent new tags per PR.
2. **Blank line**.
3. **Body** (wrap ~72 chars per line):
   - What changed (1–2 sentences).
   - WHY (the bug, the customer report, the design decision). Link the customer / ticket if any.
   - Any new env var, manual deploy step, KV migration → call it out explicitly. `deploy-checklist` skill scans for these.
4. **No marketing**: no "improves user experience", "makes it better", "polish". Be concrete: "shrinks dashboard latency by reordering KV reads".
5. **ASCII only** in commits (no Hebrew). Hebrew belongs in code strings, not git history.

## Steps
1. Run `git diff --cached` and write the message from what you see.
2. Use a HEREDOC for multi-line messages:
   ```
   git commit -m "$(cat <<'EOF'
   bot: tighten owner-only gate in subscription command

   The handler dispatched on phone match but skipped the secondary
   isOwnerPhone check, so a forwarded message from a non-owner could
   trigger help text. Added the gate; covered by test_isolation.js.

   Env: no new vars.
   EOF
   )"
   ```

## Verification
- `git log --oneline -10` reads like a changelog without further editing.
- No commit titles start with "Update", "Misc", "Fix bug" (uselessly vague).

## Common pitfalls
- Title says one thing, body adds three unrelated changes → split into multiple commits.
- Forgetting to call out a new env var → next env break blamed on the commit two PRs later.
- Hebrew in the commit → bidi marks in git log; impossible to grep.
