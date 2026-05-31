// lib/log.js
// Structured logging with PII redaction. Production-safe — never logs secrets.
//
// Usage:
//   import { log, withRequestId } from '../lib/log.js';
//   log.info('user.signin', { userSub: 'abc123', ip: '1.2.3.4' });  // safe
//   log.error('write.failed', { error: e.message, refreshToken: 'xxx' });  // refreshToken auto-redacted
//
// Designed for Vercel + Sentry envelope forwarding (free of npm).

const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /apikey/i,
  /api_key/i,
  /access_?token/i,
  /refresh_?token/i,
  /id_?token/i,
  /authorization/i,
  /credit/i,
  /card/i,
  /cvv/i,
  /ssn/i,
  // PII — phone numbers, emails, invite/verification codes, Google sub.
  // These are personal data under GDPR / Israeli PPL and must not land
  // in Vercel's plaintext log retention.
  /phone/i,
  /email/i,
  /^code$/i,
  /usersub/i,
  /user_sub/i,
  // 2026-05-29 resweep R2: spreadsheetId is a per-user private Drive file
  // identifier. Leaking it in logs would let anyone with log access
  // construct a Drive URL pointing at a user's sheet (it would 403 without
  // the user's grant, but it's still PII leakage).
  /spreadsheet/i,
  /sheetid/i,
  /sheet_id/i,
];

function isSecretKey(key) {
  if (typeof key !== 'string') return false;
  return SECRET_KEY_PATTERNS.some((rx) => rx.test(key));
}

function redactValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (v.length <= 4) return '***';
    return v.slice(0, 4) + '...[REDACTED:' + v.length + ']';
  }
  if (typeof v === 'number') return '***';
  return '[REDACTED]';
}

export function redact(obj, depth = 0) {
  if (depth > 5) return '[depth limit]';
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k)) out[k] = redactValue(v);
    else if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '...[truncated:' + v.length + ']';
    else if (typeof v === 'object') out[k] = redact(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

function emit(level, event, context = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(context),
  };
  // Vercel captures console.log and ships to Vercel Logs (paid plan: also to Sentry/Datadog).
  // We use stringified JSON so log aggregators can parse cleanly.
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event, ctx) => emit('debug', event, ctx),
  info: (event, ctx) => emit('info', event, ctx),
  warn: (event, ctx) => emit('warn', event, ctx),
  error: (event, ctx) => emit('error', event, ctx),
  fatal: (event, ctx) => emit('fatal', event, ctx),
};

// Generate a unique request ID. Use Vercel's x-vercel-id if available, else random.
export function getRequestId(req) {
  return req?.headers?.['x-vercel-id'] ||
         req?.headers?.['x-request-id'] ||
         ('req_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6));
}

// 2026-05-31 audit follow-up (docs/AUDIT_WEEKLY_DIGEST_AND_CRONS_2026_05_31.md §1):
// Google OAuth `sub` is a stable opaque identifier — logging it raw lets anyone
// with log access correlate every log line back to a specific user record.
// Convert to an 8-char sha256 prefix so we still get a stable cross-line
// identifier without exposing the raw sub. Cron handlers should use:
//   log.warn('cron.X.failed', { sub: subHash(userSub), error: e.message })
// instead of `{ userSub, ... }` which the redactor already redacts but leaves
// the field name in place. Returns 'null' for empty / null input.
export function subHash(userSub) {
  if (!userSub) return 'null';
  // Lazy-import crypto so the module remains usable in environments that
  // don't ship node:crypto (this file is also referenced by frontend bundles).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(String(userSub)).digest('hex').slice(0, 8);
  } catch (_e) {
    // Fallback for environments without node:crypto: a tiny non-cryptographic
    // hash. Acceptable because raw subs are never exposed; the hash is purely
    // an identifier for log correlation.
    let h = 5381;
    const s = String(userSub);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
  }
}

// Wraps a handler to set X-Request-Id response header + add reqId to log context.
export function withRequestId(handler) {
  return async function wrapped(req, res) {
    const reqId = getRequestId(req);
    res.setHeader('X-Request-Id', reqId);
    req.reqId = reqId;
    const t0 = Date.now();
    try {
      const result = await handler(req, res);
      log.info('http.ok', { reqId, method: req.method, url: req.url, ms: Date.now() - t0, status: res.statusCode });
      return result;
    } catch (e) {
      log.error('http.error', { reqId, method: req.method, url: req.url, ms: Date.now() - t0, error: e.message, stack: e.stack?.slice(0, 500) });
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'internal_error', reqId });
      }
    }
  };
}
