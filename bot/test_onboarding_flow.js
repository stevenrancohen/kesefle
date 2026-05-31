#!/usr/bin/env node
// Test the extended onboarding questionnaire — sections A-H — added to
// bot/ExpenseBot_FIXED.gs on top of the existing Q1-Q4 survey.
//
// Sections A-D are collected by the legacy Q1-Q4 flow (tracking type, kids/
// pets, car, recurring). This suite covers the NEW E-H block + the preset
// pick:
//   E business    (only when trackingType=business)
//   F contractor  (only when business OR a construction profession)
//   G budgets     (always)
//   H import hist. (always)
//
// We exercise the REAL source. The pure branching/preset helpers are sliced
// out and eval'd directly. The interactive section handler is then replayed
// end-to-end against in-memory mocks for the Apps Script globals it touches
// (_profileAPI_, the WhatsApp senders, Logger, _surveySetState_,
// _surveyFinish_) so we assert (a) conditional branching, (b) per-section
// storage keyed by letter, and (c) the terminal profile_type preset pick.
//
// Run: node bot/test_onboarding_flow.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; fails.push(label); console.log('  FAIL ' + label + (detail ? ' -- ' + detail : '')); }
}

// ── Slice the whole A-H section-engine block out of the source. It runs from
// the `_ONBOARDING_CONTRACTOR_PROFESSIONS_` table down to (but not including)
// the cronRecurringExpenses function that follows it. ───────────────────────
function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, j);
}

const blockSrc = sliceBetween(
  SRC,
  'var _ONBOARDING_CONTRACTOR_PROFESSIONS_',
  '\nfunction cronRecurringExpenses'
);

