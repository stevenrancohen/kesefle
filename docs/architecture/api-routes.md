# 2. API Routes — Complete Surface

Convention: all routes return `{ ok: boolean, ...data, error?: string }`. Errors carry an `error_code` (machine-readable) and `error` (human Hebrew/English). Every authenticated route reads the session cookie `kfl_session` (HttpOnly, Secure, SameSite=Lax, 30 days) which holds a signed JWT minted by `/api/auth/callback`.

## Auth requirement levels

- **public** — no auth (waitlist, callback)
- **user** — valid `kfl_session` cookie
- **admin** — `kfl_session` with `role: 'admin'` claim
- **webhook** — HMAC-signed body (Meta or Stripe)
- **cron** — Vercel cron header `x-vercel-cron`

## Full route table

| Method | Path | Auth | Purpose |
|---|---|---|---|
| **AUTH** ||||
| POST | `/api/auth/google` | public | Exchange Google ID token for `kfl_session` cookie. Creates `users` row on first login. |
| GET | `/api/auth/me` | user | Return current user + plan + trial status (used to gate UI). |
| POST | `/api/auth/refresh` | user | Renew session cookie 7 days before expiry. |
| POST | `/api/auth/logout` | user | Clear `kfl_session` cookie. |
| GET | `/api/auth/google/connect` | user | Begin Google OAuth flow for **drive.file + spreadsheets** scopes (separate from sign-in). Returns redirect URL. |
| GET | `/api/auth/google/callback` | public | Receive OAuth code, exchange for refresh token, encrypt, store. |
| **SHEET** ||||
| POST | `/api/sheet/provision` | user | Copy template into user's Drive, store sheet_id. Idempotent. |
| GET | `/api/sheet/status` | user | Return `{ connected, sheetId, url, lastWriteAt, lastWriteOk }`. |
| POST | `/api/sheet/sync` | user | Force re-pull rows from sheet → DB transactions (rebuilds mirror). |
| POST | `/api/sheet/disconnect` | user | Forget sheet_id (does NOT delete the actual Google sheet). |
| **TRANSACTIONS** ||||
| GET | `/api/transactions` | user | Paginated list. Query: `from`, `to`, `category`, `q`, `cursor`, `limit≤200`. |
| POST | `/api/transactions` | user | Manually add a transaction (writes to sheet AND db). |
| PATCH | `/api/transactions/:id` | user | Edit category/amount/description. Writes back to sheet. |
| DELETE | `/api/transactions/:id` | user | Soft-delete + remove row from sheet. |
| GET | `/api/transactions/export` | user | CSV/XLSX download of all transactions, optional date range. |
| **SUMMARY** ||||
| GET | `/api/summary/today` | user | Sum and breakdown for today. |
| GET | `/api/summary/week` | user | Last 7 days + day-by-day chart data. |
| GET | `/api/summary/month` | user | Current month spend, budget vs actual per category. |
| GET | `/api/summary/by-category` | user | Aggregations grouped by category. Query: `period=month|year|all`. |
| GET | `/api/summary/insights` | user | AI-generated insights via Claude Haiku (cached 1 h). |
| **WHATSAPP** ||||
| GET | `/api/whatsapp/webhook` | public | Meta verify handshake (returns `hub.challenge`). |
| POST | `/api/whatsapp/webhook` | webhook | HMAC-verified inbound. Parse, write, reply. |
| POST | `/api/whatsapp/link` | user | Generate a one-time code; user texts it from their phone to claim/verify. |
| POST | `/api/whatsapp/verify` | webhook | Internal — called by webhook handler when it sees a `LINK <code>` message. |
| **BILLING** ||||
| POST | `/api/billing/checkout` | user | Create Stripe Checkout session. Body: `{ plan: 'pro'\|'family', period: 'month'\|'year' }`. |
| GET | `/api/billing/portal` | user | Create Stripe Customer Portal session, redirect. |
| POST | `/api/billing/webhook` | webhook | Stripe events (signature-verified). |
| GET | `/api/billing/status` | user | Returns subscription/trial info. |
| **ADMIN** ||||
| GET | `/api/admin/users` | admin | List/search users. Query: `q`, `plan`, `status`, `cursor`. |
| GET | `/api/admin/users/:id` | admin | User detail + recent audit logs. |
| POST | `/api/admin/users/:id/impersonate` | admin | Issue short-lived (5 min) session for support — logged loudly. |
| POST | `/api/admin/users/:id/suspend` | admin | Mark `status='suspended'` — webhook will refuse to write. |
| GET | `/api/admin/jobs` | admin | Inspect queue. |
| POST | `/api/admin/jobs/:id/retry` | admin | Force-retry a dead job. |
| GET | `/api/admin/metrics` | admin | DAU / MAU / signups / write-success-rate. |
| **HEALTH** ||||
| GET | `/api/health` | public | Liveness — returns `200 ok` always (used by uptime monitor). |
| GET | `/api/health/deep` | cron | Probes DB, KV, Sheets API, Meta API, Stripe API. Returns per-dep status. Called every 5 min. |
| **CRON** ||||
| POST | `/api/cron/refresh-tokens` | cron | Refresh OAuth tokens expiring in next 24 h. |
| POST | `/api/cron/process-jobs` | cron | Drain `jobs` table. Runs every minute. |
| POST | `/api/cron/weekly-summary` | cron | Send weekly summary to opted-in users. Sunday 09:00 IDT. |
| POST | `/api/cron/inactivity-nudge` | cron | Ping users with no activity 14 days. Daily 11:00 IDT. |
| POST | `/api/cron/billing-alerts` | cron | Trial-ending and renewal-soon emails. Daily 08:00 IDT. |
| **WAITLIST (legacy/keep)** ||||
| POST | `/api/waitlist` | public | (Existing.) Rate-limited via KV. |

