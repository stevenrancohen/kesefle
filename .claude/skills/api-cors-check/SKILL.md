---
name: api-cors-check
description: Decide when CORS matters for a Kesefle API endpoint and how to set the right origin allowlist without enabling credentialed cross-origin requests by accident.
---

# CORS check

Most Kesefle endpoints are called from the same origin (kesefle.com, kesefle.vercel.app) — no CORS work needed. CORS matters for: external integrations (bot HTTP from Apps Script — different origin), embeddable widgets, third-party developer access. NEVER use `Access-Control-Allow-Origin: *` on a credentialed (auth'd) endpoint.

## Steps
1. Decide: who calls this endpoint cross-origin?
   - Same-origin only → no CORS headers needed. Default.
   - Apps Script bot → no CORS, the bot calls via `UrlFetchApp.fetch`, which doesn't enforce CORS. Just verify `botSecret`.
   - Embeddable / public widget → set `Access-Control-Allow-Origin: *`, but make sure NO credentials accepted.
   - Trusted partner origin → set `Access-Control-Allow-Origin: https://partner.com` (explicit, single value).
2. Preflight: for non-GET/POST or custom headers, handle `OPTIONS`:
   ```js
   if (req.method === 'OPTIONS') {
     res.setHeader('Access-Control-Allow-Origin', allowed);
     res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
     res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-kesefle-bot-secret');
     return res.status(204).end();
   }
   ```
3. Credentialed: if `Access-Control-Allow-Credentials: true`, origin MUST be a specific value, never `*`.
4. Confirm `vercel.json` headers block doesn't accidentally inject a wildcard CORS header on `/api/(.*)`.

## Verification
- `curl -X OPTIONS -H "Origin: https://evil.com" https://kesefle.com/api/<endpoint>` → not allowed.
- `curl -X OPTIONS -H "Origin: https://kesefle.com" https://kesefle.com/api/<endpoint>` → 204 with explicit allow.
- A real cross-origin browser request returns expected CORS headers.

## Common pitfalls
- Adding `*` "to make it work" on a credentialed endpoint → browser correctly refuses, but a malicious page could still scrape data.
- Forgetting `OPTIONS` handler → preflight 404s, real request never fires.
- Missing `x-kesefle-bot-secret` in `Allow-Headers` → bot calls fail in browsers (not Apps Script, which is fine).
