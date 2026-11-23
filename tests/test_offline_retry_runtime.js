#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'offline.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const source = scripts.length ? scripts[scripts.length - 1][1] : '';
const failures = [];
function assert(condition, label) {
  if (condition) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}

function fakeClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
  };
}

function boot(fetchImpl) {
  const windowListeners = {};
  const buttonListeners = {};
  const replacements = [];
  const elements = {
    status: { textContent: '', classList: fakeClassList() },
    'retry-btn': {
      disabled: false,
      addEventListener(type, fn) { buttonListeners[type] = fn; },
    },
    'retry-icon': { classList: fakeClassList() },
  };
  const context = {
    document: { getElementById(id) { return elements[id]; } },
    window: {
      addEventListener(type, fn) { windowListeners[type] = fn; },
      location: { replace(url) { replacements.push(url); } },
    },
    fetch: fetchImpl,
    setTimeout(fn) { fn(); },
    Error,
  };
  vm.runInNewContext(source, context, { filename: 'offline-inline.js' });
  return { elements, buttonListeners, windowListeners, replacements };
}

function response({ ok = true, contentType = 'application/json', health = { ok: true } } = {}) {
  return {
    ok,
    headers: { get(name) { return name === 'content-type' ? contentType : null; } },
    async json() { return health; },
  };
}

(async function run() {
  console.log('\ntests/test_offline_retry_runtime.js\n');
  assert(source.includes("fetch('/api/health'"), 'offline runtime script was extracted');

  const healthy = boot(async () => response());
  assert(healthy.replacements.length === 0 && healthy.elements.status.textContent === 'לא מקוון',
    'initial load never redirects from navigator connectivity alone');
  await healthy.buttonListeners.click();
  assert(healthy.replacements.length === 1 && healthy.replacements[0] === '/app',
    'healthy Kesefle JSON returns the user to /app');

  const html200 = boot(async () => response({ contentType: 'text/html' }));
  await html200.buttonListeners.click();
  assert(html200.replacements.length === 0 && html200.elements['retry-btn'].disabled === false,
    'arbitrary HTTP 200 HTML cannot trigger a redirect loop');

  const unhealthy = boot(async () => response({ health: { ok: false } }));
  await unhealthy.buttonListeners.click();
  assert(unhealthy.replacements.length === 0 && unhealthy.elements['retry-btn'].disabled === false,
    'unhealthy JSON keeps the retry action available');

  const unavailable = boot(async () => { throw new Error('offline'); });
  await unavailable.buttonListeners.click();
  assert(unavailable.replacements.length === 0 && unavailable.elements.status.textContent === 'לא מקוון',
    'network failure stays on the honest offline screen');

  const onlineEvent = boot(async () => response());
  await onlineEvent.windowListeners.online();
  assert(onlineEvent.replacements[0] === '/app',
    'online transition uses the same verified health path');

  if (failures.length) {
    console.error('\nFAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('\nOK: all assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
