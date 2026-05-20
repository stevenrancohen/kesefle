// /api/billing/paypal
// PayPal recurring subscriptions for Pro / Family. ONE function serves two
// actions (keeps the serverless function count down):
//   POST /api/billing/paypal?action=subscribe   (auth'd) → { ok, url }  approval link
//   POST /api/billing/paypal?action=webhook      (PayPal)  → lifecycle events
//
// Model: accessUntil is always set to the subscription's next_billing_time + a
// few days of grace. While PayPal keeps charging, next_billing_time marches
// forward so access stays ahead; once it cancels, access lapses after the last
// paid period. That keeps it consistent with the prepaid methods.
//
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ('live'|'sandbox'),
//      PAYPAL_PLAN_PRO, PAYPAL_PLAN_FAMILY, PAYPAL_WEBHOOK_ID

import { requireAuth, requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import {
  activatePremium, deactivatePremium, priceILS,
  billingKvGet, billingKvSet,
} from '../../lib/billing.js';

const GRACE_DAYS = 3;
const SITE = process.env.PUBLIC_SITE_URL || 'https://kesefle.com';

function paypalBase() {
  return String(process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('paypal_not_configured');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('paypal_token_failed');
  return j.access_token;
}

function planIdFor(plan) {
  return plan === 'family' ? process.env.PAYPAL_PLAN_FAMILY : process.env.PAYPAL_PLAN_PRO;
}
function planFromPlanId(planId) {
  if (planId && planId === process.env.PAYPAL_PLAN_FAMILY) return 'family';
  return 'pro';
}

function accessUntilFromNextBilling(nextBillingTime) {
  const base = nextBillingTime ? Date.parse(nextBillingTime) : NaN;
  const ms = (Number.isNaN(base) ? Date.now() + 30 * 86400000 : base) + GRACE_DAYS * 86400000;
  return new Date(ms).toISOString();
}

async function getSubscription(token, subId) {
  try {
    const r = await fetch(`${paypalBase()}/v1/billing/subscriptions/${encodeURIComponent(subId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── action=subscribe ─────────────────────────────────────────────────────────
async function subscribeImpl(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const plan = String(body?.plan || '').toLowerCase() === 'family' ? 'family' : 'pro';

  const planId = planIdFor(plan);
  if (!planId) {
    return res.status(500).json({ ok: false, error: 'paypal_plan_not_configured', detail: plan });
  }

  let token;
  try { token = await getAccessToken(); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  // custom_id binds the subscription to the verified user identity (NOT body).
  const userSub = req.user.sub;
  try {
    const r = await fetch(`${paypalBase()}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: userSub,
        application_context: {
          brand_name: 'Kesefle',
          locale: 'he-IL',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${SITE}/upgrade?paypal=success`,
          cancel_url: `${SITE}/upgrade?paypal=cancel`,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      log.error('paypal_subscribe_failed', { reqId: req.reqId, status: r.status, detail: j?.message });
      return res.status(502).json({ ok: false, error: 'paypal_subscribe_failed' });
    }
    const approve = (j.links || []).find((l) => l.rel === 'approve');
    if (!approve) return res.status(502).json({ ok: false, error: 'no_approval_link' });
    return res.status(200).json({ ok: true, url: approve.href, subscriptionId: j.id });
  } catch (e) {
    log.error('paypal_unreachable', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'paypal_unreachable' });
  }
}

// ── action=webhook ───────────────────────────────────────────────────────────
async function verifyWebhook(req, token) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  try {
    const r = await fetch(`${paypalBase()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: req.body,
      }),
    });
    const j = await r.json().catch(() => ({}));
    return j.verification_status === 'SUCCESS';
  } catch { return false; }
}

async function webhookImpl(req, res) {
  let token;
  try { token = await getAccessToken(); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  const ok = await verifyWebhook(req, token);
  if (!ok) {
    log.warn('paypal_webhook_unverified', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'signature_invalid' });
  }

  const event = req.body || {};
  const type = event.event_type;
  const resource = event.resource || {};

  // Idempotency — PayPal retries failed deliveries.
  const seenKey = `paypal_event:${event.id}`;
  if (event.id && (await billingKvGet(seenKey))) {
    return res.status(200).json({ ok: true, duplicate: event.id });
  }

  try {
    if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const subId = resource.id;
      const userSub = resource.custom_id;
      const plan = planFromPlanId(resource.plan_id);
      const nextBilling = resource.billing_info?.next_billing_time;
      if (userSub && subId) {
        await billingKvSet(`paypalSub:${subId}`, { userSub, plan });
        await activatePremium(userSub, {
          plan, method: 'paypal', recurring: true, externalId: subId,
          accessUntil: accessUntilFromNextBilling(nextBilling),
        });
      }
    } else if (type === 'PAYMENT.SALE.COMPLETED') {
      // Renewal (or first) payment. Map agreement → user, then refresh accessUntil
      // from the live subscription's next_billing_time (absolute set, never stacks).
      const subId = resource.billing_agreement_id;
      if (subId) {
        const map = await billingKvGet(`paypalSub:${subId}`);
        if (map?.userSub) {
          const sub = await getSubscription(token, subId);
          const nextBilling = sub?.billing_info?.next_billing_time;
          await activatePremium(map.userSub, {
            plan: map.plan || 'pro', method: 'paypal', recurring: true, externalId: subId,
            accessUntil: accessUntilFromNextBilling(nextBilling),
          });
        }
      }
    } else if (
      type === 'BILLING.SUBSCRIPTION.CANCELLED' ||
      type === 'BILLING.SUBSCRIPTION.EXPIRED' ||
      type === 'BILLING.SUBSCRIPTION.SUSPENDED'
    ) {
      const subId = resource.id;
      const map = subId ? await billingKvGet(`paypalSub:${subId}`) : null;
      const userSub = map?.userSub || resource.custom_id;
      if (userSub) await deactivatePremium(userSub, 'canceled');
    }
    if (event.id) await billingKvSet(seenKey, { type, ts: new Date().toISOString() });
  } catch (e) {
    log.error('paypal_webhook_handler_failed', { reqId: req.reqId, type, error: e.message });
    return res.status(500).json({ ok: false, error: 'handler_failed' });
  }

  return res.status(200).json({ ok: true, processed: type });
}

