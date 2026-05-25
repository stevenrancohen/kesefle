---
name: test-hebrew-text
description: Assert that Hebrew strings in test fixtures or rendered output have no bidi control characters, RTL corruption, or wrong brand spelling.
---

# Test for Hebrew text integrity

Hebrew strings travel through copy-paste, GSheet cells, KV (JSON-encoded), and inline HTML. Each hop can sneak in U+200E/200F bidi marks or corrupt the brand spelling. Assert directly when a test fixture contains Hebrew.

## Standard assertions
```js
function assertCleanHebrew(label, s) {
  // No bidi control chars.
  ok(label + ' no bidi marks', !/[‎‏‪-‮]/.test(s));
  // Brand spelled correctly — never wrong-form.
  ok(label + ' no wrong-brand', !/כסף'/.test(s));
  // No mojibake (UTF-8 decoded as latin-1 produces "×" sequences).
  ok(label + ' no mojibake', !/×[0-9A-Fa-f]/.test(s));
  // If text has Hebrew, it should have at least one Hebrew letter.
  if (/[א-ת]/.test(s) || /<dir="rtl"/.test(s)) {
    ok(label + ' has hebrew letters', /[א-ת]/.test(s));
  }
}
```

## Steps
1. Drop the helper at the top of your test or in a shared `tests/_helpers.js`.
2. Call `assertCleanHebrew('<label>', stringUnderTest)` for every Hebrew string fixture / response.
3. For HTML pages: also run `inline-script-validate` skill (separate concern).
4. For bot replies: assert each known reply string passes.

## Verification
- All three regex tests print pass for healthy text.
- Deliberately inject a `‎` into a fixture → test fails.
- `node tests/full_qa.js` still green.

## Common pitfalls
- Asserting EXACT byte equality of Hebrew strings — flaky when the source editor inserts a NBSP. Normalize first if needed.
- Not running this on dynamic strings — bot reply generators may interpolate user input; PII or corruption can sneak in there.
- Limiting to the brand spelling check only — bidi marks are the more common corruption.
- Asserting bytes via a regex that itself contains a bidi mark from a copy-paste — the test source is itself corrupted; review the file with `cat -v` or hex.
