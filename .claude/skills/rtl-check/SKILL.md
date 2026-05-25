---
name: rtl-check
description: Verify Hebrew content in a page or component renders correctly RTL with numbers, URLs, and code blocks isolated LTR.
---

# RTL check

Kesefle is Hebrew-first. The page root has `dir="rtl"`. Mixed Hebrew + Latin / numbers must isolate Latin to LTR or you get visually reordered nonsense (parens flip, sentence ends jump to the wrong side).

## Steps
1. Page has `<html lang="he" dir="rtl">` (or equivalent on the body / main container).
2. Every numeric / currency / phone / date / URL / code island has explicit LTR. Patterns:
   - `<span dir="ltr">972-52-600-3090</span>`
   - `<span class="num">$245.00</span>` where `.num { direction: ltr; unicode-bidi: isolate; }`
3. Punctuation lands on the correct side. Run the rendered page through a quick visual scan — sentence-ending `.` / `?` should be on the LEFT (end-of-line in RTL).
4. Form inputs: `<input dir="auto">` for fields that might receive either Hebrew or Latin/numbers.
5. Icons that have direction (arrows, chevrons): use logical-property CSS (`margin-inline-start`, `padding-inline-end`) instead of `margin-left`. Chevrons in a "back" button should point in the correct RTL direction.

## Verification
- Visual: render the page in Brave; nothing reads backwards.
- `grep -nP "[\x{200E}\x{200F}\x{202A}-\x{202E}]" PAGE.html` → empty (no stray bidi control marks).
- Run `hebrew-copy-check` skill on any new Hebrew text.

## Common pitfalls
- Putting a number inline with Hebrew without LTR isolation — `"שלם 100 ₪"` may render the currency on the wrong side.
- Copy-pasting from Word / Slack — invisible bidi control chars (U+200E/200F/202A-E) leak in.
- Using `margin-left` in stylesheet — works in LTR, breaks symmetry in RTL. Use `margin-inline-start`.
- A `<table>` whose columns visually swap because of `dir="rtl"` — that's correct! If the layout looks wrong, the data labels are wrong, not the direction.
