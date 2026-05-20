// ============================================================================
// TEST-ONLY ENDPOINT — REMOVE BEFORE PRODUCTION LAUNCH
// ============================================================================
// Simulates a Coinbase charge:confirmed for TEST_USER_ID with no signature
// verification. Bypassing webhook auth in production would let anyone activate
// premium for any user, so we hard-block unless NODE_ENV !== 'production' and
// TEST_USER_ID is set.
// ============================================================================

import { activatePremium } from '../../lib/billing.js';

export default async function handler(req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'not_found' });
  }
  const testUserId = process.env.TEST_USER_ID;
  if (!testUserId) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const rec = await activatePremium(testUserId, {
      plan: 'pro',
      method: 'crypto',
      months: 1,
      externalId: `test_charge_${Date.now()}`,
    });
    return res.status(200).json({ ok: true, userId: testUserId, accessUntil: rec?.accessUntil });
  } catch (e) {
    return res.status(500).json({ error: 'activation_failed', detail: e.message });
  }
}
