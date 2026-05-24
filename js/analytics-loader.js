// js/analytics-loader.js
//
// Lazy-loaded analytics. Fetches /api/config to learn GA4 + Meta Pixel
// tracking IDs, then inits each pixel ONLY if its ID is configured. Skips
// entirely in dev (file://, localhost) and respects Do-Not-Track.
//
// Hosted via Vercel static. Pages opt in by including:
//   <script src="/js/analytics-loader.js" defer></script>
//
// All env IDs are public-safe (GA4 measurement ID + FB Pixel ID).

(function () {
  'use strict';

  // Skip in development.
  if (location.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname)) return;

  // Respect Do-Not-Track signals.
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.msDoNotTrack === '1') return;
  } catch (_e) {}

  // Already loaded? Skip.
  if (window.__kfl_analytics_loaded) return;
  window.__kfl_analytics_loaded = true;

  function loadScript(src, onload) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }

  function initGa4(id) {
    if (!id || !/^G-[A-Z0-9]+$/i.test(id)) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, {
      anonymize_ip: true,
      cookie_flags: 'SameSite=Lax;Secure',
    });
    loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id));
  }

  function initMetaPixel(id) {
    if (!id || !/^[0-9]+$/.test(id)) return;
    // Standard FB Pixel base snippet, hand-condensed.
    var f = window;
    f.fbq = f.fbq || function () { f.fbq.callMethod ? f.fbq.callMethod.apply(f.fbq, arguments) : f.fbq.queue.push(arguments); };
    f.fbq.queue = [];
    f.fbq.loaded = true;
    f.fbq.version = '2.0';
    if (!f._fbq) f._fbq = f.fbq;
    loadScript('https://connect.facebook.net/en_US/fbevents.js');
    f.fbq('init', id);
    f.fbq('track', 'PageView');
  }

  function initTikTokPixel(id) {
    if (!id || id.length < 10) return;
    var w = window;
    w.ttq = w.ttq || { _i: {}, _t: {}, methods: ['page','track','identify','instances'], setAndDefer: function(t,e){t[e]=function(){t.push([e].concat([].slice.call(arguments,0)))}}, instance: function(t){var e=w.ttq._i[t]||[];for(var n=0;n<w.ttq.methods.length;n++) w.ttq.setAndDefer(e, w.ttq.methods[n]); return e}, load: function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js'; w.ttq._i=w.ttq._i||{}; w.ttq._i[e]=[]; w.ttq._i[e]._u=i; w.ttq._t=w.ttq._t||{}; w.ttq._t[e]=+new Date; w.ttq._o=w.ttq._o||{}; w.ttq._o[e]=n||{}; loadScript(i + '?sdkid=' + encodeURIComponent(e) + '&lib=ttq'); } };
    w.ttq.load(id);
    w.ttq.page();
  }

  // Helper: app code calls kflTrack('event_name', { foo: 1 }) to fire to all
  // configured pixels. Safe no-op if none configured.
  window.kflTrack = function (eventName, props) {
    try { window.gtag && window.gtag('event', eventName, props || {}); } catch (_e) {}
    try { window.fbq && window.fbq('trackCustom', eventName, props || {}); } catch (_e) {}
    try { window.ttq && window.ttq.track(eventName, props || {}); } catch (_e) {}
  };

  // Pull tracking IDs from /api/config. If config call fails, skip silently.
  fetch('/api/config', { cache: 'force-cache' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) return;
      if (j.ga4_id) initGa4(j.ga4_id);
      if (j.meta_pixel_id) initMetaPixel(j.meta_pixel_id);
      if (j.tiktok_pixel_id) initTikTokPixel(j.tiktok_pixel_id);
    })
    .catch(function () {});
})();
