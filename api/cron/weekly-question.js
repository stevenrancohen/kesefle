// /api/cron/weekly-question
//
// "שאלת השבוע" — a weekly proactive cron (task #193) that asks each active
// linked user ONE short preference-learning question over WhatsApp. The
// answers help the bot personalize over time (the user just replies in free
// text; the bot's existing conversational + learning logic in
// bot/ExpenseBot_FIXED.gs handles the reply — this cron ONLY asks).
//
// Modeled EXACTLY on api/cron/morning-nudge.js + api/cron/customer-weekly-
// digest.js: same KV helpers, same auth, same Meta Graph send, same opt-out +
// kill-switch + throttle + cap + audit-log discipline. Nothing here touches
// the bot .gs file or the classifier.
//
// ── Cadence / idempotency ──────────────────────────────────────────────
//   * The cron FIRES once a week (vercel.json schedule, Wed 07:30 UTC).
//   * Run-level guard: cron:weekly-question:lastRun:<ISO-week> claimed via
//     SETNX. If a second invocation lands in the SAME ISO week (Vercel double-
//     invoke / manual re-run) the key is already held -> the run is a no-op.
//     This is the idempotency lock at the cron level.
//   * Per-user gate: weekly_question_last:{phone} SETNX with an ~8-day TTL so
//     each user gets AT MOST ONE question per week even across runs. The SETNX
//     only fires on the happy path, so a Meta outage doesn't burn the user's
//     week (we roll the key back on send failure).
//   * Which question: rotated by ISO week number so consecutive weeks differ.
//
// ── Safety ─────────────────────────────────────────────────────────────
//   * Kill switch: KESEFLE_DISABLE_WEEKLY_QUESTION=1 -> no sends, no redeploy.
//   * Opt-out: skips anyone with optout:{phone} (canonical key, matches the
//     webhook STOP handler + customer-weekly-digest.js).
//   * Env-fail-soft: if Meta creds are absent, sendWhatsApp throws
//     whatsapp_not_configured; we catch per-user, count it, and DO NOT consume
//     the per-user gate (SETNX rolled back), so a later run still delivers.
//   * MAX_USERS_PER_RUN cap + 1s throttle so a bug can't spray everyone.
//   * Audit log per run: weekly_question_run:{ts} (90-day TTL), content-free.
//
// Entry: GET/POST. Auth (same as morning-nudge / customer-weekly-digest):
//   * Vercel cron: Authorization: Bearer <CRON_SECRET>
//   * manual:      ?admin=<KESEFLE_BOT_SECRET>
//   * dry-run:     &dryRun=1  (reports who WOULD get asked, sends nothing,
//                  claims no KV gate keys)

import { withRequestId, log } from '../../lib/log.js';
import { constantTimeEqual } from '../../lib/crypto.js';

const MAX_USERS_PER_RUN = 500;     // safety cap
const SEND_THROTTLE_MS  = 1000;    // 1s between sends (Meta rate-limit guard)
const PER_USER_TTL_SEC  = 8 * 24 * 3600; // ~8 days: one question per user/week
const RUN_GUARD_TTL_SEC = 8 * 24 * 3600; // ~8 days: run-level once-per-week lock
const KV_KEY_USERS_SET  = 'users_all';
const KV_KEY_AUDIT_PREFIX = 'weekly_question_run:';

// ── KV helpers (identical shapes to morning-nudge.js) ──────────────────
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

// Best-effort delete (used to roll back a claimed gate key if the send throws,
// so a transient Meta error doesn't burn the user's whole week).
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

// ── Question copy (Hebrew, masculine-default per bot-reply-style) ───────
// Short, warm, ONE emoji, brand כספ'לה, ends with a question so the user
// knows to just reply. Kept free of bidi control marks.

function firstNameFromUser(u) {
  if (u && u.name) return String(u.name).split(/\s+/)[0];
  return '';
}

// One preference-learning question per send, rotated by ISO week so it varies.
// Each is a single question the user can answer in free text; the bot's normal
// conversational handling captures the reply.
const WEEKLY_QUESTIONS = [
  'שאלת השבוע: על איזו קטגוריה הכי בא לך שאשמור עליך החודש — אוכל, תחבורה, או קבועות? תכתוב לי ואדע 🎯',
  'שאלת השבוע: מתי הכי נוח לך לקבל ממני סיכום קצר — בבוקר, בערב, או בסוף השבוע? ✍️',
  'שאלת השבוע: יש הוצאה שחוזרת כל חודש ושכחת לרשום? תכתוב לי "שם 3000 קבוע" ואשמור אותה ✅',
  'שאלת השבוע: מה המטרה הכספית שהכי חשובה לך עכשיו — לחסוך, להוציא פחות, או רק לראות לאן הכסף הולך? 💙',
  'שאלת השבוע: איזה דוח הכי יעזור לך — לפי קטגוריה, לפי חודש, או הכי גדולות? תכתוב לי ואכין 📊',
  'שאלת השבוע: יש סוג הוצאה שאני נוטה לסווג לא נכון אצלך? תכתוב לי דוגמה ואלמד אותה לתמיד 🤝',
];

