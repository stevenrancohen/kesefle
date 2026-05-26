# Frontend QA Audit — 2026-05-27

Scope: public pages only (index, start, account, pricing, about, contact, team, blog, press, privacy, en, 404, install). Source-only scan; no browser render.

## Executive Summary

The site is structurally healthy: every page has correct charset, viewport, title, canonical, lang/dir, and OG/Twitter cards; `account.html` and `404.html` are properly noindexed. No bidi corruption in Hebrew copy, no missing alt attributes, every `onclick` handler resolves. The blocking issues are **content/IA consistency**, not code bugs: the WhatsApp CTA points to two different phone numbers depending on the landing page, the header dropdowns have items that were deleted but not tidied, and `/install` is orphaned from the site nav. About one day of content cleanup, not a refactor.

## Critical (blocks user → ship)

1. **Two different WhatsApp CTA numbers across the site.** Every public page except `/contact` sends to the US-format `+1-555-640-8123` (`wa.me/15556408123`); `contact.html:175` sends to the founder's IL mobile `+972-54-776-0643`. Same CTA, different chat. Pick one and sweep. Hits: `index.html:73,1554,1603`, `start.html:186,201,290,303`, `about.html:41,378,728,802`, `account.html:573`, `blog.html:733`, `pricing.html:822`, `privacy.html:200`, `team.html:378`, `press.html` footer.
2. **US-format phone shown inside the privacy policy.** `privacy.html:200` exposes "+1-555-640-8123" on a legal page — reads as fake/test to any Israeli user or regulator.

## High (broken UX, not a blocker)

3. **Header "המוצר" dropdown contains only one item ("הדגמה חיה") on every page.** The HTML comments still list `<!-- 1. המוצר -->` then jump to `<!-- 3. מחירים -->` — item 2 was deleted but the comment numbering reveals the seam. Example: `start.html:96-104`, `install.html:83-91`, identical on `team.html`, `index.html`, others. A single-item dropdown is worse UX than just a top-level link.
4. **"החברה" dropdown has trailing empty `<a>` slots (whitespace-only).** `start.html:131-135`, `install.html:118-122` — deleted links left two empty lines inside the dropdown div, causing visual padding gaps.
5. **`/install` is orphaned from the public nav.** No page in the target set links to `/install` in the header, footer, or body. The page is only reachable via redirects (`/pwa`, `/app`, `/download`, `/install-app`). Either add it to the "המוצר" dropdown or remove it from sitemap.xml.
6. **`team.html` footer omits `/team`, `/press`, `/en` self-references.** Compare `team.html:371-378` (has team/press/en) vs `start.html` footer — start.html and 404.html footers are missing the "החברה" + language column entirely. Inconsistent footer between pages.
7. **`contact.html:200` shows "בקרוב" placeholder under "רשתות" social card.** It's a real placeholder ("we haven't opened social channels yet"), not test content, but as a 3rd of a 3-column contact grid it looks like a broken card next to the working WhatsApp and email cards.
8. **`en.html:372` "Premium · coming soon" with a real price (₪29/mo) and full feature list.** English-speaking visitors see a paid plan that doesn't exist yet. Either ship the plan, hide the card, or change the badge.

## Medium (polish)

9. **`account.html:341` and `account.html:417` have `href="#"`.** Both are runtime-populated by JS (`#link-wa-deeplink` and `#sheet-link`). Not a real bug, but if JS fails to load the user lands on `#` (no-op). Consider `href="javascript:void(0)"` or removing the href until JS runs.
10. **`index.html:222`, `pricing.html:120`, `about.html:188`, `en.html:104`, `team.html:107`, `press.html:103` all set `color: white` in `<style>` blocks for badge text.** Each is layered on a colored gradient — safe — but the pattern is repeated 6 times instead of being in `/css/brand.css`.
11. **`account.html:1192` placeholder text is `email@example.com`.** Acceptable convention, just noting it for the hardcoded-string scanner.
12. **`404.html` has `<meta property="og:url" content="https://kesefle.com/" />`** pointing to homepage, not the actual 404 URL. Intentional per the comment on line 9-10, just confirming.
13. **`account.html` uses inline `style="..."` extensively inside JS-generated HTML** (`account.html:1191-1192`, `account.html:1671`, etc.). Functions, but blocks future CSP tightening from `'unsafe-inline'`.

## Top 10 fixes to ship this week

- Pick one canonical WhatsApp number and sweep — `index.html:73,1554,1603`, `start.html:186,201,290,303`, `about.html:41,378,728,802`, `account.html:573`, `blog.html:733`, `pricing.html:822`, `privacy.html:200`, `team.html:378`
- Fix the Israeli phone shown on the legal page — `privacy.html:200`
- Remove the broken "המוצר" single-item dropdown or add real items — `start.html:96-104` (sweep all 13 nav-bearing pages)
- Strip trailing empty `<a>` slots from "החברה" dropdown — `start.html:131-135`, `install.html:118-122` (sweep)
- Add `/install` to the "המוצר" dropdown or drop it from sitemap — `start.html:101`
- Restore the "החברה" / language column in the 404 footer — `404.html:175-200`
- Either ship Premium tier on /en or rewrite the card copy — `en.html:371-380`
- Replace contact "בקרוב" card with something useful or hide it on mobile — `contact.html:194-202`
- Audit `account.html:341,417` href="#" — make `#` no-op proof if JS fails
- Move repeated `color: white` badge `<style>` blocks to `/css/brand.css` — `index.html:222`, `pricing.html:120`, `about.html:188`, `en.html:104`, `team.html:107`, `press.html:103`

## Clean categories

- Bidi/RTL control chars in Hebrew copy — clean
- Missing `alt` on images — clean (only `account.html:189` is `alt=""` for a decorative ring avatar)
- Forms missing method/action — clean (both forms are JS-handled via `onsubmit`)
- `<a href="/old-path">` to deleted pages — clean
- Undefined onclick handlers — clean
- Missing `<meta charset>`/viewport/title/canonical — clean
- White-on-white contrast risk — clean
