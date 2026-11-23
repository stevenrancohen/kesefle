// Trusted browser push-service endpoints.
//
// A PushSubscription endpoint is supplied by the browser, but it still enters
// our API as user-controlled input. The sender later POSTs an encrypted payload
// and a VAPID Authorization header to that URL, so accepting arbitrary HTTPS
// origins would turn the push worker into a blind outbound-request primitive.
// Keep the provider policy in one module so subscription-time validation and
// send-time defence cannot drift.

const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
]);

const HOST_SUFFIXES = [
  '.push.apple.com',
  '.notify.windows.com',
];

export function isTrustedPushEndpoint(value) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try { url = new URL(value); }
  catch (_e) { return false; }

  // Browser push services use HTTPS on the default port. Credentials are never
  // part of a PushSubscription endpoint and can obscure the real authority.
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  if (EXACT_HOSTS.has(host)) return true;
  return HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix));
}
