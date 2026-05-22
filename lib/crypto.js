// lib/crypto.js
// =============================================================================
// Kesefle Cryptography & Secrets Module — production grade, zero npm.
//
// We rely exclusively on `node:crypto` (OpenSSL-backed on Vercel's Node 20):
//   - AES-256-GCM (constant-time, FIPS-approved, AEAD)
//   - HMAC-SHA256 with `crypto.timingSafeEqual`
//   - RSA-SHA256 (RS256) for verifying Google's JWKS-signed ID tokens
//   - `crypto.randomBytes` (CSPRNG — /dev/urandom on Linux)
//
// Ono College's network blocks npm; this module is vendored.
//
// What this protects:
//   1. Refresh tokens in KV    -> encrypt() / decrypt() with versioned envelope
//   2. Cookie tampering / CSRF -> hmacSign / hmacVerify (timing-safe)
//   3. Forged Google identity  -> verifyGoogleIdToken (RS256 + JWKS cache)
//   4. KEK rotation            -> envelope carries key-id (kid); keyring from env
//   5. Log secret leaks        -> redact() helper
//
// Envelope format (per spec, ALL base64url, NO padding, URL/cookie-safe):
//
//     v1:<kid>:<base64-iv>:<base64-tag>:<base64-ciphertext>
//
// Colons chosen because:
//   - Safe inside JSON values, HTTP headers, and base64url payloads
//   - Not URL-encoded by encodeURIComponent (unlike `+` or `/`)
//   - Cleanly tokenizable by a single .split(':')
//
// Why versioned: when KEK rotates we must decrypt old records for the
// lifetime of the longest-lived secret (refresh tokens never expire unless
// revoked). The kid byte selects which KEK from the keyring to use.
// =============================================================================

import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// 0. Constants
// -----------------------------------------------------------------------------

const ENVELOPE_VERSION = 'v1';

// AES-GCM standard sizes (NIST SP 800-38D).
const IV_LEN_BYTES = 12;
const TAG_LEN_BYTES = 16;

// -----------------------------------------------------------------------------
// 1. Keyring — load KEKs from environment
// -----------------------------------------------------------------------------
//
// Primary key:    KESEFLE_DB_KEY              -> kid "cur"
// Rotation keys:  KESEFLE_DB_KEY_<KID>        -> kid "<kid>".toLowerCase()
// Active kid:     KESEFLE_DB_KEY_ACTIVE_KID   (defaults to "cur" or the only key)
//
// Rotation flow:
//   1. Add KESEFLE_DB_KEY_2026A=<new-base64> to Vercel env.
//   2. Set KESEFLE_DB_KEY_ACTIVE_KID=2026A.
//   3. Re-deploy. New encrypt() calls use 2026A; decrypt() of old "cur"
//      envelopes still works.
//   4. Run background rotation job (calls reEncrypt() on every stored record).
//   5. After 14 days (overlap window), remove KESEFLE_DB_KEY from env.
//
// Why we re-read env every 60s: Vercel rotation can swap a secret at runtime
// without a deploy. We must pick up the new key without restarting.
//
// SECURITY NOTE: a misconfigured deploy could load NO keys -> encrypt throws.
// We fail closed. The KESEFLE_CRYPTO_SELFTEST=1 env var runs a roundtrip at
// import time so misconfigs surface during cold start, not on the first user.

const KEYRING_CACHE = { keys: null, activeKid: null, loadedAt: 0 };
const KEYRING_TTL_MS = 60_000;

