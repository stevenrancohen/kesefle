// Cross-user global learning store (privacy-preserving).
//
// The Apps Script bot writes directly to Vercel KV using its own kvGet/kvSet
// helpers. This module exists so Vercel-side endpoints (admin dashboards,
// future REST consumers) can read/write the same store without duplicating
// the schema or the hashing logic.
//
// Schema:
//   key:   `global_learn:<sha256-hex-of-normalized-text>`
//   value: { category, subcategory, count, lastSeen }
//
// Privacy: only SHA-256 hashes are stored — the original text never leaves
// the user's bot. Two users typing the same description hit the same hash.

const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function sha256Hex(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || '').toLowerCase().trim(), 'utf8')
    .digest('hex');
}

async function kvCall(method, key, body) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('KV credentials missing');
  }
  const url = `${KV_URL}/${method}/${encodeURIComponent(key)}`;
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`KV ${method} ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return j.result;
}

async function get(text) {
  const hash = sha256Hex(text);
  const raw = await kvCall('get', `global_learn:${hash}`);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function publish(text, category, subcategory) {
  const normalized = String(text || '').toLowerCase().trim();
  if (!normalized || normalized.length < 2) return null;
  const hash = sha256Hex(normalized);
  const existing = await get(normalized).catch(() => null);
  const record = {
    category,
    subcategory: subcategory || category,
    count: (existing && existing.count ? existing.count : 0) + 1,
    lastSeen: Date.now(),
  };
  await kvCall('set', `global_learn:${hash}`, JSON.stringify(record));
  return record;
}

async function remove(text) {
  const hash = sha256Hex(text);
  return kvCall('del', `global_learn:${hash}`);
}

module.exports = { sha256Hex, get, publish, remove };
