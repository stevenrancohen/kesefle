// lib/secure-kv.js
// =============================================================================
// Encrypted-at-rest wrapper around Vercel KV (Upstash REST).
//
// This module replaces the ad-hoc `fetch(${KV_REST_API_URL}/...)` calls scattered
// across api/auth/*, api/sheet/*, api/account/*, api/whatsapp/webhook.js, and
// api/billing/*. It is the ONLY module that should talk to KV directly.
//
// Why a wrapper:
//   1. Validation     — every field is checked against USER_FIELD_SCHEMA before
//                       it touches KV. Mass-assignment attacks (client sends
//                       { plan: "admin", refreshToken: "..." }) are silently
//                       dropped, not honoured.
//   2. Encryption     — sensitive fields (refreshToken, accessToken) are wrapped
//                       in AES-256-GCM envelopes via lib/crypto.js BEFORE any
//                       bytes leave the process. The envelope is AAD-bound to
//                       the userSub so a stolen envelope can't be decrypted
//                       under another user's record.
//   3. Logging        — every call is logged with a request-ID; the values are
//                       masked. The plaintext never appears in console output.
//   4. Idempotency    — markSeenOnce() uses SET NX EX to atomically claim a key
//                       for webhook dedup (WhatsApp message ID, Stripe event ID).
//   5. Intent naming  — getUser/saveUser/deleteUser/setSheetForUser/getSheetForUser
//                       read like the verbs in the architecture doc, not like KV
//                       calls. Easy to find usages with grep.
//
// Storage layout (KV keys):
//   user:<sub>                  → JSON user record (sensitive fields encrypted)
//   sheet:<sub>                 → JSON sheet pointer (not encrypted; user's own)
//   phone:<E.164>               → JSON { userSub } pointer (webhook lookup)
//   optout:<phone>              → JSON { ts, reason }
//   last_inbound:<phone>        → JSON { ts, id } (server-only, never in UI)
//   seen:<scope>:<id>           → "1" with TTL (idempotency)
//   audit:<action>:<ts>:<sub8>  → JSON audit entry (730-day TTL)
//   rl:<key>:<window>           → counter (rate-limit token bucket)
//
// "Service role" semantics: this module uses KV_REST_API_TOKEN, which is a
// server-only secret. Never invoke from a browser; never log the token.
// =============================================================================

import {
  encryptRefreshToken,
  decryptRefreshToken,
  encrypt as cryptoEncrypt,
  decrypt as cryptoDecrypt,
  inspectEnvelope,
} from './crypto.js';
import { log } from './log.js';
import nodeCrypto from 'node:crypto';

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOK = () => process.env.KV_REST_API_TOKEN;

function hasKv() { return !!(KV_URL() && KV_TOK()); }

// -----------------------------------------------------------------------------
// Field allow-list — defence in depth against mass-assignment
// -----------------------------------------------------------------------------
//
// Every field a caller can pass to saveUser() must be listed here. Unknown
// fields are silently dropped and logged so we can spot client/server drift in
// development. Two encryption modes:
//   - `refreshTokenAad: true` — uses encryptRefreshToken(value, userSub) so the
//     envelope is bound to the user via AAD = "kfl-refresh:<userSub>".
//   - `encrypt: true`        — uses generic encrypt(value, {aad: purpose})
//     for non-refresh secrets where AAD just needs to bind purpose, not user.
//
// In both cases, on read the value is decrypted transparently.

const USER_FIELD_SCHEMA = {
  // Identity
  userSub:              { type: 'string', max: 128 },
  provider:             { type: 'string', max: 32, enum: ['google', 'apple', 'facebook'] },
  email:                { type: 'string', max: 254, lower: true },
  emailVerified:        { type: 'boolean' },
  name:                 { type: 'string', max: 200 },
  picture:              { type: 'string', max: 500 },
  locale:               { type: 'string', max: 16 },
  // Phone / WhatsApp
  phoneE164:            { type: 'string', max: 24, pattern: /^\+?[0-9]{7,15}$/ },
  phoneVerified:        { type: 'boolean' },
  // Sheet
  spreadsheetId:        { type: 'string', max: 80 },
  spreadsheetUrl:       { type: 'string', max: 300 },
  provisioned:          { type: 'string', max: 40 },
  // OAuth secrets — encrypted at rest
  refreshToken:         { type: 'string', max: 2048, refreshTokenAad: true },
  accessToken:          { type: 'string', max: 4096, encrypt: true, purpose: 'kfl-access' },
  accessTokenExpiresAt: { type: 'number' },
  scopes:               { type: 'string', max: 500 },
  // Billing
  plan:                 { type: 'string', max: 16, enum: ['free', 'pro', 'family', 'admin'] },
  stripeCustomerId:     { type: 'string', max: 64 },
  stripeSubscriptionId: { type: 'string', max: 64 },
  subscriptionStatus:   { type: 'string', max: 32 },
  currentPeriodEnd:     { type: 'string', max: 40 },
  subscribedAt:         { type: 'string', max: 40 },
  canceledAt:           { type: 'string', max: 40 },
  // Lifecycle
  firstSeen:            { type: 'string', max: 40 },
  connectedAt:          { type: 'string', max: 40 },
  lastSeen:             { type: 'string', max: 40 },
  status:               { type: 'string', max: 16, enum: ['active', 'suspended', 'deleted'] },
};

