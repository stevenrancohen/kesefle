// /api/admin/user-action
// POST — perform an administrative action against a target user.
//
// Body: { action, targetUserSub }
//   action ∈ {
//     'resend_welcome',     // re-trigger the welcome WhatsApp message
//     'force_resync',       // re-read sheet structure (clears any cached schema)
//     'reset_plan_to_free', // downgrade plan back to free (no Stripe call here)
//     'pause_account',      // sets status=suspended (webhook drops messages)
//     'unpause_account',    // sets status=active again
//     'reset_password',     // placeholder — we use Google SSO, no password
//   }
//
// All actions are audit-logged via the lib/secure-kv.js auditLog() (730d retain).
// Rate-limited to 5 actions per minute per admin to slow down a compromised
// admin account from running destructive operations in bulk.
//
// CSRF posture: this endpoint requires Authorization: Bearer <Google ID token>.
// Cookies alone are not sufficient — see lib/auth.js requireAuth().
//
// NOTE: this endpoint deliberately does NOT support deleting accounts. Account
// deletion remains user-driven via /api/account/delete (per Israeli Amendment 13
// + GDPR Article 17 right to be forgotten — admins shouldn't pull that trigger).

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvGet, kvSet, kvConfigured, kvOutage } from './_kv.js';
import { auditLog, saveUser } from '../../lib/secure-kv.js';

const ALLOWED_ACTIONS = new Set([
  'resend_welcome',
  'force_resync',
  'reset_plan_to_free',
  'pause_account',
  'unpause_account',
  'reset_password',
]);

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

async function performAction(action, targetSub, reqId) {
  // We re-read the user record at the moment of action to ensure idempotency
  // checks see the latest state (in case two admin tabs race).
  const user = await kvGet('user:' + targetSub);
  if (!user) return { ok: false, error: 'target_not_found' };

  switch (action) {
    case 'resend_welcome': {
      // Mark a pending welcome — a worker (or the next inbound message handler)
      // should see this flag and dispatch. Keeps this endpoint side-effect-free
      // wrt the WhatsApp API and avoids Meta rate-limit surprises during a UI click.
      await saveUser(targetSub, { /* trigger via lastSeen touch */ }, { reqId });
      await kvSet('pending_welcome:' + targetSub, { ts: new Date().toISOString() });
      return { ok: true, queued: 'welcome_resend' };
    }
    case 'force_resync': {
      // Wipe any cached sheet schema so the next /api/sheet/summary call re-probes.
      // (Schema cache key naming is reserved for a future writer.)
      await kvSet('sheet_schema_invalid:' + targetSub, { ts: new Date().toISOString() }, { ttlSec: 3600 });
      return { ok: true, queued: 'sheet_resync' };
    }
    case 'reset_plan_to_free': {
      await saveUser(targetSub, {
        plan: 'free',
        subscriptionStatus: 'canceled',
        canceledAt: new Date().toISOString(),
      }, { reqId });
      return { ok: true, applied: 'plan=free' };
    }
    case 'pause_account': {
      await saveUser(targetSub, { status: 'suspended' }, { reqId });
      return { ok: true, applied: 'status=suspended' };
    }
    case 'unpause_account': {
      await saveUser(targetSub, { status: 'active' }, { reqId });
      return { ok: true, applied: 'status=active' };
    }
    case 'reset_password': {
      // Kesefle uses Google / Apple / Facebook SSO — there's no password to reset.
      // We return a soft success so the admin UI can render a "no-op" toast.
      return { ok: true, noop: 'sso_only_no_password' };
    }
    default:
      return { ok: false, error: 'unknown_action' };
  }
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  const body = parseBody(req);
  const action = String(body.action || '').trim();
  const targetUserSub = String(body.targetUserSub || '').trim();

  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ ok: false, error: 'invalid_action', reqId, allowed: Array.from(ALLOWED_ACTIONS) });
  }
  if (!targetUserSub || targetUserSub.length > 128 || !/^[A-Za-z0-9_\-]+$/.test(targetUserSub)) {
    return res.status(400).json({ ok: false, error: 'invalid_target_user_sub', reqId });
  }

  let result;
  try {
    result = await performAction(action, targetUserSub, reqId);
  } catch (e) {
    log.error('admin.user_action.failed', {
      reqId, adminEmail: req.user.email, action, error: e.message,
    });
    return res.status(500).json({ ok: false, error: 'action_failed', reqId });
  }

  // Always audit (even no-op results), so we can prove what an admin did.
  await auditLog('admin_user_action', targetUserSub, {
    action,
    adminEmail: req.user.email,
    adminSub: req.user.sub,
    result,
  }, { reqId });

  if (!result.ok) {
    return res.status(404).json({ ok: false, error: result.error, action, target: targetUserSub, reqId });
  }

  log.info('admin.user_action.applied', {
    reqId, adminEmail: req.user.email, action, target: targetUserSub.slice(0, 8) + '...',
  });

  return res.status(200).json({
    ok: true,
    action,
    target: targetUserSub,
    result,
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_user_action', limit: 5, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
