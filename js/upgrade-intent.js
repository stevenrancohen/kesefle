(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KesefleUpgradeIntent = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SOURCE_KEY = 'kfl_upgrade_intent_source';
  var RETURN_KEY = 'kfl_upgrade_intent_return_to';
  var ALLOWED_RETURN = /^\/(?:account|dashboard|app)(?:[/?#]|$)/;

  function source(value) {
    var normalized = String(value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : 'direct';
  }

  function returnPath(value, origin) {
    if (!value) return '';
    try {
      var base = new URL(origin || 'https://kesefle.com');
      var parsed = new URL(String(value), base);
      if (parsed.origin !== base.origin || parsed.username || parsed.password) return '';
      var path = parsed.pathname + parsed.search + parsed.hash;
      return ALLOWED_RETURN.test(path) ? path : '';
    } catch (_e) { return ''; }
  }

  function read(storage, origin) {
    try {
      return {
        source: source(storage && storage.getItem(SOURCE_KEY)),
        returnTo: returnPath(storage && storage.getItem(RETURN_KEY), origin),
      };
    } catch (_e) { return { source: 'direct', returnTo: '' }; }
  }

  function capture(search, storage, origin) {
    try {
      var params = new URLSearchParams(search || '');
      if (params.get('source')) storage.setItem(SOURCE_KEY, source(params.get('source')));
      var safeReturn = returnPath(params.get('return_to'), origin);
      if (safeReturn) storage.setItem(RETURN_KEY, safeReturn);
    } catch (_e) {}
    return read(storage, origin);
  }

  return {
    source: source,
    returnPath: returnPath,
    read: read,
    capture: capture,
    keys: { source: SOURCE_KEY, returnTo: RETURN_KEY },
  };
});
