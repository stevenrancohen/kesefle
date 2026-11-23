#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const app = read('app.html');
const welcome = read('welcome.html');
const expense = read('expense.html');
const account = read('account.html');

function scriptContaining(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'script marker exists: ' + marker);
  const start = source.lastIndexOf('<script>', at);
  const end = source.indexOf('</script>', at);
  assert.ok(start >= 0 && end > at, 'script is extractable: ' + marker);
  return source.slice(start + '<script>'.length, end);
}

function fakeElement(initialClasses = []) {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  return {
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
    value: '',
    focus() { this.focused = true; },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
  };
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function createWelcomeRuntime(configHandler, meHandler, linkStatusHandler) {
  const elements = {
    'kfl-web-first': fakeElement(),
    'kfl-web-first-title': fakeElement(),
    'kfl-whatsapp-link-flow': fakeElement(['hidden']),
    'kfl-link-phase-A': fakeElement(['hidden']),
    'kfl-link-phase-B': fakeElement(['hidden']),
    'kfl-link-phase-C': fakeElement(['hidden']),
    'kfl-link-go': fakeElement(),
    'kfl-link-phone': fakeElement(),
    'kfl-link-err': fakeElement(),
    'kfl-link-code': fakeElement(),
    'kfl-link-wa-btn': fakeElement(),
    'kfl-link-countdown': fakeElement(),
    'kfl-link-first-expense': fakeElement(),
    'kfl-bot-number-label': fakeElement(),
    'welcome-ready-badge': fakeElement(),
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
  elements['kfl-link-go'].disabled = true;

  const whatsappOnly = [fakeElement(['hidden']), fakeElement(['hidden'])];
  const calls = [];
  const intervals = new Map();
  const cleared = [];
  let nextTimer = 1;
  let fetchHandler = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/config') return configHandler();
    if (url === '/api/me') return meHandler ? meHandler() : response({ ok: false }, false);
    if (url === '/api/whatsapp/link?check=1') return linkStatusHandler ? linkStatusHandler() : response({ ok: true, linked: false });
    return response({ ok: false, error: 'unexpected_request' }, false);
  };
  const storage = new Map();
  const context = {
    window: {},
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] || null,
      querySelectorAll: (selector) => selector === '[data-whatsapp-only]' ? whatsappOnly : [],
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    location: { href: '' },
    encodeURIComponent,
    fetch: (...args) => fetchHandler(...args),
    setInterval: (fn, delay) => {
      const id = nextTimer++;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval: (id) => { cleared.push(id); intervals.delete(id); },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(scriptContaining(welcome, 'var WHATSAPP_AVAILABLE = false;'), context);
  return {
    context,
    elements,
    calls,
    intervals,
    cleared,
    storage,
    whatsappOnly,
    setFetch(handler) { fetchHandler = async (url, options = {}) => { calls.push({ url, options }); return handler(url, options); }; },
  };
}

async function flush(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function assertUnavailable(configHandler, label) {
  const runtime = createWelcomeRuntime(configHandler);
  await flush();
  assert.ok(!runtime.elements['kfl-web-first'].classList.contains('hidden'), label + ': web fallback visible');
  assert.ok(runtime.elements['kfl-whatsapp-link-flow'].classList.contains('hidden'), label + ': WhatsApp flow hidden');
  assert.ok(runtime.elements['kfl-link-phase-A'].classList.contains('hidden'), label + ': phone phase hidden');
  assert.strictEqual(runtime.elements['kfl-link-go'].disabled, true, label + ': generate button disabled');
  assert.strictEqual(runtime.intervals.size, 0, label + ': no polling/countdown');
  const before = runtime.calls.length;
  await runtime.context.kflLinkGetCode();
  assert.strictEqual(runtime.calls.length, before, label + ': direct invocation performs zero requests');
}

async function main() {
  // Initial HTML is app-first: active WhatsApp surfaces are absent from focus
  // order until JavaScript verifies the runtime capability.
  assert.match(welcome, /id="kfl-web-first" class="mt-10/);
  assert.match(welcome, /id="kfl-whatsapp-link-flow" class="mt-10 hidden/);
  assert.match(welcome, /id="kfl-link-phase-A" class="hidden"/);
  assert.match(welcome, /id="setup-pct">0<\/span>/, 'public welcome does not claim setup is complete');
  assert.match(welcome, /fetch\('\/api\/me',[\s\S]*applyWelcomeAccountState/,
    'welcome verifies the signed-in sheet before offering direct capture');
  assert.match(welcome, /data-whatsapp-only[^>]*class="[^"]*hidden|class="[^"]*hidden" data-whatsapp-only/);
  assert.doesNotMatch(welcome.slice(0, welcome.indexOf('var WHATSAPP_AVAILABLE = false;')), /href="https:\/\/wa\.me\//,
    'welcome first paint contains no active wa.me destination');
  assert.match(expense, /id="kfl-whatsapp-option" class="[^"]*hidden/);
  assert.match(expense, /c\.ok === true && c\.waba_approved === true && \/\^\[1-9\]\\d\{6,14\}\$\//);
  assert.match(app, /var WHATSAPP_AVAILABLE=false;\s*var WA_LINK='';/);
  assert.match(app, /c&&c\.ok===true&&c\.waba_approved===true&&\/\^\[1-9\]\\d\{6,14\}\$\//);
  assert.match(account, /var kflWabaApproved = false;/);
  assert.match(account, /id="link-state-input" class="hidden"/);
  assert.match(account, /id="link-first-expense-wa"[^>]*class="hidden/);
  assert.match(account, /id="link-first-expense-web" href="\/expense\?from=linked-whatsapp-unavailable"/);
  assert.match(account, /onclick="return kesefleLogFirstExpense\(event\)"/);
  assert.match(account, /if \(ev && ev\.preventDefault\) ev\.preventDefault\(\);[\s\S]*return false;/);
  assert.match(account, /window\.location\.href = '\/app';/,
    'linked returning users land on the capability-aware app');
  assert.doesNotMatch(welcome, /href="\/dashboard"/,
    'welcome cannot bypass capability gating through the legacy dashboard');

  const guest = createWelcomeRuntime(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }));
  await flush();
  assert.strictEqual(guest.context.__kflWhatsAppAvailable, true, 'channel capability can be active for a guest');
  assert.strictEqual(guest.context.__kflWelcomeSheetReady, false, 'guest has no verified sheet');
  assert.ok(!guest.elements['kfl-web-first'].classList.contains('hidden'));
  assert.ok(guest.elements['kfl-whatsapp-link-flow'].classList.contains('hidden'));
  assert.strictEqual(guest.elements['kfl-web-primary'].href, '/app');
  assert.strictEqual(guest.elements['setup-pct'].textContent, '0');
  const guestCalls = guest.calls.length;
  await guest.context.kflLinkGetCode();
  assert.strictEqual(guest.calls.length, guestCalls, 'guest cannot POST a link request even when channel capability is on');

  const available = createWelcomeRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
    async () => response({ ok: true, user: { sub: 'user-1' }, sheet: { spreadsheetUrl: 'https://docs.google.com/sheet/1' } }),
  );
  await flush();
  assert.strictEqual(available.context.__kflWhatsAppAvailable, true);
  assert.ok(available.elements['kfl-web-first'].classList.contains('hidden'));
  assert.ok(!available.elements['kfl-whatsapp-link-flow'].classList.contains('hidden'));
  assert.ok(!available.elements['kfl-link-phase-A'].classList.contains('hidden'));
  assert.strictEqual(available.elements['kfl-link-go'].disabled, false);
  assert.strictEqual(available.elements['kfl-bot-number-label'].textContent, '+972547760643');
  assert.ok(available.whatsappOnly.every((el) => !el.classList.contains('hidden')));
  assert.strictEqual(available.elements['setup-pct'].textContent, '67');

  await assertUnavailable(async () => response({ ok: true, waba_approved: false, BOT_NUMBER: '972547760643' }), 'flag false');
  await assertUnavailable(async () => response({ ok: true, BOT_NUMBER: '972547760643' }), 'flag missing');
  await assertUnavailable(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '0000000' }), 'invalid E.164');
  await assertUnavailable(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }, false), 'non-2xx');
  await assertUnavailable(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }), 'malformed JSON');
  await assertUnavailable(async () => { throw new Error('offline'); }, 'network rejection');

  // A late successful POST may not resurrect code/timers after capability false.
  const readyMe = async () => response({ ok: true, user: { sub: 'user-1' }, sheet: { spreadsheetUrl: 'https://docs.google.com/sheet/1' } });
  const late = createWelcomeRuntime(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }), readyMe);
  await flush();
  late.elements['kfl-link-phone'].value = '0541234567';
  let resolvePost;
  late.setFetch((url, options) => {
    if (url === '/api/whatsapp/link' && options.method === 'POST') return new Promise((resolve) => { resolvePost = resolve; });
    if (url === '/api/whatsapp/link?check=1') return response({ ok: true, linked: false });
    throw new Error('unexpected ' + url);
  });
  const pending = late.context.kflLinkGetCode();
  assert.strictEqual(typeof resolvePost, 'function');
  late.context.__kflSetWhatsAppAvailability(false, '');
  resolvePost(response({ ok: true, code: '123456', expiresIn: 600 }));
  await pending;
  assert.ok(late.elements['kfl-link-phase-B'].classList.contains('hidden'));
  assert.strictEqual(late.intervals.size, 0);

  // A stale config edge can still reach the backend; its truthful 503 flips the
  // whole page back to the free web path instead of exposing a raw error.
  const backendOff = createWelcomeRuntime(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }), readyMe);
  await flush();
  backendOff.elements['kfl-link-phone'].value = '0541234567';
  backendOff.setFetch((url, options) => {
    if (url === '/api/whatsapp/link' && options.method === 'POST') return response({ ok: false, error: 'whatsapp_linking_unavailable' }, false);
    if (url === '/api/whatsapp/link?check=1') return response({ ok: true, linked: false });
    throw new Error('unexpected ' + url);
  });
  await backendOff.context.kflLinkGetCode();
  assert.strictEqual(backendOff.context.__kflWhatsAppAvailable, false);
  assert.ok(!backendOff.elements['kfl-web-first'].classList.contains('hidden'));
  assert.strictEqual(backendOff.elements['kfl-web-first-title'].focused, true);

  // Once code timers exist, true -> false must clear both handles.
  const timers = createWelcomeRuntime(async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }), readyMe);
  await flush();
  timers.elements['kfl-link-phone'].value = '0541234567';
  timers.setFetch((url, options) => {
    if (url === '/api/whatsapp/link' && options.method === 'POST') return response({ ok: true, code: '654321', expiresIn: 600 });
    if (url === '/api/whatsapp/link?check=1') return response({ ok: true, linked: false });
    throw new Error('unexpected ' + url);
  });
  await timers.context.kflLinkGetCode();
  assert.strictEqual(timers.intervals.size, 2, 'countdown and status poll are active after code mint');
  timers.context.__kflSetWhatsAppAvailability(false, '');
  assert.strictEqual(timers.intervals.size, 0, 'capability false clears all active timers');
  assert.ok(timers.cleared.length >= 2);

  // A linked hint survives ambiguous status failures; only an authoritative
  // `{ok:true, linked:false}` may clear it and return to phase A.
  const status500 = createWelcomeRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
    readyMe,
    async () => response({ error: 'temporary' }, false),
  );
  status500.storage.set('kesefle_whatsapp_linked', '1');
  await flush();
  assert.ok(!status500.elements['kfl-link-phase-C'].classList.contains('hidden'), '500 preserves linked status');
  assert.strictEqual(status500.storage.get('kesefle_whatsapp_linked'), '1');

  const malformedStatus = createWelcomeRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
    readyMe,
    async () => ({ ok: true, json: async () => { throw new Error('bad status json'); } }),
  );
  malformedStatus.storage.set('kesefle_whatsapp_linked', '1');
  await flush();
  assert.ok(!malformedStatus.elements['kfl-link-phase-C'].classList.contains('hidden'), 'malformed status preserves linked status');

  const confirmedUnlinked = createWelcomeRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
    readyMe,
    async () => response({ ok: true, linked: false }),
  );
  confirmedUnlinked.storage.set('kesefle_whatsapp_linked', '1');
  await flush();
  assert.ok(!confirmedUnlinked.elements['kfl-link-phase-A'].classList.contains('hidden'), 'authoritative false returns to phase A');
  assert.strictEqual(confirmedUnlinked.storage.has('kesefle_whatsapp_linked'), false);

  console.log('WhatsApp capability UI runtime assertions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
