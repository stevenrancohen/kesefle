// js/wa-links.js — runtime bot-number swap for every wa.me/ link on the page.
// Fetches /api/config (WA_PHONE_E164 env on Vercel) and rewrites any
// <a href="https://wa.me/<old>..."> to the configured number, preserving ?text=.
// Static HTML keeps the current number as a no-JS / API-down fallback.
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
      if (as[i].hasAttribute('data-wa-keep')) continue; // e.g. "reply to user" links
      as[i].setAttribute('href', 'https://wa.me/' + digits + m[4]);
      n++;
    }
    return n;
  }
  window.KESEFLE_WA = { rewrite: rewrite, number: null };
  if (typeof fetch !== 'function' || typeof document === 'undefined') return;
  fetch('/api/config', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      var d = cfg && String(cfg.BOT_NUMBER || '').replace(/\D+/g, '');
      if (!d) return;
      window.KESEFLE_WA.number = d;
      window.KESEFLE_BOT_NUMBER = d;
      rewrite(document, d);
      document.dispatchEvent(new CustomEvent('kesefle:bot-number', { detail: cfg }));
    })
    .catch(function () {});
})();
