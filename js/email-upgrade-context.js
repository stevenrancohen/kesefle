(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kflEmailUpgradeContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SOURCE_KEY = 'kfl_email_upgrade_source';
  var RETURN_KEY = 'kfl_email_upgrade_return_to';
  var ALLOWED_RETURN = /^\/(?:account|dashboard|app)(?:[/?#]|$)/;

  function normalizeSource(value) {
    var source = String(value || '').trim().toLowerCase();
    return /^[a-z0-9_-]{1,48}$/.test(source) ? source : '';
  }

  function safeReturnPath(value, origin) {
    var raw = String(value || '').trim();
    if (!raw || raw.slice(0, 1) !== '/' || raw.slice(0, 2) === '//') return '';
    // Reject alternate slash encodings before URL normalization so a stored
    // return can never become a protocol-relative/external URL downstream.
    if (/\\|%5c|%2f/i.test(raw)) return '';
    try {
      var base = String(origin || 'https://kesefle.com');
      var parsed = new URL(raw, base);
      if (parsed.origin !== new URL(base).origin) return '';
      var path = parsed.pathname + parsed.search + parsed.hash;
      return ALLOWED_RETURN.test(path) ? path : '';
    } catch (_e) {
      return '';
    }
  }

  function read(storage, origin) {
    var source = '';
    var returnTo = '';
    try {
      source = normalizeSource(storage && storage.getItem(SOURCE_KEY));
      returnTo = safeReturnPath(storage && storage.getItem(RETURN_KEY), origin);
    } catch (_e) {}
    return { source: source, returnTo: returnTo };
  }

  function capture(search, storage, origin) {
    try {
      var params = new URLSearchParams(String(search || ''));
      var source = normalizeSource(params.get('source'));
      var returnTo = safeReturnPath(params.get('return_to'), origin);
      // Only overwrite with a valid, explicit value. A refresh, PayPal return,
      // or OAuth round-trip without these params must retain the safe context.
      if (source && storage) storage.setItem(SOURCE_KEY, source);
      if (returnTo && storage) storage.setItem(RETURN_KEY, returnTo);
    } catch (_e) {}
    return read(storage, origin);
  }

  return {
    SOURCE_KEY: SOURCE_KEY,
    RETURN_KEY: RETURN_KEY,
    normalizeSource: normalizeSource,
    safeReturnPath: safeReturnPath,
    read: read,
    capture: capture,
  };
});