// ── Build a sandbox with mocks for every Apps Script global the block
// references, plus an in-memory KV-backed _profileAPI_ so the read-modify-
// write storage path runs for real. ─────────────────────────────────────────
function makeSandbox() {
  const store = {};            // phone -> profile object (the "KV")
  const sent = [];             // every WhatsApp send, in order
  const states = {};           // phone -> survey state string
  let finishedFor = null;      // phone passed to _surveyFinish_ (terminal)

  const sandbox = {
    store, sent, states,
    getFinished() { return finishedFor; },
  };

  // Pure logger.
  sandbox.Logger = { log() {} };

  // The profile bridge, backed by `store`. Mirrors the real action shapes:
  //   get { phone } -> { ok, profile }
  //   set { phone, fields } -> merges fields onto store[phone]
  sandbox._profileAPI_ = function (action, payload) {
    payload = payload || {};
    const phone = String(payload.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return { ok: false, error: 'no_phone' };
    if (action === 'get') {
      return { ok: true, profile: JSON.parse(JSON.stringify(store[phone] || {})) };
    }
    if (action === 'set') {
      const cur = store[phone] || {};
      const f = payload.fields || {};
      // Emulate the api/profile.js merge semantics for the fields this flow
      // actually sets: `onboarding` (shallow-merge by letter) + `profileType`.
      for (const k of Object.keys(f)) {
        if (k === 'onboarding' && f[k] && typeof f[k] === 'object') {
          cur.onboarding = Object.assign({}, cur.onboarding || {}, f[k]);
        } else {
          cur[k] = f[k];
        }
      }
      store[phone] = cur;
      return { ok: true, profile: JSON.parse(JSON.stringify(cur)) };
    }
    return { ok: false, error: 'unknown_action' };
  };

  // WhatsApp senders — record only.
  sandbox.sendWhatsAppMessage = function (to, msg) { sent.push({ kind: 'msg', to, msg }); };
  sandbox.sendWhatsAppQuickButtons = function (to, body, buttons) {
    sent.push({ kind: 'buttons', to, body, ids: (buttons || []).map(function (b) { return b.id; }) });
  };

  // Survey-state stubs.
  sandbox._surveySetState_ = function (phone, s) { states[String(phone).replace(/[^0-9]/g, '')] = s; };
  sandbox._surveyGetState_ = function (phone) { return states[String(phone).replace(/[^0-9]/g, '')] || null; };

  // Terminal — the existing summary. We stub it (it lives elsewhere in the
  // file and pulls many unrelated survey helpers); all we care about is that
  // the A-H block reaches it exactly once, AFTER storing profileType.
  sandbox._surveyFinish_ = function (phone) { finishedFor = String(phone).replace(/[^0-9]/g, ''); };

  // Eval the real block into the sandbox, then export the entry points.
  const code = blockSrc +
    '\nsandbox._onboardingSectionPlan_ = _onboardingSectionPlan_;' +
    '\nsandbox._onboardingNextSection_ = _onboardingNextSection_;' +
    '\nsandbox._onboardingPickPreset_ = _onboardingPickPreset_;' +
    '\nsandbox._PROFESSION_IS_SELF_EMPLOYED_ = _PROFESSION_IS_SELF_EMPLOYED_;' +
    '\nsandbox._onboardingHandleInteractive_ = _onboardingHandleInteractive_;' +
    '\nsandbox._onboardingStartSections_ = _onboardingStartSections_;' +
    '\nsandbox._ONBOARDING_PRESETS_ = _ONBOARDING_PRESETS_;' +
    '\nsandbox._ONBOARDING_CONTRACTOR_PROFESSIONS_ = _ONBOARDING_CONTRACTOR_PROFESSIONS_;';
  // Expose the mocks as free variables inside the evaluated block.
  new Function(
    'sandbox', 'Logger', '_profileAPI_', 'sendWhatsAppMessage',
    'sendWhatsAppQuickButtons', '_surveySetState_', '_surveyGetState_', '_surveyFinish_',
    code
  )(sandbox, sandbox.Logger, sandbox._profileAPI_, sandbox.sendWhatsAppMessage,
    sandbox.sendWhatsAppQuickButtons, sandbox._surveySetState_, sandbox._surveyGetState_,
    sandbox._surveyFinish_);

  return sandbox;
}

const S = makeSandbox();

// ════════════════════════════════════════════════════════════════════════
// 1) PURE: _onboardingSectionPlan_ — conditional section gating.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 1) section plan (conditional branching) ==');

function planOf(profile) { return S._onboardingSectionPlan_(profile).join(','); }

// Basic personal user: NO business, NO contractor -> only budgets + import.
check('personal user skips business+contractor (plan = G,H)',
  planOf({ trackingType: 'personal' }) === 'G,H', planOf({ trackingType: 'personal' }));

// Personal user with a salaried profession: still G,H.
check('personal+office_worker -> G,H',
  planOf({ trackingType: 'personal', profession: 'office_worker' }) === 'G,H',
  planOf({ trackingType: 'personal', profession: 'office_worker' }));

// Family tracker: business/contractor still skipped (not a business).
check('family user -> G,H',
  planOf({ trackingType: 'family' }) === 'G,H', planOf({ trackingType: 'family' }));

// Business tracker: gets E (business) + F (contractor q) + G + H.
check('business user -> E,F,G,H',
  planOf({ trackingType: 'business' }) === 'E,F,G,H', planOf({ trackingType: 'business' }));

// Personal tracker who is a building contractor by profession: F fires even
// though they aren't a "business" tracking type, but E does NOT.
check('personal + general_contractor -> F,G,H (F but not E)',
  planOf({ trackingType: 'personal', profession: 'general_contractor' }) === 'F,G,H',
  planOf({ trackingType: 'personal', profession: 'general_contractor' }));

// Business contractor: E,F,G,H (both gates on).
check('business + electrician -> E,F,G,H',
  planOf({ trackingType: 'business', profession: 'electrician' }) === 'E,F,G,H',
  planOf({ trackingType: 'business', profession: 'electrician' }));

// Empty / missing profile -> defaults to G,H (never empty; G/H always run).
check('empty profile -> G,H', planOf({}) === 'G,H', planOf({}));
check('null profile -> G,H', planOf(null) === 'G,H', planOf(null));

// ════════════════════════════════════════════════════════════════════════
// 2) PURE: _onboardingNextSection_ — sequence stepping.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 2) next-section stepping ==');

const bizProfile = { trackingType: 'business' };
check('business: first section is E', S._onboardingNextSection_(bizProfile, null) === 'E');
check('business: after E -> F', S._onboardingNextSection_(bizProfile, 'E') === 'F');
check('business: after F -> G', S._onboardingNextSection_(bizProfile, 'F') === 'G');
check('business: after G -> H', S._onboardingNextSection_(bizProfile, 'G') === 'H');
check('business: after H -> null (done)', S._onboardingNextSection_(bizProfile, 'H') === null);

const persProfile = { trackingType: 'personal' };
check('personal: first section is G', S._onboardingNextSection_(persProfile, null) === 'G');
check('personal: after G -> H', S._onboardingNextSection_(persProfile, 'G') === 'H');
check('personal: after H -> null (done)', S._onboardingNextSection_(persProfile, 'H') === null);
// A section NOT in the plan (e.g. E for a personal user) -> stop.
check('personal: doneSection=E (not in plan) -> null',
  S._onboardingNextSection_(persProfile, 'E') === null);

// ════════════════════════════════════════════════════════════════════════
// 3) PURE: _onboardingPickPreset_ — profile_type derivation.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 3) preset (profile_type) pick ==');

check('business+contractor profession -> contractor',
  S._onboardingPickPreset_({ trackingType: 'business', profession: 'general_contractor' }) === 'contractor');
check('business + tracksProjects -> contractor',
  S._onboardingPickPreset_({ trackingType: 'business', onboarding: { F: { tracksProjects: true } } }) === 'contractor');
check('business, no contractor signal -> business',
  S._onboardingPickPreset_({ trackingType: 'business', profession: 'lawyer', onboarding: { F: { tracksProjects: false } } }) === 'business');
check('family tracker -> family',
  S._onboardingPickPreset_({ trackingType: 'family' }) === 'family');
check('group tracker -> family',
  S._onboardingPickPreset_({ trackingType: 'group' }) === 'family');
check('personal + wants import -> advanced_imported',
  S._onboardingPickPreset_({ trackingType: 'personal', onboarding: { H: { wantsImport: true } } }) === 'advanced_imported');
check('personal + self-employed profession (no import) -> mixed',
  S._onboardingPickPreset_({ trackingType: 'personal', profession: 'graphic_designer' }) === 'mixed');
check('personal + salaried profession -> basic_personal',
  S._onboardingPickPreset_({ trackingType: 'personal', profession: 'office_worker' }) === 'basic_personal');
check('bare personal -> basic_personal',
  S._onboardingPickPreset_({ trackingType: 'personal' }) === 'basic_personal');
// Precedence: business beats import (an importing business is still business/contractor).
check('business + wants import -> business (business beats import)',
  S._onboardingPickPreset_({ trackingType: 'business', profession: 'lawyer', onboarding: { H: { wantsImport: true } } }) === 'business');

// Every preset id the picker can return must be a known preset.
const PRESET_IDS = Object.keys(S._ONBOARDING_PRESETS_);
['contractor', 'business', 'family', 'advanced_imported', 'mixed', 'basic_personal'].forEach(function (p) {
  check('preset id "' + p + '" is in _ONBOARDING_PRESETS_', PRESET_IDS.indexOf(p) >= 0);
});

// ════════════════════════════════════════════════════════════════════════
// 4) PURE: _PROFESSION_IS_SELF_EMPLOYED_.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 4) self-employed classifier ==');
check('graphic_designer is self-employed', S._PROFESSION_IS_SELF_EMPLOYED_('graphic_designer') === true);
check('cashier is NOT self-employed', S._PROFESSION_IS_SELF_EMPLOYED_('cashier') === false);
check('office_worker is NOT self-employed', S._PROFESSION_IS_SELF_EMPLOYED_('office_worker') === false);
check('other_employee is NOT self-employed', S._PROFESSION_IS_SELF_EMPLOYED_('other_employee') === false);
check('empty profession -> false', S._PROFESSION_IS_SELF_EMPLOYED_('') === false);

// ════════════════════════════════════════════════════════════════════════
// 5) END-TO-END REPLAY: business contractor walks E -> F -> G -> H.
//    Asserts each tap is consumed, the right answer is stored under the
//    right letter, and the terminal preset + finish fire exactly once.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 5) e2e replay: business contractor ==');

const PHONE = '972500000001';
// Seed the profile as if Q1-Q4 already ran: business + contractor profession.
S.store[PHONE] = { trackingType: 'business', profession: 'general_contractor' };

// Kick off the A-H block (as _surveyHandleInteractive_ does after Q4).
S._onboardingStartSections_(PHONE);
// First question should be section E (osek type) — a buttons message.
let last = S.sent[S.sent.length - 1];
check('start sends section E buttons', last && last.kind === 'buttons' && last.ids.indexOf('sec_e_morsheh') >= 0,
  last && JSON.stringify(last.ids));
check('state is sec_E_await', S.states[PHONE] === 'sec_E_await', S.states[PHONE]);

// Tap "עוסק מורשה".
check('sec_e_morsheh consumed', S._onboardingHandleInteractive_(PHONE, 'sec_e_morsheh') === true);
check('E stored osekType=morsheh', S.store[PHONE].onboarding && S.store[PHONE].onboarding.E && S.store[PHONE].onboarding.E.osekType === 'morsheh',
  JSON.stringify(S.store[PHONE].onboarding));
// Next question = F.
check('after E -> section F sent', S.states[PHONE] === 'sec_F_await', S.states[PHONE]);

// Tap "כן, לפי פרויקט".
check('sec_f_yes consumed', S._onboardingHandleInteractive_(PHONE, 'sec_f_yes') === true);
check('F stored tracksProjects=true', S.store[PHONE].onboarding.F && S.store[PHONE].onboarding.F.tracksProjects === true,
  JSON.stringify(S.store[PHONE].onboarding.F));
check('after F -> section G sent', S.states[PHONE] === 'sec_G_await', S.states[PHONE]);

// Tap "כן, תזכיר לי".
check('sec_g_yes consumed', S._onboardingHandleInteractive_(PHONE, 'sec_g_yes') === true);
check('G stored wantsBudget=true', S.store[PHONE].onboarding.G && S.store[PHONE].onboarding.G.wantsBudget === true,
  JSON.stringify(S.store[PHONE].onboarding.G));
check('after G -> section H sent', S.states[PHONE] === 'sec_H_await', S.states[PHONE]);

// Tap "מתחיל מעכשיו" (no import).
check('sec_h_no consumed', S._onboardingHandleInteractive_(PHONE, 'sec_h_no') === true);
check('H stored wantsImport=false', S.store[PHONE].onboarding.H && S.store[PHONE].onboarding.H.wantsImport === false,
  JSON.stringify(S.store[PHONE].onboarding.H));

// Terminal: preset stored + finish called.
check('profileType stored = contractor (business + tracksProjects)',
  S.store[PHONE].profileType === 'contractor', S.store[PHONE].profileType);
check('_surveyFinish_ called for this phone', S.getFinished() === PHONE, S.getFinished());

// All four sections persisted under their letters.
['E', 'F', 'G', 'H'].forEach(function (L) {
  check('onboarding.' + L + ' persisted', !!(S.store[PHONE].onboarding && S.store[PHONE].onboarding[L]));
});

// ════════════════════════════════════════════════════════════════════════
// 6) END-TO-END REPLAY: basic personal user skips E+F, walks G -> H only,
//    and an import-yes answer routes to advanced_imported.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 6) e2e replay: basic personal (skips business/contractor) ==');

const P2 = '972500000002';
S.store[P2] = { trackingType: 'personal', profession: 'office_worker' };
S._onboardingStartSections_(P2);
// First question must be G (NOT E) — proves business/contractor were skipped.
check('personal user first question is budgets (G), not business',
  S.states[P2] === 'sec_G_await', S.states[P2]);
// A business tap must be IGNORED for this user's flow id-wise — but more
// importantly, no E/F state was ever set. Assert no E/F send happened.
const p2sends = S.sent.filter(function (s) { return s.to === P2; });
check('no section E/F buttons sent to personal user',
  p2sends.every(function (s) { return s.kind !== 'buttons' || (s.ids.indexOf('sec_e_morsheh') < 0 && s.ids.indexOf('sec_f_yes') < 0); }),
  JSON.stringify(p2sends.map(function (s) { return s.ids; })));

check('sec_g_no consumed', S._onboardingHandleInteractive_(P2, 'sec_g_no') === true);
check('G stored wantsBudget=false', S.store[P2].onboarding.G.wantsBudget === false);
check('after G -> H', S.states[P2] === 'sec_H_await', S.states[P2]);
check('sec_h_yes consumed', S._onboardingHandleInteractive_(P2, 'sec_h_yes') === true);
check('H stored wantsImport=true', S.store[P2].onboarding.H.wantsImport === true);
check('import-yes sends a follow-up message',
  S.sent.some(function (s) { return s.to === P2 && s.kind === 'msg' && /ייבוא/.test(s.msg); }));
check('profileType = advanced_imported', S.store[P2].profileType === 'advanced_imported', S.store[P2].profileType);
check('_surveyFinish_ called for P2', S.getFinished() === P2, S.getFinished());

// A stray non-section tap is NOT consumed by the section handler.
check('non-section tap (q1_personal) not consumed by section handler',
  S._onboardingHandleInteractive_(P2, 'q1_personal') === false);

// ════════════════════════════════════════════════════════════════════════
// 7) SOURCE WIRING: the dispatch + finish hand-off must be present so the
//    flow is actually reachable from the live bot (not just in this sandbox).
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 7) source wiring ==');

