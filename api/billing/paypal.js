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
//      PAYPAL_PLAN_PRO, PAYPAL_PLAN_FAMILY (monthly),
//      PAYPAL_PLAN_PRO_YEAR, PAYPAL_PLAN_FAMILY_YEAR (annual, optional —
//      planIdFor falls back to the monthly plan if a yearly one is unset),
//      PAYPAL_WEBHOOK_ID

import { requireAuth, requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import {
  activatePremium, deactivatePremium, priceILS,
  billingKvGet, billingKvSet,
} from '../../lib/billing.js';
import { createInvoice } from '../../lib/invoice.js';

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

// Plan ID resolution per (plan, period). Each (Pro|Family) x (month|year)
// pair is a SEPARATE PayPal subscription plan. Annual env vars are optional:
// if a yearly plan isn't configured, we fall back to the monthly plan so
// the user can still subscribe (slightly worse UX than a hard error but
// preserves the conversion).
function planIdFor(plan, period) {
  var per = period === 'year' ? 'year' : 'month';
  if (plan === 'family') {
    return per === 'year'
      ? (process.env.PAYPAL_PLAN_FAMILY_YEAR || process.env.PAYPAL_PLAN_FAMILY)
      : process.env.PAYPAL_PLAN_FAMILY;
  }
  return per === 'year'
    ? (process.env.PAYPAL_PLAN_PRO_YEAR || process.env.PAYPAL_PLAN_PRO)
    : process.env.PAYPAL_PLAN_PRO;
}
function planFromPlanId(planId) {
  if (!planId) return { plan: 'pro', period: 'month' };
  if (planId === process.env.PAYPAL_PLAN_FAMILY_YEAR) return { plan: 'family', period: 'year' };
  if (planId === process.env.PAYPAL_PLAN_FAMILY) return { plan: 'family', period: 'month' };
  if (planId === process.env.PAYPAL_PLAN_PRO_YEAR) return { plan: 'pro', period: 'year' };
  return { plan: 'pro', period: 'month' };
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

// Fire-and-forget Israeli VAT invoice (חשבונית מס/קבלה) for a completed
// PayPal payment. Never throws — invoicing failure must not block the
// webhook (PayPal would retry the event and we'd risk double-activation).
// All customer info is looked up from KV by lib/invoice's caller; we just
// pass userSub + amount + reference here.
async function maybeIssueInvoiceForPayment({ reqId, userSub, plan, amountILS, externalId, customerEmail, customerName }) {
  // Look up profile (taxId / companyName) from KV via the user's phone.
  let customerTaxId = null;
  let companyName = null;
  let resolvedEmail = customerEmail || null;
  let resolvedName = customerName || null;
  try {
    const userRec = await billingKvGet('user:' + userSub);
    if (userRec) {
      resolvedEmail = resolvedEmail || userRec.email || null;
      resolvedName = resolvedName || userRec.name || null;
      if (userRec.phone) {
        const profile = await billingKvGet('profile:' + userRec.phone);
        if (profile) {
          customerTaxId = profile.taxId || null;
          companyName = profile.companyName || null;
        }
      }
    }
  } catch (_e) { /* best effort */ }

  let result = null;
  try {
    result = await createInvoice({
      userSub,
      customerName: resolvedName,
      customerEmail: resolvedEmail,
      customerTaxId,
      companyName,
      amount: amountILS,
      currency: 'ILS',
      description: `מנוי כספלה ${plan === 'family' ? 'משפחה' : 'פרו'}`,
      paymentMethod: 'paypal',
      paymentReference: externalId,
    });
  } catch (e) {
    log.warn('paypal.invoice_threw', { reqId, userSub, error: e.message });
    return;
  }

  if (!result?.ok) {
    log.warn('paypal.invoice_failed', { reqId, userSub, error: result?.error });
    return;
  }

  // Persist (idempotent key) for later lookup / re-send.
  try {
    await billingKvSet(`invoice:${userSub}:${externalId}`, {
      invoiceId: result.invoiceId,
      pdfUrl: result.pdfUrl,
      ts: result.ts,
      paymentMethod: 'paypal',
      amount: amountILS,
      currency: 'ILS',
    });
  } catch (_e) { /* best effort */ }

  // Best-effort email of the PDF link. lib/email.js doesn't exist yet —
  // we dynamic-import to avoid a hard dependency. ANY failure here is
  // swallowed; the customer can still pull the PDF from /account.
  if (result.pdfUrl && resolvedEmail) {
    try {
      const mod = await import('../../lib/email.js').catch(() => null);
      if (mod?.sendEmail) {
        await mod.sendEmail({
          to: resolvedEmail,
          subject: 'חשבונית מס/קבלה מכספלה',
          html: `<p dir="rtl">תודה על התשלום!</p><p dir="rtl">לקבלת החשבונית: <a href="${result.pdfUrl}">${result.pdfUrl}</a></p>`,
        }).catch(() => {});
      }
    } catch (_e) { /* best effort */ }
  }
}

// ── action=subscribe ─────────────────────────────────────────────────────────
async function subscribeImpl(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const plan = String(body?.plan || '').toLowerCase() === 'family' ? 'family' : 'pro';
  const period = String(body?.period || '').toLowerCase() === 'year' ? 'year' : 'month';

  const planId = planIdFor(plan, period);
  if (!planId) {
    return res.status(500).json({ ok: false, error: 'paypal_plan_not_configured', detail: `${plan}/${period}` });
  }

  let token;
  try { token = await getAccessToken(); }
  catch (e) {
    // Stable error code (not the raw exception message) — matches the sibling
    // failure responses below (paypal_subscribe_failed / paypal_unreachable)
    // and keeps internal detail out of this user-facing, authed response body.
    // The detail is logged server-side for debugging.
    log.error('paypal_get_token_failed', { reqId: req.reqId, where: 'subscribe', error: e.message });
    return res.status(502).json({ ok: false, error: 'paypal_unreachable' });
  }

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
  catch (e) {
    // Stable error code; detail logged server-side. 502 so PayPal retries the
    // webhook delivery (a transient token-mint failure shouldn't drop the event).
    log.error('paypal_get_token_failed', { reqId: req.reqId, where: 'webhook', error: e.message });
    return res.status(502).json({ ok: false, error: 'paypal_unreachable' });
  }

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
      const { plan, period } = planFromPlanId(resource.plan_id);
      const nextBilling = resource.billing_info?.next_billing_time;
      if (userSub && subId) {
        // Persist BOTH plan + period so renewal webhooks + change-plan flow
        // know which billing cycle the user is on. activatePremium also gets
        // the period so it can set the correct accessUntil window.
        await billingKvSet(`paypalSub:${subId}`, { userSub, plan, period });
        await activatePremium(userSub, {
          plan, period, method: 'paypal', recurring: true, externalId: subId,
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
          const plan = map.plan || 'pro';
          const period = map.period === 'year' ? 'year' : 'month';
          await activatePremium(map.userSub, {
            plan, period, method: 'paypal', recurring: true, externalId: subId,
            accessUntil: accessUntilFromNextBilling(nextBilling),
          });
          // Fire-and-forget Israeli VAT invoice. Use the SALE's resource.id as
          // the paymentReference (not the subscription id) so each renewal
          // gets a distinct invoice keyed in KV. Failure here is logged
          // but never blocks the webhook ack (PayPal would otherwise retry
          // and we'd double-activate the subscription).
          const amountILS = Number(resource.amount?.total) || priceILS(plan, period);
          maybeIssueInvoiceForPayment({
            reqId: req.reqId,
            userSub: map.userSub,
            plan,
            amountILS,
            externalId: resource.id || subId,
          }).catch((e) => {
            log.warn('paypal.invoice_unhandled', { reqId: req.reqId, error: e.message });
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
    } else if (
      type === 'PAYMENT.SALE.DENIED' ||
      type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
    ) {
      // Dunning trigger: payment failed -> mark KV state + send Day 0 email.
      // The lifecycle cron picks it up on subsequent days for Day 3 + Day 7
      // retry reminders using the same KV record.
      const subId = resource.billing_agreement_id || resource.id;
      const map = subId ? await billingKvGet(`paypalSub:${subId}`) : null;
      const userSub = map?.userSub || resource.custom_id;
      if (userSub) {
        await billingKvSet(`payment_failed:${userSub}`, {
          subId,
          plan: map?.plan || 'pro',
          firstFailureAt: new Date().toISOString(),
          lastTriggerType: type,
          amountIls: Number(resource.amount?.total) || priceILS(map?.plan || 'pro', 'month'),
        });
        // Fire Day-0 email immediately (best-effort, env-fail-soft).
        try {
          const { sendTemplate } = await import('../../lib/email.js');
          const { buildUnsubscribeUrl } = await import('../../lib/email-unsub.js');
          const u = await billingKvGet(`user:${userSub}`);
          if (u?.email) {
            await sendTemplate({
              to: u.email,
              template: 'payment-failed',
              vars: {
                firstName: u.name ? String(u.name).split(/\s+/)[0] : 'שלום',
                userEmail: u.email,
                planName: (map?.plan === 'family') ? 'Family' : 'Pro',
                amount: String(Number(resource.amount?.total) || priceILS(map?.plan || 'pro', 'month')),
                // Signed unsubscribe (lib/email-unsub.js) — was an unsigned 404 link.
                unsubscribeUrl: buildUnsubscribeUrl(userSub),
              },
            });
          }
        } catch (eMail) {
          log.warn('paypal.payment_failed_email_unhandled', { reqId: req.reqId, error: eMail.message });
        }
      }
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
      description: "מנוי פרימיום לכספ'לה",
      type: 'SERVICE',
      category: 'SOFTWARE',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('product_create_failed: ' + (j.message || r.status));
  return j.id;
}

// intervalUnit is 'MONTH' (default, preserves the original monthly behavior) or
// 'YEAR'. interval_count stays 1 either way: 1 MONTH = monthly billing,
// 1 YEAR = annual billing. total_cycles:0 = bill forever until cancelled.
async function createPlan(token, productId, name, priceIls, intervalUnit) {
  const unit = intervalUnit === 'YEAR' ? 'YEAR' : 'MONTH';
  const r = await fetch(`${paypalBase()}/v1/billing/plans`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: productId,
      name,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: unit, interval_count: 1 },
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

// PURE: the canonical list of the four billing plans setup-plans creates — two
// monthly + two annual, for Pro and Family. Prices come straight from
// lib/billing.js's priceILS (the single server-side source of truth shared by
// the subscribe/webhook/invoice/revenue paths); we never hardcode amounts here.
// `envKey` is the Vercel env var the resulting plan id must be pasted into, and
// matches exactly what planIdFor / planFromPlanId look up. Annual uses
// intervalUnit 'YEAR'; monthly omits it (createPlan defaults to 'MONTH').
function buildPlansToCreate() {
  return [
    { envKey: 'PAYPAL_PLAN_PRO',         name: 'Kesefle Pro',           plan: 'pro',    period: 'month', priceIls: priceILS('pro', 'month') },
    { envKey: 'PAYPAL_PLAN_PRO_YEAR',    name: 'Kesefle Pro (Annual)',  plan: 'pro',    period: 'year',  intervalUnit: 'YEAR', priceIls: priceILS('pro', 'year') },
    { envKey: 'PAYPAL_PLAN_FAMILY',      name: 'Kesefle Family',        plan: 'family', period: 'month', priceIls: priceILS('family', 'month') },
    { envKey: 'PAYPAL_PLAN_FAMILY_YEAR', name: 'Kesefle Family (Annual)', plan: 'family', period: 'year', intervalUnit: 'YEAR', priceIls: priceILS('family', 'year') },
  ];
}

async function setupPlansImpl(req, res) {
  let token;
  try { token = await getAccessToken(); }
  catch (e) {
    return res.status(500).json({ ok: false, error: e.message, hint: 'Set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET in Vercel first.' });
  }
  try {
    const productId = await createProduct(token);
    // Create all four plans (Pro/Family x monthly/annual) under one product and
    // collect their ids keyed by the Vercel env var each must be pasted into.
    const out = {};
    for (const spec of buildPlansToCreate()) {
      out[spec.envKey] = await createPlan(token, productId, spec.name, spec.priceIls, spec.intervalUnit);
    }
    log.info('paypal.plans_created', { reqId: req.reqId, productId, count: Object.keys(out).length });
    return res.status(200).json({
      ok: true,
      productId,
      // Monthly ids (unchanged keys) + the two new annual ids.
      PAYPAL_PLAN_PRO: out.PAYPAL_PLAN_PRO,
      PAYPAL_PLAN_PRO_YEAR: out.PAYPAL_PLAN_PRO_YEAR,
      PAYPAL_PLAN_FAMILY: out.PAYPAL_PLAN_FAMILY,
      PAYPAL_PLAN_FAMILY_YEAR: out.PAYPAL_PLAN_FAMILY_YEAR,
      next: 'Paste all four IDs into Vercel as PAYPAL_PLAN_PRO, PAYPAL_PLAN_PRO_YEAR, PAYPAL_PLAN_FAMILY and PAYPAL_PLAN_FAMILY_YEAR, then redeploy.',
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

// setup-plans is an admin-only, one-time bootstrap that creates PayPal products
// + billing plans (write calls to PayPal's API). Behind requireAdmin already,
// but — like every other admin endpoint — also rate-limited so a leaked/abused
// admin session can't hammer PayPal's plan-creation API. Tight cap: this is run
// a handful of times ever. Mirrors api/billing/invoice.js's admin handler shape.
const setupPlansHandler = withRateLimit({ key: 'billing_paypal_setup', limit: 5, windowSec: 3600 })(
  requireAdmin(setupPlansImpl)
);

export default withRequestId(async function paypalRouter(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const action = String(req.query.action || '').toLowerCase();
  if (action === 'subscribe') return subscribeHandler(req, res);
  if (action === 'webhook') return webhookImpl(req, res);
  if (action === 'setup-plans') return setupPlansHandler(req, res);
  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['subscribe', 'webhook', 'setup-plans'] });
});
