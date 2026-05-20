// /api/billing/crypto-webhook
// Coinbase Commerce webhook. Verifies the HMAC signature, then activates premium
// via the shared lib/billing.activatePremium path (writes the canonical user
// record so the bot + website both see it).
//
// Env: COINBASE_WEBHOOK_SECRET

import crypto from 'node:crypto';
import { activatePremium, periodMonths, billingKvGet, billingKvSet } from '../../lib/billing.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.COINBASE_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'webhook_secret_not_configured' });
  }

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { return res.status(400).json({ error: 'body_read_failed' }); }

  const sigHeader = req.headers['x-cc-webhook-signature'];
  if (!sigHeader) return res.status(401).json({ error: 'signature_missing' });

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sigHeader), 'hex'));
  } catch { valid = false; }
  if (!valid) return res.status(401).json({ error: 'signature_invalid' });

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(200).json({ ok: true, ignored: 'invalid_json' }); }

  const type = event?.event?.type || event?.type;
  const data = event?.event?.data || event?.data;
  const eventId = event?.event?.id || event?.id || data?.id;

  if (type === 'charge:confirmed' || type === 'charge:resolved') {
    // Idempotency — Coinbase retries; never double-extend a paid period.
    const seenKey = `crypto_event:${eventId}`;
    if (await billingKvGet(seenKey)) {
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
      } catch (e) {
        console.error('crypto_activate_failed', e.message);
        // Return 500 so Coinbase retries rather than dropping a real payment.
        return res.status(500).json({ error: 'activation_failed' });
      }
    }
  }

  return res.status(200).json({ ok: true });
}
