// js/wa-links.js — runtime bot-number config for the static site.
//
// Links no longer carry a number: they point at /wa (vercel.json rewrites it
// to /api/config?go=wa, which 302s to wa.me/<WA_PHONE_E164>). This script:
//   1. fills every <span data-kfl-bot-display> with BOT_NUMBER_DISPLAY,
//   2. sets window.KESEFLE_BOT_NUMBER / KESEFLE_BOT_DISPLAY for page scripts,
//   3. still rewrites any legacy a[href*="wa.me/<digits>"] (e.g. HTML injected
//      at runtime) to the configured number. data-wa-keep opts a link out.
// Number source of truth: config/kesefle-numbers.js (+ env override).
(function () {
  'use strict';
  function rewrite(root, digits) {
    if (!digits) return 0;
    var n = 0;
    var as = (root || document).querySelectorAll('a[href*="wa.me/"]');
    for (var i = 0; i < as.length; i++) {
      var h = as[i].getAttribute('href') || '';
      var m = h.match(/^(https?:\/\/)?(api\.)?wa\.me\/(\d+)(.*)$/);
      if (!m || m[3] === digits) continue;
      if (as[i].hasAttribute('data-wa-keep')) continue;
      as[i].setAttribute('href', 'https://wa.me/' + digits + m[4]);
      n++;
    }
    return n;
  }
  function fillDisplay(root, display) {
    if (!display) return 0;
    var els = (root || document).querySelectorAll('[data-kfl-bot-display]');
    for (var i = 0; i < els.length; i++) { els[i].textContent = display; els[i].setAttribute('dir', 'ltr'); }
    return els.length;
  }
  window.KESEFLE_WA = { rewrite: rewrite, fillDisplay: fillDisplay, number: null };
  if (typeof fetch !== 'function' || typeof document === 'undefined') return;
  fetch('/api/config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      var d = cfg && String(cfg.BOT_NUMBER || '').replace(/\D+/g, '');
      if (!d) return;
      window.KESEFLE_WA.number = d;
      window.KESEFLE_BOT_NUMBER = d;
      window.KESEFLE_BOT_DISPLAY = cfg.BOT_NUMBER_DISPLAY || ('+' + d);
      rewrite(document, d);
      fillDisplay(document, window.KESEFLE_BOT_DISPLAY);
      document.dispatchEvent(new CustomEvent('kesefle:bot-number', { detail: cfg }));
    })
    .catch(function () {});
})();
