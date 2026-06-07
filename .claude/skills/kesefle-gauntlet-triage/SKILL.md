---
name: kesefle-gauntlet-triage
description: Read a failing `npm run gauntlet` run, map the failing group (full_qa, test suites, JS syntax, HTML/JSON-LD, sitemap, secret scan) to the offending file, and produce the minimal correct fix without weakening the gate.
---

# Triage a failing gauntlet

`npm run gauntlet` (`scripts/gauntlet.sh`) is the single pre-merge gate - 6 offline groups, exit 0 = safe. When it fails, fix the CODE, never the assertion. Weakening a check to go green defeats the safety net and is the one move that's explicitly disallowed.

## The 6 groups (and where each fails)
1. **QA gate** - `node tests/full_qa.js` (the consolidated offline suite; sections `5a..5m`).
2. **Test suites** - every `tests/test_*.js` + `tests/golden_set.js` + `tests/recurring_detect.js` + every `bot/test_*.js` (auto-discovered).
3. **JS syntax** - `node --check` on every committed `*.js` and the two bot `*.gs` (copied to temp `.js`).
4. **HTML scripts** - every inline `<script>` parses as JS and every `application/ld+json` block is valid JSON.
5. **Sitemap** - `sitemap.xml` is well-formed, `<url>` tags balance, every `<loc>` is an `https://kesefle.com` URL.
6. **Secret scan** - no provider-token shape (Meta `EAA...`, OpenAI `sk-...`, Anthropic `sk-ant-...`, Google `AIza...`, PEM key) in committed `html/js/gs/md`.

## Steps
1. Run `npm run gauntlet` and read the SUMMARY - it names the failing group(s) and per-item `x` lines.
2. Re-run only the failing group to get full output:
   - Group 1/2: `node tests/full_qa.js` or `node <the failing suite>` (group 2 already re-runs failures visibly).
   - Group 3: `for f in $(git ls-files '*.js'); do node --check "$f" || echo "BAD $f"; done` (and copy each `*.gs` to a temp `.js` first).
   - Group 4: open the named HTML file; the offending inline `<script>` / JSON-LD block is the parse error.
   - Group 5: open `sitemap.xml`; fix the unbalanced `<url>` or non-kesefle.com `<loc>`.
   - Group 6: the scan prints `file:line (match redacted)` - open it and REMOVE the secret; never print the value.
3. Identify the regression: a real assertion is telling you the code changed behavior. Read the assertion to learn the contract it protects (e.g. full_qa 5d = number routing, 5m = PayPal wiring, the `_personalSectionTotal` ranges = dashboard row layout).
4. Fix the CODE to satisfy the contract - restore the route, re-add the inline-script semicolon, fix the SUMIFS range, scrub the secret + rotate it.
5. Re-run `npm run gauntlet` to confirm the group flips to PASS and nothing else regressed.

## Verification
- `npm run gauntlet` exits 0: `GAUNTLET PASSED -- N checks across 6 groups, 0 failures.`
- The specific failing item from step 1 is now a `✅` in `node tests/full_qa.js`, or the suite/`node --check`/sitemap/secret check is clean.
- `git diff` shows a code change (or a removed secret), NOT a softened/`.skip`'d assertion.

## Common pitfalls
- Editing the assertion (loosening a regex, commenting out an `ok(...)`, deleting a golden-set anchor) to pass - forbidden; that erases the guard.
- A group-3 `.gs` "failure" that's really an Apps Script-only construct - copy to temp `.js` and confirm; the gauntlet already does the copy, so a real `--check` failure is a real syntax bug.
- Secret-scan hit on an EXAMPLE string in a `.md` - still scrub it; use an obviously-fake placeholder, never a real-shaped token.
- Forgetting `tests/golden_set.js` runs in BOTH group 1 (curated) and group 2 (full) - fix accuracy, don't lower the threshold.
- A bot-file fix that passes the gauntlet but isn't live until re-paste - reassemble `bot/ExpenseBot_DEPLOY.gs` ([[bot-deploy-paste]]); agents never push main.