function weeklyQuestionMessage(firstName, isoWeek) {
  const idx = ((isoWeek % WEEKLY_QUESTIONS.length) + WEEKLY_QUESTIONS.length) % WEEKLY_QUESTIONS.length;
  const q = WEEKLY_QUESTIONS[idx];
  if (!firstName) return q;
  // Personalize the leading "שאלת השבוע:" -> "<name>, שאלת השבוע:"
  return q.replace(/^שאלת השבוע:/, firstName + ', שאלת השבוע:');
}

// ISO-8601 week number (UTC). Used both for the run-level idempotency key and
// to rotate the question. Returns e.g. "2026-W23".
function isoWeekKeyUTC(d) {
  // Copy date so we don't mutate the input; shift to Thursday of this week.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function isoWeekNumber(d) {
  const key = isoWeekKeyUTC(d);
  return parseInt(key.slice(key.indexOf('W') + 1), 10) || 0;
}

// ── main handler ───────────────────────────────────────────────────────
async function handlerImpl(req, res) {
  if (!isAuthorizedCronCall(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Kill switch
  if (process.env.KESEFLE_DISABLE_WEEKLY_QUESTION === '1') {
    log.info('weekly_question.disabled', { reqId: req.reqId });
    return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'kill_switch' });
  }

  const dryRun = String((req.query && req.query.dryRun) || '').match(/^(1|true|yes)$/i);
  const now = new Date();
  const isoWeek = isoWeekKeyUTC(now);
  const weekNum = isoWeekNumber(now);

  // Run-level idempotency lock: claim cron:weekly-question:lastRun:<ISO-week>.
  // If we can't claim it, this ISO week's run already happened -> no-op. In
  // dry-run we skip the lock entirely so it doesn't burn the real week.
  if (!dryRun) {
    const runGuardKey = 'cron:weekly-question:lastRun:' + isoWeek;
    const claimedRun = await kvSetNX(runGuardKey, now.toISOString(), RUN_GUARD_TTL_SEC);
    if (!claimedRun) {
      log.info('weekly_question.already_ran_this_week', { reqId: req.reqId, isoWeek });
      return res.status(200).json({ ok: true, sent: 0, skipped: 0, reason: 'already_ran_this_week', isoWeek });
    }
  }

  // Load active users (set members) up to safety cap.
  const userKeys = await kvSmembers(KV_KEY_USERS_SET);
  const candidates = userKeys.slice(0, MAX_USERS_PER_RUN);

  let sent = 0;
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
      // and customer-weekly-digest.js).
      const optOut = await kvGet('optout:' + phone);
      if (optOut) { skipped++; continue; }

      const gateKey = 'weekly_question_last:' + phone;

      if (dryRun) {
        // PEEK only — never claim — so the real schedule is untouched.
        const recent = await kvGet(gateKey);
        if (recent) { skipped++; continue; }
        sent++;
        continue;
      }

      // Per-user weekly gate: claim weekly_question_last:{phone}. If we can't,
      // the user already got this week's question -> skip.
      const claimed = await kvSetNX(gateKey, isoWeek, PER_USER_TTL_SEC);
      if (!claimed) { skipped++; continue; }

      const firstName = firstNameFromUser(user);
      const body = weeklyQuestionMessage(firstName, weekNum);

      try {
        await sendWhatsApp(phone, body);
        sent++;
        await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
      } catch (sendErr) {
        // Roll back the gate key so a transient failure (or missing Meta creds)
        // doesn't cost the user their weekly question.
        await kvDel(gateKey);
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
    isoWeek,
    weekNum,
    sent, skipped,
    errors: errors.length,
    dryRun: !!dryRun,
  }), 60 * 60 * 24 * 90);

  log.info('weekly_question.complete', {
    reqId: req.reqId,
    isoWeek, sent, skipped, errors: errors.length, dryRun: !!dryRun,
  });

  return res.status(200).json({
    ok: true,
    sent, skipped,
    errors: errors.length,
    isoWeek,
    dryRun: !!dryRun,
  });
}

export default withRequestId(handlerImpl);
