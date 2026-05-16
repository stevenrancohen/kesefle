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

async function exchangeRefreshForAccess(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET env var missing');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Auth: X-User-Sub header (set by client from their ID token's sub claim).
  // Production hardening TODO: verify ID token signature server-side instead of trusting client.
  const userSub = req.headers['x-user-sub'] || req.query.userSub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'missing user identity' });

  const userRec = await kvGet('user:' + userSub);
  if (!userRec) return res.status(404).json({ ok: false, error: 'user not found' });
  if (!userRec.spreadsheetId) return res.status(404).json({ ok: false, error: 'no sheet provisioned' });
  if (!userRec.refreshToken) return res.status(403).json({ ok: false, error: 'reauth_needed' });

  let accessToken;
  try {
    accessToken = await exchangeRefreshForAccess(userRec.refreshToken);
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