## Example route — `/api/transactions/:id` PATCH

A complete production route with auth, validation, audit log, error handling, sheet sync.

```js
// /api/transactions/[id].js
import { z } from '../../lib/zod-mini.js';        // we ship a 2 KB zod-like validator (no npm)
import { requireUser } from '../../lib/auth.js';
import { db, sql } from '../../lib/db.js';
import { writeSheetCell, ensureFreshAccessToken } from '../../lib/sheets.js';
import { audit } from '../../lib/audit.js';
import { rateLimit } from '../../lib/rate-limit.js';

const BodySchema = z.object({
  amount_minor: z.int().min(0).max(10_000_000).optional(),
  category:     z.str().max(64).optional(),
  subcategory:  z.str().max(64).optional(),
  merchant:     z.str().max(120).optional(),
  description:  z.str().max(500).optional(),
  occurred_at:  z.isoDate().optional(),
});

export default async function handler(req, res) {
  // -- CORS / method
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'PATCH') {
    return res.status(405).json({ ok: false, error_code: 'method_not_allowed', error: 'method not allowed' });
  }

  // -- Auth
  const user = await requireUser(req, res);
  if (!user) return;        // requireUser already sent 401

  // -- Rate-limit (60 edits / 5 min per user)
  const limit = await rateLimit(`tx:edit:${user.id}`, { max: 60, windowSec: 300 });
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ ok: false, error_code: 'rate_limited', error: 'יותר מדי בקשות, נסה שוב בעוד רגע' });
  }

  // -- Validate path + body
  const id = String(req.query.id || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ ok: false, error_code: 'bad_id', error: 'bad transaction id' });
  }
  const body = await readJson(req);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error_code: 'bad_body', error: parsed.error });
  }
  const patch = parsed.data;
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error_code: 'empty_patch', error: 'no fields to update' });
  }

  // -- Load current row (also enforces ownership)
  const [tx] = await db.query(sql`
    select id, user_id, amount_minor, category, subcategory, merchant, description,
           occurred_at, sheet_row, sheet_tab
    from transactions
    where id = ${id} and user_id = ${user.id} and deleted_at is null
  `);
  if (!tx) {
    return res.status(404).json({ ok: false, error_code: 'not_found', error: 'transaction not found' });
  }

  // -- Update DB
  let updated;
  try {
    [updated] = await db.query(sql`
      update transactions set
        amount_minor = coalesce(${patch.amount_minor},  amount_minor),
        category     = coalesce(${patch.category},      category),
        subcategory  = coalesce(${patch.subcategory},   subcategory),
        merchant     = coalesce(${patch.merchant},      merchant),
        description  = coalesce(${patch.description},   description),
        occurred_at  = coalesce(${patch.occurred_at},   occurred_at),
        updated_at   = now()
      where id = ${id}
      returning *
    `);
  } catch (err) {
    console.error('tx_update_db_failed', { id, err: err.message });
    return res.status(500).json({ ok: false, error_code: 'db_error', error: 'database write failed' });
  }

  // -- Write back to user's sheet (best-effort; queue a job if it fails)
  let sheetOk = true;
  try {
    const accessToken = await ensureFreshAccessToken(user.id);
    await writeSheetCell({
      accessToken, sheetId: user.sheet_id, tab: updated.sheet_tab, row: updated.sheet_row,
      values: [updated.occurred_at, updated.amount_minor / 100, updated.category, updated.description],
    });
  } catch (err) {
    sheetOk = false;
    await db.query(sql`
      insert into jobs (kind, user_id, payload, run_after)
      values ('retry_sheet_write', ${user.id}, ${{ txId: id }}, now() + interval '30 seconds')
    `);
    console.warn('sheet_write_failed_queued', { id, err: err.message });
  }

  await audit({
    user_id: user.id, actor: 'user', action: 'tx.edit',
    target_type: 'transaction', target_id: id,
    ip: req.headers['x-forwarded-for'], ua: req.headers['user-agent'],
    metadata: { patch, sheetOk }, ok: true,
  });

  return res.status(200).json({ ok: true, transaction: updated, sheet_synced: sheetOk });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { return {}; }
}
```

## Shared helpers (all in `/api/lib/`, zero npm)

- `lib/auth.js` — `requireUser`, `requireAdmin`, session JWT sign/verify (HS256 with `KESEFLE_JWT_SECRET`)
- `lib/db.js` — tiny pg client over `fetch` to Supabase's REST endpoint (no `pg` driver), with tagged-template `sql` for safe params
- `lib/sheets.js` — `ensureFreshAccessToken`, `writeSheetCell`, `appendRow`, `readRange`
- `lib/audit.js` — write to `audit_logs`, also `console.log` JSON for Vercel log aggregation
- `lib/rate-limit.js` — token bucket via KV `INCR` + `EXPIRE`
- `lib/zod-mini.js` — 60-line shim: `z.object`, `z.str`, `z.int`, `z.isoDate`, `safeParse`. Tiny since no npm.
- `lib/crypto.js` — see `security-hardening.md`