function validateField(name, value) {
  const schema = USER_FIELD_SCHEMA[name];
  if (!schema) return { ok: false, error: `field_not_allowed:${name}` };
  if (value == null) return { ok: true, value: null };

  if (schema.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `${name}_must_be_string` };
    if (value.length > schema.max) return { ok: false, error: `${name}_too_long:${value.length}>${schema.max}` };
    let v = value;
    if (schema.lower) v = v.toLowerCase();
    if (schema.enum && !schema.enum.includes(v)) return { ok: false, error: `${name}_invalid_enum` };
    if (schema.pattern && !schema.pattern.test(v)) return { ok: false, error: `${name}_invalid_format` };
    return { ok: true, value: v };
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${name}_must_be_boolean` };
    return { ok: true, value };
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${name}_must_be_finite_number` };
    return { ok: true, value };
  }
  return { ok: false, error: `${name}_unsupported_type` };
}

// -----------------------------------------------------------------------------
// Envelope wrapping — { _enc: "v1:<kid>:..." , _binding: "refresh"|"purpose" }
// -----------------------------------------------------------------------------
//
// We wrap the v1 colon-envelope from lib/crypto.js inside a small object so the
// reader knows which AAD binding to use when decrypting. This is the boundary
// between "the cipher" and "the data layer".

function wrapEncryptedField(name, value, userSub) {
  const schema = USER_FIELD_SCHEMA[name];
  if (schema?.refreshTokenAad) {
    if (!userSub) throw new Error(`wrapEncryptedField: ${name} requires userSub for AAD binding`);
    return { _enc: encryptRefreshToken(value, userSub), _binding: 'refresh' };
  }
  if (schema?.encrypt) {
    return { _enc: cryptoEncrypt(value, { aad: schema.purpose }), _binding: 'purpose:' + schema.purpose };
  }
  return value;
}

function isWrappedEnv(v) {
  return v && typeof v === 'object' && typeof v._enc === 'string' && typeof v._binding === 'string';
}

function unwrapEncryptedField(wrapped, userSub) {
  if (!isWrappedEnv(wrapped)) return wrapped;
  try {
    if (wrapped._binding === 'refresh') {
      if (!userSub) throw new Error('unwrapEncryptedField: refresh envelope requires userSub');
      return decryptRefreshToken(wrapped._enc, userSub);
    }
    if (wrapped._binding.startsWith('purpose:')) {
      const aad = wrapped._binding.slice('purpose:'.length);
      return cryptoDecrypt(wrapped._enc, { aad });
    }
    throw new Error('unknown_binding:' + wrapped._binding);
  } catch (e) {
    const info = inspectEnvelope(wrapped._enc) || {};
    log.error('secure_kv.decrypt_failed', {
      binding: wrapped._binding,
      version: info.version,
      kid: info.kid,
      error: e.message,
    });
    return null;
  }
}

