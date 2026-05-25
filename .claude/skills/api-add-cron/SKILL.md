---
name: api-add-cron
description: Add a new scheduled job to vercel.json crons block plus the matching handler under api/cron/ with the right auth and idempotency guards.
---

# Add a Vercel cron

Crons are declared in `vercel.json` `crons` array (line ~106). Vercel hits the path on schedule with header `x-vercel-cron: 1`. Existing crons:
- `/api/cron/kv-backup` daily 03:00
- `/api/cron/reminders` daily 06:00
- `/api/cron/recurring` daily 06:05
- `/api/cron/lifecycle` daily 07:00
- `/api/cron/budget-check` daily 08:00
- `/api/cron/kv-monitor` hourly
- `/api/cron/steven-daily-digest` daily 06:00

## Steps
1. Create `api/cron/<name>.js`. Boilerplate:
   ```js
   export default async function handler(req, res) {
     if (!req.headers['x-vercel-cron'] && process.env.NODE_ENV === 'production') {
       return res.status(401).json({ ok: false, error: 'cron_only' });
     }
     // ... work ...
   }
   ```
2. Add to `vercel.json` `crons` array. Cron expr is UTC. Pick a slot that doesn't collide with existing jobs.
3. Keep handler IDEMPOTENT — Vercel may invoke twice on retries. Use a KV `cron:<name>:lastRun:<date>` guard.
4. Budget the job: Vercel free tier has execution time limits; long jobs should chunk via a self-rescheduling pattern or move to an external worker.
5. Log start, end, count of items processed. The `steven-daily-digest` cron is a good template.

## Verification
- Manually invoke locally: `vercel dev` + `curl -H "x-vercel-cron: 1" localhost:3000/api/cron/<name>`.
- Deploy + check Vercel logs at the next scheduled time — confirm exactly one execution.
- Re-run the same time slot — second invocation no-ops thanks to the idempotency guard.

## Common pitfalls
- Forgetting the `x-vercel-cron` check → anyone can trigger your cron over the public URL.
- Not idempotent → duplicate emails/notifications when Vercel retries.
- Cron time in IL local → wrong. UTC always.
- Long-running job times out at Vercel's serverless limit; result is a partial run with no resume.
