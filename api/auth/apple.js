// Verifies Apple Sign-In identity tokens (RS256 JWT against Apple JWKS).
// Env: APPLE_CLIENT_ID (Services ID), KV_REST_API_URL, KV_REST_API_TOKEN.

import crypto from 'node:crypto';

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

async function fetchAppleKeys() {
  const r = await fetch('https://appleid.apple.com/auth/keys');
  if (!r.ok) throw new Error('jwks fetch failed');
  const j = await r.json();
  return j.keys || [];
}

function jwkToPem(jwk) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return key;
}

async function verifyAppleIdToken(idToken, expectedAudience) {
  const [headerB64, payloadB64, signatureB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) throw new Error('malformed jwt');
  const header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));

  const keys = await fetchAppleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');

  const pubKey = jwkToPem(jwk);
  const data = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = b64urlToBuf(signatureB64);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(data);
  if (!verifier.verify(pubKey, sig)) throw new Error('signature invalid');

  if (payload.iss !== 'https://appleid.apple.com') throw new Error('bad issuer');
  if (expectedAudience && payload.aud !== expectedAudience) throw new Error('audience mismatch');
  if (Number(payload.exp) * 1000 < Date.now()) throw new Error('token expired');

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const idToken = String(body?.id_token || body?.identityToken || '').trim();
  const userFromClient = body?.user || null;
  if (!idToken) {
    return res.status(400).json({ ok: false, error: 'missing id_token' });
  }

  let payload;
  try {
    payload = await verifyAppleIdToken(idToken, process.env.APPLE_CLIENT_ID);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'verification failed: ' + e.message });
  }

  const user = {
    sub: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
    name: userFromClient?.name?.firstName
      ? [userFromClient.name.firstName, userFromClient.name.lastName].filter(Boolean).join(' ')
      : null,
    provider: 'apple',
    firstSeen: new Date().toISOString(),
  };

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/${encodeURIComponent('user:apple:' + user.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
      await fetch(`${kvUrl}/sadd/users_all/${encodeURIComponent('apple:' + user.sub)}`, {
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
