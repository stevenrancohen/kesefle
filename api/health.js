// /api/health
// Reports liveness + dependency status. Useful for uptime monitoring (UptimeRobot, BetterUptime, etc.)
// Reports:
//   - basic: build version, deploy time, uptime
//   - deps: KV reachable, Google OAuth endpoint reachable, Sheets API reachable
//   - capabilities: coarse product readiness without exposing secret names
//
// Returns 200 if all critical deps are up, 503 otherwise.
// Set Cache-Control: no-store so it's never cached.

import {
  buildPublicCapabilities,
  createProbeCache,
  getCapabilityConfiguration,
  publicConfigurationSummary,
  readinessFromCapabilities,
} from '../lib/health-capabilities.js';

const PROBE_TIMEOUT_MS = 5_000;
const getCoreProbes = createProbeCache(30_000);

async function checkKv() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, error: 'env_missing' };
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent('_health_probe')}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: r.ok, status: r.status };
  } catch (_e) { return { ok: false, error: 'unreachable' }; }
}

async function checkGoogleOAuth() {
  try {
    // This is the endpoint the login verifier actually consumes. Unlike a
    // tokeninfo HEAD (which returns 404), it gives a real 200 + key set.
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = r.ok ? await r.json().catch(() => null) : null;
    return { ok: r.ok && Array.isArray(body?.keys), status: r.status };
  } catch (_e) { return { ok: false, error: 'unreachable' }; }
}

async function checkSheetsApi() {
  try {
    // HEAD returns 400 even when Sheets is healthy. GET is the documented
    // discovery path; cancel the ~390 KB body after validating the headers.
    const r = await fetch('https://sheets.googleapis.com/$discovery/rest?version=v4', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const contentType = r.headers.get('content-type') || '';
    const ok = r.status === 200 && /json/i.test(contentType);
    await r.body?.cancel().catch(() => {});
    return { ok, status: r.status };
  } catch (_e) { return { ok: false, error: 'unreachable' }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const started = Date.now();
  const { value: probes, cached: probeCached } = await getCoreProbes(() => Promise.all([
    checkKv(), checkGoogleOAuth(), checkSheetsApi(),
  ]));
  const [kv, googleOauth, sheetsApi] = probes;
  const config = getCapabilityConfiguration();

  // Sheets is part of the core product path. The probe requires a real 200 JSON
  // discovery response, so provider errors and local misconfiguration fail shut.
  const critical_ok = config.core && config.googleSheets
    && kv.ok && googleOauth.ok && sheetsApi.ok;
  const capabilities = buildPublicCapabilities(config, {
    kv,
    googleOauth,
    sheets: sheetsApi,
  });

  const body = {
    schema_version: 2,
    ok: critical_ok,
    status: critical_ok ? 'ok' : 'degraded',
    readiness: readinessFromCapabilities(capabilities),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    deployed_at: process.env.VERCEL_GIT_COMMIT_DATE || null,
    region: process.env.VERCEL_REGION || null,
    response_ms: Date.now() - started,
    probe_cached: probeCached,
    deps: { kv, google_oauth: googleOauth, sheets_api: sheetsApi },
    capabilities,
    env_configured: publicConfigurationSummary(config),
  };

  return res.status(critical_ok ? 200 : 503).json(body);
}
