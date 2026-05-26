// /api/admin/learn-stats
//
// Admin-only observability for the cross-user federated learning system
// (api/learn.js). Today the bot writes global_learn:<sha256> records
// every time a user corrects a categorization, but Steven has no way to
// SEE what's been learned across the userbase.
//
// This endpoint scans the global_learn:* keyspace in KV and returns:
//   - Total entries
//   - Top N by count (most-corrected vendors)
//   - Distribution by category
//   - Consensus stats (how many entries have hit the publish threshold)
//
// Auth: requireAdmin (Google ID token from admin email).
// Cached: 5min KV cache so repeated dashboard refreshes don't re-scan.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CACHE_TTL_SEC = 300;
const CONSENSUS_THRESHOLD = Math.max(1, parseInt(process.env.KESEFLE_LEARN_CONSENSUS_THRESHOLD || '1', 10));

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}

async function kvSet(key, value, ttlSec) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const path = ttlSec ? `/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `/set/${encodeURIComponent(key)}`;
    const r = await fetch(`${KV_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: typeof value === 'string' ? value : JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

// Upstash SCAN — iterates global_learn:* keys in pages of 100. Stops at
// 10k entries to bound runtime (single admin request shouldn't ever
// retrieve more than that).
async function scanAllLearnedKeys() {
  if (!KV_URL || !KV_TOKEN) return [];
  const keys = [];
  let cursor = '0';
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${KV_URL}/scan/${cursor}/match/global_learn:*/count/100`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (!r.ok) break;
      const j = await r.json();
      const result = j?.result;
      if (!result || !Array.isArray(result) || result.length < 2) break;
      cursor = String(result[0]);
      const batch = result[1] || [];
      for (const k of batch) if (typeof k === 'string' && k.startsWith('global_learn:')) keys.push(k);
      if (cursor === '0') break;
      if (keys.length >= 10000) break;
    } catch { break; }
  }
  return keys;
}

async function computeStats() {
  const keys = await scanAllLearnedKeys();
  const entries = [];
  for (const k of keys) {
    const rec = await kvGet(k);
    if (rec && rec.category) {
      entries.push({
        hash: k.slice('global_learn:'.length),
        category: rec.category,
        subcategory: rec.subcategory || '',
        count: Number(rec.count) || 1,
        updatedAt: rec.updatedAt || null,
      });
    }
  }
  const byCategory = {};
  let publishedCount = 0;
  let pendingCount = 0;
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    if (e.count >= CONSENSUS_THRESHOLD) publishedCount++;
    else pendingCount++;
  }
  const top = entries.slice().sort((a, b) => b.count - a.count).slice(0, 50);
  return {
    totalEntries: entries.length,
    publishedCount,
    pendingCount,
    consensusThreshold: CONSENSUS_THRESHOLD,
    byCategory,
    top50ByCount: top,
    generatedAt: new Date().toISOString(),
  };
}

async function handlerImpl(req, res) {
  // Admin auth (Google ID token from ADMIN_EMAILS).
  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return; // requireAdmin already sent 401/403

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Cache 5 min so repeated dashboard refresh doesn't re-scan KV.
  const force = String(req.query?.refresh || '') === '1';
  let stats = null;
  if (!force) {
    stats = await kvGet('cache:learn_stats');
  }
  if (!stats) {
    stats = await computeStats();
    await kvSet('cache:learn_stats', stats, CACHE_TTL_SEC);
  }

  log.info('learn_stats.served', {
    reqId: req.reqId, adminEmail: adminUser.email,
    totalEntries: stats.totalEntries, force,
  });
  return res.status(200).json({ ok: true, stats });
}

export default withRequestId(handlerImpl);
