// Vercel serverless function — records waitlist signups
// No external deps; stores in Vercel KV when KV_REST_API_URL is set, else logs.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = String(body?.email || '').trim().toLowerCase();
  const source = String(body?.source || 'unknown').slice(0, 64);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid email' });
  }

  const entry = {
    email,
    source,
    ts: new Date().toISOString(),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    ref: String(req.headers['referer'] || '').slice(0, 200),
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64),
  };

  // Vercel KV (Upstash Redis) — set up when deploying
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const id = `wait:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${kvToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(entry),
      });
      await fetch(`${kvUrl}/sadd/waitlist_emails/${encodeURIComponent(email)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}` },
      });
    } catch (err) {
      console.error('KV write failed', err);
    }
  } else {
    console.log('WAITLIST', JSON.stringify(entry));
  }

  return res.status(200).json({ ok: true });
}
