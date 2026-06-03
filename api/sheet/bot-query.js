// /api/sheet/bot-query
//
// Bot-callable (bot-secret) conversational data query endpoint. Lets the
// Apps Script bot answer natural-language questions like "how much did I
// spend this week" / "what is my biggest expense this month" / "compare
// to last month" with the actual numbers from the user's sheet -- BEFORE
// falling back to the Gemini money-coach.
//
// Same auth + credential pattern as /api/sheet/append + /api/sheet/stats:
//   - shared bot secret (constantTimeEqual) + per-phone KV lookup
//   - resolves canonical sheet via sheet:{userSub}, refresh token via
//     user:{userSub}, with the leak guard from append.js
//   - read-only -- never writes to the user's sheet
//
// POST body:
//   {
//     phone: "972526003090",
//     queryType: "total" | "category" | "largest" | "income" | "comparison" | "top_categories",
//     period: "week" | "month" | "last_month" | "year",  // default "month"
//     category: "מזון",                                  // optional, for queryType=category
//     botSecret: "..."  // OR x-kesefle-bot-secret header
//   }
//
// Returns:
//   {
//     ok: true,
//     queryType,
//     period,
//     total: 1234,                                  // total amount for the matched scope
//     count: 17,                                    // count of matching rows
//     breakdown: [{ label, amount }, ...],         // top items (categories / expenses)
//     comparison: { prev_total, pct },              // present only for queryType=comparison
//     currency: 'ILS',
//   }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { decryptRefreshToken, constantTimeEqual } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { TX_TAB } from '../../lib/sheet-tabs.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
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

async function fetchSheetRange(spreadsheetId, range, accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json();
  return { ok: true, values: j.values || [] };
}

function parseDateCell(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // dd/mm/yyyy or dd.mm.yyyy
  let m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(dt) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

// ── Period windows (Asia/Jerusalem-naive; the bot's users are all IL) ──
function periodWindow(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (period === 'week') {
    // Start = most recent Sunday 00:00 (he-IL week starts Sunday)
    const start = new Date(y, m, d);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(y, m, d + 1);
    return { start, end, label: 'השבוע' };
  }
  if (period === 'last_month') {
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 1);
    return { start, end, label: 'חודש שעבר' };
  }
  if (period === 'year') {
    const start = new Date(y, 0, 1);
    const end = new Date(y + 1, 0, 1);
    return { start, end, label: 'השנה' };
  }
  // default: this month
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 1);
  return { start, end, label: 'החודש' };
}

