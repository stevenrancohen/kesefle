---
name: add-html-page
description: Pattern for adding a new public HTML page to kesefle.com — head, fonts, palette, scripts, SEO, sitemap entry — matching the existing site conventions.
---

# Add a new HTML page

Kesefle is a flat-file Vercel site — one `.html` per route. Add a page by copying an existing one and replacing content. Don't reinvent head/fonts/scripts.

## Steps
1. Pick a template. Marketing → `pricing.html`. App-like → `dashboard.html`. Long-form text → `privacy.html`.
2. Copy to `<new-name>.html`. URL = `/<new-name>` (Vercel `cleanUrls: true` strips `.html`).
3. In `<head>`, keep ALL of:
   - `<meta charset="UTF-8">`
   - `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
   - `<html lang="he" dir="rtl">`
   - Title (≤ 60 chars, includes brand `כספ'לה`).
   - Description (≤ 155 chars).
   - Canonical: `<link rel="canonical" href="https://kesefle.com/<new-name>">`.
   - OG/Twitter tags.
   - Fonts: Heebo (body) + Rubik 900 (headings) — match other pages.
4. Body: keep the shared header/nav + footer markup verbatim from the template (Kesefle has no component system — copy lives in every page).
5. Add the page to `sitemap.xml` with today's `lastmod`.
6. Run `seo-audit`, `rtl-check`, `light-mode-check`, `responsive-check` skills.
7. Inline scripts: validate them with `inline-script-validate` skill.

## Verification
- `node -e "require('fs').readFileSync('<new-name>.html')"` (file exists and is utf-8).
- Run `node tests/full_qa.js`.
- `grep -c "<h1" <new-name>.html` → `1`.
- After deploy, visit `https://kesefle.com/<new-name>` — renders, no console errors.

## Common pitfalls
- Copying an old page that hasn't been rebranded → wrong logo, wrong palette.
- Forgetting `sitemap.xml` → Google won't crawl.
- Adding `noindex` accidentally (template had it for `admin.html`).
- Inline `<script>` with unescaped Hebrew — `inline-script-validate` will catch.
