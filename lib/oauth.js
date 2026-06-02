// lib/oauth.js
// =============================================================================
// Single source of truth for the Google `grant_type=refresh_token` exchange.
//
// WHY THIS EXISTS (audit finding H1, docs/AUDIT_OAUTH_DRIVE_2026_05_31.md):
// Google ROTATES the refresh_token for grants older than ~6 months. On the
// next refresh-for-access exchange it returns a NEW `refresh_token` field and
// revokes the OLD one within hours. Every refresh-for-access call site in the
// codebase used to read only `j.access_token` and DISCARD `j.refresh_token`.
// After rotation those users silently lost the ability to write to their sheet
// (the bot fails with `refresh_failed`, invisible to the user until they
// message and get no reply). The earliest grants are ~3-4 months old, so this
// becomes real within weeks on a fixed Google-side timer.
//
// This helper captures the rotated token: when the response carries a non-empty
// `refresh_token`, it re-encrypts via encryptRefreshToken(token, userSub) (AAD
// bound to the sub) and persists the new envelope to BOTH KV records that hold
// a user's refresh token:
//   - user:{userSub}.refreshTokenEnvelope   (the canonical user record)
//   - token:{userSub}.refreshTokenEnvelope  (the legacy token store read by
//                                            api/sheet/getExpenses.js)
// Both writes MERGE into the existing record (read-modify-write) so we never
// clobber sibling fields (spreadsheetId, plan, expiry, ...).
//
// CONCURRENCY: a webhook write and a cron read can run the same exchange at the
// same moment. Google returns the same rotated token to both, but if both try
// to persist we get a read-modify-write race (lost update) and two redundant
// writes. We guard the persist with a short KV SETNX lock (`rotate_lock:{sub}`,
// ~30s) so only the first persists; the loser skips (the token it holds is the
// same one, already being saved by the winner).
//
// FAIL-SOFT: the persist is best-effort. A failed rotation-persist must NEVER
// break the access-token return — the caller still needs the access token to
// complete the user's request. We log (with subHash, never the token) and
// degrade. Worst case the rotation is re-captured on the next exchange (Google
// keeps returning the new refresh_token until it's actually used to mint an
// access token, and the old one survives a few more hours).
//
// SECURITY: no raw refresh/access token is ever logged. lib/log.js redacts
// token-named fields anyway, but we additionally only ever log `subHash(sub)`.
// =============================================================================

import nodeCrypto from 'node:crypto';
import { encryptRefreshToken } from './crypto.js';
import { log, subHash } from './log.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// -----------------------------------------------------------------------------
// In-memory access-token cache (cost + latency reduction)
// -----------------------------------------------------------------------------
//
// The expense-write path (api/sheet/append.js and api/whatsapp/webhook.js →
// lib/sheet-writer.js appendRowToUserSheet) calls exchangeRefreshForAccess on
// EVERY expense. A Google `grant_type=refresh_token` exchange is a network round
// trip that mints an access token valid for ~3600s. When a user enters several
// expenses in a row (batch entry, corrections, re-sends) on the same warm Vercel
// instance, the old code re-minted a token each time — needless Google calls,
// added latency, and — because every exchange runs the rotation-capture branch —
// the chance of redundant KV reads/writes from persistRotatedRefreshToken.
//
// Caching the minted access token per (userSub + refresh-token fingerprint) and
// reusing it until shortly before expiry removes those repeat exchanges within a
// warm window. Each avoided exchange ALSO avoids the rotation-persist KV traffic
// it could have triggered.
//
// Design constraints (these are access tokens — sensitive):
//   * In-memory ONLY. Never written to KV, never logged. A warm Vercel instance
//     lives ~15 min; a cold start simply re-mints — accepted, same tradeoff the
//     repo already makes in lib/sheet-quota.js.
//   * Keyed by userSub + a SHA-256 fingerprint of the refresh token. If Google
//     rotates the refresh token, the fingerprint changes and the stale access
//     token is never served (we also drop the entry on detected rotation).
//   * 5-minute safety margin before expiry, so we never hand back a token that
//     expires mid-request.
//   * Bounded with LRU eviction to avoid unbounded growth on a long-lived
//     instance (mirrors lib/sheet-quota.js).
const _TOKEN_CACHE = new Map(); // key -> { accessToken, expMs }
const _TOKEN_CACHE_MAX = 1000;
const _TOKEN_SAFETY_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

