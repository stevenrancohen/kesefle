// api/admin/config-drift.js
//
// Admin-only: detects when the bot number env var (KESEFLE_BOT_NUMBER) has
// diverged from the hardcoded number in the HTML pages. Useful right after
// Steven flips the env var to a new WABA number -- this surfaces "you
// forgot to run scripts/swap-bot-number.sh; the static anchors still point
// to the old number, only the JS-driven ones use the new one."
//
// Fetches /api/config to learn the configured number, then fetches the
// homepage HTML and greps for hardcoded `wa.me/<digits>` to compare.
//
// Returns { drift: bool, configured, hardcoded, mismatchCount }.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Self-fetch config (same deployment, no auth needed).
  const origin = req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : 'https://kesefle.com';
  let configured = null;
  try {
    const r = await fetch(`${origin}/api/config`);
    const j = await r.json();
    configured = String(j.BOT_NUMBER || '').replace(/\D+/g, '');
  } catch (e) {
    log.warn('config_drift.config_fetch_failed', { reqId: req.reqId, error: e.message });
  }

  // Fetch homepage and count hardcoded wa.me anchors.
  let hardcodedNumbers = {};
  let totalHardcoded = 0;
  try {
    const r = await fetch(`${origin}/`);
    const html = await r.text();
    const matches = html.matchAll(/wa\.me\/(\d{10,15})/g);
    for (const m of matches) {
      const n = m[1];
      hardcodedNumbers[n] = (hardcodedNumbers[n] || 0) + 1;
      totalHardcoded++;
    }
  } catch (e) {
    log.warn('config_drift.html_fetch_failed', { reqId: req.reqId, error: e.message });
  }

  const numbersFound = Object.keys(hardcodedNumbers);
  const drift = configured && numbersFound.length > 0
    && !numbersFound.every((n) => n === configured);

  // Mismatched count = anchors that aren't pointing at the configured number.
  let mismatchCount = 0;
  if (configured) {
    Object.entries(hardcodedNumbers).forEach(([n, count]) => {
      if (n !== configured) mismatchCount += count;
    });
  }

  return res.status(200).json({
    ok: true,
    drift,
    configured,
    hardcoded: {
      total: totalHardcoded,
      unique_numbers: numbersFound,
      mismatch_count: mismatchCount,
    },
    fix_instructions: drift
      ? `Run: scripts/swap-bot-number.sh ${configured} && git add -A && git commit -m 'chore: sync bot number to ${configured}' && git push`
      : null,
  });
}

export default withRequestId(requireAdmin(handlerImpl));
