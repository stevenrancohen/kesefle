// api/billing/winback-claim.js
//
// Public endpoint backing /win-back.html. Validates the token (= first 24
// chars of the user's userSub, sent in the win-back email), records the
// claim, alerts Steven, and returns success. Steven manually applies the
// 50% lifetime discount in PayPal admin.
//
// POST body: { token: '<userSub.slice(0,24)>' }
// Rate limit: 30 / hour / IP (defends against token enumeration).

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { sendAlert } from '../../lib/alert.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}

async function kvScan(pattern) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 20; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const token = String(body?.token || '').trim();
  // PR-S (2026-05-27 security audit Bug #7): token MUST be exactly 24 chars.
  // The earlier `length < 8 || length > 64` window was too loose. Paired with
  // the `startsWith` removal below, this enforces exact-prefix match.
  if (token.length !== 24) {
    return res.status(400).json({ ok: false, error: 'invalid_token' });
  }

  // Token = first 24 chars of userSub. We can't reverse a hash here -- we
  // resolve by scanning exit_survey:* records (a 30d-cancelled user is the
  // only valid claim source). Scoped scan is cheap because exit_survey:*
  // is small (one entry per cancellation).
  const exitKeys = await kvScan('exit_survey:*');
  let matchedSub = null;
  for (const k of exitKeys) {
    const sub = k.replace('exit_survey:', '');
    // PR-S (2026-05-27 security audit Bug #7): drop the `sub.startsWith(token)`
    // arm. With it, a 8-char token would forge-match anyone whose userSub
    // begins with those chars. Exact 24-char prefix match only.
    if (sub.slice(0, 24) === token) {
      matchedSub = sub;
      break;
    }
  }
  if (!matchedSub) {
    log.warn('winback.token_no_match', { reqId: req.reqId, tokenPrefix: token.slice(0, 8) });
    return res.status(404).json({ ok: false, error: 'token_not_found', detail: 'הקישור לא תקף או שכבר הופעל. צור איתנו קשר ב-info@kesefle.com' });
  }

  // Idempotency: already claimed?
  const existing = await kvGet(`winback:${matchedSub}`);
  if (existing?.claimed_at) {
    return res.status(200).json({
      ok: true,
      already_claimed: true,
      claimed_at: existing.claimed_at,
      note: 'ההנחה כבר הופעלה. נציג יחזור אליך בקרוב.',
    });
  }

  // Record the claim. Steven manually applies the PayPal discount via /admin
  // -- safer than auto-modifying a subscription from a public endpoint with
  // a weak token.
  const record = {
    userSub: matchedSub,
    claimed_at: new Date().toISOString(),
    discount_pct: 50,
    discount_months: 0, // 0 = forever (until they cancel)
    status: 'pending_admin_action',
  };
  await kvFetch(`/set/${encodeURIComponent('winback:' + matchedSub)}?EX=${365 * 24 * 3600}`, {
    method: 'POST',
    body: JSON.stringify(record),
  });

  // Fetch user info for the alert.
  const user = await kvGet(`user:${matchedSub}`);

  log.info('winback.claim_recorded', { reqId: req.reqId, userSub: matchedSub });
  sendAlert({
    severity: 'info',
    title: '🎁 WINBACK CLAIM',
    body: `userSub ${matchedSub} (${user?.email || 'unknown email'}) claimed the 50% lifetime winback discount.\n\nApply manually in PayPal admin: discount their subscription 50% on the NEXT renewal. Then send them a "ברוך השב" WhatsApp message.`,
    tags: ['winback', 'revenue-recovery'],
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    claimed_at: record.claimed_at,
    note: 'ההנחה נרשמה. נציג יחזור אליך בוואטסאפ עם הצעד הבא.',
  });
}

export default withRequestId(
  withRateLimit({ key: 'winback_claim', limit: 30, windowSec: 3600 })(handlerImpl)
);
