// lib/invoice.js
// Green Invoice (greeninvoice.co.il) integration. Generates Israeli
// tax invoices (חשבונית מס/קבלה, doc type 400) on demand and returns
// a PDF link. Pure module: no Express coupling, no KV writes here.
//
// Auth flow (per Green Invoice API):
//   POST /api/v1/account/token  { id, secret }  -> { token, expires }
//   token is a JWT good for ~30 min; we cache it in a module-level var
//   and refresh ~5 min before expiry.
//
// Document creation:
//   POST /api/v1/documents  (Bearer <token>)
//     body: { type: 400, ...client, income[], payment[], ... }
//     returns: { id, url, ... }
//
// Env (all optional; if either is missing, createInvoice fails soft):
//   GREEN_INVOICE_KEY     - API key id from greeninvoice.co.il
//   GREEN_INVOICE_SECRET  - API key secret
//   GREEN_INVOICE_ENV     - 'test' for sandbox, anything else for prod
//
// IMPORTANT: this is an Israeli tax-compliance code path. Failure here
// MUST NOT block payment recording — the caller can retry later or
// generate the invoice manually. Every public function returns a
// result object instead of throwing.
//
// TODO(green-invoice): the exact shape of the documents POST body
// (field names like `client`, `income`, `payment`, document type
// numbers) is based on the publicly documented v1 schema as of
// 2024; Steven must verify against the live API docs once he signs
// up and adjust the body builders below if the field names differ.

import { log } from './log.js';

// Green Invoice document type codes.
//   305 = receipt only (קבלה)
//   320 = invoice only (חשבונית)
//   400 = invoice + receipt combined (חשבונית מס/קבלה) - what we need
const DOC_TYPE_INVOICE_RECEIPT = 400;

// Payment-method codes for the documents API "payment" array.
// TODO(green-invoice): confirm these against live API docs.
const PAYMENT_METHOD_CODES = {
  paypal: 4,   // credit-card-equivalent (PayPal aggregator)
  card:   3,   // credit card
  bit:    10,  // application (Bit, Pepper Pay, etc.)
  crypto: 11,  // "other" - Green Invoice has no crypto code; we use other
  bank:   5,   // bank transfer
  cash:   1,   // cash
  manual: 11,  // other
};

// Module-level JWT cache. Single function instance can reuse across
// multiple invocations to avoid hammering the token endpoint.
let _jwtCache = { token: null, expiresAt: 0 };

function isConfigured() {
  return !!(process.env.GREEN_INVOICE_KEY && process.env.GREEN_INVOICE_SECRET);
}

function baseUrl() {
  const env = String(process.env.GREEN_INVOICE_ENV || '').toLowerCase();
  if (env === 'test' || env === 'sandbox') return 'https://api.sandbox.d.greeninvoice.co.il';
  return 'https://api.greeninvoice.co.il';
}

// Sleep that honours an upper bound to avoid pathological backoffs.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(30000, ms))));
}

// Exchange API key + secret for a JWT. Caches the token in module memory
// and refreshes when within 5 minutes of expiry. Returns null on failure.
async function getJwt() {
  if (!isConfigured()) return null;
  const now = Date.now();
  // 5-min safety buffer so we never use a token that's about to expire mid-flight.
  if (_jwtCache.token && _jwtCache.expiresAt - now > 5 * 60 * 1000) {
    return _jwtCache.token;
  }
  const url = `${baseUrl()}/api/v1/account/token`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: process.env.GREEN_INVOICE_KEY,
        secret: process.env.GREEN_INVOICE_SECRET,
      }),
    });
    if (!r.ok) {
      log.warn('invoice.token_http_failed', { status: r.status });
      return null;
    }
    const j = await r.json().catch(() => ({}));
    if (!j?.token) {
      log.warn('invoice.token_missing_in_response', {});
      return null;
    }
    // Green Invoice returns `expires` as a unix epoch (seconds) for prod
    // or sometimes a relative seconds value; treat anything below 24h
    // worth of seconds as relative to now.
    let expSec = Number(j.expires) || 1800;
    if (expSec < 86400) {
      // relative seconds
      _jwtCache.expiresAt = now + expSec * 1000;
    } else {
      // absolute epoch seconds
      _jwtCache.expiresAt = expSec * 1000;
    }
    _jwtCache.token = j.token;
    return _jwtCache.token;
  } catch (e) {
    log.warn('invoice.token_fetch_failed', { error: e.message });
    return null;
  }
}

// For tests / manual force-refresh after env change.
function _resetJwtCache() {
  _jwtCache = { token: null, expiresAt: 0 };
}

