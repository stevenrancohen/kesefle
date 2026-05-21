---
name: seo-audit
description: Per-page SEO checklist for kesefle.com (Hebrew SaaS). Use when adding or editing a public page, or auditing existing ones, to ensure on-page SEO, structured data, and social tags are correct.
---

# SEO audit (per page)

## On-page
- [ ] Exactly one `<h1>`, descriptive and keyword-relevant; logical h2/h3 order (no skips).
- [ ] `<title>` ≤ ~60 chars, unique, includes the page's primary Hebrew query + brand "כספ'לה".
- [ ] `<meta name="description">` ≤ ~155 chars, compelling, unique.
- [ ] All `<img>` have meaningful `alt` (empty `alt=""` only for decoration).
- [ ] Internal links use real descriptive anchor text (not "כאן"/"לחץ כאן").

## Technical
- [ ] `<link rel="canonical">` present and self-referential.
- [ ] `hreflang` he / en / x-default where an English equivalent exists.
- [ ] Page is in `sitemap.xml` with `lastmod` (unless intentionally noindex like /admin).
- [ ] `viewport` meta with `viewport-fit=cover`.

## Structured data (JSON-LD) — only what truly applies
- [ ] `Organization` / `WebSite` (site-wide).
- [ ] `SoftwareApplication` on product pages.
- [ ] `FAQPage` only if real Q&A is visible on the page.
- [ ] `BreadcrumbList` if breadcrumbs exist.
- [ ] `Article` on blog posts (headline, datePublished, author).
- Validate: required props present; no markup for content not on the page (Google penalizes mismatch).

## Social
- [ ] og:title, og:description, og:image (real, exists), og:url, og:type.
- [ ] twitter:card = summary_large_image (og: tags serve as fallback).

## Quick scans
```
grep -c "<h1" PAGE.html          # must be 1
grep -nE 'name="description"|rel="canonical"|og:image' PAGE.html
```

## Don't
- No keyword stuffing, hidden text, doorway pages, or schema for invisible content.
- Don't fabricate FAQ/review markup.
