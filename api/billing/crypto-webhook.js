// /api/billing/crypto-webhook
// Coinbase Commerce webhook. Verifies the HMAC signature, then activates premium
// via the shared lib/billing.activatePremium path (writes the canonical user
// record so the bot + website both see it).
//
// Env: COINBASE_WEBHOOK_SECRET

import crypto from 'node:crypto';
import { activatePremium, periodMonths, billingKvGet, billingKvSet } from '../../lib/billing.js';
import { withRequestId, log } from '../../lib/log.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A confirmed/resolved charge that we CANNOT map to a user (missing/garbled
// metadata, a charge created manually in the Coinbase dashboard, or Coinbase
// truncating the metadata round-trip) is a real paid customer who would never
// get activated. Previously this returned a bare 200 with no breadcrumb, so the
// payment was lost silently. Now we log loudly + page the owner. We still ACK
// 200 (not 500): the charge is unmappable, so retries can't fix it and would
// just hammer the endpoint -- a human has to reconcile it from the alert.
async function alertUnmappablePayment({ reqId, eventId, chargeId, type, metaKeys }) {
  log.error('crypto_webhook.confirmed_but_no_user', { reqId, eventId, chargeId, type, metaKeys });
  try {
    const { sendAlert } = await import('../../lib/alert.js');
    await sendAlert({
      severity: 'critical',
      title: 'Crypto payment confirmed but no user to activate',
      body: `A Coinbase charge was ${type} but carried no resolvable userSub in metadata.\n`
        + `chargeId=${chargeId || 'unknown'} eventId=${eventId || 'unknown'}\n`
        + `metadata keys present: ${(metaKeys && metaKeys.length) ? metaKeys.join(', ') : '(none)'}\n\n`
        + `The customer PAID but premium was NOT granted. Reconcile manually in the Coinbase dashboard + /api/billing/manual.`,
      tags: ['billing', 'payment-lost'],
    }).catch(() => {});
  } catch (_e) { /* alert must never break the ack */ }
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const secret = process.env.COINBASE_WEBHOOK_SECRET;
  if (!secret) {
    log.error('crypto_webhook.secret_not_configured', { reqId: req.reqId });
    return res.status(500).json({ ok: false, error: 'webhook_secret_not_configured' });
  }

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { return res.status(400).json({ ok: false, error: 'body_read_failed' }); }

  const sigHeader = req.headers['x-cc-webhook-signature'];
  if (!sigHeader) return res.status(401).json({ ok: false, error: 'signature_missing' });

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sigHeader), 'hex'));
  } catch { valid = false; }
  if (!valid) {
    log.warn('crypto_webhook.signature_invalid', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'signature_invalid' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch {
    log.warn('crypto_webhook.invalid_json', { reqId: req.reqId });
    return res.status(200).json({ ok: true, ignored: 'invalid_json' });
  }

  const type = event?.event?.type || event?.type;
  const data = event?.event?.data || event?.data;
  const eventId = event?.event?.id || event?.id || data?.id;

  if (type === 'charge:confirmed' || type === 'charge:resolved') {
    // Idempotency — Coinbase retries; never double-extend a paid period.
    const seenKey = `crypto_event:${eventId}`;
    if (await billingKvGet(seenKey)) {
      log.info('crypto_webhook.duplicate', { reqId: req.reqId, eventId, type });
      return res.status(200).json({ ok: true, duplicate: eventId });
    }

    const meta = data?.metadata || {};
    const userSub = meta.userSub || meta.userId; // accept legacy key
    const plan = meta.plan || 'pro';
    const period = meta.period || 'month';
    const chargeId = data?.id;

    if (userSub) {
      try {
        await activatePremium(userSub, {
          plan,
          method: 'crypto',
          months: periodMonths(period),
          externalId: chargeId,
          recurring: false,
        });
        await billingKvSet(seenKey, { type, ts: new Date().toISOString() });
        log.info('crypto_webhook.activated', { reqId: req.reqId, userSub, plan, period, chargeId, type });
      } catch (e) {
        log.error('crypto_webhook.activate_failed', { reqId: req.reqId, userSub, chargeId, error: e.message });
        // Return 500 so Coinbase retries rather than dropping a real payment.
        return res.status(500).json({ ok: false, error: 'activation_failed' });
      }
    } else {
      // Paid, but unmappable — never drop this on the floor silently.
      await alertUnmappablePayment({
        reqId: req.reqId, eventId, chargeId, type, metaKeys: Object.keys(meta || {}),
      });
      // Mark seen so the retries of this same un-fixable event don't re-page.
      await billingKvSet(seenKey, { type, ts: new Date().toISOString(), unmapped: true });
      return res.status(200).json({ ok: true, warning: 'no_user_in_metadata' });
    }
  } else if (type) {
    // Non-activation events (charge:created / charge:pending / charge:failed /
    // charge:delayed). Log for visibility instead of swallowing entirely.
    log.info('crypto_webhook.event_ignored', { reqId: req.reqId, eventId, type });
  }

  return res.status(200).json({ ok: true });
}

export default withRequestId(handlerImpl);
