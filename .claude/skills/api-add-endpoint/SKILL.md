---
name: api-add-endpoint
description: Pattern for adding a new Vercel serverless endpoint under api/ with the standard auth, rate limit, logging, and tenant-isolation wrappers.
---

# Add an API endpoint

All Kesefle Vercel endpoints follow a tight pattern. Deviating creates auth gaps, leak vectors, or silent failures. Copy from `api/sheet/append.js` or `api/me.js` as templates.

## Steps
1. Decide path. Tenant-scoped data → `api/sheet/<name>.js` or top-level `api/<name>.js`. Admin → `api/admin/<name>.js`. Cron → `api/cron/<name>.js`. Bot bridge → must accept `botSecret`.
2. Boilerplate:
   ```js
   import { withRequestId, log } from '../lib/log.js';
   import { withRateLimit, rateLimitId } from '../lib/ratelimit.js';
   import { requireAuth } from '../lib/auth.js';  // or requireAdmin
   ```
3. Choose auth (see `api-auth-pattern` skill). Wrap handler accordingly.
4. Validate input first thing — reject malformed body with 400 before any KV/Sheets call.
5. Resolve identity: end-user endpoints get `req.user.sub`; bot-bridge endpoints resolve phone → `user:{sub}`.
6. NEVER hardcode a sheet id. Always read from the user's KV record.
7. Wrap response: `{ ok: true, ... }` or `{ ok: false, error: 'snake_case_code' }` (see `api-error-format`).
8. Rate limit: `withRateLimit({ key: '<endpoint_name>', limit: 30, windowSec: 60 })` minimum.

## Verification
- `node --check api/<path>/<name>.js`.
- `node tests/full_qa.js` — add a static-grep guard if the endpoint touches Sheets.
- Hit the endpoint locally via `vercel dev` with curl; auth flow returns the expected error codes.

## Common pitfalls
- Forgetting `botSecret` check on a bot-bridge endpoint → world-writable Sheets endpoint.
- No rate limit → ban-worthy abuse vector.
- Logging the request body verbatim → PII (amounts, vendors, refresh tokens).
- Cross-cutting concerns done inline instead of via middleware → drift between endpoints.
