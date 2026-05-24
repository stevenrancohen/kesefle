// api/admin/inbox.js
//
// Unified customer-signals inbox for the admin. Aggregates every signal
// Steven might want to act on, into a single chronological feed:
//
//   - support_request   (bot escalations -- from bot _adminAlertOnce_)
//   - user_report       (floating "report a problem" button submissions)
//   - exit_survey       (cancellation reasons + comments)
//   - nps_detractor     (NPS scores 0-6 with optional comment)
//   - nps_passive       (NPS scores 7-8)
//   - testimonial       (pending-review testimonial submissions)
//   - winback_claim     (user accepted the 50% lifetime discount offer)
//   - plan_change       (upgrade/downgrade request)
//   - retention_pause   (subscription pause request)
//   - retention_discount (50% x N month retention discount accepted)
//   - sheet_anomaly     (multi-writer detected)
//
// Default sort: timestamp desc. Default returns last 50 across all sources.
// Each item has { kind, at, userSub, summary, action_url } for one-click
// jumps into the relevant detail view.
//
// GET /api/admin/inbox?kinds=support_request,user_report&limit=50

import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, ...j };
}

async function kvScan(pattern) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 30; i++) {
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    keys.push(...(r.result?.[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const r = await kvFetch('/mget/' + keys.map(encodeURIComponent).join('/'));
  return (r.result || []).map((v, i) => {
    let parsed = null;
    try { parsed = v ? JSON.parse(v) : null; } catch { parsed = null; }
    return { key: keys[i], value: parsed };
  });
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function collectKind(kind, pattern, mapper) {
  const keys = await kvScan(pattern);
  const items = await kvMget(keys);
  const out = [];
  for (const { key, value } of items) {
    if (!value) continue;
    const item = mapper(value, key);
    if (item) {
      out.push({ kind, ...item });
    }
  }
  return out;
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_outage' });

  const requestedKinds = String(req.query.kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.min(200, Math.max(5, parseInt(req.query.limit, 10) || 50));

  const ALL_KINDS = ['user_report', 'exit_survey', 'nps', 'testimonial', 'winback_claim', 'plan_change', 'retention_pause', 'retention_discount', 'sheet_anomaly'];
  const activeKinds = requestedKinds.length ? requestedKinds : ALL_KINDS;

  const tasks = [];

  if (activeKinds.includes('user_report')) {
    tasks.push(collectKind('user_report', 'user_report:*', function (v, k) {
      if (!v.at) return null;
      return {
        at: v.at,
        userSub: v.userSub || null,
        summary: clip(v.message || v.subject || '(no message)', 120),
        meta: { ua: clip(v.ua || '', 80), url: clip(v.url || '', 80) },
        action_url: '/admin?tab=reports',
      };
    }));
  }

  if (activeKinds.includes('exit_survey')) {
    tasks.push(collectKind('exit_survey', 'exit_survey:*', function (v) {
      if (!v.cancelled_at) return null;
      return {
        at: v.cancelled_at,
        userSub: v.userSub,
        summary: `Cancellation reason: ${v.reason || 'no_reason'}${v.comment ? ' — "' + clip(v.comment, 80) + '"' : ''}`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('nps')) {
    tasks.push(collectKind('nps', 'nps:*', function (v) {
      if (!v.at) return null;
      const tier = v.score <= 6 ? 'nps_detractor' : v.score <= 8 ? 'nps_passive' : 'nps_promoter';
      return {
        at: v.at,
        userSub: v.userSub,
        kind_subtype: tier,
        score: v.score,
        summary: `NPS ${v.score}/10${v.comment ? ' — "' + clip(v.comment, 80) + '"' : ''}`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('testimonial')) {
    tasks.push(collectKind('testimonial', 'testimonial:*', function (v) {
      if (!v.at) return null;
      const status = v.approved ? 'approved' : v.hidden ? 'hidden' : 'pending_review';
      return {
        at: v.at,
        userSub: v.userSub,
        summary: `[${status}] "${clip(v.text, 100)}" — ${v.name || 'משתמש/ת'}`,
        action_url: '/admin/launch-monitor#testimonials',
      };
    }));
  }

  if (activeKinds.includes('winback_claim')) {
    tasks.push(collectKind('winback_claim', 'winback:*', function (v) {
      if (!v.claimed_at) return null;
      return {
        at: v.claimed_at,
        userSub: v.userSub,
        summary: `Winback claim accepted (50% lifetime). PayPal admin action needed.`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('plan_change')) {
    tasks.push(collectKind('plan_change', 'plan_change:*', function (v) {
      if (!v.requested_at) return null;
      return {
        at: v.requested_at,
        userSub: v.userSub,
        summary: `Plan change: ${v.from?.plan}/${v.from?.period} -> ${v.to?.plan}/${v.to?.period}. Credit ${v.prorate?.creditIls || 0} NIS.`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('retention_pause')) {
    tasks.push(collectKind('retention_pause', 'retention:pause:*', function (v) {
      if (!v.paused_at) return null;
      return {
        at: v.paused_at,
        userSub: v.userSub,
        summary: `Subscription pause: ${v.days}d (resume ${(v.resume_at || '').slice(0, 10)})`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('retention_discount')) {
    tasks.push(collectKind('retention_discount', 'retention:discount:*', function (v) {
      if (!v.accepted_at) return null;
      return {
        at: v.accepted_at,
        userSub: v.userSub,
        summary: `Retention discount: ${v.pct}% × ${v.months}mo`,
        action_url: '/api/admin/user-timeline?sub=' + encodeURIComponent(v.userSub),
      };
    }));
  }

  if (activeKinds.includes('sheet_anomaly')) {
    tasks.push(collectKind('sheet_anomaly', 'sheet_anomaly:*', function (v) {
      if (!v.at) return null;
      return {
        at: v.at,
        userSub: null,
        summary: `🚨 Multi-writer anomaly: sheet ${(v.spreadsheetId || '').slice(0, 16)}... had ${(v.userSubs || []).length} distinct writers. Phone: ${v.lastPhone || '?'}`,
        action_url: '/admin/launch-monitor',
        severity: 'critical',
      };
    }));
  }

  const collected = (await Promise.all(tasks)).flat();
  collected.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // Group counts so the UI can show "12 unread" badges per kind.
  const counts = {};
  for (const it of collected) {
    counts[it.kind] = (counts[it.kind] || 0) + 1;
  }

  return res.status(200).json({
    ok: true,
    counts,
    total: collected.length,
    items: collected.slice(0, limit),
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_inbox', limit: 60, windowSec: 60 })(requireAdmin(handlerImpl))
);
