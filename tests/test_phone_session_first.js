#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const account = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');
let failed = 0;

function assert(condition, label) {
  if (condition) console.log('✅ ' + label);
  else { failed++; console.error('❌ ' + label); }
}

function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), parens = 0, i = p;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) { i++; break; }
  }
  let body = src.indexOf('{', i), depth = 0, end = body;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) { end++; break; }
  }
  return src.slice(start, end);
}

function buildFlow({ showError, displayCode, startPolling, schedule }) {
  const input = { value: '054-123-4567' };
  const button = { disabled: false, textContent: 'צור קוד חיבור' };
  const document = {
    getElementById(id) {
      if (id === 'link-phone-input') return input;
      if (id === 'link-gen-btn') return button;
      return null;
    },
  };
  const source =
    'var kflWabaApproved = null, kflLinkRequestGeneration = 0, kflLinkCode = null, kflLinkPhone = null;\n' +
    extractFn(account, '_kflPostLinkCodeRequest') + '\n' +
    extractFn(account, 'kesefleLinkRequestCode') + '\n' +
    'return kesefleLinkRequestCode;';
  const requestCode = new Function(
    '_kflNormalizeIsraelPhone', '_kflShowLinkError',
    '_kflShowLinkSuccess', '_kflDisplayCode', '_kflStartPolling', 'document',
    'setTimeout', 'kesefleStartRedirectSignin', source
  )(
    () => '972541234567', showError, () => {}, displayCode,
    startPolling, document, schedule, () => {}
  );
  return { requestCode, button };
}

async function sessionFirstScenario() {
  const calls = [];
  let displayed = null;
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { status: 200, json: async () => ({ ok: true, code: '123456', expiresIn: 600 }) };
  };
  const flow = buildFlow({
    showError: () => {},
    displayCode: (code) => { displayed = code; },
    startPolling: () => {},
    schedule: () => {},
  });
  await flow.requestCode();

  assert(calls.length === 1, 'valid session makes one link request');
  assert(calls[0].body.phone === '972541234567' && !('accessToken' in calls[0].body), 'first request sends phone without a Google token');
  assert(calls[0].options.credentials === 'include', 'session cookie is included on mobile request');
  assert(calls[0].options.headers['X-Requested-With'] === 'XMLHttpRequest', 'request includes same-origin AJAX signal');
  assert(!/_kflGetFreshAccessToken/.test(account), 'phone-link UI has no Google-token fallback');
  assert(displayed === '123456', 'valid session advances the mobile UI to the code state');
}

async function expiredSessionScenario() {
  const calls = [];
  const errors = [];
  const schedules = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { status: 401, json: async () => ({ ok: false, error: 'not_signed_in' }) };
  };
  const flow = buildFlow({
    showError: (message) => errors.push(message),
    displayCode: () => {},
    startPolling: () => {},
    schedule: (_fn, delay) => schedules.push(delay),
  });
  await flow.requestCode();

  assert(calls.length === 1, 'expired session does not loop or retry with a browser token');
  assert(!('accessToken' in JSON.parse(calls[0].options.body)), 'expired session sends no Google token');
  assert(errors.some((message) => /ההתחברות פגה/.test(message)), 'expired mobile session shows a clear sign-in message');
  assert(schedules.includes(1300), 'expired mobile session schedules sign-in recovery');
  assert(flow.button.disabled === false, 'expired mobile session re-enables the action button');
}

function safeErrorRenderingScenario() {
  const root = makeNode('root');
  function makeNode(tag) {
    return {
      tag, children: [], textContent: '', className: '',
      classList: { add() {}, remove() {} },
      replaceChildren() { this.children = []; },
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); return item; },
      addEventListener(type, listener) { this.listenerType = type; this.listener = listener; },
    };
  }
  const document = {
    getElementById(id) { return id === 'link-error' ? root : null; },
    createElement: makeNode,
  };
  const source = extractFn(account, '_kflShowLinkError') + '\nreturn _kflShowLinkError;';
  const showError = new Function('document', 'setTimeout', 'kesefleLinkRequestCode', source)(
    document, () => {}, () => {}
  );
  const payload = '&lt;img src=x onerror="globalThis.pwned=1"&gt;';
  showError(payload);
  const all = [];
  (function walk(node) { all.push(node); (node.children || []).forEach(walk); })(root);
  const title = all.find(node => node.className === 'font-bold');
  const retry = all.find(node => node.tag === 'button');
  assert(title && title.textContent === payload, 'server error text is rendered literally with textContent');
  assert(!/innerHTML\s*=/.test(extractFn(account, '_kflShowLinkError')), 'phone-link error renderer has no innerHTML sink');
  assert(retry && retry.listenerType === 'click' && typeof retry.listener === 'function', 'retry action uses an event listener, not inline JavaScript');
  assert(!/המספר נשמר אצלנו מוצפן/.test(account), 'privacy copy does not falsely claim the plaintext routing number is encrypted');
}

(async function main() {
  const savedFetch = global.fetch;
  try {
    await sessionFirstScenario();
    await expiredSessionScenario();
    safeErrorRenderingScenario();
  } catch (error) {
    failed++;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    global.fetch = savedFetch;
  }
  if (failed) process.exit(1);
  console.log('All session-first phone-link mobile checks passed.');
})();
