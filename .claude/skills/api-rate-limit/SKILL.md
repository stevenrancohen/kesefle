---
name: api-rate-limit
description: Apply withRateLimit / rateLimitId from lib/ratelimit.js to a new endpoint with sensible per-route limits tuned to expected user volume.
---

# Rate limit a new endpoint

`lib/ratelimit.js` exports `rateLimit(req, opts)`, `rateLimitId(id, opts)`, and `withRateLimit({...})` middleware. KV-backed (Upstash) INCR with TTL; fails OPEN if KV is unreachable (logged, but not 429) — by design, we'd rather take a hit than deny legit traffic during an Upstash outage.

## Steps
1. Pick a limit. Reasonable defaults:
   - User read endpoints: `limit: 60, windowSec: 60` (1/sec, per-IP).
   - User write endpoints: `limit: 30, windowSec: 60`.
   - Bot bridge (per phone): `limit: 60, windowSec: 60` — phone abuse is rare but possible.
   - Public/no-auth: `limit: 20, windowSec: 60` plus per-IP.
2. Use middleware form for IP-based limiting:
   ```js
   import { withRateLimit } from '../lib/ratelimit.js';
   const limited = withRateLimit({ key: 'endpoint_name', limit: 30, windowSec: 60 });
   ```
3. For per-phone or per-sub limiting, use `rateLimitId(phone, { key: 'append_phone', limit: 60, windowSec: 60 })` INSIDE the handler — IP isn't stable for WhatsApp.
4. Apply BOTH per-IP and per-phone for bot-bridge endpoints. Strictest wins.
5. On 429, return `{ ok: false, error: 'rate_limited', retryAfterSec: <n> }`.

## Verification
- Hit the endpoint in a tight loop with curl; the (N+1)th request returns 429.
- KV key `rl:endpoint_name:<id>` exists in Upstash console after a burst.
- Failure mode: temporarily set `KV_REST_API_URL` to a bogus value, hit endpoint — should still return 200 (fail-open) with a logged warning.

## Common pitfalls
- Forgetting per-phone limit on bot endpoints → one bad phone DoSes the bridge.
- Using a stale IP from a load balancer chain — confirm `req.headers['x-forwarded-for']` parsing in `rateLimitId`.
- Too-tight limits on background-job paths (cron, recurring) — they should rate-limit on the source caller, not the cron itself.
