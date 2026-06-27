import crypto from 'node:crypto';

const COOKIE_NAME = 'kefle_session';
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
  let secret;
  try { secret = getSecret(); } catch { return null; }
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
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
  const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  appendSetCookie(res, cookie);
}

export function requireUser(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return null;
  }
  return userId;
}
