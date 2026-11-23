#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function extractFn(src, name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

const signInContext = {
  esc: (value) => String(value),
  lineIcon: (name) => '<svg data-icon="' + name + '"></svg>',
};
vm.createContext(signInContext);
vm.runInContext(extractFn(app, 'signInState'), signInContext);
const html = signInContext.signInState();

assert.match(html, /data-guest-screen="true"/);
assert.strictEqual((html.match(/<h1\b/g) || []).length, 1, 'guest screen must expose one primary heading');
assert.match(html, /לדעת מה קורה עם הכסף — בלי לנחש/);
assert.match(html, /אישי ושכיר·ה/);
assert.match(html, /זוגי ומשפחתי/);
assert.match(html, /עצמאי·ת ועסק/);
assert.match(html, /\/account\?force_signin=1&amp;next=%2Fapp/);
assert.match(html, /<bdi dir="ltr">Google<\/bdi>/, 'mixed Hebrew/English CTA keeps the Google label intact');
assert.match(html, /\/privacy/);
assert.strictEqual((html.match(/<a\b/g) || []).length, 2, 'guest screen has one sign-in action plus privacy');
assert.match(html, /הגיליון נשאר ב־Google Drive שלך/);
assert.match(html, /לא מוכרים מידע פיננסי למפרסמים/);
assert.doesNotMatch(html, /₪\s*\d|money\s*\(|APP\.me|APP\.expenses/, 'guest preview must not invent or read personal money data');
assert.doesNotMatch(html, /\/expense|#\/tx|#\/insights|\/dashboard#\/budgets/, 'guest screen exposes no account-only action');
assert.doesNotMatch(html, /צריך להתחבר/, 'guest screen leads with value instead of a lock dead-end');

const signInSource = extractFn(app, 'signInState');
assert.match(signInSource, /guest-step-num">1[\s\S]*guest-step-num">2[\s\S]*guest-step-num">3/, 'first-run flow has three scannable steps');

const chromeSelectors = ['.bottom-nav', '#expenseFab', '#refreshBtn', '#syncTime', '.global-search', '#spaceSwitcher', '.promo-strip a'];
const chromeNodes = Object.fromEntries(chromeSelectors.map((selector) => [selector, [{ hidden: false }]]));
const who = { textContent: 'אישי' };
let bodyGuest = false;
let repaintCount = 0;
const guestModeContext = {
  document: {
    body: { classList: { toggle: (_name, on) => { bodyGuest = on; } } },
    querySelectorAll: (selector) => chromeNodes[selector] || [],
  },
  $: (selector) => selector === '#whoami' ? who : null,
  paintSpaceSwitcher: () => { repaintCount++; who.textContent = 'אישי'; },
};
vm.createContext(guestModeContext);
vm.runInContext(extractFn(app, 'setGuestMode'), guestModeContext);
guestModeContext.setGuestMode(true);
assert(bodyGuest, 'guest body mode is enabled');
assert(chromeSelectors.every((selector) => chromeNodes[selector][0].hidden), 'all account-only chrome is hidden from accessibility and keyboard order');
assert.strictEqual(who.textContent, 'סיור באפליקציה');
guestModeContext.setGuestMode(false);
assert(!bodyGuest, 'guest body mode is removed after authentication');
assert(chromeSelectors.every((selector) => !chromeNodes[selector][0].hidden), 'authenticated chrome is fully restored');
assert.strictEqual(repaintCount, 1, 'authenticated identity/space label is repainted');

assert.match(app, /if\(!view\.querySelector\('\[data-guest-screen\]'\)\) setGuestMode\(false\)/, 'successful authenticated render restores full navigation');
for (const selector of ['.bottom-nav', '#expenseFab', '#refreshBtn', '#syncTime', '.global-search', '#spaceSwitcher', '.promo-strip a']) {
  assert.match(app, new RegExp(`body\\.guest-mode [^{}]*${selector.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}[^{}]*\\{ display:none!important; \\}`), `${selector} is visually hidden in guest mode`);
}
assert.match(app, /\.guest-layout[\s\S]*grid-template-columns/, 'guest experience becomes a two-column layout on larger screens');
assert.match(app, /@media \(prefers-reduced-motion: reduce\)/, 'existing reduced-motion support remains present');

async function assertAuthRouteIsGuestOnly(name, globals = {}) {
  const view = { innerHTML: '' };
  const routeContext = {
    apiGet: async () => { throw { isAuth: true }; },
    apiPost: async () => { throw { isAuth: true }; },
    errState: () => html,
    esc: (value) => String(value),
    loadingHero: () => '<div data-loading></div>',
    activeSpace: () => 'personal',
    SPACE_LABELS: { personal: 'אישי' },
    thisMonthLabel: () => 'נובמבר 2026',
    $: () => ({ innerHTML: '' }),
    ...globals,
  };
  vm.createContext(routeContext);
  vm.runInContext(extractFn(app, name), routeContext);
  await routeContext[name](view);
  assert.strictEqual(view.innerHTML, html, `${name} replaces the entire route on an auth failure`);
  assert.strictEqual((view.innerHTML.match(/<h1\b/g) || []).length, 1, `${name} leaves exactly one H1 for guests`);
  assert.doesNotMatch(view.innerHTML, /id="txSearch"|כל התנועות|תובנות שעוזרות להחליט|החשבון שלי/, `${name} leaves no authenticated route chrome`);
}

(async () => {
  await assertAuthRouteIsGuestOnly('renderHome');
  await assertAuthRouteIsGuestOnly('renderTx');
  await assertAuthRouteIsGuestOnly('renderInsights');
  assert.match(app, /async function renderAccount\(view\)[\s\S]*?catch\(e\)\{ view\.innerHTML=errState\(e\); return; \}/, 'account auth failure replaces its whole route');

  const bootstrapCalls = [];
  const bootstrapContext = {
    APP: { prefs: {}, me: { user: { name: 'stale' } }, group: { name: 'stale' } },
    localStorage: { getItem: () => '{}' },
    apiGet: async (path) => { bootstrapCalls.push(path); throw { isAuth: true }; },
    paintSpaceSwitcher: () => { throw new Error('guest bootstrap must not paint authenticated identity'); },
  };
  vm.createContext(bootstrapContext);
  vm.runInContext(extractFn(app, 'loadPersonalization'), bootstrapContext);
  const ready = await bootstrapContext.loadPersonalization();
  assert.strictEqual(ready, false, 'guest bootstrap exits before account personalization');
  assert.deepStrictEqual(bootstrapCalls, ['/api/me'], 'guest bootstrap makes one auth probe and no sheet/preferences/group calls');
  assert.strictEqual(bootstrapContext.APP.me, null, 'stale identity is cleared after auth rejection');
  assert.strictEqual(bootstrapContext.APP.group, null, 'stale group is cleared after auth rejection');

  const retryView = { innerHTML: '' };
  const retryGuestStates = [];
  let retryAttempts = 0;
  let retryRoutes = 0;
  const retryContext = {
    APP: { me: null, group: null },
    __bootstrapping: false,
    $: (selector) => selector === '#view' ? retryView : null,
    setGuestMode: (on) => retryGuestStates.push(on),
    loadingHero: () => 'LOADING',
    signInState: () => html,
    errState: (error) => error && error.isOffline ? 'OFFLINE' : 'ERROR',
    loadAppConfig: async () => {},
    loadPersonalization: async () => {
      retryAttempts++;
      if (retryAttempts === 1) throw { isOffline: true };
      retryContext.APP.me = { user: { sub: 'verified' } };
      return true;
    },
    route: async () => { retryRoutes++; },
  };
  vm.createContext(retryContext);
  vm.runInContext(extractFn(app, 'bootstrapApp'), retryContext);
  assert.strictEqual(await retryContext.bootstrapApp(), false, 'offline bootstrap reports not ready');
  assert.strictEqual(retryView.innerHTML, 'OFFLINE', 'offline bootstrap keeps the truthful offline card');
  assert.strictEqual(retryContext.APP.me, null, 'offline bootstrap clears unverified account state');
  assert.strictEqual(await retryContext.bootstrapApp(), true, 'retry re-runs the authenticated bootstrap after connectivity returns');
  assert.strictEqual(retryAttempts, 2, 'retry performs a fresh /api/me personalization probe');
  assert.strictEqual(retryRoutes, 1, 'successful retry renders the authenticated route exactly once');
  assert.deepStrictEqual(retryGuestStates, [true, true, false], 'retry remains private until server authentication succeeds');
  assert.match(app, /onclick="bootstrapApp\(\)"/, 'offline retry button invokes the full authentication bootstrap');

  const routeSource = extractFn(app, 'route');
  assert(routeSource.indexOf('if(!APP.me)') < routeSource.indexOf('sec.render(view)'), 'route blocks protected renderers until server auth succeeds');
  assert.doesNotMatch(app, /kesefle_user[^\n]*whoami/, 'boot never treats localStorage identity as proof');
  assert.match(app, /setGuestMode\(true\);\s*\$\('#view'\)\.innerHTML=signInState\(\);\s*buildTabs\(\)/, 'boot paints the private guest shell before building account chrome');
  assert.match(sw, /v24-2026-11-23-app-identity/, 'service worker cache version covers the guest shell, cookie-session foundation and canonical app identity');
  console.log('Guest app first-run preview: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
