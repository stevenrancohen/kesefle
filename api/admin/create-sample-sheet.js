// api/admin/create-sample-sheet.js
//
// Admin-only: create a FRESH sample sheet in the admin's own Google Drive
// using the SAME spec that every new signup gets. Lets Steven preview the
// 5-tab structure + pie charts that customers actually receive, without
// signing up a fake account.
//
// POST /api/admin/create-sample-sheet { name?: "..." }
// Returns { ok, spreadsheetId, spreadsheetUrl } on success.
//
// Auth: requireAdmin (session cookie). Uses the admin's own stored
// refresh token (user:{userSub}) so the sheet is owned by them.

import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { requireAdmin } from '../../lib/auth.js';
import { createUserSheetWithRefresh } from '../../lib/sheet-writer.js';

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

  const adminEmail = req.user?.email || 'admin';
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'no_user_sub' });

  // Pull the admin's stored refresh token envelope so we can mint an
  // access token bound to THEIR Drive. The sheet will be owned by them.
  const tokRec = await kvGet(`user:${userSub}`);
  if (!tokRec || (!tokRec.refreshTokenEnvelope && !tokRec.refreshToken)) {
    return res.status(409).json({
      ok: false,
      error: 'admin_not_provisioned',
      detail: 'Admin user has no stored refresh token. Sign in at /account first to provision your own Kesefle sheet, then retry.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const customName = body?.name && typeof body.name === 'string'
    ? body.name.slice(0, 200)
    : null;
  const sheetName = customName || `כספ'לה — דוגמה (${new Date().toISOString().slice(0, 10)})`;

  try {
    const created = await createUserSheetWithRefresh({
      refreshTokenEnvelope: tokRec.refreshTokenEnvelope,
      refreshToken: tokRec.refreshToken,
      userSub,
      name: sheetName,
    });
    log.info('admin.create_sample_sheet.ok', {
      reqId: req.reqId,
      adminEmail,
      spreadsheetId: created.spreadsheetId,
    });
    return res.status(200).json({
      ok: true,
      spreadsheetId: created.spreadsheetId,
      spreadsheetUrl: created.spreadsheetUrl,
      name: sheetName,
      note: 'Sample sheet created in your own Google Drive. It is a real per-tenant spec with 5 tabs + 2 pie charts.',
    });
  } catch (e) {
    log.error('admin.create_sample_sheet.failed', { reqId: req.reqId, adminEmail, error: e.message });
    return res.status(502).json({ ok: false, error: 'sheet_create_failed', detail: e.message });
  }
}

export default withRequestId(
  withRateLimit({ key: 'admin_create_sample_sheet', limit: 10, windowSec: 3600 })(requireAdmin(handlerImpl))
);
