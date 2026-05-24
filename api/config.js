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

// Default to the Meta test number until Steven configures KESEFLE_BOT_NUMBER
// via the env var (after WABA approval). Same default lives hardcoded across
// the ~45 wa.me/ anchors -- swap with scripts/swap-bot-number.sh + this env
// var simultaneously for a clean cutover.
const DEFAULT_BOT_NUMBER = '15556408123';

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const botNumber = String(process.env.KESEFLE_BOT_NUMBER || DEFAULT_BOT_NUMBER).replace(/\D+/g, '');
  const botDisplayName = String(process.env.KESEFLE_BOT_NAME || "כספ'לה");

  // Cache for 60s -- changes propagate within a minute, but we don't pay for
  // every page load to hit a serverless function.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    ok: true,
    BOT_NUMBER: botNumber,
    BOT_NUMBER_DISPLAY: '+' + botNumber.replace(/(\d{1,3})(\d{3})(\d{3})(\d{4})/, '$1 $2 $3 $4'),
    BOT_NAME: botDisplayName,
    // Drift signal: did the env override the default? Useful for the admin
    // drift detector to know whether the hardcoded HTML anchors are still
    // accurate or have been overtaken by an env change.
    bot_number_is_default: botNumber === DEFAULT_BOT_NUMBER,
    // Surface a hint about whether features that depend on a real WABA are
    // available. Steven sets this env var to '1' once Meta approves.
    waba_approved: process.env.WABA_APPROVED === '1',
    // Analytics tracking IDs. Public values -- safe to expose. Frontend uses
    // these to lazy-init GA4 + Meta Pixel without baking the IDs into HTML.
    ga4_id: process.env.GA4_MEASUREMENT_ID || '',
    meta_pixel_id: process.env.META_PIXEL_ID || '',
    tiktok_pixel_id: process.env.TIKTOK_PIXEL_ID || '',
  });
}

export default withRequestId(handlerImpl);