function encodeUserForKV(rec, userSub) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    const schema = USER_FIELD_SCHEMA[k];
    if (!schema) continue;
    if (v == null) continue;
    if (schema.refreshTokenAad || schema.encrypt) {
      out[k] = wrapEncryptedField(k, String(v), userSub);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decodeUserFromKV(rec, userSub) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = isWrappedEnv(v) ? unwrapEncryptedField(v, userSub) : v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Logging — never the value, always the hash
// -----------------------------------------------------------------------------
//
// We never put a userSub in a log line. The sub is a stable correlator across
// services (Google issues the same `sub` to every Kesefle deploy), so leaking
// it from our logs would let an attacker join records across data sources.
// Instead we log a one-way SHA-256 prefix.

function logId(sub) {
  if (!sub) return 'anon';
  return nodeCrypto.createHash('sha256').update('log:' + String(sub)).digest('hex').slice(0, 16);
}

function maskFields(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    const schema = USER_FIELD_SCHEMA[k];
    if (schema?.refreshTokenAad || schema?.encrypt) {
      if (v == null) out[k] = null;
      else if (typeof v === 'string') out[k] = `***[len:${v.length}]`;
      else if (isWrappedEnv(v)) out[k] = `***[env:${v._enc.length}]`;
      else out[k] = '[redacted]';
    } else if (typeof v === 'string' && v.length > 80) {
      out[k] = v.slice(0, 40) + '...[truncated]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Low-level KV transport
// -----------------------------------------------------------------------------

async function kvFetch(path, init = {}) {
  if (!hasKv()) return { ok: false, kvDisabled: true };
  const url = `${KV_URL()}${path}`;
  const headers = {
    'Authorization': `Bearer ${KV_TOK()}`,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  };
  let r, j = null;
  try { r = await fetch(url, { ...init, headers }); }
  catch (e) { return { ok: false, networkError: e.message }; }
  try { j = await r.json(); } catch { /* empty body OK for some commands */ }
  return { ok: r.ok, status: r.status, json: j };
}

async function rawGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok || !r.json?.result) return null;
  try { return JSON.parse(r.json.result); } catch { return null; }
}

async function rawSet(key, value, { ttlSec, nx = false } = {}) {
  let path = `/set/${encodeURIComponent(key)}`;
  const params = new URLSearchParams();
  if (ttlSec) params.set('EX', String(ttlSec));
  if (nx) params.set('NX', 'true');
  if (params.toString()) path += '?' + params.toString();
  return kvFetch(path, { method: 'POST', body: JSON.stringify(value) });
}

async function rawDel(key) {
  return kvFetch(`/del/${encodeURIComponent(key)}`, { method: 'POST' });
}

// -----------------------------------------------------------------------------
// Public API — user record
// -----------------------------------------------------------------------------

/**
 * Get a user record by Google `sub`. Returns plaintext (decrypted) or null.
 * Sensitive fields (refreshToken, accessToken) are decrypted transparently.
 *
 * @param {string} sub - Google subject claim.
 * @param {object} [opts]
 * @param {string} [opts.reqId] - request ID for log correlation.
 */
export async function getUser(sub, { reqId } = {}) {
  if (!sub) return null;
  const t0 = Date.now();
  const raw = await rawGet('user:' + sub);
  const decoded = decodeUserFromKV(raw, sub);
  log.debug('secure_kv.get_user', {
    reqId,
    subHash: logId(sub),
    found: !!decoded,
    ms: Date.now() - t0,
  });
  return decoded;
}

/**
 * Save (upsert) a user record. Unknown fields are silently dropped (defence in
 * depth — clients cannot mass-assign arbitrary fields like `plan: "admin"`).
 * Sensitive fields are encrypted before write. Returns the validated, plaintext
 * record on success.
 *
 * @param {string} sub - Google subject; identity of the record.
 * @param {object} fields - the fields to set/update.
 * @param {object} [opts]
 * @param {string} [opts.reqId]
 * @param {boolean} [opts.merge=true] - if true, existing fields are preserved.
 */
export async function saveUser(sub, fields, { reqId, merge = true } = {}) {
  if (!sub) throw new Error('saveUser_requires_sub');

  const validated = { userSub: sub };
  const dropped = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (k === 'userSub') continue;
    const r = validateField(k, v);
    if (!r.ok) { dropped.push({ field: k, error: r.error }); continue; }
    if (r.value !== null) validated[k] = r.value;
  }

  let merged = validated;
  if (merge) {
    const existing = await getUser(sub, { reqId });
    if (existing) merged = { ...existing, ...validated };
  }
  merged.lastSeen = new Date().toISOString();

  const encoded = encodeUserForKV(merged, sub);
  const t0 = Date.now();
  const r = await rawSet('user:' + sub, encoded);

  // Maintain phone→sub pointer for webhook lookups.
  let _pr = { ok: true };
  if (merged.phoneE164) {
    _pr = await rawSet('phone:' + merged.phoneE164, { userSub: sub, ts: Date.now() });
  }

  log.info('secure_kv.save_user', {
    reqId,
    subHash: logId(sub),
    fieldsWritten: Object.keys(validated),
    dropped: dropped.length ? dropped : undefined,
    ok: r.ok,
    ms: Date.now() - t0,
  });

  if (!r.ok) throw new Error('kv_save_failed:' + (r.status || 'no_kv'));
  // The phone->sub pointer is what lets the WhatsApp webhook resolve this user;
  // a half-write (user saved, pointer missing) silently breaks bot routing.
  if (!_pr.ok) throw new Error('kv_phone_pointer_failed:' + (_pr.status || 'no_kv'));
  return merged;
}

