// api/cron/recurring.js
//
// Vercel-cron wrapper around api/recurring.js action=cron. Same pattern as
// api/cron/reminders.js -- verifies Vercel's Authorization Bearer header,
// then delegates to the existing recurring cron endpoint via a self-fetch.

import { withRequestId, log } from '../../lib/log.js';

function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error('cron.recurring.cron_secret_unset');
    return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  }
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${cronSecret}`;
  if (auth !== expected) {
    log.error('cron.recurring.unauthorized');
    return { ok: false, code: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

async function handlerImpl(req, res) {
  const authCheck = verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  const ownUrl = process.env.SELF_URL || 'https://kesefle.com';
  const kesefleCronSecret = process.env.KESEFLE_CRON_SECRET;
  if (!kesefleCronSecret) {
    return res.status(503).json({ ok: false, error: 'kesefle_cron_secret_missing' });
  }

  try {
    const r = await fetch(`${ownUrl}/api/recurring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-kesefle-cron-secret': kesefleCronSecret },
      body: JSON.stringify({ action: 'cron' }),
    });
    const j = await r.json().catch(() => ({}));
    log.info('cron.recurring.invoked', { reqId: req.reqId, status: r.status, ok: j.ok, result: j });
    return res.status(200).json({ ok: true, delegated_status: r.status, result: j });
  } catch (e) {
    log.error('cron.recurring.invoke_failed', { reqId: req.reqId, error: e.message });
    return res.status(502).json({ ok: false, error: 'invoke_failed', detail: e.message });
  }
}

export default withRequestId(handlerImpl);
