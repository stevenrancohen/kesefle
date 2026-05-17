# 5. Observability — Logging, Tracing, Alerting

## Stack decision

| Layer | Pick | Rationale |
|---|---|---|
| Error tracking | **Sentry** (free tier 5k errors / 10k perf events per month, plenty for MVP) | Source maps, releases, breadcrumbs, Hebrew-friendly UI, fingerprinting groups duplicate errors. Self-hostable later. |
| Server logs | **Vercel Log Drains → Better Stack (Logtail)** — free tier 1 GB/mo | Searchable, alerting on log patterns, 30-day retention. Backup option = pump to S3 every hour. |
| Uptime | **BetterStack Uptime** or **UptimeRobot** | 1-min checks on `/api/health`, public status page. |
| Metrics | **Vercel Analytics** for traffic + custom **PostHog** events for product analytics | Founder gets one place to see DAU/MAU + funnel from waitlist → signup → first WA message. |
| Alerts | **Slack + email + WhatsApp** via `lib/alerts.js` (single function, multiple sinks) | The founder is on +17745448053 — critical pages go there. |

Avoid Datadog/New Relic — overkill at <10k users.

## 5.1 Sentry wiring

No npm available → use Sentry's HTTP endpoint directly (`/api/<key>/envelope/`).

```js
// /api/lib/sentry.js
const DSN = process.env.SENTRY_DSN;     // form: https://<key>@oXXX.ingest.sentry.io/<project>
let cfg = null;
function parse() {
  if (cfg || !DSN) return cfg;
  const m = DSN.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  cfg = { key: m[1], host: m[2], project: m[3] };
  return cfg;
}

export async function captureException(err, ctx = {}) {
  const c = parse();
  if (!c) { console.error('NO_SENTRY', err, ctx); return; }
  const envelope = [
    JSON.stringify({ event_id: crypto.randomUUID().replace(/-/g, ''), dsn: DSN, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({
      message: err.message || String(err),
      level: ctx.level || 'error',
      platform: 'node',
      environment: process.env.VERCEL_ENV || 'development',
      release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
      tags: ctx.tags || {},
      user: ctx.user ? { id: ctx.user.id, email: ctx.user.email } : undefined,
      extra: ctx.extra || {},
      exception: { values: [{ type: err.name || 'Error', value: err.message, stacktrace: { frames: parseStack(err.stack) } }] },
    }),
  ].join('\n');
  try {
    await fetch(`https://${c.host}/api/${c.project}/envelope/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_key=${c.key},sentry_version=7` },
      body: envelope,
    });
  } catch (e) { console.error('SENTRY_SEND_FAILED', e); }
}

function parseStack(stack = '') {
  return stack.split('\n').slice(1).map(line => {
    const m = line.match(/at (.+?) \((.+?):(\d+):(\d+)\)/) || line.match(/at (.+?):(\d+):(\d+)/);
    if (!m) return { function: line.trim() };
    return m.length === 5
      ? { function: m[1], filename: m[2], lineno: +m[3], colno: +m[4] }
      : { filename: m[1], lineno: +m[2], colno: +m[3] };
  });
}
```

Use in every route:

```js
try {
  // ... handler logic
} catch (err) {
  await captureException(err, { tags: { route: '/api/transactions' }, user });
  return res.status(500).json({ ok: false, error_code: 'internal' });
}
```

## 5.2 Structured logging

All `console.log` becomes JSON via `lib/log.js` (defined in `security-hardening.md`). Vercel ships these to the Log Drain → Better Stack. Standard fields:

```json
{
  "ts": "2026-05-16T13:42:01.221Z",
  "level": "info",
  "msg": "tx_added",
  "route": "/api/transactions",
  "user_id": "uuid",
  "request_id": "req_xxx",
  "ms": 142,
  "fields": { ... }
}
```

`request_id` is set from `req.headers['x-vercel-id']` (Vercel provides one per invocation). Carry it across DB calls and external API calls so a single trace lights up across services.

## 5.3 Health check — `/api/health/deep`

```js
// /api/health/deep.js
import { db, sql } from '../../lib/db.js';

