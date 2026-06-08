// api/admin/activation-summary.js
//
// Admin-only thin wrapper over lib/activation.js. The ONE activation number:
// of people who signed up in the last N days, how many logged a 2nd expense?
// Plus the kill-criterion verdict. Read-only, no writes, no PII.
//
// GET /api/admin/activation-summary?days=30

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { computeActivationCohort } from '../../lib/activation.js';

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const data = await computeActivationCohort(days);
  if (!data.ok) return res.status(503).json(data);
  return res.status(200).json({ at: new Date().toISOString(), ...data });
}

export { handlerImpl }; // exported for unit test (bypasses the requireAdmin wrapper)

export default withRequestId(
  withRateLimit({ key: 'admin_activation_summary', limit: 60, windowSec: 60 })(requireAdmin(handlerImpl))
);
