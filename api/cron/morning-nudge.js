// /api/cron/morning-nudge
//
// "בוקר טוב מכספ'לה" — a daily morning cron that sends each active linked
// user a short, POSITIVE WhatsApp nudge. Modeled on
// api/cron/customer-weekly-digest.js (same KV helpers, auth, Meta Graph
// send, opt-out + kill-switch + audit-log discipline).
//
// ── Cadence / gating (Steven's "every 3 days" vs "once a month") ───────
//   * The cron FIRES once a day (vercel.json schedule). It does NOT send to
//     everyone every day.
//   * Per user we send AT MOST ONE nudge every 3 days. Gate:
//       nudge_last:{phone}      SETNX + 3-day TTL.
//     If the SETNX fails the user already got a nudge inside the 3-day
//     window, so we skip them today. This is the idempotency lock: even if
//     Vercel double-invokes the cron, only the first call claims the key.
//   * ONCE PER CALENDAR MONTH that send is the FULL guide (lists EVERYTHING
//     the user can do + exactly how to write each: expense, fixed expense,
//     income, photo receipt, summary, ...). Gate:
//       nudge_full_last:{phone}  SETNX, value = "YYYY-MM", ~40-day TTL.
//     If we can claim the monthly key this calendar month -> send FULL.
//     Otherwise -> send a SHORT rotating positive tip (one of a small set,
//     rotated by day-of-year so it varies between sends).
//
//   Net effect: a user hears from us roughly every 3 days with a short
//   encouraging tip, and the FIRST of those sends in each calendar month is
//   the full "here's everything I can do" guide. Steven: to make the short
//   tips more/less frequent, change NUDGE_GAP_DAYS; to change which send is
//   the full one, the monthly gate is independent of the 3-day gate.
//
// ── Safety ─────────────────────────────────────────────────────────────
//   * Kill switch: KESEFLE_DISABLE_NUDGE=1 -> no sends, no redeploy needed.
//   * Opt-out: skips anyone with optout:{phone} (canonical key, matches the
//     webhook STOP handler + the 2026-05-31 audit fix).
//   * Env-fail-soft: if Meta creds are absent, sendWhatsApp throws
//     whatsapp_not_configured; we catch per-user, count it, and DO NOT mark
//     the 3-day/monthly key as consumed for that user (the SETNX only fires
//     on the happy path), so a later run with creds present still delivers.
//   * MAX_USERS_PER_RUN cap + 1s throttle so a bug can't spray every user
//     and Meta doesn't rate-limit us.
//   * Audit log per run: nudge_run:{ts} (90-day TTL), content-free.
//
// Entry: GET/POST. Auth (same as customer-weekly-digest):
//   * Vercel cron: Authorization: Bearer <CRON_SECRET>
//   * manual:      ?admin=<KESEFLE_BOT_SECRET>
//   * dry-run:     &dryRun=1  (reports who WOULD get what, sends nothing,
//                  claims no KV gate keys)

import { withRequestId, log } from '../../lib/log.js';
import { constantTimeEqual } from '../../lib/crypto.js';

const MAX_USERS_PER_RUN = 500;   // safety cap
const SEND_THROTTLE_MS  = 1000;  // 1s between sends (Meta rate-limit guard)
const NUDGE_GAP_DAYS    = 3;     // at most one nudge per user per this many days
const KV_KEY_USERS_SET  = 'users_all';
const KV_KEY_AUDIT_PREFIX = 'nudge_run:';

// ── KV helpers (same shapes as customer-weekly-digest.js) ──────────────
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

// Atomic set-if-not-exists with TTL. Returns true ONLY if this call created
// the key (Upstash returns { result: "OK" } on set, { result: null } on NX
// reject). This is what makes the cron idempotent + double-send-safe.
async function kvSetNX(key, value, ttlSec) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}?nx=true&ex=${Number(ttlSec) || 86400}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(String(value || '1')),
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return j?.result === 'OK';
}

// Best-effort delete (used to roll back a claimed gate key if the send
// throws, so a transient Meta error doesn't burn the user's whole window).
async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.ok;
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

// ── Message copy (Hebrew, masculine-default per bot-reply-style) ────────
// Short, warm, ONE emoji, brand כספ'לה. Kept ASCII-free of bidi marks.

function firstNameFromUser(u) {
  if (u && u.name) return String(u.name).split(/\s+/)[0];
  return '';
}

// The FULL monthly guide: lists everything + how to write each, dead simple.
function fullGuideMessage(firstName) {
  const hi = firstName ? ('בוקר טוב ' + firstName + '! ') : 'בוקר טוב! ';
  return (
    hi + 'הנה כל מה שאפשר לעשות איתי, פשוט בוואטסאפ 👇\n\n' +
    '• הוצאה: כתוב "קפה 12" או "סופר 240"\n' +
    '• הוצאה קבועה: כתוב "שכר דירה 3000 קבוע"\n' +
    '• הכנסה: כתוב "הכנסה 5000 משכורת"\n' +
    '• קבלה בתמונה: צלם והבוט קורא את הסכום\n' +
    '• סיכום: כתוב "סיכום" ותראה כמה הוצאת החודש\n' +
    '• הגיליון שלך: כתוב "גיליון" לקישור לטבלה\n\n' +
    'זהו. אתה חי את החיים, אני דואג לכסף 💙'
  );
}

