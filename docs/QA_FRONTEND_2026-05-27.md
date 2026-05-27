# Frontend QA Audit — 2026-05-27

Scope: public pages only (index, start, account, pricing, about, contact, team, blog, press, privacy, en, 404, install). Source-only scan; no browser render.

## Executive Summary

The site is structurally healthy: every page has correct charset, viewport, title, canonical, lang/dir, and OG/Twitter cards; `account.html` and `404.html` are properly noindexed. No bidi corruption in Hebrew copy, no missing alt attributes, every `onclick` handler resolves. The blocking issues are **content/IA consistency**, not code bugs: the WhatsApp CTA points to two different phone numbers depending on the landing page, the header dropdowns have items that were deleted but not tidied, and `/install` is orphaned from the site nav. About one day of content cleanup, not a refactor.

## Critical (blocks user → ship)

1. **Two different WhatsApp CTA numbers across the site.** Every public page except `/contact` sends to the US-format `+1-555-640-8123` (`wa.me/15556408123`); `contact.html:175` sends to the founder's IL mobile `+972-54-776-0643`. Same CTA, different chat. Pick one and sweep. Hits: `index.html:73,1554,1603`, `start.html:186,201,290,303`, `about.html:41,378,728,802`, `account.html:573`, `blog.html:733`, `pricing.html:822`, `privacy.html:200`, `team.html:378`, `press.html` footer.
2. **US-format phone shown inside the privacy policy.** `privacy.html:200` exposes "+1-555-640-8123" on a legal page — reads as fake/test to any Israeli user or regulator.

## High (broken UX, not a blocker)

3. **"המוצר" dropdown has only one item on every page.** Source shows `<!-- 1. המוצר -->` jumping to `<!-- 3. מחירים -->` — item 2 was deleted. Example: `start.html:96-104`, `install.html:83-91`; same on `team.html`, `index.html`, all nav-bearing pages. A one-item dropdown is worse UX than a top-level link.
4. **"החברה" dropdown has trailing empty `<a>` slots (whitespace-only).** Deleted links left two empty lines and visual padding gaps. `start.html:131-135`, `install.html:118-122`, plus sweep.
5. **`/install` is orphaned from the public nav.** No target page links to `/install` in header, footer, or body. Only reachable via `/pwa`, `/app`, `/download`, `/install-app` redirects. Add to "המוצר" dropdown or drop from sitemap.xml.
6. **Footers are inconsistent across pages.** `start.html` and `404.html` are missing the "החברה" + language column; `team.html` self-includes `/team`/`/press`/`/en` but other pages don't. Pick one footer.
7. **`contact.html:200` shows "בקרוב" placeholder under "רשתות" card.** Real placeholder ("no social channels yet"), but as 1 of 3 contact cards next to working WhatsApp/email it reads as broken.
8. **`en.html:371-380` "Premium · coming soon" shows a real price (₪29/mo) and full feature list.** English visitors see a paid plan that doesn't exist. Ship it, hide it, or change the badge.

## Medium (polish)

9. **`account.html:341,417` use `href="#"`** — populated by JS at runtime. Not a bug, but if JS fails the user jumps to top. Use `javascript:void(0)` or strip until JS runs.
10. **6 pages repeat `color: white` badge `<style>` blocks** instead of using `/css/brand.css`: `index.html:222`, `pricing.html:120`, `about.html:188`, `en.html:104`, `team.html:107`, `press.html:103`. All safe (layered on gradients).
11. **`account.html` builds HTML strings with heavy inline `style="..."`** (e.g. `account.html:1191-1192,1671`). Works, but blocks future CSP tightening of `'unsafe-inline'`.

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
