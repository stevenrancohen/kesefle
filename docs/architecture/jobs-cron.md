# 4. Background Jobs & Cron

## The split: Vercel Cron for **scheduled**, DB queue for **on-demand retries**, Apps Script for **bot side**

We don't need a real worker (no Kafka, no SQS, no BullMQ). For our scale (target 10k users), Vercel Cron + a `jobs` table is plenty.

### Three places work runs

| Place | What runs | Why |
|---|---|---|
| **Vercel Cron** (scheduled HTTP) | Token-refresh sweep, weekly summary, inactivity nudge, billing alerts, deep health check, job-queue drainer | Vercel-native, free, no extra infra. Hits a normal route. |
| **`jobs` table** in Supabase (drained every minute) | Retry sheet write, send email, issue tax invoice, anything triggered by user action that can fail and need to retry | Survives across deploys; idempotent via `attempts`; visible to admin UI. |
| **Apps Script triggers** (bot side) | Anything that has to act inside the user's sheet WITHOUT a fresh API call from our server (e.g. nightly rollup formulas, dashboard refresh formulas) | Free, runs in the user's Google project, doesn't burn our quotas. |

## Vercel cron schedule (`vercel.json`)

```json
{
  "crons": [
    { "path": "/api/cron/process-jobs",     "schedule": "* * * * *" },
    { "path": "/api/cron/refresh-tokens",   "schedule": "*/15 * * * *" },
    { "path": "/api/health/deep",           "schedule": "*/5 * * * *" },
    { "path": "/api/cron/weekly-summary",   "schedule": "0 6 * * 0" },
    { "path": "/api/cron/inactivity-nudge", "schedule": "0 8 * * *" },
    { "path": "/api/cron/billing-alerts",   "schedule": "0 5 * * *" },
    { "path": "/api/cron/prune-stripe-events", "schedule": "0 3 * * 0" }
  ]
}
```

Times in UTC. Sunday 06:00 UTC = 09:00 IDT.

## Cron handler pattern

Every cron handler:
1. Verifies the caller is Vercel cron (`x-vercel-cron: 1` header).
2. Has a hard timeout matching Vercel's 60s (Hobby) / 300s (Pro) function limit.
3. Uses a DB advisory lock so concurrent invocations don't double-process.
4. Returns a tiny JSON summary that Better Stack picks up via log.

```js
// /api/cron/process-jobs.js
import { db, sql } from '../../lib/db.js';
import { runJob } from '../../lib/jobs.js';
import { log } from '../../lib/log.js';

const MAX_WALL_MS = 50_000;       // leave 10s headroom below 60s timeout
const BATCH = 25;

export default async function handler(req, res) {
  if (req.headers['x-vercel-cron'] !== '1') return res.status(401).end();
  const started = Date.now();

  // Advisory lock — Postgres-native, auto-released at connection close
  const [{ locked }] = await db.query(sql`select pg_try_advisory_lock(${42_001}) as locked`);
  if (!locked) return res.status(200).json({ ok: true, skipped: 'another_runner' });

  let processed = 0, failed = 0;
  try {
    while (Date.now() - started < MAX_WALL_MS) {
      // Atomically claim a batch
      const claimed = await db.query(sql`
        update jobs
           set status = 'running',
               locked_until = now() + interval '5 minutes',
               locked_by = ${process.env.VERCEL_DEPLOYMENT_ID || 'local'},
               attempts = attempts + 1
         where id in (
           select id from jobs
            where status = 'queued' and run_after <= now()
            order by run_after
            for update skip locked
            limit ${BATCH}
         )
         returning *
      `);
      if (claimed.length === 0) break;

      for (const job of claimed) {
        try {
          await runJob(job);
          await db.query(sql`update jobs set status='done', finished_at=now() where id=${job.id}`);
          processed++;
        } catch (err) {
          failed++;
          const dead = job.attempts >= job.max_attempts;
          await db.query(sql`
            update jobs set
              status = ${dead ? 'dead' : 'queued'},
              run_after = now() + (interval '1 minute' * power(2, attempts)),
              last_error = ${err.message}
            where id = ${job.id}
          `);
          log('warn', 'job_failed', { id: job.id, kind: job.kind, attempt: job.attempts, dead, err: err.message });
        }
      }
    }
  } finally {
    await db.query(sql`select pg_advisory_unlock(${42_001})`);
  }

  log('info', 'cron_process_jobs', { processed, failed, ms: Date.now() - started });
  return res.status(200).json({ ok: true, processed, failed, ms: Date.now() - started });
}
```

## Job kinds (the dispatch in `lib/jobs.js`)

