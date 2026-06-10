/* Kesefle Service Worker
 * Cache strategy:
 *   - kesefle-static-v1   : precached HTML shells + offline fallback
 *   - kesefle-runtime-v1  : runtime cache for fonts, images, CSS
 *   - kesefle-api-v1      : short-lived stale-while-revalidate for /api (non-admin)
 *
 * Bypass cache entirely:
 *   - /api/admin/*  (admin endpoints must always hit the network)
 *   - POST/PUT/DELETE/PATCH (mutations)
 *   - requests with Authorization header in some cases (left to network)
 */
'use strict';

const VERSION = 'v13-2026-06-09';
const STATIC_CACHE = `kesefle-static-${VERSION}`;
const RUNTIME_CACHE = `kesefle-runtime-${VERSION}`;
const API_CACHE = `kesefle-api-${VERSION}`;
const OFFLINE_URL = '/offline.html';

// Precache the critical app shell.
// Keep this list small — only HTML the user is likely to hit cold while offline.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/welcome',
  '/welcome.html',
  '/dashboard',
  '/dashboard.html',
  '/status',
  '/status.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/og-image.png',
];

// Hosts we will runtime-cache.
// IMPORTANT: cdn.tailwindcss.com is intentionally NOT cached here.
// The Tailwind JIT script must always be fresh — a stale cached copy will
// silently break the entire page layout (no class -> default styles).
const RUNTIME_CACHEABLE_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ---------------------------------------------------------------------------
// install — precache the shell
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // addAll fails atomically; use individual put so a single 404 doesn't kill install.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const resp = await fetch(url, { credentials: 'same-origin' });
        if (resp && resp.ok) {
          await cache.put(url, resp.clone());
        }
      } catch (_) { /* ignore individual failures */ }
    }));
    // Activate the new SW immediately on the next navigation.
    await self.skipWaiting();
  })());
});

// ---------------------------------------------------------------------------
// activate — clean up old caches
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const valid = new Set([STATIC_CACHE, RUNTIME_CACHE, API_CACHE]);
    await Promise.all(keys.map((k) => {
      if (k.startsWith('kesefle-') && !valid.has(k)) {
        return caches.delete(k);
      }
      return null;
    }));
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function isAdminApi(url) {
  return url.pathname.startsWith('/api/admin/');
}

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isNavigation(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html'));
}

function isRuntimeCacheableHost(url) {
  return RUNTIME_CACHEABLE_HOSTS.includes(url.hostname);
}

async function networkWithFallback(request, fallbackUrl) {
  try {
    const resp = await fetch(request);
    // DON'T cache HTML responses — fresh content beats stale layout
    return resp;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fb = await caches.match(fallbackUrl);
      if (fb) return fb;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((resp) => {
    if (resp && resp.ok) {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  }).catch(() => null);
  return cached || (await fetchPromise) || new Response('Offline', { status: 503 });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      cache.put(request, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (_) {
    return new Response('Offline', { status: 503 });
  }
}

// ---------------------------------------------------------------------------
// fetch — route every request
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET — let mutations bypass entirely.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  // Skip non-http(s) and chrome-extension://
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // Admin API → always network, never cache
  if (url.origin === self.location.origin && isAdminApi(url)) {
    return; // default network handling
  }

  // Same-origin /api/* → network first w/ short stale-while-revalidate
  if (url.origin === self.location.origin && isApi(url)) {
    event.respondWith((async () => {
      try {
        const resp = await fetch(request);
        if (resp && resp.ok) {
          const cache = await caches.open(API_CACHE);
          cache.put(request, resp.clone()).catch(() => {});
        }
        return resp;
      } catch (_) {
        const cached = await caches.match(request, { cacheName: API_CACHE });
        if (cached) return cached;
        return new Response(JSON.stringify({ error: 'offline', message: 'אין חיבור לאינטרנט' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Same-origin navigation requests → network-first with offline fallback
  if (url.origin === self.location.origin && isNavigation(request)) {
    event.respondWith(networkWithFallback(request, OFFLINE_URL));
    return;
  }

  // Same-origin static assets (css, js, images, fonts) → cache-first
  if (url.origin === self.location.origin) {
    const dest = request.destination;
    if (['style', 'script', 'image', 'font'].includes(dest) ||
        /\.(?:css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|json)$/i.test(url.pathname)) {
      event.respondWith(cacheFirst(request, RUNTIME_CACHE));
      return;
    }
  }

  // Third-party fonts / Tailwind CDN → stale-while-revalidate
  if (isRuntimeCacheableHost(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }

  // Otherwise: passthrough (let the browser do its thing)
});

// ---------------------------------------------------------------------------
// message — allow page to nudge SW into activation
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data === 'SKIP_WAITING' || event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// push — display a notification from a Web Push message
//
// lib/push.js encrypts a JSON payload of the shape:
//   { title, body, icon?, badge?, tag?, url? }
// If the payload fails to parse (or arrives empty -- some push services strip
// the body on certain platforms) we still surface a generic notification so
// the user sees that something happened. Better a vague nudge than silence.
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); }
    catch (_) {
      try { data = { body: event.data.text() }; }
      catch (_) { data = {}; }
    }
  }
  const title = (data && data.title) || "כספ'לה";
  const body  = (data && data.body)  || 'יש לך עדכון חדש';
  const opts = {
    body: body,
    icon: (data && data.icon) || '/icon-192.png',
    badge: (data && data.badge) || '/icon-192.png',
    // tag dedupes -- a second push with the same tag replaces the first.
    tag: (data && data.tag) || 'kesefle-default',
    // RTL Hebrew copy.
    dir: 'rtl',
    lang: 'he',
    // url is read by the notificationclick handler below.
    data: { url: (data && data.url) || '/dashboard' },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// ---------------------------------------------------------------------------
// notificationclick — focus the existing tab if open, else open a new one
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If an existing tab is already on the target URL, just focus it.
    for (const client of all) {
      try {
        const u = new URL(client.url);
        if (u.pathname === targetUrl || client.url === targetUrl) {
          return client.focus();
        }
      } catch (_) { /* ignore */ }
    }
    // Otherwise, prefer to navigate the most recently focused tab.
    if (all.length && all[0].navigate) {
      try { await all[0].navigate(targetUrl); return all[0].focus(); }
      catch (_) { /* fall through */ }
    }
    // Last resort: pop a new window.
    if (self.clients.openWindow) {
      return self.clients.openWindow(targetUrl);
    }
  })());
});
