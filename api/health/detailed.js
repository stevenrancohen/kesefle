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
import {
  buildPublicCapabilities,
  createProbeCache,
  getCapabilityConfiguration,
  publicConfigurationSummary,
  readinessFromCapabilities,
} from '../../lib/health-capabilities.js';

const PROBE_TIMEOUT_MS = 5_000;
const getDetailedProbes = createProbeCache(30_000);

async function probeKV() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, reason: 'not_configured' };
  const start = Date.now();
  try {
    const r = await fetch(`${url}/get/_healthprobe`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function probeGoogleOAuth() {
  const start = Date.now();
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = r.ok ? await r.json().catch(() => null) : null;
    return {
      ok: r.ok && Array.isArray(body?.keys),
      status: r.status,
      latencyMs: Date.now() - start,
    };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function probeSheets() {
  // Just verify we can reach Google's Sheets API discovery endpoint;
  // we can't actually open a sheet without a user's access token.
  const start = Date.now();
  try {
    const r = await fetch('https://sheets.googleapis.com/$discovery/rest?version=v4', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const contentType = r.headers.get('content-type') || '';
    const ok = r.status === 200 && /json/i.test(contentType);
    await r.body?.cancel().catch(() => {});
    return { ok, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function probeMeta() {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) return { ok: 'skipped', reason: 'not_configured' };
  const start = Date.now();
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=id`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function probeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: 'skipped', reason: 'no_key_configured' };
  const start = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.status < 500, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function probeCoinbase() {
  if (!process.env.COINBASE_COMMERCE_API_KEY || !process.env.COINBASE_WEBHOOK_SECRET) {
    return { ok: 'skipped', reason: 'not_configured' };
  }
  const start = Date.now();
  try {
    const r = await fetch('https://api.commerce.coinbase.com/checkouts', {
      headers: { 'X-CC-Api-Key': process.env.COINBASE_COMMERCE_API_KEY, 'X-CC-Version': '2018-03-22' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.ok, status: r.status, latencyMs: Date.now() - start };
  } catch (_e) {
    return { ok: false, error: 'unreachable', latencyMs: Date.now() - start };
  }
}

async function handlerImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ overall: 'error', error: 'method_not_allowed' });
  }
  const config = getCapabilityConfiguration();
  const { value: results, cached: probeCached } = await getDetailedProbes(() => Promise.all([
    probeKV(),
    probeGoogleOAuth(),
    probeSheets(),
    config.whatsapp ? probeMeta() : Promise.resolve({ ok: 'skipped', reason: 'not_configured' }),
    probeAnthropic(),
    config.paypal ? probePaypal() : Promise.resolve({ ok: 'skipped', reason: 'not_configured' }),
    config.coinbase ? probeCoinbase() : Promise.resolve({ ok: 'skipped', reason: 'not_configured' }),
  ]));
  const [kv, googleOauth, sheets, meta, anthropic, paypal, coinbase] = results;
  // WhatsApp, AI and payments are optional product capabilities. Their state
  // must be visible, but they must not turn the app liveness red.
  const critical = config.core && config.googleSheets ? [kv, googleOauth, sheets] : [];
  const overall = critical.length === 3 && critical.every(c => c.ok === true) ? 'ok' : 'degraded';
  const capabilities = buildPublicCapabilities(config, {
    detailed: true,
    kv,
    googleOauth,
    sheets,
    meta: config.whatsapp ? meta : null,
    paypal,
    coinbase,
  });
  res.status(200).json({
    schema_version: 2,
    overall,
    readiness: readinessFromCapabilities(capabilities),
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
    probe_cached: probeCached,
    dependencies: {
      kv,
      google_oauth: googleOauth,
      sheets,
      meta,
      anthropic,
      paypal,
      coinbase,
    },
    capabilities,
    env_configured: publicConfigurationSummary(config),
  });
}

export default withRequestId(handlerImpl);