export default async function handler(req, res) {
  // Only allow cron caller (Vercel sends x-vercel-cron) or admin
  if (req.headers['x-vercel-cron'] !== '1' && !isAdmin(req)) {
    return res.status(401).end();
  }

  const checks = {};
  const t0 = Date.now();

  // DB
  checks.db = await timed(async () => {
    const r = await db.query(sql`select 1 as ok`);
    return r[0].ok === 1;
  });

  // KV
  checks.kv = await timed(async () => {
    const r = await fetch(`${process.env.KV_REST_API_URL}/ping`, {
      headers: { 'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
    return r.ok;
  });

  // Sheets API (just OPTIONS — we can't write without a user token)
  checks.sheets = await timed(async () => {
    const r = await fetch('https://sheets.googleapis.com/discovery/rest/v4', { method: 'GET' });
    return r.ok;
  });

  // Meta Graph API
  checks.meta = await timed(async () => {
    const r = await fetch(`https://graph.facebook.com/v19.0/${process.env.META_PHONE_NUMBER_ID}?fields=id`, {
      headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}` },
    });
    return r.ok;
  });

  // Stripe API
  checks.stripe = await timed(async () => {
    const r = await fetch('https://api.stripe.com/v1/balance', {
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_API_KEY}` },
    });
    return r.ok;
  });

  // Classifier (try the regex parser on a known sample)
  checks.classifier = await timed(async () => {
    const { parseMessage } = await import('../../lib/parser.js');
    return parseMessage('60 קפה').ok === true;
  });

  const allOk = Object.values(checks).every(c => c.ok);
  const total = Date.now() - t0;

  // If any check fails, fire alert via /api/lib/alerts.js
  if (!allOk) {
    const failed = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
    await fetch(`${process.env.URL || 'https://kesefle.app'}/api/internal/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.KESEFLE_INTERNAL_KEY },
      body: JSON.stringify({ severity: 'critical', title: 'health_deep_failed', failed, checks }),
    });
  }

  return res.status(allOk ? 200 : 503).json({ ok: allOk, total_ms: total, checks });
}

async function timed(fn) {
  const t = Date.now();
  try { return { ok: await fn(), ms: Date.now() - t }; }
  catch (e) { return { ok: false, ms: Date.now() - t, err: e.message }; }
}
```

Vercel cron entry (in `vercel.json`):

```json
{ "crons": [{ "path": "/api/health/deep", "schedule": "*/5 * * * *" }] }
```

## 5.4 Alerting thresholds

| Signal | Threshold | Severity | Where |
|---|---|---|---|
| `/api/health/deep` 503 | 2 consecutive failures | critical | Slack + WhatsApp |
| Sentry new-issue burst | > 5 occurrences in 5 min | critical | Slack + WhatsApp |
| Webhook 5xx rate | > 1% over 10 min | warning | Slack |
| Sheet-write retry queue depth | > 50 | warning | Slack |
| Stripe webhook failed | any (will retry, but tell us) | warning | Slack |
| Trial-conversion drop | 7-day rolling rate <8% | info | weekly email |
| Active user count flatline | 0 new in 24 h | info | daily digest |
| Quota: drive copy 429 | any | warning | Slack |
| Quota: Sheets API 429 | > 10 in 10 min | warning | Slack |

`lib/alerts.js` skeleton:

```js
// /api/lib/alerts.js
export async function alert({ severity, title, details = {}, channels }) {
  channels = channels || (severity === 'critical' ? ['slack', 'whatsapp'] : ['slack']);
  const msg = `[${severity}] ${title}\n${JSON.stringify(details, null, 2)}`;
  await Promise.allSettled([
    channels.includes('slack')   ? slack(msg) : null,
    channels.includes('whatsapp')? whatsapp(msg) : null,
    channels.includes('email')   ? email('alerts@kesefle.app', msg) : null,
  ]);
}

async function slack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
}

async function whatsapp(text) {
  // Send via Meta API to founder's phone
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  const to = process.env.ALERT_PHONE || '17745448053';
  if (!phoneId || !token) return;
  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000) } }),
  });
}
```

## 5.5 SLOs (write them down so we know when to be worried)

- **Availability**: 99.5% monthly (4 h budget). Below = postmortem.
- **WhatsApp → sheet write p95**: < 3 seconds.
- **Dashboard load p95**: < 1.5 seconds.
- **Stripe webhook ack p99**: < 2 seconds.
- **Error budget burn rate alert**: if we burn 25% of monthly budget in 1 day, page.