// Short rotating positive tips for the every-3-day sends. Rotated by
// day-of-year so consecutive sends differ. All masculine-default, one emoji.
const SHORT_TIPS = [
  'בוקר טוב! רגע קטן לתקציב: כתוב לי הוצאה אחת מאתמול ואני אסדר את השאר ✍️',
  'בוקר טוב! טיפ: "סיכום" מראה לך בשנייה כמה הוצאת החודש 📊',
  'בוקר טוב! יש הוצאה שחוזרת כל חודש? כתוב "שם 3000 קבוע" ואשמור אותה ✅',
  'בוקר טוב! קיבלת קבלה? צלם אותה ושלח לי — אני קורא את הסכום לבד 📸',
  'בוקר טוב! כל שקל שאתה רושם הוא שליטה. כתוב הוצאה אחת עכשיו 💪',
  'בוקר טוב! רוצה לראות הכל מסודר? כתוב "גיליון" לקישור לטבלה שלך 📒',
];

function shortTipMessage(firstName, dayOfYear) {
  const tip = SHORT_TIPS[((dayOfYear % SHORT_TIPS.length) + SHORT_TIPS.length) % SHORT_TIPS.length];
  if (!firstName) return tip;
  // Personalize the leading "בוקר טוב!" -> "בוקר טוב <name>!"
  return tip.replace(/^בוקר טוב!/, 'בוקר טוב ' + firstName + '!');
}

function monthKeyUTC(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function dayOfYearUTC(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((cur - start) / 86400000);
}

// ── main handler ───────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (!isAuthorizedCronCall(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Kill switch
  if (process.env.KESEFLE_DISABLE_NUDGE === '1') {
    log.info('nudge.disabled', { reqId: req.reqId });
    return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'kill_switch' });
  }

  const dryRun = String((req.query && req.query.dryRun) || '').match(/^(1|true|yes)$/i);
  const now = new Date();
  const monthKey = monthKeyUTC(now);
  const doy = dayOfYearUTC(now);

  // Load active users (set members) up to safety cap.
  const userKeys = await kvSmembers(KV_KEY_USERS_SET);
  const candidates = userKeys.slice(0, MAX_USERS_PER_RUN);

  let sentShort = 0;
  let sentFull = 0;
  let skipped = 0;
  const errors = [];

  for (const userKey of candidates) {
    try {
      // userKey shape: "google:<sub>" — resolve to the user record for phone.
      const sub = String(userKey).startsWith('google:') ? userKey.slice(7) : userKey;
      const user = await kvGet('user:google:' + sub);
      const phone = user && (user.phoneE164 || user.linkedPhone || user.phone);
      // Active + linked only: must have a phone on record.
      if (!user || !phone) { skipped++; continue; }

      // opt-out check (canonical key 'optout:' — matches webhook STOP handler
      // and the 2026-05-31 audit fix in customer-weekly-digest.js).
      const optOut = await kvGet('optout:' + phone);
      if (optOut) { skipped++; continue; }

      // 3-day gate: claim nudge_last:{phone}. If we can't claim it, the user
      // already got a nudge inside the window -> skip. In dry-run we only
      // PEEK (never claim) so the real schedule is untouched.
      const gapKey = 'nudge_last:' + phone;
      const fullKey = 'nudge_full_last:' + phone;

      if (dryRun) {
        const recentlyNudged = await kvGet(gapKey);
        if (recentlyNudged) { skipped++; continue; }
        const fullThisMonth = await kvGet(fullKey);
        const wouldBeFull = !(fullThisMonth && String(fullThisMonth) === monthKey);
        if (wouldBeFull) sentFull++; else sentShort++;
        continue;
      }

      const claimedGap = await kvSetNX(gapKey, String(now.getTime()), NUDGE_GAP_DAYS * 24 * 3600);
      if (!claimedGap) { skipped++; continue; }

      // Monthly gate: try to claim nudge_full_last:{phone} for THIS calendar
      // month. Claimed -> this send is the FULL guide. ~40-day TTL so it
      // naturally clears next month while never lingering forever.
      const claimedFull = await kvSetNX(fullKey, monthKey, 40 * 24 * 3600);
      const firstName = firstNameFromUser(user);
      const body = claimedFull ? fullGuideMessage(firstName) : shortTipMessage(firstName, doy);

      try {
        await sendWhatsApp(phone, body);
        if (claimedFull) sentFull++; else sentShort++;
        await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
      } catch (sendErr) {
        // Roll back the gate keys we just claimed so a transient failure (or
        // missing Meta creds) doesn't cost the user their 3-day / monthly
        // window. The monthly key is only rolled back if WE claimed it now.
        await kvDel(gapKey);
        if (claimedFull) await kvDel(fullKey);
        throw sendErr;
      }
    } catch (e) {
      errors.push({ user: String(userKey).slice(0, 24), error: e.message });
      // continue with next user
    }
  }

  // Audit log this run (content-free).
  await kvSetNX(KV_KEY_AUDIT_PREFIX + Date.now(), JSON.stringify({
    ts: now.toISOString(),
    sentShort, sentFull, skipped,
    errors: errors.length,
    dryRun: !!dryRun,
    monthKey,
  }), 60 * 60 * 24 * 90);

  log.info('nudge.complete', {
    reqId: req.reqId,
    sentShort, sentFull, skipped, errors: errors.length, dryRun: !!dryRun,
  });

  return res.status(200).json({
    ok: true,
    sent: sentShort + sentFull,
    sentShort, sentFull, skipped,
    errors: errors.length,
    dryRun: !!dryRun,
  });
}

export default withRequestId(handlerImpl);
