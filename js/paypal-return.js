// PayPal return-state controller.
// A query-string success flag is only a claim that the browser returned from
// PayPal. We show success only after the authenticated server confirms that the
// subscription is ACTIVE and belongs to this user.
(function () {
  'use strict';

  var RETRY_DELAYS_MS = [0, 900, 2000];
  var REQUEST_TIMEOUT_MS = 6000;
  var subscriptionId = '';
  var verifying = false;

  function byId(id) { return document.getElementById(id); }
  function show(id, visible) { var el = byId(id); if (el) el.hidden = !visible; }
  function setPageState(state) {
    try { document.body.setAttribute('data-paypal-return-state', state); } catch (_e) {}
  }
  function setHeader(title, subtitle, icon, success) {
    var titleEl = byId('upgrade-title');
    var subEl = byId('upgrade-sub');
    var iconEl = byId('state-icon');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
    if (iconEl) {
      iconEl.textContent = icon;
      iconEl.className = success
        ? 'mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-4xl mb-6 shadow-lg shadow-brand-500/30'
        : 'mx-auto w-20 h-20 rounded-full bg-ink-100 ring-1 ring-ink-200 flex items-center justify-center text-4xl mb-6';
    }
  }
  function setStatus(message) {
    var el = byId('confirm-status');
    if (el) el.textContent = message;
  }
  function setRetry(visible, disabled) {
    var button = byId('btn-confirm-retry');
    if (!button) return;
    button.hidden = !visible;
    button.disabled = !!disabled;
  }
  function showOnly(state) {
    show('state-pending', state === 'pending');
    show('state-success', state === 'success');
    show('state-cancel', state === 'cancel');
  }
  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function launchConfetti() {
    var c = byId('confetti');
    if (!c) return;
    c.hidden = false;
    var colors = ['#2563eb', '#1d4ed8', '#7dd3fc', '#38bdf8', '#a855f7', '#f59e0b'];
    for (var i = 0; i < 60; i++) {
      var piece = document.createElement('span');
      piece.style.left = (Math.random() * 100) + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = (Math.random() * 0.5) + 's';
      piece.style.animationDuration = (2.5 + Math.random() * 2) + 's';
      c.appendChild(piece);
    }
    setTimeout(function () { try { c.remove(); } catch (_e) {} }, 5500);
  }

  function renderCancel() {
    showOnly('cancel');
    setRetry(false, false);
    setHeader('ביטלת את השדרוג', 'לא בוצע שום חיוב. החשבון שלך נשאר בדיוק כפי שהיה — אפשר לשדרג בכל רגע שתרצה.', '↩', false);
    setPageState('cancel');
    try { document.title = "בוטל — כספ'לה"; } catch (_e) {}
  }

  function renderNeutral(message) {
    showOnly('pending');
    setRetry(false, false);
    setHeader('סטטוס שדרוג', message, '…', false);
    setStatus(message);
    setPageState('neutral');
  }

  function renderVerifying(attempt) {
    showOnly('pending');
    setRetry(false, true);
    setHeader('בודקים את השדרוג', 'חזרת מ-PayPal. אנחנו מאמתים שהמנוי אושר לפני שנציג אותו כפעיל.', '…', false);
    setStatus(attempt > 1 ? 'PayPal עדיין מעדכן את המנוי. בודקים שוב אוטומטית…' : 'האימות מתבצע עכשיו. אין צורך לרענן או לבצע תשלום נוסף.');
    setPageState('verifying');
  }

  function renderSuccess() {
    showOnly('success');
    setRetry(false, false);
    setHeader('השדרוג הושלם!', 'המנוי שלך אושר ופעיל! כל יכולות הפרימיום פתוחות עכשיו.', '✓', true);
    setPageState('success');
    try { document.title = "השדרוג הושלם — כספ'לה"; } catch (_e) {}
    launchConfetti();
  }

  function renderFailure(result) {
    var data = result && result.data || {};
    var status = result && result.status || 0;
    var message;
    if (status === 401) {
      message = 'ההתחברות לחשבון פגה, ולכן לא יכולנו לאמת את המנוי. התחבר מחדש בעמוד החשבון ואז חזור לבדיקה.';
    } else if (status === 403) {
      message = 'המנוי שחזר מ-PayPal אינו תואם לחשבון המחובר. לא הפעלנו דבר. אפשר לפנות לתמיכה עם אישור PayPal.';
    } else if (data.error === 'invalid_subscription_id') {
      message = 'מזהה המנוי שחזר מ-PayPal אינו תקין. לא הצגנו הצלחה ולא בוצעה הפעלה נוספת.';
    } else {
      message = 'PayPal עדיין לא אישר שהמנוי פעיל, או שהחיבור נקטע. לא צריך לשלם שוב — אפשר לבדוק שוב בעוד רגע.';
    }
    showOnly('pending');
    setHeader('השדרוג עדיין בבדיקה', message, '…', false);
    setStatus(message);
    setRetry(!!subscriptionId && status !== 401 && status !== 403, false);
    setPageState('error');
  }

  function requestConfirmation() {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch('/api/billing/paypal?action=confirm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: subscriptionId }),
      signal: controller ? controller.signal : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { ok: response.ok && !!data.ok, status: response.status, data: data };
      });
    }).catch(function () {
      return { ok: false, status: 0, data: { error: 'network' } };
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    });
  }

  function retryable(result) {
    var status = result && result.status || 0;
    return status === 0 || status === 404 || status === 409 || status === 429 || status >= 500;
  }

  async function verify() {
    if (verifying || !subscriptionId) return false;
    verifying = true;
    var last = null;
    try {
      for (var i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (RETRY_DELAYS_MS[i]) await wait(RETRY_DELAYS_MS[i]);
        renderVerifying(i + 1);
        last = await requestConfirmation();
        if (last.ok) { renderSuccess(); return true; }
        if (!retryable(last)) break;
      }
      renderFailure(last);
      return false;
    } finally {
      verifying = false;
      var button = byId('btn-confirm-retry');
      if (button && !button.hidden) button.disabled = false;
    }
  }

  function init() {
    var params;
    var paypal = '';
    try {
      params = new URLSearchParams(window.location.search || '');
      paypal = (params.get('paypal') || '').toLowerCase();
      subscriptionId = (params.get('subscription_id') || '').trim();
    } catch (_e) {}

    if (paypal === 'cancel' || paypal === 'cancelled' || paypal === 'canceled') {
      renderCancel();
      return;
    }
    if (paypal !== 'success') {
      renderNeutral('אם השלמת תשלום ב-PayPal, אפשר לבדוק את המסלול בעמוד החשבון. המסך הזה לא יציג הצלחה ללא אישור שרת.');
      return;
    }
    if (!subscriptionId || subscriptionId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(subscriptionId)) {
      renderFailure({ status: 400, data: { error: 'invalid_subscription_id' } });
      return;
    }
    verify();
  }

  window.kflRetryPaypalConfirm = verify;
  var retryButton = byId('btn-confirm-retry');
  if (retryButton) retryButton.addEventListener('click', verify);
  init();
})();
