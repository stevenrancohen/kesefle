/*!
 * Kesefle analytics — privacy-friendly client tracker.
 *
 * GOALS:
 *   - NO Google Analytics, NO Segment, NO Mixpanel, NO third-party scripts.
 *   - NO cookies. NO fingerprinting. Per-session ID is random + stored in sessionStorage,
 *     so it dies when the tab closes (and never persists across sessions).
 *   - Respects DNT (Do Not Track) and Global Privacy Control (GPC) — no-op when set.
 *   - Uses navigator.sendBeacon so calls never block navigation.
 *   - GDPR / Israeli Privacy Law friendly.
 *
 * USAGE:
 *   <script src="/lib/analytics.js" defer></script>
 *
 *   // Auto-fires page_view on script load.
 *   // For explicit events:
 *   window.kfl.track('cta_click', { source: 'hero' });
 *   window.kfl.track('signup_start', { source: 'google' });
 *
 * STORAGE:
 *   sessionStorage['kfl_session'] = short random ID (per-tab session only).
 *   No other state is ever written to the browser.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // No-op guard for DNT / GPC / unsupported environments
  // ---------------------------------------------------------------
  function dntEnabled() {
    try {
      // Standards: navigator.doNotTrack | window.doNotTrack | navigator.msDoNotTrack
      var dnt = (navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack || '0');
      if (dnt === '1' || dnt === 'yes') return true;
      // Global Privacy Control (newer spec, growing adoption)
      if (navigator.globalPrivacyControl === true) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function ssrGuard() {
    // Defensive — in case this file ever gets imported into a non-browser context.
    return typeof window === 'undefined' || typeof document === 'undefined';
  }

  if (ssrGuard()) return;

  var NOOP_REASON = null;
  if (dntEnabled()) NOOP_REASON = 'dnt';
  if (!('sendBeacon' in navigator) && !window.fetch) NOOP_REASON = 'no_transport';

  // Public no-op tracker for DNT'd browsers
  if (NOOP_REASON) {
    window.kfl = {
      track: function () { /* no-op */ },
      sessionId: null,
      _disabled: NOOP_REASON,
    };
    return;
  }

  // ---------------------------------------------------------------
  // Session ID (per-tab, ephemeral, non-persistent)
  // ---------------------------------------------------------------
  function genSessionId() {
    // 16 chars of base36 entropy — ~80 bits, plenty for de-duping within a day.
    var s = '';
    try {
      var arr = new Uint8Array(10);
      crypto.getRandomValues(arr);
      for (var i = 0; i < arr.length; i++) s += arr[i].toString(36);
      s = s.replace(/[^a-z0-9]/g, '').slice(0, 16);
    } catch (_) {
      s = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    }
    return s.slice(0, 16) || ('s' + Date.now().toString(36));
  }

  function getSessionId() {
    try {
      var existing = sessionStorage.getItem('kfl_session');
      if (existing && /^[a-z0-9_\-]{6,40}$/i.test(existing)) return existing;
      var fresh = genSessionId();
      sessionStorage.setItem('kfl_session', fresh);
      return fresh;
    } catch (_) {
      // Private mode / disabled storage — generate ephemeral ID
      return genSessionId();
    }
  }

  // ---------------------------------------------------------------
  // UTM parameter capture (privacy-safe — these are explicit campaign tags)
  // ---------------------------------------------------------------
  function readUtmParams() {
    try {
      var params = new URLSearchParams(window.location.search);
      var out = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
        var v = params.get(k);
        if (v) out[k] = String(v).slice(0, 64);
      });
      return out;
    } catch (_) { return {}; }
  }

  // ---------------------------------------------------------------
  // Allowlist of valid events (matches server-side allowlist)
  // ---------------------------------------------------------------
  // Must match the server-side allowlist in api/events.js#handleTrack.
  var ALLOWED_EVENTS = {
    'page_view': 1,
    'cta_click': 1,
    'signup_start': 1,
    'signup_complete': 1,
    'sheet_provisioned': 1,
    'first_message_received': 1,
    'subscribe_clicked': 1,
    'export_downloaded': 1,
    'feature_used': 1,
    'help_search': 1,
    'install_pwa': 1,
    'referral_share': 1,
    'referral_redeem': 1,
  };

  var ALLOWED_META = {
    'plan': 1, 'category': 1, 'source': 1,
    'utm_source': 1, 'utm_medium': 1, 'utm_campaign': 1,
    'utm_term': 1, 'utm_content': 1,
    'lang': 1, 'feature': 1,
  };

  function sanitizeMeta(m) {
    if (!m || typeof m !== 'object') return {};
    var out = {};
    Object.keys(m).forEach(function (k) {
      if (ALLOWED_META[k] && m[k] != null) {
        out[k] = String(m[k]).slice(0, 64);
      }
    });
    return out;
  }

  function currentPath() {
    try {
      // Strip query + hash — those may have PII or noise
      return (window.location.pathname || '/').slice(0, 100);
    } catch (_) { return '/'; }
  }

  // ---------------------------------------------------------------
  // Core send (sendBeacon preferred, fetch keepalive as fallback)
  // ---------------------------------------------------------------
  var SESSION_ID = getSessionId();
  var UTM = readUtmParams();
  // Tracking endpoint — routed through the consolidated events router on the server
  // (api/events.js handles ?action=track for privacy-friendly counters).
  var ENDPOINT = '/api/events?action=track';

  function send(event, meta) {
    if (!ALLOWED_EVENTS[event]) {
      // Silent reject — never throw, never log (analytics must never break the page)
      return false;
    }
    var mergedMeta = sanitizeMeta(meta);
    // Mix in captured UTM params for ALL events in the session (helps funnel attribution)
    Object.keys(UTM).forEach(function (k) {
      if (!mergedMeta[k]) mergedMeta[k] = UTM[k];
    });

    var payload = JSON.stringify({
      event: event,
      path: currentPath(),
      meta: mergedMeta,
      session: SESSION_ID,
    });

    try {
      if (navigator.sendBeacon) {
        // Use a Blob with JSON Content-Type — sendBeacon defaults to text/plain otherwise
        var blob = new Blob([payload], { type: 'application/json' });
        var ok = navigator.sendBeacon(ENDPOINT, blob);
        if (ok) return true;
        // Fall through if beacon was rejected (quota / payload too large)
      }
      // Fallback: fetch with keepalive so it survives navigation
      if (window.fetch) {
        window.fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          credentials: 'omit',
          mode: 'same-origin',
        }).catch(function () { /* swallow */ });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Auto page_view on load
  // ---------------------------------------------------------------
  function autoPageView() {
    send('page_view', {});
  }

  // Fire after document is interactive (defer attribute should handle this,
  // but be defensive in case the script is inlined).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoPageView, { once: true });
  } else {
    autoPageView();
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  window.kfl = {
    track: function (event, meta) { return send(event, meta); },
    sessionId: SESSION_ID,
    _allowedEvents: Object.keys(ALLOWED_EVENTS),
  };
})();
