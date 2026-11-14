(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KesefleUpgradeContext = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SOURCE_KEY = 'kfl_upgrade_source';
  var RETURN_KEY = 'kfl_upgrade_return_to';
  var ALLOWED_RETURN = /^\/(?:account|dashboard|app)(?:[/?#]|$)/;

  function normalizeSource(value) {
    var source = String(value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(source) ? source : 'direct';
  }

  function safeReturnPath(value, origin) {
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
    var source = 'direct', returnTo = '';
    try {
      source = normalizeSource(storage && storage.getItem(SOURCE_KEY));
      returnTo = safeReturnPath(storage && storage.getItem(RETURN_KEY), origin);
    } catch (_e) {}
    return { source: source, returnTo: returnTo };
  }

  function capture(search, storage, origin) {
    try {
      var params = new URLSearchParams(search || '');
      var rawSource = params.get('source');
      var rawReturn = params.get('return_to');
      if (rawSource) storage.setItem(SOURCE_KEY, normalizeSource(rawSource));
      var safeReturn = safeReturnPath(rawReturn, origin);
      if (safeReturn) storage.setItem(RETURN_KEY, safeReturn);
    } catch (_e) {}
    return read(storage, origin);
  }

  function accountHref(plan, period, context) {
    var p = plan === 'family' ? 'family' : 'pro';
    var per = period === 'year' ? 'year' : 'month';
    var ctx = context || {};
    var source = normalizeSource(ctx.source);
    var returnTo = safeReturnPath(ctx.returnTo, 'https://kesefle.com');
    var query = '?plan=' + encodeURIComponent(p) + '&period=' + encodeURIComponent(per) +
      '&source=' + encodeURIComponent(source);
    if (returnTo) query += '&return_to=' + encodeURIComponent(returnTo);
    return '/account' + query;
  }

  return {
    normalizeSource: normalizeSource,
    safeReturnPath: safeReturnPath,
    read: read,
    capture: capture,
    accountHref: accountHref,
    keys: { source: SOURCE_KEY, returnTo: RETURN_KEY }
  };
});
