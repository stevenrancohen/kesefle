// api/ab.js
//
// A/B-test API. Two roles:
//   GET  /api/ab?experiment=<name>          -- public bucketization for a key
//   GET  /api/ab?list=1                      -- public read of enabled exps
//   POST /api/ab { action: 'set'|'remove'|'enable'|'disable', ... }  -- admin
//
// The public bucketize call accepts ?key=<anon-id>. If the caller has a
// session, we prefer userSub. The key choice is stable per user so we never
// flip a variant mid-flight.
//
// Storage: KV `ab:experiments` = full experiments map (JSON). One key, small
// object, low KV cost regardless of number of experiments.

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { requireAdmin } from '../lib/auth.js';
import { bucketize, validateExperimentCfg, validateAllExperiments } from '../lib/ab.js';
import { getUserId } from './_lib/session.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY = 'ab:experiments';

async function kvFetch(path, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, kvOutage: true };
  const r = await fetch(`${KV_URL}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function loadExperiments() {
  const r = await kvFetch(`/get/${encodeURIComponent(KV_KEY)}`);
  if (!r.ok) return {};
  try { return r.result ? JSON.parse(r.result) : {}; } catch { return {}; }
}

async function saveExperiments(map) {
  const body = JSON.stringify(map);
  // Use POST /set (no TTL -- experiments are persistent until removed).
  return kvFetch(`/set/${encodeURIComponent(KV_KEY)}`, {
    method: 'POST',
    body,
  });
}

async function publicBucketize(req, res) {
  const experiment = String(req.query.experiment || '').trim();
  if (!experiment) return res.status(400).json({ ok: false, error: 'missing_experiment' });

  // Pick the bucketing key: prefer userSub, else explicit ?key=, else anon
  // fingerprint from IP + UA (low entropy but stable for a given browser).
  let key = String(req.query.key || '').trim().slice(0, 80);
  try {
    const u = await getUserId(req);
    if (u && u.sub) key = String(u.sub);
  } catch (_e) {}
  if (!key) {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').toString().split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0, 60);
    key = 'anon:' + ip + ':' + ua;
  }

  const all = await loadExperiments();
  const cfg = all[experiment];
  const variant = bucketize(experiment, key, cfg);

  res.setHeader('Cache-Control', 'private, max-age=30'); // tiny client cache to dedupe burst page-loads
  return res.status(200).json({
    ok: true,
    experiment,
    variant,
    enabled: !!(cfg && cfg.enabled),
  });
}

async function publicList(_req, res) {
  const all = await loadExperiments();
  // Strip variant weights from public view -- variant names only, so a frontend
  // can pre-warm UI but doesn't learn the traffic split (which can be a
  // competitive signal once you're running paid ads).
  const summary = {};
  for (const [name, cfg] of Object.entries(all)) {
    if (cfg.enabled) {
      summary[name] = { variants: cfg.variants.map(v => v.name), enabled: true };
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({ ok: true, experiments: summary });
}

async function adminSet(req, res, body) {
  const name = String(body.experiment || '').trim();
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_experiment_name' });
  }
  const cfg = body.config || {};
  const validation = validateExperimentCfg(cfg);
  if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error, detail: validation.detail });

  const all = await loadExperiments();
  all[name] = { ...cfg, updated_at: new Date().toISOString(), updated_by: req.user?.email || 'admin' };
  const all2 = validateAllExperiments(all);
  if (!all2.ok) return res.status(400).json({ ok: false, error: all2.error, detail: all2.detail });

  const saved = await saveExperiments(all);
  if (!saved.ok) return res.status(503).json({ ok: false, error: 'kv_save_failed' });

  log.info('ab.set', { reqId: req.reqId, adminEmail: req.user?.email, experiment: name });
  return res.status(200).json({ ok: true, experiment: name, config: all[name] });
}

async function adminRemove(req, res, body) {
  const name = String(body.experiment || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'missing_experiment' });
  const all = await loadExperiments();
  if (!all[name]) return res.status(404).json({ ok: false, error: 'not_found' });
  delete all[name];
  const saved = await saveExperiments(all);
  if (!saved.ok) return res.status(503).json({ ok: false, error: 'kv_save_failed' });
  log.info('ab.remove', { reqId: req.reqId, adminEmail: req.user?.email, experiment: name });
  return res.status(200).json({ ok: true, removed: name });
}

async function adminToggle(req, res, body, enabled) {
  const name = String(body.experiment || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'missing_experiment' });
  const all = await loadExperiments();
  if (!all[name]) return res.status(404).json({ ok: false, error: 'not_found' });
  all[name].enabled = !!enabled;
  all[name].updated_at = new Date().toISOString();
  await saveExperiments(all);
  log.info('ab.toggle', { reqId: req.reqId, adminEmail: req.user?.email, experiment: name, enabled });
  return res.status(200).json({ ok: true, experiment: name, enabled: !!enabled });
}

async function listAllForAdmin(_req, res) {
  const all = await loadExperiments();
  return res.status(200).json({ ok: true, experiments: all });
}

async function handlerImpl(req, res) {
  if (req.method === 'GET') {
    if (req.query.experiment) return publicBucketize(req, res);
    if (req.query.list) return publicList(req, res);
    return res.status(400).json({ ok: false, error: 'missing_query', detail: 'pass ?experiment=NAME or ?list=1' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // POST = admin path. Wrap manually because GET above is public.
  const wrapped = requireAdmin(async function (req2, res2) {
    let body = req2.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = String(body?.action || '').toLowerCase();
    switch (action) {
      case 'set': return adminSet(req2, res2, body);
      case 'remove': return adminRemove(req2, res2, body);
      case 'enable': return adminToggle(req2, res2, body, true);
      case 'disable': return adminToggle(req2, res2, body, false);
      case 'list_all': return listAllForAdmin(req2, res2);
      default: return res2.status(400).json({ ok: false, error: 'unknown_action' });
    }
  });
  return wrapped(req, res);
}

export default withRequestId(
  withRateLimit({ key: 'ab', limit: 300, windowSec: 60 })(handlerImpl)
);
