// /api/me
//
// Returns the current user's profile + provisioned sheet info, based on
// the kefle_session cookie alone (no Bearer token needed).
//
// Used by /dashboard to hydrate localStorage when a returning user lands
// on a fresh device or after a cache clear — without this they'd get
// bounced through /account again.
//
// Response shape:
//   { ok: true, user: { sub, email, name, picture }, sheet: { spreadsheetId, spreadsheetUrl } }
//   { ok: false, error: "unauthorized" }   // 401, no/invalid cookie

import { withRequestId } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { getUserId } from './_lib/session.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return { ok: false, value: null };
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { ok: false, value: null };
    const j = await r.json();
    if (!j || Object.prototype.hasOwnProperty.call(j, 'error') ||
        !Object.prototype.hasOwnProperty.call(j, 'result')) {
      return { ok: false, value: null };
    }
    return { ok: true, value: j.result == null ? null : JSON.parse(j.result) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

async function handlerImpl(req, res) {
  // Every response is account-specific or describes account authority. Never
  // let a browser, CDN, or service worker reuse it for another session.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // CORS-friendly: same-origin GET only.
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // The dashboard stores both a `kesefle_user` (Google profile) and a
  // `kesefle_sheet` blob in localStorage. We reconstruct equivalent
  // shapes here from KV so a fresh-device user can hydrate in one call.
  const [tokenLookup, userLookup] = await Promise.all([
    kvGet('token:' + userId),
    kvGet('user:' + userId),
  ]);
  if (!tokenLookup.ok || !userLookup.ok) {
    return res.status(503).json({ ok: false, error: 'profile_unavailable' });
  }
  const token = tokenLookup.value;
  const userRec = userLookup.value;
  if (!token && !userRec) {
    // Cookie is valid but no user record -- probably mid-onboarding.
    // Return minimal profile so /dashboard knows we're authenticated;
    // it'll show the empty/onboarding state instead of redirecting.
    return res.status(200).json({ ok: true, user: { sub: userId }, sheet: null });
  }

  // Optional richer profile -- some flows store the Google profile
  // under user:{sub}; merge both records so callers always get
  // sub + email + name where available.
  const profile = {
    sub: userId,
    email: (token && token.email) || (userRec && userRec.email) || null,
    name: (token && token.name) || (userRec && userRec.name) || null,
    picture: (token && token.picture) || (userRec && userRec.picture) || null,
  };

  const sheetId = (token && token.sheetId) || (userRec && userRec.spreadsheetId) || null;
  const sheet = sheetId
    ? { spreadsheetId: sheetId, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit' }
    : null;

  return res.status(200).json({ ok: true, user: profile, sheet });
}

// 2026-05-29 resweep R8: added per-IP rate limit. /api/me returns email +
// name + picture + spreadsheetId for the cookie holder; without a limit,
// a leaked SameSite=Lax cookie + XSS could pivot to the profile in one
// round trip. 30/min is generous for any legitimate dashboard hydrate flow
// (typically 1-2 calls per session) and fail-open semantics in lib/ratelimit
// keep the endpoint available if KV is degraded.
export default withRequestId(
  withRateLimit({ key: 'me', limit: 30, windowSec: 60 })(handlerImpl)
);
