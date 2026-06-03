// api/account/unsubscribe.js
//
// Public, token-gated email unsubscribe — backs /unsubscribe.html, linked from
// the "ביטול הרשמה" footer of EVERY Kesefle email (welcome at signup, the
// day_1..day_30 lifecycle drip, weekly/monthly digests, win-back).
//
// Flow:
//   GET  /api/account/unsubscribe?sub=<sub>&t=<token>
//        -> { ok, valid, alreadyUnsubscribed, email? }   (page reads this to render)
//   POST /api/account/unsubscribe  { sub, t }
//        -> { ok, unsubscribed: true }                    (sets the suppression flag)
//
// The lifecycle + digest crons ALREADY honor user:{sub}.emailUnsubscribed
// (api/cron/lifecycle.js skips any flagged user). This endpoint is the missing
// piece that actually SETS the flag. Before it existed the link 404'd and the
// suppression switch could never be flipped — a CAN-SPAM / Israeli-privacy gap
// AND a broken link in the very first onboarding email.
//
// SECURITY: clicked from an email with no session cookie, so we authenticate
// with the HMAC token from lib/email-unsub.js (bound to the sub). Without it,
// ?sub= alone would let anyone unsubscribe anyone else. We rate-limit per IP to
// blunt token/sub enumeration. We DO NOT 404-distinguish "no such user" from
// "bad token" in the POST path — both return the same generic invalid response.
//
// Env: KV_REST_API_URL, KV_REST_API_TOKEN (+ the crypto keyring for token verify).

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { verifyUnsubscribeToken } from '../../lib/email-unsub.js';
import { auditLog } from '../../lib/secure-kv.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) {
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

function readSubAndToken(req, body) {
  // Accept from query (GET / link prefetch) or JSON body (POST).
  const sub = String((req.query && req.query.sub) || (body && body.sub) || '').trim();
  const token = String((req.query && (req.query.t || req.query.token)) || (body && (body.t || body.token)) || '').trim();
  return { sub, token };
}

async function handlerImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_unavailable' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { sub, token } = readSubAndToken(req, body);

  if (!sub) return res.status(400).json({ ok: false, error: 'missing_sub' });
  const valid = verifyUnsubscribeToken(sub, token);

  // === GET: status check the page uses to render the right state ===
  if (req.method === 'GET') {
    if (!valid) {
      // Don't leak whether the sub exists; the page shows a "confirm with the
      // button" affordance that POSTs (and will also fail closed) on bad token.
      return res.status(200).json({ ok: true, valid: false });
    }
    const userRec = await kvGet('user:' + sub);
    return res.status(200).json({
      ok: true,
      valid: true,
      alreadyUnsubscribed: !!(userRec && userRec.emailUnsubscribed),
      // First char + domain only, so the page can reassure ("...@gmail.com")
      // without rendering a full address from a URL param.
      email: userRec && userRec.email ? redactEmail(userRec.email) : null,
    });
  }

  // === POST: perform the unsubscribe ===
  if (!valid) {
    log.warn('unsubscribe.invalid_token', { reqId: req.reqId });
    return res.status(403).json({ ok: false, error: 'invalid_or_expired_link' });
  }

  const userRec = await kvGet('user:' + sub);
  if (!userRec) {
    // Valid HMAC but no record (deleted account, or KV miss). Treat as success
    // from the user's POV — there's nothing left to email them.
    return res.status(200).json({ ok: true, unsubscribed: true, note: 'no_active_record' });
  }

  if (userRec.emailUnsubscribed) {
    return res.status(200).json({ ok: true, unsubscribed: true, alreadyUnsubscribed: true });
  }

  // Read-merge-write so we preserve plan / tokens / referral / trial fields.
  userRec.emailUnsubscribed = true;
  userRec.emailUnsubscribedAt = new Date().toISOString();
  const saved = await kvSet('user:' + sub, userRec);
  if (!saved) {
    log.error('unsubscribe.kv_save_failed', { reqId: req.reqId });
    return res.status(502).json({ ok: false, error: 'save_failed', detail: 'נסו שוב בעוד רגע.' });
  }

  // 730-day audit trail (hashed sub, no PII) so the suppression is forensically
  // accountable — symmetric with the GDPR/billing actions already audited.
  auditLog('email_unsubscribe', sub, { source: 'email_link' }, { reqId: req.reqId }).catch(() => {});
  log.info('unsubscribe.done', { reqId: req.reqId });

  return res.status(200).json({ ok: true, unsubscribed: true });
}

function redactEmail(addr) {
  const s = String(addr || '');
  if (!s.includes('@')) return null;
  const [local, domain] = s.split('@');
  return `${local.charAt(0)}***@${domain}`;
}

// Per-IP rate limit blunts sub/token enumeration. 20/min is far above any
// legitimate use (a human clicks the link once) yet caps a scripted sweep.
export default withRequestId(
  withRateLimit({ key: 'email_unsubscribe', limit: 20, windowSec: 60 })(handlerImpl)
);
