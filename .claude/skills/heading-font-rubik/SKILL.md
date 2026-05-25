---
name: heading-font-rubik
description: Ensure h1/h2/h3 on every Kesefle HTML page use Rubik 900 (heavy display weight) consistently with the rest of the site.
---

# Heading font: Rubik 900

Kesefle's display font is **Rubik weight 900** for h1/h2/h3. Body is Heebo. New pages or new sections that ship with the default Tailwind / browser font feel off-brand instantly.

## Steps
1. Confirm Rubik is loaded in `<head>`. Pattern (Google Fonts):
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700&family=Rubik:wght@900&display=swap" rel="stylesheet">
   ```
2. Apply font in CSS — usually in a `<style>` block near the top of the file:
   ```css
   h1, h2, h3 { font-family: 'Rubik', 'Heebo', sans-serif; font-weight: 900; }
   ```
3. For Tailwind: utility `font-display` (or whatever the page defines) should map to Rubik. If a page doesn't have the utility, fall back to inline style.
4. Check existing pages with the right look (e.g. `index.html`, `pricing.html`) and match their head + CSS exactly.
5. If adding a 4th-level heading: keep it Heebo body, NOT Rubik — Rubik is reserved for the top three.

## Verification
- Open the page; h1/h2/h3 are visibly heavier and a different face than body text.
- `grep -nE "h[123]\s*{|h[123],?\s*h" <page>.html` shows Rubik wired up.
- DevTools → Computed → `font-family` on an h1 shows Rubik 900.

## Common pitfalls
- Tailwind utility takes precedence over inline style — verify with DevTools.
- Forgetting `font-weight: 900` — Rubik at 400/500 looks wrong for a heading.
- New page references Rubik but didn't import it — silent fallback to system font.
- Rubik 900 with very long Hebrew headings runs long — confirm responsive widths still wrap acceptably.
