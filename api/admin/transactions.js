// /api/admin/transactions
// GET — global transaction feed for admin observability.
//
// STATUS: PLACEHOLDER. We need to design how this is served before turning it on.
//
// The challenge: transactions live in each user's own Google Sheet, not in KV.
// Building a global feed requires either:
//   (a) per-user sheet read with the stored refresh token — expensive and
//       crosses a trust boundary (admins read user data, must be heavily audited
//       and probably gated by user consent); or
//   (b) a background ingest job that mirrors transactions into a server-side
//       store (BigQuery / Postgres / KV index) with consent at signup; or
//   (c) sampling — admin SPA picks a single userSub and we proxy through to
//       /api/sheet/summary as that admin (still requires (a)'s consent dance).
//
// This stub returns an empty list with a structured `note` so the admin SPA
// can render an "unavailable" tile without crashing. When (b) is implemented,
// swap the body of this function for a `txn:*` KV index scan.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }

  log.info('admin.transactions.placeholder_called', {
    reqId,
    adminEmail: req.user.email,
  });

  return res.status(200).json({
    ok: true,
    transactions: [],
    note: 'requires per-user sheet read via stored refresh token',
    note_he: 'מצריך קריאת גיליון לכל משתמש דרך אסימון הרענון השמור',
    todo: [
      'Choose strategy: per-user proxy, ingest mirror, or sampling',
      'Add per-user consent for admin read in onboarding',
      'Implement txn:* KV index OR /api/admin/user/[sub]/transactions',
      'Audit-log every admin transaction read',
    ],
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_transactions', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