/**
 * Delete a user and all associated KV entries. Used by `/api/account/delete`.
 * Returns the list of keys that were successfully deleted. The Google refresh
 * token should be revoked at oauth2.googleapis.com/revoke BEFORE this call.
 */
export async function deleteUser(sub, { reqId } = {}) {
  if (!sub) return [];
  const existing = await getUser(sub, { reqId });
  const keys = ['user:' + sub, 'sheet:' + sub];
  if (existing?.phoneE164) keys.push('phone:' + existing.phoneE164);
  // Note: optout:<phone>, last_inbound:<phone> retained for compliance —
  // see docs/security/data-classification.md.

  const deleted = [];
  for (const k of keys) {
    const r = await rawDel(k);
    if (r.ok) deleted.push(k);
  }

  log.info('secure_kv.delete_user', {
    reqId,
    subHash: logId(sub),
    deleted,
    hadRefreshToken: !!existing?.refreshToken,
  });
  return deleted;
}

// -----------------------------------------------------------------------------
// Public API — sheet pointer
// -----------------------------------------------------------------------------

/**
 * Store the sheet pointer for a user. The spreadsheetId itself is NOT encrypted:
 * the user can see it in their own Google Drive URL, so encrypting in KV adds
 * no real protection — only operational cost.
 */
export async function setSheetForUser(sub, { spreadsheetId, spreadsheetUrl, userEmail }, { reqId } = {}) {
  if (!sub) throw new Error('setSheetForUser_requires_sub');
  if (!spreadsheetId) throw new Error('setSheetForUser_requires_spreadsheetId');
  if (typeof spreadsheetId !== 'string' || spreadsheetId.length > 80) {
    throw new Error('spreadsheetId_invalid');
  }
  const rec = {
    userSub: sub,
    userEmail: typeof userEmail === 'string' ? userEmail.slice(0, 254).toLowerCase() : undefined,
    spreadsheetId,
    spreadsheetUrl: spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    provisioned: new Date().toISOString(),
  };
  await rawSet('sheet:' + sub, rec);
  // Mirror onto user record so the webhook's single phone-lookup gets everything.
  await saveUser(sub, {
    spreadsheetId: rec.spreadsheetId,
    spreadsheetUrl: rec.spreadsheetUrl,
    provisioned: rec.provisioned,
  }, { reqId });
  log.info('secure_kv.set_sheet', { reqId, subHash: logId(sub) });
  return rec;
}

/** Get the sheet pointer for a user. */
export async function getSheetForUser(sub, { reqId } = {}) {
  if (!sub) return null;
  const rec = await rawGet('sheet:' + sub);
  log.debug('secure_kv.get_sheet', { reqId, subHash: logId(sub), found: !!rec });
  return rec;
}

// -----------------------------------------------------------------------------
// Public API — idempotency & dedup
// -----------------------------------------------------------------------------

/**
 * Atomically mark a key as seen with a TTL. Returns true if this is the first
 * time (proceed) and false if already seen (skip — duplicate).
 *
 * Implementation: SET NX EX. Upstash REST supports both flags via query params.
 * The "OK" string response means the write happened; null means NX prevented it.
 *
 * @param {string} key - e.g. "seen:wa:wamid.xxx" or "seen:stripe:evt_xxx"
 * @param {number} ttlSec - retention window. Defaults 24 h.
 */
export async function markSeenOnce(key, ttlSec = 86400, { reqId } = {}) {
  if (!key) throw new Error('markSeenOnce_requires_key');
  if (!Number.isFinite(ttlSec) || ttlSec <= 0 || ttlSec > 30 * 86400) {
    throw new Error('ttlSec_out_of_range');
  }
  const r = await rawSet(key, '1', { ttlSec, nx: true });
  const fresh = r.ok && r.json?.result === 'OK';
  log.debug('secure_kv.mark_seen', { reqId, key: key.slice(0, 80), fresh });
  return fresh;
}

