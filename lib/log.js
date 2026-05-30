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
