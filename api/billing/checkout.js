// ⚠️ DEPRECATED / UNUSED — Kesefle migrated off Stripe (2026-05) to PayPal,
// crypto (Coinbase Commerce), and manual Bit/bank transfer. Nothing in the app
// calls this endpoint anymore; it is kept as dead code for reference only.
// Active billing: lib/billing.js + api/billing/{paypal,crypto-create,crypto-webhook,manual}.js.
//
// /api/billing/checkout
// Creates a Stripe Checkout Session for the user to subscribe to Pro or Family plan.
//
// Body: { plan: 'pro' | 'family', userSub, userEmail }
// Returns: { ok: true, url: <stripe-checkout-url> }
//
// Env required:
//   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
//   STRIPE_PRICE_PRO         — price_... for Pro plan (₪19/mo)
//   STRIPE_PRICE_FAMILY      — price_... for Family plan (₪39/mo)
//   STRIPE_SUCCESS_URL       — https://kesefle.com/dashboard?upgraded=true
//   STRIPE_CANCEL_URL        — https://kesefle.com/account#plan
//
// Note: Stripe REST API is called via fetch (no npm SDK — pure HTTPS).

const PLAN_PRICES = {
  pro: 'STRIPE_PRICE_PRO',
  family: 'STRIPE_PRICE_FAMILY',
};

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

import { requireAuth } from '../../lib/auth.js';
import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(500).json({ ok: false, error: 'billing_not_configured', detail: 'STRIPE_SECRET_KEY missing' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const plan = String(body?.plan || '').toLowerCase();
  // CRITICAL FIX (C5): bind userSub + email to verified ID-token identity, NOT body.
  // Previously, an attacker could send userSub=<victim> in the body and any later
  // Stripe webhook event would flip the VICTIM'S plan based on metadata.userSub.
  const userSub = req.user.sub;
  const userEmail = req.user.email;

  if (!PLAN_PRICES[plan]) {
    return res.status(400).json({ ok: false, error: 'invalid plan', allowed: Object.keys(PLAN_PRICES) });
  }

  const priceId = process.env[PLAN_PRICES[plan]];
  if (!priceId) {
    return res.status(500).json({ ok: false, error: 'plan_price_not_configured', detail: PLAN_PRICES[plan] + ' env var missing' });
  }

  // Reuse customer if we've created one before (avoids duplicate customers in Stripe)
  const userRec = await kvGet('user:' + userSub);
  let customerId = userRec?.stripeCustomerId;

  if (!customerId && userEmail) {
    // Create customer
    try {
      const params = new URLSearchParams();
      params.set('email', userEmail);
      params.set('metadata[userSub]', userSub);
      const r = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const j = await r.json();
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'stripe_customer_create_failed', detail: j.error?.message });
      customerId = j.id;
      // Persist
      if (userRec) {
        userRec.stripeCustomerId = customerId;
        await kvSet('user:' + userSub, userRec);
      }
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'stripe_unreachable', detail: e.message });
    }
  }

  // Create checkout session
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', process.env.STRIPE_SUCCESS_URL || 'https://kesefle.com/dashboard?upgraded=true');
  params.set('cancel_url', process.env.STRIPE_CANCEL_URL || 'https://kesefle.com/account#plan');
  params.set('subscription_data[trial_period_days]', '14');
  params.set('subscription_data[metadata][userSub]', userSub);
  params.set('subscription_data[metadata][plan]', plan);
  // ALSO stamp metadata on the Checkout Session itself. `subscription_data` is
  // an INPUT-only field — it never appears on the session object Stripe sends
  // back in `checkout.session.completed`, so without these two lines that
  // webhook branch could never resolve userSub and would silently no-op.
  params.set('metadata[userSub]', userSub);
  params.set('metadata[plan]', plan);
  params.set('allow_promotion_codes', 'true');
  params.set('billing_address_collection', 'auto');
  params.set('locale', 'he');
  if (customerId) params.set('customer', customerId);
  else if (userEmail) params.set('customer_email', userEmail);

  let session;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    session = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'stripe_session_create_failed', detail: session.error?.message });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'stripe_unreachable', detail: e.message });
  }

  return res.status(200).json({
    ok: true,
    url: session.url,
    sessionId: session.id,
    plan,
  });
}

// Security: request ID → rate limit (10/hour for checkout) → auth (verified ID token)
export default withRequestId(
  withRateLimit({ key: 'billing_checkout', limit: 10, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
