// Admin-only stats endpoint. Returns aggregate counts across the Vercel KV
// store so the /admin/monitor.html dashboard can render at-a-glance health.
//
// Auth: header `Authorization: Bearer <token>` where token === ADMIN_TOKEN env
// var. Fails closed if the env var is not configured (503), to prevent any
// pre-set fallback string from acting as a universal admin password.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

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

module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (!KV_URL || !KV_TOKEN) {
    res.status(500).json({ error: 'kv_not_configured' });
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

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
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
    res.status(500).json({ error: 'stats_failed', detail: e.message });
  }
};
