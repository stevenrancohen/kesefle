// js/ab-client.js
//
// Tiny client-side A/B helper. Single global function:
//   await window.kflAB('experiment_name')   -> returns variant string
//
// Caches the assignment in sessionStorage so repeat calls during the same
// browser session never hit the server again (the server itself returns
// the SAME bucket for the same user, so this is purely a perf optimization).
//
// Conversion tracking: when the variant matters for analytics, fire a
// funnel event with meta.experiment=`${name}:${variant}`. e.g.:
//   var v = await window.kflAB('hero_cta');
//   if (v === 'variant_a') document.querySelector('#hero-cta').textContent = 'התחל בחינם';
//   fetch('/api/log/funnel-event', { ... body: JSON.stringify({ event:'cta_shown', meta:{experiment:'hero_cta:'+v} }) });

(function () {
  if (window.kflAB) return; // idempotent if loaded twice
  var cache = {};

  // Pre-load sessionStorage cache (safe wrap; ssn-storage can throw in
  // private browsing on some browsers).
  try {
    var raw = sessionStorage.getItem('kfl_ab_cache_v1');
    if (raw) cache = JSON.parse(raw) || {};
  } catch (_e) {}

  function persist() {
    try { sessionStorage.setItem('kfl_ab_cache_v1', JSON.stringify(cache)); } catch (_e) {}
  }

  window.kflAB = async function (experiment) {
    if (!experiment) return 'control';
    if (cache[experiment]) return cache[experiment];
    try {
      var r = await fetch('/api/ab?experiment=' + encodeURIComponent(experiment), {
        credentials: 'include',
        cache: 'force-cache',
      });
      if (!r.ok) return 'control';
      var j = await r.json();
      var v = (j && j.variant) || 'control';
      cache[experiment] = v;
      persist();
      return v;
    } catch (_e) {
      return 'control';
    }
  };

  // Convenience: kflABApply(experiment, { variant_a: () => {...}, variant_b: () => {...} })
  // Picks the variant + invokes its handler. Defaults to 'control' if no match.
  window.kflABApply = async function (experiment, handlers) {
    var v = await window.kflAB(experiment);
    var fn = (handlers && (handlers[v] || handlers['control'])) || null;
    if (typeof fn === 'function') {
      try { fn(v); } catch (_e) {}
    }
    return v;
  };
})();
