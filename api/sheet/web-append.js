// api/sheet/web-append.js
//
// User-authenticated web-form expense write. Unlike /api/sheet/append (which
// is bot-secret-gated for the WhatsApp flow), this endpoint requires a real
// user session and writes to THAT user's sheet directly. Lets users add
// expenses from /expense web form without going through WhatsApp -- critical
// while WABA verification is pending (non-allow-listed phones can still
// use the product).
//
// POST /api/sheet/web-append
//   { amount, isIncome?, category?, subcategory?, rawText?, date?, vatDeductible? }
// Auth: requireAuth (session cookie or Bearer).
// Rate limit: 60 writes/hour per userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { appendRowToUserSheet, buildExpenseRow } from '../../lib/sheet-writer.js';
import { recordExpenseActivity } from '../../lib/user-activity.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_e) { return null; }
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'web_append_user', limit: 60, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0 || amount > 1e8) {
    return res.status(400).json({ ok: false, error: 'invalid_amount' });
  }

  // Resolve user's canonical sheet + refresh token.
  const sheetRec = await kvGet(`sheet:${userSub}`);
  const userRec = (await kvGet(`user:${userSub}`)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) {
    return res.status(409).json({ ok: false, error: 'no_sheet_provisioned', detail: 'Sign in at /account to provision your sheet first.' });
  }
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required', detail: 'Re-authenticate at /account.' });
  }

  const userRecord = {
    userSub,
    spreadsheetId,
    refreshTokenEnvelope: userRec.refreshTokenEnvelope || null,
    refreshToken: userRec.refreshToken || null,
  };

  // Sanitize all string inputs (max 200 chars; sheet-writer also runs its
  // own sanitizeCell pass on the rawText slot).
  function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }

  const row = buildExpenseRow({
    amount,
    isIncome: !!body.isIncome,
    category: clip(body.category || 'שונות', 60),
    subcategory: clip(body.subcategory || '', 60),
    rawText: clip(body.rawText || (body.category || ''), 200),
    date: body.date,
    vatDeductible: !!body.vatDeductible,
  });

  const result = await appendRowToUserSheet({ userRecord, row });
  if (!result.ok) {
    log.warn('web_append.write_failed', { reqId: req.reqId, userSub, error: result.error });
    return res.status(502).json({ ok: false, error: result.error, detail: result.detail });
  }

  log.info('web_append.ok', { reqId: req.reqId, userSub, spreadsheetId, rowIndex: result.rowIndex });

  // Activation telemetry: same as /api/sheet/append — bump expensesCount +
  // stamp lastActive on user:{userSub} so the lifecycle cron's day-1/day-7/
  // weekly-digest/inactivity gates work for web-form expenses too. Reuses the
  // `userRec` already fetched above (line ~58): one extra KV SET, no extra GET.
  try {
    await recordExpenseActivity({ userSub, currentRecord: userRec });
  } catch (_actErr) { /* telemetry must never break a write */ }

  return res.status(200).json({
    ok: true,
    rowIndex: result.rowIndex,
    spreadsheetUrl: sheetRec?.spreadsheetUrl || null,
  });
}

export default withRequestId(
  withRateLimit({ key: 'web_append', limit: 120, windowSec: 60 })(requireAuth(handlerImpl))
);
