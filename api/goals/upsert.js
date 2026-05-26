// /api/goals/upsert
//
// PR-1 of Smart Budget Goals. Called by the Apps Script bot when the user
// types "קבע יעד <category> <amount>" or "קבע יעד <amount>" (savings).
//
// Auth: bot-secret only in PR-1. Web dashboard widget (PR-3) will add an
//       optional requireAuth path so the user can manage goals from /dashboard.
//
// POST body:
//   {
//     phone: "972...",      // E.164, used to look up userSub via phone:{E164}
//     type: "spend_cap"|"savings",
//     category: "אוכל",     // required for spend_cap, ignored for savings
//     amountILS: 3000,
//     block: false          // optional; PR-3 wires the pre-write block
//   }
//
// Returns:
//   200 { ok: true, created: true|false, goal: {...} }
//   400 { ok: false, error: 'bad_input', detail }
//   401 { ok: false, error: 'bad_bot_secret' }
//   404 { ok: false, error: 'no_user_for_phone' }
//   500 { ok: false, error: 'kv_failure' }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { upsertGoal } from '../../lib/goals.js';

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

  // Bot-secret gate (timing-safe). Same pattern as /api/sheet/append.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('goals.upsert.no_secret_env', { reqId: req.reqId });
    return res.status(500).json({ ok: false, error: 'server_misconfigured' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    return res.status(401).json({ ok: false, error: 'bad_bot_secret' });
  }

  const phone = String(body?.phone || '').replace(/[^0-9]/g, '');
  const type = String(body?.type || '').trim();
  const category = body?.category ? String(body.category).trim().slice(0, 60) : null;
  const amountILS = Number(body?.amountILS);
  const block = body?.block === true;

  if (!phone) return res.status(400).json({ ok: false, error: 'bad_input', detail: 'phone required' });
  if (type !== 'spend_cap' && type !== 'savings') {
    return res.status(400).json({ ok: false, error: 'bad_input', detail: 'type must be spend_cap or savings' });
  }
  if (type === 'spend_cap' && !category) {
    return res.status(400).json({ ok: false, error: 'bad_input', detail: 'category required for spend_cap' });
  }
  if (!isFinite(amountILS) || amountILS < 1 || amountILS > 10_000_000) {
    return res.status(400).json({ ok: false, error: 'bad_input', detail: 'amountILS must be 1..10,000,000' });
  }

  const phoneRec = await _kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    log.warn('goals.upsert.no_user_for_phone', { reqId: req.reqId, phone });
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }

  try {
    const result = await upsertGoal(phoneRec.userSub, { type, category, amountILS, block });
    log.info('goals.upsert.ok', {
      reqId: req.reqId,
      userSub: phoneRec.userSub,
      goalId: result.goal.id,
      type,
      created: result.created,
    });
    return res.status(200).json({ ok: true, created: result.created, goal: result.goal });
  } catch (e) {
    log.error('goals.upsert.failed', { reqId: req.reqId, userSub: phoneRec.userSub, error: e.message });
    return res.status(500).json({ ok: false, error: 'kv_failure', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'goals_upsert', limit: 30, windowSec: 600 })(handlerImpl)
);
