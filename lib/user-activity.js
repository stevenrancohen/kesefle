// lib/user-activity.js
//
// Records per-user activity on the canonical user:{userSub} KV record so the
// lifecycle email cron (api/cron/lifecycle.js) can gate on it. WITHOUT this,
// `expensesCount` and `lastActive` are never written, so the day-1, day-7,
// weekly-digest, and inactivity/win-back lifecycle emails (which read those
// fields) silently never fire.
//
// KV-COST DISCIPLINE (Steven declined paid Upstash — free tier is 10k cmd/day):
// callers ALREADY fetch user:{userSub} to resolve the encrypted refresh token
// before every expense write, so this helper takes that in-hand record and does
// exactly ONE additional KV SET per recorded expense. It never issues its own
// GET. Pass the record you already have via `currentRecord`.
//
// FAIL-SOFT: never throws. A KV hiccup here must never block an expense write
// or fail the user's request. Returns { ok } / { ok:false, reason } for logs.

import { log } from './log.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Bump expensesCount + stamp lastActive on user:{userSub}. Single KV SET.
//
//   userSub        canonical Google sub (the user: key suffix)
//   currentRecord  the user:{userSub} record the caller already fetched
//                  (so we don't pay for a second GET). May be null/partial —
//                  we merge onto it and write back the whole record.
//   at             optional Date (defaults now) — the activity timestamp.
//
// Returns { ok:true, expensesCount } on a successful write, or
// { ok:false, reason } when KV is unconfigured / the write failed. The caller
// should treat a false result as non-fatal (best-effort telemetry).
export async function recordExpenseActivity({ userSub, currentRecord, at } = {}) {
  if (!userSub) return { ok: false, reason: 'no_user_sub' };
  if (!KV_URL || !KV_TOKEN) return { ok: false, reason: 'kv_unconfigured' };

  const nowIso = (at instanceof Date ? at : new Date()).toISOString();
  // Merge onto the in-hand record so we never clobber email / plan / refresh
  // envelope / trial fields. If the caller had no record (shouldn't happen on
  // the expense paths, since they need the token), start a minimal one keyed by
  // userSub rather than skip the write.
  const base = (currentRecord && typeof currentRecord === 'object') ? currentRecord : {};

  // CLOBBER GUARD: only ever merge-and-write onto a record that's already a
  // real user record (has an email, a refresh-token field, or a prior count).
  // A degenerate `{}` (e.g. a failed GET upstream) would otherwise be written
  // back as a near-empty record, wiping email / plan / refresh envelope. All
  // current callers gate on the refresh token before reaching here, so this is
  // belt-and-suspenders for any future caller. Skip rather than corrupt.
  const looksReal = !!(base.email || base.refreshTokenEnvelope || base.refreshToken ||
    base.expensesCount != null || base.connectedAt || base.spreadsheetId);
  if (!looksReal) return { ok: false, reason: 'empty_record_skipped' };

  const prevCount = Number(base.expensesCount) || 0;
  const next = {
    ...base,
    userSub: base.userSub || userSub,
    expensesCount: prevCount + 1,
    lastActive: nowIso,
    // Free to capture while we're already writing — handy for the admin
    // timeline + future "first transaction" analytics. Only set once.
    firstExpenseAt: base.firstExpenseAt || nowIso,
  };

  try {
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent('user:' + userSub)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!r.ok) {
      log.warn('user_activity.set_failed', { status: r.status });
      return { ok: false, reason: 'kv_set_status_' + r.status };
    }
    return { ok: true, expensesCount: next.expensesCount };
  } catch (e) {
    // Never let a KV outage surface to the expense path.
    log.warn('user_activity.set_threw', { error: e.message });
    return { ok: false, reason: 'network_error' };
  }
}
