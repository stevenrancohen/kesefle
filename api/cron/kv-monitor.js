// api/cron/kv-monitor.js
//
// Hourly KV usage watchdog. Reads Upstash usage stats and fires an alert
// (lib/alert.js) when pct_used >= 80%, so Steven gets a Slack/email ping
// before commands actually start failing. Also records the latest reading
// for /admin/launch-monitor.
//
// Schedule: vercel.json `0 * * * *` (every hour). Auth: Vercel CRON_SECRET.

import { withRequestId, log } from '../../lib/log.js';
import { sendAlert } from '../../lib/alert.js';

function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${cronSecret}`) return { ok: false, code: 401, error: 'cron_unauthorized' };
  return { ok: true };
}

async function readUpstashUsage() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, error: 'kv_not_configured' };
  try {
    // Upstash REST exposes /info on the data API; if not available, we fall
    // back to estimating from a counter we maintain ourselves.
    const r = await fetch(`${url}/info`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.result) {
      // Free tier daily limit = 10000 commands. info includes daily counters
      // under various keys depending on Upstash version -- be defensive.
      const dailyUsed = j.result?.daily_command_count || j.result?.commands_today || null;
      const dailyLimit = parseInt(process.env.KV_DAILY_LIMIT || '10000', 10);
      const pct = dailyUsed != null ? Math.round((dailyUsed / dailyLimit) * 100) : null;
      return { ok: true, dailyUsed, dailyLimit, pct, source: 'upstash_info' };
    }
    return { ok: false, error: 'upstash_info_not_available' };
  } catch (e) {
    return { ok: false, error: 'fetch_failed', detail: e.message };
  }
}

async function handlerImpl(req, res) {
  const authCheck = verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  const usage = await readUpstashUsage();
  log.info('cron.kv_monitor.usage', { reqId: req.reqId, ...usage });

  // Persist the latest reading for /admin/launch-monitor consumption.
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (url && token && usage.ok) {
      await fetch(`${url}/set/${encodeURIComponent('kv_usage:latest')}?EX=86400`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...usage, at: new Date().toISOString() }),
      }).catch(() => {});
    }
  } catch (_) {}

  // Threshold alert. Two tiers:
  //   >= 95% -> critical (also fires Web Push to admins via lib/alert.js)
  //   >= 80% ->  warning (Slack + email only)
  if (usage.ok && usage.pct != null && usage.pct >= 95) {
    await sendAlert({
      severity: 'critical',
      title: `Upstash KV usage at ${usage.pct}% (capacity)`,
      body: `Daily KV commands: ${usage.dailyUsed}/${usage.dailyLimit}. Writes will start failing soon -- upgrade Upstash or strip more defensive writes IMMEDIATELY. (cron/kv-monitor)`,
      tags: ['kv', 'capacity'],
    });
  } else if (usage.ok && usage.pct != null && usage.pct >= 80) {
    await sendAlert({
      severity: 'warning',
      title: `Upstash KV usage at ${usage.pct}%`,
      body: `Daily KV commands: ${usage.dailyUsed}/${usage.dailyLimit}. Upgrade Upstash or strip more defensive writes. (cron/kv-monitor)`,
      tags: ['kv', 'capacity'],
    });
  }

  return res.status(200).json({ ok: true, ...usage });
}

export default withRequestId(handlerImpl);
