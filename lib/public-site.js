// Canonical public origin for links emitted by server-side code.
//
// Never derive customer-facing links from Host / X-Forwarded-Host: those
// headers are request input and can turn referral or webhook URLs into
// attacker-controlled links. Operators may override the production origin for
// previews/tests with PUBLIC_SITE_URL (preferred) or SELF_URL.

const CANONICAL_ORIGIN = 'https://kesefle.com';

export function publicSiteOrigin(env = process.env) {
  const configured = env.PUBLIC_SITE_URL || env.SELF_URL || CANONICAL_ORIGIN;
  try {
    const url = new URL(configured);
    const localHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localHttp) return CANONICAL_ORIGIN;
    return url.origin;
  } catch (_error) {
    return CANONICAL_ORIGIN;
  }
}

export { CANONICAL_ORIGIN };
