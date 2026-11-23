/* Kesefle browser-session hygiene.
 *
 * Authentication lives in the HttpOnly session cookie. Browser storage is
 * presentation/offline metadata only and must never retain reusable Google or
 * admin credentials. This file intentionally has no dependencies so it can run
 * before every app surface, including the offline PWA shell.
 */
(function (root) {
  'use strict';

  var USER_KEY = 'kesefle_user';
  var LEGACY_SECRET_KEYS = ['kefle_admin_token', 'kesefle_admin_token'];
  var legacyIdToken = null;
  var PROFILE_FIELDS = {
    sub: true,
    email: true,
    name: true,
    given_name: true,
    family_name: true,
    picture: true,
    plan: true,
    locale: true,
  };

  function sanitizeProfileObject(profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
    var clean = { version: 2 };
    Object.keys(PROFILE_FIELDS).forEach(function (key) {
      var value = profile[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    });
    return clean;
  }

  function sanitizeStorage(storage) {
    if (!storage) return null;
    LEGACY_SECRET_KEYS.forEach(function (key) {
      try { storage.removeItem(key); } catch (_e) {}
    });
    try {
      var raw = storage.getItem(USER_KEY);
      if (!raw) return null;
      var profile = JSON.parse(raw);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        storage.removeItem(USER_KEY);
        return null;
      }
      // One release-cycle compatibility bridge: keep a still-valid legacy
      // Google ID token in this closure only, then immediately remove it from
      // Web Storage. Dashboard may consume it once to mint the HttpOnly cookie.
      if (!legacyIdToken && storage === root.localStorage && typeof profile.idToken === 'string') {
        try {
          var parts = profile.idToken.split('.');
          if (parts.length !== 3) throw new Error('malformed_jwt');
          var encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          while (encoded.length % 4) encoded += '=';
          var payload = JSON.parse(root.atob(encoded));
          if (Number(payload.exp) * 1000 > Date.now() + 15000) legacyIdToken = profile.idToken;
        } catch (_ignore) {}
      }
      profile = sanitizeProfileObject(profile);
      storage.setItem(USER_KEY, JSON.stringify(profile));
      return profile;
    } catch (_e) {
      try { storage.removeItem(USER_KEY); } catch (_ignore) {}
      return null;
    }
  }

  function clearIdentityStorage(storage) {
    if (!storage) return;
    var exact = [
      USER_KEY,
      'kesefle_sheet',
      'kesefle_whatsapp_linked',
      'kesefle_whatsapp_phone',
      'kesefle_signup_progress',
      'kfl_referral_redeemed',
      'kfl_push_subscribed',
    ].concat(LEGACY_SECRET_KEYS);
    exact.forEach(function (key) {
      try { storage.removeItem(key); } catch (_e) {}
    });
    try {
      var remove = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key && key.indexOf('kesefle_fixed_expenses:') === 0) remove.push(key);
      }
      remove.forEach(function (key) { storage.removeItem(key); });
    } catch (_e) {}
  }

  function clearAuthFlowStorage(storage) {
    if (!storage) return;
    var exact = ['kfl_auth_next', 'kfl_oauth_state', 'kfl_pkce_verifier', 'kfl_pkce_started_at'];
    exact.forEach(function (key) {
      try { storage.removeItem(key); } catch (_e) {}
    });
    try {
      var remove = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key && (key.indexOf('kfl_pkce_verifier_') === 0 || key.indexOf('kfl_pkce_started_') === 0)) remove.push(key);
      }
      remove.forEach(function (key) { storage.removeItem(key); });
    } catch (_e) {}
  }

  function clearAllIdentityStorage() {
    try { clearIdentityStorage(root.localStorage); } catch (_e) {}
    try { clearIdentityStorage(root.sessionStorage); } catch (_e) {}
    try { clearAuthFlowStorage(root.sessionStorage); } catch (_e) {}
    legacyIdToken = null;
  }

  function consumeLegacyIdToken() {
    var token = legacyIdToken;
    legacyIdToken = null;
    return token;
  }

  function promiseWithDeadline(promise, timeoutMs, fallback, onLate) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = root.setTimeout(function () {
        if (finished) return;
        finished = true;
        resolve(fallback);
      }, timeoutMs);
      Promise.resolve(promise).then(function (value) {
        if (finished) {
          try { if (typeof onLate === 'function') onLate(value); } catch (_e) {}
          return;
        }
        finished = true;
        root.clearTimeout(timer);
        resolve(value);
      }, function () {
        if (finished) return;
        finished = true;
        root.clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  async function readSessionAuthority() {
    if (typeof root.fetch !== 'function') return { state: 'unknown', userSub: '' };
    try {
      var response = await promiseWithDeadline(root.fetch('/api/me', {
        credentials: 'include',
        cache: 'no-store',
      }), 1200, null);
      if (!response) return { state: 'unknown', userSub: '' };
      if (response.status === 401 || response.status === 403) return { state: 'signed_out', userSub: '' };
      if (!response.ok || typeof response.json !== 'function') return { state: 'unknown', userSub: '' };
      var payload = await promiseWithDeadline(response.json(), 600, null);
      var sub = payload && payload.user && typeof payload.user.sub === 'string' ? payload.user.sub : '';
      return sub ? { state: 'authenticated', userSub: sub } : { state: 'unknown', userSub: '' };
    } catch (_e) { return { state: 'unknown', userSub: '' }; }
  }

  async function detachLateSubscription(subscription, authoritativeSub) {
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint) return;
    var expectedUserSub = typeof authoritativeSub === 'string' ? authoritativeSub : '';
    // A different account may have signed in and enabled Push while the old
    // browser API promise was stalled. Never touch the now-current endpoint in
    // that case. Signed-out is safe for browser cleanup; server DELETE may 401.
    var authority = await readSessionAuthority();
    var sameAccount = expectedUserSub && authority.state === 'authenticated' && authority.userSub === expectedUserSub;
    if (!sameAccount && authority.state !== 'signed_out') return;
    if (typeof root.fetch === 'function') {
      try {
        Promise.resolve(root.fetch('/api/push/subscribe', {
          method: 'DELETE',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint, expectedUserSub: expectedUserSub }),
        })).catch(function () {});
      } catch (_e) {}
    }
    try {
      if (typeof subscription.unsubscribe === 'function') {
        Promise.resolve(subscription.unsubscribe()).catch(function () {});
      }
    } catch (_e) {}
  }

  function detachLateRegistration(registration, authoritativeSub) {
    if (!registration || !registration.pushManager ||
        typeof registration.pushManager.getSubscription !== 'function') return;
    try {
      Promise.resolve(registration.pushManager.getSubscription()).then(function (subscription) {
        detachLateSubscription(subscription, authoritativeSub).catch(function () {});
      }).catch(function () {});
    } catch (_e) {}
  }

  // Detach this browser's Web Push endpoint while the authenticated cookie is
  // still available. The exact endpoint prevents this device from deleting a
  // newer subscription owned by another phone. Browser unsubscribe still runs
  // when the network/KV call fails, and logout remains best-effort/offline-safe.
  async function detachPushBeforeLogout(authoritativeSub) {
    try { root.localStorage.removeItem('kfl_push_subscribed'); } catch (_e) {}
    try { root.sessionStorage.removeItem('kfl_push_subscribed'); } catch (_e) {}

    var nav = root.navigator;
    if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.getRegistration !== 'function') {
      return { serverRemoved: false, browserUnsubscribed: false, skipped: true };
    }

    var expectedUserSub = typeof authoritativeSub === 'string' ? authoritativeSub : '';
    if (!expectedUserSub) {
      var initialAuthority = await readSessionAuthority();
      if (initialAuthority.state === 'authenticated') expectedUserSub = initialAuthority.userSub;
    }

    var registration;
    var subscription;
    try {
      registration = await promiseWithDeadline(
        nav.serviceWorker.getRegistration('/'),
        1500,
        null,
        function (lateRegistration) { detachLateRegistration(lateRegistration, expectedUserSub); },
      );
      if (!registration || !registration.pushManager) throw new Error('no_push_registration');
      subscription = await promiseWithDeadline(
        registration.pushManager.getSubscription(),
        1500,
        null,
        function (lateSubscription) { detachLateSubscription(lateSubscription, expectedUserSub).catch(function () {}); },
      );
    } catch (_e) {
      return { serverRemoved: false, browserUnsubscribed: false, skipped: true };
    }
    if (!subscription || typeof subscription.endpoint !== 'string') {
      return { serverRemoved: false, browserUnsubscribed: false, skipped: true };
    }

    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timeout = controller ? root.setTimeout(function () { controller.abort(); }, 1500) : null;
    var deletePromise = (async function () {
      if (typeof root.fetch !== 'function') return false;
      try {
        var options = {
          method: 'DELETE',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint, expectedUserSub: expectedUserSub }),
        };
        if (controller) options.signal = controller.signal;
        var response = await root.fetch('/api/push/subscribe', options);
        if (!response || !response.ok || typeof response.json !== 'function') return false;
        var payload = await response.json();
        return !!(payload && payload.removed === true);
      } catch (_e) { return false; }
    })();
    var unsubscribePromise = promiseWithDeadline(Promise.resolve().then(function () {
      return typeof subscription.unsubscribe === 'function' ? subscription.unsubscribe() : false;
    }), 1500, false);

    var results = await Promise.all([deletePromise, unsubscribePromise]);
    if (timeout != null) root.clearTimeout(timeout);
    return { serverRemoved: results[0] === true, browserUnsubscribed: results[1] === true };
  }

  function waitForPushTask(task, timeoutMs) {
    if (!task || typeof task.then !== 'function') return Promise.resolve('idle');
    var limit = Number(timeoutMs);
    if (!Number.isFinite(limit) || limit < 1) limit = 8000;
    return new Promise(function (resolve) {
      var finished = false;
      var timer = root.setTimeout(function () {
        if (finished) return;
        finished = true;
        resolve('timed_out');
      }, limit);
      Promise.resolve(task).then(function () {
        if (finished) return;
        finished = true;
        root.clearTimeout(timer);
        resolve('settled');
      }, function () {
        if (finished) return;
        finished = true;
        root.clearTimeout(timer);
        resolve('settled');
      });
    });
  }

  async function cancelPushBeforeLogout(authoritativeSub) {
    // Marker is synchronous: permission/subscription continuations see it
    // before this function reaches its first await.
    root.__kflPushLogout = true;
    var task = root.__kflPushEnableTask;
    if (task && root.__kflPushEnableStage === 'mutating') {
      await waitForPushTask(task, 8000);
    }
    return detachPushBeforeLogout(authoritativeSub);
  }

  var api = {
    sanitizeProfileObject: sanitizeProfileObject,
    sanitizeStorage: sanitizeStorage,
    clearIdentityStorage: clearIdentityStorage,
    clearAllIdentityStorage: clearAllIdentityStorage,
    consumeLegacyIdToken: consumeLegacyIdToken,
    detachPushBeforeLogout: detachPushBeforeLogout,
    waitForPushTask: waitForPushTask,
    cancelPushBeforeLogout: cancelPushBeforeLogout,
  };
  root.KesefleSession = api;

  // Scrub both stores immediately. PKCE state/verifiers use separate keys and
  // deliberately remain untouched so an OAuth callback can still complete.
  try { sanitizeStorage(root.localStorage); } catch (_e) {}
  try { sanitizeStorage(root.sessionStorage); } catch (_e) {}
})(typeof window !== 'undefined' ? window : globalThis);