```js
// /api/lib/jobs.js
import * as sheetWrite from './job-handlers/retry-sheet-write.js';
import * as refreshToken from './job-handlers/refresh-token.js';
import * as weeklySummary from './job-handlers/weekly-summary.js';
import * as paymentFailed from './job-handlers/payment-failed-email.js';
import * as taxInvoice from './job-handlers/issue-tax-invoice.js';
import * as inactivityNudge from './job-handlers/inactivity-nudge.js';

const HANDLERS = {
  retry_sheet_write:         sheetWrite.run,
  refresh_token:             refreshToken.run,
  weekly_summary:            weeklySummary.run,
  send_payment_failed_email: paymentFailed.run,
  issue_tax_invoice:         taxInvoice.run,
  inactivity_nudge:          inactivityNudge.run,
};

export async function runJob(job) {
  const fn = HANDLERS[job.kind];
  if (!fn) throw new Error(`unknown_job_kind:${job.kind}`);
  return await fn(job);
}
```

## Token-refresh sweep — `/api/cron/refresh-tokens`

Runs every 15 minutes. Refreshes any access token expiring in the next 30 minutes so the WhatsApp webhook **never** has to wait for a refresh round-trip.

```js
export default async function handler(req, res) {
  if (req.headers['x-vercel-cron'] !== '1') return res.status(401).end();

  // Find tokens needing refresh (and not currently being retried too much)
  const due = await db.query(sql`
    select user_id from oauth_tokens
    where access_token_exp < now() + interval '30 minutes'
      and failed_refreshes < 5
    limit 100
  `);

  let ok = 0, fail = 0;
  for (const { user_id } of due) {
    try { await refreshAccessTokenForUser(user_id); ok++; }
    catch (e) {
      fail++;
      await db.query(sql`
        update oauth_tokens
        set failed_refreshes = failed_refreshes + 1, last_error = ${e.message}
        where user_id = ${user_id}
      `);
    }
  }
  return res.status(200).json({ ok: true, refreshed: ok, failed: fail });
}
```

`failed_refreshes >= 5` puts a user into a "needs reconnect" state; the dashboard shows a banner.

## Weekly summary — `/api/cron/weekly-summary`

Every Sunday 09:00 IDT. For each Pro/Family user opted-in:
1. Aggregate last week's transactions
2. Render a Hebrew summary message
3. Send via WhatsApp (Meta API) OR queue email

```js
const summary = `
שלום ${user.display_name}! 👋
סיכום שבועי:
• סה"כ הוצאות: ₪${total.toFixed(0)}
• הכי גבוה: ${topCategory.name} (${topCategory.amount}₪)
• השוואה לשבוע שעבר: ${trendArrow} ${pctChange}%
• 3 מובילות:
  1. ${top3[0]}
  2. ${top3[1]}
  3. ${top3[2]}

הדוח המלא: https://kesefle.app/insights
`;
```

## Inactivity nudge — `/api/cron/inactivity-nudge`

Daily. Targets users:
- created > 7 days ago
- last_seen_at > 14 days ago
- not already nudged in last 7 days (track in `audit_logs`)

Sends one WhatsApp template message: "התגעגענו אליך 👋 נסה להוסיף הוצאה: '50 קפה'". One nudge per user lifetime ≤ 3 times to avoid spam.

## Billing alerts — `/api/cron/billing-alerts`

- **Trial ending in 3 days**: email + in-app banner
- **Trial ending tomorrow**: WhatsApp message with discount code
- **Card expiring this month**: email
- **Payment failed retry**: WhatsApp message after Stripe's 1st retry

Powered by joining `subscriptions` with `users`.

## Apps Script triggers (bot side)

Inside the user's Apps Script project (the one already running their sheet), we register two triggers:
1. **Daily 23:00 IDT** — recompute dashboard formulas (existing sheet logic).
2. **Hourly** — drain a `pending_writes` named range if the webhook couldn't write directly (failover path: webhook writes to this range when API call fails, Apps Script flushes to dashboard on its schedule).

The Apps Script side is the user's, so it doesn't burn our Vercel cron quotas — good division of labor.

## Failure handling: idempotency

Every job kind must be idempotent (or designed to detect retries):
- `retry_sheet_write` — checks current sheet row content first; only writes if different. Uses `whatsapp_msg_id` as natural key.
- `refresh_token` — Google's refresh-token grant is idempotent.
- `weekly_summary` — checks `audit_logs` for prior send this week before sending.
- `issue_tax_invoice` — keyed on `stripe_invoice_id` — Green Invoice rejects duplicates.

## Dead-letter handling

After `max_attempts` (default 6), status flips to `'dead'`. Admin sees them at `/api/admin/jobs?status=dead`. One-click retry sets `status='queued'` + `attempts=0`. No silent loss.
