// /api/account
// Consolidated account router — handles self-serve account operations via ?action= query param.
// This pattern keeps the project under Vercel Hobby's 12-function limit.
//
// Replaces:
//   /api/account/delete  (POST ?action=delete)
//   /api/account/export  (GET  ?action=export)
//
// Actions:
//   POST ?action=delete  body: { confirmation: 'DELETE-MY-ACCOUNT' }
//   GET  ?action=export  (returns a JSON download with all account data)
//
// All require authenticated user (requireAuth — verified Google ID token).
// Per Israeli Privacy Protection Law Amendment 13 + GDPR Articles 17 & 20.

import { requireAuth } from '../lib/auth.js';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { decryptRefreshToken, constantTimeEqual } from '../lib/crypto.js';
import { exchangeRefreshForAccess } from '../lib/oauth.js';
import { TX_TAB } from '../lib/sheet-tabs.js';
// GDPR completeness (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md): goals are
// stored as one key per goal under an index, so a flat key list can't reach
// them. purgeGoals() walks the goals:{userSub} index and deletes each
// goal:{userSub}:{id} plus the index itself.
import { purgeGoals } from '../lib/goals.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
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

// Remove ONE member from a KV set (Upstash REST: POST /srem/<key>/<member>).
// Used to evict a deleted user from the `users_all` index set on account
// deletion. A DEL can't do this — the set persists and only the matching
// member must go. Best-effort: a missing member is a no-op (SREM returns 0).
async function kvSetRemove(setKey, member) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(
    `${url}/srem/${encodeURIComponent(setKey)}/${encodeURIComponent(member)}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } },
  );
  return r.ok;
}

// 2026-05-29 resweep R1: single source of truth for "every KV key that holds
// per-user state". Previously the cookie-auth deleteAccount() path and the
// bot-secret deleteByPhone() path each maintained their own list, and they
// drifted: the web path missed profile/recurring/memberGroup/reminders/nps/
// testimonial; the bot path missed referral:code/referral:reverse.
//
// The full list is enumerated from `grep -rnE "/set/" --include='*.js' api/ lib/`
// (29 distinct prefixes across the codebase). Phone-keyed entries are only
// included when `phone` is provided; userSub-keyed entries are always included.
// Referral-reverse requires a read because the lookup is forward-only.
async function _keysForUser_(userSub, phone, referralCode) {
  const keys = [
    // Identity / auth core (both flows already had these)
    'user:' + userSub,
    'sheet:' + userSub,
    'token:' + userSub,          // legacy plaintext token store — GDPR purge
    'userPhone:' + userSub,
    // 2026-05-31 audit fix (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md #2):
    // Legacy GIS one-tap path in api/auth/google.js wrote to user:google:{sub}
    // instead of user:{sub}. Records persist past delete unless we also try
    // this orphan namespace. Best-effort: KV DEL of a missing key is a no-op.
    'user:google:' + userSub,
    // Referral mapping (only the web flow had these; bot flow missed them)
    'referral:code:' + userSub,
    // Web push subscription
    'push_sub:' + userSub,
    // NPS submission (free-text comment is PII)
    'nps:' + userSub,
    // Submitted testimonial (free text + name + plan, possibly displayed
    // publicly elsewhere). If a user deletes, drop the unpublished copy.
    'testimonial:' + userSub,
    // Cancellation exit-survey (free text reason). 365-day TTL anyway,
    // but the user explicitly asked for deletion — honor it.
    'exit_survey:' + userSub,
    // 2026-05-31 audit additions (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md
    // GDPR completeness): per-user prefixes that were written across the
    // codebase but never enumerated here, so deletion left orphan records
    // behind. Each is a single KV DEL; missing keys are no-ops.
    'usr_budget:' + userSub,             // per-user budget caps
    'custom_categories:' + userSub,      // Pro custom category list
    'objective:' + userSub,              // weekly objective state
    'payment_failed:' + userSub,         // dunning state (PII via timing)
    'retention:discount:' + userSub,     // cancel-flow save offer record
    'retention:pause:' + userSub,        // cancel-flow pause record
    'winback:' + userSub,                // post-cancel winback claim (PII)
    'user_seen_announcement:' + userSub, // dismissed announcement IDs
    'referral:redeemed:' + userSub,      // referral redemption idempotency
    // TODO (deferred — needs SCAN, not DEL):
    //   goal:{userSub}:{goalId}   — multi-key, but lib/goals.js keeps a
    //                               goals:{userSub} index; purgeGoals() walks it
    //   stats:{userSub}:{window}  — multi-key cached stats; TTL'd but PII
    // The SET `users_all` needs SREM (different op than DEL) — it is removed
    // via kvSetRemove() in BOTH deleteAccount and deleteByPhone (see below),
    // so this DEL-only list stays SET-vs-KEY clean.
  ];
  if (phone) {
    // Phone-keyed records (only the bot flow had these; web flow missed them)
    keys.push('phone:' + phone);
    keys.push('profile:' + phone);          // billing profile, currency, premium fields
    keys.push('recurring:' + phone);        // recurring expense templates
    keys.push('recurring_pending:' + phone); // pending recurring confirmation
    keys.push('memberGroup:' + phone);      // family/group membership pointer
    keys.push('reminders:' + phone);        // reminder list (PII in free text)
    keys.push('phoneGroups:' + phone);      // 2026-05-31 audit addition: family/group list
    keys.push('optout:' + phone);           // 2026-05-31 audit addition: WhatsApp STOP record
  }
  if (referralCode) {
    keys.push('referral:reverse:' + referralCode);
  }
  return keys;
}

// Purge the per-user records that a flat key list in _keysForUser_ can't reach
// because they are multi-key (one KV entry per goal, indexed) or windowed
// (one entry per stats window). Called from BOTH delete paths so bot-driven
// and web-driven deletes leave identical (zero) residue. Best-effort: every
// op tolerates a missing key, so a partial state never throws.
// (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md GDPR completeness, items 5 + 7.)
async function _purgeMultiKeyUserRecords_(userSub, deleted) {
  try {
    const r = await purgeGoals(userSub);   // walks goals:{userSub} index → goal:{userSub}:{id} + index
    if (r && r.purged) deleted.push('goal:' + userSub + ':* (' + r.purged + ')');
    deleted.push('goals:' + userSub);
  } catch (e) {
    log.warn('account.purge_goals_failed', { err: e && e.message });
  }
  // Cached stats aggregates (amounts → PII). Two known windows; TTL'd anyway,
  // but the user asked for deletion, so honor it immediately.
  for (const window of ['7d', '30d']) {
    if (await kvDel('stats:' + userSub + ':' + window)) {
      deleted.push('stats:' + userSub + ':' + window);
    }
  }
}

async function revokeGoogleToken(refreshToken) {
  if (!refreshToken) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (e) { console.warn('google_revoke_failed', e.message); }
}

// exchangeRefreshForAccess now lives in lib/oauth.js (audit H1): it captures a
// rotated refresh_token if Google returns one during the export's read.

// =============================================================
// Action: delete (GDPR Art.17 + Israeli Privacy Law Sec.14)
// =============================================================
async function deleteAccount(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const userSub = req.user.sub;

  if (body?.confirmation !== 'DELETE-MY-ACCOUNT') {
    return res.status(400).json({ ok: false, error: 'missing or invalid confirmation' });
  }

  const userRec = await kvGet('user:' + userSub);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }

  // Revoke the Google grant on delete. Handle BOTH the encrypted envelope
  // (current users) AND the legacy plaintext token — otherwise envelope users'
  // Google access survives account deletion (GDPR). Mirrors deleteByPhone.
  {
    let _refresh = null;
    try {
      _refresh = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
    } catch (_e) { _refresh = userRec.refreshToken || null; }
    if (_refresh) await revokeGoogleToken(_refresh);
  }

  const deleted = [];

  // Look up the reverse phone mapping + referral code to build the full
  // per-user key list (R1 unified delete — see _keysForUser_ above).
  const userPhoneRec = await kvGet('userPhone:' + userSub);
  const referralCode = await kvGet('referral:code:' + userSub);
  const phone = (userPhoneRec && userPhoneRec.phone) ? userPhoneRec.phone : null;
  const keysToDelete = await _keysForUser_(userSub, phone, referralCode);

  for (const k of keysToDelete) {
    if (await kvDel(k)) deleted.push(k);
  }

  // Multi-key / windowed per-user records (goals index, cached stats) that the
  // flat key list above can't reach.
  await _purgeMultiKeyUserRecords_(userSub, deleted);

  // Evict from the `users_all` index SET (SADD'd as 'google:'+sub at signup in
  // api/auth/google.js). A DEL can't remove a set member — without this SREM the
  // deleted user lingers in the set forever and the morning-nudge /
  // customer-weekly-digest crons keep iterating a ghost on every run.
  if (await kvSetRemove('users_all', 'google:' + userSub)) {
    deleted.push('users_all[google:' + userSub + ']');
  }

  // Audit log (non-fatal)
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const auditEntry = {
        ts: new Date().toISOString(),
        action: 'account_deleted',
        userSub,
        email: userRec.email,
        deletedKeys: deleted,
        ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64),
      };
      const auditKey = `audit:delete:${Date.now()}:${userSub.slice(0, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(auditKey)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(auditEntry),
      });
    } catch (e) { /* non-fatal */ }
  }

  return res.status(200).json({
    ok: true,
    deleted,
    note: 'Your account, OAuth tokens, and our connection to your sheet have been removed. The Google Sheet itself remains in your Drive under your control — delete it manually if you wish.',
    note_he: 'החשבון שלך, אסימוני ההזדהות והקישור שלנו לגיליון הוסרו. הגיליון עצמו נשאר ב-Drive שלך בשליטתך — מחק אותו ידנית אם תרצה.',
  });
}

