// api/sheet/monthly-statement.js
//
// Generate a structured monthly statement of a user's expenses for any
// month. Used by /statement.html to render a print-friendly view that
// can be saved as PDF and sent to a bookkeeper.
//
// GET /api/sheet/monthly-statement?month=YYYY-MM
//   Default month = current month
// Auth: requireAuth (session cookie or Bearer).
// Rate limit: 30/hour/userSub.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { requireAuth } from '../../lib/auth.js';
import { exchangeRefreshForAccess, TX_TAB } from '../../lib/sheet-writer.js';
import { decryptRefreshToken } from '../../lib/crypto.js';

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

function round2(n) { return Math.round(Number(n) * 100) / 100; }

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  const lim = await rateLimitId(userSub, { key: 'sheet_monthly_statement_user', limit: 30, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  const monthParam = String(req.query.month || '').trim();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)
    ? monthParam
    : new Date().toISOString().slice(0, 7);

  const sheetRec = await kvGet(`sheet:${userSub}`);
  const userRec = (await kvGet(`user:${userSub}`)) || {};
  const spreadsheetId = sheetRec?.spreadsheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  const range = encodeURIComponent(`'${TX_TAB}'!A2:I5001`);
  let rows;
  try {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'sheet_read_failed', detail: errBody.slice(0, 200) });
    }
    const j = await r.json();
    rows = j.values || [];
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_read_threw', detail: e.message });
  }

  // Filter rows to the requested month. Match either col B "YYYY-MM" OR
  // col A starting with "YYYY-MM" for safety.
  const monthRows = rows.filter((r) => {
    const colB = String(r[1] || '');
    if (colB === month) return true;
    const colA = String(r[0] || '').slice(0, 7);
    return colA === month;
  });

  let totalExpenses = 0, totalIncome = 0;
  const byCategory = {};
  const items = [];
  for (const r of monthRows) {
    const amount = Number(r[2]) || 0;
    if (!amount) continue;
    const category = String(r[3] || 'שונות');
    const subcategory = String(r[4] || '');
    const description = String(r[5] || '');
    const date = String(r[0] || '').slice(0, 10);
    const isIncomeFlag = r[7] === false || r[7] === 'FALSE' || r[7] === 'false' || category === 'הכנסות' || category === 'הכנסה';
    const vatDeductible = r[8] === true || r[8] === 'TRUE' || r[8] === 'true' || r[8] === '1';
    if (isIncomeFlag) {
      totalIncome += amount;
    } else {
      totalExpenses += amount;
      const k = category;
      byCategory[k] = (byCategory[k] || 0) + amount;
    }
    items.push({
      date, amount, category, subcategory, description,
      isIncome: isIncomeFlag,
      vatDeductible,
    });
  }
  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Sort categories by total desc.
  const categoryRanking = Object.entries(byCategory)
    .map(([name, total]) => ({ name, total: round2(total), pct: totalExpenses > 0 ? Math.round((total / totalExpenses) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);

  log.info('monthly_statement.ok', { reqId: req.reqId, userSub, month, rowCount: items.length });

  return res.status(200).json({
    ok: true,
    month,
    user: { email: userRec.email || null, name: userRec.name || null },
    summary: {
      totalExpenses: round2(totalExpenses),
      totalIncome: round2(totalIncome),
      netBalance: round2(totalIncome - totalExpenses),
      transactionCount: items.length,
      expenseCount: items.filter((i) => !i.isIncome).length,
      incomeCount: items.filter((i) => i.isIncome).length,
    },
    by_category: categoryRanking,
    items,
    generated_at: new Date().toISOString(),
  });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_monthly_statement', limit: 60, windowSec: 60 })(requireAuth(handlerImpl))
);
