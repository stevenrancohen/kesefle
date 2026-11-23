import crypto from 'node:crypto';

// The __Host- prefix is enforced by browsers: Secure, Path=/, and no Domain.
// That prevents a compromised sibling subdomain from shadowing the auth cookie.
// Read the legacy name during the migration window so existing users are not
// signed out; every successful login mints only the hardened cookie.
const COOKIE_NAME = '__Host-kefle_session';
const LEGACY_COOKIE_NAME = 'kefle_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const HEADER = { alg: 'HS256', typ: 'JWT' };
const HEADER_B64 = Buffer.from(JSON.stringify(HEADER)).toString('base64url');

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecodeToString(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(headerB64, payloadB64, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
}

function safeEqualB64Url(a, b) {
  const ab = Buffer.from(a, 'base64url');
  const bb = Buffer.from(b, 'base64url');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET env var required (min 16 chars)');
  }
  return s;
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header || typeof header !== 'string') return {};
  const out = {};
  header.split(/;\s*/).forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Ambient cookie credentials may be used only by the exact origin that owns
// them for state-changing requests. Keeping this guard in the session module
// protects direct getUserId() consumers as well as requireAuth() endpoints.
// Safe reads remain origin-agnostic; Bearer authentication is handled outside
// this module and does not depend on browser-supplied cookies.
export function isTrustedSessionMutation(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const fetchSite = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin') return false;

  const origin = String(req?.headers?.origin || '').trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const host = forwardedHost || String(req?.headers?.host || '').trim();
  if (!origin || !host) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() !== host.toLowerCase()) return false;
    if (parsed.protocol === 'https:') return true;
    return process.env.NODE_ENV !== 'production'
      && parsed.protocol === 'http:'
      && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.host);
  } catch (_e) {
    return false;
  }
}

function mintJwt(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { userId: String(userId), iat: now, exp: now + MAX_AGE_SECONDS };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(HEADER_B64, payloadB64, secret);
  return `${HEADER_B64}.${payloadB64}.${sig}`;
}

function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  try { header = JSON.parse(b64urlDecodeToString(h)); } catch { return null; }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  const expected = sign(h, p, secret);
  if (!safeEqualB64Url(expected, s)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecodeToString(p)); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
  if (!payload.userId || typeof payload.userId !== 'string') return null;
  return payload;
}

function appendSetCookie(res, value) {
  const prev = res.getHeader && res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', prev.concat(value));
  } else {
    res.setHeader('Set-Cookie', [prev, value]);
  }
}

export function getUserId(req) {
  if (!isTrustedSessionMutation(req)) return null;
  let secret;
  try { secret = getSecret(); } catch { return null; }
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME];
  if (!token) return null;
  const payload = verifyJwt(token, secret);
  if (!payload) return null;
  return payload.userId;
}

export function setSessionCookie(res, userId) {
  const secret = getSecret();
  const jwt = mintJwt(userId, secret);
  const cookie = `${COOKIE_NAME}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
  appendSetCookie(res, cookie);
}

export function clearSessionCookie(res) {
  appendSetCookie(res, `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  // Clear the pre-hardening cookie as well so logout remains complete for
  // sessions created before the __Host- migration.
  appendSetCookie(res, `${LEGACY_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export function requireUser(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return userId;
}
