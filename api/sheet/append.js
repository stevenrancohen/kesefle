// /api/sheet/append
//
// Bridge endpoint called by the Apps Script bot when it needs to write
// an expense row to a NON-owner user's sheet. The bot retains its rich
// Hebrew parser (categorization, FX detection, business-vs-personal
// routing, etc.) and just hands the parsed expense to us for a tenant
// write. We handle the encrypted-refresh-token unwrap, OAuth exchange,
// and Sheets REST API call.
//
// POST body:
//   {
//     phone: "972526003090",         // E.164, used to look up the user
//     amount: 245,
//     currency: "ILS",               // optional, default ILS
//     isIncome: false,               // optional, default false
//     category: "מזון",
//     subcategory: "סופר",
//     rawText: "245 סופר רמי לוי",
//     messageId: "wamid.XXX",        // for de-dup logging
//     botSecret: "..."               // OR x-kesefle-bot-secret header
//   }
//
// Returns:
//   { ok: true, rowIndex: "'תנועות'!A567" }
//   { ok: false, error: "no_user_for_phone" | "refresh_token_decrypt_failed" | ... }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { appendRowToUserSheet, buildExpenseRow } from '../../lib/sheet-writer.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Bot-only — fail closed if the shared secret env is missing.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('append.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (botSecret !== expected) {
    log.warn('append.unauthorized', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const userRecord = await kvGet(`phone:${phone}`);
  if (!userRecord) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }

  const amount = Number(body?.amount);
  if (!isFinite(amount) || amount <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_amount' });
  }

  const row = buildExpenseRow({
    amount,
    currency: body?.currency,
    isIncome: !!body?.isIncome,
    category: body?.category,
    subcategory: body?.subcategory,
    rawText: body?.rawText,
    messageId: body?.messageId,
  });

  const result = await appendRowToUserSheet({ userRecord, row });
  if (!result.ok) {
    log.warn('append.write_failed', { reqId: req.reqId, phone, error: result.error });
    return res.status(502).json({ ok: false, error: result.error, detail: result.detail });
  }

  log.info('append.ok', { reqId: req.reqId, phone, rowIndex: result.rowIndex });
  return res.status(200).json({
    ok: true,
    rowIndex: result.rowIndex,
    spreadsheetUrl: userRecord.spreadsheetUrl || null,
  });
}

// 60 writes/minute per phone is well above any human chatting cadence
// and still protects against a single mis-configured Apps Script loop.
export default withRequestId(
  withRateLimit({ key: 'sheet_append', limit: 60, windowSec: 60 })(handlerImpl)
);
