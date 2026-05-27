# regression-test-no-eval

The Kesefle pattern for writing regression tests that read source as a string and assert structure. **No eval, no mocking framework, no live KV/Sheets dependency.** Used by every test in `bot/test_*.js` and `tests/test_*.js`.

## When to use

Any time you ship a bug fix or new behaviour pattern that future contributors could re-break. Especially:
- Security fixes (force the guard to stay in place)
- "Don't do X" patterns (force X to never appear in active code)
- Endpoint shape contracts (response key names, status codes)

## Pattern

```js
#!/usr/bin/env node
// Regression test for PR-XX (one-sentence what + audit reference).
//
// What this guards:
//   1. ...
//   2. ...

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_<name>.js\n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', '...'), 'utf8');

// Strip comments so doc lines that mention the bug don't false-positive.
const CODE = SRC.split('\n')
  .filter(line => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('What we guard:');
assert(/PATTERN_THAT_MUST_EXIST/.test(CODE), 'description');
assert(!/PATTERN_THAT_MUST_NOT_EXIST/.test(CODE), 'description');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
```

## Critical rules

1. **Strip comments before regex** — otherwise your test fails because YOUR doc-comment in the fix mentions the bug.
2. **Use word boundaries** in regex when checking for variable names (`\bsetState\b`, not `setState`).
3. **Anchor by surrounding context** when matching a single line in a big file — `if\s*\(\s*X\s*\)\s*\{` not just `X`.
4. **Test for absence AND presence** — both "old bad pattern is gone" and "new good pattern is here".
5. **Print PASS/FAIL line per assertion** so the runner output is grep-able.
6. **Exit 1 on any failure** — runs in CI.
7. **Don't import the source** unless it's tiny — string-read is faster and avoids module-system surprises.

## Where to hook it

After writing the test, add it to `tests/full_qa.js`'s "Bot tests" or "API tests" loop so it runs in the gauntlet. Find the existing pattern and append a new line.

## Examples in repo

- `tests/test_winback_token_exact_match.js` — full pattern with comment-stripping
- `tests/test_ratelimit_arg_order.js` — repo-wide walk + spot-check
- `tests/test_sheet_ownership_guard_5_endpoints.js` — multi-file scan with shared assertions
- `bot/test_expanded_category_picker.js` — picker structure assertions

## Anti-patterns

- Don't `eval()` the source. Brittle + security.
- Don't `require()` the file and call its exports unless the test is a pure-function check. Most Kesefle files have side effects on import.
- Don't depend on live KV/Sheets/HTTP. Tests must run offline.
- Don't assert on test fixture data that's not also in the file under test (false correlation).
