// config/kesefle-numbers.js
//
// THE ONLY place in the Vercel/site code where phone numbers are written down.
// Every wa.me link, /wa redirect, /api/config value and server-side owner
// alert resolves through lib/wa-config.js, which reads env vars first and
// falls back to these defaults. tests/test_no_hardcoded_secrets.mjs fails the
// build if any of these numbers appears anywhere else (outside its allowlist).
//
// To move to the new SIM: set WA_PHONE_E164 in Vercel env (no code change),
// or change DEFAULT_PUBLIC_BOT_NUMBER here in a reviewed PR.
//
// NOTE: 972547760643 is currently the owner's personal number; it is kept as
// the default ONLY so production behaviour is unchanged until the new number
// is set. These are NOT secrets (tokens/verify tokens never live in code).

// Public bot number used by the site's wa.me links (env: WA_PHONE_E164,
// KESEFLE_BOT_NUMBER, BOT_PHONE_E164).
export const DEFAULT_PUBLIC_BOT_NUMBER = '972547760643';

// Secondary number used historically by app.html / PWA manifest shortcuts
// (env: WA_APP_LINE_E164). Kept separate so centralising does not silently
// change where those links go. Set WA_APP_LINE_E164 = WA_PHONE_E164 to unify.
export const DEFAULT_APP_LINE_NUMBER = '972547766361';

// Owner / admin alert recipient (env: KESEFLE_OWNER_PHONE, STEVEN_ADMIN_PHONE).
export const DEFAULT_OWNER_PHONE = '972547760643';