function decodeKeyMaterial(b64, envName) {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error(`crypto: ${envName} is empty`);
  }
  // Accept either base64 or base64url; pad to multiple of 4.
  const normalized = b64.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  if (buf.length !== 32) {
    throw new Error(`crypto: ${envName} must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

function loadKeyring() {
  const now = Date.now();
  if (KEYRING_CACHE.keys && (now - KEYRING_CACHE.loadedAt) < KEYRING_TTL_MS) {
    return KEYRING_CACHE;
  }

  const keys = new Map();

  // Unversioned primary key.
  if (process.env.KESEFLE_DB_KEY) {
    keys.set('cur', decodeKeyMaterial(process.env.KESEFLE_DB_KEY, 'KESEFLE_DB_KEY'));
  }

  // Versioned rotation keys.
  for (const [name, value] of Object.entries(process.env)) {
    const m = name.match(/^KESEFLE_DB_KEY_([A-Z0-9]+)$/);
    if (!m) continue;
    if (m[1] === 'ACTIVE') continue; // that's the kid pointer, not a key
    const kid = m[1].toLowerCase();
    keys.set(kid, decodeKeyMaterial(value, name));
  }

  if (keys.size === 0) {
    throw new Error('crypto: no KEK configured (set KESEFLE_DB_KEY or KESEFLE_DB_KEY_<KID>)');
  }

  const explicitActive = (process.env.KESEFLE_DB_KEY_ACTIVE_KID || '').toLowerCase();
  let activeKid = explicitActive
    || (keys.has('cur') ? 'cur' : Array.from(keys.keys())[0]);

  // Resilience: if the explicit active-kid points at a key that ISN'T in the ring
  // (a stray/typo'd KESEFLE_DB_KEY_ACTIVE_KID, or a rotation key that was never
  // added), fall back to a real key instead of failing EVERY signup with
  // token_encryption_unavailable. This is safe: ENCRYPT just uses a valid KEK,
  // and DECRYPT is unaffected because each envelope carries its own kid. We log
  // loudly so the misconfig is visible; only a truly empty ring throws.
  if (!keys.has(activeKid)) {
    const fallback = keys.has('cur') ? 'cur' : Array.from(keys.keys())[0];
    if (fallback) {
      console.error(`crypto: KESEFLE_DB_KEY_ACTIVE_KID="${activeKid}" not in keyring — falling back to "${fallback}". Fix: set KESEFLE_DB_KEY_ACTIVE_KID=${fallback} (or add the missing rotation key).`);
      activeKid = fallback;
    } else {
      throw new Error(`crypto: KESEFLE_DB_KEY_ACTIVE_KID="${activeKid}" not present in keyring`);
    }
  }

  KEYRING_CACHE.keys = keys;
  KEYRING_CACHE.activeKid = activeKid;
  KEYRING_CACHE.loadedAt = now;
  return KEYRING_CACHE;
}

function getKey(kid) {
  const { keys } = loadKeyring();
  const k = keys.get(kid);
  if (!k) {
    throw new Error(`crypto: unknown kid "${kid}" — KEK not in current keyring`);
  }
  return k;
}

function getActiveKid() {
  return loadKeyring().activeKid;
}

// -----------------------------------------------------------------------------
// 2. AES-256-GCM encrypt / decrypt
// -----------------------------------------------------------------------------
//
// AAD (Additional Authenticated Data) is OPTIONAL. When provided it must
// match on decrypt(), otherwise authentication fails. Use it to bind a
// ciphertext to a context (e.g. user-sub) so an attacker who swaps records
// in KV can't decrypt them under another user's identity.

/**
 * Encrypts a UTF-8 string with the active KEK.
 *
 * @param {string} plaintext - the secret to protect.
 * @param {Object} [opts]
 * @param {string} [opts.aad] - additional authenticated data (not encrypted,
 *                              but bound to ciphertext authentication).
 * @returns {string} envelope `v1:<kid>:<iv>:<tag>:<ct>` (all base64url)
 *
 * @example
 *   encrypt('1//0abc123def...')
 *   // -> 'v1:cur:R2VuS2V5SVY:DkN...TAG:LdQz...CIPHER'
 */
export function encrypt(plaintext, opts = {}) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('crypto.encrypt: plaintext must be a string');
  }
  const kid = getActiveKid();
  const key = getKey(kid);
  const iv = crypto.randomBytes(IV_LEN_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (opts.aad) cipher.setAAD(Buffer.from(opts.aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    kid,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join(':');
}

/**
 * Decrypts a versioned envelope produced by encrypt().
 *
 * @param {string} envelope - the `v1:<kid>:<iv>:<tag>:<ct>` string.
 * @param {Object} [opts]
 * @param {string} [opts.aad] - must match the AAD passed at encrypt-time.
 * @returns {string} the original UTF-8 plaintext.
 * @throws on any failure (signature mismatch, unknown kid, malformed envelope).
 */
export function decrypt(envelope, opts = {}) {
  if (typeof envelope !== 'string' || envelope.length === 0) {
    throw new Error('crypto.decrypt: envelope must be a non-empty string');
  }
  const parts = envelope.split(':');
  if (parts.length !== 5) {
    throw new Error('crypto.decrypt: malformed envelope (expected 5 colon-separated parts)');
  }
  const [version, kid, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`crypto.decrypt: unsupported envelope version "${version}"`);
  }
  if (!kid) throw new Error('crypto.decrypt: missing kid');

  const key = getKey(kid);
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ct = Buffer.from(ctB64, 'base64url');
  if (iv.length !== IV_LEN_BYTES) throw new Error('crypto.decrypt: bad IV length');
  if (tag.length !== TAG_LEN_BYTES) throw new Error('crypto.decrypt: bad auth tag length');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (opts.aad) decipher.setAAD(Buffer.from(opts.aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    // Collapse all auth failures to a single uninformative error.
    // We never want to tell an attacker whether the tag, key, or padding was wrong.
    throw new Error('crypto.decrypt: authentication failed');
  }
}

/**
 * Re-encrypts an envelope under the active KEK. Returns null if the envelope
 * is already under the active kid (no-op signal for batch rotation jobs).
 */
export function reEncrypt(envelope, opts = {}) {
  const parts = envelope.split(':');
  if (parts.length !== 5) throw new Error('crypto.reEncrypt: malformed envelope');
  if (parts[1] === getActiveKid()) return null;
  return encrypt(decrypt(envelope, opts), opts);
}

/**
 * Inspect an envelope without decrypting. Useful for telemetry / rotation jobs.
 * Returns { version, kid } or null on malformed input.
 */
export function inspectEnvelope(envelope) {
  if (typeof envelope !== 'string') return null;
  const parts = envelope.split(':');
  if (parts.length !== 5) return null;
  return { version: parts[0], kid: parts[1] };
}

// -----------------------------------------------------------------------------
// 3. HMAC — for cookies, CSRF, signed URLs
// -----------------------------------------------------------------------------
//
// We use the active KEK as the HMAC secret (it's 32 bytes of CSPRNG output,
// suitable as both an AES key and an HMAC key). This is safe because HMAC and
// AES are domain-separated primitives and we never expose key material.

/**
 * HMAC-SHA256 of `data`. Returns base64url signature.
 */
export function hmacSign(data) {
  const key = getKey(getActiveKid());
  return crypto.createHmac('sha256', key).update(String(data)).digest('base64url');
}

/**
 * Constant-time verification of an HMAC-SHA256 signature.
 *
 * Returns true/false; never throws. Handles length mismatch BEFORE calling
 * timingSafeEqual (timingSafeEqual itself throws on length mismatch, which
 * would leak length via the exception).
 */
export function hmacVerify(data, sigB64u) {
  if (typeof sigB64u !== 'string' || sigB64u.length === 0) return false;
  const expected = hmacSign(data);
  if (expected.length !== sigB64u.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64u));
  } catch {
    return false;
  }
}

/**
 * Generic constant-time equality. Use this for ANY secret comparison
 * (webhook tokens, confirmation strings, API keys). Never use `===` for
 * secrets — that's a timing oracle.
 */
export function constantTimeEqual(a, b) {
  if (a == null || b == null) return false;
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// 4. CSRF tokens & generic random
// -----------------------------------------------------------------------------

/**
 * Generate a CSRF token. 32 bytes of CSPRNG output, base64url-encoded (43 chars).
 * Suitable for the double-submit cookie pattern: server sets it as `kfl_csrf`
 * (NOT HttpOnly so JS can read it), client echoes in `X-CSRF-Token` header.
 */
export function genCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Alias for arbitrary cryptographic random tokens (state, nonces, codes).
 */
export function randomToken(bytes = 32) {
  if (typeof bytes !== 'number' || bytes < 16 || bytes > 256) {
    throw new RangeError('crypto.randomToken: bytes must be 16..256');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

// -----------------------------------------------------------------------------
// 5. Session JWT (HS256) — short-lived, in HttpOnly cookie
// -----------------------------------------------------------------------------
//
// The header is HARD-CODED. Verification REJECTS any non-HS256 header.
// This eliminates the classic "alg: none" and "alg confusion" attacks where
// an attacker forces RS256 -> HS256 with the public key as the HMAC secret.

const HS256_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/**
 * Sign a short-lived session payload. Default 24-hour TTL (sliding refresh
 * is the caller's responsibility).
 *
 * Recommended payload: { sub: <userSub>, email: <userEmail> }. NEVER put
 * refresh tokens or any other long-lived secret in here.
 */
export function signSessionJWT(payload, ttlSec = 60 * 60 * 24) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('crypto.signSessionJWT: payload must be an object');
  }
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat,
    exp: iat + ttlSec,
  })).toString('base64url');
  const data = `${HS256_HEADER}.${body}`;
  const sig = crypto.createHmac('sha256', getKey(getActiveKid()))
    .update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify a session JWT signed by signSessionJWT().
 *
 * Returns the decoded payload OR null on any failure. Strictly:
 *   - Header must be {alg:"HS256", typ:"JWT"} (rejects alg=none, RS256, ...)
 *   - Signature must match (constant-time)
 *   - exp must be in the future (with 60s clock-skew tolerance for iat-in-future)
 */
export function verifySessionJWT(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;

  // Enforce header structure — refuse alg switching.
  let header;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  // Constant-time signature check.
  const expected = crypto.createHmac('sha256', getKey(getActiveKid()))
    .update(`${h}.${b}`).digest('base64url');
  if (expected.length !== s.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
  } catch { return null; }

  let payload;
  try { payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); }
  catch { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return null;
  return payload;
}

// -----------------------------------------------------------------------------
// 6. Google ID Token (RS256) verification — JWKS cache
// -----------------------------------------------------------------------------
//
// Google's published OIDC spec:
//   - JWKS at https://www.googleapis.com/oauth2/v3/certs
//   - iss in {'https://accounts.google.com', 'accounts.google.com'}
//   - aud === your GOOGLE_CLIENT_ID
//   - alg === 'RS256'
//   - exp not in the past
//   - iat not in the future
//
// JWKS is cached using the response's Cache-Control max-age (Google usually
// sets ~6h). On a kid miss we refresh once before failing — Google rotates
// keys roughly weekly and the old/new pair is published in parallel.
//
// IMPORTANT: this is the ONLY way to trust the identity claims in the ID token.
// The old api/auth/google-exchange.js path that JUST SPLIT THE JWT and parsed
// the payload without signature check is a critical vulnerability — an attacker
// who steals the OAuth `code` AND replays it through their own Google-signed
// account swap could forge `sub`. Always go through verifyGoogleIdToken().

const JWKS_CACHE = { keys: null, fetchedAt: 0, ttlMs: 3600_000 };
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

async function fetchGoogleJwks() {
  const r = await fetch(JWKS_URL, { method: 'GET' });
  if (!r.ok) throw new Error(`jwks fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.keys)) throw new Error('jwks malformed (missing keys[])');

  // Honour Cache-Control max-age (Google sets it to ~6h normally).
  const cc = r.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttlMs = m
    ? Math.max(60_000, Math.min(86_400_000, Number(m[1]) * 1000))
    : 3600_000;

  JWKS_CACHE.keys = j.keys;
  JWKS_CACHE.fetchedAt = Date.now();
  JWKS_CACHE.ttlMs = ttlMs;
  return j.keys;
}

