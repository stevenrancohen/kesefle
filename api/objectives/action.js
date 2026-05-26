// /api/objectives/action
//
// PR-G2-mini single endpoint that handles all objective actions for the
// bot. Smaller surface area than 5 separate endpoints; same isolation
// pattern as /api/goals/*.
//
// Auth: bot-secret only.
//
// POST body:
//   { phone, action: 'get'|'set'|'rename'|'mute'|'achieve'|'delete', ... }
//
// Each action's extra params:
//   set      -> { horizon: 'month'|'six_months'|'year', description }
//   rename   -> { description }
//   get/mute/achieve/delete -> just { action, phone }
//
// Returns:
//   200 { ok: true, objective }   on get/set/rename/mute/achieve
//   200 { ok: true, deleted }     on delete
//   400 { ok: false, error }      on bad input
//   401 { ok: false, error }      on bad bot-secret
//   404 { ok: false, error }      on no user for phone

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import {
  getObjective,
  setObjective,
  renameObjective,
  muteObjective,
  achieveObjective,
  deleteObjective,
} from '../../lib/objectives.js';

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOK = () => process.env.KV_REST_API_TOKEN;

async function _kvGet(key) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('objectives.action.no_secret_env', { reqId: req.reqId });
    return res.status(500).json({ ok: false, error: 'server_misconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const botSecret = req.headers['x-kesefle-bot-secret'] || body.botSecret;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    return res.status(401).json({ ok: false, error: 'bad_bot_secret' });
  }

  const phone = String(body.phone || '').replace(/[^0-9]/g, '');
  const action = String(body.action || '').trim();
  if (!phone) return res.status(400).json({ ok: false, error: 'phone_required' });
  if (!action) return res.status(400).json({ ok: false, error: 'action_required' });

  const phoneRec = await _kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }
  const userSub = phoneRec.userSub;

  try {
    switch (action) {
      case 'get': {
        const objective = await getObjective(userSub);
        log.info('objectives.get.ok', { reqId: req.reqId, userSub, hasObjective: !!objective });
        return res.status(200).json({ ok: true, objective });
      }
      case 'set': {
        const horizon = String(body.horizon || '').trim();
        const description = String(body.description || '').trim().slice(0, 200);
        if (!horizon || !description) {
          return res.status(400).json({ ok: false, error: 'horizon_and_description_required' });
        }
        const objective = await setObjective(userSub, { horizon, description });
        log.info('objectives.set.ok', { reqId: req.reqId, userSub, horizon });
        return res.status(200).json({ ok: true, objective });
      }
      case 'rename': {
        const description = String(body.description || '').trim().slice(0, 200);
        if (!description) return res.status(400).json({ ok: false, error: 'description_required' });
        const objective = await renameObjective(userSub, description);
        if (!objective) return res.status(404).json({ ok: false, error: 'no_objective' });
        log.info('objectives.rename.ok', { reqId: req.reqId, userSub });
        return res.status(200).json({ ok: true, objective });
      }
      case 'mute': {
        const objective = await muteObjective(userSub);
        if (!objective) return res.status(404).json({ ok: false, error: 'no_objective' });
        log.info('objectives.mute.ok', { reqId: req.reqId, userSub });
        return res.status(200).json({ ok: true, objective });
      }
      case 'achieve': {
        const objective = await achieveObjective(userSub);
        if (!objective) return res.status(404).json({ ok: false, error: 'no_objective' });
        log.info('objectives.achieve.ok', { reqId: req.reqId, userSub });
        return res.status(200).json({ ok: true, objective });
      }
      case 'delete': {
        const deleted = await deleteObjective(userSub);
        log.info('objectives.delete.ok', { reqId: req.reqId, userSub, deleted });
        return res.status(200).json({ ok: true, deleted });
      }
      default:
        return res.status(400).json({ ok: false, error: 'unknown_action: ' + action });
    }
  } catch (e) {
    log.error('objectives.action.failed', { reqId: req.reqId, userSub, action, error: e.message });
    return res.status(500).json({ ok: false, error: 'server_error', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'objectives_action', limit: 60, windowSec: 600 })(handlerImpl)
);