// Q4 completion now hands off to the A-H block (3 sites) instead of finishing.
check('Q4 hands off to _onboardingStartSections_',
  /_onboardingStartSections_\(fromPhone\)/.test(SRC));
const startCount = (SRC.match(/_onboardingStartSections_\(fromPhone\)/g) || []).length;
check('at least 3 hand-off sites from Q4 (interactive + 2 free-text)',
  startCount >= 3, 'found ' + startCount);

// The interactive dispatch routes sec_* taps to the survey handler.
check('handleInteractiveReply_ routes sec_* to _surveyHandleInteractive_',
  /\/\^sec_\/\.test\(String\(picked\)\)/.test(SRC));
// And q4_ is now routed too (was a latent gap: /^q[123]_/ excluded q4).
check('handleInteractiveReply_ gate now includes q4 (q[1234])',
  /\/\^q\[1234\]_\//.test(SRC));

// _surveyHandleInteractive_ consumes sec_* early and returns.
check('_surveyHandleInteractive_ delegates sec_* to _onboardingHandleInteractive_',
  /picked\.indexOf\('sec_'\)\s*===\s*0/.test(SRC) &&
  /_onboardingHandleInteractive_\(fromPhone,\s*picked\)/.test(SRC));

// The finish summary surfaces the chosen preset.
check('_surveyFinish_ shows the preset (profileType) in the summary',
  /prof\.profileType/.test(SRC) && /_ONBOARDING_PRESETS_\[prof\.profileType\]/.test(SRC));

// ── Result ──────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0
  ? 'ALL ' + pass + ' CHECKS PASSED'
  : fail + ' FAILED, ' + pass + ' passed\n  - ' + fails.join('\n  - ')));
process.exit(fail === 0 ? 0 : 1);
