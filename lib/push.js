// lib/push.js
// =============================================================================
// Web Push sender -- zero npm deps, pure node:crypto.
//
// Implements the encrypted push protocol the browser push services (FCM, Mozilla
// autopush, Apple WebPushd) expect:
//   - RFC 8291: Message Encryption for Web Push
//   - RFC 8188: aes128gcm HTTP content coding
//   - RFC 8292: VAPID -- voluntary application server identification
//
// Why no `web-push` package: Steven's repo runs zero npm dependencies (the
// codebase comment in lib/crypto.js explains the constraint -- Ono College's
// network blocks npm, so everything is vendored). Node 20 ships everything
// needed: ECDH P-256, HKDF-SHA256, AES-128-GCM, ECDSA P-256 (ES256).
//
// Public API:
//   sendPush(userSub, { title, body, icon?, badge?, tag?, url?, ttl? })
//     -> { ok, status, skipped?, reason? }
//
// Env-fail-soft: if VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT_EMAIL
// are missing OR the user has no subscription stored, returns
//   { ok: false, skipped: true, reason: '...' }
// without throwing. Designed so callers in cron paths can fire-and-forget.
//
// On a 404 or 410 from the push service ("gone -- subscription invalid")
// we DELETE the subscription record from KV automatically so the cron stops
// trying to push to a stale endpoint.
// =============================================================================

import crypto from 'node:crypto';
import { log } from './log.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;     // 24h: matches most push services' max
const DEFAULT_URGENCY = 'normal';              // very-low | low | normal | high
const RECORD_SIZE = 4096;                      // RFC 8188 rs; one record covers our payload
const PAD_DELIMITER = 0x02;                    // RFC 8291 last-record delimiter

// -----------------------------------------------------------------------------
// Env / VAPID helpers
// -----------------------------------------------------------------------------

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT_EMAIL);
}

function getVapidKeys() {
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const subj = process.env.VAPID_SUBJECT_EMAIL || '';
  if (!pub || !priv || !subj) throw new Error('vapid_not_configured');
  // Normalize subject to a valid VAPID `sub` claim. Per RFC 8292 it must be
  // a mailto: or https: URL. We accept a bare email and prepend mailto:.
  let sub = subj.trim();
  if (!/^mailto:/i.test(sub) && !/^https?:/i.test(sub)) sub = 'mailto:' + sub;
  return { pub, priv, sub };
}

// -----------------------------------------------------------------------------
// KV helpers (mirror the pattern used by lib/alert.js + api/cron/budget-check.js)
// -----------------------------------------------------------------------------

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return r.ok;
  } catch (_e) { return false; }
}

// -----------------------------------------------------------------------------
// Encoding utilities
// -----------------------------------------------------------------------------

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(s) {
  return Buffer.from(String(s || ''), 'base64url');
}

// Convert a raw uncompressed P-256 point (65 bytes: 0x04 || X || Y) into a
// node:crypto KeyObject so we can use it for ECDH.
function rawP256PointToPublicKey(raw65) {
  if (!Buffer.isBuffer(raw65) || raw65.length !== 65 || raw65[0] !== 0x04) {
    throw new Error('invalid_p256_point');
  }
  const x = raw65.slice(1, 33);
  const y = raw65.slice(33, 65);
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y) },
    format: 'jwk',
  });
}

// Convert the raw 32-byte VAPID private scalar into a node:crypto KeyObject.
// We need the matching public coordinates too so the JWK is well-formed;
// derive them by re-deriving the public point from `d`.
function rawP256ScalarToKeyPair(privScalarB64Url, pubRawB64Url) {
  const x = b64urlDecode(pubRawB64Url).slice(1, 33);
  const y = b64urlDecode(pubRawB64Url).slice(33, 65);
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64urlEncode(x), y: b64urlEncode(y),
      d: privScalarB64Url,
    },
    format: 'jwk',
  });
  const publicKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y) },
    format: 'jwk',
  });
  return { publicKey, privateKey };
}

