// /api/whatsapp/link
//
// Flow for linking a user's WhatsApp number to their Kesefle account:
//
// 1. User on /account submits their E.164 phone → POST { phone } with the login session cookie
// 2. We verify the session and canonical sheet ownership server-side. Older
//    session-less clients may fall back to a verified Google access token.
// 3. Generate a unique 6-digit code (e.g. 482917) + store {code → userSub}
//    atomically in KV with a 10-min TTL
// 4. Return the code to the browser
// 5. Browser shows "Open WhatsApp and send: קוד 482917"
// 6. Bot webhook receives the message, sees "קוד 482917", calls /api/whatsapp/link?action=confirm
// 7. Server resolves code → userSub, then stores phone:<E164> → userSub permanently in KV
// 8. Bot writes to the user's sheet from then on
//
// Endpoints:
//   POST /api/whatsapp/link  { phone, accessToken? }      → { ok, code, expiresIn }
//   POST /api/whatsapp/link?action=confirm { code, phone } → { ok, status } (called by webhook)
//   GET  /api/whatsapp/link?phone=E164                    → { ok, linked: true/false, userSub? } (status check)
//
// Env: KV_REST_API_URL, KV_REST_API_TOKEN, GOOGLE_CLIENT_ID

import { withRequestId, log } from '../../lib/log.js';
import { rateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { computeEntitlement } from '../../lib/subscription.js';
import { getUserId } from '../_lib/session.js';
// Canonical constant-time compare (audit M2,
// docs/AUDIT_API_ENDPOINT_SECURITY_2026_05_31.md): shared lib/crypto.js helper
// (wraps crypto.timingSafeEqual) instead of a local copy, so the primitive
// only has to be hardened in one place.
import { constantTimeEqual } from '../../lib/crypto.js';

async function verifyAccessToken(accessToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!r.ok) throw new Error('tokeninfo_status_' + r.status);
  const info = await r.json();
  if (info.error) throw new Error('tokeninfo_error_' + info.error);
  if (!info.sub) throw new Error('tokeninfo_missing_sub');
  // tokeninfo validates the signature and expiry. When our client ID is
  // configured, also bind the legacy fallback token to this application.
  const expectedAudience = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const presentedAudience = String(info.aud || info.azp || '').trim();
  if (expectedAudience && presentedAudience !== expectedAudience) {
    throw new Error('tokeninfo_audience_mismatch');
  }
  return info;
}

function isSameOriginRequest(req) {
  const origin = String(req.headers?.origin || '').trim();
  const rawHost = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '')
    .split(',')[0]
    .trim();
  if (!origin || !rawHost) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() !== rawHost.toLowerCase()) return false;
    if (parsed.protocol === 'https:') return true;
    return process.env.NODE_ENV !== 'production'
      && parsed.protocol === 'http:'
      && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.host);
  } catch (_e) {
    return false;
  }
}

async function kvGet(key) {
  const result = await kvGetStrict(key);
  return result.ok ? result.value : null;
}

// Critical writes must distinguish "key missing" from "KV unavailable".
// The old helper collapsed both states to null, which could turn an outage
// into an incorrect expired-code response or a partial phone mapping.
async function kvGetStrict(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, value: null };
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json();
    if (j?.result === null || j?.result === undefined) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(j.result) };
  } catch (_e) {
    return { ok: false, value: null };
  }
}

async function kvSet(key, value, ttlSec) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const path = ttlSec ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${url}/set/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

// Execute one atomic Redis Lua transition over Upstash's REST API. Sending the
// complete command as a JSON array avoids URL-size/escaping problems and keeps
// network/HTTP/JSON ambiguity distinct from a typed script result.
async function kvEval(script, keys, args) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false, value: null };
  try {
    const command = ['EVAL', script, String(keys.length), ...keys, ...args.map(String)];
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json();
    if (!j || Object.prototype.hasOwnProperty.call(j, 'error') || typeof j.result !== 'string') {
      return { ok: false, value: null };
    }
    return { ok: true, value: j.result };
  } catch (_e) {
    return { ok: false, value: null };
  }
}

