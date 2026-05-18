// /api/billing/crypto-webhook
// Coinbase Commerce webhook receiver. Verifies signature and activates premium on charge:confirmed|resolved.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
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

export async function activatePremium(userId, chargeId) {
  const now = Date.now();
  const sub = {
    plan: 'premium',
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    paymentMethod: 'crypto',
    chargeId,
    activatedAt: now,
  };
  await kvSet(`sub:${userId}`, sub);

  const phoneRec = await kvGet(`phone:of:${userId}`);
  const phone = typeof phoneRec === 'string' ? phoneRec : phoneRec?.phone;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (phone && phoneId && metaToken) {
    try {
      await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${metaToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          text: { body: '✅ מנוי הפרימיום שלך הופעל! תוקף: 30 ימים מהיום. תהנה.' },
        }),
      });
    } catch (e) {
      console.error('whatsapp_notify_failed', e.message);
    }
  }
  return sub;
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

  const sigHeader = req.headers['x-cc-webhook-signature'] || req.headers['X-CC-Webhook-Signature'];
  if (!sigHeader) {
    return res.status(401).json({ error: 'signature_missing' });
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(sigHeader), 'hex'));
  } catch (e) { valid = false; }
  if (!valid) {
    return res.status(401).json({ error: 'signature_invalid' });
  }

  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return res.status(200).json({ ok: true, ignored: 'invalid_json' }); }

  const type = event?.event?.type || event?.type;
  if (type === 'charge:confirmed' || type === 'charge:resolved') {
    const data = event?.event?.data || event?.data;
    const userId = data?.metadata?.userId;
    const chargeId = data?.id;
    if (userId) {
      try {
        await activatePremium(userId, chargeId);
      } catch (e) {
        console.error('activate_premium_failed', e.message);
      }
    }
  }

  return res.status(200).json({ ok: true });
}
