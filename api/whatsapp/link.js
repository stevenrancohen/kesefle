// /api/whatsapp/link
//
// Flow for linking a user's WhatsApp number to their Kesefle account:
//
// 1. User on /account submits their E.164 phone → POST { phone } here with an authed accessToken
// 2. We verify the accessToken via tokeninfo, get the userSub
// 3. Generate a 6-digit code (e.g. 482917) + store {code → userSub} in KV with 10-min TTL
// 4. Return the code to the browser
// 5. Browser shows "Open WhatsApp and send: קוד 482917"
// 6. Bot webhook receives the message, sees "קוד 482917", calls /api/whatsapp/link?action=confirm
// 7. Server resolves code → userSub, then stores phone:<E164> → userSub permanently in KV
// 8. Bot writes to the user's sheet from then on
//
// Endpoints:
//   POST /api/whatsapp/link  { accessToken, phone }       → { ok, code, expiresIn }
//   POST /api/whatsapp/link?action=confirm { code, phone } → { ok, userSub, sheetId } (called by webhook)
//   GET  /api/whatsapp/link?phone=E164                    → { ok, linked: true/false, userSub? } (status check)
//
// Env: KV_REST_API_URL, KV_REST_API_TOKEN, GOOGLE_CLIENT_ID

import { withRequestId, log } from '../../lib/log.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { computeEntitlement } from '../../lib/subscription.js';
import { getUserId } from '../_lib/session.js';

