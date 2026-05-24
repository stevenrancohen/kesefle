// api/admin/user-timeline.js
//
// Internal ops view -- aggregates everything we know about a single user so
// support can debug "I signed up but X didn't work" without trawling 6
// different KV prefixes.
//
// Privacy-first: we do NOT capture or display the user's message text. We
// only show: signup time, plan, sheet provisioning result, last inbound time,
// recent funnel events, payment status, retention actions. Steven asks the
// user directly for the content of any message that needs deeper debugging.
//
// GET /api/admin/user-timeline?sub=<userSub>
// GET /api/admin/user-timeline?phone=<E.164>
// GET /api/admin/user-timeline?email=<email>  (slower -- requires full scan)
//
// Admin-only via requireAdmin.

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}

async function kvGet(key) {
  const r = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return null;
  try { return r.result ? JSON.parse(r.result) : null; } catch { return null; }
}

async function kvScan(pattern, maxIter = 30) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < maxIter; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

function sanitizeUser(u) {
  if (!u) return null;
  const { refreshToken, refreshTokenEnvelope, accessToken, ...safe } = u;
  return safe;
}

async function resolveSubFromQuery(query) {
  if (query.sub && /^[A-Za-z0-9_-]{4,100}$/.test(String(query.sub))) {
    return String(query.sub);
  }
  if (query.phone) {
    const phone = String(query.phone).replace(/\D+/g, '');
    if (phone.length >= 9) {
      const phoneRec = await kvGet(`phone:${phone}`);
      if (phoneRec?.userSub) return phoneRec.userSub;
    }
  }
  if (query.email) {
    const email = String(query.email).toLowerCase().trim();
    const keys = await kvScan('user:*');
    for (const k of keys) {
      const u = await kvGet(k);
      if (u?.email && String(u.email).toLowerCase() === email) {
        return u.userSub || k.replace('user:', '');
      }
    }
  }
  return null;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const userSub = await resolveSubFromQuery(req.query);
  if (!userSub) return res.status(404).json({ ok: false, error: 'user_not_found', detail: 'Provide one of: sub, phone, email.' });

  // Pull every record we have keyed off this userSub. Read everything in
  // parallel for speed -- 6 KV reads is well within the per-admin rate limit.
  const [user, sheet, profile, retentionDiscount, retentionPause, exitSurvey, paymentFailed] = await Promise.all([
    kvGet(`user:${userSub}`),
    kvGet(`sheet:${userSub}`),
    kvGet(`profile:${userSub}`),
    kvGet(`retention:discount:${userSub}`),
    kvGet(`retention:pause:${userSub}`),
    kvGet(`exit_survey:${userSub}`),
    kvGet(`payment_failed:${userSub}`),
  ]);

  if (!user) return res.status(404).json({ ok: false, error: 'user_record_not_found', userSub });

  // Build the chronological timeline of events from what we have.
  const events = [];
  if (user.connectedAt) events.push({ at: user.connectedAt, kind: 'signup', label: 'Account created', icon: '✨' });
  if (sheet?.provisioned) events.push({ at: sheet.provisioned, kind: 'sheet_provisioned', label: `Sheet provisioned (id: ${String(sheet.spreadsheetId || '').slice(0, 20)}...)`, icon: '📊' });
  if (profile?.updatedAt || profile?.createdAt) events.push({ at: profile.updatedAt || profile.createdAt, kind: 'profile_set', label: `Onboarding questionnaire: trackingType=${profile?.trackingType || 'unknown'}`, icon: '📝' });
  if (user.linkedPhone || user.phone) events.push({ at: user.phoneLinkedAt || user.lastUpdated || '(unknown)', kind: 'phone_linked', label: `Phone linked: +${user.linkedPhone || user.phone}`, icon: '📱' });
  if (user.lastActive) events.push({ at: user.lastActive, kind: 'last_inbound', label: 'Last WhatsApp message to bot', icon: '💬' });
  if (paymentFailed?.firstFailureAt) events.push({ at: paymentFailed.firstFailureAt, kind: 'payment_failed', label: `Payment failed (${paymentFailed.plan || 'unknown'} plan)`, icon: '⚠️' });
  if (retentionDiscount?.accepted_at) events.push({ at: retentionDiscount.accepted_at, kind: 'discount_accepted', label: `Retention discount: ${retentionDiscount.pct}% x ${retentionDiscount.months}mo`, icon: '🎁' });
  if (retentionPause?.paused_at) events.push({ at: retentionPause.paused_at, kind: 'pause_requested', label: `Subscription paused: ${retentionPause.days}d (resume ${(retentionPause.resume_at || '').slice(0, 10)})`, icon: '⏸' });
  if (exitSurvey?.cancelled_at) events.push({ at: exitSurvey.cancelled_at, kind: 'cancelled', label: `Cancelled (reason: ${exitSurvey.reason})`, icon: '👋' });

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  log.info('admin.user_timeline.read', { reqId: req.reqId, adminEmail: req.user?.email, userSub });

  return res.status(200).json({
    ok: true,
    userSub,
    user: sanitizeUser(user),
    sheet: sheet ? { spreadsheetId: sheet.spreadsheetId, spreadsheetUrl: sheet.spreadsheetUrl, provisioned: sheet.provisioned } : null,
    profile,
    retention: {
      discount: retentionDiscount,
      pause: retentionPause,
      exit_survey: exitSurvey ? { reason: exitSurvey.reason, comment: exitSurvey.comment, at: exitSurvey.cancelled_at } : null,
    },
    payment_failed: paymentFailed,
    events,
    privacy_note: 'Message bodies are NOT captured. To debug a specific exchange, ask the user to send "בדיקה" to the bot and check Apps Script Executions log.',
  });
}

export default withRequestId(requireAdmin(handlerImpl));
