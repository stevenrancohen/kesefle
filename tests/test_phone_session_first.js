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

function buildFlow({ getToken, showError, displayCode, startPolling, schedule }) {
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
    extractFn(account, '_kflPostLinkCodeRequest') + '\n' +
    extractFn(account, 'kesefleLinkRequestCode') + '\n' +
    'return kesefleLinkRequestCode;';
  const requestCode = new Function(
    '_kflNormalizeIsraelPhone', '_kflGetFreshAccessToken', '_kflShowLinkError',
    '_kflShowLinkSuccess', '_kflDisplayCode', '_kflStartPolling', 'document',
    'setTimeout', 'kesefleStartRedirectSignin', source
  )(
    () => '972541234567', getToken, showError, () => {}, displayCode,
    startPolling, document, schedule, () => {}
  );
  return { requestCode, button };
}

async function sessionFirstScenario() {
  const calls = [];
  let tokenCalls = 0;
  let displayed = null;
  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { status: 200, json: async () => ({ ok: true, code: '123456', expiresIn: 600 }) };
  };
  const flow = buildFlow({
    getToken: async () => { tokenCalls++; return 'should-not-be-used'; },
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
  assert(tokenCalls === 0, 'valid session never asks Google for a fresh token');
  assert(displayed === '123456', 'valid session advances the mobile UI to the code state');
}

async function compatibilityFallbackScenario() {
  const calls = [];
  let tokenCalls = 0;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (calls.length === 1) return { status: 401, json: async () => ({ ok: false, error: 'not_signed_in' }) };
    return { status: 200, json: async () => ({ ok: true, code: '654321', expiresIn: 600 }) };
  };
  const flow = buildFlow({
    getToken: async () => { tokenCalls++; return 'legacy-access-token-1234567890'; },
    showError: () => {},
    displayCode: () => {},
    startPolling: () => {},
    schedule: () => {},
  });
  await flow.requestCode();

  assert(calls.length === 2, 'session-less client retries exactly once after 401');
  assert(!('accessToken' in calls[0].body), 'fallback is not sent pre-emptively');
  assert(calls[1].body.accessToken === 'legacy-access-token-1234567890', '401 retry carries the compatibility token');
  assert(tokenCalls === 1, 'Google token is requested only for the 401 fallback');
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
    getToken: async () => { throw new Error('expired'); },
    showError: (message) => errors.push(message),
    displayCode: () => {},
    startPolling: () => {},
    schedule: (_fn, delay) => schedules.push(delay),
  });
  await flow.requestCode();

  assert(calls.length === 1, 'expired session and unavailable token do not loop requests');
  assert(errors.some((message) => /ההתחברות פגה/.test(message)), 'expired mobile session shows a clear sign-in message');
  assert(schedules.includes(1300), 'expired mobile session schedules sign-in recovery');
  assert(flow.button.disabled === false, 'expired mobile session re-enables the action button');
}

(async function main() {
  const savedFetch = global.fetch;
  try {
    await sessionFirstScenario();
    await compatibilityFallbackScenario();
    await expiredSessionScenario();
  } catch (error) {
    failed++;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    global.fetch = savedFetch;
  }
  if (failed) process.exit(1);
  console.log('All session-first phone-link mobile checks passed.');
})();
