// api/cron/reminders.js
//
// Vercel-cron wrapper around api/reminders.js action=due. Vercel sends an
// Authorization: Bearer <CRON_SECRET> header when CRON_SECRET env var is set
// (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// We verify that, then invoke the existing reminders handler directly with
// a synthesized POST body so we don't need to refactor the existing endpoint.
//
// Schedule: see vercel.json -- daily at 06:00 UTC = 09:00 Asia/Jerusalem.

import { withRequestId, log } from '../../lib/log.js';

async function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error('cron.reminders.cron_secret_unset');
    return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  }
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${cronSecret}`;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!auth || !constantTimeEqual(String(auth), expected)) {
    log.error('cron.reminders.unauthorized');
    return { ok: false, code: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

async function handlerImpl(req, res) {
  const authCheck = await verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  // The existing /api/reminders endpoint expects a bot-secret-style POST with
  // action=due. We delegate by importing its module and calling it through
  // an internal-style invocation -- but since the endpoint enforces its OWN
  // separate KESEFLE_CRON_SECRET, the cleanest path is to call its action=due
  // logic by re-exporting. For now we POST to ourselves via fetch -- adds
  // ~1 RTT but keeps the contract intact and avoids cross-import side effects.
  const ownUrl = process.env.SELF_URL || 'https://kesefle.com';
  const kesefleCronSecret = process.env.KESEFLE_CRON_SECRET;
  if (!kesefleCronSecret) {
    return res.status(503).json({ ok: false, error: 'kesefle_cron_secret_missing' });
  }

  try {
    const r = await fetch(`${ownUrl}/api/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kesefle-cron-secret': kesefleCronSecret },
      body: JSON.stringify({ action: 'due' }),
    });
    const j = await r.json().catch(() => ({}));
    log.info('cron.reminders.invoked', { reqId: req.reqId, status: r.status, ok: j.ok, result: j });
    return res.status(200).json({ ok: true, delegated_status: r.status, result: j });
  } catch (e) {
    log.error('cron.reminders.invoke_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'invoke_failed', detail: e.message });
  }
}

export default withRequestId(handlerImpl);
