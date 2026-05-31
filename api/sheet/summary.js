// /api/sheet/summary
// Reads the user's sheet via the stored refresh token and returns dashboard data:
//   month_expenses, month_income, month_count, recent[], top_categories[]
//
// Auth: the request must include a header `X-User-Sub: <google-sub>` matching the user record in KV.
// The user record holds the refreshToken used to call Sheets API.
//
// Sheet schema (matches the writer in webhook.js):
//   A timestamp | B amount | C currency | D type | E category | F subcategory | G raw | H source | I message_id
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

// exchangeRefreshForAccess now lives in lib/oauth.js (audit H1): it captures a
// rotated refresh_token if Google returns one during this dashboard read.

import { requireAuth } from '../../lib/auth.js';
import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/oauth.js';

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // CRITICAL FIX (C1): use verified ID-token-bound identity. NO MORE trusting X-User-Sub header.
  // req.user is set by requireAuth() middleware after JWT signature verification against Google JWKS.
  const userSub = req.user.sub;

  const userRec = await kvGet('user:' + userSub);
  if (!userRec) return res.status(404).json({ ok: false, error: 'user not found' });
  if (!userRec.spreadsheetId) return res.status(404).json({ ok: false, error: 'no sheet provisioned' });

  // SECURITY: refresh token is encrypted at rest (AES-256-GCM, AAD-bound to userSub).
  // Legacy plaintext fallback for users provisioned before the encryption rollout.
  let refreshToken = null;
  if (userRec.refreshTokenEnvelope) {
    try {
      refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    } catch (e) {
      return res.status(403).json({ ok: false, error: 'refresh_token_decrypt_failed' });
    }
  } else if (userRec.refreshToken) {
    refreshToken = userRec.refreshToken;
  } else {
    return res.status(403).json({ ok: false, error: 'reauth_needed' });
  }

  let accessToken;
  try {
    ({ accessToken } = await exchangeRefreshForAccess({ refreshToken, userSub }));
  } catch (e) {
    return res.status(403).json({ ok: false, error: 'reauth_needed', detail: e.message });
  }

  // Read the תנועות tab columns A-I, all rows (cap at 5000 for safety).
  const range = encodeURIComponent("'תנועות'!A2:I5001");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRec.spreadsheetId}/values/${range}`;
  let resp;
  try {
    resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheets_api_unreachable', detail: e.message });
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return res.status(resp.status).json({ ok: false, error: 'sheets_read_failed', detail: t.slice(0, 200) });
  }
  const j = await resp.json();
  const rows = j.values || [];

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = monthStart;

  let monthExpenses = 0, monthIncome = 0, monthCount = 0;
  let prevMonthExpenses = 0;
  const byCategory = {}; // { name: total }
  const recent = [];

  for (const row of rows) {
    const ts = row[0] ? new Date(row[0]) : null;
    if (!ts || isNaN(ts.getTime())) continue;
    const amount = parseFloat(row[1] || '0') || 0;
    const type = (row[3] || '').toLowerCase();
    const category = row[4] || 'אחר';
    const subcategory = row[5] || '';
    const raw = row[6] || '';
    const isIncome = type === 'income';

    if (ts >= monthStart) {
      if (isIncome) monthIncome += amount;
      else { monthExpenses += amount; byCategory[category] = (byCategory[category] || 0) + amount; }
      monthCount++;
    } else if (ts >= prevMonthStart && ts < prevMonthEnd) {
      if (!isIncome) prevMonthExpenses += amount;
    }

    recent.push({
      date: ts.toISOString().slice(0, 10),
      amount,
      is_income: isIncome,
      category,
      subcategory,
      description: subcategory || category,
      raw,
    });
  }

  // Sort recent by date desc, slice 10
  recent.sort((a, b) => b.date.localeCompare(a.date));
  const recent10 = recent.slice(0, 10);

  const topCategories = Object.entries(byCategory)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const delta = prevMonthExpenses > 0
    ? Math.round(((monthExpenses - prevMonthExpenses) / prevMonthExpenses) * 100)
    : null;

  return res.status(200).json({
    ok: true,
    month_expenses: monthExpenses,
    month_income: monthIncome,
    month_count: monthCount,
    month_expenses_delta_pct: delta,
    recent: recent10,
    top_categories: topCategories,
    refreshed_at: new Date().toISOString(),
  });
}

// Apply security middleware: request ID → rate limit (30/min) → auth (verified ID token)
export default withRequestId(
  withRateLimit({ key: 'sheet_summary', limit: 30, windowSec: 60 })(
    requireAuth(handlerImpl)
  )
);
