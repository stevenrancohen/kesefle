// api/admin/recent-signups.js
//
// Admin-only: returns the N most recent signups within the lookback window.
// Used by /admin/launch-monitor as a "Recent users" table with per-row
// actions (resend welcome, see their sheet, etc.).
//
// Default: last 20 users from last 6 hours. Override via ?limit=50&hours=24.
//
// For each user, returns:
//   userSub, email, name, connectedAt, lastLoginAt
//   sheetUrl  (if sheet provisioned)
//   linkedPhone  (if WA linked)
//   step  (1=oauth, 2=sheet, 3=linked) -- furthest reached
//   minutesAgo -- since lastLoginAt

import { withRequestId, log } from '../../lib/log.js';
import { requireAdmin } from '../../lib/auth.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) { return null; }
}

async function kvScan(pattern, maxKeys = 500) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 5 && keys.length < maxKeys; i++) {
    const j = await kvFetch(`/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/200`);
    if (!j?.result) break;
    cursor = String(j.result[0] || '0');
    const batch = j.result[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys;
}

async function kvGet(key) {
  const j = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

async function handlerImpl(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!KV_URL || !KV_TOKEN) return res.status(503).json({ ok: false, error: 'kv_unavailable' });

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 6));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const userKeys = await kvScan('user:*', 1000);
  const users = [];
  // Process in parallel up to 50 at a time to keep KV load reasonable.
  const sampleLimit = Math.min(userKeys.length, 200);
  const sample = userKeys.slice(0, sampleLimit);

  await Promise.all(sample.map(async (key) => {
    const rec = await kvGet(key);
    if (!rec) return;
    const lastLogin = Date.parse(rec.lastLoginAt || rec.connectedAt || '');
    if (isNaN(lastLogin) || lastLogin < cutoff) return;
    // Get sheet + linked-phone (in parallel).
    const userSub = rec.userSub || key.replace(/^user:/, '');
    const [sheetRec, phoneRec] = await Promise.all([
      kvGet(`sheet:${userSub}`),
      kvGet(`userPhone:${userSub}`),
    ]);
    const sheetUrl = sheetRec?.spreadsheetUrl
      || (sheetRec?.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${sheetRec.spreadsheetId}/edit` : null);
    const linkedPhone = phoneRec?.phone || null;
    // Furthest step: 3 if phone linked, 2 if sheet exists, 1 if just OAuth.
    const step = linkedPhone ? 3 : (sheetUrl ? 2 : 1);
    users.push({
      userSub,
      email: rec.email || null,
      name: rec.name || null,
      picture: rec.picture || null,
      connectedAt: rec.connectedAt || null,
      lastLoginAt: rec.lastLoginAt || null,
      minutes_ago: Math.round((Date.now() - lastLogin) / 60000),
      sheetUrl,
      linkedPhone,
      step,
    });
  }));

  users.sort((a, b) => {
    const ta = Date.parse(a.lastLoginAt || '');
    const tb = Date.parse(b.lastLoginAt || '');
    return tb - ta;
  });

  const trimmed = users.slice(0, limit);
  // Bucket counts for at-a-glance.
  const by_step = { step_1_oauth_only: 0, step_2_sheet_no_phone: 0, step_3_fully_linked: 0 };
  trimmed.forEach((u) => {
    if (u.step === 1) by_step.step_1_oauth_only++;
    else if (u.step === 2) by_step.step_2_sheet_no_phone++;
    else if (u.step === 3) by_step.step_3_fully_linked++;
  });

  return res.status(200).json({
    ok: true,
    at: new Date().toISOString(),
    window_hours: hours,
    returned: trimmed.length,
    by_step,
    scanned_users: sampleLimit,
    total_users: userKeys.length,
    users: trimmed,
  });
}

export default withRequestId(requireAdmin(handlerImpl));