// Sends a one-shot WhatsApp welcome to a freshly-linked user. Fire-and-forget
// from the confirm path — if Meta is down or the token has rotated, the link
// itself still succeeds; we just skip the welcome. Never throws upward.
async function sendWelcomeWhatsApp(phone, userRec, sheetRec) {
  const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    throw new Error('whatsapp_env_not_configured');
  }
  const sheetUrl = sheetRec?.spreadsheetUrl
    || (sheetRec?.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${sheetRec.spreadsheetId}/edit` : '');
  const body =
    'מצוין! 🎉 המספר הזה מחובר עכשיו לחשבון שלך.\n\n' +
    'נסה לשלוח לי הוצאה — לדוגמה:\n' +
    '• 45 קפה\n' +
    '• 230 סופר רמי לוי\n' +
    '• 1200 שכר דירה\n\n' +
    'אני אכניס הכל לגיליון שלך אוטומטית. 📊' +
    (sheetUrl ? `\n\n📄 הגיליון שלך:\n${sheetUrl}` : '');
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`meta_${resp.status}_${detail.slice(0, 120)}`);
  }
}

async function verifyAccessToken(accessToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!r.ok) throw new Error('tokeninfo_status_' + r.status);
  const info = await r.json();
  if (info.error) throw new Error('tokeninfo_error_' + info.error);
  if (!info.sub) throw new Error('tokeninfo_missing_sub');
  return info;
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value, ttlSec) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const path = ttlSec ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${url}/set/${encodeURIComponent(key)}`;
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

// Atomic set-if-not-exists via Upstash's `NX=true` modifier. Returns true if
// the key was set (claim won), false if the key already existed (claim lost).
// Used to atomically claim a phone -> user mapping so two confirm requests
// for the same E.164 can never both succeed.
async function kvSetNX(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}?NX=true`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) return false;
  // Upstash returns { result: "OK" } on set, { result: null } on key-exists.
  const j = await r.json().catch(() => ({}));
  return j?.result === 'OK' || j?.result === 1;
}

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

// E.164 normalization — strip everything except digits, add country code if missing.
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  // If it starts with 0 (e.g., 0541234567), assume Israel and prepend 972.
  if (s.startsWith('0')) s = '972' + s.slice(1);
  // Length sanity: 7-15 digits per E.164
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// Constant-time string comparison. Prevents timing-based leakage of a secret
// when comparing against a presented header value. Walks the longer string
// so the comparison time depends only on the larger length, not the index of
// the first differing byte.
//
// Out-of-bounds `charCodeAt` returns NaN; `NaN || 0 === 0`, so positions past
// the end of either string contribute 0 to `diff` (but the initial
// `la ^ lb` already accumulates a non-zero `diff` for any length mismatch).
function constantTimeEqual(a, b) {
  const la = a.length, lb = b.length;
  let diff = la ^ lb;
  const max = Math.max(la, lb);
  for (let i = 0; i < max; i++) {
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

// Cryptographically-safe, UNBIASED 6-digit code (100000-999999).
// The old `100000 + (buf[0] % 900000)` form is biased because 2^32 is not
// divisible by 900000 -- the lowest 232 of 900000 buckets each got one extra
// candidate value, so an attacker brute-forcing codes could narrow the search
// space slightly. Rejection sampling: draw, accept if in the unbiased window
// (< floor(2^32 / 900000) * 900000), otherwise redraw. Expected redraws < 1.0.
function gen6DigitCode() {
  const LIMIT = 900000;
  const MAX = 0xFFFFFFFF;
  const BIASED_TOP = Math.floor((MAX + 1) / LIMIT) * LIMIT;
  const buf = new Uint32Array(1);
  let n;
  for (let tries = 0; tries < 8; tries++) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      buf[0] = Math.floor(Math.random() * MAX);
    }
    n = buf[0];
    if (n < BIASED_TOP) break;
  }
  return String(100000 + (n % LIMIT));
}

async function handlerImpl(req, res) {
  // Per-method/action rate limiting. The status-check GET is POLLED by the
  // browser while waiting for code confirmation -- with the adaptive cadence
  // (6s fast / 15s slow / 3min cap) that's ~15 polls per user. We SKIP the
  // KV-backed rate limit for GET to save ~30 KV commands per user since the
  // GET is read-only and already returns minimal info to anonymous callers
  // (only {linked} -- see auth-gate added 2026-05-23 for billing fields).
  // The mint (POST) and confirm (POST + bot-secret) paths keep their limits.
  if (req.method !== 'GET') {
    const act = (req.query.action || 'request').toLowerCase();
    const conf = act === 'confirm'
      ? { key: 'wa_link_confirm', limit: 120, windowSec: 600 }   // bot-secret gated
      : { key: 'wa_link_request', limit: 30, windowSec: 600 };   // code minting
    const rl = await rateLimit(req, conf);
    res.setHeader('X-RateLimit-Limit', String(conf.limit));
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter || conf.windowSec));
      return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: rl.retryAfter || conf.windowSec });
    }
  }

  // GET — status check: is this phone already linked?
  //
  // PRIVACY: this endpoint is queried in two patterns:
  //   (a) the browser polls every 4s during onboarding to learn "did the bot
  //       confirm my code?" -- needs only { ok, linked }
  //   (b) the bot calls it server-side on every WhatsApp message to find the
  //       tenant by phone -- needs userSub + sheetId, AND plan/premium so
  //       _hasActivePremium_ can gate AI/OCR without an extra round trip
  //
  // Anonymous callers (no x-kesefle-bot-secret header) get the MINIMAL routing
  // response. Bot callers (with a matching secret) get the rich response that
  // includes billing fields. This prevents directory enumeration where an
  // attacker iterates phone numbers to learn who is a Kesefle user + their
  // plan tier, while leaving the bot's existing call pattern intact (the bot
  // sends the secret -- update bot to add the header on next deploy).
  if (req.method === 'GET') {
    const phone = normalizeE164(req.query.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    // If the bot announced its build version via header, stash the latest
    // (with TTL) so /api/admin/bot-version can compare it to the repo. We
    // only set this on bot-secret-authenticated calls to avoid spoofing.
    const presentedSecret = req.headers['x-kesefle-bot-secret'] || '';
    const botSecret = process.env.KESEFLE_BOT_SECRET;
    const isBotCaller = !!botSecret && constantTimeEqual(String(presentedSecret), String(botSecret));
    const botVersion = req.headers['x-kesefle-bot-version'];
    if (isBotCaller && botVersion && typeof botVersion === 'string' && botVersion.length < 80) {
      // Fire-and-forget; never block the bot's response on this telemetry.
      kvSet('bot_version_latest', { version: botVersion, at: Date.now() }, 86400 * 7).catch(() => {});
    }

    const rec = await kvGet(`phone:${phone}`);
    if (!rec) return res.status(200).json({ ok: true, linked: false });

    if (!isBotCaller) {
      // Anonymous (browser polling) -- minimal response, no billing leak.
      return res.status(200).json({ ok: true, linked: true });
    }

    // Bot path: full record incl. effective plan from the canonical user
    // record (the phone-record can lag behind plan changes by one Stripe
    // webhook). computeEntitlement reports an active 14-day trial as 'pro'.
    let entitlement = computeEntitlement(rec);
    if (rec.userSub) {
      try {
        const userRec = await kvGet(`user:${rec.userSub}`);
        if (userRec) entitlement = computeEntitlement(userRec);
      } catch (_e) {}
    }
    return res.status(200).json({
      ok: true,
      linked: true,
      userSub: rec.userSub,
      sheetId: rec.spreadsheetId,
      // `plan` is the EFFECTIVE plan (trial → 'pro'); `rawPlan` is the literal
      // stored plan for billing/diagnostics.
      plan: entitlement.effectivePlan,
      rawPlan: entitlement.rawPlan,
      premium: entitlement.premium,
      subscriptionStatus: entitlement.status,
      trialDaysLeft: entitlement.trial.daysLeft,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const action = (req.query.action || 'request').toLowerCase();

  // === CONFIRM action — called by the bot webhook when it sees "קוד 482917" ===
  if (action === 'confirm') {
    const code = String(body?.code || '').trim();
    const phone = normalizeE164(body?.phone);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code_format' });
    if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    // Only the bot should call this — protect with a shared secret. We
    // fail closed: if KESEFLE_BOT_SECRET is not configured the endpoint
    // refuses all confirm calls, because without it anyone could write
    // arbitrary phone→userSub mappings into KV.
    const expected = process.env.KESEFLE_BOT_SECRET;
    if (!expected) {
      log.error('link.confirm.secret_not_configured', { reqId: req.reqId });
      return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
    }
    const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
    if (botSecret !== expected) {
      log.warn('link.confirm.unauthorized', { reqId: req.reqId });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const pending = await kvGet(`linkCode:${code}`);
    if (!pending) return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });

    const userSub = pending.userSub;

    // SECURITY: bind the code to the phone the account-holder entered at
    // REQUEST time. The 6-digit code is the only secret tying a phone to an
    // account, so a leaked/shoulder-surfed code must not let a DIFFERENT
    // phone link itself to the victim's account. Backward-compatible: codes
    // issued before this field existed carry no pending.phone and are allowed.
    if (pending.phone) {
      const boundPhone = normalizeE164(pending.phone);
      if (boundPhone && boundPhone !== phone) {
        log.warn('link.confirm.phone_mismatch', {
          reqId: req.reqId, expectedPhone: boundPhone, gotPhone: phone, userSub,
        });
        return res.status(409).json({ ok: false, error: 'code_bound_to_different_phone' });
      }
    }

    // Look up the user's sheet to attach to the phone mapping.
    const sheetRec = await kvGet(`sheet:${userSub}`);
    const userRec = await kvGet(`user:${userSub}`) || {};

    // Permanent mapping: phone → user record (with sheet info for fast bot lookup)
    const permRec = {
      userSub,
      email: userRec.email || '',
      plan: userRec.plan || 'free',
      spreadsheetId: sheetRec?.spreadsheetId || userRec.spreadsheetId || null,
      spreadsheetUrl: sheetRec?.spreadsheetUrl || userRec.spreadsheetUrl || null,
      linkedAt: new Date().toISOString(),
    };

    // ATOMIC claim: SETNX (set-if-not-exists) eliminates the TOCTOU race where
    // two confirm calls for the same phone within the same second both pass
    // the "is it free?" check and the later write silently overwrites the
    // earlier one. If SETNX fails, the key already exists -- either the same
    // user is re-linking (idempotent, OK) or a different user beat us to it
    // (409). We re-read after the failed claim to decide.
    const claimed = await kvSetNX(`phone:${phone}`, permRec);
    if (!claimed) {
      const existingPhone = await kvGet(`phone:${phone}`);
      if (existingPhone && existingPhone.userSub && existingPhone.userSub !== userSub) {
        log.warn('link.confirm.phone_race_lost', {
          reqId: req.reqId, phone, existingUserSub: existingPhone.userSub, attemptedUserSub: userSub,
        });
        // Cleanup the pending code so the loser cannot brute-force a re-claim
        // by repeatedly hitting confirm with the same code.
        await kvDel(`linkCode:${code}`).catch(() => {});
        return res.status(409).json({ ok: false, error: 'phone_already_linked_to_another_account' });
      }
      // Same-user re-link: refresh the record (linkedAt + plan may have changed).
      await kvSet(`phone:${phone}`, permRec);
    }

    // Reverse mapping: user → phone (so /account can detect "linked" state)
    await kvSet(`userPhone:${userSub}`, { phone, linkedAt: permRec.linkedAt });

    // Cleanup the pending code
    await kvDel(`linkCode:${code}`);

    // Welcome the freshly-linked user so they see the bot work immediately
    // (instead of having to send their first expense to discover it does).
    // Non-fatal: if the send fails (token issue, etc.) the link itself
    // still succeeds — the user will simply not see the welcome.
    sendWelcomeWhatsApp(phone, userRec, sheetRec).catch(err => {
      log.warn('link.confirm.welcome_send_failed', { reqId: req.reqId, error: err.message });
    });

    return res.status(200).json({
      ok: true,
      userSub,
      email: permRec.email,
      sheetId: permRec.spreadsheetId,
      sheetUrl: permRec.spreadsheetUrl,
    });
  }

  // === REQUEST action (default) — user requests a linking code ===
  const phone = normalizeE164(body?.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'invalid_phone' });
  }

  // AUTH: prefer the login SESSION cookie (set at sign-in, valid 30 days) so the
  // link step never depends on the short-lived (~1h) Google ACCESS token — a
  // stale access token was the cause of `invalid_access_token` at this step.
  // Fall back to verifying an access token from the body for session-less calls.
  let userSub = getUserId(req);
  if (!userSub) {
    const accessToken = String(body?.accessToken || '').trim();
    if (!accessToken || accessToken.length < 20) {
      return res.status(401).json({ ok: false, error: 'not_signed_in' });
    }
    try {
      const tokenInfo = await verifyAccessToken(accessToken);
      userSub = tokenInfo.sub;
    } catch (e) {
      log.warn('link.request.token_invalid', { reqId: req.reqId, error: e.message });
      return res.status(401).json({ ok: false, error: 'session_expired' });
    }
  }

  // Already linked? Tell the user so they don't generate a new code unnecessarily.
  const existing = await kvGet(`userPhone:${userSub}`);
  if (existing && existing.phone === phone) {
    return res.status(200).json({ ok: true, alreadyLinked: true, phone });
  }

  // Reject up-front if this phone already belongs to a different account.
  // Surfacing the error here (instead of only at confirm time) saves the
  // user from typing a code that will never work, and keeps audit-log noise
  // localized to one origin per attempted hijack.
  const phoneRec = await kvGet(`phone:${phone}`);
  if (phoneRec && phoneRec.userSub && phoneRec.userSub !== userSub) {
    log.warn('link.request.phone_already_linked', {
      reqId: req.reqId, phone, existingUserSub: phoneRec.userSub, requestingUserSub: userSub,
    });
    return res.status(409).json({ ok: false, error: 'phone_already_linked_to_another_account' });
  }

  // Generate a new code + store with 10-min TTL.
  const code = gen6DigitCode();
  const codeRec = {
    userSub,
    phone, // suggested phone — bot doesn't strictly need this since it sees the sender's phone
    createdAt: new Date().toISOString(),
  };
  const ok = await kvSet(`linkCode:${code}`, codeRec, 600); // 10 min TTL
  if (!ok) return res.status(500).json({ ok: false, error: 'kv_unavailable' });

  // Do NOT log the code itself — it's the secret that binds a phone to an account.
  log.info('link.code_issued', { reqId: req.reqId, userSub });
  return res.status(200).json({
    ok: true,
    code,
    expiresIn: 600, // seconds
    instructions: `שלח לבוט הודעה: "קוד ${code}"`,
  });
}

export default withRequestId(handlerImpl);
