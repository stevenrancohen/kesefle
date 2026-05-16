// /api/auth/google-exchange
// Exchanges a Google OAuth authorization code (from the browser-side PKCE flow)
// for access + refresh tokens. The refresh token is what enables the bot to write
// to the user's sheet long after their browser session ended.
//
// Front-end flow (replaces the current GIS-only flow in account.html):
//   1. Browser generates code_verifier + code_challenge (PKCE).
//   2. Browser redirects to:
//        https://accounts.google.com/o/oauth2/v2/auth
//          ?client_id=...&redirect_uri=https://kesefle.vercel.app/account
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

export default async function handler(req, res) {
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

  const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
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

  // Decode the ID token to extract user identity (sub, email, name, picture).
  // ID tokens are JWTs: header.payload.signature. Payload is base64url JSON.
  let identity = {};
  try {
    if (tokens.id_token) {
      const payload = tokens.id_token.split('.')[1];
      identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_id_token' });
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
      // Encrypt refresh token at rest (XOR with a server-side key is NOT secure — use a proper KMS in prod).
      // For now: store in KV with the assumption KV is access-controlled. TODO: AES-GCM with KEK from env.
      const record = {
        userSub: identity.sub,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        refreshToken: tokens.refresh_token,
        scopes: tokens.scope,
        connectedAt: new Date().toISOString(),
      };
      await fetch(`${kvUrl}/set/${encodeURIComponent('user:' + identity.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    } catch (e) {
      console.error('user_record_kv_save_failed', e);
      // Non-fatal — user can still proceed, but won't be able to use the bot without re-consenting.
    }
  }

  // Return identity + short-lived access token to the browser (NOT the refresh token).
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
  });
}