async function getGoogleJwk(kid) {
  const fresh = JWKS_CACHE.keys && (Date.now() - JWKS_CACHE.fetchedAt) < JWKS_CACHE.ttlMs;
  if (!fresh) await fetchGoogleJwks();
  let jwk = JWKS_CACHE.keys.find(k => k.kid === kid);
  if (!jwk) {
    // Unknown kid — refresh once in case Google rotated since cache time.
    await fetchGoogleJwks();
    jwk = JWKS_CACHE.keys.find(k => k.kid === kid);
  }
  return jwk || null;
}

/**
 * Verify a Google OAuth2 ID token (RS256 JWT) against Google's JWKS.
 *
 * @param {string} idTokenJwt - the raw JWT string (3 dot-separated b64url parts).
 * @param {Object} [opts]
 * @param {string} [opts.audience] - required audience (defaults to GOOGLE_CLIENT_ID env).
 * @param {number} [opts.clockSkewSec=60] - tolerance for exp/iat.
 * @returns {Promise<object>} the verified claims (sub, email, name, picture, ...).
 * @throws on ANY validation failure. Callers must NEVER trust unverified payloads.
 */
export async function verifyGoogleIdToken(idTokenJwt, opts = {}) {
  const audience = opts.audience || process.env.GOOGLE_CLIENT_ID;
  if (!audience) throw new Error('verifyGoogleIdToken: audience (GOOGLE_CLIENT_ID) required');

  if (typeof idTokenJwt !== 'string' || idTokenJwt.length < 20) {
    throw new Error('verifyGoogleIdToken: idTokenJwt must be a non-empty string');
  }
  const parts = idTokenJwt.split('.');
  if (parts.length !== 3) throw new Error('verifyGoogleIdToken: malformed JWT (expected 3 parts)');

  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('verifyGoogleIdToken: invalid base64 / JSON');
  }

  // CRITICAL guards.
  if (header.alg !== 'RS256') {
    throw new Error('verifyGoogleIdToken: unsupported alg "' + header.alg + '" (only RS256 accepted)');
  }
  if (header.typ && header.typ !== 'JWT') {
    throw new Error('verifyGoogleIdToken: unsupported typ "' + header.typ + '"');
  }
  if (!header.kid) {
    throw new Error('verifyGoogleIdToken: header missing kid');
  }

  const jwk = await getGoogleJwk(header.kid);
  if (!jwk) {
    throw new Error('verifyGoogleIdToken: signing key not found for kid ' + header.kid);
  }
  if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256') {
    throw new Error('verifyGoogleIdToken: JWK is not an RSA RS256 key');
  }

  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });

  // Signature verification.
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = Buffer.from(sigB64, 'base64url');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  if (!verifier.verify(pubKey, signature)) {
    throw new Error('verifyGoogleIdToken: signature invalid');
  }

  // Claim checks.
  const now = Math.floor(Date.now() / 1000);
  const skew = typeof opts.clockSkewSec === 'number' ? opts.clockSkewSec : 60;

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('verifyGoogleIdToken: bad issuer "' + payload.iss + '"');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) {
    throw new Error('verifyGoogleIdToken: audience mismatch');
  }
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) {
    throw new Error('verifyGoogleIdToken: token expired');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + skew) {
    throw new Error('verifyGoogleIdToken: token issued in the future');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('verifyGoogleIdToken: missing sub claim');
  }

  return payload;
}

