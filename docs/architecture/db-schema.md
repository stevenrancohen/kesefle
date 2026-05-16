# 1. Database — Supabase Postgres (recommended)

## Decision: Supabase Postgres (free tier 500 MB → $25/mo Pro)

### Why Supabase over the alternatives

| Option | Verdict | Reason |
|---|---|---|
| **Supabase Postgres** | ✅ Pick this | Real Postgres with Row-Level Security (RLS) per user, realtime channels for the dashboard, pgcrypto for encryption-at-rest, generous free tier (500 MB / 50k MAU), self-hostable escape hatch. Hebrew text indexed correctly out of the box (`pg_trgm` + ICU collation). |
| Vercel Postgres (Neon) | ❌ | $19/mo minimum, no RLS UI, no realtime, no auth-side helpers. We'd rebuild what Supabase gives free. |
| Vercel KV (Upstash Redis) | ❌ as primary | Already used for waitlist + idempotency cache. Keep it for **ephemeral** state only (rate-limit counters, message-deduplication TTL, session cache). Not durable enough for billing/audit. |
| PlanetScale / TiDB | ❌ | No JSON-path queries; we need flexible `payload` columns for events. Schema migrations are non-trivial. |
| Firebase / Firestore | ❌ | NoSQL hurts when reporting on aggregates ("how much did I spend on coffee in May?"). Egress costs balloon. |

**Two-tier setup**: Supabase Postgres = durable system-of-record. Vercel KV = hot cache + rate-limit + dedup. The webhook hits KV first (fast), then writes through to Postgres async.

## Tables

```sql
-- =========================================================
-- users  (one row per signed-in human)
-- =========================================================
create table public.users (
  id              uuid primary key default gen_random_uuid(),
  google_sub      text unique not null,                 -- from Google ID token
  email           citext unique not null,
  email_verified  boolean not null default false,
  display_name    text,
  avatar_url      text,
  locale          text default 'he',
  phone_e164      text unique,                          -- +9725xxxxxxxx — WhatsApp lookup key
  phone_verified  boolean not null default false,
  sheet_id        text,                                 -- Google Sheets file id
  sheet_url       text generated always as
                    (case when sheet_id is null then null
                          else 'https://docs.google.com/spreadsheets/d/' || sheet_id end) stored,
  plan            text not null default 'free'
                    check (plan in ('free','pro','family','admin')),
  trial_ends_at   timestamptz default (now() + interval '14 days'),
  stripe_customer_id text unique,
  status          text not null default 'active'
                    check (status in ('active','suspended','deleted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_seen_at    timestamptz
);
create index users_phone_idx on users(phone_e164) where phone_e164 is not null;
create index users_plan_idx  on users(plan);

-- =========================================================
-- oauth_tokens  (Google refresh tokens — ENCRYPTED at rest)
-- =========================================================
-- Uses pgcrypto symmetric encryption with a key from env (KESEFLE_DB_KEY).
-- The key NEVER leaves the server; we decrypt only at the moment of use.
create extension if not exists pgcrypto;

create table public.oauth_tokens (
  user_id          uuid primary key references users(id) on delete cascade,
  provider         text not null default 'google',
  -- pgp_sym_encrypt(refresh_token, current_setting('app.db_key')) — see helper
  refresh_token_enc bytea not null,
  access_token_enc bytea,                                -- short-lived, cached
  access_token_exp timestamptz,                          -- when access token expires
  scopes           text[] not null default '{}',
  rotated_at       timestamptz not null default now(),
  failed_refreshes int not null default 0,
  last_error       text
);

-- =========================================================
-- transactions  (mirror of every expense/income row written to the sheet)
-- =========================================================
-- This lets us answer "this month I spent X on coffee" without
-- round-tripping to Google Sheets. Sheet is still source-of-truth for display,
-- but DB is source-of-truth for billing/usage/analytics.
create table public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  occurred_at     timestamptz not null,
  amount_minor    bigint not null,                       -- agorot — never float for money
  currency        text not null default 'ILS',
  kind            text not null check (kind in ('expense','income','transfer','order')),
  category        text,                                  -- top-level e.g. "food"
  subcategory     text,                                  -- e.g. "coffee"
  merchant        text,                                  -- e.g. "אובר"
  description     text,
  raw_message     text,                                  -- original WhatsApp text
  channel         text not null default 'whatsapp'
                    check (channel in ('whatsapp','web','voice','import')),
  sheet_row       integer,                               -- which row in the user's sheet
  sheet_tab       text,                                  -- which tab e.g. "ינואר"
  whatsapp_msg_id text unique,                           -- for idempotency
  classifier      text,                                  -- 'regex' | 'claude-haiku' | 'manual'
  confidence      real,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz                            -- soft delete
);
create index tx_user_time_idx     on transactions(user_id, occurred_at desc);
create index tx_user_cat_idx      on transactions(user_id, category, occurred_at desc);
create index tx_user_merchant_idx on transactions(user_id, merchant) where merchant is not null;
-- Trigram index for Hebrew search ("חפש קפה")
create extension if not exists pg_trgm;
create index tx_description_trgm  on transactions using gin (description gin_trgm_ops);

-- =========================================================
-- subscriptions  (billing state, mirror of Stripe)
-- =========================================================
create table public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  stripe_subscription_id text unique not null,
  stripe_price_id      text not null,
  plan                 text not null check (plan in ('pro','family')),
  status               text not null,                     -- active|trialing|past_due|canceled|...
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  canceled_at          timestamptz,
  trial_end            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index sub_user_idx on subscriptions(user_id);

-- =========================================================
-- audit_logs  (append-only — every privileged action)
-- =========================================================
create table public.audit_logs (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  user_id     uuid references users(id) on delete set null,
  actor       text not null,        -- 'user' | 'system' | 'admin:<email>' | 'webhook:meta'
  action      text not null,        -- 'sheet.provision' | 'tx.edit' | 'oauth.refresh' | ...
  target_type text,                  -- 'user' | 'transaction' | 'subscription' | ...
  target_id   text,
  ip          inet,
  user_agent  text,
  metadata    jsonb,                 -- arbitrary structured details
  ok          boolean not null,
  error       text
);
create index audit_user_time_idx on audit_logs(user_id, ts desc);
create index audit_action_idx     on audit_logs(action, ts desc);

-- =========================================================
-- jobs  (background work queue — small/simple, no extra infra)
-- =========================================================
create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,       -- 'retry_sheet_write' | 'refresh_token' | 'weekly_summary' | ...
  user_id       uuid references users(id) on delete cascade,
  payload       jsonb,
  run_after     timestamptz not null default now(),
  attempts      int not null default 0,
  max_attempts  int not null default 6,
  locked_until  timestamptz,
  locked_by     text,
  status        text not null default 'queued'
                  check (status in ('queued','running','done','failed','dead')),
  last_error    text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index jobs_ready_idx on jobs(run_after) where status = 'queued';

-- =========================================================
-- waitlist  (kept — port from KV later)
-- =========================================================
create table public.waitlist (
  email      citext primary key,
  source     text,
  signed_up  timestamptz not null default now(),
  converted_user_id uuid references users(id) on delete set null,
  metadata   jsonb
);
```

