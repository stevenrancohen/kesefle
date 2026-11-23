/* Runtime regression test for POST /api/auth/google.
 * A fresh, signed legacy Google ID token may upgrade an EXISTING canonical
 * account to the HttpOnly cookie, but must never create a Drive-less account
 * or overwrite server-owned billing/refresh-token fields.
 */
const crypto = require('node:crypto');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.error('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function signJwt(privateKey, kid, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + body);
  return header + '.' + body + '.' + signer.sign(privateKey).toString('base64url');
}

(async function run() {
  console.log('\n=== legacy ID-token to HttpOnly session upgrade ===');
  const oldFetch = global.fetch;
  const oldEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    SESSION_SECRET: process.env.SESSION_SECRET,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  };
  process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-bytes';
  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'kv-token';

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  let currentUser = {
    userSub: 'user-123',
    email: 'old@example.com',
    name: 'Old Name',
    plan: 'pro',
    refreshToken: 'legacy-plaintext-must-go',
    refreshTokenEnvelope: 'v1:encrypted:keep',
    spreadsheetId: 'sheet-keep',
    stripeCustomerId: 'stripe-keep',
  };
  let writtenUser = null;

  global.fetch = async function fakeFetch(url, options = {}) {
    const u = String(url);
    if (u === 'https://www.googleapis.com/oauth2/v3/certs') return jsonResponse({ keys: [jwk] });
    if (u === 'https://kv.test/pipeline') return jsonResponse([{ result: 1 }, { result: 1 }]);
    if (u.startsWith('https://kv.test/get/')) {
      return jsonResponse({ result: currentUser ? JSON.stringify(currentUser) : null });
    }
    if (u.startsWith('https://kv.test/set/')) {
      writtenUser = JSON.parse(options.body);
      currentUser = writtenUser;
      return jsonResponse({ result: 'OK' });
    }
    throw new Error('unexpected fetch ' + u);
  };

  try {
    const handler = (await import('../api/auth/google.js?test=' + Date.now())).default;
    const now = Math.floor(Date.now() / 1000);
    const basePayload = {
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      sub: 'user-123',
      email: 'fresh@example.com',
      email_verified: true,
      name: 'Fresh Name',
      picture: 'https://example.test/avatar.png',
      iat: now - 10,
      exp: now + 3600,
    };
    const token = signJwt(privateKey, jwk.kid, basePayload);
    const res = response();
    await handler({ method: 'POST', url: '/api/auth/google', headers: { 'x-forwarded-for': '203.0.113.1' }, body: { credential: token }, reqId: 'test-1' }, res);

    const cookie = String(res.getHeader('Set-Cookie') || '');
    check('existing canonical user receives a session cookie', res.statusCode === 200 && /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie));
    check('response exposes presentation profile only',
      res.body?.ok === true && res.body.user?.sub === 'user-123'
        && !JSON.stringify(res.body).includes(token)
        && !('refreshTokenEnvelope' in res.body.user));
    check('server-owned fields survive the identity refresh',
      writtenUser?.plan === 'pro' && writtenUser?.refreshTokenEnvelope === 'v1:encrypted:keep'
        && writtenUser?.spreadsheetId === 'sheet-keep' && writtenUser?.stripeCustomerId === 'stripe-keep');
    check('legacy plaintext refresh token is removed', !('refreshToken' in writtenUser));

    currentUser = null;
    writtenUser = null;
    const unknownRes = response();
    const unknownToken = signJwt(privateKey, jwk.kid, { ...basePayload, sub: 'unknown-user' });
    await handler({ method: 'POST', url: '/api/auth/google', headers: { 'x-forwarded-for': '203.0.113.2' }, body: { credential: unknownToken }, reqId: 'test-2' }, unknownRes);
    check('unknown user is sent through full PKCE instead of being half-created',
      unknownRes.statusCode === 409 && unknownRes.body?.error === 'pkce_required'
        && !unknownRes.getHeader('Set-Cookie') && writtenUser === null);

    const unverifiedRes = response();
    const unverifiedToken = signJwt(privateKey, jwk.kid, { ...basePayload, email_verified: false });
    await handler({ method: 'POST', url: '/api/auth/google', headers: { 'x-forwarded-for': '203.0.113.3' }, body: { credential: unverifiedToken }, reqId: 'test-3' }, unverifiedRes);
    check('unverified Google email is rejected', unverifiedRes.statusCode === 403 && unverifiedRes.body?.error === 'email_not_verified');
    check('auth response is never cacheable', /no-store/.test(String(res.getHeader('Cache-Control'))) && res.getHeader('Pragma') === 'no-cache');
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
