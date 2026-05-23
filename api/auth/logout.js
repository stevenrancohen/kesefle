// api/auth/logout.js
//
// Clears the HttpOnly session cookie. POST-only so a stray GET (e.g. a
// favicon-style preload) cannot sign the user out. The client-side
// kesefleLogout() in account.html / dashboard.html should also clear
// localStorage (`kesefle_user`, `kesefle_sheet`) -- this endpoint covers
// the server-side half (the cookie), which the client cannot touch
// because it is HttpOnly.

import { withRequestId } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import { clearSessionCookie } from '../_lib/session.js';

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  try {
    clearSessionCookie(res);
  } catch (_e) { /* best-effort; cookie may already be cleared */ }
  return res.status(200).json({ ok: true });
}

export default withRequestId(
  withRateLimit({ key: 'auth_logout', limit: 30, windowSec: 60 })(handlerImpl)
);
