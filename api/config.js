// api/config.js
//
// Runtime-config endpoint. Returns the small subset of environment-driven
// values that the frontend needs (bot phone number, feature flags, etc.)
// in a single GET so client code doesn't have to hardcode them.
//
// Cached aggressively (60s s-maxage) so this doesn't blow KV / function-
// invocation budgets during the launch spike.
//
// All values returned MUST be safe to expose to the public (no secrets).

import { withRequestId } from '../lib/log.js';
import { publicWaConfig } from '../lib/wa-config.js';

// The real 360dialog production WhatsApp Business number. Same default lives
// hardcoded across the wa.me/ anchors site-wide. KESEFLE_BOT_NUMBER can still
// override it via env for a future renumber without a redeploy.
// Default now lives in lib/wa-config.js (DEFAULT_PUBLIC_BOT_NUMBER).

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const wa = publicWaConfig(process.env); // WA_PHONE_E164 > KESEFLE_BOT_NUMBER > default
  const botNumber = wa.BOT_NUMBER;
  const botDisplayName = String(process.env.KESEFLE_BOT_NAME || "כספ'לה");

  const botNumberDisplay = wa.BOT_NUMBER_DISPLAY;

  // Cache for 60s -- changes propagate within a minute, but we don't pay for
  // every page load to hit a serverless function.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    ok: true,
    BOT_NUMBER: botNumber,
    BOT_NUMBER_DISPLAY: botNumberDisplay,
    BOT_NAME: botDisplayName,
    BOT_WA_LINK: wa.BOT_WA_LINK,
    // Drift signal: did the env override the default? Useful for the admin
    // drift detector to know whether the hardcoded HTML anchors are still
    // accurate or have been overtaken by an env change.
    bot_number_is_default: wa.bot_number_is_default,
    // Surface a hint about whether features that depend on a real WABA are
    // available. Steven sets this env var to '1' once Meta approves.
    waba_approved: process.env.WABA_APPROVED === '1',
    // Analytics tracking IDs. Public values -- safe to expose. Frontend uses
    // these to lazy-init GA4 + Meta Pixel without baking the IDs into HTML.
    ga4_id: process.env.GA4_MEASUREMENT_ID || '',
    meta_pixel_id: process.env.META_PIXEL_ID || '',
    tiktok_pixel_id: process.env.TIKTOK_PIXEL_ID || '',
    // VAPID public key for Web Push subscriptions. Safe to expose to the
    // browser -- it's the applicationServerKey for PushManager.subscribe().
    // The matching PRIVATE key (VAPID_PRIVATE_KEY) is server-only and is
    // read by lib/push.js to sign the push request. Empty string if the
    // owner hasn't generated the keypair yet (push then degrades gracefully:
    // the dashboard hides the enable-push card; lib/push.js fails soft).
    vapid_public_key: process.env.VAPID_PUBLIC_KEY || '',
  });
}

export default withRequestId(handlerImpl);
