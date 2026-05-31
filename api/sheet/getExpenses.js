import { requireUser } from '../_lib/session.js';
import { getGoogleClientId } from '../../lib/auth.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { withRateLimit } from '../../lib/ratelimit.js';

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
  const clientId = getGoogleClientId();
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
  // Track per-tenant Sheets API reads (in-memory; zero KV cost).
  try {
    const { recordSheetCall } = await import('../../lib/sheet-quota.js');
    recordSheetCall(spreadsheetId, 'read');
  } catch (_e) {}
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

async function handlerImpl(req, res) {
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
    // Refresh token is stored as an encrypted envelope (decrypt with userId as
    // the AAD); fall back to a legacy plaintext field for pre-migration records.
    let refreshTok = null;
    if (record.refreshTokenEnvelope) {
      try { refreshTok = decryptRefreshToken(record.refreshTokenEnvelope, userId); } catch (_e) { refreshTok = null; }
    } else if (record.refreshToken) {
      refreshTok = record.refreshToken;
    }
    if (!refreshTok) {
      return res.status(403).json({ error: 'reauth_needed' });
    }
    try {
      const refreshed = await refreshAccessToken(refreshTok);
      accessToken = refreshed.accessToken;
      const updated = { ...record, accessToken, expiry: refreshed.expiry };
      await kvSet('token:' + userId, updated);
    } catch (e) {
      return res.status(403).json({ error: 'reauth_needed', detail: e.message });
    }
  }

  // Read from row 1 (INCLUDING the header) so we can map columns by name
  // instead of guessing positions. The owner's תנועות tab and the
  // Vercel-provisioned template have DIFFERENT column orders (e.g.
  // amount is col C in one, col B in the other), so a positional guess
  // silently read the wrong column. Header-driven mapping fixes that.
  const year = new Date().getFullYear();
  const primaryRange = `'${year}'!A1:N`;
  let result = await fetchSheetRange(record.sheetId, primaryRange, accessToken);
  if (!result.ok) {
    result = await fetchSheetRange(record.sheetId, "'תנועות'!A1:N", accessToken);
  }
  if (!result.ok) {
    result = await fetchSheetRange(record.sheetId, 'A1:N', accessToken);
  }
  if (!result.ok) {
    return res.status(502).json({ error: 'sheets_read_failed', status: result.status });
  }

  const allRows = result.values || [];
  if (allRows.length === 0) {
    return res.status(200).json({ rows: [], count: 0, totalThisMonth: 0 });
  }

  // Resolve column indices from the header row. Matches Hebrew + English
  // aliases; falls back to sensible positional defaults if a header
  // can't be found (covers sheets created before headers existed).
  const header = allRows[0].map((h) => String(h || '').trim().toLowerCase());
  function colIndex(aliases, fallback) {
    for (let i = 0; i < header.length; i++) {
      if (aliases.some((a) => header[i].includes(a))) return i;
    }
    return fallback;
  }
  const idx = {
    date: colIndex(['תאריך', 'date', 'timestamp', 'זמן'], 0),
    amount: colIndex(['סכום', 'amount', 'sum', 'price'], 1),
    category: colIndex(['קטגוריה', 'category', 'קטגורי'], 4),
    description: colIndex(['פירוט', 'תיאור', 'description', 'desc', 'raw', 'note'], 5),
    member: colIndex(['חבר', 'member', 'מי', 'paid by', 'logged'], 7),
  };

  // If row 1 doesn't look like a header (its "date" cell parses as a real
  // date), treat it as data too — some legacy sheets have no header row.
  const firstIsHeader = !parseDateCell(allRows[0][idx.date]);
  const dataRows = firstIsHeader ? allRows.slice(1) : allRows;

  const rows = [];
  let totalThisMonth = 0;

  for (const raw of dataRows) {
    if (!raw || raw.length === 0) continue;
    const date = parseDateCell(raw[idx.date]);
    if (!date) continue;
    const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
    const category = (raw[idx.category] || '').toString();
    const description = (raw[idx.description] || '').toString();
    const member = (raw[idx.member] || '').toString();
    rows.push({
      date: date.toISOString().slice(0, 10),
      amount,
      category,
      description,
      member,
    });
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

// 2026-05-29 resweep R7: was previously authed-only (requireUser) with no rate
// limit. An authed user could spam reads and hit Google Sheets per-project
// quota (300 req/min) trivially, and Vercel function execution cost. 60/min IP
// cap matches the rest of api/sheet/* read endpoints (bot-query, stats).
export default withRateLimit({ key: 'sheet_get_expenses', limit: 60, windowSec: 60 })(handlerImpl);
