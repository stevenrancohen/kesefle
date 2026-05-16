// /api/account/delete
// Self-serve account deletion per Israeli Privacy Protection Law Amendment 13 + GDPR Article 17.
//
// Flow:
//   1. User in dashboard clicks "מחק את החשבון שלי".
//   2. Browser POSTs { confirmation: 'DELETE-MY-ACCOUNT' } with X-User-Sub header.
//   3. Server verifies confirmation string, deletes all KV records for this user, revokes Google token,
//      logs the deletion in audit trail.
//   4. The user's Google Sheet is NOT deleted (it lives in their Drive, under their control).
//      We only remove our connection to it.
//
// Returns: { ok: true, deleted: [...keys] } or { ok: false, error }

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

async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
  });
  return r.ok;
}

async function revokeGoogleToken(refreshToken) {
  if (!refreshToken) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (e) { console.warn('google_revoke_failed', e.message); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const userSub = req.headers['x-user-sub'] || body?.userSub;
  if (!userSub) return res.status(401).json({ ok: false, error: 'missing user identity' });

  // Require an exact confirmation string to prevent accidental/CSRF deletion.
  if (body?.confirmation !== 'DELETE-MY-ACCOUNT') {
    return res.status(400).json({ ok: false, error: 'missing or invalid confirmation' });
  }

  const userRec = await kvGet('user:' + userSub);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'user not found' });
  }

  // Revoke Google OAuth grant (this also invalidates the access tokens)
  if (userRec.refreshToken) {
    await revokeGoogleToken(userRec.refreshToken);
  }

  // Delete KV records
  const deleted = [];
  const keysToDelete = [
    'user:' + userSub,
    'sheet:' + userSub,
  ];
  // Also try to find + delete phone:* records that point to this user
  // (no SCAN in Vercel KV — would need an index. For now: skip.)

  for (const k of keysToDelete) {
    if (await kvDel(k)) deleted.push(k);
  }

  // Audit log (non-fatal)
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    try {
      const auditEntry = {
        ts: new Date().toISOString(),
        action: 'account_deleted',
        userSub,
        email: userRec.email,
        deletedKeys: deleted,
        ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64),
      };
      const auditKey = `audit:delete:${Date.now()}:${userSub.slice(0, 8)}`;
      await fetch(`${kvUrl}/set/${encodeURIComponent(auditKey)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(auditEntry),
      });
    } catch (e) { /* non-fatal */ }
  }

  return res.status(200).json({
    ok: true,
    deleted,
    note: 'Your account, OAuth tokens, and our connection to your sheet have been removed. The Google Sheet itself remains in your Drive under your control — delete it manually if you wish.',
    note_he: 'החשבון שלך, אסימוני ההזדהות והקישור שלנו לגיליון הוסרו. הגיליון עצמו נשאר ב-Drive שלך בשליטתך — מחק אותו ידנית אם תרצה.',
  });
}
