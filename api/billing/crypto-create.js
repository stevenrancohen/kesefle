// /api/billing/crypto-create
// Creates a Coinbase Commerce charge for a Pro/Family plan (prepaid month/year)
// and returns the hosted checkout URL. Activation happens in crypto-webhook.js
// via the shared lib/billing.activatePremium path.
//
// Env: COINBASE_COMMERCE_API_KEY
// Auth: standard requireAuth (Bearer Google ID token OR kfl_session cookie).

import { requireAuth } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { priceUSD, priceILS, normalizePlan, PLAN_LABELS } from '../../lib/billing.js';

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'crypto_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const plan = normalizePlan(body?.plan);
  const period = String(body?.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  if (!['pro', 'family'].includes(plan)) {
    return res.status(400).json({ ok: false, error: 'invalid_plan', allowed: ['pro', 'family'] });
  }

  // Identity comes from the verified token, never the body.
  const userSub = req.user.sub;
  const usd = priceUSD(plan, period);

  const payload = {
    name: `Kesefle ${PLAN_LABELS[plan] || 'Premium'}`,
    description: `מנוי ${period === 'year' ? 'שנתי' : 'חודשי'} לכספ'לה — ${priceILS(plan, period)}₪`,
    pricing_type: 'fixed_price',
    local_price: { amount: usd.toFixed(2), currency: 'USD' },
    // userSub is the canonical key the webhook activates against (legacy charges
    // used `userId` — the webhook still reads both).
    metadata: { userSub, plan, period },
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
      log.error('coinbase_charge_failed', { reqId: req.reqId, status: r.status, detail: j?.error });
      return res.status(502).json({ ok: false, error: 'charge_create_failed' });
    }
    const hostedUrl = j?.data?.hosted_url;
    if (!hostedUrl) {
      log.error('coinbase_no_hosted_url', { reqId: req.reqId });
      return res.status(502).json({ ok: false, error: 'charge_create_failed' });
    }
    return res.status(200).json({ ok: true, url: hostedUrl, hosted_url: hostedUrl });
  } catch (e) {
    log.error('coinbase_unreachable', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'crypto_unreachable' });
  }
}

export default withRequestId(
  withRateLimit({ key: 'billing_crypto', limit: 10, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
