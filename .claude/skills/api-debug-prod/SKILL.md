---
name: api-debug-prod
description: Read Vercel production logs for a specific endpoint to diagnose a live error or unexpected behavior reported by a user.
---

# Debug a production API endpoint

When a user reports an error or you see a spike in error rate, get to the logs fast and read them right. Vercel's UI is the source of truth.

## Steps
1. Vercel dashboard → Project (kesefle) → **Logs** tab. Filter by path: `/api/<endpoint>`.
2. Set time window to ≤ the user's reported window. Filter level: `error` first, then `warn`.
3. Each log has a `requestId` (from `withRequestId` in `lib/log.js`). Find the user's request:
   - By phone: search `phone=<digits>`.
   - By email/sub: search `sub=<google-sub>`.
   - By message id (bot): search `messageId=wamid.<...>`.
4. Open the matching log → see the full request lifecycle: rate-limit decision, auth result, KV reads, Sheets call, response.
5. If the error is in a downstream call (Sheets 5xx, KV timeout, OAuth refresh failure), the message usually says so.
6. Reproduce locally with `vercel dev` and the same body (sanitize secrets) before changing code.

## Verification
- You can quote the specific `requestId` and the specific failure line to the user when explaining.
- After fix + deploy, the same path with the same input no longer logs an error.

## Common pitfalls
- Looking at the wrong project / wrong environment (Preview vs Production).
- The error rate looks high because of one bad phone retrying — filter by phone first.
- Trusting a sanitized log over the real input — sometimes a stray Unicode is the bug; ask the user for the EXACT raw message.
- Editing in production via `vercel env` without a paired commit → drift; always commit the code change too.
