#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const account = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');

assert.match(account, /id="sheet-provision-controls"/);
assert.match(account, /id="sheet-ready-summary"/);
assert.match(account, /id="account-quick-add" href="\/expense\?from=account-activation"/);
assert.match(account, /id="whatsapp-availability-note"/);
assert.match(account, /kesefleApplyWhatsAppAvailability\(c\.waba_approved\)/);
assert.match(account, /id="service-status-title"/);
assert.match(account, /הוספה באפליקציה זמינה; WhatsApp בהשקה הדרגתית/);
assert.match(account, /אין צורך ליצור גיליון נוסף/);
assert.match(account, /var totalSteps = whatsappRequired \? 3 : 2/);
assert.match(account, /if \(kflWabaApproved === false\)[\s\S]*?return;[\s\S]*?var input = document\.getElementById\('link-phone-input'\)/,
  'the link endpoint cannot be offered programmatically while WhatsApp is unavailable');
assert.doesNotMatch(account, /window\.location\.href = '\/welcome'/,
  'sheet completion must not divert the user away from first-value activation');

const start = account.indexOf('var kflWabaApproved = null;');
const end = account.indexOf('\nfunction kesefleMarkStepDone', start);
assert.ok(start >= 0 && end > start, 'activation UI helpers are extractable');

function fakeElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    href: '',
    disabled: false,
    innerHTML: '',
    textContent: '',
    style: {},
    setAttribute(name, value) { this[name] = value; },
  };
}

function createRuntime(initialSheet) {
  let sheet = initialSheet || null;
  let celebrations = 0;
  const elements = {
    'sheet-provision-controls': fakeElement(),
    'sheet-ready-summary': fakeElement(['hidden']),
    'sheet-ready-link': fakeElement(),
    'step-2-title': fakeElement(),
    'step-3': fakeElement(),
    'step-3-title': fakeElement(),
    'step-3-description': fakeElement(),
    'whatsapp-availability-note': fakeElement(['hidden']),
    'link-state-input': fakeElement(),
    'link-state-code': fakeElement(['hidden']),
    'link-phone-input': fakeElement(),
    'link-gen-btn': fakeElement(),
    'service-status-title': fakeElement(),
    'service-status-copy': fakeElement(),
    'onboarding-progress': fakeElement(),
    'progress-label': fakeElement(),
    'banner-title': fakeElement(),
    'banner-subtitle': fakeElement(),
  };
  const context = {
    document: { getElementById: (id) => elements[id] || null },
    kesefleGetUser: () => ({ sub: 'user-1' }),
    kesefleMarkStepDone: () => {},
    kesefleCelebrate: () => { celebrations += 1; },
    _kflStopPolling: () => {},
    kflLinkRequestGeneration: 0,
    kflLinkCode: null,
    kflLinkPhone: null,
    kflLinkTtlTimer: null,
    clearInterval: () => {},
    localStorage: {
      getItem: (key) => key === 'kesefle_sheet' ? JSON.stringify(sheet) : null,
    },
  };
  vm.createContext(context);
  vm.runInContext(account.slice(start, end), context);
  return {
    context,
    elements,
    setSheet(value) { sheet = value; },
    celebrations: () => celebrations,
  };
}

const first = createRuntime(null);
const context = first.context;
const elements = first.elements;