// Export a P-256 public KeyObject as the 65-byte uncompressed point.
function publicKeyToRawPoint(keyObj) {
  const jwk = keyObj.export({ format: 'jwk' });
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('bad_public_key_export');
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

// -----------------------------------------------------------------------------
// RFC 8291: encrypt the payload for a single PushSubscription.
//
// Output layout (RFC 8188 aes128gcm "Content-Encoding"):
//
//   salt (16) | rs (4, big-endian) | idlen (1) | as_public (65) | aes128gcm ciphertext
//
// Where aes128gcm ciphertext = AES-128-GCM(content_key, content_nonce,
//                                          plaintext || 0x02 || padding_zeros)
//
// Key derivation (HKDF-SHA256):
//   ecdh_secret  = ECDH(as_private, ua_public)      -- 32 bytes
//   auth_secret  = subscription.keys.auth           -- 16 bytes (browser-supplied)
//   ikm          = HKDF(salt=auth_secret, ikm=ecdh_secret,
//                       info="WebPush: info\x00" || ua_public || as_public, len=32)
//   content_key  = HKDF(salt=salt, ikm=ikm,
//                       info="Content-Encoding: aes128gcm\x00", len=16)
//   content_nonce= HKDF(salt=salt, ikm=ikm,
//                       info="Content-Encoding: nonce\x00", len=12)
// -----------------------------------------------------------------------------

function encryptPayloadForSubscription(plaintextBuf, subscription) {
  const uaPubRaw = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  if (uaPubRaw.length !== 65) throw new Error('bad_p256dh_length');
  if (authSecret.length !== 16) throw new Error('bad_auth_length');

  const uaPub = rawP256PointToPublicKey(uaPubRaw);

  // Fresh ephemeral keypair for THIS push (RFC 8291: never reuse).
  const asKp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const asPubRaw = publicKeyToRawPoint(asKp.publicKey);

  // ECDH shared secret.
  const ecdhSecret = crypto.diffieHellman({ privateKey: asKp.privateKey, publicKey: uaPub });

  // Salt: 16 random bytes per RFC 8188 (kept in the record header).
  const salt = crypto.randomBytes(16);

  // ikm = HKDF(auth_secret, ecdh_secret, "WebPush: info" + 0x00 + ua_pub + as_pub, 32)
  const infoIkm = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPubRaw,
    asPubRaw,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, infoIkm, 32));

  // content_key + content_nonce derived from salt + ikm with fixed labels.
  const cek = Buffer.from(crypto.hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16,
  ));
  const nonce = Buffer.from(crypto.hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12,
  ));

  // RFC 8291 padding: plaintext || 0x02 || zero-bytes. The 0x02 marks the last
  // record; subsequent zero bytes are padding within the same record. We use
  // ZERO padding bytes here (single-record message). Total record body must be
  // <= rs - 16 (auth tag occupies the rest).
  const padded = Buffer.concat([plaintextBuf, Buffer.from([PAD_DELIMITER])]);
  const maxBody = RECORD_SIZE - 16; // 16 = AES-GCM tag length
  if (padded.length > maxBody) {
    throw new Error('payload_too_large_for_record_size');
  }

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header per RFC 8188:
  //   salt (16) | rs (4 BE) | idlen (1) | keyid (idlen) | aes128gcm-record
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([
    salt,
    rsBuf,
    Buffer.from([asPubRaw.length]), // idlen
    asPubRaw,                        // keyid = sender ephemeral pubkey
  ]);
  return Buffer.concat([header, ct, tag]);
}

// -----------------------------------------------------------------------------
// RFC 8292: sign a VAPID JWT (ES256) so the push service can identify us.
//
// JWT header: { "alg": "ES256", "typ": "JWT" }
// Claims    : { "aud": "<scheme>://<host>", "exp": now+12h, "sub": "mailto:..." }
// Sent as   : Authorization: vapid t=<jwt>, k=<vapid_public_b64url>
// -----------------------------------------------------------------------------

