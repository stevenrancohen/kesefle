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
//   STRIPE_SUCCESS_URL       — https://kesefle.vercel.app/dashboard?upgraded=true
//   STRIPE_CANCEL_URL        — https://kesefle.vercel.app/account#plan
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

export default async function handler(req, res) {
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
  const userSub = String(body?.userSub || req.headers['x-user-sub'] || '').trim();
  const userEmail = String(body?.userEmail || '').trim();

  if (!PLAN_PRICES[plan]) {
    return res.status(400).json({ ok: false, error: 'invalid plan', allowed: Object.keys(PLAN_PRICES) });
  }
  if (!userSub) return res.status(401).json({ ok: false, error: 'missing user identity' });

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
  params.set('success_url', process.env.STRIPE_SUCCESS_URL || 'https://kesefle.vercel.app/dashboard?upgraded=true');
  params.set('cancel_url', process.env.STRIPE_CANCEL_URL || 'https://kesefle.vercel.app/account#plan');
  params.set('subscription_data[trial_period_days]', '14');
  params.set('subscription_data[metadata][userSub]', userSub);
  params.set('subscription_data[metadata][plan]', plan);
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