// ── action=setup-plans (admin) ───────────────────────────────────────────────
// One-time helper: creates the PayPal Product + the Pro/Family subscription plans
// (in ILS) and returns their IDs. Saves the owner from PayPal's fiddly plan UI.
async function createProduct(token) {
  const r = await fetch(`${paypalBase()}/v1/catalogs/products`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Kesefle Premium',
      description: "מנוי פרימיום לכסף'לה",
      type: 'SERVICE',
      category: 'SOFTWARE',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('product_create_failed: ' + (j.message || r.status));
  return j.id;
}

async function createPlan(token, productId, name, priceIls) {
  const r = await fetch(`${paypalBase()}/v1/billing/plans`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: productId,
      name,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: String(priceIls), currency_code: 'ILS' } },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('plan_create_failed: ' + (j.message || r.status));
  return j.id;
}

async function setupPlansImpl(req, res) {
  let token;
  try { token = await getAccessToken(); }
  catch (e) {
    return res.status(500).json({ ok: false, error: e.message, hint: 'Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET in Vercel first.' });
  }
  try {
    const productId = await createProduct(token);
    const proPlanId = await createPlan(token, productId, 'Kesefle Pro', priceILS('pro', 'month'));
    const familyPlanId = await createPlan(token, productId, 'Kesefle Family', priceILS('family', 'month'));
    log.info('paypal.plans_created', { reqId: req.reqId, productId });
    return res.status(200).json({
      ok: true,
      productId,
      PAYPAL_PLAN_PRO: proPlanId,
      PAYPAL_PLAN_FAMILY: familyPlanId,
      next: 'Paste these two IDs into Vercel as PAYPAL_PLAN_PRO and PAYPAL_PLAN_FAMILY, then redeploy.',
    });
  } catch (e) {
    log.error('paypal.setup_plans_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
// Rate-limit ONLY the user-triggered subscribe action. The webhook must NOT be
// throttled — PayPal posts every subscriber's events from shared IPs, so a
// global cap would 429 legitimate lifecycle events.
const subscribeHandler = withRateLimit({ key: 'billing_paypal', limit: 30, windowSec: 3600 })(
  requireAuth(subscribeImpl)
);

export default withRequestId(async function paypalRouter(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const action = String(req.query.action || '').toLowerCase();
  if (action === 'subscribe') return subscribeHandler(req, res);
  if (action === 'webhook') return webhookImpl(req, res);
  if (action === 'setup-plans') return requireAdmin(setupPlansImpl)(req, res);
  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['subscribe', 'webhook', 'setup-plans'] });
});