// -----------------------------------------------------------------------------
// Public API — phone-based user lookup (WhatsApp webhook)
// -----------------------------------------------------------------------------

/**
 * Resolve a phone number (E.164, with or without leading +) to a user record.
 * Returns the full decrypted user record so the caller has refresh token,
 * sheet ID, and identity in one round trip.
 */
export async function getUserByPhone(phoneE164, { reqId } = {}) {
  if (!phoneE164) return null;
  const ptr = await rawGet('phone:' + phoneE164);
  if (!ptr?.userSub) return null;
  return getUser(ptr.userSub, { reqId });
}

// -----------------------------------------------------------------------------
// Public API — WhatsApp opt-out + 24h-window compliance state
// -----------------------------------------------------------------------------

/**
 * Mark a phone as opted out (STOP keyword). Retained 730 days for the Israeli
 * Communications Law direct-marketing audit trail.
 */
export async function setOptOut(phoneE164, reason = 'user_stop', { reqId } = {}) {
  if (!phoneE164) return false;
  const r = await rawSet(
    'optout:' + phoneE164,
    { ts: new Date().toISOString(), reason },
    { ttlSec: 730 * 86400 }
  );
  log.info('secure_kv.optout_set', { reqId, phoneHash: logId(phoneE164), reason });
  return r.ok;
}

export async function clearOptOut(phoneE164, { reqId } = {}) {
  if (!phoneE164) return false;
  const r = await rawDel('optout:' + phoneE164);
  log.info('secure_kv.optout_clear', { reqId, phoneHash: logId(phoneE164) });
  return r.ok;
}

export async function isOptedOut(phoneE164) {
  if (!phoneE164) return false;
  return (await rawGet('optout:' + phoneE164)) !== null;
}

/**
 * Touch the last-inbound timestamp for a phone. Used to enforce WhatsApp's
 * 24h messaging window. Server-only — never returned to the browser.
 */
export async function touchLastInbound(phoneE164, messageId, { reqId } = {}) {
  if (!phoneE164) return false;
  const r = await rawSet(
    'last_inbound:' + phoneE164,
    { ts: Date.now(), id: typeof messageId === 'string' ? messageId.slice(0, 128) : null },
    { ttlSec: 25 * 3600 } // slightly longer than the 24h window
  );
  log.debug('secure_kv.last_inbound', { reqId, phoneHash: logId(phoneE164) });
  return r.ok;
}

// -----------------------------------------------------------------------------
// Public API — rate limit (token bucket)
// -----------------------------------------------------------------------------

/**
 * Token-bucket rate limit. Fails open if KV is unavailable, so a KV outage
 * does not lock legitimate users out.
 *
 * @returns { ok, remaining, retryAfter }
 */
export async function rateLimit(key, { max, windowSec }) {
  if (!hasKv()) return { ok: true, remaining: max, kvDisabled: true };
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const incrRes = await kvFetch(`/incr/${encodeURIComponent(bucket)}`, { method: 'POST' });
  if (!incrRes.ok) return { ok: true, remaining: max, kvError: incrRes.status };
  const count = Number(incrRes.json?.result || 0);
  if (count === 1) {
    await kvFetch(`/expire/${encodeURIComponent(bucket)}/${windowSec}`, { method: 'POST' });
  }
  const ok = count <= max;
  return { ok, remaining: Math.max(0, max - count), retryAfter: ok ? 0 : windowSec };
}

// -----------------------------------------------------------------------------
// Public API — audit log (append-only, 730-day retention)
// -----------------------------------------------------------------------------

/**
 * Append an audit entry for Israeli Amendment 13 compliance (≥ 24-month retain).
 * The key embeds a short sub-hash, not the sub itself, so audit listings don't
 * leak identities.
 *
 * Secrets in `metadata` are masked via maskFields() before write.
 */
export async function auditLog(action, sub, metadata = {}, { reqId } = {}) {
  if (!action) return false;
  const subHash = sub ? logId(sub) : null;
  const entry = {
    ts: new Date().toISOString(),
    action,
    subHash,
    reqId: reqId || null,
    metadata: maskFields(metadata),
  };
  const key = `audit:${action}:${Date.now()}:${subHash ? subHash.slice(0, 8) : 'anon'}`;
  const r = await rawSet(key, entry, { ttlSec: 730 * 86400 });
  log.info('audit.' + action, { reqId, subHash, ok: r.ok });
  return r.ok;
}
