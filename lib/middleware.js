// lib/middleware.js
// Composable security middleware for Vercel serverless functions.
//
// Usage example:
//   import { compose, requireAuth, withRateLimit, withRequestId, withSecurityHeaders } from '../lib/middleware.js';
//   export default compose(
//     withRequestId,
//     withSecurityHeaders,
//     withRateLimit({ key: 'summary', limit: 30, windowSec: 60 }),
//     requireAuth,
//   )(async function (req, res) { ... });

export { requireAuth, requireAdmin, optionalAuth, verifyGoogleIdToken } from './auth.js';
export { withRateLimit, rateLimit } from './ratelimit.js';
export { withRequestId, log, redact } from './log.js';

/**
 * Compose middleware from right-to-left:
 *   compose(A, B, C)(handler) === A(B(C(handler)))
 */
export function compose(...middlewares) {
  return function combine(handler) {
    return middlewares.reduceRight((acc, mw) => mw(acc), handler);
  };
}

/**
 * Add hardened response headers for ALL API responses.
 * (vercel.json sets static-asset headers; API needs these per-request.)
 */
export function withSecurityHeaders(handler) {
  return async function headered(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return handler(req, res);
  };
}

/**
 * Validate JSON request body against a simple schema.
 * Schema is a flat object: { fieldName: { type, required, maxLen, pattern } }
 * On validation failure, returns 400 with { ok: false, error, fields }.
 *
 * Example:
 *   withValidation({
 *     email: { type: 'string', required: true, maxLen: 254, pattern: /^[^@]+@[^@]+$/ },
 *     plan: { type: 'string', required: true, enum: ['free', 'pro', 'family'] }
 *   })
 */
export function withValidation(schema) {
  return function wrap(handler) {
    return async function validated(req, res) {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        return handler(req, res);
      }
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); }
        catch (e) { return res.status(400).json({ ok: false, error: 'invalid_json' }); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ ok: false, error: 'body_must_be_object' });
      }
      // Reject prototype pollution
      if (body.__proto__ || body.constructor || body.prototype) {
        if (Object.hasOwn ? Object.hasOwn(body, '__proto__') || Object.hasOwn(body, 'constructor') || Object.hasOwn(body, 'prototype') : false) {
          return res.status(400).json({ ok: false, error: 'forbidden_keys' });
        }
      }
      const errors = {};
      for (const [field, rule] of Object.entries(schema)) {
        const v = body[field];
        if (v == null) {
          if (rule.required) errors[field] = 'required';
          continue;
        }
        if (rule.type && typeof v !== rule.type) {
          errors[field] = 'wrong_type:' + rule.type;
          continue;
        }
        if (typeof v === 'string') {
          if (rule.maxLen != null && v.length > rule.maxLen) {
            errors[field] = 'too_long_max_' + rule.maxLen;
            continue;
          }
          if (rule.minLen != null && v.length < rule.minLen) {
            errors[field] = 'too_short_min_' + rule.minLen;
            continue;
          }
          if (rule.pattern && !rule.pattern.test(v)) {
            errors[field] = 'pattern_mismatch';
            continue;
          }
          if (rule.enum && !rule.enum.includes(v)) {
            errors[field] = 'not_in_enum';
            continue;
          }
        }
        if (typeof v === 'number') {
          if (rule.min != null && v < rule.min) { errors[field] = 'below_min_' + rule.min; continue; }
          if (rule.max != null && v > rule.max) { errors[field] = 'above_max_' + rule.max; continue; }
          if (!Number.isFinite(v)) { errors[field] = 'not_finite'; continue; }
        }
      }
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ ok: false, error: 'validation_failed', fields: errors });
      }
      req.validBody = body;
      return handler(req, res);
    };
  };
}

/**
 * Enforce HTTPS — reject HTTP requests (Vercel terminates TLS, so x-forwarded-proto should always be https in production).
 */
export function requireHttps(handler) {
  return async function httpsOnly(req, res) {
    const proto = req.headers?.['x-forwarded-proto'];
    if (proto && proto !== 'https' && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ ok: false, error: 'https_required' });
    }
    return handler(req, res);
  };
}

/**
 * Limit allowed HTTP methods. Returns 405 for others.
 */
export function methods(...allowedMethods) {
  return function wrap(handler) {
    return async function methodGuard(req, res) {
      if (!allowedMethods.includes(req.method)) {
        res.setHeader('Allow', allowedMethods.join(', '));
        return res.status(405).json({ ok: false, error: 'method_not_allowed', allowed: allowedMethods });
      }
      return handler(req, res);
    };
  };
}
