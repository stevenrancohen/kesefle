#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const welcome = fs.readFileSync(path.join(ROOT, 'welcome.html'), 'utf8');

function scriptContaining(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'script marker exists: ' + marker);
  const start = source.lastIndexOf('<script>', at);
  const end = source.indexOf('</script>', at);
  assert.ok(start >= 0 && end > at, 'script is extractable: ' + marker);
  return source.slice(start + '<script>'.length, end);
}

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'function exists: ' + name);
  let body = source.indexOf('{', start);
  let depth = 0;
  let end = body;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, end + 1);
    }
  }
  throw new Error('unterminated function: ' + name);
}

function fakeElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  let innerHtmlWrites = 0;
  const element = {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        if (force === true) classes.add(name);
        else if (force === false) classes.delete(name);
        else if (classes.has(name)) classes.delete(name);
        else classes.add(name);
      },
    },
    disabled: false,
    href: '#',
    style: {},
    textContent: '',
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    get innerHtmlWrites() { return innerHtmlWrites; },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { innerHtmlWrites += 1; },
  });
  return element;
}

function response(body, { ok = true, status = ok ? 200 : 503 } = {}) {
  return { ok, status, json: async () => body };
}

function runtime(meHandler, { timeoutMs = 20 } = {}) {
  const elements = {
    'kfl-web-first': fakeElement(),
    'kfl-web-first-title': fakeElement(),
    'kfl-whatsapp-link-flow': fakeElement(['hidden']),
    'kfl-link-phase-A': fakeElement(['hidden']),
    'kfl-link-phase-B': fakeElement(['hidden']),
    'kfl-link-phase-C': fakeElement(['hidden']),
    'kfl-link-go': fakeElement(),
    'kfl-link-first-expense': fakeElement(),
    'kfl-bot-number-label': fakeElement(),
    'welcome-ready-badge': fakeElement(),
    'welcome-heading-prefix': fakeElement(),
    'welcome-heading-value': fakeElement(),
    'welcome-heading-suffix': fakeElement(),
    'welcome-celebrate-button': fakeElement(['hidden']),
    'referral-banner': fakeElement(['hidden']),
    'setup-pct': fakeElement(),
    'setup-progress': fakeElement(),
    'setup-status-label': fakeElement(),
    'setup-status-suffix': fakeElement(),
    'checkpoint-account-icon': fakeElement(),
    'checkpoint-sheet-icon': fakeElement(),
    'kfl-capability-copy': fakeElement(),
    'kfl-web-primary': fakeElement(),
    'kfl-web-secondary': fakeElement(),
  };
  elements['kfl-link-first-expense'].setAttribute('data-wa-text', '245 סופר');
  let identityClears = 0;
  const context = {
    window: {},
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    KesefleSession: { clearAllIdentityStorage() { identityClears += 1; } },
    __kflWelcomeAuthTimeoutMs: timeoutMs,
    fetch: async (url) => {
      if (url === '/api/config') return response({ ok: true, waba_approved: false, BOT_NUMBER: '' });
      if (url === '/api/me') return meHandler();
      throw new Error('unexpected request: ' + url);
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(scriptContaining(welcome, 'var WHATSAPP_AVAILABLE = false;'), context);
  return { context, elements, identityClears: () => identityClears };
}

async function settle(instance) {
  if (instance.context.__kflWelcomeSessionPromise) await instance.context.__kflWelcomeSessionPromise;
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function main() {
  const beforeRuntimeGate = welcome.slice(0, welcome.indexOf('var WHATSAPP_AVAILABLE = false;'));
  assert.doesNotMatch(beforeRuntimeGate, /localStorage\.getItem\(['"]kesefle_user['"]\)/,
    'first paint never trusts the cached profile to reveal identity UI');
  assert.match(welcome, /id="referral-banner" class="hidden /,
    'referral starts hidden');
  assert.match(welcome, /id="welcome-celebrate-button"[^>]*class="hidden /,
    'celebration starts hidden');
  assert.doesNotMatch(welcome, /Auto-burst confetti|kfl_welcome_seen/,
    'welcome never celebrates before server authority');
  assert.doesNotMatch(welcome, /h1\.innerHTML|personalizeWelcome/,
    'server-verified names are not injected with innerHTML');
  assert.match(welcome, /r\.status === 401 \|\| r\.status === 403[\s\S]*clearAllIdentityStorage/,
    'authoritative signed-out responses scrub shared-device identity metadata');
  assert.match(welcome, /kfl_first_msg_clicked:' \+ sub/,
    'first-message progress is scoped to the verified user');
  assert.doesNotMatch(welcome, /getItem\(['"]kesefle_whatsapp_linked['"]\)[\s\S]{0,80}show\(['"]C['"]\)/,
    'a device-wide WhatsApp hint can never render linked success');
  assert.match(welcome, /__kflWhatsAppAvailable !== true \|\| window\.__kflWelcomeSheetReady !== true/,
    'first-message progress requires both channel and verified sheet authority');
  assert.match(welcome, /__kflRestoreWelcomeMilestone[\s\S]*hasFirstMessageMilestone\(\)[\s\S]*maybeShowPwaInstall\(\)/,
    'a verified restored milestone retries a prompt that arrived before session authority');
  assert.match(welcome, /welcomeDeadline\([\s\S]*fetch\('\/api\/me'/,
    'session fetch is deadline bounded');
  assert.match(welcome, /welcomeDeadline\(r\.json\(\), Math\.min\(authTimeout, 800\)\)/,
    'session JSON parsing is deadline bounded');
  assert.match(welcome, /\/lib\/browser-session\.js\?v=welcome-session-v28/,
    'the welcome shell bypasses an old controller cache for the updated scrubber');

  // Simulate beforeinstallprompt arriving before /api/me. Once the verified
  // account and its scoped milestone are available, restore must retry prompt.
  const lowerScript = scriptContaining(welcome, 'function firstMessageMilestoneKey()');
  const restoreStart = lowerScript.indexOf('window.__kflRestoreWelcomeMilestone = function ()');
  const restoreEnd = lowerScript.indexOf('\n};', restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'restore function is extractable');
  let promptRetries = 0;
  const restoreElements = {
    'setup-progress': fakeElement(),
    'setup-pct': fakeElement(),
  };
  const restoreContext = {
    window: { __kflWelcomeUserSub: 'user-install', __kflWelcomeSheetReady: true },
    localStorage: { getItem: (key) => key === 'kfl_first_msg_clicked:user-install' ? '1' : null },
    document: { getElementById: (id) => restoreElements[id] || null },
    maybeShowPwaInstall() { promptRetries += 1; },
    setTimeout,
  };
  vm.createContext(restoreContext);
  vm.runInContext([
    functionSource(lowerScript, 'firstMessageMilestoneKey'),
    functionSource(lowerScript, 'hasFirstMessageMilestone'),
    functionSource(lowerScript, 'paintFirstMessageMilestone'),
    lowerScript.slice(restoreStart, restoreEnd + 3),
  ].join('\n'), restoreContext);
  restoreContext.window.__kflRestoreWelcomeMilestone();
  assert.strictEqual(promptRetries, 1, 'verified milestone retries an already-captured install opportunity');
  assert.strictEqual(restoreElements['setup-pct'].textContent, '100');

  const maliciousName = '<img/src=x/onerror=alert(1)>';
  const authenticated = runtime(async () => response({
    ok: true,
    user: { sub: 'user-1', given_name: maliciousName },
    sheet: { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/1' },
  }));
  await settle(authenticated);
  assert.strictEqual(authenticated.context.__kflWelcomeAuthorityState, 'authenticated');
  assert.strictEqual(authenticated.context.__kflWelcomeUserSub, 'user-1');
  assert.strictEqual(authenticated.elements['welcome-heading-value'].textContent, maliciousName,
    'verified name remains inert text, including markup-like characters');
  assert.strictEqual(authenticated.elements['welcome-heading-value'].innerHtmlWrites, 0);
  assert.ok(!authenticated.elements['referral-banner'].classList.contains('hidden'));
  assert.ok(!authenticated.elements['welcome-celebrate-button'].classList.contains('hidden'));
  assert.strictEqual(authenticated.identityClears(), 0);

  const noSheet = runtime(async () => response({ ok: true, user: { sub: 'user-2', name: 'נועה כהן' }, sheet: null }));
  await settle(noSheet);
  assert.strictEqual(noSheet.context.__kflWelcomeAuthorityState, 'authenticated');
  assert.ok(!noSheet.elements['referral-banner'].classList.contains('hidden'));
  assert.ok(noSheet.elements['welcome-celebrate-button'].classList.contains('hidden'),
    'celebration remains hidden until a sheet is verified');

  const signedOut = runtime(async () => response({ ok: false }, { ok: false, status: 401 }));
  await settle(signedOut);
  assert.strictEqual(signedOut.context.__kflWelcomeAuthorityState, 'signed_out');
  assert.strictEqual(signedOut.identityClears(), 1);
  assert.strictEqual(signedOut.elements['welcome-heading-value'].textContent, "כספ'לה");
  assert.ok(signedOut.elements['referral-banner'].classList.contains('hidden'));
  assert.ok(signedOut.elements['welcome-celebrate-button'].classList.contains('hidden'));

  const unavailable = runtime(async () => response({ error: 'temporary' }, { ok: false, status: 503 }));
  await settle(unavailable);
  assert.strictEqual(unavailable.context.__kflWelcomeAuthorityState, 'unknown');
  assert.strictEqual(unavailable.identityClears(), 0,
    'server outages do not destroy presentation metadata');
  assert.ok(unavailable.elements['referral-banner'].classList.contains('hidden'));
  assert.strictEqual(unavailable.elements['welcome-ready-badge'].textContent, 'ACCOUNT • CHECKING');

  const malformed = runtime(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
  await settle(malformed);
  assert.strictEqual(malformed.context.__kflWelcomeAuthorityState, 'unknown');
  assert.strictEqual(malformed.identityClears(), 0,
    'malformed success is unknown, not signed out');

  const offline = runtime(async () => { throw new Error('offline'); });
  await settle(offline);
  assert.strictEqual(offline.context.__kflWelcomeAuthorityState, 'unknown');
  assert.strictEqual(offline.identityClears(), 0);

  const hangingFetch = runtime(async () => new Promise(() => {}), { timeoutMs: 5 });
  await settle(hangingFetch);
  assert.strictEqual(hangingFetch.context.__kflWelcomeAuthorityState, 'unknown',
    'a hanging session request reaches the privacy-safe unknown state');

  const hangingJson = runtime(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), { timeoutMs: 5 });
  await settle(hangingJson);
  assert.strictEqual(hangingJson.context.__kflWelcomeAuthorityState, 'unknown',
    'a hanging JSON body reaches the privacy-safe unknown state');

  let resolveLate;
  const lateResponse = runtime(async () => new Promise((resolve) => { resolveLate = resolve; }), { timeoutMs: 5 });
  await settle(lateResponse);
  assert.strictEqual(lateResponse.context.__kflWelcomeAuthorityState, 'unknown');
  resolveLate(response({
    ok: true,
    user: { sub: 'too-late', name: 'אסור' },
    sheet: { spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/late' },
  }));
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.strictEqual(lateResponse.context.__kflWelcomeAuthorityState, 'unknown',
    'a response arriving after the deadline cannot reveal identity');
  assert.strictEqual(lateResponse.elements['welcome-heading-value'].textContent, "כספ'לה");

  console.log('Welcome session-authority assertions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
