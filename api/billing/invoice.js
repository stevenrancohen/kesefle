// /api/billing/invoice
//
// Admin-callable endpoint to (re)issue an Israeli VAT invoice
// (חשבונית מס/קבלה, type 400) for a payment that's already been
// recorded. Also imported & called internally by the PayPal /
// crypto / manual payment paths via lib/invoice.createInvoice.
//
// Why an explicit endpoint instead of always doing it inline?
//   1. Recovery: if the auto-invoice fails (Green Invoice 5xx,
//      missing env, etc.) we can re-run it from /admin.
//   2. Backfill: pre-launch payments captured manually need
//      invoices generated after-the-fact.
//   3. Manual one-offs for off-platform sales.
//
// POST /api/billing/invoice
//   Headers: Authorization: Bearer <google-id-token> (admin email)
//   Body: {
//     userSub: string,           // required
//     amount: number,            // required, ILS
//     currency?: 'ILS',          // default 'ILS'
//     paymentMethod?: string,    // 'paypal' | 'crypto' | 'bit' | 'bank' | 'manual'
//     paymentReference?: string, // upstream charge id
//     description?: string,      // line-item description (Hebrew)
//   }
//   Returns: { ok, invoiceId, pdfUrl, ts }  or  { ok:false, error, ... }
//
// Rate-limit: 20 per hour per admin (covers backfill batches but not abuse).

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { billingKvGet, billingKvSet } from '../../lib/billing.js';
import { createInvoice } from '../../lib/invoice.js';

// Profile KV: profile records use phone as the key. The user record
// (`user:{userSub}`) holds email + name + optional billing/tax info.
async function loadCustomerInfo(userSub) {
  const userRec = await billingKvGet('user:' + userSub);
  if (!userRec) return null;
  // taxId / companyName live on the per-phone profile (captured in the
  // bot's onboarding questionnaire). We look up by phone if available.
  let taxId = null;
  let companyName = null;
  if (userRec.phone) {
    const profile = await billingKvGet('profile:' + userRec.phone);
    if (profile) {
      taxId = profile.taxId || null;
      companyName = profile.companyName || null;
    }
  }
  return {
    customerName: userRec.name || null,
    customerEmail: userRec.email || null,
    customerTaxId: taxId,
    companyName,
  };
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const userSub = String(body.userSub || '').trim();
  const amount = Number(body.amount);
  const currency = String(body.currency || 'ILS').toUpperCase();
  const paymentMethod = String(body.paymentMethod || 'manual').toLowerCase();
  const paymentReference = String(body.paymentReference || ('manual-' + Date.now())).trim();
  const description = String(body.description || 'מנוי כספלה').slice(0, 250);

  if (!userSub) return res.status(400).json({ ok: false, error: 'missing_userSub' });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_amount' });
  }

  // Look up customer info from KV. If the user record doesn't exist we
  // still attempt the invoice — Green Invoice tolerates the bare client
  // name "לקוח" and the admin can edit on the dashboard.
  const customer = (await loadCustomerInfo(userSub)) || {};

  // Privacy: log only userSub / paymentReference / amount.
  log.info('invoice.endpoint_request', {
    reqId: req.reqId,
    userSub,
    paymentReference,
    amount,
    currency,
    paymentMethod,
    by: req.user?.email,
  });

  const result = await createInvoice({
    userSub,
    customerName: customer.customerName,
    customerEmail: customer.customerEmail,
    customerTaxId: customer.customerTaxId,
    companyName: customer.companyName,
    amount,
    currency,
    description,
    paymentMethod,
    paymentReference,
  });

  // Always 200 — env-fail-soft. Caller inspects `ok` + `skipped`.
  // Persist the invoice record on success (keyed by userSub + reference
  // so a re-run for the same payment is idempotent at the KV layer).
  if (result.ok) {
    await billingKvSet(`invoice:${userSub}:${paymentReference}`, {
      invoiceId: result.invoiceId,
      pdfUrl: result.pdfUrl,
      ts: result.ts,
      paymentMethod,
      amount,
      currency,
    }).catch(() => {});
  }

  return res.status(200).json(result);
}

const adminHandler = withRateLimit({ key: 'billing_invoice', limit: 20, windowSec: 3600 })(
  requireAdmin(handlerImpl)
);

export default withRequestId(adminHandler);
