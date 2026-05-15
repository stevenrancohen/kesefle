// Verifies Google ID tokens and stores user profile.
// Env: GOOGLE_CLIENT_ID (audience to verify), KV_REST_API_URL, KV_REST_API_TOKEN.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const idToken = String(body?.credential || body?.id_token || '').trim();
  if (!idToken || idToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing credential' });
  }

  let tokenInfo;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!r.ok) {
      return res.status(401).json({ ok: false, error: 'invalid id_token' });
    }
    tokenInfo = await r.json();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'token verification failed' });
  }

  const expectedAud = process.env.GOOGLE_CLIENT_ID;
  if (expectedAud && tokenInfo.aud !== expectedAud) {
    return res.status(401).json({ ok: false, error: 'audience mismatch' });
  }
  if (tokenInfo.iss !== 'https://accounts.google.com' && tokenInfo.iss !== 'accounts.google.com') {
    return res.status(401).json({ ok: false, error: 'bad issuer' });
  }
  if (Number(tokenInfo.exp) * 1000 < Date.now()) {
    return res.status(401).json({ ok: false, error: 'token expired' });
  }

  const user = {
    sub: tokenInfo.sub,
    email: tokenInfo.email,
    emailVerified: tokenInfo.email_verified === 'true' || tokenInfo.email_verified === true,
    name: tokenInfo.name,
    picture: tokenInfo.picture,
    locale: tokenInfo.locale,
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