// =============================================================
// Action: export (GDPR Art.20 right to data portability)
// =============================================================
async function exportAccount(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const userSub = req.user.sub;
  const userRec = (await kvGet('user:' + userSub)) || {};

  // Strip sensitive crypto material — user shouldn't see their own refresh token envelope
  const userProfile = {
    sub: userSub,
    email: userRec.email,
    name: userRec.name,
    picture: userRec.picture,
    plan: userRec.plan || 'free',
    subscription_status: userRec.subscriptionStatus,
    subscribed_at: userRec.subscribedAt,
    connected_at: userRec.connectedAt,
    spreadsheet_id: userRec.spreadsheetId,
    spreadsheet_url: userRec.spreadsheetUrl,
    has_refresh_token: !!(userRec.refreshTokenEnvelope || userRec.refreshToken),
  };

  // Sheet data (transactions) — fetch via stored refresh token
  let transactions = [];
  let sheetReadError = null;
  if (userRec.spreadsheetId) {
    try {
      const refreshToken = userRec.refreshTokenEnvelope
        ? decryptRefreshToken(userRec.refreshTokenEnvelope, userSub)
        : userRec.refreshToken;
      if (refreshToken) {
        const { accessToken } = await exchangeRefreshForAccess({ refreshToken, userSub });
        const range = encodeURIComponent(`'${TX_TAB}'!A2:I10001`);
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (r.ok) {
          const j = await r.json();
          transactions = (j.values || [])
            .filter(row => row[0])
            .map(row => ({
              date: row[0],
              amount: parseFloat(row[1] || '0') || 0,
              currency: row[2] || 'ILS',
              type: row[3] || '',
              category: row[4] || '',
              subcategory: row[5] || '',
              description: row[6] || '',
              source: row[7] || '',
              message_id: row[8] || '',
            }));
        } else {
          sheetReadError = 'sheets_status_' + r.status;
        }
      }
    } catch (e) {
      // Don't surface the raw exception text to the client: decrypt / token
      // failures throw messages that name internal env vars + key IDs
      // (e.g. "crypto: KESEFLE_DB_KEY_ACTIVE_KID=... not present in keyring",
      // "crypto.decrypt: authentication failed"). Return a stable, generic
      // classification in the export doc; log the real detail server-side for
      // operators. The export still succeeds — transactions just come back
      // empty with a machine-readable reason.
      sheetReadError = /crypto|decrypt|envelope|keyring|KEK/i.test(String(e && e.message))
        ? 'token_decrypt_failed'
        : 'sheet_read_failed';
      log.warn('account.export_sheet_read_failed', { reqId: req.reqId, userSub, reason: sheetReadError, err: e && e.message });
    }
  }

  // Referral data
  const referralCode = await kvGet('referral:code:' + userSub);

  const exportDoc = {
    export_meta: {
      exported_at: new Date().toISOString(),
      user_sub: userSub,
      format_version: '1.1',
      note: 'This is the complete export of all data Kesefle holds about your account. Per GDPR Article 20 and Israeli Privacy Law Section 13. To delete this data, use POST /api/account?action=delete.',
      note_he: 'זהו ייצוא מלא של כל הנתונים ש"כסף\'לה" שומר על חשבונך. לפי GDPR סעיף 20 וחוק הגנת הפרטיות סעיף 13. למחיקה: POST /api/account?action=delete.',
    },
    profile: userProfile,
    transactions: {
      count: transactions.length,
      data: transactions,
      read_error: sheetReadError,
      note: 'Transactions live in your own Google Sheet at spreadsheet_url. This export is a snapshot.',
    },
    referral: {
      code: referralCode || null,
      note: 'Your personal referral code, if generated.',
    },
    not_stored_by_kesefle: [
      'Original raw WhatsApp message bodies (only the parsed amount + category are persisted)',
      'Your bank/credit card data (we never receive it)',
      'Your phone number content beyond the sender field on incoming messages',
      'Your Google contacts, calendar, drive files outside the kesefle-provisioned sheet',
      'Your IP address beyond the last request (rate-limit ephemeral)',
    ],
    your_rights: {
      delete: 'POST /api/account?action=delete with confirmation:"DELETE-MY-ACCOUNT"',
      export: 'GET /api/account?action=export (this endpoint)',
      sheet_ownership: 'The Google Sheet at spreadsheet_url is YOURS. Kesefle has access only to files we created (drive.file scope). You can revoke our access at myaccount.google.com/permissions',
      complaint: 'https://www.gov.il/he/departments/the_privacy_protection_authority',
    },
  };

  log.info('account.export_ok', { reqId: req.reqId, userSub, txnCount: transactions.length });

  const filename = `kesefle-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify(exportDoc, null, 2));
}

// =============================================================
// Main dispatcher with per-action rate limits
// =============================================================
async function handlerImpl(req, res) {
  const action = String(req.query.action || '').trim();
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'missing_action_param',
      hint: 'use ?action=delete (POST) or ?action=export (GET)',
    });
  }

  switch (action) {
    case 'delete': return deleteAccount(req, res);
    case 'export': return exportAccount(req, res);
    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', action, allowed: ['delete', 'export'] });
  }
}

// Bot-callable deletion by phone (no Google token — the bot only knows
// the phone). Gated by the bot secret. Resolves phone → userSub via KV,
// then runs the same revoke + purge as the authed delete. This is how
// the WhatsApp "מחק חשבון כן" flow deletes an account without the user
// being in a browser session.
async function deleteByPhone(req, res) {
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const got = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (!constantTimeEqual(got, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = String(body?.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const phoneRec = await kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    // Nothing linked — still drop any phone-keyed state and report ok.
    await kvDel('phone:' + phone);
    return res.status(200).json({ ok: true, deleted: ['phone:' + phone], note: 'no_linked_user' });
  }
  const userSub = phoneRec.userSub;
  const userRec = await kvGet('user:' + userSub);
  if (userRec) {
    const refresh = userRec.refreshTokenEnvelope
      ? (() => { try { return decryptRefreshToken(userRec.refreshTokenEnvelope, userSub); } catch { return null; } })()
      : userRec.refreshToken;
    if (refresh) await revokeGoogleToken(refresh);
  }
  // R1 unified delete: same key inventory the cookie-auth path uses, so
  // bot-driven and web-driven deletes leave identical residue (none).
  const referralCode = await kvGet('referral:code:' + userSub);
  const deleted = [];
  const keysToDelete = await _keysForUser_(userSub, phone, referralCode);
  for (const k of keysToDelete) {
    if (await kvDel(k)) deleted.push(k);
  }
  // Same multi-key / windowed purge as the web deleteAccount path.
  await _purgeMultiKeyUserRecords_(userSub, deleted);
  // Same `users_all` index eviction as the web deleteAccount path, so a
  // bot-driven delete leaves no ghost in the cron set either.
  if (await kvSetRemove('users_all', 'google:' + userSub)) {
    deleted.push('users_all[google:' + userSub + ']');
  }
  log.info('account.delete_by_phone', { reqId: req.reqId, phone: phone.replace(/\d(?=\d{4})/g, '*') });
  return res.status(200).json({ ok: true, deleted });
}

// Both delete (3/hr) and export (2/hr) are sensitive but distinct.
// We use a single bucket here keyed by `account_op` with the conservative cap of 5/hour
// — covers both flows together since real users do these very rarely.
//
// The bot-secret delete-by-phone path is checked FIRST, bypassing
// requireAuth (the bot has no Google token), then the authed browser
// flows run as before.
export default withRequestId(
  withRateLimit({ key: 'account_op', limit: 5, windowSec: 3600 })(
    async function accountRouter(req, res) {
      const action = String(req.query?.action || '').toLowerCase();
      if (action === 'delete-by-phone') {
        if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return deleteByPhone(req, res);
      }
      return requireAuth(handlerImpl)(req, res);
    }
  )
);
