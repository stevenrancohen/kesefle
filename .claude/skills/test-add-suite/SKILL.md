---
name: test-add-suite
description: Add a new Node test suite under tests/ or bot/ following the Kesefle pattern of loading REAL source via balanced-brace extraction, no mocking framework.
---

# Add a test suite

Kesefle's tests use plain `node` — no Jest, no Mocha, no framework. Each suite is a single file that loads real source via `extractFn` (balanced-brace), runs assertions with a small `ok()` helper, exits non-zero on failure. Match this style.

## Steps
1. Decide where: `bot/test_<name>.js` for bot-only logic, `tests/test_<name>.js` for shared/api logic.
2. Boilerplate (copy from `bot/test_isolation.js` or `tests/test_professions.js`):
   ```js
   const fs = require('fs');
   const path = require('path');
   const ROOT = path.join(__dirname, '..');  // adjust for location
   let pass = 0, fail = 0;
   function ok(label, cond) {
     if (cond) { pass++; console.log('  ok ' + label); }
     else { fail++; console.log('  FAIL ' + label); }
   }
   ```
3. Load real source: `fs.readFileSync(...)` + balanced-brace `extractFn` for the function under test. NO mocks, NO ESM imports of source (Apps Script `.gs` isn't ESM).
4. Mock the Apps Script env at the top (PropertiesService, Logger, UrlFetchApp) — see `bot/test_isolation.js:18-26` for the standard mock.
5. Print summary + `process.exit(fail ? 1 : 0)`.
6. Wire into `tests/full_qa.js` if it's a security/isolation guard, or into `deploy-checklist` if it's a per-deploy gate.

## Verification
- `node tests/test_<name>.js` exits 0 when assertions pass.
- Deliberately break one assertion — exits 1, prints FAIL.
- The suite runs in < 5s (no network, no Sheets calls).

## Common pitfalls
- Importing the bot `.gs` as if it were Node — won't work; use `extractFn` to pull individual functions.
- Async tests without awaiting — `fail` count is wrong, false positives.
- Hardcoding a real phone or sheet id → leaks PII into the repo.
- Forgetting `process.exit(fail ? 1 : 0)` — CI thinks the suite passed.
