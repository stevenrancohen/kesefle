#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function scriptContaining(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'script marker exists: ' + marker);
  const start = source.lastIndexOf('<script>', at);
  const end = source.indexOf('</script>', at);
  assert.ok(start >= 0 && end > at, 'script is extractable: ' + marker);
  return source.slice(start + '<script>'.length, end);
}

const controller = scriptContaining(dashboard, 'Dashboard WhatsApp capability controller.');

function fakeElement(initialClasses = [], initialAttributes = {}) {
  const classes = new Set(initialClasses);
  const attrs = new Map(Object.entries(initialAttributes).map(([key, value]) => [key, String(value)]));
  return {
    href: '#',
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
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
  };
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function createRuntime(configHandler, linkHandler) {
  const actions = [
    fakeElement(['hidden', 'inline-flex'], { 'data-kfl-bot-message': '245 סופר', 'aria-disabled': 'true' }),
    fakeElement(['hidden', 'block'], { 'data-kfl-bot-message': 'יומי?', 'aria-disabled': 'true' }),
  ];
  const whatsappOnly = [fakeElement(['hidden'])];
  const appOnly = [fakeElement()];
  const linkNote = fakeElement(['hidden']);
  const calls = [];

  const context = {
    window: {},
    __kflDashboardSessionReady: Promise.resolve({ user: { sub: 'user-1' } }),
    document: {
      querySelectorAll(selector) {
        if (selector === '[data-wa-action]') return actions;
        if (selector === '[data-wa-only]') return whatsappOnly;
        if (selector === '[data-app-only]') return appOnly;
        return [];
      },
      getElementById(id) { return id === 'dashboard-whatsapp-link-note' ? linkNote : null; },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/config') return configHandler();
      if (url === '/api/whatsapp/link?check=1') return linkHandler ? linkHandler() : response({ ok: true, linked: false });
      throw new Error('unexpected request: ' + url);
    },
    encodeURIComponent,
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(controller, context);
  return { context, actions, whatsappOnly, appOnly, linkNote, calls };
}

async function flush(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function assertFailClosed(runtime, label) {
  for (const action of runtime.actions) {
    assert.strictEqual(action.href, '#', label + ': action has no destination');
    assert.ok(action.classList.contains('hidden'), label + ': action remains hidden');
    assert.strictEqual(action.getAttribute('aria-disabled'), 'true', label + ': action remains disabled');
  }
  assert.ok(runtime.whatsappOnly.every((el) => el.classList.contains('hidden')), label + ': WhatsApp-only content hidden');
  assert.ok(runtime.appOnly.every((el) => !el.classList.contains('hidden')), label + ': app-first copy remains visible');
  assert.strictEqual(runtime.context.__kflDashboardWhatsAppAvailable, false, label + ': global state is false');
}

async function main() {
  const botAnchors = dashboard.match(/<a\b[^>]*data-wa-action[^>]*>/g) || [];
  assert.strictEqual(botAnchors.length, 8, 'all eight dashboard bot actions are governed centrally');
  for (const anchor of botAnchors) {
    assert.match(anchor, /data-kfl-bot-message="[^"]+"/, 'bot action carries only a message template');
    assert.match(anchor, /href="#"/, 'bot action has no active first-paint destination');
    assert.match(anchor, /aria-disabled="true"/, 'bot action is disabled on first paint');
    assert.match(anchor, /class="[^"]*\bhidden\b/, 'bot action is hidden on first paint');
  }
  assert.doesNotMatch(dashboard, /wa\.me\/972547760643/, 'dashboard contains no hardcoded bot destination');
  assert.doesNotMatch(dashboard, /^\s*\.hidden\s*\{\s*display:\s*none\s*!important/m, 'critical fallback does not break responsive Tailwind hidden classes');
  assert.match(dashboard, /\[data-wa-action\]\[aria-disabled="true"\][\s\S]*?#dashboard-whatsapp-link-note\.hidden\s*\{\s*display:\s*none\s*!important/,
    'security-critical WhatsApp surfaces remain hidden even if the Tailwind CDN fails');
  assert.match(dashboard, /id="ref-share-whatsapp"/, 'generic WhatsApp referral share remains available');
  assert.match(dashboard, /'https:\/\/wa\.me\/\?text='/, 'referral share still uses the generic share endpoint');
  assert.match(dashboard, /href="\/expense\?from=dashboard-empty"/, 'empty state has an app-first expense CTA');
  assert.match(dashboard, /href="\/expense\?from=dashboard-quick"/, 'quick actions have an app-first expense CTA');
  assert.match(dashboard, /cta_url: '\/expense\?from=dashboard-checklist'/, 'checklist has an app-first expense CTA');
  assert.doesNotMatch(dashboard, /id: 'set_budget'/, 'checklist does not send users to the unfinished budget editor');
  assert.match(dashboard, /href="\/account\?force=1&amp;from=dashboard-whatsapp"/, 'authoritative unlinked state has a repair CTA');
  assert.match(dashboard, /href="\/expense\?from=dashboard-demo"/, 'demo ribbon returns to the real app flow');
  assert.match(dashboard, /אין תנועות עדיין\. הוסף תנועה ראשונה באפליקציה\./, 'empty recent list is channel truthful');
  assert.doesNotMatch(controller, /localStorage|sessionStorage/, 'browser storage is not trusted as link authority');
  assert.match(controller, /config\.ok === true && config\.waba_approved === true && PHONE_RE\.test\(botNumber\)/,
    'controller requires success, approval and a valid bot number');
  assert.match(controller, /linkStatus\.ok === true && linkStatus\.linked === true && PHONE_RE\.test\(linkedPhone\)/,
    'controller requires an authoritative verified user link');
  assert.match(controller, /linkStatus\.linked === false &&[\s\S]*?hasOwnProperty\.call\(linkStatus, 'phone'\)/,
    'controller only labels an account unlinked when the verified lookup returned a phone property');

  const unavailableCases = [
    ['flag false', async () => response({ ok: true, waba_approved: false, BOT_NUMBER: '972547760643' })],
    ['flag missing', async () => response({ ok: true, BOT_NUMBER: '972547760643' })],
    ['invalid bot number', async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '0000000' })],
    ['config non-2xx', async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }, false)],
    ['config malformed', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })],
    ['config offline', async () => { throw new Error('offline'); }],
  ];
  for (const [label, configHandler] of unavailableCases) {
    const runtime = createRuntime(configHandler);
    await flush();
    assertFailClosed(runtime, label);
    assert.strictEqual(runtime.calls.filter((call) => call.url.includes('/whatsapp/link')).length, 0,
      label + ': no link-status request without valid capability config');
    assert.ok(runtime.linkNote.classList.contains('hidden'), label + ': no speculative link-account prompt');
  }

  const ambiguousLinkCases = [
    ['link non-2xx', async () => response({ error: 'temporary' }, false)],
    ['link malformed', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })],
    ['link offline', async () => { throw new Error('offline'); }],
    ['unlinked without authoritative phone property', async () => response({ ok: true, linked: false })],
    ['linked without phone', async () => response({ ok: true, linked: true })],
    ['linked with invalid phone', async () => response({ ok: true, linked: true, phone: '0000000' })],
  ];
  for (const [label, linkHandler] of ambiguousLinkCases) {
    const runtime = createRuntime(
      async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
      linkHandler,
    );
    await flush();
    assertFailClosed(runtime, label);
    assert.ok(runtime.linkNote.classList.contains('hidden'), label + ': ambiguous failures do not claim the account is unlinked');
  }

  const unlinked = createRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '972547760643' }),
    async () => response({ ok: true, linked: false, phone: null }),
  );
  await flush();
  assertFailClosed(unlinked, 'authoritative unlinked');
  assert.ok(!unlinked.linkNote.classList.contains('hidden'), 'authoritative unlinked response reveals account-link repair CTA');

  const linked = createRuntime(
    async () => response({ ok: true, waba_approved: true, BOT_NUMBER: '+972-54-776-0643' }),
    async () => response({ ok: true, linked: true, phone: '+972-50-123-4567' }),
  );
  await flush();
  assert.strictEqual(linked.context.__kflDashboardWhatsAppAvailable, true, 'linked account enables optional WhatsApp actions');
  assert.strictEqual(linked.actions[0].href, 'https://wa.me/972547760643?text=' + encodeURIComponent('245 סופר'));
  assert.strictEqual(linked.actions[1].href, 'https://wa.me/972547760643?text=' + encodeURIComponent('יומי?'));
  assert.ok(linked.actions.every((action) => !action.classList.contains('hidden')), 'all governed bot actions are visible');
  assert.ok(linked.actions.every((action) => action.getAttribute('aria-disabled') === null), 'enabled actions leave disabled state');
  assert.ok(linked.whatsappOnly.every((el) => !el.classList.contains('hidden')), 'WhatsApp-only guidance is visible');
  assert.ok(linked.appOnly.every((el) => el.classList.contains('hidden')), 'availability placeholders are hidden');
  assert.ok(linked.linkNote.classList.contains('hidden'), 'linked accounts do not see repair CTA');
  assert.deepStrictEqual(linked.calls.map((call) => call.url), ['/api/config', '/api/whatsapp/link?check=1']);
  assert.strictEqual(linked.calls[0].options.credentials, 'same-origin');
  assert.strictEqual(linked.calls[0].options.cache, 'no-store');
  assert.strictEqual(linked.calls[1].options.credentials, 'include');
  assert.strictEqual(linked.calls[1].options.cache, 'no-store');
  assert.ok(linked.calls.every((call) => !call.options.method || call.options.method === 'GET'), 'controller performs no write or polling request');

  console.log('Dashboard WhatsApp capability assertions passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
