// api/admin/sheets-quota.js
//
// Admin-only: returns the current in-memory Sheets API usage snapshot from
// lib/sheet-quota.js. Useful to spot a runaway tenant before they hit
// Google's 100-req/100s hard limit.
//
// IMPORTANT: this is per-instance. Vercel warm-instance memory only -- so
// the data shown is for THIS function's recent activity, not a global view.
// For a real anomaly the sendAlert path in lib/sheet-quota.js will have
// already paged Steven via Slack/email.
//
// GET /api/admin/sheets-quota

import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';
import { getSheetQuotaSnapshot } from '../../lib/sheet-quota.js';

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const snapshot = getSheetQuotaSnapshot();
  return res.status(200).json({
    ok: true,
    snapshot,
    note: 'In-memory per-instance only. For real anomalies, lib/sheet-quota auto-alerts via lib/alert.js.',
    window_seconds: 100,
    read_limit: 100,
    write_limit: 100,
    alert_threshold_pct: 80,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_sheets_quota', limit: 60, windowSec: 60 })(requireAdmin(handlerImpl))
);