## Row-Level Security (RLS)

Every table tied to a `user_id` enables RLS so the dashboard (using user JWT) can ONLY see its own data. The serverless backend uses the **service role key** which bypasses RLS for admin/system writes (webhook, jobs, billing).

```sql
alter table users          enable row level security;
alter table transactions   enable row level security;
alter table subscriptions  enable row level security;
alter table oauth_tokens   enable row level security;  -- NO user policy = inaccessible from client
alter table audit_logs     enable row level security;

-- A user can read their own row
create policy user_self_read on users
  for select using (auth.jwt() ->> 'sub' = google_sub);

-- A user can read/edit their own transactions
create policy tx_self_read on transactions
  for select using (user_id = (select id from users where google_sub = auth.jwt()->>'sub'));
create policy tx_self_write on transactions
  for update using (user_id = (select id from users where google_sub = auth.jwt()->>'sub'));
-- INSERT/DELETE go through the backend (service role).

-- A user can read their own subscription state
create policy sub_self_read on subscriptions
  for select using (user_id = (select id from users where google_sub = auth.jwt()->>'sub'));

-- oauth_tokens has NO public policy. Only service role can touch it.
```

## Encryption at rest — OAuth refresh tokens

Tokens are stored in `bytea`, encrypted with `pgcrypto`'s `pgp_sym_encrypt` using a key passed in as a database session setting from the backend. The key (32 bytes, base64) lives only in `KESEFLE_DB_KEY` env var, never in the database.

```sql
-- Server sets the key per-session, then writes
select set_config('app.db_key', $1, true);     -- $1 = process.env.KESEFLE_DB_KEY
insert into oauth_tokens (user_id, refresh_token_enc, scopes)
values ($2, pgp_sym_encrypt($3, current_setting('app.db_key')), $4)
on conflict (user_id) do update
   set refresh_token_enc = excluded.refresh_token_enc,
       scopes = excluded.scopes,
       rotated_at = now();

-- Reading
select pgp_sym_decrypt(refresh_token_enc, current_setting('app.db_key'))::text as refresh_token
from oauth_tokens where user_id = $1;
```

Even a database breach + dump cannot reveal refresh tokens without `KESEFLE_DB_KEY`. Key rotation: generate `KESEFLE_DB_KEY_NEW`, run a one-shot job that `UPDATE oauth_tokens SET refresh_token_enc = pgp_sym_encrypt(pgp_sym_decrypt(refresh_token_enc, OLD), NEW)`, then swap env var.

## Backup strategy

| Layer | Mechanism | RPO | RTO |
|---|---|---|---|
| Supabase managed | Daily automated backups, 7-day retention (free tier). Pro tier = PITR (point-in-time recovery, 7 days). | 24 h / 2 min (PITR) | 1 h |
| Off-Supabase copy | Nightly `pg_dump` to a private S3 bucket (Backblaze B2 = cheap). GitHub Action with the connection string in a secret. Encrypted with `age`. | 24 h | 4 h |
| User data (the sheet) | Each user already owns their sheet in their own Drive — they're their own DR. | n/a | user-restore |
| OAuth keys / env | Vercel env exports → 1Password vault, monthly. | 30 d | minutes |

The user-owned sheet is the killer feature for resilience: if our DB blows up, every user still has a complete record of their finances in their own Google Drive. We just need to re-mirror back into `transactions` after restore.
