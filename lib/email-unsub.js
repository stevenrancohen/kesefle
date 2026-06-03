// lib/email-unsub.js
//
// Signed unsubscribe links for transactional + lifecycle emails.
//
// Every Kesefle email (welcome at signup, then the day_1..day_30 lifecycle
// drip, weekly/monthly digests, win-back) carries a "ביטול הרשמה" link to
// https://kesefle.com/unsubscribe?sub=<userSub>&t=<token>. The lifecycle cron
// (api/cron/lifecycle.js) and the digest crons already SKIP any user whose
// canonical user:{sub} record has emailUnsubscribed === true — but until this
// module + api/account/unsubscribe.js existed, NOTHING ever set that flag, so
// the link was a dead 404 and the suppression switch could never be flipped.
//
// SECURITY: the link is clicked from an email client / fresh webview with no
// session cookie, so we cannot use the normal auth. Instead we bind the link
// to the user with an HMAC(sub) token. Without it, ?sub= alone would let
// anyone unsubscribe anyone else by enumerating subs (the old
// `unsubscribeUrlFor` shipped exactly that unsigned shape, with a code comment
// flagging it as a placeholder to be replaced by a signed-token URL).
//
// FAIL-SOFT on the SIGN side: buildUnsubscribeUrl is called from inside the
// email-send path (which must never throw and abort a signup or a cron batch).
// If the crypto keyring is somehow unavailable we still return a usable URL
// (sub only); the VERIFY side then degrades to a confirm-required page rather
// than a silent no-op. In production the keyring is always present because the
// OAuth flow already depends on it to encrypt refresh tokens.

import { hmacSign, hmacVerify } from './crypto.js';

const SITE_ORIGIN = 'https://kesefle.com';

// Domain-separated payload so an unsubscribe token can never be replayed as a
// CSRF token, session, or any other hmacSign() consumer.
function tokenPayload(sub) {
  return 'email-unsub:v1:' + String(sub || '');
}

// Returns a base64url HMAC token for `sub`, or '' if signing is unavailable
// (keyring not configured). Never throws.
export function unsubscribeToken(sub) {
  if (!sub) return '';
  try {
    return hmacSign(tokenPayload(sub));
  } catch (_e) {
    return '';
  }
}

// Constant-time verification. Returns true only for a token that matches the
// active keyring's HMAC of this exact sub. Never throws.
export function verifyUnsubscribeToken(sub, token) {
  if (!sub || !token) return false;
  try {
    return hmacVerify(tokenPayload(sub), String(token));
  } catch (_e) {
    return false;
  }
}

// Build the full unsubscribe URL for an email. Appends the signed token when
// available. Never throws (safe to call from any email-send path).
export function buildUnsubscribeUrl(sub, origin = SITE_ORIGIN) {
  const base = (origin || SITE_ORIGIN).replace(/\/+$/, '');
  const subEnc = encodeURIComponent(String(sub || ''));
  const tok = unsubscribeToken(sub);
  return tok
    ? `${base}/unsubscribe?sub=${subEnc}&t=${encodeURIComponent(tok)}`
    : `${base}/unsubscribe?sub=${subEnc}`;
}
