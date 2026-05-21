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

// Best-effort write — used to self-heal a phone record (never blocks a write).
async function kvSet(key, val) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(val),
    });
    return r.ok;
  } catch { return false; }
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

  // ── HARD ASSERTION — tenant isolation ──────────────────────────────
  // The record resolved from phone:{phone} must carry a userSub AND a
  // spreadsheetId, and that sheet must match the canonical sheet registered
  // for the user (sheet:{userSub}). If a phone record were ever corrupted to
  // point at someone else's sheet, abort BEFORE writing rather than leak.
  // (The OAuth token is also minted from this same userSub, so Google
  //  itself rejects writes to a sheet the user doesn't own — this is the
  //  belt to that suspenders.)
  if (!userRecord.userSub) {
    log.error('append.incomplete_user_record', { reqId: req.reqId, phone });
    return res.status(409).json({ ok: false, error: 'incomplete_user_record' });
  }
  const sheetRec = await kvGet(`sheet:${userRecord.userSub}`);
  // SELF-HEAL: a phone linked before its sheet finished provisioning ends up
  // with spreadsheetId:null. The bot still sees "linked" and tries to write,
  // append used to reject 409 → the customer got "couldn't save, try again"
  // forever. Recover the id from the CANONICAL sheet:{userSub} (the same source
  // the ownership check trusts — so this cannot leak) and backfill the record.
  if (!userRecord.spreadsheetId) {
    if (sheetRec?.spreadsheetId) {
      userRecord.spreadsheetId = sheetRec.spreadsheetId;
      await kvSet(`phone:${phone}`, userRecord); // best-effort; write proceeds regardless
      log.info('append.phone_record_healed', { reqId: req.reqId, phone, userSub: userRecord.userSub, spreadsheetId: userRecord.spreadsheetId });
    } else {
      // No canonical sheet either → the customer truly has no sheet yet.
      log.error('append.no_sheet_provisioned', { reqId: req.reqId, phone, userSub: userRecord.userSub });
      return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
    }
  }
  if (sheetRec?.spreadsheetId && sheetRec.spreadsheetId !== userRecord.spreadsheetId) {
    log.error('append.sheet_ownership_mismatch', {
      reqId: req.reqId, phone, userSub: userRecord.userSub,
      phoneRecordSheet: userRecord.spreadsheetId, canonicalSheet: sheetRec.spreadsheetId,
    });
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
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

  // Traceability: log phone → userSub → sheetId for every successful write,
  // keyed by timestamp (30-day TTL). Lets us audit routing after the fact.
  // Fire-and-forget — never block or fail a write on logging.
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken) {
      const logKey = `write_log:${Date.now()}:${phone}`;
      const logVal = JSON.stringify({
        phone,
        userSub: userRecord.userSub,
        sheetId: userRecord.spreadsheetId,
        rowIndex: result.rowIndex || null,
        amount,
        at: new Date().toISOString(),
      });
      await fetch(`${kvUrl}/set/${encodeURIComponent(logKey)}?EX=2592000`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}` },
        body: logVal,
      }).catch(() => {});
    }
  } catch (_) { /* logging must never break a write */ }

  // Anomaly detector (defense-in-depth): a PERSONAL sheet should only ever be
  // written by ONE userSub (family expense-sharing goes through /api/group, not
  // this endpoint). If a SECOND distinct userSub writes to the same
  // spreadsheetId within an hour, that signals a corrupted phone→sheet mapping —
  // exactly the class of bug behind the original cross-tenant leak. Log it
  // loudly and persist a sheet_anomaly record for review. Fire-and-forget;
  // never affects the write result.
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken && userRecord.spreadsheetId && userRecord.userSub) {
      const swKey = `sheetwriters:${userRecord.spreadsheetId}`;
      const prev = await kvGet(swKey);
      const subs = (prev && Array.isArray(prev.subs)) ? prev.subs.slice(0, 10) : [];
      if (!subs.includes(userRecord.userSub)) {
        subs.push(userRecord.userSub);
        await fetch(`${kvUrl}/set/${encodeURIComponent(swKey)}?EX=3600`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken}` },
          body: JSON.stringify({ subs, at: new Date().toISOString() }),
        }).catch(() => {});
      }
      if (subs.length > 1) {
        log.error('append.sheet_multi_writer_anomaly', {
          reqId: req.reqId, spreadsheetId: userRecord.spreadsheetId, userSubs: subs,
        });
        await fetch(`${kvUrl}/set/${encodeURIComponent('sheet_anomaly:' + Date.now())}?EX=2592000`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${kvToken}` },
          body: JSON.stringify({ spreadsheetId: userRecord.spreadsheetId, userSubs: subs, lastPhone: phone, at: new Date().toISOString() }),
        }).catch(() => {});
      }
    }
  } catch (_) { /* detector must never break a write */ }

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
