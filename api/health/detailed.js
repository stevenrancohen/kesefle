// /api/health/detailed
//
// Operational health snapshot — runs end-to-end probes against every
// dependency and returns a structured report. Useful for the admin
// monitor dashboard and uptime services. Public read (no auth) so
// external uptime monitors can hit it; values are non-sensitive.
//
// Returns 200 even on partial failure with per-dependency status, so
// uptime services that match "200 OK" won't false-positive. The body
// contains the actual status.

import { withRequestId, log } from '../../lib/log.js';

async function probeKV() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, reason: 'not_configured' };
  const start = Date.now();
  try {
    const r = await fetch(`${url}/get/_healthprobe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function probeSheets() {
  // Just verify we can reach Google's Sheets API discovery endpoint;
  // we can't actually open a sheet without a user's access token.
  const start = Date.now();
  try {
    const r = await fetch('https://sheets.googleapis.com/$discovery/rest?version=v4', {
      method: 'HEAD',
    });
    return { ok: r.ok || r.status === 200, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function probeMeta() {
  // Public Facebook Graph health — no auth needed.
  const start = Date.now();
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/', { method: 'HEAD' });
    // Meta returns 400 on naked GET but the host is reachable; treat any
    // sub-500 as "Meta is up". 500+ means Meta itself is broken.
    return { ok: r.status < 500, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function probeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: 'skipped', reason: 'no_key_configured' };
  const start = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'HEAD' });
    return { ok: r.status < 500, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function probePaypal() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return { ok: 'skipped', reason: 'no_key_configured' };
  }
  const start = Date.now();
  try {
    // Default SANDBOX — must match api/billing/paypal.js's paypalBase() so the
    // health probe exercises the same environment billing actually uses.
    const base = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function probeCoinbase() {
  if (!process.env.COINBASE_COMMERCE_API_KEY) return { ok: 'skipped', reason: 'no_key_configured' };
  const start = Date.now();
  try {
    const r = await fetch('https://api.commerce.coinbase.com/checkouts', {
      headers: { 'X-CC-Api-Key': process.env.COINBASE_COMMERCE_API_KEY, 'X-CC-Version': '2018-03-22' },
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function handlerImpl(req, res) {
  const results = await Promise.all([
    probeKV(),
    probeSheets(),
    probeMeta(),
    probeAnthropic(),
    probePaypal(),
    probeCoinbase(),
  ]);
  const [kv, sheets, meta, anthropic, paypal, coinbase] = results;
  // Overall = "ok" only if every CRITICAL dep is up. Anthropic/payments
  // are not critical for the personal-tracker happy path; Meta + KV
  // + Sheets are.
  const critical = [kv, sheets, meta];
  const overall = critical.every(c => c.ok === true) ? 'ok' : 'degraded';
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    overall,
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
    dependencies: {
      kv,
      sheets,
      meta,
      anthropic,
      paypal,
      coinbase,
    },
  });
}

export default withRequestId(handlerImpl);
