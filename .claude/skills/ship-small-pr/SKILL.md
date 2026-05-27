# ship-small-pr

The full single-PR workflow used dozens of times this session. Use this as the default ship-it loop for any single-focus change.

## Trigger

Any change that's <= ~200 lines, single concern, reversible. If bigger, split first via `pr-incremental-plan`.

## Steps

1. **Branch from a fresh main**
   ```bash
   git fetch origin main && git checkout main && git pull && git checkout -b <type>-<short-name>
   ```
   Branch name format: `fix-`, `feat-`, `chore-`, `docs-`, plus a 3-5 word slug.

2. **Edit** — minimal, focused, with inline comment explaining the WHY.

3. **Validate** (in order):
   - `node --check <file>.js` for any changed `.js`
   - Inline-script validator for any changed `.html`:
     ```bash
     node -e "const fs=require('fs');const h=fs.readFileSync('PAGE.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('block',i,e.message);process.exit(1)}});console.log('ok')"
     ```
   - Run the relevant single test, then `node tests/full_qa.js`

4. **Commit** with a body that includes:
   - 1-paragraph WHY (quote the brief/audit finding if applicable)
   - "What changed" bullets
   - "What stayed" bullets (scope discipline)
   - Verification steps + results
   - Co-Authored-By trailer
   See `commit-message-style` skill for conventions.

5. **Push + open PR**:
   ```bash
   git push -u origin <branch>
   gh pr create --title "<type>(<scope>): <one-line>" --body "$(cat <<'EOF'
   ## What
   ...
   ## Test plan
   - [x] inline-script validator
   - [x] full_qa 118/118
   - [ ] Manual: ...
   EOF
   )"
   ```

6. **Report** PR URL to user. Single line, just the URL.

## Anti-patterns to avoid

- Don't include unrelated drive-by fixes. One PR = one concern.
- Don't say "tested" if you only ran node --check. List what you actually ran.
- Don't auto-merge. Steven approves.
- Don't push to main. Always a branch.
- Don't skip the regression test if the change touches behaviour.
