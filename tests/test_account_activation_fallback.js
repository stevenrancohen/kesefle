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
assert.match(account, /c\.waba_approved === false/);
assert.match(account, /id="service-status-title"/);
assert.match(account, /הוספה באפליקציה זמינה; WhatsApp בהשקה הדרגתית/);
assert.match(account, /אין צורך ליצור גיליון נוסף/);
assert.match(account, /מתוך <span class="num">3<\/span> הושלמו/);
assert.doesNotMatch(account, /window\.location\.href = '\/welcome'/,
  'sheet completion must not divert the user away from first-value activation');

const start = account.indexOf('function kesefleShowExistingSheetStep');
const end = account.indexOf('\nfunction kesefleUpdateOnboardingProgress', start);
assert.ok(start >= 0 && end > start, 'existing-sheet UI helper is extractable');

function fakeElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    href: '',
    textContent: '',
  };
}

const elements = {
  'sheet-provision-controls': fakeElement(),
  'sheet-ready-summary': fakeElement(['hidden']),
  'sheet-ready-link': fakeElement(),
  'step-2-title': fakeElement(),
  'step-3': fakeElement(),
  'banner-title': fakeElement(),
  'banner-subtitle': fakeElement(),
};
const context = {
  kflWabaApproved: null,
  document: { getElementById: (id) => elements[id] || null },
};
vm.createContext(context);
vm.runInContext(account.slice(start, end), context);

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

console.log('Account activation fallback assertions passed.');
