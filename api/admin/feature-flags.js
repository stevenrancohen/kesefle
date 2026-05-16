// /api/admin/feature-flags
// GET  — list all feature flags currently in KV.
// POST — { key, value } — upsert a single flag.
//
// KV layout: each flag is stored at `flag:<name>` as JSON:
//   { value, updatedAt, updatedBy }
//
// Flag names: lowercase alphanumerics + underscores, length 1-64.
// Flag values: any JSON-serializable value, capped at 8KB after JSON.stringify.
//
// Reads are cheap (SCAN + MGET); writes are audit-logged.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvScan, kvMGet, kvSet, kvConfigured, kvOutage } from './_kv.js';
import { auditLog } from '../../lib/secure-kv.js';

const FLAG_NAME_RE = /^[a-z0-9_]{1,64}$/;
const MAX_VALUE_BYTES = 8192;

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

async function handleGet(req, res) {
  const reqId = req.reqId;
  const scan = await kvScan({ match: 'flag:*', count: 200, maxKeys: 1000 });
  if (!scan.ok) {
    log.error('admin.flags.scan_failed', { reqId, error: scan.error });
    return kvOutage(res, reqId, 'SCAN flag:* failed');
  }
  const { values } = await kvMGet(scan.keys);
  const flags = {};
  for (let i = 0; i < scan.keys.length; i++) {
    const name = scan.keys[i].slice('flag:'.length);
    const v = values[i];
    if (v && typeof v === 'object' && 'value' in v) {
      flags[name] = v;
    } else if (v != null) {
      // tolerate raw values written by an older client
      flags[name] = { value: v, updatedAt: null, updatedBy: null };
    }
  }
  log.info('admin.flags.listed', { reqId, adminEmail: req.user.email, count: Object.keys(flags).length });
  return res.status(200).json({ ok: true, flags, reqId });
}

async function handlePost(req, res) {
  const reqId = req.reqId;
  const body = parseBody(req);
  const key = String(body.key || '').trim();
  if (!FLAG_NAME_RE.test(key)) {
    return res.status(400).json({ ok: false, error: 'invalid_flag_key', reqId,
      detail: 'lowercase alphanumerics and underscores, max 64 chars' });
  }
  if (!('value' in body)) {
    return res.status(400).json({ ok: false, error: 'missing_value', reqId });
  }

  let serialized;
  try { serialized = JSON.stringify(body.value); }
  catch (e) { return res.status(400).json({ ok: false, error: 'value_not_serializable', reqId }); }
  if (serialized.length > MAX_VALUE_BYTES) {
    return res.status(400).json({ ok: false, error: 'value_too_large', reqId,
      detail: `max ${MAX_VALUE_BYTES} bytes, got ${serialized.length}` });
  }

  const record = {
    value: body.value,
    updatedAt: new Date().toISOString(),
    updatedBy: req.user.email,
  };
  const r = await kvSet('flag:' + key, record);
  if (!r.ok) {
    log.error('admin.flags.set_failed', { reqId, key, status: r.status });
    return res.status(500).json({ ok: false, error: 'kv_write_failed', reqId });
  }

  await auditLog('feature_flag_set', null, {
    flag: key,
    value: body.value,
    adminEmail: req.user.email,
  }, { reqId });

  log.info('admin.flags.updated', { reqId, adminEmail: req.user.email, key });
  return res.status(200).json({ ok: true, flag: key, record, reqId });
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (!kvConfigured()) return kvOutage(res, reqId);

  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
}

export default withRequestId(
  withRateLimit({ key: 'admin_flags', limit: 30, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
