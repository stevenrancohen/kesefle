// lib/activation.js
//
// Activation cohort + the question the LLM Council said decides everything:
// "0% activation" is meaningless until you separate users who COULD use the bot
// from those who physically couldn't. Up to 6 of 10 early signups had no sheet
// or no WhatsApp link -> they were INCAPABLE of logging a 2nd expense, so a raw
// 0% is plumbing, not a verdict. This computes retention on the HEALTHY (fully
// linked: sheet + phone) segment only -> the honest number. Read-only, no PII.
//
// Per-user health (mirrors api/admin/recent-signups.js):
//   linked        = has sheet:{sub}  AND userPhone:{sub}  (can fully use the bot)
//   pending_link  = has sheet, no phone                   (signed up, never linked WA)
//   no_sheet      = no sheet                              (broke before provisioning)

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
const blankBucket = () => ({ signups: 0, e1: 0, e2: 0, e5: 0, ret7: 0 });

export async function computeActivationCohort(days = 30) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, error: 'kv_unavailable' };

  const now = Date.now();
  const cohortCutoff = now - days * 86400000;
  const d7 = now - 7 * 86400000;

  const allKeys = await kvScan('user:*', 5000);
  const userKeys = allKeys.filter((k) => /^user:[^:]+$/.test(k));

  let scanned = 0;
  const cohort = blankBucket();              // signed up in last `days`
  const linked = blankBucket();              // cohort AND fully linked (the honest denominator)
  const health = { linked: 0, pending_link: 0, no_sheet: 0 }; // cohort breakdown

  for (let i = 0; i < userKeys.length; i += 25) {
    await Promise.all(userKeys.slice(i, i + 25).map(async (key) => {
      const rec = await kvGet(key);
      if (!rec) return;
      const looksReal = !!(rec.email || rec.refreshTokenEnvelope || rec.refreshToken ||
        rec.expensesCount != null || rec.connectedAt || rec.spreadsheetId);
      if (!looksReal) return;
      const signupAt = Date.parse(rec.connectedAt || rec.lastLoginAt || rec.firstExpenseAt || '') || 0;
      if (!signupAt || signupAt < cohortCutoff) { scanned++; return; }
      scanned++;
      const sub = rec.userSub || key.replace(/^user:/, '');
      const count = Number(rec.expensesCount) || 0;
      const lastActive = Date.parse(rec.lastActive || rec.lastLoginAt || '') || 0;

      // registration health -> can this user even log a 2nd expense?
      const [sheetRec, phoneRec] = await Promise.all([kvGet(`sheet:${sub}`), kvGet(`userPhone:${sub}`)]);
      const hasSheet = !!(sheetRec?.spreadsheetId || rec.spreadsheetId);
      const hasPhone = !!(phoneRec?.phone);
      const seg = (hasSheet && hasPhone) ? 'linked' : (hasSheet ? 'pending_link' : 'no_sheet');
      health[seg]++;

      const bump = (b) => { b.signups++; if (count >= 1) b.e1++; if (count >= 2) b.e2++; if (count >= 5) b.e5++; if (lastActive >= d7) b.ret7++; };
      bump(cohort);
      if (seg === 'linked') bump(linked);
    }));
  }

  // The honest number: of users who COULD use the bot, how many logged #2.
  const healthyRate = pct(linked.e2, linked.signups);
  const blocked = cohort.signups - linked.signups; // pending_link + no_sheet
  let verdict, verdict_text;
  if (linked.signups < 5) {
    verdict = 'PLUMBING';
    verdict_text = `Only ${linked.signups} of ${cohort.signups} signups are fully linked (sheet + WhatsApp). ${blocked} physically could NOT log a 2nd expense. The visible activation is mostly a BUG, not a verdict -- fix onboarding links before judging the product.`;
  } else if (healthyRate < 30) {
    verdict = 'VALUE_PROBLEM';
    verdict_text = `Even fully-linked users activate at ${healthyRate}% (${linked.e2}/${linked.signups}). Working users don't come back -- a VALUE problem, not plumbing. Watch real users; don't build features.`;
  } else {
    verdict = 'OK';
    verdict_text = `Fully-linked users activate at ${healthyRate}% (${linked.e2}/${linked.signups}) -- healthy. The raw rate is dragged down by ${blocked} broken/pending signups; fixing onboarding links is the lever.`;
  }

  return {
    ok: true,
    cohort_window_days: days,
    // headline = the HONEST number (healthy segment), not the raw 0%
    headline: {
      healthy_signups: linked.signups,
      healthy_logged_2nd: linked.e2,
      activation_rate_pct: healthyRate,     // of users who COULD use it
      raw_signups: cohort.signups,
      raw_logged_2nd: cohort.e2,
      raw_rate_pct: pct(cohort.e2, cohort.signups),
      verdict,
      verdict_text,
    },
    registration_health: { linked: health.linked, pending_link: health.pending_link, no_sheet: health.no_sheet, blocked },
    healthy_funnel: { signed_up: linked.signups, logged_1st: linked.e1, logged_2nd: linked.e2, logged_5plus: linked.e5, active_last_7d: linked.ret7 },
    raw_funnel: { signed_up: cohort.signups, logged_1st: cohort.e1, logged_2nd: cohort.e2, active_last_7d: cohort.ret7 },
    meta: { user_keys_scanned: scanned, total_user_keys: userKeys.length },
  };
}
