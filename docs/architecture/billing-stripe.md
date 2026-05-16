# 3. Billing — Stripe

## Why Stripe over Paddle (revising `NEXT_STACK_PLAN.md`)

Paddle was tempting for חשבונית מס auto-generation, but its API is awkward (no clean Customer Portal), trial flow needs manual tweaks, and conversion rate vs Stripe is consistently ~10% lower in B2C tests. **Stripe** it is, with a **Green Invoice** (חשבונית ירוקה) webhook listener that auto-issues a tax invoice on every `invoice.paid` — costs ~₪0.10/invoice and keeps us legal in Israel.

## Products & prices

```text
Free        ₪0       — up to 30 txs / month, basic sheet, no AI insights
Pro         ₪19/mo   ₪190/yr (save 17%) — unlimited tx, AI categorization, weekly insights, CSV export, voice input
Family      ₪39/mo   ₪390/yr — Pro features + up to 4 shared members on one sheet
```

Create in Stripe dashboard (or via CLI), capture price IDs in env:

```text
STRIPE_PRICE_PRO_MONTH      = price_xxx
STRIPE_PRICE_PRO_YEAR       = price_xxx
STRIPE_PRICE_FAMILY_MONTH   = price_xxx
STRIPE_PRICE_FAMILY_YEAR    = price_xxx
```

## Free trial policy

