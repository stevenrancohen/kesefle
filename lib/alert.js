// lib/alert.js
//
// Severity-tagged alert sink. Routes to:
//   - Slack via incoming webhook   (env: SLACK_ALERT_WEBHOOK_URL)
//   - Email to ADMIN_EMAILS         (via lib/email.js if RESEND_API_KEY set)
//
// Env-fail-soft on both: if neither is configured, logs at warn level and
// returns { ok: false, skipped: true }. Designed so any noisy alert path
// (multi-writer anomaly, KV capacity, bot version drift) can call sendAlert
// without checking env first.

import { log } from './log.js';
import { sendEmail } from './email.js';
import { sendPush } from './push.js';

const RATE_KEY_PREFIX = 'alert_rate:';
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Dedupe identical alerts within a short window so a flapping signal doesn't
// page Steven 12 times. We hash title+severity into a KV key with a TTL.
async function shouldFire({ title, severity, dedupeWindowSec }) {
  if (!KV_URL || !KV_TOKEN) return true;
  const key = RATE_KEY_PREFIX + Buffer.from(`${severity}::${title}`).toString('base64').slice(0, 64);
  try {
    const r = await fetch(`${KV_URL}/setnx/${encodeURIComponent(key)}/1?EX=${dedupeWindowSec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const j = await r.json().catch(() => ({}));
    return j?.result === 1 || j?.result === '1';
  } catch (_e) {
    return true; // fail open -- prefer noisy over silent
  }
}

async function postSlack({ title, body, severity, tags }) {
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true, channel: 'slack', reason: 'no_webhook' };
  const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  const text = `${emoji} *${title}*\n${body}` + (tags?.length ? `\n_tags: ${tags.join(', ')}_` : '');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { ok: r.ok, channel: 'slack', status: r.status };
  } catch (e) {
    return { ok: false, channel: 'slack', error: e.message };
  }
}

async function emailAdmin({ title, body, severity, tags }) {
  const recipients = String(process.env.ADMIN_EMAILS || 'stevenrancohen@gmail.com,info@kesefle.com')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, skipped: true, channel: 'email', reason: 'no_recipients' };
  const emoji = severity === 'critical' ? '[CRITICAL]' : severity === 'warning' ? '[WARN]' : '[INFO]';
  const html = `<h2>${emoji} ${escapeHtml(title)}</h2>
<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>
${tags?.length ? `<p style="color:#888">tags: ${tags.map(escapeHtml).join(', ')}</p>` : ''}
<p style="color:#888;font-size:12px">Sent by lib/alert.js · ${new Date().toISOString()}</p>`;
  return sendEmail({
    to: recipients,
    subject: `${emoji} Kesefle: ${title}`,
    html,
    tags: [{ name: 'severity', value: severity }, ...(tags || []).map(t => ({ name: 'tag', value: t }))],
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Resolve admin userSubs to push to from env. ADMIN_PUSH_USER_SUBS is
// comma-separated; values are the Google `sub` IDs (NOT emails). If unset
// the push channel is skipped entirely (env-fail-soft). Steven gets his own
// userSub by signing in once and copying it from the `kesefle_user` localStorage
// entry on /dashboard, then pastes it into the Vercel env var.
function getAdminPushSubs() {
  return String(process.env.ADMIN_PUSH_USER_SUBS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// Public: fire a push notification to a specific admin user. Useful for
// surfacing a critical alert on Steven's phone the moment it triggers, even
// if Slack / email take longer to land. Env-fail-soft on missing VAPID env.
export async function pushAdmin(userSub, payload) {
  if (!userSub) return { ok: false, skipped: true, reason: 'missing_user_sub' };
  try {
    return await sendPush(userSub, payload);
  } catch (e) {
    log.warn('alert.push_failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

// Internal: fan out a push to every configured admin userSub. Best-effort;
// each send is awaited but failures don't abort the others.
async function pushAllAdmins({ title, body, severity, tags }) {
  const subs = getAdminPushSubs();
  if (!subs.length) return { ok: false, skipped: true, channel: 'push', reason: 'no_admin_subs' };
  const emoji = severity === 'critical' ? '[CRITICAL] ' : severity === 'warning' ? '[WARN] ' : '';
  // Truncate aggressively -- the payload travels through the push service
  // and the encrypted record is capped at ~4 KB.
  const title2 = (emoji + title).slice(0, 80);
  const body2  = String(body || '').slice(0, 220);
  const tag    = 'alert-' + (tags && tags[0] ? String(tags[0]).slice(0, 20) : severity);
  const results = await Promise.all(subs.map(sub => pushAdmin(sub, {
    title: title2,
    body: body2,
    tag,
    url: '/admin',
  })));
  const okCount = results.filter(r => r && r.ok).length;
  return { ok: okCount > 0, channel: 'push', sent: okCount, total: subs.length };
}

// Public: sendAlert({ severity, title, body, tags?, dedupeWindowSec? })
// Severity: 'critical' | 'warning' | 'info' (default 'warning').
// Dedupe: default 1 hour for warning, 5 min for critical.
//
// Channels:
//   - Slack (always, if SLACK_ALERT_WEBHOOK_URL)
//   - Email (always, if RESEND_API_KEY)
//   - Web Push to admin userSubs (ONLY on severity='critical', if VAPID + KV
//     configured + ADMIN_PUSH_USER_SUBS set). Push is rate-limited by the
//     same dedupe window as Slack/email so a flapping signal can't pop
//     dozens of phone notifications.
export async function sendAlert({ severity = 'warning', title, body, tags, dedupeWindowSec }) {
  if (!title) return { ok: false, error: 'missing_title' };

  const dedupeSec = dedupeWindowSec != null
    ? dedupeWindowSec
    : (severity === 'critical' ? 300 : 3600);
  const fire = await shouldFire({ title, severity, dedupeWindowSec: dedupeSec });
  if (!fire) {
    log.info('alert.deduped', { severity, title });
    return { ok: true, deduped: true };
  }

  // Push is gated to critical severity so we don't wake Steven's phone for
  // every "kv at 80%" tick. Slack + email already cover warning.
  const tasks = [
    postSlack({ title, body, severity, tags }),
    emailAdmin({ title, body, severity, tags }),
  ];
  if (severity === 'critical') {
    tasks.push(pushAllAdmins({ title, body, severity, tags }));
  }
  const settled = await Promise.allSettled(tasks);
  const slackRes = settled[0].status === 'fulfilled' ? settled[0].value : { ok: false, error: settled[0].reason?.message };
  const emailRes = settled[1].status === 'fulfilled' ? settled[1].value : { ok: false, error: settled[1].reason?.message };
  const pushRes  = settled[2] ? (settled[2].status === 'fulfilled' ? settled[2].value : { ok: false, error: settled[2].reason?.message }) : null;
  log.info('alert.fired', {
    severity, title,
    slack: slackRes.ok, email: emailRes.ok,
    push: pushRes ? pushRes.ok : null,
  });
  return { ok: slackRes.ok || emailRes.ok || (pushRes && pushRes.ok), slack: slackRes, email: emailRes, push: pushRes };
}

export function alertHealth() {
  return {
    slack_configured: !!process.env.SLACK_ALERT_WEBHOOK_URL,
    email_configured: !!process.env.RESEND_API_KEY,
    admin_emails: (process.env.ADMIN_EMAILS || 'stevenrancohen@gmail.com,info@kesefle.com').split(',').map(s => s.trim()),
    push_configured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT_EMAIL),
    admin_push_subs_count: getAdminPushSubs().length,
  };
}
