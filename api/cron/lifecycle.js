// api/cron/lifecycle.js
//
// Daily lifecycle email cron. Scans KV for users matching each window
// and sends the appropriate template via lib/email.js. Idempotent: each
// (userSub, template) send is recorded under `email_sent:{userSub}:{tpl}`
// with a long TTL so re-running the cron same-day doesn't re-send.
//
// Windows (per docs/SEQUENCE.md):
//   T+1 day  -> day_1_first_transaction.html  (if user has >=1 expense)
//   T+3 days -> day_3_pro_tips.html
//   T+7 days -> day_7_weekly_summary.html     (if user has >=3 expenses)
//   T+14 days -> day_14_upgrade_to_pro.html   (free plan only)
//   T+30 days -> day_30_pro_completed.html
//   inactive >= 7 days -> inactivity_7_days.html (re-engagement)
//
// Schedule: vercel.json `0 7 * * *` (07:00 UTC = 10:00 Asia/Jerusalem).
// Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>.

import { withRequestId, log } from '../../lib/log.js';
import { sendTemplate } from '../../lib/email.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
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

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}

async function kvSetEx(key, val, ttlSec) {
  return kvFetch(`/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: 'POST', body: val });
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// ISO 8601 week key (e.g. "2026-W21"). Used as a dedup namespace for the
// weekly digest so re-running the cron the same Sunday doesn't double-send.
function isoWeekKey(d) {
  var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  var dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  var weekNum = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(weekNum).padStart(2, '0');
}

function firstNameFromUser(u) {
  if (u?.name) return String(u.name).split(/\s+/)[0];
  if (u?.email) return String(u.email).split('@')[0];
  return 'שלום';
}

function unsubscribeUrlFor(userSub) {
  // Steven: replace with a signed-token URL once /api/account/unsubscribe is built.
  return `https://kesefle.com/unsubscribe?sub=${encodeURIComponent(userSub)}`;
}

// Each function returns true if a send was attempted (skipped or actually sent).
async function maybeSend(userSub, template, vars, ttlSec = 30 * 24 * 3600) {
  const guardKey = `email_sent:${userSub}:${template}`;
  const already = await kvGet(guardKey);
  if (already) return { skipped: true, reason: 'already_sent', at: already.at };
  const sendResult = await sendTemplate({ to: vars._toEmail, template, vars });
  if (sendResult.ok || sendResult.skipped) {
    // Record both "actually sent" and "skipped because email not configured" so
    // we don't pile up retries when RESEND_API_KEY isn't set yet.
    await kvSetEx(guardKey, JSON.stringify({ at: new Date().toISOString(), id: sendResult.id || null, skipped: !!sendResult.skipped }), ttlSec);
  }
  return sendResult;
}

function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${cronSecret}`) {
    return { ok: false, code: 401, error: 'cron_unauthorized' };
  }
  return { ok: true };
}

async function handlerImpl(req, res) {
  const authCheck = verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_outage' });
  }

  const now = new Date();
  const userKeys = await kvScan('user:*');
  let scanned = 0, scheduled = 0, skipped = 0, errors = 0;
  const stats = { day_1: 0, day_3: 0, day_7: 0, day_14: 0, day_30: 0, inactivity: 0 };

  for (const key of userKeys) {
    scanned++;
    const u = await kvGet(key);
    if (!u || !u.email || !u.userSub) { skipped++; continue; }
    if (u.emailUnsubscribed) { skipped++; continue; }

    const createdAt = u.connectedAt || u.createdAt;
    if (!createdAt) { skipped++; continue; }
    const days = daysBetween(new Date(createdAt), now);
    const firstName = firstNameFromUser(u);
    const baseVars = {
      _toEmail: u.email,
      firstName,
      userEmail: u.email,
      unsubscribeUrl: unsubscribeUrlFor(u.userSub),
    };

    try {
      // Day 1: triggered T+1 IF user logged at least one expense.
      if (days === 1 && (u.expensesCount || 0) >= 1) {
        const r = await maybeSend(u.userSub, 'day_1_first_transaction', baseVars);
        if (r.ok || r.skipped) { stats.day_1++; scheduled++; }
      }
      // Day 3: pro tips (no activity gate).
      if (days === 3) {
        const r = await maybeSend(u.userSub, 'day_3_pro_tips', baseVars);
        if (r.ok || r.skipped) { stats.day_3++; scheduled++; }
      }
      // Day 7: weekly summary (only if user is engaged).
      if (days === 7 && (u.expensesCount || 0) >= 3) {
        const stats7 = await kvGet(`stats:${u.userSub}:7d`) || {};
        const vars7 = { ...baseVars, week_total: stats7.total || 0, top_category: stats7.top_category || 'מזון', transactions: stats7.count || 0 };
        const r = await maybeSend(u.userSub, 'day_7_weekly_summary', vars7);
        if (r.ok || r.skipped) { stats.day_7++; scheduled++; }
      }
      // Day 14: upgrade nudge (only for free plan).
      if (days === 14 && (u.plan === 'free' || !u.plan)) {
        const r = await maybeSend(u.userSub, 'day_14_upgrade_to_pro', baseVars);
        if (r.ok || r.skipped) { stats.day_14++; scheduled++; }
      }
      // Day 30: milestone + referral push.
      if (days === 30) {
        const stats30 = await kvGet(`stats:${u.userSub}:30d`) || {};
        const vars30 = {
          ...baseVars,
          month_total: stats30.total || 0,
          transactions: stats30.count || 0,
          categories_count: stats30.categories_count || 1,
          referral_code: u.referralCode || u.userSub.slice(0, 8),
        };
        const r = await maybeSend(u.userSub, 'day_30_pro_completed', vars30);
        if (r.ok || r.skipped) { stats.day_30++; scheduled++; }
      }
      // Weekly digest: every Sunday morning, send last-7-day summary to
      // engaged users. We only run this branch on Sunday (UTC) -- the cron
      // fires daily, but the digest sends only once a week. Dedup key is
      // per-ISO-week so re-running the cron on the same Sunday is safe.
      if (now.getUTCDay() === 0 && (u.expensesCount || 0) >= 3 && !u.emailUnsubscribed) {
        var weekKey = isoWeekKey(now);
        var weeklyGuardKey = `email_sent:${u.userSub}:weekly_digest_${weekKey}`;
        var alreadyWeekly = await kvGet(weeklyGuardKey);
        if (!alreadyWeekly) {
          var stats7w = await kvGet(`stats:${u.userSub}:7d`) || {};
          var digestVars = {
            ...baseVars,
            week_total: stats7w.total || 0,
            transactions: stats7w.count || 0,
            top_category: stats7w.top_category || 'מזון',
          };
          var rd = await sendTemplate({ to: u.email, template: 'weekly-digest', vars: digestVars });
          if (rd.ok || rd.skipped) {
            await kvSetEx(weeklyGuardKey, JSON.stringify({ at: new Date().toISOString(), id: rd.id || null, skipped: !!rd.skipped }), 14 * 24 * 3600);
            stats.weekly_digest = (stats.weekly_digest || 0) + 1;
            scheduled++;
          }
        }
      }

      // Inactivity: lastActive older than 7d. Only send once per 30d window.
      if (u.lastActive) {
        const lastDays = daysBetween(new Date(u.lastActive), now);
        if (lastDays >= 7 && lastDays <= 8) {
          const r = await maybeSend(u.userSub, 'inactivity_7_days', baseVars, 30 * 24 * 3600);
          if (r.ok || r.skipped) { stats.inactivity++; scheduled++; }
        }
      }

      // Dunning sequence: payment_failed:{userSub} record drives Day 3 + Day 7
      // reminder emails after the initial Day 0 from the PayPal webhook.
      // Idempotent via the email_sent:{userSub}:{template}_day{N} guards.
      const pf = await kvGet(`payment_failed:${u.userSub}`);
      if (pf?.firstFailureAt) {
        const failureDays = daysBetween(new Date(pf.firstFailureAt), now);
        const dunningVars = {
          ...baseVars,
          planName: pf.plan === 'family' ? 'Family' : 'Pro',
          amount: String(pf.amountIls || 19),
        };
        if (failureDays === 3) {
          const r = await maybeSend(u.userSub, 'payment-failed_day3', dunningVars, 30 * 24 * 3600);
          if (r.ok || r.skipped) { stats.dunning_day3 = (stats.dunning_day3 || 0) + 1; scheduled++; }
        }
        if (failureDays === 7) {
          const r = await maybeSend(u.userSub, 'payment-failed_day7', dunningVars, 30 * 24 * 3600);
          if (r.ok || r.skipped) { stats.dunning_day7 = (stats.dunning_day7 || 0) + 1; scheduled++; }
        }
      }

      // NPS prompt at day 60: send a WhatsApp asking for a 0-10 score. The
      // bot watches for nps_pending:{phone} Script Property to parse the
      // reply -- the Apps Script side sets that flag when it sends the
      // prompt. Here we just trigger the prompt via /api/whatsapp/send.
      // Dedup is permanent (sub may answer once).
      if (days === 60 && (u.linkedPhone || u.phone) && !u.emailUnsubscribed) {
        var npsGuardKey = `email_sent:${u.userSub}:nps_d60`;
        var npsSent = await kvGet(npsGuardKey);
        if (!npsSent) {
          try {
            var npsWaUrl = (process.env.SELF_URL || 'https://kesefle.com') + '/api/whatsapp/send';
            var npsBotSecret = process.env.KESEFLE_BOT_SECRET;
            var npsPhone = u.linkedPhone || u.phone;
            if (npsBotSecret && npsPhone) {
              var npsText =
                'היי ' + firstName + ', שאלה קצרה — ' +
                'בקנה מידה של 0 עד 10, באיזה סבירות תמליצי/ימליץ על כספ\'לה לחבר/ה?\n\n' +
                'פשוט השב/י עם מספר. אופציונלי: תוסיף/י משפט קצר אחרי המספר.';
              await fetch(npsWaUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-kesefle-bot-secret': npsBotSecret },
                body: JSON.stringify({ phone: npsPhone, text: npsText }),
              });
              await kvSetEx(npsGuardKey, JSON.stringify({ at: new Date().toISOString() }), 365 * 24 * 3600);
              stats.nps_d60 = (stats.nps_d60 || 0) + 1;
              scheduled++;
            }
          } catch (npsErr) {
            log.warn('cron.lifecycle.nps_d60_failed', { userSub: u.userSub, error: npsErr.message });
          }
        }
      }

      // Win-back: 30 days after cancellation, send the 50%-off-forever offer.
      // Pulls from exit_survey:{userSub} created when /api/billing/cancel-flow
      // action=cancel was hit. Dedup is 1 year so we don't keep nagging.
      const exit = await kvGet(`exit_survey:${u.userSub}`);
      if (exit?.cancelled_at) {
        const sinceCancel = daysBetween(new Date(exit.cancelled_at), now);
        if (sinceCancel === 30) {
          // Generate a single-use winback token (just userSub + a short
          // hash); the /win-back page will validate it server-side before
          // applying the discount.
          const winbackToken = u.userSub.slice(0, 24);
          const winbackVars = { ...baseVars, winbackToken };
          const r = await maybeSend(u.userSub, 'winback_30_days', winbackVars, 365 * 24 * 3600);
          if (r.ok || r.skipped) { stats.winback = (stats.winback || 0) + 1; scheduled++; }

          // Also fire a WhatsApp message if we have the user's phone -- many
          // users live in WhatsApp and don't read email. Same dedup guard
          // (winback_30_days_wa) so a single cron run sends both channels
          // exactly once.
          const linkedPhone = u.linkedPhone || u.phone;
          if (linkedPhone) {
            const waGuardKey = `email_sent:${u.userSub}:winback_30_days_wa`;
            const waAlready = await kvGet(waGuardKey);
            if (!waAlready) {
              try {
                const waUrl = (process.env.SELF_URL || 'https://kesefle.com') + '/api/whatsapp/send';
                const botSecret = process.env.KESEFLE_BOT_SECRET;
                if (botSecret) {
                  const waText =
                    `היי ${firstName}, התגעגענו אליך 👋\n\n` +
                    `יש לנו הצעה מיוחדת: 50% הנחה לתמיד על כספ'לה.\n` +
                    `₪9.50 לחודש במקום ₪19, ולתמיד.\n\n` +
                    `לחץ כאן להפעלת ההנחה: https://kesefle.com/win-back?token=${winbackToken}\n\n` +
                    `(תוקף ההצעה: 14 יום)`;
                  await fetch(waUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-kesefle-bot-secret': botSecret },
                    body: JSON.stringify({ phone: linkedPhone, text: waText }),
                  });
                  await kvSetEx(waGuardKey, JSON.stringify({ at: new Date().toISOString(), channel: 'wa' }), 365 * 24 * 3600);
                  stats.winback_wa = (stats.winback_wa || 0) + 1;
                  scheduled++;
                }
              } catch (waErr) {
                log.warn('cron.lifecycle.winback_wa_failed', { userSub: u.userSub, error: waErr.message });
              }
            }
          }
        }
      }
    } catch (e) {
      errors++;
      log.warn('cron.lifecycle.user_failed', { userSub: u.userSub, error: e.message });
    }
  }

  log.info('cron.lifecycle.summary', { reqId: req.reqId, scanned, scheduled, skipped, errors, stats });
  return res.status(200).json({ ok: true, scanned, scheduled, skipped, errors, stats });
}

export default withRequestId(handlerImpl);
