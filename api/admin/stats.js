// Admin-only stats endpoint. Returns aggregate counts across the Vercel KV
// store so the /admin/monitor.html dashboard can render at-a-glance health.
//
// Auth: canonical requireAdmin only — verified Google ID token or HttpOnly
// session cookie, with the verified email matched against ADMIN_EMAILS.
// No parallel shared-secret path is accepted.
//
// Rate limit: 30/min per verified admin.

import { withRequestId } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';
import { withRateLimit } from '../../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvScan(pattern, maxIterations = 50) {
  let cursor = '0';
  let count = 0;
  const samples = [];
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(
      `${KV_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/200`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`KV scan ${res.status}`);
    const j = await res.json();
    const result = j.result || [];
    cursor = String(result[0] || '0');
    const keys = result[1] || [];
    count += keys.length;
    if (samples.length < 5) samples.push(...keys.slice(0, 5 - samples.length));
    if (cursor === '0') break;
  }
  return { count, samples };
}

async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result;
}

// Core handler — runs only after requireAdmin has accepted the request.
async function handlerCore(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ ok: false, error: 'kv_not_configured' });
    return;
  }

  try {
    const [phones, families, premium, globalLearn, tokens, lastPing] = await Promise.all([
      kvScan('phone:of:*'),
      kvScan('family:*'),
      kvScan('sub:*'),
      kvScan('global_learn:*'),
      kvScan('token:*'),
      kvGetRaw('stat:bot_last_ping'),
    ]);

    // Authenticated admin data must never enter a shared CDN/browser cache.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      users: {
        linkedPhones: phones.count,
        signups: tokens.count,
        premium: premium.count,
      },
      families: {
        total: families.count - phones.count, // family:of:* is duplicated under phone:of:* sometimes; rough estimate
      },
      learning: {
        globalEntries: globalLearn.count,
      },
      health: {
        botLastPing: lastPing ? (typeof lastPing === 'string' ? lastPing : JSON.stringify(lastPing)) : null,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'stats_failed', detail: e.message });
  }
}

export default withRequestId(
  requireAdmin(
    withRateLimit({ key: 'admin_stats', limit: 30, windowSec: 60 })(handlerCore)
  )
);
