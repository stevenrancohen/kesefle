// api/meta/data-deletion.js — Meta "Data Deletion Request Callback".
//
// POST (from Meta, application/x-www-form-urlencoded: signed_request=...)
//   -> verifies HMAC-SHA256 signature with META_APP_SECRET
//   -> returns { url, confirmation_code } as Meta requires.
// GET ?id=<confirmation_code> -> { ok, id, status } for /data-deletion/status.
//
// SAFETY: this endpoint does NOT delete anything. It only logs the request.
// DATA_DELETION_MODE (env): 'log' (default) = log only. Any real deletion
// pipeline must be wired separately and explicitly reviewed.
//
// Env: META_APP_SECRET (required, fail-closed 503), PUBLIC_BASE_URL (optional,
// default https://kesefle.com), DATA_DELETION_MODE.

import crypto from 'node:crypto';

export const config = { api: { bodyParser: false } };

function b64urlDecode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

export function parseSignedRequest(signedRequest, appSecret) {
  if (!appSecret) return { ok: false, error: 'app_secret_not_configured' };
  const parts = String(signedRequest || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' };
  const sig = b64urlDecode(parts[0]);
  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch (_e) { return { ok: false, error: 'bad_payload' }; }
  if (!payload || String(payload.algorithm || '').toUpperCase() !== 'HMAC-SHA256') return { ok: false, error: 'bad_algorithm' };
  const expected = crypto.createHmac('sha256', appSecret).update(parts[1]).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return { ok: false, error: 'bad_signature' };
  if (!payload.user_id) return { ok: false, error: 'no_user_id' };
  return { ok: true, payload };
}

// Deterministic, non-reversible code (doesn't expose the Meta user id).
export function confirmationCode(userId, issuedAt, appSecret) {
  return 'KDEL' + crypto.createHmac('sha256', appSecret).update('del:' + userId + ':' + (issuedAt || '')).digest('hex').slice(0, 16).toUpperCase();
}

async function readBody(req) {
  if (req.body != null) return typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : new URLSearchParams(req.body).toString());
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  const base = String(process.env.PUBLIC_BASE_URL || 'https://kesefle.com').replace(/\/+$/, '');
  if (req.method === 'GET') {
    const id = String((req.query && req.query.id) || '');
    if (!/^KDEL[0-9A-F]{16}$/.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    // No storage yet: every valid code is reported as received / pending review.
    return res.status(200).json({ ok: true, id, status: 'received_pending_manual_review' });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return res.status(503).json({ ok: false, error: 'app_secret_not_configured' });

  let raw = '';
  try { raw = await readBody(req); } catch (_e) { return res.status(400).json({ ok: false, error: 'body_read_failed' }); }
  let signed = new URLSearchParams(raw).get('signed_request');
  if (!signed) { try { signed = JSON.parse(raw).signed_request; } catch (_e) {} }
  const parsed = parseSignedRequest(signed, appSecret);
  if (!parsed.ok) return res.status(parsed.error === 'bad_signature' ? 403 : 400).json({ ok: false, error: parsed.error });

  const code = confirmationCode(parsed.payload.user_id, parsed.payload.issued_at, appSecret);
  const mode = String(process.env.DATA_DELETION_MODE || 'log');
  // LOG ONLY. No KV / sheet / account mutation here, regardless of mode.
  console.log(JSON.stringify({ event: 'meta.data_deletion.received', confirmation_code: code, mode, deleted: false }));
  return res.status(200).json({ url: `${base}/data-deletion/status?id=${code}`, confirmation_code: code });
}