function inWindow(date, win) {
  return date >= win.start && date < win.end;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Bot-only -- fail closed if the shared secret env is missing.
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('bot_query.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  // Timing-safe comparison (same pattern as mark-vat.js + admin/stats.js).
  if (!botSecret || !constantTimeEqual(String(botSecret), expected)) {
    log.warn('bot_query.unauthorized', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  // Per-phone rate limit -- 30 queries/hour is plenty for a real user.
  const phoneLim = await rateLimitId(phone, { key: 'bot_query_phone', limit: 30, windowSec: 3600 });
  if (!phoneLim.ok) {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded', retry_after: phoneLim.retryAfter });
  }

  const queryType = String(body?.queryType || 'total').toLowerCase();
  const period = String(body?.period || 'month').toLowerCase();
  const filterCategory = body?.category ? String(body.category).trim() : '';

  const VALID_QUERIES = new Set(['total', 'category', 'largest', 'income', 'comparison', 'top_categories']);
  if (!VALID_QUERIES.has(queryType)) {
    return res.status(400).json({ ok: false, error: 'invalid_query_type' });
  }
  const VALID_PERIODS = new Set(['week', 'month', 'last_month', 'year']);
  if (!VALID_PERIODS.has(period)) {
    return res.status(400).json({ ok: false, error: 'invalid_period' });
  }

  // Resolve user (same pattern as append.js / mark-vat.js).
  const phoneRec = await kvGet(`phone:${phone}`);
  if (!phoneRec || !phoneRec.userSub) {
    return res.status(404).json({ ok: false, error: 'no_user_for_phone' });
  }
  const sheetRec = await kvGet(`sheet:${phoneRec.userSub}`);
  const userRec = (await kvGet(`user:${phoneRec.userSub}`)) || {};
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    log.error('bot_query.sheet_ownership_mismatch', {
      reqId: req.reqId, phone, userSub: phoneRec.userSub,
      phoneRecordSheet: phoneSheetId, canonicalSheet: canonicalSheetId,
    });
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
  }
  const spreadsheetId = canonicalSheetId || phoneSheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) {
    return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
  }

  // Decrypt the refresh token.
  let refreshToken = null;
  try {
    if (userRec.refreshTokenEnvelope) {
      refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, phoneRec.userSub);
    } else if (userRec.refreshToken) {
      refreshToken = userRec.refreshToken;
    }
  } catch (e) {
    log.warn('bot_query.decrypt_failed', { reqId: req.reqId, phone });
  }
  if (!refreshToken) return res.status(409).json({ ok: false, error: 'reauth_required' });

  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) { return res.status(502).json({ ok: false, error: 'token_exchange_failed' }); }

  // Read the תנועות tab (same fallback chain as stats.js).
  const year = new Date().getFullYear();
  let result = await fetchSheetRange(spreadsheetId, `'${year}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, `'${TX_TAB}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, 'A1:N', accessToken);
  if (!result.ok) return res.status(502).json({ ok: false, error: 'sheets_read_failed', status: result.status });

  const allRows = result.values || [];
  if (!allRows.length) {
    return res.status(200).json({
      ok: true, queryType, period, total: 0, count: 0, breakdown: [], currency: 'ILS',
    });
  }

  // Resolve column indices from the header row (same logic as stats.js).
  const header = allRows[0].map((h) => String(h || '').trim().toLowerCase());
  const colIndex = (aliases, fb) => {
    for (let i = 0; i < header.length; i++) if (aliases.some((a) => header[i].includes(a))) return i;
    return fb;
  };
  const idx = {
    date: colIndex(['תאריך', 'date', 'timestamp', 'זמן'], 0),
    amount: colIndex(['סכום', 'amount', 'sum', 'price'], 2),
    category: colIndex(['קטגוריה', 'category', 'קטגורי'], 3),
    subcategory: colIndex(['תת', 'sub'], 4),
    description: colIndex(['פירוט', 'תיאור', 'description', 'desc', 'raw', 'note'], 5),
    // col H: true=expense, false=income (see lib/sheet-writer.js TX_HEADERS).
    flag: colIndex(['סטטוס', 'flag', 'הוצאה'], 7),
  };
  const firstIsHeader = !parseDateCell(allRows[0][idx.date]);
  const dataRows = firstIsHeader ? allRows.slice(1) : allRows;

  // ── Aggregate over the requested period ──
  const win = periodWindow(period);
  const filtered = [];
  for (const raw of dataRows) {
    if (!raw || !raw.length) continue;
    const date = parseDateCell(raw[idx.date]);
    if (!date || !inWindow(date, win)) continue;
    const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
    if (!amount) continue;
    const cat = (raw[idx.category] || '').toString().trim() || 'אחר';
    const sub = (raw[idx.subcategory] || '').toString().trim();
    const desc = (raw[idx.description] || '').toString().trim();
    // Col H: true => expense, false => income. Legacy rows may be empty;
    // treat empty as expense (matches the dashboard SUMIFS default).
    const rawFlag = raw[idx.flag];
    const flagStr = String(rawFlag == null ? '' : rawFlag).trim().toLowerCase();
    const isIncome = (flagStr === 'false' || flagStr === 'הכנסה' || cat === 'הכנסות' || cat === 'הכנסה');
    filtered.push({ date, amount: Math.abs(amount), category: cat, subcategory: sub, description: desc, isIncome });
  }

  // ── Helper: aggregate expenses only ──
  function aggregateExpenses(rows) {
    let total = 0, count = 0;
    const byCat = {};
    for (const r of rows) {
      if (r.isIncome) continue;
      total += r.amount; count++;
      byCat[r.category] = (byCat[r.category] || 0) + r.amount;
    }
    const breakdown = Object.keys(byCat)
      .map((c) => ({ label: c, amount: Math.round(byCat[c]) }))
      .sort((a, b) => b.amount - a.amount);
    return { total: Math.round(total), count, breakdown };
  }

  // ── Dispatch by queryType ──
  if (queryType === 'total') {
    const agg = aggregateExpenses(filtered);
    return res.status(200).json({
      ok: true, queryType, period, periodLabel: win.label,
      total: agg.total, count: agg.count, breakdown: agg.breakdown.slice(0, 5),
      currency: 'ILS',
    });
  }

  if (queryType === 'category') {
    if (!filterCategory) return res.status(400).json({ ok: false, error: 'missing_category' });
    // Loose match on category OR subcategory OR description (Hebrew users
    // often say "מזון" when their category is "אוכל" — match both).
    const needle = filterCategory.toLowerCase();
    const matched = filtered.filter((r) => !r.isIncome && (
      r.category.toLowerCase().includes(needle) ||
      r.subcategory.toLowerCase().includes(needle) ||
      r.description.toLowerCase().includes(needle)
    ));
    let total = 0;
    for (const r of matched) total += r.amount;
    return res.status(200).json({
      ok: true, queryType, period, periodLabel: win.label,
      total: Math.round(total), count: matched.length,
      breakdown: matched.slice(0, 5).map((r) => ({
        label: r.description || r.subcategory || r.category,
        amount: Math.round(r.amount),
      })),
      matchedCategory: filterCategory,
      currency: 'ILS',
    });
  }

  if (queryType === 'largest') {
    const expenses = filtered.filter((r) => !r.isIncome);
    expenses.sort((a, b) => b.amount - a.amount);
    const top = expenses[0] || null;
    return res.status(200).json({
      ok: true, queryType, period, periodLabel: win.label,
      total: top ? Math.round(top.amount) : 0,
      count: expenses.length,
      breakdown: expenses.slice(0, 3).map((r) => ({
        label: r.description || r.subcategory || r.category,
        category: r.category,
        amount: Math.round(r.amount),
      })),
      currency: 'ILS',
    });
  }

  if (queryType === 'income') {
    const income = filtered.filter((r) => r.isIncome);
    let total = 0;
    const bySrc = {};
    for (const r of income) {
      total += r.amount;
      const key = r.subcategory || r.category || 'הכנסה';
      bySrc[key] = (bySrc[key] || 0) + r.amount;
    }
    const breakdown = Object.keys(bySrc)
      .map((k) => ({ label: k, amount: Math.round(bySrc[k]) }))
      .sort((a, b) => b.amount - a.amount);
    return res.status(200).json({
      ok: true, queryType, period, periodLabel: win.label,
      total: Math.round(total), count: income.length,
      breakdown: breakdown.slice(0, 5),
      currency: 'ILS',
    });
  }

  if (queryType === 'comparison') {
    // Always compare this-month vs last-month, regardless of period.
    const thisWin = periodWindow('month');
    const prevWin = periodWindow('last_month');
    let thisTotal = 0, prevTotal = 0;
    for (const raw of dataRows) {
      if (!raw || !raw.length) continue;
      const date = parseDateCell(raw[idx.date]);
      if (!date) continue;
      const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
      if (!amount) continue;
      const cat = (raw[idx.category] || '').toString().trim() || 'אחר';
      const rawFlag = raw[idx.flag];
      const flagStr = String(rawFlag == null ? '' : rawFlag).trim().toLowerCase();
      const isIncome = (flagStr === 'false' || flagStr === 'הכנסה' || cat === 'הכנסות' || cat === 'הכנסה');
      if (isIncome) continue;
      if (inWindow(date, thisWin)) thisTotal += Math.abs(amount);
      else if (inWindow(date, prevWin)) prevTotal += Math.abs(amount);
    }
    const pct = prevTotal > 0 ? Math.round(((thisTotal - prevTotal) / prevTotal) * 100) : null;
    return res.status(200).json({
      ok: true, queryType, period: 'month', periodLabel: 'השוואה',
      total: Math.round(thisTotal), count: 0, breakdown: [],
      comparison: { prev_total: Math.round(prevTotal), pct },
      currency: 'ILS',
    });
  }

  if (queryType === 'top_categories') {
    const agg = aggregateExpenses(filtered);
    return res.status(200).json({
      ok: true, queryType, period, periodLabel: win.label,
      total: agg.total, count: agg.count,
      breakdown: agg.breakdown.slice(0, 5),
      currency: 'ILS',
    });
  }

  // Should be unreachable -- guarded by VALID_QUERIES above.
  return res.status(400).json({ ok: false, error: 'invalid_query_type' });
}

// 60/min IP-level cap (defense-in-depth; the per-phone cap above is the real
// guard since the bot calls from rotating egress IPs).
export default withRequestId(
  withRateLimit({ key: 'sheet_bot_query', limit: 60, windowSec: 60 })(handlerImpl)
);
