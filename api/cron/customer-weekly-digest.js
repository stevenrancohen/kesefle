// /api/cron/customer-weekly-digest
//
// "מה חדש השבוע בכספ'לה" — שולח הודעת WhatsApp שבועית ללקוחות.
// רץ ימי ראשון בבוקר (07:00 UTC = 10:00 IL) דרך vercel.json.
//
// **המסר אינו מבוית בקוד.** סטיבן מעדכן את ההודעה הנוכחית דרך
// /api/admin/customer-digest-set (נכתב בנפרד, ב-PR הזה).
// אם המסר ריק או חסר -- ה-cron יוצא בלי לשלוח שום דבר.
// זו מערכת בטיחות: אם סטיבן שכח להגדיר השבוע, הלקוחות לא יקבלו
// הודעה ריקה. עדיף להחמיץ שבוע מאשר לשלוח ספאם.
//
// כלי בטיחות נוספים:
//   - KESEFLE_DISABLE_CUSTOMER_DIGEST=1 → kill switch מיידי, בלי redeploy
//   - מקסימום משתמשים לריצה (DEFAULT 500) → מונע דלף לכלל המשתמשים אם
//     משהו לא תקין
//   - throttle של 1 שנייה בין שליחות → מונע rate-limit מצד Meta
//   - דילוג על משתמשים שעשו opt-out (isOptedOut)
//   - audit log לכל ריצה ב-KV: customer_digest_run:<ts>
//
// כניסה: GET/POST
// אימות:
//   - Vercel cron: Authorization: Bearer <CRON_SECRET>
//   - ידני: ?admin=<KESEFLE_BOT_SECRET>
//   - dry-run: הוסף &dryRun=1 כדי לראות מי היה מקבל, בלי לשלוח

import { withRequestId, log } from '../../lib/log.js';
import { constantTimeEqual } from '../../lib/crypto.js';
import { createHash } from 'node:crypto';

const MAX_USERS_PER_RUN = 500;     // safety cap
const SEND_THROTTLE_MS  = 1000;    // 1s between sends
const KV_KEY_MESSAGE    = 'customer_digest:current';
const KV_KEY_AUDIT_PREFIX = 'customer_digest_run:';
const KV_KEY_USERS_SET  = 'users_all';

// ── helpers ────────────────────────────────────────────────────────
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value, ttlSec) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const qs = ttlSec ? `?EX=${ttlSec}` : '';
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function kvSmembers(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return [];
  const r = await fetch(`${url}/smembers/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j?.result) ? j.result : [];
}

function isAuthorizedCronCall(req) {
  const cronAuth = req.headers['authorization'];
  if (cronAuth && process.env.CRON_SECRET && constantTimeEqual(cronAuth, 'Bearer ' + process.env.CRON_SECRET)) {
    return true;
  }
  const adminParam = (req.query && req.query.admin) || (req.url && (() => {
    try { return new URL(req.url, 'http://x').searchParams.get('admin'); } catch { return null; }
  })());
  if (adminParam && process.env.KESEFLE_BOT_SECRET && constantTimeEqual(adminParam, process.env.KESEFLE_BOT_SECRET)) {
    return true;
  }
  return false;
}

async function sendWhatsApp(toPhone, text) {
  const token = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('whatsapp_not_configured');
  const url = 'https://graph.facebook.com/v21.0/' + phoneId + '/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('send_failed status=' + resp.status + ' body=' + t.slice(0, 200));
  }
  const j = await resp.json().catch(() => null);
  return j && j.messages && j.messages[0] ? j.messages[0].id : null;
}

// ── main handler ───────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (!isAuthorizedCronCall(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Kill switch
  if (process.env.KESEFLE_DISABLE_CUSTOMER_DIGEST === '1') {
    log.info('customer_digest.disabled', { reqId: req.reqId });
    return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'kill_switch' });
  }

  // Load the message Steven set this week
  const messageRec = await kvGet(KV_KEY_MESSAGE);
  if (!messageRec || !messageRec.body || typeof messageRec.body !== 'string' || messageRec.body.trim().length < 10) {
    log.info('customer_digest.no_message_set', { reqId: req.reqId });
    return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'no_message_set' });
  }

  const body = String(messageRec.body).slice(0, 3900); // WhatsApp 4096 limit (with safety margin)
  const dryRun = String((req.query && req.query.dryRun) || '').match(/^(1|true|yes)$/i);

  // Load active users (set members) up to safety cap
  const userKeys = await kvSmembers(KV_KEY_USERS_SET);
  const candidates = userKeys.slice(0, MAX_USERS_PER_RUN);

  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const userKey of candidates) {
    try {
      // userKey shape: "google:<sub>" — resolve to user record to get phone
      const sub = String(userKey).startsWith('google:') ? userKey.slice(7) : userKey;
      const user = await kvGet('user:google:' + sub);
      if (!user || !user.phoneE164) { skipped++; continue; }

      // opt-out check.
      // 2026-05-31 audit fix (docs/AUDIT_KV_TENANT_ISOLATION_2026_05_31.md
      // bug #1 CRITICAL): was 'opt_out:' (underscore) — webhook.js writes
      // 'optout:' (no underscore) on STOP/UNSUBSCRIBE, so EVERY user who
      // typed STOP was still being sent the weekly digest. Israeli direct-
      // marketing law + GDPR Art.21 issue. Aligned to the canonical key.
      const optOut = await kvGet('optout:' + user.phoneE164);
      if (optOut) { skipped++; continue; }

      if (dryRun) {
        sent++;  // count what we *would* send
        continue;
      }

      await sendWhatsApp(user.phoneE164, body);
      sent++;
      // throttle so Meta doesn't rate-limit us
      await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
    } catch (e) {
      errors.push({ user: userKey, error: e.message });
      // continue with next user
    }
  }

  // Audit log this run
  await kvSet(KV_KEY_AUDIT_PREFIX + Date.now(), {
    ts: new Date().toISOString(),
    sent,
    skipped,
    errors: errors.length,
    dryRun: !!dryRun,
    // 2026-05-31 audit fix: was `.slice(0, 40)` which leaked the first 40
    // chars of message content into the 90-day audit log. Switched to a real
    // sha256 prefix so we still get a stable per-message identifier without
    // any content leakage.
    messageHash: createHash('sha256').update(String(messageRec.body || '')).digest('hex').slice(0, 16),
  }, 60 * 60 * 24 * 90);  // 90-day TTL

  log.info('customer_digest.complete', {
    reqId: req.reqId,
    sent, skipped, errors: errors.length, dryRun: !!dryRun,
  });

  return res.status(200).json({
    ok: true, sent, skipped, errors: errors.length, dryRun: !!dryRun,
  });
}

export default withRequestId(handlerImpl);
