// api/cron/kv-backup.js
//
// Nightly KV snapshot to admin's Google Drive. Disaster recovery: a single
// Upstash region failure should NOT mean total data loss. We snapshot the
// safety-critical keys (user:*, phone:*, sheet:*, profile:*) to a single
// JSON file in Steven's Drive, rotated as kesefle-kv-backup-YYYY-MM-DD.json.
//
// Last 7 daily files are kept; older ones are deleted on the next backup
// run (we don't run a separate cleanup cron -- just trim on write).
//
// Sensitive note: refresh tokens in user:* records are ALREADY encrypted at
// rest (AES-256-GCM envelopes via lib/crypto.js). The backup is a copy of
// the same envelopes, NOT plaintext. The AES key (SESSION_SECRET) is in
// Vercel env, not in the backup -- so a leaked backup file would still need
// the env secret to decrypt anything.
//
// Schedule: vercel.json `0 3 * * *` (03:00 UTC = 06:00 Asia/Jerusalem).
// Auth: Vercel CRON_SECRET via Authorization Bearer.

import { withRequestId, log } from '../../lib/log.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const BACKUP_KEY_PREFIXES = ['user:', 'phone:', 'sheet:', 'profile:', 'referral:'];
// Hard cap on records per prefix per backup -- defends against runaway scans
// pulling all of KV in a single backup file (which would be both slow + a
// privacy concern). 5000 per prefix = ~25k total records, enough for our
// first 1000 paid users with margin.
const MAX_KEYS_PER_PREFIX = 5000;

async function verifyCronAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return { ok: false, code: 503, error: 'cron_secret_not_configured' };
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${cronSecret}`;
  const { constantTimeEqual } = await import('../../lib/crypto.js');
  if (!auth || !constantTimeEqual(String(auth), expected)) return { ok: false, code: 401, error: 'cron_unauthorized' };
  return { ok: true };
}

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function kvScanPrefix(prefix, cap) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 100; i++) {
    if (keys.length >= cap) break;
    const r = await kvFetch(`/scan/${cursor}?match=${encodeURIComponent(prefix + '*')}&count=200`);
    if (!r.ok) break;
    cursor = r.result?.[0] || '0';
    const batch = r.result?.[1] || [];
    keys.push(...batch);
    if (cursor === '0') break;
  }
  return keys.slice(0, cap);
}

async function kvMget(keys) {
  if (!keys.length) return [];
  const out = [];
  // Chunk to 100 per request -- Upstash REST tolerates more but TCP rtt makes
  // a single mget with 5000 keys risk timeouts on a free tier.
  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100);
    const r = await kvFetch('/mget/' + slice.map(encodeURIComponent).join('/'));
    const batch = r.result || [];
    for (let j = 0; j < slice.length; j++) {
      out.push({ key: slice[j], value: batch[j] });
    }
  }
  return out;
}

async function getDriveAccessToken() {
  // Use Steven's stored refresh token (admin user:{ADMIN_SUB}) to mint a Drive
  // access token. Requires ADMIN_BACKUP_USER_SUB env var pointing at his sub.
  const adminSub = process.env.ADMIN_BACKUP_USER_SUB;
  if (!adminSub) {
    return { ok: false, error: 'admin_backup_user_sub_not_configured', note: 'Set ADMIN_BACKUP_USER_SUB to your own userSub so backups land in your Drive.' };
  }
  const userRec = await kvFetch(`/get/${encodeURIComponent('user:' + adminSub)}`);
  if (!userRec.ok) return { ok: false, error: 'admin_user_lookup_failed' };
  let admin;
  try { admin = userRec.result ? JSON.parse(userRec.result) : null; } catch { admin = null; }
  if (!admin) return { ok: false, error: 'admin_user_record_corrupt' };
  if (!admin.refreshTokenEnvelope && !admin.refreshToken) {
    return { ok: false, error: 'admin_user_no_refresh_token' };
  }

  // Dynamically import to keep cold-start small for endpoints that don't use it.
  const { decryptRefreshToken } = await import('../../lib/crypto.js');
  const refresh = admin.refreshToken || decryptRefreshToken(admin.refreshTokenEnvelope, adminSub);
  if (!refresh) return { ok: false, error: 'refresh_token_decrypt_failed' };

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return { ok: false, error: 'google_oauth_env_missing' };
  }

  // exchangeRefreshForAccess (lib/oauth.js) also CAPTURES a rotated refresh_token
  // (audit H1). This nightly cron is a likely place to first hit a >6-month-old
  // admin grant's rotation, so persisting it here (under the SETNX lock, into
  // user:{adminSub}) keeps the daily backup from silently breaking. Pass the
  // cron's resolved KV creds explicitly. Persist is best-effort.
  try {
    const { exchangeRefreshForAccess } = await import('../../lib/oauth.js');
    const { accessToken } = await exchangeRefreshForAccess({
      refreshToken: refresh,
      userSub: adminSub,
      kvUrl: KV_URL,
      kvToken: KV_TOKEN,
    });
    return { ok: true, accessToken };
  } catch (e) {
    return { ok: false, error: 'token_exchange_failed', detail: e.message };
  }
}

async function uploadToDrive(accessToken, filename, jsonBody) {
  // drive.file scope: file is owned by Steven's account, only this app can
  // see it (full visibility from his own Drive UI as 'kesefle-kv-backup-...json').
  const boundary = '---------kfl-' + Date.now().toString(36);
  const metadata = {
    name: filename,
    mimeType: 'application/json',
  };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n\r\n` +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    jsonBody + '\r\n' +
    `--${boundary}--`;

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: j?.error?.message || 'upload_failed' };
  return { ok: true, fileId: j.id, name: j.name };
}