function _refreshFingerprint(refreshToken) {
  // Short, non-reversible fingerprint so a rotated refresh token misses the
  // cache. We never store or log the refresh token itself.
  return nodeCrypto.createHash('sha256').update(String(refreshToken)).digest('hex').slice(0, 16);
}

function _tokenCacheKey(userSub, refreshToken) {
  return `${userSub || 'anon'}:${_refreshFingerprint(refreshToken)}`;
}

function _cacheGetAccessToken(userSub, refreshToken) {
  const key = _tokenCacheKey(userSub, refreshToken);
  const hit = _TOKEN_CACHE.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (now >= hit.expMs) {
    _TOKEN_CACHE.delete(key);
    return null;
  }
  // LRU touch: re-insert so recently used keys stay warm.
  _TOKEN_CACHE.delete(key);
  _TOKEN_CACHE.set(key, hit);
  // Report the TRUTHFUL remaining lifetime (the cache stores expMs with the
  // safety margin already subtracted, so this is conservative). Callers that
  // persist a token expiry (e.g. api/sheet/getExpenses.js) therefore record an
  // accurate, never-overstated expiry — not a fresh 3600.
  return { accessToken: hit.accessToken, expiresInSec: Math.max(1, Math.round((hit.expMs - now) / 1000)) };
}

function _cacheSetAccessToken(userSub, refreshToken, accessToken, expiresInSec) {
  const key = _tokenCacheKey(userSub, refreshToken);
  const ttlMs = Math.max(0, (Number(expiresInSec) || 3600) * 1000 - _TOKEN_SAFETY_MS);
  if (ttlMs <= 0) return; // too short to be worth caching
  if (_TOKEN_CACHE.size >= _TOKEN_CACHE_MAX && !_TOKEN_CACHE.has(key)) {
    const oldest = _TOKEN_CACHE.keys().next().value;
    if (oldest !== undefined) _TOKEN_CACHE.delete(oldest);
  }
  _TOKEN_CACHE.set(key, { accessToken, expMs: Date.now() + ttlMs });
}

function _cacheDropForSub(userSub, refreshToken) {
  // Drop the entry for an old refresh token after a rotation so it can't be
  // served again. The new token will be cached under its own fingerprint.
  if (!userSub) return;
  _TOKEN_CACHE.delete(_tokenCacheKey(userSub, refreshToken));
}

// How long the rotation-persist lock is held. Long enough to cover a
// read-modify-write of two KV records over the network; short enough that a
// crash mid-persist can't wedge rotation capture for long.
const ROTATE_LOCK_TTL_SEC = 30;

function getGoogleClientId() {
  // Mirrors lib/auth.js getGoogleClientId() without importing it (keeps this
  // module dependency-light and usable from cron handlers).
  return process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
}

// --- KV REST helpers (Upstash) -------------------------------------------------
// All take kvUrl/kvToken explicitly so call sites pass whatever they already
// resolved (env in most, but cron mints them too). If KV is unconfigured these
// degrade to no-ops and rotation simply isn't persisted this round.

async function kvGetJSON(kvUrl, kvToken, key) {
  if (!kvUrl || !kvToken) return null;
  try {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    if (!j || j.result == null) return null;
    try { return JSON.parse(j.result); } catch { return null; }
  } catch {
    return null;
  }
}

