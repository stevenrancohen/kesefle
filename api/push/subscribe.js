// api/push/subscribe.js
//
// CRUD for the current user's Web Push PushSubscription.
//
//   POST   { subscription: { endpoint, keys: { p256dh, auth } }, deviceInfo? }
//          -> { ok: true, stored: true }
//          Persists the subscription at KV key  push_sub:{userSub}.
//
//   GET    -> { ok: true, subscribed: <bool>, matchesDevice: <bool> }
//          Cheap probe used by the dashboard to decide whether to show the
//          "enable notifications" card. An optional endpoint SHA-256 header
//          verifies device ownership without exposing the endpoint itself.
//
//   DELETE -> { ok: true, removed: <bool> }
//          User toggled off / uninstalled. Removes the KV record.
//
// Auth: requireAuth (session cookie or Bearer ID token).
// Rate limit: 120 reads / hour and 10 mutations / hour / userSub. Dashboard
// reconciliation is read-only; subscribing/unsubscribing stays tightly capped.
//
// Storage shape:
//   push_sub:{userSub} = JSON.stringify({
//     subscription: { endpoint, keys: { p256dh, auth }, expirationTime? },
//     deviceInfo:   { ua, lang, tz, addedFrom? },        -- diagnostic only
//     subscribedAt: '<ISO timestamp>',
//   })
//
// One device per user for v1. When a second device subscribes, the second
// overwrites the first -- intentional simplification; future change can
// migrate to push_sub:{userSub}:{deviceId} and an LPUSH/SMEMBERS index.

import { withRequestId, log } from '../../lib/log.js';
import { requireAuth } from '../../lib/auth.js';
import { rateLimitId } from '../../lib/ratelimit.js';
import { isTrustedPushEndpoint } from '../../lib/push-endpoint.js';
import { createHash } from 'node:crypto';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const MAX_ENDPOINT_LEN = 600;
const MAX_DEVICE_INFO_LEN = 400;

function subscriptionKey(userSub) {
  return `push_sub:${userSub}`;
}

// ── KV helpers ──────────────────────────────────────────────────────────────
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, value: null };
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json();
    return { ok: true, value: j?.result ? JSON.parse(j.result) : null };
  } catch (_e) { return { ok: false, value: null }; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) { return false; }
}

async function kvEval(script, keys, args) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, value: null };
  try {
    const command = ['EVAL', script, String(keys.length), ...keys, ...args.map(String)];
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json();
    if (!j || Object.prototype.hasOwnProperty.call(j, 'error') || typeof j.result !== 'string') {
      return { ok: false, value: null };
    }
    return { ok: true, value: j.result };
  } catch (_e) { return { ok: false, value: null }; }
}

async function deleteSubscriptionAtomic(key, requestedEndpoint) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_DELETE_PUSH_SUB_V1
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
if ARGV[1] ~= '' then
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' or type(record.subscription) ~= 'table' then
    return 'invalid_state'
  end
  local storedEndpoint = tostring(record.subscription.endpoint or '')
  if storedEndpoint ~= ARGV[1] then return 'different_device' end
