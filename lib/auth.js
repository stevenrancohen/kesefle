// lib/auth.js
// Server-side authentication for API endpoints.
//
// Two auth modes:
//   1. Bearer token (Authorization: Bearer <google-id-token>) — for SPA/dashboard calls
//   2. Session cookie (kfl_session) — for browser navigations (post-login)
//
// Both methods verify the Google ID token signature against Google's JWKS.
// NO MORE TRUSTING X-User-Sub HEADER.
//
// Usage:
//   import { requireAuth } from '../lib/auth.js';
//   export default requireAuth(async function (req, res) {
//     // req.user is now { sub, email, name } — verified
//     const userSub = req.user.sub;
//     ...
//   });

import crypto from 'node:crypto';
import { log } from './log.js';

// Single source of truth for our Google OAuth client identity. Every API
// handler that verifies a Google ID token (or exchanges a refresh token)
// must read this — NEVER a hardcoded fallback. The audit flagged six
// endpoints that had `process.env.GOOGLE_CLIENT_ID || '<prod-id>'` baked
// in, which meant a preview deploy without the env var silently used
// prod identity and would have accepted tokens minted for the prod app.
// Fails closed here so the deployment surfaces the misconfiguration
// instead of papering over it.
export function getGoogleClientId() {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) {
    throw new Error('GOOGLE_CLIENT_ID env var not configured');
  }
  return id;
}

// Cache for Google's public keys (refreshed when expired)
let JWKS_CACHE = { keys: null, fetchedAt: 0, ttlMs: 3600 * 1000 };

async function getGoogleJWKS() {
  const now = Date.now();
  if (JWKS_CACHE.keys && (now - JWKS_CACHE.fetchedAt < JWKS_CACHE.ttlMs)) {
    return JWKS_CACHE.keys;
  }
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw new Error('jwks_fetch_status_' + r.status);
    const j = await r.json();
    JWKS_CACHE = { keys: j.keys, fetchedAt: now, ttlMs: 3600 * 1000 };
    return j.keys;
  } catch (e) {
    log.error('jwks.fetch_failed', { error: e.message });
    throw e;
  }
}

// Parse a JWS compact serialization without verifying — only used for header inspection.
function decodeJwtParts(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('invalid_jwt_format');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const signingInput = parts[0] + '.' + parts[1];
  const signature = Buffer.from(parts[2], 'base64url');
  return { header, payload, signingInput, signature };
}

// Convert JWK (RSA public key) to a PEM-formatted KeyObject.
function jwkToPublicKey(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verifies a Google-issued ID token (RS256). Returns the verified payload.
 * Throws if signature invalid, expired, or audience mismatch.
 */
export async function verifyGoogleIdToken(idToken, expectedAudience) {
  if (!idToken || typeof idToken !== 'string') throw new Error('missing_id_token');
  const { header, payload, signingInput, signature } = decodeJwtParts(idToken);
  if (header.alg !== 'RS256') throw new Error('unsupported_alg_' + header.alg);
  if (!header.kid) throw new Error('missing_kid');

  const keys = await getGoogleJWKS();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid_not_in_jwks');

  const pubKey = jwkToPublicKey(jwk);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  const isValid = verifier.verify(pubKey, signature);
  if (!isValid) throw new Error('signature_invalid');

  // Check claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('token_expired');
  if (payload.nbf && payload.nbf > now + 30) throw new Error('token_not_yet_valid');
  if (payload.iss && payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('invalid_issuer_' + payload.iss);
  }
  // Audience: must match our OAuth client_id (caller passes expectedAudience)
  if (expectedAudience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAudience)) throw new Error('audience_mismatch');
  }
  if (!payload.sub) throw new Error('missing_sub_claim');
  return payload;
}

/**
 * Middleware: extract + verify a Google ID token from `Authorization: Bearer <jwt>` header
 * or `kfl_session` cookie. Sets req.user = verified payload.
 * Returns 401 if missing/invalid.
 */
export function requireAuth(handler) {
  return async function authed(req, res) {
    const reqId = req.reqId || 'unknown';
    let token;
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice('Bearer '.length).trim();
    } else if (req.headers?.cookie) {
      const m = req.headers.cookie.match(/(?:^|;\s*)kfl_session=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }

    if (!token) {
      return res.status(401).json({ ok: false, error: 'missing_auth', reqId });
    }

    let expectedAud;
    try { expectedAud = getGoogleClientId(); }
    catch (e) {
      log.error('auth.client_id_missing', { reqId });
      return res.status(503).json({ ok: false, error: 'auth_misconfigured', reqId });
    }

    try {
      const payload = await verifyGoogleIdToken(token, expectedAud);
      req.user = { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
      log.info('auth.ok', { reqId, userSub: payload.sub, email: payload.email });
      return handler(req, res);
    } catch (e) {
      log.warn('auth.failed', { reqId, error: e.message });
      return res.status(401).json({ ok: false, error: 'invalid_token', reqId });
    }
  };
}

/**
 * Soft auth: same as requireAuth but doesn't 401 — just sets req.user if valid, else null.
 * Use for endpoints that work both authenticated + anonymous (e.g. landing analytics).
 */
export function optionalAuth(handler) {
  return async function softAuthed(req, res) {
    let token;
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token) return handler(req, res);
    let expectedAud;
    try { expectedAud = getGoogleClientId(); }
    catch (_e) { return handler(req, res); /* unauth-allowed path */ }
    try {
      const payload = await verifyGoogleIdToken(token, expectedAud);
      req.user = { sub: payload.sub, email: payload.email };
    } catch (e) { /* ignore */ }
    return handler(req, res);
  };
}

/**
 * Admin check — requires both valid auth AND user.email in ADMIN_EMAILS env var (comma-separated).
 */
export function requireAdmin(handler) {
  return requireAuth(async function admined(req, res) {
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!admins.includes(req.user.email)) {
      log.warn('admin.denied', { reqId: req.reqId, userSub: req.user.sub, email: req.user.email });
      return res.status(403).json({ ok: false, error: 'admin_required' });
    }
    return handler(req, res);
  });
}
