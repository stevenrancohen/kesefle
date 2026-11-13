// Privacy-safe pricing -> signup measurement.
//
// Uses the existing first-party window.kfl tracker only. That tracker stores a
// random per-tab session ID in sessionStorage, creates no cookie, sends no PII,
// and is a no-op when DNT or Global Privacy Control is enabled.
(function () {
  'use strict';

  var STATE_KEY = 'kfl_pricing_funnel_v1';
  var TRIAL_PENDING_KEY = 'kfl_pricing_trial_started_pending';
  var VALID_INTENTS = { trial: 1, paypal: 1 };
  var VALID_PLANS = { free: 1, pro: 1, family: 1 };

  function analyticsEnabled() {
    return !!(window.kfl && typeof window.kfl.track === 'function' && !window.kfl._disabled);
  }

  function readState() {
    try {
      var parsed = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null');
      if (!parsed || !VALID_INTENTS[parsed.intent] || !VALID_PLANS[parsed.plan]) return null;
      return parsed;
    } catch (_e) { return null; }
  }

  function writeState(state) {
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (_e) {}
  }

  function selectedPeriod(el) {
    var attr = el && el.getAttribute ? el.getAttribute('data-kfl-period') : '';
    if (attr === 'year') return 'year';
    try { return sessionStorage.getItem('kfl_pricing_period') === 'year' ? 'year' : 'month'; }
    catch (_e) { return 'month'; }
  }

  function eventName(intent, stage) {
    if (stage === 'selected') return intent === 'paypal' ? 'pricing_paypal_selected' : 'pricing_trial_selected';
    if (stage === 'arrived') return intent === 'paypal' ? 'pricing_paypal_arrived' : 'pricing_trial_arrived';
    return 'pricing_trial_started';
  }

  function send(event, state) {
    if (!analyticsEnabled()) return false;
    return window.kfl.track(event, {
      plan: state.plan,
      source: 'pricing_' + state.intent,
      feature: state.period,
    }) !== false;
  }

  function select(intent, plan, period) {
    intent = VALID_INTENTS[intent] ? intent : 'trial';
    plan = VALID_PLANS[plan] ? plan : (intent === 'paypal' ? 'pro' : 'free');
    period = period === 'year' ? 'year' : 'month';

    // Consent refusal means no analytics state and no event. The link's normal
    // navigation continues because this function never prevents or awaits it.
    if (!analyticsEnabled()) return false;

    var state = {
      version: 1,
      intent: intent,
      plan: plan,
      period: period,
      selected: false,
      arrived: false,
      trialStarted: false,
    };
    state.selected = send(eventName(intent, 'selected'), state);
    writeState(state);
    return state.selected;
  }

  function stateFromArrivalQuery() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var from = params.get('from');
      var intent = from === 'pricing-paypal' ? 'paypal' : (from === 'pricing-trial' ? 'trial' : '');
      if (!intent) return null;
      var plan = params.get('plan');
      if (!VALID_PLANS[plan]) plan = intent === 'paypal' ? 'pro' : 'free';
      return {
        version: 1,
        intent: intent,
        plan: plan,
        period: params.get('period') === 'year' ? 'year' : 'month',
        selected: false,
        arrived: false,
        trialStarted: false,
      };
    } catch (_e) { return null; }
  }

  function markSignupArrival() {
    if (!analyticsEnabled()) return false;
    var state = readState() || stateFromArrivalQuery();
    if (!state || state.arrived) return false;
    state.arrived = send(eventName(state.intent, 'arrived'), state);
    writeState(state);
    return state.arrived;
  }

  function markTrialStarted() {
    var pending = false;
    try { pending = sessionStorage.getItem(TRIAL_PENDING_KEY) === '1'; } catch (_e) {}
    if (!pending || !analyticsEnabled()) return false;

    var state = readState();
    // A new user can be created while following the PayPal path too. Keep the
    // two funnels distinct: only the explicit free-trial path emits this step.
    if (!state || state.intent !== 'trial') {
      try { sessionStorage.removeItem(TRIAL_PENDING_KEY); } catch (_e2) {}
      return false;
    }
    if (!state.trialStarted) {
      state.trialStarted = send(eventName('trial', 'started'), state);
      writeState(state);
    }
    if (state.trialStarted) {
      try { sessionStorage.removeItem(TRIAL_PENDING_KEY); } catch (_e3) {}
    }
    return state.trialStarted;
  }

  function onPricingClick(event) {
    var target = event && event.target;
    var el = target && target.closest ? target.closest('[data-kfl-pricing-intent]') : null;
    if (!el) return;
    var intent = el.getAttribute('data-kfl-pricing-intent');
    var plan = el.getAttribute('data-kfl-plan');
    select(intent, plan, selectedPeriod(el));
    // Intentionally no preventDefault and no async work: navigation/payment
    // logic remains owned by the CTA itself.
  }

  window.kflPricingFunnel = {
    select: select,
    markSignupArrival: markSignupArrival,
    markTrialStarted: markTrialStarted,
    _readState: readState,
  };

  document.addEventListener('click', onPricingClick, true);

  function onReady() {
    if (/\/account(?:\.html)?\/?$/.test(window.location.pathname || '')) markSignupArrival();
    markTrialStarted();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
})();
