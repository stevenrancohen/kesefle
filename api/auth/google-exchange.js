// /api/auth/google-exchange
// Exchanges a Google OAuth authorization code (from the browser-side PKCE flow)
// for access + refresh tokens. The refresh token is what enables the bot to write
// to the user's sheet long after their browser session ended.
//
// Front-end flow (replaces the current GIS-only flow in account.html):
//   1. Browser generates code_verifier + code_challenge (PKCE).
//   2. Browser redirects to:
//        https://accounts.google.com/o/oauth2/v2/auth
//          ?client_id=...&redirect_uri=https://kesefle.com/account
//          &response_type=code
//          &access_type=offline       <-- this gives us a refresh token
//          &prompt=consent            <-- forces refresh token on re-grant
//          &scope=openid email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets
//          &code_challenge=...&code_challenge_method=S256
//          &state=<csrf-random>
//   3. Google redirects back to /account?code=...&state=...
//   4. Browser POSTs { code, codeVerifier, redirectUri } to this endpoint.
//   5. Server exchanges with Google, returns { idToken (for identity), accessToken (short-lived) }.
//      The refresh token is NEVER returned to the browser — stored server-side only.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN

import { verifyGoogleIdToken } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { encryptRefreshToken } from '../../lib/crypto.js';
import { setSessionCookie } from '../_lib/session.js';
import { getGoogleClientId } from '../../lib/auth.js';
import { newUserTrialFields } from '../../lib/subscription.js';

async function kvSetTokenRecord(kvUrl, kvToken, userSub, record) {
  await fetch(`${kvUrl}/set/${encodeURIComponent('token:' + userSub)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

async function kvGetSheetId(kvUrl, kvToken, userSub) {
  try {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent('sheet:' + userSub)}`, {
      headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    const j = await r.json();
    if (j?.result) {
      const parsed = JSON.parse(j.result);
      return parsed.spreadsheetId || null;
    }
  } catch (e) {
    log.warn('token_record.sheet_lookup_failed', { error: e.message });
  }
  return null;
}

// Fetch the existing canonical user record so we can MERGE into it rather than
// clobber it. Critical because the OAuth flow uses prompt=consent, so Google
// hands us a refresh_token on every login — and the old code rebuilt the record
// from scratch each time, wiping plan / stripeCustomerId / subscriptionStatus /
// trial fields for any returning (especially paying) user.
async function kvGetUser(kvUrl, kvToken, userSub) {
  try {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent('user:' + userSub)}`, {
      headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    const j = await r.json();
    if (j?.result) return JSON.parse(j.result);
  } catch (e) {
    log.warn('user_record.lookup_failed', { error: e.message });
  }
  return null;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const code = String(body?.code || '').trim();
  const codeVerifier = String(body?.codeVerifier || '').trim();
  const redirectUri = String(body?.redirectUri || '').trim();

  if (!code) return res.status(400).json({ ok: false, error: 'missing code' });
  if (!codeVerifier) return res.status(400).json({ ok: false, error: 'missing codeVerifier' });
  if (!redirectUri) return res.status(400).json({ ok: false, error: 'missing redirectUri' });

  const clientId = getGoogleClientId();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) {
    return res.status(500).json({ ok: false, error: 'server misconfigured: GOOGLE_CLIENT_SECRET missing' });
  }

  // Exchange the code for tokens
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  let tokens;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    tokens = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: 'token_exchange_failed',
        detail: tokens.error_description || tokens.error,
      });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'google_token_endpoint_unreachable', detail: e.message });
  }

  // CRITICAL FIX (C3): Verify ID token signature against Google's JWKS using RS256.
  // The previous code decoded the JWT payload WITHOUT verifying the signature, which
  // would allow a forged JWT to populate the user record with an arbitrary sub claim.
  let identity = {};
  try {
    if (!tokens.id_token) throw new Error('no_id_token_in_response');
    identity = await verifyGoogleIdToken(tokens.id_token, clientId);
    log.info('exchange.verified', { reqId: req.reqId, userSub: identity.sub });
  } catch (e) {
    log.warn('exchange.verify_failed', { reqId: req.reqId, error: e.message });
    return res.status(400).json({ ok: false, error: 'id_token_verification_failed', detail: e.message });
  }

  if (!identity.sub) {
    return res.status(400).json({ ok: false, error: 'id_token_missing_sub' });
  }

  // Store the refresh token in KV (only on first consent — Google omits refresh_token on subsequent grants
  // unless prompt=consent was forced).
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (tokens.refresh_token && kvUrl && kvToken) {
    try {
      // SECURITY: Encrypt refresh token at rest using AES-256-GCM with AAD bound to userSub.
      // The AAD binding means even if an attacker swaps the envelope between user records,
      // decryption fails (the userSub in the AAD won't match the new record's userSub).
      let refreshTokenEnvelope = null;
      try {
        refreshTokenEnvelope = encryptRefreshToken(tokens.refresh_token, identity.sub);
      } catch (e) {
        log.error('refresh_token_encrypt_failed', { reqId: req.reqId, error: e.message });
        // Fail closed if encryption is misconfigured — refusing to store plaintext.
        return res.status(500).json({ ok: false, error: 'token_encryption_unavailable' });
      }
      // MERGE into the existing record (don't clobber). Preserves plan,
      // stripeCustomerId, subscriptionStatus, referral data, etc. on re-login.
      const existing = await kvGetUser(kvUrl, kvToken, identity.sub);
      const isNewUser = !existing;
      const nowIso = new Date().toISOString();
      const record = {
        ...(existing || {}),
        userSub: identity.sub,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        // NOTE: refreshToken (plaintext) is NEVER stored anymore. Only the encrypted envelope.
        refreshTokenEnvelope,
        scopes: tokens.scope,
        connectedAt: existing?.connectedAt || nowIso,
        lastLoginAt: nowIso,
      };
      // Start a 14-day Pro trial exactly once, at first signup. Guarded on
      // trialEndsAt absence so we never reset a trial or override a paid plan.
      if (isNewUser && !record.trialEndsAt && !record.stripeSubscriptionId) {
        Object.assign(record, newUserTrialFields(Date.now()));
        log.info('user.trial_started', { reqId: req.reqId, userSub: identity.sub });
      }
      await fetch(`${kvUrl}/set/${encodeURIComponent('user:' + identity.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    } catch (e) {
      console.error('user_record_kv_save_failed', e);
    }
  }

  if (kvUrl && kvToken && tokens.access_token) {
    try {
      const existingSheetId = await kvGetSheetId(kvUrl, kvToken, identity.sub);
      const tokenRecord = {
        refreshToken: tokens.refresh_token || null,
        accessToken: tokens.access_token,
        expiry: Date.now() + 3500 * 1000,
        sheetId: existingSheetId,
      };
      await kvSetTokenRecord(kvUrl, kvToken, identity.sub, tokenRecord);
    } catch (e) {
      log.error('token_record_save_failed', { reqId: req.reqId, error: e.message });
    }
  }

  try {
    setSessionCookie(res, identity.sub);
  } catch (e) {
    log.error('session_cookie_failed', { reqId: req.reqId, error: e.message });
  }

  return res.status(200).json({
    ok: true,
    user: {
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
    },
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    hasRefreshToken: !!tokens.refresh_token,
    redirect: '/dashboard',
  });
}

// Security: request ID → rate limit (10 exchanges/hour per IP).
// Auth NOT required here — this endpoint IS the auth flow's exchange step.
export default withRequestId(
  withRateLimit({ key: 'oauth_exchange', limit: 10, windowSec: 3600 })(handlerImpl)
);
