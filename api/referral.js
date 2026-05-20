// /api/referral
// Refer-a-friend program. Both referrer and redeemer get 1 month of Pro free.
//
// Storage (Vercel KV):
//   referral:code:<sub>      → '<CODE>'        (one code per user; overwritten on regenerate)
//   referral:reverse:<code>  → '<sub>'         (lookup owner from code; case-normalized)
//   referral:redeemed:<sub>  → { code, referrerSub, at }  (mark current user as redeemed)
//   referral:count:<sub>     → integer        (how many people have used this user's code)
//   referral:redeemers:<sub> → JSON array of { email, at } redacted to first letter
//   user:<sub>.referral_credit → ISO date 30 days from grant (set on referrer + redeemer)
//
// Auth: requireAuth (verified Google ID token).
// Rate limit: 30 req / hour / user — generous for browsing 'mine' but caps code-gen abuse.
//
// Actions:
//   POST ?action=generate  → { ok, code, url }
//   GET  ?action=mine      → { ok, code, url, count, redeemers: [{ email_initial, at }] }
//   POST ?action=redeem  body: { code }  → { ok, granted_until, referrer_first_name }

import { requireAuth } from '../lib/auth.js';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

// ---- KV helpers (REST API — no npm) ----
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j?.result) return null;
  // KV stores everything as string; try JSON parse, fall back to raw string
  try { return JSON.parse(j.result); } catch { return j.result; }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  return r.ok;
}

async function kvIncr(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0;
  const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return 0;
  const j = await r.json();
  return j?.result ?? 0;
}

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

// ---- Code helpers ----
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion
const CODE_LEN = 6;
const CODE_RE = /^[A-Za-z0-9]{6}$/;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function normalizeCode(c) {
  return String(c || '').trim().toUpperCase();
}

function baseUrl(req) {
  // Honor x-forwarded-host on Vercel; fall back to host header; default to canonical.
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'kesefle.vercel.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function buildReferralUrl(req, code) {
  return `${baseUrl(req)}/referral?ref=${encodeURIComponent(code)}`;
}

// =============================================================
// Action: generate
// =============================================================
async function generateAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = req.user.sub;

  // Reuse existing code if present (idempotent — 1 code per user). Allow forced regen with ?force=1.
  const existing = await kvGet('referral:code:' + userSub);
  if (existing && !req.query.force) {
    return res.status(200).json({
      ok: true,
      code: existing,
      url: buildReferralUrl(req, existing),
      reused: true,
    });
  }

  // If regenerating, free up the reverse-lookup of the old code.
  if (existing) {
    await kvDel('referral:reverse:' + existing);
  }

  // Generate a unique code (up to 5 collision retries; CODE space is 32^6 ≈ 1B so collision is rare)
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = generateCode();
    const taken = await kvGet('referral:reverse:' + code);
    if (!taken) break;
    code = '';
  }
  if (!code) {
    return res.status(500).json({ ok: false, error: 'code_generation_failed_collision' });
  }

  await kvSet('referral:code:' + userSub, code);
  await kvSet('referral:reverse:' + code, userSub);

  log.info('referral.generate', { reqId: req.reqId, userSub, regenerated: !!existing });

  return res.status(200).json({
    ok: true,
    code,
    url: buildReferralUrl(req, code),
    regenerated: !!existing,
  });
}

// =============================================================
// Action: mine (return user's code + stats)
// =============================================================
async function mineAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = req.user.sub;

  const code = await kvGet('referral:code:' + userSub);
  if (!code) {
    return res.status(200).json({
      ok: true,
      code: null,
      url: null,
      count: 0,
      redeemers: [],
      note: 'No code yet — POST ?action=generate to create one.',
    });
  }

  const count = parseInt(await kvGet('referral:count:' + userSub) || '0', 10) || 0;
  const redeemers = (await kvGet('referral:redeemers:' + userSub)) || [];

  // Redact: only show first letter of email
  const safeRedeemers = redeemers.slice(0, 50).map(r => ({
    email_initial: (r.email || '?').slice(0, 1) + '***',
    at: r.at,
  }));

  // Also surface the user's own referral credit if any.
  const userRec = await kvGet('user:' + userSub);
  const credit = userRec?.referral_credit || null;

  return res.status(200).json({
    ok: true,
    code,
    url: buildReferralUrl(req, code),
    count,
    redeemers: safeRedeemers,
    referral_credit_until: credit,
  });
}

