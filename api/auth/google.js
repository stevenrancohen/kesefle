// One-time/browser-session upgrade for a verified Google ID token.
//
// New users must use the PKCE flow in google-exchange.js so Kesefle receives
// drive.file consent and stores an encrypted refresh-token envelope. This
// endpoint exists for returning users and legacy cached PWAs: it verifies the
// short-lived ID token, confirms a canonical user:{sub} record already exists,
// and mints the HttpOnly session cookie without ever echoing the credential.

import { rateLimit } from '../_lib/rateLimit.js';
import { setSessionCookie } from '../_lib/session.js';
import { getGoogleClientId, verifyGoogleIdToken } from '../../lib/auth.js';
import { log } from '../../lib/log.js';

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function kvGetUser(kvUrl, kvToken, userSub) {
  const r = await fetch(`${kvUrl}/get/${encodeURIComponent('user:' + userSub)}`, {
    headers: { 'Authorization': `Bearer ${kvToken}` },
  });
  if (!r.ok) throw new Error('kv_get_user_status_' + r.status);
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSetUser(kvUrl, kvToken, userSub, record) {
  const r = await fetch(`${kvUrl}/set/${encodeURIComponent('user:' + userSub)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!r.ok) throw new Error('kv_set_user_status_' + r.status);
}

export default async function handler(req, res) {
  noStore(res);
  if (await rateLimit(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const idToken = String(body?.credential || body?.id_token || '').trim();
  if (!idToken || idToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing_credential' });
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken, getGoogleClientId());
  } catch (e) {
    log.warn('auth.session_upgrade_verify_failed', { reqId: req.reqId, error: e.message });
    return res.status(401).json({ ok: false, error: 'verification_failed' });
  }
  if (payload.email_verified !== true) {
    return res.status(403).json({ ok: false, error: 'email_not_verified' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(503).json({ ok: false, error: 'identity_store_unavailable' });
  }

  let existing;
  try {
    existing = await kvGetUser(kvUrl, kvToken, payload.sub);
  } catch (e) {
    log.error('auth.session_upgrade_lookup_failed', { reqId: req.reqId, userSub: payload.sub, error: e.message });
    return res.status(502).json({ ok: false, error: 'identity_lookup_failed' });
  }
  if (!existing) {
    return res.status(409).json({ ok: false, error: 'pkce_required' });
  }

  // Identity refresh is deliberately minimal and merge-only: paid plan,
  // encrypted refresh-token envelope, sheet IDs, referral state, and every
  // other server-owned field remain untouched. Remove a pre-migration
  // plaintext refresh token if the account happens to carry one.
  const record = {
    ...existing,
    userSub: payload.sub,
    email: payload.email || existing.email || '',
    name: payload.name || existing.name || '',
    picture: payload.picture || existing.picture || '',
    lastLoginAt: new Date().toISOString(),
  };
  delete record.refreshToken;

  try {
    await kvSetUser(kvUrl, kvToken, payload.sub, record);
    setSessionCookie(res, payload.sub);
  } catch (e) {
    log.error('auth.session_upgrade_commit_failed', { reqId: req.reqId, userSub: payload.sub, error: e.message });
    return res.status(502).json({ ok: false, error: 'session_upgrade_failed' });
  }

  return res.status(200).json({
    ok: true,
    user: {
      sub: payload.sub,
      email: record.email,
      name: record.name,
      picture: record.picture,
      plan: record.plan || 'free',
    },
  });
}