end
redis.call('DEL', KEYS[1])
return 'removed'`;
  return kvEval(script, [key], [requestedEndpoint]);
}

// ── Validation ──────────────────────────────────────────────────────────────
function isValidEndpoint(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.length > MAX_ENDPOINT_LEN) return false;
  return isTrustedPushEndpoint(s);
}

function isValidB64Url(s, minLen, maxLen) {
  if (typeof s !== 'string') return false;
  if (s.length < minLen || s.length > maxLen) return false;
  // base64url alphabet only (no padding).
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// Validates a PushSubscription.toJSON() shape. Returns null on success or an
// error string. The browser-supplied subscription has:
//   { endpoint, expirationTime, keys: { p256dh (88 b64url chars), auth (22 chars) } }
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return 'missing_subscription';
  if (!isValidEndpoint(sub.endpoint)) return 'invalid_endpoint';
  if (!sub.keys || typeof sub.keys !== 'object') return 'missing_keys';
  // p256dh is the raw uncompressed P-256 point (65 bytes) -> 88 base64url chars.
  if (!isValidB64Url(sub.keys.p256dh, 80, 100)) return 'invalid_p256dh';
  // auth is 16 bytes -> 22 base64url chars.
  if (!isValidB64Url(sub.keys.auth, 18, 28)) return 'invalid_auth';
  return null;
}

function sanitizeDeviceInfo(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const k of ['ua', 'lang', 'tz', 'addedFrom']) {
    if (raw[k] != null) out[k] = String(raw[k]).slice(0, MAX_DEVICE_INFO_LEN);
  }
  return out;
}

// ── Handlers ────────────────────────────────────────────────────────────────
async function handleGet(req, res, userSub) {
  const lookup = await kvGet(subscriptionKey(userSub));
  // An outage is not equivalent to "not subscribed": telling the browser to
  // repair on unknown state could destroy a healthy local subscription and
  // then fail to store its replacement.
  if (!lookup.ok) return res.status(502).json({ ok: false, error: 'kv_read_failed' });
  const rec = lookup.value;
  const storedEndpoint = rec?.subscription?.endpoint;
  const subscribed = isTrustedPushEndpoint(storedEndpoint);
  // Compare an authenticated browser to the account record without returning
  // or transmitting the Push endpoint itself. Endpoints are bearer-like
  // secrets; a one-way fingerprint is enough for device ownership repair.
  const suppliedFingerprint = typeof req.headers?.['x-push-endpoint-fingerprint'] === 'string'
    ? req.headers['x-push-endpoint-fingerprint'].toLowerCase()
    : '';
  const validFingerprint = /^[a-f0-9]{64}$/.test(suppliedFingerprint);
  const storedFingerprint = subscribed
    ? createHash('sha256').update(storedEndpoint).digest('hex')
    : '';
  const matchesDevice = validFingerprint && subscribed && suppliedFingerprint === storedFingerprint;
  return res.status(200).json({ ok: true, subscribed, matchesDevice });
}

async function handlePost(req, res, userSub) {
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_not_configured' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const err = validateSubscription(body.subscription);
  if (err) return res.status(400).json({ ok: false, error: err });

  const record = {
    subscription: {
      endpoint: body.subscription.endpoint,
      keys: {
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
      },
      // Preserve expirationTime when present -- some push services hint when
      // a subscription will be auto-rotated. Allows future cleanup heuristics.
      expirationTime: body.subscription.expirationTime ?? null,
    },
    deviceInfo: sanitizeDeviceInfo(body.deviceInfo),
    subscribedAt: new Date().toISOString(),
  };
  const ok = await kvSet(subscriptionKey(userSub), record);
  if (!ok) return res.status(502).json({ ok: false, error: 'kv_write_failed' });

  // NEVER log the endpoint / keys -- they're effectively a per-user secret
  // (anyone with the endpoint + VAPID identity can push to the device).
  log.info('push.subscribe.ok', {
    reqId: req.reqId,
    deviceInfoLen: JSON.stringify(record.deviceInfo).length,
  });
  return res.status(200).json({ ok: true, stored: true });
}

async function handleDelete(req, res, userSub) {
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_not_configured' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (body.endpoint != null && (
    typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > MAX_ENDPOINT_LEN
  )) {
    return res.status(400).json({ ok: false, removed: false, error: 'invalid_endpoint' });
  }
  const requestedEndpoint = body.endpoint || '';
  const key = subscriptionKey(userSub);
  const transition = await deleteSubscriptionAtomic(key, requestedEndpoint);
  if (!transition.ok) {
    return res.status(502).json({ ok: false, removed: false, error: 'kv_delete_failed' });
  }
  if (transition.value === 'missing') {
    return res.status(200).json({ ok: true, removed: false });
  }
  if (transition.value === 'different_device') {
    log.info('push.unsubscribe.different_device', { reqId: req.reqId });
    return res.status(200).json({ ok: true, removed: false, reason: 'different_device' });
  }
  if (transition.value !== 'removed') {
    return res.status(502).json({ ok: false, removed: false, error: 'kv_invalid_state' });
  }
  log.info('push.unsubscribe.ok', { reqId: req.reqId, removed: true });
  return res.status(200).json({ ok: true, removed: true });
}

// ── Wrapped entry point ─────────────────────────────────────────────────────
async function authedHandler(req, res) {
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user' });

  // Rate limit BEFORE method dispatch -- protects against a wedged client
  // hammering POST in a tight loop after a permission denial.
  const isRead = req.method === 'GET';
  const limit = isRead ? 120 : 10;
  const rl = await rateLimitId(userSub, { key: isRead ? 'push_subscribe_read' : 'push_subscribe', limit, windowSec: 3600 });
  res.setHeader('X-RateLimit-Limit', String(limit));
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter || 3600));
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || 3600 });
  }

  if (req.method === 'GET')    return handleGet(req, res, userSub);
  if (req.method === 'POST')   return handlePost(req, res, userSub);
  if (req.method === 'DELETE') return handleDelete(req, res, userSub);

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}

const authedWrapped = requireAuth(authedHandler);

export default withRequestId(async function handlerImpl(req, res) {
  return authedWrapped(req, res);
});
