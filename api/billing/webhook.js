// ⚠️ DEPRECATED / UNUSED — Kesefle migrated off Stripe (2026-05) to PayPal,
// crypto (Coinbase Commerce), and manual Bit/bank transfer. No Stripe webhook is
// configured anymore; this is kept as dead code for reference only.
// Active billing: lib/billing.js + api/billing/{paypal,crypto-create,crypto-webhook,manual}.js.
//
// /api/billing/webhook
// Handles Stripe webhook events: subscription created/updated/canceled, payment succeeded/failed.
// Updates user.plan in KV.
//
// Env required:
//   STRIPE_WEBHOOK_SECRET — whsec_... from Stripe dashboard
//   STRIPE_SECRET_KEY     — for API calls (not used in this handler, but needed downstream)
//
// Stripe sends signed POST. Verify HMAC before trusting.

import crypto from 'node:crypto';

// CRITICAL: capture raw body bytes for HMAC verification (Stripe pattern same as Meta).
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader) return { ok: false, reason: 'no_signature_header' };
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const t = parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'malformed_signature' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: 'timestamp_outside_tolerance' };

  const signedPayload = `${t}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    if (crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'))) {
      return { ok: true };
    }
  } catch (e) { return { ok: false, reason: 'compare_failed' }; }
  return { ok: false, reason: 'signature_mismatch' };
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function updateUserPlan(userSub, planFields) {
  if (!userSub) return false;
  const userRec = await kvGet('user:' + userSub) || { userSub };
  Object.assign(userRec, planFields);
  return await kvSet('user:' + userSub, userRec);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'webhook_secret_not_configured' });
  }

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'body_read_failed' }); }

  const sig = req.headers['stripe-signature'];
  const verify = verifyStripeSignature(rawBody, sig, secret);
  if (!verify.ok) {
    return res.status(401).json({ ok: false, error: 'signature_invalid', reason: verify.reason });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return res.status(400).json({ ok: false, error: 'invalid_json' }); }

  // Idempotency — track events we've seen (Stripe may retry)
  const seenKey = `stripe_event:${event.id}`;
  if (await kvGet(seenKey)) {
    return res.status(200).json({ ok: true, duplicate: event.id });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userSub = session.subscription_data?.metadata?.userSub || session.metadata?.userSub;
      const plan = session.subscription_data?.metadata?.plan || session.metadata?.plan;
      if (userSub) {
        await updateUserPlan(userSub, {
          plan,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          subscriptionStatus: 'trialing',
          subscribedAt: new Date().toISOString(),
        });
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const userSub = sub.metadata?.userSub;
      if (userSub) {
        await updateUserPlan(userSub, {
          plan: sub.metadata?.plan,
          subscriptionStatus: sub.status,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
          stripeSubscriptionId: sub.id,
        });
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const userSub = sub.metadata?.userSub;
      if (userSub) {
        await updateUserPlan(userSub, {
          plan: 'free',
          subscriptionStatus: 'canceled',
          canceledAt: new Date().toISOString(),
        });
      }
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      // TODO: send a WhatsApp message to user asking to update payment method.
      console.log('PAYMENT_FAILED', invoice.id, invoice.customer);
      break;
    }
    default:
      // Unhandled event types — log but return 200 so Stripe doesn't retry
      console.log('stripe_event_unhandled', event.type, event.id);
  }

  // Mark seen
  await kvSet(seenKey, { type: event.type, ts: new Date().toISOString() });

  return res.status(200).json({ ok: true, processed: event.type });
}
