// Public endpoint backing /win-back.html.
//
// A claim token is an opaque 14-day AES-GCM envelope. After decryption we can
// read the exact user key directly, bind the offer to the cancellation record,
// and atomically create one pending admin action. No identity-prefix token and
// no KV keyspace scan are involved. The former predictable 24-character links
// are intentionally hard-cut rather than kept alive behind a temporary SCAN;
// their error response directs the customer to support for a reissued offer.

import { withRequestId, log, subHash } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { sendAlert } from '../../lib/alert.js';
import { verifyWinbackToken, WinbackTokenError } from '../../lib/winback-token.js';
import { randomUUID } from 'node:crypto';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CLAIM_TTL_SEC = 365 * 24 * 60 * 60;

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  let response;
  try {
    response = await fetch(`${KV_URL}${path}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (error) {
    return { ok: false, networkError: error.message };
  }
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, ...(json && typeof json === 'object' ? json : {}) };
}

async function kvGetJson(key) {
  const result = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!result.ok) return { ok: false, status: result.status, value: null };
  if (result.result == null) return { ok: true, value: null };
  if (typeof result.result === 'object') return { ok: true, value: result.result };
  try {
    let value = JSON.parse(result.result);
    // The previous claim endpoint serialized its record before passing it to
    // a helper that serialized again. Unwrap at most one legacy JSON-string
    // layer so that old successful claims remain replay-safe.
    if (typeof value === 'string') value = JSON.parse(value);
    return { ok: true, value };
  }
  catch (_e) { return { ok: false, corrupt: true, value: null }; }
}

async function kvSetNxEx(key, value, ttlSec) {
  const result = await kvFetch(
    `/set/${encodeURIComponent(key)}?NX=true&EX=${Number(ttlSec)}`,
    { method: 'POST', body: value },
  );
  if (!result.ok) return { ok: false, inserted: false, status: result.status };
  if (result.result === 'OK') return { ok: true, inserted: true };
  // Upstash returns an explicit JSON null when NX loses. A missing result
  // field can also mean a committed write whose response body was truncated,
  // so it must enter claim_id reconciliation rather than skip the alert.
  if (Object.prototype.hasOwnProperty.call(result, 'result') && result.result === null) {
    return { ok: true, inserted: false };
  }
  return { ok: false, inserted: false, ambiguous: true };
}

function cancellationMatches(record, expectedIso) {
  try { return new Date(record?.cancelled_at).toISOString() === expectedIso; }
  catch (_e) { return false; }
}

function isCurrentClaim(record, offer) {
  return Boolean(record?.claimed_at)
    && String(record.userSub || '') === offer.userSub
    && cancellationMatches(record, offer.cancelledAt)
    && Number(record.discount_pct) === 50;
}

function isLegacyClaim(record, offer) {
  return Boolean(record?.claimed_at)
    && !record.cancelled_at
    && String(record.userSub || '') === offer.userSub
    && Number(record.discount_pct) === 50;
}

function replayResponse(res, record) {
  return res.status(200).json({
    ok: true,
    already_claimed: true,
    claimed_at: record.claimed_at,
    note: 'ההנחה כבר נרשמה. נציג יחזור אליך בקרוב.',
  });
}

function alreadyUsedResponse(res) {
  return res.status(409).json({
    ok: false,
    error: 'offer_already_used',
    detail: 'ההצעה כבר נוצלה עבור ביטול קודם. אם לדעתך זו טעות, אפשר לפנות אלינו ב-info@kesefle.com.',
  });
}

export async function handlerImpl(req, res, deps = {}) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_e) { body = {}; } }
  const token = String(body?.token || '').trim();

  let offer;
  try {
    offer = verifyWinbackToken(token, { nowMs: deps.nowMs ?? Date.now() });
  } catch (error) {
    const expired = error instanceof WinbackTokenError && error.code === 'expired_token';
    return res.status(expired ? 410 : 400).json({
      ok: false,
      error: expired ? 'token_expired' : 'invalid_token',
      detail: expired
        ? 'תוקף ההצעה הסתיים. אפשר לפנות אלינו ב-info@kesefle.com.'
        : 'הקישור לא תקף. אפשר לפנות אלינו ב-info@kesefle.com.',
    });
  }

  const exitResult = await kvGetJson(`exit_survey:${offer.userSub}`);
  if (!exitResult.ok) {
    log.error('winback.exit_survey_read_failed', { reqId: req.reqId, sub: subHash(offer.userSub) });
    return res.status(503).json({ ok: false, error: 'temporarily_unavailable' });
  }
  if (!exitResult.value
    || String(exitResult.value.userSub || '') !== offer.userSub
    || !cancellationMatches(exitResult.value, offer.cancelledAt)) {
    log.warn('winback.cancellation_mismatch', { reqId: req.reqId, sub: subHash(offer.userSub) });
    return res.status(404).json({
      ok: false,
      error: 'offer_not_found',
      detail: 'הקישור לא תקף או שאינו תואם לביטול האחרון.',
    });
  }

  const claimedAt = new Date(deps.nowMs ?? Date.now()).toISOString();
  // claim_id lets us distinguish our own committed write from an older claim
  // if Upstash persists SET NX but its HTTP response is lost in transit.
  const claimId = (deps.randomUUIDFn || randomUUID)();
  const record = {
    claim_id: claimId,
    userSub: offer.userSub,
    cancelled_at: offer.cancelledAt,
    offer_issued_at: offer.issuedAt,
    offer_expires_at: offer.expiresAt,
    claimed_at: claimedAt,
    discount_pct: 50,
    discount_months: 0,
    status: 'pending_admin_action',
  };
  const claimKey = `winback:${offer.userSub}`;
  const write = await kvSetNxEx(claimKey, record, CLAIM_TTL_SEC);
  let recoveredOwnWrite = false;
  if (!write.ok) {
    // A failed or unfamiliar HTTP response does not prove the write failed.
    // Read the exact key back: only this request's random claim_id may be
    // promoted to success and continue to the operator alert.
    const reconciliation = await kvGetJson(claimKey);
    if (reconciliation.ok
      && reconciliation.value?.claim_id === claimId
      && isCurrentClaim(reconciliation.value, offer)) {
      recoveredOwnWrite = true;
      log.warn('winback.claim_write_reconciled', { reqId: req.reqId, sub: subHash(offer.userSub) });
    } else if (reconciliation.ok && (isCurrentClaim(reconciliation.value, offer) || isLegacyClaim(reconciliation.value, offer))) {
      return replayResponse(res, reconciliation.value);
    } else if (reconciliation.ok && reconciliation.value?.claimed_at) {
      return alreadyUsedResponse(res);
    } else {
      log.error('winback.claim_write_failed', { reqId: req.reqId, sub: subHash(offer.userSub) });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable' });
    }
  }

  if (!write.inserted && !recoveredOwnWrite) {
    const existing = await kvGetJson(claimKey);
    if (existing.ok && (isCurrentClaim(existing.value, offer) || isLegacyClaim(existing.value, offer))) {
      return replayResponse(res, existing.value);
    }
    if (existing.ok && existing.value?.claimed_at) {
      return alreadyUsedResponse(res);
    }
    return res.status(503).json({ ok: false, error: 'temporarily_unavailable' });
  }

  const userResult = await kvGetJson(`user:${offer.userSub}`);
  const user = userResult.ok ? userResult.value : null;
  log.info('winback.claim_recorded', { reqId: req.reqId, sub: subHash(offer.userSub) });

  const alertFn = deps.sendAlertFn || sendAlert;
  try {
    // Await the alert attempt so a serverless runtime cannot freeze first.
    // The durable winback:* record remains the admin inbox source of truth if
    // every alert channel is unavailable.
    await alertFn({
      severity: 'info',
      title: `🎁 WINBACK CLAIM ${subHash(offer.userSub)}`,
      body: `userSub ${offer.userSub} (${user?.email || 'unknown email'}) claimed the 50% lifetime winback discount.\n\nApply manually in PayPal admin: discount their subscription 50% on the NEXT renewal. Then send them a "ברוך השב" WhatsApp message.`,
      tags: ['winback', 'revenue-recovery'],
    });
  } catch (error) {
    log.warn('winback.claim_alert_failed', { reqId: req.reqId, sub: subHash(offer.userSub), error: error?.message });
  }

  return res.status(200).json({
    ok: true,
    claimed_at: claimedAt,
    note: 'ההנחה נרשמה. נציג יחזור אליך בוואטסאפ עם הצעד הבא.',
  });
}

export default withRequestId(
  withRateLimit({ key: 'winback_claim', limit: 30, windowSec: 3600 })(handlerImpl)
);