// =============================================================
// Action: redeem
// =============================================================
async function redeemAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const userSub = req.user.sub;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const rawCode = body?.code;
  const code = normalizeCode(rawCode);
  if (!code || !CODE_RE.test(code)) {
    return res.status(400).json({ ok: false, error: 'invalid_code_format', hint: '6-char alphanumeric' });
  }

  // Already redeemed once? Block double-dipping.
  const prior = await kvGet('referral:redeemed:' + userSub);
  if (prior) {
    return res.status(409).json({ ok: false, error: 'already_redeemed', prior });
  }

  // Look up the owner of this code.
  const referrerSub = await kvGet('referral:reverse:' + code);
  if (!referrerSub) {
    return res.status(404).json({ ok: false, error: 'code_not_found' });
  }

  // Self-referral guard.
  if (referrerSub === userSub) {
    return res.status(400).json({ ok: false, error: 'cannot_redeem_own_code' });
  }

  // Mark this user as redeemed.
  const now = new Date();
  const grantedUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await kvSet('referral:redeemed:' + userSub, { code, referrerSub, at: now.toISOString() });

  // Increment referrer's count.
  await kvIncr('referral:count:' + referrerSub);

  // Append to referrer's redeemers list (capped at 200).
  const existingList = (await kvGet('referral:redeemers:' + referrerSub)) || [];
  existingList.push({ email: req.user.email || '', at: now.toISOString() });
  await kvSet('referral:redeemers:' + referrerSub, existingList.slice(-200));

  // Grant the free month — ONCE per user, ever. No stacking, no double promos:
  // if a user already received a referral credit we still TRACK the referral
  // (count + redeemers list above) but never grant a second month.
  for (const sub of [userSub, referrerSub]) {
    const rec = (await kvGet('user:' + sub)) || {};
    if (rec.referral_credit_granted_at) continue; // already benefited once
    rec.referral_credit = grantedUntil;
    rec.referral_credit_granted_at = now.toISOString();
    // Stamp who triggered it (helpful for support)
    rec.referral_credit_source = (sub === userSub) ? 'redeemed:' + code : 'referrer_of:' + userSub.slice(0, 8);
    await kvSet('user:' + sub, rec);
  }

  // Try to surface the referrer's first name for the UX confirmation
  const referrerRec = await kvGet('user:' + referrerSub);
  const refName = referrerRec?.name ? String(referrerRec.name).split(/\s+/)[0] : null;

  // Audit log
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken) {
      const auditKey = `audit:referral_redeem:${Date.now()}:${userSub.slice(0, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(auditKey)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ts: now.toISOString(),
          action: 'referral_redeem',
          userSub,
          referrerSub,
          code,
        }),
      });
    }
  } catch (e) { /* non-fatal */ }

  log.info('referral.redeem', { reqId: req.reqId, userSub, referrerSub, code });

  return res.status(200).json({
    ok: true,
    granted_until: grantedUntil,
    referrer_first_name: refName,
    note_he: 'קיבלת חודש Pro חינם. גם החבר שהביא אותך קיבל.',
  });
}

// =============================================================
// Main dispatcher
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'missing_action_param',
      hint: 'use ?action=generate (POST) | mine (GET) | redeem (POST)',
    });
  }
  switch (action) {
    case 'generate': return generateAction(req, res);
    case 'mine': return mineAction(req, res);
    case 'redeem': return redeemAction(req, res);
    default:
      return res.status(400).json({
        ok: false, error: 'unknown_action', action,
        allowed: ['generate', 'mine', 'redeem'],
      });
  }
}

export default withRequestId(
  withRateLimit({ key: 'referral', limit: 30, windowSec: 3600 })(
    requireAuth(handlerImpl)
  )
);
