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
import { createHmac } from 'node:crypto';
import { rateLimit } from '../../lib/ratelimit.js';
import { computeEntitlement, withReferralCredit } from '../../lib/subscription.js';
import { getUserId } from '../_lib/session.js';
// Canonical constant-time compare (audit M2,
// docs/AUDIT_API_ENDPOINT_SECURITY_2026_05_31.md): shared lib/crypto.js helper
// (wraps crypto.timingSafeEqual) instead of a local copy, so the primitive
// only has to be hardened in one place.
import { constantTimeEqual } from '../../lib/crypto.js';

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

async function _linkJsonWithDeadline_(url, init = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('link_io_timeout'));
    }, Math.max(10, Number(timeoutMs) || 3000));
  });
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const payload = await response.json();
        return { response, payload };
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function _deletionGuardKey_(userSub) {
  const secret = process.env.KV_REST_API_TOKEN;
  if (!secret || !userSub) return null;
  const digest = createHmac('sha256', secret)
    .update(`kesefle:account-deletion:v1:guard:${String(userSub)}`)
    .digest('hex');
  return `deletion:guard:${digest}`;
}

// Commit the forward mapping, reverse mapping, and one-time-code consumption
// in one Redis transaction. The canonical user and deletion guard are part of
// the same declared key set used by account deletion, so a pending confirmation
// cannot recreate either mapping after deletion has begun or completed.
async function _confirmPhoneLinkAtomically_(code, phone, userSub, linkedAt) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const guardKey = _deletionGuardKey_(userSub);
  if (!url || !token || !guardKey) return { status: 'unavailable' };

  const script = `#!lua flags=allow-key-locking
-- KESEFLE_PHONE_LINK_CONFIRM_V2
local pendingRaw = redis.call('GET', KEYS[5])
if not pendingRaw then return cjson.encode({ status = 'code_missing' }) end
local pendingOk, pending = pcall(cjson.decode, pendingRaw)
if not pendingOk or type(pending) ~= 'table' or pending['userSub'] == nil then
  return cjson.encode({ status = 'code_invalid' })
end
if tostring(pending['userSub']) ~= ARGV[1] then
  return cjson.encode({ status = 'code_invalid' })
end
if pending['phone'] ~= nil and tostring(pending['phone']) ~= ARGV[2] then
  return cjson.encode({ status = 'code_invalid' })
end

if redis.call('GET', KEYS[6]) then
  redis.call('DEL', KEYS[5])
  return cjson.encode({ status = 'account_deleting' })
end

local userRaw = redis.call('GET', KEYS[1])
if not userRaw then
  redis.call('DEL', KEYS[5])
  return cjson.encode({ status = 'user_missing' })
end
local userOk, user = pcall(cjson.decode, userRaw)
if not userOk or type(user) ~= 'table' then
  return cjson.encode({ status = 'user_malformed' })
end

local phoneRaw = redis.call('GET', KEYS[3])
local existing = nil
if phoneRaw then
  local phoneOk
  phoneOk, existing = pcall(cjson.decode, phoneRaw)
  if not phoneOk or type(existing) ~= 'table' or existing['userSub'] == nil then
    return cjson.encode({ status = 'phone_malformed' })
  end
  if tostring(existing['userSub']) ~= ARGV[1] then
    redis.call('DEL', KEYS[5])
    return cjson.encode({ status = 'foreign_phone' })
  end
end

local reverseRaw = redis.call('GET', KEYS[4])
local existingReverse = nil
if reverseRaw then
  local reverseOk
  reverseOk, existingReverse = pcall(cjson.decode, reverseRaw)
  if not reverseOk or type(existingReverse) ~= 'table' or existingReverse['phone'] == nil then
    return cjson.encode({ status = 'reverse_malformed' })
  end
  if tostring(existingReverse['phone']) ~= ARGV[2] then
    return cjson.encode({ status = 'different_phone_linked' })
  end
end

-- A successful first EVAL may lose its HTTP response. Keep the original
-- one-time-code record as a short confirmed tombstone instead of deleting it;
-- retries can then prove that both mappings committed. Guard/user checks above
-- intentionally run first, so deletion between commit and retry never replays
-- a stale linked result.
if pending['status'] == 'confirmed' then
  if existing == nil or existingReverse == nil then
    return cjson.encode({ status = 'replay_incomplete' })
  end
  return cjson.encode({ status = 'linked', record = existing, replayed = true })
end
if pending['status'] ~= nil then
  return cjson.encode({ status = 'code_invalid' })
end

local spreadsheetId = user['spreadsheetId']
local spreadsheetUrl = user['spreadsheetUrl']
local sheetRaw = redis.call('GET', KEYS[2])
if sheetRaw then
  local sheetOk, sheet = pcall(cjson.decode, sheetRaw)
  if sheetOk and type(sheet) == 'table' then
    if sheet['spreadsheetId'] ~= nil then spreadsheetId = sheet['spreadsheetId'] end
    if sheet['spreadsheetUrl'] ~= nil then spreadsheetUrl = sheet['spreadsheetUrl'] end
  end
end
local record = {
  userSub = ARGV[1],
  email = user['email'] or '',
  plan = user['plan'] or 'free',
  spreadsheetId = spreadsheetId or cjson.null,
  spreadsheetUrl = spreadsheetUrl or cjson.null,
  linkedAt = ARGV[3]
}
local reverse = { phone = ARGV[2], linkedAt = ARGV[3] }
redis.call('SET', KEYS[3], cjson.encode(record))
redis.call('SET', KEYS[4], cjson.encode(reverse))
local confirmed = { status = 'confirmed', userSub = ARGV[1], phone = ARGV[2], linkedAt = ARGV[3] }
redis.call('SET', KEYS[5], cjson.encode(confirmed), 'EX', ARGV[4])
return cjson.encode({ status = 'linked', record = record })`;

  try {
    const { response, payload } = await _linkJsonWithDeadline_(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL', script, '6',
        `user:${userSub}`,
        `sheet:${userSub}`,
        `phone:${phone}`,
        `userPhone:${userSub}`,
        `linkCode:${code}`,
        guardKey,
        userSub, phone, linkedAt, '600',
      ]),
    });
    if (!response.ok || typeof payload?.result !== 'string') return { status: 'unavailable' };
    const result = JSON.parse(payload.result);
    const allowed = new Set([
      'linked', 'code_missing', 'code_invalid', 'account_deleting',
      'user_missing', 'user_malformed', 'phone_malformed', 'reverse_malformed',
      'foreign_phone', 'different_phone_linked', 'replay_incomplete',
    ]);
    return allowed.has(result?.status) ? result : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

