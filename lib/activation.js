// lib/activation.js
//
// Shared activation-cohort computation (LLM Council 2026-06-08). Of the people
// who signed up in the last N days, how many logged a 2nd expense? Reads the
// per-user activity that lib/user-activity.js already records (expensesCount /
// lastActive / firstExpenseAt) on the canonical user:{sub} KV record. Read-only,
// no PII. One source of truth for the admin endpoint AND the daily digest.

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

async function kvScan(pattern, maxKeys = 5000) {
  let cursor = '0';
  const keys = [];
  for (let i = 0; i < 40 && keys.length < maxKeys; i++) {
    const j = await kvFetch(`/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/300`);
    if (!j?.result) break;
    cursor = String(j.result[0] || '0');
    keys.push(...(j.result[1] || []));
    if (cursor === '0') break;
  }
  return keys;
}

async function kvGet(key) {
  const j = await kvFetch(`/get/${encodeURIComponent(key)}`);
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// Returns { ok, cohort_window_days, headline, cohort_funnel, all_time, meta }
// or { ok:false, error } when KV is unavailable.
export async function computeActivationCohort(days = 30) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, error: 'kv_unavailable' };

  const now = Date.now();
  const cohortCutoff = now - days * 86400000;
  const d7 = now - 7 * 86400000;
  const d2 = now - 2 * 86400000;

  const allKeys = await kvScan('user:*', 5000);
  const userKeys = allKeys.filter((k) => /^user:[^:]+$/.test(k)); // skip user:{sub}:archived etc.

  let scanned = 0;
  const all = { signups: 0, e1: 0, e2: 0, e5: 0, ret7: 0, ret2: 0 };
  const cohort = { signups: 0, e1: 0, e2: 0, e5: 0, ret7: 0, ret2: 0 };

  for (let i = 0; i < userKeys.length; i += 50) {
    const recs = await Promise.all(userKeys.slice(i, i + 50).map((k) => kvGet(k)));
    for (const rec of recs) {
      if (!rec) continue;
      const looksReal = !!(rec.email || rec.refreshTokenEnvelope || rec.refreshToken ||
        rec.expensesCount != null || rec.connectedAt || rec.spreadsheetId);
      if (!looksReal) continue;
      scanned++;
      const count = Number(rec.expensesCount) || 0;
      const lastActive = Date.parse(rec.lastActive || rec.lastLoginAt || '') || 0;
      const signupAt = Date.parse(rec.connectedAt || rec.lastLoginAt || rec.firstExpenseAt || '') || 0;
      const bump = (b) => {
        b.signups++;
        if (count >= 1) b.e1++;
        if (count >= 2) b.e2++;
        if (count >= 5) b.e5++;
        if (lastActive >= d7) b.ret7++;
        if (lastActive >= d2) b.ret2++;
      };
      bump(all);
      if (signupAt && signupAt >= cohortCutoff) bump(cohort);
    }
  }

  const activationRate = pct(cohort.e2, cohort.signups);
  const tooSmall = cohort.signups < 10;
  const verdict = tooSmall ? 'SAMPLE_TOO_SMALL' : (activationRate < 30 ? 'FREEZE_FEATURES' : 'OK');
  const verdictText = tooSmall
    ? `Only ${cohort.signups} signups in the last ${days}d -- too few to judge activation. The bottleneck is acquisition: hand-recruit the first ~10-20 real users before building or freezing anything.`
    : (activationRate < 30
      ? `Only ${activationRate}% of last-${days}d signups logged a 2nd expense (kill-criterion: 30%). The product's value-moment is weak -- FREEZE feature work until this number moves.`
      : `${activationRate}% of last-${days}d signups logged a 2nd expense (>= 30% kill-criterion). Activation is healthy enough to keep building.`);

  return {
    ok: true,
    cohort_window_days: days,
    headline: { signups: cohort.signups, logged_2nd_expense: cohort.e2, activation_rate_pct: activationRate, verdict, verdict_text: verdictText },
    cohort_funnel: {
      signed_up: cohort.signups, logged_1st_expense: cohort.e1, logged_2nd_expense: cohort.e2,
      logged_5plus: cohort.e5, active_last_7d: cohort.ret7, active_last_2d: cohort.ret2,
      pct: { signup_to_1st: pct(cohort.e1, cohort.signups), signup_to_2nd: pct(cohort.e2, cohort.signups), first_to_2nd: pct(cohort.e2, cohort.e1) },
    },
    all_time: {
      total_real_users: all.signups, ever_logged_1: all.e1, ever_logged_2: all.e2, ever_logged_5: all.e5,
      active_last_7d: all.ret7, activation_rate_pct: pct(all.e2, all.signups),
    },
    meta: { user_keys_scanned: scanned, total_user_keys: userKeys.length },
  };
}
