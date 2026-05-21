---
name: hebrew-copy-check
description: Validate Hebrew text in the product — direction (RTL), bidi/number isolation, brand spelling, and grammar — before shipping any user-facing Hebrew copy or bot message.
---

# Hebrew copy check

## Brand spelling (strict)
- Correct: **כספ'לה** (medial פ + geresh). Wrong: כסף'לה (final ף).
- Scan: `grep -rn "כסף'" *.html` → must be empty.
- English fallback only where a Hebrew brand can't render (e.g. some Meta fields): "Kesefle".

## Direction & bidi
- Page/root containers `dir="rtl"`; English/number islands isolated.
- Numbers, currency, phone, dates, URLs, code: wrap in `.num { direction:ltr; unicode-bidi:isolate }` or `dir="ltr"` so they don't reorder inside RTL.
- Mixed Hebrew+Latin lines: verify punctuation lands on the correct side.

## Source-file hygiene
- Hebrew belongs in **string literals / HTML text**, NOT in code comments (comments must be ASCII — Hebrew there corrupts with bidi marks and breaks diffs).
- When pasting Hebrew, ensure no stray U+200E/U+200F/U+202A-E control chars leaked in.

## Tone & correctness
- Warm, direct, second-person, concise (WhatsApp-friendly). No corporate stiffness.
- Verb gender/number agreement; no machine-translation artifacts.
- CTA text matches the action (e.g. a "send שלום" button must actually send שלום).

## Quick scan
```
grep -rn "כסף'" *.html bot/*.gs            # wrong brand spelling
grep -rnP "[\x{200E}\x{200F}\x{202A}-\x{202E}]" *.html   # stray bidi controls
```
Fix any hit before shipping.