// -----------------------------------------------------------------------------
// 7. Logging redaction
// -----------------------------------------------------------------------------

const REDACT_KEY_PATTERN = /(authorization|cookie|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|password|credential|secret|client[-_]?secret|signature|hmac|csrf|bearer|webhook[-_]?secret)/i;

/**
 * Recursively redact any field whose KEY matches REDACT_KEY_PATTERN.
 * Returns a new object — does not mutate the input.
 */
export function redact(obj, depth = 0) {
  if (depth > 8) return '[redacted:depth]';
  if (obj == null) return obj;
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEY_PATTERN.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'object') out[k] = redact(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// 8. Convenience wrappers for refresh tokens (AAD-bound to userSub)
// -----------------------------------------------------------------------------
//
// AAD = "kfl-refresh:<userSub>" ensures that an envelope stolen for user A
// cannot be decrypted in user B's KV record, even if an attacker swaps the
// `userSub` field. The auth tag won't validate.

export function encryptRefreshToken(refreshToken, userSub) {
  if (!userSub) throw new Error('encryptRefreshToken: userSub required for AAD binding');
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new Error('encryptRefreshToken: refreshToken required');
  }
  return encrypt(refreshToken, { aad: `kfl-refresh:${userSub}` });
}

export function decryptRefreshToken(envelope, userSub) {
  if (!userSub) throw new Error('decryptRefreshToken: userSub required for AAD binding');
  return decrypt(envelope, { aad: `kfl-refresh:${userSub}` });
}