async function listOldBackups(accessToken) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files?q=' +
    encodeURIComponent("name contains 'kesefle-kv-backup-' and trashed = false") +
    '&fields=files(id,name,createdTime)&orderBy=createdTime desc', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return j?.files || [];
}

async function deleteFile(accessToken, fileId) {
  return fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(r => ({ ok: r.ok, status: r.status })).catch(e => ({ ok: false, error: e.message }));
}

async function handlerImpl(req, res) {
  const authCheck = await verifyCronAuth(req);
  if (!authCheck.ok) return res.status(authCheck.code).json({ ok: false, error: authCheck.error });

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ ok: false, error: 'kv_outage' });
  }

  const tokenRes = await getDriveAccessToken();
  if (!tokenRes.ok) {
    log.error('cron.kv_backup.token_failed', { reqId: req.reqId, error: tokenRes.error });
    return res.status(503).json({ ok: false, error: tokenRes.error, detail: tokenRes.note });
  }
  const accessToken = tokenRes.accessToken;

  // Pull all 5 critical prefixes in parallel.
  const prefixResults = {};
  let totalRecords = 0;
  await Promise.all(BACKUP_KEY_PREFIXES.map(async (prefix) => {
    const keys = await kvScanPrefix(prefix, MAX_KEYS_PER_PREFIX);
    const records = await kvMget(keys);
    prefixResults[prefix] = records;
    totalRecords += records.length;
  }));

  // Build the snapshot JSON.
  const snapshot = {
    version: 1,
    generated_at: new Date().toISOString(),
    total_records: totalRecords,
    prefixes: Object.fromEntries(
      Object.entries(prefixResults).map(([prefix, records]) => [
        prefix,
        records.map(r => ({ key: r.key, value: r.value })),
      ])
    ),
  };
  const snapshotJson = JSON.stringify(snapshot);
  const sizeBytes = Buffer.byteLength(snapshotJson, 'utf8');

  const today = new Date().toISOString().slice(0, 10);
  const filename = `kesefle-kv-backup-${today}.json`;

  const upload = await uploadToDrive(accessToken, filename, snapshotJson);
  if (!upload.ok) {
    log.error('cron.kv_backup.upload_failed', { reqId: req.reqId, error: upload.error, status: upload.status });
    return res.status(502).json({ ok: false, error: 'upload_failed', detail: upload.error });
  }

  // Trim: keep newest 7 backups, delete older.
  const allBackups = await listOldBackups(accessToken);
  const toDelete = allBackups.slice(7);
  let deleted = 0;
  for (const f of toDelete) {
    const d = await deleteFile(accessToken, f.id);
    if (d.ok) deleted++;
  }

  log.info('cron.kv_backup.ok', { reqId: req.reqId, filename, totalRecords, sizeBytes, fileId: upload.fileId, deletedOld: deleted });
  return res.status(200).json({
    ok: true,
    filename,
    fileId: upload.fileId,
    totalRecords,
    sizeBytes,
    sizeReadable: (sizeBytes / 1024).toFixed(1) + ' KB',
    deletedOldFiles: deleted,
    keptBackups: Math.min(7, allBackups.length + 1),
  });
}

export default withRequestId(handlerImpl);