// One active challenge per account. A new request atomically supersedes the
// earlier active pointer, while SET-if-absent semantics protect another user's
// live 6-digit code from random collision overwrite.
async function mintLinkChallengeAtomic(code, userSub, phone, createdAt) {
  const challengeKey = `linkCode:${code}`;
  const activeKey = `activeLink:${userSub}`;
  const challenge = JSON.stringify({
    schemaVersion: 2,
    state: 'pending',
    attemptId: code,
    userSub,
    phone,
    createdAt,
  });
  const active = JSON.stringify({
    schemaVersion: 2,
    attemptId: code,
    code,
    userSub,
    phone,
    createdAt,
  });
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_MINT_LINK_V2
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 'collision'
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 'stored'`;
  return kvEval(script, [challengeKey, activeKey], [challenge, active, 600]);
}

// Atomically validate and commit the whole phone-link state transition. The
// confirmed challenge remains as a short receipt so a lost HTTP response or
// Meta redelivery can replay safely without a second commit.
async function confirmLinkChallengeAtomic({
  code, userSub, phone, spreadsheetId, phoneRecord, reverseRecord, receipt,
}) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_CONFIRM_LINK_V2
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then return nil end
  return value
end

local function normalizePhone(raw)
  local value = tostring(raw or ''):gsub('%D', '')
  while string.sub(value, 1, 6) == '972972' do
    value = string.sub(value, 4)
  end
  if string.sub(value, 1, 4) == '9720' then
    value = '972' .. string.sub(value, 5)
  end
  if string.sub(value, 1, 1) == '0' then
    value = '972' .. string.sub(value, 2)
  end
  if string.len(value) == 9 and string.sub(value, 1, 1) == '5' then
    value = '972' .. value
  end
  return value
end

local challengeRaw = redis.call('GET', KEYS[1])
if not challengeRaw then return 'expired' end
local challenge = decode(challengeRaw)
if not challenge then return 'invalid_state' end
if challenge.state == 'confirmed' then
  if challenge.userSub ~= ARGV[1]
    or challenge.phone ~= ARGV[2]
    or challenge.attemptId ~= ARGV[3] then
    return 'invalid_state'
  end
  local replayPhone = decode(redis.call('GET', KEYS[3]))
  local replayReverse = decode(redis.call('GET', KEYS[4]))
  local replaySheet = decode(redis.call('GET', KEYS[5]))
  local replayUser = decode(redis.call('GET', KEYS[6]))
  if replayPhone
    and replayReverse
    and replaySheet
    and replayUser
    and replayPhone.userSub == ARGV[1]
    and replayReverse.phone == ARGV[2]
    and tostring(replayPhone.spreadsheetId or '') == tostring(replaySheet.spreadsheetId or '') then
    return 'replayed'
  end
  return 'invalid_state'
end
if challenge.state ~= 'pending'
  or challenge.userSub ~= ARGV[1]
  or challenge.phone ~= ARGV[2]
  or challenge.attemptId ~= ARGV[3] then
  return 'invalid_state'
end

local active = decode(redis.call('GET', KEYS[2]))
if not active
  or active.userSub ~= ARGV[1]
  or active.phone ~= ARGV[2]
  or active.attemptId ~= ARGV[3]
  or active.code ~= ARGV[3] then
  return 'superseded'
end

local existingPhoneRaw = redis.call('GET', KEYS[3])
if existingPhoneRaw then
  local existingPhone = decode(existingPhoneRaw)
  if not existingPhone then return 'invalid_state' end
  if existingPhone.userSub ~= ARGV[1] then return 'phone_unavailable' end
end

local existingReverseRaw = redis.call('GET', KEYS[4])
if existingReverseRaw then
  local existingReverse = decode(existingReverseRaw)
  if not existingReverse then return 'invalid_state' end
  if existingReverse.phone and existingReverse.phone ~= ARGV[2] then
    return 'phone_change_blocked'
  end
end

local sheet = decode(redis.call('GET', KEYS[5]))
local user = decode(redis.call('GET', KEYS[6]))
if not sheet or not user or tostring(sheet.spreadsheetId or '') ~= ARGV[4] then
  return 'account_not_ready'
end
local legacyPhone = normalizePhone(user.phoneE164)
if legacyPhone == '' then legacyPhone = normalizePhone(user.linkedPhone) end
if legacyPhone == '' then legacyPhone = normalizePhone(user.phone) end
if legacyPhone ~= '' and legacyPhone ~= ARGV[2] then
  return 'phone_change_blocked'
end

redis.call('SET', KEYS[3], ARGV[5])
redis.call('SET', KEYS[4], ARGV[6])
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[1], ARGV[7], 'EX', ARGV[8])
return 'linked'`;
  return kvEval(script, [
    `linkCode:${code}`,
    `activeLink:${userSub}`,
    `phone:${phone}`,
    `userPhone:${userSub}`,
    `sheet:${userSub}`,
    `user:${userSub}`,
  ], [
    userSub,
    phone,
    code,
    spreadsheetId,
    JSON.stringify(phoneRecord),
    JSON.stringify(reverseRecord),
    JSON.stringify(receipt),
    86400,
  ]);
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
  // double country code from a double paste: 972972...
  while (s.startsWith('972972')) s = s.slice(3);
  if (s.startsWith('9720')) s = '972' + s.slice(4);
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
    candidate = [legacy?.phoneE164, legacy?.linkedPhone, legacy?.phone]
      .map(normalizeE164)
      .find(Boolean) || null;
  }
  if (!candidate) return { linked: false, phone: null };
  const forward = await kvGet(`phone:${candidate}`);
  if (!forward || forward.userSub !== userSub) {
    return { linked: false, phone: candidate, reason: 'mapping_mismatch' };
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
      // nothing about whether a number belongs to a Kesefle customer. Require
      // the reverse mapping too so a partial confirm never looks successful.
      const sessSub = getUserId(req);
      if (!sessSub || rec.userSub !== sessSub) {
        return res.status(200).json({ ok: true, linked: false });
      }
      const reverse = await kvGet(`userPhone:${sessSub}`);
      return res.status(200).json({
        ok: true,
        linked: normalizeE164(reverse?.phone) === phone,
      });
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
    if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
      log.warn('link.confirm.unauthorized', { reqId: req.reqId });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // The outer request limit sees only the webhook server's IP. Add explicit
    // phone + challenge buckets after authenticating the bot so one sender or
    // leaked code cannot monopolize confirmation work.
    const [phoneLimit, codeLimit] = await Promise.all([
      rateLimitId(phone, { key: 'wa_link_confirm_phone', limit: 20, windowSec: 600 }),
      rateLimitId(code, { key: 'wa_link_confirm_code', limit: 8, windowSec: 600 }),
    ]);
    if (!phoneLimit.ok || !codeLimit.ok) {
      const retryAfter = Math.max(phoneLimit.retryAfter || 0, codeLimit.retryAfter || 0, 600);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: retryAfter });
    }

    const pendingResult = await kvGetStrict(`linkCode:${code}`);
    if (!pendingResult.ok) {
      return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
    }
    const pending = pendingResult.value;
    if (!pending) return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });

    const userSub = typeof pending.userSub === 'string' ? pending.userSub.trim() : '';
    if (!userSub || userSub.length > 256) {
      log.error('link.confirm.invalid_pending_record', { reqId: req.reqId });
      return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });
    }

    // SECURITY: bind the code to the phone the account-holder entered at
    // REQUEST time. The 6-digit code is the only secret tying a phone to an
    // account, so a leaked/shoulder-surfed code must not let a different
    // sender link itself. Legacy unbound records fail closed.
    const boundPhone = normalizeE164(pending.phone);
    if (!boundPhone || boundPhone !== phone) {
      log.warn('link.confirm.phone_mismatch', {
        reqId: req.reqId, hasBoundPhone: !!boundPhone, userSub,
      });
      return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });
    }

    let sheetRec = null;
    let userRec = null;
    if (pending.state !== 'confirmed') {
      if (pending.state !== 'pending' || pending.attemptId !== code) {
        return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });
      }
      // Prepare the canonical record outside Lua, then the script re-reads the
      // same account/sheet keys and compares spreadsheetId before committing.
      const [sheetResult, userResult] = await Promise.all([
        kvGetStrict(`sheet:${userSub}`),
        kvGetStrict(`user:${userSub}`),
      ]);
      if (!sheetResult.ok || !userResult.ok) {
        return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
      }
      sheetRec = sheetResult.value;
      userRec = userResult.value;
      if (!sheetRec?.spreadsheetId || !userRec) {
        return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
      }
    }

    // Permanent mapping: phone → user record (with sheet info for fast bot
    // lookup). Receipt replays take the fast path in Lua and ignore dummy data.
    const verifiedAt = new Date().toISOString();
    const permRec = {
      schemaVersion: 2,
      userSub,
      email: userRec?.email || '',
      plan: userRec?.plan || 'free',
      spreadsheetId: sheetRec?.spreadsheetId || null,
      spreadsheetUrl: sheetRec?.spreadsheetUrl || userRec?.spreadsheetUrl || null,
      linkedAt: verifiedAt,
      verifiedAt,
      verificationMethod: 'whatsapp_inbound_code',
      lastInboundAt: verifiedAt,
    };
    const reverseRec = {
      schemaVersion: 2,
      phone,
      linkedAt: verifiedAt,
      verifiedAt,
      verificationMethod: 'whatsapp_inbound_code',
    };
    const receipt = {
      schemaVersion: 2,
      state: 'confirmed',
      attemptId: code,
      userSub,
      phone,
      verifiedAt,
    };
    const transition = await confirmLinkChallengeAtomic({
      code,
      userSub,
      phone,
      spreadsheetId: sheetRec?.spreadsheetId || '',
      phoneRecord: permRec,
      reverseRecord: reverseRec,
      receipt,
    });
    if (!transition.ok) {
      return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
    }
    if (transition.value === 'linked' || transition.value === 'replayed') {
      return res.status(200).json({
        ok: true,
        status: transition.value === 'linked' ? 'linked' : 'already_confirmed',
        replayed: transition.value === 'replayed',
      });
    }
    if (['expired', 'superseded', 'invalid_state'].includes(transition.value)) {
      return res.status(404).json({ ok: false, error: 'code_expired_or_invalid' });
    }
    if (transition.value === 'phone_unavailable') {
      return res.status(409).json({ ok: false, error: 'phone_unavailable' });
    }
    if (transition.value === 'phone_change_blocked') {
      return res.status(503).json({ ok: false, error: 'verification_state_changed' });
    }
    if (transition.value === 'account_not_ready') {
      return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
    }
    return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
  }

  // === REQUEST action (default) — user requests a linking code ===
  // Keep the migration window closed while WhatsApp is unavailable. This is
  // the same public feature flag used by /api/config and prevents an old tab
  // or client from minting a new legacy forward route between backfill scans.
  if (process.env.WABA_APPROVED !== '1') {
    return res.status(503).json({ ok: false, error: 'whatsapp_linking_unavailable' });
  }
  const phone = normalizeE164(body?.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'invalid_phone' });
  }

  // AUTH: prefer the login SESSION cookie (set at sign-in, valid 30 days) so the
  // link step never depends on the short-lived (~1h) Google ACCESS token — a
  // stale access token was the cause of `invalid_access_token` at this step.
  // Fall back to verifying an access token from the body for session-less calls.
  let userSub = getUserId(req);
  if (userSub) {
    // Cookie credentials are sent automatically by the browser, so require a
    // same-origin request before allowing this state-changing action.
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
    }
  } else {
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

  // A verified identity is not enough to mint a link code. Require Kesefle's
  // canonical server-side onboarding records and an owned sheet first.
  const [sheetRec, userRec] = await Promise.all([
    kvGet(`sheet:${userSub}`),
    kvGet(`user:${userSub}`),
  ]);
  const ownedSheetId = sheetRec?.spreadsheetId || userRec?.spreadsheetId || null;
  if (!ownedSheetId) {
    return res.status(403).json({ ok: false, error: 'sheet_not_ready' });
  }

  // Already linked? Tell the user so they don't generate a new code unnecessarily.
  const existing = await getVerifiedPhoneForUser(userSub);
  if (existing.linked && existing.phone === phone) {
    return res.status(200).json({ ok: true, alreadyLinked: true, phone });
  }
  if (existing.phone && existing.phone !== phone) {
    // Phone-keyed recurring/group/profile state is not yet migrated as one
    // audited transfer. Refuse a partial remap that could leave an old number
    // active or orphan customer data; support can verify and migrate it safely.
    return res.status(409).json({ ok: false, error: 'phone_change_requires_support' });
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
    return res.status(409).json({ ok: false, error: 'phone_unavailable' });
  }

  // Generate a globally unique active code. One Lua transition protects a
  // live code from collision and supersedes this user's prior active attempt.
  let code = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = gen6DigitCode();
    const stored = await mintLinkChallengeAtomic(
      candidate,
      userSub,
      phone,
      new Date().toISOString()
    );
    if (!stored.ok) {
      return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
    }
    if (stored.value === 'stored') {
      code = candidate;
      break;
    }
    if (stored.value !== 'collision') {
      return res.status(503).json({ ok: false, error: 'verification_storage_unavailable' });
    }
  }
  if (!code) {
    return res.status(503).json({ ok: false, error: 'code_generation_unavailable' });
  }

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