function buildVapidHeaders(endpointUrl, ttlSec, urgency, topic) {
  const { pub, priv, sub } = getVapidKeys();
  const aud = new URL(endpointUrl).origin;

  const header = { alg: 'ES256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const claims = { aud, exp, sub };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const claimsB64 = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  const { privateKey } = rawP256ScalarToKeyPair(priv, pub);
  // ES256 wants the raw r|s (IEEE-P1363) form, not DER -- node returns DER
  // by default for EC signatures, so request ieee-p1363 to skip the conversion.
  const sig = crypto.sign(null, Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${b64urlEncode(sig)}`;

  const headers = {
    'Authorization': `vapid t=${jwt}, k=${pub}`,
    'Content-Encoding': 'aes128gcm',
    'TTL': String(ttlSec),
    'Urgency': urgency,
  };
  if (topic) headers['Topic'] = String(topic).slice(0, 32);
  return headers;
}

// -----------------------------------------------------------------------------
// Subscription storage (KV)
// -----------------------------------------------------------------------------

function subscriptionKey(userSub) {
  return `push_sub:${userSub}`;
}

async function getStoredSubscription(userSub) {
  if (!userSub) return null;
  const rec = await kvGet(subscriptionKey(userSub));
  if (!rec || !rec.subscription || !rec.subscription.endpoint) return null;
  if (!rec.subscription.keys || !rec.subscription.keys.p256dh || !rec.subscription.keys.auth) {
    return null;
  }
  return rec.subscription;
}

async function deleteStoredSubscription(userSub, reason) {
  await kvDel(subscriptionKey(userSub));
  log.info('push.subscription_deleted', { reason });
}

// -----------------------------------------------------------------------------
// PUBLIC: sendPush(userSub, payload)
// -----------------------------------------------------------------------------

// Build the JSON payload that the service worker `push` event handler unpacks.
// Keep the field names short -- after encryption + record framing the message
// counts against the push service's max payload size (FCM is 4096 bytes).
function buildPayloadJson(payload) {
  const safe = {
    title: String(payload?.title || "כספ'לה").slice(0, 80),
    body: String(payload?.body || '').slice(0, 240),
  };
  if (payload?.icon) safe.icon = String(payload.icon).slice(0, 200);
  if (payload?.badge) safe.badge = String(payload.badge).slice(0, 200);
  if (payload?.tag) safe.tag = String(payload.tag).slice(0, 64);
  if (payload?.url) safe.url = String(payload.url).slice(0, 400);
  return JSON.stringify(safe);
}

export async function sendPush(userSub, payload) {
  // 1. Env / config gate -- never throw on missing keys.
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  if (!KV_URL || !KV_TOKEN) {
    return { ok: false, skipped: true, reason: 'kv_not_configured' };
  }
  if (!userSub) return { ok: false, skipped: true, reason: 'missing_user_sub' };

  // 2. Load the stored subscription. Bail soft if the user never opted in.
  const subscription = await getStoredSubscription(userSub);
  if (!subscription) {
    return { ok: false, skipped: true, reason: 'no_subscription' };
  }

  // 3. Encrypt the JSON payload for THIS subscription's keys.
  let encrypted;
  try {
    const json = buildPayloadJson(payload);
    encrypted = encryptPayloadForSubscription(Buffer.from(json, 'utf8'), subscription);
  } catch (e) {
    log.warn('push.encrypt_failed', { error: e.message });
    return { ok: false, error: 'encrypt_failed', detail: e.message };
  }

  // 4. Build VAPID auth header + post to the push service endpoint.
  const ttlSec = Number.isFinite(payload?.ttl) ? Math.max(0, Math.min(2419200, payload.ttl | 0)) : DEFAULT_TTL_SECONDS;
  const urgency = payload?.urgency || DEFAULT_URGENCY;
  let headers;
  try {
    headers = buildVapidHeaders(subscription.endpoint, ttlSec, urgency, payload?.topic);
  } catch (e) {
    return { ok: false, error: 'vapid_header_failed', detail: e.message };
  }

  let resp;
  try {
    resp = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body: encrypted,
    });
  } catch (e) {
    log.warn('push.network_error', { error: e.message });
    return { ok: false, error: 'network_error', detail: e.message };
  }

  // 201 (Created) / 202 (Accepted) are the success codes per RFC 8030 / 8291.
  // 404 / 410 -- subscription is permanently invalid; clean it up so the next
  // cron doesn't waste a call. 413 = payload too large. 429 = backoff. 401/403
  // = our VAPID signature was rejected (clock skew or env wrong).
  if (resp.status === 201 || resp.status === 202 || resp.status === 200) {
    return { ok: true, status: resp.status };
  }
  if (resp.status === 404 || resp.status === 410) {
    await deleteStoredSubscription(userSub, `push_gone_${resp.status}`);
    return { ok: false, status: resp.status, removed: true, reason: 'subscription_gone' };
  }
  // Any other status: log + return -- caller decides what to do.
  let detail = '';
  try { detail = (await resp.text()).slice(0, 200); } catch (_) {}
  log.warn('push.send_failed', { status: resp.status, detail });
  return { ok: false, status: resp.status, detail };
}

// -----------------------------------------------------------------------------
// Health probe (used by /api/admin/health-deep + future debug)
// -----------------------------------------------------------------------------

export function pushHealth() {
  return {
    configured: isConfigured(),
    vapid_public_present: !!process.env.VAPID_PUBLIC_KEY,
    vapid_private_present: !!process.env.VAPID_PRIVATE_KEY,
    vapid_subject_present: !!process.env.VAPID_SUBJECT_EMAIL,
    kv_configured: !!(KV_URL && KV_TOKEN),
  };
}