// -----------------------------------------------------------------------------
// 9. Self-test (optional, runs at import if KESEFLE_CRYPTO_SELFTEST=1)
// -----------------------------------------------------------------------------
//
// Catches misconfiguration at cold-start so we don't ship a deploy that
// bricks every encrypt() call. Recommended for production.

if (process.env.KESEFLE_CRYPTO_SELFTEST === '1') {
  try {
    const t = encrypt('selftest');
    if (decrypt(t) !== 'selftest') throw new Error('encrypt/decrypt roundtrip mismatch');
    const tAAD = encrypt('aad-test', { aad: 'ctx-1' });
    if (decrypt(tAAD, { aad: 'ctx-1' }) !== 'aad-test') throw new Error('AAD roundtrip mismatch');
    let aadGuardOk = false;
    try { decrypt(tAAD, { aad: 'ctx-2' }); } catch { aadGuardOk = true; }
    if (!aadGuardOk) throw new Error('AAD did not reject mismatched context');

    const sig = hmacSign('x');
    if (!hmacVerify('x', sig)) throw new Error('hmac roundtrip mismatch');
    if (hmacVerify('x', sig.slice(0, -1) + 'A')) throw new Error('hmac false-positive');
    if (!constantTimeEqual('abc', 'abc')) throw new Error('constantTimeEqual failed positive');
    if (constantTimeEqual('abc', 'abd')) throw new Error('constantTimeEqual failed negative');

    const jwt = signSessionJWT({ sub: 'test' }, 60);
    if (!verifySessionJWT(jwt)) throw new Error('jwt roundtrip mismatch');
    // alg=none rejection
    const noneTok = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      + '.' + Buffer.from(JSON.stringify({ sub: 'evil', exp: 9999999999 })).toString('base64url')
      + '.';
    if (verifySessionJWT(noneTok)) throw new Error('alg=none was accepted');

    console.log(JSON.stringify({ level: 'info', msg: 'crypto.selftest.ok', activeKid: getActiveKid() }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'fatal', msg: 'crypto.selftest.failed', error: e.message }));
    throw e;
  }
}
