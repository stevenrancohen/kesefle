#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'install-pwa.js'), 'utf8');
const failures = [];
function assert(condition, label) {
  if (condition) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}

function boot(options = {}) {
  const windowListeners = {};
  const buttonListeners = {};
  const displayListeners = {};
  const status = { textContent: '' };
  const button = {
    hidden: true,
    disabled: false,
    addEventListener(type, fn) { buttonListeners[type] = fn; },
  };
  const shell = {
    dataset: {
      installedLabel: 'installed',
      readyLabel: 'ready',
      iosLabel: 'ios',
      manualLabel: 'manual',
      acceptedLabel: 'accepted',
      declinedLabel: 'declined',
    },
    querySelector(selector) {
      if (selector === '[data-install-button]') return button;
      if (selector === '[data-install-status]') return status;
      return null;
    },
  };
  const displayMode = {
    matches: Boolean(options.standalone),
    addEventListener(type, fn) { displayListeners[type] = fn; },
  };
  const context = {
    document: {
      readyState: 'complete',
      querySelector(selector) { return selector === '[data-install-shell]' ? shell : null; },
      addEventListener() {},
    },
    navigator: { userAgent: options.ios ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (Linux; Android)' },
    window: {
      navigator: {
        userAgent: options.ios ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (Linux; Android)',
        standalone: Boolean(options.iosStandalone),
      },
      matchMedia() { return displayMode; },
      addEventListener(type, fn) { windowListeners[type] = fn; },
      MSStream: undefined,
    },
    Boolean,
  };
  vm.runInNewContext(source, context, { filename: 'install-pwa.js' });
  return { windowListeners, buttonListeners, displayListeners, button, status, displayMode };
}

(async function run() {
  console.log('\ntests/test_install_prompt_runtime.js\n');

  const android = boot();
  assert(android.button.hidden && android.status.textContent === 'manual',
    'Android starts with honest manual-install fallback');

  let prevented = false;
  let prompted = false;
  const acceptedPrompt = {
    preventDefault() { prevented = true; },
    async prompt() { prompted = true; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  };
  android.windowListeners.beforeinstallprompt(acceptedPrompt);
  assert(prevented && !android.button.hidden && android.status.textContent === 'ready',
    'beforeinstallprompt exposes the native install action');
  await android.buttonListeners.click();
  assert(prompted && android.button.hidden && android.status.textContent === 'accepted',
    'accepted prompt is invoked once and reports success');

  const declined = boot();
  declined.windowListeners.beforeinstallprompt({
    preventDefault() {},
    async prompt() {},
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });
  await declined.buttonListeners.click();
  assert(declined.button.hidden && declined.status.textContent === 'declined',
    'dismissed prompt falls back without a false success state');

  const ios = boot({ ios: true });
  assert(ios.button.hidden && ios.status.textContent === 'ios',
    'iPhone receives Safari-specific Add to Home Screen guidance');

  const installed = boot({ standalone: true });
  assert(installed.button.hidden && installed.status.textContent === 'installed',
    'standalone display mode is recognized as already installed');

  const installedByIos = boot({ ios: true, iosStandalone: true });
  assert(installedByIos.button.hidden && installedByIos.status.textContent === 'installed',
    'legacy iOS standalone mode is recognized as already installed');

  const fromEvent = boot();
  fromEvent.windowListeners.appinstalled();
  assert(fromEvent.button.hidden && fromEvent.status.textContent === 'installed',
    'appinstalled clears the prompt and reports the installed state');

  if (failures.length) {
    console.error('\nFAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('\nOK: all assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