// Build the request body for the documents endpoint.
// TODO(green-invoice): verify field names against live API docs.
function buildDocumentBody(opts) {
  const {
    customerName, customerEmail, customerTaxId, companyName,
    amount, currency = 'ILS', description, paymentMethod, paymentReference,
    vatRate,
  } = opts;

  // VAT rate: as of 2026 in Israel the default rate is 18% (raised
  // from 17% in 2025). Caller can override via vatRate; the API
  // calculates exact VAT from the rate + price, so any drift only
  // affects the rounding in the line item display.
  const vatPercent = typeof vatRate === 'number' ? vatRate : 18;

  // "Quantity 1, price = amount (incl. VAT)" - simplest representation.
  // Green Invoice will back-calculate the VAT portion from vatType=1
  // (price-includes-vat) - the most common Israeli usage.
  const incomeLine = {
    description: String(description || 'מנוי כספלה').slice(0, 250),
    quantity: 1,
    price: Number(amount),
    currency,
    vatType: 1, // 1 = price includes VAT (most common in IL)
    // TODO(green-invoice): some accounts require an itemId/catalogNumber.
  };

  const paymentLine = {
    date: new Date().toISOString().slice(0, 10),
    type: PAYMENT_METHOD_CODES[String(paymentMethod || '').toLowerCase()] ?? PAYMENT_METHOD_CODES.manual,
    price: Number(amount),
    currency,
    // Include the payment reference so the receipt shows the upstream id.
    // TODO(green-invoice): the field name for free-text reference may be
    // `info`, `reference`, or `description` depending on payment type.
    info: paymentReference ? String(paymentReference).slice(0, 80) : undefined,
  };

  const client = {
    // Prefer the company name if provided, fall back to person name.
    name: String(companyName || customerName || 'לקוח').slice(0, 120),
    emails: customerEmail ? [String(customerEmail)] : undefined,
    // For B2B invoices the taxId enables the customer to deduct the VAT
    // as input tax — REQUIRED when companyName/taxId provided.
    taxId: customerTaxId || undefined,
    // TODO(green-invoice): for personal (non-business) customers,
    // some accounts require `add: true` (creates a client record) and
    // omit taxId. Confirm against live docs.
  };

  return {
    type: DOC_TYPE_INVOICE_RECEIPT,
    description: String(description || 'מנוי כספלה').slice(0, 250),
    lang: 'he',
    currency,
    vatType: 1,
    client,
    income: [incomeLine],
    payment: [paymentLine],
    // We want the customer to get an email automatically when possible,
    // but only if we know the address. Green Invoice's `emailContent`
    // / send flags vary by account tier; we leave email-out to our own
    // mailer (which the caller wires in) so behaviour is consistent.
  };
}

// Create an Israeli VAT invoice (חשבונית מס/קבלה, type 400) for a
// completed payment. Returns:
//   { ok: true, invoiceId, pdfUrl, ts }
// or fail-soft:
//   { ok: false, error: 'not_configured', skipped: true }   - env missing
//   { ok: false, error: 'token_failed' }                    - JWT exchange failed
//   { ok: false, error: 'http_<status>', errorDetail }      - documents API failed
//   { ok: false, error: 'network_error', errorDetail }      - fetch threw
//
// NEVER throws. The caller (PayPal webhook / billing flow) MUST continue
// successfully even when invoicing falls over — bookkeeping comes second
// to the customer's payment record.
async function createInvoice(opts) {
  const {
    userSub, amount, paymentReference, paymentMethod,
  } = opts || {};

  // Safe-log identity only. Never log customerEmail / customerTaxId.
  const logCtx = {
    userSub: userSub || null,
    paymentReference: paymentReference || null,
    paymentMethod: paymentMethod || null,
    amount: typeof amount === 'number' ? amount : null,
  };

  if (!isConfigured()) {
    log.warn('invoice.skipped_not_configured', logCtx);
    return { ok: false, error: 'not_configured', skipped: true };
  }

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    log.warn('invoice.skipped_bad_amount', logCtx);
    return { ok: false, error: 'invalid_amount' };
  }

  const token = await getJwt();
  if (!token) {
    log.warn('invoice.token_failed', logCtx);
    return { ok: false, error: 'token_failed' };
  }

  const url = `${baseUrl()}/api/v1/documents`;
  const body = JSON.stringify(buildDocumentBody(opts));

  // Up to 3 attempts on 429 / 5xx with exponential backoff honouring Retry-After.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body,
      });
    } catch (e) {
      lastErr = { error: 'network_error', errorDetail: e.message };
      log.warn('invoice.network_error', { ...logCtx, attempt, error: e.message });
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }

    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      const retryAfter = Number(r.headers.get('retry-after')) || 0;
      const wait = retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * Math.pow(2, attempt));
      log.warn('invoice.retry', { ...logCtx, attempt, status: r.status, waitMs: wait });
      await sleep(wait);
      continue;
    }

    let j = {};
    try { j = await r.json(); } catch { /* ignore */ }

    if (!r.ok) {
      // Don't log the response body raw — it may echo the client object
      // back which contains PII. Log only the high-level error code.
      const detail = j?.errorCode || j?.code || j?.message?.slice?.(0, 80) || ('http_' + r.status);
      log.warn('invoice.http_failed', { ...logCtx, status: r.status, detail });
      return { ok: false, error: 'http_' + r.status, errorDetail: detail };
    }

    if (!j?.id) {
      log.warn('invoice.missing_id_in_response', logCtx);
      return { ok: false, error: 'invalid_response' };
    }

    const out = {
      ok: true,
      invoiceId: String(j.id),
      pdfUrl: j.url || j.downloadUrl || null,
      ts: new Date().toISOString(),
    };
    log.info('invoice.created', { ...logCtx, invoiceId: out.invoiceId, hasPdfUrl: !!out.pdfUrl });
    return out;
  }

  log.warn('invoice.gave_up', { ...logCtx, lastErr });
  return lastErr || { ok: false, error: 'retries_exhausted' };
}

export {
  createInvoice,
  getJwt,
  isConfigured,
  buildDocumentBody,
  _resetJwtCache,
  PAYMENT_METHOD_CODES,
  DOC_TYPE_INVOICE_RECEIPT,
};
