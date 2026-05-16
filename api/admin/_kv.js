// api/admin/_kv.js
// Internal helper for admin endpoints — wraps Upstash REST KV calls used across
// the admin suite (SCAN, MGET, GET, SET, DEL).
//
// We deliberately keep this module local to /api/admin/ rather than promoting it
// to /lib/ because:
//   1. It exposes SCAN — a privileged operation we don't want callable from
//      user-facing endpoints.
//   2. It bypasses the secure-kv envelope/validation layer on purpose: admins
//      need to read raw records (e.g. to inspect a broken envelope), so we don't
//      route through saveUser/getUser which strip + re-encode.
//
// Fail-mode: every call returns a structured { ok, ... } object. Callers should
// check `result.ok` and surface 503 on KV outage rather than swallow errors.

import { log } from '../../lib/log.js';

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOK = () => process.env.KV_REST_API_TOKEN;

export function kvConfigured() {
  return !!(KV_URL() && KV_TOK());
}

async function kvFetch(path, init = {}) {
  if (!kvConfigured()) return { ok: false, kvDisabled: true };
  const url = `${KV_URL()}${path}`;
  const headers = {
    'Authorization': `Bearer ${KV_TOK()}`,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  };
  try {
    const r = await fetch(url, { ...init, headers });
    let j = null;
    try { j = await r.json(); } catch { /* empty body OK */ }
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) {
    return { ok: false, networkError: e.message };
  }
}

/**
 * Cursor-based SCAN over KV keys matching a glob pattern.
 * Upstash REST: GET /scan/<cursor>?match=<pattern>&count=<n>
 * Response shape: { result: [cursor, [keys...]] }
 *
 * @param {object} opts
 * @param {string} opts.match - glob pattern like "user:*" or "audit:*"
 * @param {number} [opts.count=100] - hint to KV for how many to return per page
 * @param {number} [opts.maxKeys=1000] - safety cap on total keys returned
 * @param {string} [opts.cursor='0'] - resume from a previous cursor
 * @returns {Promise<{ok, keys, nextCursor, error?}>}
 */
export async function kvScan({ match, count = 100, maxKeys = 1000, cursor = '0' }) {
  if (!kvConfigured()) return { ok: false, error: 'kv_unconfigured', keys: [] };
  const keys = [];
  let nextCursor = cursor;
  let iterations = 0;
  const maxIterations = 50; // hard cap to avoid runaway loops

  while (iterations < maxIterations) {
    iterations++;
    const params = new URLSearchParams();
    if (match) params.set('match', match);
    if (count) params.set('count', String(count));
    const path = `/scan/${encodeURIComponent(nextCursor)}?${params.toString()}`;
    const r = await kvFetch(path);
    if (!r.ok) {
      log.warn('admin.kvScan_failed', { match, status: r.status, networkError: r.networkError });
      return { ok: false, error: 'kv_scan_failed', keys, status: r.status };
    }
    const result = r.json?.result;
    if (!Array.isArray(result) || result.length < 2) {
      return { ok: false, error: 'kv_scan_bad_shape', keys };
    }
    nextCursor = String(result[0]);
    const batch = Array.isArray(result[1]) ? result[1] : [];
    for (const k of batch) {
      if (keys.length >= maxKeys) {
        return { ok: true, keys, nextCursor, truncated: true };
      }
      keys.push(k);
    }
    // cursor "0" means we've completed a full pass
    if (nextCursor === '0') return { ok: true, keys, nextCursor: '0' };
  }
  return { ok: true, keys, nextCursor, truncated: true };
}

/**
 * Batch-get multiple keys. Upstash REST exposes MGET via POST /mget with
 * a JSON body of key strings, but for portability we just GET them in parallel
 * with a small concurrency cap.
 */
export async function kvMGet(keys, { concurrency = 10 } = {}) {
  if (!kvConfigured()) return { ok: false, values: [] };
  if (!Array.isArray(keys) || !keys.length) return { ok: true, values: [] };
  const out = new Array(keys.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < keys.length) {
      const i = idx++;
      const r = await kvFetch(`/get/${encodeURIComponent(keys[i])}`);
      if (r.ok && r.json?.result) {
        try { out[i] = JSON.parse(r.json.result); }
        catch { out[i] = r.json.result; }
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, worker);
  await Promise.all(workers);
  return { ok: true, values: out };
}

export async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok || !r.json?.result) return null;
  try { return JSON.parse(r.json.result); } catch { return r.json.result; }
}

export async function kvSet(key, value, { ttlSec } = {}) {
  let path = `/set/${encodeURIComponent(key)}`;
  if (ttlSec) path += `?EX=${ttlSec}`;
  return kvFetch(path, { method: 'POST', body: JSON.stringify(value) });
}

export async function kvDel(key) {
  return kvFetch(`/del/${encodeURIComponent(key)}`, { method: 'POST' });
}

/**
 * Strip sensitive fields from a user record before returning to admin UI.
 * We never send refreshToken / accessToken across the wire even to admins —
 * the only operation that should ever touch those is the server-side
 * "force_resync" which calls Google APIs directly.
 */
export function sanitizeUser(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  delete out.refreshToken;
  delete out.accessToken;
  delete out.accessTokenExpiresAt;
  // Wrapped envelopes from secure-kv look like { _enc: '...', _binding: '...' }
  // — replace with a marker so admin UI can see "encrypted, present" without
  // exposing ciphertext.
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v && typeof v === 'object' && typeof v._enc === 'string' && typeof v._binding === 'string') {
      out[k] = `[encrypted:${v._binding}:${v._enc.length}b]`;
    }
  }
  return out;
}

/**
 * Standardized 503 helper for KV outages. Admin endpoints prefer this over
 * fail-open because the UI needs to know the data is stale, not silently empty.
 */
export function kvOutage(res, reqId, detail) {
  return res.status(503).json({
    ok: false,
    error: 'kv_unavailable',
    detail: detail || 'KV store is unreachable. Try again shortly.',
    reqId,
  });
}
