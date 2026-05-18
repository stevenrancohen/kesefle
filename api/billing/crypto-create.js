// /api/billing/crypto-create
// Creates a Coinbase Commerce charge for premium-monthly and returns hosted_url.

import crypto from 'node:crypto';

const ALLOWED_PLANS = ['premium-monthly'];

async function getUserIdFromSession(req) {
  try {
    const mod = await import('../_lib/session.js');
    if (typeof mod.requireUser === 'function') return null;
  } catch (e) { /* session.js not present yet — fall through to inline decode */ }

  const cookieHeader = req.headers?.cookie || '';
  const m = cookieHeader.match(/(?:^|;\s*)kefle_session=([^;]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const signingInput = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  if (expected !== parts[2]) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload.sub || payload.userId || null;
  } catch (e) {
    return null;
  }
}

async function resolveUserId(req, res) {
  try {
    const mod = await import('../_lib/session.js');
    if (typeof mod.requireUser === 'function') {
      return await mod.requireUser(req, res);
    }
  } catch (e) { /* fall through to inline decode */ }
  const uid = await getUserIdFromSession(req);
  if (!uid) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return uid;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const userId = await resolveUserId(req, res);
  if (!userId) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const plan = String(body?.plan || '');
  if (!ALLOWED_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'invalid_plan', allowed: ALLOWED_PLANS });
  }

  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'billing_not_configured' });
  }

  // Coinbase Commerce's local_price doesn't accept ILS for crypto conversion reliably.
  // We bill USD ~8 (≈ ₪29) — close to the local Pro tier price.
  const payload = {
    name: 'Kesefle Premium',
    description: "מנוי חודשי לכסף'לה",
    pricing_type: 'fixed_price',
    local_price: { amount: '8.00', currency: 'USD' },
    metadata: { userId: String(userId), plan },
  };

  try {
    const r = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('coinbase_charge_failed', r.status, JSON.stringify(j));
      return res.status(500).json({ error: 'charge_create_failed' });
    }
    const hostedUrl = j?.data?.hosted_url;
    if (!hostedUrl) {
      console.error('coinbase_charge_no_hosted_url', JSON.stringify(j));
      return res.status(500).json({ error: 'charge_create_failed' });
    }
    return res.status(200).json({ hosted_url: hostedUrl });
  } catch (e) {
    console.error('coinbase_unreachable', e.message);
    return res.status(500).json({ error: 'charge_create_failed' });
  }
}
