// api/sheet/fix-company-dashboard.js
//
// Surgical fix for existing users whose "מאזן חברה" tab was created with
// the OLD broken business SUMIFS (every business expense vanished from
// the dashboard because the classifier and dashboard had drifted apart
// on subcategory strings). This endpoint overwrites just the four
// business-expense formula rows (R8-R11) with the new wildcard +
// multi-criteria SUMIFS. It does NOT touch the user's data or any
// other dashboard rows — only the broken formulas.
//
// POST /api/sheet/fix-company-dashboard
// Headers: x-kesefle-bot-secret OR session cookie
// Body: { phone? }  (phone required when bot-secret auth; ignored when
//                    using session cookie -- session resolves the user)
//
// Returns:
//   200 { ok: true, repaired: 4 }
//   401 unauthorized | 404 no_user | 502 sheet_write_failed
//
// Safe to call any number of times — idempotent (just rewrites the same
// 4×13 cells with the latest formulas).

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit, rateLimitId } from '../../lib/ratelimit.js';
import { constantTimeEqual, decryptRefreshToken } from '../../lib/crypto.js';
import { exchangeRefreshForAccess } from '../../lib/sheet-writer.js';
import { getUserId } from '../_lib/session.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;
const TX_TAB = 'תנועות';
const COMPANY_TAB = 'מאזן חברה';

// MUST match COMPANY_EXPENSE_ROWS in lib/sheet-writer.js. Keep in sync
// with that file — both should evolve together.
const COMPANY_EXPENSE_ROWS = [
  { criteria: ['*חומרי גלם*'] },
  { criteria: ['*שיווק*'] },
  { criteria: ['*משלוח*', '*אריזה*'] },
  { criteria: ['*תפעולי*', 'יועצים', 'תוכנות', 'ציוד עסקי', 'מיסים'] },
];

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

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// Build the 4 row × 13 column matrix of formulas (col B = annual sum,
// col C..N = Jan..Dec). Matches _buildCompanyDashboardTab.
function buildBusinessRowFormulas() {
  const rows = [];
  for (let r = 0; r < COMPANY_EXPENSE_ROWS.length; r++) {
    const rowNum = 8 + r;
    const cells = [`=SUM(C${rowNum}:N${rowNum})`];
    const crits = COMPANY_EXPENSE_ROWS[r].criteria;
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const parts = crits.map((cr) => {
        const safe = String(cr).replace(/"/g, '""');
        return `SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$4&"-${mm}", '${TX_TAB}'!D:D, "עסק", '${TX_TAB}'!E:E, "${safe}")`;
      });
      const sumExpr = parts.length ? parts.join(' + ') : '0';
      cells.push(`=IFERROR(${sumExpr}, 0)`);
    }
    rows.push(cells);
  }
  return rows; // 4 rows × 13 cells
}

async function resolveUser(req, body) {
  // Mode A: session cookie (the /account button uses this).
  const sessionSub = getUserId(req);
  if (sessionSub) {
    const userRec = (await kvGet(`user:${sessionSub}`)) || {};
    const sheetRec = await kvGet(`sheet:${sessionSub}`);
    return {
      ok: true,
      userSub: sessionSub,
      userRec,
      sheetRec,
      phone: null,
    };
  }
  // Mode B: bot-secret + phone (the bot uses this).
  const presented = String(req.headers['x-kesefle-bot-secret'] || '') ||
                    String((body && body.botSecret) || '');
  if (!presented || !BOT_SECRET || !constantTimeEqual(presented, BOT_SECRET)) {
    return { ok: false, code: 401, error: 'unauthorized' };
  }
  const phone = normalizeE164(body && body.phone);
  if (!phone) return { ok: false, code: 400, error: 'missing_phone' };
  const phoneRec = await kvGet(`phone:${phone}`);
  if (!phoneRec?.userSub) return { ok: false, code: 404, error: 'no_user' };
  const userRec = (await kvGet(`user:${phoneRec.userSub}`)) || {};
  const sheetRec = await kvGet(`sheet:${phoneRec.userSub}`);
  return {
    ok: true,
    userSub: phoneRec.userSub,
    userRec,
    sheetRec,
    phone,
  };
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const r = await resolveUser(req, body);
  if (!r.ok) return res.status(r.code || 401).json({ ok: false, error: r.error });

  const { userSub, userRec, sheetRec, phone } = r;
  const spreadsheetId = sheetRec?.spreadsheetId || userRec?.spreadsheetId || null;
  if (!spreadsheetId) return res.status(404).json({ ok: false, error: 'no_sheet' });
  if (!userRec.refreshTokenEnvelope && !userRec.refreshToken) {
    return res.status(409).json({ ok: false, error: 'reauth_required' });
  }

  // Light rate limit so a buggy client can't loop on this.
  const idForLimit = phone || userSub;
  const lim = await rateLimitId(idForLimit, { key: 'fix_company_dashboard', limit: 10, windowSec: 3600 });
  if (!lim.ok) return res.status(429).json({ ok: false, error: 'rate_limited', retryAfter: lim.retryAfter });

  let accessToken;
  try {
    const refresh = userRec.refreshToken || decryptRefreshToken(userRec.refreshTokenEnvelope, userSub);
    accessToken = await exchangeRefreshForAccess(refresh);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'token_refresh_failed', detail: e.message });
  }

  const matrix = buildBusinessRowFormulas();
  // Range: 'מאזן חברה'!B8:N11 — col B = annual, C..N = Jan..Dec, R8..R11
  // = the 4 business expense rows. USER_ENTERED so formulas evaluate.
  const range = encodeURIComponent(`'${COMPANY_TAB}'!B8:N11`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`;
  let writeR;
  try {
    writeR = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: matrix }),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'sheet_unreachable', detail: e.message });
  }
  if (!writeR.ok) {
    const detail = await writeR.text().catch(() => '');
    try {
      const { alertOwnerOfClientError } = await import('../../lib/error-alert.js');
      alertOwnerOfClientError({
        reqId: req.reqId, phone, userSub,
        route: '/api/sheet/fix-company-dashboard',
        code: 'sheet_write_failed',
        detail: `status=${writeR.status} ${String(detail).slice(0, 120)}`,
      });
    } catch (_e2) {}
    return res.status(502).json({ ok: false, error: 'sheet_write_failed', status: writeR.status, detail: String(detail).slice(0, 200) });
  }

  log.info('fix_company_dashboard.ok', { reqId: req.reqId, userSub, repaired: matrix.length });
  return res.status(200).json({ ok: true, repaired: matrix.length, message: 'הנוסחאות במאזן חברה תוקנו. רענן/י את הגיליון.' });
}

export default withRequestId(
  withRateLimit({ key: 'sheet_fix_company_dashboard', limit: 30, windowSec: 60 })(handlerImpl)
);
