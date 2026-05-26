// /api/cron/objective-reminders
//
// PR-G2-cron of Smart Budget Goals v2 (design: docs/SMART_BUDGET_GOALS_DESIGN.md).
// Runs Sun + Tue + Thu at 20:00 IL (18:00 UTC in DST, 17:00 UTC standard).
// We pick the broader 17:00 UTC slot in the Vercel schedule so DST changes
// don't push the DM out of evening hours.
//
// For each user with an active objective (not muted, not achieved, not past
// horizonEndsAt), DMs a progress-aware reminder so the user doesn't forget
// their long-horizon goal. Anti-spam: 36h cooldown via objective.lastReminderAt.
//
// Auth: this endpoint is protected by Vercel's built-in cron auth — Vercel
// injects an Authorization: Bearer header on cron invocations that matches
// the CRON_SECRET env var. Direct browser requests are rejected.

import { withRequestId, log } from '../../lib/log.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const META_TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;

// 36 hours — never DM the same user twice within this window even if the
// cron is invoked multiple times per day (Vercel won't, but be defensive).
const MIN_HOURS_BETWEEN_REMINDERS = 36;

// IL day-of-week semantics: Sunday=0, Monday=1, ..., Thursday=4.
// Reminders fire on 0 (Sun), 2 (Tue), 4 (Thu).
const REMINDER_DAYS_IL = new Set([0, 2, 4]);

// ── KV helpers (inlined to avoid edge-runtime import complications) ──

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${KV_URL}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${KV_TOKEN}`, ...(opts.headers || {}) },
    });
    if (!r.ok) return { ok: false, status: r.status };
    return await r.json();
  } catch { return { ok: false, status: 0 }; }
}

async function kvScan(pattern, count = 100) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 50; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=${count}`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    const batch = r.result?.[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys;
}

async function kvGetJson(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok || !r.result) return null;
  try { return JSON.parse(r.result); } catch { return null; }
}

async function kvSetJson(key, value) {
  return await kvFetch(`/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

// ── reminder content (progress-aware) ──

function buildReminderText(o) {
  const horizonHe = {
    month: 'לחודש הקרוב',
    six_months: 'ל-6 חודשים',
    year: 'לשנה הקרובה',
  };
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.round((o.horizonEndsAt - o.horizonChosenAt) / MS_PER_DAY));
  const elapsed = Math.max(0, Math.round((Date.now() - o.horizonChosenAt) / MS_PER_DAY));
  const remaining = Math.max(0, totalDays - elapsed);
  const pct = Math.min(100, Math.round((elapsed / totalDays) * 100));
  const horizon = horizonHe[o.horizon] || '';

  // Pick template by elapsed pct. PR-G2-cron uses time-elapsed as the proxy
  // for "progress" since we don't yet wire actual spend/saving tracking.
  // PR-G2-progress will replace this with real category-based progress math.
  if (pct < 30) {
    // Early — keep them excited
    return [
      '🎯 רק תזכורת — היעד שלך ' + horizon + ':',
      '',
      '"' + o.description + '"',
      '',
      'עברו ' + elapsed + ' ימים, נשארו ' + remaining + '.',
      'איך הולך? "יעד שלי" כדי לראות את הסטטוס המלא.',
    ].join('\n');
  }
  if (pct < 70) {
    // Middle — encouragement
    return [
      '🔥 אנחנו באמצע הדרך ל"' + o.description + '".',
      '',
      'עברו ' + elapsed + ' מ-' + totalDays + ' ימים (' + pct + '%).',
      'עוד ' + remaining + ' ימים להגיע. אתה במסלול?',
      '',
      'אם הגעת, שלח "השגתי יעד" 🏆.',
    ].join('\n');
  }
  // Last stretch — urgency
  return [
    '⚡ ' + remaining + ' ימים אחרונים ל"' + o.description + '".',
    '',
    '(עברו כבר ' + pct + '% מהזמן שהקצבת.)',
    '',
    'אם הגעת ליעד — "השגתי יעד" 🏆.',
    'אם לא — "שנה יעד" אם בא לך לעדכן את הניסוח.',
  ].join('\n');
}

// ── Israel day-of-week + DM ──

function israelDayOfWeek(now = new Date()) {
  // Israel is UTC+2 (standard) or UTC+3 (DST). For day-of-week purposes the
  // 1-hour DST flip is irrelevant — both shifts keep us in the same calendar
  // day for the 20:00 IL slot. We use the fixed +2 offset which is correct
  // 99% of the time and only off in the narrow window around DST flips.
  const il = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return il.getUTCDay();
}

async function sendDM(toPhone, text) {
  if (!META_TOKEN || !META_PHONE_ID) {
    return { ok: false, reason: 'meta_env_missing' };
  }
  const url = `https://graph.facebook.com/v21.0/${META_PHONE_ID}/messages`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${META_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: { body: text },
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'meta_unreachable', detail: e.message };
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return { ok: false, reason: 'meta_send_failed', status: resp.status, detail: detail.slice(0, 200) };
  }
  return { ok: true };
}

