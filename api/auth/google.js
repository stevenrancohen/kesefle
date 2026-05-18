// Verifies Google ID tokens via JWKS (RS256). Production-grade per Google's docs.
// Env: GOOGLE_CLIENT_ID (required audience), KV_REST_API_URL, KV_REST_API_TOKEN.

import crypto from 'node:crypto';
import { rateLimit } from '../_lib/rateLimit.js';

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

let _jwksCache = null;
let _jwksCacheTime = 0;
async function fetchGoogleKeys() {
  const now = Date.now();
  if (_jwksCache && (now - _jwksCacheTime) < 3600_000) return _jwksCache;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('jwks fetch failed');
  const j = await r.json();
  _jwksCache = j.keys || [];
  _jwksCacheTime = now;
  return _jwksCache;
}

async function verifyGoogleIdToken(idToken, expectedAudience) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('unsupported alg');

  const keys = await fetchGoogleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');

  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = b64urlToBuf(signatureB64);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(data);
  if (!verifier.verify(pubKey, sig)) throw new Error('signature invalid');

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('bad issuer');
  }
  if (expectedAudience && payload.aud !== expectedAudience) throw new Error('audience mismatch');
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('token expired');
  if (Number(payload.iat) * 1000 > Date.now() + 60_000) throw new Error('token in future');

  return payload;
}

export default async function handler(req, res) {
  if (await rateLimit(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ ok: false, error: 'server misconfigured: GOOGLE_CLIENT_ID required' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const idToken = String(body?.credential || body?.id_token || '').trim();
  if (!idToken || idToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing credential' });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken, process.env.GOOGLE_CLIENT_ID);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'verification failed: ' + e.message });
  }

  const user = {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
    locale: payload.locale,
    provider: 'google',
    firstSeen: new Date().toISOString(),
  };

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/${encodeURIComponent('user:google:' + user.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
      await fetch(`${kvUrl}/sadd/users_all/${encodeURIComponent('google:' + user.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}` },
      });
    } catch (e) {
      console.error('KV write failed', e);
    }
  } else {
    console.log('USER_SIGNUP', JSON.stringify(user));
  }

  return res.status(200).json({ ok: true, user });
}
