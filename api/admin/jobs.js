// /api/admin/jobs
// GET — list of failed and retry-queued background jobs.
//
// KV layout (convention used by background workers):
//   job:failed:<id>  → { type, payload, error, attempts, failedAt, lastError }
//   job:retry:<id>   → { type, payload, attempts, nextRetry, lastError }
//
// Returns:
//   { ok, jobs: [{ id, status: 'failed'|'retry', type, lastError,
//                  attempts, nextRetry?, failedAt? }],
//     counts: { failed, retry } }
//
// Failure modes worth noting:
//   - If no jobs are queued, returns { ok: true, jobs: [] }. Not an error.
//   - SCAN truncation at 1000 keys is intentional — if you ever hit it, the
//     real problem is a backed-up queue, not the admin UI.

import { requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { kvScan, kvMGet, kvConfigured, kvOutage } from './_kv.js';

const JOB_SCAN_BUDGET = 1000;

function shapeJob(rec, key, status) {
  if (!rec || typeof rec !== 'object') return null;
  const id = key.split(':').slice(2).join(':') || key;
  return {
    id,
    status,
    type: rec.type || 'unknown',
    lastError: typeof rec.lastError === 'string' ? rec.lastError.slice(0, 500)
              : typeof rec.error === 'string' ? rec.error.slice(0, 500)
              : null,
    attempts: Number.isFinite(rec.attempts) ? rec.attempts : null,
    nextRetry: rec.nextRetry || null,
    failedAt: rec.failedAt || rec.ts || null,
    // Payload is intentionally omitted from the list view — admin SPA should
    // request a detail endpoint if/when we add one. Keeps the wire small and
    // prevents accidental leakage of user PII embedded in job payloads.
  };
}

async function handlerImpl(req, res) {
  const reqId = req.reqId;
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', reqId });
  }
  if (!kvConfigured()) return kvOutage(res, reqId);

  const [failedScan, retryScan] = await Promise.all([
    kvScan({ match: 'job:failed:*', count: 200, maxKeys: JOB_SCAN_BUDGET }),
    kvScan({ match: 'job:retry:*',  count: 200, maxKeys: JOB_SCAN_BUDGET }),
  ]);

  if (!failedScan.ok || !retryScan.ok) {
    log.error('admin.jobs.scan_failed', {
      reqId,
      failedOk: failedScan.ok, failedErr: failedScan.error,
      retryOk: retryScan.ok, retryErr: retryScan.error,
    });
    return kvOutage(res, reqId, 'SCAN over job:* failed');
  }

  const [failedVals, retryVals] = await Promise.all([
    kvMGet(failedScan.keys),
    kvMGet(retryScan.keys),
  ]);

  const jobs = [];
  for (let i = 0; i < failedScan.keys.length; i++) {
    const j = shapeJob(failedVals.values[i], failedScan.keys[i], 'failed');
    if (j) jobs.push(j);
  }
  for (let i = 0; i < retryScan.keys.length; i++) {
    const j = shapeJob(retryVals.values[i], retryScan.keys[i], 'retry');
    if (j) jobs.push(j);
  }

  // Sort failed-first, then most-recent within each bucket
  jobs.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'failed' ? -1 : 1;
    return (b.failedAt || b.nextRetry || '').localeCompare(a.failedAt || a.nextRetry || '');
  });

  log.info('admin.jobs.listed', {
    reqId,
    adminEmail: req.user.email,
    failed: failedScan.keys.length,
    retry: retryScan.keys.length,
  });

  return res.status(200).json({
    ok: true,
    jobs,
    counts: {
      failed: failedScan.keys.length,
      retry: retryScan.keys.length,
    },
    truncated: !!(failedScan.truncated || retryScan.truncated),
    reqId,
  });
}

export default withRequestId(
  withRateLimit({ key: 'admin_jobs', limit: 60, windowSec: 60 })(
    requireAdmin(handlerImpl)
  )
);