assert.strictEqual(context.kesefleShowExistingSheetStep(null), false);
assert.strictEqual(context.kesefleShowExistingSheetStep({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' }), true);
assert.ok(elements['sheet-provision-controls'].classList.contains('hidden'));
assert.ok(!elements['sheet-ready-summary'].classList.contains('hidden'));
assert.strictEqual(elements['sheet-ready-link'].href, 'https://docs.google.com/sheet/abc');
assert.strictEqual(elements['step-2-title'].textContent, 'הגיליון שלך מוכן');
assert.ok(elements['step-3'].classList.contains('is-current'));
assert.match(elements['banner-title'].textContent, /אפשר להתחיל עכשיו/);
assert.match(elements['banner-subtitle'].textContent, /WhatsApp אפשר לחבר גם בהמשך/);

context.kflWabaApproved = false;
assert.strictEqual(context.kesefleShowExistingSheetStep({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' }), true);
assert.ok(!elements['step-3'].classList.contains('is-current'), 'pending WhatsApp rollout must not look like the required next step');

// Config-before-sheet: unavailable WhatsApp is removed from required progress,
// its controls are disabled, and provisioning later completes activation at 2/2.
const before = createRuntime(null);
before.context.kesefleApplyWhatsAppAvailability(false);
assert.ok(before.elements['link-state-input'].classList.contains('hidden'));
assert.strictEqual(before.elements['link-phone-input'].disabled, true);
assert.strictEqual(before.elements['link-gen-btn'].disabled, true);
assert.strictEqual(before.elements['link-gen-btn']['aria-disabled'], 'true');
assert.match(before.elements['progress-label'].innerHTML, /1<\/span> מתוך <span class="num">2/);
assert.strictEqual(before.celebrations(), 0);
before.setSheet({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' });
before.context.kesefleShowExistingSheetStep({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' });
before.context.kesefleUpdateOnboardingProgress();
assert.strictEqual(before.elements['progress-label'].innerHTML, 'הושלם ✓');
assert.strictEqual(before.elements['onboarding-progress'].style.width, '100%');
assert.strictEqual(before.celebrations(), 1);

// Config-after-sheet: a hydrated account must immediately move from the
// provisional 3-step view to honest, completed 2-step activation.
const after = createRuntime({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' });
after.context.kesefleShowExistingSheetStep({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' });
assert.ok(after.elements['step-3'].classList.contains('is-current'));
after.context.kesefleApplyWhatsAppAvailability(false);
assert.ok(!after.elements['step-3'].classList.contains('is-current'));
assert.strictEqual(after.elements['step-3-title'].textContent, 'WhatsApp — אופציונלי');
assert.strictEqual(after.elements['progress-label'].innerHTML, 'הושלם ✓');
assert.strictEqual(after.celebrations(), 1);

async function testDeferredLinkResponseFailsClosed() {
  const runtime = createRuntime({ spreadsheetUrl: 'https://docs.google.com/sheet/abc' });
  const input = runtime.elements['link-phone-input'];
  input.value = '054-123-4567';
  let resolveFetch;
  let displayed = 0;
  let polling = 0;
  runtime.context.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  runtime.context._kflNormalizeIsraelPhone = () => '972541234567';
  runtime.context._kflShowLinkError = () => {};
  runtime.context._kflDisplayCode = () => { displayed += 1; };
  runtime.context._kflStartPolling = () => { polling += 1; };
  runtime.context._kflShowLinkSuccess = () => {};

  const requestStart = account.indexOf('function _kflSetLinkState');
  const requestEnd = account.indexOf('\nfunction _kflDisplayCode', requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart, 'link request state machine is extractable');
  vm.runInContext(account.slice(requestStart, requestEnd), runtime.context);

  const pending = runtime.context.kesefleLinkRequestCode();
  assert.strictEqual(typeof resolveFetch, 'function', 'link request is in flight before config resolves');
  runtime.context.kesefleApplyWhatsAppAvailability(false);
  resolveFetch({ json: async () => ({ ok: true, code: '123456', expiresIn: 600 }) });
  await pending;

  assert.strictEqual(displayed, 0, 'late link response cannot display a code');
  assert.strictEqual(polling, 0, 'late link response cannot start polling');
  assert.ok(runtime.elements['link-state-input'].classList.contains('hidden'));
  assert.ok(runtime.elements['link-state-code'].classList.contains('hidden'));
}

testDeferredLinkResponseFailsClosed()
  .then(() => console.log('Account activation fallback assertions passed.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
