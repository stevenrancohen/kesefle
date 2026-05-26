// api/admin/user-reports.js
//
// Admin-only: returns the most recent user-submitted problem reports
// captured by /api/log/user-report. Surfaced in /admin/launch-monitor
// as a list of "users complaining + their context".

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import { withRateLimit } from '../../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_unavailable' });

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const r = await fetch(`${KV_URL}/lrange/user_reports/0/${limit - 1}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const j = await r.json();
    const raw = j?.result || [];
    const reports = raw.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    return res.status(200).json({
      ok: true,
      at: new Date().toISOString(),
      returned: reports.length,
      reports,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'kv_read_failed', detail: e.message });
  }
}

// Steven 2026-05-26 (API audit follow-up): defense-in-depth rate limit.
export default withRequestId(
  withRateLimit({ key: 'admin_user_reports', limit: 60, windowSec: 60 })(requireAdmin(handlerImpl))
);
