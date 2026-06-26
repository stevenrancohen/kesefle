// lib/auth.js
// Server-side authentication for API endpoints.
//
// Two auth modes:
//   1. Bearer token (Authorization: Bearer <google-id-token>) — for SPA/dashboard calls
//   2. Session cookie (kefle_session) — for browser navigations (post-login)
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
import { getUserId } from '../api/_lib/session.js';

// Default admin emails for when ADMIN_EMAILS env var is not set on Vercel.
// These are the OWNER identities for kesefle.com; env var (if present)
// OVERRIDES this list. Keeping a default in code means a fresh Vercel
// project works out-of-the-box for the owner without needing to flip env
// vars before the admin panel can be used.
const DEFAULT_ADMIN_EMAILS = 'stevenrancohen@gmail.com,info@kesefle.com';

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
 * or `kefle_session` cookie. Sets req.user = verified payload.
 * Returns 401 if missing/invalid.
 */
export function requireAuth(handler) {
  return async function authed(req, res) {
    const reqId = req.reqId || 'unknown';

    // Auth mode 1: Bearer Google ID token (legacy SPA path; still works for
    // any client that has a fresh Google ID token).
    let bearer;
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      bearer = authHeader.slice('Bearer '.length).trim();
    }

    if (bearer) {
      let expectedAud;
      try { expectedAud = getGoogleClientId(); }
      catch (e) {
        log.error('auth.client_id_missing', { reqId });
        return res.status(503).json({ ok: false, error: 'auth_misconfigured', reqId });
      }
      try {
        const payload = await verifyGoogleIdToken(bearer, expectedAud);
        req.user = { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
        log.info('auth.ok', { reqId, userSub: payload.sub, email: payload.email, via: 'bearer' });
        return handler(req, res);
      } catch (e) {
        log.warn('auth.bearer_failed', { reqId, error: e.message });
        // Fall through to cookie path -- a stale Bearer should not preempt a
        // valid cookie session.
      }
    }

    // Auth mode 2: HS256 session cookie (set at /api/auth/google-exchange).
    // The cookie holds only the userSub; we fetch the user record from KV to
    // populate email/name/picture so downstream code (requireAdmin etc.) can
    // make policy decisions without an extra round trip from the handler.
    const userSub = getUserId(req);
    if (userSub) {
      const kvUrl = process.env.KV_REST_API_URL;
      const kvToken = process.env.KV_REST_API_TOKEN;
      let email = null, name = null, picture = null;
      if (kvUrl && kvToken) {
        try {
          const r = await fetch(`${kvUrl}/get/${encodeURIComponent('user:' + userSub)}`, {
            headers: { 'Authorization': `Bearer ${kvToken}` },
          });
          const j = await r.json();
          const rec = j?.result ? JSON.parse(j.result) : null;
          if (rec) { email = rec.email || null; name = rec.name || null; picture = rec.picture || null; }
        } catch (e) {
          log.warn('auth.kv_user_lookup_failed', { reqId, userSub, error: e.message });
        }
      }
      req.user = { sub: userSub, email, name, picture };
      log.info('auth.ok', { reqId, userSub, email, via: 'session' });
      return handler(req, res);
    }

    return res.status(401).json({ ok: false, error: 'missing_auth', reqId });
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
    if (token) {
      let expectedAud = null;
      try { expectedAud = getGoogleClientId(); } catch (_e) { /* no client id -> skip bearer */ }
      if (expectedAud) {
        try {
          const payload = await verifyGoogleIdToken(token, expectedAud);
          req.user = { sub: payload.sub, email: payload.email };
        } catch (e) { /* ignore -> fall through to cookie */ }
      }
    }
    // Soft cookie path (#25): a verified kefle_session cookie also identifies
    // the user, matching requireAuth. Never blocks — absent/invalid -> anon.
    if (!req.user) {
      try {
        const userSub = getUserId(req);
        if (userSub) req.user = { sub: userSub, email: null };
      } catch (_e) { /* ignore */ }
    }
    return handler(req, res);
  };
}

/**
 * Admin check — requires both valid auth AND user.email in ADMIN_EMAILS env var (comma-separated).
 */
export function requireAdmin(handler) {
  return requireAuth(async function admined(req, res) {
    // ADMIN_EMAILS env var OVERRIDES the in-code default; both are comma-
    // separated and case-insensitive on the email comparison (Gmail/Google
    // emails are case-insensitive). Empty env var falls back to defaults
    // (the owner identities) so the admin panel works on a fresh Vercel
    // project without env-var setup.
    const raw = process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS;
    const admins = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const userEmail = (req.user.email || '').toLowerCase();
    if (!userEmail || !admins.includes(userEmail)) {
      log.warn('admin.denied', { reqId: req.reqId, userSub: req.user.sub, email: req.user.email, adminsCount: admins.length });
      return res.status(403).json({ ok: false, error: 'admin_required' });
    }
    return handler(req, res);
  });
}
