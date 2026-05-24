#!/usr/bin/env node
// scripts/gen-vapid-keys.mjs
//
// Generates a fresh VAPID keypair for Web Push.
//
// Usage:
//   node scripts/gen-vapid-keys.mjs
//
// Output:
//   VAPID_PUBLIC_KEY   (base64url, 65 raw bytes: 0x04 || X || Y)
//   VAPID_PRIVATE_KEY  (base64url, 32 raw bytes: d scalar)
//   VAPID_SUBJECT_EMAIL (suggestion -- override with your own contact)
//
// Steven: run once, paste the three values into Vercel env (Production +
// Preview). The PUBLIC key is exposed to the browser via /api/config. The
// PRIVATE key NEVER leaves the server -- only lib/push.js reads it.
//
// Zero dependencies. Uses node:crypto P-256 / ECDH primitives that web-push
// expects per RFC 8292 (VAPID). Keys do NOT need to be rotated unless
// compromised; rotating invalidates EVERY existing PushSubscription so users
// would have to re-subscribe.

import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// P-256 keypair via the synchronous API (we want a deterministic single run).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

// Web Push expects the public key as the RAW uncompressed point: 0x04 || X || Y
// (65 bytes). Node's JWK export gives base64url-encoded X and Y separately;
// we concatenate them with the 0x04 prefix.
const jwkPub = publicKey.export({ format: 'jwk' });
const x = Buffer.from(jwkPub.x, 'base64url');
const y = Buffer.from(jwkPub.y, 'base64url');
if (x.length !== 32 || y.length !== 32) {
  console.error('Unexpected coordinate length -- regenerate.');
  process.exit(1);
}
const rawPub = Buffer.concat([Buffer.from([0x04]), x, y]);

// Private key: the raw 32-byte 'd' scalar.
const jwkPriv = privateKey.export({ format: 'jwk' });
const d = Buffer.from(jwkPriv.d, 'base64url');
if (d.length !== 32) {
  console.error('Unexpected scalar length -- regenerate.');
  process.exit(1);
}

const pubB64 = b64url(rawPub);
const privB64 = b64url(d);

console.log('');
console.log('Generated VAPID keypair for Kesefle Web Push.');
console.log('Paste these three values into Vercel env (Production + Preview):');
console.log('');
console.log('--- VAPID_PUBLIC_KEY ---');
console.log(pubB64);
console.log('');
console.log('--- VAPID_PRIVATE_KEY ---');
console.log(privB64);
console.log('');
console.log('--- VAPID_SUBJECT_EMAIL ---');
console.log('mailto:info@kesefle.com');
console.log('');
console.log('Notes:');
console.log('  - VAPID_PUBLIC_KEY is exposed to browsers via /api/config (safe).');
console.log('  - VAPID_PRIVATE_KEY is read ONLY by api/push/* and lib/push.js (server-side).');
console.log('  - VAPID_SUBJECT_EMAIL must be either a mailto: or https: URL (RFC 8292).');
console.log('  - Rotating these keys invalidates ALL existing PushSubscriptions.');
console.log('');
