# Subresource Integrity (SRI) Hashes — External Resources

This document lists **every external `<script>` and `<link rel="stylesheet">` URL** loaded by any HTML page in this repo, and the SHA-384 SRI hash that should be pinned on each.

The placeholder hashes below (`sha384-PLACEHOLDER_...`) are **NOT real** — they must be recomputed from the live bytes before they are added to HTML. See "How to compute" at the bottom.

---

## Inventory by file

### `index.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 43 | `https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap` | `<link rel="stylesheet">` | **SKIP** — Google Fonts CSS is dynamically generated per User-Agent (different `unicode-range` declarations per browser) → SRI will mismatch. Mitigate via CSP `style-src https://fonts.googleapis.com` instead. |
| 44 | `https://cdn.tailwindcss.com?plugins=forms,typography` | `<script>` | **CRITICAL — DO NOT USE THIS CDN IN PRODUCTION.** This is the Tailwind Play CDN (warned against by Tailwind authors). Migrate to a self-hosted compiled bundle, then SRI is trivial: `sha384-<hash of your built tailwind.css>`. Until then: `sha384-PLACEHOLDER_TAILWIND_CDN` |
| 56 | `https://accounts.google.com/gsi/client` | `<script async defer>` | **SKIP / use CSP** — Google republishes this file unannounced (sometimes daily). Pinning SRI will break sign-in randomly. Mitigate via CSP `script-src https://accounts.google.com`. |
| 64 (lazy) | `https://connect.facebook.net/he_IL/sdk.js` | injected `<script>` | Use a **version-pinned** URL: `https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0`. Then: `sha384-PLACEHOLDER_FB_SDK_v19_0` |
| 65 (lazy) | `https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/he_IL/appleid.auth.js` | injected `<script>` | `sha384-PLACEHOLDER_APPLE_ID_JS` (Apple is more stable than Google GSI; weekly check is reasonable.) |

### `account.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 8  | `https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap` | `<link rel="stylesheet">` | SKIP (see index.html row 43) |
| 9  | `https://cdn.tailwindcss.com` | `<script>` | `sha384-PLACEHOLDER_TAILWIND_CDN_NOPLUGINS` — note this is a *different* URL from index.html (no `?plugins=...` query), so a different hash |
| 15 | `https://accounts.google.com/gsi/client` | `<script async defer>` | SKIP (see index.html row 56) |

### `dashboard.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 11 | `https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap` | `<link rel="stylesheet">` | SKIP |
| 12 | `https://cdn.tailwindcss.com` | `<script>` | `sha384-PLACEHOLDER_TAILWIND_CDN_NOPLUGINS` (same URL as account.html line 9 → same hash) |

### `privacy.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 7 | `https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap` | `<link rel="stylesheet">` | SKIP (different weight subset from above → would be a different hash anyway, but the underlying CSS-per-UA issue stands) |
| 8 | `https://cdn.tailwindcss.com` | `<script>` | `sha384-PLACEHOLDER_TAILWIND_CDN_NOPLUGINS` |

### `terms.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 7 | `https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&display=swap` | `<link rel="stylesheet">` | SKIP |
| 8 | `https://cdn.tailwindcss.com` | `<script>` | `sha384-PLACEHOLDER_TAILWIND_CDN_NOPLUGINS` |

### `test.html`

| Line | URL | Tag | Suggested integrity |
|---|---|---|---|
| 7 | `https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800;900&display=swap` | `<link rel="stylesheet">` | SKIP |
| 8 | `https://cdn.tailwindcss.com` | `<script>` | `sha384-PLACEHOLDER_TAILWIND_CDN_NOPLUGINS` |

---

## How to compute a real SHA-384 SRI hash

Run this on a machine that can reach the live URL:

```bash
curl -s 'https://cdn.tailwindcss.com' | openssl dgst -sha384 -binary | openssl base64 -A
```

Prepend `sha384-` to the output to get the value for the `integrity` attribute:

```html
<script
  src="https://cdn.tailwindcss.com"
  integrity="sha384-<base64 output here>"
  crossorigin="anonymous"
></script>
```

Computed example template (replace `<base64>` with the actual base64 from the openssl run):

```html
<!-- index.html line 44 -->
<script src="https://cdn.tailwindcss.com?plugins=forms,typography"
        integrity="sha384-<base64>"
        crossorigin="anonymous"></script>

<!-- account.html line 9, dashboard.html line 12, privacy.html line 8, terms.html line 8, test.html line 8 -->
<script src="https://cdn.tailwindcss.com"
        integrity="sha384-<base64>"
        crossorigin="anonymous"></script>

<!-- index.html line 64 (after pinning to v19.0) -->
<script src="https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v19.0"
        integrity="sha384-<base64>"
        crossorigin="anonymous"
        async defer></script>

<!-- index.html line 65 -->
<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/he_IL/appleid.auth.js"
        integrity="sha384-<base64>"
        crossorigin="anonymous"
        async defer></script>
```

---

## Important caveats — why SRI is **not enough by itself**

1. **Google Fonts CSS and the GSI client cannot be safely SRI-pinned** because the served bytes vary by UA (fonts) or change frequently without versioning (GSI). For these, defense lives in **CSP**:
   ```
   Content-Security-Policy:
     script-src 'self' https://accounts.google.com https://apis.google.com https://connect.facebook.net https://appleid.cdn-apple.com;
     style-src 'self' https://fonts.googleapis.com 'unsafe-inline';
     font-src 'self' https://fonts.gstatic.com;
   ```
   Add this header in `vercel.json` under `headers`.

2. **`cdn.tailwindcss.com` is the single highest-risk dependency in this repo.** It is a CDN with no version pinning, no SRI guarantee, and Tailwind authors explicitly say not to use it in production. The right fix is not "add SRI" — it is "stop using this CDN":
   ```bash
   npm install -D tailwindcss
   npx tailwindcss -i src/in.css -o public/assets/tailwind.css --minify
   ```
   Then in every HTML file replace `<script src="https://cdn.tailwindcss.com...">` with `<link rel="stylesheet" href="/assets/tailwind.css">` and add the SRI hash of the **built file** (which never changes between deploys).

3. **SRI on Google GSI / Facebook SDK breaks login when the vendor republishes.** This is operational pain. The realistic policy:
   - SRI hard-required for Tailwind (post-self-host).
   - CSP allow-list for Google/Facebook/Apple SDKs.
   - Automated weekly cron that recomputes hashes for any pinned vendor URLs you do choose to SRI-pin, and opens a PR with the new hash. Treat hash mismatches in production as a P1 incident — investigate before bumping.

4. **`crossorigin="anonymous"` is mandatory** alongside `integrity=` for cross-origin resources. Without it, the SRI check is silently skipped by the browser.

---

## Verification checklist before deploying SRI changes

- [ ] All `cdn.tailwindcss.com` references replaced with self-hosted `/assets/tailwind.css`.
- [ ] SRI computed for the **exact byte stream** the browser will fetch (including any redirects — `curl -L`).
- [ ] `integrity=` and `crossorigin="anonymous"` both present on each external `<script>` / `<link rel="stylesheet">`.
- [ ] CSP header added in `vercel.json` covering all remaining external origins.
- [ ] Test in **all** target browsers — SRI mismatches cause silent failures in Safari that don't appear in Chrome devtools the same way.
- [ ] Login flows (Google, Facebook if enabled, Apple if enabled) all succeed end-to-end after the change.
- [ ] CI lint step that fails the build if any HTML file contains a `<script src="https://...">` without an `integrity=` attribute (excepting the documented SKIP list above).
