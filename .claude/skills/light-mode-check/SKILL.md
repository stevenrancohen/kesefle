---
name: light-mode-check
description: Verify a new or changed UI element works in light mode (no white-on-white, no invisible text, contrast acceptable) before merging.
---

# Light mode check

Kesefle's HTML pages have a light-mode palette baked in via inline `<style>` and the Tailwind CDN. New elements often inherit a dark-mode color by accident (white text on a white card, gray text on a gray panel). `scripts/fix-white-on-white.js` and `scripts/light-mode-flip.js` exist exactly because this keeps happening.

## Steps
1. Open the page in a browser (Brave preferred per project convention) at the URL it ships on.
2. For each new element:
   - Inspect element. Is `color` the same as the parent `background-color`? If yes → white-on-white.
   - Check `:hover` and `:focus` states too — they're easy to miss.
   - Disabled buttons: must still be readable (gray on white OK, white on white NOT).
3. Run `node scripts/fix-white-on-white.js <page>.html` if it's a known pattern; review the diff before committing.
4. Compare against an existing page that does it right (e.g. `pricing.html`, `account.html`).

## Verification
- Visual sweep at 100% browser zoom — every text/icon/border is visible against its background.
- Contrast ratio ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI components (WCAG AA).
- Take a screenshot and share with Steven (see `screenshot-share-with-user` skill).

## Common pitfalls
- Tailwind class `text-white` on a `bg-white` parent → invisible.
- A new `<input>` that inherits `color: inherit` from a dark scope.
- Modals / dropdowns that open with a transparent background and inherit nothing — looks fine on the trigger, broken when opened.
- Forgetting to also check the `:focus-visible` ring color — invisible focus ring is an a11y bug, not just a visual one.