async function handlerImpl(req, res) {
  // Vercel cron protection
  if (CRON_SECRET) {
    const hdr = req.headers.authorization || '';
    if (hdr !== `Bearer ${CRON_SECRET}`) {
      log.warn('cron.objective_reminders.unauthorized', { reqId: req.reqId });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const isReminderDay = REMINDER_DAYS_IL.has(israelDayOfWeek());
  const isDryRun = req.query?.dryRun === '1' || req.query?.dry === '1';

  // Only short-circuit if NOT a reminder day AND not dry-run. We still want
  // ?dryRun=1 to be invokable any day for debugging.
  if (!isReminderDay && !isDryRun) {
    log.info('cron.objective_reminders.skip_not_reminder_day', { reqId: req.reqId, dow: israelDayOfWeek() });
    return res.status(200).json({ ok: true, skipped: 'not_reminder_day', dow: israelDayOfWeek() });
  }

  const keys = await kvScan('objective:*', 200);
  log.info('cron.objective_reminders.scanning', { reqId: req.reqId, count: keys.length });

  let sent = 0, skipped = 0, errors = 0;
  const now = Date.now();

  for (const key of keys) {
    try {
      const o = await kvGetJson(key);
      if (!o) { skipped++; continue; }
      if (o.muted)    { skipped++; continue; }
      if (o.achieved) { skipped++; continue; }
      if (o.horizonEndsAt && o.horizonEndsAt < now) { skipped++; continue; }
      if (o.lastReminderAt) {
        const hoursSince = (now - o.lastReminderAt) / (60 * 60 * 1000);
        if (hoursSince < MIN_HOURS_BETWEEN_REMINDERS) { skipped++; continue; }
      }

      // Resolve phone from user:{sub}
      const userSub = o.userSub;
      if (!userSub) { skipped++; continue; }
      const userRec = await kvGetJson('user:' + userSub);
      const phone = userRec && userRec.phone;
      if (!phone) { skipped++; continue; }

      const text = buildReminderText(o);

      if (isDryRun) {
        log.info('cron.objective_reminders.dryrun', {
          reqId: req.reqId, userSub, phone, preview: text.slice(0, 80),
        });
        sent++;
        continue;
      }

      const send = await sendDM(phone, text);
      if (!send.ok) {
        log.warn('cron.objective_reminders.send_failed', {
          reqId: req.reqId, userSub, reason: send.reason, status: send.status,
        });
        errors++;
        continue;
      }

      o.lastReminderAt = now;
      o.reminderCount = (o.reminderCount || 0) + 1;
      await kvSetJson(key, o);
      sent++;
    } catch (e) {
      log.error('cron.objective_reminders.iter_failed', { reqId: req.reqId, key, error: e.message });
      errors++;
    }
  }

  log.info('cron.objective_reminders.done', {
    reqId: req.reqId, scanned: keys.length, sent, skipped, errors, dryRun: isDryRun,
  });
  return res.status(200).json({
    ok: true,
    scanned: keys.length,
    sent,
    skipped,
    errors,
    dryRun: isDryRun,
  });
}

export default withRequestId(handlerImpl);
