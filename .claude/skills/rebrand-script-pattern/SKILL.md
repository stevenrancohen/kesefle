---
name: rebrand-script-pattern
description: Use a scripts/*.js sweep to do site-wide replacements (palette, brand, font) atomically across all HTML pages without missing any.
---

# Site-wide rebrand script

`scripts/indigo-rebrand.js`, `scripts/monday-rebrand.js`, `scripts/light-mode-flip.js`, `scripts/add-display-font.js`, `scripts/fix-white-on-white.js` exist because copy-pasting changes into 50 HTML files is how things drift. ALWAYS use a script for cross-page changes.

## Steps
1. Pick the closest existing rebrand script as a template.
2. Create `scripts/<name>.js`. Pattern:
   ```js
   const fs = require('fs');
   const path = require('path');
   const pages = fs.readdirSync('.').filter(f => f.endsWith('.html'));
   let changed = 0;
   for (const p of pages) {
     let s = fs.readFileSync(p, 'utf8');
     const before = s;
     s = s.replace(/OLD/g, 'NEW');
     if (s !== before) { fs.writeFileSync(p, s); changed++; console.log('changed', p); }
   }
   console.log('total', changed);
   ```
3. Dry-run mode FIRST: set `DRY=1` env, log changes without writing. Verify spot-checks.
4. Commit the script ALONGSIDE the changes — so future-you can re-run or audit.
5. Add a one-liner comment at the top: `// scripts/<name>.js — what this did, when, why.`

## Verification
- `git diff --stat` after running — every page that should have changed did.
- `grep -rn "OLD" *.html` → empty (or known exceptions documented inline).
- Run `node tests/full_qa.js` — inline scripts still parse.

## Common pitfalls
- Regex too greedy → swaps an unintended substring (e.g. brand name appearing inside a URL).
- Forgetting `.gs` / `.md` / `.json` files that also contain the old value.
- Not committing the script → next person can't audit "how did this happen?".
- Running on a dirty working tree → impossible to review the rebrand diff cleanly. Commit first, rebrand, commit.