async function kvSetJSON(kvUrl, kvToken, key, value) {
  if (!kvUrl || !kvToken) return false;
  try {
    const r = await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Atomic claim. Returns true if WE set the key (won the lock), false if it
// already existed (another exchange is persisting) or KV is unavailable.
// Upstash returns { result: "OK" } on set, { result: null } on NX-rejected.
async function kvSetNXLock(kvUrl, kvToken, key, ttlSec) {
  if (!kvUrl || !kvToken) return false;
  try {
    const r = await fetch(`${kvUrl}/set/${encodeURIComponent(key)}?nx=true&ex=${Number(ttlSec) || ROTATE_LOCK_TTL_SEC}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify('1'),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j?.result === 'OK' || j?.result === 1;
  } catch {
    return false;
  }
}

/**
 * Persist a rotated refresh token into BOTH the user: and token: KV records.
 *
 * Best-effort + race-guarded. Never throws. Returns a small status object
 * (mostly for tests + telemetry):
 *   { persisted: boolean, lock: 'acquired'|'busy'|'no_kv', records: string[] }
 *
 * @param {object} args
 * @param {string} args.newRefreshToken - the fresh token Google just returned.
 * @param {string} args.userSub         - the Google sub (AAD binding + KV keys).
 * @param {string} args.kvUrl
 * @param {string} args.kvToken
 */
async function persistRotatedRefreshToken({ newRefreshToken, userSub, kvUrl, kvToken }) {
  if (!kvUrl || !kvToken) {
    return { persisted: false, lock: 'no_kv', records: [] };
  }

  // Race guard: only the first concurrent exchange persists. The loser holds
  // the identical rotated token, which the winner is already saving — so
  // skipping is correct, not a lost update.
  const lockKey = `rotate_lock:${userSub}`;
  const gotLock = await kvSetNXLock(kvUrl, kvToken, lockKey, ROTATE_LOCK_TTL_SEC);
  if (!gotLock) {
    log.info('oauth.rotation.skip_locked', { sub: subHash(userSub) });
    return { persisted: false, lock: 'busy', records: [] };
  }

  // Encrypt once; the SAME envelope (AAD-bound to this sub) goes to both keys.
  let envelope;
  try {
    envelope = encryptRefreshToken(newRefreshToken, userSub);
  } catch (e) {
    log.error('oauth.rotation.encrypt_failed', { sub: subHash(userSub), error: e.message });
    return { persisted: false, lock: 'acquired', records: [] };
  }

  const written = [];

  // user:{sub} — canonical record. MERGE so we never clobber spreadsheetId etc.
  try {
    const userKey = `user:${userSub}`;
    const userRec = (await kvGetJSON(kvUrl, kvToken, userKey)) || {};
    userRec.refreshTokenEnvelope = envelope;
    // A pre-migration plaintext field would otherwise out-live the rotation and
    // get re-read on the next exchange; drop it now that we have a fresh
    // envelope (the old plaintext token is revoked by Google anyway).
    if (userRec.refreshToken) delete userRec.refreshToken;
    if (await kvSetJSON(kvUrl, kvToken, userKey, userRec)) written.push(userKey);
  } catch (e) {
    log.error('oauth.rotation.user_persist_failed', { sub: subHash(userSub), error: e.message });
  }

  // token:{sub} — legacy token store read by api/sheet/getExpenses.js. Only
  // touch it if the record already exists (don't conjure one for users who
  // never had it); MERGE to keep accessToken/expiry/sheetId intact.
  try {
    const tokenKey = `token:${userSub}`;
    const tokenRec = await kvGetJSON(kvUrl, kvToken, tokenKey);
    if (tokenRec) {
      tokenRec.refreshTokenEnvelope = envelope;
      if (tokenRec.refreshToken) delete tokenRec.refreshToken;
      if (await kvSetJSON(kvUrl, kvToken, tokenKey, tokenRec)) written.push(tokenKey);
    }
  } catch (e) {
    log.error('oauth.rotation.token_persist_failed', { sub: subHash(userSub), error: e.message });
  }

  if (written.length > 0) {
    log.info('oauth.rotation.captured', { sub: subHash(userSub), records: written.length });
  }
  return { persisted: written.length > 0, lock: 'acquired', records: written };
}

/**
 * Exchange a Google OAuth refresh token for a fresh access token, and CAPTURE
 * a rotated refresh_token if Google returns one.
 *
 * @param {object} args
 * @param {string} args.refreshToken - the (already-decrypted) refresh token.
 * @param {string} args.userSub      - Google sub; REQUIRED so a rotated token
 *                                      can be re-encrypted (AAD) + persisted.
 * @param {string} [args.kvUrl]      - Upstash REST URL (defaults to env).
 * @param {string} [args.kvToken]    - Upstash REST token (defaults to env).
 * @param {boolean} [args.noCache]   - skip the warm-instance access-token cache
 *                                      and force a fresh Google mint. Set this on
 *                                      a 401-retry (the cached token is what was
 *                                      just rejected).
 * @returns {Promise<{ accessToken: string, expiresIn: number, rotated: boolean, cached?: boolean }>}
 *          `cached` is true when served from the in-memory cache; `expiresIn` is
 *          the truthful remaining lifetime in seconds either way.
 * @throws on exchange failure (non-2xx or no access_token) — callers keep their
 *         existing fail-soft handling for that.
 */
export async function exchangeRefreshForAccess({ refreshToken, userSub, kvUrl, kvToken, noCache = false } = {}) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new Error('exchangeRefreshForAccess: refreshToken required');
  }

  // Fast path: reuse a still-valid access token minted for this exact
  // (userSub + refresh-token fingerprint) on this warm instance. Skips the
  // Google round trip AND the rotation-capture KV traffic. `noCache` lets a
  // caller force a fresh mint (e.g. after a 401 from the Sheets API).
  if (!noCache) {
    const cached = _cacheGetAccessToken(userSub, refreshToken);
    if (cached) {
      // expiresIn is the TRUTHFUL remaining lifetime so any caller that persists
      // a token expiry stays accurate; it's always > 0 (a hit is never expired).
      return { accessToken: cached.accessToken, expiresIn: cached.expiresInSec, rotated: false, cached: true };
    }
  }

  const clientId = getGoogleClientId();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error('google_client_id_missing');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var missing');

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  }

  // ROTATION CAPTURE. Google only includes `refresh_token` when it rotated;
  // a normal refresh response omits it. Persist is best-effort and MUST NOT
  // break the access-token return — hence the try/catch around the whole thing.
  const expiresIn = Number(j.expires_in || 3600);

  // Cache the freshly minted token under the CURRENT refresh token's fingerprint
  // so subsequent expenses on this warm instance reuse it. Bounded by the safety
  // margin in _cacheSetAccessToken (won't cache a too-short-lived token).
  if (!noCache) _cacheSetAccessToken(userSub, refreshToken, j.access_token, expiresIn);

  let rotated = false;
  const newRefresh = j.refresh_token;
  if (typeof newRefresh === 'string' && newRefresh.length > 0 && newRefresh !== refreshToken) {
    // The refresh token rotated: the access token we just cached is keyed by the
    // OLD fingerprint. Drop that entry so nothing reuses a token tied to a
    // now-defunct refresh token; future calls pass the new token and re-cache
    // under its own fingerprint.
    _cacheDropForSub(userSub, refreshToken);
    if (!userSub) {
      // We got a rotated token but can't AAD-bind/persist it without the sub.
      // Log loudly (no token) so the missing-arg call site is fixable; the old
      // token still works for a few hours so this isn't an immediate outage.
      log.error('oauth.rotation.no_subject', { note: 'rotated refresh_token received but userSub missing — cannot persist' });
    } else {
      try {
        const res = await persistRotatedRefreshToken({
          newRefreshToken: newRefresh,
          userSub,
          kvUrl: kvUrl || process.env.KV_REST_API_URL,
          kvToken: kvToken || process.env.KV_REST_API_TOKEN,
        });
        rotated = res.persisted;
      } catch (e) {
        // Defensive: persistRotatedRefreshToken already swallows its own errors,
        // but never let anything here break the token return.
        log.error('oauth.rotation.persist_threw', { sub: subHash(userSub), error: e.message });
      }
    }
  }

  return {
    accessToken: j.access_token,
    expiresIn,
    rotated,
  };
}

// Exposed for tests (and any future direct caller). Not part of the primary API.
export { persistRotatedRefreshToken };

// Test-only: clear the in-memory access-token cache so a suite can simulate
// independent logical exchanges in one process. No effect on production behavior
// (the cache simply re-populates on the next mint). Never call this from request
// handlers — it would defeat the cache's purpose.
export function __clearAccessTokenCache() {
  _TOKEN_CACHE.clear();
}
