// Shared, secret-safe capability model for the public health endpoints.
//
// Keep two concepts separate:
//   1. configured — the server has the complete env set needed to attempt work.
//   2. available  — a live probe verified the dependency on this request.
//
// Never return individual secret names from this module's public helpers. The
// admin-only bot-status endpoint is the right place for field-level setup help.

function present(value) {
  return typeof value === 'string' ? value.trim().length > 0 : !!value;
}

// Health routes are public and intentionally bypass the normal rate limiter so
// external uptime monitors always work. A short per-instance cache prevents a
// burst from fanning out into repeated provider calls (and paid API traffic).
export function createProbeCache(ttlMs = 30_000) {
  let cachedValue;
  let expiresAt = 0;
  let pending = null;

  return async function cachedProbe(run) {
    const now = Date.now();
    if (cachedValue !== undefined && now < expiresAt) {
      return { value: cachedValue, cached: true };
    }
    if (pending) return { value: await pending, cached: true };

    pending = Promise.resolve().then(run);
    try {
      cachedValue = await pending;
      expiresAt = Date.now() + ttlMs;
      return { value: cachedValue, cached: false };
    } finally {
      pending = null;
    }
  };
}

export function getCapabilityConfiguration(env = process.env) {
  const kv = present(env.KV_REST_API_URL) && present(env.KV_REST_API_TOKEN);
  const googleOauth = present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET);
  const googleSheets = googleOauth && present(env.KESEFLE_TEMPLATE_SHEET_ID);

  const whatsappCredentials = present(env.META_PHONE_NUMBER_ID)
    && present(env.META_ACCESS_TOKEN)
    && present(env.META_VERIFY_TOKEN)
    && present(env.META_APP_SECRET);
  const whatsappApproved = env.WABA_APPROVED === '1';
  const whatsapp = whatsappCredentials && whatsappApproved;

  const paypal = String(env.PAYPAL_ENV || '').toLowerCase() === 'live'
    && present(env.PAYPAL_CLIENT_ID)
    && present(env.PAYPAL_CLIENT_SECRET)
    && [
      env.PAYPAL_PLAN_PRO,
      env.PAYPAL_PLAN_FAMILY,
      env.PAYPAL_PLAN_PRO_YEAR,
      env.PAYPAL_PLAN_FAMILY_YEAR,
    ].every(present)
    && present(env.PAYPAL_WEBHOOK_ID);
  // A key without the webhook secret can accept money but cannot safely grant
  // the purchased plan, so it is not a usable payment rail.
  const coinbase = present(env.COINBASE_COMMERCE_API_KEY)
    && present(env.COINBASE_WEBHOOK_SECRET);
  const manualPayment = present(env.BIT_PAYEE_PHONE) || present(env.BANK_TRANSFER_DETAILS);

  return {
    core: kv && googleOauth,
    kv,
    googleOauth,
    googleSheets,
    whatsapp,
    whatsappCredentials,
    whatsappApproved,
    payments: paypal || coinbase || manualPayment,
    paypal,
    coinbase,
    manualPayment,
    email: present(env.RESEND_API_KEY),
    push: present(env.VAPID_PUBLIC_KEY)
      && present(env.VAPID_PRIVATE_KEY)
      && present(env.VAPID_SUBJECT_EMAIL),
  };
}

function probedStatus(configured, probe) {
  if (!configured) return 'not_configured';
  if (!probe) return 'configured';
  return probe.ok === true ? 'available' : 'degraded';
}

export function buildPublicCapabilities(config, probes = {}) {
  const coreProbe = probes.kv && probes.googleOauth
    ? { ok: probes.kv.ok === true && probes.googleOauth.ok === true }
    : null;

  let paymentsStatus = config.payments ? 'configured' : 'not_configured';
  if (config.payments && probes.detailed === true) {
    const verifiedAvailable = config.manualPayment
      || (config.paypal && probes.paypal?.ok === true)
      || (config.coinbase && probes.coinbase?.ok === true);
    const verifiedFailure = (config.paypal && probes.paypal?.ok === false)
      || (config.coinbase && probes.coinbase?.ok === false);
    paymentsStatus = verifiedAvailable ? 'available' : (verifiedFailure ? 'degraded' : 'configured');
  }

  return {
    web_app: { status: probedStatus(config.core, coreProbe) },
    google_sheets: { status: probedStatus(config.googleSheets, probes.sheets) },
    whatsapp: { status: probedStatus(config.whatsapp, probes.meta) },
    payments: { status: paymentsStatus },
    email: { status: config.email ? 'configured' : 'not_configured' },
    push: { status: config.push ? 'configured' : 'not_configured' },
  };
}

export function readinessFromCapabilities(capabilities) {
  const coreReady = capabilities.web_app.status === 'available'
    && capabilities.google_sheets.status === 'available';
  if (!coreReady) return 'degraded';

  const optional = ['whatsapp', 'payments', 'email', 'push'];
  return optional.every(name => ['available', 'configured'].includes(capabilities[name].status))
    ? 'ready'
    : 'limited';
}

// Temporary compatibility adapter for monitors that expect env_configured.
// It intentionally exposes only product-level groups, never secret names.
export function publicConfigurationSummary(config) {
  return {
    core: config.core,
    google_sheets: config.googleSheets,
    whatsapp: config.whatsapp,
    payments: config.payments,
    email: config.email,
    push: config.push,
  };
}
