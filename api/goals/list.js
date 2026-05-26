// /api/goals/list
//
// PR-1 of Smart Budget Goals. Called by the bot when the user types "יעדים".
// Returns the user's active goals (no thresholds-progress in PR-1 — that's PR-2).
//
// Auth: bot-secret only in PR-1.
//
// GET / POST (both accepted for simplicity from Apps Script UrlFetchApp):
//   ?phone=972...           (or in JSON body)
//   x-kesefle-bot-secret    (or botSecret in body)
//
// Returns:
//   200 { ok: true, goals: [...] }
//   401 { ok: false, error: 'bad_bot_secret' }
//   404 { ok: false, error: 'no_user_for_phone' }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { listGoals } from '../../lib/goals.js';

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
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    return res.status(401).json({ ok: false, error: 'bad_bot_secret' });
  }

  const phone = String(req.query?.phone || body?.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

  const phoneRec = await _kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }

  try {
    const goals = await listGoals(phoneRec.userSub);
    log.info('goals.list.ok', { reqId: req.reqId, userSub: phoneRec.userSub, count: goals.length });
    return res.status(200).json({ ok: true, goals });
  } catch (e) {
    log.error('goals.list.failed', { reqId: req.reqId, error: e.message });
    return res.status(500).json({ ok: false, error: 'kv_failure', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'goals_list', limit: 60, windowSec: 600 })(handlerImpl)
);