- **14-day Stripe-native trial** on Pro and Family (`subscription_data.trial_period_days = 14`).
- No credit card required to start trial — `payment_method_collection: 'if_required'`. They'll only add a card when trial ends.
- 3-day pre-trial-end email + in-app banner. After trial: if no card, downgrade to Free automatically (don't churn-bill).

## Checkout flow

```text
User clicks "Upgrade to Pro" on /account
  → POST /api/billing/checkout  body: { plan: 'pro', period: 'month' }
  → Server: ensure stripe_customer_id (create if missing)
  → Server: create Checkout Session with:
        mode: 'subscription'
        line_items: [{ price: <price_id>, quantity: 1 }]
        success_url: https://kesefle.app/account?upgraded=1&session_id={CHECKOUT_SESSION_ID}
        cancel_url:  https://kesefle.app/account?canceled=1
        subscription_data: { trial_period_days: 14 }
        payment_method_collection: 'if_required'
        client_reference_id: <user.id>     ← critical, ties session to our user
        customer: <stripe_customer_id>
        locale: 'he'
        automatic_tax: { enabled: true }   ← VAT auto-handled
  → Server returns { url }, browser redirects
  → Stripe handles card entry, returns to success_url
  → checkout.session.completed webhook arrives → we activate plan in DB
```

## Customer portal

```text
User clicks "Manage subscription" on /account
  → POST /api/billing/portal
  → Server creates billing_portal.Session { customer: <id>, return_url: https://kesefle.app/account }
  → Server returns { url }, browser redirects
  → User cancels / updates card / downloads invoices in Stripe-hosted UI
  → Stripe fires customer.subscription.updated webhook
```

## Webhook handler skeleton

`/api/billing/webhook.js` — **must be raw body** for signature verification.

```js
// Vercel: this route MUST have config.api.bodyParser = false (see vercel.json)
// We read the raw stream and verify, THEN parse.

import crypto from 'node:crypto';
import { db, sql } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';

export const config = { api: { bodyParser: false } };

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_API_KEY = process.env.STRIPE_API_KEY;

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyStripeSignature(rawBody, header, secret) {
  // header form: t=<ts>,v1=<sig>[,v0=<sig>]
  const parts = Object.fromEntries(header.split(',').map(s => s.split('=')));
  const expectedSig = parts.v1;
  const ts = parts.t;
  if (!expectedSig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;  // 5-min skew
  const signed = `${ts}.${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(expectedSig, 'hex'));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readRaw(req);
  const sig = req.headers['stripe-signature'];
  if (!sig || !verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ ok: false, error: 'bad signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ ok: false, error: 'bad json' }); }

  // Idempotency: skip if we've already processed this event id
  const seen = await db.query(sql`
    insert into stripe_events_seen (id) values (${event.id})
    on conflict (id) do nothing
    returning id
  `);
  if (seen.length === 0) return res.status(200).json({ ok: true, dedup: true });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.client_reference_id;
        await db.query(sql`
          update users set stripe_customer_id = ${s.customer}
          where id = ${userId} and stripe_customer_id is null
        `);
        // The subscription will arrive via customer.subscription.created next.
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userRow = await db.query(sql`
          select id from users where stripe_customer_id = ${sub.customer}
        `);
        if (!userRow.length) {
          console.warn('subscription_for_unknown_customer', sub.customer);
          break;
        }
        const userId = userRow[0].id;
        const planName = planFromPriceId(sub.items.data[0].price.id);
        await db.query(sql`
          insert into subscriptions (
            user_id, stripe_subscription_id, stripe_price_id, plan, status,
            current_period_start, current_period_end,
            cancel_at, canceled_at, trial_end
          ) values (
            ${userId}, ${sub.id}, ${sub.items.data[0].price.id}, ${planName}, ${sub.status},
            to_timestamp(${sub.current_period_start}), to_timestamp(${sub.current_period_end}),
            ${sub.cancel_at ? sql`to_timestamp(${sub.cancel_at})` : null},
            ${sub.canceled_at ? sql`to_timestamp(${sub.canceled_at})` : null},
            ${sub.trial_end ? sql`to_timestamp(${sub.trial_end})` : null}
          )
          on conflict (stripe_subscription_id) do update set
            status = excluded.status,
            current_period_start = excluded.current_period_start,
            current_period_end = excluded.current_period_end,
            cancel_at = excluded.cancel_at,
            canceled_at = excluded.canceled_at,
            updated_at = now()
        `);
        // Mirror onto users.plan for fast gating
        const effective = (sub.status === 'active' || sub.status === 'trialing') ? planName : 'free';
        await db.query(sql`update users set plan = ${effective}, updated_at = now() where id = ${userId}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(sql`
          update subscriptions set status = 'canceled', canceled_at = now()
          where stripe_subscription_id = ${sub.id}
        `);
        await db.query(sql`
          update users set plan = 'free'
          where stripe_customer_id = ${sub.customer}
        `);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        // Queue an email job — 1st failure: gentle reminder; 2nd: warning; 3rd: downgrade.
        await db.query(sql`
          insert into jobs (kind, user_id, payload)
          select 'send_payment_failed_email', u.id,
                 ${{ attempt: inv.attempt_count, hosted_invoice_url: inv.hosted_invoice_url }}
          from users u where u.stripe_customer_id = ${inv.customer}
        `);
        break;
      }

      case 'invoice.paid': {
        const inv = event.data.object;
        // Issue חשבונית מס via Green Invoice API
        await db.query(sql`
          insert into jobs (kind, payload)
          values ('issue_tax_invoice', ${{ stripe_invoice_id: inv.id, amount: inv.amount_paid, customer: inv.customer }})
        `);
        break;
      }

      default:
        // Acknowledge but don't act
        break;
    }

    await audit({
      actor: 'webhook:stripe', action: `stripe.${event.type}`,
      target_type: 'stripe_event', target_id: event.id, ok: true,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('stripe_webhook_error', { type: event.type, id: event.id, err: err.message });
    await audit({
      actor: 'webhook:stripe', action: `stripe.${event.type}`,
      target_type: 'stripe_event', target_id: event.id, ok: false, error: err.message,
    });
    // 500 → Stripe will retry with exp. backoff for up to 3 days.
    return res.status(500).json({ ok: false, error: 'handler failed' });
  }
}

function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_PRO_MONTH || priceId === process.env.STRIPE_PRICE_PRO_YEAR) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_FAMILY_MONTH || priceId === process.env.STRIPE_PRICE_FAMILY_YEAR) return 'family';
  return 'free';
}
```

## Stripe events helper table

```sql
create table public.stripe_events_seen (
  id text primary key,
  seen_at timestamptz not null default now()
);
-- Periodically prune > 30 days (cron)
```

## Plan-gating helper

```js
// lib/plan.js
export const LIMITS = {
  free:   { txPerMonth: 30,    aiInsights: false, voiceInput: false, familyMembers: 1 },
  pro:    { txPerMonth: Infinity, aiInsights: true,  voiceInput: true,  familyMembers: 1 },
  family: { txPerMonth: Infinity, aiInsights: true,  voiceInput: true,  familyMembers: 4 },
};

export function canAddTransaction(user, currentMonthCount) {
  const limit = LIMITS[user.plan].txPerMonth;
  return currentMonthCount < limit;
}
```

The webhook handler is the **source of truth** — we never trust the client to tell us the plan. UI shows the plan from `users.plan`, which only the webhook writes.
