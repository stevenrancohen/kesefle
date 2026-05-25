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
import { getUserId } from './_lib/session.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch (_) {
    return null;
  }
}

async function handlerImpl(req, res) {
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
  const token = await kvGet('token:' + userId);
  if (!token) {
    // Cookie is valid but no user record -- probably mid-onboarding.
    // Return minimal profile so /dashboard knows we're authenticated;
    // it'll show the empty/onboarding state instead of redirecting.
    return res.status(200).json({ ok: true, user: { sub: userId }, sheet: null });
  }

  // Optional richer profile -- some flows store the Google profile
  // under user:{sub}; merge both records so callers always get
  // sub + email + name where available.
  const userRec = await kvGet('user:' + userId);
  const profile = {
    sub: userId,
    email: token.email || (userRec && userRec.email) || null,
    name: token.name || (userRec && userRec.name) || null,
    picture: token.picture || (userRec && userRec.picture) || null,
  };

  const sheetId = token.sheetId || (userRec && userRec.spreadsheetId) || null;
  const sheet = sheetId
    ? { spreadsheetId: sheetId, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit' }
    : null;

  // No-cache: this is per-request user state, should never be cached
  // by a CDN or shared proxy.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).json({ ok: true, user: profile, sheet });
}

export default withRequestId(handlerImpl);
