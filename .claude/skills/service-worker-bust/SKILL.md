---
name: service-worker-bust
description: Force the Kesefle PWA service worker (sw.js) to fetch new assets after a deploy when users report seeing stale UI.
---

# Service worker cache bust

`sw.js` caches static assets for PWA install (`install.html` / `manifest.webmanifest`). After a deploy, users running the installed PWA may keep seeing the old version for hours. Bumping the cache version forces a refresh on next load.

## Steps
1. Open `sw.js`. Find the `CACHE_NAME` / `VERSION` constant near the top.
2. Bump to today's date + slug, e.g. `'kesefle-v2026-05-26-1'`.
3. Confirm the install handler deletes old cache names matching the prefix.
4. `vercel.json` already serves `sw.js` with `Cache-Control: no-cache, no-store, must-revalidate` and `Service-Worker-Allowed: /` — keep those headers; if they drift, sw won't update.
5. Commit + push. Vercel deploys.
6. Tell Steven: "PWA users may need to close and reopen the app once for the update." Or, in a strict scenario, push a one-time notice via push API.

## Verification
- DevTools → Application → Service Workers → reload, confirm new version takes over.
- `manifest.webmanifest` updates (if changed) within one reload cycle.
- Check on iOS Safari "Add to Home Screen" instance separately — Apple is stricter about caching.

## Common pitfalls
- Bumping `CACHE_NAME` but not deleting old caches → user disk fills with stale caches over time.
- Forgetting that the SW's update happens on the SECOND visit (first one shows old, second shows new). Tell Steven this so he doesn't think it didn't deploy.
- `vercel.json` cache headers for `sw.js` got reverted in a merge → SW never updates. Re-add them and bump.
- Inline script CSP blocks the SW registration — confirm CSP allows `self` for scripts.
