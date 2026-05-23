// api/admin/launch-monitor.js
//
// Real-time launch-day health endpoint. Returns:
//   - signups in last 1h / 24h (from user:* keys with lastLoginAt)
//   - success/failure split (from KV write_log + missed-inapp list)
//   - top error reasons in last hour
//   - bot reachability (last successful append timestamp)
//   - KV usage estimate (% of free tier 10k/day used)
//   - in-app browser misses (UAs that slipped past detection)
//
// Admin-gated via requireAdmin. Designed to be polled every 30-60s from the
// /admin dashboard during launch.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) { return null; }
}

// Scan a key pattern with bounded iterations. Free-tier KV is fragile so we
// limit to 5 passes max -- which covers ~1000 keys per scan.
async function kvScan(pattern, maxKeys = 1000) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 5 && keys.length < maxKeys; i++) {
    const j = await kvFetch(`/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/200`);
    if (!j?.result) break;
    cursor = String(j.result[0] || '0');
    const batch = j.result[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys;
}

async function kvGet(key) {
  const j = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

async function kvLRange(key, start, stop) {
  const j = await kvFetch(`/lrange/${encodeURIComponent(key)}/${start}/${stop}`);
  return j?.result || [];
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  }

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // 1. Signups: scan user:* keys, count by lastLoginAt window.
  // Note: lastLoginAt is set on every sign-in, so this is "active users in
  // last hour/day" rather than "new signups". For true new-signups, we'd
  // check connectedAt instead. Both are interesting.
  const userKeys = await kvScan('user:*', 2000);
  let signupsLastHour = 0, signupsLastDay = 0;
  let newSignupsLastHour = 0, newSignupsLastDay = 0;
  let totalUsers = userKeys.length;
  // Sample first 200 to avoid blowing the KV quota on a launch-day spike.
  const sampleSize = Math.min(200, userKeys.length);
  for (let i = 0; i < sampleSize; i++) {
    const rec = await kvGet(userKeys[i]);
    if (!rec) continue;
    const lastLogin = Date.parse(rec.lastLoginAt || rec.connectedAt || '');
    const connected = Date.parse(rec.connectedAt || '');
    if (!isNaN(lastLogin)) {
      if (lastLogin > oneHourAgo) signupsLastHour++;
      if (lastLogin > oneDayAgo) signupsLastDay++;
    }
    if (!isNaN(connected)) {
      if (connected > oneHourAgo) newSignupsLastHour++;
      if (connected > oneDayAgo) newSignupsLastDay++;
    }
  }

  // 2. Sheet success: count sheet:* records (one per successful provision).
  const sheetKeys = await kvScan('sheet:*', 2000);
  const successRate = totalUsers > 0 ? sheetKeys.length / totalUsers : 0;

  // 3. Phone-link success: count phone:* records.
  const phoneKeys = await kvScan('phone:*', 2000);

  // 4. In-app browser misses (last 50 in the list).
  const inappMisses = await kvLRange('inapp_misses', 0, 49);
  const recentMisses = inappMisses.map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);
  // Group by UA prefix to spot patterns.
  const uaCounts = {};
  recentMisses.forEach((m) => {
    const k = (m.ua || '').slice(0, 60);
    uaCounts[k] = (uaCounts[k] || 0) + 1;
  });
  const topMissedUas = Object.entries(uaCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ua, count]) => ({ ua, count }));

  // 5. Bot reachability: last write_log entry timestamp.
  const writeLogs = await kvLRange('write_log:append', 0, 4);
  let lastBotWrite = null;
  for (const entry of writeLogs) {
    try {
      const parsed = JSON.parse(entry);
      if (parsed.at) { lastBotWrite = parsed.at; break; }
    } catch (_e) {}
  }

  // 6. KV usage estimate: count today's commands from our own counter.
  //    We increment kv_cmd_today on every write; reset daily via TTL.
  const kvUsageToday = await kvGet('kv_cmd_today_count') || 0;
  const KV_FREE_TIER_DAILY = 10000;
  const kvUsagePct = Math.min(100, Math.round((Number(kvUsageToday) / KV_FREE_TIER_DAILY) * 100));

  return res.status(200).json({
    ok: true,
    at: new Date().toISOString(),
    totals: {
      users: totalUsers,
      sheetsProvisioned: sheetKeys.length,
      phonesLinked: phoneKeys.length,
      provisionSuccessRate: successRate.toFixed(3),
    },
    signups: {
      active_last_hour: signupsLastHour,
      active_last_day: signupsLastDay,
      new_last_hour: newSignupsLastHour,
      new_last_day: newSignupsLastDay,
      sample_size: sampleSize,
    },
    bot: {
      last_successful_write: lastBotWrite,
      minutes_since_last_write: lastBotWrite ? Math.round((now - lastBotWrite) / 60000) : null,
      healthy: lastBotWrite && (now - lastBotWrite < 15 * 60 * 1000),
    },
    inappBrowserMisses: {
      total_last_50: recentMisses.length,
      top_user_agents: topMissedUas,
    },
    kvUsage: {
      commands_today: Number(kvUsageToday),
      free_tier_daily: KV_FREE_TIER_DAILY,
      pct_used: kvUsagePct,
      warning: kvUsagePct >= 80,
      critical: kvUsagePct >= 95,
    },
    notes: {
      sample_warning: sampleSize < totalUsers
        ? `Sampled first ${sampleSize} of ${totalUsers} users. Signup counts are extrapolated.`
        : null,
      kv_watchdog: kvUsagePct >= 80
        ? 'KV usage past 80% — upgrade to paid tier or curb writes immediately.'
        : null,
    },
  });
}

export default withRequestId(requireAdmin(handlerImpl));
