// /api/health
// Reports liveness + dependency status. Useful for uptime monitoring (UptimeRobot, BetterUptime, etc.)
// Reports:
//   - basic: build version, deploy time, uptime
//   - deps: KV reachable, Google OAuth endpoint reachable, Sheets API reachable
//   - secrets: which env vars are configured (NEVER prints values)
//
// Returns 200 if all critical deps are up, 503 otherwise.
// Set Cache-Control: no-store so it's never cached.

async function checkKv() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, error: 'env_missing' };
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent('_health_probe')}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkGoogleOAuth() {
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo', { method: 'HEAD' });
    return { ok: r.status < 500, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkSheetsApi() {
  try {
    // OPTIONS request — checks reachability without an access token.
    const r = await fetch('https://sheets.googleapis.com/$discovery/rest?version=v4', { method: 'HEAD' });
    return { ok: r.status < 500, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

function envFlags() {
  return {
    google_client_id: !!process.env.GOOGLE_CLIENT_ID,
    google_client_secret: !!process.env.GOOGLE_CLIENT_SECRET,
    kv: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
    meta_verify_token: !!process.env.META_VERIFY_TOKEN,
    meta_app_secret: !!process.env.META_APP_SECRET,
    meta_phone_number_id: !!process.env.META_PHONE_NUMBER_ID,
    meta_access_token: !!process.env.META_ACCESS_TOKEN,
    template_sheet_id: !!process.env.KESEFLE_TEMPLATE_SHEET_ID,
    // Payments: PayPal + crypto (auto) and Bit/bank (manual). Stripe was removed.
    paypal_client_id: !!process.env.PAYPAL_CLIENT_ID,
    coinbase_commerce_api_key: !!process.env.COINBASE_COMMERCE_API_KEY,
    bit_payee_phone: !!process.env.BIT_PAYEE_PHONE,
    bank_transfer_details: !!process.env.BANK_TRANSFER_DETAILS,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const started = Date.now();
  const [kv, googleOauth, sheetsApi] = await Promise.all([
    checkKv(),
    checkGoogleOAuth(),
    checkSheetsApi(),
  ]);
  const env = envFlags();

  // Critical = KV + Google OAuth (without these, nothing works)
  const critical_ok = kv.ok && googleOauth.ok;

  const body = {
    ok: critical_ok,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    deployed_at: process.env.VERCEL_GIT_COMMIT_DATE || null,
    region: process.env.VERCEL_REGION || null,
    response_ms: Date.now() - started,
    deps: { kv, google_oauth: googleOauth, sheets_api: sheetsApi },
    env_configured: env,
  };

  return res.status(critical_ok ? 200 : 503).json(body);
}
