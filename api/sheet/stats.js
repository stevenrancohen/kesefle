// /api/sheet/stats
//
// Bot-callable (bot-secret) compact spending stats for a tenant, so the
// WhatsApp concierge can answer personally ("you've spent ~₪X this month,
// mostly on Y") instead of generically. Resolves the user EXACTLY like
// /api/sheet/append: phone:{E164} → userSub, refresh token from user:{userSub},
// sheet from canonical sheet:{userSub} (with the same leak guard). Read-only.
//
// POST body: { phone, botSecret }  (or x-kesefle-bot-secret header)
// Returns: { ok, thisMonth:{ total, count, topCategory, topCategoryAmount },
//            lastMonth:{ total }, currency:'ILS' }

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';

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

function monthKey(dt) { return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); }

async function handlerImpl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const botSecret = req.headers['x-kesefle-bot-secret'] || body?.botSecret;
  if (botSecret !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const phone = normalizeE164(body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });

  const phoneRec = await kvGet(`phone:${phone}`);
  if (!phoneRec || !phoneRec.userSub) return res.status(404).json({ ok: false, error: 'no_user_for_phone' });

  // Same resolution + leak guard as /api/sheet/append: token from user:{userSub},
  // sheet from canonical sheet:{userSub}; never trust a divergent cached id.
  const sheetRec = await kvGet(`sheet:${phoneRec.userSub}`);
  const userRec = (await kvGet(`user:${phoneRec.userSub}`)) || {};
  const canonicalSheetId = sheetRec?.spreadsheetId || null;
  const phoneSheetId = phoneRec.spreadsheetId || null;
  if (canonicalSheetId && phoneSheetId && canonicalSheetId !== phoneSheetId) {
    return res.status(409).json({ ok: false, error: 'sheet_ownership_mismatch' });
  }
  const spreadsheetId = canonicalSheetId || phoneSheetId || userRec.spreadsheetId || null;
  if (!spreadsheetId) return res.status(409).json({ ok: false, error: 'no_sheet_provisioned' });

  let refreshToken = null;
  try {
    if (userRec.refreshTokenEnvelope) refreshToken = decryptRefreshToken(userRec.refreshTokenEnvelope, phoneRec.userSub);
    else if (userRec.refreshToken) refreshToken = userRec.refreshToken;
  } catch (e) { log.warn('stats.decrypt_failed', { reqId: req.reqId, phone }); }
  if (!refreshToken) return res.status(409).json({ ok: false, error: 'reauth_required' });

  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refreshToken); }
  catch (e) { return res.status(502).json({ ok: false, error: 'token_exchange_failed' }); }

  const year = new Date().getFullYear();
  let result = await fetchSheetRange(spreadsheetId, `'${year}'!A1:N`, accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, "'תנועות'!A1:N", accessToken);
  if (!result.ok) result = await fetchSheetRange(spreadsheetId, 'A1:N', accessToken);
  if (!result.ok) return res.status(502).json({ ok: false, error: 'sheets_read_failed', status: result.status });

  const allRows = result.values || [];
  if (!allRows.length) {
    return res.status(200).json({ ok: true, thisMonth: { total: 0, count: 0, topCategory: null, topCategoryAmount: 0 }, lastMonth: { total: 0 }, currency: 'ILS' });
  }

  const header = allRows[0].map((h) => String(h || '').trim().toLowerCase());
  const colIndex = (aliases, fb) => { for (let i = 0; i < header.length; i++) if (aliases.some((a) => header[i].includes(a))) return i; return fb; };
  const idx = {
    date: colIndex(['תאריך', 'date', 'timestamp', 'זמן'], 0),
    amount: colIndex(['סכום', 'amount', 'sum', 'price'], 1),
    category: colIndex(['קטגוריה', 'category', 'קטגורי'], 4),
  };
  const firstIsHeader = !parseDateCell(allRows[0][idx.date]);
  const dataRows = firstIsHeader ? allRows.slice(1) : allRows;

  const now = new Date();
  const thisKey = monthKey(now);
  const lastKey = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  let thisTotal = 0, thisCount = 0, lastTotal = 0;
  const byCat = {};
  for (const raw of dataRows) {
    if (!raw || !raw.length) continue;
    const date = parseDateCell(raw[idx.date]);
    if (!date) continue;
    const amount = parseFloat(String(raw[idx.amount] || '').replace(/[^\d.\-]/g, '')) || 0;
    if (amount <= 0) continue;
    const mk = monthKey(date);
    if (mk === thisKey) {
      thisTotal += amount; thisCount++;
      const cat = (raw[idx.category] || '').toString().trim() || 'אחר';
      byCat[cat] = (byCat[cat] || 0) + amount;
    } else if (mk === lastKey) {
      lastTotal += amount;
    }
  }
  let topCategory = null, topCategoryAmount = 0;
  for (const c in byCat) if (byCat[c] > topCategoryAmount) { topCategory = c; topCategoryAmount = byCat[c]; }

  return res.status(200).json({
    ok: true,
    thisMonth: { total: Math.round(thisTotal), count: thisCount, topCategory, topCategoryAmount: Math.round(topCategoryAmount) },
    lastMonth: { total: Math.round(lastTotal) },
    currency: 'ILS',
  });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_stats', limit: 120, windowSec: 60 })(handlerImpl)
);
