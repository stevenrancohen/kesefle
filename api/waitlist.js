// Vercel serverless function — records waitlist signups
// No external deps; stores in Vercel KV when KV_REST_API_URL is set, else logs.
// Rate limit: 5 requests per IP per hour, 3 requests per email per hour (KV-backed).

const RATE_LIMIT_IP_PER_HOUR = 5;
const RATE_LIMIT_EMAIL_PER_HOUR = 3;

async function checkRateLimit(kvUrl, kvToken, key, limit) {
  // Token-bucket via INCR + EXPIRE. Returns { ok: boolean, remaining: number }.
  try {
    const r = await fetch(`${kvUrl}/incr/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
    });
    const j = await r.json();
    const count = j?.result ?? 0;
    if (count === 1) {
      // First hit — set TTL of 1 hour
      await fetch(`${kvUrl}/expire/${encodeURIComponent(key)}/3600`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${kvToken}` },
      });
    }
    return { ok: count <= limit, count, limit };
  } catch (e) {
    // Fail open (don't block legitimate users on KV outage)
    return { ok: true, count: 0, limit, kvError: e.message };
  }
}

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

  // Rate limiting (per IP + per email)
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) || 'unknown';
    const ipKey = `rl:wait:ip:${ip}`;
    const emailKey = `rl:wait:em:${email}`;
    const ipLimit = await checkRateLimit(kvUrl, kvToken, ipKey, RATE_LIMIT_IP_PER_HOUR);
    if (!ipLimit.ok) {
      return res.status(429).json({ ok: false, error: 'rate_limit_ip', retry_after: '3600' });
    }
    const emailLimit = await checkRateLimit(kvUrl, kvToken, emailKey, RATE_LIMIT_EMAIL_PER_HOUR);
    if (!emailLimit.ok) {
      return res.status(429).json({ ok: false, error: 'rate_limit_email', retry_after: '3600' });
    }
  }

  const entry = {
    email,
    source,
    ts: new Date().toISOString(),
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    ref: String(req.headers['referer'] || '').slice(0, 200),
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64),
  };

  // Vercel KV (Upstash Redis) — already validated above. Re-using kvUrl/kvToken from rate-limit block.
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
