import { requireUser } from '../_lib/session.js';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

async function refreshAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '191938738571-tlpptgagkbs82tc1omrrk8i6l0c02cm4.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET missing');
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
  if (!r.ok || !j.access_token) {
    throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  }
  return {
    accessToken: j.access_token,
    expiry: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
  };
}

async function fetchSheetRange(spreadsheetId, range, accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  if (!r.ok) {
    return { ok: false, status: r.status, values: [] };
  }
  const j = await r.json();
  return { ok: true, status: 200, values: j.values || [] };
}

function parseDateCell(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d2 = new Date(year, month, day);
    if (!isNaN(d2.getTime())) return d2;
  }
  return null;
}

function isInCurrentMonth(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const userId = requireUser(req, res);
  if (!userId) return;

  const record = await kvGet('token:' + userId);
  if (!record) {
    return res.status(404).json({ error: 'no_tokens' });
  }
  if (!record.sheetId) {
    return res.status(404).json({ error: 'no_sheet' });
  }

  let accessToken = record.accessToken;
  const expiry = Number(record.expiry || 0);
  const needsRefresh = !accessToken || expiry < Date.now() + 60 * 1000;

  if (needsRefresh) {
    if (!record.refreshToken) {
      return res.status(403).json({ error: 'reauth_needed' });
    }
    try {
      const refreshed = await refreshAccessToken(record.refreshToken);
      accessToken = refreshed.accessToken;
      const updated = { ...record, accessToken, expiry: refreshed.expiry };
      await kvSet('token:' + userId, updated);
    } catch (e) {
      return res.status(403).json({ error: 'reauth_needed', detail: e.message });
    }
  }

  const year = new Date().getFullYear();
  const primaryRange = `'${year}'!A2:M`;
  let result = await fetchSheetRange(record.sheetId, primaryRange, accessToken);
  if (!result.ok) {
    result = await fetchSheetRange(record.sheetId, 'A2:M', accessToken);
  }
  if (!result.ok) {
    result = await fetchSheetRange(record.sheetId, "'תנועות'!A2:M", accessToken);
  }
  if (!result.ok) {
    return res.status(502).json({ error: 'sheets_read_failed', status: result.status });
  }

  const rows = [];
  let totalThisMonth = 0;

  for (const raw of result.values) {
    if (!raw || raw.length === 0) continue;
    const date = parseDateCell(raw[0]);
    if (!date) continue;
    const amount = parseFloat(String(raw[1] || '').replace(/[^\d.\-]/g, '')) || 0;
    const category = (raw[4] || raw[2] || '').toString();
    const description = (raw[5] || raw[3] || '').toString();
    const member = (raw[7] || raw[6] || '').toString();
    const row = {
      date: date.toISOString().slice(0, 10),
      amount,
      category,
      description,
      member,
    };
    rows.push(row);
    if (isInCurrentMonth(date) && amount > 0) {
      totalThisMonth += amount;
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date));

  return res.status(200).json({
    rows,
    count: rows.length,
    totalThisMonth,
  });
}
