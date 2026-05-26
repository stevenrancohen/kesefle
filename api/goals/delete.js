// /api/goals/delete
//
// PR-1 of Smart Budget Goals. Called by the bot when the user types
// "מחק יעד <category>". Soft delete (sets active: false on the record so
// PR-2 alerts won't fire for the dropped category, but the record stays
// for audit + GDPR data export).
//
// Auth: bot-secret only in PR-1.
//
// POST body:
//   {
//     phone: "972...",
//     category: "אוכל",     // required — what the user typed after "מחק יעד"
//   }
//
// Returns:
//   200 { ok: true,  deleted: true,  goalId }
//   200 { ok: true,  deleted: false, reason: 'not_found' }
//   401 { ok: false, error: 'bad_bot_secret' }
//   404 { ok: false, error: 'no_user_for_phone' }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { deleteGoalByCategory } from '../../lib/goals.js';

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
  if (!expected) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    return res.status(401).json({ ok: false, error: 'bad_bot_secret' });
  }

  const phone = String(body?.phone || '').replace(/[^0-9]/g, '');
  const category = String(body?.category || '').trim().slice(0, 60);
  if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
  if (!category) return res.status(400).json({ ok: false, error: 'category required' });

  const phoneRec = await _kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }

  try {
    const result = await deleteGoalByCategory(phoneRec.userSub, category);
    log.info('goals.delete.ok', {
      reqId: req.reqId,
      userSub: phoneRec.userSub,
      category,
      deleted: !!result.deleted,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    log.error('goals.delete.failed', { reqId: req.reqId, error: e.message });
    return res.status(500).json({ ok: false, error: 'kv_failure', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'goals_delete', limit: 30, windowSec: 600 })(handlerImpl)
);
