---
name: inline-script-validate
description: Validate that all inline <script> blocks in a Kesefle HTML page parse as valid JavaScript using node -e, before committing.
---

# Validate inline scripts

Kesefle pages have inline `<script>` blocks for analytics, init, dropdowns, OAuth callbacks. A typo in any of them silently breaks the page in production (and the CSP allows `unsafe-inline`, so they DO execute). Validate them before commit.

## Steps
1. For each page you changed with inline scripts:
   ```
   node -e "const fs=require('fs');const h=fs.readFileSync('PAGE.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m,i)=>{try{new Function(m[1])}catch(e){console.log('block',i,e.message);process.exit(1)}});console.log('ok')"
   ```
2. Replace `PAGE.html` with the file. `ok` means all blocks parse.
3. If a block fails, the index tells you which one — count `<script>` openings in the file to find it.
4. NOTE: `new Function(src)` checks SYNTAX. It does NOT execute the code; runtime errors won't surface here. For runtime, open the page in a browser with DevTools open.
5. `<script src="...">` blocks aren't checked — they're external files; check them separately (usually `node --check js/<name>.js`).

## Verification
- Output line `ok`. Exit code 0.
- Repeat for every changed page. `deploy-checklist` skill encodes this loop.

## Common pitfalls
- A Hebrew string literal without escaped quotes inside a script — syntax error.
- A template literal that contains unescaped backticks from a copy-paste.
- Trailing comma in object literal where the parser running on Vercel disagrees with your local Node.
- The check passes but the script still throws at runtime (e.g. uses an undefined global). Open the page and watch the console.
