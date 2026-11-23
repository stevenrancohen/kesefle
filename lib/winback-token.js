// Opaque, expiring win-back offer tokens.
//
// The token is an AES-256-GCM envelope produced by the existing crypto
// keyring. It carries the user and the exact cancellation event, but exposes
// neither in the URL. Purpose-specific AAD prevents a ciphertext issued for a
// different feature from being accepted here.

import { encrypt, decrypt } from './crypto.js';

export const WINBACK_TOKEN_TTL_SEC = 14 * 24 * 60 * 60;
const WINBACK_TOKEN_AAD = 'kesefle:winback-offer:v1';
const MAX_TOKEN_LENGTH = 2048;
const CLOCK_SKEW_SEC = 5 * 60;

export class WinbackTokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WinbackTokenError';
    this.code = code;
  }
}

function canonicalCancellation(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new WinbackTokenError('invalid_cancellation');
  return date.toISOString();
}

export function createWinbackToken({ userSub, cancelledAt, nowMs = Date.now() }) {
  const sub = String(userSub || '').trim();
  if (!sub || sub.length > 255) throw new WinbackTokenError('invalid_subject');
  if (!Number.isFinite(nowMs)) throw new WinbackTokenError('invalid_time');

  const iat = Math.floor(nowMs / 1000);
  const payload = {
    v: 1,
    sub,
    cancelledAt: canonicalCancellation(cancelledAt),
    iat,
    exp: iat + WINBACK_TOKEN_TTL_SEC,
  };
  return encrypt(JSON.stringify(payload), { aad: WINBACK_TOKEN_AAD });
}

export function verifyWinbackToken(token, { nowMs = Date.now() } = {}) {
  const raw = String(token || '').trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) throw new WinbackTokenError('invalid_token');

  let payload;
  try {
    payload = JSON.parse(decrypt(raw, { aad: WINBACK_TOKEN_AAD }));
  } catch (_e) {
    throw new WinbackTokenError('invalid_token');
  }

  const nowSec = Math.floor(nowMs / 1000);
  const validShape = payload
    && payload.v === 1
    && typeof payload.sub === 'string'
    && payload.sub.length > 0
    && payload.sub.length <= 255
    && typeof payload.cancelledAt === 'string'
    && Number.isInteger(payload.iat)
    && Number.isInteger(payload.exp)
    && payload.exp - payload.iat === WINBACK_TOKEN_TTL_SEC;
  if (!validShape) throw new WinbackTokenError('invalid_token');

  let cancelledAt;
  try { cancelledAt = canonicalCancellation(payload.cancelledAt); }
  catch (_e) { throw new WinbackTokenError('invalid_token'); }
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) throw new WinbackTokenError('invalid_token');
  if (payload.exp <= nowSec) throw new WinbackTokenError('expired_token');

  return {
    userSub: payload.sub,
    cancelledAt,
    issuedAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}