// E.164 normalization — strip everything except digits, add country code if missing.
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  // Paste artifacts seen in the wild (audit 2026-06-10) -- each produced a
  // DIFFERENT KV key than the bot computes, so the user linked under one key
  // and the bot looked up another ("linked but the bot ignores me"):
  // "+972 054-..." keeps the zero after the country code.
  if (s.startsWith('9720')) s = '972' + s.slice(4);
  // double country code from a double paste: 972972...
  if (s.startsWith('972972')) s = s.slice(3);
  // If it starts with 0 (e.g., 0541234567), assume Israel and prepend 972.
  if (s.startsWith('0')) s = '972' + s.slice(1);
  // bare Israeli mobile without the leading zero: 5XXXXXXXX (9 digits)
  if (/^5\d{8}$/.test(s)) s = '972' + s;
  // Length sanity: 7-15 digits per E.164
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// The permanent phone index and its reverse index must agree. Reading only a
// legacy field on user:<sub> made returning customers look unlinked even after
// a successful confirmation, while trusting only userPhone:<sub> could accept
// a stale mapping. Verify both directions before reporting a connection.
async function getVerifiedPhoneForUser(userSub) {
  if (!userSub) return { linked: false, phone: null };
  const reverse = await kvGet(`userPhone:${userSub}`);
  let candidate = normalizeE164(reverse?.phone);
  if (!candidate) {
    const legacy = await kvGet(`user:${userSub}`);
    candidate = normalizeE164(legacy?.linkedPhone || legacy?.phone);
  }
  if (!candidate) return { linked: false, phone: null };
  const forward = await kvGet(`phone:${candidate}`);
  if (!forward || forward.userSub !== userSub) {
    return { linked: false, phone: null, reason: 'mapping_mismatch' };
  }
  return { linked: true, phone: candidate };
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
  // (6s fast / 15s slow / 3min cap) that's ~15 polls per user.
  //
  // PR-S6 (2026-05-27 backend audit Bug #2): the GET path used to skip the
  // rate limit entirely to save ~30 KV commands per onboarding. That made
  // the endpoint a phone-number enumeration oracle -- iterate phones, see
  // who returns {linked:true}, harvest a competitor's user list.
  //
  // Fix: GET still skips the limit for bot-secret callers (server-side
  // lookups, trusted) but enforces a generous IP cap for anonymous callers.
  // 60/min/IP is 4x the legitimate poll cadence; a sweep attempting more
  // gets 429'd. The single-onboarding browser polls under this cap easily.
  if (req.method === 'GET') {
    const presentedSecret = req.headers['x-kesefle-bot-secret'] || '';
    const botSecret = process.env.KESEFLE_BOT_SECRET;
    const isBotCallerForLimit = !!botSecret &&
      constantTimeEqual(String(presentedSecret), String(botSecret));
    if (!isBotCallerForLimit) {
      const conf = { key: 'wa_link_status', limit: 60, windowSec: 60 };
      const rl = await rateLimit(req, conf);
      res.setHeader('X-RateLimit-Limit', String(conf.limit));
      if (!rl.ok) {
        res.setHeader('Retry-After', String(rl.retryAfter || conf.windowSec));
        log.warn('wa_link.status_rate_limit', {
          reqId: req.reqId,
          ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
        });
        return res.status(429).json({
          ok: false,
          error: 'rate_limit_exceeded',
          retry_after: rl.retryAfter || conf.windowSec,
        });
      }
    }
  } else {
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
    // Session-based lookup: ?check=1 returns whether the CURRENT authed user
    // has any phone linked. Lets /welcome bypass the phone-entry step if the
    // user already linked on another tab/session.
    if (req.query.check === '1') {
      const sessSub = getUserId(req);
      if (!sessSub) return res.status(200).json({ ok: true, linked: false });
      try {
        const status = await getVerifiedPhoneForUser(sessSub);
        return res.status(200).json({ ok: true, linked: status.linked, phone: status.phone });
      } catch (_e) {
        return res.status(200).json({ ok: true, linked: false });
      }
    }

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
      // Browser polling is account-bound: a phone linked to somebody else must
      // never make this session show a false success. Anonymous callers learn
      // nothing about whether a number belongs to a Kesefle customer.
      const sessSub = getUserId(req);
      return res.status(200).json({ ok: true, linked: !!sessSub && rec.userSub === sessSub });
    }

    // Bot path: full record incl. effective plan from the canonical user
    // record (the phone-record can lag behind plan changes by one Stripe
    // webhook). computeEntitlement reports an active 14-day trial as 'pro'.
    let entitlement = computeEntitlement(rec);
    if (rec.userSub) {
      try {
        const [userRec, referralCredit] = await Promise.all([
          kvGet(`user:${rec.userSub}`),
          kvGet(`referral:credit:${rec.userSub}`),
        ]);
        if (userRec) entitlement = computeEntitlement(withReferralCredit(userRec, referralCredit));
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
    if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
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

    const linkedAt = new Date().toISOString();
    const confirmation = await _confirmPhoneLinkAtomically_(code, phone, userSub, linkedAt);
    if (confirmation.status === 'foreign_phone') {
      log.warn('link.confirm.phone_race_lost', {
        reqId: req.reqId, phone, attemptedUserSub: userSub,
      });
      return res.status(409).json({ ok: false, error: 'phone_already_linked_to_another_account' });
    }
    if (confirmation.status === 'different_phone_linked') {
      return res.status(409).json({ ok: false, error: 'account_already_linked_to_different_phone' });
    }
    if (confirmation.status === 'account_deleting' || confirmation.status === 'user_missing') {
      return res.status(409).json({ ok: false, error: 'account_deletion_in_progress' });
    }
    if (confirmation.status === 'code_missing' || confirmation.status === 'code_invalid') {
      return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });
    }
    if (confirmation.status !== 'linked' || !confirmation.record) {
      return res.status(503).json({ ok: false, error: 'link_confirmation_unavailable' });
    }

    const permRec = confirmation.record;
    const userRec = permRec;
    const sheetRec = permRec;

    // Welcome the freshly-linked user so they see the bot work immediately
    // (instead of having to send their first expense to discover it does).
    // Non-fatal: if the send fails (token issue, etc.) the link itself
    // still succeeds — the user will simply not see the welcome.
    if (!confirmation.replayed) {
      sendWelcomeWhatsApp(phone, userRec, sheetRec).catch(err => {
        log.warn('link.confirm.welcome_send_failed', { reqId: req.reqId, error: err.message });
      });
    }

    return res.status(200).json({
      ok: true,
      userSub,
      email: permRec.email,
      sheetId: permRec.spreadsheetId,
      sheetUrl: permRec.spreadsheetUrl,
      ...(confirmation.replayed ? { replayed: true } : {}),
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
  const existing = await getVerifiedPhoneForUser(userSub);
  if (existing.linked && existing.phone === phone) {
    return res.status(200).json({ ok: true, alreadyLinked: true, phone });
  }
  if (existing.linked) {
    return res.status(409).json({ ok: false, error: 'account_already_linked_to_different_phone' });
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
