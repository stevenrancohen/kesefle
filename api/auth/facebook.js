// Verifies Facebook access tokens (covers Instagram Business via Facebook Login).
// Env: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const accessToken = String(body?.accessToken || body?.access_token || '').trim();
  const userId = String(body?.userID || body?.userId || '').trim();
  if (!accessToken || accessToken.length < 20) {
    return res.status(400).json({ ok: false, error: 'missing access token' });
  }

  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;

  if (!appId || !appSecret) {
    return res.status(500).json({ ok: false, error: 'server misconfigured: FACEBOOK_APP_ID and FACEBOOK_APP_SECRET required' });
  }

  try {
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appId + '|' + appSecret)}`
    );
    const debug = await debugRes.json();
    if (!debug?.data?.is_valid) {
      return res.status(401).json({ ok: false, error: 'invalid facebook token' });
    }
    if (debug.data.app_id !== appId) {
      return res.status(401).json({ ok: false, error: 'token app mismatch' });
    }
    if (userId && debug.data.user_id !== userId) {
      return res.status(401).json({ ok: false, error: 'user id mismatch' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'debug_token failed' });
  }

  let profile;
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=id,name,email,picture&access_token=${encodeURIComponent(accessToken)}`
    );
    if (!r.ok) {
      return res.status(401).json({ ok: false, error: 'profile fetch failed' });
    }
    profile = await r.json();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'graph api error' });
  }

  const user = {
    sub: profile.id,
    email: profile.email || null,
    name: profile.name,
    picture: profile.picture?.data?.url || null,
    provider: 'facebook',
    firstSeen: new Date().toISOString(),
  };

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      await fetch(`${kvUrl}/set/${encodeURIComponent('user:facebook:' + user.sub)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
      });
      await fetch(`${kvUrl}/sadd/users_all/${encodeURIComponent('facebook:' + user.sub)}`, {
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
